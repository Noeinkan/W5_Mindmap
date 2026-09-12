/**
 * The AI provider / model switch above the Generate button.
 *
 * The server keeps no preference of its own — it answers with what is *possible*
 * (`GET /api/providers`) and takes the choice on each run. What this module owns is
 * the other half: drawing the two dropdowns from that answer, remembering what was
 * picked in localStorage, and handing `{ provider, model }` to the run.
 *
 * The model chosen for each provider is remembered separately, so flipping to
 * Gemini and back does not lose which Ollama model you were on.
 */

import { el } from "./ui.js";

const KEY = "mindmap.model.v1";

/** What came back from /api/providers, or null until it does. */
let catalogue = null;

/** { provider: string, models: { [providerId]: string } } */
let choice = readStored();

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function readStored() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return { provider: null, models: {} };
    return {
      provider: typeof parsed.provider === "string" ? parsed.provider : null,
      models: parsed.models && typeof parsed.models === "object" ? parsed.models : {}
    };
  } catch {
    // A private window, cleared site data, a half-written entry: the switch works
    // without its memory, it just starts on the server's default every time.
    return { provider: null, models: {} };
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    /* Not worth a toast: the only cost is that the choice is forgotten on reload. */
  }
}

/* ------------------------------------------------------------------ */
/* Reading the catalogue                                               */
/* ------------------------------------------------------------------ */

const providerById = (id) =>
  (catalogue && catalogue.providers.find((p) => p.id === id)) || null;

/**
 * The provider a run should use: what was picked, unless it has become unusable —
 * a key removed from .env between two visits — in which case the first one that
 * works, so the button never opens onto a guaranteed failure.
 */
function activeProviderId() {
  if (!catalogue) return null;
  const stored = providerById(choice.provider);
  if (stored && stored.available) return stored.id;
  const server = providerById(catalogue.active);
  if (server && server.available) return server.id;
  const usable = catalogue.providers.find((p) => p.available);
  return usable ? usable.id : catalogue.providers[0].id;
}

/** The model for a provider: the remembered one if it is still offered, else its default. */
function modelFor(providerId) {
  const provider = providerById(providerId);
  if (!provider) return "";
  const remembered = choice.models[providerId];
  if (remembered && provider.models.includes(remembered)) return remembered;
  return provider.model || provider.models[0] || "";
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

function option(value, label, { disabled = false } = {}) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  node.disabled = disabled;
  return node;
}

function renderProviders() {
  const active = activeProviderId();
  el.aiProvider.replaceChildren(
    ...catalogue.providers.map((provider) =>
      option(
        provider.id,
        // The reason it cannot be picked belongs in the option itself: a greyed
        // line with no explanation reads as a bug.
        provider.available ? provider.label : `${provider.label} — no API key`,
        { disabled: !provider.available }
      )
    )
  );
  el.aiProvider.value = active;
}

function renderModels() {
  const provider = providerById(el.aiProvider.value);
  if (!provider) return;
  // The value stays the id the server needs; the text is the model's own name
  // where the server knows one ("DeepSeek V4.1 Flash" for `deepseek-flash`).
  el.aiModel.replaceChildren(
    ...provider.models.map((id) => option(id, modelLabel(provider, id)))
  );
  el.aiModel.value = modelFor(provider.id);
  el.aiModel.disabled = !provider.available || provider.models.length < 2;
  el.modelNote.textContent = `${provider.hint} ${provider.note}`.trim();
}

function render() {
  renderProviders();
  renderModels();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

/**
 * Load the catalogue and show the switch. Failing is not fatal: the row stays
 * hidden and runs go out with no provider named, which the server answers with its
 * own configured default — exactly the behaviour before this switch existed.
 *
 * @param {{onChange?: (choice: {provider: string, model: string}) => void}} [handlers]
 */
export async function initModelPicker(handlers = {}) {
  try {
    const response = await fetch("/api/providers");
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.providers) || !data.providers.length) {
      throw new Error("No providers returned");
    }
    catalogue = data;
  } catch {
    el.modelPicker.hidden = true;
    return null;
  }

  render();
  el.modelPicker.hidden = false;

  el.aiProvider.addEventListener("change", () => {
    choice.provider = el.aiProvider.value;
    renderModels();
    persist();
    handlers.onChange?.(currentChoice());
  });

  el.aiModel.addEventListener("change", () => {
    choice.models[el.aiProvider.value] = el.aiModel.value;
    persist();
    handlers.onChange?.(currentChoice());
  });

  // The stored choice is only now known to be valid — an unavailable provider was
  // just swapped for a usable one — so write back what is actually on screen.
  choice.provider = el.aiProvider.value;
  choice.models[el.aiProvider.value] = el.aiModel.value;
  persist();

  return currentChoice();
}

/**
 * What to send with a run. `{}` before the catalogue has loaded, or after it
 * failed: an absent provider means "whatever the server is configured for".
 */
export function currentChoice() {
  if (!catalogue) return {};
  return { provider: el.aiProvider.value, model: el.aiModel.value };
}

/** The name to show for a model id: the server's label if it sent one, else the id. */
function modelLabel(provider, id) {
  return (provider && provider.modelLabels && provider.modelLabels[id]) || id;
}

/**
 * A phrase for the status line: "DeepSeek V4.1 Flash" where the model has a name
 * of its own — it already says whose it is — and "Ollama (gemma3:4b)" where the
 * id is all there is.
 */
export function describeChoice() {
  const { provider, model } = currentChoice();
  if (!provider) return "";
  const known = providerById(provider);
  const label = modelLabel(known, model);
  if (model && label !== model) return label;
  const name = known ? known.label.split("—")[0].trim() : provider;
  return model ? `${name} (${model})` : name;
}
