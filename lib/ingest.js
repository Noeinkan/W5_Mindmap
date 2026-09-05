"use strict";

/**
 * A file the user handed over, turned into the text the extractor reads.
 *
 * One way in for every format: sniff what the bytes are, read them into units
 * (pages, chapters, or the lines of a text file), let `sections.js` say where the
 * document breaks, and hand back one string plus the map of where each section
 * sits inside it. The app can then map the whole thing or one chapter of it
 * without asking for the file a second time.
 *
 * The format is decided by the bytes, not by the name: a `.pdf` that is really a
 * ZIP would otherwise fail deep inside a parser with a puzzling message.
 */

const { pdfToPages } = require("./pdf-text");
const { epubToDocuments } = require("./epub-text");
const { detectSections, assembleSections } = require("./sections");
const { normalizeText } = require("./html-text");
const { readZip } = require("./zip");

/**
 * The ceiling is a safety valve, not a reading limit: a whole book comes back
 * whole, because the section list is what keeps a run short — the app hands the
 * model one chapter, not the eight hundred thousand characters around it. Two
 * million is about four fat books, and past that the browser is the thing that
 * suffers.
 */
const DEFAULT_MAX_CHARS = 2000000;
/**
 * A page with less than this much text on it, on average, has no text layer:
 * the file is a scan and what it needs is OCR, not a better reader. Counting per
 * page rather than in total is what tells a three-hundred-page scan with a
 * hundred stray characters from a two-page note that is simply short.
 */
const MIN_CHARS_PER_UNIT = 15;

const LIGATURES = { ﬁ: "fi", ﬂ: "fl", ﬀ: "ff", ﬃ: "ffi", ﬄ: "ffl", ﬅ: "st", ﬆ: "st" };

class IngestError extends Error {
  constructor(message, code = "unsupported_file") {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

/**
 * @param {Buffer} buffer The file, as it arrived.
 * @param {{filename?: string, maxChars?: number, maxPages?: number}} [options]
 * @returns {{kind: string, title: string, text: string, chars: number, units: number,
 *   unitLabel: string, method: string, sections: Array<object>, truncated: boolean, warnings: string[]}}
 */
function ingestFile(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new IngestError("That file is empty.", "empty_file");
  }

  const kind = sniff(buffer, options.filename || "");
  const read = { pdf: readPdf, epub: readEpub, text: readPlainText }[kind];
  const { units, marks, title, warnings, unitLabel, splitByUnit } = read(buffer, options);

  // Tidied before anything is measured, not after: the joins and the ligatures
  // change how long the text is, and a section's place in it has to be counted
  // against the text that is actually handed over.
  const tidied = units.map(finish);
  const { sections, method } = detectSections({ units: tidied, marks, splitByUnit });
  const assembled = assembleSections(tidied, sections, { headings: kind !== "text" });

  const text = assembled.text;
  const perUnit = text.length / Math.max(1, units.length);
  if (!text.length || (kind !== "text" && perUnit < MIN_CHARS_PER_UNIT)) {
    throw new IngestError(
      kind === "pdf" && units.length
        ? "This PDF has pages but no text in them — it is a scan, and would need OCR first."
        : "There is no readable text in that file.",
      "no_text"
    );
  }

  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;
  const capped = cap(text, maxChars);
  if (capped.truncated) {
    warnings.push(
      `Only the first ${capped.text.length.toLocaleString("en-GB")} of ${text.length.toLocaleString("en-GB")} characters were kept.`
    );
  }

  return {
    kind,
    title: title || "",
    text: capped.text,
    chars: capped.text.length,
    units: units.length,
    unitLabel,
    method,
    sections: trimSections(assembled.sections, capped.text.length),
    truncated: capped.truncated,
    warnings
  };
}

/* ------------------------------------------------------------------ */
/* One reader per format                                               */
/* ------------------------------------------------------------------ */

function readPdf(buffer, options) {
  const pdf = pdfToPages(buffer, { maxPages: options.maxPages });
  return {
    units: pdf.pages,
    marks: pdf.outline.map((entry) => ({ title: entry.title, unit: entry.page, depth: entry.depth })),
    title: pdf.title,
    warnings: pdf.warnings,
    unitLabel: "page"
  };
}

function readEpub(buffer) {
  const epub = epubToDocuments(buffer);
  return {
    units: epub.documents,
    marks: epub.marks,
    title: epub.title,
    warnings: epub.warnings,
    unitLabel: "chapter",
    splitByUnit: true
  };
}

/**
 * A text file is already text. The one thing worth reading out of it is its
 * Markdown headings, which are the same promise a chapter title makes.
 */
function readPlainText(buffer) {
  const text = normalizeText(decodeText(buffer));
  const units = [];
  const marks = [];
  let current = [];

  for (const line of text.split("\n")) {
    const heading = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      if (current.length) units.push(current.join("\n"));
      current = [];
      marks.push({ title: heading[2].trim(), unit: units.length, depth: heading[1].length - 1 });
    }
    current.push(line);
  }
  units.push(current.join("\n"));

