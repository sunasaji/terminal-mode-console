#!/usr/bin/env node
// tmcon-cli — a thin terminal client that connects to terminal-mode-console / even-terminal.
//
// For reading and writing, from the terminal, the same conversation as the glasses and WebUI.
// It is not the Claude Code TUI (no slash commands, no diff display).
//
//   tmcon-cli 'http://host:3462?token=XXXX'      # the pairing URL as-is
//   tmcon-cli --url http://host:3462 --token XXXX [--session <id>] [--new] [--provider claude|codex] [--model <name>]
//
// Specify the model with --model (or EVEN_MODEL); switch mid-conversation with /model <name>,
// and /model on its own returns to "auto" (clears the memory and defers to the server-side default).
// If unspecified, no model is sent and the session/server-side setting is carried over as-is.
//
// The conversation state lives on the server, so the context is not lost when you disconnect.
// Reconnect and you can read the continuation from history (tmux is not required).
//
// Zero dependencies (Node 20+).

import { createInterface } from "node:readline";
import { stdin, stdout, argv, exit, env } from "node:process";
import { makeT } from "../i18n.mjs";

// ── Language (choosing what to display) ──────────────────────────────
// The wording is externalized to locales/<lang>.json and looked up via the shared loader i18n.mjs
// (same file, same format as server.mjs and the WebUI). The language is determined from the environment's locale.
const { t } = makeT();

// ── Arguments ──────────────────────────────────────────────
const args = argv.slice(2);
let url = env.EVEN_URL || "",
  token = env.EVEN_TOKEN || "",
  sessionId = null,
  wantNew = false;
let provider = env.EVEN_PROVIDER || "claude";
let cwd = null; // an existing session inherits that session's working directory
let cwdArg = null; // --cwd: filters the listing + working directory for a new session
// --model: the model used for each turn (a claude alias opus/sonnet/haiku/fable/default, or
// a full ID). If omitted, defer to the server-side memory/default. Switchable mid-conversation with /model <name>.
let model = env.EVEN_MODEL || null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--url") url = args[++i];
  else if (a === "--token") token = args[++i];
  else if (a === "--session") sessionId = args[++i];
  else if (a === "--provider") provider = args[++i];
  else if (a === "--model") model = args[++i];
  else if (a === "--cwd") cwdArg = args[++i];
  else if (a === "--new") wantNew = true;
  else if (a === "-h" || a === "--help") {
    usage();
    exit(0);
  } else if (/^https?:\/\//.test(a)) {
    // the pairing URL can be passed as-is
    const u = new URL(a);
    token = u.searchParams.get("token") || token;
    url = `${u.protocol}//${u.host}`;
  }
}
function usage() {
  stdout.write(t("cli.usage"));
}
if (!url || !token) {
  usage();
  exit(1);
}

