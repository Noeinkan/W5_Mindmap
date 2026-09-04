/**
 * The saved shape of a mind map, and the rules a saved map has to obey.
 *
 * One document, whichever door it comes through: the JSON export, the browser's
 * own autosave, and a map stored on the server are all this object. Keeping the
 * rules in one file is the point — `lib/document.js` loads this module from Node
 * instead of holding a second copy, so a file the browser accepts on import is a
 * file the server accepts on save, by construction rather than by good intentions.
 *
 * Pure: no DOM, no storage, no fetch. That is what lets Node import it.
 */

export const DOC_VERSION = 1;

export const NODE_TYPES = ["theme", "cause", "hierarchy"];
export const EDGE_TYPES = ["relates", "causes", "supports", "contrasts"];

export const DEFAULT_TITLE = "Central topic";

const DEFAULT_NODE_TYPE = "theme";
const DEFAULT_EDGE_TYPE = "relates";

// The same ceilings `lib/graph.js` applies to what the model returns. A label the
// server would have cut must not come back in at full length through a file.
const MAX_TITLE_LENGTH = 120;
const MAX_LABEL_LENGTH = 120;
const MAX_QUOTE_LENGTH = 300;
// A transcript is the one field with no natural bound. This is far above the
// longest real meeting and far below what would choke localStorage on its own.
const MAX_TRANSCRIPT_LENGTH = 200000;

export function normalizeNodeType(type) {
  const t = String(type || "").toLowerCase().trim();
  return NODE_TYPES.includes(t) ? t : DEFAULT_NODE_TYPE;
}

export function normalizeEdgeType(type) {
  const t = String(type || "").toLowerCase().trim();
  return EDGE_TYPES.includes(t) ? t : DEFAULT_EDGE_TYPE;
}

function clamp(value, max) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const round = (n) => Math.round(n * 10) / 10;

/**
 * Build the document for the map currently on screen.
 *
 * @param {{title?:string, transcript?:string, nodes?:Array, edges?:Array, savedAt?:string}} source
 */
export function toDocument({ title, transcript, nodes = [], edges = [], savedAt } = {}) {
  const doc = {
    version: DOC_VERSION,
    title: clamp(title || DEFAULT_TITLE, MAX_TITLE_LENGTH) || DEFAULT_TITLE,
    nodes: nodes.map((n) => {
      const node = {
        id: String(n.id),
        label: clamp(n.label, MAX_LABEL_LENGTH),
        type: normalizeNodeType(n.type)
      };
      // The quote is the whole body of a note card: a map saved without it comes
      // back unable to answer "did the model make this up?".
      if (n.quote && String(n.quote).trim()) node.quote = clamp(n.quote, MAX_QUOTE_LENGTH);
      // Only positions the user placed by hand travel with the document. Every
      // other coordinate is the layout's own output — recomputed identically on
      // load, and noise in a file meant to be read.
      //
      // The flag goes with them, and is what makes that distinction survive a
      // second pass: a document read back and written again (imported, then
      // saved; saved, then validated on the server) has no other way of saying
      // that its coordinates are a choice rather than a cached layout.
      if (n.pinned && Number.isFinite(n.x) && Number.isFinite(n.y)) {
        node.x = round(n.x);
        node.y = round(n.y);
        node.pinned = true;
      }
      return node;
    }),
    edges: edges.map((e) => ({
      id: String(e.id),
      from: String(e.from),
      to: String(e.to),
      type: normalizeEdgeType(e.type)
    }))
  };

  // Whitespace is content here, so the transcript never goes through `clamp`.
  const text = String(transcript || "");
  if (text.trim()) doc.transcript = text.slice(0, MAX_TRANSCRIPT_LENGTH);
  if (savedAt) doc.savedAt = String(savedAt);
  return doc;
}

/**
 * Check and normalise a document that came from outside — a file the user picked,
 * a row read back from localStorage, a request body.
 *
 * Two levels, deliberately: `errors` are reasons the whole thing is not a mind map
 * and there is nothing to load; `warnings` are rows dropped on the way in, which
 * still leave a usable map. Rejecting a whole file over one edge pointing at a
 * node that is not there would be the wrong trade — that edge is the only thing
 * lost, and the map is fine without it.
 *
 * @returns {{ok:boolean, errors:string[], warnings:string[], doc:object|null}}
 */
export function validateDocument(value) {
  const errors = [];
  const warnings = [];

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("This is not a mind map document — expected a JSON object.");
    return { ok: false, errors, warnings, doc: null };
  }

  if (Number(value.version) > DOC_VERSION) {
    errors.push(`This map was saved by a newer version of the app (format ${value.version}).`);
  }
  if (!Array.isArray(value.nodes)) {
    errors.push('"nodes" is missing, or is not an array.');
  }
  if (value.edges !== undefined && !Array.isArray(value.edges)) {
    errors.push('"edges" is there but is not an array.');
  }
  if (errors.length) return { ok: false, errors, warnings, doc: null };

  const seenNodeIds = new Set();
  let unusable = 0;
  let duplicates = 0;

  const nodes = value.nodes
    .filter((n) => {
      const usable = n && typeof n === "object" && n.id && n.label && String(n.label).trim();
      if (!usable) unusable += 1;
      return usable;
    })
    .filter((n) => {
      const id = String(n.id);
      if (seenNodeIds.has(id)) {
        duplicates += 1;
        return false;
      }
      seenNodeIds.add(id);
      return true;
    });

  if (unusable) warnings.push(`${unusable} node${unusable > 1 ? "s" : ""} had no id or no label — skipped.`);
  if (duplicates) warnings.push(`${duplicates} node${duplicates > 1 ? "s" : ""} repeated an id already used — skipped.`);

  const rawEdges = Array.isArray(value.edges) ? value.edges : [];
  const seenEdgeIds = new Set();
  let dangling = 0;

  const edges = rawEdges
    .filter((e) => e && typeof e === "object" && e.id && e.from && e.to)
    .filter((e) => {
      const ok = seenNodeIds.has(String(e.from)) && seenNodeIds.has(String(e.to)) && String(e.from) !== String(e.to);
      if (!ok) dangling += 1;
      return ok;
    })
    .filter((e) => {
      const id = String(e.id);
      if (seenEdgeIds.has(id)) {
        dangling += 1;
        return false;
      }
      seenEdgeIds.add(id);
      return true;
    });

  if (dangling) {
    warnings.push(
      `${dangling} connection${dangling > 1 ? "s" : ""} pointed at a node that is not in the file — dropped.`
    );
  }

  const doc = toDocument({
    title: value.title,
    transcript: value.transcript,
    nodes,
    edges,
    savedAt: value.savedAt
  });

  return { ok: true, errors, warnings, doc };
}

/** `validateDocument` for text that has not been parsed yet — a file, a stored row. */
export function readDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [`That file is not valid JSON (${err.message}).`],
      warnings: [],
      doc: null
    };
  }
  return validateDocument(parsed);
}
