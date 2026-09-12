"use strict";

const {
  UpstreamError,
  describeError,
  fetchWithRetry,
  responseError,
  tryModels
} = require("./upstream");

/**
 * DeepSeek's failing statuses, as the sentence that says what to do about them.
 * 402 is the one a first run is most likely to hit: DeepSeek is prepaid, so a new
 * key with no credit on the account fails every call until it is topped up.
 */
function explainStatus(status) {
  if (status === 401) return "the API key was refused — check DEEPSEEK_API_KEY in .env";
  if (status === 402) return "the DeepSeek account has no balance left — top it up at https://platform.deepseek.com";
  if (status === 429) return "DeepSeek is rate-limiting this key — too many requests at once";
  if (status === 503) return "DeepSeek is overloaded — try again in a minute";
  return "";
}

/** Busy, rate-limited or briefly broken: DeepSeek's own advice is to try again. */
const isBusyStatus = (status) => status === 503 || status === 429 || status === 500;

/** A model id DeepSeek does not have. */
const isBadModelStatus = (status, body) =>
  status === 404 || ((status === 400 || status === 422) && /model/i.test(String(body || "")));

/** The answer text, or "" when there is none. */
function readText(data) {
  const message = data && data.choices && data.choices[0] && data.choices[0].message;
  return message && typeof message.content === "string" ? message.content.trim() : "";
}

/**
 * A client for DeepSeek's API, shaped exactly like the Ollama and Gemini ones:
 * `generate(prompt)` and `health()`, with the answer wrapped as `{ response }` so
 * lib/json-extract.js reads it without knowing where it came from.
 *
 * Two differences from Gemini decide how the call is made:
 *
 * - **No schema.** DeepSeek's JSON mode promises valid JSON but takes no schema, so
 *   the `schema` argument the other clients use is ignored here. What keeps the
 *   answer in shape is the prompt, which already spells the structure out with an
 *   example — DeepSeek's docs ask for exactly that, and for the word "json" to
 *   appear in it — and lib/graph.js, which drops whatever does not fit.
 *
 * - **Thinking is off.** V4.1 reasons before it answers unless told not to, and
 *   while it does it ignores the temperature. Extraction wants the greedy sampler
 *   every other backend uses (see lib/config.js), and an answer in one second
 *   rather than twenty.
 */
function createDeepSeekClient(config, fetchImpl = fetch) {
  const model = config.deepseekModel;
  const apiKey = config.deepseekApiKey;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  function requireKey() {
    if (!apiKey) {
      throw new UpstreamError(
        "DeepSeek is selected but no API key is configured. Put DEEPSEEK_API_KEY in .env and restart the server.",
        "deepseek_not_configured",
        ""
      );
    }
  }

  async function callModel(targetModel, prompt) {
    const response = await fetchWithRetry(
      fetchImpl,
      `${config.deepseekUrl}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          temperature: config.ollamaTemperature,
          max_tokens: config.deepseekMaxOutputTokens,
          stream: false
        })
      },
      {
        timeoutMs: config.deepseekTimeoutMs,
        retries: config.deepseekRetries,
        backoffMs: config.deepseekRetryBackoffMs,
        label: "DeepSeek request failed",
        code: "deepseek_failed"
      }
    );

    if (!response.ok) {
      throw await responseError(response, "DeepSeek request failed", "deepseek_failed", explainStatus);
    }
    return response.json();
  }

  /**
   * Ask for one JSON object. DeepSeek documents that JSON mode "may occasionally
   * return empty content", so an empty answer is returned as one — the chunk gets
   * re-asked and, failing that, skipped with a warning — rather than thrown, which
   * would stop the whole run.
   */
  async function generate(prompt) {
    requireKey();

    return tryModels(
      [model, ...config.deepseekFallbackModels],
      async (targetModel) => {
        const data = await callModel(targetModel, prompt);
        const text = readText(data);
        if (text) return { response: text, model: targetModel };
        const reason = (data && data.choices && data.choices[0] && data.choices[0].finish_reason) || "no choice returned";
        // `length` is an answer cut off by max_tokens; `content_filter` is a refusal.
        return { response: "", model: targetModel, empty: `finish_reason ${reason}` };
      },
      (err) => isBusyStatus(err.status) || isBadModelStatus(err.status, err.body)
    );
  }

  /** Is the key there, does the API answer, and does it know the configured model? */
  async function health() {
    const result = {
      provider: "deepseek",
      model,
      configured: Boolean(apiKey),
      reachable: false,
      modelAvailable: false,
      models: []
    };

    if (!apiKey) {
      result.error = "DEEPSEEK_API_KEY is not set";
      return result;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.deepseekHealthTimeoutMs);
    try {
      const response = await fetchImpl(`${config.deepseekUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal
      });
      if (!response.ok) {
        const hint = explainStatus(response.status);
        result.error = hint ? `Status ${response.status} — ${hint}` : `Status ${response.status}`;
        return result;
      }
      const data = await response.json();
      result.reachable = true;
      result.models = Array.isArray(data && data.data)
        ? data.data.map((m) => String((m && m.id) || "")).filter(Boolean)
        : [];
      result.modelAvailable = result.models.includes(model);
      return result;
    } catch (err) {
      result.error = err && err.name === "AbortError" ? "Timed out" : describeError(err);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { provider: "deepseek", model, generate, health };
}

module.exports = { createDeepSeekClient };
