---
name: adapt-skill
description: Adapt an imported skill file (SKILL.md) from another repo so it works correctly in this project. Fixes stale memory paths, wrong file references, wrong stack assumptions, and out-of-scope doc lists.
---

# Adapt Skill

When a `SKILL.md` is copied from another repo it carries the source repo's memory paths, file paths, directory conventions, and doc inventory. This skill audits and rewrites those references so the skill works in the current project without manual hunting.

## Steps

1. **Read the imported skill**
   Read the `SKILL.md` being adapted in full.

2. **Collect project facts** (already gathered below — re-verify only if the repo has moved on)

   | Fact | Value here |
   |------|-----------|
   | Memory path slug | `c--Users-andre-Downloads-W5-Mindmap` |
   | Root `.md` files | `README.md`, `roadmap.md` — there is no `CLAUDE.md`, no `CHANGELOG.md`, no `docs/` tree |
   | Authoritative stack description | `README.md` — its **Layout**, **API** and **How extraction works** sections are the closest thing to an architecture doc |
   | Server-side source | `server.js` (Express app, routes, error mapping) + `lib/` (`config`, `chunking`, `prompt`, `ollama`, `json-extract`, `graph`, `extract`) |
   | Browser source | `public/js/` (`main`, `controller`, `state`, `graph`, `ui`, `api`, `exporters`) + `public/index.html`, `public/styles.css` |
   | Test runner | built-in `node:test`, CommonJS (`require("node:test")`) — **no Vitest, no Jest**, zero test dependencies |
   | Full suite | `npm test` (= `node --test "test/*.test.js"`) |
   | Runtime deps | `express` only |
   | `.claude/` contents | skills: `adapt-skill`, `fix-bug`. No agents, no hooks, no settings file |
   | Noise dirs to filter | `node_modules/`, `.git/`, `.shots/` (screenshot output), `samples/` (fixture transcripts, not source) |

3. **Audit the skill for stale references** — check each category:

   | Category | What to look for | How to fix |
   |----------|-----------------|------------|
   | Memory path | Any `c--Users-*` slug that isn't `c--Users-andre-Downloads-W5-Mindmap` | Replace with this project's slug |
   | Doc file paths | `docs/API.md`, `.claude/project-index.md`, `CLAUDE.md`, `CHANGELOG.md` — none of these exist here | Point at `README.md` (architecture, API, env vars) or `roadmap.md` (planned work); drop the reference if nothing here covers it |
   | Directory paths | `src/`, `server/`, `ml-service/`, `frontend/` and other source dirs from the source repo | Map to `lib/` (server modules), `public/js/` (browser modules) or `server.js` |
   | Test commands | `npm run test:run`, `vitest related --run`, `jest -o`, `--findRelatedTests` | Full suite: `npm test`. Focused: `node --test test/<name>.test.js` — `node:test` has no import-graph selection, so widen the circle when you touch `lib/config.js`, `lib/graph.js` or anything `server.js` mounts |
   | Test authoring | Vitest/Jest idioms: `describe`/`it`, `expect(...)`, `vi.mock`, ESM `import` | This repo uses `require("node:test")` + `node:assert/strict`, flat `test(...)` calls, and stubs Ollama by pointing `OLLAMA_URL` at a local HTTP server (see `test/server.test.js`) |
   | Stack references | React, Vite, Tailwind, TypeScript, Zod, a database, a deploy script, Hetzner | None of these exist here. The browser side is hand-written ES modules plus D3 for the force layout; the only backend is Ollama over HTTP |
   | Sister skill links | References to skills not in `.claude/skills/` | Only `adapt-skill` and `fix-bug` exist. Remove the link or point it at a globally installed skill (e.g. `roadmap-format`, `screenshot-kit`) |
   | Noise filters | Build artifact dirs (`build/`, `.next/`, `dist/`) | Replace with `node_modules/`, `.shots/`, `samples/` |
   | Decision rule examples | Concrete examples referencing source-repo patterns | Rewrite against this repo's vocabulary: chunk, merge, node/edge, warning vs transport failure, SSE stream |

4. **Emit a verdict per category** before editing:
   - `Memory path: UPDATE — old slug X → c--Users-andre-Downloads-W5-Mindmap`
   - `Doc files: UPDATE — replaced docs/ table with README.md + roadmap.md`
   - `Stack refs: SKIP — no foreign stack references found`
   - (etc.)

5. **Rewrite the skill** — apply only the changes identified. Do not restructure sections that are fine as-is. Preserve the skill's core logic, modes, and step numbering.

6. **Verify** — re-read the updated skill and confirm:
   - Every file path mentioned exists in the current repo (a quick `Glob` or `Grep` if unsure)
   - The memory slug matches `c--Users-andre-Downloads-W5-Mindmap` exactly
   - Every command in the skill is runnable here — in particular no `vitest`, `jest`, `tsc` or `eslint` invocation survives, since none of them are installed
   - No sister skill links point to skills that don't exist

## What never changes
- The skill's core purpose and step logic — only the project-specific references change.
- The frontmatter `name:` field (it must match the skill's directory name and the trigger in the harness).
- The `description:` field is updated only if the scope genuinely differs (e.g. the doc file list changed).
