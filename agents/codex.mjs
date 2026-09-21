// agents/codex.mjs — Codex backend (optional dependency)
//
// Enabled if @openai/codex-sdk (= bundled with the Codex CLI) is present. Converts
// the App Server's structured JSON-RPC into even-terminal SSE events.
//
// Environment variables:
//   CODEX_MODEL             model (if unspecified, Codex's config/default)
//   CODEX_SANDBOX           read-only / workspace-write / danger-full-access
//   CODEX_APPROVAL_POLICY   never / on-request / on-failure / untrusted
//   CODEX_REASONING_EFFORT  reasoning effort. Validated against the selected model's model/list response
//   CODEX_HOME              Codex's state directory (default ~/.codex)
//   CODEX_USAGE_CACHE       rate-limit-window cache (default ~/.tmcon/codex-usage.json)

import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { CodexAppServer } from "./codex-app-server.mjs";

let Codex = null;
try {
  ({ Codex } = await import("@openai/codex-sdk"));
} catch {
  /* optional dependency */
}

export const available = !!Codex;
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
const str = (x) => (typeof x === "string" ? x : "");

const MODEL = process.env.CODEX_MODEL || undefined;
const SANDBOX = process.env.CODEX_SANDBOX || "workspace-write";
const APPROVAL = process.env.CODEX_APPROVAL_POLICY || "on-request";
const REASONING = process.env.CODEX_REASONING_EFFORT || undefined;
const CODEX_DIR = process.env.CODEX_HOME || join(homedir(), ".codex");
const MAP_FILE =
  process.env.CODEX_SESSION_MAP || join(homedir(), ".tmcon", "codex-map.json");
const running = new Map(); // even session id → {rpc, threadId, turnId}
const sessionCache = new Map(); // Codex id → metadata. Lets follow-up polling get by with just stat.
const inferredTitleCache = new Map(); // rollout path → { size, title }
const MODEL_CACHE_TTL = 5 * 60_000;
let modelCache = { at: 0, models: [], details: new Map() };
let modelWarmup = null;

// rate limits are per-account and shared across all sessions. A session that just
// hit the limit has its request fail and leaves no token_count, so it can't hold its
// own window info; therefore we pick up the most recent window info across all
// sessions and also keep it on disk to backfill after a restart.
const USAGE_CACHE_FILE =
  process.env.CODEX_USAGE_CACHE ||
  join(homedir(), ".tmcon", "codex-usage.json");
const GLOBAL_USAGE_TTL = 30_000; // short-lived memo to avoid a full scan on every poll
let globalUsageMemo = null; // { at: ms, value: {fiveHour, sevenDay} | null }

// The feature flag exposes the native tool, but this instruction makes natural
// multiple-choice requests reliably use it in Default mode. App-server supports
// developerInstructions on both start and resume.
export const CODEX_DEVELOPER_INSTRUCTIONS =
  "When you need the user to choose among two or three explicit, mutually exclusive options and wait for their selection, use request_user_input instead of asking in ordinary assistant text. Also use request_user_input when the user explicitly asks you to present a multiple-choice question. Do not use it for rhetorical questions or permission requests.";

export const codexThreadStartParams = (cwd) => ({
  cwd,
  approvalPolicy: APPROVAL,
  sandbox: SANDBOX,
  serviceName: "terminal-mode-console",
  developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
});
export const codexThreadResumeParams = (threadId) => ({
  threadId,
  developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
});

export const codexResponseModel = (...values) => {
  for (const raw of values) {
    const model = str(raw?.model);
    if (model) return model;
  }
  return "";
};
export function normalizeCodexModels(rawModels) {
  const details = new Map(),
    models = [];
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
    const value = codexResponseModel(raw) || str(raw?.id);
    if (!value || raw?.hidden) continue;
    details.set(value, raw);
    models.push({ value, label: str(raw?.displayName) || value });
  }
  return { models, details };
}

