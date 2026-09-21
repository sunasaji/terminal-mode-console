// Local LLM usage (the status line's Ctx% and actual token counts).
// Stands up an LM Studio-like mock, picks up the usage carried on the final streaming
// chunk, reads the context window from /api/v0/models, and checks that getUsage returns
// {context, tokens} correctly. A local backend has no 5h/1w windows, so those slots are
// repurposed to show used/max tokens.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

/** A mock identified as LM Studio that serves a context window and a streaming reply. */
async function mockLmStudio({ ctx = 4096, usage } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const sendJson = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      w({
        model: "chat-a",
        choices: [{ index: 0, delta: { content: "Hello" } }],
      });
      w({
        model: "chat-a",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      // The include_usage final chunk: choices is empty and only usage is present.
      w({ model: "chat-a", choices: [], usage });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    // owned_by=organization_owner is what identifies this as LM Studio.
    if (url.pathname === "/v1/models")
      return sendJson(200, {
        object: "list",
        data: [
          { id: "chat-a", object: "model", owned_by: "organization_owner" },
        ],
      });
    if (url.pathname === "/api/v1/models")
      return sendJson(200, {
        models: [
          {
            key: "chat-a",
            type: "llm",
            display_name: "Chat A",
            loaded_instances: [{ id: "chat-a" }],
          },
        ],
      });
    // The context window is read from loaded_context_length here (v0).
    if (url.pathname === "/api/v0/models")
      return sendJson(200, {
        data: [
          {
            id: "chat-a",
            type: "llm",
            state: "loaded",
            loaded_context_length: ctx,
            max_context_length: 8192,
          },
        ],
      });
    sendJson(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}

test("getUsage reports Ctx% and used/max tokens from a streamed usage chunk", async () => {
  const srv = await mockLmStudio({
    ctx: 4096,
    usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
  });
  process.env.LLM_BASE_URL = srv.base;
  process.env.LLM_PERSIST = "0";
  process.env.LLM_TOOLS = "0";
  delete process.env.LLM_MODEL;
  delete process.env.LLM_CONTEXT;
  delete process.env.LLM_NUM_CTX;
  try {
    const agent = (
      await import(`../agents/local-llm.mjs?case=usage-${Date.now()}`)
    ).default;
    const session = { id: "s1", cwd: "", history: [] };
    const events = [];
    await agent.runTurn({
      text: "hi",
      images: [],
      emit: (e) => events.push(e),
      session,
      ask: async () => {},
      model: "",
    });

    // The result event carries the actual token counts (they used to be hard-coded 0).
    const result = events.find((e) => e.type === "result");
    assert.equal(result.inputTokens, 1000);
    assert.equal(result.outputTokens, 200);

    const u = await agent.getUsage(session);
    assert.equal(u.available, true);
    assert.equal(u.tokens.used, 1200); // total_tokens = the last turn's context occupancy
    assert.equal(u.tokens.max, 4096); // loaded_context_length from /api/v0/models
    assert.equal(Math.round(u.context.utilization), 29); // 1200 / 4096
  } finally {
    srv.close();
  }
});

test("LLM_CONTEXT overrides the probed context window", async () => {
  const srv = await mockLmStudio({
    ctx: 4096, // probe value; the override should win, so this must go unused
    usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
  });
  process.env.LLM_BASE_URL = srv.base;
  process.env.LLM_PERSIST = "0";
  process.env.LLM_TOOLS = "0";
  process.env.LLM_CONTEXT = "2000";
  delete process.env.LLM_MODEL;
  delete process.env.LLM_NUM_CTX;
  try {
    const agent = (
      await import(`../agents/local-llm.mjs?case=ctxenv-${Date.now()}`)
    ).default;
    const session = { id: "s2", cwd: "", history: [] };
    await agent.runTurn({
      text: "hi",
      images: [],
      emit: () => {},
      session,
      ask: async () => {},
      model: "",
    });
    const u = await agent.getUsage(session);
    assert.equal(u.tokens.max, 2000); // the env override takes effect
    assert.equal(u.tokens.used, 600);
    assert.equal(Math.round(u.context.utilization), 30); // 600 / 2000
  } finally {
    srv.close();
    delete process.env.LLM_CONTEXT;
  }
});
