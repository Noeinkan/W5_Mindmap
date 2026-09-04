# Transcript Mind Map

Minimal app that uses a local Ollama model to extract a typed mind‑map graph from a transcript and renders it with an editable D3.js force layout.

## Requirements

- Node.js 18+
- Ollama running locally

## Run

1. Install dependencies:
   - `npm install`
2. Start the server:
   - `npm start`
3. Open http://localhost:3200

The status line tells you straight away whether Ollama is reachable and whether the configured model is pulled, so you find out before pasting a transcript rather than forty seconds into a generation.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3200` | HTTP port |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `OLLAMA_MODEL` | `gemma3:4b` | Model used for extraction — must be pulled locally (`ollama pull gemma3:4b`) |
| `OLLAMA_TIMEOUT_MS` | `120000` | Per-request timeout, i.e. per chunk |
| `OLLAMA_RETRIES` | `1` | Retries on a transport failure |
| `OLLAMA_RETRY_BACKOFF_MS` | `500` | Base backoff, doubled per retry |
| `OLLAMA_HEALTH_TIMEOUT_MS` | `2500` | Timeout for the health probe |
| `SSE_HEARTBEAT_MS` | `10000` | Keep-alive comment sent while a chunk is being processed; must stay under the browser's 45 s idle timeout |
| `TRANSCRIPT_CHUNK_SIZE` | `3500` | Max characters per chunk |
| `TRANSCRIPT_CHUNK_OVERLAP_LINES` | `1` | Lines repeated from the previous chunk |
| `CHUNK_PARSE_RETRIES` | `1` | Stricter re-asks when the model answers with prose or nothing |
| `OLLAMA_FORMAT_SCHEMA` | `1` | Send a JSON schema as `format`; set to `0` for an Ollama older than 0.5 |
| `LINK_PASS` | `1` | One extra call at the end that connects concepts found in different chunks |
| `KNOWN_LABELS_IN_PROMPT` | `40` | Concepts fed back into later chunk prompts |
| `NODE_ENV` | `development` | `production` hides error details from responses |

## How extraction works

1. **Chunking** cuts the transcript at line boundaries only, so speaker turns (`IM: And agree the CDE naming convention…`) stay intact. A line longer than the limit is the one case that gets split on words. Each chunk repeats the last line of the previous one so a thought straddling a cut is still visible whole. Chunks are then evened out: filling each one to the brim split the 3658-character sample into 3354 + 304, and a 304-character tail is short enough that the model answers it with an empty graph.
2. **Each chunk** is asked for with a JSON schema, not with `format: "json"`. Plain JSON mode only promises *some* valid JSON, and the shortest valid JSON is `{}` — which is what gemma3:4b answered for whole chunks, however the prompt was worded. The schema requires both arrays, so that exit is closed.
3. **The prompt carries the concepts found so far**, so the model reuses the exact label `Handover Issues` instead of inventing `Issues with handover`.
4. **Merging** collapses nodes whose labels match once case, punctuation and a leading article are ignored, then rewrites every edge onto the surviving node ids. Without that rewrite the same concept is drawn once per chunk that mentions it.
5. **A linking pass** closes the run. Each chunk is extracted alone, so its concepts only ever get edges to concepts from the same chunk and the map still reads as one island per chunk. This pass shows the model the concept list alone — no transcript, so it is short — and asks only for the edges that cross between groups. Edges pointing at ids it made up are dropped.
6. **Failures are separated.** A chunk the model answered badly is re-asked once with a stricter instruction, then skipped with a warning — the rest of the map survives. A chunk that comes back well-formed but empty is asked once more, then reported as `empty_chunk` rather than as a schema error. A transport failure (Ollama down, timed out) stops the run at once, because every remaining chunk would fail the same way, slowly — but the chunks already done are still returned, as a `partial` map with an `ollama_failed` warning naming the chunk it stopped on.
7. **A long run is not a hung run.** A 24k-character transcript is seven chunks plus the linking pass: two minutes of model calls with nothing to say in between. The stream sends an SSE heartbeat every 10 s (`SSE_HEARTBEAT_MS`) and the browser watches for *silence*, not for total elapsed time — 45 s without a byte is a stall, anything else is work. A fixed 60 s deadline in the browser used to kill healthy runs mid-way and blame it on Ollama.

Each node carries a `quote`: a verbatim span from the transcript that justifies it. It is the body of the card in the note view, and it is in the exported JSON.

## API

- `GET /api/health` → `{ ok, ready, ollama: { url, model, reachable, modelAvailable, models } }`
- `POST /api/extract` `{ transcript }` → `{ nodes, edges, warnings, chunks, partial, requestId }`
- `POST /api/extract/stream` `{ transcript }` → server-sent events: `status` (carries `chunks`, `chunkSize` and the `model` name), `progress` (`chunk`, `total`, `chars`), `retry` (a chunk being re-asked, with the `code` that caused it), `graph` (the full merged graph so far, once per chunk, with the `ms` that chunk took), `warning`, `done` (`chunks`, `warnings`, `partial`, `ms`), `error`
- `GET /samples/<file>` → the bundled sample transcripts in `samples/`

## Layout

```
server.js          Express app: config, routes, error mapping
lib/config.js      Environment into one config object
lib/chunking.js    Line-aware transcript chunking
lib/prompt.js      The extraction prompt and the linking prompt
lib/schema.js      JSON schemas sent to Ollama as `format`
lib/ollama.js      Ollama client: generate, health, retry
lib/json-extract.js  Getting JSON out of whatever the model wrapped it in
lib/graph.js       Node/edge normalisation, sanitising, cross-chunk merging, components
lib/link.js        The pass that connects concepts from different chunks
lib/extract.js     The per-chunk pipeline both routes share

