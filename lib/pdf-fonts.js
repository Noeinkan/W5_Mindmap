"use strict";

/**
 * What the bytes inside a PDF's text-showing operators actually say.
 *
 * A PDF string is not text: it is a run of glyph codes, and only the font that
 * was current when it was drawn knows which characters those glyphs stand for.
 * Three cases cover nearly every file:
 *
 * 1. The font carries a ToUnicode CMap — a table of code → character. Every
 *    subset-embedded font written by Word, InDesign or LaTeX has one, and it is
 *    the only thing that makes a two-byte Identity-H font readable at all.
 * 2. The font is a **simple 8-bit font** with a named encoding (WinAnsi, MacRoman)
 *    and possibly a /Differences list that moves a few glyphs around.
 * 3. Neither, in which case a byte is read as Latin-1 and counted as a doubt —
 *    `pdf-text.js` turns enough of those into a warning rather than a lie.
 */

const { PdfName, PdfStream, nameOf } = require("./pdf-lexer");

/* WinAnsi: Latin-1, with the C1 block filled in by Windows. */
const WIN_ANSI_HIGH = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡",
  0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘",
  0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜",
  0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ"
};

/* MacRoman, codes 128–255, in order. */
const MAC_ROMAN_HIGH =
  "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø" +
  "¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔuÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";

/** The glyph names a /Differences array uses that are not one character already. */
const GLYPH_NAMES = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%",
  ampersand: "&", quotesingle: "'", quoteright: "’", quoteleft: "‘", parenleft: "(",
  parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", period: ".",
  slash: "/", zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", colon: ":", semicolon: ";", less: "<",
  equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\",
  bracketright: "]", asciicircum: "^", underscore: "_", grave: "`", braceleft: "{",
  bar: "|", braceright: "}", asciitilde: "~", quotedblleft: "“", quotedblright: "”",
  quotedblbase: "„", quotesinglbase: "‚", endash: "–", emdash: "—", bullet: "•",
  ellipsis: "…", dagger: "†", daggerdbl: "‡", perthousand: "‰", guilsinglleft: "‹",
  guilsinglright: "›", guillemotleft: "«", guillemotright: "»", fi: "fi", fl: "fl",
  ff: "ff", ffi: "ffi", ffl: "ffl", degree: "°", plusminus: "±", multiply: "×",
  divide: "÷", minus: "−", fraction: "⁄", sterling: "£", euro: "€", yen: "¥",
  cent: "¢", currency: "¤", section: "§", paragraph: "¶", copyright: "©",
  registered: "®", trademark: "™", ordfeminine: "ª", ordmasculine: "º",
  exclamdown: "¡", questiondown: "¿", germandbls: "ß", ae: "æ", AE: "Æ", oe: "œ",
  OE: "Œ", oslash: "ø", Oslash: "Ø", aring: "å", Aring: "Å", eth: "ð", thorn: "þ",
  dotlessi: "ı", florin: "ƒ", brokenbar: "¦", macron: "¯", acute: "´", cedilla: "¸",
  dieresis: "¨", circumflex: "ˆ", tilde: "˜", caron: "ˇ", breve: "˘", ring: "˚",
  ogonek: "˛", hungarumlaut: "˝", dotaccent: "˙", logicalnot: "¬", mu: "µ",
  onehalf: "½", onequarter: "¼", threequarters: "¾", onesuperior: "¹",
  twosuperior: "²", threesuperior: "³", nbspace: " ", nonbreakingspace: " "
};

/* The accented letters, built rather than listed: "eacute" is "e" plus an accent
   name, and there are two hundred of them. */
const ACCENTS = {
  acute: "́", grave: "̀", circumflex: "̂", tilde: "̃",
  dieresis: "̈", ring: "̊", cedilla: "̧", caron: "̌",
  breve: "̆", macron: "̄", ogonek: "̨", hungarumlaut: "̋",
  dotaccent: "̇", slash: "̸"
};