const C = {
  dim: "\x1b[2m",
  user: "\x1b[32m",
  err: "\x1b[31m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  off: "\x1b[0m",
};
const TTY = Boolean(stdout.isTTY);

// ── Status line ──────────────────────────────────────
// Show "what it's doing right now" directly above the input line (the same role as Waiting input on the glasses' bottom line).
// Make the prompt two lines, "status line + input line", and let readline redraw them together.
let statusLabel = t("state.waitingInput"),
  statusWait = false,
  t0 = 0,
  ticker = null;
let basePrompt = "› ",
  shown = false;

function statusText() {
  const secs = t0 ? Math.floor((Date.now() - t0) / 1000) : 0;
  const el = t0
    ? `  ${secs < 60 ? secs + "s" : Math.floor(secs / 60) + "m" + (secs % 60) + "s"}`
    : "";
  return `${statusWait ? C.warn : C.dim}[${statusLabel}${el}]${C.off}`;
}
/** Clear the status line and the input line. Call before writing output (otherwise they overlap). */
function unpaint() {
  if (TTY && shown) {
    stdout.write("\r\x1b[2K\x1b[1A\r\x1b[2K");
    shown = false;
  }
}
const say = (s = "") => {
  unpaint();
  stdout.write(s + "\n");
};

/** running=false stops the timer. wait=true is the "we are waiting for a response" state. */
function setStatus(label, { running = true, wait = false } = {}) {
  statusLabel = label;
  statusWait = wait;
  if (running && !t0) {
    t0 = Date.now();
    if (TTY) {
      ticker = setInterval(() => {
        if (!streaming) prompt();
      }, 1000);
      ticker.unref?.();
    }
  }
  if (!running) {
    t0 = 0;
    clearInterval(ticker);
    ticker = null;
  }
  if (TTY && !streaming) prompt();
}

// ── REST ──────────────────────────────────────────────
async function api(path, init = {}) {
  const r = await fetch(url + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
}

// ── Terminal input ──────────────────────────────────────
// Calling prompt() after stdin has closed crashes with ERR_USE_AFTER_CLOSE.
// With piped input (echo ... | tmcon-cli) it always happens, because stdin closes during the line handler's await.
// Enable Tab completion only during the cwd input prompt (no completion for normal chat input).
// cwd is interpreted on the server side, so the completion candidates are also drawn from directories that actually exist on the server.
let completePaths = false;
function completer(line, cb) {
  if (!completePaths) return cb(null, [[], line]);
  api(`/api/fs/dirs?path=${encodeURIComponent(line)}`)
    .then(({ dirs = [] }) => cb(null, [dirs, line])) // treat the whole line as a path for completion
    .catch(() => cb(null, [[], line]));
}
const rl = createInterface({
  input: stdin,
  output: stdout,
  prompt: basePrompt,
  completer,
});
let closed = false,
  awaiting = false;
// On a terminal, redraw the "status line + input line" every time. With a pipe on the other end, use a plain prompt as before.
const prompt = () => {
  if (closed || !bootDone) return;
  if (!TTY) return rl.prompt();
  rl.setPrompt(`${statusText()}\n${basePrompt}`);
  rl.prompt(true); // redraw while preserving the characters being typed
  shown = true;
};
const question = (q) => new Promise((r) => rl.question(q, r));
// Don't advance reading stdin until the line handler is registered.
// If we do advance, the first line of piped input is picked up by no one and vanishes.
rl.pause();
let bootDone = false;
rl.on("close", () => {
  closed = true;
  // If startup is still in progress (fetching the listing or showing history), don't finish yet.
  // If waiting for a response, wait until it finishes streaming. Otherwise, exit immediately (Ctrl+D).
  if (bootDone && !awaiting) exit(0);
});

// ── Show the actually-connected backend first ────────────────
// provider can fall back. Even if you request "claude", the real backend may be a local LLM,
// so show the true connection target before starting the conversation.
try {
  const i = await api(`/api/info?provider=${encodeURIComponent(provider)}`);
  const b = i.backend ?? {};
  const where = b.endpoint && b.endpoint !== "-" ? ` @ ${b.endpoint}` : "";
  // When the backend is known to be unreachable, do not present it in the normal style.
  // Neither the label nor the model came from the backend, so it must not look configured.
  if (b.reachable === false) {
    say(`${C.err}backend: ${t("backend.unreachable")}${where}${C.off}`);
    say(`${C.dim}${t("backend.unreachableHint")}${C.off}`);
  } else {
    say(
      `${C.dim}backend: ${b.label ?? i.provider} / ${b.model ?? ""}${where}${
        i.provider !== provider
          ? t("cli.reqRoute", { req: provider, got: i.provider })
          : ""
      }${C.off}`,
    );
  }
  if (model) say(`${C.dim}${t("cli.modelHint", { model })}${C.off}`);
} catch {
  /* even if it can't be shown, the conversation can continue */
}

// ── Session selection ────────────────────────────────────
// If --session / --new is given explicitly, don't ask. Otherwise, let the user pick from a listing.
// Silently connecting to the most recent one would merge into an unintended conversation.
// Let the user choose the working directory for a new session. Pick an existing cwd by number, or
// type a path directly (free input). Empty means the server default (the server's startup directory).
async function pickNewCwd(cwds) {
  if (cwds.length) {
    say(`${C.dim}${t("cli.cwdCandidates")}${C.off}`);
    cwds.forEach((c, i) =>
      say(`  ${String(i + 1).padStart(2)}) ${C.dim}${c}${C.off}`),
    );
  }
  completePaths = true; // only here, Tab completes directories that actually exist on the server
  const a = (await question(t("cli.cwdPrompt"))).trim();
  completePaths = false;
  if (closed || !a) return null;
  const i = parseInt(a, 10);
  if (String(i) === a && i >= 1 && i <= cwds.length) return cwds[i - 1];
  return a; // if not a number, treat as a path (allows specifying a directory not in the history)
}

// Whether it can be regarded as an absolute path. Decides whether to put --cwd on the dir-scoped fetch (?cwd=).
const isAbsPath = (v) => /^(\/|~|[A-Za-z]:[\\/])/.test(v || "");
// Drop the trailing slash (but keep root "/"). A session's cwd has no trailing /, so this prevents
// a trailing-/ filter like "…/urdwell/" from failing to match under includes().
const trimSlash = (v) => (v && v.length > 1 ? v.replace(/\/+$/, "") : v);

if (!sessionId && !wantNew) {
  try {
    const lim = cwdArg ? 50 : 20; // when filtering, increase the pool to reduce misses
    // If --cwd is an absolute path, fetch scoped to that cwd (equivalent to claude's
    // listSessions({dir})). This reliably picks up even stale sessions that fell off the overall recent listing.
    const scoped = isAbsPath(cwdArg)
      ? `&cwd=${encodeURIComponent(cwdArg)}`
      : "";
    const { sessions = [] } = await api(
      `/api/sessions?provider=${encodeURIComponent(provider)}&limit=${lim}${scoped}`,
    );
    // When --cwd is given, narrow to candidates in that working directory (substring match, case-insensitive).
    const needle = trimSlash(cwdArg || "").toLowerCase();
    const shown = cwdArg
      ? sessions.filter((s) => (s.cwd || "").toLowerCase().includes(needle))
      : sessions;
    if (sessions.length) {
      if (cwdArg)
        say(
          `\n${C.dim}${t("cli.cwdFilter", { needle: cwdArg, shown: shown.length, total: sessions.length })}${C.off}`,
        );
      say("");
      shown.forEach((s, i) => {
        const when = String(s.timestamp ?? "")
          .slice(0, 16)
          .replace("T", " ");
        const where = s.cwd ? `  ${C.dim}${s.cwd}${C.off}` : "";
        say(
          `  ${String(i + 1).padStart(2)}) ${C.dim}${when}${C.off}  ${(s.title || s.id).slice(0, 52)}${where}`,
        );
      });
      if (!shown.length) say(`${C.dim}${t("cli.noCwdMatch")}${C.off}`);
      say(`   ${C.info}n${C.off}) ${t("cli.newSessionItem")}`);
      // Working-directory candidates for a new session (cwds seen in the history, deduplicated)
      const cwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
      for (;;) {
        const a = (await question(t("cli.pickNumber"))).trim();
        if (closed) break;
        if (a === "n" || a === "N") {
          // leave sessionId unset → new
          cwd = cwdArg || (await pickNewCwd(cwds));
          break;
        }
        const i = parseInt(a, 10);
        if (i >= 1 && i <= shown.length) {
          sessionId = shown[i - 1].id;
          cwd = shown[i - 1].cwd || null;
          say(`${C.info}${shown[i - 1].title || sessionId}${C.off}`);
          break;
        }
        say(`${C.dim}${t("cli.enterNumOrN", { n: shown.length })}${C.off}`);
      }
    }
  } catch (e) {
    say(`${C.err}${t("cli.sessListFail", { msg: e.message })}${C.off}`);
  }
}
if (!sessionId) {
  sessionId = crypto.randomUUID();
  if (!cwd) cwd = cwdArg; // even with --new / direct launch, use --cwd as the working directory
  say(
    `${C.info}${t("cli.newSessionColon")} ${sessionId}${cwd ? `  ${C.dim}(cwd: ${cwd})` : ""}${C.off}`,
  );
}

// Even when only an ID is passed via --session, look up the cwd.
// Without cwd, the server uses its own startup directory and fails to resume a session
// from a different project.
if (sessionId && !cwd) {
  try {
    const { sessions = [] } = await api(
      `/api/sessions?provider=${encodeURIComponent(provider)}&limit=50`,
    );
    const selected = sessions.find((s) => s.id === sessionId);
    cwd = selected?.cwd || null;
  } catch {
    /* if the lookup fails, it's fine for a new session */
  }
}

// Print the recent history, then follow along (context is visible even after reconnecting)
try {
  // provider is required. Without it, the default backend is queried and the history comes back empty.
  const { history = [] } = await api(
    `/api/sessions/${encodeURIComponent(sessionId)}/history?limit=50&provider=${encodeURIComponent(provider)}`,
  );
  for (const m of history)
    say(m.role === "user" ? `${C.user}› ${m.text}${C.off}` : m.text);
} catch {
  /* for a new session, no history is normal */
}

// ── SSE (parsed by hand, zero dependencies) ──────────────────────
let pendingAnswer = null; // awaiting a permission/question response
let streaming = false;

let markReady;
const ready = new Promise((r) => {
  markReady = r;
}); // completion of the first SSE connection

async function subscribe() {
  const res = await fetch(
    `${url}/api/events?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}`,
    {
      headers: { Accept: "text/event-stream" },
    },
  );
  if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
  markReady();
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          handle(JSON.parse(line.slice(5).trim()));
        } catch {
          /* heartbeat etc. */
        }
      }
    }
  }
}

