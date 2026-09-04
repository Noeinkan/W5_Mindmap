"use strict";

const { graphResponseSchema } = require("./schema");

class UpstreamError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "UpstreamError";
    this.code = code || "ollama_failed";
    this.details = details ? String(details) : "";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A readable one-liner for a failed fetch. Undici wraps a refused connection in an
 * AggregateError whose own message is the useless string "AggregateError"; the
 * sentence a user can act on ("connect ECONNREFUSED 127.0.0.1:11434") is inside it.
 */
function describeError(err, depth = 0) {
  if (!err || depth > 3) return "";
  if (Array.isArray(err.errors) && err.errors.length) {
    return err.errors.map((e) => describeError(e, depth + 1)).filter(Boolean).join("; ");
  }
  const message = err.message ? String(err.message) : String(err);
  if (err.cause) {
    const cause = describeError(err.cause, depth + 1);
    return cause && cause !== message ? `${message}: ${cause}` : message;
  }
  return message;
}

async function fetchWithRetry(fetchImpl, url, options, timeoutMs, retries, backoffMs) {
  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      if (attempt >= retries) break;
      await delay(backoffMs * Math.pow(2, attempt));
    }
    attempt += 1;
  }

  throw new UpstreamError("Ollama request failed", "ollama_failed", describeError(lastError));
}

function createOllamaClient(config, fetchImpl = fetch) {
  /**
   * Ask the model for one JSON object. Returns the raw Ollama body.
   * `schema` overrides the default graph schema (the linking pass wants edges only).
   */
  async function generate(prompt, schema) {
    const response = await fetchWithRetry(
      fetchImpl,
      `${config.ollamaUrl}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.ollamaModel,
          prompt,
          // A schema when the server supports structured outputs, plain JSON mode
          // otherwise. See lib/schema.js for why the difference matters.
          format: config.useSchema ? schema || graphResponseSchema : "json",
          stream: false
        })
      },
      config.ollamaTimeoutMs,
      config.ollamaRetries,
      config.ollamaRetryBackoffMs
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new UpstreamError(
        "Ollama request failed",
        "ollama_failed",
        `Status ${response.status}: ${text}`
      );
    }

    return response.json();
  }

  /**
   * Is Ollama actually there, and does it have the configured model pulled?
   * Answering this up front turns "502 after 40 seconds" into a sentence the user
   * can act on before pasting anything.
   */
  async function health() {
    const result = {
      url: config.ollamaUrl,
      model: config.ollamaModel,
      reachable: false,
      modelAvailable: false,
      models: []
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.ollamaHealthTimeoutMs);
    try {
      const response = await fetchImpl(`${config.ollamaUrl}/api/tags`, {
        signal: controller.signal
      });
      if (!response.ok) {
        result.error = `Status ${response.status}`;
        return result;
      }
      const data = await response.json();
      result.reachable = true;
      result.models = Array.isArray(data && data.models)
        ? data.models.map((m) => String(m && m.name ? m.name : m)).filter(Boolean)
        : [];
      // Ollama reports "llama3.2:3b"; a config without a tag means the :latest tag.
      const wanted = config.ollamaModel.includes(":")
        ? config.ollamaModel
        : `${config.ollamaModel}:latest`;
      result.modelAvailable = result.models.some((m) => m === config.ollamaModel || m === wanted);
      return result;
    } catch (err) {
      result.error = err && err.name === "AbortError" ? "Timed out" : describeError(err);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { generate, health };
}

module.exports = { createOllamaClient, fetchWithRetry, UpstreamError };
