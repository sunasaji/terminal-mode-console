// bus.mjs — session state + SSE delivery + permission/question round-trips
//
// The stateful part of the protocol "shell". Used by server.mjs, it passes
// only emit and ask to the adapters (agents/*). This layer is backend-agnostic.

import { randomUUID } from "node:crypto";
import { makeT } from "./i18n.mjs";

// Notification strings are localized via the shared i18n loader (server locale).
const { t } = makeT();

// How long without a response before we treat it as "silence" and notify. We do not
// force-terminate the turn (so we don't kill a long but legitimate investigation). 0 disables the notification itself.
const STALL_WARN_MS = Math.max(
  0,
  parseInt(process.env.STALL_WARN_MS ?? "120000", 10) || 0,
);
const MAX_MESSAGES = 500; // SSE ring buffer length (value matched to the official implementation)

/**
 * session = {
 *   id, title, cwd, provider,
 *   state: "idle" | "busy",
 *   history: [{role, content}],   // conversation history passed to the LLM (used by the adapter)
 *   messages: [{id, msg}],        // SSE ring buffer
 *   clients: Set<res>,            // live SSE connections (multiple allowed)
 *   nextId,
 *   pending: { permissions: [fn], questions: [fn] }, // resolvers awaiting a response
 *   waiting: null | {kind, label, event},  // content awaiting a response (for re-sending)
 *   queue: [{text, images, agent, model}], // turns waiting to run (FIFO). images/model are optional
 *   running: bool,                // drain loop is active
 *   startedAt, lastActivityAt: epoch milliseconds | null, // only the current foreground turn
 *   activityKind: string | null,  // last meaningful agent event observed
 * }
 */
const sessions = new Map();

export function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      title: "",
      cwd: "",
      provider: "",
      state: "idle",
      history: [],
      messages: [],
      clients: new Set(),
      nextId: 1,
      // Identifies this in-memory session instance. It is regenerated whenever the
      // session object is (re)created — notably a server restart, where nextId also
      // resets to 1. The WebUI passes back the epoch it last saw; a mismatch tells the
      // server the client's lastEventId belongs to a dead instance, so incremental
      // catch-up would silently drop every new (lower-id) event. See server.mjs /api/events.
      epoch: randomUUID(),
      pending: { permissions: [], questions: [] },
      waiting: null,
      queue: [],
      running: false,
      startedAt: null,
      lastActivityAt: null,
      activityKind: null,
    };
    sessions.set(id, s);
  }
  return s;
}

/** Returns only when it exists. Read-only paths should use this.
 *  getSession() has the side effect of creating empty sessions, which lets ghosts
 *  slip into listings and can overwrite the persisted title or cwd. */
export function peekSession(id) {
  return sessions.get(id);
}

// Returns only the listing scoped by provider (the actual backend name).
// We deliberately provide no unscoped "return everything" entry point — this prevents
// accidents where a caller's missing filter mixes in another provider's sessions (e.g. claude showing up in the codex listing).
export function listSessions(provider) {
  return [...sessions.values()].filter((s) => s.provider === provider);
}

// Do not add notification or connection events here. In particular, if the silence warning itself
// counts as activity, the thing being observed gets reset by the act of observing it. Since background
// can arrive after the foreground ends, we also exclude it from the status activity kinds.
const ACTIVITY_TYPES = new Set([
  "text_delta",
  "tool_start",
  "tool_end",
  "result",
]);
const ACTIVITY_STATES = new Set([
  "think_start",
  "think_end",
  "text_start",
  "text_end",
]);
export function activityKindOf(event) {
  if (event?.type === "status" && ACTIVITY_STATES.has(event.state))
    return event.state;
  return ACTIVITY_TYPES.has(event?.type) ? event.type : null;
}

export function livenessSnapshot(s) {
  const foreground = s?.state === "busy" && Number.isFinite(s.startedAt);
  return {
    startedAt: foreground ? s.startedAt : null,
    lastActivityAt:
      foreground && Number.isFinite(s.lastActivityAt) ? s.lastActivityAt : null,
    activityKind: foreground ? (s.activityKind ?? null) : null,
    stallWarnMs: STALL_WARN_MS,
  };
}

