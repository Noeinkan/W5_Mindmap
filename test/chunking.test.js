"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { chunkTranscript } = require("../lib/chunking");

test("returns nothing for empty input", () => {
  assert.deepEqual(chunkTranscript("", 100), []);
  assert.deepEqual(chunkTranscript("   \n  ", 100), []);
});

test("keeps a short transcript in one chunk, newlines intact", () => {
  const transcript = "PM: We need the EIR.\nIM: And the CDE naming convention.";
  assert.deepEqual(chunkTranscript(transcript, 500), [transcript]);
});

test("cuts at line boundaries, never mid-line", () => {
  const lines = ["PM: aaaa", "IM: bbbb", "PM: cccc", "IM: dddd"];
  const chunks = chunkTranscript(lines.join("\n"), 20, 0);

  assert.ok(chunks.length > 1);
  chunks.forEach((chunk) => {
    chunk.split("\n").forEach((line) => {
      assert.ok(lines.includes(line), `unexpected partial line: ${line}`);
    });
  });
});

test("preserves speaker turns across a cut", () => {
  const transcript = ["PM: first turn here", "IM: second turn here", "PM: third turn here"].join("\n");
  const chunks = chunkTranscript(transcript, 25, 0);
  const rejoined = chunks.join("\n");
  assert.ok(rejoined.includes("IM: second turn here"));
});

test("repeats the trailing line as overlap", () => {
  const lines = Array.from({ length: 6 }, (_, i) => `line-${String(i).padStart(7, "0")}`);
  const chunks = chunkTranscript(lines.join("\n"), 40, 1);

  assert.ok(chunks.length >= 2);
  const lastLineOfFirst = chunks[0].split("\n").pop();
  assert.equal(chunks[1].split("\n")[0], lastLineOfFirst);
});

test("evens out the chunks instead of leaving a runt at the end", () => {
  // The sample transcript's shape: just over the limit, so the greedy pass leaves a
  // tail too short for the model to take seriously.
  const lines = Array.from({ length: 12 }, (_, i) => `Speaker: turn number ${i} of the meeting`);
  const chunks = chunkTranscript(lines.join("\n"), 200, 0);
  const lengths = chunks.map((c) => c.length);

  assert.ok(chunks.length >= 2);
  assert.ok(
    Math.min(...lengths) > Math.max(...lengths) / 2,
    `chunks are lopsided: ${lengths.join(", ")}`
  );
  assert.ok(Math.max(...lengths) <= 200);
});

test("drops the overlap rather than blow the limit", () => {
  const transcript = ["one line aaa", "two line bbb", "three line ccc"].join("\n");
  const chunks = chunkTranscript(transcript, 26, 1);

  // The carried-over line plus the next one would be 27 chars, so the overlap goes.
  assert.deepEqual(chunks, ["one line aaa\ntwo line bbb", "three line ccc"]);
});

test("respects the character limit", () => {
  const transcript = Array.from({ length: 40 }, (_, i) => `Speaker ${i}: line number ${i}`).join("\n");
  chunkTranscript(transcript, 80, 1).forEach((chunk) => {
    assert.ok(chunk.length <= 80, `chunk of ${chunk.length} chars exceeds 80`);
  });
});

test("hard-splits a single line longer than the limit", () => {
  const line = Array.from({ length: 50 }, () => "word").join(" ");
  const chunks = chunkTranscript(line, 40);

  assert.ok(chunks.length > 1);
  chunks.forEach((chunk) => assert.ok(chunk.length <= 40));
  assert.equal(chunks.join(" ").split(/\s+/).length, 50);
});

test("always makes progress even when overlap fills the budget", () => {
  const transcript = Array.from({ length: 10 }, (_, i) => `line ${i} padded out`).join("\n");
  const chunks = chunkTranscript(transcript, 20, 5);

  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((chunk) => chunk.trim().length > 0));
  assert.ok(chunks.some((chunk) => chunk.includes("line 9")));
});