function handle(e) {
  switch (e.type) {
    case "user_prompt":
      say(`\n${C.user}› ${e.text}${C.off}`);
      prompt();
      break;
    case "status":
      if (e.state === "busy") setStatus(t("state.running"));
      else if (e.state === "think_start") setStatus(t("state.thinking"));
      else if (e.state === "think_end") setStatus(t("state.running"));
      else if (e.state === "text_start") {
        setStatus(t("state.responding"));
        unpaint();
        streaming = true;
      } else if (e.state === "text_end") {
        streaming = false;
        stdout.write("\n");
        prompt();
      }
      // The server is waiting on our response. It doesn't time out, so keep showing it.
      else if (e.state === "waiting")
        setStatus(t("state.waitingAnswer", { what: e.label ?? "" }), {
          wait: true,
        });
      else if (e.state === "idle") {
        awaiting = false;
        if (closed) exit(0);
        setStatus(t("state.waitingInput"), { running: false });
      }
      break;
    case "text_delta":
      stdout.write(e.text);
      break;
    // Turn complete. If the concrete model ID actually used is present (extension field), show it in dim text.
    case "result":
      if (e.model) say(`${C.dim}› model: ${e.model}${C.off}`);
      prompt();
      break;
    case "tool_end":
      say(`${C.dim}› ${e.name}${e.summary ? " " + e.summary : ""}${C.off}`);
      prompt();
      break;
    case "notification":
      say(`${C.dim}› ${e.title ?? ""} ${e.message ?? ""}${C.off}`);
      prompt();
      break;
    case "error":
      say(`${C.err}${e.message}${C.off}`);
      prompt();
      break;
    case "permission_request":
      askPermission(e);
      break;
    case "user_question":
      askQuestion(e);
      break;
    // If another client answered first, fold up our wait.
    // If it was released by an interrupt, no one answered, so say so (don't mislead into thinking someone answered).
    case "permission_result":
    case "question_answer":
      if (pendingAnswer) {
        say(
          `${C.dim}(${e.cancelled ? t("result.cancelled") : t("cli.answeredByOther")})${C.off}`,
        );
        pendingAnswer = null;
        basePrompt = "› ";
        prompt();
      }
      break;
  }
}

