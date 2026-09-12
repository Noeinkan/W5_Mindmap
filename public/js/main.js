/** Composition root: builds the three views, the controller, and keeps them in sync. */

import { createGraph } from "./graph.js";
import { createNotes } from "./notes.js";
import { createFlow } from "./flow.js";
import { connectController } from "./controller.js";
import { state, subscribe } from "./state.js";
import { restoreSession, applyDocument, initAutosave } from "./session.js";
import {
  el,
  syncPanels,
  syncFlowCaption,
  updateCharCount,
  setStatus,
  toast,
  relativeTime
} from "./ui.js";

let delegate = {};

const graph = createGraph(el.graph, {
  onNodeClick: (node, event) => delegate.onNodeClick?.(node, event),
  onNodeDoubleClick: (node, event) => delegate.onNodeDoubleClick?.(node, event),
  onNodeToggle: (node, event) => delegate.onNodeToggle?.(node, event),
  onEdgeClick: (edge, event) => delegate.onEdgeClick?.(edge, event),
  onBackgroundClick: () => delegate.onBackgroundClick?.(),
  onZoom: (transform) => delegate.onZoom?.(transform)
});

const notes = createNotes(el.notes, {
  onSelect: (node, event) => delegate.onNoteSelect?.(node, event),
  onFollow: (node, edge) => delegate.onNoteFollow?.(node, edge),
  onEdit: (node) => delegate.onNoteEdit?.(node)
});

// The same handlers as the map: a click selects, a double click renames, and
// connect mode works here too. The flow view is a different drawing of the one
// graph, not a different graph, so the gestures had better mean the same thing.
const flow = createFlow(el.flow, {
  onNodeClick: (node, event) => delegate.onNodeClick?.(node, event),
  onNodeDoubleClick: (node, event) => delegate.onNodeDoubleClick?.(node, event),
  onEdgeClick: (edge, event) => delegate.onEdgeClick?.(edge, event),
  onBackgroundClick: () => delegate.onBackgroundClick?.()
});

delegate = connectController(graph, notes, flow);
// The controller applies the stored/system theme; the palettes were read before
// that happened, so both canvases pick up the final colours.
graph.refreshTheme();
flow.refreshTheme();

// The map from the last visit, back before anything is subscribed or drawn: the
// first render below then paints it in place, instead of the canvas flashing
// empty and animating it in.
const restored = restoreSession();
if (restored) applyDocument(restored.doc);

// All three views stay rendered whichever one is on screen: the note board and
// the flow canvas are overlays rather than replacements, so switching is
// instant and the PNG export still has a laid-out map to serialise from either
// of them.
subscribe((reason) => {
  if (reason === "graph") {
    graph.render();
    notes.render();
    flow.render();
  } else {
    graph.paint();
    notes.paint();
    flow.paint();
  }
  syncPanels();
  syncFlowCaption(flow.summary());
});

new ResizeObserver(() => graph.resize()).observe(el.canvas);

updateCharCount();
syncPanels();
graph.render({ animate: false });
notes.render();
flow.render();
syncFlowCaption(flow.summary());
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
