/**
 * Single source of truth for the mind map: graph data, selection, view filters
 * and an undo/redo history. Everything that mutates the graph goes through
 * `withHistory` so Ctrl+Z always has something to fall back to.
 */

import {
  NODE_TYPES,
  EDGE_TYPES,
  DEFAULT_TITLE,
  normalizeNodeType,
  normalizeEdgeType
} from "./graph-doc.js";

// The type lists and their fallbacks belong to the saved format, not to this
// module: a map that comes back from a file has to normalise to exactly what the
// live graph normalises to. Re-exported so the rest of the app still reads them
// from the state it is already importing.
export { NODE_TYPES, EDGE_TYPES, normalizeNodeType, normalizeEdgeType };

export const VIEWS = ["map", "notes", "flow"];

export const state = {
  nodes: [],
  edges: [],
  /** @type {{kind: "node"|"edge", id: string}|null} */
  selection: null,
  connectMode: false,
  pendingSourceId: null,
  hiddenTypes: new Set(),
  /**
   * Branches folded away, by the id of the node they hang from. A way of
   * looking at the map rather than a fact about it, so it sits here beside the
   * legend filter and the search box instead of travelling in the document —
   * the same line the app already draws between the map and the view of it.
   */
  collapsed: new Set(),
  query: "",
  /** Which renderer owns the canvas: the map, the note cards, or the flow. */
  view: "map",
  /** Label of the map's centre when the graph has no single natural root. */
  title: DEFAULT_TITLE,
  /**
   * The transcript the map was built from. It lives here rather than only in the
   * textarea because it travels with the saved map: a graph without the words it
   * came from cannot be checked against them later.
   */
  transcript: "",
  nextNodeId: 1,
  nextEdgeId: 1
};

const listeners = new Set();
const undoStack = [];
const redoStack = [];
const HISTORY_LIMIT = 60;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason = "update") {
  listeners.forEach((fn) => fn(reason));
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function snapshot() {
  return {
    // `quote` and `pinned` travel with the snapshot: the first is the whole
    // content of a note card, the second is a position the user placed by hand.
    // Undo used to drop both, so one Ctrl+Z emptied every card on screen.
    nodes: state.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      quote: n.quote,
      x: n.x,
      y: n.y,
      pinned: n.pinned
    })),
    edges: state.edges.map((e) => ({ ...e })),
    title: state.title,
    // Opening a file replaces the transcript along with the map, so undoing that
    // has to put both back. Typing in the box takes no snapshot of its own, so
    // this never fights the user mid-sentence.
    transcript: state.transcript,
    nextNodeId: state.nextNodeId,
    nextEdgeId: state.nextEdgeId
  };
}

function restore(snap) {
  state.nodes = snap.nodes.map((n) => ({ ...n }));
  state.edges = snap.edges.map((e) => ({ ...e }));
  state.title = snap.title;
  state.transcript = snap.transcript ?? state.transcript;
  state.nextNodeId = snap.nextNodeId;
  state.nextEdgeId = snap.nextEdgeId;
  if (state.selection && !findSelected()) state.selection = null;
}

