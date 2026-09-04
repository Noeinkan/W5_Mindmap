// Screenshot config for the transcript mind map.
//
// Notes for the next run:
//  * `node server.js` serves the whole app on :3200. `npm start` also opens a
//    browser and kills whatever holds the port, so prefer `node server.js` here.
//  * `samples/client-kickoff.txt` is an invented meeting, written for this —
//    real client transcripts are exactly what this app exists to keep local.
//  * D3 is loaded from d3js.org, so the runner needs `d3js.org` allowed or the
//    graph never draws.
//
// Why the extraction is replayed instead of run live
// --------------------------------------------------
// The graph in these shots is the real output of the real pipeline: it was
// produced once by `lib/extract.js` against the local `gemma3:4b` through
// Ollama, and saved to SEED_FILE. The capture then serves that payload back to
// the page from `page.route`, as the same SSE stream `/api/extract/stream`
// would have sent.
//
// Two reasons this is not a shortcut:
//  * one live call is ~20 s warm and much more cold, and every shot below
//    starts from a fresh `page.goto`, so live extraction would be paid six
//    times per run;
//  * the model is not deterministic. Six live runs give six different sets of
//    labels, and a set whose map changes between frames does not read as one
//    app.
//
// To refresh the seed after changing the prompt, the model or the sample, run
// the pipeline once with a chunk size above the transcript length and write the
// result to SEED_FILE:
//
//   node -e "const{loadConfig}=require('./lib/config'),{createOllamaClient}=require('./lib/ollama'),{extractGraph}=require('./lib/extract'),fs=require('fs');\
//   const c=loadConfig({...process.env,TRANSCRIPT_CHUNK_SIZE:'4000'});\
//   extractGraph({transcript:fs.readFileSync('samples/client-kickoff.txt','utf8').trim(),config:c,client:createOllamaClient(c)})\
//   .then(r=>{fs.mkdirSync('C:/tmp/w5-mindmap-seeds',{recursive:true});fs.writeFileSync('C:/tmp/w5-mindmap-seeds/graph.json',JSON.stringify(r,null,2));console.log(r.nodes.length+' nodes')})"
//
// The chunk size matters: the sample is 3658 characters and the default chunk
// is 3500, so the default splits off a 158-character tail that comes back as an
// empty graph and puts an error card on screen (roadmap 4.3).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Stable path on purpose: a seed inside a session temp directory evaporates and
// turns the next re-shoot back into a full re-extraction.
const SEED_FILE = "C:/tmp/w5-mindmap-seeds/graph.json";

const TRANSCRIPT = readFileSync(join(here, "samples", "client-kickoff.txt"), "utf8").trim();
const SEED = JSON.parse(readFileSync(SEED_FILE, "utf8"));

/** The bytes `/api/extract/stream` would have written for this graph. */
const SSE_BODY =
  `event: status\ndata: ${JSON.stringify({ message: "Processing 1 chunk(s)..." })}\n\n` +
  `event: progress\ndata: ${JSON.stringify({ message: "Analyzing chunk 1 of 1..." })}\n\n` +
  `event: graph\ndata: ${JSON.stringify({ nodes: SEED.nodes, edges: SEED.edges })}\n\n` +
  `event: done\ndata: ${JSON.stringify({ chunks: 1, warnings: SEED.warnings || [] })}\n\n`;

