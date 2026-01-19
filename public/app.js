const graphEl = document.getElementById("graph");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const nodeTypeEl = document.getElementById("nodeType");
const edgeTypeEl = document.getElementById("edgeType");
const generateBtn = document.getElementById("generate");

const API_TIMEOUT_MS = 25000;

const state = {
  nodes: [],
  edges: [],
  selectedNodeId: null,
  selectedEdgeId: null,
  addEdgeMode: false,
  edgeSourceId: null,
  nextNodeId: 1,
  nextEdgeId: 1
};

const typeColors = {
  cause: "#ef4444",
  theme: "#3b82f6",
  hierarchy: "#10b981"
};

const width = graphEl.clientWidth;
const height = graphEl.clientHeight;

const svg = d3.select(graphEl);
const container = svg.append("g");
const linkGroup = container.append("g").attr("class", "links");
const nodeGroup = container.append("g").attr("class", "nodes");

svg.call(
  d3
    .zoom()
    .scaleExtent([0.2, 2.5])
    .on("zoom", (event) => container.attr("transform", event.transform))
);

let simulation = d3.forceSimulation(state.nodes)
  .force("link", d3.forceLink().id((d) => d.id).distance(120))
  .force("charge", d3.forceManyBody().strength(-350))
  .force("center", d3.forceCenter(width / 2, height / 2))
  .force("collision", d3.forceCollide().radius(30));

function setStatus(text) {
  statusEl.textContent = text;
}

function sanitizeIncomingGraph(data) {
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];

  state.nodes = nodes.map((n) => ({
    id: String(n.id),
    label: String(n.label || "Untitled"),
    type: normalizeNodeType(n.type)
  }));

  const nodeIds = new Set(state.nodes.map((n) => n.id));

  state.edges = edges
    .map((e) => ({
      id: String(e.id),
      from: String(e.from),
      to: String(e.to),
      type: normalizeEdgeType(e.type)
    }))
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  state.nextNodeId = nextIdFrom(state.nodes.map((n) => n.id), "n");
  state.nextEdgeId = nextIdFrom(state.edges.map((e) => e.id), "e");
}

function nextIdFrom(ids, prefix) {
  let max = 0;
  ids.forEach((id) => {
    const match = String(id).match(/^(\D+)(\d+)$/);
    if (match && match[1] === prefix) {
      max = Math.max(max, Number(match[2]));
    }
  });
  return max + 1;
}

function normalizeNodeType(type) {
  const t = String(type || "").toLowerCase();
  return ["cause", "theme", "hierarchy"].includes(t) ? t : "theme";
}

function normalizeEdgeType(type) {
  const t = String(type || "").toLowerCase();
  return ["causes", "relates", "supports", "contrasts"].includes(t)
    ? t
    : "relates";
}

function render() {
  const links = state.edges.map((e) => ({
    ...e,
    source: e.from,
    target: e.to
  }));

  const linkSel = linkGroup
    .selectAll("line")
    .data(links, (d) => d.id);

  linkSel.exit().remove();

  const linkEnter = linkSel
    .enter()
    .append("line")
    .on("click", (event, d) => {
      event.stopPropagation();
      state.selectedEdgeId = d.id;
      state.selectedNodeId = null;
      updateSelection();
    });

  linkEnter.merge(linkSel)
    .attr("class", (d) => (d.id === state.selectedEdgeId ? "selected" : ""));

  const nodeSel = nodeGroup
    .selectAll("g.node")
    .data(state.nodes, (d) => d.id);

  nodeSel.exit().remove();

  const nodeEnter = nodeSel
    .enter()
    .append("g")
    .attr("class", "node")
    .call(drag(simulation));

  nodeEnter
    .append("circle")
    .attr("r", 18)
    .attr("fill", (d) => typeColors[d.type] || typeColors.theme);

  nodeEnter
    .append("text")
    .text((d) => d.label)
    .attr("dy", 0);

  nodeEnter
    .on("click", (event, d) => {
      event.stopPropagation();
      if (state.addEdgeMode) {
        handleEdgeSelection(d.id);
        return;
      }
      state.selectedNodeId = d.id;
      state.selectedEdgeId = null;
      updateSelection();
    })
    .on("dblclick", (event, d) => {
      event.stopPropagation();
      const next = prompt("Edit label", d.label);
      if (next && next.trim()) {
        d.label = next.trim();
        updateLabels();
      }
    });

  nodeSel
    .merge(nodeEnter)
    .select("text")
    .text((d) => d.label);

  nodeSel
    .merge(nodeEnter)
    .select("circle")
    .attr("fill", (d) => typeColors[d.type] || typeColors.theme);

  simulation.nodes(state.nodes).on("tick", () => {
    linkGroup
      .selectAll("line")
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    nodeGroup
      .selectAll("g.node")
      .attr("transform", (d) => `translate(${d.x}, ${d.y})`);
  });

  simulation.force("link").links(links);
  simulation.alpha(1).restart();
}

function updateSelection() {
  nodeGroup
    .selectAll("g.node")
    .classed("selected", (d) => d.id === state.selectedNodeId);

  linkGroup
    .selectAll("line")
    .classed("selected", (d) => d.id === state.selectedEdgeId);
}

function updateLabels() {
  nodeGroup.selectAll("g.node").select("text").text((d) => d.label);
}

function drag(sim) {
  function dragstarted(event, d) {
    if (!event.active) sim.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }
  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }
  function dragended(event, d) {
    if (!event.active) sim.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }
  return d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended);
}

