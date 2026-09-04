/**
 * The map currently on screen, as a document — and the browser's own copy of it.
 *
 * Two jobs that are really one: turning the live state into the saved format and
 * back (which import, the library and the autosave all need), and keeping the
 * last version of it in localStorage so a reload does not throw away an hour of
 * hand editing. Before this, Export JSON was the only way out and there was no
 * way back in.
 */

import { state, setGraph, emit, subscribe, withHistory } from "./state.js";
import { toDocument, readDocument, DEFAULT_TITLE } from "./graph-doc.js";
import { el, updateCharCount } from "./ui.js";

const KEY = "mindmap.session.v1";
// Long enough that dragging a node writes once at the end of the gesture rather
// than sixty times during it; short enough to survive a reflex Ctrl+R.
const AUTOSAVE_DELAY_MS = 700;

/* ------------------------------------------------------------------ */
/* State ⇄ document                                                    */
/* ------------------------------------------------------------------ */

/** The map on screen, in the shape it is saved and exported in. */
export function currentDocument() {
  return toDocument({
    title: state.title,
    transcript: state.transcript,
    nodes: state.nodes,
    edges: state.edges
  });
}

/**
 * Put a document on screen: an imported file, a map from the library, or the
 * autosave from last time.
 *
 * The graph is emptied first on purpose. `setGraph` keeps the position of any id
 * it already knows so a streamed map settles instead of exploding — but ids are
 * `n1`, `n2`, … in every map, so opening a second one would otherwise inherit the
 * first one's layout node by node.
 *
 * `undoable` is what makes opening the wrong file survivable: it replaces
 * everything on the canvas, and without a history entry the map that was there is
 * gone — the autosave has already been written over by the new one. Restoring
 * last session's map at startup is the one case that wants no entry, because
 * there is nothing yet to go back to.
 */
export function applyDocument(doc, { undoable = false } = {}) {
  const apply = () => {
    state.nodes = [];
    state.edges = [];
    state.selection = null;
    setGraph(doc);
    state.title = doc.title || DEFAULT_TITLE;
    state.transcript = doc.transcript || "";
    el.transcript.value = state.transcript;
    updateCharCount();
  };

  if (undoable) {
    withHistory(apply);
    return;
  }
  apply();
  emit("graph");
}

/* ------------------------------------------------------------------ */
/* Autosave                                                            */
/* ------------------------------------------------------------------ */

let timer = null;
let onProblem = () => {};

/** Saves the current map to localStorage, coalescing bursts of edits. */
export function scheduleAutosave() {
  clearTimeout(timer);
  timer = setTimeout(saveNow, AUTOSAVE_DELAY_MS);
}

export function saveNow() {
  clearTimeout(timer);
  const doc = currentDocument();

  // An empty canvas is not a map worth restoring, and writing one would quietly
  // overwrite the map the user actually wants back after a stray "delete all".
  if (!doc.nodes.length && !doc.transcript) {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* A browser that refuses storage has nothing to clear either. */
    }
    return;
  }

  doc.savedAt = new Date().toISOString();
  if (write(doc)) return;

  // Out of room. The transcript is by far the biggest field and the one the user
  // can paste again, so it is what gets dropped before the map itself.
  const { transcript, ...withoutTranscript } = doc;
  if (transcript && write(withoutTranscript)) {
    onProblem("The map was saved locally, but the transcript was too big to keep with it");
    return;
  }
  onProblem("This map is too big to save in the browser — export it or save it to the library");
}

function write(doc) {
  try {
    localStorage.setItem(KEY, JSON.stringify(doc));
    return true;
  } catch {
    // QuotaExceededError, or storage switched off entirely (private windows do
    // both). Either way the answer is the same: say so once, do not throw.
    return false;
  }
}

/**
 * Start saving after every change to the graph.
 *
 * @param {{onProblem?: (message: string) => void}} handlers
 */
export function initAutosave({ onProblem: report } = {}) {
  if (report) onProblem = report;
  subscribe((reason) => {
    if (reason === "graph") scheduleAutosave();
  });
}

/**
 * The map from the last visit, or null. Anything unreadable is treated as
 * nothing: a session that cannot be parsed is not worth an error dialog on a
 * page the user has only just opened.
 *
 * @returns {{doc: object, savedAt: string|null}|null}
 */
export function restoreSession() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  const { ok, doc } = readDocument(raw);
  if (!ok || (!doc.nodes.length && !doc.transcript)) return null;
  return { doc, savedAt: doc.savedAt || null };
}

/** Forgets the stored session — used when the user asks for a blank canvas. */
export function clearSession() {
  clearTimeout(timer);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* Nothing stored, nothing to forget. */
  }
}