async function fetchCodexModels(rpc) {
  const all = [];
  let cursor;
  do {
    const result = obj(
      await rpc.request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      }),
    );
    const page = Array.isArray(result.data)
      ? result.data
      : Array.isArray(result.models)
        ? result.models
        : [];
    all.push(...page);
    cursor = str(result.nextCursor ?? result.next_cursor);
  } while (cursor);
  const normalized = normalizeCodexModels(all);
  modelCache = { at: Date.now(), ...normalized };
  return modelCache;
}

async function ensureCodexModels(rpc) {
  if (modelCache.at && Date.now() - modelCache.at < MODEL_CACHE_TTL)
    return modelCache;
  if (rpc) return fetchCodexModels(rpc);
  if (modelWarmup) return modelWarmup;
  modelWarmup = (async () => {
    const client = new CodexAppServer({ cwd: process.cwd() });
    try {
      await client.initialize();
      return await fetchCodexModels(client);
    } finally {
      client.close();
    }
  })()
    .catch(() => modelCache)
    .finally(() => {
      modelWarmup = null;
    });
  return modelWarmup;
}

export function codexEffortForModel(
  reasoning,
  model,
  details = modelCache.details,
) {
  const detail = model ? details.get(model) : null;
  const supported = Array.isArray(detail?.supportedReasoningEfforts)
    ? detail.supportedReasoningEfforts.map((x) => str(x?.reasoningEffort))
    : null;
  return reasoning && (!supported || supported.includes(reasoning))
    ? reasoning
    : undefined;
}

export function codexTurnStartParams(
  threadId,
  input,
  model,
  details = modelCache.details,
) {
  const effectiveModel = model || MODEL || undefined;
  const effort = codexEffortForModel(REASONING, effectiveModel, details);
  return {
    threadId,
    input,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(effort ? { effort } : {}),
  };
}

let aliases;
async function loadAliases() {
  if (aliases) return aliases;
  try {
    aliases = new Map(
      Object.entries(JSON.parse(await readFile(MAP_FILE, "utf8"))),
    );
  } catch {
    aliases = new Map();
  }
  return aliases;
}
async function saveAlias(from, to) {
  if (!from || !to || from === to) return;
  const map = await loadAliases();
  map.set(from, to);
  try {
    await mkdir(join(MAP_FILE, ".."), { recursive: true });
    await writeFile(
      MAP_FILE,
      JSON.stringify(Object.fromEntries(map), null, 2) + "\n",
    );
  } catch {
    /* even if the mapping table can't be written, let the current turn run to completion */
  }
}

async function jsonLines(path, visit) {
  try {
    const rl = createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      try {
        await visit(JSON.parse(line));
      } catch {
        /* skip broken/unknown lines */
      }
    }
  } catch {
    /* skip unreadable sessions from the list */
  }
}

async function sessionFiles(dir = join(CODEX_DIR, "sessions")) {
  const out = [];
  async function walk(path) {
    let ents;
    try {
      ents = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(path, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile() && extname(ent.name) === ".jsonl") out.push(p);
    }
  }
  await walk(dir);
  return out;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => b?.text ?? b?.input_text ?? b?.output_text ?? "")
    .join("")
    .trim();
}

async function metadata(path) {
  let meta = null;
  try {
    const rl = createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      try {
        const row = JSON.parse(line);
        if (row.type === "session_meta") meta = row.payload ?? null;
      } catch {
        /* malformed */
      }
      break; // session_meta is the first line. Don't read the whole huge rollout on every listing.
    }
  } catch {
    return null;
  }
  // Don't mix guardian / multi-agent internal threads into the human-facing list.
  if (!meta || meta.source?.subagent) return null;
  let modified = Date.now();
  try {
    modified = (await stat(path)).mtimeMs;
  } catch {
    /* keep now */
  }
  const result = {
    id: meta.id || meta.session_id,
    cwd: meta.cwd || "",
    timestamp: new Date(modified).toISOString(),
    path,
    meta,
  };
  if (result.id) sessionCache.set(result.id, result);
  return result;
}

async function titleIndex() {
  const titles = new Map();
  await jsonLines(join(CODEX_DIR, "session_index.jsonl"), (row) => {
    if (row.id && row.thread_name) titles.set(row.id, row.thread_name);
  });
  return titles;
}

