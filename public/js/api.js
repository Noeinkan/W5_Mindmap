/** Talks to the server: streamed extraction (SSE) with a plain-JSON fallback. */

// Two budgets, not one. Opening the request has to be quick — the server flushes the
// SSE headers before it goes anywhere near the model. After that a run is minutes
// long (one model call per chunk, ~17 s each on a warm gemma3:4b), so a single total
// deadline kills healthy runs: that is what used to blame Ollama at 60 s while the
// map was still being built. What we watch instead is silence. The server heartbeats
// every few seconds, so nothing arriving for this long means the run is really stuck.
const CONNECT_TIMEOUT_MS = 20000;
const IDLE_TIMEOUT_MS = 45000;

/**
 * @param {string} transcript
 * @param {{onStatus:Function, onGraph:Function, onDone:Function, onError:Function, onEvent?:Function}} handlers
 *   `onEvent` sees every pipeline event verbatim — the server's own, plus the
 *   client-side ones (request opened, stream closed) that the status line never
 *   had a place for. It is what feeds the activity log.
 * @param {{connectTimeoutMs?:number, idleTimeoutMs?:number}} [options] Overridable for tests.
 */
export async function generateMindMap(transcript, handlers, options = {}) {
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  const controller = new AbortController();
  const run = { graphs: 0, done: false, stalled: false, reported: false, idleTimeoutMs };

  let timer = null;
  const watch = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      run.stalled = true;
      controller.abort();
    }, ms);
  };

  const emit = handlers.onEvent || (() => {});
  /** A line that only the browser knows about, phrased like a server event. */
  const client = (message, extra = {}) => emit({ type: "client", message, ...extra });

  const tracked = {
    onStatus: handlers.onStatus,
    onEvent: emit,
    onGraph: (data) => {
      run.graphs += 1;
      handlers.onGraph(data);
    },
    onDone: (result) => {
      run.done = true;
      handlers.onDone(result || {});
    },
    onError: (message, meta) => {
      run.reported = true;
      handlers.onError(message, meta || { partial: run.graphs > 0 });
    }
  };

  watch(connectTimeoutMs);

  try {
    client(`POST /api/extract/stream — ${transcript.length.toLocaleString()} characters sent`);
    const response = await fetch("/api/extract/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      clearTimeout(timer);
      client(`Server answered ${response ? response.status : 0} without a stream — reading it as plain JSON`);
      await handlePlainResponse(response, tracked);
      return;
    }

    client("Stream open — waiting for the first chunk");
    await readSseStream(response, tracked, () => watch(idleTimeoutMs));
    client("Stream closed by the server");

    // A stream can end without a `done` event: the server process died, a proxy cut
    // the connection, the laptop slept. Saying so beats leaving the status line
    // stuck on "Building the map…" forever.
    if (!run.done && !run.reported) {
      const message = incompleteMessage(run);
      client(message, { kind: "error" });
      tracked.onError(message);
    }
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    if (aborted && run.stalled) {
      client(`Nothing arrived for ${Math.round(idleTimeoutMs / 1000)}s — the request was given up on`, {
        kind: "error"
      });
    }
    if (!run.reported) {
      const message = aborted
        ? incompleteMessage(run)
        : (err && err.message) || String(err || "Unknown error");
      // Failures the browser decides on its own never travel as SSE events, so
      // without this line the log would end mid-run with no verdict.
      client(message, { kind: "error" });
      tracked.onError(message);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why the run stopped, in words that point at the right thing to check. The old
 * single message blamed Ollama for every abort, including the ones caused by the
 * browser's own deadline.
 */
function incompleteMessage(run) {
  const seconds = Math.round(run.idleTimeoutMs / 1000);
  if (run.stalled && run.graphs) {
    return `The server went quiet for ${seconds}s — the map on screen is partial. Check the server window for the chunk it stopped on.`;
  }
  if (run.stalled) {
    return "No answer from the server. Is it running (npm run dev), and is Ollama up (ollama serve)?";
  }
  if (run.graphs) {
    return "The connection closed before the map was finished — what you see is partial.";
  }
  return "The connection closed before the model answered.";
}

async function handlePlainResponse(response, { onGraph, onDone, onError, onEvent = () => {} }) {
  if (response && response.ok) {
    const data = await response.json();
    onEvent({ type: "graph", ...data });
    onGraph(data);
    const done = { warnings: data.warnings, chunks: data.chunks };
    onEvent({ type: "done", ...done });
    onDone(done);
    return;
  }
  const failure = await describeFailure(response);
  onEvent({ type: "error", error: failure });
  onError(failure, { partial: false });
}

async function describeFailure(response) {
  const text = response ? await response.text() : "";
  let message = "Request failed";
  let extras = "";
  try {
    const json = JSON.parse(text);
    message = json.error || message;
    // The saved-map routes answer with a list of reasons, one per broken field.
    if (json.details) {
      extras += ` (${Array.isArray(json.details) ? json.details.join(" ") : json.details})`;
    }
    if (json.code) extras += ` [${json.code}]`;
  } catch {
    if (text) message = text;
  }
  const status = response ? response.status : 0;
  return `${status ? `${status} — ` : ""}${message}${extras}`;
}

async function readSseStream(response, handlers, keepAlive) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Any byte counts, heartbeats included: the point is that the server is alive.
    keepAlive();
    buffer += decoder.decode(value, { stream: true });

    let splitIndex;
    while ((splitIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, splitIndex).trim();
      buffer = buffer.slice(splitIndex + 2);
      // ":" opens an SSE comment — that is what a heartbeat is.
      if (rawEvent && !rawEvent.startsWith(":")) dispatchSseEvent(rawEvent, handlers);
    }
  }
}

