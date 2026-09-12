/**
 * Coordinates for the flow view: the last phase of the Sugiyama method, after
 * `causal.js` has decided which layer everything sits in and in what order.
 *
 * Left to right, one column per layer, because that is the direction a causal
 * chain is read in and because labels are wide and short — stacked in a column
 * they waste nothing, which is the same reason the mind map gave up its rings.
 * A column is only as wide as its widest label, so a layer of three-word nodes
 * does not pay for the one long sentence four layers away.
 *
 * Rows are where the readability actually comes from. Stacking each column and
 * leaving it there gives a diagram of correct but pointlessly diagonal arrows;
 * what makes a chain read as a chain is that an effect sits level with the
 * cause that feeds it. So each column is nudged towards the average height of
 * whatever points at it, then pushed apart again just enough that nothing
 * overlaps — sweeping right, then left, so the pull travels both ways.
 *
 * Pure: no DOM, no d3. Sizes come in through `sizeOf`. `test/flow-layout.test.js`
 * covers it.
 */

const GAP_X = 76; // clear space between one column of labels and the next
const GAP_Y = 20; // clear space between two labels stacked in the same column
const BEND_H = 16; // the room a passing edge claims in a column it crosses
const PASSES = 4;

/**
 * @param {ReturnType<import("./causal.js").buildCausal>} model
 * @param {{sizeOf:(id:string)=>{w:number,h:number}, gapX?:number, gapY?:number}} options
 * @returns {Map<string, {x:number, y:number, rank:number}>} keyed by slot id —
 *   a node id for a node, `<edgeId>@<rank>` for the bend of a passing edge.
 */
export function flowLayout(model, { sizeOf, gapX = GAP_X, gapY = GAP_Y, passes = PASSES }) {
  const placed = new Map();
  if (!model || !model.layers.length) return placed;

  const { layers } = model;
  const size = new Map();
  layers.forEach((layer) =>
    layer.forEach((slot) => {
      size.set(slot.id, slot.node ? sizeOf(slot.node) : { w: 0, h: BEND_H });
    })
  );

  const x = columnCentres(layers, size, gapX);
  const y = rows(model, layers, size, gapY, passes);

  layers.forEach((layer, rank) =>
    layer.forEach((slot) => {
      placed.set(slot.id, { x: x[rank], y: y.get(slot.id), rank });
    })
  );

  centre(placed);
  return placed;
}

/** One x per layer: each column as wide as its widest label, laid end to end. */
function columnCentres(layers, size, gapX) {
  const centres = [];
  let cursor = 0;
  layers.forEach((layer, rank) => {
    const width = layer.reduce((max, slot) => Math.max(max, size.get(slot.id).w), 0);
    centres[rank] = cursor + width / 2;
    cursor += width + gapX;
  });
  return centres;
}

function rows(model, layers, size, gapY, passes) {
  const y = new Map();
  layers.forEach((layer) => stack(layer, size, gapY).forEach((value, index) => y.set(layer[index].id, value)));

  // Who each slot should line up with, in the layer on either side. Bends count
  // as slots here, which is what keeps a long edge running straight instead of
  // bowing round whatever happens to be in the way.
  const ahead = new Map();
  const behind = new Map();
  const join = (a, b) => {
    if (!ahead.has(a)) ahead.set(a, []);
    if (!behind.has(b)) behind.set(b, []);
    ahead.get(a).push(b);
    behind.get(b).push(a);
  };
  model.links.forEach((link) => {
    if (link.back) return;
    [link.from, ...link.bends, link.to].reduce((a, b) => {
      join(a, b);
      return b;
    });
  });

  for (let pass = 0; pass < passes; pass += 1) {
    const down = pass % 2 === 0;
    const reference = down ? behind : ahead;
    const range = down ? layers.slice(1) : layers.slice(0, -1).reverse();

    range.forEach((layer) => {
      const wanted = layer.map((slot) => {
        const peers = (reference.get(slot.id) || [])
          .map((id) => y.get(id))
          .filter((value) => Number.isFinite(value));
        return peers.length ? peers.reduce((a, b) => a + b, 0) / peers.length : y.get(slot.id);
      });
      settle(layer, size, gapY, wanted).forEach((value, index) => y.set(layer[index].id, value));
    });
  }

  return y;
}

/** A column with nothing to line up with yet: one label under the next. */
function stack(layer, size, gapY) {
  const out = [];
  let cursor = 0;
  layer.forEach((slot, index) => {
    const { h } = size.get(slot.id);
    cursor = index === 0 ? h / 2 : cursor + size.get(layer[index - 1].id).h / 2 + gapY + h / 2;
    out.push(cursor);
  });
  return out;
}

/**
 * Puts a column as close to where it wants to be as it can get without any two
 * labels touching.
 *
 * Walking down from the top and pushing each label clear of the one above gives
 * a legal column, but one that has sagged: every label the walk had to push is
 * now lower than it asked for, and the whole column drifts down the further you
 * go. Sliding the finished column back by the average of those pushes cancels
 * the drift without disturbing a single gap, since moving every label by the
 * same amount cannot make two of them collide.
 */
function settle(layer, size, gapY, wanted) {
  const out = [];
  layer.forEach((slot, index) => {
    const { h } = size.get(slot.id);
    if (index === 0) {
      out.push(wanted[0]);
      return;
    }
    const floor = out[index - 1] + size.get(layer[index - 1].id).h / 2 + gapY + h / 2;
    out.push(Math.max(wanted[index], floor));
  });

  const drift = out.reduce((sum, value, index) => sum + (value - wanted[index]), 0) / out.length;
  return out.map((value) => value - drift);
}

/** Slides the whole diagram so its middle sits on the origin, as the map does. */
function centre(placed) {
  const points = [...placed.values()];
  if (!points.length) return;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const dx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const dy = (Math.min(...ys) + Math.max(...ys)) / 2;
  placed.forEach((point) => {
    point.x -= dx;
    point.y -= dy;
  });
}
