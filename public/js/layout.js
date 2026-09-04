/**
 * Radial layout for the mind map: every node gets an angle and a radius, and
 * the centre sits at (0, 0).
 *
 * A force simulation was the wrong tool here. It settles somewhere different
 * every run, it has no notion of level, and the result is a cloud — readable as
 * a network, not as a map you can follow outward from the middle. This is
 * deterministic instead: a subtree's angular slice is proportional to how many
 * leaves it holds, and each ring is pushed out far enough that the labels on it
 * fit side by side around the circle.
 *
 * Pure: no DOM, no d3. Sizes come in through `sizeOf`. `test/layout.test.js`
 * covers it.
 */

const START_ANGLE = -Math.PI / 2; // first branch leaves the centre going up
const RING_PAD = 38; // clear space between one ring of labels and the next
const ARC_PAD = 24; // clear space between two labels on the same ring
const CHAIN_BEND = 0.3; // how far an only child leans out of its parent's line

/**
 * @param {ReturnType<import("./tree.js").buildTree>} tree
 * @param {{sizeOf:(id:string)=>{w:number,h:number}, ringPad?:number, arcPad?:number}} options
 * @returns {Map<string, {x:number,y:number,angle:number,radius:number}>}
 */
export function radialLayout(tree, { sizeOf, ringPad = RING_PAD, arcPad = ARC_PAD }) {
  const placed = new Map();
  if (!tree) return placed;

  const angles = assignAngles(tree);
  const depths = groupByDepth(tree);

  // A crowded level has to be far enough out that its labels fit side by side
  // around the circle. This is a floor per level, not the distance itself.
  const floor = depths.map((ring) => {
    const circumference = ring.reduce(
      (sum, id) => sum + tangentialExtent(sizeOf(id), angles.get(id)) + arcPad,
      0
    );
    return circumference / (2 * Math.PI);
  });

  // The distance itself is measured branch by branch. Shared rings meant the
  // one wide label lying along the radius pushed *every* branch out by its
  // width, which is how a map of ten concepts ended up needing the whole canvas
  // and reading at 58%. Here a chain going straight up costs its labels' height
  // and nothing more.
  const radii = new Map([[tree.root.id, 0]]);
  tree.order.forEach((id) => {
    const { parent, depth } = tree.byId.get(id);
    if (!parent) return;
    const angle = angles.get(id);
    const step =
      radialHalf(sizeOf(id), angle) + radialHalf(sizeOf(parent), angle) + ringPad;
    radii.set(id, Math.max(radii.get(parent) + step, floor[depth] || 0));
  });

  tree.order.forEach((id) => {
    const angle = angles.get(id);
    const radius = radii.get(id) || 0;
    placed.set(id, {
      angle,
      radius,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    });
  });

  return placed;
}

/**
 * Each subtree keeps a slice of the circle proportional to its leaf count.
 *
 * The exception is the only child, which would otherwise inherit its parent's
 * exact angle and turn a chain of causes into a straight spoke — the one shape
 * a hand-drawn map never has. It leans to alternating sides instead, by less
 * each ring, so a chain curves away from the centre and reads as a branch.
 */
function assignAngles(tree) {
  const angles = new Map();
  const walk = (id, from, to) => {
    const node = tree.byId.get(id);
    const middle = (from + to) / 2;
    angles.set(id, middle);

    if (node.children.length === 1) {
      const child = node.children[0];
      const lean = Math.min(CHAIN_BEND / Math.sqrt(node.depth + 1), (to - from) * 0.3);
      const bend = node.depth % 2 === 0 ? lean : -lean;
      // The whole slice travels with the child, so its own descendants keep
      // leaning around the curve instead of snapping back to the parent's line.
      walk(child, from + bend, to + bend);
      return;
    }

    let cursor = from;
    node.children.forEach((child) => {
      const share = (to - from) * (tree.byId.get(child).leaves / node.leaves);
      walk(child, cursor, cursor + share);
      cursor += share;
    });
  };
  walk(tree.root.id, START_ANGLE, START_ANGLE + Math.PI * 2);
  angles.set(tree.root.id, START_ANGLE);
  return angles;
}

function groupByDepth(tree) {
  const depths = [];
  tree.order.forEach((id) => {
    const { depth } = tree.byId.get(id);
    (depths[depth] ||= []).push(id);
  });
  for (let i = 0; i < depths.length; i += 1) depths[i] ||= [];
  return depths;
}

/** Half the thickness of a label measured along the radius it sits on. */
function radialHalf({ w, h }, angle) {
  return (Math.abs(w * Math.cos(angle)) + Math.abs(h * Math.sin(angle))) / 2;
}

/**
 * How much of the ring a label eats. A label at 3 o'clock lies along the radius
 * and costs its height; the same label at 12 o'clock lies across the ring and
 * costs its full width.
 */
function tangentialExtent({ w, h }, angle) {
  return Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle));
}
