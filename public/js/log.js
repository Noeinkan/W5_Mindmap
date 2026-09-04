/**
 * The activity log: what the extraction pipeline is doing, line by line.
 *
 * The status line holds one sentence at a time and forgets it. A run is minutes
 * long — eight chunks, a retry here, a chunk the model fumbled there — and when
 * the map comes out short the question is always *which* part of the transcript
 * went missing and why. That answer only exists if the whole sequence is kept.
 *
 * The module owns its own DOM (the panel in the sidebar) but reads it lazily, so
 * the formatting helpers can be imported and tested without a browser.
 */

const MAX_ENTRIES = 500;

/** @type {{at:Date, kind:string, text:string, detail:string}[]} */
const entries = [];

// What the current run has said so far, so a line can be phrased as a delta
// ("+5 nodes") and timed ("answered in 17.4 s") instead of an absolute dump.
const run = { startedAt: 0, chunkStartedAt: 0, nodes: 0, edges: 0 };

let unseen = 0;
let pinnedToBottom = true;
let notify = null;

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function initLog(options = {}) {
  notify = options.notify || null;

  const panel = byId("logPanel");
  const list = byId("logList");

  byId("logClear")?.addEventListener("click", (event) => {
    event.preventDefault();
    clearLog();
  });

  byId("logCopy")?.addEventListener("click", async (event) => {
    event.preventDefault();
    const text = logText();
    if (!text) {
      notify?.("Nothing in the log yet");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      notify?.(`${entries.length} log line${entries.length === 1 ? "" : "s"} copied`, "ok");
    } catch {
      notify?.("The browser refused clipboard access", "error");
    }
  });

  byId("logExpand")?.addEventListener("click", (event) => {
    event.preventDefault();
    toggleExpanded();
  });

  // Auto-scroll only while the reader is already at the bottom: scrolling up to
  // read chunk 2 while chunk 7 lands must not yank the view back down.
  list?.addEventListener("scroll", () => {
    pinnedToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  });

  panel?.addEventListener("toggle", () => {
    if (!panel.open) return;
    unseen = 0;
    syncBadge();
    if (list) list.scrollTop = list.scrollHeight;
  });

  renderAll();
}

/** Opens (or closes) the panel — the `L` shortcut and the empty state use it. */
export function toggleLogPanel(force) {
  const panel = byId("logPanel");
  if (!panel) return;
  panel.open = force === undefined ? !panel.open : Boolean(force);
  if (panel.open) {
    unseen = 0;
    syncBadge();
  }
}

export const isLogExpanded = () =>
  Boolean(byId("logPanel")?.classList.contains("expanded"));

export function toggleExpanded(force) {
  const panel = byId("logPanel");
  if (!panel) return;
  const expanded = force === undefined ? !panel.classList.contains("expanded") : Boolean(force);
  panel.classList.toggle("expanded", expanded);
  if (expanded) panel.open = true;
  const button = byId("logExpand");
  if (button) {
    button.setAttribute("aria-pressed", String(expanded));
    // The button is also the way back, so it has to say so.
    button.textContent = expanded ? "Shrink" : "Expand";
    button.title = expanded ? "Put the log back in the panel" : "Expand the log over the canvas";
  }
  const list = byId("logList");
  if (list && pinnedToBottom) list.scrollTop = list.scrollHeight;
}

/** One line in the log. `kind` picks the colour: info, model, ok, warn, error, start. */
export function logLine(text, kind = "info", detail = "") {
  if (!text) return;
  const entry = { at: new Date(), kind, text: String(text), detail: detail ? String(detail) : "" };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  appendRow(entry);
  const panel = byId("logPanel");
  if (panel && !panel.open) unseen += 1;
  syncBadge();
}

export function clearLog() {
  entries.length = 0;
  unseen = 0;
  pinnedToBottom = true;
  renderAll();
  syncBadge();
}

/** The whole log as text, for the copy button and for pasting into a bug report. */
export function logText() {
  return entries
    .map((entry) => {
      const head = `${clock(entry.at)}  ${entry.kind.toUpperCase().padEnd(5)}  ${entry.text}`;
      return entry.detail ? `${head}\n${" ".repeat(15)}${entry.detail}` : head;
    })
    .join("\n");
}

/** Starts a run: the timers reset and the log gets a separator it can be read from. */
export function logRunStart(chars) {
  run.startedAt = Date.now();
  run.chunkStartedAt = 0;
  run.nodes = 0;
  run.edges = 0;
  logLine(`Run started — ${count(chars)} characters of transcript`, "start");
}

/**
 * Turns one pipeline event into a log line. Events arrive from the server over
 * SSE (status, progress, retry, graph, warning, done, error) and from the client
 * itself (`client`), and both are phrased the same way here.
 */
export function logServerEvent(event) {
  const line = describeEvent(event, run);
  if (!line) return;
  logLine(line.text, line.kind, line.detail);
}

/**
 * The pure half: an event plus the running totals in, a line out (or null when
 * the event says nothing worth a line). Exported so it can be tested directly.
 *
 * `state` is mutated — it carries the per-chunk stopwatch and the node/edge
 * counts that turn an absolute graph into "+5 nodes".
 */
