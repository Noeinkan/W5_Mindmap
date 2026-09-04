"use strict";

/**
 * The saved-maps routes, mounted at /api/graphs.
 *
 * Every body that arrives here goes through the same validator the browser runs
 * before it exports a file (`public/js/graph-doc.js`), so what the store holds is
 * always a document the app can open again — not whatever the caller sent.
 */

const express = require("express");

const { validateDocument } = require("./document");
const { summarize, isValidId } = require("./store");

function fail(res, status, code, message, details) {
  const payload = { error: message, code };
  // These details are about the caller's own payload — which node had no label —
  // so unlike an upstream failure they are safe to send back as they are.
  if (details && details.length) payload.details = details;
  return res.status(status).json(payload);
}

/** Turns a thrown error into a 500 instead of a hung request. */
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

function createGraphsRouter({ store }) {
  const router = express.Router();

  router.get(
    "/",
    route(async (req, res) => {
      res.json({ graphs: await store.list() });
    })
  );

  router.post(
    "/",
    route(async (req, res) => {
      const { ok, errors, warnings, doc } = await validateDocument(req.body);
      if (!ok) return fail(res, 400, "invalid_document", "That is not a mind map.", errors);
      if (!doc.nodes.length) {
        return fail(res, 400, "empty_document", "There is nothing to save — the map has no nodes.");
      }
      const record = await store.create(stripClientTimestamp(doc));
      res.status(201).json({ ...summarize(record), warnings });
    })
  );

  router.get(
    "/:id",
    route(async (req, res) => {
      if (!isValidId(req.params.id)) return fail(res, 400, "bad_request", "That is not a saved map id.");
      const record = await store.read(req.params.id);
      if (!record) return fail(res, 404, "not_found", "No saved map with that id.");
      res.json(record);
    })
  );

  // Save over a map that is already in the library — the "Save" button on a map
  // that was opened from it.
  router.put(
    "/:id",
    route(async (req, res) => {
      if (!isValidId(req.params.id)) return fail(res, 400, "bad_request", "That is not a saved map id.");
      const { ok, errors, warnings, doc } = await validateDocument(req.body);
      if (!ok) return fail(res, 400, "invalid_document", "That is not a mind map.", errors);
      if (!doc.nodes.length) {
        return fail(res, 400, "empty_document", "There is nothing to save — the map has no nodes.");
      }
      const record = await store.replace(req.params.id, stripClientTimestamp(doc));
      if (!record) return fail(res, 404, "not_found", "No saved map with that id.");
      res.json({ ...summarize(record), warnings });
    })
  );

  router.patch(
    "/:id",
    route(async (req, res) => {
      if (!isValidId(req.params.id)) return fail(res, 400, "bad_request", "That is not a saved map id.");
      const title = String((req.body && req.body.title) || "").trim();
      if (!title) return fail(res, 400, "bad_request", "A title is required.");

      const existing = await store.read(req.params.id);
      if (!existing) return fail(res, 404, "not_found", "No saved map with that id.");

      // Through the validator rather than straight onto the record: a rename is
      // the one write that could otherwise put a title in the file that the
      // format itself would have refused.
      const { ok, errors, doc } = await validateDocument({ ...existing, title });
      if (!ok) return fail(res, 400, "invalid_document", "That title cannot be saved.", errors);

      const record = await store.replace(req.params.id, stripClientTimestamp(doc));
      if (!record) return fail(res, 404, "not_found", "No saved map with that id.");
      res.json(summarize(record));
    })
  );

  router.delete(
    "/:id",
    route(async (req, res) => {
      if (!isValidId(req.params.id)) return fail(res, 400, "bad_request", "That is not a saved map id.");
      const deleted = await store.remove(req.params.id);
      if (!deleted) return fail(res, 404, "not_found", "No saved map with that id.");
      res.json({ ok: true, id: req.params.id });
    })
  );

  // Four parameters, `next` included and unused: that arity is how Express tells
  // an error handler from an ordinary middleware.
  router.use((err, req, res, next) => {
    fail(res, 500, err.code || "server_error", "The saved maps could not be reached on disk.");
  });

  return router;
}

/**
 * `savedAt` is the browser's own timestamp for its autosave. On this side the
 * store keeps `createdAt` / `updatedAt`, and two clocks in one record is one too
 * many.
 */
function stripClientTimestamp(doc) {
  const { savedAt, ...rest } = doc;
  return rest;
}

module.exports = { createGraphsRouter };
