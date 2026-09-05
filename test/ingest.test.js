"use strict";

/**
 * The one way in: bytes to transcript.
 *
 * The format is decided here, so this is where the wrong file gets a sentence
 * rather than a stack trace — and where the text is tidied into the shape the
 * chunker expects.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const { ingestFile } = require("../lib/ingest");
const { makeEpub, makeZip, makeTextPdf, drawText } = require("./fixtures");

test("a PDF comes back as text, with its pages counted", () => {
  const pdf = makeTextPdf([drawText(72, 720, "The EIR was never issued"), drawText(72, 720, "So handover fails")]);
  const result = ingestFile(pdf, { filename: "kickoff.pdf" });

  assert.equal(result.kind, "pdf");
  assert.equal(result.units, 2);
  assert.equal(result.unitLabel, "page");
  assert.match(result.text, /The EIR was never issued/);
  assert.match(result.text, /So handover fails/);
  assert.equal(result.chars, result.text.length);
});

test("an EPUB comes back as chapters, split one per file when it has no contents", () => {
  const epub = makeEpub({
    toc: "none",
    title: "Handover Practice",
    chapters: [
      { html: "<h1>One</h1><p>The first chapter says something.</p>" },
      { html: "<h1>Two</h1><p>The second chapter says something else.</p>" }
    ]
  });

  const result = ingestFile(epub, { filename: "book.epub" });
  assert.equal(result.kind, "epub");
  assert.equal(result.title, "Handover Practice");
  assert.equal(result.unitLabel, "chapter");
  assert.equal(result.sections.length, 2);
  assert.equal(result.method, "documents");
});

test("every section points at its own text inside the transcript", () => {
  const epub = makeEpub({
    chapters: [
      { title: "Beginnings", html: "<p>The first chapter says something.</p>" },
      { title: "Endings", html: "<p>The second chapter says something else.</p>" }
    ]
  });

  const { text, sections } = ingestFile(epub, { filename: "book.epub" });
  assert.equal(sections.length, 2);

  const first = text.slice(sections[0].start, sections[0].end);
  const second = text.slice(sections[1].start, sections[1].end);
  assert.match(first, /first chapter/);
  assert.match(second, /second chapter/);
  assert.equal(first.includes("second chapter"), false);
  // The sections tile the text: no gap between one ending and the next starting.
  assert.equal(sections[0].end, sections[1].start);
});

test("a text file is taken as it is, and its Markdown headings are its sections", () => {
  const markdown = [
    "# Kickoff notes",
    "",
    "PM: The EIR was never issued.",
    "",
    "## Actions",
    "",
    "IM: Agree the CDE naming convention."
  ].join("\n");

  const result = ingestFile(Buffer.from(markdown, "utf8"), { filename: "notes.md" });
  assert.equal(result.kind, "text");
  assert.deepEqual(
    result.sections.map((section) => section.title),
    ["Kickoff notes", "Actions"]
  );
  // Nothing is written in above a heading that is already there.
  assert.equal(result.text.startsWith("# Kickoff notes"), true);
});

test("words broken across a line by a hyphen are put back together", () => {
  const text = "The infra-\nstructure programme was re-\nviewed in full detail today.";
  const result = ingestFile(Buffer.from(text, "utf8"), { filename: "notes.txt" });

  assert.match(result.text, /infrastructure programme/);
  assert.match(result.text, /reviewed in full/);
});

test("a hyphen between two words is left alone", () => {
  const result = ingestFile(Buffer.from("A post-appointment BEP, and a well-known risk.", "utf8"), {});
  assert.match(result.text, /post-appointment BEP/);
  assert.match(result.text, /well-known risk/);
});

test("ligatures are read as the letters they stand for", () => {
  const result = ingestFile(Buffer.from("The oﬃce ﬁle was ﬂagged for review by the team.", "utf8"), {});
  assert.match(result.text, /The office file was flagged/);
});

test("a UTF-16 file is decoded rather than refused as binary", () => {
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("PM: The EIR was never issued and handover suffered.", "utf16le")
  ]);

  const result = ingestFile(utf16, { filename: "notes.txt" });
  assert.equal(result.kind, "text");
  assert.match(result.text, /The EIR was never issued/);
});

test("a scanned PDF says it needs OCR instead of returning an empty transcript", () => {
  // Pages, but nothing drawn on them.
  const pdf = makeTextPdf(["q 1 0 0 1 0 0 cm Q\n"]);
  assert.throws(() => ingestFile(pdf, { filename: "scan.pdf" }), (err) => {
    assert.equal(err.code, "no_text");
    assert.match(err.message, /scan/);
    return true;
  });
});

test("a Word document is refused by name, with what to do instead", () => {
  const docx = makeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", data: "<document/>" }
  ]);

  assert.throws(() => ingestFile(docx, { filename: "brief.docx" }), /Word documents.*export it as a PDF/s);
});

test("a plain ZIP is refused as what it is", () => {
  const zip = makeZip([{ name: "notes.txt", data: "hello" }]);
  assert.throws(() => ingestFile(zip, { filename: "stuff.zip" }), (err) => {
    assert.equal(err.code, "unsupported_file");
    assert.match(err.message, /"stuff\.zip" is a ZIP archive/);
    return true;
  });
});

test("a binary file is refused before any parser sees it", () => {
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  assert.throws(() => ingestFile(binary, { filename: "diagram.png" }), (err) => {
    assert.equal(err.code, "unsupported_file");
    assert.match(err.message, /"diagram\.png" is not a document/);
    return true;
  });
});

test("an empty file is refused", () => {
  assert.throws(() => ingestFile(Buffer.alloc(0), {}), (err) => {
    assert.equal(err.code, "empty_file");
    return true;
  });
});

test("the character cap cuts the text and says so, keeping the sections that survive", () => {
  const long = new Array(40).fill("A line of the document that goes on for a while.").join("\n");
  const result = ingestFile(Buffer.from(long, "utf8"), { filename: "long.txt", maxChars: 400 });

  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 400);
  assert.match(result.warnings.join(" "), /Only the first/);
  assert.ok(result.sections.every((section) => section.end <= result.text.length));
});

test("a PDF that is really something else fails as that something else", () => {
  // The bytes decide, not the name.
  const epub = makeEpub({ chapters: [{ title: "One", html: "<p>Still a book, whatever it is called.</p>" }] });
  assert.equal(ingestFile(epub, { filename: "report.pdf" }).kind, "epub");
});

test("a compressed PDF page is read like any other", () => {
  const pdf = makeTextPdf([drawText(72, 720, "Compressed but readable enough to keep")], { compress: true });
  assert.match(ingestFile(pdf, {}).text, /Compressed but readable/);
});

test("gzip is not mistaken for a document", () => {
  const gzipped = zlib.gzipSync(Buffer.from("PM: the EIR was never issued"));
  assert.throws(() => ingestFile(gzipped, { filename: "notes.gz" }), /not a document/);
});