export function describeEvent(event, state = run) {
  if (!event || typeof event !== "object") return null;
  const where = event.chunk && event.total ? `Chunk ${event.chunk}/${event.total}` : "";

  switch (event.type) {
    case "client":
      return { text: event.message, kind: event.kind || "info", detail: event.detail || "" };

    case "status": {
      if (event.chunks) {
        const size = event.chunkSize ? ` of up to ${count(event.chunkSize)} characters` : "";
        const model = event.model ? ` — model ${event.model}` : "";
        return {
          text: `Transcript split into ${event.chunks} chunk${event.chunks === 1 ? "" : "s"}${size}${model}`,
          kind: "info"
        };
      }
      return event.message ? { text: event.message, kind: "info" } : null;
    }

    case "progress": {
      state.chunkStartedAt = Date.now();
      const size = event.chars ? ` (${count(event.chars)} characters)` : "";
      return { text: `${where || "Chunk"} sent to the model${size}`, kind: "model" };
    }

    case "retry":
      return {
        text: `${where} — ${event.message || "the answer was not a graph"}; asking again`,
        kind: "warn",
        detail: event.code || ""
      };

    case "graph": {
      const nodes = countOf(event.nodes);
      const edges = countOf(event.edges);
      const addedNodes = nodes - state.nodes;
      const addedEdges = edges - state.edges;
      state.nodes = nodes;
      state.edges = edges;
      const took = elapsed(event.ms ?? sinceChunk(state));
      const gained = `+${addedNodes} node${addedNodes === 1 ? "" : "s"}, +${addedEdges} connection${addedEdges === 1 ? "" : "s"}`;
      const total = `map now ${nodes} node${nodes === 1 ? "" : "s"}, ${edges} connection${edges === 1 ? "" : "s"}`;
      // The linking pass also sends a graph, without a chunk number.
      const head = where ? `${where} answered${took ? ` in ${took}` : ""}` : event.message || "Graph updated";
      return { text: `${head} — ${gained} (${total})`, kind: "ok" };
    }

    case "warning":
      return { text: event.message || "Something was skipped", kind: "warn", detail: detailOf(event) };

    case "done": {
      // The server times the extraction itself; the client clock is the fallback
      // for the plain-JSON path, which carries no timing.
      const took = elapsed(event.ms ?? (state.startedAt ? Date.now() - state.startedAt : 0));
      const warnings = (event.warnings || []).length;
      const chunks = event.chunks ? `${event.chunks} chunk${event.chunks === 1 ? "" : "s"}` : "";
      const trouble = warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : "";
      return {
        text: `${event.partial ? "Stopped early" : "Finished"}${took ? ` in ${took}` : ""} — ${chunks}${trouble}`,
        kind: event.partial || warnings ? "warn" : "ok"
      };
    }

    case "error":
      return { text: event.error || event.message || "Extraction failed", kind: "error", detail: detailOf(event) };

    default:
      return event.message ? { text: event.message, kind: "info" } : null;
  }
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

function detailOf(event) {
  const bits = [];
  if (event.code) bits.push(`[${event.code}]`);
  if (event.details) bits.push(String(event.details).slice(0, 400));
  return bits.join(" ");
}

function countOf(value) {
  return Array.isArray(value) ? value.length : Number(value) || 0;
}

function sinceChunk(state) {
  return state.chunkStartedAt ? Date.now() - state.chunkStartedAt : 0;
}

export function elapsed(ms) {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${String(Math.round(seconds % 60)).padStart(2, "0")} s`;
}

function count(value) {
  return Number(value || 0).toLocaleString();
}

function clock(date) {
  return date.toTimeString().slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

function byId(id) {
  if (typeof document === "undefined") return null;
  return document.getElementById(id);
}

function renderAll() {
  const list = byId("logList");
  if (!list) return;
  list.textContent = "";
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "log-empty";
    empty.textContent = "Nothing yet — the steps of the next run show up here.";
    list.appendChild(empty);
    return;
  }
  entries.forEach((entry) => list.appendChild(rowFor(entry)));
  list.scrollTop = list.scrollHeight;
}

function appendRow(entry) {
  const list = byId("logList");
  if (!list) return;
  list.querySelector(".log-empty")?.remove();
  list.appendChild(rowFor(entry));
  while (list.children.length > MAX_ENTRIES) list.removeChild(list.firstChild);
  if (pinnedToBottom) list.scrollTop = list.scrollHeight;
}

function rowFor(entry) {
  const row = document.createElement("div");
  row.className = "log-row";
  row.dataset.kind = entry.kind;

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = clock(entry.at);

  const body = document.createElement("div");
  body.className = "log-body";
  const text = document.createElement("span");
  text.className = "log-text";
  text.textContent = entry.text;
  body.appendChild(text);

  if (entry.detail) {
    const detail = document.createElement("code");
    detail.className = "log-detail";
    detail.textContent = entry.detail;
    body.appendChild(detail);
  }

  row.append(time, body);
  return row;
}

function syncBadge() {
  const badge = byId("logBadge");
  if (!badge) return;
  badge.hidden = unseen === 0;
  badge.textContent = unseen > 99 ? "99+" : String(unseen);
}
