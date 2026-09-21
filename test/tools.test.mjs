// test/tools.test.mjs — local-LLM tool dispatch (agents/tools.mjs)
//
// These tools run shell commands and read the filesystem on behalf of a local
// model, so the auto-allow gating and the execute() dispatch are security
// sensitive. Tests assert on behavior rather than the exact (localizable)
// message wording so they stay stable if the model-facing strings change.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isAutoAllowed,
  allowAlways,
  summarize,
  execute,
} from "../agents/tools.mjs";

const ctx = (cwd) => ({ cwd, signal: new AbortController().signal });

test("isAutoAllowed: read-only tools are auto-allowed, bash is not", () => {
  assert.equal(isAutoAllowed("read_file"), true);
  assert.equal(isAutoAllowed("grep"), true);
  assert.equal(isAutoAllowed("list_dir"), true);
  assert.equal(isAutoAllowed("view_image"), true);
  // bash can run arbitrary commands, so it must require explicit permission.
  assert.equal(isAutoAllowed("bash"), false);
  assert.equal(isAutoAllowed("unknown_tool"), false);
});

test("allowAlways: promotes a tool into the auto-allow set", () => {
  assert.equal(isAutoAllowed("bash"), false);
  allowAlways("bash");
  assert.equal(isAutoAllowed("bash"), true);
});

test("summarize: picks a field and truncates long labels", () => {
  assert.equal(summarize("bash", { command: "ls -la" }), "ls -la");
  assert.equal(summarize("grep", { pattern: "TODO" }), "TODO");
  assert.equal(summarize("read_file", { path: "a/b.txt" }), "a/b.txt");
  assert.equal(summarize("read_file", {}), "");
  const long = "x".repeat(60);
  const out = summarize("bash", { command: long });
  assert.equal(out.length, 48);
  assert.ok(out.endsWith("…"));
});

test("execute read_file: returns file contents, and a string on error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmcon-tools-"));
  await writeFile(join(dir, "hello.txt"), "hello world");
  const ok = await execute("read_file", { path: "hello.txt" }, ctx(dir));
  assert.equal(ok, "hello world");
  // Missing path and missing file both return a string, never throw.
  assert.equal(typeof (await execute("read_file", {}, ctx(dir))), "string");
  const missing = await execute("read_file", { path: "nope.txt" }, ctx(dir));
  assert.equal(typeof missing, "string");
});

test("execute list_dir: lists entries with a trailing slash for dirs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmcon-tools-"));
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "file.txt"), "x");
  const out = await execute("list_dir", {}, ctx(dir));
  const lines = out.split("\n");
  assert.ok(lines.includes("sub/"));
  assert.ok(lines.includes("file.txt"));
});

test("execute grep: reports matches and distinguishes no-match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmcon-tools-"));
  await writeFile(join(dir, "a.txt"), "alpha\nNEEDLE here\nbeta\n");
  const hit = await execute("grep", { pattern: "NEEDLE" }, ctx(dir));
  assert.match(hit, /a\.txt:2:.*NEEDLE/);
  const miss = await execute(
    "grep",
    { pattern: "does-not-exist-xyz" },
    ctx(dir),
  );
  assert.equal(typeof miss, "string");
  assert.doesNotMatch(miss, /NEEDLE/);
});

test("execute bash: runs a command and surfaces non-zero exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmcon-tools-"));
  const out = await execute("bash", { command: "echo hi" }, ctx(dir));
  assert.match(out, /hi/);
  const fail = await execute("bash", { command: "exit 3" }, ctx(dir));
  assert.match(fail, /exit 3/);
});

test("execute view_image: rejects non-image extensions, embeds a data URL for images", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmcon-tools-"));
  await writeFile(join(dir, "note.txt"), "not an image");
  const bad = await execute("view_image", { path: "note.txt" }, ctx(dir));
  assert.equal(typeof bad, "string"); // unsupported extension -> plain string

  // 1x1 transparent PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
  await writeFile(join(dir, "dot.png"), png);
  const ok = await execute("view_image", { path: "dot.png" }, ctx(dir));
  assert.equal(typeof ok, "object");
  assert.ok(ok.image?.dataUrl?.startsWith("data:image/png;base64,"));
});

test("execute: unknown tool returns a string instead of throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmcon-tools-"));
  const out = await execute("no_such_tool", {}, ctx(dir));
  assert.equal(typeof out, "string");
});
