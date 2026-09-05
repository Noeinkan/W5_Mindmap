/**
 * Turns the typed graph into the tree a mind map needs.
 *
 * The extractor does not produce a tree: it produces a handful of small chains
 * and stars, one per chunk, with no shared centre. Drawn as they are, that is a
 * scatter of pills — which is exactly why the old canvas did not read as a mind
 * map. Here every component is rooted, and when there is more than one they are
 * hung off a synthetic centre standing for the transcript itself, so the whole
 * thing has one middle and branches going outward.
 *
 * Edges that are not part of the tree are not thrown away: they come back as
 * `crossEdges`, drawn thin and dashed, so the typed relations survive.
 *
 * Pure: no DOM, no d3. `test/tree.test.js` covers it.
 */

export const SYNTHETIC_ROOT = "__root";

/**
 * @param {Array<{id:string,label:string,type:string}>} nodes
 * @param {Array<{id:string,from:string,to:string,type:string}>} edges
 * @param {{title?:string}} [options]
 * @returns {null|{
 *   root: {id:string,label:string,synthetic:boolean},
 *   byId: Map<string, {id:string,parent:string|null,depth:number,branch:string|null,children:string[],leaves:number}>,
 *   order: string[],
 *   treeEdges: Array<{from:string,to:string,edge:object|null}>,
 *   crossEdges: object[]
 * }}
 */
export function buildTree(nodes, edges, { title = "Central topic" } = {}) {
  if (!nodes.length) return null;

  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const links = edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);

  const out = new Map(ids.map((id) => [id, []]));
  const inn = new Map(ids.map((id) => [id, []]));
  const both = new Map(ids.map((id) => [id, []]));
  links.forEach((e) => {
    out.get(e.from).push(e);
    inn.get(e.to).push(e);
    both.get(e.from).push(e);
    both.get(e.to).push(e);
  });

  const groups = components(ids, both);
  const roots = groups.map((group) => pickRoot(group, inn, both));

  // One component with a natural centre needs no invented one; several do, and
  // the invented one is what stops the map reading as unrelated islands.
  const synthetic = roots.length > 1;
  const rootId = synthetic ? SYNTHETIC_ROOT : roots[0];

  const byId = new Map();
  const order = [];
  const treeEdges = [];
  const usedEdgeIds = new Set();

  const place = (id, parent, depth, branch) => {
    byId.set(id, { id, parent, depth, branch, children: [], leaves: 0 });
    order.push(id);
    if (parent) byId.get(parent).children.push(id);
  };

  place(rootId, null, 0, null);

  if (synthetic) {
    roots.forEach((id) => {
      treeEdges.push({ from: rootId, to: id, edge: null });
      place(id, rootId, 1, id);
    });
  }

  // Breadth-first from each root, following the edge direction first so a chain
  // of causes reads outward from its head instead of doubling back.
  const queue = synthetic ? [...roots] : [rootId];
  const seen = new Set(queue);
  if (!synthetic) seen.add(rootId);

  while (queue.length) {
    const id = queue.shift();
    const parent = byId.get(id);
    const candidates = [...out.get(id), ...inn.get(id)];
    candidates.forEach((edge) => {
      if (usedEdgeIds.has(edge.id)) return;
      const next = edge.from === id ? edge.to : edge.from;
      if (seen.has(next)) return;
      seen.add(next);
      usedEdgeIds.add(edge.id);
      const depth = parent.depth + 1;
      place(next, id, depth, depth === 1 ? next : parent.branch);
      treeEdges.push({ from: id, to: next, edge });
      queue.push(next);
    });
  }

  countLeaves(rootId, byId);

  return {
    root: {
      id: rootId,
      label: synthetic ? title : nodes.find((n) => n.id === rootId).label,
      synthetic
    },
    byId,
    order,
    treeEdges,
    crossEdges: links.filter((e) => !usedEdgeIds.has(e.id))
  };
}

/**
 * Cuts the branches the reader has folded away out of the tree, and reports how
 * many nodes each fold is holding.
 *
 * Deliberately not a paint-time filter, which is how the legend hides a type: a
 * node that keeps its place in the layout while invisible saves no room, and
 * room is the entire reason to fold a branch. So the cut happens here, before
 * anything is measured, and what comes out is a smaller tree of the same shape
 * — every later stage stays unaware that folding exists.
 *
 * The tree is returned unchanged when nothing is folded, so the common case
 * costs one `size` check.
 *
 * @param {ReturnType<buildTree>} tree
 * @param {Set<string>} collapsed
 * @returns {{tree: ReturnType<buildTree>, hidden: Map<string, number>}}
 */
export function collapseTree(tree, collapsed) {
  const hidden = new Map();
  if (!tree || !collapsed || !collapsed.size) return { tree, hidden };

  const dropped = new Set();
  const dropBelow = (id) => {
    tree.byId.get(id).children.forEach((child) => {
      dropped.add(child);
      dropBelow(child);
    });
  };

  // From the root down, so a fold inside a folded branch costs nothing: by the
  // time we would reach it, its whole subtree has already gone.
  const walk = (id) => {
    const node = tree.byId.get(id);
    if (collapsed.has(id) && node.children.length) {
      const before = dropped.size;
      dropBelow(id);
      hidden.set(id, dropped.size - before);
      return;
    }
    node.children.forEach(walk);
  };
  walk(tree.root.id);

  if (!dropped.size) return { tree, hidden };

  const byId = new Map();
  tree.order.forEach((id) => {
    if (dropped.has(id)) return;
    const node = tree.byId.get(id);
    byId.set(id, { ...node, children: node.children.filter((c) => !dropped.has(c)) });
  });
  countLeaves(tree.root.id, byId);

  return {
    tree: {
      ...tree,
      byId,
      order: tree.order.filter((id) => !dropped.has(id)),
      treeEdges: tree.treeEdges.filter((e) => !dropped.has(e.to)),
      // A typed relation into a folded branch has nothing to point at any more.
      // It comes back the moment the branch is opened, because the fold is only
      // ever a filter over the full tree, never an edit to it.
      crossEdges: tree.crossEdges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to))
    },
    hidden
  };
}

/** Connected components over the undirected graph, in node order. */
function components(ids, both) {
  const seen = new Set();
  const groups = [];
  ids.forEach((id) => {
    if (seen.has(id)) return;
    const group = [];
    const queue = [id];
    seen.add(id);
    while (queue.length) {
      const current = queue.shift();
      group.push(current);
      both.get(current).forEach((e) => {
        const next = e.from === current ? e.to : e.from;
        if (seen.has(next)) return;
        seen.add(next);
        queue.push(next);
      });
    }
    groups.push(group);
  });
  return groups;
}

/**
 * The node a component should hang from: something nothing points at, because
 * that is where a causal chain starts, and among those the best connected.
 * A cycle has no such node, so there the busiest one wins.
 */
function pickRoot(group, inn, both) {
  const sources = group.filter((id) => inn.get(id).length === 0);
  const pool = sources.length ? sources : group;
  return pool.reduce(
    (best, id) => (both.get(id).length > both.get(best).length ? id : best),
    pool[0]
  );
}

/** Leaf count per subtree — the weight each branch gets in the angular spread. */
function countLeaves(id, byId) {
  const node = byId.get(id);
  if (!node.children.length) {
    node.leaves = 1;
    return 1;
  }
  node.leaves = node.children.reduce((sum, child) => sum + countLeaves(child, byId), 0);
  return node.leaves;
}
