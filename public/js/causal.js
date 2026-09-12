/**
 * The causal model behind the flow view: the same typed graph read as cause and
 * effect instead of as a mind map.
 *
 * No second document and no new field in the saved file. Three of the four edge
 * types already say which way an influence runs — `causes` and `supports` push
 * the effect in the same direction as the cause, `contrasts` pushes against it,
 * and `relates` says nothing about effect at all, so it never earns a place on
 * the spine. Reading that off the type is what lets a map saved months ago open
 * in this view with no migration and no re-reading of the transcript.
 *
 * The shape is Sugiyama's, the standard way a directed graph is drawn so it can
 * be followed: break the cycles, put every node in a numbered layer, order each
 * layer so the arrows cross as little as possible, and leave the coordinates to
 * `flow-layout.js`. Causes end up on the left, effects on the right, and every
 * arrow points the same way — which is the whole reason a chain reads as a
 * chain rather than as the cloud the force layout used to draw.
 *
 * The cycles broken in step one are not thrown away. A cycle in a causal graph
 * is a feedback loop, and a feedback loop is the most interesting thing such a
 * diagram can find: each comes back labelled by the convention systems thinkers
 * already read — count the negative links going round it, an even count means
 * the loop reinforces itself (R), an odd count means it balances itself (B).
 *
 * Pure: no DOM, no d3. `test/causal.test.js` covers it.
 */

/** The edge types that assert an influence. `relates` deliberately is not one. */
export const CAUSAL_EDGE_TYPES = ["causes", "supports", "contrasts"];

const SIGN = { causes: 1, supports: 1, contrasts: -1 };

/** +1 same direction, −1 opposite, 0 for a type that claims no influence. */
export const polarityOf = (type) => SIGN[type] ?? 0;

export const isCausalType = (type) => Object.prototype.hasOwnProperty.call(SIGN, type);

/** Where a node sits in the story, read off the arrows rather than off its type. */
export const ROLES = ["trigger", "link", "outcome"];

// Four passes settle a map of this size; the ordering stops improving well
// before that, and each pass is two linear walks over the layers.
const SWEEPS = 4;

/**
 * @param {Array<{id:string,label:string,type:string}>} nodes
 * @param {Array<{id:string,from:string,to:string,type:string}>} edges
 * @returns {null | {
 *   ids: string[],
 *   byId: Map<string, {id:string, rank:number, role:string, pos:number}>,
 *   layers: Array<Array<{id:string, node:string|null, edge:string|null}>>,
 *   links: Array<{id, from, to, type, polarity:number, back:boolean, loop:string|null, bends:string[]}>,
 *   loops: Array<{id, label, kind, nodes:string[], edges:string[]}>,
 *   context: Array<{id, from, to, type}>,
 *   omitted: number
 * }}
 */