/**
 * One decoder per font in a page's resources.
 *
 * It also measures: a PDF that draws one glyph at a time — and plenty do —
 * only reads as words if the reader can tell "the pen carried on" from "the pen
 * skipped a space", and that needs the width of what was just drawn. The widths
 * are in the font dictionary, in thousandths of the font size.
 *
 * @param {object} font The font dictionary.
 * @param {{resolve: Function, read: Function}} pdf
 * @returns {{decode(bytes: Buffer): {text: string, width: number, glyphs: number, spaces: number}, missing: number}}
 */
function createFontDecoder(font, pdf) {
  const state = { missing: 0 };
  const toUnicode = readToUnicode(font, pdf);
  const composite = isComposite(font, pdf);
  const table = composite ? null : buildSimpleEncoding(font, pdf);
  const widthOf = buildWidths(font, pdf, composite);

  // How many bytes make one code. A simple font is one byte per glyph and that
  // is not negotiable — plenty of files ship a ToUnicode map that claims a
  // two-byte codespace on an 8-bit font, and believing it reads every second
  // letter as half of the one before it.
  const widths = composite && toUnicode.widths.length ? toUnicode.widths : [composite ? 2 : 1];
  const fallbackWidth = composite ? 2 : 1;

  const lookup = (code, width) => {
    const mapped = toUnicode.map.get(code);
    if (mapped !== undefined) return mapped;
    if (!composite) {
      const character = table[code];
      if (character !== undefined) return character;
      state.missing += 1;
      // A byte with no mapping at all is still more likely to be its Latin-1 self
      // than to be nothing; dropping it silently loses words.
      return code >= 32 && code < 0x100 ? String.fromCharCode(code) : "";
    }
    // A two-byte font with no /ToUnicode: nothing on this side can guess what
    // glyph 0x0134 was, and inventing a character would poison the quotes.
    state.missing += 1;
    return width === 1 && code >= 32 ? String.fromCharCode(code) : "";
  };

  return {
    get missing() {
      return state.missing;
    },
    decode(bytes) {
      let text = "";
      let width = 0;
      let glyphs = 0;
      let spaces = 0;
      let i = 0;

      while (i < bytes.length) {
        let size = composite ? 0 : 1;
        for (const candidate of widths) {
          if (size || i + candidate > bytes.length) continue;
          // A CMap can mix code widths — one byte here, two there — and the
          // codespace is what says which is which.
          if (toUnicode.inRange(readCode(bytes, i, candidate), candidate)) size = candidate;
        }
        if (!size) size = Math.min(fallbackWidth, bytes.length - i);

        const code = readCode(bytes, i, size);
        text += lookup(code, size);
        width += widthOf(code);
        glyphs += 1;
        // Word spacing applies to the single byte 32, and only in a simple font.
        if (size === 1 && code === 32) spaces += 1;
        i += size;
      }
      // Thousandths of the font size is how a PDF states a width; the caller
      // multiplies by the size in force.
      return { text, width: width / 1000, glyphs, spaces };
    }
  };
}

function readCode(bytes, at, width) {
  let code = 0;
  for (let i = 0; i < width; i += 1) code = (code << 8) | bytes[at + i];
  return code;
}

/* ------------------------------------------------------------------ */
/* Widths                                                              */
/* ------------------------------------------------------------------ */

/**
 * Width in thousandths for one code. A simple font lists them from /FirstChar; a
 * composite one uses the /W run-length form on its descendant. Neither is always
 * there, and 500 — half an em — is the least wrong guess for a missing one.
 */
