"use strict";

const express = require("express");
const path = require("path");

const { loadConfig } = require("./lib/config");
const { createOllamaClient } = require("./lib/ollama");
const { createGeminiClient } = require("./lib/gemini");
const { createAiClient, describeProviders } = require("./lib/provider");
const { UpstreamError } = require("./lib/upstream");
const { extractGraph } = require("./lib/extract");
const { PROMPT_MODES, DEFAULT_MODE } = require("./lib/prompt");
const { createStore } = require("./lib/store");
const { createGraphsRouter } = require("./lib/graphs-api");
const { createIngestRouter } = require("./lib/ingest-api");

const config = loadConfig();
const store = createStore({ dir: config.graphStoreDir });

/**
 * The backend for one run, chosen by the switch in the sidebar rather than fixed at
 * boot. Everything a request needs is in the body, so nothing is remembered between
 * runs on the server: two browsers can sit on different providers at once.
 *
 * A refusal here is the user's choice being impossible (no API key, an unknown
 * model), not the model failing — hence its own codes, which the routes answer 400
 * to instead of blaming the upstream with a 502.
 */
function clientForRequest(body) {
  return createAiClient(config, {
    provider: body && body.provider,
    model: body && body.model
  });
}

const isChoiceError = (err) =>
  err instanceof UpstreamError &&
  (err.code === "provider_unavailable" || err.code === "unknown_model");

/**
 * Which reading of the transcript to run: the mind map, or the chain of cause
 * and effect the flow view draws.
 *
 * Falls back rather than refusing. An unknown mode is a client sending a name
 * this server has not heard of, and answering that with a 400 would cost the
 * user a whole run over a spelling; the map they get is the default one, which
 * is the one they would have got before the modes existed.
 */
const modeForRequest = (body) => {
  const asked = String((body && body.mode) || "").trim();
  return Object.prototype.hasOwnProperty.call(PROMPT_MODES, asked) ? asked : DEFAULT_MODE;
};

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
// samples/ lives outside public/, so it needs its own mount for the client to be
// able to offer "load the sample transcript".
app.use("/samples", express.static(path.join(__dirname, "samples")));
app.use("/api/graphs", createGraphsRouter({ store }));
// Mounted before nothing in particular, but note it takes a raw body of its own:
// the JSON parser above never sees a PDF.
app.use("/api/ingest", createIngestRouter({ config }));

app.get("/api/health", async (req, res) => {
  // Both are asked, whichever is selected: the point of the screen is to say which
  // of the two is usable right now. The Gemini call is free when no key is set —
  // it answers "not configured" without going anywhere near the network.
  const [ollama, gemini] = await Promise.all([
    createOllamaClient(config).health(),
    createGeminiClient(config).health()
  ]);
  const active = config.aiProvider === "gemini" ? gemini : ollama;
  res.json({
    ok: true,
    provider: config.aiProvider,
    ollama,
    gemini,
    chunkSize: config.chunkSize,
    ready: Boolean(active.reachable && active.modelAvailable)
  });
});

// What the browser needs to draw the model switch: the providers, which of them
// can be used, and the models to offer for each.
app.get("/api/providers", async (req, res) => {
  try {
    res.json(await describeProviders(config));
  } catch (err) {
    sendError(res, 500, "Could not list the available models", String(err), "server_error", createRequestId());
  }
});

app.post("/api/extract", async (req, res) => {
  const requestId = createRequestId();
  const transcript = String((req.body && req.body.transcript) || "").trim();

  if (!transcript) {
    return sendError(res, 400, "Transcript is required.", null, "bad_request", requestId);
  }

  let client;
  try {
    client = clientForRequest(req.body);
  } catch (err) {
    if (isChoiceError(err)) {
      return sendError(res, 400, err.message, err.details, err.code, requestId);
    }
    throw err;
  }

  try {
    const result = await extractGraph({
      transcript,
      config,
      client,
      mode: modeForRequest(req.body)
    });
    res.json({ ...result, requestId });
  } catch (err) {
    if (err instanceof UpstreamError) {
      return sendError(res, 502, err.message, err.details, err.code, requestId);
    }
    sendError(res, 500, "Extraction failed", String(err), "server_error", requestId);
  }
});

app.post("/api/extract/stream", async (req, res) => {
  const requestId = createRequestId();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // nginx buffers a proxied response by default, which would hold every event back
  // until the run ends — turning a streaming map into a two-minute blank screen.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // The response socket closing is what tells us the browser walked away; the
  // request stream closes as soon as its body is read, which is far too early.
  let cancelled = false;
  res.on("close", () => {
    cancelled = true;
  });

  const sendEvent = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify({ ...data, requestId })}\n\n`);
  };

  // One chunk keeps the model busy for tens of seconds with nothing to report. An
  // SSE comment every few seconds is what tells the browser the silence is work and
  // not a dead server; unref'd so it never holds the process open.
  const heartbeat = setInterval(() => {
    if (res.writableEnded || cancelled) return;
    res.write(`: ping ${Date.now()}\n\n`);
  }, config.sseHeartbeatMs);
  heartbeat.unref?.();
  res.on("close", () => clearInterval(heartbeat));

  const transcript = String((req.body && req.body.transcript) || "").trim();
  if (!transcript) {
    clearInterval(heartbeat);
    sendEvent("error", { error: "Transcript is required.", code: "bad_request" });
    return res.end();
  }

  // The headers are already out, so an impossible choice travels as an SSE error
  // rather than a status code: the browser is reading a stream by now, not waiting
  // on a response.
  let client;
  try {
    client = clientForRequest(req.body);
  } catch (err) {
    clearInterval(heartbeat);
    if (isChoiceError(err)) {
      sendEvent("error", {
        error: err.message,
        details: config.exposeErrorDetails ? err.details : undefined,
        code: err.code
      });
      return res.end();
    }
    throw err;
  }

  try {
    const result = await extractGraph({
      transcript,
      config,
      client,
      mode: modeForRequest(req.body),
      isCancelled: () => cancelled || res.writableEnded,
      onEvent: ({ type, ...data }) => {
        if (!config.exposeErrorDetails) delete data.details;
        sendEvent(type, data);
      }
    });
    sendEvent("done", {
      warnings: result.warnings,
      chunks: result.chunks,
      partial: result.partial,
      ms: result.ms
    });
    res.end();
  } catch (err) {
    if (err instanceof UpstreamError) {
      sendEvent("error", {
        error: err.message,
        details: config.exposeErrorDetails ? err.details : undefined,
        code: err.code
      });
      return res.end();
    }
    sendEvent("error", {
      error: "Extraction failed",
      details: config.exposeErrorDetails ? String(err) : undefined,
      code: "server_error"
    });
    res.end();
  } finally {
    clearInterval(heartbeat);
  }
});

function sendError(res, status, message, details, code, requestId) {
  const payload = { error: message, code, requestId };
  if (config.exposeErrorDetails && details) {
    payload.details = String(details);
  }
  return res.status(status).json(payload);
}

function createRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`);
    console.log(`Ollama: ${config.ollamaUrl} (model ${config.ollamaModel})`);
    console.log(
      config.geminiApiKey
        ? `Gemini: key loaded (model ${config.geminiModel})`
        : "Gemini: no GEMINI_API_KEY in .env — the cloud option stays greyed out"
    );
    console.log(`Default provider: ${config.aiProvider} (switchable in the sidebar)`);
  });
}

module.exports = { app, config };