export function buildCausal(nodes, edges, { sweeps = SWEEPS } = {}) {
  const known = new Map(nodes.map((n) => [n.id, n]));
  const joins = (e) => known.has(e.from) && known.has(e.to) && e.from !== e.to;

  const causal = edges.filter((e) => joins(e) && isCausalType(e.type));
  // Nothing asserts an influence, so there is no diagram to draw — not an empty
  // one. The view says so and offers the causal re-read instead.
  if (!causal.length) return null;

  const live = new Set();
  causal.forEach((e) => {
    live.add(e.from);
    live.add(e.to);
  });
  // Document order, so a map that has not changed comes back laid out the same.
  const ids = nodes.filter((n) => live.has(n.id)).map((n) => n.id);

  const out = new Map(ids.map((id) => [id, []]));
  const inn = new Map(ids.map((id) => [id, []]));
  causal.forEach((e) => {
    out.get(e.from).push(e);
    inn.get(e.to).push(e);
  });

  const { back, loops } = breakCycles(ids, out);
  const rank = rankNodes(
    ids,
    causal.filter((e) => !back.has(e.id))
  );

  const loopByEdge = new Map();
  loops.forEach((loop) => loop.edges.forEach((id) => loopByEdge.set(id, loop.id)));

  const layers = Array.from({ length: Math.max(...rank.values()) + 1 }, () => []);
  ids.forEach((id) => layers[rank.get(id)].push({ id, node: id, edge: null }));

  const links = causal.map((edge) => ({
    ...edge,
    polarity: polarityOf(edge.type),
    back: back.has(edge.id),
    loop: loopByEdge.get(edge.id) || null,
    // An edge that skips layers gets a bend in each one it passes through, so
    // the ordering below can steer it round the boxes standing in the way
    // instead of letting it cut straight across them.
    bends: back.has(edge.id)
      ? []
      : bendsFor(edge, rank.get(edge.from), rank.get(edge.to), layers)
  }));

  order(layers, links, sweeps);

  const byId = new Map();
  layers.forEach((layer) =>
    layer.forEach((slot, pos) => {
      if (!slot.node) return;
      byId.set(slot.node, {
        id: slot.node,
        rank: rank.get(slot.node),
        role: roleOf(slot.node, inn, out),
        pos
      });
    })
  );

  return {
    ids,
    byId,
    layers,
    links,
    loops,
    // Association without a direction of effect. It is drawn, faintly, because
    // dropping it would silently hide a relation the map does record — but it
    // never ranks a node, or the layering would claim a causality nobody wrote.
    context: edges.filter((e) => joins(e) && !isCausalType(e.type) && live.has(e.from) && live.has(e.to)),
    /** Concepts with no causal link at all: on the map, absent from the flow. */
    omitted: nodes.length - ids.length
  };
}

function bendsFor(edge, from, to, layers) {
  const bends = [];
  for (let rank = from + 1; rank < to; rank += 1) {
    const slot = { id: `${edge.id}@${rank}`, node: null, edge: edge.id };
    layers[rank].push(slot);
    bends.push(slot.id);
  }
  return bends;
}

/**
 * Trigger, link or outcome — read off the arrows, not off the node type.
 *
 * Deliberately topological: the extractor's node types (`cause`, `theme`,
 * `hierarchy`) describe what a concept *is*, and a diagram of cause and effect
 * needs to know where it *stands*. A concept nothing points at is where the
 * chain starts however the model typed it, and a concept that points at nothing
 * is where it lands.
 */
function roleOf(id, inn, out) {
  if (!inn.get(id).length) return "trigger";
  if (!out.get(id).length) return "outcome";
  return "link";
}

/* ------------------------------------------------------------------ */
/* Cycles                                                              */
/* ------------------------------------------------------------------ */

/**
 * Depth-first walk that names the edges closing a cycle, and the loop each one
 * closes.
 *
 * Those edges are pulled out of the layering — a layer number cannot exist while
 * a cycle does — but not out of the diagram: they come back drawn as an arc
 * running against the flow, which is exactly what a feedback loop looks like on
 * paper.
 */
function breakCycles(ids, out) {
  const UNSEEN = 0;
  const OPEN = 1;
  const CLOSED = 2;

  const mark = new Map(ids.map((id) => [id, UNSEEN]));
  const back = new Set();
  const cycles = [];
  const stack = [];
  // The edge that led into each node on the stack, so a cycle can be read off
  // as the nodes *and* the edges between them — the signs on those edges are
  // what decides whether the loop reinforces or balances.
  const via = [];

  const walk = (id) => {
    mark.set(id, OPEN);
    stack.push(id);

    out.get(id).forEach((edge) => {
      const next = edge.to;
      if (mark.get(next) === UNSEEN) {
        via.push(edge);
        walk(next);
        via.pop();
        return;
      }
      // A node already finished is reached by a second route, not by a cycle.
      if (mark.get(next) !== OPEN) return;
      back.add(edge.id);
      const at = stack.lastIndexOf(next);
      cycles.push({ nodes: stack.slice(at), edges: via.slice(at).concat([edge]) });
    });

    stack.pop();
    mark.set(id, CLOSED);
  };

  ids.forEach((id) => {
    if (mark.get(id) === UNSEEN) walk(id);
  });

  return { back, loops: labelLoops(cycles) };
}

