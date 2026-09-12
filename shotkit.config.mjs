// Screenshot config for the transcript mind map.
//
// Notes for the next run:
//  * `node server.js` serves the whole app on :3200. `npm start` also opens a
//    browser and kills whatever holds the port, so prefer `node server.js` here.
//  * D3 is loaded from d3js.org, so the runner needs `d3js.org` allowed or the
//    graph never draws.
//  * The library writes JSON files to `data/graphs` under the repo. The capture
//    points GRAPH_STORE_DIR at the seed sandbox instead, so a screenshot run
//    neither reads nor writes whatever is in the real library.
//
// The two sources in the set
// --------------------------
//  * `samples/client-kickoff.txt` — an invented kickoff meeting, written for
//    this. Real client transcripts are exactly what this app exists to keep
//    local, so none is anywhere near a screenshot.
//  * `information-management-handbook.epub` — an invented handbook, built by
//    `C:/tmp/w5-mindmap-seeds/make-book.js`. It exists because the Sections
//    panel is only worth a frame if the book behind it has chapters a reader
//    would recognise, and because 30 nodes is a map worth folding while 19 is
//    not.
//
// Why the extraction is replayed instead of run live
// --------------------------------------------------
// Both graphs in these shots are the real output of the real pipeline: they
// were produced by `lib/extract.js` against the local `gemma3:4b` through
// Ollama and saved, and the capture serves them back to the page from
// `page.route` as the same SSE stream `/api/extract/stream` would have sent.
//
// Two reasons this is not a shortcut:
//  * the two together are ~100 s of model time, and every shot below starts
//    from a fresh `page.goto`, so live extraction would be paid eight times per
//    run;
//  * the model is not deterministic. Eight live runs give eight different sets
//    of labels, and a set whose map changes between frames does not read as one
//    app.
//
// The seeds are made at the real chunk size, not a raised one, so `chunks`
// below is what the text really costs and the captions can repeat it.
//
// To refresh everything after changing the prompt, the model or the sources:
//
//   node C:/tmp/w5-mindmap-seeds/make-book.js      # the EPUB
//   node C:/tmp/w5-mindmap-seeds/make-seed.js      # both graphs (needs Ollama)
//   node C:/tmp/w5-mindmap-seeds/make-library.js   # the saved-maps sandbox

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// A stable path on purpose: seeds inside a session temp directory evaporate and
// turn the next re-shoot back into a full re-extraction.
const SEEDS = "C:/tmp/w5-mindmap-seeds";
const BOOK_FILE = `${SEEDS}/information-management-handbook.epub`;

const TRANSCRIPT = readFileSync(join(here, "samples", "client-kickoff.txt"), "utf8").trim();

const GRAPHS = {
  meeting: JSON.parse(readFileSync(`${SEEDS}/meeting.json`, "utf8")),
  book: JSON.parse(readFileSync(`${SEEDS}/book.json`, "utf8"))
};

/** The bytes `/api/extract/stream` would have written for one of those graphs. */
function sseBody(graph) {
  const chunks = graph.chunks || 1;
  const events = [
    `event: status\ndata: ${JSON.stringify({ message: `Processing ${chunks} chunk(s)...` })}\n\n`
  ];
  for (let i = 1; i <= chunks; i += 1) {
    events.push(
      `event: progress\ndata: ${JSON.stringify({ message: `Analyzing chunk ${i} of ${chunks}...` })}\n\n`
    );
  }
  events.push(
    `event: graph\ndata: ${JSON.stringify({ nodes: graph.nodes, edges: graph.edges })}\n\n`,
    `event: done\ndata: ${JSON.stringify({ chunks, warnings: graph.warnings || [] })}\n\n`
  );
  return events.join("");
}

// Which graph the next Generate answers with. `setup` registers the route once
// for the whole run, but the request only happens when a `prepare` clicks
// Generate — so setting this at the top of a `prepare` is in time.
let activeGraph = "meeting";

/** Wait for the layout to land and fit the map in the frame. */
async function settleMap(page) {
  await page.waitForSelector("#graph g.node", { state: "visible", timeout: 30_000 });
  // The layout is deterministic and its move is a fixed 420 ms tween, after
  // which the app fits itself. This wait is that tween plus the fit, not a
  // simulation cooling down.
  await page.waitForTimeout(1600);
  await page.click("#zoomFit");
  await page.waitForTimeout(900);
  await parkPointer(page);
}

