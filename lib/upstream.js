"use strict";

/**
 * What every model backend shares: one error type the routes already know how to
 * turn into a 502, one readable sentence for a failed fetch, and one fetch with a
 * deadline and a retry.
 *
 * It lives on its own rather than inside lib/ollama.js because Ollama and Gemini
 * are alternatives, not layers: neither should have to import the other to borrow
 * a helper.
 */

class UpstreamError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "UpstreamError";
    this.code = code || "upstream_failed";
    this.details = details ? String(details) : "";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A readable one-liner for a failed fetch. Undici wraps a refused connection in an
 * AggregateError whose own message is the useless string "AggregateError"; the
 * sentence a user can act on ("connect ECONNREFUSED 127.0.0.1:11434") is inside it.
 */
function describeError(err, depth = 0) {
  if (!err || depth > 3) return "";
  if (Array.isArray(err.errors) && err.errors.length) {
    return err.errors.map((e) => describeError(e, depth + 1)).filter(Boolean).join("; ");
  }
  const message = err.message ? String(err.message) : String(err);
  if (err.cause) {
    const cause = describeError(err.cause, depth + 1);
    return cause && cause !== message ? `${message}: ${cause}` : message;
  }
  return message;
}

/**
 * Fetch with a deadline, retried on a transport failure only.
 *
 * A response that arrives is returned whatever its status: a 400 says the request
 * was wrong and sending it again would only be wrong again. `label` and `code` name
 * the backend in the error, so a failure reads "Gemini request failed" rather than
 * something generic the user cannot act on.
 */
async function fetchWithRetry(
  fetchImpl,
  url,
  options,
  { timeoutMs, retries = 0, backoffMs = 0, label = "Upstream request failed", code = "upstream_failed" } = {}
) {
  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
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

  throw new UpstreamError(label, code, describeError(lastError));
}

module.exports = { UpstreamError, delay, describeError, fetchWithRetry };
