"use strict";

const express = require("express");
const path = require("path");

const { loadConfig } = require("./lib/config");
const { createOllamaClient, UpstreamError } = require("./lib/ollama");
const { extractGraph } = require("./lib/extract");

const config = loadConfig();
const client = createOllamaClient(config);
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
// samples/ lives outside public/, so it needs its own mount for the client to be
// able to offer "load the sample transcript".
app.use("/samples", express.static(path.join(__dirname, "samples")));

app.get("/api/health", async (req, res) => {
  const ollama = await client.health();
  res.json({
    ok: true,
    ollama,
    chunkSize: config.chunkSize,
    ready: ollama.reachable && ollama.modelAvailable
  });
});

app.post("/api/extract", async (req, res) => {
  const requestId = createRequestId();
  const transcript = String((req.body && req.body.transcript) || "").trim();

  if (!transcript) {
    return sendError(res, 400, "Transcript is required.", null, "bad_request", requestId);
  }

  try {
    const result = await extractGraph({ transcript, config, client });
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

  try {
    const result = await extractGraph({
      transcript,
      config,
      client,
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
  });
}

module.exports = { app, config };
