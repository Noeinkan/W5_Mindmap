"use strict";

const { createOllamaClient } = require("./ollama");
const { createGeminiClient } = require("./gemini");
const { createDeepSeekClient } = require("./deepseek");
const { UpstreamError } = require("./upstream");

/**
 * Which model answers a run, and how the browser is told what it may choose.
 *
 * Everything downstream — lib/extract.js, lib/link.js — takes a client with a
 * `generate` and a `health` and never asks which one it got. That seam already
 * existed for testing; this module is what makes it a user-visible choice.
 */

const PROVIDERS = [
  {
    id: "ollama",
    label: "Ollama — on this machine",
    // Free and private, and it never leaves the laptop; the price is that it is as
    // fast as the graphics card and needs `ollama serve` running.
    hint: "Runs locally. Free, private, slower."
  },
  {
    id: "gemini",
    label: "Google Gemini — in the cloud",
    // The transcript is sent to Google, which is the thing to be aware of before
    // switching: the point of the local option is that it is not.
    hint: "Sends the transcript to Google. Faster, costs per run."
  },
  {
    id: "deepseek",
    label: "DeepSeek — in the cloud",
    // DeepSeek's privacy policy states that API data is processed and stored in
    // the People's Republic of China. For client meeting transcripts that can be a
    // contractual question, so it is said where the choice is made.
    hint: "Sends the transcript to DeepSeek, which stores API data in China. Cheapest cloud option."
  }
];

const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

/**
 * The cloud providers, which differ only in names: the key that unlocks them, the
 * models they offer, and the client that calls them. Kept as one table so that a
 * fourth provider is a row here rather than another copy of every branch below.
 */
const CLOUD = {
  gemini: {
    name: "Gemini",
    keySetting: "GEMINI_API_KEY",
    key: (config) => config.geminiApiKey,
    model: (config) => config.geminiModel,
    models: (config) => config.geminiModels,
    fallbacks: (config) => config.geminiFallbackModels,
    create: (config, model, fetchImpl) =>
      createGeminiClient(model ? { ...config, geminiModel: model } : config, fetchImpl)
  },
  deepseek: {
    name: "DeepSeek",
    keySetting: "DEEPSEEK_API_KEY",
    key: (config) => config.deepseekApiKey,
    model: (config) => config.deepseekModel,
    models: (config) => config.deepseekModels,
    fallbacks: (config) => config.deepseekFallbackModels,
    create: (config, model, fetchImpl) =>
      createDeepSeekClient(model ? { ...config, deepseekModel: model } : config, fetchImpl)
  }
};

/**
 * What the Model dropdown shows for a cloud model id. The id is what the API and
 * .env need, but it is not always the name the model is known by: DeepSeek serves
 * V4.1 Flash as plain `deepseek-flash`, and a dropdown reading only that hides the
 * version someone is looking for. An id with no entry here — one added through
 * GEMINI_MODELS or DEEPSEEK_MODELS later — is shown as it is.
 */
const MODEL_LABELS = {
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash-Lite",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "deepseek-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro"
};

/**
 * An Ollama model id: a name, optionally under one or two namespaces
 * (`library/llama3.2`, `hf.co/user/repo`), optionally with a `:tag`.
 *
 * Loose enough to take whatever is pulled on the machine — the list of installed
 * models is the machine's business, not this server's — and tight enough that a
 * URL or a sentence is not mistaken for one.
 */
const OLLAMA_MODEL_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,2}(?::[A-Za-z0-9._-]+)?$/;
const OLLAMA_MODEL_MAX_LENGTH = 120;

/** The requested provider if it is one we have, otherwise the configured default. */
function normalizeProvider(requested, config) {
  const wanted = String(requested || "").trim().toLowerCase();
  return PROVIDER_IDS.includes(wanted) ? wanted : config.aiProvider;
}

/** Every model this server will accept for a cloud provider, not just the dropdown's. */
function allowedModels(cloud, config) {
  return new Set([cloud.model(config), ...cloud.models(config), ...cloud.fallbacks(config)]);
}

