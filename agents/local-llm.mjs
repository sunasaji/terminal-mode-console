// agents/local-llm.mjs — Local LLM backend (the primary one)
//
// Ollama / llama.cpp server / LM Studio all "speak OpenAI-compatible
// /v1/chat/completions with stream:true". So a single adapter is enough, and
// switching between them is just environment variables (base URL and model name).
//
//   backend        LLM_BASE_URL                       LLM_MODEL (optional)
//   ─────────────  ─────────────────────────────────  ─────────────
//   LM Studio      http://localhost:1234/v1           (model ID shown in LM Studio)
//   Ollama         http://localhost:11434/v1(default) (the name you "ollama pull"ed)
//   llama.cpp      http://localhost:8080/v1           (model loaded when the server started)
//
// e.g.: LLM_BASE_URL=http://localhost:1234/v1 node server.mjs
//
// LLM_MODEL is optional: with no model specified the backend is asked what it has and
// a loaded one is used (see autoChoice). Set it only to pin a particular model — a
// wrong value is worse than none, since the backend rejects an ID it does not have.
//
// Zero dependencies (uses Node 20+ global fetch).
//
// [Tool use] When LLM_TOOLS!=0 (enabled by default), bash/grep/read_file/list_dir
// are handed to the model via OpenAI-compatible function-calling. When the model
// calls a tool we execute it, append the result to the conversation, and ask the
// model again — an agentic loop. The execution part and safety measures live in
// tools.mjs. Read-only tools are auto-allowed; bash by default asks the user for
// permission every time (via the bus's ask). To turn tools off entirely, LLM_TOOLS=0.
//
// Conversations are persisted to store.mjs (JSONL). They remain in the list across
// restarts, and reopening one continues it with its full context. Tool calls
// (assistant.tool_calls) and their results (the tool role) are persisted too, so
// after resuming they can be handed back to the API as a correct conversation
// sequence. Disable with LLM_PERSIST=0.
//
// [Debug] LLM_DEBUG_DUMP logs the raw exchange with the backend as JSONL — the full
// request body (system prompt, history, base64 image_url URLs, tool specs) and the reply
// (reasoning, text, tool calls). It is a side-effect log only and never changes what the
// model receives. See DEBUG_DUMP below for the accepted values (flag / dir / file).

import * as store from "./store.mjs";
import * as tools from "./tools.mjs";
import { makeT } from "../i18n.mjs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// User-facing and model-facing strings are localized via the shared i18n loader
// (server locale). English is the base; other locales fall back to it.
const { t } = makeT();

const PERSIST = process.env.LLM_PERSIST !== "0";
const BASE = process.env.LLM_BASE_URL || "http://localhost:11434/v1";
// Keep the explicit setting and the last-resort fallback apart. The OpenAI-compatible
// API requires model — there is no "let the server decide" — so something must be
// chosen when nothing is specified. An explicit LLM_MODEL is honoured; otherwise one is
// picked from the backend's own list (autoChoice). MODEL is the long-standing default
// for when there is neither, and it is not guaranteed to exist on the backend.
const MODEL_ENV = process.env.LLM_MODEL || "";
const MODEL = MODEL_ENV || "agents-a1-4b";
const API_KEY = process.env.LLM_API_KEY || "not-needed"; // usually not needed locally
const TOOLS_ON = process.env.LLM_TOOLS !== "0";
// Context window, in tokens. 0 = unset, in which case it is read from the backend.
// Set it by hand for backends where that lookup is unavailable (or where the reported
// value disagrees with the effective num_ctx, as on Ollama).
const CTX_OVERRIDE =
  Number(process.env.LLM_CONTEXT || process.env.LLM_NUM_CTX) || 0;
const MAX_ROUNDS = Number(process.env.LLM_TOOLS_MAX_ROUNDS) || 8; // runaway guard for tool round-trips
const SYSTEM_PROMPT = process.env.LLM_SYSTEM_PROMPT || t("local.systemPrompt");
// Hint added to system when tools are enabled. Small models won't call tools unless explicitly told they "may use" them.
const TOOLS_HINT = t("local.toolsHint");

