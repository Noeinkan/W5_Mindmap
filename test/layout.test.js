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

/** A centre and a single chain hanging off it: r -> a -> b -> c. */
async function chainTree() {
  const { buildTree } = await load("tree.js");
  return buildTree(
    [node("r", "Centre"), node("a", "A"), node("b", "B"), node("c", "C")],
    [edge("e1", "r", "a"), edge("e2", "a", "b"), edge("e3", "b", "c")]
  );
}

test("the centre sits at the origin", async () => {
  const { wingLayout } = await load("layout.js");
  const placed = wingLayout(await sampleTree(), { sizeOf });

  assert.equal(placed.get("r").x, 0);
  assert.equal(placed.get("r").y, 0);
});

test("the branches are shared out between the two wings", async () => {
  const { wingLayout } = await load("layout.js");
  const tree = await sampleTree();
  const placed = wingLayout(tree, { sizeOf });

  const sides = tree.byId.get("r").children.map((id) => placed.get(id).side);
  assert.ok(sides.includes(1), "something goes right");
  assert.ok(sides.includes(-1), "something goes left");
});

test("a child sits further out than its parent, on its parent's side", async () => {
  const { wingLayout } = await load("layout.js");
  const tree = await sampleTree();
  const placed = wingLayout(tree, { sizeOf });

  tree.order.forEach((id) => {
    const { parent } = tree.byId.get(id);
    if (!parent) return;
    const child = placed.get(id);
    assert.equal(child.side, placed.get(parent).side || child.side, `${id} keeps its wing`);
    assert.ok(
      Math.abs(child.x) > Math.abs(placed.get(parent).x),
      `${id} is further out than ${parent}`
    );
    assert.ok(Math.sign(child.x) === child.side, `${id} is on its own side`);
  });
});

test("a chain of only children folds down a 45° diagonal", async () => {
  const { wingLayout } = await load("layout.js");
  const placed = wingLayout(await chainTree(), { sizeOf });

  [["a", "b"], ["b", "c"]].forEach(([parent, child]) => {
    const p = placed.get(parent);
    const q = placed.get(child);
    assert.ok(q.y > p.y, `${child} sits below ${parent}`);
    // Equal widths here, so the shared edge and the middle move together.
    assert.equal(Math.abs(q.x - p.x), q.y - p.y, `${child} steps out as far as it steps down`);
  });
});

test("the diagonal holds when the labels differ in size", async () => {
  const { wingLayout } = await load("layout.js");
  const sizes = { r: { w: 200, h: 50 }, a: { w: 240, h: 60 }, b: { w: 90, h: 30 }, c: { w: 170, h: 44 } };
  const placed = wingLayout(await chainTree(), { sizeOf: (id) => sizes[id] });

  [["a", "b"], ["b", "c"]].forEach(([parent, child]) => {
    const p = placed.get(parent);
    const q = placed.get(child);
    const edge = (spot, id) => spot.x - spot.side * (sizes[id].w / 2);
    assert.equal(Math.abs(edge(q, child) - edge(p, parent)), q.y - p.y, `${child} keeps the 45° edge`);
  });
});

test("no two labels overlap", async () => {
  const { buildTree } = await load("tree.js");
  const { wingLayout } = await load("layout.js");

  // A centre, eight branches, and a mix of stars and chains under them — the
  // shape a real transcript produces, and the one the ring layout could not
  // lay out without labels landing on top of each other.
  const nodes = [node("r", "Centre")];
  const edges = [];
  for (let b = 0; b < 8; b += 1) {
    nodes.push(node(`b${b}`, `Branch ${b}`));
    edges.push(edge(`eb${b}`, "r", `b${b}`));
    let tail = `b${b}`;
    for (let i = 0; i < 4; i += 1) {
      const id = `n${b}_${i}`;
      nodes.push(node(id, `Node ${b}.${i}`));
      // even branches fan out, odd ones run as a chain
      edges.push(edge(`e${b}_${i}`, b % 2 ? tail : `b${b}`, id));
      tail = id;
    }
  }

  const tree = buildTree(nodes, edges);
  const placed = wingLayout(tree, { sizeOf });
  const ids = [...placed.keys()];

  ids.forEach((a, i) => {
    ids.slice(i + 1).forEach((b) => {
      const p = placed.get(a);
      const q = placed.get(b);
      const apart =
        Math.abs(p.x - q.x) >= sizeOf().w || Math.abs(p.y - q.y) >= sizeOf().h;
      assert.ok(apart, `${a} and ${b} overlap`);
    });
  });
});

test("no tree, no positions", async () => {
  const { wingLayout } = await load("layout.js");
  assert.equal(wingLayout(null, { sizeOf }).size, 0);
});
