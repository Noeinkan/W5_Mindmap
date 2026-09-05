"use strict";

/**
 * A PDF, read as pages of text.
 *
 * The bytes of a page say where each run of glyphs is drawn, not where a line
 * ends — a PDF has no paragraphs, only coordinates. So the reader watches the
 * text matrix: a jump down the page is a line break, a bigger jump is a blank
 * line, and a gap along the same line is a space. That is the whole trick, and it
 * is why the output of a two-column paper reads worse than the output of a
 * report: the coordinates are honest, the columns are not.
 *
 * What comes back is one string per page plus the outline, which `ingest.js`
 * turns into sections. Nothing here knows about mind maps.
 */

const {
  Lexer,
  PdfKeyword,
  PdfRef,
  PdfStream,
  parsePdfObjects,
  decodePdfString,
  isDict,
  nameOf,
  toArray,
  END_OF_INPUT
} = require("./pdf-lexer");
const { createFontDecoder } = require("./pdf-fonts");
const { readOutline } = require("./pdf-outline");
const { normalizeText } = require("./html-text");

const DEFAULT_MAX_PAGES = 2000;
// Forms can nest, and a file that points a form at itself would otherwise spin.
const MAX_FORM_DEPTH = 6;
const IDENTITY = [1, 0, 0, 1, 0, 0];

class PdfError extends Error {
  constructor(message, code = "bad_pdf") {
    super(message);
    this.name = "PdfError";
    this.code = code;
  }
}

/**
 * @param {Buffer} buffer
 * @param {{maxPages?: number}} [options]
 * @returns {{pages: string[], outline: Array<{title:string,page:number,depth:number}>, title: string, warnings: string[]}}
 */
function pdfToPages(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 1024).includes("%PDF")) {
    throw new PdfError("That file does not start like a PDF.");
  }

  const pdf = parsePdfObjects(buffer);
  const warnings = [...pdf.warnings];

  if (pdf.trailer.Encrypt !== undefined) {
    throw new PdfError(
      "This PDF is encrypted — its text cannot be read without the password.",
      "encrypted_pdf"
    );
  }

  const pages = collectPages(pdf);
  if (!pages.length) throw new PdfError("No pages were found in this PDF.");

  const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
  const kept = pages.slice(0, maxPages);
  if (pages.length > kept.length) {
    warnings.push(`Only the first ${kept.length} of ${pages.length} pages were read.`);
  }

  const fontCache = new Map();
  const doubts = { missing: 0, characters: 0 };
  const texts = kept.map((page) => {
    try {
      return renderPage(page, pdf, fontCache, doubts);
    } catch (err) {
      warnings.push(`A page could not be read (${err.message}).`);
      return "";
    }
  });

  // A subset font with no ToUnicode table gives codes nobody can map. A few are
  // one bullet glyph; a third of the file is a document that came out as noise.
  if (doubts.missing > 40 && doubts.missing > doubts.characters * 0.15) {
    warnings.push(
      "Some of the fonts in this PDF carry no character map, so part of the text could not be read."
    );
  }

  const pageNumberOf = new Map(kept.map((page, index) => [page.number, index]));

  return {
    pages: texts,
    outline: readOutline(pdf, pageNumberOf, warnings),
    title: documentTitle(pdf),
    warnings
  };
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

/**
 * The pages in reading order, by walking the page tree. /Resources is inherited
 * from a parent node, which is where half the real files keep their fonts.
 */
function collectPages(pdf) {
  const { objects, trailer, resolve } = pdf;
  const root = resolve(trailer.Root);
  const pages = [];
  const seen = new Set();

  const walk = (ref, inherited, depth) => {
    if (depth > 64) return;
    const number = ref instanceof PdfRef ? ref.num : null;
    if (number !== null) {
      if (seen.has(number)) return;
      seen.add(number);
    }
    const node = resolve(ref);
    if (!isDict(node)) return;

    const resources = node.Resources !== undefined ? node.Resources : inherited;
    const kids = resolve(node.Kids);

    if (nameOf(resolve(node.Type)) === "Pages" || Array.isArray(kids)) {
      for (const kid of toArray(kids)) walk(kid, resources, depth + 1);
      return;
    }
    pages.push({ number, dict: node, resources: resolve(resources) });
  };

  walk(root ? root.Pages : null, null, 0);

  // No usable page tree — a damaged file, or one whose catalogue never made it.
  // Every page object is still in there somewhere, in the order they were written.
  if (!pages.length) {
    for (const [number, value] of [...objects].sort((a, b) => a[0] - b[0])) {
      if (isDict(value) && nameOf(resolve(value.Type)) === "Page") {
        pages.push({ number, dict: value, resources: resolve(value.Resources) });
      }
    }
  }
  return pages;
}

function documentTitle(pdf) {
  const info = pdf.resolve(pdf.trailer.Info);
  const title = info ? decodePdfString(pdf.resolve(info.Title)) : "";
  return title.trim();
}

/* ------------------------------------------------------------------ */
/* One page                                                            */
/* ------------------------------------------------------------------ */

