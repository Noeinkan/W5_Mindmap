"use strict";

const { graphResponseSchema } = require("./schema");
const { UpstreamError, describeError, fetchWithRetry } = require("./upstream");

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Gemini's `responseSchema` is OpenAPI-flavoured, not JSON Schema. Two differences
 * bite:
 *
 * - the type is an enum name, so it has to be upper-case ("OBJECT", not "object");
 * - `additionalProperties` is rejected outright outside the enterprise tier, which
 *   is the same trap the capsar_io service hit and sanitises for.
 *
 * `propertyOrdering` is Google's own recommendation: told the order to emit fields
 * in, the model wanders less. lib/schema.js stays the single definition of the
 * shape — this only translates it on the way out.
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  const out = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items);

  if (schema.properties && typeof schema.properties === "object") {
    out.properties = {};
    Object.keys(schema.properties).forEach((key) => {
      out.properties[key] = toGeminiSchema(schema.properties[key]);
    });
    out.propertyOrdering = Object.keys(schema.properties);
  }

  return out;
}

/** Gemini 3 reasons before it answers and cannot be told not to. */
const isGemini3 = (model) => /^gemini-3/i.test(String(model || ""));

/**
 * On Gemini 3, `maxOutputTokens` is one budget covering the thinking *and* the
 * answer. A cap sized for the answer alone is spent entirely on thinking and the
 * call comes back empty — so the cap the caller asked for gets headroom added on
 * those models, and only those.
 */
const THINKING_HEADROOM_TOKENS = 2048;

/** A 503 or a 429: the model is there, it is just busy. Worth a different one. */
function isBusyStatus(status) {
  return status === 503 || status === 429;
}

/** A 404 or a 400 naming the model: the id is wrong or the model is retired. */
function isBadModelStatus(status, body) {
  if (status === 404) return true;
  return status === 400 && /model/i.test(String(body || ""));
}

