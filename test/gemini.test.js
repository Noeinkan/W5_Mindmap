"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGeminiClient, toGeminiSchema } = require("../lib/gemini");
const { UpstreamError } = require("../lib/upstream");
const { loadConfig } = require("../lib/config");
const { graphResponseSchema } = require("../lib/schema");

const config = loadConfig({
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-3.1-flash-lite",
  GEMINI_MODELS: "gemini-3.1-flash-lite,gemini-2.5-flash-lite",
  GEMINI_FALLBACK_MODELS: "gemini-2.5-flash-lite",
  GEMINI_RETRIES: "0",
  GEMINI_RETRY_BACKOFF_MS: "1",
  GEMINI_HEALTH_TIMEOUT_MS: "50",
  GEMINI_MAX_OUTPUT_TOKENS: "4096"
});

const keyless = loadConfig({ GEMINI_API_KEY: "" });

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

/** What the API sends back when it answers normally. */
const answer = (text, finishReason = "STOP") => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason }]
});

const EMPTY_GRAPH = '{"nodes":[],"edges":[]}';

/* ------------------------------------------------------------------ */
/* The schema translation                                              */
/* ------------------------------------------------------------------ */

test("the graph schema is translated into the shape Gemini accepts", () => {
  const translated = toGeminiSchema(graphResponseSchema);

  // An enum name, not a JSON Schema keyword: lower case is rejected by the API.
  assert.equal(translated.type, "OBJECT");
  assert.equal(translated.properties.nodes.type, "ARRAY");
  assert.equal(translated.properties.nodes.items.type, "OBJECT");
  assert.equal(translated.properties.nodes.items.properties.label.type, "STRING");
  assert.deepEqual(translated.required, ["nodes", "edges"]);
});

test("the node and edge type lists survive the translation", () => {
  const translated = toGeminiSchema(graphResponseSchema);

  assert.ok(translated.properties.nodes.items.properties.type.enum.includes("theme"));
  assert.ok(translated.properties.edges.items.properties.type.enum.includes("causes"));
});

test("propertyOrdering is added so the model emits fields in a fixed order", () => {
  const translated = toGeminiSchema(graphResponseSchema);

  assert.deepEqual(translated.propertyOrdering, ["nodes", "edges"]);
  assert.deepEqual(translated.properties.edges.items.propertyOrdering, ["id", "from", "to", "type"]);
});

test("additionalProperties is dropped — Gemini refuses the request outright with it", () => {
  const translated = toGeminiSchema({
    type: "object",
    additionalProperties: false,
    properties: { a: { type: "string", additionalProperties: true } }
  });

  assert.equal("additionalProperties" in translated, false);
  assert.equal("additionalProperties" in translated.properties.a, false);
});

/* ------------------------------------------------------------------ */
/* generate                                                            */
/* ------------------------------------------------------------------ */

test("the API key travels in a header, never in the URL", async () => {
  let seenUrl;
  let seenHeaders;
  const client = createGeminiClient(config, async (url, options) => {
    seenUrl = url;
    seenHeaders = options.headers;
    return jsonResponse(answer(EMPTY_GRAPH));
  });

  await client.generate("hi");

  assert.equal(seenUrl.includes("test-key"), false);
  assert.equal(seenHeaders["x-goog-api-key"], "test-key");
  assert.match(seenUrl, /models\/gemini-3\.1-flash-lite:generateContent$/);
});

test("generate asks for JSON constrained to the graph schema, not just any JSON", async () => {
  let sent;
  const client = createGeminiClient(config, async (url, options) => {
    sent = JSON.parse(options.body);
    return jsonResponse(answer(EMPTY_GRAPH));
  });

  await client.generate("hi");

  assert.equal(sent.generationConfig.responseMimeType, "application/json");
  assert.equal(sent.generationConfig.responseSchema.type, "OBJECT");
  assert.deepEqual(sent.generationConfig.responseSchema.required, ["nodes", "edges"]);
});

test("the answer comes back in the shape the Ollama path already parses", async () => {
  const client = createGeminiClient(config, async () => jsonResponse(answer(EMPTY_GRAPH)));

  const result = await client.generate("hi");

  assert.equal(result.response, EMPTY_GRAPH);
});

test("extraction runs on a greedy sampler, the same as the local path", async () => {
  let sent;
  const client = createGeminiClient(config, async (url, options) => {
    sent = JSON.parse(options.body);
    return jsonResponse(answer(EMPTY_GRAPH));
  });

  await client.generate("hi");

  assert.equal(sent.generationConfig.temperature, 0);
});

test("Gemini 3 gets extra output tokens, because it spends some of them thinking", async () => {
  let sent;
  const client = createGeminiClient(config, async (url, options) => {
    sent = JSON.parse(options.body);
    return jsonResponse(answer(EMPTY_GRAPH));
  });

  await client.generate("hi");

  // 4096 asked for, plus the headroom the thinking eats before the answer starts.
  assert.equal(sent.generationConfig.maxOutputTokens, 4096 + 2048);
});

