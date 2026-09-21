// agents/store.mjs — minimal store that persists sessions as JSONL
//
// A shared component that gives conversation history to backends that do not
// persist it themselves (local-llm etc.). We keep our own equivalent of Claude
// Code's JSONL. One session = one file, one line = one message
// ({ts, role, content}), simply appended.
//
//   Save location: LLM_STORE_DIR (default ~/.tmcon/sessions)
//
// Conversations are kept in plaintext (same nature as Claude's JSONL). They are
// placed in ~/.tmcon outside the repository, so there is no risk of accidental
// commits. Zero dependencies (node:fs etc. from Node 20+).

import { appendFile, readFile, readdir, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = process.env.LLM_STORE_DIR || join(homedir(), ".tmcon", "sessions");
// The session store directory, exported so debug tooling can co-locate its output.
export const STORE_DIR = DIR;
// Default count when list() is called with no argument (the server passes its own limit explicitly).
const LIST_LIMIT_DEFAULT = Number(process.env.SESSIONS_LIMIT_DEFAULT) || 100;
const UUID_RE = /^[0-9a-f-]{8,}$/i; // only handle ids that are safe to use as file names

const file = (id) => join(DIR, `${id}.jsonl`);
const safe = (id) => typeof id === "string" && UUID_RE.test(id);

async function ensureDir() {
  try {
    await mkdir(DIR, { recursive: true });
  } catch {
    /* ignore if it already exists */
  }
}

/** Append one message. meta (cwd etc.) is only recorded on the first line.
 *  For tool use, also keep the assistant's tool_calls and the tool role's
 *  tool_call_id / name (so the next turn can re-supply a correct conversation
 *  sequence to the OpenAI-compatible API). */
export async function append(id, msg, meta = {}) {
  if (!safe(id)) return;
  await ensureDir();
  const rec = { ts: Date.now(), role: msg.role, content: msg.content ?? "" };
  if (msg.tool_calls) rec.tool_calls = msg.tool_calls; // line where the assistant called a tool
  if (msg.tool_call_id) rec.tool_call_id = msg.tool_call_id; // response line for the tool role
  if (msg.name) rec.name = msg.name;
  Object.assign(rec, meta);
  const line = JSON.stringify(rec) + "\n";
  try {
    await appendFile(file(id), line, "utf8");
  } catch {
    /* the conversation continues even if the write fails */
  }
}

/** Return the history as an array. Empty if none. Corrupted lines are skipped. */
export async function load(id) {
  if (!safe(id)) return [];
  let raw;
  try {
    raw = await readFile(file(id), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.role && typeof o.content === "string") {
        const rec = { role: o.role, content: o.content, ts: o.ts, cwd: o.cwd };
        if (o.tool_calls) rec.tool_calls = o.tool_calls;
        if (o.tool_call_id) rec.tool_call_id = o.tool_call_id;
        if (o.name) rec.name = o.name;
        out.push(rec);
      }
    } catch {
      /* ignore corrupted lines */
    }
  }
  return out;
}

/** Session list. Title is the first user utterance, time is the file's modification time. */
export async function list(limit = LIST_LIMIT_DEFAULT) {
  let names;
  try {
    names = await readdir(DIR);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -6);
    if (!safe(id)) continue;
    try {
      const [msgs, st] = await Promise.all([load(id), stat(file(id))]);
      if (!msgs.length) continue;
      const firstUser = msgs.find((m) => m.role === "user");
      rows.push({
        id,
        title: (firstUser?.content || msgs[0].content || "session").slice(
          0,
          64,
        ),
        timestamp: new Date(st.mtimeMs).toISOString(),
        cwd: msgs.find((m) => m.cwd)?.cwd || "",
      });
    } catch {
      /* skip files that cannot be read */
    }
  }
  rows.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return rows.slice(0, limit);
}
