"use strict";

/**
 * Where a document breaks into sections, and what the text looks like once it
 * has been put back together with those breaks recorded.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { detectSections, assembleSections, readHeading } = require("../lib/sections");

const titles = (result) => result.sections.map((section) => section.title);
const ranges = (result) => result.sections.map((section) => [section.from, section.to]);

test("a contents list is preferred over anything read off the page", () => {
  const result = detectSections({
    units: ["Cover", "Chapter 1 text", "more", "Chapter 2 text"],
    marks: [
      { title: "Chapter 1", unit: 1, depth: 0 },
      { title: "Chapter 2", unit: 3, depth: 0 }
    ]
  });

  assert.equal(result.method, "contents");
  assert.deepEqual(titles(result), ["Front matter", "Chapter 1", "Chapter 2"]);
  assert.deepEqual(ranges(result), [
    [0, 1],
    [1, 3],
    [3, 4]
  ]);
});

test("the chapters win when a contents list holds chapters and their subheadings", () => {
  const result = detectSections({
    units: new Array(6).fill("text"),
    marks: [
      { title: "Preface", unit: 0, depth: 0 },
      { title: "Chapter 1", unit: 1, depth: 0 },
      { title: "1.1 Something", unit: 2, depth: 1 },
      { title: "1.2 Something else", unit: 3, depth: 1 },
      { title: "Chapter 2", unit: 4, depth: 0 },
      { title: "2.1 More", unit: 5, depth: 1 }
    ]
  });

  assert.deepEqual(titles(result), ["Preface", "Chapter 1", "Chapter 2"]);
});

test("with no chapters, the shallowest level that has two entries is the split", () => {
  const result = detectSections({
    units: new Array(4).fill("text"),
    marks: [
      { title: "The whole book", unit: 0, depth: 0 },
      { title: "Part One", unit: 1, depth: 1 },
      { title: "Part Two", unit: 3, depth: 1 }
    ]
  });

  // The dropped depth-0 entry covered unit 0, and that unit is still part of the
  // document: it comes back as front matter rather than going missing.
  assert.deepEqual(titles(result), ["Front matter", "Part One", "Part Two"]);
});

test("without a contents list, headings on the page are read instead", () => {
  const result = detectSections({
    units: [
      "Title page\nby someone",
      "Chapter 1\nIt starts here.",
      "carrying on",
      "Chapter 2: Consequences\nAnd here."
    ]
  });

  assert.equal(result.method, "headings");
  assert.deepEqual(titles(result), ["Front matter", "Chapter 1", "Chapter 2 — Consequences"]);
});

test("a numbered heading is a heading, a numbered list item is not", () => {
  assert.equal(readHeading("4. Information Delivery Planning").title, "4 Information Delivery Planning");
  assert.equal(readHeading("Chapter 12: Risk").title, "Chapter 12 — Risk");
  assert.equal(readHeading("3. see the appendix for the rest of it."), null);
  assert.equal(readHeading("just a sentence"), null);
});

test("the contents page is not mistaken for the start of a section", () => {
  // Every heading in the document appears on it, in order, with page numbers.
  // Read as section openings they would all land on page 1.
  const result = detectSections({
    units: [
      "Contents\n1. Introduction 3\n2. Requirements 8\n3. Delivery 14\n4. Assurance 21",
      "1. Introduction\nThe project begins.",
      "2. Requirements\nWhat is needed.",
      "3. Delivery\nHow it arrives."
    ]
  });

  assert.deepEqual(titles(result), ["Front matter", "1 Introduction", "2 Requirements", "3 Delivery"]);
  assert.deepEqual(ranges(result), [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4]
  ]);
});

test("a book whose contents list is useless still splits by chapter file", () => {
  const result = detectSections({
    units: ["COVER", "Chapter One\nIt begins.", "Chapter Two\nIt continues."],
    marks: [{ title: "Start", unit: 0, depth: 0 }],
    splitByUnit: true
  });

  assert.equal(result.method, "documents");
  assert.deepEqual(titles(result), ["COVER", "Chapter One", "Chapter Two"]);
});

test("a document with nothing to split is one section", () => {
  const result = detectSections({ units: ["A short memo about one thing."] });
  assert.equal(result.method, "none");
  assert.deepEqual(titles(result), ["Whole document"]);
});

test("two headings on one page make one section, titled by the first", () => {
  const result = detectSections({
    units: ["intro", "Chapter 1\nChapter 2\nboth here", "Chapter 3\nlater"]
  });
  assert.deepEqual(titles(result), ["Front matter", "Chapter 1", "Chapter 3"]);
});

test("page numbers trailing a contents title are not part of it", () => {
  const result = detectSections({
    units: ["a", "b"],
    marks: [
      { title: "Introduction . . . . . . 12", unit: 0, depth: 0 },
      { title: "Findings", unit: 1, depth: 0 }
    ]
  });
  assert.deepEqual(titles(result), ["Introduction", "Findings"]);
});

/* ------------------------------------------------------------------ */
/* Putting the text back together                                      */
/* ------------------------------------------------------------------ */

test("each section knows where it starts and ends in the assembled text", () => {
  const units = ["First page.", "Second page.", "Third page."];
  const sections = [
    { title: "Opening", from: 0, to: 2 },
    { title: "Closing", from: 2, to: 3 }
  ];

  const { text, sections: placed } = assembleSections(units, sections);

  assert.equal(placed.length, 2);
  for (const section of placed) {
    assert.equal(text.slice(section.start, section.end).length, section.chars);
    assert.ok(text.slice(section.start, section.end).startsWith(section.title));
  }
  assert.match(text.slice(placed[0].start, placed[0].end), /First page\.\n\nSecond page\./);
});

test("a heading is written in above a section that does not already say it", () => {
  const { text } = assembleSections(["It begins."], [{ title: "Chapter 1", from: 0, to: 1 }]);
  assert.equal(text, "Chapter 1\n\nIt begins.");
});

test("a section that opens with its own title is left alone", () => {
  const { text } = assembleSections(["Chapter 1\n\nIt begins."], [{ title: "Chapter 1", from: 0, to: 1 }]);
  assert.equal(text, "Chapter 1\n\nIt begins.");
});

test("empty units do not become empty sections", () => {
  const { sections } = assembleSections(
    ["Something.", "", "   "],
    [
      { title: "Real", from: 0, to: 1 },
      { title: "Blank", from: 1, to: 3 }
    ]
  );
  assert.deepEqual(
    sections.map((section) => section.title),
    ["Real"]
  );
});
