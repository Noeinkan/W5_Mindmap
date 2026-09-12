"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDeepSeekClient } = require("../lib/deepseek");
const { UpstreamError } = require("../lib/upstream");
const { loadConfig } = require("../lib/config");
const { extractGraph } = require("../lib/extract");
const { PROMPT_MODES, buildLinkPrompt } = require("../lib/prompt");

const config = loadConfig({
  DEEPSEEK_API_KEY: "sk-test",
  DEEPSEEK_URL: "https://api.deepseek.test/",
  DEEPSEEK_MODEL: "deepseek-flash",
  DEEPSEEK_MODELS: "deepseek-flash,deepseek-v4-pro",
  DEEPSEEK_FALLBACK_MODELS: "",
  DEEPSEEK_RETRIES: "0",
  DEEPSEEK_RETRY_BACKOFF_MS: "1",
  DEEPSEEK_HEALTH_TIMEOUT_MS: "50",
  DEEPSEEK_MAX_OUTPUT_TOKENS: "4096"
});

const keyless = loadConfig({ DEEPSEEK_API_KEY: "" });

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

/** What DeepSeek sends back when it answers normally. */
const answer = (content, finishReason = "stop") => ({
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }]
});

const EMPTY_GRAPH = '{"nodes":[],"edges":[]}';

/* ------------------------------------------------------------------ */
/* The prompts                                                         */
/* ------------------------------------------------------------------ */

test("every prompt says 'JSON' and shows the shape — DeepSeek's JSON mode requires both", () => {
  // DeepSeek takes no schema, so the prompt is the only thing describing the
  // answer. Its docs make the word "json" and an example a condition of JSON mode.
  const prompts = [
    ...Object.entries(PROMPT_MODES).map(([mode, build]) => [
      mode,
      build({ chunk: "PM: hello", idPrefix: "c1_", knownLabels: [] })
    ]),
    ["link", buildLinkPrompt({ nodes: [{ id: "a", label: "A", type: "theme" }], components: [["a"]] })]
  ];

  for (const [name, prompt] of prompts) {
    assert.match(prompt, /json/i, `the ${name} prompt never says JSON`);
    assert.match(prompt, /"edges"/, `the ${name} prompt shows no example of the answer`);
  }
});

/* ------------------------------------------------------------------ */
/* generate                                                            */
/* ------------------------------------------------------------------ */

test("the call goes to DeepSeek's chat endpoint with the key as a bearer token", async () => {
  let seenUrl;
  let seenHeaders;
  const client = createDeepSeekClient(config, async (url, options) => {
    seenUrl = url;
    seenHeaders = options.headers;
    return jsonResponse(answer(EMPTY_GRAPH));
  });

  await client.generate("json please");

  // A trailing slash on DEEPSEEK_URL does not double up in the path.
  assert.equal(seenUrl, "https://api.deepseek.test/chat/completions");
  assert.equal(seenHeaders.Authorization, "Bearer sk-test");
});

test("it asks for JSON mode, with thinking off and the greedy sampler on", async () => {
  let sent;
  const client = createDeepSeekClient(config, async (url, options) => {
    sent = JSON.parse(options.body);
    return jsonResponse(answer(EMPTY_GRAPH));
  });

  await client.generate("json please");

  assert.equal(sent.model, "deepseek-flash");
  assert.deepEqual(sent.response_format, { type: "json_object" });
  // Left on, V4.1 reasons first and ignores the temperature while it does.
  assert.deepEqual(sent.thinking, { type: "disabled" });
  assert.equal(sent.temperature, 0);
  assert.equal(sent.max_tokens, 4096);
  assert.equal(sent.stream, false);
  assert.deepEqual(sent.messages, [{ role: "user", content: "json please" }]);
});

test("the answer comes back in the shape the other backends use", async () => {
  const client = createDeepSeekClient(config, async () => jsonResponse(answer(EMPTY_GRAPH)));

  const result = await client.generate("json");

  assert.equal(result.response, EMPTY_GRAPH);
  assert.equal(result.model, "deepseek-flash");
});

test("an empty answer — which DeepSeek documents as occasional — is returned, not thrown", async () => {
  const client = createDeepSeekClient(config, async () => jsonResponse(answer("", "length")));

  const result = await client.generate("json");

  assert.equal(result.response, "");
  assert.match(result.empty, /length/);
});

