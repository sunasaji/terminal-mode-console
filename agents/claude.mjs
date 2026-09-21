// agents/claude.mjs — Claude Code backend (optional dependency)
//
// Enabled when @anthropic-ai/claude-agent-sdk is installed. If not installed,
// available=false and the registry silently skips it. If you only use local
// LLMs, it stays dependency-free.
//
//   npm install --omit=optional   → local / echo only
//   npm install                   → claude available too
//
// [Approach] Open exactly one query() per session (streaming input); each turn
// pushes a user message into that input channel to drive it. A single reader
// loop handles all messages from that query. Conversation state is persisted in
// Claude's own JSONL.
//
// Why per-turn (re-opening a query every turn and closing it on result) was
// dropped: In Claude Code 2.1.2xx the Agent (sub-agent) tool became background
// execution by default. The main turn just launches the sub-agent and returns a
// result immediately; completion arrives later as a follow-up message triggered
// by a task-notification (a result carrying an origin) flowing into the same
// query. With per-turn, the result would close the query — and thus the child
// process — killing any running background agent along with it. With a
// persistent query the child process stays alive so agents don't die, and the
// main turn's result can still return runTurn and bring the bus back to idle, so
// you can keep talking to the foreground agent even while background execution
// is in progress (in 2.1.2xx the old "freezes on the second turn" issue is also
// resolved).
//
// Foreground (user turn) completion and background-triggered completion are
// distinguished by result.origin (user turn = no origin / background =
// origin.kind==="task-notification"). This prevents mistakenly treating a later,
// separate turn as an early completion.
//
// [Model selection] Switchable per turn. The effective model is resolved in this
// order:
//   (1) the request's model (WebUI dropdown / CLI --model or /model)
//   (2) the value the server remembered (this conversation → the provider-wide
//       global default; server.mjs resolves and passes it)
//   (3) env CLAUDE_MODEL  (4) Claude Code's default
// Switching an existing session is done with Query.setModel() (an API specific
// to streaming input) without re-opening the query. Only on cold-open is it put
// on query()'s options. The concrete model ID actually used (the alias's
// resolution result) is picked up from the assistant message's message.model and
// attached to the result.
//
// Environment variables:
//   CLAUDE_MODEL            default when no model is specified (item ③ above; if
//                           unset, Claude Code's default)
//   CLAUDE_PERMISSION_MODE  default acceptEdits
//   CLAUDE_AUTO_ALLOW       tool names to allow without confirmation (comma-separated)
//   CLAUDE_AUTO_COMPACT     default off. 1/true/on enables the SDK's auto
//                           compaction. By default, long threads are meant to be
//                           handled by running /compact manually or by emitting a
//                           handoff prompt and moving to a new thread, so they are
//                           not auto-compacted.
//   CLAUDE_DEBUG=1          write the SDK/CLI stderr to the server log (for diagnostics)

import { existsSync, mkdirSync } from "node:fs";
import { makeT } from "../i18n.mjs";

// Notification strings are localized via the shared i18n loader (server locale).
const { t } = makeT();

let query = null,
  listSessionsSdk = null,
  getSessionMessages = null;
try {
  ({
    query,
    listSessions: listSessionsSdk,
    getSessionMessages,
  } = await import("@anthropic-ai/claude-agent-sdk"));
} catch {
  // Not installed. available=false, so it is not registered.
}

export const available = !!query;

