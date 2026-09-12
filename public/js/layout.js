/**
 * Two-wing layout for the mind map: the centre sits at (0, 0), branches leave
 * it left and right, and the children of a branch stack downward in a column.
 *
 * A ring per level was the wrong shape. Labels are wide and short, and a ring
 * only grows with its radius while the disc it encloses grows with the square —
 * so forty labels laid side by side around a circle forced the outer ring far
 * enough out that everything inside it was empty, and the map then fit on
 * screen at a third of its size. Stacked in a column those same labels waste
 * nothing: on the graph the change is a fill of 26% against 9%, and no two
 * labels landing on top of each other.
 *
 * A chain of only children folds downward instead of claiming a column each,
 * because a chain five deep spends five columns to say what five rows say just
 * as well. It folds on a 45° diagonal, not straight down: every link slides out
 * by exactly as much as it drops. Straight down, a chain ten deep became a wall
 * ten rows tall that made no progress away from the centre, so depth stopped
 * showing at all and the map came out taller than it was wide.
 *
 * Pure: no DOM, no d3. Sizes come in through `sizeOf`. `test/layout.test.js`
 * covers it.
 */

const GAP_X = 34; // clear space between a node and the column of its children
const GAP_Y = 12; // clear space between two labels stacked in the same column

/**
 * @param {ReturnType<import("./tree.js").buildTree>} tree
 * @param {{sizeOf:(id:string)=>{w:number,h:number}, gapX?:number, gapY?:number}} options
 * @returns {Map<string, {x:number,y:number,side:number}>}
 */
export function wingLayout(tree, { sizeOf, gapX = GAP_X, gapY = GAP_Y }) {
  const placed = new Map();
  if (!tree) return placed;

  const size = new Map(tree.order.map((id) => [id, sizeOf(id)]));
  const rootId = tree.root.id;
  const top = tree.byId.get(rootId).children;
  const folds = (id) => Boolean(id) && id !== rootId && tree.byId.get(id).children.length === 1;
  const isLink = (id) => folds(tree.byId.get(id).parent);

  const side = splitWings(tree, top, rowsPerSubtree(tree));
  const y = stackWings(tree, top, side, size, gapY, isLink);

  const x = new Map([[rootId, 0]]);
  tree.order.forEach((id) => {
    const { parent } = tree.byId.get(id);
    if (!parent) return;
    // Everything lines up on the edge facing the centre — the edge the bullet
    // sits on and the eye comes down — so `(cw - pw) / 2` is what turns a
    // shared edge into the two different middles the nodes are placed by.
    // Matching middles instead leaves a column with a ragged margin, which
    // reads as if the labels had been dropped rather than placed.
    //
    // A link's shared edge moves out by the same distance its row moved down,
    // which is what keeps the diagonal at 45° whatever height the labels are.
    const pw = size.get(parent).w;
    const cw = size.get(id).w;
    const step = folds(parent)
      ? (cw - pw) / 2 + (y.get(id) - y.get(parent))
      : pw / 2 + gapX + cw / 2;
    x.set(id, x.get(parent) + side.get(id) * step);
  });

  tree.order.forEach((id) => {
    placed.set(id, { x: x.get(id) || 0, y: y.get(id) || 0, side: side.get(id) });
  });
  return placed;
}

/**
 * How many rows a subtree occupies. Not the same as its leaf count: a folded
 * chain is one leaf but a row per link, and balancing the two wings on leaves
 * would pile a chain's whole height onto one side of the map.
 */
function rowsPerSubtree(tree) {
  const rows = new Map();
  [...tree.order].reverse().forEach((id) => {
    const kids = tree.byId.get(id).children;
    if (!kids.length) rows.set(id, 1);
    else if (kids.length === 1) rows.set(id, 1 + rows.get(kids[0]));
    else rows.set(id, kids.reduce((sum, child) => sum + rows.get(child), 0));
  });
  return rows;
}

/**
 * Which wing each node belongs to: each branch in turn goes to whichever wing
 * is currently shorter, and everything below it inherits that side.
 *
 * Cutting the list in half instead would be tidier to read, but the map an
 * extractor produces is rarely even — one branch routinely carries half the
 * transcript — and a cut leaves that branch alone on one side with the map
 * hanging off the edge of the screen. Taking the shorter wing each time keeps
 * the two halves within one branch of each other whatever the shape.
 */
function splitWings(tree, top, rows) {
  const side = new Map([[tree.root.id, 0]]);
  const load = new Map([[1, 0], [-1, 0]]);
  top.forEach((id) => {
    const dir = load.get(1) <= load.get(-1) ? 1 : -1;
    side.set(id, dir);
    load.set(dir, load.get(dir) + rows.get(id));
  });
  tree.order.forEach((id) => {
    const { parent } = tree.byId.get(id);
    if (parent && !side.has(id)) side.set(id, side.get(parent));
  });
  return side;
}

/** Vertical positions: one running cursor per wing, each wing then centred. */
function stackWings(tree, top, side, size, gapY, isLink) {
  const y = new Map([[tree.root.id, 0]]);

  [1, -1].forEach((dir) => {
    const wing = top.filter((id) => side.get(id) === dir);
    if (!wing.length) return;

    let cursor = null;
    let previous = 0;
    const row = (id) => {
      const { h } = size.get(id);
      cursor = cursor === null ? 0 : cursor + previous / 2 + gapY + h / 2;
      y.set(id, cursor);
      previous = h;
    };

    const stack = (id) => {
      const kids = tree.byId.get(id).children;
      // A leaf takes a row. So does a link in a chain, and its only child takes
      // the next one — that is the fold. A link that turns out to have children
      // of its own takes a row too, and heads the block they make underneath
      // it: centring it on them instead would lift it out of the column its
      // chain is standing in and leave a long thread back to the link above.
      if (!kids.length || kids.length === 1 || isLink(id)) {
        row(id);
        kids.forEach(stack);
        return;
      }
      kids.forEach(stack);
      y.set(id, alongsideChildren(id, kids, size, y));
    };

    wing.forEach(stack);
    centreWing(tree, wing, size, y);
  });

  return y;
}

/**
 * A parent sits level with the middle of its children — clamped to stay inside
 * their span, so a label taller than everything it holds cannot lean out of its
 * own block and into the branch stacked above.
 */
function alongsideChildren(id, kids, size, y) {
  const last = kids[kids.length - 1];
  const top = y.get(kids[0]) - size.get(kids[0]).h / 2;
  const bottom = y.get(last) + size.get(last).h / 2;
  const middle = (y.get(kids[0]) + y.get(last)) / 2;
  const half = size.get(id).h / 2;
  if (bottom - top < size.get(id).h) return middle;
  return Math.min(Math.max(middle, top + half), bottom - half);
}

/** Slides a wing so its block is centred on the middle of the map. */
function centreWing(tree, wing, size, y) {
  const ids = [];
  const walk = (id) => {
    ids.push(id);
    tree.byId.get(id).children.forEach(walk);
  };
  wing.forEach(walk);

  const lo = ids.reduce((min, id) => Math.min(min, y.get(id) - size.get(id).h / 2), Infinity);
  const hi = ids.reduce((max, id) => Math.max(max, y.get(id) + size.get(id).h / 2), -Infinity);
  const shift = (lo + hi) / 2;
  ids.forEach((id) => y.set(id, y.get(id) - shift));
}
