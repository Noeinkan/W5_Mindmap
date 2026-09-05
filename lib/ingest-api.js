"use strict";

/**
 * The route that turns an uploaded file into a transcript, mounted at /api/ingest.
 *
 * The body is the file itself rather than a multipart form: there is one file,
 * the browser can `fetch` a `File` straight into the body, and multipart parsing
 * would be a dependency and a temporary file for no gain. The name comes along
 * as `?name=`, and only to make the messages say which file went wrong.
 */

const express = require("express");

const { ingestFile } = require("./ingest");

/** Which failures are the caller's, and which is ours. */
const STATUS = {
  empty_file: 400,
  bad_zip: 400,
  unsupported_file: 415,
  unsupported_zip: 415,
  bad_pdf: 422,
  bad_epub: 422,
  encrypted_pdf: 422,
  no_text: 422
};

function createIngestRouter({ config }) {
  const router = express.Router();

  router.post(
    "/",
    // Every kind of file arrives here, so the type is not worth checking — the
    // sniffer looks at the bytes anyway.
    express.raw({ type: () => true, limit: config.ingestMaxBytes }),
    (req, res) => {
      const filename = String(req.query.name || "").slice(0, 200);

      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return fail(res, 400, "empty_file", "No file arrived with that request.");
      }

      try {
        const result = ingestFile(req.body, {
          filename,
          maxChars: config.ingestMaxChars,
          maxPages: config.ingestMaxPages
        });
        // The chunk size travels with the answer so the section list can say
        // what each section costs to map without guessing the server's setting.
        res.json({ ok: true, name: filename, chunkSize: config.chunkSize, ...result });
      } catch (err) {
        const status = STATUS[err.code];
        if (status) return fail(res, status, err.code, err.message);
        fail(
          res,
          500,
          "server_error",
          "That file could not be read.",
          config.exposeErrorDetails ? String(err && err.message) : null
        );
      }
    }
  );

  // Four parameters with `next` unused: that arity is how Express tells an error
  // handler from a middleware. Body-parser's own failures land here — a file
  // over the limit above all, which is worth saying plainly.
  router.use((err, req, res, next) => {
    if (err && (err.type === "entity.too.large" || err.status === 413)) {
      const megabytes = Math.round(config.ingestMaxBytes / (1024 * 1024));
      return fail(res, 413, "file_too_large", `That file is bigger than the ${megabytes} MB limit.`);
    }
    fail(res, 400, "bad_request", "That upload could not be read.");
  });

  return router;
}

function fail(res, status, code, message, details) {
  const payload = { error: message, code };
  if (details) payload.details = details;
  return res.status(status).json(payload);
}

module.exports = { createIngestRouter };
