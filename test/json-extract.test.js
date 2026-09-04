"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractJson, parseGraphResponse } = require("../lib/json-extract");

test("extractJson takes a bare object as is", () => {
  assert.equal(extractJson('{"nodes":[]}'), '{"nodes":[]}');
});

test("extractJson unwraps a markdown fence", () => {
  const text = 'Here you go:\n```json\n{"nodes":[],"edges":[]}\n```\nHope that helps.';
  assert.equal(extractJson(text), '{"nodes":[],"edges":[]}');
});

test("extractJson falls back to the outermost braces", () => {
  assert.equal(extractJson('sure! {"a":{"b":1}} done'), '{"a":{"b":1}}');
});

test("extractJson gives up on prose", () => {
  assert.equal(extractJson("I could not find any concepts."), null);
  assert.equal(extractJson(""), null);
});

test("parseGraphResponse accepts an object response", () => {
  const result = parseGraphResponse({ response: { nodes: [], edges: [] } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { nodes: [], edges: [] });
});

test("parseGraphResponse accepts a JSON string response", () => {
  const result = parseGraphResponse({ response: '{"nodes":[],"edges":[]}' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { nodes: [], edges: [] });
});

test("parseGraphResponse reports malformed JSON instead of throwing", () => {
  const result = parseGraphResponse({ response: '{"nodes":[,]}' });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_json");
});

test("parseGraphResponse reports prose as no_json", () => {
  const result = parseGraphResponse({ response: "Nothing to extract." });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no_json");
});

test("parseGraphResponse accepts a body that is already the graph", () => {
  const result = parseGraphResponse({ nodes: [{ id: "n1", label: "A" }], edges: [] });
  assert.equal(result.ok, true);
  assert.equal(result.value.nodes.length, 1);
});
