"use strict";

/**
 * The browser side of the stream. It has no DOM dependency — fetch, TextDecoder and
 * timers are all it touches — so it runs here with a scripted stream standing in for
 * the server. The timeouts are injected: the real ones are 20 s and 45 s.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const loadApi = () => import("../public/js/api.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fetch that answers with an SSE stream driven by `script({ write, close })`.
 * Aborting the request errors the stream exactly as the browser would.
 */
function streamingFetch(script) {
  return async (url, options) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        let closed = false;
        const write = (text) => {
          if (!closed) controller.enqueue(encoder.encode(text));
        };
        const close = () => {
          if (closed) return;
          closed = true;
          controller.close();
        };
        options.signal?.addEventListener("abort", () => {
          if (closed) return;
          closed = true;
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          controller.error(err);
        });
        script({ write, close });
      }
    });
    return { ok: true, body };
  };
}

const graphEvent = (labels) =>
  `event: graph\ndata: ${JSON.stringify({
    nodes: labels.map((label, i) => ({ id: `n${i}`, label, type: "theme" })),
    edges: []
  })}\n\n`;

function collect() {
  const calls = { status: [], graphs: [], done: null, error: null, meta: null };
  return {
    calls,
    handlers: {
      onStatus: (m) => calls.status.push(m),
      onGraph: (g) => calls.graphs.push(g),
      onDone: (result) => {
        calls.done = result;
      },
      onError: (message, meta) => {
        calls.error = message;
        calls.meta = meta;
      }
    }
  };
}

test.afterEach(() => {
  delete globalThis.fetch;
});

test("heartbeats carry a run past the idle timeout", async () => {
  const { generateMindMap } = await loadApi();
  globalThis.fetch = streamingFetch(async ({ write, close }) => {
    write("event: status\ndata: {\"message\":\"Processing 3 chunk(s)...\"}\n\n");
    write(graphEvent(["EIR Problems"]));
    // Five quiet stretches, each shorter than the idle timeout but far longer than
    // it in total: exactly the shape of a real seven-chunk run.
    for (let i = 0; i < 5; i += 1) {
      await sleep(30);
      write(`: ping ${i}\n\n`);
    }
    write(graphEvent(["EIR Problems", "Handover Data"]));
    write("event: done\ndata: {\"warnings\":[],\"chunks\":2}\n\n");
    close();
  });

  const { calls, handlers } = collect();
  await generateMindMap("transcript", handlers, { connectTimeoutMs: 100, idleTimeoutMs: 80 });

  assert.equal(calls.error, null, `unexpected error: ${calls.error}`);
  assert.deepEqual(calls.done, { warnings: [], chunks: 2 });
  assert.equal(calls.graphs.length, 2);
  // A heartbeat is not an event and must never reach the status line.
  assert.deepEqual(calls.status, ["Processing 3 chunk(s)..."]);
});

test("real silence is reported as a partial map, not as a dead Ollama", async () => {
  const { generateMindMap } = await loadApi();
  globalThis.fetch = streamingFetch(({ write }) => {
    write(graphEvent(["EIR Problems"]));
    // ...and then the server never speaks again.
  });

  const { calls, handlers } = collect();
  await generateMindMap("transcript", handlers, { connectTimeoutMs: 200, idleTimeoutMs: 60 });

  assert.equal(calls.graphs.length, 1);
  assert.match(calls.error, /went quiet/);
  assert.match(calls.error, /partial/);
  assert.deepEqual(calls.meta, { partial: true });
  assert.equal(calls.done, null);
});

test("nothing at all points at the server and Ollama", async () => {
  const { generateMindMap } = await loadApi();
  globalThis.fetch = streamingFetch(() => {});

  const { calls, handlers } = collect();
  await generateMindMap("transcript", handlers, { connectTimeoutMs: 60, idleTimeoutMs: 60 });

  assert.match(calls.error, /ollama serve/);
  assert.deepEqual(calls.meta, { partial: false });
});

test("a stream that closes without done is not silently treated as success", async () => {
  const { generateMindMap } = await loadApi();
  globalThis.fetch = streamingFetch(({ write, close }) => {
    write(graphEvent(["EIR Problems"]));
    close();
  });

  const { calls, handlers } = collect();
  await generateMindMap("transcript", handlers, { connectTimeoutMs: 200, idleTimeoutMs: 200 });

  assert.equal(calls.done, null);
  assert.match(calls.error, /closed before the map was finished/);
  assert.deepEqual(calls.meta, { partial: true });
});

test("a server error event wins over the stream ending early", async () => {
  const { generateMindMap } = await loadApi();
  globalThis.fetch = streamingFetch(({ write, close }) => {
    write(
      "event: error\ndata: {\"error\":\"Ollama request failed\",\"code\":\"ollama_failed\"}\n\n"
    );
    close();
  });

  const { calls, handlers } = collect();
  await generateMindMap("transcript", handlers, { connectTimeoutMs: 200, idleTimeoutMs: 200 });

  assert.equal(calls.error, "Ollama request failed [ollama_failed]");
});

test("a run that finishes normally reports its warnings", async () => {
  const { generateMindMap } = await loadApi();
  globalThis.fetch = streamingFetch(({ write, close }) => {
    write(graphEvent(["EIR Problems"]));
    write(
      `event: done\ndata: ${JSON.stringify({
        warnings: [{ chunk: 2, code: "no_json", message: "Chunk 2 of 3 skipped" }],
        chunks: 3,
        partial: false
      })}\n\n`
    );
    close();
  });

  const { calls, handlers } = collect();
  await generateMindMap("transcript", handlers, { connectTimeoutMs: 200, idleTimeoutMs: 200 });

  assert.equal(calls.error, null);
  assert.equal(calls.done.warnings.length, 1);
});
