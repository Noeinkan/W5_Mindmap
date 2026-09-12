"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

const load = () => import(pathToFileURL(join(__dirname, "..", "public", "js", "routing.js")).href);

const box = (x, y, w = 140, h = 36, side = 1) => ({ x, y, w, h, side });

/** Points along the cubic, ends excluded — the ends are meant to touch the boxes. */
function samples({ start, c1, c2, end }, count = 60) {
  const points = [];
  for (let i = 1; i < count; i += 1) {
    const t = i / count;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    points.push({
      x: a * start.x + b * c1.x + c * c2.x + d * end.x,
      y: a * start.y + b * c1.y + c * c2.y + d * end.y
    });
  }
  return points;
}

const inside = (p, n, margin = 1) =>
  Math.abs(p.x - n.x) < n.w / 2 - margin && Math.abs(p.y - n.y) < n.h / 2 - margin;

function assertClear(curve, from, to, what) {
  samples(curve).forEach((p) => {
    assert.ok(!inside(p, from), `${what}: runs through the parent at ${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    assert.ok(!inside(p, to), `${what}: runs through the child at ${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  });
}

test("an ordinary child out beyond its parent gets a sideways S across the gap", async () => {
  const { branchCurve } = await load();
  const from = box(0, 0);
  const to = box(174, 260);
  const curve = branchCurve(from, to);

  assert.equal(curve.start.x, 70, "leaves the parent's outer edge");
  assert.equal(curve.start.y, 0);
  assert.equal(curve.end.y, 260, "arrives level with the child's middle");
  assert.ok(curve.end.x <= 104, "arrives at the child's leading edge");
  assertClear(curve, from, to, "sibling far down");
});

test("a chain link on its 45° diagonal drops from under the bullet into the next bullet", async () => {
  const { branchCurve } = await load();
  const from = box(0, 0);
  const to = box(48, 48);
  const curve = branchCurve(from, to);

  assert.equal(curve.start.y, 18, "leaves through the bottom of the parent");
  assert.ok(curve.start.x < -50, "from the bullet end, not the far end");
  assert.equal(curve.end.y, 48, "arrives level with the child's middle");
  assert.ok(curve.end.x <= to.x - to.w / 2, "arrives at the child's leading edge");
  assertClear(curve, from, to, "diagonal link");
});

test("the left wing is the mirror image", async () => {
  const { branchCurve } = await load();
  const from = box(0, 0, 140, 36, -1);
  const to = box(-48, 48, 140, 36, -1);
  const curve = branchCurve(from, to);

  assert.ok(curve.start.x > 50, "leaves from the bullet end, which is the right on this side");
  assert.ok(curve.end.x >= to.x + to.w / 2, "arrives at the child's right edge");
  assertClear(curve, from, to, "mirrored link");
});

test("a child dragged above its parent re-seats the elbow on top", async () => {
  const { branchCurve } = await load();
  const from = box(0, 0);
  const to = box(60, -90);
  const curve = branchCurve(from, to);

  assert.equal(curve.start.y, -18, "leaves through the top of the parent");
  assertClear(curve, from, to, "dragged above");
});

test("a child dragged behind its parent is met from the parent's back edge", async () => {
  const { branchCurve } = await load();
  const from = box(0, 0);
  const to = box(-220, 10);
  const curve = branchCurve(from, to);

  assert.equal(curve.start.x, -70, "leaves the edge that faces the child");
  assert.ok(curve.end.x >= to.x + to.w / 2, "arrives at the child's facing edge");
  assertClear(curve, from, to, "dragged behind");
});

test("a child below that reaches back past the bullet is entered from its top", async () => {
  const { branchCurve } = await load();
  const from = box(0, 0);
  const to = box(-40, 80);
  const curve = branchCurve(from, to);

  assert.equal(curve.end.y, 80 - 18, "arrives through the child's top");
  assertClear(curve, from, to, "reaching back");
});

test("wherever two separate labels sit, the branch between them crosses neither", async () => {
  const { branchCurve } = await load();
  // A fixed seed: the same thousand placements every run.
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  for (let i = 0; i < 1000; i += 1) {
    const side = random() < 0.5 ? 1 : -1;
    const from = box(0, 0, 60 + random() * 180, 30 + random() * 40, side);
    const to = box((random() - 0.5) * 700, (random() - 0.5) * 700, 60 + random() * 180, 30 + random() * 40, side);
    const apart =
      Math.abs(from.x - to.x) >= (from.w + to.w) / 2 || Math.abs(from.y - to.y) >= (from.h + to.h) / 2;
    if (!apart) continue;
    assertClear(branchCurve(from, to), from, to, `placement ${i}`);
  }
});
