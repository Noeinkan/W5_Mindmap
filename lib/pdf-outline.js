"use strict";

/**
 * The outline of a PDF — the bookmarks a reader shows down the side.
 *
 * This is the best table of contents a file can give, because the writer put it
 * there on purpose: titles that are really titles, each pointing at the page it
 * starts on. `sections.js` prefers it over anything guessed from the text, and
 * only falls back to guessing when a file has no outline at all.
 *
 * The awkward part is the destination. An entry points at a page directly, or
 * through an action, or through a name that has to be looked up in a tree
 * somewhere else in the file — all three are common, so all three are here.
 */

const { PdfRef, decodePdfString, isDict, nameOf, toArray } = require("./pdf-lexer");

const MAX_ENTRIES = 4000;
const MAX_DEPTH = 12;

/**
 * @param {object} pdf The parsed file, from `parsePdfObjects`.
 * @param {Map<number, number>} pageNumberOf Page object number → page index.
 * @param {string[]} warnings
 * @returns {Array<{title: string, page: number, depth: number}>}
 */
function readOutline(pdf, pageNumberOf, warnings = []) {
  const root = pdf.resolve(pdf.trailer.Root);
  const outlines = root ? pdf.resolve(root.Outlines) : null;
  if (!isDict(outlines)) return [];

  const entries = [];
  const visited = new Set();
  const lookup = createDestinationLookup(pdf);

  const walk = (ref, depth) => {
    let current = ref;
    while (current && entries.length < MAX_ENTRIES) {
      const key = current instanceof PdfRef ? current.num : null;
      if (key !== null) {
        if (visited.has(key)) return;
        visited.add(key);
      }
      const item = pdf.resolve(current);
      if (!isDict(item)) return;

      const title = decodePdfString(pdf.resolve(item.Title)).trim();
      const page = pageOf(pdf, item, lookup, pageNumberOf);
      if (title && page !== null) entries.push({ title, page, depth });

      if (item.First !== undefined && depth < MAX_DEPTH) walk(item.First, depth + 1);
      current = item.Next;
    }
  };

  try {
    walk(outlines.First, 0);
  } catch (err) {
    warnings.push(`The outline of this PDF could not be read (${err.message}).`);
  }
  return entries;
}

/** The page an outline entry lands on, whichever of the three ways it says so. */
function pageOf(pdf, item, lookup, pageNumberOf) {
  let destination = pdf.resolve(item.Dest);

  if (destination === null || destination === undefined) {
    const action = pdf.resolve(item.A);
    if (isDict(action) && ["GoTo", undefined].includes(nameOf(pdf.resolve(action.S)) || undefined)) {
      destination = pdf.resolve(action.D);
    }
  }

  // A name, or a byte string: both are keys into the file's destination tables.
  if (Buffer.isBuffer(destination) || (destination && destination.name !== undefined)) {
    const key = Buffer.isBuffer(destination) ? decodePdfString(destination) : destination.name;
    destination = lookup(key);
  }
  // A named destination can be wrapped in a dictionary of its own.
  if (isDict(destination)) destination = pdf.resolve(destination.D);
  if (!Array.isArray(destination) || !destination.length) return null;

  const target = destination[0];
  if (target instanceof PdfRef) {
    const index = pageNumberOf.get(target.num);
    return index === undefined ? null : index;
  }
  // A plain number is a page index already — how a remote destination is written.
  return typeof target === "number" && target >= 0 ? target : null;
}

/**
 * Named destinations live in one of two places depending on how old the file is:
 * a flat /Dests dictionary, or a name tree under /Names. Both are read lazily,
 * because most files never ask.
 */
function createDestinationLookup(pdf) {
  const root = pdf.resolve(pdf.trailer.Root);
  const flat = root ? pdf.resolve(root.Dests) : null;
  const names = root ? pdf.resolve(root.Names) : null;
  const tree = names ? pdf.resolve(names.Dests) : null;
  const cache = new Map();

  return (key) => {
    if (cache.has(key)) return cache.get(key);
    let found = null;
    if (isDict(flat) && flat[key] !== undefined) found = pdf.resolve(flat[key]);
    if (!found && isDict(tree)) found = searchNameTree(pdf, tree, key, 0);
    cache.set(key, found);
    return found;
  };
}

function searchNameTree(pdf, node, key, depth) {
  if (!isDict(node) || depth > 24) return null;

  const pairs = pdf.resolve(node.Names);
  if (Array.isArray(pairs)) {
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const name = pdf.resolve(pairs[i]);
      if (decodePdfString(name) === key) return pdf.resolve(pairs[i + 1]);
    }
  }

  for (const kid of toArray(pdf.resolve(node.Kids))) {
    // The Limits of a branch say which names it can hold; skipping the branches
    // that cannot hold this one is what keeps a big tree cheap.
    const child = pdf.resolve(kid);
    const limits = isDict(child) ? pdf.resolve(child.Limits) : null;
    if (Array.isArray(limits) && limits.length === 2) {
      const low = decodePdfString(pdf.resolve(limits[0]));
      const high = decodePdfString(pdf.resolve(limits[1]));
      if (key < low || key > high) continue;
    }
    const found = searchNameTree(pdf, child, key, depth + 1);
    if (found) return found;
  }
  return null;
}

module.exports = { readOutline };
