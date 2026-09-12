/**
 * The flow view: the same graph read as cause and effect.
 *
 * A mind map answers "how is this shaped?" and the note board answers "what was
 * actually said?". Neither answers "what led to what?" — the map deliberately
 * hangs everything off one centre, so a chain of three causes and the branch
 * they belong to look alike, and the arrows that carry the causality end up as
 * dashed cross-links drawn round the outside. Here the arrows are the subject:
 * causes on the left, effects on the right, every arrow pointing the same way,
 * and the chain readable in one sweep of the eye.
 *
 * Three things a reader needs, and where each is:
 *
 *   - **Direction.** Left to right, always. `causal.js` reverses nothing and
 *     hides nothing; an arrow that has to run backwards is a feedback loop and
 *     is drawn as one, under the diagram, dashed.
 *   - **Polarity.** A `contrasts` link carries a − and a `supports` link a +,
 *     the notation every systems-thinking text uses. A plain `causes` link
 *     carries no glyph: it is the positive default, and marking the common case
 *     buys nothing but clutter. What has to be visible is the exception, since
 *     it is the negatives that decide what a loop does.
 *   - **Feedback.** Each loop gets the R or B badge on the arc that closes it.
 *     Hovering the badge lights the whole loop, which is the only way to see at
 *     a glance which nodes are inside it.
 *
 * Nodes are not draggable here, unlike the map. On the map a dragged node keeps
 * its spot because the layout has no opinion about where a branch hangs; here
 * the column *is* the claim — "this is three steps downstream of that" — and a
 * node dragged out of it would state something the graph does not say.
 *
 * Visual attributes are written inline rather than through CSS classes, so the
 * live SVG can be serialised straight into the PNG export, as the map's is.
 */

import { state, isVisible, matchesQuery, neighboursOf } from "./state.js";
import { buildCausal } from "./causal.js";
import { flowLayout } from "./flow-layout.js";
import { wrapLabel } from "./geometry.js";
import { readPalette, fade } from "./palette.js";

const FONT = 14;
const MAX_WIDTH = 168;
const PAD_X = 15;
const PAD_Y = 10;
const ARROW_GAP = 9;
/** How far under the diagram a feedback arc swings before coming back. */
const LOOP_DROP = 52;

