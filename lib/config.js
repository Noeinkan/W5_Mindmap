"use strict";

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
  KNOWN_LABELS_IN_PROMPT: 40,
  // One extra call at the end that connects concepts found in different chunks.
  LINK_PASS: 1,
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
    linkPass: num(env.LINK_PASS, DEFAULTS.LINK_PASS) !== 0,
    knownLabelsInPrompt: num(env.KNOWN_LABELS_IN_PROMPT, DEFAULTS.KNOWN_LABELS_IN_PROMPT),
    nodeEnv,
    exposeErrorDetails: nodeEnv !== "production"
  };
}

module.exports = { loadConfig, DEFAULTS };