/** Paste the kickoff transcript and generate its map. */
async function generateMeeting(page) {
  activeGraph = "meeting";
  await page.fill("#transcript", TRANSCRIPT);
  await page.click("#generate");
  await settleMap(page);
}

/**
 * Open the handbook the way the Open file… button does, then generate.
 *
 * The file goes to the hidden input rather than through the OS file picker.
 * At 10,225 characters the book is under the 20,000 the controller maps whole,
 * so it loads whole and the Sections panel arrives collapsed — the summary
 * click below is what opens it.
 */
async function generateBook(page, { openPanel = false } = {}) {
  activeGraph = "book";
  await page.setInputFiles("#documentFile", BOOK_FILE);
  await page.waitForSelector("#sectionsPanel:not([hidden])", { timeout: 20_000 });
  if (openPanel) {
    await page.click("#sectionsPanel > summary");
    await page.waitForTimeout(250);
  }
  await page.click("#generate");
  await settleMap(page);
}

/**
 * Park the pointer over an empty strip of the sidebar. Hovering a node dims
 * every node that is not its neighbour, so a pointer left anywhere over the
 * canvas can silently grey out most of the map in the frame.
 */
async function parkPointer(page) {
  await page.mouse.move(100, 870);
  await page.waitForTimeout(250);
}

/** Click a node by its label — the full text lives in the node's <title>. */
async function clickNode(page, label) {
  const match = page.locator("#graph g.node").filter({ hasText: label });
  const target = (await match.count()) ? match.first() : page.locator("#graph g.node").first();
  await target.click();
  return target;
}

