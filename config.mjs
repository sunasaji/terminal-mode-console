// config.mjs — shared settings loader for server.mjs and bin/tmcon-cli.mjs.
//
// Resolution order, highest precedence first:
//   command-line arguments  >  environment variables  >  config file  >  built-in defaults
//
// The config file is a plain KEY=VALUE .env file. By default it is
//   $XDG_CONFIG_HOME/terminal-mode-console/env   (i.e. ~/.config/terminal-mode-console/env)
// and can be overridden with --config <path> or the TMCON_CONFIG environment variable.
//
// loadConfigIntoEnv() reads that file and copies any key that is NOT already set
// in process.env, so real environment variables always win over the file and
// everything downstream keeps reading process.env.<KEY> unchanged. The server /
// CLI then layer their command-line arguments on top of that.
//
// Zero dependencies (Node 20+).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as util from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));

// The default (XDG) config file path. Honors $XDG_CONFIG_HOME when set.
export function defaultConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "terminal-mode-console", "env");
}

// Decide which config file to read: --config <path> on argv, else TMCON_CONFIG,
// else the XDG default. `explicit` is true when the user asked for a specific
// file (so a missing one is an error, whereas a missing default is ignored).
export function resolveConfigPath(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const i = argv.indexOf("--config");
  if (i !== -1 && argv[i + 1]) return { path: argv[i + 1], explicit: true };
  if (env.TMCON_CONFIG) return { path: env.TMCON_CONFIG, explicit: true };
  return { path: defaultConfigPath(env), explicit: false };
}

// Parse .env text into a plain object. Prefers util.parseEnv (Node 20.12+) and
// falls back to a minimal parser so the Node 20 baseline still works.
export function parseEnvText(text) {
  if (typeof util.parseEnv === "function") return util.parseEnv(text);
  const out = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    if (key) out[key] = val;
  }
  return out;
}

// Load the config file and copy any key NOT already present in process.env, so
// real environment variables take precedence over the file. A missing file at
// the default location is silently ignored; a missing EXPLICIT file throws.
// Returns { path, loaded, applied } for optional logging.
export function loadConfigIntoEnv({ argv, env = process.env } = {}) {
  const { path, explicit } = resolveConfigPath(argv, env);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT" && !explicit)
      return { path, loaded: false, applied: [] };
    throw new Error(`cannot read config file ${path}: ${e.message}`, {
      cause: e,
    });
  }
  const vals = parseEnvText(text);
  const applied = [];
  for (const [k, v] of Object.entries(vals)) {
    if (env[k] === undefined) {
      env[k] = v;
      applied.push(k);
    }
  }
  return { path, loaded: true, applied };
}

// The package version (for --version). Read from package.json next to this file.
export function pkgVersion() {
  try {
    return (
      JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version ??
      "unknown"
    );
  } catch {
    return "unknown";
  }
}
