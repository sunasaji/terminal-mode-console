import test from "node:test";
import assert from "node:assert/strict";
import {
  activityKindOf,
  addClient,
  enqueue,
  getSession,
  livenessSnapshot,
  resolvePermission,
  resolveQuestion,
} from "../bus.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = (name) => `${name}-${Date.now()}-${Math.random()}`;
const sink = () => {
  const frames = [];
  return {
    frames,
    write(frame) {
      frames.push(frame);
    },
  };
};

test("transport and warning events are not agent activity", () => {
  assert.equal(activityKindOf({ type: "heartbeat" }), null);
  assert.equal(activityKindOf({ type: "notification", key: "stall" }), null);
  assert.equal(activityKindOf({ type: "status", state: "background" }), null);
  assert.equal(activityKindOf({ type: "text_delta", text: "x" }), "text_delta");
});
async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(2);
  }
  assert.fail(message);
}

test("foreground liveness starts, advances only for meaningful events, then clears", async () => {
  const id = unique("liveness");
  let releaseStart, releaseFinish;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const finishGate = new Promise((resolve) => {
    releaseFinish = resolve;
  });
  const agent = {
    async runTurn({ emit }) {
      await startGate;
      emit({ type: "notification", title: "note", message: "not activity" });
      await delay(3);
      emit({ type: "status", state: "think_start" });
      await finishGate;
      emit({ type: "tool_end", name: "read" });
      emit({ type: "result", success: true, text: "done" });
    },
  };
  enqueue(id, { text: "go", agent, stallWarnMs: 0 });
  await until(() => getSession(id).state === "busy", "turn did not start");
  const started = livenessSnapshot(getSession(id));
  assert.equal(typeof started.startedAt, "number");
  assert.equal(started.lastActivityAt, started.startedAt);
  assert.equal(started.activityKind, "turn_start");

  await delay(3);
  releaseStart();
  await until(
    () => getSession(id).activityKind === "think_start",
    "activity did not advance",
  );
  const advanced = livenessSnapshot(getSession(id));
  assert.ok(advanced.lastActivityAt > started.lastActivityAt);
  assert.equal(advanced.activityKind, "think_start");
  releaseFinish();
  await until(() => getSession(id).state === "idle", "turn did not finish");
  const done = livenessSnapshot(getSession(id));
  assert.equal(done.startedAt, null);
  assert.equal(done.lastActivityAt, null);
  assert.equal(done.activityKind, null);
});

test("warning notifications do not become activity and are emitted once per quiet period", async () => {
  const id = unique("warning");
  const out = sink();
  addClient(id, out, "web");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  enqueue(id, {
    text: "go",
    stallWarnMs: 12,
    agent: {
      async runTurn() {
        await gate;
      },
    },
  });
  await until(() => getSession(id).state === "busy", "turn did not start");
  const at = getSession(id).lastActivityAt;
  await delay(40);
  const warnings = out.frames.filter((f) => f.includes('"key":"stall"'));
  assert.equal(warnings.length, 1);
  assert.equal(getSession(id).lastActivityAt, at);
  release();
  await until(() => getSession(id).state === "idle", "turn did not finish");
});

test("answer waiting suppresses quiet warnings", async () => {
  const id = unique("waiting");
  const out = sink();
  addClient(id, out, "web");
  enqueue(id, {
    text: "ask",
    stallWarnMs: 10,
    agent: {
      async runTurn({ ask }) {
        await ask.question({
          questions: [
            { question: "Continue?", header: "Confirm", options: [] },
          ],
        });
      },
    },
  });
  await until(
    () => Boolean(getSession(id).waiting),
    "question did not enter waiting state",
  );
  await delay(35);
  assert.equal(
    out.frames.some((f) => f.includes('"key":"stall"')),
    false,
  );
  resolveQuestion(id, JSON.stringify({ "Continue?": "yes" }));
  await until(() => getSession(id).state === "idle", "turn did not finish");
});

test("permission waiting suppresses quiet warnings", async () => {
  const id = unique("permission");
  const out = sink();
  addClient(id, out, "web");
  enqueue(id, {
    text: "ask",
    stallWarnMs: 10,
    agent: {
      async runTurn({ ask }) {
        await ask.permission({ toolName: "Bash", description: "test" });
      },
    },
  });
  await until(
    () => getSession(id).waiting?.kind === "permission",
    "permission did not enter waiting state",
  );
  await delay(35);
  assert.equal(
    out.frames.some((f) => f.includes('"key":"stall"')),
    false,
  );
  resolvePermission(id, "deny");
  await until(() => getSession(id).state === "idle", "turn did not finish");
});

test("zero warning threshold disables warning notification", async () => {
  const id = unique("disabled");
  const out = sink();
  addClient(id, out, "web");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  enqueue(id, {
    text: "go",
    stallWarnMs: 0,
    agent: {
      async runTurn() {
        await gate;
      },
    },
  });
  await until(() => getSession(id).state === "busy", "turn did not start");
  await delay(30);
  assert.equal(
    out.frames.some((f) => f.includes('"key":"stall"')),
    false,
  );
  release();
  await until(() => getSession(id).state === "idle", "turn did not finish");
});
