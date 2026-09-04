/**
 * Chrome around the canvas: status line, toasts, inspector, legend, empty
 * state, theme and the inline label editor. Nothing here mutates the graph —
 * it reads state and reflects it in the DOM.
 */

import {
  state,
  NODE_TYPES,
  EDGE_TYPES,
  nodeById,
  degreeOf,
  matchesQuery,
  typeCounts,
  canUndo,
  canRedo,
  findSelected
} from "./state.js";

export const el = new Proxy(
  {},
  {
    get: (cache, id) => {
      if (!(id in cache)) cache[id] = document.getElementById(id);
      return cache[id];
    }
  }
);

const THEME_KEY = "mindmap-theme";

/* ------------------------------------------------------------------ */
/* Status, toasts, busy state                                          */
/* ------------------------------------------------------------------ */

export function setStatus(text, tone = "idle") {
  el.status.textContent = text;
  el.status.dataset.tone = tone;
}

export function setBusy(busy) {
  el.generate.disabled = busy;
  el.progress.hidden = !busy;
  el.generateLabel.textContent = busy ? "Reading transcript…" : "Generate mind map";
}

export function toast(message, tone = "info", duration = 2600) {
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.tone = tone;
  node.textContent = message;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add("out");
    node.addEventListener("animationend", () => node.remove(), { once: true });
  }, duration);
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

export function initTheme(onChange) {
  const stored = localStorage.getItem(THEME_KEY);
  const preferred =
    stored || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.dataset.theme = preferred;

  el.themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    onChange?.(next);
  });
}

/* ------------------------------------------------------------------ */
/* Chips (node/edge type pickers and the legend)                       */
/* ------------------------------------------------------------------ */

function chip(label, colorVar, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `chip ${extraClass}`.trim();
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", "false");
  button.style.setProperty("--chip-color", `var(${colorVar})`);
  button.innerHTML = `<span class="swatch"></span><span class="chip-label">${label}</span>`;
  return button;
}

export function buildChips({ onNodeType, onEdgeType, onLegendToggle }) {
  NODE_TYPES.forEach((type) => {
    const button = chip(type, `--c-${type}`);
    button.dataset.type = type;
    button.addEventListener("click", () => onNodeType(type));
    el.nodeTypeChips.appendChild(button);
  });

  EDGE_TYPES.forEach((type) => {
    const button = chip(type, `--e-${type}`);
    button.dataset.type = type;
    button.addEventListener("click", () => onEdgeType(type));
    el.edgeTypeChips.appendChild(button);
  });

  NODE_TYPES.forEach((type) => {
    const button = chip(type, `--c-${type}`);
    button.dataset.type = type;
    button.setAttribute("role", "switch");
    button.title = `Show or hide ${type} nodes`;
    const count = document.createElement("span");
    count.className = "count";
    button.appendChild(count);
    button.addEventListener("click", () => onLegendToggle(type));
    el.legend.appendChild(button);
  });
}

/* ------------------------------------------------------------------ */
/* Panel synchronisation                                               */
/* ------------------------------------------------------------------ */

export function syncPanels() {
  syncView();
  syncInspector();
  syncLegend();
  syncToolbar();
  syncEmptyState();
  syncSearchCount();
  syncModeBanner();
}

function syncView() {
  const notes = state.view === "notes";
  el.notes.hidden = !notes;
  el.viewMap.setAttribute("aria-selected", String(!notes));
  el.viewNotes.setAttribute("aria-selected", String(notes));
  // Zoom and fit belong to the canvas; the note board scrolls instead.
  el.zoomBar.hidden = notes;
}

function syncInspector() {
  const selection = state.selection;
  const target = findSelected();

  if (!selection || !target) {
    el.inspector.hidden = true;
    return;
  }

  el.inspector.hidden = false;
  const isNode = selection.kind === "node";
  el.nodeInspector.hidden = !isNode;
  el.edgeInspector.hidden = isNode;
  el.inspectorTitle.textContent = isNode ? "Selected node" : "Selected connection";

  if (isNode) {
    if (document.activeElement !== el.nodeLabel) el.nodeLabel.value = target.label;
    const degree = degreeOf(target.id);
    el.nodeMeta.textContent = `${degree} connection${degree === 1 ? "" : "s"}`;
    markChips(el.nodeTypeChips, target.type);
  } else {
    const from = nodeById(target.from);
    const to = nodeById(target.to);
    el.edgeEndpoints.innerHTML = `<strong>${escapeHtml(from?.label || "?")}</strong> → <strong>${escapeHtml(to?.label || "?")}</strong>`;
    markChips(el.edgeTypeChips, target.type);
  }
}