test("an empty answer on one chunk costs that chunk only, not the run", async () => {
  // The regression this guards against: an empty answer thrown as an error reads,
  // to lib/extract.js, like the network going down, and the run stops there.
  const small = loadConfig({
    DEEPSEEK_API_KEY: "sk-test",
    DEEPSEEK_RETRIES: "0",
    TRANSCRIPT_CHUNK_SIZE: "40",
    TRANSCRIPT_CHUNK_OVERLAP_LINES: "0",
    CHUNK_PARSE_RETRIES: "0",
    LINK_PASS: "0"
  });
  const graph = (prefix, label) =>
    JSON.stringify({ nodes: [{ id: `${prefix}n1`, label, type: "theme" }], edges: [] });
  const replies = [graph("c1_", "EIR Problems"), "", graph("c3_", "Capability Check")];
  const client = createDeepSeekClient(small, async () => jsonResponse(answer(replies.shift())));

  const result = await extractGraph({
    transcript: [
      "PM: The EIR was never issued properly.",
      "IM: So handover data is inconsistent.",
      "PM: We should run a capability check."
    ].join("\n"),
    config: small,
    client
  });

  assert.equal(result.partial, false);
  assert.deepEqual(result.nodes.map((n) => n.label).sort(), ["Capability Check", "EIR Problems"]);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].chunk, 2);
});

test("an empty balance says to top up, and is not retried on another model", async () => {
  const withFallback = { ...config, deepseekFallbackModels: ["deepseek-v4-pro"] };
  let calls = 0;
  const client = createDeepSeekClient(withFallback, async () => {
    calls += 1;
    return jsonResponse({ error: { message: "Insufficient Balance" } }, 402);
  });

  await assert.rejects(
    () => client.generate("json"),
    (err) =>
      err instanceof UpstreamError &&
      err.code === "deepseek_failed" &&
      /top it up/.test(err.message) &&
      /Insufficient Balance/.test(err.details)
  );
  assert.equal(calls, 1, "a balance problem would fail the same way on every model");
});

test("a refused key is named as a key problem", async () => {
  const client = createDeepSeekClient(config, async () => jsonResponse({ error: {} }, 401));

  await assert.rejects(() => client.generate("json"), (err) => /DEEPSEEK_API_KEY/.test(err.message));
});

test("a busy model moves to a fallback when one is configured", async () => {
  const withFallback = { ...config, deepseekFallbackModels: ["deepseek-v4-pro"] };
  const tried = [];
  const client = createDeepSeekClient(withFallback, async (url, options) => {
    tried.push(JSON.parse(options.body).model);
    return tried.length === 1
      ? jsonResponse({ error: { message: "overloaded" } }, 503)
      : jsonResponse(answer(EMPTY_GRAPH));
  });

  const result = await client.generate("json");

  assert.deepEqual(tried, ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(result.model, "deepseek-v4-pro");
});

test("with no fallback configured — the default — a busy model is reported, not swapped for Pro", async () => {
  const tried = [];
  const client = createDeepSeekClient(config, async (url, options) => {
    tried.push(JSON.parse(options.body).model);
    return jsonResponse({ error: { message: "overloaded" } }, 503);
  });

  await assert.rejects(() => client.generate("json"), (err) => /overloaded/.test(err.message));
  assert.deepEqual(tried, ["deepseek-flash"]);
});

test("without a key nothing is sent, and the message says which setting is missing", async () => {
  let called = false;
  const client = createDeepSeekClient(keyless, async () => {
    called = true;
    return jsonResponse(answer(EMPTY_GRAPH));
  });

  await assert.rejects(
    () => client.generate("json"),
    (err) => err.code === "deepseek_not_configured" && /DEEPSEEK_API_KEY/.test(err.message)
  );
  assert.equal(called, false);
});

/* ------------------------------------------------------------------ */
/* health                                                              */
/* ------------------------------------------------------------------ */

test("health without a key answers straight away instead of calling DeepSeek", async () => {
  let called = false;
  const client = createDeepSeekClient(keyless, async () => {
    called = true;
    return jsonResponse({ data: [] });
  });

  const health = await client.health();

  assert.equal(called, false);
  assert.equal(health.configured, false);
  assert.match(health.error, /DEEPSEEK_API_KEY/);
});

test("health lists the models DeepSeek reports", async () => {
  let seenUrl;
  const client = createDeepSeekClient(config, async (url) => {
    seenUrl = url;
    return jsonResponse({
      object: "list",
      data: [
        { id: "deepseek-flash", object: "model", owned_by: "deepseek" },
        { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" }
      ]
    });
  });

  const health = await client.health();

  assert.equal(seenUrl, "https://api.deepseek.test/models");
  assert.equal(health.reachable, true);
  assert.equal(health.modelAvailable, true);
  assert.deepEqual(health.models, ["deepseek-flash", "deepseek-v4-pro"]);
});

test("health reports a refused key in words", async () => {
  const client = createDeepSeekClient(config, async () => jsonResponse({}, 401));

  const health = await client.health();

  assert.equal(health.reachable, false);
  assert.match(health.error, /401 — the API key was refused/);
});

test("health reports an unreachable API instead of throwing", async () => {
  const client = createDeepSeekClient(config, async () => {
    throw new Error("getaddrinfo ENOTFOUND api.deepseek.com");
  });

  assert.match((await client.health()).error, /ENOTFOUND/);
});
