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
import { generateMindMap, loadSampleTranscript } from "./api.js";
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
    const derived = titleFromTranscript(transcript);
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
      setTranscript(el.transcript.value);
      scheduleAutosave();
      updateCharCount();
      setStatus("Sample transcript loaded — hit Generate", "idle");
      logLine(`Sample transcript loaded — ${el.transcript.value.length.toLocaleString()} characters`, "info");
      el.transcript.focus();
    } catch {
      setStatus("Sample transcript could not be loaded", "error");
    }
  }

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

  el.generate.addEventListener("click", generate);
  el.loadSample.addEventListener("click", useSample);
  el.emptySample.addEventListener("click", useSample);
  el.emptyAdd.addEventListener("click", () => createNodeAt());
  el.transcript.addEventListener("input", (event) => {
    updateCharCount();
    // The transcript is part of the saved map, so it is part of what autosave
    // has to keep — but it never emits, so it schedules the save itself.
    setTranscript(event.target.value);
    scheduleAutosave();
  });
  el.transcript.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) generate();
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
    if (state.view === "notes") notes.focus(node.id);
    else graph.centreOn(node);
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
