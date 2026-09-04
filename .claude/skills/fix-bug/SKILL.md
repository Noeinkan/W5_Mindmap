---
name: fix-bug
description: Investigate a bug, failing test, regression, runtime error, or unknown issue in the mind-map app. Enforces evidence-first workflow: reproduce, isolate, add or find a failing test, fix minimally, rerun validation.
---

# Fix Bug

Use when fixing a bug, regression, failing test, runtime error, or unknown issue.

## Workflow
1. Anchor on one concrete symptom: a failing test, stack trace, route, browser console error, command, or user-visible behavior.
2. Read the **Layout** and **How extraction works** sections of `README.md` first, then open only the nearest owning module.
3. Check the gotchas below for that symptom before opening more files.
4. State one falsifiable local hypothesis and one cheap check that could disconfirm it.
5. Reproduce the failure with the narrowest possible signal. Prefer an existing failing test; otherwise use the smallest command or interaction that shows the bug.
6. If no focused test exists, add the smallest test for the touched slice before fixing — see **Writing a test here**.
7. Fix the root cause minimally. No refactors, no formatting churn, no adjacent cleanup.
8. Immediately rerun the same focused check after the first edit: `node --test test/<name>.test.js`.
9. If the focused check passes, run `npm test` and report the pass / fail / skipped counts it prints.
10. Note what could regress and add or suggest guard coverage when the fix changes a behavior boundary.

## Which side of the app is it?

The two halves do not share a module system and are debugged differently.

| Symptom | Owner | How to verify a fix |
|---------|-------|---------------------|
| Wrong nodes/edges, duplicated concepts, lost cross-chunk links | `lib/graph.js` (normalise, sanitise, merge) | `node --test test/graph.test.js` |
| Transcript cut in the wrong place, a speaker turn split | `lib/chunking.js` | `node --test test/chunking.test.js` |
| The model answered with prose and nothing parsed | `lib/json-extract.js`, then the stricter re-ask in `lib/extract.js` | `node --test test/json-extract.test.js test/extract.test.js` |
| Ollama unreachable, timeout, retry, health wrong | `lib/ollama.js` | `node --test test/ollama.test.js` |
| Wrong HTTP status, wrong error code, SSE event missing or out of order | `server.js` | `node --test test/server.test.js` |
| An env var has no effect | `lib/config.js` — and the README env table, which must stay true | widen to `npm test`: nearly everything reads the config |
| Nothing renders, drag/zoom broken, edit dialog, export, status line | `public/js/` (`graph`, `ui`, `controller`, `state`, `exporters`, `api`) | **no automated coverage** — run `npm start` and check the browser console |

## Gotchas
- **`lib/` is CommonJS, `public/js/` is browser ES modules.** `package.json` has no `"type"` field. A `require` in `public/js/` or an `import` in `lib/` fails at load, not at call.
- **`public/js/` is untested and unbundled.** It is served as-is from `public/`, so a syntax error there shows up only as a blank canvas plus a console error. There is no build step to catch it.
- **Merging rewrites edge ids.** If concepts appear once per chunk instead of merged, or the map renders as disconnected islands, the suspect is the id rewrite in `lib/graph.js`, not the model output.
- **A bad chunk and a dead Ollama are deliberately different failures.** A chunk the model botched is re-asked once, then skipped with a `warning` and the run continues; a transport failure aborts the whole run. Never "fix" a bug by collapsing the two.
- **Both routes share one pipeline.** `POST /api/extract` and `POST /api/extract/stream` both go through `lib/extract.js`, so a fix in there needs checking on both paths in `test/server.test.js`.
- **`NODE_ENV=production` hides error details from responses.** A symptom that reads as "the error message disappeared" may be config, not a lost throw.
- **Tests stub Ollama with a real local HTTP server** and point `OLLAMA_URL` at it. No mocking library is installed and none should be added.

## Writing a test here
CommonJS, built-in runner, flat `test(...)` calls — no `describe`/`it`, no `expect`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { chunkTranscript } = require("../lib/chunking");
```

Name the test after the behavior in plain language, the way the existing ones do ("a trailing slash on OLLAMA_URL does not double up in the path"), not after the function under test. Copy the stub-server setup from `test/server.test.js` when the code path talks to Ollama.

## Investigation Limits
- Prefer one nearby abstraction hop at a time. Stop broad searching once one explanation cleanly fits the symptom.
- If the first hypothesis fails, take one nearby hop to the code that more directly computes or controls the behavior.
- If two hypotheses fail, collect one missing artifact before continuing: exact error text, the transcript that triggers it, the raw model response, the SSE event log, or a screenshot.
- Ask the user only when the blocker is external: missing repro steps, a model that isn't pulled, environment access, or unclear intended behavior.
- Use read-only subagents for wider research, but keep implementation and validation in the main context.
- The suite runs in about 1.5 s. There is no worker-flake excuse for a red — a failure here is real, so read it rather than rerunning it.

## Rules
- Evidence before code.
- Root cause before patch.
- Test the bug before and after the fix.
- Read only files relevant to the issue.
- No new packages — this repo has exactly one runtime dependency and zero test dependencies, and that is a design choice, not an oversight.
- No new docs or scope expansion unless the bug requires it.
