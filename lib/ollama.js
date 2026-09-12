"use strict";

const { graphResponseSchema } = require("./schema");
const { UpstreamError, describeError, fetchWithRetry } = require("./upstream");

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
          // Sent on every call rather than left to the model's own defaults: the
          // schema says what shape the answer takes, this says how it is chosen.
          // See lib/config.js for why extraction wants a greedy sampler.
          options: {
            temperature: config.ollamaTemperature,
            top_p: config.ollamaTopP,
            num_ctx: config.ollamaNumCtx
          },
          stream: false
        })
      },
      {
        timeoutMs: config.ollamaTimeoutMs,
        retries: config.ollamaRetries,
        backoffMs: config.ollamaRetryBackoffMs,
        label: "Ollama request failed",
        code: "ollama_failed"
      }
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
      provider: "ollama",
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

  // `provider` and `model` travel with the client so the caller can say which
  // backend produced a map without having to re-derive it from the config — with
  // the switch in the UI, the config default is no longer the whole answer.
  return { provider: "ollama", model: config.ollamaModel, generate, health };
}

module.exports = { createOllamaClient, fetchWithRetry, UpstreamError };
