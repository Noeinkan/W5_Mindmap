/**
 * The sections of a document read from a file, as a list you can pick from.
 *
 * A book is not a transcript. Handed to the extractor whole it is two hundred
 * chunks and an hour of model time, and what comes back is a map of everything
 * and therefore of nothing. Split into the sections the document already has —
 * its chapters, its numbered headings — it becomes a list of jobs the size of a
 * meeting, and the one worth mapping is the one you pick.
 *
 * This module owns the document that was read: the panel is the only place it
 * is kept, and the controller asks it for the text of whatever was chosen.
 */

import { el } from "./ui.js";

/** @type {{name, title, text, sections, kind, unitLabel, method, chunkSize}|null} */
let current = null;
let activeIndex = -2;
let onPick = () => {};

/** The whole document, as opposed to one of its sections. */
export const WHOLE_DOCUMENT = -1;

export function initSections(handlers = {}) {
  onPick = handlers.onPick || (() => {});

  el.sectionsList.addEventListener("click", (event) => {
    const row = event.target.closest("button[data-index]");
    if (!row || !current) return;
    choose(Number(row.dataset.index), { chosen: true });
  });
}

/**
 * Put a freshly read document on the panel.
 * @param {object} doc The answer from /api/ingest, plus the file's name.
 */
export function showDocument(doc) {
  current = doc && doc.text ? doc : null;
  activeIndex = -2;
  render();
}

/** After a sample, an imported map, or anything else that is not this file. */
export function clearDocument() {
  current = null;
  activeIndex = -2;
  render();
}

/**
 * Choose a section (or `WHOLE_DOCUMENT`) and hand its text to the controller.
 *
 * `chosen` marks the click on a row, as opposed to the pick a freshly read file
 * makes for itself — the two want different things said about them.
 *
 * @returns {{title: string, text: string, index: number}|null}
 */
export function choose(index, { chosen = false } = {}) {
  if (!current) return null;

  const whole = index === WHOLE_DOCUMENT || !current.sections[index];
  const section = whole ? null : current.sections[index];
  const text = whole ? current.text : current.text.slice(section.start, section.end);
  const title = whole ? current.title || current.name || "Document" : section.title;

  activeIndex = whole ? WHOLE_DOCUMENT : index;
  render();
  onPick({ title, text, index: activeIndex, section, whole, chosen });
  return { title, text, index: activeIndex };
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

function render() {
  const panel = el.sectionsPanel;
  // A document with one section has nothing to choose between: the panel would
  // be a list of one row saying what the transcript box already shows.
  if (!current || current.sections.length < 2) {
    panel.hidden = true;
    panel.open = false;
    el.sectionsList.replaceChildren();
    return;
  }

  panel.hidden = false;
  el.sectionsBadge.textContent = String(current.sections.length);
  el.sectionsSource.textContent = sourceLine(current);

  const rows = [row(WHOLE_DOCUMENT, `Whole ${noun(current)}`, current.chars, current.chunkSize)];
  current.sections.forEach((section, index) => {
    rows.push(row(index, `${index + 1}. ${section.title}`, section.chars, current.chunkSize));
  });
  el.sectionsList.replaceChildren(...rows);
}

function row(index, title, chars, chunkSize) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "section-row";
  button.dataset.index = String(index);
  if (index === activeIndex) button.setAttribute("aria-current", "true");

  const name = document.createElement("span");
  name.className = "section-title";
  name.textContent = title;

  const meta = document.createElement("span");
  meta.className = "section-meta";
  meta.textContent = describeSize(chars, chunkSize);

  button.append(name, meta);
  return button;
}

/** What a section costs to map, in the only two units that matter here. */
function describeSize(chars, chunkSize) {
  const chunks = Math.max(1, Math.ceil(chars / (chunkSize || 3500)));
  return `${chars.toLocaleString("en-GB")} chars · ${chunks} chunk${chunks === 1 ? "" : "s"}`;
}

function noun(doc) {
  if (doc.kind === "epub") return "book";
  return doc.kind === "pdf" ? "document" : "file";
}

/** Where the split came from, because it changes how much to trust the titles. */
function sourceLine(doc) {
  const where = {
    contents: "from the document's own contents",
    headings: "from the headings on the page",
    documents: "one per chapter file",
    none: "no sections found — the whole thing is one"
  }[doc.method];
  const size = `${doc.units} ${doc.unitLabel}${doc.units === 1 ? "" : "s"}`;
  return `${size}, ${where}`;
}
