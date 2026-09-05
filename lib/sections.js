"use strict";

/**
 * Where a document breaks into sections.
 *
 * A book or a report is not one text, and feeding the whole of it to the model
 * as one transcript gives one enormous map of nothing in particular. Split into
 * chapters it becomes a stack of small, answerable jobs — one map per chapter,
 * or one chapter picked out of a book and mapped on its own.
 *
 * The order of preference is the same for both formats, and it is the order of
 * how much the writer meant it:
 *
 * 1. **What the file says.** A PDF outline (its bookmarks) or an EPUB table of
 *    contents was written by hand, so its titles are real titles and its
 *    boundaries are real boundaries.
 * 2. **What the text looks like.** No outline: a line near the top of a page
 *    reading "Chapter 4" is a chapter heading, and two of them make a book.
 * 3. **Nothing.** One section holding the lot, which is what a five-page
 *    memo should be.
 *
 * A "unit" here is a page for a PDF and a spine document for an EPUB — the
 * smallest thing a section boundary can land on.
 */

const HEADING_PATTERNS = [
  { kind: "Chapter", pattern: /^\s*chapter\s+(\d{1,3}|[ivxlcdm]{1,7})\b[\s:.\-–—]*(.*)$/i },
  { kind: "Part", pattern: /^\s*part\s+(\d{1,3}|[ivxlcdm]{1,7})\b[\s:.\-–—]*(.*)$/i },
  { kind: "Appendix", pattern: /^\s*appendix\s+([a-z]|\d{1,2})\b[\s:.\-–—]*(.*)$/i }
];

/**
 * The other way a document numbers itself: "4. Information Delivery" at the top
 * of a page. A report has no chapters but it has these, and they are the only
 * headings a BEP or an EIR ever gives you. The capital after the number is what
 * keeps a list item ("3. see the appendix") out.
 */