function buildWidths(font, pdf, composite) {
  const { resolve } = pdf;

  if (!composite) {
    const first = numberOr(resolve(font.FirstChar), 0);
    const widths = asArray(resolve(font.Widths)).map((w) => numberOr(resolve(w), NaN));
    const descriptor = resolve(font.FontDescriptor);
    const missing = numberOr(resolve(descriptor && descriptor.MissingWidth), 500);
    if (!widths.length) return () => missing;
    return (code) => {
      const width = widths[code - first];
      return Number.isFinite(width) && width > 0 ? width : missing;
    };
  }

  const descendant = resolve(asArray(resolve(font.DescendantFonts))[0]);
  const fallback = numberOr(resolve(descendant && descendant.DW), 1000);
  const table = new Map();
  const runs = asArray(resolve(descendant && descendant.W));

  let i = 0;
  while (i < runs.length) {
    const start = numberOr(resolve(runs[i]), null);
    const second = resolve(runs[i + 1]);
    if (start === null) break;

    if (Array.isArray(second)) {
      // "c [w1 w2 …]": consecutive codes from c.
      second.forEach((width, offset) => table.set(start + offset, numberOr(resolve(width), fallback)));
      i += 2;
      continue;
    }
    // "cFirst cLast w": one width for the whole range.
    const end = numberOr(second, start);
    const width = numberOr(resolve(runs[i + 2]), fallback);
    for (let code = start; code <= end && code - start < 65536; code += 1) table.set(code, width);
    i += 3;
  }
  return (code) => (table.has(code) ? table.get(code) : fallback);
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isComposite(font, { resolve }) {
  if (nameOf(resolve(font.Subtype)) === "Type0") return true;
  const encoding = nameOf(resolve(font.Encoding)) || "";
  return encoding.includes("Identity") || encoding.endsWith("-H") || encoding.endsWith("-V");
}

/* ------------------------------------------------------------------ */
/* /ToUnicode                                                          */
/* ------------------------------------------------------------------ */

function readToUnicode(font, pdf) {
  const empty = { map: new Map(), widths: [], inRange: () => false };
  const stream = pdf.resolve(font.ToUnicode);
  if (!(stream instanceof PdfStream)) return empty;

  const data = pdf.read(font.ToUnicode);
  if (!data || !data.length) return empty;
  return parseCMap(data.toString("latin1"));
}

/**
 * A CMap is PostScript, but the three constructs that carry the mapping are
 * regular enough to read directly: the code widths, the single codes, and the
 * ranges.
 */
function parseCMap(text) {
  const map = new Map();
  const ranges = [];

  for (const block of blocks(text, "codespacerange")) {
    const hex = block.match(/<([0-9a-fA-F]+)>/g) || [];
    for (let i = 0; i + 1 < hex.length; i += 2) {
      const low = hex[i].slice(1, -1);
      const high = hex[i + 1].slice(1, -1);
      ranges.push({ bytes: Math.ceil(low.length / 2), low: parseInt(low, 16), high: parseInt(high, 16) });
    }
  }

  for (const block of blocks(text, "bfchar")) {
    const pairs = block.match(/<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\/[^\s/<>]+)/g) || [];
    for (const pair of pairs) {
      const [, code, target] = /<([0-9a-fA-F]+)>\s*(.+)/.exec(pair) || [];
      if (code === undefined) continue;
      map.set(parseInt(code, 16), hexToText(target));
    }
  }

  for (const block of blocks(text, "bfrange")) {
    const entries =
      block.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]*>|\/[^\s/<>]+)/g) || [];
    for (const entry of entries) {
      const parts = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*([\s\S]+)/.exec(entry);
      if (!parts) continue;
      const from = parseInt(parts[1], 16);
      const to = parseInt(parts[2], 16);
      const target = parts[3].trim();
      // A guard against a broken range asking for a million entries.
      const count = Math.min(to - from, 0xffff);

      if (target.startsWith("[")) {
        const items = target.match(/<[0-9a-fA-F]*>/g) || [];
        items.forEach((item, index) => map.set(from + index, hexToText(item)));
        continue;
      }
      const base = hexToText(target);
      for (let i = 0; i <= count; i += 1) {
        map.set(from + i, i === 0 ? base : shiftLastUnit(base, i));
      }
    }
  }

  const widths = [...new Set(ranges.map((range) => range.bytes))].sort((a, b) => a - b);
  const inRange = (code, bytes) =>
    ranges.some((range) => range.bytes === bytes && code >= range.low && code <= range.high);

  return { map, widths, inRange };
}