// ── Permission / question ────────────────────────────────────────
function choose(title, detail, options, send) {
  say(`\n${C.info}${title}${C.off}`);
  if (detail) say(`${C.dim}${detail}${C.off}`);
  options.forEach((o, i) =>
    say(`  ${i + 1}) ${o.label}${o.sub ? C.dim + " — " + o.sub + C.off : ""}`),
  );
  pendingAnswer = (input) => {
    const i = parseInt(input, 10);
    if (!(i >= 1 && i <= options.length)) {
      say(
        `${C.dim}${t("cli.enterNumToAnswer", { n: options.length })}${C.off}`,
      );
      return false;
    }
    send(options[i - 1].value);
    return true;
  };
  basePrompt = t("cli.numPrompt");
  rl.setPrompt(basePrompt);
  prompt();
}

function askPermission(e) {
  choose(
    t("permission.title", { tool: e.toolName ?? "" }),
    [e.description, e.detail].filter(Boolean).join("\n"),
    (e.options ?? []).map((o) => ({ label: o.text, value: o.key })),
    (decision) =>
      api("/api/permission-response", {
        method: "POST",
        body: JSON.stringify({ sessionId, decision }),
      }).catch(() => {}),
  );
}

function askQuestion(e) {
  const qs = e.questions ?? [];
  const answers = {};
  let i = 0;
  const next = () => {
    if (i >= qs.length) {
      // send answer as a double-encoded string (same shape as the original app)
      api("/api/question-response", {
        method: "POST",
        body: JSON.stringify({ sessionId, answer: JSON.stringify(answers) }),
      }).catch(() => {});
      basePrompt = "› ";
      rl.setPrompt(basePrompt);
      prompt();
      return;
    }
    const q = qs[i++];
    choose(
      q.header || t("cli.questionHeader"),
      q.question,
      (q.options ?? []).map((o) => ({
        label: o.label,
        sub: o.description,
        value: o.label,
      })),
      (label) => {
        answers[q.question] = label;
        next();
      },
    );
  };
  next();
}