/** Paste the transcript, generate, and wait for the radial layout to land. */
async function generate(page) {
  await page.fill("#transcript", TRANSCRIPT);
  await page.click("#generate");
  await page.waitForSelector("#graph g.node", { state: "visible", timeout: 30_000 });
  // The layout is deterministic and its move is a fixed 420 ms tween, after
  // which the app fits itself. This wait is that tween plus the fit, not a
  // simulation cooling down.
  await page.waitForTimeout(1600);
  await page.click("#zoomFit");
  await page.waitForTimeout(900);
  await parkPointer(page);
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
    timeoutMs: 60_000
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
        body: SSE_BODY
      })
    );
  },

  shots: [
    {
      name: "01-map-from-transcript",
      alt:
        "Dark two-column app: a meeting transcript in the left panel, and on the canvas a radial mind map — the meeting's own title in a pill at the centre, three coloured branches curving outward, each thinning towards its leaf labels.",
      shows:
        "A meeting transcript turned into a radial mind map by a model running locally: the centre is the meeting, each branch keeps one colour end to end, and the ribbons thin as they go so the trunk is obvious without a single arrowhead",
      path: "/",
      waitFor: "#graph g.node",
      async prepare(page) {
        await generate(page);
      }
    },
    {
      name: "02-node-inspector",
      alt:
        "The same map with one node, Sequencing Root Cause, and its neighbours lit while the rest of the branches fade back; the left panel shows its label, its type chips and a delete button.",
      shows:
        "A node selected: the rest of the map dims to its immediate neighbourhood, and the inspector renames it, retypes it between theme / cause / hierarchy, reports its degree and offers deletion — the extraction is a starting point, not a verdict",
      path: "/",
      waitFor: "#inspector",
      async prepare(page) {
        await generate(page);
        await clickNode(page, "Sequencing");
        await parkPointer(page);
      }
    },
    {
      name: "03-search-highlight",
      alt:
        "The canvas search field holds the word problem; two nodes stay bright, Project Handover Problems and EIR Problem, and every other node is faded.",
      shows:
        "Search across node labels: matches stay lit, everything else dims, and the hit count sits in the field — how you find one concept in a map too big to read at once",
      path: "/",
      waitFor: "#searchCount",
      async prepare(page) {
        await generate(page);
        // Two hits in the seeded map ("…Handover Problems", "EIR Problem…").
        await page.fill("#search", "problem");
        await page.waitForTimeout(400);
        await parkPointer(page);
      }
    },
    {
      name: "04-filter-by-type",
      alt:
        "The legend chip for cause is switched off and the three red nodes have gone from the canvas, leaving the blue theme nodes and the green hierarchy node.",
      shows:
        "The legend doubles as a type filter — causes switched off, counts per type still shown, so a dense map can be read one layer at a time",
      path: "/",
      waitFor: "#legend .chip.off",
      async prepare(page) {
        await generate(page);
        await page.click('#legend .chip[data-type="cause"]');
        await page.waitForTimeout(600);
        await parkPointer(page);
      }
    },
    {
      name: "05-connect-mode",
      alt:
        "The connect tool is active in the toolbar, the node Naming Confusion is outlined as the chosen source, and a banner along the bottom asks for the target node.",
      shows:
        "Connect mode mid-gesture: the source node is picked and the banner asks for the target — the map is editable by hand, with typed relations (relates / causes / supports / contrasts)",
      path: "/",
      waitFor: "#modeBanner",
      async prepare(page) {
        await generate(page);
        await page.click("#toggleEdge");
        // Entering connect mode fires a 2.6 s toast that would otherwise float
        // over the top of the map; the banner says the same thing better.
        await page.waitForTimeout(3200);
        await clickNode(page, "Naming");
        await page.waitForTimeout(400);
        await parkPointer(page);
      }
    },
    {
      name: "06-export",
      alt:
        "An open menu at the top right of the canvas offering two exports, JSON and PNG image, over the finished map.",
      shows:
        "Export: the finished map leaves as JSON — quotes included — for another tool, or as a PNG image; nothing in the round trip leaves the machine",
      path: "/",
      waitFor: "#exportMenu",
      async prepare(page) {
        await generate(page);
        await page.click("#exportBtn");
        await page.waitForTimeout(300);
        await parkPointer(page);
      }
    },
    {
      name: "07-notes",
      alt:
        "The same graph as a board of note cards: each card carries an id, a type tag, the concept as a heading, a verbatim quote from the transcript in italics, and pill-shaped links to the concepts it causes or supports.",
      shows:
        "The note view — the same graph read as a Zettelkasten. Every concept is one card carrying the verbatim line from the transcript that justifies it, plus its links out and its backlinks, so the map can be checked against what was actually said",
      path: "/",
      waitFor: ".note-card",
      async prepare(page) {
        await generate(page);
        await page.click("#viewNotes");
        await page.waitForTimeout(500);
        await parkPointer(page);
      }
    }
  ]
};
