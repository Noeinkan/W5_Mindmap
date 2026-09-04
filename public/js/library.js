/**
 * The library: maps saved on the server, listed in the sidebar.
 *
 * localStorage keeps one map — the one you were last looking at. This keeps as
 * many as you like, on disk next to the app, so a meeting mapped in March can be
 * opened again in June from a browser that has since been cleared.
 *
 * Which entry the map on screen came from is remembered too, so **Save** means
 * "save over that one" rather than "leave a fourth copy of it in the list".
 */

import {
  listGraphs,
  readGraph,
  createGraph,
  replaceGraph,
  renameGraph,
  deleteGraph
} from "./api.js";
import { validateDocument } from "./graph-doc.js";
import { currentDocument } from "./session.js";
import { state } from "./state.js";
import { el, toast, relativeTime } from "./ui.js";

const OPEN_KEY = "mindmap.library.open.v1";

let graphs = [];
let openId = null;
let onOpen = () => {};
let busy = false;

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

export function initLibrary(handlers = {}) {
  onOpen = handlers.onOpen || (() => {});
  openId = readStoredOpenId();

  el.librarySave.addEventListener("click", () => save({ asNew: false }));
  el.librarySaveNew.addEventListener("click", () => save({ asNew: true }));
  el.libraryRefresh.addEventListener("click", () => refresh());

  refresh();
}

/** What the Save button does, for the keyboard shortcut that means the same. */
export const saveToLibrary = () => save({ asNew: false });

/**
 * Forget which saved map is on screen. Generating a new map or importing a file
 * replaces everything on the canvas, and **Save** must not then overwrite the
 * entry the previous map came from.
 */
export function setOpenGraph(id) {
  openId = id || null;
  try {
    if (openId) localStorage.setItem(OPEN_KEY, openId);
    else localStorage.removeItem(OPEN_KEY);
  } catch {
    /* Storage off: Save falls back to creating a new entry, which is safe. */
  }
  render();
}

