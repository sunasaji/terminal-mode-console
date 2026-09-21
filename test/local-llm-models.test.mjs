// Identifying a local LLM backend, and listing its models.
// Stands up a mock server that answers differently per implementation, and checks that
// identification works from the responses rather than the port number, and that the list
// is fetched correctly for each implementation.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

/** Start a mock server with the given handler and return its base URL (including /v1). */
async function mockServer(handler) {
  const server = createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, "http://x");
    if (!handler(url.pathname, send)) send(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}

/** Reload local-llm against a new BASE and return describe() once warm-up has finished.
 *  describe() returns the cache synchronously, so wait for a sign that identification is
 *  done. An empty list is the correct answer in one case (llama.cpp single-model), so the
 *  contents of models cannot be the sole wait condition. */
const DETECTED = new Set(["LM Studio", "Ollama", "llama.cpp"]);
async function describeWith(base, tag) {
  process.env.LLM_BASE_URL = base;
  process.env.LLM_PERSIST = "0";
  const mod = await import(`../agents/local-llm.mjs?case=${tag}-${Date.now()}`);
  for (let i = 0; i < 100; i++) {
    const d = mod.default.describe();
    if (d.models.length || DETECTED.has(d.label)) return d;
    await new Promise((r) => setTimeout(r, 20));
  }
  return mod.default.describe();
}

test("LM Studio is detected from its response and embedding models are excluded", async () => {
  // Served on a port other than the usual 1234, which also proves a port guess cannot work.
  const srv = await mockServer((path, send) => {
    if (path === "/v1/models")
      return (
        send(200, {
          object: "list",
          data: [
            { id: "chat-a", object: "model", owned_by: "organization_owner" },
            { id: "embed-a", object: "model", owned_by: "organization_owner" },
          ],
        }),
        true
      );
    if (path === "/api/v1/models")
      return (
        send(200, {
          models: [
            {
              key: "chat-a",
              type: "llm",
              display_name: "Chat A",
              loaded_instances: [{ id: "chat-a" }],
            },
            {
              key: "embed-a",
              type: "embedding",
              display_name: "Embed A",
              loaded_instances: [],
            },
            {
              key: "chat-b",
              type: "llm",
              display_name: "Chat B",
              loaded_instances: [],
            },
          ],
        }),
        true
      );
    return false;
  });
  try {
    const d = await describeWith(srv.base, "lmstudio");
    assert.equal(d.label, "LM Studio");
    // Drop embeddings. They are excluded because /v1/models alone cannot tell them apart.
    assert.deepEqual(
      d.models.map((m) => m.value),
      ["chat-a", "chat-b"],
    );
    assert.equal(d.models[0].label, "Chat A");
    // Only loaded models are flagged (the value is an i18n key).
    assert.equal(d.models[0].noteKey, "model.note.loaded");
    assert.equal(d.models[1].noteKey, undefined);
  } finally {
    srv.close();
  }
});

test("Ollama is detected via /api/version and loaded models are marked", async () => {
  const srv = await mockServer((path, send) => {
    // owned_by "library" is not conclusive, so /api/version is needed to confirm.
    if (path === "/v1/models")
      return (
        send(200, {
          object: "list",
          data: [
            {
              id: "llama3:latest",
              object: "model",
              created: 1,
              owned_by: "library",
            },
          ],
        }),
        true
      );
    if (path === "/api/version") return (send(200, { version: "0.5.1" }), true);
    if (path === "/api/tags")
      return (
        send(200, {
          models: [
            { name: "llama3:latest", model: "llama3:latest" },
            { name: "qwen:7b", model: "qwen:7b" },
          ],
        }),
        true
      );
    if (path === "/api/ps")
      return (send(200, { models: [{ model: "qwen:7b" }] }), true);
    return false;
  });
  try {
    const d = await describeWith(srv.base, "ollama");
    assert.equal(d.label, "Ollama");
    assert.deepEqual(
      d.models.map((m) => m.value),
      ["llama3:latest", "qwen:7b"],
    );
    assert.equal(d.models[0].noteKey, undefined); // pulled, but not loaded
    assert.equal(d.models[1].noteKey, "model.note.loaded"); // present in /api/ps
  } finally {
    srv.close();
  }
});

test("llama.cpp in router mode lists every model", async () => {
  const srv = await mockServer((path, send) => {
    if (path === "/v1/models")
      return (
        send(
          200,
          {
            object: "list",
            data: [
              { id: "a.gguf", status: { value: "loaded" } },
              { id: "b.gguf", status: { value: "unloaded" } },
            ],
          },
          { Server: "llama.cpp" },
        ),
        true
      );
    if (path === "/props") return (send(200, { role: "router" }), true);
    return false;
  });
  try {
    const d = await describeWith(srv.base, "router");
    assert.equal(d.label, "llama.cpp");
    assert.deepEqual(
      d.models.map((m) => m.value),
      ["a.gguf", "b.gguf"],
    );
    assert.equal(d.models[0].noteKey, "model.note.loaded");
  } finally {
    srv.close();
  }
});