function recordActivity(s, event, now = Date.now()) {
  const kind = activityKindOf(event);
  // Claude's background reader keeps the same emit even after the foreground runTurn.
  // Events after startedAt has cleared must not be mixed into the foreground liveness.
  if (!kind || s.state !== "busy" || !Number.isFinite(s.startedAt))
    return false;
  s.lastActivityAt = now;
  s.activityKind = kind;
  return true;
}

// SSE: push onto the ring buffer, then deliver to all clients
export function emit(sessionId, msg) {
  const s = getSession(sessionId);
  const id = s.nextId++;
  s.messages.push({ id, msg });
  if (s.messages.length > MAX_MESSAGES) s.messages.shift();
  const frame = `id: ${id}\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const res of s.clients) {
    try {
      res.write(frame);
    } catch {
      s.clients.delete(res);
    }
  }
}

// Count SSE clients by kind (dart = glasses / web = WebUI / cli / other).
// This lets us detect cases like "the glasses are polling the listing but there are zero Dart SSE connections".
export function addClient(sessionId, res, kind = "other") {
  const s = getSession(sessionId);
  res._evenKind = kind;
  s.clients.add(res);
  // For a client that reconnected while a response was still pending (reload or app restart),
  // re-send the outstanding request. Waits are indefinite, so if we don't re-send here it stalls with no one able to answer.
  // Regardless of any replay, this is sent every time not as event history but as a snapshot of the
  // state "an answer is still needed right now". Even if a client advanced only the event id and then
  // discarded the screen, it can restore the card after reconnecting. Because a re-send with the same
  // requestId is handled idempotently on the WebUI side, an already-displayed card or a half-typed answer is not lost.
  if (s.waiting) {
    const w = s.waiting;
    try {
      res.write(`data: ${JSON.stringify(waitingStatus(sessionId, w))}\n\n`);
      res.write(`data: ${JSON.stringify(w.event)}\n\n`);
    } catch {
      s.clients.delete(res);
    }
  }
}
export function removeClient(sessionId, res) {
  sessions.get(sessionId)?.clients.delete(res);
}

/** Count live SSE connections by kind */
export function clientStats() {
  const stat = { dart: 0, web: 0, cli: 0, other: 0, total: 0 };
  for (const s of sessions.values())
    for (const res of s.clients) {
      stat[res._evenKind] = (stat[res._evenKind] ?? 0) + 1;
      stat.total++;
    }
  return stat;
}

// ── Turn serialization ─────────────────────────────────────
// There are multiple clients (glasses, WebUI, CLI). Even if prompts arrive simultaneously,
// running turns in parallel would tangle the history, so we run them FIFO per session.
// The original app assumes a single client, so this is the compatibility server's responsibility.

/** Push onto the run queue. The return value is the wait position (0 = starts immediately). */
export function enqueue(sessionId, job) {
  const s = getSession(sessionId);
  s.queue.push(job);
  const position = s.queue.length - 1 + (s.running ? 1 : 0);
  // We want to return 202 first, so defer starting drain to the next microtask
  if (!s.running) queueMicrotask(() => drain(sessionId));
  return position;
}

async function drain(sessionId) {
  const s = getSession(sessionId);
  if (s.running) return;
  s.running = true;
  while (s.queue.length) {
    const { text, images, agent, model, stallWarnMs } = s.queue.shift();

    // On the session's first turn, announce the actually-connected backend exactly once.
    // provider can fall back, so even if the app selected "Claude Code", the real
    // backend may be a local LLM. We don't silently hide that.
    if (!s.announced && process.env.ANNOUNCE_BACKEND !== "0") {
      s.announced = true;
      const d = agent.describe?.();
      if (d) {
        const where =
          d.endpoint && d.endpoint !== "-" ? ` @ ${d.endpoint}` : "";
        emit(sessionId, {
          type: "notification",
          title: "backend:",
          message: `${d.label} / ${d.model}${where}`,
        });
      }
    }

    // Extend history at "run time", not "enqueue time".
    // Otherwise a queued utterance would line up ahead of an earlier response.
    s.history.push({ role: "user", content: text });
    s.state = "busy";
    const turnStartedAt = Date.now();
    s.startedAt = turnStartedAt;
    s.lastActivityAt = turnStartedAt;
    s.activityKind = "turn_start";
    s.agent = agent; // so that interrupt reaches the adapter
    s.abort = new AbortController();
    emit(sessionId, { type: "user_prompt", text });
    emit(sessionId, { type: "status", state: "busy", sessionId });

    // Silence watcher. Stays quiet as long as events are flowing. If nothing flows for
    // STALL_WARN_MS, it tells the user in dim text that it's "still working / can be interrupted" (without killing the turn).
    let warnedForActivityAt = null;
    const trackedEmit = (e) => {
      recordActivity(s, e);
      emit(sessionId, e);
    };
    // Tests can inject a short threshold via job.stallWarnMs. It's an internal-only field that
    // doesn't exist for normal enqueue calls and has no effect on the public protocol.
    const warnMs = Number.isFinite(stallWarnMs)
      ? Math.max(0, stallWarnMs)
      : STALL_WARN_MS;
    const span =
      warnMs >= 60000
        ? t("notify.stall.minutes", { count: Math.round(warnMs / 60000) })
        : t("notify.stall.awhile");
    // Within the same inactivity span, notify only on the first threshold hit. It re-arms on the next meaningful activity.
    const watcher =
      warnMs > 0
        ? setInterval(
            () => {
              // Waiting for a response is not "silence". While we're waiting on the user, stay quiet.
              if (s.waiting || s.state !== "busy") return;
              if (Date.now() - s.lastActivityAt < warnMs) return;
              if (warnedForActivityAt === s.lastActivityAt) return;
              warnedForActivityAt = s.lastActivityAt;
              emit(sessionId, {
                type: "notification",
                // Stable machine key so consumers can detect the stall
                // notification without matching localized title text.
                key: "stall",
                title: t("notify.stall.title"),
                message: t("notify.stall.message", { span }),
              });
            },
            Math.max(1, Math.min(warnMs, 1000)),
          )
        : null;

    try {
      await agent.runTurn({
        session: s,
        text,
        images,
        model,
        emit: trackedEmit,
        ask: makeAsk(sessionId),
      });
    } catch (err) {
      emit(sessionId, { type: "error", message: err.message });
      try {
        await s.agent?.interrupt?.(s);
      } catch {
        /* cleanup, so swallow it */
      }
    } finally {
      if (watcher) clearInterval(watcher);
    }
  }
  s.running = false;
  s.state = "idle";
  s.startedAt = null;
  s.lastActivityAt = null;
  s.activityKind = null;
  // Emit idle only once, after the queue is drained. This keeps busy/idle from flickering across consecutive turns.
  // However, for an adapter with a background agent running (claude), returning to "Waiting input" (idle)
  // once the foreground turn ends makes it indistinguishable from actually running. Ask the adapter for its current
  // base state, and if there is one, emit that (e.g. status:background) instead of idle.
  const bg = s.agent?.backgroundStatus?.(s);
  emit(sessionId, bg || { type: "status", state: "idle", sessionId });
}

// ── Permission/question round-trips ─────────────────────────────────────
// The adapter simply does await ask.permission(payload). This layer throws it onto SSE and
// waits until a POST /api/permission-response arrives.
//
// We set no timeout. The official server auto-sends deny / "skip" at 60s/120s, but that
// finalizes an answer on its own while the user is still thinking and lets the conversation move on
// (in practice, a 3-choice AskUserQuestion got treated as "skip" at exactly 120 seconds).
// Only "the user's response" or "an explicit interrupt" ends the wait.

/** Sentinel indicating the wait was released by an interrupt. Since this value can't arrive over HTTP, it never mixes with a user's answer. */
const CANCELLED = Symbol("cancelled");

function waitForUser(queue) {
  return new Promise((resolve) => {
    let done = false;
    const entry = (v) => {
      if (done) return;
      done = true;
      const i = queue.indexOf(entry);
      if (i !== -1) queue.splice(i, 1);
      resolve(v);
    };
    queue.push(entry);
  });
}

const waitingStatus = (sessionId, w) => ({
  type: "status",
  state: "waiting",
  sessionId,
  waitingFor: w.kind,
  label: w.label,
});

/** Enter the waiting-for-response state and wait until an answer (or interrupt).
 *  We signal that we're waiting via status:waiting. The genuine glasses app ignores unknown
 *  statuses, so we also emit a notification that renders as a single dim line (docs/protocol.md §7.6). */
async function awaitAnswer(sessionId, queue, waiting) {
  const s = getSession(sessionId);
  s.waiting = waiting; // retained so it can be re-sent to a client that connects later
  emit(sessionId, waitingStatus(sessionId, waiting));
  emit(sessionId, {
    type: "notification",
    // Stable machine key so the WebUI can re-localize this to the browser
    // language (see web/index.html); title/message are the server-locale text
    // that the genuine glasses app renders directly.
    key: "waiting",
    title: t("notify.waiting.title"),
    message: t("notify.waiting.message", { label: waiting.label }),
  });
  try {
    return await waitForUser(queue);
  } finally {
    s.waiting = null;
    // Once the wait is released, return to the turn. If idle (after an interrupt), leave it idle.
    if (s.state === "busy")
      emit(sessionId, { type: "status", state: "busy", sessionId });
  }
}

export function makeAsk(sessionId) {
  const s = getSession(sessionId);
  return {
    // payload example: {toolName, description, detail, options:[{text,key}], suggestions}
    async permission(payload) {
      const event = {
        type: "permission_request",
        ...payload,
        requestId: `wait-${s.nextId}`,
      };
      emit(sessionId, event);
      const raw = await awaitAnswer(sessionId, s.pending.permissions, {
        kind: "permission",
        label: t("notify.label.permission", {
          tool: payload.toolName ?? "",
        }).trim(),
        event,
      });
      const cancelled = raw === CANCELLED;
      const decision = cancelled ? "deny" : raw;
      emit(sessionId, {
        type: "permission_result",
        toolName: payload.toolName ?? "",
        summary: payload.description ?? "",
        decision:
          decision === "allowAlways"
            ? "always"
            : decision === "allow"
              ? "allowed"
              : "denied",
        cancelled, // extension field: set when released by an interrupt (no one answered)
      });
      return decision;
    },
    // payload example: {questions:[{question,header,options:[{label,description,preview}]}]}
    async question(payload) {
      const event = {
        type: "user_question",
        ...payload,
        requestId: `wait-${s.nextId}`,
      };
      emit(sessionId, event);
      const raw = await awaitAnswer(sessionId, s.pending.questions, {
        kind: "question",
        label: t("notify.label.question", {
          header: payload.questions?.[0]?.header ?? "",
        }).trim(),
        event,
      });
      const cancelled = raw === CANCELLED;
      const answer = cancelled ? "skip" : raw;
      // The app sends answer as a double-encoded string. A raw string is also accepted.
      let answers;
      try {
        answers = JSON.parse(answer);
      } catch {
        answers = Object.fromEntries(
          (payload.questions ?? []).map((q) => [q.question, answer]),
        );
      }
      emit(sessionId, { type: "question_answer", answers, cancelled });
      return answers;
    },
  };
}

export function resolvePermission(sessionId, decision) {
  sessions.get(sessionId)?.pending.permissions.shift()?.(decision || "deny");
}
export function resolveQuestion(sessionId, answer) {
  sessions.get(sessionId)?.pending.questions.shift()?.(answer || "skip");
}
export function interrupt(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  // "Stop" halts not only the running turn but everything queued as well.
  const dropped = s.queue.length;
  s.queue.length = 0;
  // Release the response waits too. Waits are indefinite, so if we don't release them here, the turn won't end even after an interrupt.
  const waits = s.pending.permissions.length + s.pending.questions.length;
  while (s.pending.permissions.length) s.pending.permissions.shift()(CANCELLED);
  while (s.pending.questions.length) s.pending.questions.shift()(CANCELLED);
  s.waiting = null;
  s.abort?.abort();
  // Tell the adapter too. claude calls the SDK's Query.interrupt().
  // Without this, pressing "interrupt" leaves it frozen at busy.
  try {
    s.agent?.interrupt?.(s);
  } catch {
    /* swallow it */
  }
  if (dropped)
    emit(sessionId, {
      type: "notification",
      title: t("notify.interrupt.title"),
      message: t("notify.interrupt.dropped", { count: dropped }),
    });
  if (waits)
    emit(sessionId, {
      type: "notification",
      title: t("notify.interrupt.title"),
      message: t("notify.interrupt.cancelled"),
    });
  // If a turn is running, idle is emitted by drain's finally equivalent. If not, emit it here.
  if (!s.running) {
    s.state = "idle";
    s.startedAt = null;
    s.lastActivityAt = null;
    s.activityKind = null;
    emit(sessionId, { type: "status", state: "idle", sessionId });
  }
}
