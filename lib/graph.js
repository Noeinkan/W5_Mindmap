"use strict";

const NODE_TYPES = ["cause", "theme", "hierarchy"];
const EDGE_TYPES = ["causes", "relates", "supports", "contrasts"];

// The fallbacks below double as "the model did not really choose": when a duplicate
// concept arrives with a more specific type, the fallback loses.
const DEFAULT_NODE_TYPE = "theme";
const DEFAULT_EDGE_TYPE = "relates";

const MAX_LABEL_LENGTH = 120;
const MAX_QUOTE_LENGTH = 300;

function normalizeNodeType(type) {
  const t = String(type || "").toLowerCase().trim();
  return NODE_TYPES.includes(t) ? t : DEFAULT_NODE_TYPE;
}

function normalizeEdgeType(type) {
  const t = String(type || "").toLowerCase().trim();
  return EDGE_TYPES.includes(t) ? t : DEFAULT_EDGE_TYPE;
}

/**
 * The key two labels are considered "the same concept" under. Case, punctuation,
 * surrounding whitespace and a leading article are all noise here: chunk 1 saying
 * "Handover issues" and chunk 3 saying "The handover issues," is one node.
 */
function labelKey(label) {
  return String(label || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/^\s*(the|a|an)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value, max) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sanitizeGraph(graph) {
  const safe = { nodes: [], edges: [] };
  if (!graph || typeof graph !== "object") return safe;

  if (Array.isArray(graph.nodes)) {
    const seenIds = new Set();
    safe.nodes = graph.nodes
      .filter((n) => n && n.id && n.label && String(n.label).trim())
      .map((n) => {
        const node = {
          id: String(n.id),
          label: clamp(n.label, MAX_LABEL_LENGTH),
          type: normalizeNodeType(n.type),
          mentions: Math.max(1, Number(n.mentions) || 1)
        };
        if (n.quote && String(n.quote).trim()) {
          node.quote = clamp(n.quote, MAX_QUOTE_LENGTH);
        }
        return node;
      })
      .filter((n) => {
        if (seenIds.has(n.id)) return false;
        seenIds.add(n.id);
        return true;
      });
  }

  const nodeIds = new Set(safe.nodes.map((n) => n.id));

  if (Array.isArray(graph.edges)) {
    const seenIds = new Set();
    safe.edges = graph.edges
      .filter((e) => e && e.id && e.from && e.to)
      .map((e) => ({
        id: String(e.id),
        from: String(e.from),
        to: String(e.to),
        type: normalizeEdgeType(e.type)
      }))
      .filter((e) => e.from !== e.to && nodeIds.has(e.from) && nodeIds.has(e.to))
      .filter((e) => {
        if (seenIds.has(e.id)) return false;
        seenIds.add(e.id);
        return true;
      });
  }

  return safe;
}

/**
 * Bend what the model returned into { nodes, edges }, or null if it is not a graph
 * at all. Small models are loose in predictable ways: asked for an empty graph they
 * answer `{}`, they drop the `edges` key when they found no relations, and they like
 * to wrap the whole thing in `{"mindmap": …}`. Rejecting those as schema errors
 * threw away entire chunks of transcript for no good reason.
 */
function coerceGraph(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) {
    return null;
  }

  if (Array.isArray(value.nodes) || Array.isArray(value.edges)) {
    return {
      nodes: Array.isArray(value.nodes) ? value.nodes : [],
      edges: Array.isArray(value.edges) ? value.edges : []
    };
  }

  const keys = Object.keys(value);
  if (!keys.length) return { nodes: [], edges: [] };
  if (keys.length === 1) return coerceGraph(value[keys[0]], depth + 1);
  return null;
}

/**
 * Merge per-chunk graphs into one. Concatenating them leaves the map as a row of
 * disconnected islands — the same concept named in chunk 1 and chunk 3 shows up
 * twice and nothing crosses a chunk boundary. Here duplicates collapse onto the
 * first node that carried the label, and every edge is rewritten onto the surviving
 * ids, which is what actually joins the islands together.
 */
function mergeGraphs(graphs) {
  const safeGraphs = (graphs || []).map(sanitizeGraph);

  const byLabel = new Map();
  const canonicalId = new Map();
  const nodes = [];

  safeGraphs.forEach((graph) => {
    graph.nodes.forEach((node) => {
      const key = labelKey(node.label);
      if (!key) return;

      const existing = byLabel.get(key);
      if (!existing) {
        const merged = { ...node };
        byLabel.set(key, merged);
        canonicalId.set(node.id, merged.id);
        nodes.push(merged);
        return;
      }

      existing.mentions += node.mentions;
      if (existing.type === DEFAULT_NODE_TYPE && node.type !== DEFAULT_NODE_TYPE) {
        existing.type = node.type;
      }
      if (!existing.quote && node.quote) existing.quote = node.quote;
      canonicalId.set(node.id, existing.id);
    });
  });

  const edgeByPair = new Map();
  safeGraphs.forEach((graph) => {
    graph.edges.forEach((edge) => {
      const from = canonicalId.get(edge.from);
      const to = canonicalId.get(edge.to);
      // A self-edge here means both endpoints collapsed onto one concept.
      if (!from || !to || from === to) return;

      const pair = `${from}\u0000${to}`;
      const existing = edgeByPair.get(pair);
      if (!existing) {
        edgeByPair.set(pair, { ...edge, from, to });
        return;
      }
      if (existing.type === DEFAULT_EDGE_TYPE && edge.type !== DEFAULT_EDGE_TYPE) {
        existing.type = edge.type;
      }
    });
  });

  return { nodes, edges: Array.from(edgeByPair.values()) };
}

/**
 * The connected components of the graph, as arrays of node ids, treating edges as
 * undirected. More than one component means the map reads as separate islands —
 * usually one per chunk, which is the thing the linking pass exists to fix.
 */
function graphComponents(graph) {
  const neighbours = new Map();
  graph.nodes.forEach((node) => neighbours.set(node.id, []));
  graph.edges.forEach((edge) => {
    if (!neighbours.has(edge.from) || !neighbours.has(edge.to)) return;
    neighbours.get(edge.from).push(edge.to);
    neighbours.get(edge.to).push(edge.from);
  });

  const seen = new Set();
  const components = [];

  graph.nodes.forEach((node) => {
    if (seen.has(node.id)) return;
    const component = [];
    const stack = [node.id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      component.push(id);
      neighbours.get(id).forEach((next) => {
        if (!seen.has(next)) stack.push(next);
      });
    }
    components.push(component);
  });

  return components;
}

module.exports = {
  NODE_TYPES,
  EDGE_TYPES,
  DEFAULT_NODE_TYPE,
  DEFAULT_EDGE_TYPE,
  normalizeNodeType,
  normalizeEdgeType,
  labelKey,
  sanitizeGraph,
  coerceGraph,
  mergeGraphs,
  graphComponents
};
