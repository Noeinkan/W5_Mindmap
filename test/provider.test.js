"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeProvider, createAiClient, describeProviders } = require("../lib/provider");
const { loadConfig } = require("../lib/config");

const withKey = loadConfig({
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-3.1-flash-lite",
  GEMINI_MODELS: "gemini-3.1-flash-lite,gemini-2.5-flash-lite",
  GEMINI_FALLBACK_MODELS: "",
  OLLAMA_MODEL: "gemma3:4b",
  OLLAMA_HEALTH_TIMEOUT_MS: "50"
});

const keyless = loadConfig({
  GEMINI_API_KEY: "",
  OLLAMA_MODEL: "gemma3:4b",
  OLLAMA_HEALTH_TIMEOUT_MS: "50"
});

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const neverCalled = async () => {
  throw new Error("no request should have been made");
};

/* ------------------------------------------------------------------ */
/* Which provider                                                      */
/* ------------------------------------------------------------------ */

test("a provider the server does not have falls back to the configured one", () => {
  assert.equal(normalizeProvider("openai", withKey), "ollama");
  assert.equal(normalizeProvider("", withKey), "ollama");
  assert.equal(normalizeProvider(undefined, withKey), "ollama");
});

test("the provider name is read case-insensitively", () => {
  assert.equal(normalizeProvider("GEMINI", withKey), "gemini");
});

test("AI_PROVIDER=gemini makes the cloud the default a request inherits", () => {
  const config = loadConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" });

  assert.equal(createAiClient(config, {}, neverCalled).provider, "gemini");
});

test("a misspelt AI_PROVIDER starts on the local model rather than failing at boot", () => {
  assert.equal(loadConfig({ AI_PROVIDER: "geminni" }).aiProvider, "ollama");
});

/* ------------------------------------------------------------------ */
/* Building the client                                                 */
/* ------------------------------------------------------------------ */

test("no choice at all gives the configured default", () => {
  const client = createAiClient(withKey, {}, neverCalled);

  assert.equal(client.provider, "ollama");
  assert.equal(client.model, "gemma3:4b");
});

test("choosing Gemini gives a Gemini client on the configured model", () => {
  const client = createAiClient(withKey, { provider: "gemini" }, neverCalled);

  assert.equal(client.provider, "gemini");
  assert.equal(client.model, "gemini-3.1-flash-lite");
});

test("a model from the dropdown replaces the default for that run only", () => {
  const client = createAiClient(withKey, { provider: "gemini", model: "gemini-2.5-flash-lite" }, neverCalled);

  assert.equal(client.model, "gemini-2.5-flash-lite");
  // The config itself is untouched, so the next request starts from the default again.
  assert.equal(withKey.geminiModel, "gemini-3.1-flash-lite");
});

test("a Gemini model that is not on the list is refused — the id decides the bill", () => {
  assert.throws(
    () => createAiClient(withKey, { provider: "gemini", model: "gemini-2.5-pro" }, neverCalled),
    (err) => err.code === "unknown_model" && /gemini-2\.5-pro/.test(err.message)
  );
});

test("a fallback model counts as allowed, since a run can end up on one", () => {
  const config = loadConfig({
    GEMINI_API_KEY: "test-key",
    GEMINI_MODELS: "gemini-3.1-flash-lite",
    GEMINI_FALLBACK_MODELS: "gemini-2.5-flash"
  });

  assert.equal(
    createAiClient(config, { provider: "gemini", model: "gemini-2.5-flash" }, neverCalled).model,
    "gemini-2.5-flash"
  );
});

test("choosing Gemini with no key says which setting is missing", () => {
  assert.throws(
    () => createAiClient(keyless, { provider: "gemini" }, neverCalled),
    (err) => err.code === "provider_unavailable" && /GEMINI_API_KEY/.test(err.message)
  );
});

test("an Ollama model is taken as given — what is pulled is the machine's business", () => {
  assert.equal(
    createAiClient(withKey, { provider: "ollama", model: "qwen2.5:7b" }, neverCalled).model,
    "qwen2.5:7b"
  );
});

test("something that is not a model id at all is still refused", () => {
  assert.throws(
    () => createAiClient(withKey, { provider: "ollama", model: "http://evil.example/x" }, neverCalled),
    (err) => err.code === "unknown_model"
  );
});

/* ------------------------------------------------------------------ */
/* What the browser is told                                            */
/* ------------------------------------------------------------------ */

test("the catalogue lists what is installed locally and what Gemini offers", async () => {
  const data = await describeProviders(withKey, async () =>
    jsonResponse({ models: [{ name: "gemma3:4b" }, { name: "qwen2.5:7b" }] })
  );
  const byId = Object.fromEntries(data.providers.map((p) => [p.id, p]));

  assert.deepEqual(byId.ollama.models, ["gemma3:4b", "qwen2.5:7b"]);
  assert.equal(byId.ollama.ready, true);
  assert.deepEqual(byId.gemini.models, ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"]);
  assert.equal(byId.gemini.available, true);
});

test("listing the models never calls Google — the list is configuration, not a lookup", async () => {
  const urls = [];
  await describeProviders(withKey, async (url) => {
    urls.push(String(url));
    return jsonResponse({ models: [] });
  });

  assert.equal(urls.some((url) => url.includes("googleapis")), false);
  assert.equal(urls.length, 1, "only Ollama should have been asked");
});

test("a model that is configured but not pulled still appears, so the dropdown is honest", async () => {
  const data = await describeProviders(withKey, async () =>
    jsonResponse({ models: [{ name: "qwen2.5:7b" }] })
  );
  const ollama = data.providers.find((p) => p.id === "ollama");

  assert.deepEqual(ollama.models, ["gemma3:4b", "qwen2.5:7b"]);
  assert.equal(ollama.ready, false);
  assert.match(ollama.note, /ollama pull gemma3:4b/);
});

test("no key means Gemini is listed, greyed out, with the fix in the note", async () => {
  const data = await describeProviders(keyless, async () =>
    jsonResponse({ models: [{ name: "gemma3:4b" }] })
  );
  const gemini = data.providers.find((p) => p.id === "gemini");

  assert.equal(gemini.available, false);
  assert.match(gemini.note, /GEMINI_API_KEY/);
  // The hint says what the choice means, and is shown whether or not it can be picked.
  assert.match(gemini.hint, /Google/);
});
