"use strict";

const path = require("node:path");

const DEFAULTS = {
  // 3000 is the default of every other dev server on this machine; 3200 keeps
  // this app from fighting one of them for the port.
  PORT: 3200,
  // Which model answers by default. The switch in the sidebar overrides it per
  // run; this is what a fresh browser starts on. Local is the safe default: it
  // needs no key and sends nothing anywhere.
  AI_PROVIDER: "ollama",
  OLLAMA_URL: "http://localhost:11434",
  OLLAMA_MODEL: "gemma3:4b",
  // One chunk takes ~17 s on a warm gemma3:4b; the first call of a run also
  // pays for loading the model. 20 s timed out before the first chunk landed.
  OLLAMA_TIMEOUT_MS: 120000,
  OLLAMA_RETRIES: 1,
  OLLAMA_RETRY_BACKOFF_MS: 500,
  OLLAMA_HEALTH_TIMEOUT_MS: 2500,
  // A model call says nothing for tens of seconds. This keeps a byte on the wire so
  // the browser (and any proxy in between) can tell a working run from a dead one.
  // Must stay well under the client's idle timeout in public/js/api.js.
  SSE_HEARTBEAT_MS: 10000,
  TRANSCRIPT_CHUNK_SIZE: 3500,
  TRANSCRIPT_CHUNK_OVERLAP_LINES: 1,
  CHUNK_PARSE_RETRIES: 1,
  // Ollama 0.5+ accepts a JSON schema as `format`. Set to 0 for an older server.
  OLLAMA_FORMAT_SCHEMA: 1,
  // Extraction is a reading task, not a writing one: the sampler has nothing to
  // add here. Left unset, every call inherits the model's chat defaults —
  // gemma3:4b ships at temperature 1, top_p 0.95, top_k 64 — so the same chunk
  // comes back different each time it is asked. Greedy decoding stays safe even
  // though a chunk can be asked twice, because the second ask is a different
  // prompt: lib/extract.js sets `strict` or `retryEmpty` on it.
  OLLAMA_TEMPERATURE: 0,
  // Only bites if the temperature is raised: at 0 the sampler is greedy anyway.
  OLLAMA_TOP_P: 0.9,
  // Ollama's own default is 4096. A full 3500-character chunk plus the prompt
  // and 40 known labels is around 1600 tokens in, and a chunk dense in concepts
  // answers with close to a thousand more — near enough the ceiling that a long
  // answer risks being cut off mid-object. 8192 buys the headroom for roughly
  // 300 MB of KV cache, which an 8 GB card has to spare.
  OLLAMA_NUM_CTX: 8192,
  KNOWN_LABELS_IN_PROMPT: 40,

  /* --- Google Gemini, the cloud alternative to Ollama --------------------- */

  // Read from .env (see the npm scripts: node loads it with --env-file-if-exists).
  // Empty means the Gemini option is shown but cannot be picked, which is the
  // honest state — better than a switch that fails when it is flipped.
  GEMINI_API_KEY: "",
  // What .env ships with on the GEMINI_API_KEY line until a real key replaces it.
  // Read as "no key": taken literally it would light the Gemini option up as
  // ready, and every run would then fail at Google with "API key not valid".
  GEMINI_API_KEY_PLACEHOLDER: "your-gemini-api-key-here",
  // Cheapest of the current generation, and extraction is a reading task rather
  // than a writing one: a run is one call per chunk, so the per-call price is
  // what a long book multiplies.
  GEMINI_MODEL: "gemini-3.1-flash-lite",
  // What the dropdown offers, cheapest first. A comma-separated list rather than a
  // constant in the code: a model released next month becomes selectable by
  // editing .env, with no typo able to reach the API — the server only accepts ids
  // that are on this list.
  GEMINI_MODELS: "gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-3.8-flash,gemini-2.5-flash-lite",
  // Tried in order when the chosen model answers 503 or 429. A run is one call per
  // chunk, so without this a single busy minute halfway through a book costs every
  // chunk after it.
  GEMINI_FALLBACK_MODELS: "gemini-3.5-flash-lite,gemini-2.5-flash",
  GEMINI_TIMEOUT_MS: 120000,
  GEMINI_RETRIES: 1,
  GEMINI_RETRY_BACKOFF_MS: 500,
  GEMINI_HEALTH_TIMEOUT_MS: 5000,
  // A chunk's graph is well under a thousand tokens; this is the runaway stop, not
  // a target. lib/gemini.js adds headroom on top for Gemini 3, which spends part of
  // the same budget thinking before it answers.
  GEMINI_MAX_OUTPUT_TOKENS: 8192,

  /* --- DeepSeek, the second cloud alternative ----------------------------- */

  DEEPSEEK_API_KEY: "",
  // Same role as the Gemini placeholder: what .env ships with, read as no key.
  DEEPSEEK_API_KEY_PLACEHOLDER: "your-deepseek-api-key-here",
  // DeepSeek's own OpenAI-compatible endpoint. Only worth changing to point at a
  // proxy, or at a stub in a test.
  DEEPSEEK_URL: "https://api.deepseek.com",
  // `deepseek-flash` is DeepSeek-V4.1-Flash — the id DeepSeek now publishes for it.
  // The older `deepseek-v4-flash` still answers, but is served by the same model.
  DEEPSEEK_MODEL: "deepseek-flash",
  // Flash first; Pro costs three to four times as much per token for a stronger
  // reader, worth it only when Flash misses things on a dense document.
  DEEPSEEK_MODELS: "deepseek-flash,deepseek-v4-pro",
  // Empty on purpose. DeepSeek has two models and the other one costs several
  // times as much: a busy minute silently moving a whole book onto Pro is not a
  // decision this file should make for you.
  DEEPSEEK_FALLBACK_MODELS: "",
  DEEPSEEK_TIMEOUT_MS: 120000,
  DEEPSEEK_RETRIES: 1,
  DEEPSEEK_RETRY_BACKOFF_MS: 500,
  DEEPSEEK_HEALTH_TIMEOUT_MS: 5000,
  // Same runaway stop as Gemini. Thinking is switched off for extraction (see
  // lib/deepseek.js), so all of this budget goes to the answer.
  DEEPSEEK_MAX_OUTPUT_TOKENS: 8192,

  // One extra call at the end that connects concepts found in different chunks.
  LINK_PASS: 1,
  // Reading a file: a PDF or an EPUB into the text the extractor sees. 64 MB
  // takes an illustrated textbook — a real one measured 43 MB — and reading it
  // costs about twice that in memory while it happens.
  INGEST_MAX_BYTES: 64 * 1024 * 1024,
  // A safety valve, not a reading limit — a book comes back whole and the
  // section list is what keeps a run short.
  INGEST_MAX_CHARS: 2000000,
  INGEST_MAX_PAGES: 2000,
  // Saved maps, one JSON file each. Relative to the repository root, and
  // gitignored: these are the user's meetings, not the project's fixtures.
  GRAPH_STORE_DIR: path.join(__dirname, "..", "data", "graphs"),
  NODE_ENV: "development"
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** A comma-separated setting as a clean list: no blanks, no repeats, trimmed. */
function list(value, fallback) {
  const raw = value === undefined || value === null || value === "" ? fallback : value;
  return [...new Set(String(raw).split(",").map((item) => item.trim()).filter(Boolean))];
}

/** An API key, or "" when the line is blank or still holds its placeholder. */
function readApiKey(value, placeholder) {
  const key = String(value || "").trim();
  return key === placeholder ? "" : key;
}

// Kept here rather than imported from lib/provider.js: that module reads the
// config, so importing it back would be a circle.
const KNOWN_PROVIDERS = ["ollama", "gemini", "deepseek"];

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || DEFAULTS.NODE_ENV;
  const provider = String(env.AI_PROVIDER || DEFAULTS.AI_PROVIDER).trim().toLowerCase();
  return {
    port: num(env.PORT, DEFAULTS.PORT),
    // A typo in AI_PROVIDER falls back to local rather than failing at boot: the
    // switch in the UI can put it right without touching the file.
    aiProvider: KNOWN_PROVIDERS.includes(provider) ? provider : DEFAULTS.AI_PROVIDER,
    ollamaUrl: (env.OLLAMA_URL || DEFAULTS.OLLAMA_URL).replace(/\/+$/, ""),
    ollamaModel: env.OLLAMA_MODEL || DEFAULTS.OLLAMA_MODEL,
    ollamaTimeoutMs: num(env.OLLAMA_TIMEOUT_MS, DEFAULTS.OLLAMA_TIMEOUT_MS),
    ollamaRetries: num(env.OLLAMA_RETRIES, DEFAULTS.OLLAMA_RETRIES),
    ollamaRetryBackoffMs: num(env.OLLAMA_RETRY_BACKOFF_MS, DEFAULTS.OLLAMA_RETRY_BACKOFF_MS),
    ollamaHealthTimeoutMs: num(env.OLLAMA_HEALTH_TIMEOUT_MS, DEFAULTS.OLLAMA_HEALTH_TIMEOUT_MS),
    sseHeartbeatMs: num(env.SSE_HEARTBEAT_MS, DEFAULTS.SSE_HEARTBEAT_MS),
    chunkSize: num(env.TRANSCRIPT_CHUNK_SIZE, DEFAULTS.TRANSCRIPT_CHUNK_SIZE),
    chunkOverlapLines: num(env.TRANSCRIPT_CHUNK_OVERLAP_LINES, DEFAULTS.TRANSCRIPT_CHUNK_OVERLAP_LINES),
    chunkParseRetries: num(env.CHUNK_PARSE_RETRIES, DEFAULTS.CHUNK_PARSE_RETRIES),
    useSchema: num(env.OLLAMA_FORMAT_SCHEMA, DEFAULTS.OLLAMA_FORMAT_SCHEMA) !== 0,
    ollamaTemperature: num(env.OLLAMA_TEMPERATURE, DEFAULTS.OLLAMA_TEMPERATURE),
    ollamaTopP: num(env.OLLAMA_TOP_P, DEFAULTS.OLLAMA_TOP_P),
    ollamaNumCtx: num(env.OLLAMA_NUM_CTX, DEFAULTS.OLLAMA_NUM_CTX),
    linkPass: num(env.LINK_PASS, DEFAULTS.LINK_PASS) !== 0,
    knownLabelsInPrompt: num(env.KNOWN_LABELS_IN_PROMPT, DEFAULTS.KNOWN_LABELS_IN_PROMPT),
    geminiApiKey: readApiKey(env.GEMINI_API_KEY, DEFAULTS.GEMINI_API_KEY_PLACEHOLDER),
    deepseekApiKey: readApiKey(env.DEEPSEEK_API_KEY, DEFAULTS.DEEPSEEK_API_KEY_PLACEHOLDER),
    deepseekUrl: (env.DEEPSEEK_URL || DEFAULTS.DEEPSEEK_URL).replace(/\/+$/, ""),
    deepseekModel: (env.DEEPSEEK_MODEL || DEFAULTS.DEEPSEEK_MODEL).trim(),
    deepseekModels: list(env.DEEPSEEK_MODELS, DEFAULTS.DEEPSEEK_MODELS),
    deepseekFallbackModels: list(env.DEEPSEEK_FALLBACK_MODELS, DEFAULTS.DEEPSEEK_FALLBACK_MODELS),
    deepseekTimeoutMs: num(env.DEEPSEEK_TIMEOUT_MS, DEFAULTS.DEEPSEEK_TIMEOUT_MS),
    deepseekRetries: num(env.DEEPSEEK_RETRIES, DEFAULTS.DEEPSEEK_RETRIES),
    deepseekRetryBackoffMs: num(env.DEEPSEEK_RETRY_BACKOFF_MS, DEFAULTS.DEEPSEEK_RETRY_BACKOFF_MS),
    deepseekHealthTimeoutMs: num(env.DEEPSEEK_HEALTH_TIMEOUT_MS, DEFAULTS.DEEPSEEK_HEALTH_TIMEOUT_MS),
    deepseekMaxOutputTokens: num(env.DEEPSEEK_MAX_OUTPUT_TOKENS, DEFAULTS.DEEPSEEK_MAX_OUTPUT_TOKENS),
    geminiModel: (env.GEMINI_MODEL || DEFAULTS.GEMINI_MODEL).trim(),
    geminiModels: list(env.GEMINI_MODELS, DEFAULTS.GEMINI_MODELS),
    geminiFallbackModels: list(env.GEMINI_FALLBACK_MODELS, DEFAULTS.GEMINI_FALLBACK_MODELS),
    geminiTimeoutMs: num(env.GEMINI_TIMEOUT_MS, DEFAULTS.GEMINI_TIMEOUT_MS),
    geminiRetries: num(env.GEMINI_RETRIES, DEFAULTS.GEMINI_RETRIES),
    geminiRetryBackoffMs: num(env.GEMINI_RETRY_BACKOFF_MS, DEFAULTS.GEMINI_RETRY_BACKOFF_MS),
    geminiHealthTimeoutMs: num(env.GEMINI_HEALTH_TIMEOUT_MS, DEFAULTS.GEMINI_HEALTH_TIMEOUT_MS),
    geminiMaxOutputTokens: num(env.GEMINI_MAX_OUTPUT_TOKENS, DEFAULTS.GEMINI_MAX_OUTPUT_TOKENS),
    ingestMaxBytes: num(env.INGEST_MAX_BYTES, DEFAULTS.INGEST_MAX_BYTES),
    ingestMaxChars: num(env.INGEST_MAX_CHARS, DEFAULTS.INGEST_MAX_CHARS),
    ingestMaxPages: num(env.INGEST_MAX_PAGES, DEFAULTS.INGEST_MAX_PAGES),
    graphStoreDir: path.resolve(env.GRAPH_STORE_DIR || DEFAULTS.GRAPH_STORE_DIR),
    nodeEnv,
    exposeErrorDetails: nodeEnv !== "production"
  };
}

module.exports = { loadConfig, DEFAULTS };
