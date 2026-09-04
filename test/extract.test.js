"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractGraph } = require("../lib/extract");
const { UpstreamError } = require("../lib/ollama");
const { loadConfig } = require("../lib/config");

const config = loadConfig({
  TRANSCRIPT_CHUNK_SIZE: "40",
  TRANSCRIPT_CHUNK_OVERLAP_LINES: "0",
  CHUNK_PARSE_RETRIES: "1"
});

const TRANSCRIPT = [
  "PM: The EIR was never issued properly.",
  "IM: So handover data is inconsistent.",
  "PM: We should run a capability check."
].join("\n");

/** A stand-in for the Ollama client: one scripted answer per call. */
function fakeClient(answers) {
  const prompts = [];
  return {
    prompts,
    generate: async (prompt) => {
      prompts.push(prompt);
      const answer = answers[prompts.length - 1];
      if (answer instanceof Error) throw answer;
      return { response: typeof answer === "string" ? answer : JSON.stringify(answer) };
    }
  };
}

const graphFor = (prefix, labels) => ({
  nodes: labels.map((label, i) => ({ id: `${prefix}n${i + 1}`, label, type: "theme" })),
  edges: labels.length > 1
    ? [{ id: `${prefix}e1`, from: `${prefix}n1`, to: `${prefix}n2`, type: "relates" }]
    : []
});

test("merges every chunk into one graph", async () => {
  const client = fakeClient([
    graphFor("c1_", ["EIR Problems", "Handover Data"]),
    graphFor("c2_", ["Handover data", "Capability Check"]),
    graphFor("c3_", ["Capability check"])
  ]);

  const result = await extractGraph({ transcript: TRANSCRIPT, config, client });

  assert.equal(result.chunks, 3);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.nodes.map((n) => n.label),
    ["EIR Problems", "Handover Data", "Capability Check"]
  );
});

test("a chunk the model botches is skipped, not fatal", async () => {
  const client = fakeClient([
    graphFor("c1_", ["EIR Problems"]),
    "I am sorry, I cannot do that.",
    "still not JSON",
    graphFor("c3_", ["Capability Check"])
  ]);

  const result = await extractGraph({ transcript: TRANSCRIPT, config, client });

  assert.deepEqual(result.nodes.map((n) => n.label), ["EIR Problems", "Capability Check"]);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].chunk, 2);
  assert.equal(result.warnings[0].code, "no_json");
});

test("a botched chunk gets one stricter retry before being skipped", async () => {
  const client = fakeClient([
    "prose, not JSON",
    graphFor("c1_", ["EIR Problems"]),
    graphFor("c2_", ["Handover Data"]),
    graphFor("c3_", ["Capability Check"])
  ]);

  const result = await extractGraph({ transcript: TRANSCRIPT, config, client });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.nodes.length, 3);
  assert.match(client.prompts[1], /previous answer was not valid JSON/);
});

test("an empty object is a valid empty answer, re-asked once", async () => {
  const client = fakeClient([
    {},
    graphFor("c1_", ["EIR Problems"]),
    graphFor("c2_", ["Handover Data"]),
    graphFor("c3_", ["Capability Check"])
  ]);

  const result = await extractGraph({ transcript: TRANSCRIPT, config, client });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.nodes.length, 3);
  assert.match(client.prompts[1], /contained no nodes/);
  assert.doesNotMatch(client.prompts[1], /not valid JSON/);
});

test("a chunk that stays empty is reported as empty, not as a schema error", async () => {
  const client = fakeClient([
    {},
    { nodes: [], edges: [] },
    graphFor("c2_", ["Handover Data"]),
    graphFor("c3_", ["Capability Check"])
  ]);

  const result = await extractGraph({ transcript: TRANSCRIPT, config, client });

  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "empty_chunk");
  assert.equal(result.nodes.length, 2);
});

test("all chunks failing is an error, not an empty map", async () => {
  const client = fakeClient(Array(8).fill("no JSON here"));

  await assert.rejects(
    () => extractGraph({ transcript: TRANSCRIPT, config, client }),
    (err) => err instanceof UpstreamError && err.code === "no_json"
  );
});

