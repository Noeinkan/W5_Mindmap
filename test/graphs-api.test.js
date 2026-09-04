"use strict";

/**
 * The saved-map routes, run against the real Express app with the store pointed
 * at a temporary directory. No Ollama here: nothing under /api/graphs talks to
 * the model.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

let baseUrl;
let appServer;
let storeDir;

test.before(async () => {
  storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mindmap-api-"));
  process.env.GRAPH_STORE_DIR = storeDir;

  const { app } = require("../server");
  appServer = http.createServer(app);
  await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => appServer.close(resolve));
  await fs.rm(storeDir, { recursive: true, force: true });
});

const send = (method, url, body) =>
  fetch(`${baseUrl}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

const document = (overrides = {}) => ({
  version: 1,
  title: "Client kickoff",
  transcript: "PM: The EIR was never issued.\nIM: So handover data is inconsistent.",
  nodes: [
    { id: "n1", label: "EIR Problems", type: "cause", quote: "The EIR was never issued." },
    // Dragged by hand, which is what `pinned` records — the coordinates of a
    // node the layout placed itself are not saved.
    { id: "n2", label: "Handover Data", type: "theme", pinned: true, x: 40, y: -10 }
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", type: "causes" }],
  ...overrides
});

test("a map is saved, listed, and read back with its transcript", async () => {
  const created = await send("POST", "/api/graphs", document()).then((r) => r.json());

  assert.match(created.id, /^g_/);
  assert.equal(created.nodeCount, 2);
  assert.equal(created.hasTranscript, true);

  const { graphs } = await send("GET", "/api/graphs").then((r) => r.json());
  assert.ok(graphs.some((g) => g.id === created.id && g.title === "Client kickoff"));

  const read = await send("GET", `/api/graphs/${created.id}`).then((r) => r.json());
  assert.equal(read.transcript, document().transcript);
  assert.equal(read.nodes[0].quote, "The EIR was never issued.");
  // The position of the node its author dragged is part of the saved map.
  assert.deepEqual([read.nodes[1].x, read.nodes[1].y], [40, -10]);
});

test("what is not a mind map is a 400 that says which field is wrong", async () => {
  const response = await send("POST", "/api/graphs", { title: "No nodes key" });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, "invalid_document");
  assert.match(body.details.join(" "), /nodes/);
});

test("an empty map is refused rather than filed as one", async () => {
  const response = await send("POST", "/api/graphs", document({ nodes: [], edges: [] }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "empty_document");
});

test("the server drops the rows the browser would have dropped", async () => {
  const created = await send(
    "POST",
    "/api/graphs",
    document({ edges: [{ id: "e1", from: "n1", to: "nowhere", type: "causes" }] })
  ).then((r) => r.json());

  const read = await send("GET", `/api/graphs/${created.id}`).then((r) => r.json());
  assert.deepEqual(read.edges, [], "an edge with no far end is not saved");
});

test("saving over a map keeps its id and replaces its content", async () => {
  const created = await send("POST", "/api/graphs", document()).then((r) => r.json());

  const updated = await send("PUT", `/api/graphs/${created.id}`, {
    ...document({ title: "Client kickoff, tidied" }),
    edges: []
  }).then((r) => r.json());

  assert.equal(updated.id, created.id);
  assert.equal(updated.edgeCount, 0);
  assert.equal((await send("GET", `/api/graphs/${created.id}`).then((r) => r.json())).title, "Client kickoff, tidied");
});

test("renaming changes the title and leaves the map alone", async () => {
  const created = await send("POST", "/api/graphs", document()).then((r) => r.json());

  const renamed = await send("PATCH", `/api/graphs/${created.id}`, { title: "Handover review" }).then((r) => r.json());
  assert.equal(renamed.title, "Handover review");
  assert.equal(renamed.nodeCount, 2);

  const blank = await send("PATCH", `/api/graphs/${created.id}`, { title: "   " });
  assert.equal(blank.status, 400);
  assert.equal((await blank.json()).code, "bad_request");
});

test("a deleted map is gone, and deleting it again is a 404", async () => {
  const created = await send("POST", "/api/graphs", document()).then((r) => r.json());

  assert.equal((await send("DELETE", `/api/graphs/${created.id}`)).status, 200);
  assert.equal((await send("GET", `/api/graphs/${created.id}`)).status, 404);
  assert.equal((await send("DELETE", `/api/graphs/${created.id}`)).status, 404);
});

test("an id that is not one of ours is refused before any file is touched", async () => {
  for (const id of ["nope", "graph.json", "..%2F..%2Fserver.js"]) {
    const response = await send("GET", `/api/graphs/${id}`);
    assert.equal(response.status, 400, `expected 400 for ${id}`);
    assert.equal((await response.json()).code, "bad_request");
  }
});

test("a map missing from disk is a 404, not a 500", async () => {
  const response = await send("PUT", "/api/graphs/g_nope_nope", document());

  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "not_found");
});
