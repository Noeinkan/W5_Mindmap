"use strict";

/**
 * The /api/ingest route, against the real Express app. No Ollama here: reading a
 * file never touches the model.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { makeEpub, makeZip, makeTextPdf, drawText } = require("./fixtures");

let baseUrl;
let appServer;
let storeDir;

test.before(async () => {
  storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mindmap-ingest-"));
  process.env.GRAPH_STORE_DIR = storeDir;
  // Small enough to test the refusal without sending megabytes at it.
  process.env.INGEST_MAX_BYTES = String(64 * 1024);

  const { app } = require("../server");
  appServer = http.createServer(app);
  await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => appServer.close(resolve));
  await fs.rm(storeDir, { recursive: true, force: true });
  delete process.env.INGEST_MAX_BYTES;
});

const send = (body, name = "file.bin") =>
  fetch(`${baseUrl}/api/ingest?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body
  });

test("a PDF comes back as a transcript with its sections", async () => {
  const pdf = makeTextPdf(
    [
      drawText(72, 720, "Front page of the post-appointment BEP for the project"),
      drawText(72, 720, "1. Introduction") + drawText(72, 690, "The project begins here with information requirements."),
      drawText(72, 720, "2. Delivery") + drawText(72, 690, "The information is delivered against the milestones.")
    ],
    { compress: true }
  );

  const response = await send(pdf, "bep.pdf");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.kind, "pdf");
  assert.equal(body.name, "bep.pdf");
  assert.equal(body.units, 3);
  assert.equal(body.unitLabel, "page");
  assert.equal(body.chars, body.text.length);
  assert.match(body.text, /post-appointment BEP/);
  // The chunk size travels with the answer so the section list can price a run.
  assert.equal(typeof body.chunkSize, "number");

  assert.deepEqual(
    body.sections.map((section) => section.title),
    ["Front matter", "1 Introduction", "2 Delivery"]
  );
  const first = body.text.slice(body.sections[1].start, body.sections[1].end);
  assert.match(first, /information requirements/);
});

test("an EPUB comes back as chapters", async () => {
  const epub = makeEpub({
    title: "A Short Book",
    chapters: [
      { title: "Beginnings", html: "<p>The first chapter says quite enough to be worth reading.</p>" },
      { title: "Endings", html: "<p>The second chapter says something else entirely, at length.</p>" }
    ]
  });

  const body = await send(epub, "book.epub").then((r) => r.json());
  assert.equal(body.kind, "epub");
  assert.equal(body.title, "A Short Book");
  assert.deepEqual(
    body.sections.map((section) => section.title),
    ["Beginnings", "Endings"]
  );
});

test("a file that is not a document is refused with a reason and a code", async () => {
  const response = await send(makeZip([{ name: "notes.txt", data: "hello" }]), "stuff.zip");
  const body = await response.json();

  assert.equal(response.status, 415);
  assert.equal(body.code, "unsupported_file");
  assert.match(body.error, /ZIP archive/);
});

test("a scan is refused as a scan", async () => {
  const response = await send(makeTextPdf(["q Q\n"]), "scan.pdf");
  const body = await response.json();

  assert.equal(response.status, 422);
  assert.equal(body.code, "no_text");
  assert.match(body.error, /OCR/);
});

test("a file past the size limit is refused by size, not by parsing it", async () => {
  const tooBig = Buffer.alloc(80 * 1024, 0x41);
  const response = await send(tooBig, "huge.pdf");
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.code, "file_too_large");
  assert.match(body.error, /bigger than the \d+ MB limit/);
});

test("a request with no body at all is a plain bad request", async () => {
  const response = await send(Buffer.alloc(0), "nothing.pdf");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "empty_file");
});

test("reading a file leaves the other routes alone", async () => {
  // The raw body parser is mounted on this route only: JSON still works next to
  // it, which is the thing a shared `express.raw` would quietly break.
  const response = await fetch(`${baseUrl}/api/graphs`);
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).graphs));
});
