// test/server-http.test.mjs — HTTP transport layer (server.mjs)
//
// server.mjs starts listening on import, so it is exercised as a spawned
// process over real HTTP. Focus is the security-sensitive surface:
//   - token authentication (Bearer header and ?token= query)
//   - /api/fs/dirs directory listing (reachable only with the token)
//   - /api/prompt input validation and the image-size cap
// These paths all return before any agent turn is enqueued, so no backend
// (Claude/Codex/local) is invoked.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.mjs");
const TOKEN = "test-token-123";
const MAX_IMG = 10; // small cap so the 413 path is easy to trigger

let child;
let base;

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function waitReady(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Static manifest is served before the auth gate -> good readiness probe.
      const r = await fetch(url + "/manifest.webmanifest");
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become ready in time");
}

function api(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      TMCON_TOKEN: TOKEN,
      PORT: String(port),
      HOST: "127.0.0.1",
      LOG_REQUESTS: "0",
      MAX_PROMPT_IMAGE_CHARS: String(MAX_IMG),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitReady(base);
});

after(() => {
  child?.kill("SIGKILL");
});

test("static WebUI shell is served without a token", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
});

test("auth: API rejects missing and wrong tokens", async () => {
  assert.equal((await api("/api/info")).status, 401);
  assert.equal((await api("/api/info", { token: "nope" })).status, 401);
});

test("auth: API accepts the token via Bearer header and ?token= query", async () => {
  const bearer = await api("/api/info", { token: TOKEN });
  assert.equal(bearer.status, 200);
  assert.ok((await bearer.json()).provider);

  const query = await fetch(`${base}/api/info?token=${TOKEN}`);
  assert.equal(query.status, 200);
});

test("/api/fs/dirs is unreachable without the token", async () => {
  // The directory-listing endpoint can walk arbitrary absolute paths, so its
  // only protection is the token gate.
  assert.equal((await api("/api/fs/dirs?path=/")).status, 401);
});

test("/api/fs/dirs lists subdirectories, skipping files and dotdirs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmcon-fsdirs-"));
  await mkdir(join(dir, "alpha"));
  await mkdir(join(dir, "beta"));
  await mkdir(join(dir, ".hidden"));
  await writeFile(join(dir, "file.txt"), "x");

  const r = await api(`/api/fs/dirs?path=${encodeURIComponent(dir + "/")}`, {
    token: TOKEN,
  });
  assert.equal(r.status, 200);
  const { base: outBase, dirs } = await r.json();
  assert.equal(outBase, resolve(dir));
  assert.ok(dirs.includes(join(dir, "alpha") + "/"));
  assert.ok(dirs.includes(join(dir, "beta") + "/"));
  assert.ok(!dirs.includes(join(dir, ".hidden") + "/")); // dotdir hidden
  assert.ok(!dirs.some((d) => d.includes("file.txt"))); // files excluded
});

test("/api/fs/dirs filters by prefix and reveals dotdirs when asked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmcon-fsdirs-"));
  await mkdir(join(dir, "alpha"));
  await mkdir(join(dir, "beta"));
  await mkdir(join(dir, ".hidden"));

  const pref = await api(
    `/api/fs/dirs?path=${encodeURIComponent(join(dir, "al"))}`,
    { token: TOKEN },
  );
  const { dirs: prefixed } = await pref.json();
  assert.deepEqual(prefixed, [join(dir, "alpha") + "/"]);

  // Build the "<dir>/." string literally; path.join() would collapse the dot.
  const dot = await api(`/api/fs/dirs?path=${encodeURIComponent(dir + "/.")}`, {
    token: TOKEN,
  });
  const { dirs: dots } = await dot.json();
  assert.deepEqual(dots, [join(dir, ".hidden") + "/"]);
});

test("/api/fs/dirs expands ~ to the home directory", async () => {
  const r = await api(`/api/fs/dirs?path=${encodeURIComponent("~/")}`, {
    token: TOKEN,
  });
  const { base: outBase } = await r.json();
  assert.equal(outBase, resolve(homedir()));
});

test("/api/prompt validates types and rejects oversized images", async () => {
  // wrong 'text' type
  assert.equal(
    (
      await api("/api/prompt", {
        method: "POST",
        token: TOKEN,
        body: { text: 5 },
      })
    ).status,
    400,
  );
  // 'images' must be an array of strings
  assert.equal(
    (
      await api("/api/prompt", {
        method: "POST",
        token: TOKEN,
        body: { images: [123] },
      })
    ).status,
    400,
  );
  // nothing to send
  assert.equal(
    (
      await api("/api/prompt", {
        method: "POST",
        token: TOKEN,
        body: { text: "" },
      })
    ).status,
    400,
  );
  // over the image-size cap (11 chars > MAX_IMG=10) -> 413
  assert.equal(
    (
      await api("/api/prompt", {
        method: "POST",
        token: TOKEN,
        body: { images: ["a".repeat(MAX_IMG + 1)] },
      })
    ).status,
    413,
  );
});

// ── SSE reconnect handshake (stream_meta / resync) ───────────────────────────
// Open an SSE connection, collect whatever frames arrive in a short window, then
// abort. The server writes the stream_meta handshake immediately on connect, so a
// brief read is enough to observe it. A dedicated User-Agent selects the client
// "kind" (Mozilla -> web, Dart -> the glasses app).
async function sseProbe(query, ua = "Mozilla/5.0") {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 700);
  let buf = "";
  try {
    const r = await fetch(`${base}/api/events?token=${TOKEN}&${query}`, {
      headers: { "user-agent": ua },
      signal: ac.signal,
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buf += dec.decode(value, { stream: true });
    }
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  } finally {
    clearTimeout(timer);
  }
  return buf;
}

test("SSE: a web reconnect with a stale/ahead lastEventId is told to resync", async () => {
  // lastEventId far ahead of a fresh session (nextId=1) mimics reconnecting to a
  // restarted server, plus an epoch that cannot match the new instance. Incremental
  // catch-up would silently drop every new event, so the server must ask for a resync.
  const buf = await sseProbe(
    `sessionId=resync-${Date.now()}&lastEventId=999&epoch=dead-instance`,
  );
  assert.match(buf, /"type":"stream_meta"/);
  assert.match(buf, /"resync":true/);
});

test("SSE: a fresh web connect (no lastEventId) is not asked to resync", async () => {
  const buf = await sseProbe(`sessionId=fresh-${Date.now()}`);
  assert.match(buf, /"type":"stream_meta"/);
  assert.match(buf, /"resync":false/);
});

test("SSE: non-web clients get no stream_meta handshake", async () => {
  // The glasses app (Dart) must see the unchanged protocol — no extra control frame,
  // even on a reconnect that would trigger a resync for the WebUI.
  const buf = await sseProbe(
    `sessionId=dart-${Date.now()}&lastEventId=999&epoch=dead-instance`,
    "Dart/3.0 (dart:io)",
  );
  assert.doesNotMatch(buf, /stream_meta/);
});