  return { units, marks, title: "", warnings: [], unitLabel: "part" };
}

/* ------------------------------------------------------------------ */
/* What kind of file is this                                           */
/* ------------------------------------------------------------------ */

function sniff(buffer, filename) {
  // The marker is at the start, give or take the junk some tools prepend.
  if (buffer.subarray(0, 1024).includes("%PDF")) return "pdf";
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return sniffZip(buffer, filename);

  const head = buffer.subarray(0, 4096);
  // A NUL byte in the first pages is the clearest sign of a binary format, and
  // UTF-16 text is the one exception — it is full of them by design.
  if (!hasUtf16Bom(buffer) && head.includes(0)) {
    throw new IngestError(`${describe(filename)} is not a document this app can read.`);
  }
  return "text";
}

function sniffZip(buffer, filename) {
  let names = [];
  try {
    const zip = readZip(buffer);
    const mimetype = (zip.text("mimetype") || "").trim();
    if (mimetype === "application/epub+zip") return "epub";
    names = zip.names;
  } catch (err) {
    throw new IngestError(`${describe(filename)} is a damaged archive (${err.message})`, "bad_zip");
  }

  if (names.some((name) => name.toLowerCase().endsWith(".opf"))) return "epub";
  if (names.includes("word/document.xml")) {
    throw new IngestError("Word documents are not supported yet — export it as a PDF first.");
  }
  throw new IngestError(`${describe(filename)} is a ZIP archive, not a document.`);
}

const describe = (filename) => (filename ? `"${filename}"` : "That file");

function hasUtf16Bom(buffer) {
  return (
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))
  );
}

/** Bytes into characters: UTF-8 unless the file says otherwise, Latin-1 if that fails. */
function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const body = Buffer.from(buffer.subarray(2, buffer.length - ((buffer.length - 2) % 2)));
    return body.swap16().toString("utf16le");
  }

  const utf8 = buffer.toString("utf8").replace(/^﻿/, "");
  // One replacement character is a stray byte; a rash of them means the file was
  // never UTF-8 in the first place.
  const broken = (utf8.match(/�/g) || []).length;
  if (broken > 8 && broken > utf8.length / 500) return buffer.toString("latin1");
  return utf8;
}

/* ------------------------------------------------------------------ */
/* Tidying                                                             */
/* ------------------------------------------------------------------ */

/**
 * The last pass over the whole text: the two things every format arrives with —
 * words broken across a line by a hyphen, and typographic ligatures that no
 * search box will ever match.
 */
function finish(text) {
  const joined = String(text || "")
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, "$1$2")
    .replace(/[ﬁﬂﬀﬃﬄﬅﬆ]/g, (ligature) => LIGATURES[ligature] || ligature);
  return normalizeText(joined);
}

/** Cuts the text to size at a line break, so no sentence is halved. */
function cap(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", maxChars);
  return { text: text.slice(0, cut > maxChars * 0.5 ? cut : maxChars).trimEnd(), truncated: true };
}

/** Sections that survived the cut, ending where the text now ends. */
function trimSections(sections, length) {
  return sections
    .filter((section) => section.start < length)
    .map((section, index, kept) => {
      const end = index + 1 < kept.length ? kept[index + 1].start : length;
      return {
        title: section.title,
        start: section.start,
        end,
        chars: Math.max(0, end - section.start)
      };
    })
    .filter((section) => section.chars > 0);
}

module.exports = { ingestFile, IngestError, DEFAULT_MAX_CHARS };
