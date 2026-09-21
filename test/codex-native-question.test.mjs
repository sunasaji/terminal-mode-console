import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CODEX_APP_SERVER_ARGS } from "../agents/codex-app-server.mjs";
import {
  CODEX_DEVELOPER_INSTRUCTIONS,
  codexEffortForModel,
  codexFailureMessage,
  codexResponseModel,
  codexThreadResumeParams,
  codexThreadStartParams,
  codexTurnStartParams,
  handleRequest,
  normalizeCodexModels,
} from "../agents/codex.mjs";

test("private app-server enables native questions in Default mode", () => {
  assert.deepEqual(DEFAULT_CODEX_APP_SERVER_ARGS, [
    "app-server",
    "--enable",
    "default_mode_request_user_input",
  ]);
});

test("native requestUserInput becomes a UI question and returns the standard RPC answer", async () => {
  const calls = [];
  const rpc = {
    respond: (id, result) => calls.push({ id, result }),
    reject: () => assert.fail("unexpected reject"),
  };
  const ask = {
    question: async (dialog) => {
      assert.deepEqual(dialog, {
        toolUseId: "17",
        questions: [
          {
            header: "Choice",
            question: "CかDか？",
            options: [
              { label: "C", description: "Cを選ぶ" },
              { label: "D", description: "Dを選ぶ" },
            ],
          },
        ],
      });
      return { "CかDか？": ["D"] };
    },
  };
  await handleRequest(
    rpc,
    {
      id: 17,
      method: "item/tool/requestUserInput",
      params: {
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "CかDか？",
            options: [
              { label: "C", description: "Cを選ぶ" },
              { label: "D", description: "Dを選ぶ" },
            ],
          },
        ],
      },
    },
    ask,
  );
  assert.deepEqual(calls, [
    { id: 17, result: { answers: { choice: { answers: ["D"] } } } },
  ]);
});

test("start and resume use developer instructions without dynamic tools", () => {
  assert.match(CODEX_DEVELOPER_INSTRUCTIONS, /use request_user_input/);
  const start = codexThreadStartParams("/repo");
  const resume = codexThreadResumeParams("t1");
  assert.equal(start.developerInstructions, CODEX_DEVELOPER_INSTRUCTIONS);
  assert.equal(Object.hasOwn(start, "model"), false);
  assert.deepEqual(resume, {
    threadId: "t1",
    developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
  });
  assert.equal(Object.hasOwn(start, "dynamicTools"), false);
  assert.equal(Object.hasOwn(resume, "dynamicTools"), false);
});

test("Codex model list becomes language-independent WebUI choices", () => {
  const { models, details } = normalizeCodexModels([
    {
      id: "m1",
      model: "gpt-current",
      displayName: "GPT Current",
      hidden: false,
    },
    { id: "hidden", displayName: "Hidden", hidden: true },
  ]);
  assert.deepEqual(models, [{ value: "gpt-current", label: "GPT Current" }]);
  assert.equal(details.get("gpt-current").id, "m1");
});

test("catalog ids can name models without becoming turn result models", () => {
  const { models } = normalizeCodexModels([
    { id: "catalog-model", displayName: "Catalog Model" },
  ]);
  assert.deepEqual(models, [
    { value: "catalog-model", label: "Catalog Model" },
  ]);
  // App Server thread/turn objects also have UUID-shaped `id` fields. The adapter
  // must report the requested model instead of treating those entity ids as models.
  const params = codexTurnStartParams(
    "turn-uuid",
    [],
    "catalog-model",
    new Map(),
  );
  assert.equal(params.model, "catalog-model");
  assert.equal(codexResponseModel({ id: "turn-uuid" }), "");
  assert.equal(
    codexResponseModel({ id: "turn-uuid", model: "catalog-model" }),
    "catalog-model",
  );
});

test("turn model is only present when explicitly resolved", () => {
  const input = [{ type: "text", text: "hello" }];
  assert.deepEqual(
    codexTurnStartParams("t1", input, "gpt-current", new Map()),
    {
      threadId: "t1",
      input,
      model: "gpt-current",
    },
  );
  const automatic = codexTurnStartParams("t1", input, undefined, new Map());
  if (!process.env.CODEX_MODEL)
    assert.equal(Object.hasOwn(automatic, "model"), false);
});

test("unsupported reasoning effort falls back to the selected model default", () => {
  const details = new Map([
    [
      "luna",
      {
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
        ],
      },
    ],
  ]);
  assert.equal(codexEffortForModel("medium", "luna", details), "medium");
  assert.equal(codexEffortForModel("ultra", "luna", details), undefined);
});

test("terminal Codex failures retain the user-facing App Server reason", () => {
  assert.equal(
    codexFailureMessage({ message: "You've hit your usage limit" }),
    "You've hit your usage limit",
  );
  assert.equal(
    codexFailureMessage({
      error: { message: "Usage limit reached. Try again later." },
    }),
    "Usage limit reached. Try again later.",
  );
  assert.equal(
    codexFailureMessage({ status: "failed" }),
    "Codex turn failed without an error message.",
  );
});