/** The bodies of every `begin<name> … end<name>` block in a CMap. */
function blocks(text, name) {
  const pattern = new RegExp(`begin${name}([\\s\\S]*?)end${name}`, "g");
  const found = [];
  let match;
  while ((match = pattern.exec(text)) !== null) found.push(match[1]);
  return found;
}

/** A CMap's target: hex UTF-16BE, or a glyph name. */
function hexToText(token) {
  const value = String(token || "").trim();
  if (value.startsWith("/")) return glyphToText(value.slice(1));

  const hex = value.replace(/[<>]/g, "");
  if (!hex) return "";
  let out = "";
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const unit = parseInt(hex.slice(i, i + 4).padEnd(4, "0"), 16);
    if (Number.isFinite(unit)) out += String.fromCharCode(unit);
  }
  // Surrogate pairs arrive as two units and String.fromCharCode already pairs
  // them; a lone unmapped 0 is noise from a padded entry.
  return out.replace(/\u0000/g, "");
}

/** The next character along, which is what a bfrange means by a single target. */
function shiftLastUnit(base, step) {
  if (!base) return base;
  const head = base.slice(0, -1);
  return head + String.fromCharCode(base.charCodeAt(base.length - 1) + step);
}

/* ------------------------------------------------------------------ */
/* Simple 8-bit encodings                                              */
/* ------------------------------------------------------------------ */

function buildSimpleEncoding(font, { resolve }) {
  const encoding = resolve(font.Encoding);
  const baseName = nameOf(encoding) || nameOf(resolve(encoding?.BaseEncoding)) || "WinAnsiEncoding";
  const table = baseTable(baseName);

  const differences = resolve(encoding?.Differences);
  if (Array.isArray(differences)) {
    let code = 0;
    for (const item of differences) {
      const value = resolve(item);
      if (typeof value === "number") {
        code = value;
      } else if (value instanceof PdfName) {
        table[code] = glyphToText(value.name);
        code += 1;
      }
    }
  }
  return table;
}

function baseTable(name) {
  const table = [];
  for (let code = 32; code < 127; code += 1) table[code] = String.fromCharCode(code);

  if (name === "MacRomanEncoding") {
    for (let i = 0; i < MAC_ROMAN_HIGH.length; i += 1) table[128 + i] = MAC_ROMAN_HIGH[i];
    return table;
  }

  // WinAnsi, and StandardEncoding read as WinAnsi: they agree on everything a
  // reader is likely to meet outside the accents, and a wrong quote mark beats a
  // missing sentence.
  for (let code = 0xa0; code < 0x100; code += 1) table[code] = String.fromCharCode(code);
  for (const [code, character] of Object.entries(WIN_ANSI_HIGH)) table[Number(code)] = character;
  return table;
}

/** A glyph name into the character it draws. */
function glyphToText(name) {
  if (!name) return "";
  if (GLYPH_NAMES[name]) return GLYPH_NAMES[name];
  if (name.length === 1) return name;

  // uni0041, u1F600: the name is the code point.
  const uni = /^uni([0-9a-fA-F]{4,6})$/.exec(name) || /^u([0-9a-fA-F]{4,6})$/.exec(name);
  if (uni) {
    const code = parseInt(uni[1], 16);
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
  }

  // "eacute", "Adieresis": a letter and the accent to put on it. Composed, so the
  // result is one character and searching for it works.
  const accented = /^([A-Za-z])([a-z]+)$/.exec(name);
  if (accented && ACCENTS[accented[2]]) {
    return (accented[1] + ACCENTS[accented[2]]).normalize("NFC");
  }

  // A subset font's own numbering (g12, cid7, index40) means nothing without the
  // font programme itself.
  return "";
}

module.exports = { createFontDecoder, parseCMap, glyphToText };
