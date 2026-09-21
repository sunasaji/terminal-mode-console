import test from "node:test";
import assert from "node:assert/strict";
import { addClient, makeAsk, resolveQuestion } from "../bus.mjs";

function responseSink() {
  const frames = [];
  return {
    frames,
    write(frame) {
      frames.push(frame);
    },
  };
}

test("an unanswered question is re-presented on every reconnect", async () => {
  const sessionId = `reconnect-${Date.now()}-${Math.random()}`;
  const questions = [{ question: "Continue?", header: "Confirm", options: [] }];
  const answer = makeAsk(sessionId).question({ questions });
  await Promise.resolve();

  const first = responseSink();
  addClient(sessionId, first, "web");
  const second = responseSink();
  // A reconnect that already performed an event replay must still receive the
  // current unanswered request as a state snapshot.
  addClient(sessionId, second, "web");

  for (const sink of [first, second]) {
    const body = sink.frames.join("");
    assert.match(body, /"state":"waiting"/);
    assert.match(body, /"type":"user_question"/);
    assert.match(body, /"requestId":"wait-\d+"/);
  }

  const firstId = first.frames.join("").match(/"requestId":"([^"]+)"/)[1];
  const secondId = second.frames.join("").match(/"requestId":"([^"]+)"/)[1];
  assert.equal(secondId, firstId, "re-presentations identify the same request");

  resolveQuestion(sessionId, JSON.stringify({ "Continue?": "yes" }));
  assert.deepEqual(await answer, { "Continue?": "yes" });
});