// Reasoning models (agents-a1-4b, qwen3, etc.) return their thinking in
// delta.reasoning_content and the final answer separately in delta.content. By
// default we don't show the thinking on the glasses and only emit the final
// answer as text_delta. With SHOW_REASONING=1 the thinking is also streamed, treated as dimmed text.
const SHOW_REASONING = process.env.LLM_SHOW_REASONING === "1";

// Debug: LLM_DEBUG_DUMP records every request/response exchange with the backend as
// JSONL — the full prompt (system prompt, history and the raw base64 image_url data URLs)
// and the reply (reasoning, text, tool calls). This is purely a side-effect log: it never
// mutates the messages sent to the model, so the model's context is identical whether it is
// on or off. Note the file(s) can grow large and contain full image data; for local
// debugging, not production. Accepted values:
//   unset / "0"              → disabled (zero overhead)
//   "1" / "true"             → <store dir>/debug/<sessionId>.jsonl (per session)
//   a path ending in .jsonl  → one combined file for all sessions
//   any other path (a dir)   → <that dir>/<sessionId>.jsonl (per session)
const DEBUG_DUMP = process.env.LLM_DEBUG_DUMP || "";
const DEBUG_ON = DEBUG_DUMP !== "" && DEBUG_DUMP !== "0";
// Keep a debug filename filesystem-safe. UUID-like ids pass through unchanged, and it also
// matches the session's own JSONL name in the store dir so the two are easy to correlate.
const safeId = (id) => String(id || "session").replace(/[^\w.-]/g, "_");
function debugPathFor(sessionId) {
  if (!DEBUG_ON) return "";
  if (DEBUG_DUMP === "1" || DEBUG_DUMP === "true")
    return join(store.STORE_DIR, "debug", `${safeId(sessionId)}.jsonl`);
  if (DEBUG_DUMP.toLowerCase().endsWith(".jsonl")) return DEBUG_DUMP;
  return join(DEBUG_DUMP, `${safeId(sessionId)}.jsonl`);
}
const ensuredDumpDirs = new Set();
let dumpWarned = false;
async function debugDump(entry) {
  const path = debugPathFor(entry.session);
  if (!path) return;
  try {
    const dir = dirname(path);
    if (!ensuredDumpDirs.has(dir)) {
      await mkdir(dir, { recursive: true }).catch(() => {});
      ensuredDumpDirs.add(dir);
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    await appendFile(path, line + "\n");
  } catch (err) {
    // Never let debug logging break a turn. Warn only once (a failure is usually a bad
    // path or permissions, i.e. persistent — no point logging it every round).
    if (!dumpWarned) {
      dumpWarned = true;
      console.error(`[LLM_DEBUG_DUMP] write to ${path} failed: ${err.message}`);
    }
  }
}

// Guess a familiar name from the port. Even if wrong, the endpoint is shown alongside so there's no confusion.
// Only a fallback for before detection finishes — detectKind() below identifies the server from its responses.
function guessLabel(base) {
  if (base.includes(":1234")) return "LM Studio";
  if (base.includes(":11434")) return "Ollama";
  if (base.includes(":8080")) return "llama.cpp";
  return t("local.compatLabel");
}

// ── Identifying the backend, and listing its models ──────────────────────
// Every implementation serves an OpenAI-compatible /v1/models, but it carries too
// little to use: it cannot even say whether an entry is for chat or for embeddings
// (LM Studio really does mix text-embedding-* into the same list). So identify the
// implementation first and then use its own native API. Identification reads the
// responses, not the port number — ports are freely configurable and prove nothing.
const ORIGIN = BASE.replace(/\/v1\/?$/, "");
const KIND_LABELS = {
  lmstudio: "LM Studio",
  ollama: "Ollama",
  llamacpp: "llama.cpp",
};
const DISCOVERY_TTL_MS = 60_000;

let serverKind = null; // "lmstudio" | "ollama" | "llamacpp" | "openai"
let modelChoices = []; // what describe() returns: [{value,label,noteKey?}]
let discoveredAt = 0;
let discovering = null;
// Whether any HTTP response came back. null = not determined yet (just started).
// Clients report "cannot connect" only on false — reporting it before the first
// attempt finishes would flash an error at startup.
let reachable = null;

async function getJson(url) {
  // fetch itself throws when the network cannot be reached. That has to be told apart
  // from a 4xx/5xx that did arrive, so mark the latter with reached — a 401 from
  // LM Studio means "connected, but it wants a token", not "not connected".
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.reached = true;
    throw err;
  }
  return { json: await res.json(), res };
}

