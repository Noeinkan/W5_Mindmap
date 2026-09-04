/**
 * Single source of truth for the mind map: graph data, selection, view filters
 * and an undo/redo history. Everything that mutates the graph goes through
 * `withHistory` so Ctrl+Z always has something to fall back to.
 */

export const NODE_TYPES = ["theme", "cause", "hierarchy"];
export const EDGE_TYPES = ["relates", "causes", "supports", "contrasts"];

export const state = {
  nodes: [],
  edges: [],
  /** @type {{kind: "node"|"edge", id: string}|null} */
  selection: null,
  connectMode: false,
  pendingSourceId: null,
  hiddenTypes: new Set(),
  query: "",
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
    nodes: state.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      x: n.x,
      y: n.y
    })),
    edges: state.edges.map((e) => ({ ...e })),
    nextNodeId: state.nextNodeId,
    nextEdgeId: state.nextEdgeId
  };
}

function restore(snap) {
  state.nodes = snap.nodes.map((n) => ({ ...n, vx: 0, vy: 0 }));
  state.edges = snap.edges.map((e) => ({ ...e }));
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
      ...(old ? { x: old.x, y: old.y, vx: old.vx, vy: old.vy } : {})
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
    x,
    y
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