export default {
  baseUrl: "http://localhost:3200",
  server: {
    command: "node server.js",
    readyUrl: "http://localhost:3200/api/health",
    timeoutMs: 60_000,
    // Never the repo's own data/graphs: the library shot reads a sandbox that
    // `make-library.js` fills, and nothing the capture does lands in the repo.
    env: { GRAPH_STORE_DIR: `${SEEDS}/graphs` }
  },

  viewport: { width: 1440, height: 900 },
  colorScheme: "dark", // the app follows prefers-color-scheme on first load
  allowHosts: ["d3js.org"],
  settleMs: 900,

  // Every shot starts from a fresh page load, so the interception has to be in
  // place before the first one rather than inside a `prepare`.
  async setup(page) {
    await page.route("**/api/extract/stream", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: sseBody(GRAPHS[activeGraph])
      })
    );
  },

  shots: [
    {
      name: "01-map-from-transcript",
      alt:
        "Dark two-column app: a meeting transcript in the left panel, and on the canvas a mind map with the meeting's title in a pill at the centre and branches fanning left and right, each in its own colour, labels stacked in columns.",
      shows:
        "A kickoff meeting turned into a mind map by a model running on the machine: a centre standing for the transcript, branches shared between a left and a right wing so neither side runs off the screen, and each limb keeping one colour end to end",
      path: "/",
      waitFor: "#graph g.node",
      async prepare(page) {
        await generateMeeting(page);
      }
    },
    {
      name: "02-book-sections",
      alt:
        "The Sections panel is open in the left column listing eight chapters of a handbook, each with its character count and what that costs in chunks; the canvas holds the map of the whole book.",
      shows:
        "A PDF or EPUB read locally and split into the sections the file itself declares — here a handbook's eight chapters, each priced in characters and model chunks, so a book becomes a list of jobs the size of a meeting instead of one hour-long run",
      path: "/",
      waitFor: ".section-row",
      async prepare(page) {
        await generateBook(page, { openPanel: true });
      }
    },
    {
      name: "03-node-inspector",
      alt:
        "One node, Missing Capability Assessment, and its neighbours stay lit in the middle of the canvas while the rest of the map fades back; the left panel shows its label in a field, its type chips and a delete button.",
      shows:
        "A node selected: the rest of the map dims to its immediate neighbourhood, and the inspector renames it, retypes it between theme / cause / hierarchy, reports its degree and offers deletion — the extraction is a starting point, not a verdict",
      path: "/",
      waitFor: "#inspector",
      async prepare(page) {
        await generateMeeting(page);
        // A branch hub rather than a leaf. Selecting a node at the edge of the
        // map is a true frame of a weak state: the lit neighbourhood lands in a
        // corner and the rest goes dark. This one sits between the centre and
        // its own column, so what stays lit reads as a neighbourhood.
        await clickNode(page, "Missing Capability Assessment");
        await parkPointer(page);
      }
    },
    {
      name: "04-search-highlight",
      alt:
        "The canvas search field holds the word data with a hit count of 3 beside it; three matching nodes stay bright in both wings of the map and every other node is faded.",
      shows:
        "Search across node labels: matches stay lit wherever they sit, everything else dims, and the hit count sits in the field — how you find one concept in a map without reading it",
      path: "/",
      waitFor: "#searchCount",
      async prepare(page) {
        // The kickoff map rather than the book: at 30 nodes the book fits on
        // screen at 70% and the lit hits are too small to read, which is the
        // one thing this shot has to show.
        await generateMeeting(page);
        // Three hits in the seeded map, two in the left wing and one in the right.
        await page.fill("#search", "data");
        await page.waitForTimeout(400);
        await parkPointer(page);
      }
    },
    {
      name: "05-fold-branch",
      alt:
        "The handbook map with one branch folded away: where its children were there is a small pill carrying the number it is holding, and the rest of the map has spread into the room that freed up.",
      shows:
        "Branches fold away: the fold happens before the layout is measured, so the map spreads into the room the branch gives back and the badge says how many nodes are behind it — the answer to a map too big to read all at once",
      path: "/",
      waitFor: "#graph g.node",
      async prepare(page) {
        await generateBook(page);
        await foldBranch(page, "Common Data Environment Issues");
      }
    },
    {
      name: "06-connect-mode",
      alt:
        "The connect tool is active in the toolbar, one node is outlined as the chosen source, and a banner along the bottom of the canvas asks for the target node.",
      shows:
        "Connect mode mid-gesture: the source node is picked and the banner asks for the target — the map is editable by hand, with typed relations (relates / causes / supports / contrasts)",
      path: "/",
      waitFor: "#modeBanner",
      async prepare(page) {
        await generateMeeting(page);
        await page.click("#toggleEdge");
        // Entering connect mode fires a 2.6 s toast that would otherwise float
        // over the top of the map; the banner says the same thing better.
        await page.waitForTimeout(3200);
        await clickNode(page, "Asset Register");
        await page.waitForTimeout(400);
        await parkPointer(page);
      }
    },
    {
      name: "07-library",
      alt:
        "The Library panel is open in the left column with four saved maps, each row giving its title, its node count, whether it still carries its transcript, and when it was last touched.",
      shows:
        "The library: maps are saved as one JSON file each under the app's own directory, listed with their size and age, and reopened, renamed or deleted from the panel — the same JSON the export button writes, so a map can be read and backed up without this app",
      path: "/",
      waitFor: ".lib-row",
      async prepare(page) {
        await generateMeeting(page);
        await page.click("#libraryPanel > summary");
        await page.waitForSelector(".lib-row", { timeout: 10_000 });
        await page.waitForTimeout(400);
        await parkPointer(page);
      }
    },
    {
      name: "08-notes",
      alt:
        "The same graph as a board of note cards: each card carries an id, a type tag, the concept as a heading, a verbatim quote from the source in italics, and pill-shaped links to the concepts it causes or supports.",
      shows:
        "The note view — the same graph read as a Zettelkasten. Every concept is one card carrying the verbatim line from the source that justifies it, plus its links out and its backlinks, so the map can be checked against what was actually said",
      path: "/",
      waitFor: ".note-card",
      async prepare(page) {
        await generateBook(page);
        await page.click("#viewNotes");
        await page.waitForTimeout(500);
        await parkPointer(page);
      }
    }
  ]
};

/**
 * Fold one branch away.
 *
 * `Common Data Environment Issues` is the branch worth folding in the book map:
 * of the five hanging off the centre it holds 20 of the 30 nodes, so the badge
 * reads 20 and the rest of the map visibly spreads into what it gives back.
 * That number comes from the seed, not from a guess — rebuild it with:
 *
 *   node --input-type=module -e "import {buildTree} from './public/js/tree.js'; …"
 *
 * The fold badge is only hit-testable while its node is hovered or selected, so
 * the node is selected first and the selection cleared afterwards: a folded
 * badge stays at full opacity on its own, but a node left selected would dim
 * the rest of the map, and this shot is about the whole map.
 */
async function foldBranch(page, label) {
  const node = await clickNode(page, label);
  await page.waitForTimeout(300);
  await node.locator("g.fold").click();
  await page.waitForTimeout(1200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.click("#zoomFit");
  await page.waitForTimeout(900);
  await parkPointer(page);
}
