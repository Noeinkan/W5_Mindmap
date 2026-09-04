/** Download helpers: the graph as JSON, or the canvas as a PNG image. */

import { state } from "./state.js";
import { readPalette } from "./graph.js";

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportJson() {
  const payload = JSON.stringify(
    {
      nodes: state.nodes.map(({ id, label, type }) => ({ id, label, type })),
      edges: state.edges.map(({ id, from, to, type }) => ({ id, from, to, type }))
    },
    null,
    2
  );
  download(new Blob([payload], { type: "application/json" }), "mindmap.json");
}

/** Rasterises the live SVG, cropped to the graph bounds, at 2× resolution. */
export async function exportPng(graph) {
  const box = graph.bounds();
  if (!box) throw new Error("Nothing to export yet");

  const padding = 48;
  const width = box.x1 - box.x0 + padding * 2;
  const height = box.y1 - box.y0 + padding * 2;
  const palette = readPalette();

  const clone = graph.svgNode().cloneNode(true);
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
  download(blob, "mindmap.png");
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not render the image"));
    image.src = src;
  });
}