public/index.html  Markup, icon sprite, canvas overlays
public/styles.css  Design tokens (light and dark) and every component
public/notes.css   The note board and its cards
public/js/main.js        Composition root: both views + controller + state subscription
public/js/state.js       Graph data, selection, filters, current view, undo/redo history
public/js/tree.js        Roots the graph: centre, branches, cross-links   (pure)
public/js/layout.js      Radial positions, one ring per level             (pure)
public/js/geometry.js    Label wrapping and the tapered branch ribbons
public/js/palette.js     Theme colours, and the branch hues
public/js/graph.js       D3 map view: nodes, branches, viewport
public/js/notes.js       Note view: one card per concept, with backlinks
public/js/controller.js  Every control, gesture and keyboard shortcut
public/js/ui.js          Panels, inspector, legend, toasts, inline label editor
public/js/api.js         Fetch + SSE client for the extraction routes
public/js/log.js         The activity log: every pipeline event, in words
public/js/exporters.js   JSON and PNG downloads
```

`public/js/package.json` holds nothing but `{"type": "module"}`. The browser does not
need it — those files are loaded as modules either way — but Node does, so
`test/tree.test.js` and `test/layout.test.js` can import the real layout code instead
of a copy of it.

## Tests

```
node --test test/*.test.js
```

No test dependencies — the built-in `node:test` runner. `test/server.test.js` runs the real Express app against a stub Ollama, so the routes and the SSE stream are covered too.

## The two views

One graph, two readings, switched with **Map** / **Notes** at the top left (or `V`).
Both stay rendered, so switching is instant and the PNG export always has a laid-out
map behind it.

### Map — a radial mind map

The extractor does not hand back a tree. It hands back a handful of small chains and
stars, one per chunk, and drawn as they are that is a scatter of pills — which is why
the canvas used to read as a network diagram rather than as a mind map. So the map view
builds the tree first:

1. **Every component is rooted** at a node nothing points at — the head of a causal
   chain — falling back to the best connected node when there is no such head, as in a
   cycle. Rooting a chain at its middle, which picking by degree alone would do, gives
   a two-armed star instead of a branch.
2. **A centre is invented** when there is more than one component. It stands for the
   transcript itself and takes the transcript's opening line as its label, unless that
   line is a speaker turn; double-click it to rename it. A graph that is already one
   component keeps its own hub as the centre and nothing is invented.
3. **Each subtree gets a slice of the circle** proportional to how many leaves it
   holds, and distances are measured branch by branch: a chain going straight up costs
   its own labels' height, not the width of the widest label anywhere on that level.
4. **An only child leans to one side**, alternating outward, because a chain that
   inherits its parent's exact angle draws a straight spoke, and a hand-drawn map has
   no straight spokes.

What that is drawn as: the centre in a filled pill, first-level branches in pills
tinted with their own hue, everything deeper as plain text on a coloured rule — the way
a paper map writes a leaf along its branch. Branches are tapered ribbons, thick at the
trunk and thin at the tip, so which end is which is clear without an arrowhead.
**Colour follows the branch, not the type**: everything hanging off one limb of the
centre shares a hue, which is how you find a concept before reading a single label.
Node type keeps its own colour, on the dot and in the legend.

Edges the tree does not use are not dropped — a relation between two branches, or the
long way round a cycle. They stay as thin dashed curves in their relation colour, with
an arrowhead, drawn over the branches.

The layout is deterministic: same graph, same picture, run after run. Drag a node and
it stays where you put it; `R` hands every node back to the layout.

### Notes — a Zettelkasten

The same concepts as cards, ordered by the same tree and carrying the same branch
colours. Each card is one atomic note: its id, its type, the concept, the **verbatim
line from the transcript** that justifies it, and its links — outgoing by relation
name, incoming as backlinks. Click a link to jump to that note. Search matches quote
text here, not only labels, so a card can be found by what was actually said.

This is the view that answers "did the model make this up?", which a canvas of labels
cannot.

## Usage

Paste a transcript in the left panel and press **Generate mind map** (or `Ctrl`+`Enter`
inside the box). **Load sample** fills it with `samples/client-kickoff.txt`. The map
streams in chunk by chunk and fits itself to the screen when the run finishes.

**Activity log.** The status line under the button holds one sentence at a time. The
**Activity log** panel below it keeps all of them, timestamped: how many chunks the
transcript was split into and which model is answering, each chunk going out and coming
back with how long it took and how much it added, every retry, every skipped chunk with
its error code, and the verdict at the end. Open it with `L`, **Expand** (or `Shift`+`L`)
to float it over the canvas, `Esc` to put the map back. **Copy** puts the whole log on
the clipboard — that is what to paste when a map comes out short and the reason is not
obvious.

On the canvas:

- **Click** a node or a connection to select it. The panel on the left then shows its
  label, its type and how many connections it has — change the type by clicking a chip.
- **Double‑click** a node to rename it in place; `Enter` saves, `Esc` cancels.
- **Double‑click empty canvas** to drop a new node exactly there.
- **Hover** a node to dim everything that is not one of its neighbours.
- **Drag** a node to reposition it, drag the background to pan, scroll to zoom.
- The **search box** dims everything that does not match; `Enter` centres the first hit.
- The **legend** doubles as a filter: click a type to hide or show its nodes.

On the note board the same clicks apply: a card selects, a link jumps to its note, and
connect mode picks its two nodes from cards exactly as it does from the canvas.

Toolbar, top right: add node, connect mode, undo, redo, export (JSON or a 2× PNG of the
map), light/dark theme. Viewport controls sit bottom right, including fit‑to‑screen.

Keyboard: `N` add node, `E` connect mode, `V` switch view, `Enter` rename the selection,
`Del` delete it, `F` fit to screen, `R` re-run the layout, `L` activity log
(`Shift`+`L` expanded), `/` search,
`Ctrl`+`Z` / `Ctrl`+`Shift`+`Z` undo and redo, `Esc` to cancel whatever is going on.
