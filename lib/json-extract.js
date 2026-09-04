"use strict";

/** Pull the JSON object out of whatever the model wrapped it in. */
function extractJson(text) {
  if (!text) return null;

  const trimmed = String(text).trim();
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

/**
 * Turn an Ollama /api/generate payload into a candidate graph object.
 * Returns { ok: true, value } or { ok: false, code, error } — never throws.
 */
function parseGraphResponse(data) {
  const payload = data && data.response !== undefined ? data.response : data;

  if (payload && typeof payload === "object") {
    return { ok: true, value: payload };
  }

  const rawText = String(payload || "");
  const jsonText = extractJson(rawText);

  if (jsonText) {
    try {
      return { ok: true, value: JSON.parse(jsonText) };
    } catch (parseError) {
      return {
        ok: false,
        code: "invalid_json",
        error: "Invalid JSON returned by LLM",
        details: String(parseError)
      };
    }
  }

  if (data && typeof data === "object" && data.nodes && data.edges) {
    return { ok: true, value: data };
  }

  return {
    ok: false,
    code: "no_json",
    error: "No JSON found in LLM response",
    details: rawText || JSON.stringify(data)
  };
}

module.exports = { extractJson, parseGraphResponse };
