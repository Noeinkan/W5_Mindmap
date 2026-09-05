/** Wires every control, gesture and keyboard shortcut to a state mutation. */

import {
  state,
  withHistory,
  undo,
  redo,
  select,
  clearSelection,
  setConnectMode,
  setQuery,
  toggleTypeVisibility,
  toggleCollapse,
  expandAll,
  openFolds,
  addNode,
  addEdge,
  removeNode,
  removeEdge,
  nodeById,
  setGraph,
  emit,
  setView,
  setTitle,
  setTranscript,
  unpinAll,
  matchesQuery,
  normalizeNodeType,
  normalizeEdgeType
} from "./state.js";
import { SYNTHETIC_ROOT } from "./tree.js";
import { generateMindMap, loadSampleTranscript, ingestDocument } from "./api.js";
import { initSections, showDocument, clearDocument, choose, WHOLE_DOCUMENT } from "./sections.js";
import { exportJson, exportPng } from "./exporters.js";
import { readDocument } from "./graph-doc.js";
import { applyDocument, scheduleAutosave } from "./session.js";
import { initLibrary, setOpenGraph, saveToLibrary } from "./library.js";
import {
  el,
  setStatus,
  setBusy,
  toast,
  buildChips,
  initTheme,
  initSidebar,
  updateCharCount,
  openInlineEditor,
  dismissInlineEditor,
  isInlineEditorOpen,
  syncPanels
} from "./ui.js";
import {
  initLog,
  logLine,
  logRunStart,
  logServerEvent,
  toggleLogPanel,
  toggleExpanded,
  isLogExpanded
} from "./log.js";

