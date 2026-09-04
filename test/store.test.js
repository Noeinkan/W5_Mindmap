"use strict";

/** The file-backed library of saved maps. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createStore, isValidId } = require("../lib/store");

let dir;
let store;

test.beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mindmap-store-"));
  store = createStore({ dir });
});

test.afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const document = (title = "Kickoff") => ({
  version: 1,
  title,
  transcript: "PM: The EIR was never issued.",
  nodes: [
    { id: "n1", label: "EIR Problems", type: "cause" },
    { id: "n2", label: "Handover Data", type: "theme" }
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", type: "causes" }]
});

test("a saved map comes back whole, transcript included", async () => {
  const created = await store.create(document());
  const read = await store.read(created.id);

  assert.match(created.id, /^g_/);
  assert.equal(read.title, "Kickoff");
  assert.equal(read.nodes.length, 2);
  assert.equal(read.transcript, "PM: The EIR was never issued.");
  assert.equal(read.createdAt, read.updatedAt);
});

test("an empty library is an empty list, not a crash", async () => {
  const missingDir = createStore({ dir: path.join(dir, "not-created-yet") });

  assert.deepEqual(await missingDir.list(), []);
});

test("the list summarises without carrying the whole map", async () => {
  await store.create(document("First"));
  const [summary] = await store.list();

  assert.equal(summary.title, "First");
  assert.equal(summary.nodeCount, 2);
  assert.equal(summary.edgeCount, 1);
  assert.equal(summary.hasTranscript, true);
  assert.equal(summary.nodes, undefined, "the list is a menu, not the meal");
});

test("the newest map is listed first", async () => {
  const first = await store.create(document("Older"));
  await store.create(document("Newer"));
  // Two writes inside the same millisecond would tie on updatedAt.
  await store.rename(first.id, "Older, touched last");

  assert.deepEqual((await store.list()).map((g) => g.title), ["Older, touched last", "Newer"]);
});

test("saving over a map keeps its id and its birthday", async () => {
  const created = await store.create(document());
  await new Promise((resolve) => setTimeout(resolve, 5));

  const replaced = await store.replace(created.id, { ...document("Same map, more nodes"), nodes: [] });

  assert.equal(replaced.id, created.id);
  assert.equal(replaced.createdAt, created.createdAt);
  assert.notEqual(replaced.updatedAt, created.updatedAt);
  assert.equal((await store.read(created.id)).title, "Same map, more nodes");
});

test("renaming touches the title and nothing else", async () => {
  const created = await store.create(document());
  const renamed = await store.rename(created.id, "Renamed");

  assert.equal(renamed.title, "Renamed");
  assert.equal(renamed.nodes.length, 2);
  assert.equal(renamed.transcript, created.transcript);
});

test("deleting is final, and saying so twice is not an error the second time", async () => {
  const created = await store.create(document());

  assert.equal(await store.remove(created.id), true);
  assert.equal(await store.remove(created.id), false);
  assert.equal(await store.read(created.id), null);
});

test("an id that is not one of ours never reaches the filesystem", async () => {
  assert.equal(isValidId("g_abc_def"), true);
  for (const id of ["../../etc/passwd", "g_abc/../x", "", null, "graph.json"]) {
    assert.equal(isValidId(id), false);
    assert.equal(await store.read(id), null);
    assert.equal(await store.remove(id), false);
  }
});

test("missing is null and corrupt is loud — they are not the same problem", async () => {
  assert.equal(await store.read("g_nope_nope"), null);

  await fs.writeFile(path.join(dir, "g_broken_file.json"), "{ half a fi", "utf8");
  await assert.rejects(() => store.read("g_broken_file"), /corrupt/);
});

test("one unreadable file does not take the whole library down", async () => {
  await store.create(document("Fine"));
  await fs.writeFile(path.join(dir, "g_broken_file.json"), "{ half a fi", "utf8");
  await fs.writeFile(path.join(dir, "notes.txt"), "not a map at all", "utf8");

  assert.deepEqual((await store.list()).map((g) => g.title), ["Fine"]);
});
