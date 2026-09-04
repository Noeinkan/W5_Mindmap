/**
 * Every colour the canvas draws with, read from the CSS custom properties so
 * the two themes stay defined in one place.
 *
 * Two palettes, because the map encodes two different things. Node and edge
 * *type* keeps its own colours — that is what the legend filters on. Branch
 * colour is separate and is what makes a mind map findable: everything hanging
 * off one branch of the centre carries the same hue, so you locate a concept by
 * pointing at its side of the map before you read a single label.
 */

const BRANCH_VARS = ["--b1", "--b2", "--b3", "--b4", "--b5", "--b6", "--b7", "--b8"];

export function readPalette() {
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
    branches: BRANCH_VARS.map(read).filter(Boolean),
    nodeBg: read("--node-bg"),
    nodeText: read("--node-text"),
    text: read("--text"),
    textDim: read("--text-dim"),
    accent: read("--accent"),
    accentHi: read("--accent-hi"),
    accentFg: read("--accent-fg"),
    warn: read("--warn"),
    canvasBg: read("--canvas-bg")
  };
}

/** Stable colour for a branch: same branch, same hue, run after run. */
export function branchColour(palette, branchId, index) {
  if (!palette.branches.length) return palette.accentHi;
  if (branchId == null) return palette.accentHi;
  return palette.branches[index % palette.branches.length];
}

/** Fades a hex colour by returning an rgba string; passes anything else through. */
export function fade(hex, alpha) {
  const value = String(hex || "").trim();
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
