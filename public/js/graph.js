/**
 * The map view: a radial mind map drawn with D3, not a force-directed cloud.
 *
 * What changed and why. The old canvas ran d3-force over the raw graph, so the
 * result had no centre, no levels and a different shape every run — a network
 * diagram, which is not what anyone means by a mind map. Here `tree.js` roots
 * the graph, `layout.js` hangs the branches off the centre in two wings, and
 * the branches are drawn as tapered ribbons carrying one colour per branch of
 * the centre. Colour therefore answers "which part of the map is this?" before
 * a single label is read, while node *type* keeps its own colour on the dot and
 * in the legend filter.
 *
 * `fitWhenSettled` survives the rewrite with the same contract — fit only once
 * the layout has stopped moving, cancelled if the user pans meanwhile — because
 * fitting mid-movement measures a knot and lands at the scale clamp. What it
 * waits for is now the position tween rather than the simulation cooling.
 *
 * Visual attributes are written inline rather than through CSS classes, so the
 * live SVG can be serialised straight into the PNG export.
 */

import { state, neighboursOf, isVisible, matchesQuery } from "./state.js";
import { buildTree, collapseTree, SYNTHETIC_ROOT } from "./tree.js";
import { wingLayout } from "./layout.js";
import { wrapLabel, curvePath, ribbonPath } from "./geometry.js";
import { borderPoint, branchCurve } from "./routing.js";
import { readPalette, branchColour, fade } from "./palette.js";

/** Font, label width and padding per level — the centre shouts, the leaves talk. */
const LEVEL = [
  { font: 20, maxWidth: 250, padX: 26, padY: 15 },
  { font: 15.5, maxWidth: 200, padX: 19, padY: 12 },
  { font: 14.5, maxWidth: 150, padX: 13, padY: 9 },
  { font: 13.5, maxWidth: 140, padX: 12, padY: 8 }
];
const levelOf = (depth) => LEVEL[Math.min(depth, LEVEL.length - 1)];

const ARROW_GAP = 9;
const MOVE_MS = 420;