// The client-side context that Codex mixes into the user role should not become
// the conversation title. Since a tag and the actual request can be in the same
// message, we remove only the blocks rather than skipping the message itself.
const NON_CONVERSATION_USER_BLOCKS = [
  "recommended_plugins",
  "environment_context",
];

export function titleFromUserText(value, maxLength = 64) {
  let text = String(value || "");
  for (const tag of NON_CONVERSATION_USER_BLOCKS) {
    text = text.replace(
      new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "gi"),
      " ",
    );
  }
  text = text
    .replace(/^\s*# AGENTS\.md instructions[^\n]*\n\s*/gim, "")
    .replace(/<INSTRUCTIONS(?:\s[^>]*)?>[\s\S]*?<\/INSTRUCTIONS>/gi, " ");
  text = text
    .replace(/<image\b[^>]*>(?:[^<]*<\/image>)?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLength).trim();
}

async function inferredSessionTitle(path) {
  let size;
  try {
    size = (await stat(path)).size;
  } catch {
    return "";
  }
  const cached = inferredTitleCache.get(path);
  if (cached && (cached.title || cached.size === size)) return cached.title;

  let title = "";
  try {
    const rl = createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        row.type !== "response_item" ||
        row.payload?.type !== "message" ||
        row.payload?.role !== "user"
      )
        continue;
      title = titleFromUserText(contentText(row.payload.content));
      if (title) break;
    }
    rl.close();
  } catch {
    /* for a broken/unreadable rollout, fall back to showing "session" as before */
  }
  inferredTitleCache.set(path, { size, title });
  return title;
}

async function findSession(id) {
  if (!id) return null;
  const mapped = (await loadAliases()).get(id) || id;
  const cached = sessionCache.get(mapped);
  if (cached) {
    try {
      const s = await stat(cached.path);
      return { ...cached, timestamp: new Date(s.mtimeMs).toISOString() };
    } catch {
      sessionCache.delete(mapped);
    }
  }
  for (const path of await sessionFiles()) {
    const m = await metadata(path);
    if (m?.id === mapped) return m;
  }
  return null;
}

const cursorOf = (s) => `${s.ino}:${s.size}:${Math.trunc(s.mtimeMs)}`;
function parseCursor(value) {
  const m = /^(\d+):(\d+):(\d+)$/.exec(value || "");
  return m
    ? { ino: Number(m[1]), size: Number(m[2]), mtime: Number(m[3]) }
    : null;
}
function historyItem(row) {
  if (row.type !== "response_item" || row.payload?.type !== "message")
    return null;
  const role = row.payload.role;
  if (role !== "user" && role !== "assistant") return null;
  const text = contentText(row.payload.content);
  return text ? { role, text } : null;
}

async function readAppended(path, offset, length) {
  if (length <= 0) return { items: [], consumed: 0 };
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) return { items: [], consumed: 0 }; // a partial write is re-read next time from the same offset
    const consumed = end + 1,
      out = [];
    for (const line of buf.subarray(0, consumed).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        const item = historyItem(JSON.parse(line));
        if (item) out.push(item);
      } catch {
        /* partial/unknown */
      }
    }
    return { items: out, consumed };
  } finally {
    await fh.close();
  }
}

