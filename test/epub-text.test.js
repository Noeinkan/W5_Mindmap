"use strict";

/**
 * The EPUB reader, and the ZIP reader underneath it, against archives built byte
 * by byte in `fixtures.js`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { epubToDocuments } = require("../lib/epub-text");
const { htmlToText } = require("../lib/html-text");
const { readZip } = require("../lib/zip");
const { makeEpub, makeZip } = require("./fixtures");

test("chapters come back in the spine's order, as text", () => {
  const epub = makeEpub({
    title: "Handover Practice",
    chapters: [
      { title: "One", html: "<h1>Chapter One</h1><p>The EIR was never issued.</p>" },
      { title: "Two", html: "<p>So the handover data is inconsistent.</p>" }
    ]
  });

  const { documents, title } = epubToDocuments(epub);
  assert.equal(title, "Handover Practice");
  assert.deepEqual(documents, [
    "Chapter One\n\nThe EIR was never issued.",
    "So the handover data is inconsistent."
  ]);
});

test("the navigation document becomes marks against the chapters", () => {
  const epub = makeEpub({
    chapters: [
      { title: "Introduction", html: "<p>Why any of this matters.</p>" },
      { title: "Method", html: "<p>How it was done.</p>" }
    ]
  });

  assert.deepEqual(epubToDocuments(epub).marks, [
    { title: "Introduction", unit: 0, depth: 0 },
    { title: "Method", unit: 1, depth: 0 }
  ]);
});

test("an EPUB 2 book is read from its NCX instead", () => {
  const epub = makeEpub({
    toc: "ncx",
    chapters: [
      { title: "Front matter", html: "<p>Copyright.</p>" },
      { title: "Chapter 1", html: "<p>It begins.</p>" }
    ]
  });

  const { marks } = epubToDocuments(epub);
  assert.deepEqual(
    marks.map((mark) => mark.title),
    ["Front matter", "Chapter 1"]
  );
});

test("a book with no contents list still gives its chapters", () => {
  const epub = makeEpub({
    toc: "none",
    chapters: [{ title: "One", html: "<p>Alone.</p>" }, { title: "Two", html: "<p>Also alone.</p>" }]
  });

  const { documents, marks } = epubToDocuments(epub);
  assert.equal(documents.length, 2);
  assert.deepEqual(marks, []);
});

test("the table of contents is not read as a chapter", () => {
  const epub = makeEpub({ chapters: [{ title: "Only", html: "<p>The only chapter.</p>" }] });
  const { documents } = epubToDocuments(epub);

  assert.equal(documents.length, 1);
  assert.equal(documents[0], "The only chapter.");
});

test("a chapter the archive is missing is a warning, not a failure", () => {
  const broken = makeEpub({
    chapters: [{ title: "One" }, { title: "Two", missing: true }]
  });

  const { documents, warnings } = epubToDocuments(broken);
  assert.equal(documents[0], "Chapter 1 body.");
  assert.equal(documents[1], "");
  assert.match(warnings[0], /not in the file/);
});

test("something that is not an EPUB is refused with a reason", () => {
  assert.throws(() => epubToDocuments(Buffer.from("not a zip at all")), /not an archive|too short/);
});

/* ------------------------------------------------------------------ */
/* The ZIP underneath                                                  */
/* ------------------------------------------------------------------ */

test("stored and deflated entries both come back as they went in", () => {
  const big = "The same line, many times over. ".repeat(200);
  const zip = readZip(
    makeZip([
      { name: "mimetype", data: "application/epub+zip", store: true },
      { name: "folder/long.txt", data: big }
    ])
  );

  assert.deepEqual(zip.names, ["mimetype", "folder/long.txt"]);
  assert.equal(zip.text("mimetype"), "application/epub+zip");
  assert.equal(zip.text("folder/long.txt"), big);
});

test("a name the archive spells differently in case is still found", () => {
  const zip = readZip(makeZip([{ name: "OEBPS/Chapter.xhtml", data: "<p>Here</p>" }]));
  assert.equal(zip.has("oebps/chapter.xhtml"), true);
  assert.equal(zip.read("nothing/here.xhtml"), null);
});

/* ------------------------------------------------------------------ */
/* HTML into text                                                      */
/* ------------------------------------------------------------------ */

test("blocks become lines and inline tags do not", () => {
  const html = "<body><h1>Title</h1><p>One <em>emphasised</em> sentence.</p><p>Another.</p></body>";
  assert.equal(htmlToText(html), "Title\n\nOne emphasised sentence.\n\nAnother.");
});

test("scripts, styles and comments are not text", () => {
  const html = "<body><style>p{color:red}</style><p>Kept</p><script>alert(1)</script><!-- gone --></body>";
  assert.equal(htmlToText(html), "Kept");
});

test("entities are decoded, including the numeric ones", () => {
  assert.equal(htmlToText("<p>Fish &amp; chips &#8212; &pound;9 &#x2014; caf&eacute;</p>"), "Fish & chips — £9 — café");
});

test("a line break tag breaks the line", () => {
  assert.equal(htmlToText("<p>First<br/>Second</p>"), "First\nSecond");
});