// ── Input ──────────────────────────────────────────────
rl.on("line", async (line) => {
  const text = line.trim();
  shown = false; // the displayed prompt is finalized. Don't go clear it (it would erase the input echo)
  if (pendingAnswer) {
    if (pendingAnswer(text)) {
      pendingAnswer = null;
      basePrompt = "› ";
      rl.setPrompt(basePrompt);
    } else prompt();
    return;
  }
  if (!text) return prompt();
  if (text === "/quit" || text === "/exit") {
    rl.close();
    exit(0);
  }
  // /model <name> switches the model from here on (also remembered on the server and carried over to other clients).
  // /model on its own means "auto" = clearing the memory. Make it mean the same as "auto" in the WebUI dropdown
  // (if only this side stops sending locally, a lingering server-side memory would keep being carried over).
  if (text === "/model" || text.startsWith("/model ")) {
    model = text.slice("/model".length).trim() || null;
    try {
      // model:"" is a clear request. As with setting it, both the session and global defaults are targeted.
      await api("/api/model", {
        method: "POST",
        body: JSON.stringify({ sessionId, provider, model: model ?? "" }),
      });
    } catch {
      /* even if remembering fails, if specified, model is included when sending */
    }
    say(
      model
        ? `${C.info}${t("cli.modelSet", { model })}${C.off}`
        : `${C.info}${t("cli.modelAuto")}${C.off}`,
    );
    return prompt();
  }
  awaiting = true;
  try {
    const r = await api("/api/prompt", {
      method: "POST",
      body: JSON.stringify({
        text,
        sessionId,
        cwd,
        provider,
        model: model || undefined,
      }),
    });
    if (r.queued > 0)
      say(`${C.dim}${t("cli.queued", { count: r.queued })}${C.off}`);
  } catch (e) {
    awaiting = false;
    say(`${C.err}${t("cli.sendFail", { msg: e.message })}${C.off}`);
  }
  prompt();
});

let interrupted = false;
rl.on("SIGINT", () => {
  if (interrupted) {
    rl.close();
    exit(0);
  }
  interrupted = true;
  setTimeout(() => {
    interrupted = false;
  }, 1500);
  api("/api/interrupt", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  }).catch(() => {});
  say(`${C.dim}${t("cli.interrupted")}${C.off}`);
  prompt();
});

// Even if SSE drops, reconnect. State lives on the server, so reconnecting recovers it.
(async function loop() {
  for (;;) {
    try {
      await subscribe();
    } catch (e) {
      say(`${C.dim}${t("cli.disconnected", { msg: e.message })}${C.off}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
})();

// Don't accept input until SSE is fully established.
// Sending earlier would miss that turn's events entirely (the same trap as the original app).
await ready;
bootDone = true;
// Reflect the state at the moment of opening. SSE only streams "changes", so without this,
// connecting to a running session would stay at Waiting input.
try {
  const st = await api(
    `/api/status?sessionId=${encodeURIComponent(sessionId)}&provider=${encodeURIComponent(provider)}`,
  );
  if (st.state === "busy" && !statusWait) setStatus(t("state.running"));
} catch {
  /* even if it can't be fetched, the conversation still works */
}
if (closed) {
  if (!awaiting) exit(0);
} // stdin is already closed (e.g. </dev/null)
else {
  rl.resume();
  prompt();
}
