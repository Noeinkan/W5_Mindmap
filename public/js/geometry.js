/**
 * The shapes a mind map is drawn with: labels wrapped onto two or three lines
 * instead of cut off with an ellipsis, and branches as tapered ribbons rather
 * than arrows of constant width.
 *
 * The taper is not decoration. A branch that starts thick at the centre and
 * thins towards the leaf tells you which end is the trunk without a single
 * arrowhead, which is how a paper mind map is read and why a graph drawn with
 * uniform arrows reads as a flow chart instead.
 */

const measurer = document.createElement("canvas").getContext("2d");

/** Word-wraps a label and reports the box it needs. */
export function wrapLabel(text, { fontSize, weight = 600, family, maxWidth, maxLines = 3 }) {
  measurer.font = `${weight} ${fontSize}px ${family}`;
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (measurer.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
      return;
    }
    lines.push(current);
    current = word;
  });
  if (current) lines.push(current);

  // Only the overflow past the last allowed line gets an ellipsis, so a label
  // loses its tail rather than everything after the first few words.
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = ellipsise(kept[maxLines - 1], maxWidth);
    lines.length = 0;
    lines.push(...kept);
  }

  const width = lines.reduce((max, line) => Math.max(max, measurer.measureText(line).width), 0);
  return { lines, width, lineHeight: fontSize * 1.28, height: lines.length * fontSize * 1.28 };
}

function ellipsise(line, maxWidth) {
  let text = `${line}…`;
  while (text.length > 2 && measurer.measureText(text).width > maxWidth) {
    text = `${text.slice(0, -2)}…`;
  }
  return text;
}

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
 * Control points that keep a branch inside its own wedge: the curve leaves the
 * parent along the parent's own direction from the centre and arrives at the
 * child along the child's, which is what gives a radial map its flower shape
 * instead of a bundle of straight spokes.
 */
export function radialControls(from, to) {
  const midRadius = (from.radius + to.radius) / 2;
  return [
    { x: Math.cos(from.angle) * midRadius, y: Math.sin(from.angle) * midRadius },
    { x: Math.cos(to.angle) * midRadius, y: Math.sin(to.angle) * midRadius }
  ];
}

/** A cubic Bézier as a plain path — used for the thin cross-links. */
export function curvePath(p0, c1, c2, p3) {
  return `M${round(p0.x)},${round(p0.y)} C${round(c1.x)},${round(c1.y)} ${round(c2.x)},${round(
    c2.y
  )} ${round(p3.x)},${round(p3.y)}`;
}

/**
 * The same cubic as a closed shape whose width falls from `w0` at the trunk to
 * `w1` at the tip. Sampled rather than offset analytically: at these sizes 18
 * samples are already smoother than the eye resolves, and the result is one
 * fillable path that survives serialisation into the PNG export.
 */
export function ribbonPath(p0, c1, c2, p3, w0, w1, samples = 18) {
  const forward = [];
  const back = [];

  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const point = cubicAt(p0, c1, c2, p3, t);
    const tangent = cubicTangent(p0, c1, c2, p3, t);
    const length = Math.hypot(tangent.x, tangent.y) || 1;
    const nx = -tangent.y / length;
    const ny = tangent.x / length;
    // Ease the taper so the trunk keeps its weight for a while instead of
    // shedding it linearly the moment it leaves the parent.
    const half = (w0 + (w1 - w0) * (t * t * (3 - 2 * t))) / 2;
    forward.push(`${round(point.x + nx * half)},${round(point.y + ny * half)}`);
    back.push(`${round(point.x - nx * half)},${round(point.y - ny * half)}`);
  }

  return `M${forward[0]} L${forward.slice(1).join(" L")} L${back.reverse().join(" L")} Z`;
}

function cubicAt(p0, c1, c2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y
  };
}

function cubicTangent(p0, c1, c2, p3, t) {
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const c = 3 * t * t;
  return {
    x: a * (c1.x - p0.x) + b * (c2.x - c1.x) + c * (p3.x - c2.x),
    y: a * (c1.y - p0.y) + b * (c2.y - c1.y) + c * (p3.y - c2.y)
  };
}

const round = (value) => Math.round(value * 10) / 10;
