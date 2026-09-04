"use strict";

/**
 * Saved maps on disk: one JSON file per map, under the store directory.
 *
 * A directory of files rather than a database, because that is what the data is —
 * a handful of documents, each one the same JSON the export button writes. It can
 * be read, diffed and backed up without this app, which for something whose whole
 * point is that nothing leaves the machine matters more than query speed.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

/**
 * The ids this store hands out, and the only shape a lookup is allowed to have.
 * It is also what keeps `..\..\etc` out of `path.join`: an id that does not match
 * never reaches the filesystem.
 */
const ID_PATTERN = /^g_[a-z0-9]+_[a-z0-9]+$/;

const isValidId = (id) => ID_PATTERN.test(String(id || ""));

const createId = () =>
  `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** What the list route returns: enough to choose a map, without its whole body. */
function summarize(record) {
  return {
    id: record.id,
    title: record.title,
    nodeCount: Array.isArray(record.nodes) ? record.nodes.length : 0,
    edgeCount: Array.isArray(record.edges) ? record.edges.length : 0,
    // The transcript is the heavy field and the list never shows it — but whether
    // a saved map still carries the meeting it came from is worth knowing.
    hasTranscript: Boolean(record.transcript),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function createStore({ dir }) {
  const fileFor = (id) => path.join(dir, `${id}.json`);

  async function write(record) {
    await fs.mkdir(dir, { recursive: true });
    // Straight to the final name, a crash mid-write leaves a truncated file that
    // parses as nothing — and the map is gone. Rename is atomic, so the file on
    // disk is either the old map or the new one.
    const temp = path.join(dir, `.${record.id}.${process.pid}.tmp`);
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await fs.rename(temp, fileFor(record.id));
    return record;
  }

  /** The stored map, or null when there is no such id. */
  async function read(id) {
    if (!isValidId(id)) return null;
    try {
      return JSON.parse(await fs.readFile(fileFor(id), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      // A file that is there but unreadable is a real failure — a 500, not a 404.
      if (err instanceof SyntaxError) {
        throw Object.assign(new Error(`Saved map ${id} is corrupt on disk`), { code: "corrupt_graph" });
      }
      throw err;
    }
  }

  async function list() {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      // Nothing saved yet is an empty library, not an error.
      if (err.code === "ENOENT") return [];
      throw err;
    }

    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json") && isValidId(name.slice(0, -5)))
        .map(async (name) => {
          try {
            return JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
          } catch {
            // One unreadable file must not take the whole library down with it.
            return null;
          }
        })
    );

    return records
      .filter(Boolean)
      .map(summarize)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function create(doc) {
    const now = new Date().toISOString();
    return write({ ...doc, id: createId(), createdAt: now, updatedAt: now });
  }

  /** Overwrite a saved map with a new version of the same document. */
  async function replace(id, doc) {
    const existing = await read(id);
    if (!existing) return null;
    return write({
      ...doc,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString()
    });
  }

  async function rename(id, title) {
    const existing = await read(id);
    if (!existing) return null;
    return write({ ...existing, title, updatedAt: new Date().toISOString() });
  }

  /** True when a map was deleted, false when there was nothing to delete. */
  async function remove(id) {
    if (!isValidId(id)) return false;
    try {
      await fs.unlink(fileFor(id));
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  return { dir, list, read, create, replace, rename, remove };
}

module.exports = { createStore, summarize, isValidId, createId };