/**
 * R or B, by the rule every systems-thinking text uses: count the negative
 * links round the loop. An even count (none included) means the effect comes
 * back with the same sign it left with, so the loop feeds itself — reinforcing.
 * An odd count means it comes back inverted and damps itself — balancing.
 */
function labelLoops(cycles) {
  const seen = { reinforcing: 0, balancing: 0 };
  return cycles.map((cycle, index) => {
    const negatives = cycle.edges.filter((e) => polarityOf(e.type) < 0).length;
    const kind = negatives % 2 === 0 ? "reinforcing" : "balancing";
    seen[kind] += 1;
    return {
      id: `loop${index + 1}`,
      kind,
      label: `${kind === "reinforcing" ? "R" : "B"}${seen[kind]}`,
      negatives,
      nodes: cycle.nodes,
      edges: cycle.edges.map((e) => e.id)
    };
  });
}

/* ------------------------------------------------------------------ */
/* Layering                                                            */
/* ------------------------------------------------------------------ */

/**
 * Longest path from a source, which is what puts every cause strictly to the
 * left of everything it causes. Ranking by shortest path instead would let an
 * effect sit level with one of its own causes wherever a second, shorter route
 * reached it — and a diagram where an arrow runs backwards is a diagram nobody
 * can follow.
 */
function rankNodes(ids, forward) {
  const after = new Map(ids.map((id) => [id, []]));
  const waiting = new Map(ids.map((id) => [id, 0]));
  forward.forEach((e) => {
    after.get(e.from).push(e.to);
    waiting.set(e.to, waiting.get(e.to) + 1);
  });

  const rank = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => waiting.get(id) === 0);

  while (queue.length) {
    const id = queue.shift();
    after.get(id).forEach((next) => {
      rank.set(next, Math.max(rank.get(next), rank.get(id) + 1));
      waiting.set(next, waiting.get(next) - 1);
      if (!waiting.get(next)) queue.push(next);
    });
  }

  return rank;
}

/* ------------------------------------------------------------------ */
/* Ordering within a layer                                             */
/* ------------------------------------------------------------------ */

/**
 * Reorders each layer so the arrows between neighbouring layers cross as little
 * as possible — the barycentre heuristic, which is cheap and within a few per
 * cent of optimal in practice: each slot moves to the average position of what
 * it is joined to in the layer next door, sweeping right then left.
 *
 * Only the order changes here; nothing has a coordinate yet.
 */
function order(layers, links, sweeps) {
  const ahead = new Map();
  const behind = new Map();
  const join = (a, b) => {
    if (!ahead.has(a)) ahead.set(a, []);
    if (!behind.has(b)) behind.set(b, []);
    ahead.get(a).push(b);
    behind.get(b).push(a);
  };

  links.forEach((link) => {
    if (link.back) return;
    // Through the bends, so a long edge steers the layers it passes over.
    [link.from, ...link.bends, link.to].reduce((a, b) => {
      join(a, b);
      return b;
    });
  });

  const place = () => {
    const at = new Map();
    layers.forEach((layer) => layer.forEach((slot, index) => at.set(slot.id, index)));
    return at;
  };

  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    const down = sweep % 2 === 0;
    const at = place();
    const reference = down ? behind : ahead;
    const range = down ? layers.slice(1) : layers.slice(0, -1).reverse();

    range.forEach((layer) => {
      const was = new Map(layer.map((slot, index) => [slot.id, index]));
      const key = new Map(
        layer.map((slot, index) => {
          const peers = (reference.get(slot.id) || [])
            .map((id) => at.get(id))
            .filter((value) => value !== undefined);
          // Nothing to line up with, so it keeps the place it already has.
          return [slot.id, peers.length ? peers.reduce((a, b) => a + b, 0) / peers.length : index];
        })
      );
      // The place it held before this sweep is the tie-break, read from a map
      // taken beforehand: asking the array being sorted where a slot is gives a
      // different answer halfway through the sort, and two slots sharing a
      // barycentre would then swap places on every pass forever.
      layer.sort((a, b) => key.get(a.id) - key.get(b.id) || was.get(a.id) - was.get(b.id));
      layer.forEach((slot, index) => at.set(slot.id, index));
    });
  }
}