const NUMBERED_HEADING = /^\s*(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+([A-Z][^.]{2,80})$/;

// A heading sits at the top of the page it opens; further down it is a mention.
const HEADING_LINES = 12;
// More than this and the list stops being a way to find a chapter.
const MAX_SECTIONS = 300;

/**
 * @param {{units: string[], marks?: Array<{title: string, unit: number, depth?: number}>,
 *   splitByUnit?: boolean}} input
 *   `splitByUnit` says a unit is already a section on its own — true of an EPUB,
 *   where the spine holds one document per chapter, and false of a PDF, where a
 *   section per page would be nonsense.
 * @returns {{sections: Array<{title: string, from: number, to: number}>, method: string}}
 *   `from`/`to` are unit indices, `to` exclusive.
 */
function detectSections({ units, marks = [], splitByUnit = false }) {
  const total = units.length;
  if (!total) return { sections: [], method: "none" };

  const fromMarks = rangesFrom(chooseMarks(marks), total);
  if (fromMarks.length >= 2) return { sections: fromMarks, method: "contents" };

  const fromHeadings = rangesFrom(headingMarks(units), total);
  if (fromHeadings.length >= 2) return { sections: fromHeadings, method: "headings" };

  // A book whose contents list is a single "Start" entry — every EPUB a
  // converter has been through — still has its chapters, one per file.
  if (splitByUnit && total >= 2) {
    return {
      sections: units.map((unit, index) => ({ title: unitTitle(unit, index), from: index, to: index + 1 })),
      method: "documents"
    };
  }

  return { sections: [{ title: "Whole document", from: 0, to: total }], method: "none" };
}

/** A document's own first line, when it is short enough to be a heading. */
function unitTitle(unit, index) {
  const first = String(unit || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return first && first.length <= 60 ? first : `Part ${index + 1}`;
}

/**
 * Which entries of a table of contents are the sections.
 *
 * A contents list is a tree, and cutting at every leaf of it would make a
 * hundred one-paragraph sections. So: the chapters, if the list names things
 * "Chapter n" — plus the top-level entries that are not chapters, which is where
 * the introduction, the glossary and the index live. Failing that, the shallowest
 * level that has more than one entry on it.
 */
function chooseMarks(marks) {
  const usable = marks.filter((mark) => mark && mark.title && Number.isInteger(mark.unit) && mark.unit >= 0);
  if (usable.length < 2) return usable;

  const isChapter = (mark) => /^\s*chapter\b/i.test(mark.title);
  const chapters = usable.filter(isChapter);
  if (chapters.length >= 2) {
    const bookends = usable.filter(
      (mark) => (mark.depth || 0) === 0 && !/^\s*(chapter|part)\b/i.test(mark.title)
    );
    return [...bookends, ...chapters];
  }

  const depths = [...new Set(usable.map((mark) => mark.depth || 0))].sort((a, b) => a - b);
  for (const depth of depths) {
    const level = usable.filter((mark) => (mark.depth || 0) === depth);
    if (level.length >= 2) return level;
  }
  return usable;
}

/** Marks read off the text itself, for a file that carries no contents list. */
function headingMarks(units) {
  const marks = [];
  const seen = new Set();

  units.forEach((text, unit) => {
    const all = String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    // The contents page names every heading in the document. Read as headings
    // they would open a section each, at the front, in the wrong order — and
    // the real openings further in would then be thrown away as duplicates.
    if (looksLikeContents(all)) return;

    const lines = all.slice(0, HEADING_LINES);
    for (const line of lines) {
      // A heading is short. "…as we saw in Chapter 4, the rate…" is not one.
      if (line.length > 90) continue;
      const heading = readHeading(line);
      if (!heading) continue;
      if (!seen.has(heading.key)) {
        seen.add(heading.key);
        marks.push({ title: heading.title, unit, depth: 0 });
      }
      break;
    }
  });
  return marks;
}

/**
 * A page of the contents rather than a page of the document: several entries
 * that end in a page number, or a run of headings one after another with no
 * prose between them.
 */
function looksLikeContents(lines) {
  if (lines.length < 3) return false;

  const withPageNumbers = lines.filter((line) => /[\s.·—–-]\d{1,4}$/.test(line) && line.length < 100).length;
  if (withPageNumbers >= 3 && withPageNumbers >= lines.length * 0.4) return true;

  const headings = lines.slice(0, 14).filter((line) => line.length <= 90 && readHeading(line)).length;
  return headings >= 4;
}

function readHeading(line) {
  for (const { kind, pattern } of HEADING_PATTERNS) {
    const match = pattern.exec(line);
    if (!match) continue;
    const number = match[1];
    const rest = (match[2] || "").trim().replace(/[\s.:–—-]+$/, "");
    return {
      title: rest ? `${kind} ${number} — ${rest}` : `${kind} ${number}`,
      key: `${kind}:${number}`.toLowerCase()
    };
  }

  const numbered = NUMBERED_HEADING.exec(line);
  if (numbered) {
    const title = `${numbered[1]} ${numbered[2].trim()}`;
    // Numbered by its top level: "4.1" continues section 4 rather than opening
    // one, and a section per subheading is a section per paragraph.
    return { title, key: `n:${numbered[1].split(".")[0]}` };
  }
  return null;
}

/** Marks in reading order, turned into the ranges between them. */
function rangesFrom(marks, total) {
  const sorted = [...marks]
    .filter((mark) => mark.unit < total)
    .sort((a, b) => a.unit - b.unit || (a.depth || 0) - (b.depth || 0));

  const starts = [];
  for (const mark of sorted) {
    // Two entries on the same page are one section, titled by the first.
    if (starts.length && starts[starts.length - 1].unit === mark.unit) continue;
    starts.push(mark);
  }
  if (!starts.length) return [];

  // Whatever comes before the first heading is still part of the document: a
  // title page, a preface, an executive summary.
  if (starts[0].unit > 0) starts.unshift({ title: "Front matter", unit: 0 });

  const sections = starts.slice(0, MAX_SECTIONS).map((mark, index, kept) => ({
    title: cleanTitle(mark.title),
    from: mark.unit,
    to: index + 1 < kept.length ? kept[index + 1].unit : total
  }));
  return sections.filter((section) => section.to > section.from);
}

function cleanTitle(title) {
  const clean = String(title || "")
    .replace(/\s+/g, " ")
    // A contents list often carries its page number in the title, as leader dots.
    .replace(/[.·\s]{4,}\d{1,4}\s*$/, "")
    .trim();
  return clean.length > 90 ? `${clean.slice(0, 88).trimEnd()}…` : clean || "Untitled section";
}

/**
 * The units joined into one text, with each section's place in it recorded so the
 * app can hand a single chapter to the model without asking for the file again.
 *
 * A title is written in above its section unless the text already opens with it,
 * because a chunk that starts "Chapter 7 — Risk" tells the model what it is
 * reading, and the model reuses that in the labels it invents.
 */
function assembleSections(units, sections, { headings = true } = {}) {
  const parts = [];
  const placed = [];
  let length = 0;

  for (const section of sections) {
    const body = units
      .slice(section.from, section.to)
      .map((unit) => String(unit || "").trim())
      .filter(Boolean)
      .join("\n\n");
    if (!body) continue;

    const heading = headings && !startsWithTitle(body, section.title) ? `${section.title}\n\n` : "";
    const text = heading + body;
    const start = length ? length + 2 : 0;

    if (length) parts.push("\n\n");
    parts.push(text);
    length = start + text.length;

    placed.push({
      title: section.title,
      start,
      end: length,
      chars: text.length,
      from: section.from,
      to: section.to
    });
  }

  return { text: parts.join(""), sections: placed };
}

function startsWithTitle(body, title) {
  const head = body.slice(0, 120).toLowerCase().replace(/\s+/g, " ");
  const name = String(title || "").toLowerCase().replace(/\s+/g, " ").slice(0, 40);
  return Boolean(name) && head.startsWith(name);
}

module.exports = { detectSections, assembleSections, readHeading };
