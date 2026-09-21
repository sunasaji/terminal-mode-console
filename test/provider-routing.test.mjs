// Provider resolution rules.
// A provider sent by a client is one of two kinds — a slot (claude/codex), or a backend
// named directly (local/echo). The stock glasses app only ever sends the former, so the
// requirement when adding the latter is that the former's behavior does not change.
import test from "node:test";
import assert from "node:assert/strict";

/** Reload the registry with the environment swapped (SLOTS is fixed at load time). */
async function loadRegistry(env, tag) {
  const saved = {};
  for (const k of ["PROVIDER_CLAUDE", "PROVIDER_CODEX"]) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  // Loading makes the local LLM try to fetch its list; a failure there is swallowed.
  process.env.LLM_BASE_URL ||= "http://127.0.0.1:1/v1";
  const mod = await import(`../agents/index.mjs?case=${tag}-${Date.now()}`);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return mod;
}

test("a backend name can be addressed directly, without binding it to a slot", async () => {
  const r = await loadRegistry({}, "direct");
  // This is the whole point. Previously local was not a slot, so it fell silently through
  // to the default slot (claude) and asking for local handed back Claude.
  assert.equal(r.getAgent("local").name, "local");
  assert.equal(r.getAgent("echo").name, "echo");
});

test("unknown providers still fall back to the default slot", async () => {
  const r = await loadRegistry({}, "unknown");
  assert.equal(r.getAgent("nonexistent").name, r.getAgent("claude").name);
  assert.equal(r.providerKey("nonexistent"), "claude");
});

test("a slot binding wins over a backend of the same name", async () => {
  // The established setup (the claude slot bound to local). The glasses only send
  // provider=claude, so breaking this would connect the stock app to another backend.
  const r = await loadRegistry({ PROVIDER_CLAUDE: "local" }, "bound");
  assert.equal(r.getAgent("claude").name, "local");
  // A bound backend is reported under its slot name, preserving the app's vocabulary.
  assert.equal(r.slotForBackend("local"), "claude");
});

test("an unbound backend is reported under its own name", async () => {
  const r = await loadRegistry({}, "unbound");
  // If a directly-addressed session came back as claude, the client could no longer
  // reopen it with the provider it used.
  assert.equal(r.slotForBackend("local"), "local");
  assert.equal(r.slotForBackend("echo"), "echo");
  assert.equal(r.slotForBackend("nonexistent"), "claude");
});

test("providerKey keeps per-provider state separate", async () => {
  const r = await loadRegistry({}, "key");
  // Remembered models and archive flags are separated by this key. Collapsing it would
  // hand the model remembered for the local LLM to Claude, and vice versa.
  const keys = ["claude", "codex", "local", "echo"].map((p) =>
    r.providerKey(p),
  );
  assert.equal(
    new Set(keys).size,
    keys.length,
    "each provider gets a distinct key",
  );
  assert.equal(r.providerKey("local"), "local");
  assert.equal(r.providerKey("echo"), "echo");
});

test("state is keyed by the backend, so rebinding a slot does not carry it over", async () => {
  // Used through a slot bound to local, the state accumulates as local's.
  const bound = await loadRegistry({ PROVIDER_CLAUDE: "local" }, "key-bound");
  assert.equal(bound.providerKey("claude"), "local");
  // Through the slot or addressed directly, the same key means the same state.
  assert.equal(bound.providerKey("claude"), bound.providerKey("local"));

  // Rebinding the slot to claude returns the key to claude, so a model remembered for
  // local is never carried over to Claude (keying by slot name mixed these up).
  const rebound = await loadRegistry(
    { PROVIDER_CLAUDE: "claude" },
    "key-rebound",
  );
  assert.notEqual(rebound.providerKey("claude"), "local");
  assert.equal(rebound.providerKey("claude"), rebound.getAgent("claude").name);
});
