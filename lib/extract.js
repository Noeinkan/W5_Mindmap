"use strict";

const { chunkTranscript } = require("./chunking");
const { promptFor, DEFAULT_MODE } = require("./prompt");
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
 * (Ollama down, timed out) stops the run immediately: every remaining chunk would
 * fail the same way, slowly. Stopping is not the same as failing, though — if
 * earlier chunks produced a graph, that graph is returned with a warning instead of
 * being thrown away with them.
 *
 * `onEvent` receives { type, ... } as work progresses: status, progress, graph,
 * warning. Callers that do not stream can ignore it.
 */
async function extractGraph({
  transcript,
  config,
  client,
  mode = DEFAULT_MODE,
  onEvent = () => {},
  isCancelled = () => false
}) {
  const startedAt = Date.now();
  // A mode is a prompt and nothing else. Both readings answer in the same
  // schema, so the retries, the merge, the linking pass and the saved file
  // below are shared rather than duplicated per reading.
  const buildPrompt = promptFor(mode);
  const chunks = chunkTranscript(transcript, config.chunkSize, config.chunkOverlapLines);
  const graphs = [];
  const warnings = [];

  onEvent({
    type: "status",
    message: `Processing ${chunks.length} chunk(s)...`,
    chunks: chunks.length,
    // Only the log reads these two: they answer "why eight chunks?" and "which
    // model produced this?" without a trip to the server window.
    chunkSize: config.chunkSize,
    // Read off the client, not the config: with the switch in the sidebar the
    // configured default is no longer what a given run actually used.
    provider: client.provider,
    model: client.model || config.ollamaModel,
    // Which reading produced this map. The log is the only place that answers
    // "why does this map look nothing like the last one?" after the fact.
    mode
  });

  let merged = { nodes: [], edges: [] };
  let stopped = false;

  for (let i = 0; i < chunks.length; i += 1) {
    if (isCancelled()) break;
    const chunkNumber = i + 1;
    const idPrefix = `c${chunkNumber}_`;
    const chunkStartedAt = Date.now();

    onEvent({
      type: "progress",
      chunk: chunkNumber,
      total: chunks.length,
      chars: chunks[i].length,
      message: `Analyzing chunk ${chunkNumber} of ${chunks.length}...`
    });

    const knownLabels = merged.nodes
      .slice(0, Math.max(0, config.knownLabelsInPrompt))
      .map((n) => n.label);

    let graph = null;
    let failure = null;
    let transportError = null;

    const lastAttempt = Math.max(0, config.chunkParseRetries);
    // A retry is invisible from outside — the chunk simply takes twice as long,
    // or comes back thin. Saying it out loud is half of what the log is for.
    const announceRetry = (attempt, code, message) => {
      if (attempt >= lastAttempt) return;
      onEvent({
        type: "retry",
        chunk: chunkNumber,
        total: chunks.length,
        attempt: attempt + 2,
        attempts: lastAttempt + 1,
        code,
        message
      });
    };

    for (let attempt = 0; attempt <= lastAttempt; attempt += 1) {
      const prompt = buildPrompt({
        chunk: chunks[i],
        idPrefix,
        knownLabels,
        strict: failure !== null,
        retryEmpty: graph !== null
      });

      // A transport error is not retried here — fetchWithRetry already did that, and
      // the run is over either way.
      let data;
      try {
        data = await client.generate(prompt);
      } catch (err) {
        transportError = err;
        break;
      }

      const parsed = parseGraphResponse(data);
      if (!parsed.ok) {
        failure = parsed;
        graph = null;
        announceRetry(attempt, parsed.code, parsed.error || "the answer was not JSON");
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
        announceRetry(attempt, failure.code, failure.error);
        continue;
      }

      failure = null;
      graph = sanitizeGraph(coerced);
      // A well-formed but empty answer is worth one more ask before giving up.
      if (graph.nodes.length) break;
      announceRetry(attempt, "empty_graph", "the model found no concepts");
    }

    if (transportError) {
      // Nothing usable yet: the caller asked for a map and there is none, so the
      // transport error is the answer. With chunks already done, the half-map is
      // worth more than the exception — the user keeps what the model found before
      // Ollama went away.
      if (!graphs.length) throw transportError;
      const warning = {
        chunk: chunkNumber,
        total: chunks.length,
        code: transportError.code || "ollama_failed",
        message: `Stopped at chunk ${chunkNumber} of ${chunks.length}: ${
          transportError.message || "the model became unreachable"
        }. The map covers the transcript up to there.`,
        details: transportError.details ? String(transportError.details) : ""
      };
      warnings.push(warning);
      onEvent({ type: "warning", ...warning });
      stopped = true;
      break;
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
    onEvent({
      type: "graph",
      ...merged,
      chunk: chunkNumber,
      total: chunks.length,
      ms: Date.now() - chunkStartedAt
    });
  }

  if (chunks.length && !graphs.length && !isCancelled()) {
    const first = warnings[0];
    throw new UpstreamError(
      "The model returned no usable graph for any chunk",
      first ? first.code : "no_json",
      first ? first.details : ""
    );
  }

  // No linking pass after a transport failure: it is one more call to a model that
  // just proved unreachable, and it would only add its own timeout to the wait.
  if (config.linkPass && !stopped && graphs.length > 1 && merged.nodes.length > 1 && !isCancelled()) {
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

  return { ...merged, warnings, chunks: chunks.length, partial: stopped, ms: Date.now() - startedAt };
}

module.exports = { extractGraph };
