// Session display metadata specific to terminal-mode-console.
// Without touching Claude's / Codex's saved data, it holds the archive state in
// the list and the "last specified model" (per session + a per-provider global default).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FILE =
  process.env.TMCON_SESSION_METADATA ||
  join(homedir(), ".tmcon", "session-metadata.json");
let loadPromise = null;
let sessions = {};
// Key "provider:sessionId" → the model last used in that conversation (alias/full ID).
// Held separately from the archive state (sessions) so it is not erased by the unarchive delete.
let sessionModels = {};
// provider slot (claude/codex) → the model someone last selected. A reference point
// so that a client without a UI (the glasses) can carry over the most recently specified
// model even under a different sessionId.
let globalLastModel = {};
let pendingWrite = Promise.resolve();

const keyOf = (provider, sessionId) => `${provider}:${sessionId}`;

async function load() {
  if (!loadPromise)
    loadPromise = (async () => {
      try {
        const parsed = JSON.parse(await readFile(FILE, "utf8"));
        sessions =
          parsed?.sessions && typeof parsed.sessions === "object"
            ? parsed.sessions
            : {};
        sessionModels =
          parsed?.sessionModels && typeof parsed.sessionModels === "object"
            ? parsed.sessionModels
            : {};
        globalLastModel =
          parsed?.globalLastModel && typeof parsed.globalLastModel === "object"
            ? parsed.globalLastModel
            : {};
      } catch {
        sessions = {};
        sessionModels = {};
        globalLastModel = {};
      }
    })();
  await loadPromise;
}

async function persist() {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify(
      { version: 1, sessions, sessionModels, globalLastModel },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  await rename(tmp, FILE);
}

export async function isArchived(provider, sessionId) {
  await load();
  return Boolean(sessions[keyOf(provider, sessionId)]?.archivedAt);
}

export async function archivedSessions(provider) {
  await load();
  const prefix = `${provider}:`;
  return new Map(
    Object.entries(sessions)
      .filter(([key, value]) => key.startsWith(prefix) && value?.archivedAt)
      .map(([key, value]) => [key.slice(prefix.length), value]),
  );
}

/** Resolve which model should be used for that conversation. Priority order:
 *  "this session's last specification" → "the provider slot's global default
 *  (the value someone last selected)". null if neither exists.
 *  Even when the UI-less glasses arrive with a different sessionId, the global
 *  default lets it carry over the most recent specification. */
export async function rememberedModel(provider, sessionId) {
  await load();
  return (
    sessionModels[keyOf(provider, sessionId)] ??
    globalLastModel[provider] ??
    null
  );
}

/** Remember the model when it is explicitly specified. Update both the
 *  per-session value and the global default, and write serially to disk so it
 *  survives a restart. */
export async function setLastModel(provider, sessionId, model) {
  await load();
  const value = typeof model === "string" ? model.trim() : "";
  if (!value) return null;
  sessionModels[keyOf(provider, sessionId)] = value;
  globalLastModel[provider] = value;
  pendingWrite = pendingWrite.catch(() => {}).then(persist);
  await pendingWrite;
  return value;
}

/** Clear the remembered model, returning to "unspecified" (env CLAUDE_MODEL →
 *  delegate to the backend default). Since setting writes both the per-session
 *  value and the global default, clearing targets both as well.
 *  Without this, there would be no way to undo a default once it is written. */
export async function clearLastModel(provider, sessionId) {
  await load();
  delete sessionModels[keyOf(provider, sessionId)];
  delete globalLastModel[provider];
  pendingWrite = pendingWrite.catch(() => {}).then(persist);
  await pendingWrite;
  return null;
}

export async function setArchived(
  provider,
  sessionId,
  archived,
  snapshot = {},
) {
  await load();
  const key = keyOf(provider, sessionId);
  if (archived)
    sessions[key] = {
      ...sessions[key],
      archivedAt: new Date().toISOString(),
      ...(typeof snapshot.title === "string" ? { title: snapshot.title } : {}),
      ...(typeof snapshot.cwd === "string" ? { cwd: snapshot.cwd } : {}),
      ...(typeof snapshot.timestamp === "string"
        ? { timestamp: snapshot.timestamp }
        : {}),
    };
  else delete sessions[key];
  // Even when operated on concurrently by multiple clients, serialize the writes so the last state remains.
  pendingWrite = pendingWrite.catch(() => {}).then(persist);
  await pendingWrite;
  return archived ? sessions[key] : null;
}