export function createFlow(svgEl, handlers = {}) {
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();

  const defs = svg.append("defs");
  const viewport = svg.append("g").attr("class", "viewport");
  const contextLayer = viewport.append("g").attr("class", "flow-context");
  const edgeLayer = viewport.append("g").attr("class", "flow-edges");
  const nodeLayer = viewport.append("g").attr("class", "flow-nodes");
  // Above the nodes: a badge sitting behind a box could not be hovered, and the
  // badge is the only handle a loop has.
  const loopLayer = viewport.append("g").attr("class", "flow-loops");

  let palette = readPalette();
  let model = null;
  let drawables = [];
  let byId = new Map();
  let visuals = new Map();
  let loopById = new Map();
  let hoveredId = null;
  let hoveredLoop = null;
  let transform = d3.zoomIdentity;

  const line = d3
    .line()
    .x((p) => p.x)
    .y((p) => p.y)
    // Monotone in x cannot overshoot sideways, so an edge threading a column of
    // boxes never bulges back into the one it just left.
    .curve(d3.curveMonotoneX);

  const zoom = d3
    .zoom()
    .scaleExtent([0.15, 3])
    .on("zoom", (event) => {
      transform = event.transform;
      viewport.attr("transform", transform);
    });

  svg.call(zoom).on("dblclick.zoom", null);
  svg.on("click", () => handlers.onBackgroundClick?.());

  writeMarkers();
  centreOrigin();

  function centreOrigin() {
    const { width, height } = svgEl.getBoundingClientRect();
    if (!width || !height) return;
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2));
  }

  /* ---------------------------------------------------------------- */
  /* Model                                                             */
  /* ---------------------------------------------------------------- */

  function build() {
    model = buildCausal(state.nodes, state.edges);
    loopById = new Map((model?.loops || []).map((loop) => [loop.id, loop]));

    if (!model) {
      drawables = [];
      byId = new Map();
      visuals = new Map();
      return new Map();
    }

    const family = getComputedStyle(document.body).fontFamily;
    const nodeById = new Map(state.nodes.map((n) => [n.id, n]));

    drawables = model.ids.map((id) => nodeById.get(id));
    byId = new Map(drawables.map((n) => [n.id, n]));

    visuals = new Map();
    drawables.forEach((node) => {
      const meta = model.byId.get(node.id);
      const wrapped = wrapLabel(node.label, {
        fontSize: FONT,
        family,
        maxWidth: MAX_WIDTH,
        maxLines: 3
      });
      node.fw = wrapped.width + PAD_X * 2 + 14;
      node.fh = wrapped.height + PAD_Y * 2;
      visuals.set(node.id, { wrapped, role: meta.role, rank: meta.rank });
    });

    return flowLayout(model, {
      sizeOf: (id) => {
        const node = byId.get(id);
        return node ? { w: node.fw, h: node.fh } : { w: 120, h: 36 };
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function render() {
    const placed = build();

    drawables.forEach((node) => {
      const spot = placed.get(node.id);
      if (!spot) return;
      node.fx = spot.x;
      node.fy = spot.y;
    });
    // Where a long edge bends on its way across the columns it skips.
    const bends = new Map();
    placed.forEach((spot, id) => {
      if (!byId.has(id)) bends.set(id, spot);
    });

    joinNodes();
    joinEdges(bends);
    joinContext();
    joinLoops();
    paint();
  }

  function joinNodes() {
    nodeLayer
      .selectAll("g.fnode")
      .data(drawables, (d) => d.id)
      .join(
        (enter) => {
          const g = enter.append("g").attr("class", "fnode").attr("cursor", "pointer");
          g.append("rect").attr("class", "body");
          // The cap on the leading edge is what says "this is where the chain
          // starts" without a legend: it is on the side the arrows arrive from.
          g.append("rect").attr("class", "cap");
          g.append("circle").attr("class", "bullet");
          g.append("text").attr("class", "label").attr("pointer-events", "none");
          g.append("title");

          g.on("click", (event, d) => {
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
      .attr("transform", (d) => `translate(${d.fx || 0},${d.fy || 0})`)
      .each(function (d) {
        const { wrapped, role } = visuals.get(d.id);
        const g = d3.select(this);
        const textX = -d.fw / 2 + PAD_X + 11;

        g.select("rect.body")
          .attr("x", -d.fw / 2)
          .attr("y", -d.fh / 2)
          .attr("width", d.fw)
          .attr("height", d.fh)
          .attr("rx", role === "trigger" ? d.fh / 2 : 9);
        g.select("rect.cap")
          .attr("x", -d.fw / 2)
          .attr("y", -d.fh / 2 + 6)
          .attr("width", 3)
          .attr("height", d.fh - 12)
          .attr("rx", 1.5)
          .attr("display", role === "outcome" ? null : "none");
        g.select("circle.bullet")
          .attr("cx", -d.fw / 2 + PAD_X * 0.62)
          .attr("cy", 0)
          .attr("r", 3.4);
        g.select("title").text(`${d.label} — ${role}`);

        const text = g
          .select("text.label")
          .attr("font-size", FONT)
          .attr("font-weight", role === "link" ? 600 : 680)
          .attr("font-family", getComputedStyle(document.body).fontFamily)
          .attr("dominant-baseline", "central");
        text.selectAll("tspan").remove();
        const top = -((wrapped.lines.length - 1) * wrapped.lineHeight) / 2;
        wrapped.lines.forEach((lineText, index) => {
          text
            .append("tspan")
            .attr("x", textX)
            .attr("y", top + index * wrapped.lineHeight)
            .attr("text-anchor", "start")
            .text(lineText);
        });
      });
  }

  function joinEdges(bends) {
    edgeLayer
      .selectAll("g.flink")
      .data(model ? model.links : [], (d) => d.id)
      .join(
        (enter) => {
          const g = enter.append("g").attr("class", "flink");
          g.append("path").attr("class", "hit").attr("fill", "none").attr("stroke-width", 12);
          g.append("path").attr("class", "line").attr("fill", "none");
          // The polarity glyph rides the middle of the link, on its own disc so
          // it stays legible where the line passes under a label.
          const sign = g.append("g").attr("class", "sign").attr("pointer-events", "none");
          sign.append("circle").attr("r", 8);
          sign
            .append("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", 13)
            .attr("font-weight", 700);
          g.append("text")
            .attr("class", "flink-label")
            .attr("text-anchor", "middle")
            .attr("dy", -10)
            .attr("font-size", 10.5)
            .attr("font-weight", 600)
            .attr("pointer-events", "none");

          g.on("click", (event, d) => {
            event.stopPropagation();
            handlers.onEdgeClick?.(d, event);
          })
            .on("mouseenter", (event, d) => {
              hoveredId = d.id;
              hoveredLoop = d.loop;
              paint();
            })
            .on("mouseleave", () => {
              hoveredId = null;
              hoveredLoop = null;
              paint();
            });
          return g;
        },
        (update) => update,
        (exit) => exit.remove()
      )
      .each(function (d) {
        const g = d3.select(this);
        const shape = edgePath(d, bends);
        d.mid = shape.mid;
        g.select("path.line").attr("d", shape.path);
        g.select("path.hit").attr("d", shape.path);
        g.select("g.sign")
          .attr("display", d.polarity > 0 && d.type === "causes" ? "none" : null)
          .attr("transform", `translate(${shape.mid.x},${shape.mid.y})`);
        g.select("g.sign text").text(d.polarity < 0 ? "−" : "+");
        g.select("text.flink-label")
          .text(d.type)
          .attr("x", shape.mid.x)
          .attr("y", shape.mid.y);
      });
  }

  /** `relates` edges: association with no claimed direction of effect. */
  function joinContext() {
    contextLayer
      .selectAll("path.fcontext")
      .data(model ? model.context : [], (d) => d.id)
      .join(
        (enter) =>
          enter
            .append("path")
            .attr("class", "fcontext")
            .attr("fill", "none")
            .attr("stroke-dasharray", "3 7")
            .attr("stroke-linecap", "round"),
        (update) => update,
        (exit) => exit.remove()
      )
      .attr("d", (d) => {
        const from = byId.get(d.from);
        const to = byId.get(d.to);
        if (!from || !to) return "";
        return line([
          { x: from.fx, y: from.fy },
          { x: (from.fx + to.fx) / 2, y: (from.fy + to.fy) / 2 + 18 },
          { x: to.fx, y: to.fy }
        ]);
      });
  }

  function joinLoops() {
    loopLayer
      .selectAll("g.floop")
      .data(model ? model.loops : [], (d) => d.id)
      .join(
        (enter) => {
          const g = enter.append("g").attr("class", "floop").attr("cursor", "help");
          g.append("circle").attr("class", "floop-disc").attr("r", 13);
          g.append("text")
            .attr("class", "floop-label")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", 11.5)
            .attr("font-weight", 800)
            .attr("pointer-events", "none");
          g.append("title");
          g.on("mouseenter", (event, d) => {
            hoveredLoop = d.id;
            paint();
          }).on("mouseleave", () => {
            hoveredLoop = null;
            paint();
          });
          return g;
        },
        (update) => update,
        (exit) => exit.remove()
      )
      .each(function (d) {
        const g = d3.select(this);
        const closing = model.links.find((link) => link.id === d.edges[d.edges.length - 1]);
        const at = closing?.mid || { x: 0, y: 0 };
        g.attr("transform", `translate(${at.x},${at.y})`);
        g.select("text.floop-label").text(d.label);
        g.select("title").text(
          `${d.label} — ${d.kind} loop through ${d.nodes.length} concepts` +
            (d.negatives
              ? ` (${d.negatives} opposing link${d.negatives > 1 ? "s" : ""})`
              : " (no opposing links)")
        );
      });
  }

  /* ---------------------------------------------------------------- */
  /* Edge geometry                                                     */
  /* ---------------------------------------------------------------- */

  function edgePath(link, bends) {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (!from || !to) return { path: "", mid: { x: 0, y: 0 } };

    if (link.back) return feedbackArc(from, to);

    const points = [
      { x: from.fx + from.fw / 2, y: from.fy },
      ...link.bends.map((id) => bends.get(id)).filter(Boolean),
      { x: to.fx - to.fw / 2 - ARROW_GAP, y: to.fy }
    ];
    return { path: line(points), mid: midpoint(points) };
  }

  /**
   * The arc a feedback link takes back upstream: down out of the effect, along
   * under the diagram, and up into the cause it feeds.
   *
   * Under, rather than through: a line running right to left between the
   * columns would be read as one more forward arrow at a glance, and the one
   * thing this diagram promises is that everything between the boxes flows the
   * same way. The drop grows with the distance travelled, so a loop spanning
   * the whole chain clears the one closing two columns along.
   */
  function feedbackArc(from, to) {
    const span = Math.abs(from.fx - to.fx);
    const floor = Math.max(from.fy + from.fh / 2, to.fy + to.fh / 2) + LOOP_DROP + span * 0.06;
    const start = { x: from.fx, y: from.fy + from.fh / 2 };
    const end = { x: to.fx, y: to.fy + to.fh / 2 + ARROW_GAP };
    // One cubic whose handles both sit on the floor: it leaves straight down,
    // runs flat underneath, and arrives straight up.
    return {
      path: `M${start.x},${start.y} C${start.x},${floor} ${end.x},${floor} ${end.x},${end.y}`,
      // The curve's own halfway point, not the midpoint of the box — the badge
      // has to sit *on* the line it labels.
      mid: { x: (start.x + end.x) / 2, y: (start.y + end.y + 6 * floor) / 8 }
    };
  }

  /** The point halfway along a polyline — where the sign and the label sit. */
  function midpoint(points) {
    if (points.length === 1) return points[0];
    const lengths = [];
    let total = 0;
    for (let i = 1; i < points.length; i += 1) {
      const step = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      total += step;
      lengths.push(total);
    }
    const half = total / 2;
    const index = lengths.findIndex((value) => value >= half);
    const before = index === 0 ? 0 : lengths[index - 1];
    const t = lengths[index] === before ? 0 : (half - before) / (lengths[index] - before);
    const a = points[index];
    const b = points[index + 1];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /* ---------------------------------------------------------------- */
  /* Painting                                                          */
  /* ---------------------------------------------------------------- */

  function paint() {
    if (!model) return;

    const selection = state.selection;
    const focusId =
      hoveredId && byId.has(hoveredId)
        ? hoveredId
        : selection?.kind === "node"
          ? selection.id
          : null;
    const focusSet = focusId ? neighboursOf(focusId) : null;
    const inFocus = (id) => !focusSet || focusSet.has(id);

    const loop = hoveredLoop ? loopById.get(hoveredLoop) : null;
    const loopNodes = loop ? new Set(loop.nodes) : null;
    const loopEdges = loop ? new Set(loop.edges) : null;

    nodeLayer
      .selectAll("g.fnode")
      .attr("opacity", (d) => {
        if (!isVisible(d)) return 0;
        if (!matchesQuery(d)) return 0.16;
        if (loopNodes) return loopNodes.has(d.id) ? 1 : 0.22;
        return inFocus(d.id) ? 1 : 0.24;
      })
      .attr("pointer-events", (d) => (isVisible(d) ? "auto" : "none"))
      .each(function (d) {
        const g = d3.select(this);
        const { role } = visuals.get(d.id);
        const selected = selection?.kind === "node" && selection.id === d.id;
        const pending = state.pendingSourceId === d.id;
        const matched = Boolean(state.query) && matchesQuery(d);
        const marked = selected || pending || matched;
        const base = palette.role[role] || palette.textDim;
        const stroke = matched && !selected ? palette.warn : base;

        g.select("rect.body")
          .attr("fill", role === "trigger" ? fade(base, 0.14) : palette.nodeBg)
          .attr("stroke", marked ? stroke : fade(base, 0.62))
          .attr("stroke-width", marked ? 2.6 : 1.6);
        g.select("rect.cap").attr("fill", base);
        g.select("circle.bullet").attr("fill", palette.node[d.type] || base);
        g.select("text.label").attr("fill", palette.nodeText);
      });

    edgeLayer
      .selectAll("g.flink")
      .attr("opacity", (d) => {
        const from = byId.get(d.from);
        const to = byId.get(d.to);
        if (!from || !to || !isVisible(from) || !isVisible(to)) return 0;
        if (loopEdges) return loopEdges.has(d.id) ? 1 : 0.12;
        if (!inFocus(d.from) || !inFocus(d.to)) return 0.14;
        if (state.query && !(matchesQuery(from) || matchesQuery(to))) return 0.14;
        return 1;
      })
      .attr("pointer-events", (d) => {
        const from = byId.get(d.from);
        const to = byId.get(d.to);
        return from && to && isVisible(from) && isVisible(to) ? "auto" : "none";
      })
      .each(function (d) {
        const g = d3.select(this);
        const active =
          (state.selection?.kind === "edge" && state.selection.id === d.id) || hoveredId === d.id;
        const colour = active ? palette.accentHi : palette.edge[d.type];

        g.select("path.line")
          .attr("stroke", colour)
          .attr("stroke-width", active ? 2.8 : d.back ? 1.6 : 2)
          .attr("stroke-dasharray", d.back ? "8 6" : null)
          .attr("marker-end", `url(#flow-arrow-${active ? "active" : d.type})`);
        g.select("path.hit").attr("stroke", "transparent");
        g.select("g.sign circle")
          .attr("fill", palette.canvasBg)
          .attr("stroke", colour)
          .attr("stroke-width", 1.5);
        g.select("g.sign text").attr("fill", colour);
        g.select("text.flink-label")
          .attr("fill", palette.textDim)
          .attr("opacity", active ? 1 : 0);
      });

    contextLayer
      .selectAll("path.fcontext")
      .attr("stroke", palette.edge.relates)
      .attr("stroke-width", 1.4)
      .attr("opacity", (d) => {
        const from = byId.get(d.from);
        const to = byId.get(d.to);
        if (!from || !to || !isVisible(from) || !isVisible(to)) return 0;
        return loop || focusSet ? 0.1 : 0.32;
      });

    loopLayer
      .selectAll("g.floop")
      .attr("opacity", (d) => (loop && loop.id !== d.id ? 0.25 : 1))
      .each(function (d) {
        const g = d3.select(this);
        const colour = palette.loop[d.kind] || palette.accentHi;
        g.select("circle.floop-disc")
          .attr("fill", palette.canvasBg)
          .attr("stroke", colour)
          .attr("stroke-width", hoveredLoop === d.id ? 3 : 2);
        g.select("text.floop-label").attr("fill", colour);
      });
  }

  /* ---------------------------------------------------------------- */
  /* Markers, palette, viewport                                        */
  /* ---------------------------------------------------------------- */

  function writeMarkers() {
    defs.selectAll("marker").remove();
    Object.entries(palette.edge)
      .concat([["active", palette.accentHi]])
      .forEach(([name, colour]) => {
        defs
          .append("marker")
          .attr("id", `flow-arrow-${name}`)
          .attr("viewBox", "0 0 10 10")
          .attr("refX", 9)
          .attr("refY", 5)
          .attr("markerWidth", 5)
          .attr("markerHeight", 5)
          .attr("orient", "auto-start-reverse")
          .append("path")
          .attr("d", "M0,1 L9,5 L0,9 z")
          .attr("fill", colour);
      });
  }

  function refreshTheme() {
    palette = readPalette();
    writeMarkers();
    render();
  }

  function bounds() {
    const visible = drawables.filter((n) => isVisible(n) && Number.isFinite(n.fx));
    if (!visible.length) return null;
    const xs = visible.flatMap((n) => [n.fx - n.fw / 2, n.fx + n.fw / 2]);
    // Feedback arcs hang below the boxes; fitting to the boxes alone would cut
    // every loop badge off the bottom of the screen.
    const drop = model && model.links.some((l) => l.back) ? LOOP_DROP + 30 : 0;
    const ys = visible.flatMap((n) => [n.fy - n.fh / 2, n.fy + n.fh / 2 + drop]);
    return {
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0: Math.min(...ys),
      y1: Math.max(...ys)
    };
  }

  function fit({ duration = 420, padding = 70 } = {}) {
    const box = bounds();
    if (!box) return;
    const { width, height } = svgEl.getBoundingClientRect();
    if (!width || !height) return;
    const scale = Math.min(
      Math.max(
        Math.min(
          width / (box.x1 - box.x0 + padding * 2),
          height / (box.y1 - box.y0 + padding * 2)
        ),
        0.2
      ),
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

  function centreOn(node, { duration = 400 } = {}) {
    const placed = byId.get(node.id);
    if (!placed || !Number.isFinite(placed.fx)) return;
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
          .translate(-placed.fx, -placed.fy)
      );
  }

  /** Screen position of a node, for overlaying the inline label editor. */
  function screenPosition(node) {
    const placed = byId.get(node.id);
    const [x, y] = transform.apply([placed?.fx || 0, placed?.fy || 0]);
    return { x, y, k: transform.k };
  }

  return {
    render,
    paint,
    refreshTheme,
    fit,
    centreOn,
    screenPosition,
    // The PNG export crops to this, so it is part of the contract a canvas owes
    // the rest of the app, not an internal of the fit.
    bounds,
    // Nothing to recompute: the diagram is in graph coordinates and the zoom
    // transform already maps them onto whatever size the canvas has become.
    resize: () => {},
    zoomIn: () => svg.transition().duration(200).call(zoom.scaleBy, 1.3),
    zoomOut: () => svg.transition().duration(200).call(zoom.scaleBy, 1 / 1.3),
    /**
     * What the view found, for the caption strip: counts, loops, what it left
     * out, and which polarity glyphs it actually drew — the strip explains only
     * the notation on screen, so it has to be told rather than guess.
     */
    summary: () =>
      model
        ? {
            ok: true,
            nodes: model.ids.length,
            links: model.links.length,
            loops: model.loops,
            omitted: model.omitted,
            depth: model.layers.length,
            signs: {
              plus: model.links.some((l) => l.polarity > 0 && l.type !== "causes"),
              minus: model.links.some((l) => l.polarity < 0)
            }
          }
        : {
            ok: false,
            nodes: 0,
            links: 0,
            loops: [],
            omitted: state.nodes.length,
            depth: 0,
            signs: {}
          },
    /** Whether a node appears in this view at all — search needs to know. */
    has: (id) => byId.has(id),
    svgNode: () => svgEl
  };
}
