"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

const load = (name) =>
  import(pathToFileURL(join(__dirname, "..", "public", "js", name)).href);

const node = (id, label = id, type = "theme") => ({ id, label, type });
const edge = (id, from, to, type = "causes") => ({ id, from, to, type });
const sizeOf = () => ({ w: 160, h: 40 });

const GAP_Y = 20;

async function lay(nodes, edges, options = {}) {
  const { buildCausal } = await load("causal.js");
  const { flowLayout } = await load("flow-layout.js");
  const model = buildCausal(nodes, edges);
  return { model, placed: flowLayout(model, { sizeOf, gapY: GAP_Y, ...options }) };
}

test("nothing to lay out gives nothing back", async () => {
  const { flowLayout } = await load("flow-layout.js");
  assert.equal(flowLayout(null, { sizeOf }).size, 0);
});

test("each layer sits strictly to the right of the one before", async () => {
  const { model, placed } = await lay(
    [node("a"), node("b"), node("c")],
    [edge("e1", "a", "b"), edge("e2", "b", "c")]
  );

  const x = model.layers.map((layer) => placed.get(layer[0].id).x);
  assert.ok(x[0] < x[1], "layer 1 is right of layer 0");
  assert.ok(x[1] < x[2], "layer 2 is right of layer 1");
});

test("a column never leaves the right edge of the one before it behind", async () => {
  // The boxes are 160 wide, so the columns can only avoid overlapping if the
  // gap is measured between their edges rather than between their centres.
  const { model, placed } = await lay(
    [node("a"), node("b")],
    [edge("e1", "a", "b")]
  );

  const left = placed.get(model.layers[0][0].id).x + 160 / 2;
  const right = placed.get(model.layers[1][0].id).x - 160 / 2;
  assert.ok(right > left, `column 1 starts at ${right}, column 0 ends at ${left}`);
});

test("no two labels in one column overlap", async () => {
  const { model, placed } = await lay(
    [node("a"), node("b"), node("c"), node("d")],
    [edge("e1", "a", "d"), edge("e2", "b", "d"), edge("e3", "c", "d")]
  );

  const column = model.layers[0]
    .map((slot) => placed.get(slot.id).y)
    .sort((p, q) => p - q);

  column.slice(1).forEach((y, index) => {
    assert.ok(y - column[index] >= 40 + GAP_Y - 0.001, `${column[index]} and ${y} are too close`);
  });
});

test("an effect sits level with the middle of what feeds it", async () => {
  const { placed } = await lay(
    [node("a"), node("b"), node("c")],
    [edge("e1", "a", "c"), edge("e2", "b", "c")]
  );

  const middle = (placed.get("a").y + placed.get("b").y) / 2;
  assert.ok(
    Math.abs(placed.get("c").y - middle) < 0.001,
    `c at ${placed.get("c").y}, midway is ${middle}`
  );
});

test("a straight chain draws a straight line", async () => {
  const { placed } = await lay(
    [node("a"), node("b"), node("c"), node("d")],
    [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "d")]
  );

  const ys = ["a", "b", "c", "d"].map((id) => placed.get(id).y);
  ys.slice(1).forEach((y) => assert.ok(Math.abs(y - ys[0]) < 0.001, `${y} is off the line`));
});

test("the bend of a skipping edge gets a place of its own", async () => {
  const { placed } = await lay(
    [node("a"), node("b"), node("c")],
    [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "a", "c")]
  );

  const bend = placed.get("e3@1");
  assert.ok(bend, "the bend was placed");
  assert.equal(bend.rank, 1);
  // In the middle column, so the edge passes through it rather than across it.
  assert.ok(Math.abs(bend.x - placed.get("b").x) < 0.001);
  assert.ok(Math.abs(bend.y - placed.get("b").y) >= 40 / 2 + GAP_Y - 0.001);
});

test("the diagram is centred on the origin, as the map is", async () => {
  const { placed } = await lay(
    [node("a"), node("b"), node("c")],
    [edge("e1", "a", "b"), edge("e2", "a", "c")]
  );

  const points = [...placed.values()];
  const span = (key) => {
    const values = points.map((p) => p[key]);
    return (Math.min(...values) + Math.max(...values)) / 2;
  };
  assert.ok(Math.abs(span("x")) < 0.001);
  assert.ok(Math.abs(span("y")) < 0.001);
});

test("a feedback edge takes no room in the columns", async () => {
  const { model, placed } = await lay(
    [node("a"), node("b")],
    [edge("e1", "a", "b"), edge("e2", "b", "a", "contrasts")]
  );

  // Two nodes, two layers, one slot each: the loop is drawn underneath rather
  // than given a lane of its own.
  assert.equal(placed.size, 2);
  assert.equal(model.layers.length, 2);
});

test("a node with a label of its own size is placed by that size", async () => {
  const { buildCausal } = await load("causal.js");
  const { flowLayout } = await load("flow-layout.js");
  const model = buildCausal(
    [node("a"), node("b"), node("c")],
    [edge("e1", "a", "c"), edge("e2", "b", "c")]
  );
  const tall = (id) => (id === "a" ? { w: 160, h: 120 } : { w: 160, h: 40 });
  const placed = flowLayout(model, { sizeOf: tall, gapY: GAP_Y });

  const gap = Math.abs(placed.get("a").y - placed.get("b").y);
  assert.ok(gap >= 120 / 2 + GAP_Y + 40 / 2 - 0.001, `only ${gap} apart`);
});
