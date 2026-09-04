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
6. **Failures are separated.** A chunk the model answered badly is re-asked once with a stricter instruction, then skipped with a warning — the rest of the map survives. A chunk that comes back well-formed but empty is asked once more, then reported as `empty_chunk` rather than as a schema error. A transport failure (Ollama down, timed out) aborts the run at once, because every remaining chunk would fail the same way, slowly.

Each node carries a `quote`: a verbatim span from the transcript that justifies it. It is not drawn on the canvas yet, but it is in the exported JSON.

## API

- `GET /api/health` → `{ ok, ready, ollama: { url, model, reachable, modelAvailable, models } }`
- `POST /api/extract` `{ transcript }` → `{ nodes, edges, warnings, chunks, requestId }`
- `POST /api/extract/stream` `{ transcript }` → server-sent events: `status`, `progress`, `graph` (the full merged graph so far, once per chunk), `warning`, `done`, `error`
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
public/js/main.js        Composition root: graph + controller + state subscription
public/js/state.js       Graph data, selection, filters, undo/redo history
public/js/graph.js       D3 layer: layout, pill nodes, curved edges, viewport
public/js/controller.js  Every control, gesture and keyboard shortcut
public/js/ui.js          Panels, inspector, legend, toasts, inline label editor
public/js/api.js         Fetch + SSE client for the extraction routes
public/js/exporters.js   JSON and PNG downloads
```

## Tests

```
node --test test/*.test.js
```

No test dependencies — the built-in `node:test` runner. `test/server.test.js` runs the real Express app against a stub Ollama, so the routes and the SSE stream are covered too.

## Usage

Paste a transcript in the left panel and press **Generate mind map** (or `Ctrl`+`Enter`
inside the box). **Load sample** fills it with `samples/client-kickoff.txt`. The map
streams in chunk by chunk and fits itself to the screen when the run finishes.

On the canvas:

- **Click** a node or a connection to select it. The panel on the left then shows its
  label, its type and how many connections it has — change the type by clicking a chip.
- **Double‑click** a node to rename it in place; `Enter` saves, `Esc` cancels.
- **Double‑click empty canvas** to drop a new node exactly there.
- **Hover** a node to dim everything that is not one of its neighbours.
- **Drag** a node to reposition it, drag the background to pan, scroll to zoom.
- The **search box** dims everything that does not match; `Enter` centres the first hit.
- The **legend** doubles as a filter: click a type to hide or show its nodes.

Toolbar, top right: add node, connect mode, undo, redo, export (JSON or a 2× PNG of the
map), light/dark theme. Viewport controls sit bottom right, including fit‑to‑screen.

Keyboard: `N` add node, `E` connect mode, `Enter` rename the selection, `Del` delete it,
`F` fit to screen, `/` search, `Ctrl`+`Z` / `Ctrl`+`Shift`+`Z` undo and redo, `Esc` to
cancel whatever is going on.
