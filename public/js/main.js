/** Composition root: builds the two views, the controller, and keeps them in sync. */

import { createGraph } from "./graph.js";
import { createNotes } from "./notes.js";
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

const notes = createNotes(el.notes, {
  onSelect: (node, event) => delegate.onNoteSelect?.(node, event),
  onFollow: (node, edge) => delegate.onNoteFollow?.(node, edge),
  onEdit: (node) => delegate.onNoteEdit?.(node)
});

delegate = connectController(graph, notes);
// The controller applies the stored/system theme; the graph palette was read
// before that happened, so pick up the final colours.
graph.refreshTheme();

// Both views stay rendered whichever one is on screen: the note board is an
// overlay rather than a replacement, so switching is instant and the PNG export
// still has a laid-out map to serialise from the note view.
subscribe((reason) => {
  if (reason === "graph") {
    graph.render();
    notes.render();
  } else {
    graph.paint();
    notes.paint();
  }
  syncPanels();
});

new ResizeObserver(() => graph.resize()).observe(el.canvas);

updateCharCount();
syncPanels();
graph.render({ animate: false });
notes.render();
setStatus("Ready — paste a transcript or add nodes by hand");
