"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createOllamaClient, UpstreamError } = require("../lib/ollama");
const { loadConfig } = require("../lib/config");

const config = loadConfig({
  OLLAMA_URL: "http://localhost:11434/",
  OLLAMA_MODEL: "llama3.2:3b",
  OLLAMA_RETRIES: "1",
  OLLAMA_RETRY_BACKOFF_MS: "1",
  OLLAMA_HEALTH_TIMEOUT_MS: "50"
});

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

test("a trailing slash on OLLAMA_URL does not double up in the path", async () => {
  const seen = [];
  const client = createOllamaClient(config, async (url) => {
    seen.push(url);
    return jsonResponse({ response: '{"nodes":[],"edges":[]}' });
  });

  await client.generate("hi");
  assert.equal(seen[0], "http://localhost:11434/api/generate");
});

test("generate asks Ollama for the graph schema, not just any JSON", async () => {
  let sent;
  const client = createOllamaClient(config, async (url, options) => {
    sent = JSON.parse(options.body);
    return jsonResponse({ response: '{"nodes":[],"edges":[]}' });
  });

  await client.generate("hi");

  // `format: "json"` lets the model answer `{}`, which is what a 4B model does.
  assert.notEqual(sent.format, "json");
  assert.deepEqual(sent.format.required, ["nodes", "edges"]);
  assert.deepEqual(sent.format.properties.nodes.items.properties.type.enum, [
    "cause",
    "theme",
    "hierarchy"
  ]);
});

test("generate pins the sampler instead of inheriting the model's chat defaults", async () => {
  let sent;
  const client = createOllamaClient(config, async (url, options) => {
    sent = JSON.parse(options.body);
    return jsonResponse({ response: '{"nodes":[],"edges":[]}' });
  });

  await client.generate("hi");

  // Without this block the call runs at gemma3's temperature 1 / top_p 0.95,
  // which answers the same chunk differently every time it is asked.
  assert.equal(sent.options.temperature, 0);
  assert.equal(sent.options.top_p, 0.9);
  assert.equal(sent.options.num_ctx, 8192);
});

test("the sampler settings are overridable from the environment", async () => {
  let sent;
  const client = createOllamaClient(
    loadConfig({ OLLAMA_TEMPERATURE: "0.3", OLLAMA_TOP_P: "0.95", OLLAMA_NUM_CTX: "4096" }),
    async (url, options) => {
      sent = JSON.parse(options.body);
      return jsonResponse({ response: '{"nodes":[],"edges":[]}' });
    }
  );

  await client.generate("hi");
  assert.deepEqual(sent.options, { temperature: 0.3, top_p: 0.95, num_ctx: 4096 });
});

test("OLLAMA_FORMAT_SCHEMA=0 falls back to plain JSON mode for an old server", async () => {
  let sent;
  const client = createOllamaClient(
    loadConfig({ OLLAMA_FORMAT_SCHEMA: "0" }),
    async (url, options) => {
      sent = JSON.parse(options.body);
      return jsonResponse({ response: "{}" });
    }
  );

  await client.generate("hi");
  assert.equal(sent.format, "json");
});

test("generate retries a dropped connection and then gives up as ollama_failed", async () => {
  let calls = 0;
  const client = createOllamaClient(config, async () => {
    calls += 1;
    throw new Error("ECONNREFUSED");
  });

  await assert.rejects(
    () => client.generate("hi"),
    (err) => err instanceof UpstreamError && err.code === "ollama_failed"
  );
  assert.equal(calls, 2, "one initial attempt plus one retry");
});

test("a refused connection reads as something the user can act on", async () => {
  const client = createOllamaClient(loadConfig({ OLLAMA_RETRIES: "0" }), async () => {
    // The shape undici produces for a refused connection.
    const inner = new Error("connect ECONNREFUSED 127.0.0.1:11434");
    throw new AggregateError([inner], "");
  });

  await assert.rejects(
    () => client.generate("hi"),
    (err) => err.details === "connect ECONNREFUSED 127.0.0.1:11434"
  );
});

test("a non-2xx from Ollama carries the status into the error details", async () => {
  const client = createOllamaClient(config, async () => ({
    ok: false,
    status: 404,
    text: async () => "model not found"
  }));

  await assert.rejects(
    () => client.generate("hi"),
    (err) => err.code === "ollama_failed" && /404/.test(err.details)
  );
});

test("health reports the model as available when it is pulled", async () => {
  const client = createOllamaClient(config, async () =>
    jsonResponse({ models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:7b" }] })
  );

  const health = await client.health();
  assert.equal(health.reachable, true);
  assert.equal(health.modelAvailable, true);
  assert.deepEqual(health.models, ["llama3.2:3b", "qwen2.5:7b"]);
});

test("health matches an untagged model against :latest", async () => {
  const untagged = loadConfig({ OLLAMA_MODEL: "mistral" });
  const client = createOllamaClient(untagged, async () =>
    jsonResponse({ models: [{ name: "mistral:latest" }] })
  );

  assert.equal((await client.health()).modelAvailable, true);
});

test("health says the model is missing rather than pretending it is fine", async () => {
  const client = createOllamaClient(config, async () =>
    jsonResponse({ models: [{ name: "qwen2.5:7b" }] })
  );

  const health = await client.health();
  assert.equal(health.reachable, true);
  assert.equal(health.modelAvailable, false);
});

test("health reports an unreachable Ollama instead of throwing", async () => {
  const client = createOllamaClient(config, async () => {
    throw new Error("ECONNREFUSED");
  });

  const health = await client.health();
  assert.equal(health.reachable, false);
  assert.match(health.error, /ECONNREFUSED/);
});
