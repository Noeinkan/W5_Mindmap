"use strict";

const path = require("node:path");

const DEFAULTS = {
  // 3000 is the default of every other dev server on this machine; 3200 keeps
  // this app from fighting one of them for the port.
  PORT: 3200,
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
  // One extra call at the end that connects concepts found in different chunks.
  LINK_PASS: 1,
  // Saved maps, one JSON file each. Relative to the repository root, and
  // gitignored: these are the user's meetings, not the project's fixtures.
  GRAPH_STORE_DIR: path.join(__dirname, "..", "data", "graphs"),
  NODE_ENV: "development"
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || DEFAULTS.NODE_ENV;
  return {
    port: num(env.PORT, DEFAULTS.PORT),
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
    graphStoreDir: path.resolve(env.GRAPH_STORE_DIR || DEFAULTS.GRAPH_STORE_DIR),
    nodeEnv,
    exposeErrorDetails: nodeEnv !== "production"
  };
}

module.exports = { loadConfig, DEFAULTS };
