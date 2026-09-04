"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// A stub standing in for Ollama, started before server.js is loaded so the app
// picks it up through OLLAMA_URL.
let upstream;
let handleUpstream = () => ({ nodes: [], edges: [] });

const startServer = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const stopServer = (server) => new Promise((resolve) => server.close(resolve));

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => resolve(raw));
  });

let baseUrl;
let app;
let appServer;

test.before(async () => {
  upstream = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const result = await handleUpstream(req.url, body);
    res.writeHead(result.status || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body !== undefined ? result.body : result));
  });
  const upstreamPort = await startServer(upstream);

  process.env.OLLAMA_URL = `http://127.0.0.1:${upstreamPort}`;
  process.env.OLLAMA_MODEL = "test-model:1b";
  process.env.TRANSCRIPT_CHUNK_SIZE = "45";
  process.env.TRANSCRIPT_CHUNK_OVERLAP_LINES = "0";
  process.env.OLLAMA_RETRIES = "0";
  process.env.CHUNK_PARSE_RETRIES = "0";
  // Real runs heartbeat every 10 s; here we want a ping inside a 150 ms test.
  process.env.SSE_HEARTBEAT_MS = "25";

  ({ app } = require("../server"));
  appServer = http.createServer(app);
  const appPort = await startServer(appServer);
  baseUrl = `http://127.0.0.1:${appPort}`;
});

test.after(async () => {
  await stopServer(appServer);
  await stopServer(upstream);
});

const TRANSCRIPT = ["PM: The EIR was never issued.", "IM: So handover data is inconsistent."].join("\n");

const graphResponse = (labels, prefix) => ({
  response: JSON.stringify({
    nodes: labels.map((label, i) => ({ id: `${prefix}n${i + 1}`, label, type: "theme" })),
    edges: []
  })
});

test("health reports Ollama and the configured model", async () => {
  handleUpstream = () => ({ body: { models: [{ name: "test-model:1b" }] } });

  const data = await fetch(`${baseUrl}/api/health`).then((r) => r.json());

  assert.equal(data.ok, true);
  assert.equal(data.ready, true);
  assert.equal(data.ollama.model, "test-model:1b");
});

test("health says not ready when the model is missing", async () => {
  handleUpstream = () => ({ body: { models: [{ name: "something-else" }] } });

  const data = await fetch(`${baseUrl}/api/health`).then((r) => r.json());

  assert.equal(data.ready, false);
  assert.equal(data.ollama.reachable, true);
  assert.equal(data.ollama.modelAvailable, false);
});

test("the sample transcript is served to the browser", async () => {
  const response = await fetch(`${baseUrl}/samples/client-kickoff.txt`);

  assert.equal(response.status, 200);
  assert.ok((await response.text()).trim().length > 0);
});

test("an empty transcript is a 400, not an upstream call", async () => {
  let called = false;
  handleUpstream = () => {
    called = true;
    return { body: {} };
  };

  const response = await fetch(`${baseUrl}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: "  " })
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "bad_request");
  assert.equal(called, false);
});

test("POST /api/extract returns one merged graph across chunks", async () => {
  let call = 0;
  handleUpstream = () => {
    call += 1;
    return call === 1
      ? { body: graphResponse(["EIR Problems", "Handover Data"], "c1_") }
      : { body: graphResponse(["handover data", "Capability Check"], "c2_") };
  };

  const data = await fetch(`${baseUrl}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: TRANSCRIPT })
  }).then((r) => r.json());

  assert.equal(data.chunks, 2);
  assert.deepEqual(data.nodes.map((n) => n.label), [
    "EIR Problems",
    "Handover Data",
    "Capability Check"
  ]);
  assert.ok(data.requestId);
});

test("a dead Ollama is a 502 with an actionable code", async () => {
  handleUpstream = () => ({ status: 500, body: { error: "boom" } });

  const response = await fetch(`${baseUrl}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: TRANSCRIPT })
  });

  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "ollama_failed");
});

test("the stream emits status, progress, growing graphs and done", async () => {
  let call = 0;
  handleUpstream = () => {
    call += 1;
    return call === 1
      ? { body: graphResponse(["EIR Problems"], "c1_") }
      : { body: graphResponse(["Handover Data"], "c2_") };
  };

  const response = await fetch(`${baseUrl}/api/extract/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: TRANSCRIPT })
  });

  assert.equal(response.headers.get("content-type"), "text/event-stream");

  const events = parseSse(await response.text());
  assert.equal(events[0].event, "status");
  assert.deepEqual(
    events.filter((e) => e.event === "graph").map((e) => e.data.nodes.length),
    [1, 2]
  );
  assert.equal(events[events.length - 1].event, "done");
  assert.deepEqual(events[events.length - 1].data.warnings, []);
});

test("the stream skips a botched chunk and reports it as a warning", async () => {
  let call = 0;
  handleUpstream = () => {
    call += 1;
    return call === 1
      ? { body: { response: "I am sorry, I cannot do that." } }
      : { body: graphResponse(["Handover Data"], "c2_") };
  };

  const response = await fetch(`${baseUrl}/api/extract/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: TRANSCRIPT })
  });

  const events = parseSse(await response.text());
  const warnings = events.filter((e) => e.event === "warning");

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].data.chunk, 1);
  assert.equal(events.filter((e) => e.event === "graph").length, 1);
  assert.equal(events[events.length - 1].event, "done");
});

test("a slow model still puts bytes on the wire, so the browser knows it is alive", async () => {
  handleUpstream = async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { body: graphResponse(["EIR Problems"], "c1_") };
  };

  const text = await fetch(`${baseUrl}/api/extract/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: TRANSCRIPT })
  }).then((r) => r.text());

  assert.ok(/^: ping /m.test(text), "no heartbeat in the stream");
  // The comment is a heartbeat, not an event: the parser must not see it as one.
  const events = parseSse(text);
  assert.equal(events[events.length - 1].event, "done");
});

test("a mid-run Ollama failure ends in done-with-warning, keeping the partial map", async () => {
  let call = 0;
  handleUpstream = () => {
    call += 1;
    return call === 1
      ? { body: graphResponse(["EIR Problems"], "c1_") }
      : { status: 500, body: { error: "boom" } };
  };

  const text = await fetch(`${baseUrl}/api/extract/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: TRANSCRIPT })
  }).then((r) => r.text());

  const events = parseSse(text);
  const last = events[events.length - 1];

  assert.equal(events.filter((e) => e.event === "error").length, 0);
  assert.equal(events.filter((e) => e.event === "graph").length, 1);
  assert.equal(last.event, "done");
  assert.equal(last.data.partial, true);
  assert.equal(last.data.warnings.length, 1);
  assert.equal(last.data.warnings[0].code, "ollama_failed");
});

function parseSse(text) {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith(":"))
    .map((block) => {
      const event = (block.match(/^event: (.*)$/m) || [])[1];
      const data = (block.match(/^data: (.*)$/m) || [])[1];
      return { event, data: JSON.parse(data) };
    });
}