test("an older model gets exactly the cap it was given", async () => {
  let sent;
  const older = { ...config, geminiModel: "gemini-2.5-flash-lite" };
  const client = createGeminiClient(older, async (url, options) => {
    sent = JSON.parse(options.body);
    return jsonResponse(answer(EMPTY_GRAPH));
  });

  await client.generate("hi");

  assert.equal(sent.generationConfig.maxOutputTokens, 4096);
});

test("a busy model is not the end of the run — the next one on the list is tried", async () => {
  const tried = [];
  const client = createGeminiClient(config, async (url) => {
    tried.push(url.match(/models\/([^:]+):/)[1]);
    return tried.length === 1
      ? jsonResponse({ error: { message: "overloaded" } }, 503)
      : jsonResponse(answer(EMPTY_GRAPH));
  });

  const result = await client.generate("hi");

  assert.deepEqual(tried, ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"]);
  assert.equal(result.model, "gemini-2.5-flash-lite");
});

test("a model that no longer exists falls through to the fallback as well", async () => {
  const tried = [];
  const client = createGeminiClient(config, async (url) => {
    tried.push(url.match(/models\/([^:]+):/)[1]);
    return tried.length === 1
      ? jsonResponse({ error: { message: "model not found" } }, 404)
      : jsonResponse(answer(EMPTY_GRAPH));
  });

  await client.generate("hi");

  assert.equal(tried.length, 2);
});

test("a rejected request is reported, not retried on another model", async () => {
  let calls = 0;
  const client = createGeminiClient(config, async () => {
    calls += 1;
    return jsonResponse({ error: { message: "API key not valid" } }, 401);
  });

  await assert.rejects(
    () => client.generate("hi"),
    (err) => err instanceof UpstreamError && err.code === "gemini_failed"
  );
  assert.equal(calls, 1);
});

test("an empty answer is returned, not thrown — so it costs one chunk, not the run", async () => {
  const client = createGeminiClient(config, async () =>
    jsonResponse({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] })
  );

  const result = await client.generate("hi");

  assert.equal(result.response, "");
  // The reason travels with it, so the chunk's warning can say why.
  assert.match(result.empty, /MAX_TOKENS/);
});

test("a blocked prompt names the block in the empty answer's reason", async () => {
  const client = createGeminiClient(config, async () =>
    jsonResponse({ candidates: [{ content: { parts: [] } }], promptFeedback: { blockReason: "SAFETY" } })
  );

  assert.match((await client.generate("hi")).empty, /SAFETY/);
});

test("without a key nothing is sent anywhere, and the message says what to do", async () => {
  let called = false;
  const client = createGeminiClient(keyless, async () => {
    called = true;
    return jsonResponse(answer(EMPTY_GRAPH));
  });

  await assert.rejects(
    () => client.generate("hi"),
    (err) => err.code === "gemini_not_configured" && /GEMINI_API_KEY/.test(err.message)
  );
  assert.equal(called, false);
});

/* ------------------------------------------------------------------ */
/* health                                                              */
/* ------------------------------------------------------------------ */

test("health without a key answers straight away instead of calling Google", async () => {
  let called = false;
  const client = createGeminiClient(keyless, async () => {
    called = true;
    return jsonResponse({ models: [] });
  });

  const health = await client.health();

  assert.equal(called, false);
  assert.equal(health.configured, false);
  assert.equal(health.reachable, false);
  assert.match(health.error, /GEMINI_API_KEY/);
});

test("health lists the models without the 'models/' prefix the API adds", async () => {
  const client = createGeminiClient(config, async () =>
    jsonResponse({
      models: [{ name: "models/gemini-3.1-flash-lite" }, { name: "models/gemini-2.5-flash" }]
    })
  );

  const health = await client.health();

  assert.equal(health.reachable, true);
  assert.equal(health.modelAvailable, true);
  assert.deepEqual(health.models, ["gemini-3.1-flash-lite", "gemini-2.5-flash"]);
});

test("health says the configured model is missing rather than pretending it is fine", async () => {
  const client = createGeminiClient(config, async () =>
    jsonResponse({ models: [{ name: "models/gemini-2.5-flash" }] })
  );

  const health = await client.health();

  assert.equal(health.reachable, true);
  assert.equal(health.modelAvailable, false);
});

test("a refused key is reported as a key problem, not as a status number", async () => {
  const client = createGeminiClient(config, async () => jsonResponse({ error: {} }, 403));

  const health = await client.health();

  assert.equal(health.reachable, false);
  assert.match(health.error, /API key/);
});

test("health reports an unreachable API instead of throwing", async () => {
  const client = createGeminiClient(config, async () => {
    throw new Error("getaddrinfo ENOTFOUND generativelanguage.googleapis.com");
  });

  const health = await client.health();

  assert.equal(health.reachable, false);
  assert.match(health.error, /ENOTFOUND/);
});
