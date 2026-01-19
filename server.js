const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";
const TRANSCRIPT_CHUNK_SIZE = Number(process.env.TRANSCRIPT_CHUNK_SIZE || 3500);
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 20000);
const OLLAMA_RETRIES = Number(process.env.OLLAMA_RETRIES || 1);
const OLLAMA_RETRY_BACKOFF_MS = Number(process.env.OLLAMA_RETRY_BACKOFF_MS || 500);
const NODE_ENV = process.env.NODE_ENV || "development";
const EXPOSE_ERROR_DETAILS = NODE_ENV !== "production";

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/extract", async (req, res) => {
  const requestId = createRequestId();
  try {
    const transcript = String(req.body.transcript || "").trim();
    if (!transcript) {
      return sendError(res, 400, "Transcript is required.", null, "bad_request", requestId);
    }

    const chunks = chunkTranscript(transcript, TRANSCRIPT_CHUNK_SIZE);
    const graphs = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const idPrefix = `c${i + 1}_`;
      const prompt = `You are a JSON API. Extract a mind-map from the transcript chunk.\n\nReturn ONLY valid JSON with this schema:\n{\n  \"nodes\": [\n    {\"id\": \"${idPrefix}n1\", \"label\": \"...\", \"type\": \"cause|theme|hierarchy\"}\n  ],\n  \"edges\": [\n    {\"id\": \"${idPrefix}e1\", \"from\": \"${idPrefix}n1\", \"to\": \"${idPrefix}n2\", \"type\": \"causes|relates|supports|contrasts\"}\n  ]\n}\n\nRules:\n- Prefix ALL node and edge IDs with \"${idPrefix}\".\n- Use stable, unique IDs.\n- Use ONLY the node types cause, theme, hierarchy.\n- Use only the edge types causes, relates, supports, contrasts.\n- Prefer concise labels.\n- If unsure, return an empty graph.\n\nTranscript chunk:\n\"\"\"${chunk}\"\"\"`;

      let ollamaResponse;
      try {
        ollamaResponse = await fetchWithRetry(
          `${OLLAMA_URL}/api/generate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: OLLAMA_MODEL,
              prompt,
              format: "json",
              stream: false
            })
          },
          OLLAMA_TIMEOUT_MS,
          OLLAMA_RETRIES,
          OLLAMA_RETRY_BACKOFF_MS
        );
      } catch (err) {
        const details = err && err.cause ? String(err.cause) : String(err);
        return sendError(res, 502, "Ollama request failed", details, "ollama_failed", requestId);
      }

      if (!ollamaResponse.ok) {
        const text = await ollamaResponse.text();
        const details = `Status ${ollamaResponse.status}: ${text}`;
        return sendError(res, 502, "Ollama request failed", details, "ollama_failed", requestId);
      }

      const data = await ollamaResponse.json();
      const responsePayload = data && data.response !== undefined ? data.response : data;
      let parsed = null;
      let rawText = "";

      if (responsePayload && typeof responsePayload === "object") {
        parsed = responsePayload;
      } else {
        rawText = String(responsePayload || "");
        const jsonText = extractJson(rawText);
        if (jsonText) {
          try {
            parsed = JSON.parse(jsonText);
          } catch (parseError) {
            return sendError(
              res,
              502,
              "Invalid JSON returned by LLM",
              String(parseError),
              "invalid_json",
              requestId
            );
          }
        }
      }

      if (!parsed && data && typeof data === "object" && data.nodes && data.edges) {
        parsed = data;
      }

      if (!parsed) {
        const details = rawText || JSON.stringify(data);
        return sendError(res, 502, "No JSON found in LLM response", details, "no_json", requestId);
      }

      const validation = validateGraphCandidate(parsed);
      if (!validation.ok) {
        return sendError(res, 502, validation.error, null, "invalid_schema", requestId);
      }

      const graph = sanitizeGraph(parsed);
      graphs.push(graph);
    }

    const merged = mergeGraphs(graphs);
    res.json({ ...merged, requestId });
  } catch (err) {
    sendError(res, 500, "Extraction failed", String(err), "server_error", requestId);
  }
});

app.post("/api/extract/stream", async (req, res) => {
  const requestId = createRequestId();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const transcript = String(req.body.transcript || "").trim();
    if (!transcript) {
      sendEvent("error", {
        error: "Transcript is required.",
        code: "bad_request",
        requestId
      });
      return res.end();
    }

    const chunks = chunkTranscript(transcript, TRANSCRIPT_CHUNK_SIZE);
    const graphs = [];

    sendEvent("status", {
      message: `Processing ${chunks.length} chunk(s)...`,
      requestId
    });

    for (let i = 0; i < chunks.length; i += 1) {
      if (res.writableEnded) return;
      const chunk = chunks[i];
      const idPrefix = `c${i + 1}_`;
      const prompt = `You are a JSON API. Extract a mind-map from the transcript chunk.\n\nReturn ONLY valid JSON with this schema:\n{\n  \"nodes\": [\n    {\"id\": \"${idPrefix}n1\", \"label\": \"...\", \"type\": \"cause|theme|hierarchy\"}\n  ],\n  \"edges\": [\n    {\"id\": \"${idPrefix}e1\", \"from\": \"${idPrefix}n1\", \"to\": \"${idPrefix}n2\", \"type\": \"causes|relates|supports|contrasts\"}\n  ]\n}\n\nRules:\n- Prefix ALL node and edge IDs with \"${idPrefix}\".\n- Use stable, unique IDs.\n- Use ONLY the node types cause, theme, hierarchy.\n- Use only the edge types causes, relates, supports, contrasts.\n- Prefer concise labels.\n- If unsure, return an empty graph.\n\nTranscript chunk:\n\"\"\"${chunk}\"\"\"`;

      sendEvent("progress", {
        chunk: i + 1,
        total: chunks.length,
        message: `Analyzing chunk ${i + 1} of ${chunks.length}...`,
        requestId
      });

      let ollamaResponse;
      try {
        ollamaResponse = await fetchWithRetry(
          `${OLLAMA_URL}/api/generate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: OLLAMA_MODEL,
              prompt,
              format: "json",
              stream: false
            })
          },
          OLLAMA_TIMEOUT_MS,
          OLLAMA_RETRIES,
          OLLAMA_RETRY_BACKOFF_MS
        );
      } catch (err) {
        const details = err && err.cause ? String(err.cause) : String(err);
        sendEvent("error", {
          error: "Ollama request failed",
          details,
          code: "ollama_failed",
          requestId
        });
        return res.end();
      }

      if (!ollamaResponse.ok) {
        const text = await ollamaResponse.text();
        sendEvent("error", {
          error: "Ollama request failed",
          details: `Status ${ollamaResponse.status}: ${text}`,
          code: "ollama_failed",
          requestId
        });
        return res.end();
      }

      const data = await ollamaResponse.json();
      const responsePayload = data && data.response !== undefined ? data.response : data;
      let parsed = null;
      let rawText = "";

      if (responsePayload && typeof responsePayload === "object") {
        parsed = responsePayload;
      } else {
        rawText = String(responsePayload || "");
        const jsonText = extractJson(rawText);
        if (jsonText) {
          try {
            parsed = JSON.parse(jsonText);
          } catch (parseError) {
            sendEvent("error", {
              error: "Invalid JSON returned by LLM",
              details: String(parseError),
              code: "invalid_json",
              requestId
            });
            return res.end();
          }
        }
      }

      if (!parsed && data && typeof data === "object" && data.nodes && data.edges) {
        parsed = data;
      }

      if (!parsed) {
        sendEvent("error", {
          error: "No JSON found in LLM response",
          details: rawText || JSON.stringify(data),
          code: "no_json",
          requestId
        });
        return res.end();
      }

      const validation = validateGraphCandidate(parsed);
      if (!validation.ok) {
        sendEvent("error", {
          error: validation.error,
          code: "invalid_schema",
          requestId
        });
        return res.end();
      }

      const graph = sanitizeGraph(parsed);
      graphs.push(graph);

      const merged = mergeGraphs(graphs);
      sendEvent("graph", {
        ...merged,
        requestId
      });
    }

    sendEvent("done", { requestId });
    res.end();
  } catch (err) {
    sendEvent("error", {
      error: "Extraction failed",
      details: String(err),
      code: "server_error",
      requestId
    });
    res.end();
  }
});

function sendError(res, status, message, details, code, requestId) {
  const payload = { error: message, code, requestId };
  if (EXPOSE_ERROR_DETAILS && details) {
    payload.details = String(details);
  }
  return res.status(status).json(payload);
}

async function fetchWithRetry(url, options, timeoutMs, retries, backoffMs) {
  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      if (attempt >= retries) break;
      await delay(backoffMs * Math.pow(2, attempt));
    }
    attempt += 1;
  }

  const error = new Error("Upstream request failed");
  error.cause = lastError;
  throw error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJson(text) {
  if (!text) return null;

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch && fencedMatch[1]) {
    const fenced = fencedMatch[1].trim();
    if (fenced.startsWith("{") && fenced.endsWith("}")) {
      return fenced;
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return trimmed.slice(first, last + 1);
}

function sanitizeGraph(graph) {
  const safe = { nodes: [], edges: [] };
  if (!graph || typeof graph !== "object") return safe;

  if (Array.isArray(graph.nodes)) {
    safe.nodes = graph.nodes
      .filter((n) => n && n.id && n.label)
      .map((n) => ({
        id: String(n.id),
        label: String(n.label),
        type: normalizeNodeType(n.type)
      }));
  }

  const nodeIds = new Set(safe.nodes.map((n) => n.id));

  if (Array.isArray(graph.edges)) {
    safe.edges = graph.edges
      .filter((e) => e && e.id && e.from && e.to)
      .map((e) => ({
        id: String(e.id),
        from: String(e.from),
        to: String(e.to),
        type: normalizeEdgeType(e.type)
      }))
      .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  }

  return safe;
}

function validateGraphCandidate(graph) {
  if (!graph || typeof graph !== "object") {
    return { ok: false, error: "Graph must be an object" };
  }

  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { ok: false, error: "Graph must include nodes and edges arrays" };
  }

  return { ok: true };
}

function mergeGraphs(graphs) {
  const merged = { nodes: [], edges: [] };
  graphs.forEach((graph) => {
    if (graph && Array.isArray(graph.nodes)) {
      merged.nodes.push(...graph.nodes);
    }
    if (graph && Array.isArray(graph.edges)) {
      merged.edges.push(...graph.edges);
    }
  });
  return sanitizeGraph(merged);
}

function chunkTranscript(text, maxLen) {
  if (!text) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = "";

  words.forEach((word) => {
    if (!current) {
      current = word;
      return;
    }

    if (current.length + word.length + 1 > maxLen) {
      chunks.push(current);
      current = word;
      return;
    }

    current += ` ${word}`;
  });

  if (current) chunks.push(current);
  return chunks;
}

function normalizeNodeType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "cause" || t === "theme" || t === "hierarchy") return t;
  return "theme";
}

function normalizeEdgeType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "causes" || t === "relates" || t === "supports" || t === "contrasts") {
    return t;
  }
  return "relates";
}

function createRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
