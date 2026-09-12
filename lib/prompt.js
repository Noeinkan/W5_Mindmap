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
 * Build the causal-reading prompt for one chunk — the same transcript read for
 * cause and effect instead of for structure.
 *
 * It answers in the same schema and the same four edge types as the mind-map
 * pass, deliberately: that is what lets the result be saved, exported and
 * reopened as an ordinary map, with no second format and no migration. What
 * changes is which types the model is pushed towards. `causes` and `supports`
 * are influences in the same direction, `contrasts` is an influence against,
 * and `relates` — the default everywhere else in the app — is here the answer
 * of last resort, because an edge that claims no direction of effect cannot be
 * drawn on a diagram of effects.
 *
 * The two instructions that actually change the output are the chain and the
 * loop. Asked for "causes", a small model returns a star: one central topic
 * with six effects hanging off it, which is the mind map again. Asked for the
 * step in between, it returns the chain that makes the diagram worth drawing.
 * And a feedback loop is the one thing this view can show that neither of the
 * other two can, so it is worth asking for by name.
 */
function buildCausalPrompt({ chunk, idPrefix, knownLabels = [], strict = false, retryEmpty = false }) {
  const knownBlock = knownLabels.length
    ? `\n\nFactors already found in earlier chunks — reuse the EXACT label when you mean the same thing:\n${knownLabels
        .map((label) => `- ${label}`)
        .join("\n")}`
    : "";

  const strictBlock = strict
    ? "\n\nYour previous answer was not valid JSON. Return the JSON object ONLY: no prose, no markdown fence, no explanation."
    : "";

  const emptyBlock = retryEmpty
    ? "\n\nYour previous answer contained no nodes. This chunk does describe something happening: extract at least the factors it names, even if you can only find one link between them."
    : "";

  return `You are a JSON API. Read the transcript chunk for CAUSE AND EFFECT and return the chain of what leads to what.

Return ONLY valid JSON with this schema:
{
  "nodes": [
    {"id": "${idPrefix}n1", "label": "...", "type": "${NODE_TYPES.join("|")}", "quote": "..."}
  ],
  "edges": [
    {"id": "${idPrefix}e1", "from": "${idPrefix}n1", "to": "${idPrefix}n2", "type": "${EDGE_TYPES.join("|")}"}
  ]
}

What a node is:
- One factor, event, action or condition that can rise, fall or happen. Short noun phrase, 2-5 words, in the vocabulary of the transcript.
- Use type "cause" for an action or event someone does or that happens; "theme" for a standing condition or state; "hierarchy" for a rule, policy or constraint.
- "quote" is a short verbatim span from THIS chunk that justifies the factor. Copy it exactly; omit the field if no single span justifies it.

What an edge is — "from" acts on "to", never the other way round:
- "causes": from brings about, triggers or increases to.
- "supports": from strengthens, reinforces or makes to more likely.
- "contrasts": from reduces, prevents, delays or works against to. Use this whenever the influence is negative — do NOT write it as "causes".
- "relates": last resort only, when two factors go together but neither acts on the other.

Rules:
- Prefix ALL node and edge IDs with "${idPrefix}".
- Build CHAINS, not stars. If A leads to B and B leads to C, return A->B and B->C. Do not return A->C as well, and do not hang every effect straight off one factor.
- Direction matters more than anything else here. Ask "which one happened first, and which one happened because of it?" before writing each edge.
- If an effect later feeds back into one of its own causes, say so with an edge pointing back. Feedback loops are the most valuable thing in this chunk — do not drop one because it closes a circle.
- Return an empty graph ONLY if the chunk is pure small talk or scheduling with nothing that leads to anything.${knownBlock}${strictBlock}${emptyBlock}

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

/**
 * The reading the extractor is doing. A mode is a prompt and nothing else: both
 * answer in the same schema, so everything downstream — parsing, sanitising,
 * merging, the linking pass, the saved file — is shared.
 */
const PROMPT_MODES = {
  mindmap: buildExtractionPrompt,
  causal: buildCausalPrompt
};

const DEFAULT_MODE = "mindmap";

/** The prompt builder for a mode, falling back rather than throwing. */
function promptFor(mode) {
  return PROMPT_MODES[mode] || PROMPT_MODES[DEFAULT_MODE];
}

module.exports = {
  buildExtractionPrompt,
  buildCausalPrompt,
  buildLinkPrompt,
  promptFor,
  PROMPT_MODES,
  DEFAULT_MODE
};