/**
 * Build the client for one request.
 *
 * The model override is checked rather than trusted. For a cloud provider that is
 * not pedantry: the id decides the bill, and a dropdown is only a suggestion to
 * anything that can edit the page. An id that is not on the list is refused with
 * its own code so the route can answer 400 instead of blaming the model.
 */
function createAiClient(config, { provider, model } = {}, fetchImpl = fetch) {
  const id = normalizeProvider(provider, config);
  const wantedModel = String(model || "").trim();
  const cloud = CLOUD[id];

  if (cloud) {
    if (!cloud.key(config)) {
      throw new UpstreamError(
        `${cloud.name} is selected but no API key is configured. Put ${cloud.keySetting} in .env and restart the server.`,
        "provider_unavailable",
        ""
      );
    }
    const allowed = allowedModels(cloud, config);
    if (wantedModel && !allowed.has(wantedModel)) {
      throw new UpstreamError(
        `Unknown ${cloud.name} model "${wantedModel}".`,
        "unknown_model",
        `Allowed: ${[...allowed].join(", ")}`
      );
    }
    return cloud.create(config, wantedModel, fetchImpl);
  }

  if (
    wantedModel &&
    (wantedModel.length > OLLAMA_MODEL_MAX_LENGTH || !OLLAMA_MODEL_PATTERN.test(wantedModel))
  ) {
    throw new UpstreamError(`Unknown Ollama model "${wantedModel}".`, "unknown_model", "");
  }
  return createOllamaClient(
    wantedModel ? { ...config, ollamaModel: wantedModel } : config,
    fetchImpl
  );
}

/**
 * What the browser needs to draw the switch: the providers, whether each can
 * actually be used, and the models to offer for it.
 *
 * Ollama's list is whatever is pulled on this machine, so it is read from the
 * running server — that is the only way to know. A cloud provider's is its
 * configured list (GEMINI_MODELS, DEEPSEEK_MODELS), read without a network call:
 * asking for the catalogue on every page load would spend a call to tell us
 * something the configuration already knows.
 */
async function describeProviders(config, fetchImpl = fetch) {
  const ollama = await createOllamaClient(config, fetchImpl).health();

  return {
    active: config.aiProvider,
    providers: PROVIDERS.map((provider) => {
      const cloud = CLOUD[provider.id];
      if (!cloud) {
        return {
          ...provider,
          available: true,
          ready: ollama.reachable && ollama.modelAvailable,
          model: config.ollamaModel,
          // Keep the configured model on the list even when Ollama is down or has
          // not pulled it: the dropdown must still show what a run would use, and
          // the note underneath is where "not installed" belongs.
          models: [...new Set([config.ollamaModel, ...ollama.models])],
          note: ollamaNote(ollama, config)
        };
      }
      const hasKey = Boolean(cloud.key(config));
      const models = [...new Set([cloud.model(config), ...cloud.models(config)])];
      return {
        ...provider,
        available: hasKey,
        ready: hasKey,
        model: cloud.model(config),
        models,
        modelLabels: Object.fromEntries(models.map((id) => [id, MODEL_LABELS[id] || id])),
        // Deliberately not naming the default model: the dropdown next to this
        // line already says which one is selected, and the two disagreeing reads
        // as a bug.
        note: hasKey
          ? "API key loaded — ready."
          : `Add ${cloud.keySetting} to .env in the project folder, then restart the server.`
      };
    })
  };
}

/** The one sentence that says what to do about Ollama, if anything. */
function ollamaNote(health, config) {
  if (!health.reachable) return `Not answering at ${config.ollamaUrl}. Start it with: ollama serve`;
  if (!health.modelAvailable) {
    return `Running, but ${config.ollamaModel} is not installed. Pull it with: ollama pull ${config.ollamaModel}`;
  }
  return `Running, ${health.models.length} model${health.models.length === 1 ? "" : "s"} installed.`;
}

module.exports = { PROVIDERS, PROVIDER_IDS, normalizeProvider, createAiClient, describeProviders };