function markChips(container, activeType) {
  container.querySelectorAll(".chip").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.type === activeType));
  });
}

function syncLegend() {
  const counts = typeCounts();
  el.legend.querySelectorAll(".chip").forEach((button) => {
    const type = button.dataset.type;
    const hidden = state.hiddenTypes.has(type);
    button.classList.toggle("off", hidden);
    button.setAttribute("aria-checked", String(!hidden));
    button.querySelector(".count").textContent = counts[type] ?? 0;
  });
}

function syncToolbar() {
  el.undo.disabled = !canUndo();
  el.redo.disabled = !canRedo();
  el.toggleEdge.setAttribute("aria-pressed", String(state.connectMode));
  el.graph.classList.toggle("connect-mode", state.connectMode);
}

function syncEmptyState() {
  el.empty.hidden = state.nodes.length > 0;
}

function syncSearchCount() {
  if (!state.query) {
    el.searchCount.hidden = true;
    return;
  }
  const hits = state.nodes.filter(matchesQuery);
  el.searchCount.hidden = false;
  el.searchCount.textContent = `${hits.length}`;
}

function syncModeBanner() {
  el.modeBanner.hidden = !state.connectMode;
  if (!state.connectMode) return;
  const source = state.pendingSourceId ? nodeById(state.pendingSourceId) : null;
  el.modeBannerText.textContent = source
    ? `Connect mode — now click the target node (from “${source.label}”)`
    : "Connect mode — click the source node";
}

/* ------------------------------------------------------------------ */
/* Sidebar & transcript                                                */
/* ------------------------------------------------------------------ */

export function initSidebar(onResize) {
  el.toggleSidebar.addEventListener("click", () => {
    const collapsed = el.app.classList.toggle("collapsed");
    el.toggleSidebar.setAttribute("aria-label", collapsed ? "Show panel" : "Hide panel");
    el.toggleSidebar.title = collapsed ? "Show panel" : "Hide panel";
    setTimeout(() => onResize?.(), 300);
  });
}

export function updateCharCount() {
  const length = el.transcript.value.length;
  el.charCount.textContent = `${length.toLocaleString()} character${length === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ */
/* Inline label editor                                                 */
/* ------------------------------------------------------------------ */

let closeInlineEditor = null;

export function openInlineEditor(node, graph, onCommit) {
  closeInlineEditor?.();
  const input = el.inlineEdit;
  const place = () => {
    const { x, y } = graph.screenPosition(node);
    input.style.left = `${x}px`;
    input.style.top = `${y}px`;
  };

  input.value = node.label;
  input.hidden = false;
  place();
  input.focus();
  input.select();

  const onKey = (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    // Keep the key inside the editor: the document-level shortcut handler would
    // otherwise re-open the editor on Enter, or clear the selection on Escape.
    event.stopPropagation();
    finish(event.key === "Enter");
  };

  function finish(commit) {
    if (!closeInlineEditor) return;
    const value = input.value.trim();
    closeInlineEditor = null;
    input.hidden = true;
    input.removeEventListener("keydown", onKey);
    input.removeEventListener("blur", onBlur);
    // Hand focus back to the document, otherwise the hidden input keeps it and
    // every keyboard shortcut is swallowed as "the user is typing".
    input.blur();
    if (commit && value && value !== node.label) onCommit(value);
  }

  const onBlur = () => finish(true);

  input.addEventListener("keydown", onKey);
  input.addEventListener("blur", onBlur);
  closeInlineEditor = () => finish(false);
}

export const isInlineEditorOpen = () => Boolean(closeInlineEditor);
export const dismissInlineEditor = () => closeInlineEditor?.();

/* ------------------------------------------------------------------ */

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );
}
