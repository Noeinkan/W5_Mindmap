"use strict";

const { createOllamaClient } = require("./ollama");
const { createGeminiClient } = require("./gemini");
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
  }
];

const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

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

/** Every Gemini model this server will accept, not just the ones in the dropdown. */
function allowedGeminiModels(config) {
  return new Set([config.geminiModel, ...config.geminiModels, ...config.geminiFallbackModels]);
}

/**
 * Build the client for one request.
 *
 * The model override is checked rather than trusted. For Gemini that is not
 * pedantry: the id decides the bill, and a dropdown is only a suggestion to
 * anything that can edit the page. An id that is not on the list is refused with
 * its own code so the route can answer 400 instead of blaming the model.
 */
function createAiClient(config, { provider, model } = {}, fetchImpl = fetch) {
  const id = normalizeProvider(provider, config);
  const wantedModel = String(model || "").trim();

  if (id === "gemini") {
    if (!config.geminiApiKey) {
      throw new UpstreamError(
        "Gemini is selected but no API key is configured. Put GEMINI_API_KEY in .env and restart the server.",
        "provider_unavailable",
        ""
      );
    }
    if (wantedModel && !allowedGeminiModels(config).has(wantedModel)) {
      throw new UpstreamError(
        `Unknown Gemini model "${wantedModel}".`,
        "unknown_model",
        `Allowed: ${[...allowedGeminiModels(config)].join(", ")}`
      );
    }
    return createGeminiClient(
      wantedModel ? { ...config, geminiModel: wantedModel } : config,
      fetchImpl
    );
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
 * What the browser needs to draw the switch: the two providers, whether each can
 * actually be used, and the models to offer for it.
 *
 * Ollama's list is whatever is pulled on this machine, so it is read from the
 * running server — that is the only way to know. Gemini's is the configured list
 * (GEMINI_MODELS), read without a network call: asking Google for its catalogue on
 * every page load would spend a quota call to tell us something a constant already
 * knows, and the answer includes dozens of models nobody wants here.
 */
async function describeProviders(config, fetchImpl = fetch) {
  const ollama = await createOllamaClient(config, fetchImpl).health();

  const models = {
    // Keep the configured model on the list even when Ollama is down or has not
    // pulled it: the dropdown must still show what a run would use, and the
    // status line underneath is where "not installed" belongs.
    ollama: [...new Set([config.ollamaModel, ...ollama.models])],
    gemini: [...new Set([config.geminiModel, ...config.geminiModels])]
  };

  const available = {
    ollama: true,
    gemini: Boolean(config.geminiApiKey)
  };

  const ready = {
    ollama: ollama.reachable && ollama.modelAvailable,
    gemini: Boolean(config.geminiApiKey)
  };

  const note = {
    ollama: ollamaNote(ollama, config),
    // Deliberately not naming the default model: the dropdown next to this line
    // already says which one is selected, and the two disagreeing reads as a bug.
    gemini: config.geminiApiKey
      ? "API key loaded — ready."
      : "Add GEMINI_API_KEY to .env in the project folder, then restart the server."
  };

  return {
    active: config.aiProvider,
    providers: PROVIDERS.map((provider) => ({
      ...provider,
      available: available[provider.id],
      ready: ready[provider.id],
      model: provider.id === "gemini" ? config.geminiModel : config.ollamaModel,
      models: models[provider.id],
      note: note[provider.id]
    }))
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