function readStoredOpenId() {
  try {
    return localStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export async function refresh() {
  try {
    graphs = (await listGraphs()).graphs || [];
    // The map we thought was open may have been deleted from another tab.
    if (openId && !graphs.some((g) => g.id === openId)) setOpenGraph(null);
    render();
  } catch (err) {
    renderMessage(err.message || "The library could not be read");
  }
}

async function save({ asNew }) {
  if (busy) return;
  if (!state.nodes.length) {
    toast("Nothing to save yet — generate or draw a map first", "error");
    return;
  }

  const overwrite = Boolean(openId) && !asNew;
  setBusy(true);
  try {
    const doc = currentDocument();
    const saved = overwrite ? await replaceGraph(openId, doc) : await createGraph(doc);
    setOpenGraph(saved.id);
    toast(overwrite ? `“${saved.title}” updated` : `“${saved.title}” saved to the library`, "ok");
    await refresh();
  } catch (err) {
    // The entry was deleted while this tab still had it open. Saving the work as
    // a new entry is the only outcome that does not lose it.
    if (overwrite && /not_found/.test(err.message)) {
      setOpenGraph(null);
      setBusy(false);
      return save({ asNew: true });
    }
    toast(err.message || "Save failed", "error", 4600);
  } finally {
    setBusy(false);
  }
}

async function open(id) {
  if (busy) return;
  setBusy(true);
  try {
    const record = await readGraph(id);
    // Files on disk can be edited by hand, so what comes back goes through the
    // same check an imported file does rather than straight onto the canvas.
    const { ok, errors, warnings, doc } = validateDocument(record);
    if (!ok) {
      toast(errors[0] || "That saved map cannot be opened", "error", 4600);
      return;
    }
    onOpen(doc);
    setOpenGraph(id);
    toast(warnings.length ? `Opened “${doc.title}” — ${warnings[0]}` : `Opened “${doc.title}”`, warnings.length ? "info" : "ok");
  } catch (err) {
    toast(err.message || "That map could not be opened", "error", 4600);
  } finally {
    setBusy(false);
  }
}

async function commitRename(id, title) {
  if (!title) {
    render();
    return;
  }
  setBusy(true);
  try {
    const saved = await renameGraph(id, title);
    toast(`Renamed to “${saved.title}”`, "ok");
    await refresh();
  } catch (err) {
    toast(err.message || "Rename failed", "error", 4600);
    render();
  } finally {
    setBusy(false);
  }
}

async function commitDelete(id) {
  setBusy(true);
  try {
    await deleteGraph(id);
    if (openId === id) setOpenGraph(null);
    toast("Saved map deleted", "ok");
    await refresh();
  } catch (err) {
    toast(err.message || "Delete failed", "error", 4600);
    render();
  } finally {
    setBusy(false);
  }
}

function setBusy(value) {
  busy = value;
  el.librarySave.disabled = value;
  el.librarySaveNew.disabled = value;
  el.libraryRefresh.disabled = value;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  el.libraryCount.hidden = !graphs.length;
  el.libraryCount.textContent = String(graphs.length);
  // "Save as new" only means something once there is an entry to save over.
  el.librarySaveNew.hidden = !openId;
  el.librarySave.textContent = openId ? "Save" : "Save to library";

  el.libraryList.textContent = "";
  if (!graphs.length) {
    renderMessage("No saved maps yet — Save puts the one on screen here.");
    return;
  }
  graphs.forEach((graph) => el.libraryList.appendChild(row(graph)));
}

function renderMessage(text) {
  el.libraryList.textContent = "";
  const line = document.createElement("p");
  line.className = "lib-empty";
  line.textContent = text;
  el.libraryList.appendChild(line);
}

function row(graph) {
  const container = document.createElement("div");
  container.className = "lib-row";
  if (graph.id === openId) container.classList.add("is-open");

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "lib-open";
  openButton.title = `Open “${graph.title}”`;

  const title = document.createElement("span");
  title.className = "lib-title";
  title.textContent = graph.title;

  const meta = document.createElement("span");
  meta.className = "lib-meta";
  const nodes = `${graph.nodeCount} node${graph.nodeCount === 1 ? "" : "s"}`;
  meta.textContent = [nodes, graph.hasTranscript ? "transcript" : null, relativeTime(graph.updatedAt)]
    .filter(Boolean)
    .join(" · ");

  openButton.append(title, meta);
  openButton.addEventListener("click", () => open(graph.id));

  const actions = document.createElement("div");
  actions.className = "lib-actions";
  actions.append(
    iconButton("i-pencil", "Rename", () => renameRow(container, graph)),
    iconButton("i-trash", "Delete", () => deleteRow(container, graph))
  );

  container.append(openButton, actions);
  return container;
}

/** The row turns into its own rename field — no dialog, no page of its own. */
function renameRow(container, graph) {
  container.textContent = "";
  container.classList.add("is-editing");

  const input = document.createElement("input");
  input.className = "input lib-input";
  input.value = graph.title;
  input.setAttribute("aria-label", "Map title");
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    // Escape and Enter mean something to the canvas too; inside this field they
    // belong to the field.
    event.stopPropagation();
    if (event.key === "Enter") commitRename(graph.id, input.value.trim());
    else render();
  });

  const actions = document.createElement("div");
  actions.className = "lib-actions";
  actions.append(
    textButton("Save", () => commitRename(graph.id, input.value.trim())),
    textButton("Cancel", render)
  );

  container.append(input, actions);
  input.focus();
  input.select();
}

/**
 * Deleting asks in the row itself. A browser `confirm()` would do the job, but it
 * is the one thing in this app that stops the page dead, and losing a saved map
 * is worth exactly one extra click.
 */
function deleteRow(container, graph) {
  container.textContent = "";
  container.classList.add("is-confirming");

  const question = document.createElement("span");
  question.className = "lib-title";
  question.textContent = `Delete “${graph.title}”?`;

  const actions = document.createElement("div");
  actions.className = "lib-actions";
  const confirm = textButton("Delete", () => commitDelete(graph.id));
  confirm.classList.add("is-danger");
  actions.append(confirm, textButton("Cancel", render));

  container.append(question, actions);
  confirm.focus();
}

function iconButton(icon, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn icon-btn-sm";
  button.title = label;
  button.setAttribute("aria-label", label);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${icon}`);
  svg.appendChild(use);

  button.appendChild(svg);
  button.addEventListener("click", onClick);
  return button;
}

function textButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-btn";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}
