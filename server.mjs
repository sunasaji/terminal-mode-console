#!/usr/bin/env node
// server.mjs — even-terminal compatible server (the transport shell)
//
// Implements the HTTP API from docs/protocol.md. This layer is backend-agnostic.
// To extend it, just add one file under agents/.
//
//   TMCON_TOKEN=<token> PORT=3456 node server.mjs
//
// Pairing URL (turn it into a QR code):
//   http://<host>:<PORT>?token=<token>&defaultProvider=<name>
//
// Zero dependencies (Node 20+).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import * as bus from "./bus.mjs";
import {
  getAgent,
  agentNames,
  defaultProvider,
  slotForBackend,
  providerKey,
  slotBindings,
} from "./agents/index.mjs";
import {
  archivedSessions,
  setArchived,
  rememberedModel,
  setLastModel,
  clearLastModel,
} from "./session-metadata.mjs";
import { makeT } from "./i18n.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Logging ───────────────────────────────────────────────
// Prefix every line with a timestamp (local time). For long-lived connections
// like SSE, finish takes a long time to fire, so log connect/disconnect
// separately (otherwise it looks like things "stalled halfway").
const pad = (n) => String(n).padStart(2, "0");
const stamp = () => {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
};
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const maskToken = (s) => s.replace(/token=[^&]*/g, "token=***");

// ── Language (choosing which log strings to emit) ───────────────────────────────
// Messages are externalized to locales/<lang>.json and looked up through the
// shared loader i18n.mjs (same files, same format as the WebUI and CLI).
// The language is determined by the environment's locale.
const { t } = makeT();

// Determine the client kind from the UA (glasses = Dart / WebUI = browser / CLI = node)
const kindOf = (ua = "") =>
  /Dart/i.test(ua)
    ? "dart"
    : /Mozilla/i.test(ua)
      ? "web"
      : /node|undici/i.test(ua)
        ? "cli"
        : "other";

// Estimating the app's connection state. The glasses keep polling the session
// list even after their SSE drops, so "Dart has polled recently (= the app is
// running) yet there are zero Dart SSE connections" lets us conclude it has not
// reconnected = the app needs to be restarted.
let lastDartPollAt = 0;
function appHealth() {
  const s = bus.clientStats();
  const pollingRecently = Date.now() - lastDartPollAt < 30_000;
  return {
    glassesPolling: pollingRecently,
    glassesSse: s.dart > 0,
    // The app is running and fetching the list, but has no SSE connection open
    glassesStale: pollingRecently && s.dart === 0,
    sseClients: s,
  };
}
// Log each state transition once (not on every poll)
let staleLogged = false;
setInterval(() => {
  const h = appHealth();
  if (h.glassesStale && !staleLogged) {
    staleLogged = true;
    log(t("server.appStale"));
  } else if (!h.glassesStale && staleLogged) {
    staleLogged = false;
    log(t("server.appReconnected"));
  }
}, 10_000).unref?.();

const PORT = parseInt(process.env.PORT ?? "3456", 10);
// Bind address. Defaults to loopback only (secure-by-default). Because this
// server grants arbitrary path traversal (/api/fs/dirs) and effectively RCE
// (/api/prompt) behind a single token, by default it must not be reachable
// directly from outside. Reachability should be handled by a fronting TLS proxy
// (tailscale serve, etc.).
// Only set HOST=0.0.0.0 explicitly when you want a direct LAN connection from
// the glasses/phone.
const HOST = process.env.HOST ?? "127.0.0.1";
// Trust the X-Forwarded-For / Tailscale-User-* headers a fronting proxy adds,
// so request logs show the real client instead of the loopback proxy. Only
// honored when the TCP peer is loopback (tailscale serve forwards from there),
// so a direct LAN client cannot spoof its origin. Set TRUST_PROXY=0 to disable.
const TRUST_PROXY = process.env.TRUST_PROXY !== "0";
const isLoopback = (ip) =>
  ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
