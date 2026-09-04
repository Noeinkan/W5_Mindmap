"use strict";

/**
 * The server's way into the document rules, which live in `public/js/graph-doc.js`.
 *
 * That file is an ES module because the browser loads it directly, and `require`
 * cannot read one — so it comes in through a dynamic import instead. The
 * alternative was a second copy of the same rules on this side, which is exactly
 * how "the file the app exported" and "the file the server accepts" drift apart.
 *
 * The import starts at load time and is awaited once per call after that, so a
 * request never pays for it twice.
 */
const loading = import("../public/js/graph-doc.js");
// Without a handler attached now, a broken import would surface as an unhandled
// rejection at startup instead of as an error on the first request.
loading.catch(() => {});

/** @returns {Promise<{ok:boolean, errors:string[], warnings:string[], doc:object|null}>} */
async function validateDocument(value) {
  const { validateDocument: validate } = await loading;
  return validate(value);
}

async function documentConstants() {
  const { DOC_VERSION, NODE_TYPES, EDGE_TYPES } = await loading;
  return { DOC_VERSION, NODE_TYPES, EDGE_TYPES };
}

module.exports = { validateDocument, documentConstants };