test("a transport failure aborts the run instead of grinding through every chunk", async () => {
  const client = fakeClient([new UpstreamError("Ollama request failed", "ollama_failed")]);

  await assert.rejects(
    () => extractGraph({ transcript: TRANSCRIPT, config, client }),
    (err) => err.code === "ollama_failed"
  );
  assert.equal(client.prompts.length, 1, "no further chunks attempted");
});

test("a transport failure mid-run keeps the chunks already done", async () => {
  const client = fakeClient([
    graphFor("c1_", ["EIR Problems"]),
    new UpstreamError("Ollama request failed", "ollama_failed", "connect ECONNREFUSED")
  ]);

  const result = await extractGraph({ transcript: TRANSCRIPT, config, client });

  assert.deepEqual(result.nodes.map((n) => n.label), ["EIR Problems"]);
  assert.equal(result.partial, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "ollama_failed");
  assert.equal(result.warnings[0].chunk, 2);
  // Chunk 3 and the linking pass are not attempted against a model that just died.
  assert.equal(client.prompts.length, 2);
});

test("concepts already found are fed back into the next prompt", async () => {
  const client = fakeClient([
    graphFor("c1_", ["EIR Problems"]),
    graphFor("c2_", ["Handover Data"]),
    graphFor("c3_", ["Capability Check"])
  ]);

  await extractGraph({ transcript: TRANSCRIPT, config, client });

  assert.doesNotMatch(client.prompts[0], /already found/);
  assert.match(client.prompts[1], /- EIR Problems/);
  assert.match(client.prompts[2], /- Handover Data/);
});

test("finishes by connecting the concepts found in different chunks", async () => {
  const client = fakeClient([
    graphFor("c1_", ["EIR Problems", "Handover Data"]),
    graphFor("c2_", ["Capability Check", "CDE Naming"]),
    graphFor("c3_", ["Data Drops", "Model Validation"]),
    // The linking pass, which sees only the concept list.
    { edges: [{ id: "l1", from: "c1_n1", to: "c2_n1", type: "causes" }] }
  ]);

  const result = await extractGraph({ transcript: TRANSCRIPT, config, client });

  assert.equal(client.prompts.length, 4);
  assert.match(client.prompts[3], /Group 1:/);
  assert.doesNotMatch(client.prompts[3], /Transcript chunk/);
  assert.ok(
    result.edges.some((e) => e.from === "c1_n1" && e.to === "c2_n1"),
    "the crossing edge made it into the map"
  );
});

test("LINK_PASS=0 leaves the islands alone", async () => {
  const client = fakeClient([
    graphFor("c1_", ["EIR Problems", "Handover Data"]),
    graphFor("c2_", ["Capability Check", "CDE Naming"]),
    graphFor("c3_", ["Data Drops", "Model Validation"])
  ]);

  await extractGraph({
    transcript: TRANSCRIPT,
    config: { ...config, linkPass: false },
    client
  });

  assert.equal(client.prompts.length, 3);
});

test("streams a growing graph, one event per chunk", async () => {
  const client = fakeClient([
    graphFor("c1_", ["EIR Problems"]),
    graphFor("c2_", ["Handover Data"]),
    graphFor("c3_", ["Capability Check"])
  ]);

  const events = [];
  await extractGraph({
    transcript: TRANSCRIPT,
    config,
    client,
    onEvent: (event) => events.push(event)
  });

  const graphs = events.filter((e) => e.type === "graph");
  assert.deepEqual(graphs.map((g) => g.nodes.length), [1, 2, 3]);
  assert.equal(events.filter((e) => e.type === "progress").length, 3);
  assert.equal(events[0].type, "status");
});

test("cancelling stops the run where it is", async () => {
  const client = fakeClient([
    graphFor("c1_", ["EIR Problems"]),
    graphFor("c2_", ["Handover Data"]),
    graphFor("c3_", ["Capability Check"])
  ]);

  let calls = 0;
  const result = await extractGraph({
    transcript: TRANSCRIPT,
    config,
    client,
    isCancelled: () => {
      calls += 1;
      return calls > 2;
    }
  });

  assert.equal(client.prompts.length, 2);
  assert.equal(result.nodes.length, 2);
});

test("an empty transcript yields an empty graph, not an error", async () => {
  const client = fakeClient([]);
  const result = await extractGraph({ transcript: "   ", config, client });

  assert.deepEqual(result.nodes, []);
  assert.equal(result.chunks, 0);
});
