"use strict";

/**
 * The stream filters a PDF wraps its bytes in.
 *
 * Everything inside a PDF that is not a number or a name arrives compressed —
 * page contents, the font tables that say what the glyph codes mean, and in a
 * modern file the objects themselves. Flate is the one that matters and it is
 * `node:zlib`; the other three are here because a file that uses one of them for
 * a single font would otherwise lose all of its text, and each is a dozen lines.
 */

const zlib = require("node:zlib");

/** Applies a filter chain to a stream's raw bytes. */
function decodeStream(dict, raw, resolve) {
  const filters = toArray(resolve(dict.Filter)).map((f) => nameOf(resolve(f))).filter(Boolean);
  const parms = toArray(resolve(dict.DecodeParms ?? dict.DP));

  let data = raw;
  filters.forEach((filter, index) => {
    data = applyFilter(filter, data, resolve(parms[index]) || null, resolve);
  });
  return data;
}

function applyFilter(filter, data, params, resolve) {
  switch (filter) {
    case "FlateDecode":
    case "Fl":
      return predict(inflate(data), params, resolve);
    case "LZWDecode":
    case "LZW":
      return predict(lzwDecode(data, num(resolve(params?.EarlyChange), 1)), params, resolve);
    case "ASCIIHexDecode":
    case "AHx":
      return asciiHexDecode(data);
    case "ASCII85Decode":
    case "A85":
      return ascii85Decode(data);
    case "RunLengthDecode":
    case "RL":
      return runLengthDecode(data);
    // An image filter: the bytes are a JPEG, not text. Handing them back
    // unchanged is right — nothing downstream reads a picture.
    case "DCTDecode":
    case "JPXDecode":
    case "JBIG2Decode":
    case "CCITTFaxDecode":
      return data;
    default:
      return data;
  }
}

/**
 * Flate, forgiving. A surprising number of files in the wild have a byte of junk
 * before the zlib header or a truncated tail, and a strict inflate turns either
 * into a page with no text at all.
 */
function inflate(data) {
  const attempts = [
    () => zlib.inflateSync(data),
    () => zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    () => zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    () => zlib.inflateSync(data.subarray(1), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
  ];
  for (const attempt of attempts) {
    try {
      const out = attempt();
      if (out.length) return out;
    } catch {
      /* Next way in. */
    }
  }
  return Buffer.alloc(0);
}

/**
 * Undoes the row-by-row prediction a writer applies before compressing, which is
 * what cross-reference streams and most object streams use. Without this their
 * bytes come out shifted and the file reads as if it had no objects at all.
 */
function predict(data, params, resolve) {
  const predictor = num(resolve(params?.Predictor), 1);
  if (predictor <= 1 || !data.length) return data;

  const colors = num(resolve(params?.Colors), 1);
  const bpc = num(resolve(params?.BitsPerComponent), 8);
  const columns = num(resolve(params?.Columns), 1);
  const pixelBytes = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);

  // TIFF prediction (2) is a horizontal delta; only the 8-bit case is worth the code.
  if (predictor === 2) {
    if (bpc !== 8) return data;
    for (let row = 0; row + rowBytes <= data.length; row += rowBytes) {
      for (let i = pixelBytes; i < rowBytes; i += 1) {
        data[row + i] = (data[row + i] + data[row + i - pixelBytes]) & 0xff;
      }
    }
    return data;
  }

  // PNG prediction: every row carries its filter type in a leading byte.
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = Buffer.alloc(rows * rowBytes);
  let previous = Buffer.alloc(rowBytes);

  for (let row = 0; row < rows; row += 1) {
    const type = data[row * (rowBytes + 1)];
    const line = data.subarray(row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1));
    const current = Buffer.from(line);

    for (let i = 0; i < rowBytes; i += 1) {
      const left = i >= pixelBytes ? current[i - pixelBytes] : 0;
      const up = previous[i];
      const upLeft = i >= pixelBytes ? previous[i - pixelBytes] : 0;
      switch (type) {
        case 1:
          current[i] = (current[i] + left) & 0xff;
          break;
        case 2:
          current[i] = (current[i] + up) & 0xff;
          break;
        case 3:
          current[i] = (current[i] + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          current[i] = (current[i] + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          break;
      }
    }
    current.copy(out, row * rowBytes);
    previous = current;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** LZW as PDF (and TIFF) use it: 9-bit codes growing to 12, 256 clears, 257 ends. */
function lzwDecode(input, earlyChange = 1) {
  const out = [];
  let dictionary = [];
  let next = 258;
  let bits = 9;
  let buffer = 0;
  let bufferBits = 0;
  let previous = null;

  const reset = () => {
    dictionary = new Array(4096);
    for (let i = 0; i < 256; i += 1) dictionary[i] = [i];
    next = 258;
    bits = 9;
    previous = null;
  };
  reset();

  for (const byte of input) {
    buffer = (buffer << 8) | byte;
    bufferBits += 8;

    while (bufferBits >= bits) {
      const code = (buffer >> (bufferBits - bits)) & ((1 << bits) - 1);
      bufferBits -= bits;

      if (code === 256) {
        reset();
        continue;
      }
      if (code === 257) return Buffer.from(out);

      let entry;
      if (dictionary[code]) entry = dictionary[code];
      else if (previous) entry = previous.concat(previous[0]);
      else return Buffer.from(out);

      for (const value of entry) out.push(value);
      if (previous && next < 4096) dictionary[next++] = previous.concat(entry[0]);
      previous = entry;
      if (next + earlyChange >= 1 << bits && bits < 12) bits += 1;
    }
  }
  return Buffer.from(out);
}

function asciiHexDecode(data) {
  const text = data.toString("latin1");
  // ">" ends the data; an odd number of digits means the last byte was written
  // with its low nibble left off.
  const end = text.indexOf(">");
  const digits = (end === -1 ? text : text.slice(0, end)).replace(/[^0-9a-fA-F]/g, "");
  return Buffer.from(digits.length % 2 ? `${digits}0` : digits, "hex");
}

function ascii85Decode(data) {
  const text = data.toString("latin1").replace(/\s+/g, "").replace(/^<~/, "");
  const end = text.indexOf("~>");
  const body = end === -1 ? text : text.slice(0, end);
  const out = [];
  let tuple = [];

  for (const char of body) {
    if (char === "z" && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const value = char.charCodeAt(0) - 33;
    if (value < 0 || value > 84) continue;
    tuple.push(value);
    if (tuple.length === 5) {
      pushTuple(out, tuple, 4);
      tuple = [];
    }
  }
  if (tuple.length > 1) {
    const kept = tuple.length - 1;
    while (tuple.length < 5) tuple.push(84);
    pushTuple(out, tuple, kept);
  }
  return Buffer.from(out);
}

function pushTuple(out, tuple, keep) {
  let value = 0;
  for (const digit of tuple) value = value * 85 + digit;
  const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  for (let i = 0; i < keep; i += 1) out.push(bytes[i]);
}

function runLengthDecode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const length = data[i++];
    if (length === 128) break;
    if (length < 128) {
      for (let n = 0; n <= length && i < data.length; n += 1) out.push(data[i++]);
    } else {
      const byte = data[i++];
      for (let n = 0; n < 257 - length; n += 1) out.push(byte);
    }
  }
  return Buffer.from(out);
}

/* Small shared helpers — the lexer's own copies would be the same three lines. */

function nameOf(value) {
  return value && typeof value === "object" && typeof value.name === "string" ? value.name : null;
}

function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

module.exports = { decodeStream, nameOf, toArray };
