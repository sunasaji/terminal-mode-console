// agents/index.mjs — backend registry + provider slot binding
//
// The app (even-terminal) only sends two provider slots: claude and codex.
// terminal-mode-console runs by assigning an "actual backend"
// (claude / codex / local / echo) to each of these two slots. The assignment
// is decided by environment variables:
//
//   PROVIDER_CLAUDE  the actual backend for the claude slot (default: claude; auto-demoted to local if the SDK is not installed)
//   PROVIDER_CODEX   the actual backend for the codex slot  (default: codex;  auto-demoted to local if the SDK is not installed)
//
// Examples:
//   PROVIDER_CLAUDE=claude PROVIDER_CODEX=codex   # both Claude and Codex are the real thing
//   PROVIDER_CLAUDE=local  PROVIDER_CODEX=local   # both slots use a local LLM
//   PROVIDER_CLAUDE=echo   PROVIDER_CODEX=echo    # for smoke testing
//
// Adding a new backend = just import and register it here. The slot assignment is done on the env side.

import echo from "./echo.mjs";
import localLLM from "./local-llm.mjs";
// claude is an optional dependency. available=false if the SDK is not installed.
import claude, { available as claudeAvailable } from "./claude.mjs";
import codex, { available as codexAvailable } from "./codex.mjs";

const registry = new Map();
export function register(agent, alias) {
  registry.set(alias || agent.name, agent);
}

register(echo);
register(localLLM);
if (claudeAvailable) register(claude);
if (codexAvailable) register(codex);

// App provider slot → actual backend name.
const SLOTS = {
  claude: process.env.PROVIDER_CLAUDE || "claude",
  codex: process.env.PROVIDER_CODEX || "codex",
};
// Default slot to fall back to for unknown/unspecified providers.
const DEFAULT_SLOT = "claude";
// Last-resort fallback for when the assigned backend is not registered
// (e.g. PROVIDER_*=claude while the claude SDK is not installed).
// Use local if available, otherwise echo.
const FALLBACK = registry.has(localLLM.name) ? localLLM.name : echo.name;

/**
 * provider → actual adapter.
 *
 * Two kinds of name are accepted:
 *   1. a slot (claude/codex) — resolved through its env binding. The glasses app only
 *      ever sends these two, so this path keeps its behavior exactly as before.
 *   2. a backend name (local/echo/…) — opened directly, even when no slot is bound to it.
 *      Without this, `?defaultProvider=local` silently landed on the default slot and the
 *      client got Claude while asking for the local LLM.
 * A slot always wins over a backend of the same name, so an env binding is never bypassed.
 * Anything unknown falls back to the default slot.
 */
export function getAgent(provider) {
  if (Object.hasOwn(SLOTS, provider)) {
    return (
      registry.get(SLOTS[provider] || SLOTS[DEFAULT_SLOT]) ||
      registry.get(FALLBACK)
    );
  }
  if (registry.has(provider)) return registry.get(provider);
  return registry.get(SLOTS[DEFAULT_SLOT]) || registry.get(FALLBACK);
}

/**
 * The key that per-provider state (model memory, archive flags) is stored under.
 *
 * This is the **resolved backend**, not the requested name. A model name belongs to a
 * backend — "opus" means nothing to LM Studio, and "yi-coder-1.5b-chat" means nothing to
 * Claude Code — so keying by slot would carry a model across a change of binding:
 * pick a local model through a claude slot bound to local, rebind that slot back to
 * claude, and the slot would still hand Claude the local model's name.
 * Keying by backend also means the same conversation state is found whether a backend was
 * reached through a slot or addressed directly.
 */
export function providerKey(provider) {
  return getAgent(provider).name;
}

/**
 * Actual backend name → the name clients should see.
 * A slot bound to this backend wins, so the glasses keep seeing claude/codex as before;
 * a backend that no slot is bound to is reported under its own name, which is how a
 * directly-addressed one (e.g. local) stays re-openable by the client that asked for it.
 * If multiple slots point to the same backend, the first matching slot is returned.
 */
export function slotForBackend(name) {
  for (const slot of Object.keys(SLOTS)) if (SLOTS[slot] === name) return slot;
  return registry.has(name) ? name : DEFAULT_SLOT;
}

export function agentNames() {
  return [...registry.keys()];
}
export function providerSlots() {
  return Object.keys(SLOTS);
}
export const slotBindings = { ...SLOTS };
export { DEFAULT_SLOT as defaultProvider };