function imageExt(value) {
  const type = /^data:([^;,]+)/i.exec(value)?.[1]?.toLowerCase();
  return type === "image/png"
    ? ".png"
    : type === "image/gif"
      ? ".gif"
      : type === "image/webp"
        ? ".webp"
        : ".jpg";
}
export async function buildInput(text, images) {
  const valid = (Array.isArray(images) ? images : []).filter(
    (x) => typeof x === "string" && x,
  );
  if (!valid.length)
    return { input: [{ type: "text", text }], cleanup: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), "even-codex-"));
  const input = [{ type: "text", text: text || "" }];
  for (let i = 0; i < valid.length; i++) {
    const raw = valid[i].replace(/^data:[^;,]*;base64,/i, "");
    const path = join(dir, `image-${i}${imageExt(valid[i])}`);
    await writeFile(path, Buffer.from(raw, "base64"));
    input.push({ type: "localImage", path });
  }
  return { input, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const finite = (...values) => values.find((value) => Number.isFinite(value));
const isoFromSeconds = (value) =>
  Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;

/** Normalize both the rollout's token_count (snake_case) and the App Server
 * notification (camelCase) into the usage shape shared by the WebUI. Context is the
 * share the most recent request occupies, not a cumulative value. Rate-limit windows
 * are identified by duration, and fall back to primary/secondary in the old format. */
export function normalizeCodexUsage(payload) {
  const p = obj(payload),
    info = obj(p.info ?? p.tokenUsage),
    limits = obj(p.rate_limits ?? p.rateLimits);
  const last = obj(info.last_token_usage ?? info.last);
  const used = finite(last.total_tokens, last.totalTokens);
  const max = finite(info.model_context_window, info.modelContextWindow);
  const windows = [limits.primary, limits.secondary].filter(
    (x) => x && typeof x === "object",
  );
  const duration = (x) => finite(x.window_minutes, x.windowDurationMins);
  const five = windows.find((x) => duration(x) === 300) ?? limits.primary;
  const week = windows.find((x) => duration(x) === 10080) ?? limits.secondary;
  const window = (x) =>
    x && typeof x === "object"
      ? {
          utilization: finite(x.used_percent, x.usedPercent) ?? null,
          resetsAt: isoFromSeconds(finite(x.resets_at, x.resetsAt)),
        }
      : null;
  return {
    context:
      Number.isFinite(used) && Number.isFinite(max) && max > 0
        ? { utilization: (used / max) * 100 }
        : null,
    fiveHour: window(five),
    sevenDay: window(week),
  };
}

const hasWindows = (payload) => {
  const u = normalizeCodexUsage(payload);
  return !!(u.fiveHour?.resetsAt || u.sevenDay?.resetsAt);
};

/** Search for token_count from the tail end, without reading the whole potentially huge rollout.
 * newest    = the latest token_count (for context)
 * withLimits = the latest token_count whose rate windows are non-null (when the limit
 *              is hit, the tail has null primary/secondary, so use the last healthy one before it)
 * Stop once both are found or we've gone back MAX. */
async function latestTokenCounts(path) {
  const s = await stat(path),
    fh = await open(path, "r");
  const CHUNK = 64 * 1024,
    MAX = 2 * 1024 * 1024;
  let end = s.size,
    tail = "",
    newest = null,
    withLimits = null;
  try {
    while (
      end > 0 &&
      Buffer.byteLength(tail) < MAX &&
      !(newest && withLimits)
    ) {
      const size = Math.min(CHUNK, end),
        buf = Buffer.alloc(size);
      end -= size;
      const { bytesRead } = await fh.read(buf, 0, size, end);
      tail = buf.subarray(0, bytesRead).toString("utf8") + tail;
      const lines = tail.split("\n");
      // The first line may be cut off at the chunk boundary, so exclude it while there's still more before it.
      for (let i = lines.length - 1; i >= (end > 0 ? 1 : 0); i--) {
        let row;
        try {
          row = JSON.parse(lines[i]);
        } catch {
          continue; /* partial / malformed */
        }
        if (row.type !== "event_msg" || row.payload?.type !== "token_count")
          continue;
        if (!newest) newest = row.payload;
        if (!withLimits && hasWindows(row.payload)) withLimits = row.payload;
        if (newest && withLimits) break;
      }
    }
  } finally {
    await fh.close();
  }
  return { newest, withLimits };
}

async function saveGlobalUsage(value) {
  try {
    await mkdir(join(USAGE_CACHE_FILE, ".."), { recursive: true });
    await writeFile(USAGE_CACHE_FILE, JSON.stringify(value, null, 2) + "\n");
  } catch {
    /* not fatal if the cache can't be written */
  }
}
async function loadGlobalUsage() {
  try {
    return JSON.parse(await readFile(USAGE_CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}
/** Update the cache with new window info. When only one window is present, keep the
 * previous value and don't wipe the other window (a limit message shows only one of the 5h/weekly windows). */
async function persistGlobal(value) {
  const prior = globalUsageMemo?.value || (await loadGlobalUsage()) || {};
  const merged = {
    fiveHour: value.fiveHour ?? prior.fiveHour ?? null,
    sevenDay: value.sevenDay ?? prior.sevenDay ?? null,
  };
  globalUsageMemo = { at: Date.now(), value: merged };
  await saveGlobalUsage(merged);
  return true;
}

/** Recover from the usageLimitExceeded text (e.g. "... try again at 5:59 PM.").
 * When the limit is hit the structured rate_limits become null and the reset time
 * only survives in this text. If it's an absolute datetime use it as-is; if it's a
 * time only, treat it as the next occurrence of that time in local time. */
export function resetFromMessage(message) {
  const m = str(message);
  const at = /try again (?:at|after) ([^.]+?)(?:\.|$)/i.exec(m);
  if (!at) return null;
  const when = at[1].trim();
  const direct = new Date(when);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const t = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(when);
  if (!t) return null;
  let hour = Number(t[1]);
  const min = Number(t[2]);
  const ap = (t[3] || "").toUpperCase();
  if (ap === "PM" && hour < 12) hour += 12;
  if (ap === "AM" && hour === 12) hour = 0;
  const now = new Date(),
    d = new Date(now);
  d.setHours(hour, min, 0, 0);
  if (d.getTime() <= now.getTime() - 60_000) d.setDate(d.getDate() + 1); // if the time is in the past, treat it as tomorrow
  return d.toISOString();
}

/** Determine the account-wide rate windows (5h / weekly) across all sessions.
 * Inspect token_count starting from the most recently updated session and adopt the
 * first window that has resets_at. If the scan finds nothing, fall back to the disk cache. */
async function globalRateLimits() {
  if (globalUsageMemo && Date.now() - globalUsageMemo.at < GLOBAL_USAGE_TTL)
    return globalUsageMemo.value;
  const stated = [];
  for (const path of await sessionFiles()) {
    try {
      stated.push({ path, mtime: (await stat(path)).mtimeMs });
    } catch {
      /* skip ones that can't be read */
    }
  }
  stated.sort((a, b) => b.mtime - a.mtime);
  let value = null;
  for (const { path } of stated.slice(0, 15)) {
    const { withLimits } = await latestTokenCounts(path);
    if (!withLimits) continue;
    const u = normalizeCodexUsage(withLimits);
    value = { fiveHour: u.fiveHour, sevenDay: u.sevenDay };
    break;
  }
  if (value) await saveGlobalUsage(value);
  else value = await loadGlobalUsage(); // if the scan finds nothing, backfill with the previous value
  globalUsageMemo = { at: Date.now(), value };
  return value;
}

/** Reflect window info from a failed-turn notification into the cache. At the moment
 * the limit is hit via terminal-mode-console, the rollout's tail token_count becomes
 * null and gets lost, so we grab this primary source. Prefer structured rate_limits;
 * if absent, recover the reset time from the usageLimitExceeded text. */
async function cacheUsageFromError(...payloads) {
  for (const raw of payloads) {
    const p = obj(raw),
      err = obj(p.error),
      turn = obj(p.turn),
      terr = obj(turn.error);
    const limits =
      p.rate_limits ?? p.rateLimits ?? err.rate_limits ?? err.rateLimits;
    if (limits) {
      const u = normalizeCodexUsage({ rate_limits: limits });
      if (u.fiveHour?.resetsAt || u.sevenDay?.resetsAt)
        return persistGlobal({ fiveHour: u.fiveHour, sevenDay: u.sevenDay });
    }
    const info = str(
      err.codexErrorInfo || p.codexErrorInfo || terr.codexErrorInfo,
    );
    const message = str(err.message || p.message || terr.message);
    if (info === "usageLimitExceeded" || /usage limit/i.test(message)) {
      const reset = resetFromMessage(message);
      if (reset) {
        const within6h = new Date(reset).getTime() - Date.now() <= 6 * 3600_000;
        const w = { utilization: 100, resetsAt: reset }; // hitting the limit = that window is effectively 100%
        return persistGlobal(within6h ? { fiveHour: w } : { sevenDay: w });
      }
    }
  }
  return false;
}

/** App Server versions have reported terminal failures both as an `error`
 * notification and inside the failed turn. Keep the extraction deliberately
 * tolerant so a protocol field rename does not turn the failure silent again. */
export function codexFailureMessage(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    const valueObj = obj(value);
    for (const candidate of [
      valueObj.message,
      valueObj.error,
      valueObj.detail,
      valueObj.reason,
    ]) {
      if (typeof candidate === "string" && candidate.trim())
        return candidate.trim();
      const nested = obj(candidate);
      if (typeof nested.message === "string" && nested.message.trim())
        return nested.message.trim();
    }
  }
  return "Codex turn failed without an error message.";
}

export async function handleRequest(rpc, req, ask) {
  const p = obj(req.params);
  try {
    if (req.method === "item/tool/requestUserInput") {
      const source = Array.isArray(p.questions) ? p.questions : [];
      const questions = source.map((raw) => {
        const q = obj(raw);
        return {
          question: str(q.question),
          header: str(q.header),
          options: (Array.isArray(q.options) ? q.options : []).map((x) => {
            const o = obj(x);
            return { label: str(o.label), description: str(o.description) };
          }),
        };
      });
      const byText = await ask.question({
        questions,
        toolUseId: String(req.id),
      });
      const answers = {};
      source.forEach((raw, i) => {
        const q = obj(raw),
          v = byText[str(q.question)];
        answers[str(q.id) || `q${i + 1}`] = Array.isArray(v)
          ? v
          : [String(v ?? "skip")];
      });
      rpc.respond(req.id, {
        answers: Object.fromEntries(
          Object.entries(answers).map(([id, values]) => [
            id,
            { answers: values },
          ]),
        ),
      });
      return;
    }
    if (
      req.method === "item/commandExecution/requestApproval" ||
      req.method === "item/fileChange/requestApproval"
    ) {
      const toolName = req.method.includes("commandExecution")
        ? "bash"
        : "apply_patch";
      const detail = str(p.command) || str(p.reason) || str(p.grantRoot);
      const choice = await ask.permission({
        toolName,
        description: detail || toolName,
        detail,
        toolUseId: String(req.id),
        options: [
          { text: "Allow once", key: "allow" },
          { text: "Allow for session", key: "allowAlways" },
          { text: "Decline", key: "deny" },
        ],
      });
      rpc.respond(req.id, {
        decision:
          choice === "allow"
            ? "accept"
            : choice === "allowAlways"
              ? "acceptForSession"
              : "decline",
      });
      return;
    }
    if (req.method === "item/permissions/requestApproval") {
      const choice = await ask.permission({
        toolName: "permissions",
        description: str(p.reason) || "Additional permissions",
        detail: str(p.cwd),
        toolUseId: String(req.id),
        options: [
          { text: "Allow this turn", key: "allow" },
          { text: "Allow for session", key: "allowAlways" },
          { text: "Decline", key: "deny" },
        ],
      });
      rpc.respond(req.id, {
        permissions: choice === "deny" ? {} : (p.permissions ?? {}),
        scope: choice === "allowAlways" ? "session" : "turn",
      });
      return;
    }
    rpc.reject(req.id, -32601, `unsupported Codex request: ${req.method}`);
  } catch (error) {
    rpc.reject(req.id, -32603, error.message || "request failed");
  }
}

export default {
  name: "codex",

  describe() {
    if (available) void ensureCodexModels();
    return {
      label: "Codex",
      model: MODEL || "(Codex default)",
      endpoint: "Codex SDK (local child process)",
      models: modelCache.models,
    };
  },

  /** A saved rollout's token_count includes both context and rate limits. For context
   * we use the latest one; for the windows we use "the latest non-null one" (at the
   * limit, the tail's windows are null). If windows are still missing, we backfill the
   * reset datetime from the account-wide most recent rate windows (from other sessions/error text/cache). */
  async getUsage(session) {
    const found = await findSession(session.id);
    const { newest, withLimits } = found
      ? await latestTokenCounts(found.path)
      : {};
    const base = newest
      ? normalizeCodexUsage(newest)
      : { context: null, fiveHour: null, sevenDay: null };
    const own = withLimits ? normalizeCodexUsage(withLimits) : null;
    const usage = {
      context: base.context,
      fiveHour: base.fiveHour?.resetsAt
        ? base.fiveHour
        : (own?.fiveHour ?? base.fiveHour),
      sevenDay: base.sevenDay?.resetsAt
        ? base.sevenDay
        : (own?.sevenDay ?? base.sevenDay),
    };
    if (!usage.fiveHour?.resetsAt || !usage.sevenDay?.resetsAt) {
      const global = await globalRateLimits();
      if (global) {
        if (!usage.fiveHour?.resetsAt && global.fiveHour)
          usage.fiveHour = global.fiveHour;
        if (!usage.sevenDay?.resetsAt && global.sevenDay)
          usage.sevenDay = global.sevenDay;
      }
    }
    return usage;
  },

  async listSessions(limit = 30, cwd) {
    const titles = await titleIndex();
    const found = [];
    for (const path of await sessionFiles()) {
      const m = await metadata(path);
      if (!m?.id || (cwd && m.cwd !== cwd)) continue;
      const indexedTitle = String(titles.get(m.id) || "").trim();
      const title =
        indexedTitle && indexedTitle !== "session"
          ? indexedTitle
          : (await inferredSessionTitle(path)) || "session";
      found.push({
        id: m.id,
        title: `  ${title}`,
        timestamp: m.timestamp,
        cwd: m.cwd,
        provider: "codex",
        status: "idle",
      });
    }
    return found
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, limit);
  },

  async getHistory(session, limit = 10) {
    const found = await findSession(session.id);
    if (!found) return [];
    const out = [];
    await jsonLines(found.path, (row) => {
      const item = historyItem(row);
      if (item) out.push(item);
    });
    return out.slice(-limit);
  },

  /** For read-only following. If the cursor is unchanged, just stat; if appended to, read only the added bytes. */
  async getHistoryUpdate(session, limit = 10, cursor = "") {
    const found = await findSession(session.id);
    if (!found)
      return { history: [], cursor: "", unchanged: true, replace: false };
    const s = await stat(found.path);
    const prior = parseCursor(cursor);
    if (!prior) {
      const history = await this.getHistory(session, limit);
      const after = await stat(found.path);
      return {
        history,
        cursor: cursorOf(after),
        unchanged: false,
        replace: true,
      };
    }
    if (
      prior.ino === Number(s.ino) &&
      prior.size === s.size &&
      prior.mtime === Math.trunc(s.mtimeMs)
    ) {
      return { history: [], cursor, unchanged: true, replace: false };
    }
    if (prior.ino === Number(s.ino) && s.size >= prior.size) {
      const added = await readAppended(
        found.path,
        prior.size,
        s.size - prior.size,
      );
      return {
        history: added.items,
        cursor: `${s.ino}:${prior.size + added.consumed}:${Math.trunc(s.mtimeMs)}`,
        unchanged: added.consumed === 0,
        replace: false,
      };
    }
    // Only on truncate / rotate / inode change, fetch the whole tail history and replace.
    const history = await this.getHistory(session, limit);
    const after = await stat(found.path);
    return {
      history,
      cursor: cursorOf(after),
      unchanged: false,
      replace: true,
    };
  },

  async runTurn({ session, text, images, model, emit, ask }) {
    const startedAt = Date.now();
    const known = await findSession(session.id);
    const cwd =
      known?.cwd ||
      (session.cwd && existsSync(session.cwd) ? session.cwd : process.cwd());
    const rpc = new CodexAppServer({ cwd });
    const prepared = await buildInput(text, images);
    const activeTools = new Map();
    let full = "",
      success = false,
      usage = null,
      failure = "",
      actualId = known?.id,
      turnId,
      actualModel = null,
      finish;
    const completed = new Promise((resolve) => {
      finish = resolve;
    });

    rpc.on("request", (req) => void handleRequest(rpc, req, ask));
    rpc.on("notification", (method, params) => {
      const p = obj(params),
        item = obj(p.item),
        id = str(item.id);
      if (method === "item/agentMessage/delta") {
        const delta = str(p.delta);
        if (!full)
          emit({ type: "status", state: "text_start", sessionId: session.id });
        full += delta;
        emit({ type: "text_delta", text: delta });
      } else if (method === "item/reasoning/summaryTextDelta")
        emit({ type: "status", state: "think_start", sessionId: session.id });
      else if (method === "item/started") {
        const name =
          item.type === "commandExecution"
            ? "bash"
            : item.type === "fileChange"
              ? "apply_patch"
              : item.type === "mcpToolCall"
                ? `${str(item.server) || "mcp"}.${str(item.tool) || "tool"}`
                : item.type === "webSearch"
                  ? "web_search"
                  : "";
        if (name) {
          activeTools.set(id, name);
          emit({ type: "tool_start", name, toolId: id });
        }
      } else if (method === "item/completed" && activeTools.has(id)) {
        const name = activeTools.get(id);
        activeTools.delete(id);
        emit({ type: "tool_end", name, toolId: id, summary: name });
      } else if (method === "account/rateLimits/updated") {
        void cacheUsageFromError(p); // if windows are non-null, reflect the latest utilization/reset
      } else if (method === "error") {
        // Codex may retry after this notification. Retain the latest reason but
        // only surface it if the turn ultimately fails.
        failure = codexFailureMessage(p.error, p);
        void cacheUsageFromError(p); // don't miss the window info/text of a limit error
      } else if (method === "turn/completed") {
        const turn = obj(p.turn);
        success = turn.status !== "failed";
        usage = obj(turn.usage);
        if (!success) {
          failure = codexFailureMessage(turn.error, p.error, failure, turn);
          void cacheUsageFromError(p);
        }
        finish();
      }
    });

    try {
      await rpc.initialize();
      await ensureCodexModels(rpc).catch(() => modelCache);
      if (known) {
        const resumed = obj(
          await rpc.request("thread/resume", codexThreadResumeParams(known.id)),
        );
        actualModel = codexResponseModel(obj(resumed.thread), resumed);
      } else {
        const started = obj(
          await rpc.request("thread/start", codexThreadStartParams(cwd)),
        );
        const thread = obj(started.thread);
        actualId = str(thread.id);
        actualModel = codexResponseModel(thread, started);
        await saveAlias(session.id, actualId);
      }
      const effectiveModel = model || MODEL || undefined;
      const turn = obj(
        await rpc.request(
          "turn/start",
          codexTurnStartParams(actualId, prepared.input, model),
        ),
      );
      actualModel =
        codexResponseModel(obj(turn.turn), turn) ||
        effectiveModel ||
        actualModel;
      turnId = str(obj(turn.turn).id);
      running.set(session.id, { rpc, threadId: actualId, turnId });
      await completed;
      if (!success)
        emit({
          type: "error",
          message: `codex: ${failure || codexFailureMessage()}`,
        });
    } catch (err) {
      emit({ type: "error", message: `codex: ${err.message}` });
    } finally {
      if (full)
        emit({ type: "status", state: "text_end", sessionId: session.id });
      rpc.close();
      await prepared.cleanup().catch(() => {});
      running.delete(session.id);
      if (full) session.history.push({ role: "assistant", content: full });
      emit({
        type: "result",
        success,
        text: full,
        sessionId: session.id,
        provider: "codex",
        model: actualModel || null,
        costUsd: 0,
        turns: 1,
        durationMs: Date.now() - startedAt,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        ...(actualId ? { backendSessionId: actualId } : {}),
      });
    }
  },

  async interrupt(session) {
    const r = running.get(session.id);
    if (!r) return;
    try {
      await r.rpc.request("turn/interrupt", {
        threadId: r.threadId,
        turnId: r.turnId,
      });
    } catch {
      /* completion race */
    }
  },
};
