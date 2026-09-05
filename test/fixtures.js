"use strict";

/**
 * Small, real files, built byte by byte.
 *
 * The readers under test take a PDF or an EPUB as bytes, so the fixtures have to
 * be bytes too — a hand-written object graph would test a different program. Both
 * builders are the minimum a reader is entitled to expect: a package, a spine and
 * a chapter for the EPUB; a catalogue, a page tree and a content stream for the
 * PDF. Everything else each test adds for itself.
 *
 * Not a test file: `npm test` runs `test/*.test.js`, and this is imported by
 * those.
 */

const zlib = require("node:zlib");

/* ------------------------------------------------------------------ */
/* ZIP, which is what an EPUB is                                       */
/* ------------------------------------------------------------------ */

const crc32 =
  typeof zlib.crc32 === "function"
    ? (data) => zlib.crc32(data)
    : (data) => {
        let crc = 0xffffffff;
        for (const byte of data) {
          crc ^= byte;
          for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
        return (crc ^ 0xffffffff) >>> 0;
      };

/**
 * @param {Array<{name: string, data: string|Buffer, store?: boolean}>} entries
 *   `store` writes the entry uncompressed, which is what an EPUB's `mimetype`
 *   must be — and the other half of the reader worth covering.
 */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const stored = Boolean(entry.store);
    const body = stored ? raw : zlib.deflateRawSync(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // names are UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt32LE(crc32(raw), 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/**
 * An EPUB with the skeleton the format requires and whatever chapters are asked
 * for.
 *
 * @param {{chapters?: Array<{name?: string, title?: string, html?: string}>,
 *   title?: string, toc?: "nav"|"ncx"|"none", extra?: Array<object>}} options
 */
function makeEpub(options = {}) {
  const title = options.title || "A Test Book";
  const toc = options.toc || "nav";
  const chapters = (options.chapters || [{ title: "One", html: "<p>First chapter.</p>" }]).map(
    (chapter, index) => ({
      id: `c${index + 1}`,
      name: chapter.name || `chapter-${index + 1}.xhtml`,
      title: chapter.title || `Chapter ${index + 1}`,
      html: chapter.html === undefined ? `<p>Chapter ${index + 1} body.</p>` : chapter.html,
      // Listed in the package but left out of the archive, which is how a book
      // arrives after a bad conversion.
      missing: Boolean(chapter.missing)
    })
  );

  const document = (heading, body) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${heading}</title></head><body>${body}</body></html>`;

  const manifest = chapters
    .map((c) => `<item id="${c.id}" href="OEBPS/${c.name}" media-type="application/xhtml+xml"/>`)
    .join("\n    ");
  const spine = chapters.map((c) => `<itemref idref="${c.id}"/>`).join("\n    ");

  const navItem =
    toc === "nav" ? '<item id="nav" href="OEBPS/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : "";
  const ncxItem = toc === "ncx" ? '<item id="ncx" href="OEBPS/toc.ncx" media-type="application/x-dtbncx+xml"/>' : "";

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    ${manifest}
    ${navItem}
    ${ncxItem}
  </manifest>
  <spine${toc === "ncx" ? ' toc="ncx"' : ""}>
    ${spine}
  </spine>
</package>`;

  const files = [
    { name: "mimetype", data: "application/epub+zip", store: true },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
    },
    { name: "content.opf", data: opf },
    ...chapters
      .filter((c) => !c.missing)
      .map((c) => ({ name: `OEBPS/${c.name}`, data: document(c.title, c.html) }))
  ];

  if (toc === "nav") {
    const items = chapters
      .map((c) => `<li><a href="${c.name}">${c.title}</a></li>`)
      .join("\n        ");
    files.push({
      name: "OEBPS/nav.xhtml",
      data: document(
        "Contents",
        `<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>\n        ${items}\n      </ol></nav>`
      )
    });
  }
  if (toc === "ncx") {
    const points = chapters
      .map(
        (c, index) =>
          `<navPoint id="${c.id}" playOrder="${index + 1}"><navLabel><text>${c.title}</text></navLabel><content src="${c.name}"/></navPoint>`
      )
      .join("\n    ");
    files.push({
      name: "OEBPS/toc.ncx",
      data: `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    ${points}
  </navMap>
</ncx>`
    });
  }

  return makeZip([...files, ...(options.extra || [])]);
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

/**
 * A PDF built from numbered objects.
 *
 * Objects are written in order with no cross-reference table, which is on
 * purpose: the reader scans for objects rather than trusting the table, and a
 * fixture that carried one would hide it if that ever stopped being true.
 *
 * @param {Array<string|{dict: string, stream: string|Buffer, compress?: boolean}>} objects
 *   One entry per object, numbered from 1.
 * @param {string} [trailer] The trailer dictionary body.
 */
function makePdf(objects, trailer = "/Root 1 0 R") {
  const parts = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];

  objects.forEach((object, index) => {
    const number = index + 1;
    if (typeof object === "string") {
      parts.push(Buffer.from(`${number} 0 obj\n${object}\nendobj\n`, "latin1"));
      return;
    }
    const raw = Buffer.isBuffer(object.stream) ? object.stream : Buffer.from(object.stream, "latin1");
    const body = object.compress ? zlib.deflateSync(raw) : raw;
    const filter = object.compress ? " /Filter /FlateDecode" : "";
    parts.push(
      Buffer.from(`${number} 0 obj\n<< ${object.dict}${filter} /Length ${body.length} >>\nstream\n`, "latin1"),
      body,
      Buffer.from("\nendstream\nendobj\n", "latin1")
    );
  });

  parts.push(Buffer.from(`trailer\n<< ${trailer} >>\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/**
 * The usual shape: a catalogue, a page tree, one Helvetica font, and one page
 * per content stream given.
 *
 * @param {Array<string>} contents One content stream per page.
 * @param {{compress?: boolean, extra?: Array<any>, outline?: Array<{title: string, page: number}>}} [options]
 */
function makeTextPdf(contents, options = {}) {
  const pageObjects = contents.length;
  // 1 catalogue, 2 page tree, 3 font, then one page and one stream each.
  const firstPage = 4;
  const kids = contents.map((_, index) => `${firstPage + index * 2} 0 R`).join(" ");
  const outlineRoot = firstPage + pageObjects * 2;

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${options.outline ? ` /Outlines ${outlineRoot} 0 R` : ""} >>`,
    `<< /Type /Pages /Count ${pageObjects} /Kids [${kids}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  contents.forEach((content, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPage + index * 2 + 1} 0 R >>`
    );
    objects.push({ dict: "", stream: content, compress: options.compress });
  });

  if (options.outline) {
    const first = outlineRoot + 1;
    objects.push(`<< /Type /Outlines /First ${first} 0 R /Count ${options.outline.length} >>`);
    options.outline.forEach((entry, index) => {
      const next = index + 1 < options.outline.length ? ` /Next ${first + index + 1} 0 R` : "";
      objects.push(
        `<< /Title (${entry.title}) /Parent ${outlineRoot} 0 R${next} /Dest [${firstPage + entry.page * 2} 0 R /XYZ null null null] >>`
      );
    });
  }

  return makePdf([...objects, ...(options.extra || [])]);
}

/** A text-showing block at a point on the page. */
function drawText(x, y, text, { font = "F1", size = 12 } = {}) {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${text}) Tj ET\n`;
}

module.exports = { makeZip, makeEpub, makePdf, makeTextPdf, drawText };
