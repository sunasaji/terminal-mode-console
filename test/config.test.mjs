import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEnvText,
  resolveConfigPath,
  defaultConfigPath,
  loadConfigIntoEnv,
} from "../config.mjs";

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "tmcon-config-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("parseEnvText: KEY=VALUE, comments, blanks, and quotes", () => {
  const out = parseEnvText(
    '# comment\n\nTMCON_TOKEN=abc123\nTMCON_HOST="127.0.0.1"\nTMCON_PORT=3456\n',
  );
  assert.equal(out.TMCON_TOKEN, "abc123");
  assert.equal(out.TMCON_HOST, "127.0.0.1");
  assert.equal(out.TMCON_PORT, "3456");
});

test("defaultConfigPath honors XDG_CONFIG_HOME", () => {
  assert.equal(
    defaultConfigPath({ XDG_CONFIG_HOME: "/x/cfg" }),
    "/x/cfg/terminal-mode-console/env",
  );
});

test("resolveConfigPath: --config > TMCON_CONFIG > default", () => {
  assert.deepEqual(resolveConfigPath(["--config", "/a/env"], {}), {
    path: "/a/env",
    explicit: true,
  });
  assert.deepEqual(resolveConfigPath([], { TMCON_CONFIG: "/b/env" }), {
    path: "/b/env",
    explicit: true,
  });
  const def = resolveConfigPath([], { XDG_CONFIG_HOME: "/c" });
  assert.equal(def.explicit, false);
  assert.equal(def.path, "/c/terminal-mode-console/env");
});

test("loadConfigIntoEnv: file populates env, real env wins", () =>
  withTmp((dir) => {
    const path = join(dir, "env");
    writeFileSync(path, "TMCON_TOKEN=from-file\nTMCON_PORT=39991\n");
    const env = { TMCON_PORT: "40000" }; // pre-set env must win over the file
    const r = loadConfigIntoEnv({ argv: ["--config", path], env });
    assert.equal(r.loaded, true);
    assert.equal(env.TMCON_TOKEN, "from-file");
    assert.equal(env.TMCON_PORT, "40000");
    assert.deepEqual(r.applied, ["TMCON_TOKEN"]);
  }));

test("loadConfigIntoEnv: missing default file is ignored", () => {
  const r = loadConfigIntoEnv({
    argv: [],
    env: { XDG_CONFIG_HOME: join(tmpdir(), "tmcon-does-not-exist") },
  });
  assert.equal(r.loaded, false);
  assert.deepEqual(r.applied, []);
});

test("loadConfigIntoEnv: missing explicit file throws", () => {
  assert.throws(
    () => loadConfigIntoEnv({ argv: ["--config", "/no/such/file"], env: {} }),
    /cannot read config file/,
  );
});
