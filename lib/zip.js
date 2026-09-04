"use strict";

/**
 * The little of ZIP that reading an EPUB needs.
 *
 * An EPUB is a ZIP archive with a fixed skeleton inside it, so the archive has to
 * be opened before anything else can happen — and the two compression methods the
 * format allows (stored and deflate) are both in `node:zlib` already. That is why
 * this is forty lines of header parsing rather than a dependency: the central
 * directory is 46 fixed bytes per entry, and inflate comes with Node.
 *
 * What it deliberately does not do: encrypted entries, multi-disk archives, and
 * streaming — the whole file is held in memory, which for a book is a few MB.
 */

const zlib = require("node:zlib");

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
// The archive comment is a u16 length, so the end record starts at most this far
// from the last byte.
const MAX_COMMENT = 0xffff;
// The marker both u32 size fields carry when the real value lives in a ZIP64
// extra field instead.
const NEEDS_ZIP64 = 0xffffffff;

class ZipError extends Error {
  constructor(message, code = "bad_zip") {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

/**
 * Opens an archive held in memory.
 *
 * @param {Buffer} buffer
 * @returns {{names: string[], has(name: string): boolean, read(name: string): Buffer|null, text(name: string): string|null}}
 */
function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_SIZE) {
    throw new ZipError("That file is too short to be an archive.");
  }

  const eocd = findEndRecord(buffer);
  if (eocd === -1) throw new ZipError("That file has no ZIP directory — it is not an archive.");

  const { offset } = directoryLocation(buffer, eocd);
  const entries = readDirectory(buffer, offset);
  // Names are matched exactly first; an EPUB whose OPF disagrees with the archive
  // on case is common enough to be worth the second lookup rather than an error.
  const lowered = new Map();
  entries.forEach((entry, name) => {
    if (!lowered.has(name.toLowerCase())) lowered.set(name.toLowerCase(), entry);
  });

  const find = (name) => entries.get(name) || lowered.get(String(name).toLowerCase()) || null;

  return {
    names: [...entries.keys()],
    has: (name) => Boolean(find(name)),
    read(name) {
      const entry = find(name);
      return entry ? readEntry(buffer, entry) : null;
    },
    text(name) {
      const data = this.read(name);
      return data ? stripBom(data.toString("utf8")) : null;
    }
  };
}

function findEndRecord(buf) {
  const floor = Math.max(0, buf.length - EOCD_SIZE - MAX_COMMENT);
  for (let i = buf.length - EOCD_SIZE; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/** Where the central directory starts, following the ZIP64 record when there is one. */
function directoryLocation(buf, eocd) {
  const entries = buf.readUInt16LE(eocd + 10);
  const offset = buf.readUInt32LE(eocd + 16);
  if (entries !== 0xffff && offset !== NEEDS_ZIP64) return { entries, offset };

  const locator = eocd - 20;
  if (locator < 0 || buf.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new ZipError("This archive claims to be ZIP64 but carries no ZIP64 record.");
  }
  const record = Number(buf.readBigUInt64LE(locator + 8));
  if (record < 0 || record + 56 > buf.length || buf.readUInt32LE(record) !== ZIP64_EOCD_SIGNATURE) {
    throw new ZipError("This archive's ZIP64 record is not where it says it is.");
  }
  return {
    entries: Number(buf.readBigUInt64LE(record + 32)),
    offset: Number(buf.readBigUInt64LE(record + 48))
  };
}

function readDirectory(buf, start) {
  const entries = new Map();
  let pos = start;

  while (pos + 46 <= buf.length && buf.readUInt32LE(pos) === CENTRAL_SIGNATURE) {
    const flags = buf.readUInt16LE(pos + 8);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const nameBytes = buf.subarray(pos + 46, pos + 46 + nameLength);
    // Bit 11 is the archive saying the name is UTF-8. Without it the standard says
    // CP437; latin1 is the closest thing Node has and EPUB names are ASCII anyway.
    const entry = {
      name: nameBytes.toString(flags & 0x800 ? "utf8" : "latin1"),
      method: buf.readUInt16LE(pos + 10),
      compressedSize: buf.readUInt32LE(pos + 20),
      size: buf.readUInt32LE(pos + 24),
      headerOffset: buf.readUInt32LE(pos + 42)
    };
    if (entry.compressedSize === NEEDS_ZIP64 || entry.size === NEEDS_ZIP64 || entry.headerOffset === NEEDS_ZIP64) {
      applyZip64Extra(buf.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength), entry);
    }
    // A directory entry is a name ending in "/" with no content; nothing here ever
    // wants one, and keeping them out saves every caller the check.
    if (!entry.name.endsWith("/")) entries.set(entry.name, entry);
    pos += 46 + nameLength + extraLength + commentLength;
  }

  if (!entries.size) throw new ZipError("That archive has no files in it.");
  return entries;
}

/** The 0x0001 extra field carries the real sizes, in the order of the fields that overflowed. */
function applyZip64Extra(extra, entry) {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const size = extra.readUInt16LE(pos + 2);
    const body = extra.subarray(pos + 4, pos + 4 + size);
    if (id === 0x0001) {
      let at = 0;
      const next = () => {
        const value = Number(body.readBigUInt64LE(at));
        at += 8;
        return value;
      };
      if (entry.size === NEEDS_ZIP64 && at + 8 <= body.length) entry.size = next();
      if (entry.compressedSize === NEEDS_ZIP64 && at + 8 <= body.length) entry.compressedSize = next();
      if (entry.headerOffset === NEEDS_ZIP64 && at + 8 <= body.length) entry.headerOffset = next();
      return;
    }
    pos += 4 + size;
  }
}

function readEntry(buf, entry) {
  const header = entry.headerOffset;
  if (header + 30 > buf.length || buf.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new ZipError(`"${entry.name}" is not where the archive's directory says it is.`);
  }
  const nameLength = buf.readUInt16LE(header + 26);
  const extraLength = buf.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  // A zero compressed size in the directory means the writer streamed the entry and
  // put the sizes in a trailing descriptor. Inflate stops at the end of its own
  // stream, so handing it the rest of the file is safe.
  const raw =
    entry.compressedSize > 0 ? buf.subarray(start, start + entry.compressedSize) : buf.subarray(start);

  if (entry.method === STORED) return Buffer.from(raw);
  if (entry.method === DEFLATED) {
    try {
      return zlib.inflateRawSync(raw);
    } catch (err) {
      throw new ZipError(`"${entry.name}" could not be decompressed (${err.message}).`);
    }
  }
  throw new ZipError(
    `"${entry.name}" uses compression method ${entry.method}, which this reader does not know.`,
    "unsupported_zip"
  );
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

module.exports = { readZip, ZipError };
