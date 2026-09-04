"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

// The browser modules are ES modules; `public/js/package.json` marks that
// directory as such so Node can load them here without a build step.
const load = (name) =>
  import(pathToFileURL(join(__dirname, "..", "public", "js", name)).href);

const node = (id, label, type = "theme") => ({ id, label, type });
const edge = (id, from, to, type = "relates") => ({ id, from, to, type });

test("chains from different chunks hang off one synthetic centre", async () => {
  const { buildTree, SYNTHETIC_ROOT } = await load("tree.js");

  const tree = buildTree(
    [node("a", "A"), node("b", "B"), node("c", "C"), node("d", "D")],
    [edge("e1", "a", "b"), edge("e2", "c", "d")],
    { title: "Kickoff" }
  );

  assert.equal(tree.root.id, SYNTHETIC_ROOT);
  assert.equal(tree.root.label, "Kickoff");
  assert.equal(tree.root.synthetic, true);
  // One branch per component, each rooted at the head of its chain.
  assert.deepEqual(tree.byId.get(SYNTHETIC_ROOT).children, ["a", "c"]);
  assert.equal(tree.byId.get("b").depth, 2);
  assert.equal(tree.byId.get("b").branch, "a");
  assert.equal(tree.byId.get("d").branch, "c");
});

test("a single component keeps its own node as the centre", async () => {
  const { buildTree, SYNTHETIC_ROOT } = await load("tree.js");

  const tree = buildTree(
    [node("hub", "Hub"), node("a", "A"), node("b", "B")],
    [edge("e1", "hub", "a"), edge("e2", "hub", "b")]
  );

  assert.equal(tree.root.id, "hub");
  assert.equal(tree.root.synthetic, false);
  assert.notEqual(tree.root.id, SYNTHETIC_ROOT);
  assert.deepEqual(tree.byId.get("hub").children, ["a", "b"]);
  assert.equal(tree.byId.get("a").depth, 1);
});

test("a chain is rooted at its head, not at its middle", async () => {
  const { buildTree } = await load("tree.js");

  // Degree alone would pick the middle node; the head is what makes a causal
  // chain read outward from the centre.
  const tree = buildTree(
    [node("head", "Head"), node("mid", "Mid"), node("tail", "Tail")],
    [edge("e1", "head", "mid", "causes"), edge("e2", "mid", "tail", "causes")]
  );

  assert.equal(tree.root.id, "head");
  assert.equal(tree.byId.get("tail").depth, 2);
});

test("edges the tree does not use come back as cross-links", async () => {
  const { buildTree } = await load("tree.js");

  // Breadth first, so both b and c hang straight off a and the long way round
  // (b to c) is the edge left over. Nothing is dropped: it is drawn thin and
  // dashed instead of as a branch.
  const tree = buildTree(
    [node("a", "A"), node("b", "B"), node("c", "C")],
    [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "a", "c", "contrasts")]
  );

  assert.equal(tree.treeEdges.length, 2);
  assert.deepEqual(
    tree.treeEdges.map((t) => t.edge.id),
    ["e1", "e3"]
  );
  assert.equal(tree.crossEdges.length, 1);
  assert.equal(tree.crossEdges[0].id, "e2");
});

test("leaf counts weigh each subtree", async () => {
  const { buildTree } = await load("tree.js");

  const tree = buildTree(
    [node("r", "R"), node("a", "A"), node("b", "B"), node("b1", "B1"), node("b2", "B2")],
    [edge("e1", "r", "a"), edge("e2", "r", "b"), edge("e3", "b", "b1"), edge("e4", "b", "b2")]
  );

  assert.equal(tree.byId.get("a").leaves, 1);
  assert.equal(tree.byId.get("b").leaves, 2);
  assert.equal(tree.byId.get("r").leaves, 3);
});

test("a cycle still gets a root, and every node is placed once", async () => {
  const { buildTree } = await load("tree.js");

  const tree = buildTree(
    [node("a", "A"), node("b", "B"), node("c", "C")],
    [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a")]
  );

  assert.equal(tree.order.length, new Set(tree.order).size);
  assert.equal(tree.order.length, 3);
  assert.equal(tree.crossEdges.length, 1);
});

test("an empty graph has no tree at all", async () => {
  const { buildTree } = await load("tree.js");
  assert.equal(buildTree([], []), null);
});

test("edges pointing at unknown nodes are ignored", async () => {
  const { buildTree } = await load("tree.js");

  const tree = buildTree([node("a", "A")], [edge("e1", "a", "ghost")]);

  assert.equal(tree.root.id, "a");
  assert.equal(tree.crossEdges.length, 0);
  assert.equal(tree.treeEdges.length, 0);
});
