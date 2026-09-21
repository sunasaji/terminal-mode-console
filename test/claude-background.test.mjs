// test/claude-background.test.mjs — background (Task sub-agent) follow-up rendering
//
// When a background agent completes, the SDK delivers the main agent's follow-up as
// a result carrying an origin (a task-notification). That body is not always streamed
// as text_delta first; when it isn't, it must still be rendered as a full assistant
// block rather than being swallowed by a truncated "update" notification.
import test from "node:test";
import assert from "node:assert/strict";
import { runReader } from "../agents/claude.mjs";

// Minimal fake connection matching what runReader touches.
function fakeConn(messages) {
  const events = [];
  async function* q() {
    for (const m of messages) yield m;
  }
  const conn = {
    session: { id: `bg-${Math.random()}`, history: [] },
    emit: (e) => events.push(e),
    q: q(),
    st: { tools: new Map() },
    acc: "",
    pendingFg: [],
    bgCount: 0,
    ambientState: "background",
    input: { close() {} },
  };
  return { conn, events };
}

const streamDelta = (text) => ({
  type: "stream_event",
  event: {
    type: "content_block_delta",
    delta: { type: "text_delta", text },
  },
});

test("a non-streamed background sub-turn renders the full follow-up as an assistant block", async () => {
  const body = "Here is the combined result from all sub-agents. ".repeat(6);
  const { conn, events } = fakeConn([
    // No stream_event deltas precede it: the SDK gave only the final result.
    {
      type: "result",
      subtype: "success",
      result: body,
      origin: { kind: "task-notification" },
    },
  ]);
  await runReader(conn);

  const delta = events.find((e) => e.type === "text_delta");
  assert.ok(delta, "the follow-up body is emitted as a text_delta");
  assert.equal(delta.text, body, "the full body is delivered, untruncated");
  assert.ok(
    events.some((e) => e.type === "status" && e.state === "text_start"),
    "an assistant block is opened",
  );
  assert.ok(
    events.some((e) => e.type === "status" && e.state === "text_end"),
    "the assistant block is finalized",
  );
  // The notification must not double up as the body carrier (title is localized,
  // so assert on structure/content, not on the title text).
  const note = events.find((e) => e.type === "notification");
  assert.ok(note, "a background-update marker is shown");
  assert.ok(
    !note.message.includes("combined result"),
    "the body is not duplicated into the notification",
  );
});

test("a streamed background sub-turn is not re-rendered (no double body)", async () => {
  const body = "streamed follow-up body";
  const { conn, events } = fakeConn([
    streamDelta(body),
    {
      type: "result",
      subtype: "success",
      result: body,
      origin: { kind: "task-notification" },
    },
  ]);
  await runReader(conn);

  const deltas = events.filter((e) => e.type === "text_delta");
  assert.equal(deltas.length, 1, "the body streams exactly once, not twice");
  assert.equal(deltas[0].text, body);
  // Here the body was on screen already, so the notification summarizes it (the
  // message is the answer text itself, which is locale-independent).
  const note = events.find(
    (e) =>
      e.type === "notification" &&
      (e.message ?? "").includes("streamed follow-up"),
  );
  assert.ok(note, "the streamed body is summarized in the update notification");
});

test("a foreground result (no origin) still emits a turn-ending result", async () => {
  const { conn, events } = fakeConn([
    streamDelta("foreground answer"),
    { type: "result", subtype: "success", result: "foreground answer" },
  ]);
  // A foreground turn resolves a pending runTurn; provide one so it can settle.
  let resolved;
  conn.pendingFg.push((v) => (resolved = v));
  await runReader(conn);

  assert.ok(
    events.some((e) => e.type === "result" && e.success === true),
    "a foreground turn emits a real result event",
  );
  assert.equal(
    resolved,
    "foreground answer",
    "the foreground runTurn is resolved",
  );
});
