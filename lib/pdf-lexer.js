"use strict";

/**
 * The objects of a PDF, out of its bytes.
 *
 * A PDF is a heap of numbered objects with a table at the end saying where each
 * one starts. This reader ignores that table on purpose and scans for the objects
 * themselves — `12 0 obj … endobj` — because the table is the first thing to go
 * wrong in a file that has been edited, appended to, or produced by a generator
 * in a hurry, and a wrong table means "no text" rather than "slightly off". The
 * scan costs one pass over the file and survives all three.
 *
 * The objects a modern PDF hides inside compressed object streams are unpacked
 * afterwards, which is the one thing a scan alone cannot see.
 *
 * Text is not decoded here: what comes back is the object graph. `pdf-text.js`
 * walks it, and `pdf-fonts.js` says what the bytes in a string mean.
 */

const { decodeStream, nameOf, toArray } = require("./pdf-filters");

class PdfName {
  constructor(name) {
    this.name = name;
  }
}

class PdfRef {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}

class PdfStream {
  constructor(dict, raw) {
    this.dict = dict;
    this.raw = raw;
  }
}

/** A bare word in the byte soup: `obj`, `stream`, or a content-stream operator. */
class PdfKeyword {
  constructor(word) {
    this.word = word;
  }
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));
const END_OF_ARRAY = Symbol("]");
const END_OF_DICT = Symbol(">>");
const END_OF_INPUT = Symbol("eof");

const isSpace = (code) => WHITESPACE.has(code);
// Number.isFinite is doing real work here: charCodeAt past the end of the string
// answers NaN, and a NaN that counts as a regular character is a loop that reads
// past the end of the file for ever.
const isRegular = (code) => Number.isFinite(code) && !WHITESPACE.has(code) && !DELIMITERS.has(code);

/**
 * A reader over one stretch of PDF syntax — the body of the file, or a decoded
 * content stream. It works on a latin1 view of the bytes, where one character is
 * one byte, so an index into the string is also an index into the buffer.
 */
class Lexer {
  constructor(buffer, pos = 0) {
    this.buf = buffer;
    this.src = buffer.toString("latin1");
    this.pos = pos;
  }

  skipSpace() {
    while (this.pos < this.src.length) {
      const code = this.src.charCodeAt(this.pos);
      if (isSpace(code)) {
        this.pos += 1;
      } else if (code === 0x25) {
        // "%" comments out the rest of the line.
        while (this.pos < this.src.length && !"\r\n".includes(this.src[this.pos])) this.pos += 1;
      } else {
        return;
      }
    }
  }

  /** The next value, or one of the END_OF_* sentinels. */
  next(depth = 0) {
    this.skipSpace();
    if (this.pos >= this.src.length) return END_OF_INPUT;

    const char = this.src[this.pos];

    if (char === "/") return this.readName();
    if (char === "(") return this.readLiteralString();
    if (char === "[") return this.readArray(depth);
    if (char === "]") {
      this.pos += 1;
      return END_OF_ARRAY;
    }
    if (char === "<") {
      if (this.src[this.pos + 1] === "<") return this.readDict(depth);
      return this.readHexString();
    }
    if (char === ">") {
      this.pos += this.src[this.pos + 1] === ">" ? 2 : 1;
      return END_OF_DICT;
    }
    if (char === "{" || char === "}" || char === ")") {
      this.pos += 1;
      return this.next(depth);
    }
    if (/[+\-.\d]/.test(char)) return this.readNumberOrRef();
    return this.readKeyword();
  }