function renderPage(page, pdf, fontCache, doubts) {
  const content = pageContent(page.dict, pdf);
  if (!content || !content.length) return "";

  const builder = new TextBuilder();
  runContent(content, page.resources, pdf, {
    builder,
    fontCache,
    doubts,
    depth: 0,
    seen: new Set(),
    ctm: IDENTITY.slice()
  });
  return normalizeText(builder.toString());
}

/** /Contents is one stream or several that continue each other. */
function pageContent(pageDict, pdf) {
  const parts = toArray(pdf.resolve(pageDict.Contents))
    .map((part) => pdf.read(part))
    .filter((part) => part && part.length);
  if (!parts.length) return null;
  // A newline between them: the split can fall in the middle of an operator.
  return Buffer.concat(parts.flatMap((part) => [part, Buffer.from("\n")]));
}

/**
 * Walks a content stream, keeping just enough of the text state to know where
 * each run of glyphs lands.
 */
function runContent(data, resources, pdf, ctx) {
  const lexer = new Lexer(data);
  const fonts = fontsFor(resources, pdf, ctx.fontCache);
  const { builder } = ctx;

  let operands = [];
  let font = null;
  let fontSize = 12;
  let leading = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontalScale = 1;
  let tm = IDENTITY.slice();
  let tlm = IDENTITY.slice();

  // The graphics matrix. Ignoring it is how a document that positions each
  // paragraph with `cm` and leaves the text matrix alone comes out as one long
  // line: every block claims to be at the same place, because the place is in
  // the matrix nobody looked at.
  let ctm = ctx.ctm ? ctx.ctm.slice() : IDENTITY.slice();
  const stack = [];

  const show = (bytes) => {
    if (!Buffer.isBuffer(bytes)) return;
    // Text space through the text matrix and then the graphics matrix is where
    // the glyphs actually land on the page.
    const placed = multiply(tm, ctm);
    const size = fontSize * (Math.hypot(placed[2], placed[3]) || 1);
    const run = font
      ? font.decode(bytes)
      : { text: bytes.toString("latin1"), width: bytes.length * 0.5, glyphs: bytes.length, spaces: 0 };
    ctx.doubts.characters += run.text.length;

    const step =
      (run.width * fontSize + run.glyphs * charSpacing + run.spaces * wordSpacing) * horizontalScale;
    builder.draw(run.text, placed[4], placed[5], size, step * (Math.hypot(placed[0], placed[1]) || 1));
    // Showing text moves the pen along the line, which is a translation of the
    // text matrix — the same thing the next run will be measured against.
    tm = multiply([1, 0, 0, 1, step, 0], tm);
  };
  const lineMove = (tx, ty) => {
    tlm = translate(tlm, tx, ty);
    tm = tlm.slice();
  };
  const setMatrix = (matrix) => {
    tm = matrix;
    tlm = matrix.slice();
  };

  while (true) {
    const token = lexer.next();
    if (token === END_OF_INPUT) break;

    if (!(token instanceof PdfKeyword)) {
      operands.push(token);
      // An operator takes at most six; anything longer is a malformed run and
      // holding on to it would only grow.
      if (operands.length > 8) operands.shift();
      continue;
    }

    const args = operands;
    operands = [];
    const last = args[args.length - 1];

    switch (token.word) {
      case "BT":
        setMatrix(IDENTITY.slice());
        break;
      case "Tf":
        font = fonts.get(nameOf(args[args.length - 2])) || null;
        fontSize = typeof last === "number" ? last : fontSize;
        break;
      case "TL":
        if (typeof last === "number") leading = last;
        break;
      case "Tc":
        if (typeof last === "number") charSpacing = last;
        break;
      case "Tw":
        if (typeof last === "number") wordSpacing = last;
        break;
      case "Tz":
        if (typeof last === "number" && last > 0) horizontalScale = last / 100;
        break;
      case "Td":
        lineMove(number(args[0]), number(args[1]));
        break;
      case "TD":
        leading = -number(args[1]);
        lineMove(number(args[0]), number(args[1]));
        break;
      case "Tm":
        if (args.length >= 6 && args.slice(-6).every((v) => typeof v === "number")) {
          setMatrix(args.slice(-6));
        }
        break;
      case "T*":
        lineMove(0, -leading);
        break;
      case "Tj":
        show(last);
        break;
      case "'":
        lineMove(0, -leading);
        show(last);
        break;
      case '"':
        // Word and character spacing come with this one, ahead of the string.
        if (typeof args[args.length - 3] === "number") wordSpacing = args[args.length - 3];
        if (typeof args[args.length - 2] === "number") charSpacing = args[args.length - 2];
        lineMove(0, -leading);
        show(last);
        break;
      case "TJ":
        for (const item of toArray(last)) {
          if (Buffer.isBuffer(item)) show(item);
          // A number between two runs moves the pen along — thousandths of the
          // size, positive meaning "back". Whether the gap it leaves is wide
          // enough to read as a space is the builder's call, not this one's.
          else if (typeof item === "number") {
            tm = multiply([1, 0, 0, 1, (-item / 1000) * fontSize * horizontalScale, 0], tm);
          }
        }
        break;
      case "q":
        stack.push(ctm.slice());
        break;
      case "Q":
        if (stack.length) ctm = stack.pop();
        break;
      case "cm":
        if (args.length >= 6 && args.slice(-6).every((v) => typeof v === "number")) {
          ctm = multiply(args.slice(-6), ctm);
        }
        break;
      case "Do":
        drawXObject(nameOf(last), resources, pdf, { ...ctx, ctm });
        break;
      case "BI":
        // An inline image: raw bytes follow ID, and they are not PDF syntax.
        lexer.pos = skipInlineImage(lexer.src, lexer.pos);
        break;
      default:
        break;
    }
  }
}