const MODEL = process.env.CLAUDE_MODEL || undefined;
// Choices for the model-selection dropdown. Since these are aliases, Claude Code
// always resolves them to the latest model (they hold no fixed ID like
// claude-opus-4-6 = no rework needed on model updates).
// "default" is the alias that reverts to the account default.
// label holds only language-independent proper nouns; supplementary text is
// passed via noteKey (a WebUI i18n key). The server does not know the display
// language, so translations live on the client side.
const MODEL_CHOICES = [
  { value: "default", label: "Default", noteKey: "model.note.default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  // fable can incur pay-as-you-go credit billing on the Pro plan (on Max it is within the standard quota).
  { value: "fable", label: "Fable", noteKey: "model.note.fable" },
];
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || "acceptEdits";
const DEBUG = process.env.CLAUDE_DEBUG === "1";
// Auto compaction is off by default. Enable it with CLAUDE_AUTO_COMPACT=1/true/on.
// The value is injected into the query's settings (the flag settings layer =
// higher priority than user/project settings.json), so this default reliably
// takes effect regardless of what settings.json says.
const AUTO_COMPACT = /^(1|true|on|yes)$/i.test(
  process.env.CLAUDE_AUTO_COMPACT ?? "",
);
const AUTO_ALLOW = new Set(
  (
    process.env.CLAUDE_AUTO_ALLOW ??
    "Read,Glob,Grep,WebSearch,WebFetch,TaskOutput,ExitPlanMode,ListMcpResources,ReadMcpResource"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// A persistent query that has been idle for this long is torn down to free the
// child process (default 10 minutes). While a background agent is running,
// task_progress and the like keep flowing and lastActivity keeps being updated,
// so anything in progress is not torn down. 0 disables GC.
const SESSION_IDLE_MS = parseInt(
  process.env.CLAUDE_SESSION_IDLE_MS ?? "600000",
  10,
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collapse the SDK's experimental /usage response into a small, stable shape for the WebUI. */
export function normalizeClaudeUsage(context, usage) {
  const window = (value) =>
    value && typeof value === "object"
      ? {
          utilization: Number.isFinite(value.utilization)
            ? value.utilization
            : null,
          resetsAt:
            typeof value.resets_at === "string" ? value.resets_at : null,
        }
      : null;
  const limits = usage?.rate_limits_available ? usage.rate_limits : null;
  return {
    context: Number.isFinite(context?.percentage)
      ? { utilization: context.percentage }
      : null,
    fiveHour: window(limits?.five_hour),
    sevenDay: window(limits?.seven_day),
  };
}

/** Extract just the body text from a JSONL message (content is a string or a block array) */
function textOf(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reconstruct "question → answer" from the AskUserQuestion tool_result string.
 *  Format: `Your questions have been answered: "Q"="A"[, "Q2"="A2"]. You can now continue...`
 *  The question text is known from the tool_use side, so use it as the key to
 *  slice out the answer. Even if extraction fails, the conversation can still be
 *  displayed, so on failure return it empty. */
function parseQuestionAnswers(content, questions) {
  const answers = {};
  if (typeof content !== "string" || !content) return answers;
  const body =
    /answered:\s*([\s\S]*?)\.\s*You can now continue/i.exec(content)?.[1] ??
    content;
  for (const q of questions) {
    const key = q.question || "";
    if (!key) continue;
    const re = new RegExp(
      '"' + escapeRe(key) + '"\\s*=\\s*"([\\s\\S]*?)"(?=\\s*,\\s*"|\\s*$)',
    );
    const m = re.exec(body);
    if (m) answers[key] = m[1];
  }
  // Fallback: if there is only one question and the key match failed, treat the trailing ="..." as the answer.
  if (!Object.keys(answers).length && questions.length === 1) {
    const m = /=\s*"([\s\S]*)"\s*$/.exec(body.trim());
    if (m) answers[questions[0].question || ""] = m[1];
  }
  return answers;
}

/** Convert an image coming from the WebUI (a data URL or raw base64) into an
 *  Anthropic image block. Vision input can only be placed in the content array
 *  of a user message, so the prompt must be a structured message rather than a
 *  string (see buildUserMessage below). Only jpeg/png/gif/webp are allowed for
 *  media_type. If absent from the data URL, it is assumed to be jpeg (the same
 *  default as local-llm's toDataUrl). */
function toImageBlock(img) {
  if (typeof img !== "string" || !img) return null;
  const ALLOWED = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);
  const m = /^data:([^;,]*);base64,(.*)$/is.exec(img);
  const data = m ? m[2] : img; // if not a data URL, treat it as raw base64
  let mt = (m ? m[1] : "").toLowerCase();
  if (mt === "image/jpg") mt = "image/jpeg";
  if (!ALLOWED.has(mt)) mt = "image/jpeg";
  if (!data) return null;
  return { type: "image", source: { type: "base64", media_type: mt, data } };
}

/** Build one turn's user message to push into the input channel. If there are no
 *  images, content is a string; if there are, it becomes a [text, ...image]
 *  array (Vision input can only be placed in the content array). */
function buildUserMessage(text, images) {
  const blocks = (Array.isArray(images) ? images : [])
    .map(toImageBlock)
    .filter(Boolean);
  const content = blocks.length
    ? [{ type: "text", text: text || "" }, ...blocks]
    : text || "";
  return {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content },
  };
}

/** Make a short label that fits on a single line of the glasses. The screen is small, so brevity is king. */
function summarize(name, input = {}) {
  const pick =
    input.command ??
    input.pattern ??
    input.file_path ??
    input.query ??
    input.url ??
    input.description;
  const s = pick == null ? "" : String(pick).replace(/\s+/g, " ").trim();
  return s.length > 48 ? s.slice(0, 47) + "…" : s;
}

/** Check whether a conversation with that ID exists on the Claude side and, if
 *  so, return it along with its working directory. resume looks for the
 *  conversation under the project (=cwd), so if the cwd mismatches it fails with
 *  "No conversation found with session ID". Even if the client does not send a
 *  cwd, make sure we can supply the correct cwd here. */
async function findOnDisk(id) {
  if (!listSessionsSdk || !UUID_RE.test(id)) return null;
  try {
    const all = await listSessionsSdk({ limit: 200 });
    return all.find((s) => s.sessionId === id) ?? null;
  } catch {
    return null;
  }
}

/** canUseTool: bridge tool-execution permission / answers to questions to the user via the bus */
function makeCanUseTool(ask) {
  return async (toolName, input, options) => {
    // AskUserQuestion is a channel that returns an "answer", not "permission".
    // The SDK's contract is to allow it with the answers placed on updatedInput.
    if (toolName === "AskUserQuestion") {
      const questions = (input.questions ?? []).map((q) => ({
        question: q.question ?? "",
        header: q.header ?? "",
        options: (q.options ?? []).map((o) => ({
          label: o.label ?? "",
          description: o.description ?? "",
          preview: o.preview ?? "",
        })),
      }));
      const answers = await ask.question({
        questions,
        toolUseId: options?.toolUseID,
      });
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    if (AUTO_ALLOW.has(toolName))
      return { behavior: "allow", updatedInput: input };

    const decision = await ask.permission({
      toolName,
      description: `${toolName} ${summarize(toolName, input)}`.trim(),
      detail: summarize(toolName, input),
      toolUseId: options?.toolUseID,
      options: [
        { text: "Yes", key: "allow" },
        { text: `Yes, and always allow ${toolName}`, key: "allowAlways" },
        { text: "No", key: "deny" },
      ],
      suggestions: options?.suggestions ?? null,
    });
    if (decision === "allowAlways") AUTO_ALLOW.add(toolName);
    return decision === "deny"
      ? { behavior: "deny", message: t("notify.denied") }
      : { behavior: "allow", updatedInput: input };
  };
}

// ── Persistent connection (1 session = 1 query = 1 child process) ─────────────────────
/** sessionId → conn. A conn holds the query itself, the input channel that feeds
 *  user turns into it, and the state of the single reader loop. */
const conns = new Map();

/** A sentinel to release a waiting runTurn when the reader ends (disconnect / interrupt). */
const CANCELLED = Symbol("cancelled");

/** The input channel for streaming-input. It yields pushed user messages in
 *  order, and if none are buffered it waits for the next push. close ends the
 *  generator. */
function makeInput() {
  const buf = [];
  let wake = null,
    closed = false;
  const gen = (async function* () {
    for (;;) {
      while (buf.length) yield buf.shift();
      if (closed) return;
      await new Promise((r) => (wake = r));
      wake = null;
    }
  })();
  return {
    gen,
    push(m) {
      buf.push(m);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

/** The single loop that handles all messages from that query. On a foreground
 *  result it returns the corresponding runTurn, and it keeps streaming
 *  background (origin-carrying) follow-ups to the SSE. */
export async function runReader(conn) {
  const { session } = conn;
  const emit = (e) => {
    conn.lastActivity = Date.now();
    conn.emit(e);
  };
  const status = (state) =>
    emit({ type: "status", state, sessionId: session.id });
  const notify = (title, message) =>
    emit({ type: "notification", title, message });
  // Re-emit the "ambient state" when no foreground turn is running. If a
  // background is active, emit background rather than idle (="Waiting input") so
  // it is clear something is in progress. The bus unconditionally emits idle
  // after a foreground result, so afterwards, every time a background system
  // message arrives, re-assert and bring the WebUI's bottom line back to
  // background.
  const setAmbient = () => {
    if (conn.pendingFg.length) return; // during a foreground turn, leave it to the normal flow
    if (conn.bgCount > 0) {
      // background overrides the idle the bus emits out-of-band, so re-emit it every time (do not suppress).
      conn.ambientState = "background";
      emit({
        type: "status",
        state: "background",
        sessionId: session.id,
        count: conn.bgCount,
      });
    } else {
      if (conn.ambientState === "idle") return; // suppress consecutive idles (prevents duplicates right after completion)
      conn.ambientState = "idle";
      emit({ type: "status", state: "idle", sessionId: session.id }); // all done → back to Waiting input
    }
  };
  try {
    for await (const msg of conn.q) {
      conn.lastActivity = Date.now();
      switch (msg.type) {
        case "system": {
          // Track the rise and fall of active background tasks (tasks is the current full set).
          if (msg.subtype === "background_tasks_changed") {
            const tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
            const prev = conn.bgCount;
            conn.bgCount = tasks.length;
            if (prev === 0 && tasks.length > 0) {
              const desc = tasks
                .map((task) => task.description)
                .filter(Boolean)
                .slice(0, 3)
                .join(" / ");
              notify(
                t("notify.bg.runningTitle"),
                desc
                  ? t("notify.bg.runningDesc", { count: tasks.length, desc })
                  : t("notify.bg.runningCount", { count: tasks.length }),
              );
            } else if (prev > 0 && tasks.length === 0) {
              notify(t("notify.bg.doneTitle"), t("notify.bg.doneMessage"));
              // A background (Task sub-agent) lifecycle has completed on this
              // persistent query. Empirically the SDK then stops producing a
              // foreground result for the *next* streaming-input user message,
              // so runTurn's await would hang ("Running..." forever). Mark the
              // connection so the next turn recycles the query (close + reopen
              // with resume, preserving context) instead of reusing this one.
              conn.staleAfterBg = true;
            }
          }
          // Every time a background-originated system message (task_progress /
          // task_updated etc.) arrives, bring the bottom line back to background
          // (do not leave it overwritten by the bus's idle).
          setAmbient();
          break;
        }
        case "stream_event": {
          const ev = msg.event;
          if (
            ev.type === "content_block_start" &&
            ev.content_block?.type === "thinking"
          ) {
            conn.st.thinkIdx = ev.index;
            status("think_start");
          }
          if (
            ev.type === "content_block_stop" &&
            conn.st.thinkIdx === ev.index
          ) {
            conn.st.thinkIdx = undefined;
            status("think_end");
          }
          if (
            ev.type === "content_block_delta" &&
            ev.delta?.type === "text_delta"
          ) {
            if (!conn.st.streaming) {
              conn.st.streaming = true;
              status("text_start");
            }
            conn.acc += ev.delta.text;
            emit({ type: "text_delta", text: ev.delta.text });
          }
          break;
        }
        case "assistant":
          // The assistant message carries the concrete model ID actually used
          // (e.g. claude-opus-4-6). This is the first point at which we learn
          // what the alias ("opus") resolved to.
          if (msg.message?.model) conn.usedModel = msg.message.model;
          for (const b of msg.message?.content ?? []) {
            if (b.type === "tool_use") {
              conn.st.tools.set(b.id, b.name);
              emit({ type: "tool_start", name: b.name, toolId: b.id });
            }
          }
          break;
        case "user":
          for (const b of msg.message?.content ?? []) {
            if (b.type === "tool_result") {
              const name = conn.st.tools.get(b.tool_use_id) ?? "tool";
              conn.st.tools.delete(b.tool_use_id);
              emit({
                type: "tool_end",
                name,
                toolId: b.tool_use_id,
                summary: name,
              });
            }
          }
          break;
        case "result": {
          // Captured before the reset below: whether this turn's body was streamed
          // to the WebUI as text_delta. A background sub-turn is NOT always streamed
          // (see the origin branch), so this decides whether we still need to render it.
          const wasStreaming = conn.st.streaming;
          if (conn.st.streaming) {
            conn.st.streaming = false;
            status("text_end");
          }
          const success = msg.subtype === "success";
          const answer = success ? (msg.result ?? conn.acc) : "";
          const kept = answer || conn.acc;
          if (kept) session.history.push({ role: "assistant", content: kept });
          conn.acc = "";
          if (!success)
            emit({ type: "error", message: `claude: ${msg.subtype}` });
          // If there is an origin, this is triggered by a task-notification (=a
          // background sub-turn). The app is already idle, so we don't emit a
          // turn-ending result. When the SDK streamed the body (text_delta) it is
          // already on screen, so we only add a quiet "update" marker. But the SDK
          // does NOT always stream a background sub-turn — often it delivers only the
          // final result — and in that case the body was never shown, so a plain
          // notification (truncated to 120 chars) silently swallows the whole
          // follow-up. So when nothing was streamed, render the full answer as an
          // assistant block via the normal text_start/delta/end path so the
          // continuation is not lost. Overall completion is still announced on the
          // background_tasks_changed→[] side; other agents may still be running, so
          // this is an "update", not "complete".
          if (msg.origin) {
            if (!wasStreaming && answer) {
              status("text_start");
              emit({ type: "text_delta", text: answer });
              status("text_end");
            }
            notify(
              t("notify.bg.updateTitle"),
              // If we just rendered the body as a block, keep the notification a
              // generic marker (don't duplicate the text); otherwise summarize it.
              wasStreaming && answer
                ? answer.replace(/\s+/g, " ").slice(0, 120)
                : t("notify.bg.updateMessage"),
            );
            setAmbient(); // if still running, bring the bottom line back to background
          } else {
            emit({
              type: "result",
              success,
              text: answer,
              sessionId: session.id,
              provider: "claude",
              // The concrete model ID actually used for this turn (an extended
              // field). Tells you what the alias resolved to. If unavailable,
              // fall back to the alias from the request.
              model: conn.usedModel || conn.currentModel || null,
              costUsd: msg.total_cost_usd ?? 0,
              turns: msg.num_turns ?? 1,
              durationMs: msg.duration_ms ?? 0,
              inputTokens: 0,
              outputTokens: 0,
            });
            conn.pendingFg.shift()?.(answer); // return the corresponding runTurn
            // After a foreground turn, instead of emitting idle the bus queries
            // backgroundStatus(), so if a background remains, we can keep
            // background rather than reverting to "Waiting input" (see
            // backgroundStatus below). Keep the adapter-side ambientState in sync
            // with that too.
            if (conn.bgCount > 0) conn.ambientState = "background";
          }
          break;
        }
      }
    }
  } catch (err) {
    if (err?.name !== "AbortError")
      conn.emit({ type: "error", message: `claude: ${err.message}` });
  } finally {
    if (conn.st.streaming)
      conn.emit({ type: "status", state: "text_end", sessionId: session.id });
    conn.closed = true;
    if (conns.get(session.id) === conn) conns.delete(session.id);
    try {
      conn.input.close();
    } catch {
      /* swallow */
    }
    try {
      conn.q.close?.();
    } catch {
      /* swallow */
    }
    // Release any waiting runTurn and bring the bus back to idle (don't leave it frozen with no response).
    while (conn.pendingFg.length) conn.pendingFg.shift()?.(CANCELLED);
  }
}

/** Return the session's persistent connection. If none exists, open a query and
 *  start the reader. resume/cwd resolution happens only once, when the connection
 *  is opened (subsequent turns use the same query). model is used as the initial
 *  model on cold-open (including reconnection after idle GC / interrupt). Model
 *  changes on an existing connection are done by the runTurn side via
 *  Query.setModel(). */
async function getConn(session, model) {
  const existing = conns.get(session.id);
  if (existing && !existing.closed) {
    // Normally reuse the live persistent query. But if a completed background
    // (Task sub-agent) cycle left it in a state where the SDK no longer emits a
    // foreground result for the next streaming-input message (see staleAfterBg),
    // recycle it: close it and fall through to reopen with resume, which keeps
    // the conversation context. Only safe when nothing is in flight (no pending
    // foreground turn and no active background).
    if (
      existing.staleAfterBg &&
      existing.bgCount === 0 &&
      existing.pendingFg.length === 0
    ) {
      existing.closed = true;
      if (conns.get(session.id) === existing) conns.delete(session.id);
      try {
        existing.input.close();
      } catch {
        /* swallow */
      }
      try {
        existing.q?.close?.();
      } catch {
        /* swallow */
      }
      // fall through to open a fresh query below (resume restores context)
    } else {
      return existing;
    }
  }
  const initialModel = model || MODEL || undefined;

  const known = await findOnDisk(session.id);
  const idOpt = known
    ? { resume: session.id }
    : UUID_RE.test(session.id)
      ? { sessionId: session.id }
      : {};
  let cwd = known?.cwd || session.cwd || process.cwd();
  if (!existsSync(cwd)) {
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      cwd =
        session.cwd && existsSync(session.cwd) ? session.cwd : process.cwd();
    }
  }

  const input = makeInput();
  const conn = {
    session,
    input,
    q: null,
    emit: () => {}, // runTurn injects the latest turn's trackedEmit
    ask: null, // same as above (the permission/question round-trip)
    pendingFg: [], // resolvers for foreground turns (usually ≤1 since the bus is serial)
    st: { streaming: false, thinkIdx: undefined, tools: new Map() },
    acc: "", // the current turn's response text (for saving to history)
    bgCount: 0, // number of active background tasks
    staleAfterBg: false, // set once a background cycle completes; triggers a query recycle on the next turn
    lastActivity: Date.now(),
    closed: false,
    currentModel: initialModel ?? null, // the model currently in effect for this query (for setModel diff detection)
    usedModel: null, // the concrete model ID actually used by the most recent assistant message
  };
  conn.q = query({
    prompt: input.gen,
    options: {
      cwd,
      ...idOpt,
      ...(initialModel ? { model: initialModel } : {}),
      permissionMode: PERMISSION_MODE,
      canUseTool: (name, inp, opts) =>
        makeCanUseTool(conn.ask)(name, inp, opts),
      includePartialMessages: true, // needed to produce text_delta
      settingSources: ["user", "project"], // make it read CLAUDE.md
      settings: { autoCompactEnabled: AUTO_COMPACT }, // off by default (overridden by CLAUDE_AUTO_COMPACT)
      ...(DEBUG
        ? {
            stderr: (d) =>
              process.stderr.write(`[claude ${session.id.slice(0, 8)}] ${d}`),
          }
        : {}),
    },
  });
  conns.set(session.id, conn);
  runReader(conn); // the single reader loop (not awaited; from here on it handles all messages of this query)
  return conn;
}

/** Tear down unresponsive persistent queries to free their child processes. */
if (SESSION_IDLE_MS > 0) {
  setInterval(() => {
    const now = Date.now();
    for (const conn of conns.values()) {
      if (conn.pendingFg.length) continue; // don't touch ones awaiting a foreground response
      if (now - conn.lastActivity < SESSION_IDLE_MS) continue;
      conn.closed = true;
      conns.delete(conn.session.id);
      try {
        conn.input.close();
      } catch {
        /* swallow */
      }
      try {
        conn.q?.close?.();
      } catch {
        /* swallow */
      }
    }
  }, 60000).unref?.();
}

export default {
  name: "claude",

  describe() {
    return {
      label: "Claude Code",
      model: MODEL || "(Claude Code default)",
      endpoint: "Agent SDK (local child process)",
      // For the WebUI's model-selection dropdown. Don't hardcode version
      // numbers; list only aliases that always auto-track "the latest in that
      // line" (no rework needed on model updates). The values are Claude Code
      // aliases that can be passed as-is to --model / Query.setModel.
      models: MODEL_CHOICES,
    };
  },

  /** The "ambient state" the bus queries when the foreground turn becomes empty.
   *  If a background is running, return background instead of idle to prevent
   *  reverting to "Waiting input". */
  backgroundStatus(session) {
    const conn = conns.get(session.id);
    return conn && !conn.closed && conn.bgCount > 0
      ? {
          type: "status",
          state: "background",
          count: conn.bgCount,
          sessionId: session.id,
        }
      : null;
  },

  /** For the WebUI's status line. Uses the structured /context and /usage. */
  async getUsage(session) {
    const conn = await getConn(session);
    const [context, usage] = await Promise.all([
      conn.q.getContextUsage(),
      conn.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
    ]);
    return normalizeClaudeUsage(context, usage);
  },

  /** List the real sessions Claude Code holds in JSONL */
  async listSessions(limit = 30, cwd) {
    if (!listSessionsSdk) return [];
    try {
      const list = await listSessionsSdk({
        ...(cwd ? { dir: cwd } : {}),
        limit,
      });
      return list.map((s) => ({
        id: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt || "session",
        timestamp: new Date(s.lastModified ?? Date.now()).toISOString(),
        cwd: s.cwd ?? cwd ?? "",
        provider: "claude",
        status: "idle",
      }));
    } catch {
      return [];
    }
  },

  /** For display when opening a past session. Pick up only the body text from
   *  JSONL and return the last `limit` entries.
   *
   *  Note: getSessionMessages' limit is "the maximum count counted from the
   *  beginning". Passing limit=10 as-is returns the first 10 of the conversation
   *  and does not show the latest utterances. On top of that, tool_use /
   *  tool_result make up the majority, so keeping only the body leaves just a few
   *  lines. Therefore we page all the way to the end with offset and then slice
   *  off the tail. */
  async getHistory(session, limit = 10) {
    if (!getSessionMessages) return [];
    const PAGE = 500,
      MAX_PAGES = 40,
      KEEP = 2000;
    const out = [];
    // AskUserQuestion is stored in JSONL split across an assistant tool_use (the
    // question) and a user tool_result (the answer). Match them by tool_use_id
    // and collapse them into a single question item to return.
    const asks = new Map();
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await getSessionMessages(session.id, {
          limit: PAGE,
          offset: i * PAGE,
        });
        for (const m of page) {
          if (m.type !== "user" && m.type !== "assistant") continue;
          const text = textOf(m.message);
          if (text) out.push({ role: m.type, text });
          const content = m.message?.content;
          if (!Array.isArray(content)) continue;
          for (const b of content) {
            // Question: the assistant's AskUserQuestion tool_use. Pick up each option.
            if (
              m.type === "assistant" &&
              b?.type === "tool_use" &&
              b.name === "AskUserQuestion"
            ) {
              const questions = (b.input?.questions ?? []).map((q) => ({
                question: q.question ?? "",
                header: q.header ?? "",
                options: (q.options ?? []).map((o) => ({
                  label: o.label ?? "",
                  description: o.description ?? "",
                })),
              }));
              const item = {
                role: "assistant",
                kind: "question",
                questions,
                answers: {},
              };
              asks.set(b.id, item);
              out.push(item);
            }
            // Answer: the user's tool_result. Insert it into the corresponding question item.
            if (
              m.type === "user" &&
              b?.type === "tool_result" &&
              asks.has(b.tool_use_id)
            ) {
              const item = asks.get(b.tool_use_id);
              const c =
                typeof b.content === "string"
                  ? b.content
                  : Array.isArray(b.content)
                    ? b.content.map((x) => x?.text ?? "").join("")
                    : "";
              item.answers = parseQuestionAnswers(c, item.questions);
            }
          }
        }
        if (page.length < PAGE) break;
        if (out.length > KEEP) out.splice(0, out.length - KEEP); // only the tail is used, so drop the front
      }
    } catch {
      return [];
    }
    return out.slice(-limit);
  },

  async runTurn({ session, text, images, model, emit, ask }) {
    // Prepare the session's persistent query (if none, resolve resume/cwd and
    // open it), and push this turn's user message into the input channel. The
    // reader streams the response to the SSE, and once this turn's foreground
    // result is received, the done below resolves and runTurn returns. At the
    // moment it returns, the bus goes back to idle — even if a background agent
    // is running, the query stays open and alive, and its completion arrives as
    // subsequent SSE.
    //
    // model is "this request's specification or the remembered model the server
    // resolved". If absent, fall back to env CLAUDE_MODEL, and if that too is
    // absent, to the Claude Code default.
    const effectiveModel = model || MODEL || undefined;
    const conn = await getConn(session, effectiveModel); // cold-open applies the initial model here
    conn.emit = emit; // use the latest turn's trackedEmit (tied to the bus's silence watcher)
    conn.ask = ask; // route the permission/question round-trip to the latest turn's too
    // Swap the existing query's model only when the specification changed.
    // setModel is an API specific to streaming-input that switches the model for
    // subsequent responses without re-opening the query.
    if (effectiveModel && effectiveModel !== conn.currentModel) {
      try {
        await conn.q.setModel(effectiveModel);
        conn.currentModel = effectiveModel;
        emit({
          type: "notification",
          title: t("notify.model.switched"),
          message: `→ ${effectiveModel}`,
        });
      } catch (err) {
        // Even if it fails (e.g. an unknown model name), the conversation can continue with the previous model.
        emit({
          type: "notification",
          title: t("notify.model.switchFailed"),
          message: `${effectiveModel}: ${err.message}`,
        });
      }
    }
    const done = new Promise((resolve) => conn.pendingFg.push(resolve));
    conn.input.push(buildUserMessage(text, images));
    await done; // resolved by a foreground result (also resolved via CANCELLED on disconnect/interrupt)
  },

  /** Interrupt. Called from bus.interrupt. Tears down the persistent query and
   *  stops the whole child process (stopping both foreground and background). The
   *  next turn opens a new query and resumes from JSONL, so the context stays
   *  connected. The reader's finally releases the waiting runTurn. */
  async interrupt(session) {
    const conn = conns.get(session.id);
    if (!conn) return;
    // If a background was running, notify so it's clear this is a "stop", not a "completion".
    if (conn.bgCount > 0) {
      try {
        conn.emit({
          type: "notification",
          title: t("notify.bg.stopTitle"),
          message: t("notify.bg.stopMessage", { count: conn.bgCount }),
        });
      } catch {
        /* swallow */
      }
    }
    conn.closed = true;
    conns.delete(session.id);
    try {
      await conn.q?.interrupt?.();
    } catch {
      /* ignore if already finished */
    }
    try {
      conn.q?.close?.();
    } catch {
      /* swallow */
    }
    try {
      conn.input.close();
    } catch {
      /* swallow */
    }
    while (conn.pendingFg.length) conn.pendingFg.shift()?.(CANCELLED);
  },
};
