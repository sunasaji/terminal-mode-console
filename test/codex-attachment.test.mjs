import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildInput } from "../agents/codex.mjs";

test("buildInput materializes data URL images for Codex App Server", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const prepared = await buildInput("inspect this", [
    `data:image/png;base64,${png.toString("base64")}`,
  ]);

  try {
    assert.deepEqual(prepared.input[0], { type: "text", text: "inspect this" });
    assert.equal(prepared.input[1].type, "localImage");
    assert.match(prepared.input[1].path, /image-0\.png$/);
    assert.deepEqual(await readFile(prepared.input[1].path), png);
  } finally {
    await prepared.cleanup();
  }

  await assert.rejects(readFile(prepared.input[1].path), { code: "ENOENT" });
});
