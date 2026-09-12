/**
 * Where a branch leaves one label and arrives at the next.
 *
 * The route is chosen from where the two boxes actually sit, every frame, not
 * from what the layout meant to do with them — so a branch re-seats itself the
 * moment a node is dragged, the way a Miro connector snaps to whichever side
 * faces the shape it joins. Deciding from the layout's intent instead left a
 * dragged node with a branch still aimed at the side it used to face, cutting
 * back across its own text.
 *
 * The one rule behind every case: a branch only ever runs through the space
 * *between* two boxes, so it can never cross the words in either.
 *
 * Pure: no DOM, no d3. `test/routing.test.js` covers it.
 */

const MIN_GAP = 8; // less clear space than this and a sideways S has no room to turn
const RAIL_INSET = 10; // how far inside the leading edge the bullet sits

/** Point where the segment towards (tx, ty) leaves a node's box. */
export function borderPoint(node, tx, ty, pad = 0) {
  const dx = tx - node.x;
  const dy = ty - node.y;
  if (!dx && !dy) return { x: node.x, y: node.y };
  const hw = node.w / 2 + pad;
  const hh = node.h / 2 + pad;
  const scale = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

/**
 * @param {{x:number,y:number,w:number,h:number,side?:number}} from the parent
 * @param {{x:number,y:number,w:number,h:number,side?:number}} to the child
 * @returns {{start:{x:number,y:number}, c1:{x:number,y:number}, c2:{x:number,y:number}, end:{x:number,y:number}}}
 */
export function branchCurve(from, to) {
  // "Outward" is the wing's direction, not wherever the child happens to be:
  // a child dragged behind its parent is still judged against the edge its
  // bullet is on.
  const s = from.side || to.side || Math.sign(to.x - from.x) || 1;
  const lead = (n) => n.x - s * (n.w / 2);
  const trail = (n) => n.x + s * (n.w / 2);

  // Out beyond the parent: the ordinary branch, a sideways S across the gap.
  if (s * (lead(to) - trail(from)) >= MIN_GAP) {
    return sideways({ x: trail(from), y: from.y }, { x: lead(to) - s, y: to.y });
  }

  // Below or above it and overlapping sideways — a chain link on its diagonal
  // is this case. Drop from under the parent's bullet and turn into the child's
  // bullet: the elbow an indented list draws.
  const below = to.y - to.h / 2 >= from.y + from.h / 2;
  const above = to.y + to.h / 2 <= from.y - from.h / 2;
  if (below || above) {
    const v = below ? 1 : -1;
    const rail = lead(from) + s * RAIL_INSET;
    const start = { x: rail, y: from.y + v * (from.h / 2) };
    if (s * (lead(to) - rail) >= MIN_GAP) {
      const end = { x: lead(to) - s, y: to.y };
      return {
        start,
        c1: { x: rail, y: start.y + (end.y - start.y) * 0.7 },
        c2: { x: rail + (end.x - rail) * 0.3, y: end.y },
        end
      };
    }
    // The child reaches back past the parent's bullet, so its leading edge is
    // not facing the rail any more: come in through its top (or bottom).
    const left = to.x - to.w / 2 + RAIL_INSET;
    const right = to.x + to.w / 2 - RAIL_INSET;
    const end = { x: Math.min(Math.max(rail, left), right), y: to.y - v * (to.h / 2) };
    const mid = (start.y + end.y) / 2;
    return { start, c1: { x: start.x, y: mid }, c2: { x: end.x, y: mid }, end };
  }

  // Level with the parent but behind it: the same S, out of the other side.
  if (s * (lead(from) - trail(to)) >= MIN_GAP) {
    return sideways({ x: lead(from), y: from.y }, { x: trail(to) + s, y: to.y });
  }

  // Dragged on top of each other: no side faces the other, so go direct.
  const start = borderPoint(from, to.x, to.y);
  const end = borderPoint(to, from.x, from.y, 1);
  return {
    start,
    c1: { x: start.x + (end.x - start.x) / 3, y: start.y + (end.y - start.y) / 3 },
    c2: { x: start.x + ((end.x - start.x) * 2) / 3, y: start.y + ((end.y - start.y) * 2) / 3 },
    end
  };
}

/** An S that leaves and arrives horizontally, turning in the middle of the gap. */
function sideways(start, end) {
  const mid = (start.x + end.x) / 2;
  return { start, c1: { x: mid, y: start.y }, c2: { x: mid, y: end.y }, end };
}
