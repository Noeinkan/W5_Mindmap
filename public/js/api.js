/** Talks to the server: streamed extraction (SSE) with a plain-JSON fallback. */

const API_TIMEOUT_MS = 60000;

/**
 * @param {string} transcript
 * @param {{onStatus:Function, onGraph:Function, onDone:Function, onError:Function}} handlers
 */
export async function generateMindMap(transcript, handlers) {
  const { onStatus, onGraph, onDone, onError } = handlers;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch("/api/extract/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      await handlePlainResponse(response, { onGraph, onDone, onError });
      return;
    }

    await readSseStream(response, { onStatus, onGraph, onDone, onError });
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    onError(
      aborted
        ? "The model took too long to answer. Is Ollama running?"
        : (err && err.message) || String(err || "Unknown error")
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handlePlainResponse(response, { onGraph, onDone, onError }) {
  if (response && response.ok) {
    onGraph(await response.json());
    onDone();
    return;
  }
  onError(await describeFailure(response));
}

async function describeFailure(response) {
  const text = response ? await response.text() : "";
  let message = "Request failed";
  let extras = "";
  try {
    const json = JSON.parse(text);
    message = json.error || message;
    if (json.details) extras += ` (${json.details})`;
    if (json.code) extras += ` [${json.code}]`;
  } catch {
    if (text) message = text;
  }
  const status = response ? response.status : 0;
  return `${status ? `${status} — ` : ""}${message}${extras}`;
}

async function readSseStream(response, handlers) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let splitIndex;
    while ((splitIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, splitIndex).trim();
      buffer = buffer.slice(splitIndex + 2);
      if (rawEvent) dispatchSseEvent(rawEvent, handlers);
    }
  }
}

function dispatchSseEvent(rawEvent, { onStatus, onGraph, onDone, onError }) {
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

  switch (eventName) {
    case "status":
    case "progress":
      if (data.message) onStatus(data.message);
      break;
    case "graph":
      onGraph(data || {});
      break;
    case "done":
      onDone();
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
