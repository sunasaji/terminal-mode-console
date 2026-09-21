import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("archive metadata is scoped by provider and persists as display-only state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmcon-metadata-"));
  const file = join(dir, "session-metadata.json");
  process.env.TMCON_SESSION_METADATA = file;
  const store = await import(`../session-metadata.mjs?test=${Date.now()}`);

  await store.setArchived("claude", "same-id", true, {
    title: "Archived session",
    cwd: "/tmp/project",
    timestamp: "2026-09-18T00:00:00.000Z",
  });
  assert.equal(await store.isArchived("claude", "same-id"), true);
  assert.equal(await store.isArchived("codex", "same-id"), false);
  const archived = await store.archivedSessions("claude");
  assert.deepEqual([...archived.keys()], ["same-id"]);
  assert.equal(archived.get("same-id").cwd, "/tmp/project");

  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.ok(saved.sessions["claude:same-id"].archivedAt);

  await store.setArchived("claude", "same-id", false);
  assert.equal(await store.isArchived("claude", "same-id"), false);
});

test("remembered model resolves per-session then provider-global, and persists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmcon-model-"));
  const file = join(dir, "session-metadata.json");
  process.env.TMCON_SESSION_METADATA = file;
  const store = await import(`../session-metadata.mjs?test=${Date.now()}`);

  // With nothing specified, the result is null.
  assert.equal(await store.rememberedModel("claude", "s1"), null);

  // Set s1 to opus → s1 is opus. A different session s2 inherits the global default (opus).
  await store.setLastModel("claude", "s1", "opus");
  assert.equal(await store.rememberedModel("claude", "s1"), "opus");
  assert.equal(await store.rememberedModel("claude", "s2"), "opus");

  // Set s2 to sonnet → s2 is sonnet, while s1 keeps its own setting (opus).
  await store.setLastModel("claude", "s2", "sonnet");
  assert.equal(await store.rememberedModel("claude", "s1"), "opus");
  assert.equal(await store.rememberedModel("claude", "s2"), "sonnet");

  // Provider slots are isolated (the codex side is unaffected by claude's memory).
  assert.equal(await store.rememberedModel("codex", "s1"), null);

  // An empty string is not remembered (auto = defer to the default).
  assert.equal(await store.setLastModel("claude", "s3", "  "), null);

  // Archiving then unarchiving does not erase the remembered model (kept in a separate map).
  await store.setArchived("claude", "s1", true);
  await store.setArchived("claude", "s1", false);
  assert.equal(await store.rememberedModel("claude", "s1"), "opus");

  // A separate process (re-import) restores the value from disk.
  const reloaded = await import(
    `../session-metadata.mjs?test=${Date.now()}-reload`
  );
  assert.equal(await reloaded.rememberedModel("claude", "s1"), "opus");
  assert.equal(await reloaded.rememberedModel("claude", "brand-new"), "sonnet"); // global default
});

test("clearing the remembered model restores the unset state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmcon-model-clear-"));
  const file = join(dir, "session-metadata.json");
  process.env.TMCON_SESSION_METADATA = file;
  const store = await import(
    `../session-metadata.mjs?test=${Date.now()}-clear`
  );

  await store.setLastModel("claude", "s1", "opus");
  assert.equal(await store.rememberedModel("claude", "s1"), "opus");
  assert.equal(await store.rememberedModel("claude", "s2"), "opus"); // global default

  // Clearing erases both the session and the global default, returning to the "unset" state.
  // Erasing only one would leave the supposedly cancelled default still in effect for other sessions.
  await store.clearLastModel("claude", "s1");
  assert.equal(await store.rememberedModel("claude", "s1"), null);
  assert.equal(await store.rememberedModel("claude", "s2"), null);

  // The clear also persists to disk (it does not come back after a restart).
  const reloaded = await import(
    `../session-metadata.mjs?test=${Date.now()}-clear-reload`
  );
  assert.equal(await reloaded.rememberedModel("claude", "s1"), null);
});