export function createGraph(svgEl, handlers = {}) {
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const defs = svg.append("defs");
  const viewport = svg.append("g").attr("class", "viewport");
  const branchLayer = viewport.append("g").attr("class", "branches");
  const linkLayer = viewport.append("g").attr("class", "links");
  const nodeLayer = viewport.append("g").attr("class", "nodes");

  let palette = readPalette();
  let tree = null;
  let drawables = [];
  let byId = new Map();
  let branches = [];
  let crossLinks = [];
  let visuals = new Map();
  /** How many nodes each folded branch is holding, for the badge on it. */
  let folded = new Map();
  let hoveredId = null;
  let transform = d3.zoomIdentity;
  let mover = null;
  let pendingFit = null;
  let pendingCentre = null;
  /** The tree before folding — the only thing that knows where a hidden node was. */
  let full = null;

  const root = { id: SYNTHETIC_ROOT, synthetic: true, label: "", type: null, x: 0, y: 0 };

  const zoom = d3
    .zoom()
    .scaleExtent([0.15, 3])
    .on("zoom", (event) => {
      transform = event.transform;
      viewport.attr("transform", transform);
      // A pan or zoom by hand outranks a move of the viewport we are still
      // waiting to perform. Only a real gesture counts: our own transitions
      // arrive with no source event.
      if (event.sourceEvent) {
        pendingFit = null;
        pendingCentre = null;
      }
      handlers.onZoom?.(transform);
    });

  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", () => handlers.onBackgroundClick?.());

  writeMarkers();
  centreOrigin();

  /** Puts graph coordinate (0,0) — the centre of the map — mid-screen. */
  function centreOrigin() {
    const { width, height } = svgEl.getBoundingClientRect();
    if (!width || !height) return;
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2));
  }

  /* ---------------------------------------------------------------- */
  /* Model: tree, measurement, layout                                  */
  /* ---------------------------------------------------------------- */

  function build() {
    // The folded branches come out before anything is measured, so the layout
    // never knows they existed and the space they took is genuinely given back.
    const whole = buildTree(state.nodes, state.edges, { title: state.title });
    const cut = collapseTree(whole, state.collapsed);
    full = whole;
    tree = cut.tree;
    folded = cut.hidden;
    root.label = state.title;

    if (!tree) {
      drawables = [];
      byId = new Map();
      branches = [];
      crossLinks = [];
      visuals = new Map();
      folded = new Map();
      return new Map();
    }

    drawables = (tree.root.synthetic ? [root] : []).concat(
      state.nodes.filter((n) => tree.byId.has(n.id))
    );
    byId = new Map(drawables.map((n) => [n.id, n]));

    // The hue of a branch comes from the order the centre's children were
    // found, so the same map keeps the same colours from one run to the next.
    const branchIndex = new Map(
      tree.byId.get(tree.root.id).children.map((id, index) => [id, index])
    );

    const family = getComputedStyle(document.body).fontFamily;
    visuals = new Map();
    drawables.forEach((node) => {
      const meta = tree.byId.get(node.id);
      const depth = meta?.depth ?? 1;
      const level = levelOf(depth);
      const wrapped = wrapLabel(node.label, {
        fontSize: level.font,
        family,
        maxWidth: level.maxWidth,
        maxLines: depth === 0 ? 2 : 3
      });
      node.w = wrapped.width + level.padX * 2 + (node.synthetic ? 0 : 14);
      node.h = wrapped.height + level.padY * 2;
      visuals.set(node.id, {
        depth,
        wrapped,
        level,
        boxed: depth <= 1,
        colour: branchColour(palette, meta?.branch, branchIndex.get(meta?.branch) ?? 0)
      });
    });

    const placed = wingLayout(tree, {
      sizeOf: (id) => {
        const node = byId.get(id);
        return node ? { w: node.w, h: node.h } : { w: 100, h: 34 };
      }
    });

    branches = tree.treeEdges.map(({ from, to, edge }) => ({
      id: `${from}->${to}`,
      from,
      to,
      edge,
      colour: visuals.get(to)?.colour
    }));
    crossLinks = tree.crossEdges.map((e) => ({ ...e }));

    return placed;
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function render({ animate = true } = {}) {
    const placed = build();

    const targets = new Map();
    drawables.forEach((node) => {
      const spot = placed.get(node.id);
      if (!spot) return;
      node.side = spot.side;
      // A node the user dragged keeps the position they gave it; everything
      // else goes where the layout says.
      targets.set(node.id, node.pinned ? { x: node.x, y: node.y } : { x: spot.x, y: spot.y });
    });

    joinNodes();
    joinBranches();
    joinLinks();
    moveTo(targets, animate);
    paint();
  }

  function joinNodes() {
    nodeLayer
      .selectAll("g.node")
      .data(drawables, (d) => d.id)
      .join(
        (enter) => {
          const g = enter.append("g").attr("class", "node");
          g.append("rect").attr("class", "hit").attr("fill", "transparent");
          g.append("rect").attr("class", "body");
          g.append("line").attr("class", "rule").attr("stroke-linecap", "round");
          g.append("circle").attr("class", "bullet");
          g.append("text").attr("class", "label").attr("pointer-events", "none");

          // The fold badge: a minus while the branch is open, the count of what
          // it is holding once it is shut. Shut, it has to stay on screen — it
          // is the only thing saying the branch is there at all — so only the
          // minus waits for a hover, which keeps a busy map from sprouting a
          // control on every node.
          const fold = g.append("g").attr("class", "fold").attr("cursor", "pointer");
          fold.append("rect").attr("class", "fold-pill");
          fold
            .append("text")
            .attr("class", "fold-mark")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("pointer-events", "none")
            .attr("font-weight", 700);
          fold
            // The badge sits over the node, so pressing it must not start the
            // drag underneath and clicking it must not also select the node.
            .on("mousedown", (event) => event.stopPropagation())
            .on("click", (event, d) => {
              event.stopPropagation();
              handlers.onNodeToggle?.(d, event);
            });

          // Native tooltip, so a label clipped at three lines is still readable.
          g.append("title");
          g.call(dragBehaviour())
            .on("click", (event, d) => {
              event.stopPropagation();
              handlers.onNodeClick?.(d, event);
            })
            .on("dblclick", (event, d) => {
              event.stopPropagation();
              handlers.onNodeDoubleClick?.(d, event);
            })
            .on("mouseenter", (event, d) => {
              hoveredId = d.id;
              paint();
            })
            .on("mouseleave", () => {
              hoveredId = null;
              paint();
            });
          return g;
        },
        (update) => update,
        (exit) => exit.remove()
      )
      .each(function (d) {
        const { wrapped, level, boxed, depth } = visuals.get(d.id);
        const g = d3.select(this);
        const corner = boxed ? d.h / 2 : 8;
        // A node in the left wing is met by its branch on the right, so its
        // bullet and its text turn round to face it: reading outward from the
        // centre then works the same way on both sides.
        const mirrored = d.side < 0;
        const inset = level.padX + (d.synthetic ? 0 : 12);
        const textX = mirrored ? d.w / 2 - inset : -d.w / 2 + inset;
        const bulletX = mirrored
          ? d.w / 2 - level.padX * 0.6
          : -d.w / 2 + level.padX * 0.6;

        g.select("rect.hit")
          .attr("x", -d.w / 2)
          .attr("y", -d.h / 2)
          .attr("width", d.w)
          .attr("height", d.h)
          .attr("rx", corner);
        g.select("rect.body")
          .attr("x", -d.w / 2)
          .attr("y", -d.h / 2)
          .attr("width", d.w)
          .attr("height", d.h)
          .attr("rx", corner)
          .attr("display", boxed ? null : "none");
        // Leaves get no box at all — a rule under the words, the way a hand
        // drawn map writes a leaf along its branch.
        g.select("line.rule")
          .attr("x1", -d.w / 2 + 6)
          .attr("x2", d.w / 2 - 6)
          .attr("y1", d.h / 2 - 3)
          .attr("y2", d.h / 2 - 3)
          .attr("display", boxed ? "none" : null);
        g.select("circle.bullet")
          .attr("cx", bulletX)
          .attr("cy", 0)
          .attr("r", d.synthetic ? 0 : 3.6);

        // The badge straddles the edge the children hang off, so it reads as
        // the door into them rather than as decoration on the label.
        const hidden = folded.get(d.id) || 0;
        const open = tree?.byId.get(d.id)?.children.length || 0;
        const mark = hidden ? String(hidden) : "−";
        const pill = Math.max(20, mark.length * 8 + 12);
        g.select("g.fold")
          .attr("display", !d.synthetic && (hidden || open) ? null : "none")
          .attr("transform", `translate(${(d.side || 1) * (d.w / 2)},0)`);
        g.select("rect.fold-pill")
          .attr("x", -pill / 2)
          .attr("y", -9)
          .attr("width", pill)
          .attr("height", 18)
          .attr("rx", 9);
        g.select("text.fold-mark")
          .attr("font-size", hidden ? 10.5 : 13)
          .attr("font-family", getComputedStyle(document.body).fontFamily)
          .text(mark);
        g.select("title").text(
          hidden ? `${d.label} — ${hidden} hidden, click the badge to open` : d.label
        );

        const text = g
          .select("text.label")
          .attr("font-size", level.font)
          .attr("font-weight", depth === 0 ? 700 : 600)
          .attr("font-family", getComputedStyle(document.body).fontFamily)
          .attr("dominant-baseline", "central");
        text.selectAll("tspan").remove();
        const top = -((wrapped.lines.length - 1) * wrapped.lineHeight) / 2;
        wrapped.lines.forEach((line, index) => {
          text
            .append("tspan")
            .attr("x", textX)
            .attr("y", top + index * wrapped.lineHeight)
            .attr("text-anchor", mirrored ? "end" : "start")
            .text(line);
        });
      });
  }

  function joinBranches() {
    branchLayer
      .selectAll("path.branch")
      .data(branches, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append("path")
            .attr("class", "branch")
            .attr("stroke", "none")
            .on("click", (event, d) => {
              if (!d.edge) return;
              event.stopPropagation();
              handlers.onEdgeClick?.(d.edge, event);
            })
            .on("mouseenter", (event, d) => {
              hoveredId = d.edge?.id || null;
              paint();
            })
            .on("mouseleave", () => {
              hoveredId = null;
              paint();
            }),
        (update) => update,
        (exit) => exit.remove()
      );
  }

  function joinLinks() {
    linkLayer
      .selectAll("g.link")
      .data(crossLinks, (d) => d.id)
      .join(
        (enter) => {
          const g = enter.append("g").attr("class", "link");
          g.append("path").attr("class", "hit").attr("fill", "none");
          g.append("path").attr("class", "line").attr("fill", "none");
          g.append("text")
            .attr("class", "edge-label")
            .attr("text-anchor", "middle")
            .attr("dy", -6)
            .attr("font-size", 10.5)
            .attr("font-weight", 600)
            .attr("pointer-events", "none");
          g.on("click", (event, d) => {
            event.stopPropagation();
            handlers.onEdgeClick?.(d, event);
          })
            .on("mouseenter", (event, d) => {
              hoveredId = d.id;
              paint();
            })
            .on("mouseleave", () => {
              hoveredId = null;
              paint();
            });
          return g;
        },
        (update) => update,
        (exit) => exit.remove()
      )
      .select("text.edge-label")
      .text((d) => d.type);
  }

  /* ---------------------------------------------------------------- */
  /* Geometry, redrawn every frame of a move                           */
  /* ---------------------------------------------------------------- */

  function drawGeometry() {
    nodeLayer.selectAll("g.node").attr("transform", (d) => `translate(${d.x || 0},${d.y || 0})`);

    branchLayer.selectAll("path.branch").attr("d", (d) => {
      const from = byId.get(d.from);
      const to = byId.get(d.to);
      if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(to.x)) return "";
      const { start, c1, c2, end } = branchCurve(from, to);
      const depth = visuals.get(d.from)?.depth ?? 0;
      const width = Math.max(3, 12 - depth * 3.2);
      return ribbonPath(start, c1, c2, end, width, Math.max(2, width * 0.42));
    });

    linkLayer.selectAll("g.link").each(function (d) {
      const from = byId.get(d.from);
      const to = byId.get(d.to);
      if (!from || !to) return;
      const g = d3.select(this);
      const [c1, c2] = bowedControls(from, to);
      const start = borderPoint(from, c1.x, c1.y, 2);
      const end = borderPoint(to, c2.x, c2.y, ARROW_GAP);
      const path = curvePath(start, c1, c2, end);
      g.select("path.line").attr("d", path);
      g.select("path.hit").attr("d", path);
      g.select("text.edge-label")
        .attr("x", (start.x + c1.x + c2.x + end.x) / 4)
        .attr("y", (start.y + c1.y + c2.y + end.y) / 4);
    });
  }

  /** Cross-links bow sideways so they never hide underneath a branch ribbon. */
  function bowedControls(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const bend = 0.16;
    return [
      { x: mx - dy * bend, y: my + dx * bend },
      { x: mx - dy * bend * 0.6, y: my + dx * bend * 0.6 }
    ];
  }

  /** Eases every node from where it is now to where the layout wants it. */
  function moveTo(targets, animate) {
    mover?.stop();
    mover = null;

    const from = new Map();
    drawables.forEach((node) => {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
        const target = targets.get(node.id) || { x: 0, y: 0 };
        // A node drawn for the first time starts near the centre, so a map
        // streaming in chunk by chunk grows outward instead of blinking about.
        node.x = target.x * 0.25;
        node.y = target.y * 0.25;
      }
      from.set(node.id, { x: node.x, y: node.y });
    });

    const settle = () => {
      drawables.forEach((node) => {
        const target = targets.get(node.id);
        if (!target) return;
        node.x = target.x;
        node.y = target.y;
      });
      drawGeometry();
      runPendingView();
    };

    if (!animate) {
      settle();
      return;
    }

    mover = d3.timer((elapsed) => {
      const t = Math.min(1, elapsed / MOVE_MS);
      const eased = d3.easeCubicOut(t);
      drawables.forEach((node) => {
        const start = from.get(node.id);
        const target = targets.get(node.id);
        if (!start || !target) return;
        node.x = start.x + (target.x - start.x) * eased;
        node.y = start.y + (target.y - start.y) * eased;
      });
      drawGeometry();
      if (t < 1) return;
      mover.stop();
      mover = null;
      settle();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Painting: selection, hover, search, filters                       */
  /* ---------------------------------------------------------------- */

  const shown = (node) => node.synthetic || isVisible(node);

  function paint() {
    const selection = state.selection;
    const focusId =
      hoveredId && byId.has(hoveredId)
        ? hoveredId
        : selection?.kind === "node"
          ? selection.id
          : null;
    const focusSet = focusId ? neighboursOf(focusId) : null;
    const inFocus = (id) => !focusSet || focusSet.has(id);

    nodeLayer
      .selectAll("g.node")
      .attr("opacity", (d) => {
        if (!shown(d)) return 0;
        if (d.synthetic) return 1;
        if (!matchesQuery(d)) return 0.16;
        return inFocus(d.id) ? 1 : 0.2;
      })
      .attr("pointer-events", (d) => (shown(d) ? "auto" : "none"))
      .each(function (d) {
        const g = d3.select(this);
        const { colour, depth, boxed } = visuals.get(d.id);
        const selected = selection?.kind === "node" && selection.id === d.id;
        const pending = state.pendingSourceId === d.id;
        const matched = Boolean(state.query) && !d.synthetic && matchesQuery(d);
        const marked = selected || pending || matched;
        const ring = matched && !selected ? palette.warn : colour;

        g.select("rect.body")
          .attr("fill", depth === 0 ? palette.accent : fade(colour, 0.16))
          .attr("stroke", marked ? ring : fade(colour, depth === 0 ? 0 : 0.7))
          .attr("stroke-width", marked ? 2.6 : 1.6);
        g.select("line.rule")
          .attr("stroke", ring)
          .attr("stroke-width", marked ? 3.4 : 2.2)
          .attr("opacity", marked ? 1 : 0.5);
        g.select("circle.bullet").attr("fill", palette.node[d.type] || colour);
        g.select("text.label").attr(
          "fill",
          depth === 0 ? palette.accentFg : boxed ? palette.nodeText : palette.text
        );

        const hidden = folded.get(d.id) || 0;
        const offering = hoveredId === d.id || selected;
        g.select("g.fold")
          .attr("opacity", hidden ? 1 : offering ? 1 : 0)
          .attr("pointer-events", hidden || offering ? "auto" : "none");
        g.select("rect.fold-pill")
          .attr("fill", hidden ? colour : palette.canvasBg)
          .attr("stroke", colour)
          .attr("stroke-width", 1.6);
        g.select("text.fold-mark").attr("fill", hidden ? palette.accentFg : colour);
      });

    branchLayer
      .selectAll("path.branch")
      .attr("fill", (d) => d.colour)
      .attr("pointer-events", (d) => (d.edge ? "auto" : "none"))
      .attr("opacity", (d) => {
        const from = byId.get(d.from);
        const to = byId.get(d.to);
        if (!from || !to || !shown(from) || !shown(to)) return 0;
        if (d.edge && hoveredId === d.edge.id) return 1;
        if (!inFocus(d.from) || !inFocus(d.to)) return 0.18;
        return 0.72;
      });

    linkLayer
      .selectAll("g.link")
      .attr("opacity", (d) => {
        const from = byId.get(d.from);
        const to = byId.get(d.to);
        if (!from || !to || !shown(from) || !shown(to)) return 0;
        if (!inFocus(d.from) || !inFocus(d.to)) return 0.1;
        if (state.query && !(matchesQuery(from) || matchesQuery(to))) return 0.12;
        return 1;
      })
      .attr("pointer-events", (d) => {
        const from = byId.get(d.from);
        const to = byId.get(d.to);
        return from && to && shown(from) && shown(to) ? "auto" : "none";
      })
      .each(function (d) {
        const g = d3.select(this);
        const active =
          (state.selection?.kind === "edge" && state.selection.id === d.id) ||
          hoveredId === d.id;
        g.select("path.line")
          .attr("stroke", active ? palette.accentHi : palette.edge[d.type])
          .attr("stroke-width", active ? 2.4 : 1.5)
          .attr("stroke-dasharray", active ? null : "7 6")
          .attr("marker-end", `url(#arrow-${active ? "active" : d.type})`);
        g.select("text.edge-label")
          .attr("fill", palette.textDim)
          .attr("opacity", active ? 1 : 0);
      });
  }

  function dragBehaviour() {
    return d3
      .drag()
      .on("start", () => {
        mover?.stop();
        mover = null;
        pendingFit = null;
        pendingCentre = null;
      })
      .on("drag", (event, d) => {
        d.x = event.x;
        d.y = event.y;
        // Dragging pins a node: the layout stops owning it until "R" hands
        // every node back (see `unpinAll`).
        if (!d.synthetic) d.pinned = true;
        drawGeometry();
      })
      .on("end", () => drawGeometry());
  }

  /* ---------------------------------------------------------------- */
  /* Markers & palette                                                 */
  /* ---------------------------------------------------------------- */

  function writeMarkers() {
    defs.selectAll("marker").remove();
    Object.entries(palette.edge)
      .concat([["active", palette.accentHi]])
      .forEach(([name, colour]) => {
        defs
          .append("marker")
          .attr("id", `arrow-${name}`)
          .attr("viewBox", "0 0 10 10")
          .attr("refX", 9)
          .attr("refY", 5)
          .attr("markerWidth", 5.5)
          .attr("markerHeight", 5.5)
          .attr("orient", "auto-start-reverse")
          .append("path")
          .attr("d", "M0,1 L9,5 L0,9 z")
          .attr("fill", colour);
      });
  }

  function refreshTheme() {
    palette = readPalette();
    writeMarkers();
    render({ animate: false });
  }

  /* ---------------------------------------------------------------- */
  /* Viewport                                                          */
  /* ---------------------------------------------------------------- */

  function zoomBy(factor) {
    svg.transition().duration(200).call(zoom.scaleBy, factor);
  }

  function bounds() {
    const visible = drawables.filter((n) => shown(n) && Number.isFinite(n.x));
    if (!visible.length) return null;
    const xs = visible.flatMap((n) => [n.x - n.w / 2, n.x + n.w / 2]);
    const ys = visible.flatMap((n) => [n.y - n.h / 2, n.y + n.h / 2]);
    return {
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0: Math.min(...ys),
      y1: Math.max(...ys)
    };
  }

  function fit({ duration = 450, padding = 80 } = {}) {
    const box = bounds();
    if (!box) return;
    const { width, height } = svgEl.getBoundingClientRect();
    if (!width || !height) return;
    const scale = clamp(
      Math.min(
        width / (box.x1 - box.x0 + padding * 2),
        height / (box.y1 - box.y0 + padding * 2)
      ),
      0.2,
      1.4
    );
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    svg
      .transition()
      .duration(duration)
      .call(
        zoom.transform,
        d3.zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-cx, -cy)
      );
  }

  /**
   * Fits once the layout has come to rest. Measuring the bounds while the nodes
   * are still travelling measures a knot: the scale lands at the clamp, the map
   * then spreads and spills past both edges of the canvas. Cancelled if the user
   * pans or zooms in the meantime.
   */
  function fitWhenSettled(options = {}) {
    if (!mover) {
      fit(options);
      return;
    }
    pendingFit = options;
  }

  function runPendingView() {
    if (pendingFit) {
      const options = pendingFit;
      pendingFit = null;
      fit(options);
    }
    if (pendingCentre) {
      const { node, options } = pendingCentre;
      pendingCentre = null;
      centreOn(node, options);
    }
  }

  function centreOn(node, options = {}) {
    // Mid-move a node is still at the position it is travelling from, which
    // after a branch has just been opened is wherever it sat before it was
    // folded away. Centring on that lands the viewport nowhere.
    if (mover) {
      pendingCentre = { node, options };
      return;
    }
    const { duration = 400 } = options;
    const { width, height } = svgEl.getBoundingClientRect();
    const scale = Math.max(transform.k, 0.9);
    svg
      .transition()
      .duration(duration)
      .call(
        zoom.transform,
        d3.zoomIdentity
          .translate(width / 2, height / 2)
          .scale(scale)
          .translate(-node.x, -node.y)
      );
  }

  /** Screen position of a node, for overlaying HTML on top of the canvas. */
  function screenPosition(node) {
    const [x, y] = transform.apply([node.x || 0, node.y || 0]);
    return { x, y, k: transform.k };
  }

  /**
   * The folds standing between the centre and `id`, outermost first — empty
   * when the node is already on screen. Answered from the tree before folding,
   * which is the only copy that still knows where a hidden node belongs.
   */
  function foldsHiding(id) {
    if (!full || !full.byId.has(id)) return [];
    const shut = [];
    let cursor = full.byId.get(id).parent;
    while (cursor) {
      if (state.collapsed.has(cursor)) shut.unshift(cursor);
      cursor = full.byId.get(cursor).parent;
    }
    return shut;
  }

  /** Point in graph coordinates at the centre of the viewport. */
  function viewportCentre() {
    const { width, height } = svgEl.getBoundingClientRect();
    const [x, y] = transform.invert([width / 2, height / 2]);
    return { x, y };
  }

  return {
    render,
    paint,
    refreshTheme,
    fit,
    fitWhenSettled,
    centreOn,
    resize: () => drawGeometry(),
    screenPosition,
    viewportCentre,
    bounds,
    /** How many nodes the fold on `id` is holding — 0 when it is not folded. */
    hiddenUnder: (id) => folded.get(id) || 0,
    foldsHiding,
    rootNode: () => root,
    zoomIn: () => zoomBy(1.3),
    zoomOut: () => zoomBy(1 / 1.3),
    getTransform: () => transform,
    svgNode: () => svgEl
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
