// test/claude-background.test.mjs — background (Task sub-agent) follow-up rendering
//
// When a background agent completes, the SDK delivers the main agent's follow-up as
// a result carrying an origin (a task-notification). That body is not always streamed
// as text_delta first; when it isn't, it must still be rendered as a full assistant
// block rather than being swallowed by a truncated "update" notification.
import test from "node:test";
import assert from "node:assert/strict";
import {
  runReader,
  isForegroundResult,
  buildUserMessage,
} from "../agents/claude.mjs";

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

const bgChanged = (tasks) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks,
});

test("auto-continuation: enqueues a follow-up turn when background work finishes", async () => {
  const calls = [];
  const { conn } = fakeConn([
    bgChanged([{ description: "watch CI" }]), // 0 -> 1
    bgChanged([]), // 1 -> 0 : all background done
  ]);
  conn.pendingFg = []; // the foreground turn already resolved
  conn.enqueueFollowup = (text) => calls.push(text);
  await runReader(conn);

  assert.equal(calls.length, 1, "exactly one continuation turn is enqueued");
  assert.match(calls[0], /background|finished|results|結果/i);
});

test("auto-continuation: does not fire while a foreground turn is still active", async () => {
  const calls = [];
  const { conn } = fakeConn([bgChanged([{}]), bgChanged([])]);
  conn.pendingFg = [() => {}]; // a foreground turn is in flight
  conn.enqueueFollowup = (text) => calls.push(text);
  await runReader(conn);

  assert.equal(
    calls.length,
    0,
    "no auto-continuation while the user's turn runs",
  );
});

test("auto-continuation: honors the chained-followup cap", async () => {
  const calls = [];
  const { conn } = fakeConn([bgChanged([{}]), bgChanged([])]);
  conn.pendingFg = [];
  conn.session.bgFollowupChain = 99; // already past the cap
  conn.enqueueFollowup = (text) => calls.push(text);
  await runReader(conn);

  assert.equal(
    calls.length,
    0,
    "the cap stops runaway auto-continuation loops",
  );
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

// ---------------------------------------------------------------------------
// Foreground vs injected results are told apart by result.origin.kind, not by
// whether an origin is present. The SDK forwards the triggering user message's
// origin onto its result, and typed input must be stamped {kind:"human"}, so a
// foreground result normally DOES carry an origin.

test("isForegroundResult: our turns (human, or unattributed) are foreground", () => {
  assert.equal(isForegroundResult({ type: "result" }), true, "no origin");
  assert.equal(
    isForegroundResult({ type: "result", origin: { kind: "human" } }),
    true,
    "a typed turn stamped human",
  );
  assert.equal(
    isForegroundResult({ type: "result", origin: {} }),
    true,
    "an origin without a kind ties to foreground (never hang the bus)",
  );
});

test("isForegroundResult: every injected kind is not foreground", () => {
  for (const origin of [
    { kind: "task-notification" },
    { kind: "task-notification", subkind: "scheduled-trigger" },
    { kind: "peer", from: "other-session" },
    { kind: "channel", server: "some-server" },
    { kind: "some-kind-added-later" },
  ]) {
    assert.equal(
      isForegroundResult({ type: "result", origin }),
      false,
      `origin.kind=${origin.kind} must not resolve a pending turn`,
    );
  }
});

test("a foreground result stamped {kind:'human'} resolves the pending turn", async () => {
  // Regression: keying on the mere presence of origin would treat this as a
  // background update, never resolve pendingFg, and leave the WebUI stuck on
  // "Running..." forever.
  const { conn, events } = fakeConn([
    streamDelta("human answer"),
    {
      type: "result",
      subtype: "success",
      result: "human answer",
      origin: { kind: "human" },
    },
  ]);
  let resolved;
  conn.pendingFg.push((v) => (resolved = v));
  await runReader(conn);

  assert.equal(resolved, "human answer", "the foreground runTurn is resolved");
  assert.ok(
    events.some((e) => e.type === "result" && e.success === true),
    "a turn-ending result is emitted",
  );
});

test("a peer/channel result does not resolve the user's pending turn", async () => {
  for (const origin of [
    { kind: "peer", from: "other-session" },
    { kind: "channel", server: "some-server" },
  ]) {
    const { conn, events } = fakeConn([
      { type: "result", subtype: "success", result: "injected", origin },
    ]);
    let resolved;
    conn.pendingFg.push((v) => (resolved = v));
    await runReader(conn);

    // The reader's end releases leftovers with a CANCELLED sentinel, so the
    // turn must not have been resolved with the injected answer itself.
    assert.notEqual(resolved, "injected", `${origin.kind}: turn not answered`);
    assert.ok(
      !events.some((e) => e.type === "result"),
      `${origin.kind}: no turn-ending result`,
    );
  }
});

test("a turn after a completed background cycle is answered on the same query", async () => {
  // The query used to be marked stale here and recycled on the next turn (a
  // second child process on the same session). It must now stay in use: the
  // next foreground result arrives on this very reader and resolves the turn.
  const { conn } = fakeConn([
    bgChanged([{ description: "sub-agent" }]), // 0 -> 1
    bgChanged([]), // 1 -> 0 : background cycle complete
    {
      type: "result",
      subtype: "success",
      result: "after background",
      origin: { kind: "human" },
    },
  ]);
  let resolved;
  conn.pendingFg.push((v) => (resolved = v));
  await runReader(conn);

  assert.equal(resolved, "after background");
  assert.equal(
    conn.staleAfterBg,
    undefined,
    "the connection is not marked for recycling",
  );
});

test("buildUserMessage stamps typed input as human", () => {
  const m = buildUserMessage("hello");
  assert.deepEqual(m.origin, { kind: "human" });
  assert.equal(m.type, "user");
  assert.equal(m.message.content, "hello");
});

test("buildUserMessage leaves our own auto-continuation unattributed", () => {
  const m = buildUserMessage("continue", [], { human: false });
  assert.equal(
    "origin" in m,
    false,
    "a synthesized prompt must not pass isHuman() trust gates",
  );
});

test("buildUserMessage keeps the human origin when images are attached", () => {
  const m = buildUserMessage("look", ["data:image/png;base64,AAAA"]);
  assert.deepEqual(m.origin, { kind: "human" });
  assert.ok(Array.isArray(m.message.content), "content becomes a block array");
});
