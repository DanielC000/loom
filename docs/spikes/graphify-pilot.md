# Spike: graphify as an opt-in worker-orientation tool

**Card:** cf54807c · **Date:** 2026-06-07 · **Type:** throwaway pilot (not integrated)
**Tool:** [graphify](https://github.com/safishamsi/graphify) (PyPI `graphifyy`) v0.8.35

## Verdict (TL;DR)

**KEEP → adopt as an opt-in skill.** graphify's tree-sitter code graph is accurate
(99% EXTRACTED / 0% AMBIGUOUS edges, 0 token cost), builds in ~12s, and its
*node-targeted* commands (`explain` / `path` / `affected`) answered the real
web-design orientation questions in **one call** where grep would need a
read-and-follow-imports loop. The natural-language `query` command, by contrast, is
noise — do **not** rely on it. Recommendation: bundle `/graphify` as an **opt-in skill**
(human installs the tool once, same posture as the opt-in browser); wire **nothing** in
the daemon for v1.

**This spike was strictly local-only:** no `git push`, no Obsidian-vault write, no git
hooks / merge driver / PreToolUse hooks installed, no paid/headless LLM backend, no API
spend. All graphify output stayed under `packages/graphify-out/` (git-excluded) and the
only committed artifact is this doc.

## What was installed & how (reproducible)

One-time, user-level install (managed by `uv`; reversible via `uv tool uninstall`):

```sh
uv tool install graphifyy        # installs the `graphify` binary to ~/.local/bin
# alternatives: pipx install graphifyy   |   pip install graphifyy
graphify --version               # -> graphify 0.8.35
```

Build a **code-only** graph (tree-sitter, no LLM, no API key) scoped to the workspace:

```sh
graphify update packages         # AST-only re-extraction; "no LLM needed"
# (the `extract` subcommand is AST + *semantic LLM* and needs a backend — NOT used here)
```

Result: `223 files → 2381 nodes, 3674 edges, 155 communities` in **~12s**, written to
`packages/graphify-out/` (`graph.json`, `graph.html`, `GRAPH_REPORT.md`, `cache/`).

Query it locally (no API key — these read the cached `graph.json`):

```sh
G=packages/graphify-out/graph.json
graphify explain "<symbol>"        --graph $G   # a node + its call neighborhood
graphify path    "<A>" "<B>"       --graph $G   # shortest path between two symbols
graphify affected "<symbol>"       --graph $G   # reverse traversal: what depends on X
graphify query   "<NL question>"   --graph $G   # BFS node-dump — weak, see below
graphify diagnose multigraph       --graph $G   # edge-integrity / ghost-edge check
```

### Reversibility (leaves no trace)

`graphify-out/`, `.graphify/`, `graph.json`, `GRAPH_REPORT.md`, `graph.html`, `cost.json`
were added to `.git/info/exclude` (local, not committed) **before** building, so git
stayed clean throughout. To fully undo the spike: `rm -rf packages/graphify-out` and
`uv tool uninstall graphifyy`.

## The test — 3 real orientation queries (web-design epic test bed)

For each: ✅/❌ accuracy, and the time-vs-grep judgement. The headline finding is that
the **surface matters more than the question**: node-targeted `explain`/`path` are strong;
the NL `query` command is not.

### Q1 — "show the skill injection flow"
- **`query "show the skill injection flow"`** → ❌ **poor**. 0.42s, but BFS started from
  mis-matched seeds (`theme.ts`, `The job`) and dumped 255 mostly-unrelated `web/src/*.tsx`
  nodes. `skills/seed.ts` / `skills/inject.ts` were *not* surfaced.
- **`explain "injectSkills()"`** → ✅ **accurate** (0.41s). Showed `injectSkills()`
  (`skills/inject.ts:23`) is called by `host.ts` / `.createPty()` and calls
  `hideFromGit()` — i.e. skills are injected at **spawn**, while `seedGlobalSkills()`
  (`skills/seed.ts:26`) seeds at **boot**. graphify keeps these as two lifecycle phases,
  which is arguably *more correct* than treating them as one linear "flow".
- **Verdict:** correct **once you target the node**. Clearer than grep (one call returns
  the caller + callee neighborhood; grep would need to find the symbol, open the file,
  then chase the import in `host.ts`).

### Q2 — "how does a Profile reach a spawned session"
- **`explain ".spawnWorker()"`** → ✅ structure correct (0.4s): `spawnWorker()`
  (`sessions/service.ts:1101`) → `resolveConfig()`, `resolveProfile()`, `createWorktree()`,
  `resolveAgentSpawn()`. **`path "resolveProfile()" ".spawnWorker()"`** = 1 hop.
- **⚠️ accuracy caveat:** the `spawnWorker → resolveProfile` edge is `[INFERRED]`
  (heuristic). Source verification shows `resolveProfile` is actually called by
  `resolveAgentSpawn()` (`service.ts:138`), which `spawnWorker` calls — so the inferred
  edge is a **transitive shortcut presented as a direct call** (mild false precision). The
  `[EXTRACTED]` edges (`spawnWorker → resolveAgentSpawn`, `→ resolveConfig`) are exact.
- **⚠️ field limitation:** `browserTesting` is a *config field*, not an extracted symbol,
  so it is not a graph node — AST extraction captures functions/types/files, not object
  properties. (It's visible via grep as the value threaded through `resolveAgentSpawn`.)
- **`query "how does a Profile reach a spawned session"`** → ❌ again noisy (107 nodes
  starting `_guard.mjs`, `types.ts`); did include `resolveConfig`/`config.ts` but buried.
- **Verdict:** the call graph is right and fast via `explain`/`path`; **treat `[INFERRED]`
  edges as hints to verify, not facts.**

### Q3 (my pick) — "how does `browserTesting` wire the Playwright MCP at spawn?"
Directly serves the in-flight **"Web Designer" browser-profile task**.
- **`explain ".createPty()"`** + **`explain "buildMcpServers()"`** → ✅ **excellent**
  (0.41s). Fully reconstructed from `[EXTRACTED]` edges:
  `.createPty()` (`pty/host.ts:698`) → `buildMcpServers()` (`:268`) →
  `playwrightMcpServer()` (`:250`) → `resolvePlaywrightCli()` (`:237`); and `.createPty()`
  also → `injectSkills()`, `buildSpawnArgs()`, `writeSessionSettings()`. That is exactly
  the spawn recipe a Web-Designer worker needs, in one shot.
- **Disambiguation:** `.createPty()` is a duplicated label (~20 nodes — the real
  `PtyHost` method plus test-seam stubs). `explain` auto-resolved to the canonical
  high-degree node (degree 8, `pty/host.ts:698`). Clean, but it silently picks one — to
  inspect a test seam you'd need its node id.
- **Verdict:** the standout result. This replaced what would otherwise be several greps
  across `host.ts` + reading to assemble the call chain.

## Evidence on the open questions

| Question | Finding |
|---|---|
| **Did it save grepping?** | Yes for *orientation* (cold subsystem). `explain`/`path` return the call neighborhood in one call vs the grep→open→read→follow-imports loop. A *single* `rg` is faster in wall-clock (0.06s vs ~0.41s), but you rarely need one grep — you need the graph it would take many greps to assemble. |
| **Accuracy / ghost nodes?** | Code structure is accurate: report says **99% EXTRACTED, 1% INFERRED (47 edges, avg conf 0.8), 0% AMBIGUOUS, 0 token cost**. `diagnose multigraph` is **clean**: 0 missing/dangling endpoints, 0 self-loops, 0 duplicate or collapsed edges. No structural ghosts. The two real caveats: (1) `[INFERRED]` edges can be imprecise (Q2), (2) overloaded method names collide as duplicate-labelled nodes (Q3) — neither is a wrong edge. |
| **Setup friction?** | Minimal. `uv tool install graphifyy` + `graphify update packages`; zero config, zero API key, ~12s build. Bundled tree-sitter grammars (incl. TS) ship in the install. |
| **Incremental-update behavior?** | `graphify update packages` is AST-only (no API), idempotent — a no-change re-run reported *"No code-graph topology changes detected; outputs left untouched"* in ~8s (still re-parses all files; not instant). Freshness is tracked: `graph.json` records `built_at_commit` (here `99e9c661` = HEAD) and the report tells you to compare against `git rev-parse HEAD`. |
| **NL `query` command** | Weakest surface — keyword-seeded BFS that dumps 100–250 loosely-related nodes. Not useful for orientation; steer agents away from it. |

## Adoption recommendation (if KEEP — and it is)

Bundle **`/graphify` as an opt-in skill**, same posture as the opt-in worker browser:
the **human installs `graphifyy` once**; nothing is wired into the daemon for v1
(no auto-build, no spawn-time hook, no MCP tool). The skill should:

1. **Build/refresh** the code-only graph on demand: `graphify update packages`
   (never `extract` with a backend; never any API key).
2. **Steer to node-targeted commands** — `explain` / `path` / `affected` — and explicitly
   **discourage the NL `query`** command (it's noise).
3. **Mark `[INFERRED]` edges as verify-before-trust**, and remind that config *fields*
   (e.g. `browserTesting`) won't appear as nodes — grep those.
4. **Keep it reversible:** instruct that `graphify-out/` (+ `.graphify/`, `cost.json`) live
   in `.git/info/exclude`; **never** run `graphify hook install`, `graphify <platform> install`
   (these edit CLAUDE.md / add PreToolUse hooks), or any vault export.

**Daemon wiring for v1: none.** This stays a worker-side convenience, fully additive and
off by default, exactly like the spike — consistent with Loom's trust boundaries (the vault
is the human-only system of record; agents never push/commit/install hooks).

### Out of scope this spike
- Optional extension (graph a source repo such as impeccable/taste-skill to speed the
  extraction-inventory ticket) was **not run** — time-boxed; the 3 in-repo queries already
  give a clear verdict. Worth a follow-up if/when the skill is authored.
