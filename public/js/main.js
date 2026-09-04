/** Composition root: builds the two views, the controller, and keeps them in sync. */

import { createGraph } from "./graph.js";
import { createNotes } from "./notes.js";
import { connectController } from "./controller.js";
import { state, subscribe } from "./state.js";
import { restoreSession, applyDocument, initAutosave } from "./session.js";
import { el, syncPanels, updateCharCount, setStatus, toast, relativeTime } from "./ui.js";

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

// The map from the last visit, back before anything is subscribed or drawn: the
// first render below then paints it in place, instead of the canvas flashing
// empty and animating it in.
const restored = restoreSession();
if (restored) applyDocument(restored.doc);

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
if (restored) graph.fit({ duration: 0 });

setStatus(restoredMessage(restored) || "Ready — paste a transcript or add nodes by hand");

// Started last, so restoring the session is not itself the first thing saved.
initAutosave({ onProblem: (message) => toast(message, "error", 5200) });

function restoredMessage(session) {
  if (!session) return null;
  const when = relativeTime(session.savedAt);
  const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const what = state.nodes.length
    ? `${count(state.nodes.length, "node")}, ${count(state.edges.length, "connection")}`
    : "the transcript you had open";
  return `Restored ${what}${when ? ` from ${when}` : ""}`;
}
