/** Download helpers: the graph as JSON, or the canvas as a PNG image. */

import { readPalette } from "./palette.js";
import { currentDocument } from "./session.js";

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The map as a file. It is the same document the app saves and reads back, so an
 * export is a round trip rather than a one-way dump: the quotes that make the
 * note view worth reading, the transcript the map came from, and the positions
 * of the nodes the user placed by hand all leave with it.
 */
export function exportJson() {
  const payload = JSON.stringify(currentDocument(), null, 2);
  download(new Blob([payload], { type: "application/json" }), "mindmap.json");
}

/**
 * Rasterises the live SVG, cropped to the graph bounds, at 2× resolution.
 *
 * `view` is whichever canvas is on screen — the map or the flow diagram. Both
 * answer `bounds()` and `svgNode()` and both draw into a `g.viewport`, which is
 * the whole contract this needs, so exporting what you are looking at costs
 * nothing beyond being handed the right one.
 */
export async function exportPng(view, filename = "mindmap.png") {
  const box = view.bounds();
  if (!box) throw new Error("Nothing to export yet");

  const padding = 48;
  const width = box.x1 - box.x0 + padding * 2;
  const height = box.y1 - box.y0 + padding * 2;
  const palette = readPalette();

  const clone = view.svgNode().cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", width);
  clone.setAttribute("height", height);
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const viewport = clone.querySelector("g.viewport");
  viewport.setAttribute(
    "transform",
    `translate(${padding - box.x0}, ${padding - box.y0})`
  );

  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("width", width);
  background.setAttribute("height", height);
  background.setAttribute("fill", palette.canvasBg);
  clone.insertBefore(background, clone.firstChild);

  const source = new XMLSerializer().serializeToString(clone);
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

  const image = await loadImage(svgUrl);
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  download(blob, filename);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not render the image"));
    image.src = src;
  });
}
