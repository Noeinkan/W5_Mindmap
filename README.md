# Transcript Mind Map

Minimal app that uses a local Ollama model to extract a typed mind‑map graph from a transcript and renders it with an editable D3.js force layout. The transcript can be pasted, or read out of a **PDF, EPUB, Markdown or text file** — a document arrives split into its own sections, so a book is mapped a chapter at a time.

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
| `OLLAMA_TEMPERATURE` | `0` | Sampling temperature. `0` is greedy: the same chunk gives the same map |
| `OLLAMA_TOP_P` | `0.9` | Nucleus sampling; only has an effect if the temperature is raised |
| `OLLAMA_NUM_CTX` | `8192` | Context window per call. Ollama's own default is `4096`, tight for a full chunk plus a long answer |
| `LINK_PASS` | `1` | One extra call at the end that connects concepts found in different chunks |
| `KNOWN_LABELS_IN_PROMPT` | `40` | Concepts fed back into later chunk prompts |
| `GRAPH_STORE_DIR` | `data/graphs` | Where saved maps are written, one JSON file per map. Gitignored |
| `INGEST_MAX_BYTES` | `67108864` | Biggest file `/api/ingest` will take (64 MB). Reading one costs about twice its size in memory |
| `INGEST_MAX_CHARS` | `2000000` | Safety valve on the text a file can turn into — not a reading limit, since sections are what keep a run short |
| `INGEST_MAX_PAGES` | `2000` | Pages read from one PDF |
| `NODE_ENV` | `development` | `production` hides error details from responses |

## How extraction works

1. **Chunking** cuts the transcript at line boundaries only, so speaker turns (`IM: And agree the CDE naming convention…`) stay intact. A line longer than the limit is the one case that gets split on words. Each chunk repeats the last line of the previous one so a thought straddling a cut is still visible whole. Chunks are then evened out: filling each one to the brim split the 3658-character sample into 3354 + 304, and a 304-character tail is short enough that the model answers it with an empty graph.
2. **Each chunk** is asked for with a JSON schema, not with `format: "json"`. Plain JSON mode only promises *some* valid JSON, and the shortest valid JSON is `{}` — which is what gemma3:4b answered for whole chunks, however the prompt was worded. The schema requires both arrays, so that exit is closed. The same call also pins the sampler at temperature 0: the schema decides what shape the answer takes, the temperature decides how it is chosen, and left unset it is gemma3's chat default of 1 — variety, on a job that wants the same chunk to give the same map.
3. **The prompt carries the concepts found so far**, so the model reuses the exact label `Handover Issues` instead of inventing `Issues with handover`.
4. **Merging** collapses nodes whose labels match once case, punctuation and a leading article are ignored, then rewrites every edge onto the surviving node ids. Without that rewrite the same concept is drawn once per chunk that mentions it.
5. **A linking pass** closes the run. Each chunk is extracted alone, so its concepts only ever get edges to concepts from the same chunk and the map still reads as one island per chunk. This pass shows the model the concept list alone — no transcript, so it is short — and asks only for the edges that cross between groups. Edges pointing at ids it made up are dropped.
6. **Failures are separated.** A chunk the model answered badly is re-asked once with a stricter instruction, then skipped with a warning — the rest of the map survives. A chunk that comes back well-formed but empty is asked once more, then reported as `empty_chunk` rather than as a schema error. A transport failure (Ollama down, timed out) stops the run at once, because every remaining chunk would fail the same way, slowly — but the chunks already done are still returned, as a `partial` map with an `ollama_failed` warning naming the chunk it stopped on.
7. **A long run is not a hung run.** A 24k-character transcript is seven chunks plus the linking pass: two minutes of model calls with nothing to say in between. The stream sends an SSE heartbeat every 10 s (`SSE_HEARTBEAT_MS`) and the browser watches for *silence*, not for total elapsed time — 45 s without a byte is a stall, anything else is work. A fixed 60 s deadline in the browser used to kill healthy runs mid-way and blame it on Ollama.

Each node carries a `quote`: a verbatim span from the transcript that justifies it. It is the body of the card in the note view, and it is in the exported JSON.

## Reading a file

**Open file…** above the transcript box (or drop a file on the box) reads a PDF,
an EPUB, or a text file and puts its text in the box. Nothing is uploaded
anywhere: the file goes to the local server, which turns it into text and
forgets it.

The reading is done here rather than by a library, in about a thousand lines
across `lib/pdf-*.js`, `lib/zip.js` and `lib/epub-text.js`. That is a deliberate
trade — one dependency in the whole project, nothing to install, and a reader
that can be argued with when a file comes out wrong.

