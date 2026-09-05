"use strict";

/**
 * The PDF reader, against PDFs built byte by byte in `fixtures.js`.
 *
 * What is worth pinning down here is not "it reads text" but the four things
 * that decide whether the text is readable: where the line breaks fall, where
 * the spaces come from when the file never wrote any, which bytes a font's
 * character map turns into which letters, and that a malformed file stops
 * instead of spinning.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const { pdfToPages, PdfError } = require("../lib/pdf-text");
const { makePdf, makeTextPdf, drawText } = require("./fixtures");

test("reads the text of a page", () => {
  const pdf = makeTextPdf([drawText(72, 720, "Handover data is inconsistent")]);
  const { pages } = pdfToPages(pdf);

  assert.equal(pages.length, 1);
  assert.equal(pages[0], "Handover data is inconsistent");
});

test("reads a compressed content stream", () => {
  const pdf = makeTextPdf([drawText(72, 720, "The EIR was never issued")], { compress: true });
  assert.match(pdfToPages(pdf).pages[0], /The EIR was never issued/);
});

test("a step down the page ends the line, a bigger step ends the paragraph", () => {
  const pdf = makeTextPdf([
    drawText(72, 720, "First line") + drawText(72, 704, "Second line") + drawText(72, 640, "New paragraph")
  ]);

  assert.equal(pdfToPages(pdf).pages[0], "First line\nSecond line\n\nNew paragraph");
});

test("a gap along the line is a space, even though the file never wrote one", () => {
  // "Handover" is 8 glyphs of half an em at 12pt: 48 units wide, so it ends at
  // 120. The next run starts past that, and the hole between them is the space.
  const pdf = makeTextPdf([drawText(72, 720, "Handover") + drawText(126, 720, "data")]);
  assert.equal(pdfToPages(pdf).pages[0], "Handover data");
});

test("glyphs that carry on where the last ones stopped are one word", () => {
  const pdf = makeTextPdf([drawText(72, 720, "Hand") + drawText(96, 720, "over")]);
  assert.equal(pdfToPages(pdf).pages[0], "Handover");
});

test("a wide kern inside a TJ array is a space", () => {
  const content = "BT /F1 12 Tf 72 720 Td [(EIR) -400 (problems)] TJ ET\n";
  assert.equal(pdfToPages(makeTextPdf([content])).pages[0], "EIR problems");
});

test("text positioned by the graphics matrix lands where the matrix puts it", () => {
  // Both blocks draw at the same text-space point; only the `cm` between them
  // says they are on different lines. Reading the matrix is the whole test.
  const content =
    "q 1 0 0 1 72 720 cm BT /F1 12 Tf 0 0 Td (Top block) Tj ET Q\n" +
    "q 1 0 0 1 72 600 cm BT /F1 12 Tf 0 0 Td (Bottom block) Tj ET Q\n";

  assert.equal(pdfToPages(makeTextPdf([content])).pages[0], "Top block\n\nBottom block");
});

test("pages come back in the order of the page tree", () => {
  const pdf = makeTextPdf([drawText(72, 720, "Page one"), drawText(72, 720, "Page two")]);
  assert.deepEqual(pdfToPages(pdf).pages, ["Page one", "Page two"]);
});

test("the outline comes back as titles against page numbers", () => {
  const pdf = makeTextPdf([drawText(72, 720, "Opening"), drawText(72, 720, "Later")], {
    outline: [
      { title: "Introduction", page: 0 },
      { title: "Findings", page: 1 }
    ]
  });

  assert.deepEqual(
    pdfToPages(pdf).outline.map((entry) => [entry.title, entry.page]),
    [
      ["Introduction", 0],
      ["Findings", 1]
    ]
  );
});

test("the document title comes from its Info dictionary", () => {
  const pdf = makePdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      { dict: "", stream: drawText(72, 720, "Body text") },
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Title (Post-appointment BEP) >>"
    ],
    "/Root 1 0 R /Info 6 0 R"
  );

  assert.equal(pdfToPages(pdf).title, "Post-appointment BEP");
});

test("a font's ToUnicode map decides what its bytes say", () => {
  // The codes are meaningless on their own — glyph numbers in a subset font.
  // Only the map says they spell "BIM".
  const cmap = `/CIDInit /ProcSet findresource begin
1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar
<0001> <0042>
<0002> <0049>
<0003> <004D>
endbfchar
endcmap`;

  const pdf = makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    { dict: "", stream: "BT /F1 12 Tf 72 720 Td <000100020003> Tj ET\n" },
    "<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Arial /Encoding /Identity-H /ToUnicode 6 0 R /DescendantFonts [7 0 R] >>",
    { dict: "", stream: cmap },
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Arial /DW 500 >>"
  ]);

  assert.equal(pdfToPages(pdf).pages[0], "BIM");
});

test("a ToUnicode map that claims two-byte codes on an 8-bit font is not believed", () => {
  // Real files do this — a subset font with WinAnsiEncoding and a CMap whose
  // codespace says <0000> <FFFF>. Read two bytes at a time it swallows every
  // second letter, which is what this fixture would do if the reader believed it.
  const cmap = `/CIDInit /ProcSet findresource begin
1 begincodespacerange <0000> <FFFF> endcodespacerange
4 beginbfchar
<43> <0043>
<44> <0044>
<45> <0045>
<20> <0020>
endbfchar
endcmap`;

  const pdf = makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    { dict: "", stream: "BT /F1 12 Tf 72 720 Td (CDE) Tj ET\n" },
    "<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Arial /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>",
    { dict: "", stream: cmap }
  ]);

  assert.equal(pdfToPages(pdf).pages[0], "CDE");
});

test("a /Differences encoding renames the glyphs it moves", () => {
  const pdf = makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    { dict: "", stream: "BT /F1 12 Tf 72 720 Td (\\101\\102) Tj ET\n" },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times /Encoding << /Type /Encoding /Differences [65 /eacute /emdash] >> >>"
  ]);

  assert.equal(pdfToPages(pdf).pages[0], "é—");
});

test("a form XObject's text is part of the page", () => {
  const pdf = makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fx 6 0 R >> >> /Contents 4 0 R >>",
    { dict: "", stream: `${drawText(72, 720, "On the page")}q 1 0 0 1 0 -80 cm /Fx Do Q\n` },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    {
      dict: "/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >>",
      stream: drawText(72, 720, "Inside the form")
    }
  ]);

  const text = pdfToPages(pdf).pages[0];
  assert.match(text, /On the page/);
  assert.match(text, /Inside the form/);
});

test("objects hidden in a compressed object stream are found", () => {
  // Everything but the content stream lives inside object 6, which is how a PDF
  // written this decade stores its page tree.
  const inner = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  const numbers = [1, 2, 3, 5];

  let body = "";
  const offsets = [];
  inner.forEach((object, index) => {
    offsets.push(`${numbers[index]} ${body.length}`);
    body += `${object}\n`;
  });
  const header = `${offsets.join(" ")}\n`;

  const pdf = makePdf([
    "null",
    "null",
    "null",
    { dict: "", stream: drawText(72, 720, "Packed away") },
    "null",
    {
      dict: `/Type /ObjStm /N ${inner.length} /First ${header.length}`,
      stream: header + body,
      compress: true
    }
  ]);

  // The placeholders above are objects 1-3 and 5; the object stream's copies are
  // the ones that carry the document, so this also pins down which wins.
  assert.equal(pdfToPages(pdf).pages[0], "Packed away");
});

test("an encrypted file says so instead of returning nonsense", () => {
  const pdf = makeTextPdf([drawText(72, 720, "Secret")]).toString("latin1").replace("/Root 1 0 R", "/Root 1 0 R /Encrypt 99 0 R");

  assert.throws(() => pdfToPages(Buffer.from(pdf, "latin1")), (err) => {
    assert.ok(err instanceof PdfError);
    assert.equal(err.code, "encrypted_pdf");
    return true;
  });
});

test("something that is not a PDF is refused", () => {
  assert.throws(() => pdfToPages(Buffer.from("just some text")), /does not start like a PDF/);
});

test("a content stream that ends mid-token stops instead of spinning", () => {
  // The regression: reading a keyword ran off the end of the string, where
  // charCodeAt answers NaN — which counted as a character, for ever.
  const pdf = makeTextPdf(["BT /F1 12 Tf 72 720 Td (Cut short) Tj ET Q"]);
  assert.match(pdfToPages(pdf).pages[0], /Cut short/);
});

test("a page whose content will not inflate costs that page, not the file", () => {
  const broken = makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    { dict: "/Filter /FlateDecode", stream: Buffer.from("not deflate data at all") },
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    { dict: "", stream: drawText(72, 720, "This page is fine") },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ]);

  const { pages } = pdfToPages(broken);
  assert.equal(pages[0], "");
  assert.equal(pages[1], "This page is fine");
});

test("a page is dropped only when it has no text, never when it has no font", () => {
  const noFont = makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    { dict: "", stream: drawText(72, 720, "No resources here") }
  ]);

  assert.equal(pdfToPages(noFont).pages[0], "No resources here");
});

test("the reader does not depend on a cross-reference table", () => {
  // makeTextPdf writes none at all, so this is really a statement about the
  // fixtures — but it is the property the whole reader rests on.
  const pdf = makeTextPdf([drawText(72, 720, "Found by scanning")]);
  assert.equal(pdf.includes("startxref"), false);
  assert.equal(pdfToPages(pdf).pages[0], "Found by scanning");
});

test("zlib streams that are slightly wrong are still read", () => {
  // A trailing byte of junk after the deflate stream: strict inflate throws,
  // and the page would come back empty.
  const content = drawText(72, 720, "Almost valid");
  const deflated = Buffer.concat([zlib.deflateSync(Buffer.from(content, "latin1")), Buffer.from([0x0a, 0x00])]);

  const pdf = makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    { dict: "/Filter /FlateDecode", stream: deflated },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ]);

  assert.match(pdfToPages(pdf).pages[0], /Almost valid/);
});
