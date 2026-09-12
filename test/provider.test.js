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

test("the placeholder .env ships with counts as no key, so Gemini stays greyed out", () => {
  const config = loadConfig({ GEMINI_API_KEY: "your-gemini-api-key-here" });

  assert.equal(config.geminiApiKey, "");
  assert.throws(
    () => createAiClient(config, { provider: "gemini" }, neverCalled),
    (err) => err.code === "provider_unavailable"
  );
});

test("a real key next to the placeholder rules is kept as it is", () => {
  assert.equal(loadConfig({ GEMINI_API_KEY: "  AIzaSyExample123  " }).geminiApiKey, "AIzaSyExample123");
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

test("choosing DeepSeek gives a DeepSeek client on V4.1 Flash by default", () => {
  const config = loadConfig({ DEEPSEEK_API_KEY: "sk-test" });

  const client = createAiClient(config, { provider: "deepseek" }, neverCalled);

  assert.equal(client.provider, "deepseek");
  assert.equal(client.model, "deepseek-flash");
});

test("DeepSeek's Pro model can be picked, anything else cannot", () => {
  const config = loadConfig({ DEEPSEEK_API_KEY: "sk-test" });

  assert.equal(
    createAiClient(config, { provider: "deepseek", model: "deepseek-v4-pro" }, neverCalled).model,
    "deepseek-v4-pro"
  );
  assert.throws(
    () => createAiClient(config, { provider: "deepseek", model: "deepseek-r1" }, neverCalled),
    (err) => err.code === "unknown_model" && /DeepSeek/.test(err.message)
  );
});

test("a Gemini model is not accepted for DeepSeek — each provider has its own list", () => {
  const config = loadConfig({ DEEPSEEK_API_KEY: "sk-test", GEMINI_API_KEY: "g-test" });

  assert.throws(
    () => createAiClient(config, { provider: "deepseek", model: "gemini-3.1-flash-lite" }, neverCalled),
    (err) => err.code === "unknown_model"
  );
});

test("DeepSeek with no key — or the .env placeholder — names DEEPSEEK_API_KEY", () => {
  for (const key of ["", "your-deepseek-api-key-here"]) {
    assert.throws(
      () => createAiClient(loadConfig({ DEEPSEEK_API_KEY: key }), { provider: "deepseek" }, neverCalled),
      (err) => err.code === "provider_unavailable" && /DEEPSEEK_API_KEY/.test(err.message)
    );
  }
});

test("AI_PROVIDER=deepseek is accepted as a default", () => {
  assert.equal(loadConfig({ AI_PROVIDER: "deepseek" }).aiProvider, "deepseek");
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

test("the switch offers the three providers, local first", async () => {
  const data = await describeProviders(keyless, async () => jsonResponse({ models: [] }));

  assert.deepEqual(data.providers.map((p) => p.id), ["ollama", "gemini", "deepseek"]);
});

test("DeepSeek is listed with its two models, and says where the transcript goes", async () => {
  const config = loadConfig({ DEEPSEEK_API_KEY: "sk-test" });
  const data = await describeProviders(config, async () => jsonResponse({ models: [] }));
  const deepseek = data.providers.find((p) => p.id === "deepseek");

  assert.equal(deepseek.available, true);
  assert.deepEqual(deepseek.models, ["deepseek-flash", "deepseek-v4-pro"]);
  assert.match(deepseek.hint, /China/);
});

test("the dropdown names V4.1 Flash, since its id alone does not say which version it is", async () => {
  const config = loadConfig({ DEEPSEEK_API_KEY: "sk-test", GEMINI_API_KEY: "g-test" });
  const data = await describeProviders(config, async () => jsonResponse({ models: [] }));
  const byId = Object.fromEntries(data.providers.map((p) => [p.id, p]));

  assert.equal(byId.deepseek.modelLabels["deepseek-flash"], "DeepSeek V4.1 Flash");
  assert.equal(byId.deepseek.modelLabels["deepseek-v4-pro"], "DeepSeek V4 Pro");
  assert.equal(byId.gemini.modelLabels["gemini-3.1-flash-lite"], "Gemini 3.1 Flash-Lite");
});

test("a model added through .env with no known name is shown by its id", async () => {
  const config = loadConfig({ DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_MODELS: "deepseek-flash,deepseek-v5-flash" });
  const data = await describeProviders(config, async () => jsonResponse({ models: [] }));
  const deepseek = data.providers.find((p) => p.id === "deepseek");

  assert.equal(deepseek.modelLabels["deepseek-v5-flash"], "deepseek-v5-flash");
});

test("listing never calls DeepSeek either", async () => {
  const urls = [];
  const config = loadConfig({ DEEPSEEK_API_KEY: "sk-test", GEMINI_API_KEY: "g-test" });
  await describeProviders(config, async (url) => {
    urls.push(String(url));
    return jsonResponse({ models: [] });
  });

  assert.equal(urls.length, 1, "only Ollama should have been asked");
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