  readName() {
    this.pos += 1;
    const start = this.pos;
    while (isRegular(this.src.charCodeAt(this.pos))) this.pos += 1;
    const raw = this.src.slice(start, this.pos);
    // "#" escapes a byte in a name: /Adobe#20Green is "Adobe Green".
    return new PdfName(raw.replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
  }

  /** A string is bytes, not text — what they mean is the font's business. */
  readLiteralString() {
    this.pos += 1;
    const out = [];
    let depth = 1;

    while (this.pos < this.src.length) {
      const char = this.src[this.pos++];
      if (char === "\\") {
        const escape = this.src[this.pos++];
        const simple = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 }[escape];
        if (simple !== undefined) {
          out.push(simple);
        } else if (escape >= "0" && escape <= "7") {
          let octal = escape;
          while (octal.length < 3 && this.src[this.pos] >= "0" && this.src[this.pos] <= "7") {
            octal += this.src[this.pos++];
          }
          out.push(parseInt(octal, 8) & 0xff);
        } else if (escape === "\n") {
          /* A backslash at the end of a line continues the string. */
        } else if (escape === "\r") {
          if (this.src[this.pos] === "\n") this.pos += 1;
        } else if (escape !== undefined) {
          out.push(escape.charCodeAt(0));
        }
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      out.push(char.charCodeAt(0));
    }
    return Buffer.from(out);
  }

  readHexString() {
    this.pos += 1;
    const start = this.pos;
    while (this.pos < this.src.length && this.src[this.pos] !== ">") this.pos += 1;
    const digits = this.src.slice(start, this.pos).replace(/[^0-9a-fA-F]/g, "");
    this.pos += 1;
    return Buffer.from(digits.length % 2 ? `${digits}0` : digits, "hex");
  }

  readArray(depth) {
    this.pos += 1;
    const out = [];
    if (depth > 40) return out;

    while (true) {
      const value = this.next(depth + 1);
      if (value === END_OF_ARRAY || value === END_OF_INPUT) break;
      if (value === END_OF_DICT) continue;
      out.push(value);
    }
    return out;
  }

  readDict(depth) {
    this.pos += 2;
    const dict = Object.create(null);
    if (depth > 40) return dict;

    while (true) {
      const key = this.next(depth + 1);
      if (key === END_OF_DICT || key === END_OF_INPUT) break;
      if (!(key instanceof PdfName)) continue;
      const value = this.next(depth + 1);
      if (value === END_OF_DICT || value === END_OF_INPUT) break;
      if (value === END_OF_ARRAY) continue;
      dict[key.name] = value;
    }
    return dict;
  }

  /** A number, unless two integers and an "R" turn out to be a reference. */
  readNumberOrRef() {
    const start = this.pos;
    while (/[+\-.\deE]/.test(this.src[this.pos] || "")) this.pos += 1;
    const text = this.src.slice(start, this.pos);
    const value = Number(text);
    const number = Number.isFinite(value) ? value : 0;

    if (Number.isInteger(number) && number >= 0) {
      const ref = /^\s+(\d+)\s+R(?![A-Za-z0-9])/.exec(this.src.slice(this.pos, this.pos + 24));
      if (ref) {
        this.pos += ref[0].length;
        return new PdfRef(number, Number(ref[1]));
      }
    }
    return number;
  }

  readKeyword() {
    const start = this.pos;
    while (isRegular(this.src.charCodeAt(this.pos))) this.pos += 1;
    // A delimiter where a keyword was expected would loop forever otherwise.
    if (this.pos === start) this.pos += 1;
    const word = this.src.slice(start, this.pos);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return new PdfKeyword(word);
  }
}

/**
 * Every object in the file, by number.
 *
 * @param {Buffer} buffer
 * @returns {{objects: Map<number, any>, trailer: object, resolve: Function, read: Function, warnings: string[]}}
 */
function parsePdfObjects(buffer) {
  const lexer = new Lexer(buffer);
  const src = lexer.src;
  const objects = new Map();
  const streams = [];
  const warnings = [];

  const OBJECT = /(?<![0-9])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let match;
  while ((match = OBJECT.exec(src)) !== null) {
    const number = Number(match[1]);
    lexer.pos = match.index + match[0].length;
    const value = lexer.next();
    lexer.skipSpace();

    if (isDict(value) && src.startsWith("stream", lexer.pos)) {
      let start = lexer.pos + "stream".length;
      if (src[start] === "\r") start += 1;
      if (src[start] === "\n") start += 1;
      // The end is worked out in the second pass, because /Length is often a
      // reference to an object further down the file.
      streams.push({ number, dict: value, start });
      objects.set(number, null);
      // Binary stream data can hold anything, "5 0 obj" included. Resuming the
      // scan after the stream keeps those out of the object map.
      const endstream = src.indexOf("endstream", start);
      OBJECT.lastIndex = endstream === -1 ? src.length : endstream;
    } else if (value !== END_OF_INPUT) {
      objects.set(number, value);
    }
  }

  const resolve = (value) => {
    let current = value;
    // A reference to a reference is legal and rare; the guard is against a cycle.
    for (let hops = 0; current instanceof PdfRef && hops < 8; hops += 1) {
      current = objects.has(current.num) ? objects.get(current.num) : null;
    }
    return current instanceof PdfRef ? null : current;
  };

  for (const { number, dict, start } of streams) {
    objects.set(number, new PdfStream(dict, buffer.subarray(start, streamEnd(src, buffer, dict, start, resolve))));
  }

  const read = (value) => {
    const stream = resolve(value);
    if (!(stream instanceof PdfStream)) return null;
    try {
      return decodeStream(stream.dict, stream.raw, resolve);
    } catch (err) {
      warnings.push(`A compressed part of the file could not be read (${err.message}).`);
      return null;
    }
  };

  expandObjectStreams(objects, read, warnings);

  return { objects, trailer: readTrailer(src, objects, resolve), resolve, read, warnings };
}

/**
 * Where a stream's bytes stop: what /Length says, when the file agrees with
 * itself, and the next "endstream" when it does not.
 */
function streamEnd(src, buffer, dict, start, resolve) {
  const length = resolve(dict.Length);
  if (typeof length === "number" && length >= 0 && start + length <= buffer.length) {
    const after = src.slice(start + length, start + length + 20).trimStart();
    if (after.startsWith("endstream")) return start + length;
  }

  const marker = src.indexOf("endstream", start);
  if (marker === -1) return buffer.length;
  // The EOL before "endstream" belongs to the file, not to the stream.
  let end = marker;
  if (src[end - 1] === "\n") end -= 1;
  if (src[end - 1] === "\r") end -= 1;
  return Math.max(start, end);
}

/**
 * Objects packed inside an /ObjStm — which in a PDF written this decade is most
 * of them, the page tree included.
 */
function expandObjectStreams(objects, read, warnings) {
  for (const value of [...objects.values()]) {
    if (!(value instanceof PdfStream) || nameOf(value.dict.Type) !== "ObjStm") continue;

    const data = read(value);
    if (!data) continue;

    const count = Number(value.dict.N) || 0;
    const first = Number(value.dict.First) || 0;
    const inner = new Lexer(data);
    const header = inner.src.slice(0, first).trim().split(/\s+/).map(Number);

    for (let i = 0; i < count; i += 1) {
      const number = header[i * 2];
      const offset = header[i * 2 + 1];
      if (!Number.isFinite(number) || !Number.isFinite(offset)) break;
      // An object found loose in the file was written later than this stream in
      // every case that matters (an incremental update), so it wins.
      if (objects.has(number) && objects.get(number) !== null) continue;
      inner.pos = first + offset;
      const parsed = inner.next();
      if (parsed !== END_OF_INPUT) objects.set(number, parsed);
    }
  }
  if (!objects.size) warnings.push("No objects were found in this PDF.");
}

/**
 * The trailer dictionary — where /Root and /Encrypt live. A file can have several
 * (one per incremental save) and a modern one has none at all, keeping the same
 * keys in a cross-reference stream instead. Both are read, last one first.
 */
function readTrailer(src, objects, resolve) {
  const merged = Object.create(null);

  const trailers = [];
  let index = src.lastIndexOf("trailer");
  while (index !== -1 && trailers.length < 12) {
    const lexer = new Lexer(Buffer.from(src.slice(index + 7, index + 4096), "latin1"));
    const dict = lexer.next();
    if (isDict(dict)) trailers.push(dict);
    index = src.lastIndexOf("trailer", index - 1);
  }

  for (const value of objects.values()) {
    if (value instanceof PdfStream && nameOf(value.dict.Type) === "XRef") trailers.push(value.dict);
  }

  for (const dict of trailers) {
    for (const key of ["Root", "Info", "Encrypt", "ID"]) {
      if (merged[key] === undefined && dict[key] !== undefined) merged[key] = dict[key];
    }
  }

  // Still no catalogue: find it the way the objects were found, by looking.
  if (merged.Root === undefined || !isDict(resolve(merged.Root))) {
    for (const [number, value] of objects) {
      if (isDict(value) && nameOf(value.Type) === "Catalog") {
        merged.Root = new PdfRef(number, 0);
        break;
      }
    }
  }
  return merged;
}

function isDict(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof PdfName) && !(value instanceof PdfRef) && !(value instanceof PdfKeyword) && !(value instanceof PdfStream);
}

/** A PDF text string: UTF-16BE when it carries the marker, PDFDocEncoding otherwise. */
function decodePdfString(value) {
  if (!Buffer.isBuffer(value)) return typeof value === "string" ? value : "";
  if (value.length >= 2 && value[0] === 0xfe && value[1] === 0xff) {
    // A copy, because swap16 rewrites the buffer it is given — and that buffer is
    // a window onto the file itself.
    const body = Buffer.from(value.subarray(2, value.length - ((value.length - 2) % 2)));
    return body.swap16().toString("utf16le").replace(/\u0000/g, "");
  }
  return value.toString("latin1");
}

module.exports = {
  Lexer,
  PdfName,
  PdfRef,
  PdfStream,
  PdfKeyword,
  parsePdfObjects,
  decodePdfString,
  isDict,
  nameOf,
  toArray,
  END_OF_INPUT,
  END_OF_ARRAY,
  END_OF_DICT
};