**A PDF has no lines and no words**, only glyphs at coordinates, so the reader
works those out: a step down the page is a line break, nearly two is a
paragraph, and a gap wider than an eighth of an em between where one run of
glyphs ended and the next began is a space — which is how a file that draws one
word at a time and never writes a space still comes out as prose. Both matrices
are followed, the text one and the graphics one: a document that positions each
paragraph with `cm` reads as a single run-on line without the second. What the
bytes in a string *mean* comes from the font — its `ToUnicode` map where there
is one, its `/Differences` encoding where there is not — and a simple 8-bit font
is always read one byte at a time, whatever its character map claims, because
plenty of files ship a two-byte codespace on an 8-bit font and believing it eats
every second letter.

**Objects are found by scanning** for `12 0 obj` rather than by trusting the
cross-reference table at the end, because that table is the first thing to go
wrong in a file that has been edited or appended to, and a wrong table means "no
text" rather than "slightly off". Objects packed into compressed object streams —
most of a PDF written this decade — are unpacked afterwards.

**An EPUB is a ZIP**, so the archive is opened with `node:zlib` and read through
its own skeleton: the container names the package, the package names the
chapters and their order, and each chapter's XHTML becomes text with the block
tags kept as line breaks.

**A scan is refused, not silently emptied.** A PDF averaging less than fifteen
characters a page has no text layer, and is turned away with a message saying it
needs OCR — as opposed to an empty transcript and no explanation. A password-
protected file, a Word document and a plain ZIP each get their own sentence too.

### Sections

A book handed to the extractor whole is three hundred chunks and an hour of
model time, and what comes back is a map of everything and therefore of nothing.
So a document arrives already split, and the **Sections** panel lists the parts
with what each one costs — its characters, and the number of chunks that is.
Clicking one puts that section in the transcript box and names the map after it.

Where the split comes from, in the order of how much the writer meant it:

1. **The file's own contents** — a PDF's outline (its bookmarks), an EPUB's
   navigation document or NCX. Real titles, real boundaries. When the list names
   chapters, the chapters are the split and the top-level entries that are not
   chapters (preface, glossary, index) are kept as bookends; otherwise the
   shallowest level with more than one entry on it is used.
2. **Headings on the page** — `Chapter 4`, `Part II`, `Appendix B`, or a report's
   `4. Information Delivery`, found near the top of a page. The contents page
   itself is skipped: it names every heading in the document, in order, and read
   as openings they would all land on page one.
3. **One per chapter file**, for an EPUB whose contents list is the single
   `Start` entry a converter leaves behind.
4. **Nothing**, for a memo — one section holding the lot, and no panel.

A short document is loaded whole. A long one loads one section — the first that
is neither a title page nor the size of a book — and leaves the rest in the
panel.

## API

- `GET /api/health` → `{ ok, ready, ollama: { url, model, reachable, modelAvailable, models } }`
- `POST /api/extract` `{ transcript }` → `{ nodes, edges, warnings, chunks, partial, requestId }`
- `POST /api/extract/stream` `{ transcript }` → server-sent events: `status` (carries `chunks`, `chunkSize` and the `model` name), `progress` (`chunk`, `total`, `chars`), `retry` (a chunk being re-asked, with the `code` that caused it), `graph` (the full merged graph so far, once per chunk, with the `ms` that chunk took), `warning`, `done` (`chunks`, `warnings`, `partial`, `ms`), `error`
- `GET /samples/<file>` → the bundled sample transcripts in `samples/`
- `POST /api/ingest?name=<filename>` with the file itself as the body (no
  multipart form) → `{ ok, kind, title, text, chars, units, unitLabel, method,
  sections: [{ title, start, end, chars }], chunkSize, truncated, warnings }`.
  `start`/`end` index into `text`, so a section is a `slice` away. Failures name
  themselves: `415 unsupported_file`, `413 file_too_large`, `422 no_text` for a
  scan, `422 encrypted_pdf`, `400 empty_file`

Saved maps, one JSON file each under `GRAPH_STORE_DIR`:

- `GET /api/graphs` → `{ graphs: [{ id, title, nodeCount, edgeCount, hasTranscript, createdAt, updatedAt }] }`, newest first
- `POST /api/graphs` `{ title, transcript, nodes, edges }` → `201` with the summary of the saved map, including its new `id`
- `GET /api/graphs/:id` → the whole document, transcript included
- `PUT /api/graphs/:id` → save over that map, keeping its id and its `createdAt`
- `PATCH /api/graphs/:id` `{ title }` → rename it
- `DELETE /api/graphs/:id` → `{ ok, id }`

