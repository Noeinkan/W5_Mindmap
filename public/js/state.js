/**
 * Single source of truth for the mind map: graph data, selection, view filters
 * and an undo/redo history. Everything that mutates the graph goes through
 * `withHistory` so Ctrl+Z always has something to fall back to.
 */

export const NODE_TYPES = ["theme", "cause", "hierarchy"];
export const EDGE_TYPES = ["relates", "causes", "supports", "contrasts"];

export const VIEWS = ["map", "notes"];

export const state = {
  nodes: [],
  edges: [],
  /** @type {{kind: "node"|"edge", id: string}|null} */
  selection: null,
  connectMode: false,
  pendingSourceId: null,
  hiddenTypes: new Set(),
  query: "",
  /** Which renderer owns the canvas: the radial map, or the note cards. */
  view: "map",
  /** Label of the map's centre when the graph has no single natural root. */
  title: "Central topic",
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
    nextNodeId: state.nextNodeId,
    nextEdgeId: state.nextEdgeId
  };
}

function restore(snap) {
  state.nodes = snap.nodes.map((n) => ({ ...n }));
  state.edges = snap.edges.map((e) => ({ ...e }));
  state.title = snap.title;
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
  state.title = String(title || "").trim() || "Central topic";
  emit("graph");
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

export function normalizeNodeType(type) {
  const t = String(type || "").toLowerCase();
  return NODE_TYPES.includes(t) ? t : "theme";
}

export function normalizeEdgeType(type) {
  const t = String(type || "").toLowerCase();
  return EDGE_TYPES.includes(t) ? t : "relates";
}

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
    return {
      id,
      label: String(n.label || "Untitled"),
      type: normalizeNodeType(n.type),
      // The verbatim span the model copied out of the transcript. It is the
      // body of the note card, so it has to survive the trip into state.
      quote: typeof n.quote === "string" ? n.quote.trim() : old?.quote || "",
      mentions: Number(n.mentions) || old?.mentions || 1,
      ...(old ? { x: old.x, y: old.y, pinned: old.pinned } : {})
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
  if (state.selection?.id === id) state.selection = null;
}

export function removeEdge(id) {
  state.edges = state.edges.filter((e) => e.id !== id);
  if (state.selection?.id === id) state.selection = null;
}
