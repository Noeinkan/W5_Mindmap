"use strict";

const { NODE_TYPES, EDGE_TYPES } = require("./graph");

/**
 * The JSON schema handed to Ollama as `format`.
 *
 * `format: "json"` only promises *some* valid JSON, and the shortest valid JSON is
 * `{}` — which is exactly what a 4B model answers most of the time, however the
 * prompt is worded. A schema that requires both arrays removes that exit: the
 * sampler cannot close the object before it has emitted `nodes` and `edges`.
 *
 * Deliberately no `minItems`: a chunk that genuinely holds nothing must still be
 * able to answer with empty arrays rather than invent a concept.
 */
const graphResponseSchema = {
  type: "object",
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          type: { type: "string", enum: NODE_TYPES },
          quote: { type: "string" }
        },
        required: ["id", "label", "type"]
      }
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          type: { type: "string", enum: EDGE_TYPES }
        },
        required: ["id", "from", "to", "type"]
      }
    }
  },
  required: ["nodes", "edges"]
};

const edgeItemSchema = graphResponseSchema.properties.edges.items;

/** The schema for the linking pass, which proposes edges over existing nodes. */
const edgesResponseSchema = {
  type: "object",
  properties: {
    edges: { type: "array", items: edgeItemSchema }
  },
  required: ["edges"]
};

module.exports = { graphResponseSchema, edgesResponseSchema };
