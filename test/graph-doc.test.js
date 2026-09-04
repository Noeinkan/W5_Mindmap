"use strict";

/**
 * The saved document format. It is the browser's module, imported here the same
 * way the server imports it (`lib/document.js`) — so these tests cover the rules
 * on both sides at once, which is the whole reason there is only one copy of them.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeGraph } = require("../lib/graph");

let doc;

test.before(async () => {
  doc = await import("../public/js/graph-doc.js");
});

const graph = (nodes, edges = []) => ({ nodes, edges });

test("a document carries the quote, the title and the transcript", () => {
  const result = doc.toDocument({
    title: "Kickoff meeting",
    transcript: "PM: The EIR was never issued.\nIM: So handover data is inconsistent.",
    nodes: [{ id: "n1", label: "EIR Problems", type: "cause", quote: "The EIR was never issued." }],
    edges: []
  });

  assert.equal(result.version, 1);
  assert.equal(result.title, "Kickoff meeting");
  assert.equal(result.nodes[0].quote, "The EIR was never issued.");
  // Line breaks are content in a transcript, and nothing may collapse them.
  assert.ok(result.transcript.includes("\n"));
});

test("only hand-placed positions travel with the document", () => {
  const result = doc.toDocument({
    nodes: [
      { id: "n1", label: "Dragged", type: "theme", x: 12.34, y: -5, pinned: true },
      { id: "n2", label: "Laid out", type: "theme", x: 200, y: 100 }
    ]
  });

  assert.deepEqual([result.nodes[0].x, result.nodes[0].y], [12.3, -5]);
  assert.equal(result.nodes[0].pinned, true);
  assert.equal("x" in result.nodes[1], false, "the layout's own coordinates are not data");
});

test("a position placed by hand survives being read and written again", () => {
  // Once through is the import; twice is the import followed by a save, which
  // validates the document a second time. Both have to keep the coordinates.
  const once = doc.validateDocument(
    doc.toDocument({ nodes: [{ id: "n1", label: "Dragged", pinned: true, x: 8, y: 9 }] })
  ).doc;
  const twice = doc.validateDocument(once).doc;

  assert.deepEqual([twice.nodes[0].x, twice.nodes[0].y], [8, 9]);
});

test("what is not a document at all is refused, with a reason", () => {
  for (const value of [null, "nope", 42, []]) {
    const { ok, errors } = doc.validateDocument(value);
    assert.equal(ok, false);
    assert.equal(errors.length, 1);
  }

  const missingNodes = doc.validateDocument({ title: "x" });
  assert.equal(missingNodes.ok, false);
  assert.match(missingNodes.errors[0], /nodes/);
});

test("a file from a newer version of the app is refused rather than half-read", () => {
  const { ok, errors } = doc.validateDocument({ version: 99, nodes: [] });

  assert.equal(ok, false);
  assert.match(errors[0], /newer version/);
});

test("broken rows are dropped and reported, the rest of the map survives", () => {
  const { ok, warnings, doc: value } = doc.validateDocument(
    graph(
      [
        { id: "n1", label: "Kept", type: "cause" },
        { id: "n2", label: "   " },
        { label: "No id at all" },
        { id: "n1", label: "Same id twice" }
      ],
      [
        { id: "e1", from: "n1", to: "nowhere", type: "causes" },
        { id: "e2", from: "n1", to: "n1", type: "relates" }
      ]
    )
  );

  assert.equal(ok, true);
  assert.deepEqual(value.nodes.map((n) => n.id), ["n1"]);
  assert.deepEqual(value.edges, []);
  assert.equal(warnings.length, 3, "one warning per kind of problem");
});

test("types the app does not know fall back instead of failing", () => {
  const { doc: value } = doc.validateDocument(
    graph(
      [
        { id: "n1", label: "One", type: "invented" },
        { id: "n2", label: "Two", type: "CAUSE" }
      ],
      [{ id: "e1", from: "n1", to: "n2", type: "who knows" }]
    )
  );

  assert.deepEqual(value.nodes.map((n) => n.type), ["theme", "cause"]);
  assert.equal(value.edges[0].type, "relates");
});

test("a file that is not JSON says so", () => {
  const { ok, errors } = doc.readDocument("{ this is not json");

  assert.equal(ok, false);
  assert.match(errors[0], /not valid JSON/);
});

test("an exported document round-trips through the reader unchanged", () => {
  const exported = doc.toDocument({
    title: "Kickoff",
    transcript: "PM: hello.",
    nodes: [
      { id: "n1", label: "EIR Problems", type: "cause", quote: "never issued", pinned: true, x: 10, y: 20 },
      { id: "n2", label: "Handover Data", type: "theme" }
    ],
    edges: [{ id: "e1", from: "n1", to: "n2", type: "causes" }]
  });

  const { ok, warnings, doc: reread } = doc.readDocument(JSON.stringify(exported));

  assert.equal(ok, true);
  assert.deepEqual(warnings, []);
  assert.deepEqual(reread, exported);
});

test("what this accepts, the server's own sanitiser also accepts", () => {
  // The two live in different modules — this one in the browser, `lib/graph.js`
  // on the server — and the promise the app makes is that a file it exports is a
  // file the server will store. That only holds while they agree.
  const messy = graph(
    [
      { id: "n1", label: "  Spaced   out  ", type: "HIERARCHY", quote: "a quote" },
      { id: "n2", label: "Second", type: "nonsense" },
      { id: "n3", label: "" }
    ],
    [
      { id: "e1", from: "n1", to: "n2", type: "supports" },
      { id: "e2", from: "n1", to: "missing", type: "relates" }
    ]
  );

  const client = doc.validateDocument(messy).doc;
  const server = sanitizeGraph(messy);

  const shape = (g) => ({
    nodes: g.nodes.map(({ id, label, type, quote }) => ({ id, label, type, quote: quote || "" })),
    edges: g.edges.map(({ id, from, to, type }) => ({ id, from, to, type }))
  });

  assert.deepEqual(shape(client), shape(server));
});
