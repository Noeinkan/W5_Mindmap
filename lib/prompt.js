"use strict";

const { NODE_TYPES, EDGE_TYPES } = require("./graph");

/**
 * Build the extraction prompt for one chunk.
 *
 * `knownLabels` are the concepts already found in earlier chunks. Feeding them back
 * is what makes cross-chunk merging work at the source: told that "Handover Issues"
 * already exists, the model reuses that exact label instead of inventing "Issues
 * with handover", and the two collapse into one node instead of two islands.
 */
function buildExtractionPrompt({
  chunk,
  idPrefix,
  knownLabels = [],
  strict = false,
  retryEmpty = false
}) {
  const knownBlock = knownLabels.length
    ? `\n\nConcepts already found in earlier chunks — reuse the EXACT label when you mean the same thing:\n${knownLabels
        .map((label) => `- ${label}`)
        .join("\n")}`
    : "";

  const strictBlock = strict
    ? "\n\nYour previous answer was not valid JSON. Return the JSON object ONLY: no prose, no markdown fence, no explanation."
    : "";

  // Small models answer a short chunk with an empty graph even when it is full of
  // decisions. Asking once more, saying plainly that there is something there, is
  // cheaper than losing the chunk.
  const emptyBlock = retryEmpty
    ? "\n\nYour previous answer contained no nodes. This chunk does discuss something: extract at least the concepts it names, even if you can find no relations between them."
    : "";

  return `You are a JSON API. Extract a mind-map from the transcript chunk.

Return ONLY valid JSON with this schema:
{
  "nodes": [
    {"id": "${idPrefix}n1", "label": "...", "type": "${NODE_TYPES.join("|")}", "quote": "..."}
  ],
  "edges": [
    {"id": "${idPrefix}e1", "from": "${idPrefix}n1", "to": "${idPrefix}n2", "type": "${EDGE_TYPES.join("|")}"}
  ]
}

Rules:
- Prefix ALL node and edge IDs with "${idPrefix}".
- Use stable, unique IDs.
- Use ONLY the node types ${NODE_TYPES.join(", ")}.
- Use only the edge types ${EDGE_TYPES.join(", ")}.
- Labels are short noun phrases, 2-5 words, in the vocabulary of the transcript.
- "quote" is a short verbatim span from THIS chunk that justifies the node. Copy it exactly; omit the field if no single span justifies the node.
- Connect the nodes: a chunk that yields nodes should yield edges between them.
- Return an empty graph ONLY if the chunk is pure small talk or scheduling with nothing to map.${knownBlock}${strictBlock}${emptyBlock}

Transcript chunk:
"""${chunk}"""`;
}

/**
 * Build the prompt for the linking pass.
 *
 * Each chunk is extracted on its own, so its concepts only ever get edges to other
 * concepts from the same chunk: the finished map reads as one island per chunk with
 * nothing between them. This pass shows the model the concept list alone — no
 * transcript, so it is short and quick — and asks only for the edges that cross.
 */
function buildLinkPrompt({ nodes, components }) {
  const labelById = new Map(nodes.map((node) => [node.id, node]));

  const groups = components
    .map((ids, index) => {
      const lines = ids
        .map((id) => labelById.get(id))
        .filter(Boolean)
        .map((node) => `- ${node.id}: ${node.label} (${node.type})`)
        .join("\n");
      return `Group ${index + 1}:\n${lines}`;
    })
    .join("\n\n");

  return `You are a JSON API. The concepts below all come from one meeting, but they were extracted separately and no relation between the groups has been recorded yet.

${groups}

Return ONLY valid JSON with this schema:
{
  "edges": [
    {"id": "l1", "from": "<id from one group>", "to": "<id from another group>", "type": "${EDGE_TYPES.join("|")}"}
  ]
}

Rules:
- Use ONLY the ids listed above, exactly as written.
- Every edge must join two DIFFERENT groups.
- Add an edge only where the relation between the two concepts is clear. Three to eight edges is normal; fewer is fine.
- Never repeat a pair.`;
}

module.exports = { buildExtractionPrompt, buildLinkPrompt };
