"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

const load = (name) =>
  import(pathToFileURL(join(__dirname, "..", "public", "js", name)).href);

const node = (id, label, type = "theme") => ({ id, label, type });
const edge = (id, from, to, type = "relates") => ({ id, from, to, type });
const sizeOf = () => ({ w: 160, h: 40 });

/** A centre with three branches, the middle one carrying two leaves. */
async function sampleTree() {
  const { buildTree } = await load("tree.js");
  return buildTree(
    [
      node("r", "Centre"),
      node("a", "A"),
      node("b", "B"),
      node("c", "C"),
      node("b1", "B1"),
      node("b2", "B2")
    ],
    [
      edge("e1", "r", "a"),
      edge("e2", "r", "b"),
      edge("e3", "r", "c"),
      edge("e4", "b", "b1"),
      edge("e5", "b", "b2")
    ]
  );
}

test("the centre sits at the origin", async () => {
  const { radialLayout } = await load("layout.js");
  const placed = radialLayout(await sampleTree(), { sizeOf });

  assert.ok(Math.abs(placed.get("r").x) < 1e-9);
  assert.ok(Math.abs(placed.get("r").y) < 1e-9);
  assert.equal(placed.get("r").radius, 0);
});

test("every node sits further out than its parent", async () => {
  const { radialLayout } = await load("layout.js");
  const tree = await sampleTree();
  const placed = radialLayout(tree, { sizeOf });

  // Distances are measured branch by branch rather than per ring, so two
  // siblings need not share a radius — but a child is always outside its
  // parent, or a branch would fold back over the centre.
  tree.order.forEach((id) => {
    const { parent } = tree.byId.get(id);
    if (!parent) return;
    assert.ok(placed.get(id).radius > placed.get(parent).radius, `${id} outside ${parent}`);
  });
  assert.ok(placed.get("a").radius > 0);
});

test("a branch with more leaves gets a wider slice of the circle", async () => {
  const { radialLayout } = await load("layout.js");
  const tree = await sampleTree();
  const placed = radialLayout(tree, { sizeOf });

  // b carries two leaves against one each for a and c, so its children sit on
  // either side of it rather than stacked on one edge of its wedge.
  const spread = Math.abs(placed.get("b1").angle - placed.get("b2").angle);
  assert.ok(spread > 0);
  assert.ok(Math.abs(placed.get("b").angle - (placed.get("b1").angle + placed.get("b2").angle) / 2) < 1e-9);
});

test("no two nodes are placed on the same point", async () => {
  const { radialLayout } = await load("layout.js");
  const placed = radialLayout(await sampleTree(), { sizeOf });

  const seen = new Set();
  placed.forEach(({ x, y }) => {
    const key = `${x.toFixed(3)}:${y.toFixed(3)}`;
    assert.equal(seen.has(key), false);
    seen.add(key);
  });
});

test("a crowded ring is pushed out far enough to hold its labels", async () => {
  const { buildTree } = await load("tree.js");
  const { radialLayout } = await load("layout.js");

  const many = Array.from({ length: 24 }, (_, i) => node(`n${i}`, `Node ${i}`));
  const tree = buildTree(
    [node("r", "Centre"), ...many],
    many.map((n, i) => edge(`e${i}`, "r", n.id))
  );

  const placed = radialLayout(tree, { sizeOf });
  const radius = placed.get("n0").radius;
  // 24 labels of at least 40px, laid side by side, need this much circle.
  assert.ok(2 * Math.PI * radius >= 24 * 40);
});

test("no tree, no positions", async () => {
  const { radialLayout } = await load("layout.js");
  assert.equal(radialLayout(null, { sizeOf }).size, 0);
});