export function connectController(graph, notes) {
  // Whether the map's title came from a file — a book's own title, or the
  // chapter's. It survives until the transcript is typed over or replaced.
  let titleFromFile = false;

  /* ---------------------------- Graph gestures --------------------- */

  function onNodeClick(node) {
    // The centre of a map with several branches stands for the transcript, not
    // for a concept: there is nothing to select or connect.
    if (node.id === SYNTHETIC_ROOT) {
      clearSelection();
      return;
    }
    if (state.connectMode) {
      handleConnectClick(node);
      return;
    }
    select("node", node.id);
  }

  /**
   * Folds the branch under a node away, or opens it again.
   *
   * The count comes back from the graph rather than being worked out here: the
   * controller holds nodes and edges, and how many of them hang under one node
   * is a fact about the tree, which is the map view's own reading of them.
   */
  function foldBranch(node) {
    if (!node || node.id === SYNTHETIC_ROOT) return;
    toggleCollapse(node.id);

    const hidden = graph.hiddenUnder(node.id);
    if (hidden) {
      toast(`Branch folded — ${hidden} node${hidden > 1 ? "s" : ""} hidden`);
      return;
    }
    // Nothing hung off it. Left as it is, the map would look untouched and the
    // fold would have no badge to undo it with, so it is taken straight back.
    if (state.collapsed.has(node.id)) {
      toggleCollapse(node.id);
      toast("Nothing to fold under this node");
      return;
    }
    toast("Branch opened");
  }

  function handleConnectClick(node) {
    if (!state.pendingSourceId) {
      state.pendingSourceId = node.id;
      emit("mode");
      return;
    }
    if (state.pendingSourceId === node.id) {
      toast("Pick a different node as the target");
      return;
    }
    const source = state.pendingSourceId;
    let created = null;
    withHistory(() => {
      created = addEdge(source, node.id, el.edgeType.value);
      state.pendingSourceId = null;
    });
    toast(created ? "Connection added" : "Those nodes are already connected", created ? "ok" : "info");
  }

  function editNode(node) {
    // Renaming the centre renames the map, not a node: it is the one label on
    // the canvas that has no row in the graph.
    if (node.id === SYNTHETIC_ROOT) {
      openInlineEditor(node, graph, (label) => setTitle(label));
      return;
    }
    openInlineEditor(node, graph, (label) => {
      withHistory(() => {
        const target = nodeById(node.id);
        if (target) target.label = label;
      });
    });
  }

  /* ---------------------------- Actions ---------------------------- */

  function createNodeAt(point) {
    // Nudge new nodes off the exact centre so two in a row do not start stacked.
    const centre = graph.viewportCentre();
    const position = point || {
      x: centre.x + (Math.random() - 0.5) * 90,
      y: centre.y + (Math.random() - 0.5) * 90
    };
    let created = null;
    withHistory(() => {
      created = addNode("New idea", el.nodeType.value, position);
    });
    editNode(created);
  }

  function deleteSelection() {
    const selection = state.selection;
    if (!selection) {
      toast("Select a node or a connection first");
      return;
    }
    withHistory(() => {
      if (selection.kind === "node") removeNode(selection.id);
      else removeEdge(selection.id);
    });
    toast(selection.kind === "node" ? "Node deleted" : "Connection deleted", "ok");
  }

  /**
   * One step back or forward, with the transcript box put back in step with it.
   * A history entry can carry a different transcript — opening a file replaces
   * both — and the textarea is the one thing on screen no re-render touches.
   */
  function stepHistory(back) {
    if (!(back ? undo() : redo())) return false;
    if (el.transcript.value !== state.transcript) {
      el.transcript.value = state.transcript;
      updateCharCount();
    }
    return true;
  }

  async function generate() {
    const transcript = el.transcript.value.trim();
    if (!transcript) {
      setStatus("Paste a transcript first", "error");
      el.transcript.focus();
      return;
    }

    setBusy(true);
    setStatus("Sending the transcript to the model…", "busy");
    logRunStart(transcript.length);
    setTranscript(transcript);
    // A map generated from scratch is a new map: Save must not land on top of
    // whichever library entry happened to be open before it.
    setOpenGraph(null);
    // The centre of the map is the meeting itself, so it gets the meeting's own
    // first line where there is one. Double-click it to say something better.
    // A title that came from a file — the book's own, or the chapter's — is
    // already better than a guess at the first line, so it stands.
    const derived = titleFromFile ? null : titleFromTranscript(transcript);
    if (derived) state.title = derived;
    let received = false;

    await generateMindMap(transcript, {
      onStatus: (message) => setStatus(message, "busy"),
      // The status line shows the latest step; the log keeps all of them, with
      // the chunk numbers, timings and warning codes the line has no room for.
      onEvent: logServerEvent,
      onGraph: (data) => {
        received = true;
        withHistory(() => setGraph(data));
        setStatus("Building the map…", "busy");
      },
      onDone: (result = {}) => {
        setBusy(false);
        const warnings = result.warnings || [];
        const summary = `${state.nodes.length} nodes, ${state.edges.length} connections`;
        setStatus(
          result.partial ? `Stopped early — ${summary} from part of the transcript` : `Done — ${summary}`,
          result.partial ? "error" : "ok"
        );
        if (received) {
          graph.fitWhenSettled();
          // What the canvas ended up with, which is not always what the server
          // counted: merging and sanitising happen on this side too.
          logLine(`Map drawn — ${summary}`, "info");
          // Warnings are chunks the model fumbled or never reached. Dropping them
          // silently is how a map loses a third of the meeting with no clue why.
          if (warnings.length) {
            toast(
              `${warnings.length} chunk${warnings.length > 1 ? "s" : ""} skipped — ${warnings[0].message}`,
              "error",
              5200
            );
          } else {
            toast("Mind map ready", "ok");
          }
        }
      },
      onError: (message, meta = {}) => {
        setBusy(false);
        setStatus(message, "error");
        if (meta.partial && received) {
          graph.fitWhenSettled();
          toast("Partial map kept — see the message above", "error", 4600);
          return;
        }
        toast("Extraction failed", "error", 3600);
      }
    });
    setBusy(false);
  }

  /**
   * A heading for the map, taken from the transcript's opening line — but only
   * when that line is a heading. A transcript that opens on a speaker turn
   * ("PM: The main worry is…") has none, and half a sentence in the middle of
   * the canvas is worse than the neutral default.
   */
  function titleFromTranscript(text) {
    const first = text.split("\n").find((line) => line.trim());
    if (!first || /^[A-Za-z][\w .]{0,14}:/.test(first.trim())) return null;
    const sentence = first.trim().split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, "");
    if (sentence.length <= 44) return sentence;
    const cut = sentence.slice(0, 44);
    return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:–—-]+$/, "");
  }

  /**
   * Puts a document on the canvas: an imported file, or a map from the library.
   * Undoable, because it replaces everything that was there.
   */
  function openDocument(doc) {
    applyDocument(doc, { undoable: true });
    // Whatever file was read, this map replaced its transcript: the section list
    // would now cut up a text that is no longer in the box.
    clearDocument();
    titleFromFile = false;
    graph.fitWhenSettled();
    setStatus(
      `${doc.title} — ${doc.nodes.length} nodes, ${doc.edges.length} connections`,
      "ok"
    );
  }

  async function importFile(file) {
    if (!file) return;
    const { ok, errors, warnings, doc } = readDocument(await file.text());

    if (!ok) {
      setStatus(`Import failed — ${errors[0] || "that file is not a mind map"}`, "error");
      logLine(`Import failed — ${file.name}`, "error", errors.join(" "));
      toast("That file is not a mind map", "error", 4200);
      return;
    }
    if (!doc.nodes.length) {
      setStatus("That file has no nodes to draw", "error");
      toast("That file has no nodes to draw", "error", 4200);
      return;
    }

    openDocument(doc);
    // An imported file is a file, not a library entry — until it is saved.
    setOpenGraph(null);
    logLine(`Imported ${file.name} — ${doc.nodes.length} nodes, ${doc.edges.length} connections`, "ok");
    warnings.forEach((warning) => logLine(warning, "warn"));
    toast(
      warnings.length ? `Imported with ${warnings.length} problem${warnings.length > 1 ? "s" : ""} — see the log` : "Map imported",
      warnings.length ? "info" : "ok",
      warnings.length ? 4600 : 2600
    );
  }

  async function useSample() {
    try {
      el.transcript.value = await loadSampleTranscript();
      putInTranscript(el.transcript.value);
      clearDocument();
      titleFromFile = false;
      setStatus("Sample transcript loaded — hit Generate", "idle");
      logLine(`Sample transcript loaded — ${el.transcript.value.length.toLocaleString()} characters`, "info");
      el.transcript.focus();
    } catch {
      setStatus("Sample transcript could not be loaded", "error");
    }
  }

  /* ------------------------- Reading a file ------------------------ */

  /**
   * A document short enough to map in one go. Above it, opening a file loads one
   * section rather than all of it: a book is three hundred chunks and an hour of
   * model time, and the Sections panel is where the rest of it waits.
   */
  const WHOLE_DOCUMENT_LIMIT = 20000;
  /**
   * The most that is put in the box without being asked for — about a quarter of
   * an hour of model time. A section can be far bigger than this: books exist
   * whose contents list names one chapter and then holds the entire novel, and
   * loading that on the way past would be a surprise, not a convenience.
   */
  const AUTO_LOAD_LIMIT = 60000;
  /** Below this a section is a title page or a heading, not something to map. */
  const SUBSTANTIAL = 1200;

  /** Reads a PDF, EPUB or text file into the transcript box. */
  async function readFile(file) {
    if (!file) return;

    setBusy(true);
    setStatus(`Reading ${file.name}…`, "busy");
    logLine(`Reading ${file.name} — ${formatSize(file.size)}`, "info");

    try {
      const doc = await ingestDocument(file);
      showDocument({ ...doc, name: file.name });

      logLine(
        `${file.name} — ${doc.chars.toLocaleString()} characters over ${count(doc.units, doc.unitLabel)}, ${count(doc.sections.length, "section")}`,
        "ok"
      );
      doc.warnings.forEach((warning) => logLine(warning, "warn"));

      // Small enough to map whole, or long enough that one section is the
      // sensible first bite. Either way the panel is open and says what else
      // there is.
      const whole = doc.chars <= WHOLE_DOCUMENT_LIMIT || doc.sections.length < 2;
      const kind = doc.kind === "epub" ? "book" : "document";

      if (whole) {
        choose(WHOLE_DOCUMENT);
        setStatus(`${file.name} — ${doc.chars.toLocaleString()} characters. Hit Generate.`, "ok");
      } else {
        el.sectionsPanel.open = true;
        const index = firstLoadableSection(doc);
        if (index === -1) {
          // Every section is either a heading or the size of a book. Nothing goes
          // in the box uninvited; the list says what the choices cost. The box is
          // emptied all the same — leaving the last file's text under a new
          // file's section list is how the wrong thing gets mapped.
          putInTranscript("");
          setStatus(
            `${file.name} — ${doc.chars.toLocaleString()} characters in ${doc.sections.length} sections. Pick one below.`,
            "ok"
          );
        } else {
          const picked = choose(index);
          setStatus(
            `${picked.title} loaded — ${doc.sections.length} sections in this ${kind}, pick another below.`,
            "ok"
          );
        }
      }
      toast(doc.warnings.length ? "File read — see the log" : "File read", doc.warnings.length ? "info" : "ok");
    } catch (err) {
      const message = (err && err.message) || "That file could not be read";
      setStatus(message, "error");
      logLine(`${file.name} — ${message}`, "error");
      toast("That file could not be read", "error", 4600);
    } finally {
      setBusy(false);
    }
  }

  /**
   * The first section worth putting in the box on the way past: past the cover,
   * the title page and the copyright notice, and not the one that turns out to
   * hold the whole novel. `-1` when there is no such thing.
   */
  function firstLoadableSection(doc) {
    // A section worth opening on holds a real share of the document as well as a
    // real number of characters. The share is what rules out the copyright page
    // of a book whose contents list has put every chapter in one section.
    const floor = Math.max(SUBSTANTIAL, doc.chars * 0.01);
    return doc.sections.findIndex((section) => section.chars >= floor && section.chars <= AUTO_LOAD_LIMIT);
  }

  /** Puts text in the box and tells everything that cares. */
  function putInTranscript(text) {
    el.transcript.value = text;
    setTranscript(text);
    updateCharCount();
    scheduleAutosave();
  }

  function formatSize(bytes) {
    if (!bytes) return "unknown size";
    return bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const count = (n, noun) => `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;

  /** A drag carrying a file, as opposed to selected text from another window. */
  const hasFiles = (event) =>
    Boolean(event.dataTransfer) && Array.from(event.dataTransfer.types || []).includes("Files");

  /* ---------------------------- Wiring ----------------------------- */

  buildChips({
    onNodeType: (type) => {
      if (state.selection?.kind !== "node") return;
      const id = state.selection.id;
      withHistory(() => {
        const node = nodeById(id);
        if (node) node.type = normalizeNodeType(type);
      });
    },
    onEdgeType: (type) => {
      if (state.selection?.kind !== "edge") return;
      const id = state.selection.id;
      withHistory(() => {
        const edge = state.edges.find((e) => e.id === id);
        if (edge) edge.type = normalizeEdgeType(type);
      });
    },
    onLegendToggle: (type) => toggleTypeVisibility(type)
  });

  // Both views read their colours from the CSS custom properties, so a theme
  // change is a redraw for each of them.
  initTheme(() => {
    graph.refreshTheme();
    notes.render();
  });
  initSidebar(() => graph.resize());
  initLog({ notify: toast });
  // Picking a section replaces what is in the box, and names the map after it:
  // a map of chapter seven should not be called after the whole book.
  initSections({
    onPick: ({ title, text, whole, chosen }) => {
      putInTranscript(text);
      if (title) {
        state.title = title;
        titleFromFile = true;
      }
      // Only a click on the list says so out loud: the section chosen while a
      // file is being read has its own line, and two would fight over it.
      if (chosen) {
        setStatus(`${title} — ${text.length.toLocaleString()} characters. Hit Generate.`, "ok");
        if (!whole) logLine(`Section loaded — ${title} (${text.length.toLocaleString()} characters)`, "info");
      }
    }
  });

  el.generate.addEventListener("click", generate);
  el.loadSample.addEventListener("click", useSample);
  el.emptySample.addEventListener("click", useSample);
  el.emptyAdd.addEventListener("click", () => createNodeAt());
  el.openFile.addEventListener("click", () => el.documentFile.click());
  el.documentFile.addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    // Cleared first: picking the same file twice in a row fires no second change
    // event otherwise, which reads as a dead button.
    event.target.value = "";
    readFile(file);
  });
  el.transcript.addEventListener("input", (event) => {
    updateCharCount();
    // The transcript is part of the saved map, so it is part of what autosave
    // has to keep — but it never emits, so it schedules the save itself.
    setTranscript(event.target.value);
    scheduleAutosave();
    // Typed over: the title the file gave has stopped describing what is here.
    titleFromFile = false;
  });
  el.transcript.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) generate();
  });

  // Dropping a file on the transcript box reads it. The window-level handlers
  // are what stop the browser from doing its own thing with a file dropped
  // anywhere else — which is to leave the page and open the PDF, taking the map
  // on the canvas with it.
  const dropZone = el.transcriptDrop;
  const overZone = (event) => dropZone.contains(event.target);

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.toggle("dropping", overZone(event) && hasFiles(event));
  });
  window.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) dropZone.classList.remove("dropping");
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dropping");
    if (!overZone(event)) return;
    const [file] = (event.dataTransfer && event.dataTransfer.files) || [];
    if (file) readFile(file);
  });

  el.addNode.addEventListener("click", () => createNodeAt());
  el.toggleEdge.addEventListener("click", () => {
    setConnectMode(!state.connectMode);
    if (state.connectMode) toast("Connect mode on — click two nodes");
  });
  el.undo.addEventListener("click", () => {
    if (stepHistory(true)) toast("Undone");
  });
  el.redo.addEventListener("click", () => {
    if (stepHistory(false)) toast("Redone");
  });
  el.deleteSelected.addEventListener("click", deleteSelection);
  el.inspectorClose.addEventListener("click", clearSelection);

  el.nodeLabel.addEventListener("focus", (event) => {
    event.target.dataset.original = event.target.value;
  });
  el.nodeLabel.addEventListener("input", (event) => {
    if (state.selection?.kind !== "node") return;
    const node = nodeById(state.selection.id);
    if (!node) return;
    node.label = event.target.value;
    graph.render({ reheat: false });
  });
  el.nodeLabel.addEventListener("change", (event) => {
    if (state.selection?.kind !== "node") return;
    const node = nodeById(state.selection.id);
    if (!node) return;
    const next = event.target.value.trim() || "Untitled";
    node.label = event.target.dataset.original ?? next;
    withHistory(() => {
      node.label = next;
    });
    event.target.value = next;
  });

  el.search.addEventListener("input", (event) => setQuery(event.target.value));
  el.search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.target.value = "";
      setQuery("");
      event.target.blur();
      return;
    }
    if (event.key !== "Enter" || !state.query) return;
    const hit = state.nodes.find(matchesQuery);
    if (hit) reveal(hit);
  });

  /** Brings a node into view in whichever view is on screen. */
  function reveal(node) {
    select("node", node.id);
    if (state.view === "notes") {
      notes.focus(node.id);
      return;
    }
    // Following a link into a folded branch has to open it on the way, or the
    // map would travel to a spot where the node is not drawn.
    const opened = openFolds(graph.foldsHiding(node.id));
    if (opened) toast(`Opened ${opened} branch${opened > 1 ? "es" : ""} to get there`);
    graph.centreOn(node);
  }

  el.viewMap.addEventListener("click", () => setView("map"));
  el.viewNotes.addEventListener("click", () => setView("notes"));

  el.zoomIn.addEventListener("click", graph.zoomIn);
  el.zoomOut.addEventListener("click", graph.zoomOut);
  el.zoomFit.addEventListener("click", () => graph.fit());

  el.modeBannerExit.addEventListener("click", () => setConnectMode(false));

  /* Export menu */
  const closeExportMenu = () => {
    el.exportMenu.hidden = true;
    el.exportBtn.setAttribute("aria-expanded", "false");
  };
  el.exportBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = el.exportMenu.hidden;
    el.exportMenu.hidden = !open;
    el.exportBtn.setAttribute("aria-expanded", String(open));
  });
  el.exportMenu.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-export], button[data-action]");
    if (!button) return;
    closeExportMenu();

    if (button.dataset.action === "import") {
      el.importFile.click();
      return;
    }
    if (!state.nodes.length) {
      toast("Nothing to export yet", "error");
      return;
    }
    try {
      if (button.dataset.export === "json") {
        exportJson();
        toast("mindmap.json downloaded", "ok");
      } else {
        await exportPng(graph);
        toast("mindmap.png downloaded", "ok");
      }
    } catch (err) {
      toast(err.message || "Export failed", "error");
    }
  });
  document.addEventListener("click", closeExportMenu);

  el.importFile.addEventListener("change", async (event) => {
    const [file] = event.target.files || [];
    // Cleared before the file is read: picking the same file twice in a row
    // fires no second change event otherwise, which reads as a dead button.
    event.target.value = "";
    try {
      await importFile(file);
    } catch (err) {
      setStatus(err.message || "That file could not be read", "error");
      toast("That file could not be read", "error", 4200);
    }
  });

  /* Saved maps */
  initLibrary({ onOpen: openDocument });

  /* Double-click on empty canvas creates a node there */
  el.graph.addEventListener("dblclick", (event) => {
    if (event.target !== el.graph) return;
    const transform = graph.getTransform();
    const [x, y] = transform.invert([event.offsetX, event.offsetY]);
    createNodeAt({ x, y });
  });

  /* Keyboard shortcuts */
  document.addEventListener("keydown", (event) => {
    const typing =
      isInlineEditorOpen() ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);

    if (event.key === "Escape") {
      if (isInlineEditorOpen()) return dismissInlineEditor();
      if (!el.exportMenu.hidden) return closeExportMenu();
      // Expanded, the log covers the canvas: Escape has to give the map back.
      if (isLogExpanded()) return toggleExpanded(false);
      if (state.connectMode) return setConnectMode(false);
      return clearSelection();
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (stepHistory(!event.shiftKey)) toast(event.shiftKey ? "Redone" : "Undone");
      return;
    }

    // Ctrl+S means save in every editor, and here too — including from inside
    // the transcript box, which is why it sits above the "user is typing" guard.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveToLibrary();
      return;
    }

    if (typing) return;

    switch (event.key.toLowerCase()) {
      case "n":
        event.preventDefault();
        createNodeAt();
        break;
      case "e":
        setConnectMode(!state.connectMode);
        break;
      case "f":
        graph.fit();
        break;
      case "v":
        setView(state.view === "map" ? "notes" : "map");
        break;
      case "r": {
        // Hands every hand-placed node back to the radial layout.
        const pinned = unpinAll();
        graph.render();
        graph.fitWhenSettled();
        toast(pinned ? `Layout redrawn — ${pinned} node${pinned > 1 ? "s" : ""} released` : "Layout redrawn");
        break;
      }
      case "l":
        // Shift+L throws the log over the canvas, where long lines fit.
        if (event.shiftKey) toggleExpanded();
        else toggleLogPanel();
        break;
      case "c": {
        // Shift+C opens everything, which is the way back when a map has been
        // folded down to a few branches and the badge you want is off screen.
        if (event.shiftKey) {
          const opened = expandAll();
          toast(opened ? `${opened} branch${opened > 1 ? "es" : ""} opened` : "Nothing folded");
          break;
        }
        if (state.selection?.kind === "node") foldBranch(nodeById(state.selection.id));
        break;
      }
      case "/":
        event.preventDefault();
        el.search.focus();
        break;
      case "delete":
      case "backspace":
        if (state.selection) {
          event.preventDefault();
          deleteSelection();
        }
        break;
      case "enter": {
        if (state.selection?.kind === "node") {
          const node = nodeById(state.selection.id);
          if (node) editNode(node);
        }
        break;
      }
      default:
        break;
    }
  });

  return {
    onNodeClick,
    onNodeDoubleClick: editNode,
    onNodeToggle: foldBranch,
    // A card is a node: clicking one selects it, and picks it up in connect
    // mode exactly as clicking it on the canvas would.
    onNoteSelect: onNodeClick,
    onNoteFollow: (node) => reveal(node),
    onNoteEdit: (node) => {
      select("node", node.id);
      el.nodeLabel.focus();
      el.nodeLabel.select();
    },
    onEdgeClick: (edge) => select("edge", edge.id),
    onBackgroundClick: () => {
      if (state.pendingSourceId) {
        state.pendingSourceId = null;
        emit("mode");
      }
      clearSelection();
    },
    onZoom: (transform) => {
      el.zoomLevel.textContent = `${Math.round(transform.k * 100)}%`;
    }
  };
}