// Resolve the real client for logging. Behind a trusted loopback proxy
// (tailscale serve), combine the Tailscale login (who) and the first
// X-Forwarded-For hop (source IP) as "login, ip"; fall back to whichever is
// present, else the raw TCP peer.
const clientOf = (req) => {
  const peer = (req.socket.remoteAddress || "-").replace(/^::ffff:/, "");
  if (!TRUST_PROXY || !isLoopback(peer)) return peer;
  const user = req.headers["tailscale-user-login"];
  const xff = req.headers["x-forwarded-for"];
  const ip = xff ? String(xff).split(",")[0].trim() : "";
  const parts = [user && String(user), ip].filter(Boolean);
  return parts.length ? parts.join(", ") : peer;
};
// Upper limit on the total size of images attachable to /api/prompt (character
// count = sum of base64 lengths). base64 is about 1.34x the original bytes.
// The default 24MB of characters ≒ about 18MB equivalent.
const MAX_PROMPT_IMAGE_CHARS =
  Number(process.env.MAX_PROMPT_IMAGE_CHARS) || 24 * 1024 * 1024;
// Number of entries the session list /api/sessions returns.
//   SESSIONS_LIMIT_DEFAULT  default when the ?limit= query is omitted (default 100)
//   SESSIONS_LIMIT_MAX      upper bound allowed for ?limit=. 0 or unset means "unlimited".
const SESSIONS_LIMIT_DEFAULT =
  Number(process.env.SESSIONS_LIMIT_DEFAULT) || 100;
const SESSIONS_LIMIT_MAX = Number(process.env.SESSIONS_LIMIT_MAX) || Infinity;
// Number of history entries returned when opening an existing session.
//   HISTORY_LIMIT_DEFAULT  default when the ?limit= query is omitted (default 100)
//   HISTORY_LIMIT_MAX      upper bound allowed for ?limit=. 0 or unset means "unlimited".
const HISTORY_LIMIT_DEFAULT = Number(process.env.HISTORY_LIMIT_DEFAULT) || 100;
const HISTORY_LIMIT_MAX = Number(process.env.HISTORY_LIMIT_MAX) || Infinity;
const TOKEN = process.env.TMCON_TOKEN;
if (!TOKEN) {
  console.error(t("server.needToken"));
  process.exit(1);
}

