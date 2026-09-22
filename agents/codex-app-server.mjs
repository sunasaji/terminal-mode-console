import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const localBin = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "codex.cmd" : "codex",
);
const defaultCommand = existsSync(localBin) ? localBin : "codex";

// Codex gates request_user_input in Default mode behind this under-development
// feature. Enable it only on terminal-mode-console's private child; never edit config.toml.
// Default-mode requests currently report isBlocking:false at the protocol level,
// so the UI must still answer the exact server-request id explicitly.
export const DEFAULT_CODEX_APP_SERVER_ARGS = [
  "app-server",
  "--enable",
  "default_mode_request_user_input",
];

export class CodexAppServer extends EventEmitter {
  constructor({
    command = process.env.CODEX_COMMAND || defaultCommand,
    cwd,
  } = {}) {
    super();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    // Use Codex's auto-review by default. Only when "0" is explicitly specified
    // do we forward permission requests to the client as before.
    const args =
      process.env.CODEX_APPROVE_FOR_ME === "0"
        ? [...DEFAULT_CODEX_APP_SERVER_ARGS]
        : ["--approve-for-me", ...DEFAULT_CODEX_APP_SERVER_ARGS];
    this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) =>
      this.onLine(line),
    );
    this.child.stderr.on("data", (d) => {
      if (process.env.CODEX_DEBUG === "1") process.stderr.write(`[codex] ${d}`);
    });
    this.child.once("error", (e) => this.shutdown(e));
    this.child.once("exit", (code, signal) =>
      this.shutdown(
        new Error(`codex app-server exited (${signal ?? code ?? "unknown"})`),
      ),
    );
  }
  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "terminal-mode-console",
        title: "terminal-mode-console",
        version: "0.3.1",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    return result;
  }
  request(method, params = {}) {
    if (this.closed)
      return Promise.reject(new Error("codex app-server is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }
  notify(method, params = {}) {
    this.write({ method, params });
  }
  respond(id, result) {
    this.write({ id, result });
  }
  reject(id, code, message) {
    this.write({ id, error: { code, message } });
  }
  write(msg) {
    if (this.closed) throw new Error("codex app-server is closed");
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }
  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error("invalid Codex JSON-RPC"));
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error
        ? p.reject(
            new Error(`Codex RPC ${msg.error.code}: ${msg.error.message}`),
          )
        : p.resolve(msg.result);
    } else if (msg.id !== undefined) this.emit("request", msg);
    else if (msg.method)
      this.emit("notification", msg.method, msg.params ?? {});
  }
  close() {
    if (!this.closed) this.child.kill("SIGTERM");
  }
  shutdown(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.emit("closed", error);
  }
}