Every body is checked against the document rules before it is written, so what the
store holds can always be opened again: `400 invalid_document` carries a `details`
array naming the field that is wrong, `400 empty_document` refuses a map with no
nodes, and an id that is not one the store issued is a `400 bad_request` before any
file is touched.

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
lib/document.js    The server's way into the document rules (imports the browser's module)
lib/store.js       Saved maps on disk: one JSON file each, atomic writes
lib/graphs-api.js  The /api/graphs routes: list, save, open, rename, delete

lib/ingest.js      A file into a transcript: sniff the format, read it, tidy it
lib/ingest-api.js  The /api/ingest route: raw body in, transcript and sections out
lib/sections.js    Where a document breaks into sections, and how it is put back together
lib/pdf-lexer.js   PDF objects, found by scanning rather than by the xref table
lib/pdf-filters.js The stream filters: flate, LZW, ASCII85, run-length, predictors
lib/pdf-fonts.js   What a font's bytes say, and how wide each glyph is
lib/pdf-text.js    Pages into text: the matrices, the line breaks, the spaces
lib/pdf-outline.js The bookmarks, and the destinations they point at
lib/zip.js         The little of ZIP an EPUB needs
lib/epub-text.js   Container, package, spine, navigation — a book in reading order
lib/html-text.js   XHTML into prose, and the whitespace rules the rest agrees on

