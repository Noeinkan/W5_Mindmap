/** Composition root: builds the graph, the controller, and keeps them in sync. */

import { createGraph } from "./graph.js";
import { connectController } from "./controller.js";
import { subscribe } from "./state.js";
import { el, syncPanels, updateCharCount, setStatus } from "./ui.js";

let delegate = {};

const graph = createGraph(el.graph, {
  onNodeClick: (node, event) => delegate.onNodeClick?.(node, event),
  onNodeDoubleClick: (node, event) => delegate.onNodeDoubleClick?.(node, event),
  onEdgeClick: (edge, event) => delegate.onEdgeClick?.(edge, event),
  onBackgroundClick: () => delegate.onBackgroundClick?.(),
  onZoom: (transform) => delegate.onZoom?.(transform)
});

delegate = connectController(graph);
// The controller applies the stored/system theme; the graph palette was read
// before that happened, so pick up the final colours.
graph.refreshTheme();

subscribe((reason) => {
  if (reason === "graph") graph.render();
  else graph.paint();
  syncPanels();
});

new ResizeObserver(() => graph.resize()).observe(el.canvas);

updateCharCount();
syncPanels();
graph.render({ reheat: false });
setStatus("Ready — paste a transcript or add nodes by hand");
