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
  const view = state.view;
  el.notes.hidden = view !== "notes";
  // `hidden` is a property of HTMLElement, and the flow canvas is an <svg> —
  // an SVGSVGElement, which inherits from Element and never sees that property.
  // Assigning to it there sets a plain expando that reads back correctly and
  // changes nothing on screen, so the attribute has to be written directly.
  el.flow.toggleAttribute("hidden", view !== "flow");
  el.viewMap.setAttribute("aria-selected", String(view === "map"));
  el.viewNotes.setAttribute("aria-selected", String(view === "notes"));
  el.viewFlow.setAttribute("aria-selected", String(view === "flow"));
  // Zoom and fit belong to a canvas; the note board scrolls instead. The flow
  // view is a canvas like the map, so it keeps them.
  el.zoomBar.hidden = view === "notes";
  // The flow diagram has no hand-placed nodes to hand back.
  el.rearrange.hidden = view !== "map";
  if (view !== "flow") {
    el.flowBar.hidden = true;
    el.flowEmpty.hidden = true;
  }
}

/**
 * The caption strip under the flow diagram.
 *
 * A layered causal diagram carries three conventions the picture cannot state
 * for itself — which way it is read, what a sign on an arrow means, and what R
 * and B stand for — and a reader who does not already know them reads the
 * diagram wrong rather than not at all. So they are written under it, and only
 * the ones the diagram on screen actually uses: a key for a notation that is
 * not there is noise, and noise is what makes a legend stop being read.
 *
 * @param {ReturnType<ReturnType<import("./flow.js").createFlow>["summary"]>} summary
 */
export function syncFlowCaption(summary) {
  if (state.view !== "flow") return;

  el.flowEmpty.hidden = summary.ok;
  el.flowBar.hidden = !summary.ok;
  if (!summary.ok) {
    el.flowEmptyWhy.innerHTML = state.nodes.length
      ? 'This view draws the arrows that claim an influence — <em>causes</em>, <em>supports</em> and <em>contrasts</em>. This map has none of those yet, only plain <em>relates</em> links.'
      : "There is no map yet. Generate one from a transcript, or add a few nodes and connect them.";
    return;
  }

  const loops = summary.loops.length;
  const parts = [
    `${summary.nodes} factor${summary.nodes === 1 ? "" : "s"}`,
    `${summary.depth} step${summary.depth === 1 ? "" : "s"} deep`
  ];
  if (loops) parts.push(`${loops} feedback loop${loops === 1 ? "" : "s"}`);
  // Concepts the map holds that no arrow of influence touches. Said out loud,
  // because a diagram quietly showing eleven of a map's thirty concepts is a
  // diagram the reader will trust for something it never claimed.
  if (summary.omitted) parts.push(`${summary.omitted} not in any chain`);
  el.flowStat.textContent = `— ${parts.join(", ")}`;

  const keys = [];
  if (summary.signs.plus) keys.push(["plus", "+", "same direction"]);
  if (summary.signs.minus) keys.push(["minus", "−", "opposite direction"]);
  if (summary.loops.some((l) => l.kind === "reinforcing")) {
    keys.push(["reinforcing", "R", "reinforcing loop"]);
  }
  if (summary.loops.some((l) => l.kind === "balancing")) {
    keys.push(["balancing", "B", "balancing loop"]);
  }

  el.flowKeys.textContent = "";
  keys.forEach(([kind, mark, meaning]) => {
    const key = document.createElement("span");
    key.className = "flow-key";
    key.dataset.key = kind;
    const badge = document.createElement("b");
    badge.textContent = mark;
    key.appendChild(badge);
    key.appendChild(document.createTextNode(meaning));
    el.flowKeys.appendChild(key);
  });
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
  // The flow view has an empty state of its own, which can say the more useful
  // thing: a map with plenty of nodes and no influence between them is not the
  // same problem as no map at all.
  el.empty.hidden = state.nodes.length > 0 || state.view === "flow";
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

/**
 * "just now", "6 min ago", "3 days ago" — how a saved map says when it was last
 * touched. A timestamp would be exact and useless: what the list is scanned for
 * is which map is the recent one.
 */
export function relativeTime(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) {
    const hours = Math.round(seconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(seconds / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
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