public/index.html  Markup, icon sprite, canvas overlays
public/styles.css  Design tokens (light and dark) and every component
public/notes.css   The note board and its cards
public/js/main.js        Composition root: both views + controller + state subscription
public/js/state.js       Graph data, selection, filters, current view, undo/redo history
public/js/graph-doc.js   The saved format and its rules — shared with the server  (pure)
public/js/session.js     The map as a document, and the localStorage autosave
public/js/library.js     The saved-maps panel: save, open, rename, delete
public/js/tree.js        Roots the graph: centre, branches, cross-links   (pure)
public/js/layout.js      Two-wing positions, children stacked in columns  (pure)
public/js/geometry.js    Label wrapping and the tapered branch ribbons
public/js/palette.js     Theme colours, and the branch hues
public/js/graph.js       D3 map view: nodes, branches, viewport
public/js/notes.js       Note view: one card per concept, with backlinks
public/js/controller.js  Every control, gesture and keyboard shortcut
public/js/ui.js          Panels, inspector, legend, toasts, inline label editor
public/js/api.js         Fetch + SSE client for the extraction routes, and the file upload
public/js/sections.js    The sections panel: the parts of a file that was read
public/js/log.js         The activity log: every pipeline event, in words
public/js/exporters.js   JSON and PNG downloads
```

`public/js/package.json` holds nothing but `{"type": "module"}`. The browser does not
need it — those files are loaded as modules either way — but Node does, so
`test/tree.test.js` and `test/layout.test.js` can import the real layout code instead
of a copy of it. `lib/document.js` uses the same door for `public/js/graph-doc.js`:
the rules a saved map has to obey are written once, in the module the browser loads,
and the server reaches them with a dynamic `import` rather than keeping a second copy
that would drift.

## Tests

```
node --test test/*.test.js
```

No test dependencies — the built-in `node:test` runner. `test/server.test.js` runs the real Express app against a stub Ollama, so the routes and the SSE stream are covered too; `test/graphs-api.test.js` runs it against a temporary store directory for the saved-map routes. `test/graph-doc.test.js` imports the browser's own document module and checks it agrees with `lib/graph.js`, which is what keeps "the file the app exports" and "the file the server accepts" the same file.

The readers are tested against real bytes: `test/fixtures.js` writes an actual ZIP,
EPUB and PDF — object by object, with no cross-reference table, because that is what
the PDF reader claims not to need. `test/pdf-text.test.js` pins down where the line
breaks and spaces come from, `test/epub-text.test.js` the archive and the two kinds
of table of contents, `test/sections.test.js` the splitting rules, and
`test/ingest.test.js` what happens to a file that is not what it says it is.

## The two views

One graph, two readings, switched with **Map** / **Notes** at the top left (or `V`).
Both stay rendered, so switching is instant and the PNG export always has a laid-out
map behind it.

### Map — a two-wing mind map

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
3. **Branches are shared out between two wings**, left and right of the centre, each
   one going to whichever wing is currently shorter — because the map an extractor
   produces is rarely even, and a branch carrying half the transcript would otherwise
   leave the map hanging off one edge of the screen. Inside a branch the children
   stack downward in a column.
4. **A chain of only children folds into a column** rather than claiming a column per
   link. Width is what decides how far the map has to shrink to fit on screen, and a
   chain five deep spends five columns saying what one column and five rows say just as
   well. The indent is spent once, where the chain leaves its head; every link after it
   keeps the column, lines up on the same leading edge, and is joined to the one above
   by a short hook on that edge. Charging the indent per link instead drew a staircase
   drifting away from its own branch — the one shape on the map you cannot follow.

A ring per level came before this and could not be made dense. Labels are wide and
short, and a ring only grows with its radius while the disc it encloses grows with the
square — so forty labels laid side by side around a circle pushed the outer ring far
enough out that everything inside it was empty, and the map fit on screen at a third of
its size with labels landing on top of each other. Stacked in columns those same labels
waste nothing: on the same graph, a quarter of the box filled against a tenth, and no
two labels overlapping.

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

**Branches fold away.** Hover a node and a minus appears on the edge its children hang
from; click it and the whole branch goes, leaving a badge with the count of what it is
holding. Click the badge to bring it back, or <kbd>Shift</kbd>+<kbd>C</kbd> to open
everything at once. This is the answer to a forty-node map being hard to read at all:
no arrangement of forty labels reads well, so the map you look at is the part you are
working on. The fold happens before the layout is measured, not by hiding what is
already drawn — a branch that kept its place while invisible would give no room back,
and room is the point. Following a link from a note card into a folded branch opens it
on the way.

Folding is a way of looking at the map rather than a fact about it, so it sits with the
legend filter and the search box: it is not written into the saved document, and
opening a different map starts with everything open.

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

## Keeping a map

A map is worth editing only if the editing survives the tab being closed. There are
three doors, and all three write the same document — the same JSON, with the same
rules, whichever one it came through.

**The browser keeps the last one for you.** Every change to the graph is written to
`localStorage` about a second later, transcript included, and the map is back on the
canvas at the next visit with the status line saying when it was saved. Nothing is
asked and nothing is clicked. It is one map — the one you were last looking at — and
it lives in that browser on that machine: clearing site data clears it.

**The library keeps as many as you like.** *Saved maps* in the left panel lists what
is on the server (`GRAPH_STORE_DIR`, one JSON file per map, `data/graphs` by
default). **Save to library** (`Ctrl`+`S`) puts the map on screen there; open one by
clicking its row, rename it with the pencil, delete it with the bin — deleting asks
once, in the row itself. A map opened from the library stays marked as open, and
**Save** then writes over that entry rather than leaving a fourth copy of it in the
list; **Save as new** is there for when a copy is what you want.

**A file goes anywhere.** Export ▸ **Export JSON** downloads the map; Export ▸
**Import JSON…** reads one back. An imported file is checked against the same rules
the server applies before it stores anything, and the two levels of that check are
deliberate: a file that is not a mind map is refused with the field that is wrong
named in the status line, while rows that are individually broken — a node with no
label, an edge pointing at a node that is not in the file — are dropped, counted in
the activity log, and the rest of the map is drawn. Importing is undoable
(`Ctrl`+`Z`), because it replaces everything on the canvas.

What travels in the document: the title of the centre, every node with its type and
its verbatim quote, every connection with its relation, the transcript the map was
extracted from — and the positions of the nodes *you* dragged. Positions the layout
worked out itself are not saved; they are recomputed identically on load, and in a
file meant to be read they are noise.

## Usage

Paste a transcript in the left panel and press **Generate mind map** (or `Ctrl`+`Enter`
inside the box). **Load sample** fills it with `samples/client-kickoff.txt`. The map
streams in chunk by chunk and fits itself to the screen when the run finishes.

**Open file…** — next to *Load sample*, or drop the file straight on the transcript
box — reads a PDF, an EPUB, a Markdown or a text file into the box instead. A
document with parts to it brings a **Sections** panel with it: one row per chapter
or heading, each saying how many characters and how many chunks it is. Click a row
to map that part, and the centre of the map takes its name.

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

Toolbar, top right: add node, connect mode, undo, redo, the file menu (export as JSON
or a 2× PNG, import a JSON map), light/dark theme. Viewport controls sit bottom right,
including fit‑to‑screen.

Keyboard: `N` add node, `E` connect mode, `V` switch view, `Enter` rename the selection,
`Del` delete it, `F` fit to screen, `R` re-run the layout, `L` activity log
(`Shift`+`L` expanded), `/` search, `Ctrl`+`S` save to the library,
`Ctrl`+`Z` / `Ctrl`+`Shift`+`Z` undo and redo, `Esc` to cancel whatever is going on.
