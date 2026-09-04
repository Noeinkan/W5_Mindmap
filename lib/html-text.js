"use strict";

/**
 * The XHTML of an EPUB chapter, read as prose.
 *
 * A chapter is machine-written markup — no scripts to run, no layout to resolve —
 * so what a reader needs from it is the text between the tags with the block
 * boundaries kept as line breaks. Tags become newlines rather than nothing,
 * because `<p>one</p><p>two</p>` read as "onetwo" is how a book turns into one
 * unreadable paragraph, and the chunker downstream cuts on lines.
 */

// Everything that ends a line when it opens or closes. Inline tags (em, strong,
// a, span) are left out on purpose: they sit inside a sentence.
const BLOCK_TAGS =
  /<\/?(?:p|div|section|article|aside|main|header|footer|nav|h[1-6]|li|ul|ol|dl|dt|dd|table|thead|tbody|tr|td|th|blockquote|pre|figure|figcaption|hr|form|fieldset)\b[^>]*>/gi;

const ENTITIES = new Map(
  Object.entries({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ensp: " ",
    emsp: " ",
    thinsp: " ",
    shy: "",
    ndash: "–",
    mdash: "—",
    lsquo: "‘",
    rsquo: "’",
    sbquo: "‚",
    ldquo: "“",
    rdquo: "”",
    bdquo: "„",
    hellip: "…",
    bull: "•",
    middot: "·",
    laquo: "«",
    raquo: "»",
    lsaquo: "‹",
    rsaquo: "›",
    deg: "°",
    plusmn: "±",
    times: "×",
    divide: "÷",
    micro: "µ",
    para: "¶",
    sect: "§",
    copy: "©",
    reg: "®",
    trade: "™",
    euro: "€",
    pound: "£",
    yen: "¥",
    cent: "¢",
    dagger: "†",
    permil: "‰",
    prime: "′",
    larr: "←",
    rarr: "→",
    harr: "↔",
    frac12: "½",
    frac14: "¼",
    frac34: "¾"
  })
);

/**
 * @param {string} html One (X)HTML document.
 * @returns {string} Its text, one block per line.
 */
function htmlToText(html) {
  let text = String(html || "");

  // Only the body: an EPUB chapter's <head> holds a <title> that would otherwise
  // be read as the first line of every chapter.
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(text);
  if (body) text = body[1];

  text = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<(script|style|head|svg|math|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]*>/g, "");

  return normalizeText(decodeEntities(text));
}

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Anything outside Unicode is a broken entity, not something to render.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      return code === 0xa0 ? " " : String.fromCodePoint(code);
    }
    const named = ENTITIES.get(body);
    if (named !== undefined) return named;
    // A capitalised name we know in lowercase: &Eacute; and friends.
    const lower = ENTITIES.get(body.toLowerCase());
    return lower !== undefined ? lower.toUpperCase() : whole;
  });
}

/**
 * The whitespace rules the whole ingest side agrees on: one space between words,
 * no trailing space on a line, at most one blank line between blocks. Exported
 * because the PDF reader wants exactly the same tidying at the end.
 */
function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    // Every space a typesetter uses — non-breaking, en, em, thin — read as one
    // plain space, so the chunker counts characters the way a reader would.
    .replace(/[\t   -   　]/g, " ")
    // Zero-width characters survive the trip out of a PDF or an EPUB and count
    // against the chunk size while showing nothing at all.
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/ {2,}/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { htmlToText, normalizeText };
