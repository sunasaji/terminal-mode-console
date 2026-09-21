// agents/tools.mjs — the "coding-agent-like" toolset given to the local LLM
//
// Called from local-llm.mjs via OpenAI-compatible function-calling. This holds only
//   1) the tool definitions handed to the model (TOOL_SPECS)
//   2) the actual execution (execute)
//   3) deciding whether permission is required (isAutoAllowed / allowAlways)
//   4) a short one-line-for-the-glasses label (summarize)
// It's a pure component; the SSE and the permission round-trip (ask) are owned by local-llm.mjs.
//
// [Safety policy]
//   - read_file / grep / list_dir are read-only. Auto-allowed by default.
//   - bash can run arbitrary commands, so by default it asks the user for permission every time.
//   - Everything is relative to the working directory (session.cwd). The abort signal is passed to
//     child processes so they can be killed instantly on turn interruption. Output and run time are capped.
//
// Environment variables:
//   LLM_TOOLS_AUTO_ALLOW  tool names to auto-allow (comma-separated; default: read_file,grep,list_dir)
//   LLM_TOOLS_TIMEOUT     execution timeout in seconds for bash/grep (default 30)
//
// Zero dependencies (node:child_process / node:fs/promises / node:path).

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { makeT } from "../i18n.mjs";

// Model-facing tool descriptions and result strings are localized via the shared
// i18n loader (server locale). English is the base; other locales fall back to it.
const { t } = makeT();

const TIMEOUT = (Number(process.env.LLM_TOOLS_TIMEOUT) || 30) * 1000;
const MAX_OUTPUT = 12000; // cap on child-process output (chars). Don't overflow the small glasses/context.
const MAX_READ = 60000; // cap for read_file (bytes).
// Cap for view_image (bytes). base64 encoding inflates the context, so reject large images and prompt for downscaling.
const MAX_IMAGE = Number(process.env.LLM_TOOLS_MAX_IMAGE) || 8 * 1024 * 1024;

// Image formats view_image handles (extension → MIME). Limited to what Vision models can understand.
const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

// Auto-allow set. bash is not included by default (asks every time). allowAlways can add to it later.
// view_image is read-only, so like the read tools it's auto-allowed by default.
const AUTO = new Set(
  (process.env.LLM_TOOLS_AUTO_ALLOW ?? "read_file,grep,list_dir,view_image")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
export function isAutoAllowed(name) {
  return AUTO.has(name);
}
export function allowAlways(name) {
  AUTO.add(name);
}

/** Tool definitions handed to the model (OpenAI function-calling format). */
export const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: t("tools.desc.bash"),
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: t("tools.desc.bash.command"),
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: t("tools.desc.grep"),
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: t("tools.desc.grep.pattern"),
          },
          path: {
            type: "string",
            description: t("tools.desc.grep.path"),
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: t("tools.desc.read_file"),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: t("tools.desc.read_file.path"),
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_image",
      description: t("tools.desc.view_image"),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: t("tools.desc.view_image.path"),
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: t("tools.desc.list_dir"),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: t("tools.desc.list_dir.path"),
          },
        },
      },
    },
  },
];

/** A short label that fits one line on the glasses. Used in the permission dialog and tool_start display. */
export function summarize(name, args = {}) {
  const pick =
    args.command ?? args.pattern ?? args.path ?? args.file_path ?? "";
  const s = String(pick).replace(/\s+/g, " ").trim();
  return s.length > 48 ? s.slice(0, 47) + "…" : s;
}

/** Execute a tool and return the result. Never throws; returns something the model can read.
 *  Usually a string. Only view_image, since it carries an image, returns { text, image:{dataUrl} }
 *  — the OpenAI-compatible API can't put an image on role:"tool", so the caller
 *  (local-llm) makes text the tool response and injects image into the immediately following user message. */
export async function execute(name, args, ctx) {
  switch (name) {
    case "bash":
      return runBash(args, ctx);
    case "grep":
      return runGrep(args, ctx);
    case "read_file":
      return readFileTool(args, ctx);
    case "view_image":
      return viewImageTool(args, ctx);
    case "list_dir":
      return listDirTool(args, ctx);
    default:
      return t("tools.result.unknownTool", { name });
  }
}

async function runBash({ command }, { cwd, signal }) {
  if (!command || typeof command !== "string")
    return t("tools.result.noCommand");
  const r = await spawnCapture("bash", ["-c", command], { cwd, signal });
  return formatProc(r);
}