/** Identify the implementation from its responses. Try to decide from a single
 *  /v1/models, and if that is inconclusive probe the implementation-specific
 *  endpoints in turn (each answers 200 on exactly one implementation).
 *  The returned reached means "some HTTP response came back". It is separate from
 *  whether identification succeeded, and lets the caller tell "nothing is there"
 *  apart from "something is there, but it is a plain OpenAI-compatible server". */
async function detectKind() {
  let json = null,
    res = null,
    reached;
  try {
    ({ json, res } = await getJson(`${BASE}/models`));
    reached = true;
  } catch (err) {
    reached = Boolean(err.reached);
  }
  // llama-server sets Server: llama.cpp on every response. The cheapest, surest signal.
  if (res?.headers.get("server")?.toLowerCase().includes("llama.cpp"))
    return { kind: "llamacpp", reached };
  // Only llama.cpp carries a top-level models alongside data (its Ollama-compat duplicate).
  if (Array.isArray(json?.models)) return { kind: "llamacpp", reached };
  const first = json?.data?.[0];
  if (first?.owned_by === "llamacpp") return { kind: "llamacpp", reached };
  // Every LM Studio entry is organization_owner. Undocumented, so not a sole discriminator.
  if (first?.owned_by === "organization_owner")
    return { kind: "lmstudio", reached };
  for (const [url, kind] of [
    [`${ORIGIN}/api/version`, "ollama"],
    [`${ORIGIN}/props`, "llamacpp"],
    [`${ORIGIN}/api/v1/models`, "lmstudio"],
  ]) {
    try {
      await getJson(url);
      return { kind, reached: true };
    } catch (err) {
      reached ||= Boolean(err.reached);
    }
  }
  return { kind: "openai", reached };
}

/** The model list per implementation, shaped so describe() can return it as-is:
 *  [{value,label,noteKey?}]. noteKey is an i18n key the WebUI translates, because
 *  the server does not know the display language. */
async function fetchChoices(kind) {
  const LOADED = { noteKey: "model.note.loaded" };
  if (kind === "lmstudio") {
    // The native v1 can exclude embeddings by type, and loaded_instances says what is
    // loaded. Older builds lack it, so fall back to v0.
    try {
      const { json } = await getJson(`${ORIGIN}/api/v1/models`);
      return (json.models ?? [])
        .filter((m) => m.type === "llm")
        .map((m) => ({
          value: m.key,
          label: m.display_name || m.key,
          ...(m.loaded_instances?.length ? LOADED : {}),
        }));
    } catch {
      const { json } = await getJson(`${ORIGIN}/api/v0/models`);
      return (json.data ?? [])
        .filter((m) => m.type === "llm" || m.type === "vlm")
        .map((m) => ({
          value: m.id,
          label: m.id,
          ...(m.state === "loaded" ? LOADED : {}),
        }));
    }
  }
  if (kind === "ollama") {
    const { json } = await getJson(`${ORIGIN}/api/tags`);
    let hot = new Set();
    try {
      const ps = await getJson(`${ORIGIN}/api/ps`);
      hot = new Set((ps.json.models ?? []).map((m) => m.model || m.name));
    } catch {
      /* the list is still usable without load state */
    }
    return (json.models ?? []).map((m) => {
      const id = m.model || m.name;
      return { value: id, label: m.name || id, ...(hot.has(id) ? LOADED : {}) };
    });
  }
  if (kind === "llamacpp") {
    // Switching is only possible in router mode (started without -m). Single-model mode
    // is fixed at startup and cannot be changed, so return empty and show no picker.
    const { json: props } = await getJson(`${ORIGIN}/props`);
    if (props.role !== "router") return [];
    const { json } = await getJson(`${BASE}/models`);
    return (json.data ?? []).map((m) => ({
      value: m.id,
      label: m.id,
      ...(m.status?.value === "loaded" ? LOADED : {}),
    }));
  }
  // A plain OpenAI-compatible server. Types are unknown, so list everything unfiltered.
  const { json } = await getJson(`${BASE}/models`);
  return (json.data ?? []).map((m) => ({ value: m.id, label: m.id }));
}

