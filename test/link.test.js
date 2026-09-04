"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { linkComponents } = require("../lib/link");
const { graphComponents } = require("../lib/graph");

// Two islands, one per chunk: the shape every multi-chunk run produces.
const islands = () => ({
  nodes: [
    { id: "c1_n1", label: "EIR Problems", type: "theme", mentions: 1 },
    { id: "c1_n2", label: "Handover Issues", type: "theme", mentions: 1 },
    { id: "c2_n1", label: "Capability Assessment", type: "cause", mentions: 1 },
    { id: "c2_n2", label: "CDE Naming Convention", type: "theme", mentions: 1 }
  ],
  edges: [
    { id: "c1_e1", from: "c1_n1", to: "c1_n2", type: "causes" },
    { id: "c2_e1", from: "c2_n1", to: "c2_n2", type: "relates" }
  ]
});

const clientReturning = (edges) => {
  const prompts = [];
  return {
    prompts,
    generate: async (prompt) => {
      prompts.push(prompt);
      return { response: JSON.stringify(typeof edges === "string" ? edges : { edges }) };
    }
  };
};

test("graphComponents finds the islands", () => {
  assert.equal(graphComponents(islands()).length, 2);
  assert.equal(graphComponents({ nodes: [], edges: [] }).length, 0);
  assert.equal(
    graphComponents({ nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] }).length,
    1
  );
});

test("adds the edges that cross between chunks", async () => {
  const client = clientReturning([
    { id: "x", from: "c1_n1", to: "c2_n1", type: "causes" },
    { id: "y", from: "c1_n2", to: "c2_n2", type: "relates" }
  ]);

  const result = await linkComponents({ graph: islands(), client });

  assert.equal(result.added, 2);
  assert.equal(result.components, 2);
  assert.equal(graphComponents(result.graph).length, 1, "the map is one piece now");
  assert.equal(result.graph.nodes.length, 4, "the pass adds no nodes");
});

test("the prompt lists the concepts by group and carries no transcript", async () => {
  const client = clientReturning([]);
  await linkComponents({ graph: islands(), client });

  const prompt = client.prompts[0];
  assert.match(prompt, /Group 1:/);
  assert.match(prompt, /Group 2:/);
  assert.match(prompt, /c1_n1: EIR Problems \(theme\)/);
  assert.ok(prompt.length < 1200, "short enough to be cheap");
});

test("drops edges pointing at concepts the model invented", async () => {
  const client = clientReturning([
    { id: "x", from: "c1_n1", to: "made_up", type: "causes" },
    { id: "y", from: "c1_n2", to: "c2_n1", type: "supports" }
  ]);

  const result = await linkComponents({ graph: islands(), client });

  assert.equal(result.added, 1);
  assert.deepEqual(
    result.graph.edges.slice(2).map((e) => [e.from, e.to]),
    [["c1_n2", "c2_n1"]]
  );
});

test("ignores an edge that does not actually cross", async () => {
  const client = clientReturning([{ id: "x", from: "c1_n1", to: "c1_n2", type: "supports" }]);

  const result = await linkComponents({ graph: islands(), client });

  assert.equal(result.added, 0);
  assert.equal(graphComponents(result.graph).length, 2);
});

test("never repeats a pair the map already has", async () => {
  const graph = islands();
  graph.edges.push({ id: "seed", from: "c1_n1", to: "c2_n1", type: "relates" });

  const client = clientReturning([
    { id: "x", from: "c1_n1", to: "c2_n1", type: "causes" },
    { id: "y", from: "c2_n1", to: "c1_n1", type: "supports" }
  ]);

  const result = await linkComponents({ graph, client });
  assert.equal(result.added, 0);
});

test("does nothing when the map is already one piece", async () => {
  const graph = islands();
  graph.edges.push({ id: "bridge", from: "c1_n2", to: "c2_n1", type: "relates" });

  let called = false;
  const client = {
    generate: async () => {
      called = true;
      return { response: "{}" };
    }
  };

  const result = await linkComponents({ graph, client });

  assert.equal(called, false, "no call is worth making");
  assert.equal(result.skipped, "already connected");
});

test("a nonsense answer leaves the graph untouched", async () => {
  const client = clientReturning("I cannot connect these.");
  const before = islands();

  const result = await linkComponents({ graph: before, client });

  assert.equal(result.added, 0);
  assert.deepEqual(result.graph.edges, before.edges);
  assert.ok(result.skipped);
});
