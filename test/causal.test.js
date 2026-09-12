"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

const load = (name) =>
  import(pathToFileURL(join(__dirname, "..", "public", "js", name)).href);

const node = (id, label = id, type = "theme") => ({ id, label, type });
const edge = (id, from, to, type = "causes") => ({ id, from, to, type });

/** A -> B -> C, the shape the whole view exists to draw. */
const chain = () => ({
  nodes: [node("a"), node("b"), node("c")],
  edges: [edge("e1", "a", "b"), edge("e2", "b", "c")]
});

test("a graph with no causal edge is not a causal graph at all", async () => {
  const { buildCausal } = await load("causal.js");
  const model = buildCausal(
    [node("a"), node("b")],
    [edge("e1", "a", "b", "relates")]
  );
  assert.equal(model, null);
});

test("a chain ranks left to right, one layer per step", async () => {
  const { buildCausal } = await load("causal.js");
  const { nodes, edges } = chain();
  const model = buildCausal(nodes, edges);

  assert.equal(model.byId.get("a").rank, 0);
  assert.equal(model.byId.get("b").rank, 1);
  assert.equal(model.byId.get("c").rank, 2);
  assert.equal(model.layers.length, 3);
});

test("roles come from the arrows, not from the node type", async () => {
  const { buildCausal } = await load("causal.js");
  const { nodes, edges } = chain();
  const model = buildCausal(nodes, edges);

  assert.equal(model.byId.get("a").role, "trigger");
  assert.equal(model.byId.get("b").role, "link");
  assert.equal(model.byId.get("c").role, "outcome");
});

test("a shortcut never lifts an effect level with its own cause", async () => {
  const { buildCausal } = await load("causal.js");
  // a -> b -> c and also a -> c. Ranked by the shortest route c would sit at 1,
  // beside b, and the arrow b -> c would have to run straight up.
  const model = buildCausal(
    [node("a"), node("b"), node("c")],
    [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "a", "c")]
  );

  assert.equal(model.byId.get("c").rank, 2);
});

test("an edge that skips a layer gets a bend in the one it passes", async () => {
  const { buildCausal } = await load("causal.js");
  const model = buildCausal(
    [node("a"), node("b"), node("c")],
    [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "a", "c")]
  );

  const shortcut = model.links.find((l) => l.id === "e3");
  assert.deepEqual(shortcut.bends, ["e3@1"]);
  assert.ok(model.layers[1].some((slot) => slot.id === "e3@1" && slot.edge === "e3"));
});

test("polarity is read off the edge type", async () => {
  const { polarityOf } = await load("causal.js");
  assert.equal(polarityOf("causes"), 1);
  assert.equal(polarityOf("supports"), 1);
  assert.equal(polarityOf("contrasts"), -1);
  // `relates` claims no direction of effect, so it has no sign to carry.
  assert.equal(polarityOf("relates"), 0);
});

test("a cycle is broken for the layering but kept as a loop", async () => {
  const { buildCausal } = await load("causal.js");
  const model = buildCausal(
    [node("a"), node("b"), node("c")],
    [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a")]
  );

  assert.equal(model.loops.length, 1);
  assert.equal(model.links.filter((l) => l.back).length, 1);
  // Every node still has a layer, which is only possible because one edge left
  // the ranking — and every node is in exactly one.
  assert.equal(model.byId.size, 3);
});

test("a loop with no opposing link reinforces itself", async () => {
  const { buildCausal } = await load("causal.js");
  const model = buildCausal(
    [node("a"), node("b")],
    [edge("e1", "a", "b"), edge("e2", "b", "a", "supports")]
  );

  assert.equal(model.loops[0].kind, "reinforcing");
  assert.equal(model.loops[0].label, "R1");
});

test("one opposing link flips a loop to balancing", async () => {
  const { buildCausal } = await load("causal.js");
  const model = buildCausal(
    [node("a"), node("b")],
    [edge("e1", "a", "b"), edge("e2", "b", "a", "contrasts")]
  );

  assert.equal(model.loops[0].kind, "balancing");
  assert.equal(model.loops[0].label, "B1");
  assert.equal(model.loops[0].negatives, 1);
});

test("two opposing links cancel, and the loop reinforces again", async () => {
  const { buildCausal } = await load("causal.js");
  const model = buildCausal(
    [node("a"), node("b"), node("c")],
    [
      edge("e1", "a", "b", "contrasts"),
      edge("e2", "b", "c", "contrasts"),
      edge("e3", "c", "a")
    ]
  );

  assert.equal(model.loops[0].kind, "reinforcing");
  assert.equal(model.loops[0].negatives, 2);
});

test("a loop reports the nodes it runs through", async () => {
  const { buildCausal } = await load("causal.js");
  const model = buildCausal(
    [node("a"), node("b"), node("c"), node("d")],
    [
      edge("e1", "a", "b"),
      edge("e2", "b", "c"),
      edge("e3", "c", "b"),
      edge("e4", "c", "d")
    ]
  );

  assert.deepEqual([...model.loops[0].nodes].sort(), ["b", "c"]);
  assert.equal(model.loops[0].edges.length, 2);
});

test("`relates` comes back as context and never ranks a node", async () => {
  const { buildCausal } = await load("causal.js");
  const model = buildCausal(
    [node("a"), node("b"), node("c")],
    [edge("e1", "a", "b"), edge("e2", "a", "c", "relates"), edge("e3", "b", "c")]
  );

  assert.deepEqual(model.context.map((e) => e.id), ["e2"]);
  // c is one step past b, which is one past a. The `relates` edge straight from
  // a would have made it rank 1 if it counted.
  assert.equal(model.byId.get("c").rank, 2);
});

test("concepts with no causal link are counted, not drawn", async () => {
  const { buildCausal } = await load("causal.js");
  const model = buildCausal(
    [node("a"), node("b"), node("lonely"), node("also")],
    [edge("e1", "a", "b")]
  );

  assert.deepEqual(model.ids, ["a", "b"]);
  assert.equal(model.omitted, 2);
});

test("an edge pointing at a node that is not there is dropped", async () => {
  const { buildCausal } = await load("causal.js");
  const model = buildCausal(
    [node("a"), node("b")],
    [edge("e1", "a", "b"), edge("e2", "b", "ghost"), edge("e3", "a", "a")]
  );

  assert.deepEqual(model.links.map((l) => l.id), ["e1"]);
});

test("the same graph twice lays out the same way", async () => {
  const { buildCausal } = await load("causal.js");
  const { nodes, edges } = chain();
  const shape = (model) => model.layers.map((layer) => layer.map((slot) => slot.id));

  assert.deepEqual(shape(buildCausal(nodes, edges)), shape(buildCausal(nodes, edges)));
});

test("two chains that never meet are both laid out", async () => {
  const { buildCausal } = await load("causal.js");
  const model = buildCausal(
    [node("a"), node("b"), node("x"), node("y")],
    [edge("e1", "a", "b"), edge("e2", "x", "y")]
  );

  assert.equal(model.layers.length, 2);
  assert.equal(model.layers[0].length, 2);
  assert.equal(model.byId.get("x").role, "trigger");
  assert.equal(model.byId.get("y").role, "outcome");
});