/** Warm the cache with the list. describe() is synchronous, so it returns whatever is
 *  cached at that moment (empty on the first call, which hides the WebUI picker). */
function refreshModels() {
  if (discovering || Date.now() - discoveredAt < DISCOVERY_TTL_MS) return;
  discovering = (async () => {
    try {
      const { kind, reached } = await detectKind();
      // Publish the identification and the list together. Setting kind first would expose
      // a transient state that claims "LM Studio" while the list is still empty (no picker).
      let listed = false;
      try {
        modelChoices = await fetchChoices(kind);
        listed = true;
      } catch {
        /* even without a list, a response means the connection itself is alive */
      } finally {
        serverKind = kind;
      } // the identification is worth showing either way
      reachable = reached || listed;
    } catch {
      reachable = false; /* keep the previous cache; a turn can still be attempted */
    } finally {
      discoveredAt = Date.now();
      discovering = null;
    }
  })();
}
refreshModels(); // prefetch at startup

/** Make sure the list has been fetched at least once. "Auto" picks from that list, so
 *  choosing before it arrives would land on the off-target default. Later calls are
 *  served from the cache and return immediately. */
async function ensureDiscovered() {
  refreshModels();
  if (discovering) await discovering;
}

/** Decide which model is actually used when none is specified (i.e. "auto").
 *  Order: an explicit LLM_MODEL > a loaded model > the first entry > the old default.
 *  Loaded wins because naming an unloaded model costs a load, and fails outright on
 *  some backends. With an empty list there is nothing to pick, so it falls back. */
function autoChoice() {
  const found = (v) => modelChoices.find((m) => m.value === v);
  if (MODEL_ENV)
    return found(MODEL_ENV) || { value: MODEL_ENV, label: MODEL_ENV };
  const pick =
    modelChoices.find((m) => m.noteKey === "model.note.loaded") ||
    modelChoices[0];
  return pick || { value: MODEL, label: MODEL };
}

// ── Context window (n_ctx) and token usage ───────────────────────────────
// What the WebUI status line needs to show "Ctx %" (= used / window) and the actual
// token counts (used / max). Used tokens come from the response's usage
// (stream_options.include_usage); the window size comes from each implementation's
// native API. Token count tends to be the binding constraint on a local LLM, so the
// 5h/1w rate slots — which a local backend does not have — are repurposed to show
// used/max tokens instead.
const usageBySession = new Map(); // session.id → { promptTokens, completionTokens, totalTokens, at }
let ctxWindowCache = { model: null, value: null, at: 0 };
const CTX_TTL_MS = 60_000;

/** Read the loaded model's context window (in tokens), per implementation.
 *  null when it cannot be read; the caller then shows "—" for Ctx% and Max. */
async function probeContextWindow(kind, model) {
  try {
    if (kind === "lmstudio") {
      // v0's models carry loaded_context_length / max_context_length (v1 does not).
      const { json } = await getJson(`${ORIGIN}/api/v0/models`);
      const list = json.data ?? [];
      const m =
        list.find(
          (x) =>
            x.id === model && (x.loaded_context_length || x.max_context_length),
        ) ??
        list.find((x) => x.state === "loaded") ??
        list.find((x) => x.id === model);
      return m?.loaded_context_length || m?.max_context_length || null;
    }
    if (kind === "llamacpp") {
      const { json } = await getJson(`${ORIGIN}/props`);
      return json.n_ctx || json.default_generation_settings?.n_ctx || null;
    }
    if (kind === "ollama") {
      // /api/show is a POST. model_info's "<arch>.context_length" is the model's maximum.
      // The effective num_ctx may still default to 2048/4096, so override with
      // LLM_CONTEXT when it has to match exactly.
      const res = await fetch(`${ORIGIN}/api/show`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ model }),
      });
      if (!res.ok) return null;
      const json = await res.json();
      const info = json.model_info || {};
      const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
      return (key && Number(info[key])) || null;
    }
  } catch {
    /* the used-token count is still reportable without the window */
  }
  return null;
}