test("llama.cpp in single-model mode offers no choices, so no picker is shown", async () => {
  const srv = await mockServer((path, send) => {
    if (path === "/v1/models")
      return (
        send(
          200,
          { object: "list", data: [{ id: "only.gguf", owned_by: "llamacpp" }] },
          { Server: "llama.cpp" },
        ),
        true
      );
    // No role = single-model mode. Fixed at startup, with no way to switch.
    if (path === "/props")
      return (send(200, { model_path: "/models/only.gguf" }), true);
    return false;
  });
  try {
    const d = await describeWith(srv.base, "single");
    assert.equal(d.label, "llama.cpp");
    assert.deepEqual(d.models, []);
  } finally {
    srv.close();
  }
});

/** A mock that answers like LM Studio. `loaded` marks which models count as loaded. */
function lmStudioMock(models) {
  return (path, send) => {
    if (path === "/v1/models")
      return (
        send(200, {
          object: "list",
          data: models.map((m) => ({
            id: m.key,
            object: "model",
            owned_by: "organization_owner",
          })),
        }),
        true
      );
    if (path === "/api/v1/models")
      return (
        send(200, {
          models: models.map((m) => ({
            key: m.key,
            type: "llm",
            display_name: m.label,
            loaded_instances: m.loaded ? [{ id: m.key }] : [],
          })),
        }),
        true
      );
    return false;
  };
}

test("with no model configured, auto picks the loaded one", async () => {
  // The "agents-a1-4b" default is not guaranteed to exist on the backend — LM Studio's
  // real ID here is internscience_agents-a1-4b, and sending the default yields
  // model_not_found. Picking from the list avoids that mismatch.
  const srv = await mockServer(
    lmStudioMock([
      { key: "cold-one", label: "Cold One" },
      { key: "hot-one", label: "Hot One", loaded: true },
    ]),
  );
  try {
    delete process.env.LLM_MODEL;
    const d = await describeWith(srv.base, "auto-loaded");
    assert.equal(d.autoModel, "Hot One"); // the loaded one, not the unloaded one
  } finally {
    srv.close();
  }
});

test("with nothing loaded, auto falls back to the first model", async () => {
  const srv = await mockServer(
    lmStudioMock([
      { key: "first", label: "First" },
      { key: "second", label: "Second" },
    ]),
  );
  try {
    delete process.env.LLM_MODEL;
    const d = await describeWith(srv.base, "auto-first");
    assert.equal(d.autoModel, "First");
  } finally {
    srv.close();
  }
});

test("an explicit LLM_MODEL wins over the auto pick", async () => {
  const srv = await mockServer(
    lmStudioMock([
      { key: "cold-one", label: "Cold One" },
      { key: "hot-one", label: "Hot One", loaded: true },
    ]),
  );
  try {
    // An explicit operator setting is honoured regardless of what happens to be loaded.
    process.env.LLM_MODEL = "cold-one";
    const d = await describeWith(srv.base, "auto-env");
    assert.equal(d.autoModel, "Cold One");
  } finally {
    srv.close();
    delete process.env.LLM_MODEL;
  }
});

test("an unreachable backend is reported as such, not as a plausible-looking guess", async () => {
  // Points at a port nobody listens on, so identification and listing both fail.
  process.env.LLM_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.LLM_PERSIST = "0";
  const mod = await import(`../agents/local-llm.mjs?case=down-${Date.now()}`);
  for (let i = 0; i < 100 && mod.default.describe().reachable === null; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const d = mod.default.describe();
  // Returning true here would pair the port-guessed label with the env default model and
  // look like a working configuration while nothing is connected — which really happened.
  assert.equal(d.reachable, false);
  assert.deepEqual(d.models, []);
});

test("a reachable backend is not flagged as unreachable", async () => {
  const srv = await mockServer((path, send) => {
    if (path === "/v1/models")
      return (
        send(200, {
          object: "list",
          data: [{ id: "some-model", object: "model" }],
        }),
        true
      );
    return false;
  });
  try {
    const d = await describeWith(srv.base, "up");
    assert.equal(d.reachable, true);
  } finally {
    srv.close();
  }
});

test("a backend that answers but rejects the request still counts as reachable", async () => {
  // An authenticated LM Studio answers 401. It was reached, so it is not "cannot connect".
  const srv = await mockServer((_path, send) => {
    send(401, { error: "unauthorized" });
    return true;
  });
  try {
    process.env.LLM_BASE_URL = srv.base;
    process.env.LLM_PERSIST = "0";
    const mod = await import(`../agents/local-llm.mjs?case=401-${Date.now()}`);
    for (let i = 0; i < 100 && mod.default.describe().reachable === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(mod.default.describe().reachable, true);
  } finally {
    srv.close();
  }
});

test("an unknown OpenAI-compatible server still lists models from /v1/models", async () => {
  const srv = await mockServer((path, send) => {
    if (path === "/v1/models")
      return (
        send(200, {
          object: "list",
          data: [{ id: "some-model", object: "model" }],
        }),
        true
      );
    return false; // every implementation-specific endpoint 404s
  });
  try {
    const d = await describeWith(srv.base, "openai");
    assert.deepEqual(
      d.models.map((m) => m.value),
      ["some-model"],
    );
  } finally {
    srv.close();
  }
});