const json = (res, code, body) => {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // Request log (for diagnostics). Timestamp, IP, status, method, path (query
  // included, token masked), response time, and client kind. SSE is excluded
  // since its finish is slow — it is left to the dedicated log below.
  if (process.env.LOG_REQUESTS !== "0" && p !== "/api/events") {
    const ip = clientOf(req);
    const kind = kindOf(req.headers["user-agent"]);
    const started = Date.now();
    res.on("finish", () =>
      log(
        `[${ip}] ${res.statusCode} ${req.method} ${maskToken(p + url.search)} ${Date.now() - started}ms ${kind}`,
      ),
    );
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
      "Access-Control-Allow-Headers":
        req.headers["access-control-request-headers"] ?? "*",
    });
    return res.end();
  }

  // ── WebUI assets (vendor) ─────────────────────────────
  // Serve the frontend libraries for Markdown/highlighting/diff rendering from
  // web/vendor/. These are vendored static files rather than npm dependencies,
  // so we keep "zero core dependencies".
  // A browser's <script src> cannot attach a token, so return them before auth.
  // The contents are third-party libraries identical to what public CDNs serve;
  // there is nothing secret and exposure does not increase.
  // Restrict file names to alphanumerics, dots, and hyphens to block path traversal.
  if (p.startsWith("/vendor/")) {
    const name = p.slice("/vendor/".length);
    if (!/^[\w.-]+$/.test(name))
      return json(res, 400, { error: "bad asset name" });
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const ctype =
      ext === "js"
        ? "text/javascript; charset=utf-8"
        : ext === "css"
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
    try {
      const buf = await readFile(join(HERE, "web", "vendor", name));
      res.writeHead(200, {
        "Content-Type": ctype,
        // Contents are version-pinned, so long-term caching is fine (index.html stays no-cache)
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(buf);
    } catch {
      return json(res, 404, { error: "asset not found" });
    }
  }

  // The WebUI's own helper script. Since a <script src> cannot attach an auth
  // header, serve it before the auth check, just like vendor. Its contents are
  // only the rendering logic for the publicly served index.html.
  if (p === "/tagged-markdown.js") {
    try {
      const js = await readFile(join(HERE, "web", "tagged-markdown.js"));
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(js);
    } catch {
      return json(res, 404, { error: "WebUI asset not found" });
    }
  }

  // Translation dictionaries. Serve them from locales/ at the repo root, shared
  // with the CLI and server. Accept BCP 47 tags (language, optional script and
  // region subtags, e.g. zh-Hant, pt-BR). The character class allows only
  // letters, digits, and hyphens, so no path traversal (../ etc.) is possible.
  const localeMatch = p.match(
    /^\/locales\/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2})\.json$/,
  );
  if (localeMatch) {
    try {
      const data = await readFile(
        join(HERE, "locales", `${localeMatch[1]}.json`),
      );
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(data);
    } catch {
      return json(res, 404, { error: "locale not found" });
    }
  }

  // ── PWA assets (manifest / icons) ────────────────
  // The browser fetches the manifest and <link rel=icon>/apple-touch-icon
  // without a token. Serve them from web/ before the auth check, just like
  // vendor. The contents are only static assets that are fine to make public.
  const PWA_ASSETS = {
    "/manifest.webmanifest": "application/manifest+json; charset=utf-8",
    "/icon.svg": "image/svg+xml; charset=utf-8",
    "/icon-192.png": "image/png",
    "/icon-512.png": "image/png",
    "/apple-touch-icon.png": "image/png",
  };
  if (PWA_ASSETS[p]) {
    try {
      const buf = await readFile(join(HERE, "web", p.slice(1)));
      res.writeHead(200, {
        "Content-Type": PWA_ASSETS[p],
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(buf);
    } catch {
      return json(res, 404, { error: "PWA asset not found" });
    }
  }

  // ── WebUI shell (index.html) ─────────────────────────
  // When launched standalone as a PWA, the start_url (/) carries no token, so
  // return the shell HTML before auth. Its contents are only static UI that is
  // fine to make public; there is nothing secret, and access to the real data
  // (REST/SSE) goes through the auth below, so exposure does not increase.
  // The page's JS obtains the token from the URL query or localStorage and calls
  // the API. Since it is read from disk every time, the UI can be swapped out
  // without restarting.
  if (p === "/" || p === "/index.html") {
    try {
      const html = await readFile(join(HERE, "web", "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(html);
    } catch {
      return json(res, 404, { error: "WebUI not installed (web/index.html)" });
    }
  }

  // Auth: REST uses the Bearer header, SSE uses ?token= (the app cannot send
  // headers over SSE). Supporting both is mandatory — with only one, SSE gets a
  // 401 and the screen silently becomes unresponsive.
  const header = req.headers.authorization;
  const provided = header?.startsWith("Bearer ")
    ? header.slice(7)
    : url.searchParams.get("token");
  if (provided !== TOKEN) return json(res, 401, { error: "Unauthorized" });

  let body = {};
  if (req.method === "POST") {
    const raw = await new Promise((r) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => r(b));
    });
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { error: "Invalid JSON" });
    }
  }

  // ── SSE ───────────────────────────────────────────────
  if (p === "/api/events") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId)
      return json(res, 400, { error: "Missing 'sessionId' query parameter" });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(":ok\n\n");
    // ── Catching up on missed events (on reconnect) ──────────────────────
    // When a phone browser is backgrounded, the SSE silently drops; on returning
    // to the foreground it reconnects, but any screen updates that flowed while
    // it was disconnected (text_delta, tool_end, and dialogs awaiting a response)
    // are missed. So we resend only the events after the last id received, in
    // order, from a ring buffer (up to 500 entries), catching up to the latest state.
    //   - Last-Event-ID header … sent by EventSource's automatic reconnect (browser standard)
    //   - ?lastEventId= query … for when we explicitly re-establish on foreground return
    //     (a new EventSource has no header, so we pass the tracked id via the query)
    //   - needReplay=true      … resend everything (the legacy endpoint; the app does not use it)
    const full = url.searchParams.get("needReplay") === "true";
    const lastId = parseInt(
      req.headers["last-event-id"] ||
        url.searchParams.get("lastEventId") ||
        "0",
      10,
    );
    const kind = kindOf(req.headers["user-agent"]);
    const s = bus.getSession(sessionId);
    // Incremental catch-up (resending e.id > lastId from the 500-entry ring buffer) only
    // works while the client's lastId is still reachable from the current instance. Two cases
    // break that, and both make the WebUI's dedup guard drop every subsequent append
    // (user_prompt / text_delta / …) while still showing dialogs (which are re-sent id-less):
    //   1. epoch mismatch  — the session instance was recreated (server restart); nextId reset
    //      to 1, so new events get ids <= the client's stale lastId and look like redeliveries.
    //   2. buffer gap      — more than 500 events elapsed while the client was disconnected
    //      (long/active turn + backgrounded tab), so the events it missed were trimmed and can
    //      never be replayed; or lastId is ahead of the server (also a regression).
    // In either case we tell the WebUI to resync: reset its baseline and reload history from disk
    // instead of trusting the incremental stream. Only the WebUI speaks this; other clients are
    // unchanged. See web/index.html openStream()/stream_meta handling.
    let resync = false;
    if (kind === "web") {
      const clientEpoch = url.searchParams.get("epoch") || "";
      const firstBufferedId = s.messages.length ? s.messages[0].id : s.nextId;
      const serverLastId = s.nextId - 1;
      resync =
        !full &&
        lastId > 0 &&
        ((clientEpoch && clientEpoch !== s.epoch) ||
          firstBufferedId > lastId + 1 ||
          lastId > serverLastId);
      res.write(
        `data: ${JSON.stringify({ type: "stream_meta", epoch: s.epoch, resync })}\n\n`,
      );
    }
    if (!resync && (full || lastId > 0)) {
      for (const e of s.messages) {
        if (full || e.id > lastId)
          res.write(`id: ${e.id}\ndata: ${JSON.stringify(e.msg)}\n\n`);
      }
    }
    // Separately from catching up on history, resend the currently unanswered
    // requests as a state snapshot. The WebUI dedupes by requestId, so even if
    // the replay includes the same request it is not displayed twice.
    bus.addClient(sessionId, res, kind);
    log(
      `[sse] connect  ${sessionId.slice(0, 8)} kind=${kind} clients=${bus.clientStats().total}`,
    );
    // Long-lived connection. A 15-second heartbeat keeps intermediaries from cutting it off.
    const hb = setInterval(() => {
      try {
        res.write(":heartbeat\n\n");
      } catch {
        clearInterval(hb);
      }
    }, 15000);
    req.on("close", () => {
      clearInterval(hb);
      bus.removeClient(sessionId, res);
      log(
        `[sse] disconnect ${sessionId.slice(0, 8)} clients=${bus.clientStats().total}`,
      );
    });
    return;
  }

  // ── REST ──────────────────────────────────────────────
  if (p === "/api/info") {
    // Actually resolve the requested provider before answering. Even if a
    // fallback has occurred, looking here reveals "where it is really connected".
    const requestedProvider = url.searchParams.get("provider");
    const agent = getAgent(requestedProvider);
    const d = agent.describe?.() ?? {};
    // Initial value for the model-selection dropdown. If a sessionId is present,
    // return that conversation's remembered model; otherwise return the provider
    // slot's global default (the value some other client last chose). This lets
    // the WebUI display reflect the same model as the UI-less glasses.
    const providerSlot = providerKey(requestedProvider);
    const sessionId = url.searchParams.get("sessionId");
    let currentModel;
    try {
      currentModel = await rememberedModel(providerSlot, sessionId || "");
    } catch {
      currentModel = null;
    }
    return json(res, 200, {
      account: {
        email: "local",
        organization: "local",
        subscriptionType: "local",
      },
      model: d.model ?? agent.name,
      currentModel: currentModel ?? null, // the remembered effective model (extension field)
      version: "0.3.0",
      provider: agent.name,
      backend: { provider: agent.name, ...d }, // extension field (includes the models list)
      app: appHealth(), // the glasses' connection state (extension field)
    });
  }

  // A dedicated endpoint for cheaply checking just the connection state (for monitoring / the WebUI)
  if (p === "/api/app-health") return json(res, 200, appHealth());

  // From the path being typed, return the subdirectories that actually exist on
  // the server. Used by the WebUI's dynamic completion and the CLI's Tab
  // completion. Since cwd is interpreted on the server side, it is important that
  // the scan target is this server's filesystem too (not the client's local one).
  // No restrictions: any absolute path can be traversed (token-protected, on the
  // assumption of personal use).
  if (p === "/api/fs/dirs") {
    let input = url.searchParams.get("path") || "";
    if (input === "~" || input.startsWith("~/"))
      input = homedir() + input.slice(1); // ~ expansion
    // base = the directory to scan, prefix = the name to prefix-match within it.
    // A trailing / means "all of its contents"; otherwise use the last element as
    // the seed for prefix matching.
    let base, prefix;
    if (!input) {
      base = homedir();
      prefix = "";
    } else if (input.endsWith("/")) {
      base = input;
      prefix = "";
    } else {
      base = dirname(input) || "/";
      prefix = basename(input);
    }
    base = resolve(base);
    const lower = prefix.toLowerCase();
    const dirs = [];
    try {
      const ents = await readdir(base, { withFileTypes: true });
      for (const e of ents) {
        const n = e.name;
        // Only show dot directories when the user has explicitly typed a leading ".".
        if (n.startsWith(".") && !prefix.startsWith(".")) continue;
        if (!n.toLowerCase().startsWith(lower)) continue;
        let isDir = e.isDirectory();
        // For symbolic links, check the target and accept only directories.
        if (!isDir && e.isSymbolicLink()) {
          try {
            isDir = (await stat(join(base, n))).isDirectory();
          } catch {
            isDir = false;
          }
        }
        if (isDir) dirs.push(join(base, n) + "/"); // the trailing / lets you drill straight in
        if (dirs.length >= 200) break;
      }
    } catch {
      /* For unreadable directories, return zero candidates (the UI silently shows nothing) */
    }
    dirs.sort((a, b) => a.localeCompare(b));
    return json(res, 200, { base, dirs });
  }

  if (p === "/api/sessions") {
    // Use the glasses' (Dart) list polling as a liveness check for the connection state
    if (kindOf(req.headers["user-agent"]) === "dart")
      lastDartPollAt = Date.now();
    const requestedProvider = url.searchParams.get("provider");
    const providerSlot = providerKey(requestedProvider);
    const agent = getAgent(requestedProvider);
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const archived = await archivedSessions(providerSlot);
    const limit = Math.min(
      parseInt(url.searchParams.get("limit")) || SESSIONS_LIMIT_DEFAULT,
      SESSIONS_LIMIT_MAX,
    );
    const wantCwd = url.searchParams.get("cwd") || undefined;
    // In-memory sessions (those actually spoken to in this process). Only include
    // those belonging to the resolved concrete backend — do not mix in sessions
    // from another provider.
    // Do not list empty sessions that merely opened an SSE or queried state.
    // Listing them makes updatedAt the current time, floating them to the top of
    // the list and pushing aside the real titles from the persistent side.
    // When a cwd is specified, narrow to only that directory's sessions — the bus
    // side can only filter by provider, so without narrowing here, sessions
    // recently spoken to in a different directory would get mixed in regardless
    // of cwd (a bug where opening a specific directory from the glasses' explorer
    // still shows recent sessions from another directory).
    const inMemory = bus
      .listSessions(agent.name)
      .filter(
        (s) =>
          (s.history.length || s.state === "busy") &&
          (!wantCwd || s.cwd === wantCwd),
      )
      .map((s) => ({
        id: s.id,
        title:
          agent.name === "codex"
            ? `  ${(s.title || "session").replace(/^(?:R | {2})/, "")}`
            : s.title || "session",
        timestamp: new Date(s.updatedAt || Date.now()).toISOString(),
        cwd: s.cwd,
        provider: s.provider || defaultProvider,
        status: s.state,
        ...bus.livenessSnapshot(s),
      }));
    // If the adapter persists sessions, mix in that list too (e.g. Claude Code's
    // past sessions). Prefer the memory side and do not duplicate the same ID.
    let persisted = [];
    try {
      persisted = (await agent.listSessions?.(limit, wantCwd)) ?? [];
    } catch {
      /* Even if the list cannot be fetched, conversation still works */
    }
    // Using the persistent side as the base, overlay only the memory side's
    // "entries that actually have values". Naively preferring memory would let a
    // merely-opened empty session clobber the real title.
    const byId = new Map(persisted.map((s) => [s.id, s]));
    for (const m of inMemory) {
      const base = byId.get(m.id);
      byId.set(
        m.id,
        !base
          ? m
          : {
              ...base,
              // Prefer the persistent side's title (Claude's auto-summary). The
              // memory side's title is "the first prompt sent in this process",
              // which for a resumed session becomes a continuation like "Continue."
              // and would clobber the proper summary. Fall back to the memory side
              // only when the persistent side has no title.
              title:
                base.title && base.title !== "session" ? base.title : m.title,
              cwd: base.cwd || m.cwd,
              status: m.status,
              timestamp:
                m.timestamp > base.timestamp ? m.timestamp : base.timestamp,
            },
      );
    }
    // Supplement with the display snapshot taken at archive time so that archives
    // older than the list limit can still be restored. If the same session can be
    // fetched from upstream, always prefer the newer upstream information.
    if (includeArchived)
      for (const [id, meta] of archived) {
        if (byId.has(id) || (wantCwd && meta.cwd !== wantCwd)) continue;
        byId.set(id, {
          id,
          title: meta.title || "session",
          timestamp: meta.timestamp || meta.archivedAt,
          cwd: meta.cwd || "",
          provider: agent.name,
          status: "idle",
        });
      }
    const list = [...byId.values()]
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .map((s) => ({ ...s, archived: archived.has(String(s.id)) }))
      .filter((s) => includeArchived || !s.archived)
      .slice(0, limit)
      // Return responses in the app's vocabulary (claude/codex). Do not expose the concrete names (local/echo).
      .map((s) => ({ ...s, provider: slotForBackend(s.provider) }));
    return json(res, 200, { sessions: list });
  }

  if (p === "/api/sessions/archive" && req.method === "POST") {
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
    if (typeof body.archived !== "boolean")
      return json(res, 400, { error: "'archived' must be a boolean" });
    const providerSlot = providerKey(body.provider);
    const s = bus.peekSession(sessionId);
    const background = s?.agent?.backgroundStatus?.(s);
    if (body.archived && (s?.state === "busy" || s?.waiting || background)) {
      return json(res, 409, {
        error: "A running or waiting session cannot be archived",
      });
    }
    const snapshot =
      body.snapshot && typeof body.snapshot === "object" ? body.snapshot : {};
    await setArchived(providerSlot, sessionId, body.archived, snapshot);
    return json(res, 200, {
      ok: true,
      sessionId,
      provider: providerSlot,
      archived: body.archived,
    });
  }

  const hist = p.match(/^\/api\/sessions\/([^/]+)\/history$/);
  if (hist) {
    const s = bus.peekSession(hist[1]) ?? { id: hist[1], history: [] };
    const limit = Math.min(
      parseInt(url.searchParams.get("limit")) || HISTORY_LIMIT_DEFAULT,
      HISTORY_LIMIT_MAX,
    );
    // Prefer the persistent side (the adapter). The memory side's history is a
    // subset of "what this process saw" and is missing things like interrupted
    // turns. Do not obscure the history the backend really holds with the memory
    // side's incomplete copy.
    // Adapters that do not persist (echo / local-llm) return empty, so only then use the memory side.
    const agent = getAgent(url.searchParams.get("provider"));
    let history;
    const follow = url.searchParams.get("follow") === "1";
    const cursor = url.searchParams.get("cursor") || "";
    if ((follow || cursor) && agent.getHistoryUpdate) {
      try {
        const update = await agent.getHistoryUpdate(s, limit, cursor);
        return json(res, 200, update);
      } catch {
        return json(res, 200, {
          history: [],
          cursor,
          unchanged: true,
          replace: false,
        });
      }
    }
    try {
      history = (await agent.getHistory?.(s, limit)) ?? [];
    } catch {
      history = [];
    }
    // Fall back to the memory side only when that in-memory session belongs to
    // the same concrete backend. Do not surface another provider's history (e.g.
    // claude's turns) under codex.
    if (!history.length && s.provider === agent.name) {
      history = s.history
        .slice(-limit)
        .map((m) => ({ role: m.role, text: m.content }));
    }
    return json(res, 200, { history });
  }

  if (p === "/api/status") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
    const s = bus.peekSession(sessionId);
    return json(res, 200, {
      state: s?.state ?? "idle",
      sessionId,
      provider: slotForBackend(s?.provider || defaultProvider),
      ...bus.livenessSnapshot(s),
    });
  }

  if (p === "/api/usage") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
    const agent = getAgent(url.searchParams.get("provider"));
    const s = bus.peekSession(sessionId) ?? {
      id: sessionId,
      cwd: "",
      history: [],
    };
    // Fetching usage makes the backend open a persistent connection (a child
    // process), so cwd is fixed here. For a new session this endpoint is hit
    // before the first send, so unless we store the cwd the WebUI passed here,
    // the child process gets fixed/cached at the launch directory and a cwd
    // specified later is not reflected.
    const cwd = url.searchParams.get("cwd");
    if (cwd && !s.cwd) s.cwd = cwd;
    if (!agent.getUsage) return json(res, 200, { available: false });
    try {
      return json(res, 200, { available: true, ...(await agent.getUsage(s)) });
    } catch {
      return json(res, 200, { available: false });
    }
  }

  if (p === "/api/messages") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
    const after = parseInt(url.searchParams.get("after")) || 0;
    const s = bus.peekSession(sessionId);
    return json(res, 200, {
      messages: (s?.messages ?? [])
        .filter((m) => m.id > after)
        .map((m) => ({ id: m.id, ...m.msg })),
      state: s?.state ?? "idle",
      sessionId,
      provider: slotForBackend(s?.provider || defaultProvider),
    });
  }

  if (p === "/api/prompt" && req.method === "POST") {
    const { text, images, sessionId, provider, cwd, model } = body;
    if (text != null && typeof text !== "string")
      return json(res, 400, { error: "'text' must be a string" });
    if (model != null && typeof model !== "string")
      return json(res, 400, { error: "'model' must be a string" });
    // Images are optional. An array of strings, each a data URL or raw base64.
    // A vision-capable backend (local-llm) attaches them to the user message.
    // Set an upper limit because too large a total overflows both the context and memory.
    let imgs;
    if (images != null) {
      if (!Array.isArray(images) || images.some((x) => typeof x !== "string")) {
        return json(res, 400, {
          error: "'images' must be an array of strings (data URL or base64)",
        });
      }
      const total = images.reduce((n, x) => n + x.length, 0);
      if (total > MAX_PROMPT_IMAGE_CHARS) {
        return json(res, 413, {
          error: `images too large (${total} > ${MAX_PROMPT_IMAGE_CHARS} chars)`,
        });
      }
      if (images.length) imgs = images;
    }
    // If both text and images are empty, there is nothing to send. Either one alone is fine (images-only is OK).
    const text0 = text || "";
    if (!text0 && !imgs)
      return json(res, 400, { error: "Provide 'text' and/or 'images'" });
    const id = sessionId || randomUUID();
    const agent = getAgent(provider);
    const s = bus.getSession(id);
    s.provider = agent.name;
    s.cwd = cwd || s.cwd || process.cwd();
    s.updatedAt = Date.now();
    if (!s.title)
      s.title = (
        text0 ||
        (imgs ? t("session.imageTitle", { count: imgs.length }) : "session")
      ).slice(0, 64);

    // Resolving the model. (1) explicit specification in this request → (2) this
    // conversation's or the provider slot's remembered value → (from here on,
    // handled in agents/claude.mjs) (3) env CLAUDE_MODEL → (4) Claude Code default.
    // In case (1), update the remembered value so the UI-less glasses (which
    // specify nothing) can follow along from the next turn.
    // Do not await reading/writing the remembered value so as not to delay the
    // 202 response (once loaded, it is effectively an in-memory operation).
    const providerSlot = providerKey(provider);
    let turnModel =
      typeof model === "string" && model.trim() ? model.trim() : undefined;
    if (turnModel) setLastModel(providerSlot, id, turnModel).catch(() => {});
    else {
      try {
        turnModel = (await rememberedModel(providerSlot, id)) || undefined;
      } catch {
        turnModel = undefined;
      }
    }

    // The app assumes an immediate 202 response. Leave execution to the bus's
    // FIFO (so that turns are not run concurrently even when the glasses, WebUI,
    // and CLI submit at the same time).
    const queued = bus.enqueue(id, {
      text: text0,
      images: imgs,
      agent,
      model: turnModel,
    });
    return json(res, 202, {
      ok: true,
      sessionId: id,
      provider: agent.name,
      queued,
      model: turnModel ?? null,
    });
  }

  if (p === "/api/permission-response" && req.method === "POST") {
    if (!body.sessionId)
      return json(res, 400, { error: "Missing 'sessionId'" });
    bus.resolvePermission(body.sessionId, body.decision);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/question-response" && req.method === "POST") {
    if (!body.sessionId)
      return json(res, 400, { error: "Missing 'sessionId'" });
    bus.resolveQuestion(body.sessionId, body.answer);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/interrupt" && req.method === "POST") {
    if (!body.sessionId)
      return json(res, 400, { error: "Missing 'sessionId'" });
    bus.interrupt(body.sessionId);
    return json(res, 200, { ok: true });
  }

  // Remembering the model selection. Called when the WebUI's dropdown changes.
  // By remembering it here without waiting for a prompt to be sent, a UI-less
  // client's (the glasses') next turn inherits this model (for this session, and
  // as the provider slot's global default).
  if (p === "/api/model" && req.method === "POST") {
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const providerSlot = providerKey(body.provider);
    if (typeof body.model !== "string")
      return json(res, 400, { error: "'model' must be a string" });
    const model = body.model.trim();
    if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
    // An empty string means "auto" = clearing the remembered value. Since setting
    // writes both the session and the global default, clearing targets both too.
    // Without this, a default once written cannot be undone.
    if (model) await setLastModel(providerSlot, sessionId, model);
    else await clearLastModel(providerSlot, sessionId);
    return json(res, 200, {
      ok: true,
      sessionId,
      provider: providerSlot,
      model: model || null,
    });
  }

  // Stubs (the app calls these, but their contents do not matter)
  if (p === "/api/update-check")
    return json(res, 200, { updateAvailable: false });
  if (p === "/api/metrics")
    return json(res, 200, { codex: { subscribedSessions: [] } });

  return json(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  log(
    `terminal-mode-console listening ${HOST}:${PORT}  slots=[claude→${slotBindings.claude}, codex→${slotBindings.codex}]  backends=[${agentNames().join(", ")}]  cwd=${process.cwd()}`,
  );
  log(
    `pair: http://<host>:${PORT}?token=${TOKEN}&defaultProvider=${defaultProvider}`,
  );
  if (HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1") {
    log(t("server.bindLoopback"));
    log(t("server.bindHint"));
  }
});
process.on("SIGINT", () => {
  log(t("server.sigint"));
  process.exit(0);
});
process.on("SIGTERM", () => {
  log(t("server.sigterm"));
  process.exit(0);
});