/** Return the context window. An explicit LLM_CONTEXT wins; otherwise read it from the
 *  implementation and cache it briefly — the WebUI polls usage repeatedly. */
async function contextWindowFor(kind, model) {
  if (CTX_OVERRIDE) return CTX_OVERRIDE;
  if (
    ctxWindowCache.model === model &&
    Date.now() - ctxWindowCache.at < CTX_TTL_MS
  )
    return ctxWindowCache.value;
  const value = await probeContextWindow(kind, model);
  ctxWindowCache = { model, value, at: Date.now() };
  return value;
}

/** Normalize an image to a data URL. If it starts with data:, use it as-is; if it's raw base64, treat it as jpeg. */
function toDataUrl(img) {
  if (typeof img !== "string" || !img) return null;
  return img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`;
}

/** Build the content of a user message. With no images it's a plain string as
 *  before; with images it becomes an OpenAI Vision content array ([text, image_url...]).
 *  Vision input can only ride on a user message, so this is the sole entry point. */
function buildUserContent(text, images) {
  const urls = (Array.isArray(images) ? images : [])
    .map(toDataUrl)
    .filter(Boolean);
  if (!urls.length) return text;
  // Small local models tend to reach for view_image/list_dir even when the image is
  // already inline. A short note right next to the image_url (without pasting the huge
  // base64 URL itself) tells the model it can look at it directly. See local.imageAttached.
  const note = t("local.imageAttached", { count: urls.length });
  return [
    { type: "text", text: text ? `${text}\n\n${note}` : note },
    ...urls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

/** Shape the persisted past history into a conversation sequence acceptable to the
 *  OpenAI-compatible API. Inconsistencies in the tool sequence (e.g. an interruption
 *  left an assistant.tool_calls without its tool response) make the API error out,
 *  so we sanitize by dropping any tool_calls whose responses aren't all present. */
function sanitizeForApi(msgs) {
  const answered = new Set();
  for (const m of msgs)
    if (m.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id);
  const out = [];
  for (const m of msgs) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const kept = m.tool_calls.filter((tc) => answered.has(tc.id));
      if (kept.length)
        out.push({
          role: "assistant",
          content: m.content || "",
          tool_calls: kept,
        });
      else if (m.content) out.push({ role: "assistant", content: m.content }); // no responses → demote to a plain utterance
      // if neither content nor tool_calls remain, drop it entirely
    } else if (m.role === "tool") {
      if (answered.has(m.tool_call_id))
        out.push({
          role: "tool",
          tool_call_id: m.tool_call_id,
          name: m.name,
          content: m.content,
        });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** Consume one round of the OpenAI-compatible SSE stream.
 *  Returns: { text, toolCalls:[{id,name,args}], finishReason, error?, aborted? }
 *  The status event order matches upstream: think_start → think_end → text_start → text_delta* → text_end */
async function streamOnce({ messages, emit, session, model }) {
  // model is this turn's choice (the WebUI dropdown / the API's model). Falls back to env.
  // include_usage puts usage on the final chunk (choices: []). Servers without it ignore it.
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (TOOLS_ON) body.tools = tools.TOOL_SPECS;
  await debugDump({ dir: "request", session: session.id, model, body });

  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: session.abort?.signal,
    });
  } catch (err) {
    if (err.name === "AbortError")
      return { text: "", toolCalls: [], aborted: true };
    await debugDump({
      dir: "response",
      session: session.id,
      model,
      error: true,
      message: err.message,
    });
    emit({
      type: "error",
      message: t("local.connectFail", { base: BASE, msg: err.message }),
    });
    return { text: "", toolCalls: [], error: true };
  }
  if (!res.ok || !res.body) {
    const b = await res.text().catch(() => "");
    await debugDump({
      dir: "response",
      session: session.id,
      model,
      error: true,
      status: res.status,
      body: b,
    });
    emit({
      type: "error",
      message: `LLM HTTP ${res.status}: ${b.slice(0, 200)}`,
    });
    return { text: "", toolCalls: [], error: true };
  }

  const decoder = new TextDecoder();
  let carry = "",
    text = "",
    reasoning = "", // accumulated only for LLM_DEBUG_DUMP (see debugDump below)
    finishReason = null,
    usage = null, // the final chunk's usage (prompt_tokens / completion_tokens / total_tokens)
    usedModel = null; // the model the server named in its response (what actually ran)
  const acc = new Map(); // index → { id, name, args }, assembled from fragments
  let thinking = false,
    started = false;
  const setStatus = (state) =>
    emit({ type: "status", state, sessionId: session.id });
  const beginThinking = () => {
    if (!thinking && !started) {
      thinking = true;
      setStatus("think_start");
    }
  };
  const endThinking = () => {
    if (thinking) {
      thinking = false;
      setStatus("think_end");
    }
  };
  const ensureStart = () => {
    endThinking();
    if (!started) {
      started = true;
      setStatus("text_start");
    }
  };
  const closeStream = () => {
    endThinking();
    if (started) setStatus("text_end");
  };

  try {
    for await (const chunk of res.body) {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (!usedModel && json.model) usedModel = json.model;
        if (json.usage) usage = json.usage; // normally arrives on the final, choices-empty chunk
        const choice = json.choices?.[0] ?? {};
        const delta = choice.delta ?? {};
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (delta.reasoning_content) {
          if (DEBUG_ON) reasoning += delta.reasoning_content;
          if (SHOW_REASONING) {
            ensureStart();
            emit({ type: "text_delta", text: delta.reasoning_content });
          } else beginThinking(); // don't emit the body, just signal "thinking"
        }
        if (delta.content) {
          ensureStart();
          text += delta.content;
          emit({ type: "text_delta", text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = acc.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            acc.set(idx, cur);
          }
        }
      }
    }
  } catch (err) {
    closeStream();
    if (err.name === "AbortError")
      return {
        text,
        toolCalls: [],
        finishReason,
        usedModel,
        usage,
        aborted: true,
      };
    await debugDump({
      dir: "response",
      session: session.id,
      model,
      error: true,
      message: err.message,
      text,
      reasoning,
    });
    emit({
      type: "error",
      message: t("local.streamError", { msg: err.message }),
    });
    return { text, toolCalls: [], finishReason, usedModel, usage, error: true };
  }
  closeStream();

  const toolCalls = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => v.name);
  await debugDump({
    dir: "response",
    session: session.id,
    model,
    usedModel,
    finishReason,
    reasoning,
    text,
    toolCalls,
  });
  return { text, toolCalls, finishReason, usedModel, usage };
}

export default {
  name: "local",

  /** Return who we're actually talking to, so each client can show which backend is connected. */
  describe() {
    refreshModels(); // refetch in the background when stale; this call stays synchronous
    const auto = autoChoice();
    return {
      // Use the identified name once known; until then fall back to the port guess.
      label: KIND_LABELS[serverKind] || guessLabel(BASE),
      // The model actually used when none is specified. Reporting the MODEL constant
      // would show "agents-a1-4b" whenever LLM_MODEL is unset, which is neither what
      // auto picks nor necessarily present on the backend — display and behavior
      // would disagree.
      model: auto.label,
      endpoint: BASE.replace(/^https?:\/\//, "").replace(/\/v1$/, ""),
      // For the WebUI's model dropdown. Empty before the fetch, when it fails, or when
      // switching is impossible (llama.cpp single-model mode) — the picker then hides.
      models: modelChoices,
      // null = not determined yet / false = cannot connect. Clients report the error on false.
      reachable,
      // Display name of the model "auto" uses. Same value as model on this backend, but
      // kept separate because they mean different things — model is the generic "what is
      // connected" field, which on claude/codex holds an env value or "(default)". Only
      // this one can be appended to the dropdown's auto entry.
      autoModel: auto.label,
    };
  },

  // Return persisted past sessions as a list/history (used when the provider resolves to local)
  async listSessions(limit = 30, _cwd) {
    if (!PERSIST) return [];
    return (await store.list(limit)).map((s) => ({
      ...s,
      provider: "local",
      status: "idle",
    }));
  },
  async getHistory(session, limit = 10) {
    if (!PERSIST) return [];
    const msgs = await store.load(session.id);
    // Show only user/assistant messages that have a body. Hide tool calls (empty content) and tool responses.
    return msgs
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim(),
      )
      .slice(-limit)
      .map((m) => ({ role: m.role, text: m.content }));
  },

  /** For the WebUI's status line. A local backend has no 5h/1w rate windows, so Ctx is the
   *  context occupancy (%) and the other two slots carry actual token counts (used / max).
   *  Used is the last turn's total_tokens; max is the context window read from the
   *  backend. A slot shows "—" when its value is unavailable. */
  async getUsage(session) {
    await ensureDiscovered();
    // autoChoice() already encodes LLM_MODEL's precedence, so there is no need to repeat
    // it here — a second copy would be the one place that disagrees once the rule changes.
    const model = autoChoice().value;
    const max = await contextWindowFor(serverKind, model);
    const u = usageBySession.get(session.id) || null;
    const used = u ? u.totalTokens : null;
    // With no turn run yet and no window available, hide the row entirely (available:false).
    if (used == null && !Number.isFinite(max)) return { available: false };
    const utilization =
      Number.isFinite(used) && Number.isFinite(max) && max > 0
        ? Math.min(100, (used / max) * 100)
        : null;
    return {
      available: true,
      context: utilization == null ? null : { utilization },
      // The WebUI switches to the local "actual token count" display based on tokens.
      tokens: { used, max: Number.isFinite(max) ? max : null },
    };
  },

  async runTurn(ctx) {
    const { text, images, emit, session, ask, model } = ctx;
    // No model means "auto". It is picked from the list, so wait for the first fetch.
    if (!model) await ensureDiscovered();
    const effectiveModel = model || autoChoice().value;
    const startedAt = Date.now();
    let usedModel = null; // the model the server named in its response (goes on result)

    // The context of record is the persistent store (which spans restarts). This turn's user utterance isn't in it yet, so add it.
    const prior = PERSIST ? await store.load(session.id) : session.history;
    // Persist the user utterance first (so the tool round-trips that follow line up correctly after the user).
    // Images (base64) bloat the JSONL and would mean re-sending a huge context on every resume,
    // so don't persist them. Keep only the text. If an image is needed after resuming, the model can call view_image again.
    if (PERSIST)
      await store.append(
        session.id,
        { role: "user", content: text },
        { cwd: session.cwd || "" },
      );

    const sys = TOOLS_ON ? `${SYSTEM_PROMPT}\n\n${TOOLS_HINT}` : SYSTEM_PROMPT;
    const convo = sanitizeForApi([
      { role: "system", content: sys },
      ...prior,
      { role: "user", content: buildUserContent(text, images) },
    ]);

    let finalText = "",
      rounds = 0,
      ok = true,
      lastUsage = null; // the last usage seen (final tool round-trip = the largest context)
    const cwd = session.cwd || process.cwd();

    try {
      while (true) {
        rounds++;
        const r = await streamOnce({
          messages: convo,
          emit,
          session,
          model: effectiveModel,
        });
        if (r.usedModel) usedModel = r.usedModel;
        if (r.usage) lastUsage = r.usage;
        if (r.error) {
          ok = false;
          break;
        }
        if (r.aborted) {
          ok = false;
          if (r.text) finalText = r.text;
          break;
        }

        // If no tool was called, this utterance is the final answer.
        if (!TOOLS_ON || !r.toolCalls.length) {
          finalText = r.text || "";
          break;
        }

        // Record the assistant's tool calls in the conversation and the persistent store.
        const toolCalls = r.toolCalls.map((tc, i) => ({
          id: tc.id || `call_${rounds}_${i}`,
          type: "function",
          function: { name: tc.name, arguments: tc.args || "{}" },
        }));
        const assistantMsg = {
          role: "assistant",
          content: r.text || "",
          tool_calls: toolCalls,
        };
        convo.push(assistantMsg);
        if (PERSIST) await store.append(session.id, assistantMsg);

        if (rounds >= MAX_ROUNDS) {
          emit({
            type: "error",
            message: t("local.toolRoundsExceeded", { max: MAX_ROUNDS }),
          });
          finalText = r.text || finalText;
          ok = false;
          break;
        }

        // Execute each tool in order and return the result to the conversation via the tool role.
        for (const call of toolCalls) {
          const name = call.function.name;
          let args;
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            args = {};
          }

          emit({ type: "tool_start", name, toolId: call.id });
          let result;
          if (!tools.isAutoAllowed(name) && ask?.permission) {
            const decision = await ask.permission({
              toolName: name,
              description: `${name} ${tools.summarize(name, args)}`.trim(),
              detail: tools.summarize(name, args),
              toolUseId: call.id,
              options: [
                { text: "Yes", key: "allow" },
                { text: `Yes, and always allow ${name}`, key: "allowAlways" },
                { text: "No", key: "deny" },
              ],
            });
            if (decision === "allowAlways") tools.allowAlways(name);
            if (decision === "deny") result = t("local.toolDenied");
          }
          if (result === undefined) {
            try {
              result = await tools.execute(name, args, {
                cwd,
                signal: session.abort?.signal,
              });
            } catch (err) {
              result = t("local.toolError", { msg: err.message });
            }
          }

          // view_image returns { text, image }. The OpenAI-compatible API can't carry an
          // image on role:"tool", so we make only the text the tool response and inject the image into the immediately following user message.
          const hasImage =
            result && typeof result === "object" && result.image?.dataUrl;
          const resultText = hasImage
            ? result.text || ""
            : String(result ?? "");

          const toolMsg = {
            role: "tool",
            tool_call_id: call.id,
            name,
            content: resultText,
          };
          convo.push(toolMsg);
          if (PERSIST) await store.append(session.id, toolMsg); // don't keep the image (text stand-in only)

          if (hasImage) {
            // Synthetic user message. Used only within this round-trip and not persisted (base64 would bloat the JSONL).
            convo.push({
              role: "user",
              content: [
                {
                  type: "text",
                  text: t("local.imageInjected", { name }),
                },
                { type: "image_url", image_url: { url: result.image.dataUrl } },
              ],
            });
          }
          emit({
            type: "tool_end",
            name,
            toolId: call.id,
            summary: tools.summarize(name, args) || name,
          });
        }
        // Let the model read the tool results and loop again (until it finishes).
      }
    } catch (err) {
      if (err?.name !== "AbortError")
        emit({ type: "error", message: `local: ${err.message}` });
      ok = false;
    }

    session.history.push({ role: "assistant", content: finalText });
    if (PERSIST)
      await store.append(session.id, { role: "assistant", content: finalText });
    // Keep this turn's usage; getUsage uses it for the status line's Ctx% and token counts.
    if (lastUsage)
      usageBySession.set(session.id, {
        promptTokens: Number(lastUsage.prompt_tokens) || 0,
        completionTokens: Number(lastUsage.completion_tokens) || 0,
        totalTokens:
          Number(lastUsage.total_tokens) ||
          (Number(lastUsage.prompt_tokens) || 0) +
            (Number(lastUsage.completion_tokens) || 0),
        at: Date.now(),
      });
    emit({
      type: "result",
      success: ok,
      text: finalText,
      sessionId: session.id,
      provider: this.name,
      // The model actually used (extension field). Falls back to what we asked for.
      model: usedModel || effectiveModel,
      costUsd: 0,
      turns: rounds,
      durationMs: Date.now() - startedAt,
      inputTokens: lastUsage ? Number(lastUsage.prompt_tokens) || 0 : 0,
      outputTokens: lastUsage ? Number(lastUsage.completion_tokens) || 0 : 0,
    });
  },
};
