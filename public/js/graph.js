/**
 * D3 rendering layer: pill-shaped nodes sized to their label, curved directed
 * edges clipped at the node border, neighbour highlighting on hover, and the
 * zoom/pan viewport. Visual attributes are written inline (not via CSS classes)
 * so the SVG can be serialised straight to a PNG.
 */

import { state, degreeOf, neighboursOf, isVisible } from "./state.js";

const NODE_FONT = 13;
const NODE_HEIGHT = 34;
const NODE_MIN_W = 84;
const NODE_MAX_W = 244;
const CURVE = 0.13;
const ARROW_GAP = 9;

const measurer = document.createElement("canvas").getContext("2d");

export function createGraph(svgEl, handlers = {}) {
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const defs = svg.append("defs");
  const viewport = svg.append("g").attr("class", "viewport");
  const linkLayer = viewport.append("g").attr("class", "links");
  const nodeLayer = viewport.append("g").attr("class", "nodes");

  let palette = readPalette();
  let links = [];
  let hoveredId = null;
  let transform = d3.zoomIdentity;

  const zoom = d3
    .zoom()
    .scaleExtent([0.15, 3])
    .on("zoom", (event) => {
      transform = event.transform;
      viewport.attr("transform", transform);
      handlers.onZoom?.(transform);
    });

  svg.call(zoom).on("dblclick.zoom", null);

  svg.on("click", () => handlers.onBackgroundClick?.());

  const simulation = d3
    .forceSimulation([])
    .force("link", d3.forceLink([]).id((d) => d.id).distance(150).strength(0.5))
    .force("charge", d3.forceManyBody().strength(-420).distanceMax(520))
    .force("center", d3.forceCenter(0, 0))
    .force("collide", d3.forceCollide().radius((d) => d.w / 2 + 16).iterations(2))
    .force("x", d3.forceX(0).strength(0.09))
    .force("y", d3.forceY(0).strength(0.11))
    .on("tick", tick);

  writeMarkers();
  centreOrigin();

  /** Puts graph coordinate (0,0) — where the forces pull — mid-screen. */
  function centreOrigin() {
    const { width, height } = svgEl.getBoundingClientRect();
    if (!width || !height) return;
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2));
  }

  /* ---------------------------------------------------------------- */
  /* Geometry                                                          */
  /* ---------------------------------------------------------------- */

  function measureNodes() {
    const family = getComputedStyle(document.body).fontFamily;
    state.nodes.forEach((n) => {
      const degree = degreeOf(n.id);
      const emphasis = Math.min(degree, 5);
      n.fontSize = NODE_FONT + emphasis * 0.55;
      n.h = NODE_HEIGHT + emphasis * 1.6;
      measurer.font = `600 ${n.fontSize}px ${family}`;
      n.display = truncate(n.label, NODE_MAX_W - 44);
      n.w = clamp(measurer.measureText(n.display).width + 44, NODE_MIN_W, NODE_MAX_W);
    });
  }

  function truncate(label, maxWidth) {
    if (measurer.measureText(label).width <= maxWidth) return label;
    let text = label;
    while (text.length > 3 && measurer.measureText(`${text}…`).width > maxWidth) {
      text = text.slice(0, -1);
    }
    return `${text.trimEnd()}…`;
  }

  /** Point where the segment towards (tx, ty) leaves the node's box. */
  function borderPoint(node, tx, ty, pad = 0) {
    const dx = tx - node.x;
    const dy = ty - node.y;
    if (!dx && !dy) return { x: node.x, y: node.y };
    const hw = node.w / 2 + pad;
    const hh = node.h / 2 + pad;
    const scale = Math.min(
      dx ? hw / Math.abs(dx) : Infinity,
      dy ? hh / Math.abs(dy) : Infinity
    );
    return { x: node.x + dx * scale, y: node.y + dy * scale };
  }

  function controlPoint(d) {
    const mx = (d.source.x + d.target.x) / 2;
    const my = (d.source.y + d.target.y) / 2;
    const dx = d.target.x - d.source.x;
    const dy = d.target.y - d.source.y;
    return { x: mx - dy * CURVE, y: my + dx * CURVE };
  }

  function linkPath(d) {
    if (!d.source.x && d.source.x !== 0) return "";
    const c = controlPoint(d);
    const a = borderPoint(d.source, c.x, c.y, 2);
    const b = borderPoint(d.target, c.x, c.y, ARROW_GAP);
    return `M${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`;
  }

  function linkMid(d) {
    const c = controlPoint(d);
    return {
      x: (d.source.x + 2 * c.x + d.target.x) / 4,
      y: (d.source.y + 2 * c.y + d.target.y) / 4
    };
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function render({ reheat = true } = {}) {
    measureNodes();

    links = state.edges.map((e) => ({ ...e, source: e.from, target: e.to }));

    const linkSel = linkLayer
      .selectAll("g.link")
      .data(links, (d) => d.id)
      .join(
        (enter) => {
          const g = enter.append("g").attr("class", "link");
          g.append("path").attr("class", "hit");
          g.append("path").attr("class", "line").attr("fill", "none");
          g.append("text")
            .attr("class", "edge-label")
            .attr("text-anchor", "middle")
            .attr("dy", -5)
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
      );

    linkSel.select("text.edge-label").text((d) => d.type);

    const nodeSel = nodeLayer
      .selectAll("g.node")
      .data(state.nodes, (d) => d.id)
      .join(
        (enter) => {
          const g = enter.append("g").attr("class", "node");
          g.append("rect").attr("class", "halo").attr("fill", "none");
          g.append("rect").attr("class", "body");
          g.append("rect").attr("class", "tint").attr("stroke", "none");
          g.append("circle").attr("class", "bullet");
          g.append("text")
            .attr("class", "label")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("pointer-events", "none");
          // Native tooltip, so a truncated label is still readable in full.
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
      );

    nodeSel.each(function (d) {
      const g = d3.select(this);
      const r = d.h / 2;
      g.select("rect.halo")
        .attr("x", -d.w / 2 - 5)
        .attr("y", -d.h / 2 - 5)
        .attr("width", d.w + 10)
        .attr("height", d.h + 10)
        .attr("rx", r + 5)
        .attr("stroke-width", 2);
      g.selectAll("rect.body, rect.tint")
        .attr("x", -d.w / 2)
        .attr("y", -d.h / 2)
        .attr("width", d.w)
        .attr("height", d.h)
        .attr("rx", r);
      g.select("circle.bullet")
        .attr("cx", -d.w / 2 + 15)
        .attr("cy", 0)
        .attr("r", 4);
      g.select("title").text(d.label);
      g.select("text.label")
        .attr("x", 7)
        .attr("font-size", d.fontSize)
        .attr("font-weight", 600)
        .attr("font-family", getComputedStyle(document.body).fontFamily)
        .text(d.display);
    });

    simulation.nodes(state.nodes);
    simulation.force("link").links(links);
    simulation.alpha(reheat ? 0.9 : 0.25).restart();
    paint();
  }

  /** Cheap restyle: selection, hover, search matches, type filters. */
  function paint() {
    const selection = state.selection;
    const query = state.query;
    const focusId =
      hoveredId && state.nodes.some((n) => n.id === hoveredId)
        ? hoveredId
        : selection?.kind === "node"
          ? selection.id
          : null;
    const focusSet = focusId ? neighboursOf(focusId) : null;

    const matches = (n) => !query || n.label.toLowerCase().includes(query);

    const nodeOpacity = (n) => {
      if (!isVisible(n)) return 0;
      if (!matches(n)) return 0.14;
      if (focusSet && !focusSet.has(n.id)) return 0.16;
      return 1;
    };

    nodeLayer
      .selectAll("g.node")
      .attr("opacity", nodeOpacity)
      .attr("pointer-events", (d) => (isVisible(d) ? "auto" : "none"))
      .each(function (d) {
        const g = d3.select(this);
        const color = palette.node[d.type];
        const selected = selection?.kind === "node" && selection.id === d.id;
        const pending = state.pendingSourceId === d.id;
        const matched = Boolean(query) && matches(d);

        g.select("rect.body")
          .attr("fill", palette.nodeBg)
          .attr("stroke", selected || pending ? color : mix(color, 0.55))
          .attr("stroke-width", selected || pending ? 2.4 : 1.5);
        g.select("rect.tint").attr("fill", color).attr("opacity", selected ? 0.2 : 0.11);
        g.select("circle.bullet").attr("fill", color);
        g.select("text.label").attr("fill", palette.nodeText);
        g.select("rect.halo")
          .attr("stroke", matched && !selected ? palette.warn : color)
          .attr("opacity", selected || pending || matched ? 0.85 : 0);
      });

    linkLayer
      .selectAll("g.link")
      .attr("opacity", (d) => {
        const from = byId(d.source);
        const to = byId(d.target);
        if (!from || !to || !isVisible(from) || !isVisible(to)) return 0;
        if (focusSet && !(focusSet.has(from.id) && focusSet.has(to.id))) return 0.08;
        if (query && !(matches(from) || matches(to))) return 0.12;
        return 1;
      })
      .attr("pointer-events", (d) => {
        const from = byId(d.source);
        const to = byId(d.target);
        return from && to && isVisible(from) && isVisible(to) ? "auto" : "none";
      })
      .each(function (d) {
        const g = d3.select(this);
        const active =
          (selection?.kind === "edge" && selection.id === d.id) || hoveredId === d.id;
        const color = palette.edge[d.type];
        g.select("path.line")
          .attr("stroke", active ? palette.accent : color)
          .attr("stroke-width", active ? 2.6 : 1.7)
          .attr("stroke-dasharray", d.type === "contrasts" ? "6 5" : null)
          .attr("marker-end", `url(#arrow-${active ? "active" : d.type})`);
        g.select("text.edge-label")
          .attr("fill", palette.textDim)
          .attr("opacity", active ? 1 : 0);
      });
  }

  function byId(ref) {
    return typeof ref === "object" ? ref : state.nodes.find((n) => n.id === ref);
  }

  function tick() {
    linkLayer.selectAll("g.link").each(function (d) {
      const path = linkPath(d);
      const g = d3.select(this);
      g.select("path.line").attr("d", path);
      g.select("path.hit").attr("d", path);
      const mid = linkMid(d);
      g.select("text.edge-label").attr("x", mid.x).attr("y", mid.y);
    });
    nodeLayer
      .selectAll("g.node")
      .attr("transform", (d) => `translate(${d.x || 0},${d.y || 0})`);
  }

  function dragBehaviour() {
    return d3
      .drag()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.25).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
  }

  /* ---------------------------------------------------------------- */
  /* Markers & palette                                                 */
  /* ---------------------------------------------------------------- */

  function writeMarkers() {
    defs.selectAll("marker").remove();
    const entries = Object.entries(palette.edge).concat([["active", palette.accent]]);
    entries.forEach(([name, color]) => {
      defs
        .append("marker")
        .attr("id", `arrow-${name}`)
        .attr("viewBox", "0 0 10 10")
        .attr("refX", 9)
        .attr("refY", 5)
        .attr("markerWidth", 6)
        .attr("markerHeight", 6)
        .attr("orient", "auto-start-reverse")
        .append("path")
        .attr("d", "M0,1 L9,5 L0,9 z")
        .attr("fill", color);
    });
  }

  function refreshTheme() {
    palette = readPalette();
    writeMarkers();
    paint();
  }

  /* ---------------------------------------------------------------- */
  /* Viewport                                                          */
  /* ---------------------------------------------------------------- */

  function zoomBy(factor) {
    svg.transition().duration(200).call(zoom.scaleBy, factor);
  }

  function bounds() {
    const visible = state.nodes.filter(isVisible);
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

  function fit({ duration = 450, padding = 70 } = {}) {
    const b = bounds();
    if (!b) return;
    const { width, height } = svgEl.getBoundingClientRect();
    const scale = clamp(
      Math.min(width / (b.x1 - b.x0 + padding * 2), height / (b.y1 - b.y0 + padding * 2)),
      0.2,
      1.5
    );
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    svg
      .transition()
      .duration(duration)
      .call(
        zoom.transform,
        d3.zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-cx, -cy)
      );
  }

  function centreOn(node, { duration = 400 } = {}) {
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
    const [x, y] = transform.apply([node.x, node.y]);
    return { x, y, k: transform.k };
  }

  /** Point in graph coordinates at the centre of the viewport. */
  function viewportCentre() {
    const { width, height } = svgEl.getBoundingClientRect();
    const [x, y] = transform.invert([width / 2, height / 2]);
    return { x, y };
  }

  function resize() {
    simulation.force("center", d3.forceCenter(0, 0));
    simulation.alpha(0.1).restart();
  }

  return {
    render,
    paint,
    refreshTheme,
    fit,
    centreOn,
    resize,
    screenPosition,
    viewportCentre,
    bounds,
    zoomIn: () => zoomBy(1.3),
    zoomOut: () => zoomBy(1 / 1.3),
    getTransform: () => transform,
    svgNode: () => svgEl
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Fades a hex colour towards transparency by returning an rgba string. */
function mix(hex, alpha) {
  const value = hex.trim();
  if (!value.startsWith("#")) return value;
  const full =
    value.length === 4
      ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
      : value;
  const r = parseInt(full.slice(1, 3), 16);
  const g = parseInt(full.slice(3, 5), 16);
  const b = parseInt(full.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function readPalette() {
  const css = getComputedStyle(document.documentElement);
  const read = (name) => css.getPropertyValue(name).trim();
  return {
    node: {
      cause: read("--c-cause"),
      theme: read("--c-theme"),
      hierarchy: read("--c-hierarchy")
    },
    edge: {
      causes: read("--e-causes"),
      relates: read("--e-relates"),
      supports: read("--e-supports"),
      contrasts: read("--e-contrasts")
    },
    nodeBg: read("--node-bg"),
    nodeText: read("--node-text"),
    textDim: read("--text-dim"),
    accent: read("--accent-hi"),
    warn: read("--warn"),
    canvasBg: read("--canvas-bg")
  };
}

export { readPalette };