function handleEdgeSelection(nodeId) {
  if (!state.edgeSourceId) {
    state.edgeSourceId = nodeId;
    setStatus(`Edge source selected: ${nodeId}`);
    return;
  }

  if (state.edgeSourceId === nodeId) {
    setStatus("Select a different target node.");
    return;
  }

  const edgeType = edgeTypeEl.value;
  state.edges.push({
    id: `e${state.nextEdgeId++}`,
    from: state.edgeSourceId,
    to: nodeId,
    type: edgeType
  });

  state.edgeSourceId = null;
  setStatus("Edge added.");
  render();
}

function addNode() {
  const label = prompt("Node label");
  if (!label || !label.trim()) return;

  const node = {
    id: `n${state.nextNodeId++}`,
    label: label.trim(),
    type: nodeTypeEl.value
  };

  state.nodes.push(node);

  if (state.selectedNodeId) {
    state.edges.push({
      id: `e${state.nextEdgeId++}`,
      from: state.selectedNodeId,
      to: node.id,
      type: edgeTypeEl.value
    });
  }

  render();
}

function removeNode() {
  if (!state.selectedNodeId) {
    setStatus("Select a node first.");
    return;
  }
  const id = state.selectedNodeId;
  state.nodes = state.nodes.filter((n) => n.id !== id);
  state.edges = state.edges.filter((e) => e.from !== id && e.to !== id);
  state.selectedNodeId = null;
  render();
}

function removeEdge() {
  if (!state.selectedEdgeId) {
    setStatus("Select an edge first.");
    return;
  }
  state.edges = state.edges.filter((e) => e.id !== state.selectedEdgeId);
  state.selectedEdgeId = null;
  render();
}

function toggleEdgeMode() {
  state.addEdgeMode = !state.addEdgeMode;
  state.edgeSourceId = null;
  setStatus(state.addEdgeMode ? "Add Edge Mode on" : "Add Edge Mode off");
  document.getElementById("toggleEdge").textContent = state.addEdgeMode
    ? "Exit Edge Mode"
    : "Add Edge Mode";
}

async function generateMindMap() {
  setStatus("Generating...");
  if (generateBtn) generateBtn.disabled = true;
  try {
    const transcript = transcriptEl.value.trim();
    if (!transcript) {
      setStatus("Transcript is empty.");
      return;
    }
    const response = await fetchWithTimeout(
      "/api/extract/stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript })
      },
      API_TIMEOUT_MS
    );

    if (!response.ok || !response.body) {
      await handleNonStreamingResponse(response);
      return;
    }

    await readSseStream(response);
  } catch (err) {
    const message = err && err.message ? err.message : String(err || "Unknown error");
    setStatus(`Error: ${message}`);
  } finally {
    if (generateBtn) generateBtn.disabled = false;
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function exportJson() {
  const payload = JSON.stringify({ nodes: state.nodes, edges: state.edges }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mindmap.json";
  a.click();
  URL.revokeObjectURL(url);
}

svg.on("click", () => {
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  updateSelection();
});

document.getElementById("generate").addEventListener("click", generateMindMap);
document.getElementById("addNode").addEventListener("click", addNode);
document.getElementById("removeNode").addEventListener("click", removeNode);
document.getElementById("toggleEdge").addEventListener("click", toggleEdgeMode);
document.getElementById("removeEdge").addEventListener("click", removeEdge);
document.getElementById("export").addEventListener("click", exportJson);

setStatus("Idle");
render();

async function handleNonStreamingResponse(response) {
  if (response && response.ok) {
    const data = await response.json();
    sanitizeIncomingGraph(data);
    render();
    setStatus("Mind map generated.");
    return;
  }

  const errorText = response ? await response.text() : "";
  let errorMessage = "Failed";
  let errorDetails = "";
  let errorCode = "";
  let requestId = "";
  try {
    const errorJson = JSON.parse(errorText);
    errorMessage = errorJson.error || errorMessage;
    errorDetails = errorJson.details ? ` (${errorJson.details})` : "";
    errorCode = errorJson.code ? ` [${errorJson.code}]` : "";
    requestId = errorJson.requestId ? ` (${errorJson.requestId})` : "";
  } catch {
    if (errorText) {
      errorMessage = errorText;
    }
  }
  const statusCode = response ? response.status : 0;
  const prefix = statusCode ? `Error ${statusCode}` : "Error";
  setStatus(`${prefix}${errorCode}: ${errorMessage}${errorDetails}${requestId}`);
}

async function readSseStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let splitIndex;
    while ((splitIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, splitIndex).trim();
      buffer = buffer.slice(splitIndex + 2);
      if (rawEvent) handleSseEvent(rawEvent);
    }
  }
}

function handleSseEvent(rawEvent) {
  const lines = rawEvent.split("\n");
  let eventName = "message";
  let dataText = "";

  lines.forEach((line) => {
    if (line.startsWith("event:")) {
      eventName = line.replace("event:", "").trim();
    } else if (line.startsWith("data:")) {
      dataText += line.replace("data:", "").trim();
    }
  });

  let data;
  try {
    data = dataText ? JSON.parse(dataText) : {};
  } catch {
    data = { message: dataText };
  }

  switch (eventName) {
    case "status":
    case "progress":
      if (data && data.message) setStatus(data.message);
      break;
    case "graph":
      sanitizeIncomingGraph(data || {});
      render();
      setStatus("Updating mind map...");
      break;
    case "done":
      setStatus("Mind map generated.");
      break;
    case "error": {
      const message = data && data.error ? data.error : "Failed";
      const details = data && data.details ? ` (${data.details})` : "";
      const code = data && data.code ? ` [${data.code}]` : "";
      const requestId = data && data.requestId ? ` (${data.requestId})` : "";
      setStatus(`Error${code}: ${message}${details}${requestId}`);
      break;
    }
    default:
      if (data && data.message) setStatus(data.message);
  }
}
