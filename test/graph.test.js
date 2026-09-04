"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  labelKey,
  sanitizeGraph,
  coerceGraph,
  mergeGraphs,
  normalizeNodeType,
  normalizeEdgeType
} = require("../lib/graph");

test("unknown types fall back to the neutral default", () => {
  assert.equal(normalizeNodeType("CAUSE"), "cause");
  assert.equal(normalizeNodeType("nonsense"), "theme");
  assert.equal(normalizeEdgeType("SUPPORTS"), "supports");
  assert.equal(normalizeEdgeType(undefined), "relates");
});

test("labelKey ignores case, punctuation and a leading article", () => {
  assert.equal(labelKey("The Handover Issues,"), labelKey("handover issues"));
  assert.notEqual(labelKey("Handover issues"), labelKey("Handover risk"));
});

test("sanitizeGraph drops nodes without a label and edges with a dangling end", () => {
  const graph = sanitizeGraph({
    nodes: [
      { id: "n1", label: "Kept", type: "cause" },
      { id: "n2", label: "  " },
      { id: "n3" }
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", type: "causes" },
      { id: "e2", from: "n1", to: "n1", type: "relates" }
    ]
  });

  assert.deepEqual(graph.nodes.map((n) => n.id), ["n1"]);
  assert.deepEqual(graph.edges, []);
});

test("sanitizeGraph keeps the source quote and defaults the mention count", () => {
  const graph = sanitizeGraph({
    nodes: [{ id: "n1", label: "Handover", quote: "  the   handover slipped " }],
    edges: []
  });

  assert.equal(graph.nodes[0].quote, "the handover slipped");
  assert.equal(graph.nodes[0].mentions, 1);
});

test("sanitizeGraph rejects duplicate ids", () => {
  const graph = sanitizeGraph({
    nodes: [
      { id: "n1", label: "First" },
      { id: "n1", label: "Second" }
    ],
    edges: []
  });

  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].label, "First");
});

test("coerceGraph reads an empty object as an empty graph", () => {
  // What a small model actually answers when it finds nothing: `{}`.
  assert.deepEqual(coerceGraph({}), { nodes: [], edges: [] });
});

test("coerceGraph fills in a missing edges array", () => {
  assert.deepEqual(coerceGraph({ nodes: [{ id: "n1", label: "A" }] }), {
    nodes: [{ id: "n1", label: "A" }],
    edges: []
  });
});

test("coerceGraph unwraps a single wrapper key", () => {
  assert.deepEqual(coerceGraph({ mindmap: { nodes: [], edges: [] } }), {
    nodes: [],
    edges: []
  });
});

test("coerceGraph refuses what is not a graph at all", () => {
  assert.equal(coerceGraph(null), null);
  assert.equal(coerceGraph("nodes"), null);
  assert.equal(coerceGraph([1, 2]), null);
  assert.equal(coerceGraph({ answer: "no", reason: "unclear" }), null);
});

test("mergeGraphs collapses the same concept named in two chunks", () => {
  const merged = mergeGraphs([
    {
      nodes: [
        { id: "c1_n1", label: "Handover Issues", type: "theme" },
        { id: "c1_n2", label: "EIR Problems", type: "theme" }
      ],
      edges: [{ id: "c1_e1", from: "c1_n2", to: "c1_n1", type: "causes" }]
    },
    {
      nodes: [
        { id: "c2_n1", label: "handover issues", type: "cause" },
        { id: "c2_n2", label: "Model Validation", type: "theme" }
      ],
      edges: [{ id: "c2_e1", from: "c2_n1", to: "c2_n2", type: "relates" }]
    }
  ]);

  assert.equal(merged.nodes.length, 3);

  const handover = merged.nodes.find((n) => n.id === "c1_n1");
  assert.equal(handover.mentions, 2, "both mentions counted");
  assert.equal(handover.type, "cause", "the specific type wins over the theme fallback");
});

test("mergeGraphs rewrites cross-chunk edges onto the surviving node", () => {
  const merged = mergeGraphs([
    {
      nodes: [{ id: "c1_n1", label: "Handover Issues" }],
      edges: []
    },
    {
      nodes: [
        { id: "c2_n1", label: "Handover issues" },
        { id: "c2_n2", label: "Model Validation" }
      ],
      edges: [{ id: "c2_e1", from: "c2_n1", to: "c2_n2", type: "supports" }]
    }
  ]);

  // Without the rewrite this edge would hang off a node that no longer exists and
  // the two chunks would stay separate islands.
  assert.deepEqual(merged.edges.map((e) => [e.from, e.to]), [["c1_n1", "c2_n2"]]);
  assert.equal(merged.nodes.length, 2);
});

test("mergeGraphs drops an edge whose ends collapsed onto one concept", () => {
  const merged = mergeGraphs([
    {
      nodes: [
        { id: "c1_n1", label: "Handover Issues" },
        { id: "c1_n2", label: "handover issues" }
      ],
      edges: [{ id: "c1_e1", from: "c1_n1", to: "c1_n2", type: "causes" }]
    }
  ]);

  assert.equal(merged.nodes.length, 1);
  assert.deepEqual(merged.edges, []);
});

test("mergeGraphs keeps one edge per pair and upgrades the fallback type", () => {
  const merged = mergeGraphs([
    {
      nodes: [
        { id: "n1", label: "A" },
        { id: "n2", label: "B" }
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", type: "relates" }]
    },
    {
      nodes: [
        { id: "m1", label: "A" },
        { id: "m2", label: "B" }
      ],
      edges: [{ id: "e2", from: "m1", to: "m2", type: "causes" }]
    }
  ]);

  assert.equal(merged.edges.length, 1);
  assert.equal(merged.edges[0].type, "causes");
});

test("mergeGraphs of nothing is an empty graph", () => {
  assert.deepEqual(mergeGraphs([]), { nodes: [], edges: [] });
  assert.deepEqual(mergeGraphs(undefined), { nodes: [], edges: [] });
});
