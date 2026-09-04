"use strict";

/**
 * The activity log. Its DOM half is inert without a document — every element
 * lookup is guarded — so the part that matters here, turning a pipeline event
 * into a sentence, runs under plain node.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const loadLog = () => import("../public/js/log.js");

function freshState(startedAt = Date.now()) {
  return { startedAt, chunkStartedAt: 0, nodes: 0, edges: 0 };
}

test("the opening status names the split, the chunk size and the model", async () => {
  const { describeEvent } = await loadLog();
  const line = describeEvent(
    { type: "status", chunks: 8, chunkSize: 3500, model: "gemma3:4b", message: "Processing 8 chunk(s)..." },
    freshState()
  );
  assert.match(line.text, /split into 8 chunks/i);
  assert.match(line.text, /3,500 characters/);
  assert.match(line.text, /gemma3:4b/);
});

test("a graph event is phrased as a delta over the previous one", async () => {
  const { describeEvent } = await loadLog();
  const state = freshState();

  const first = describeEvent(
    { type: "graph", chunk: 1, total: 3, ms: 17400, nodes: new Array(5), edges: new Array(4) },
    state
  );
  assert.match(first.text, /Chunk 1\/3 answered in 17\.4 s/);
  assert.match(first.text, /\+5 nodes, \+4 connections/);
  assert.equal(first.kind, "ok");

  const second = describeEvent(
    { type: "graph", chunk: 2, total: 3, ms: 900, nodes: new Array(9), edges: new Array(7) },
    state
  );
  assert.match(second.text, /\+4 nodes, \+3 connections/);
  assert.match(second.text, /map now 9 nodes, 7 connections/);
  assert.match(second.text, /900 ms/);
});

test("a retry is a warning line that names the chunk", async () => {
  const { describeEvent } = await loadLog();
  const line = describeEvent(
    { type: "retry", chunk: 4, total: 8, attempt: 2, code: "no_json", message: "the answer was not JSON" },
    freshState()
  );
  assert.equal(line.kind, "warn");
  assert.match(line.text, /Chunk 4\/8/);
  assert.match(line.text, /asking again/);
  assert.equal(line.detail, "no_json");
});

test("warnings and errors carry their code and details into the log", async () => {
  const { describeEvent } = await loadLog();
  const warning = describeEvent(
    { type: "warning", chunk: 2, total: 3, code: "empty_chunk", message: "Chunk 2 of 3 produced no concepts.", details: "" },
    freshState()
  );
  assert.equal(warning.kind, "warn");
  assert.equal(warning.detail, "[empty_chunk]");

  const failure = describeEvent(
    { type: "error", error: "Ollama is unreachable", code: "ollama_unreachable", details: "ECONNREFUSED" },
    freshState()
  );
  assert.equal(failure.kind, "error");
  assert.match(failure.detail, /ollama_unreachable/);
  assert.match(failure.detail, /ECONNREFUSED/);
});

test("done reports the server's own timing, and reads as trouble when partial", async () => {
  const { describeEvent } = await loadLog();
  const clean = describeEvent({ type: "done", chunks: 3, warnings: [], ms: 52000 }, freshState());
  assert.equal(clean.kind, "ok");
  assert.match(clean.text, /Finished in 52\.0 s — 3 chunks/);

  const partial = describeEvent(
    { type: "done", chunks: 8, warnings: [{ message: "x" }], partial: true, ms: 125000 },
    freshState()
  );
  assert.equal(partial.kind, "warn");
  assert.match(partial.text, /Stopped early in 2 m 05 s/);
  assert.match(partial.text, /1 warning/);
});

test("an event with nothing to say produces no line", async () => {
  const { describeEvent } = await loadLog();
  assert.equal(describeEvent(null, freshState()), null);
  assert.equal(describeEvent({ type: "heartbeat" }, freshState()), null);
  assert.equal(describeEvent({ type: "status" }, freshState()), null);
});

test("the buffer keeps the run in order and hands it over as text", async () => {
  const { clearLog, logLine, logText, logRunStart, logServerEvent } = await loadLog();
  clearLog();

  logRunStart(23783);
  logServerEvent({ type: "progress", chunk: 1, total: 2, chars: 3500 });
  logLine("something failed", "error", "[boom]");

  const text = logText();
  const lines = text.split("\n");
  assert.equal(lines.length, 4); // three entries, one of them with a detail line
  assert.match(lines[0], /^\d{2}:\d{2}:\d{2}\s+START\s+Run started — 23,783 characters/);
  assert.match(lines[1], /Chunk 1\/2 sent to the model \(3,500 characters\)/);
  assert.match(lines[2], /ERROR\s+something failed/);
  assert.match(lines[3], /\[boom\]/);

  clearLog();
  assert.equal(logText(), "");
});

test("empty lines are dropped rather than logged blank", async () => {
  const { clearLog, logLine, logText } = await loadLog();
  clearLog();
  logLine("");
  logLine(null);
  assert.equal(logText(), "");
});