function drawXObject(name, resources, pdf, ctx) {
  if (!name || ctx.depth >= MAX_FORM_DEPTH) return;
  const xobjects = pdf.resolve(resources?.XObject);
  if (!isDict(xobjects)) return;

  const ref = xobjects[name];
  const stream = pdf.resolve(ref);
  if (!(stream instanceof PdfStream) || nameOf(pdf.resolve(stream.dict.Subtype)) !== "Form") return;

  const key = ref instanceof PdfRef ? ref.num : name;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);

  const data = pdf.read(ref);
  if (data && data.length) {
    // A form carries its own matrix, applied on top of the one in force where it
    // was drawn — that is what puts its text in the right place on the page.
    const matrix = pdf.resolve(stream.dict.Matrix);
    const inner =
      Array.isArray(matrix) && matrix.length === 6 && matrix.every((v) => typeof v === "number")
        ? multiply(matrix, ctx.ctm)
        : ctx.ctm;

    runContent(data, pdf.resolve(stream.dict.Resources) || resources, pdf, {
      ...ctx,
      ctm: inner,
      depth: ctx.depth + 1
    });
  }
  ctx.seen.delete(key);
}

/** Past the binary body of an inline image, which no lexer can read as syntax. */
function skipInlineImage(src, pos) {
  const id = src.indexOf("ID", pos);
  if (id === -1) return src.length;
  // "EI" has to stand alone: the same two letters turn up inside compressed data.
  const end = /\sEI(?=[\s\]/<(]|$)/.exec(src.slice(id));
  return end ? id + end.index + end[0].length : src.length;
}

function fontsFor(resources, pdf, cache) {
  const dict = pdf.resolve(resources?.Font);
  if (!isDict(dict)) return new Map();
  if (cache.has(dict)) return cache.get(dict);

  const fonts = new Map();
  for (const [name, ref] of Object.entries(dict)) {
    const font = pdf.resolve(ref);
    if (isDict(font)) fonts.set(name, createFontDecoder(font, pdf));
  }
  cache.set(dict, fonts);
  return fonts;
}

function translate(matrix, tx, ty) {
  return [
    matrix[0],
    matrix[1],
    matrix[2],
    matrix[3],
    matrix[0] * tx + matrix[2] * ty + matrix[4],
    matrix[1] * tx + matrix[3] * ty + matrix[5]
  ];
}

/** `a` applied first, then `b` — the order every matrix in a PDF is written in. */
function multiply(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5]
  ];
}

const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/* ------------------------------------------------------------------ */
/* Coordinates into lines                                              */
/* ------------------------------------------------------------------ */

/**
 * Where the line breaks go. Every run of glyphs arrives with the point it starts
 * at and the distance it covers, and the rules are the ones an eye uses: a step
 * down the page ends the line, a bigger step ends the paragraph, and a hole
 * between the end of one run and the start of the next is a space.
 */
class TextBuilder {
  constructor() {
    this.parts = [];
    this.end = null;
    this.y = null;
  }

  draw(text, x, y, size, advance = 0) {
    const step = size > 0 ? size : 12;
    if (!text) {
      // A run of unmapped glyphs draws nothing but still moves the pen.
      if (this.end !== null) this.end = Math.max(this.end, x + advance);
      return;
    }

    if (this.y !== null) {
      const down = Math.abs(y - this.y);
      // Half a line down is a new line; nearly two lines is a new paragraph.
      // Anything smaller is a superscript or a baseline nudge, not a break.
      if (down > step * 1.8) this.parts.push("\n\n");
      else if (down > Math.max(1, step * 0.5)) this.parts.push("\n");
      // Same line, and the pen skipped a gap on the way: that is a space the
      // file never wrote down. An eighth of an em is the line — measured gaps
      // inside a word stay under 0.01, and the tightest real space seen in a
      // document was 0.175.
      else if (x - this.end > step * 0.12) this.gap();
    }

    this.parts.push(text);
    this.y = y;
    this.end = x + advance;
  }

  /** A space, unless one is already there. */
  gap() {
    const last = this.parts[this.parts.length - 1];
    if (!last || /[\s]$/.test(last)) return;
    this.parts.push(" ");
  }

  breakLine() {
    this.parts.push("\n");
    this.end = null;
    this.y = null;
  }

  toString() {
    return this.parts.join("");
  }
}

module.exports = { pdfToPages, PdfError };
