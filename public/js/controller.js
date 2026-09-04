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
  normalizeNodeType,
  normalizeEdgeType
} from "./state.js";
import { generateMindMap, loadSampleTranscript } from "./api.js";
import { exportJson, exportPng } from "./exporters.js";
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

export function connectController(graph) {
  /* ---------------------------- Graph gestures --------------------- */

  function onNodeClick(node) {
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
    node.fx = node.x;
    node.fy = node.y;
    openInlineEditor(node, graph, (label) => {
      withHistory(() => {
        const target = nodeById(node.id);
        if (target) target.label = label;
      });
    });
    const release = () => {
      node.fx = null;
      node.fy = null;
    };
    setTimeout(function check() {
      if (isInlineEditorOpen()) setTimeout(check, 120);
      else release();
    }, 120);
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

  async function generate() {
    const transcript = el.transcript.value.trim();
    if (!transcript) {
      setStatus("Paste a transcript first", "error");
      el.transcript.focus();
      return;
    }

    setBusy(true);
    setStatus("Sending the transcript to the model…", "busy");
    let received = false;

    await generateMindMap(transcript, {
      onStatus: (message) => setStatus(message, "busy"),
      onGraph: (data) => {
        received = true;
        withHistory(() => setGraph(data));
        setStatus("Building the map…", "busy");
      },
      onDone: () => {
        setBusy(false);
        setStatus(
          `Done — ${state.nodes.length} nodes, ${state.edges.length} connections`,
          "ok"
        );
        if (received) {
          graph.fit();
          toast("Mind map ready", "ok");
        }
      },
      onError: (message) => {
        setBusy(false);
        setStatus(message, "error");
        toast("Extraction failed", "error", 3600);
      }
    });
    setBusy(false);
  }

  async function useSample() {
    try {
      el.transcript.value = await loadSampleTranscript();
      updateCharCount();
      setStatus("Sample transcript loaded — hit Generate", "idle");
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

  initTheme(() => graph.refreshTheme());
  initSidebar(() => graph.resize());

  el.generate.addEventListener("click", generate);
  el.loadSample.addEventListener("click", useSample);
  el.emptySample.addEventListener("click", useSample);
  el.emptyAdd.addEventListener("click", () => createNodeAt());
  el.transcript.addEventListener("input", updateCharCount);
  el.transcript.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) generate();
  });

  el.addNode.addEventListener("click", () => createNodeAt());
  el.toggleEdge.addEventListener("click", () => {
    setConnectMode(!state.connectMode);
    if (state.connectMode) toast("Connect mode on — click two nodes");
  });
  el.undo.addEventListener("click", () => {
    if (undo()) toast("Undone");
  });
  el.redo.addEventListener("click", () => {
    if (redo()) toast("Redone");
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
    const hit = state.nodes.find((n) => n.label.toLowerCase().includes(state.query));
    if (hit) {
      select("node", hit.id);
      graph.centreOn(hit);
    }
  });

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
    const button = event.target.closest("button[data-export]");
    if (!button) return;
    closeExportMenu();
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
      if (state.connectMode) return setConnectMode(false);
      return clearSelection();
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey ? redo() : undo()) toast(event.shiftKey ? "Redone" : "Undone");
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
