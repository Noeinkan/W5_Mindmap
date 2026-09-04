"use strict";

const { chunkTranscript } = require("./chunking");
const { buildExtractionPrompt } = require("./prompt");
const { parseGraphResponse } = require("./json-extract");
const { sanitizeGraph, coerceGraph, mergeGraphs } = require("./graph");
const { UpstreamError } = require("./ollama");
const { linkComponents } = require("./link");

/**
 * Run the whole transcript through the model, one chunk at a time, and return the
 * merged graph.
 *
 * Two failure modes are deliberately kept apart. A chunk the model answered badly
 * (prose instead of JSON, a missing array) is retried once and then skipped with a
 * warning — one bad chunk must not throw away the good ones. A transport failure
 * (Ollama down, timed out) aborts immediately: every remaining chunk would fail the
 * same way, slowly.
 *
 * `onEvent` receives { type, ... } as work progresses: status, progress, graph,
 * warning. Callers that do not stream can ignore it.
 */
async function extractGraph({
  transcript,
  config,
  client,
  onEvent = () => {},
  isCancelled = () => false
}) {
  const chunks = chunkTranscript(transcript, config.chunkSize, config.chunkOverlapLines);
  const graphs = [];
  const warnings = [];

  onEvent({
    type: "status",
    message: `Processing ${chunks.length} chunk(s)...`,
    chunks: chunks.length
  });

  let merged = { nodes: [], edges: [] };

  for (let i = 0; i < chunks.length; i += 1) {
    if (isCancelled()) break;
    const chunkNumber = i + 1;
    const idPrefix = `c${chunkNumber}_`;

    onEvent({
      type: "progress",
      chunk: chunkNumber,
      total: chunks.length,
      message: `Analyzing chunk ${chunkNumber} of ${chunks.length}...`
    });

    const knownLabels = merged.nodes
      .slice(0, Math.max(0, config.knownLabelsInPrompt))
      .map((n) => n.label);

    let graph = null;
    let failure = null;

    for (let attempt = 0; attempt <= Math.max(0, config.chunkParseRetries); attempt += 1) {
      const prompt = buildExtractionPrompt({
        chunk: chunks[i],
        idPrefix,
        knownLabels,
        strict: failure !== null,
        retryEmpty: graph !== null
      });

      // A transport error is not retried here — fetchWithRetry already did that, and
      // the run is over either way.
      const data = await client.generate(prompt);

      const parsed = parseGraphResponse(data);
      if (!parsed.ok) {
        failure = parsed;
        graph = null;
        continue;
      }

      const coerced = coerceGraph(parsed.value);
      if (!coerced) {
        failure = {
          code: "invalid_schema",
          error: "Response was not a graph",
          details: ""
        };
        graph = null;
        continue;
      }

      failure = null;
      graph = sanitizeGraph(coerced);
      // A well-formed but empty answer is worth one more ask before giving up.
      if (graph.nodes.length) break;
    }

    if (!graph) {
      const warning = {
        chunk: chunkNumber,
        total: chunks.length,
        code: failure ? failure.code : "no_json",
        message: `Chunk ${chunkNumber} of ${chunks.length} skipped: ${
          failure ? failure.error : "no graph returned"
        }`,
        details: failure ? failure.details : ""
      };
      warnings.push(warning);
      onEvent({ type: "warning", ...warning });
      continue;
    }

    graphs.push(graph);

    if (!graph.nodes.length) {
      const warning = {
        chunk: chunkNumber,
        total: chunks.length,
        code: "empty_chunk",
        message: `Chunk ${chunkNumber} of ${chunks.length} produced no concepts.`,
        details: ""
      };
      warnings.push(warning);
      onEvent({ type: "warning", ...warning });
      continue;
    }

    merged = mergeGraphs(graphs);
    onEvent({ type: "graph", ...merged, chunk: chunkNumber, total: chunks.length });
  }

  if (chunks.length && !graphs.length && !isCancelled()) {
    const first = warnings[0];
    throw new UpstreamError(
      "The model returned no usable graph for any chunk",
      first ? first.code : "no_json",
      first ? first.details : ""
    );
  }

  if (config.linkPass && graphs.length > 1 && merged.nodes.length > 1 && !isCancelled()) {
    onEvent({ type: "status", message: "Connecting concepts across chunks..." });
    try {
      const result = await linkComponents({ graph: merged, client });
      if (result.added) {
        merged = result.graph;
        onEvent({
          type: "graph",
          ...merged,
          message: `Connected ${result.components} groups of concepts.`
        });
      }
    } catch (err) {
      // The map is already usable without this; losing the linking pass is a
      // warning, never the reason a run fails.
      const warning = {
        code: "link_failed",
        message: "Could not connect the concepts found in different chunks.",
        details: err && err.details ? err.details : String(err)
      };
      warnings.push(warning);
      onEvent({ type: "warning", ...warning });
    }
  }

  return { ...merged, warnings, chunks: chunks.length };
}

module.exports = { extractGraph };
