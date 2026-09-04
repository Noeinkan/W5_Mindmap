/**
 * The note view: the same graph as a Zettelkasten instead of a picture.
 *
 * A mind map answers "how is this shaped?". It cannot answer "what was actually
 * said?", because a canvas has room for a label and nothing else — and the most
 * valuable thing the extractor produces, the verbatim `quote` it copied out of
 * the transcript to justify each concept, was until now written to the JSON
 * export and never shown. Here each concept is an atomic note carrying that
 * quote, its id, and its links out and back, so the graph can be read.
 *
 * Cards are ordered by the same tree the map draws and carry the same branch
 * colour, so a concept sits in the same place in your head in both views.
 */

import { state, isVisible, matchesQuery, linksOf, nodeById } from "./state.js";
import { buildTree } from "./tree.js";
import { readPalette, branchColour } from "./palette.js";

export function createNotes(container, handlers = {}) {
  let cards = new Map();

  /** Rebuilds the board. Cheap enough at map sizes; `paint` handles the rest. */
  function render() {
    const palette = readPalette();
    const tree = buildTree(state.nodes, state.edges, { title: state.title });
    const colours = branchColours(tree, palette);

    container.textContent = "";
    cards = new Map();

    ordered(tree).forEach((node) => {
      const card = buildCard(node, colours.get(node.id) || palette.accentHi);
      cards.set(node.id, card);
      container.appendChild(card);
    });

    paint();
  }

  /** Node order: the tree's, so the board reads like the map does. */
  function ordered(tree) {
    if (!tree) return state.nodes;
    const rank = new Map(tree.order.map((id, index) => [id, index]));
    return [...state.nodes].sort(
      (a, b) => (rank.get(a.id) ?? 1e6) - (rank.get(b.id) ?? 1e6)
    );
  }

  function branchColours(tree, palette) {
    const colours = new Map();
    if (!tree) return colours;
    const index = new Map(
      tree.byId.get(tree.root.id).children.map((id, position) => [id, position])
    );
    tree.order.forEach((id) => {
      const branch = tree.byId.get(id)?.branch;
      colours.set(id, branchColour(palette, branch, index.get(branch) ?? 0));
    });
    return colours;
  }

  function buildCard(node, colour) {
    const card = document.createElement("article");
    card.className = "note-card";
    card.dataset.id = node.id;
    card.style.setProperty("--note-colour", colour);
    card.tabIndex = 0;

    const head = document.createElement("div");
    head.className = "note-head";
    head.appendChild(span("note-id", `#${node.id}`));
    const type = span("note-type", node.type);
    type.dataset.type = node.type;
    head.appendChild(type);
    if (node.mentions > 1) head.appendChild(span("note-mentions", `${node.mentions}×`));
    card.appendChild(head);

    const title = document.createElement("h3");
    title.className = "note-title";
    title.textContent = node.label;
    card.appendChild(title);

    if (node.quote) {
      const quote = document.createElement("blockquote");
      quote.className = "note-quote";
      quote.textContent = `“${node.quote}”`;
      card.appendChild(quote);
    } else {
      card.appendChild(span("note-empty", "No quote captured for this concept"));
    }

    const { out, in: incoming } = linksOf(node.id);
    if (out.length || incoming.length) {
      const links = document.createElement("div");
      links.className = "note-links";
      out.forEach((edge) => links.appendChild(linkRow(edge, edge.to, "out")));
      incoming.forEach((edge) => links.appendChild(linkRow(edge, edge.from, "in")));
      card.appendChild(links);
    }

    card.addEventListener("click", (event) => {
      if (event.target.closest("button[data-goto]")) return;
      handlers.onSelect?.(node);
    });
    card.addEventListener("dblclick", () => handlers.onEdit?.(node));
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      handlers.onSelect?.(node);
    });

    return card;
  }

  /**
   * One link. The relation type is spelled out rather than left to a colour:
   * "causes" and "supports" are the whole point of a typed graph, and on a card
   * there is room to say so.
   */
  function linkRow(edge, otherId, direction) {
    const other = nodeById(otherId);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-link";
    button.dataset.goto = otherId;
    button.dataset.direction = direction;
    button.appendChild(span("note-arrow", direction === "out" ? "→" : "←"));
    button.appendChild(span("note-rel", edge.type));
    button.appendChild(span("note-target", other?.label || otherId));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (other) handlers.onFollow?.(other, edge);
    });
    return button;
  }

  /** Cheap restyle: selection, neighbours, search matches, type filters. */
  function paint() {
    const selection = state.selection;
    const selectedId = selection?.kind === "node" ? selection.id : null;
    const selectedEdge = selection?.kind === "edge" ? selection.id : null;
    const neighbours = new Set();
    if (selectedId) {
      state.edges.forEach((e) => {
        if (e.from === selectedId) neighbours.add(e.to);
        if (e.to === selectedId) neighbours.add(e.from);
      });
    }

    cards.forEach((card, id) => {
      const node = nodeById(id);
      if (!node) return;
      card.hidden = !isVisible(node);
      card.classList.toggle("dim", Boolean(state.query) && !matchesQuery(node));
      card.classList.toggle("hit", Boolean(state.query) && matchesQuery(node));
      card.classList.toggle("selected", id === selectedId);
      card.classList.toggle("linked", neighbours.has(id));
      card.classList.toggle("pending", state.pendingSourceId === id);
      card.querySelectorAll(".note-link").forEach((button) => {
        const edge = state.edges.find(
          (e) =>
            (e.from === id && e.to === button.dataset.goto) ||
            (e.to === id && e.from === button.dataset.goto)
        );
        button.classList.toggle("active", Boolean(edge) && edge.id === selectedEdge);
      });
    });
  }

  /** Brings one note into view and flashes it — used by search and by links. */
  function focus(id) {
    const card = cards.get(id);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("flash");
    // Reading offsetWidth restarts the animation; without it a second jump to
    // the same card does nothing at all.
    void card.offsetWidth;
    card.classList.add("flash");
  }

  return { render, paint, focus };
}

/** A span with a class and its text — set as text, never as markup. */
function span(className, text) {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}