function dispatchSseEvent(rawEvent, { onStatus, onGraph, onDone, onError, onEvent = () => {} }) {
  let eventName = "message";
  let dataText = "";

  rawEvent.split("\n").forEach((line) => {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataText += line.slice(5).trim();
  });

  let data;
  try {
    data = dataText ? JSON.parse(dataText) : {};
  } catch {
    data = { message: dataText };
  }

  // The log wants every event, including the ones the status line ignores
  // (warnings, retries) and the fields it drops (chunk numbers, timings).
  onEvent({ type: eventName, ...data });

  switch (eventName) {
    case "status":
    case "progress":
      if (data.message) onStatus(data.message);
      break;
    case "graph":
      onGraph(data || {});
      break;
    case "done":
      onDone(data || {});
      break;
    case "error": {
      let extras = "";
      if (data.details) extras += ` (${data.details})`;
      if (data.code) extras += ` [${data.code}]`;
      onError(`${data.error || "Extraction failed"}${extras}`);
      break;
    }
    default:
      if (data.message) onStatus(data.message);
  }
}

export async function loadSampleTranscript() {
  const response = await fetch("/samples/client-kickoff.txt");
  if (!response.ok) throw new Error("Sample transcript not available");
  return response.text();
}

/* ------------------------------------------------------------------ */
/* Saved maps                                                          */
/* ------------------------------------------------------------------ */

/**
 * One request against /api/graphs. Everything here is small and local — a few
 * kilobytes to a server on the same machine — so none of it gets the streaming
 * treatment above; what it does need is the failure turned into a sentence a
 * toast can show.
 */
async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(await describeFailure(response));
  return response.json();
}

const sending = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

const graphUrl = (id) => `/api/graphs/${encodeURIComponent(id)}`;

/** @returns {Promise<{graphs: Array<{id, title, nodeCount, edgeCount, updatedAt}>}>} */
export const listGraphs = () => request("/api/graphs");

export const readGraph = (id) => request(graphUrl(id));

export const createGraph = (doc) => request("/api/graphs", sending("POST", doc));

/** Save over a map already in the library. */
export const replaceGraph = (id, doc) => request(graphUrl(id), sending("PUT", doc));

export const renameGraph = (id, title) => request(graphUrl(id), sending("PATCH", { title }));

export const deleteGraph = (id) => request(graphUrl(id), { method: "DELETE" });