async function runGrep({ pattern, path }, { cwd, signal }) {
  if (!pattern || typeof pattern !== "string")
    return t("tools.result.noPattern");
  const target = typeof path === "string" && path ? path : ".";
  const r = await spawnCapture(
    "grep",
    ["-rIn", "--color=never", "-e", pattern, "--", target],
    { cwd, signal },
  );
  if (r.timedOut) return t("tools.result.timeout", { sec: TIMEOUT / 1000 });
  if (r.code === 0) return r.stdout || t("tools.result.matchNoOutput");
  if (r.code === 1) return t("tools.result.noMatch");
  return r.stderr || t("tools.result.grepFail", { code: r.code });
}

async function readFileTool({ path: p }, { cwd }) {
  if (!p || typeof p !== "string") return t("tools.result.noPath");
  try {
    const buf = await readFile(resolve(cwd, p));
    let s = buf.subarray(0, MAX_READ).toString("utf8");
    if (buf.length > MAX_READ)
      s += t("tools.result.truncatedRead", { bytes: buf.length - MAX_READ });
    return s || t("tools.result.emptyFile");
  } catch (err) {
    return t("tools.result.readFail", { msg: err.message });
  }
}

async function viewImageTool({ path: p }, { cwd }) {
  if (!p || typeof p !== "string") return t("tools.result.noPath");
  const mime = IMAGE_MIME[extname(p).toLowerCase()];
  if (!mime)
    return t("tools.result.unsupportedImage", {
      ext: extname(p) || t("tools.result.imageExtNone"),
    });
  try {
    const buf = await readFile(resolve(cwd, p));
    if (buf.length > MAX_IMAGE) {
      return t("tools.result.imageTooLarge", {
        bytes: buf.length,
        max: MAX_IMAGE,
      });
    }
    // Return an object rather than a string. local-llm injects image into the user message.
    return {
      text: t("tools.result.imageLoaded", { path: p, bytes: buf.length }),
      image: { dataUrl: `data:${mime};base64,${buf.toString("base64")}` },
    };
  } catch (err) {
    return t("tools.result.readFail", { msg: err.message });
  }
}

async function listDirTool({ path: p }, { cwd }) {
  const target = typeof p === "string" && p ? p : ".";
  try {
    const ents = await readdir(resolve(cwd, target), { withFileTypes: true });
    return (
      ents
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .sort()
        .join("\n") || t("tools.result.emptyDir")
    );
  } catch (err) {
    return t("tools.result.listFail", { msg: err.message });
  }
}

/** Combine the child-process result (stdout/stderr/code) into a single string for the model to read. */
function formatProc(r) {
  if (r.timedOut)
    return `${t("tools.result.timeoutKilled", { sec: TIMEOUT / 1000 })}\n${r.stdout}`.trim();
  const parts = [];
  if (r.stdout) parts.push(r.stdout);
  if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
  if (r.code !== 0) parts.push(`[exit ${r.code}]`);
  return parts.join("\n").trim() || t("tools.result.noOutput");
}

/** Launch cmd with argv, collect output with a cap. Kill the child on abort/timeout. */
function spawnCapture(cmd, argv, { cwd, signal }) {
  return new Promise((resolveP) => {
    let stdout = "",
      stderr = "",
      timedOut = false,
      settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolveP(r);
      }
    };

    let child;
    try {
      child = spawn(cmd, argv, { cwd: cwd || process.cwd(), signal });
    } catch (err) {
      return done({
        stdout: "",
        stderr: String(err.message),
        code: 127,
        timedOut: false,
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, TIMEOUT);
    const grab = (chunk, into) => {
      if (into.length < MAX_OUTPUT) into += chunk.toString();
      return into;
    };
    child.stdout?.on("data", (d) => {
      stdout = grab(d, stdout);
    });
    child.stderr?.on("data", (d) => {
      stderr = grab(d, stderr);
    });
    child.on("error", (err) =>
      done({
        stdout,
        stderr: stderr || String(err.message),
        code: 127,
        timedOut,
      }),
    );
    child.on("close", (code) =>
      done({
        stdout: cap(stdout),
        stderr: cap(stderr),
        code: code ?? 0,
        timedOut,
      }),
    );
  });
}

function cap(s) {
  return s.length > MAX_OUTPUT
    ? s.slice(0, MAX_OUTPUT) +
        t("tools.result.truncatedOutput", { max: MAX_OUTPUT })
    : s;
}