/** Runs `mutator` as one undoable step. */
export function withHistory(mutator) {
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  mutator();
  emit("graph");
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  emit("graph");
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  emit("graph");
  return true;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

export const nodeById = (id) => state.nodes.find((n) => n.id === id) || null;
export const edgeById = (id) => state.edges.find((e) => e.id === id) || null;

export function findSelected() {
  if (!state.selection) return null;
  return state.selection.kind === "node"
    ? nodeById(state.selection.id)
    : edgeById(state.selection.id);
}

export function degreeOf(nodeId) {
  return state.edges.filter((e) => e.from === nodeId || e.to === nodeId).length;
}

export function neighboursOf(nodeId) {
  const set = new Set([nodeId]);
  state.edges.forEach((e) => {
    if (e.from === nodeId) set.add(e.to);
    if (e.to === nodeId) set.add(e.from);
  });
  return set;
}

export function typeCounts() {
  const counts = Object.fromEntries(NODE_TYPES.map((t) => [t, 0]));
  state.nodes.forEach((n) => {
    counts[n.type] = (counts[n.type] || 0) + 1;
  });
  return counts;
}

/* ------------------------------------------------------------------ */
/* Selection & modes                                                   */
/* ------------------------------------------------------------------ */

export function select(kind, id) {
  state.selection = kind && id ? { kind, id } : null;
  emit("selection");
}

export function clearSelection() {
  if (!state.selection) return;
  state.selection = null;
  emit("selection");
}

export function setConnectMode(on) {
  state.connectMode = on;
  state.pendingSourceId = null;
  emit("mode");
}

export function setView(view) {
  if (!VIEWS.includes(view) || state.view === view) return;
  state.view = view;
  emit("view");
}

export function setTitle(title) {
  state.title = String(title || "").trim() || DEFAULT_TITLE;
  emit("graph");
}

/**
 * The transcript in the box, kept for saving. Deliberately silent: this runs on
 * every keystroke, and an "update" here would repaint the whole canvas for a
 * change nothing on it can see.
 */
export function setTranscript(text) {
  state.transcript = String(text || "");
}

export function setQuery(q) {
  state.query = q.trim().toLowerCase();
  emit("filter");
}

export function toggleTypeVisibility(type) {
  if (state.hiddenTypes.has(type)) state.hiddenTypes.delete(type);
  else state.hiddenTypes.add(type);
  emit("filter");
}

export const isVisible = (node) => !state.hiddenTypes.has(node.type);

/**
 * Folds a branch away, or opens it again.
 *
 * "graph", not "filter": a folded branch leaves the tree entirely, so the map
 * has to be laid out again. A branch that kept its place while invisible would
 * save no room, and room is the whole reason to fold one.
 */
export function toggleCollapse(id) {
  if (state.collapsed.has(id)) state.collapsed.delete(id);
  else state.collapsed.add(id);
  emit("graph");
}

/** Opens the named folds. Returns how many of them were actually shut. */
export function openFolds(ids) {
  const shut = ids.filter((id) => state.collapsed.has(id));
  if (!shut.length) return 0;
  shut.forEach((id) => state.collapsed.delete(id));
  emit("graph");
  return shut.length;
}

/** Opens every folded branch. Returns how many there were. */
export function expandAll() {
  const folded = state.collapsed.size;
  if (!folded) return 0;
  state.collapsed.clear();
  emit("graph");
  return folded;
}

/**
 * Search hits. The note view puts the transcript quote on screen, so a search
 * that only looked at labels would dim a card whose visible text holds the word.
 */
export function matchesQuery(node) {
  if (!state.query) return true;
  if (node.label.toLowerCase().includes(state.query)) return true;
  return state.view === "notes" && (node.quote || "").toLowerCase().includes(state.query);
}

/** Edges in and out of a node, kept apart — a note card lists them separately. */
export function linksOf(nodeId) {
  return {
    out: state.edges.filter((e) => e.from === nodeId),
    in: state.edges.filter((e) => e.to === nodeId)
  };
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

function nextIdFrom(ids, prefix) {
  let max = 0;
  ids.forEach((id) => {
    const match = String(id).match(/^(\D+)(\d+)$/);
    if (match && match[1] === prefix) max = Math.max(max, Number(match[2]));
  });
  return max + 1;
}

/**
 * Replaces the graph with server-provided data, keeping the positions of nodes
 * that already exist so streamed updates settle instead of exploding.
 */
export function setGraph(data) {
  const incoming = Array.isArray(data.nodes) ? data.nodes : [];
  const incomingEdges = Array.isArray(data.edges) ? data.edges : [];
  const previous = new Map(state.nodes.map((n) => [n.id, n]));

  state.nodes = incoming.map((n) => {
    const id = String(n.id);
    const old = previous.get(id);
    // A saved map carries the coordinates of the nodes its author dragged, and
    // only those. Nothing streamed from the extractor has them, so this branch
    // is the file-and-library path alone.
    const placed = Number.isFinite(n.x) && Number.isFinite(n.y);
    return {
      id,
      label: String(n.label || "Untitled"),
      type: normalizeNodeType(n.type),
      // The verbatim span the model copied out of the transcript. It is the
      // body of the note card, so it has to survive the trip into state.
      quote: typeof n.quote === "string" ? n.quote.trim() : old?.quote || "",
      mentions: Number(n.mentions) || old?.mentions || 1,
      ...(placed
        ? { x: n.x, y: n.y, pinned: true }
        : old
          ? { x: old.x, y: old.y, pinned: old.pinned }
          : {})
    };
  });

  const ids = new Set(state.nodes.map((n) => n.id));
  state.edges = incomingEdges
    .map((e) => ({
      id: String(e.id),
      from: String(e.from),
      to: String(e.to),
      type: normalizeEdgeType(e.type)
    }))
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

  state.nextNodeId = nextIdFrom(state.nodes.map((n) => n.id), "n");
  state.nextEdgeId = nextIdFrom(state.edges.map((e) => e.id), "e");
  // Ids are `n1`, `n2`, … in every map, so folds kept from the last one would
  // land on whichever nodes happened to take those ids in this one.
  state.collapsed.clear();
  if (!findSelected()) state.selection = null;
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export function addNode(label, type, { x, y, connectToSelection = true } = {}) {
  const node = {
    id: `n${state.nextNodeId++}`,
    label: label.trim(),
    type: normalizeNodeType(type),
    quote: "",
    mentions: 1,
    x,
    y,
    // Dropped at a point the user chose, so the radial layout leaves it there.
    pinned: Number.isFinite(x) && Number.isFinite(y)
  };
  state.nodes.push(node);

  const anchor = state.selection?.kind === "node" ? state.selection.id : null;
  if (connectToSelection && anchor && anchor !== node.id) {
    state.edges.push({
      id: `e${state.nextEdgeId++}`,
      from: anchor,
      to: node.id,
      type: "relates"
    });
  }

  state.selection = { kind: "node", id: node.id };
  return node;
}

/** Hands every node back to the layout, dropping the positions set by dragging. */
export function unpinAll() {
  let pinned = 0;
  state.nodes.forEach((n) => {
    if (n.pinned) pinned += 1;
    n.pinned = false;
  });
  return pinned;
}

export function addEdge(fromId, toId, type) {
  const exists = state.edges.some(
    (e) =>
      (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId)
  );
  if (fromId === toId || exists) return null;

  const edge = {
    id: `e${state.nextEdgeId++}`,
    from: fromId,
    to: toId,
    type: normalizeEdgeType(type)
  };
  state.edges.push(edge);
  return edge;
}

export function removeNode(id) {
  state.nodes = state.nodes.filter((n) => n.id !== id);
  state.edges = state.edges.filter((e) => e.from !== id && e.to !== id);
  state.collapsed.delete(id);
  if (state.selection?.id === id) state.selection = null;
}

export function removeEdge(id) {
  state.edges = state.edges.filter((e) => e.id !== id);
  if (state.selection?.id === id) state.selection = null;
}