/** The answer text, or "" when the candidate carried no text part. */
function readText(data) {
  const parts =
    data && data.candidates && data.candidates[0] && data.candidates[0].content
      ? data.candidates[0].content.parts
      : null;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

/**
 * Why an answer came back empty, in words rather than a shrug. `MAX_TOKENS` means
 * the JSON was cut off mid-object and the cap wants raising; `SAFETY` means the
 * chunk was refused, which on a meeting transcript is worth knowing verbatim.
 */
function describeEmptyAnswer(data) {
  const candidate = (data && data.candidates && data.candidates[0]) || {};
  const reason = candidate.finishReason || "no candidate returned";
  const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
  return blocked ? `finishReason ${reason}, prompt blocked: ${blocked}` : `finishReason ${reason}`;
}

/**
 * A client for Google's Gemini API, shaped exactly like the Ollama one: the same
 * `generate(prompt, schema)` and `health()`, and an answer wrapped as
 * `{ response }` so lib/json-extract.js reads it without knowing which backend it
 * came from.
 *
 * Called over plain REST rather than through @google/genai: the whole repository
 * depends on express and nothing else, and the two calls used here are a POST and
 * a GET.
 */
function createGeminiClient(config, fetchImpl = fetch) {
  const model = config.geminiModel;
  const apiKey = config.geminiApiKey;

  const headers = {
    "Content-Type": "application/json",
    // In a header rather than the query string: a URL ends up in proxy logs and
    // in the error messages this app prints, and an API key should be in neither.
    "x-goog-api-key": apiKey
  };

  function requireKey() {
    if (!apiKey) {
      throw new UpstreamError(
        "Gemini is selected but no API key is configured. Put GEMINI_API_KEY in .env and restart the server.",
        "gemini_not_configured",
        ""
      );
    }
  }

  /** One call to one model. Returns the body, or throws with the status attached. */
  async function callModel(targetModel, body) {
    const response = await fetchWithRetry(
      fetchImpl,
      `${API_BASE}/models/${encodeURIComponent(targetModel)}:generateContent`,
      { method: "POST", headers, body: JSON.stringify(body) },
      {
        timeoutMs: config.geminiTimeoutMs,
        retries: config.geminiRetries,
        backoffMs: config.geminiRetryBackoffMs,
        label: "Gemini request failed",
        code: "gemini_failed"
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const err = new UpstreamError(
        "Gemini request failed",
        "gemini_failed",
        `Status ${response.status}: ${text}`
      );
      err.status = response.status;
      err.body = text;
      throw err;
    }

    return response.json();
  }

  /**
   * Ask the model for one JSON object. `schema` overrides the default graph schema
   * (the linking pass wants edges only).
   *
   * A run is one call per chunk, so a single 503 in the middle of a long book would
   * otherwise cost every chunk after it. The configured fallback models are tried
   * in order when the primary is busy or turns out not to exist — the map keeps
   * building on a slightly different model instead of stopping.
   */
  async function generate(prompt, schema) {
    requireKey();

    const maxOutputTokens = config.geminiMaxOutputTokens;
    const body = (targetModel) => ({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        // The same greedy sampler the Ollama path uses, and for the same reason:
        // extraction is a reading task, so the same chunk should come back the same
        // way twice. See lib/config.js.
        temperature: config.ollamaTemperature,
        topP: config.ollamaTopP,
        maxOutputTokens: isGemini3(targetModel)
          ? maxOutputTokens + THINKING_HEADROOM_TOKENS
          : maxOutputTokens,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(schema || graphResponseSchema)
      }
    });

    const candidates = [model, ...config.geminiFallbackModels].filter(
      (name, index, all) => name && all.indexOf(name) === index
    );

    let lastError;
    for (let i = 0; i < candidates.length; i += 1) {
      const targetModel = candidates[i];
      const hasNext = i < candidates.length - 1;

      let data;
      try {
        data = await callModel(targetModel, body(targetModel));
      } catch (err) {
        const retryable = isBusyStatus(err.status) || isBadModelStatus(err.status, err.body);
        if (retryable && hasNext) {
          lastError = err;
          continue;
        }
        throw err;
      }

      const text = readText(data);
      if (text) return { response: text, model: targetModel };

      // An empty answer is the model's problem, not the network's, so it is not
      // worth another model — lib/extract.js already retries the chunk itself.
      throw new UpstreamError(
        "Gemini returned an empty answer",
        "gemini_empty",
        `model ${targetModel}: ${describeEmptyAnswer(data)}`
      );
    }

    throw lastError || new UpstreamError("Gemini request failed", "gemini_failed", "");
  }

  /**
   * Is the key there, does the API answer, and does it know the configured model?
   * The same question the Ollama health answers, so /api/health can put the two
   * side by side.
   */
  async function health() {
    const result = {
      provider: "gemini",
      model,
      configured: Boolean(apiKey),
      reachable: false,
      modelAvailable: false,
      models: []
    };

    if (!apiKey) {
      result.error = "GEMINI_API_KEY is not set";
      return result;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.geminiHealthTimeoutMs);
    try {
      const response = await fetchImpl(`${API_BASE}/models?pageSize=200`, {
        headers: { "x-goog-api-key": apiKey },
        signal: controller.signal
      });
      if (!response.ok) {
        // 400 and 403 here mean one thing in practice: the key is wrong. Saying so
        // beats "Status 400" on a screen whose only other clue is a dropdown.
        result.error =
          response.status === 400 || response.status === 403
            ? `Status ${response.status} — the API key looks wrong or has no access`
            : `Status ${response.status}`;
        return result;
      }
      const data = await response.json();
      result.reachable = true;
      // The API answers "models/gemini-3.1-flash-lite"; the config names the bare id.
      result.models = Array.isArray(data && data.models)
        ? data.models
            .map((m) => String((m && m.name) || "").replace(/^models\//, ""))
            .filter(Boolean)
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

  return { provider: "gemini", model, generate, health };
}

module.exports = { createGeminiClient, toGeminiSchema, API_BASE };
