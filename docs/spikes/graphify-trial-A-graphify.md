# graphify A/B trial — Arm A (graphify)

Controlled A/B trial (task f3917f96). I answered the 5 orientation questions about the
daemon-restart → boot-fleet-resume → boot-reconcile subsystem **primarily via graphify**
(`explain` / `path` / `affected` / `query`), falling back to grep/Read only where graphify
came up short — and noting every fallback. This is a benefit test: the honest method-log
matters as much as the answers.

## Setup (guardrails — all honored)
- graphify `0.8.35` already installed locally via `uv tool install graphifyy` (from the pilot).
- Built **code-only**: `graphify update packages` → `packages/graphify-out/graph.json`
  (2381 nodes, 3674 edges, 155 communities). **No** `extract`/backend, **no** API key, **no**
  token spend, **no** `hook install`, **no** platform/Obsidian export, **no** push.
- `graphify-out/`, `.graphify/`, `graph.json`, etc. were already in `.git/info/exclude` from the
  pilot (card cf54807c). Confirmed `git status` clean after the build — nothing tracked but this
  doc.
- One scope note: `graphify update packages` indexes **`packages/` only**. The restart supervisor
  (`scripts/daemon-supervisor.mjs`) lives **outside** `packages/`, so it is **absent from the
  graph entirely** — directly relevant to Q5 (see below).

---

## Q1 — Trace `daemon_restart` MCP tool → a worker PTY re-spawned after the daemon returns

**Answer (full chain):**
1. MCP tool handler `daemon_restart` → `sessions.requestDaemonRestart(managerSessionId, reason)`
   — `packages/daemon/src/mcp/orchestration.ts:312`.
2. `SessionService.requestDaemonRestart()` — `service.ts:468`: manager-only check (`:470`) →
   `isSupervised()` guard (`:471`) → `buildDaemon()` rebuild-first (`:474`) → pre-restart backup
   (`:482`) → **capture** `liveFleetResumeSet()` (`:490`) → snapshot pending FIFOs (`:500`) →
   `snapshotAllLive()` transcripts (`:512`) → `writeRestartIntent(...)` to
   `~/.loom/restart-intent.json` (`:513`) → `setTimeout(() => process.exit(RESTART_EXIT_CODE), 300)`
   (`:522`).
3. Supervisor `scripts/daemon-supervisor.mjs`: `for(;;)` loop sees `runCode === RESTART_EXIT_CODE`
   (`:40`) → `continue` → rebuilds (`:32`) + relaunches `node dist/index.js` (`:39`).
4. Boot wiring `index.ts`: `readRestartIntent()` (`:122`) → after reconcile, `if (restartIntent)`
   → `sessions.resumeFleetOnBoot(restartIntent)` (`:292`).
5. `SessionService.resumeFleetOnBoot()` — `service.ts:584`: `resumeSetFromIntent(intent)` (`:592`)
   → per entry `resumeOne(e.sessionId)` (`:616`), where `resumeOne` defaults to `this.resume(id)`
   (`:589-590`). **`this.resume()` is the actual PTY re-spawn.** Then continuation nudges via
   `this.pty.enqueueStdin(...)` (`:621` worker, `:628` manager, `:646` requester).

**graphify commands used:**
- `graphify explain "requestDaemonRestart"` — gave file:line (service.ts:468) + all 7 forward
  calls (takeBackup, buildDaemon, liveFleetResumeSet, snapshotAllLive, writeRestartIntent, …).
- `graphify explain "resumeFleetOnBoot"` / `"resumeSetFromIntent"` / `"buildDaemon"` /
  `"isSupervised"` / `"writeRestartIntent"` / `"snapshotAllLive"` — fleshed out the forward chain
  and confirmed restart.ts as the helper module.

**Fallback to grep (noted):**
- `graphify affected "requestDaemonRestart"` returned **"No affected nodes found"** — it did NOT
  capture the MCP-tool handler → method call. Likewise `affected "resumeFleetOnBoot"` was empty,
  missing the `index.ts` boot wiring. Both are `sessions.method()` instance-dispatch calls that
  graphify's AST extractor does not resolve to the receiver's method node. → grep
  `requestDaemonRestart|resumeFleetOnBoot` found the two **entry points** (orchestration.ts:312,
  index.ts:292) graphify could not.
- `graphify explain ".resume()"` fuzzy-matched to the wrong node (`resumeSetFromIntent`); the
  actual `this.resume()` re-spawn step was confirmed by Read of service.ts:589-590, not graphify.

**Files opened:** 2 (service.ts, index.ts; supervisor read for step 3 shared with Q5).
**Dead-ends:** `affected` empty on both endpoints; `explain ".resume()"` mis-resolved.
**Turns/time:** ~5 tool calls / ~6 min.
**Confidence:** High (every hop confirmed against source).
**Help or hindrance:** *Mixed* — `explain` nailed the forward fan-out instantly, but the two
human-facing entry points (the whole point of "trace from the tool") needed grep.

---

## Q2 — Guards preventing a LIVE session's worktree from being deleted during boot-reconcile

**Answer — four layered guards, all in `reconcileOrchestrationOnBoot()` (`service.ts:2020`) +
its boot wiring:**
1. **`protectedSessionIds` set** — checked in **all three** passes: Pass A `:2038`, Pass A2
   `:2081`, Pass B `:2106`. Seeded in `index.ts:123` from `protectedIdsFromIntent(restartIntent)`
   (`restart.ts:105`), which spans the **entire captured fleet across all projects** (every id in
   `resume[]` + the requester + legacy `workerSessionIds`). This is the primary guard: boot's
   `recoverStaleSessions()` (`index.ts:60`) marks every prior-run session `exited`, so without
   this the just-restarted live fleet's worktrees would be GC-eligible.
2. **`worktreeHasWork()` SAFE-TO-DISCARD guard** — Pass A `:2051`, Pass B `:2112`
   (`git/worktrees.ts:401` → `worktreeStatusHasWork` `:365`). Deletes only a worktree that is
   0-commits-ahead **and** clean; **fails safe → keep** on any timeout/error. Holds for ALL
   sessions, protected or not.
3. **`processState !== "exited" && resumability !== "dead"` gate** — Pass B `:2107`. A genuinely
   live session is skipped outright (only exited/dead rows are GC candidates).
4. **`isBranchMerged()` precondition** — Pass A `:2042`: a worktree is only finalized/removed in
   Pass A if its branch is provably merged into HEAD.

**graphify commands used:**
- `graphify explain "worktreeHasWork"` → `worktrees.ts:401`, and crucially its reverse edge
  `<-- .reconcileOrchestrationOnBoot() [calls]` — this is how I found the reconcile method by name.
- `graphify explain "reconcileOrchestrationOnBoot"` → `service.ts:2020` + its 4 forward calls
  (removeWorktree, worktreeHasWork, isBranchMerged, finalizeMerge).
- `graphify explain "protectedIdsFromIntent"` → `restart.ts:105`, reverse edge
  `<-- main() [calls]` (the index.ts boot use) and `<-- index.ts [imports]`.

**Fallback to grep/Read (noted):** None for *finding* the guards — graphify's `explain` reverse
edges (worktreeHasWork ← reconcile, protectedIdsFromIntent ← main) were genuinely the fastest
route in. I still had to **Read** service.ts:2020-2123 to read the actual guard *conditions* and
their order (graphify gives the call graph, not the branch logic), but that is reading the answer,
not searching for it.

**Files opened:** 1 (service.ts; restart.ts shared with Q3/Q5).
**Dead-ends:** None.
**Turns/time:** ~3 tool calls / ~4 min.
**Confidence:** High.
**Help or hindrance:** *Helped clearly* — this is graphify's best showing. `explain` on a leaf
helper (`worktreeHasWork`) walked me straight back up to the reconcile method and its sibling
guards without a single grep.

---

## Q3 — If you change the return shape of `liveFleetResumeSet()`, what call sites + tests break?

**Answer:**
- **Production call site (1):** `service.ts:490` — `const resume: RestartResumeEntry[] =
  this.liveFleetResumeSet();` inside `requestDaemonRestart()`. The returned `RestartResumeEntry[]`
  flows into `writeRestartIntent({ resume, … })` (`:513`) and is later read field-by-field
  (`e.sessionId`, `e.role`, `e.parentSessionId`) in `resumeFleetOnBoot` (`service.ts:610,613-635`)
  and `resumeSetFromIntent` (`restart.ts:88-98`).
- **Tests that break (2) — both call it directly and assert on the return shape:**
  - `test/restart-fleet.mjs:97` `const fleet = sessions.liveFleetResumeSet();` + `:219-220`
    (`.map((e) => e.sessionId)`, `.some((e) => e.sessionId === …)`).
  - `test/agent-runs-primitive.mjs:181` `!svc.liveFleetResumeSet().some((e) => e.sessionId === …)`.
- **Type consumers** of `RestartResumeEntry` shape: `restart.ts:45` (interface), `:67`
  (`RestartIntent.resume?`), `:88-98` (`resumeSetFromIntent` builds it), `service.ts:490,534`.

**graphify commands used:**
- `graphify affected "liveFleetResumeSet" --depth 3` → returned **exactly one** node:
  `.requestDaemonRestart()`. Correct for production, but **incomplete**.
- `graphify explain "liveFleetResumeSet"` → confirmed the single reverse caller + `RestartResumeEntry [references]`.
- `graphify affected "RestartResumeEntry" --depth 2` → surfaced real consumers (restart.ts,
  service.ts) **but also four FALSE `imports_from` edges** (server.ts, audit.ts, platform.ts,
  run.ts at L1) — grep confirms none of those files reference `RestartResumeEntry`. Noise.

**Fallback to grep (noted) — this is the headline failure for graphify:**
graphify's `affected` reported "1 caller" with an authoritative air, but grep
`liveFleetResumeSet` revealed **2 tests** (`restart-fleet.mjs`, `agent-runs-primitive.mjs`) that
call it via `sessions.`/`svc.` instance dispatch and assert on `.sessionId`. graphify **missed
both** — and I verified the cause: `restart-fleet.mjs` **is** in the graph (node id
`daemon_package_scripts_test_restart_fleet`), so it isn't a coverage gap — graphify simply never
built the `test → method` edge. For a refactor-impact question, a reverse-dep tool that silently
under-reports the exact thing it's for (which tests break) is worse than no tool, because the
"1 caller" answer *looks* complete.

**Files opened:** 0 new (grep + prior reads sufficed).
**Dead-ends:** `affected` false-negative on tests; `affected RestartResumeEntry` false-positive
imports_from edges.
**Turns/time:** ~3 tool calls / ~4 min.
**Confidence:** High (grep is exhaustive here; graphify alone would have been ~60% — prod only).
**Help or hindrance:** *Got in the way* — it gave a confident, incomplete answer. Only grep made
it trustworthy.

---

## Q4 — How does a PARKED (rate-limited) session get resumed-live-but-NOT-nudged on boot? What field drives "parked"?

**Answer:**
- In `resumeFleetOnBoot()` (`service.ts:584`), the local `isParked(id)` (`:605-608`) checks the
  session row's **`rateLimitedUntil`** field: `!!s?.rateLimitedUntil && new
  Date(s.rateLimitedUntil).getTime() > now.getTime()`. **`rateLimitedUntil` is the field that
  drives "parked."**
- Flow: every entry is resumed live first — `resumeOne(e.sessionId)` → `this.resume(id)` (`:616`,
  spawns the PTY so the rate-limit watcher can later recover it). Then if `parked`, the code does
  `skippedParked.push(...); continue;` (`:618`) **before** `replayPending` and the
  `enqueueStdin` nudge — so a parked session is **resumed but receives no continuation nudge and no
  pending-FIFO replay** (never pushes a held turn back into the cap). Same withholding for the
  requesting manager at `:641-642`. The DB park state is left intact.
- `rateLimitedUntil` is written by `db.setRateLimitedUntil(...)` in PtyHost's `onRateLimited`
  callback (`index.ts:86`), derived from the resolved rate-limit config.

**graphify commands used:**
- `graphify explain "resumeFleetOnBoot"` (from Q1) located the method; the parked branch is read
  from the method body. graphify confirmed `resumeFleetOnBoot → resumeSetFromIntent` but the
  `isParked`/`rateLimitedUntil` logic is an *intra-method local + DB field*, which graphify does
  not model (it's neither a top-level node nor a cross-module edge).

**Fallback to Read (noted):** The entire answer came from **reading** `service.ts:584-658`.
graphify pointed me at the method (useful) but contributed nothing to the parked-field mechanics —
`rateLimitedUntil`, the resume-before-skip ordering, and the nudge-withhold are all branch-level
logic inside one method, below graphify's resolution. No grep needed beyond confirming
`rateLimitedUntil`'s writer (`index.ts:86`), which graphify's `onRateLimited` node also did not
link to a DB setter.

**Files opened:** 0 new (service.ts already open; index.ts already open).
**Dead-ends:** None, but graphify added ~zero signal here.
**Turns/time:** ~1 tool call (Read) / ~3 min.
**Confidence:** High.
**Help or hindrance:** *Neutral/absent* — graphify located the method (which Q1 already had);
the actual answer is intra-method logic it can't see. A grep for `rateLimitedUntil` would have
been just as fast.

---

## Q5 — Where is the restart sentinel exit code (75) PRODUCED and where CONSUMED?

**Answer:**
- **Defined:** `const RESTART_EXIT_CODE = 75;` — `packages/daemon/src/orchestration/restart.ts:35`.
- **PRODUCED:** `setTimeout(() => process.exit(RESTART_EXIT_CODE), 300)` —
  `service.ts:522` (the only `process.exit` with it; imported at `service.ts:22`).
- **CONSUMED:** `scripts/daemon-supervisor.mjs` — its **own** copy `const RESTART_EXIT_CODE = 75;`
  (`:18`, with a comment "must match packages/daemon/src/orchestration/restart.ts"), checked at
  `:40` `if (runCode === RESTART_EXIT_CODE)` → `continue` the `for(;;)` loop (`:42`) to rebuild +
  relaunch. **The value 75 is duplicated, not imported** — the supervisor is a standalone `.mjs`
  that can't import the daemon's TS, so the two must be kept in sync by hand.

**graphify commands used:**
- `graphify explain "RESTART_EXIT_CODE"` → **"No node matching found"** (graphify doesn't index
  module-level `const` constants as nodes).
- `graphify query "RESTART_EXIT_CODE exit 75 sentinel"` → **completely off-target**: keyword BFS
  latched onto unrelated test `exitLog` nodes (graceful-stop.mjs, pty-stop-queue.mjs) — 26 nodes,
  none relevant.

**Fallback to grep (noted) — graphify was useless here:**
Both producer and consumer were found by grep `RESTART_EXIT_CODE|=== 75|exit 75`. Two structural
reasons graphify can't answer this: (1) it doesn't model bare constants as graph nodes; (2) the
**consumer lives in `scripts/`, which `graphify update packages` never indexed at all.** A
constant-trace question is squarely outside graphify's code-graph model.

**Files opened:** 1 (daemon-supervisor.mjs; restart.ts shared with Q3).
**Dead-ends:** `explain` (no node) + `query` (irrelevant BFS) both whiffed.
**Turns/time:** ~2 tool calls / ~3 min.
**Confidence:** High (grep is exhaustive; the cross-file duplication is the notable detail).
**Help or hindrance:** *Got in the way* — two graphify calls returned nothing/garbage before grep
answered it in one.

---

## Effort tally (Arm A)
- **graphify commands run:** ~16 (`explain` ×11, `affected` ×3, `query` ×2).
- **grep fallbacks:** 3 (Q1 entry points, Q3 tests/call-sites, Q5 constant) + 1 confirm.
- **Files Read:** 4 distinct (service.ts, index.ts, restart.ts, daemon-supervisor.mjs).
- **Total turns:** ~14 tool calls. **Wall time:** ~25 min.

## Honest overall take — did graphify genuinely help on this subsystem?

**Partial. It helped on one of five questions and got in the way on two.**

- **Where it genuinely helped (Q2):** `explain` on a leaf helper (`worktreeHasWork`) walked
  reverse edges straight up to the reconcile method and its sibling guards — faster than I'd have
  found them by grep. `explain`'s forward fan-out on `requestDaemonRestart` (Q1) was also a real
  head start on the call chain.
- **Where it actively misled (Q3, Q5):** `affected liveFleetResumeSet` confidently returned
  "1 caller" while missing the **2 tests** that actually break a shape change — and I confirmed
  those test files ARE in the graph, so it's an edge-building failure, not a coverage gap. Plus
  false `imports_from` edges on the type. Q5 (a constant, with its consumer in un-indexed
  `scripts/`) was outside the model entirely.
- **The systemic limitation:** graphify reliably captures **forward, same-class method→method
  calls**, but does **not** resolve `instance.method()` cross-module dispatch — which is exactly
  how MCP handlers, boot wiring (`index.ts`), and `.mjs` tests call into `SessionService`. So
  every "who calls / what breaks" question — the highest-value orientation queries — silently
  under-reports. Constants and intra-method branch logic (Q4's `rateLimitedUntil` park) are also
  invisible.

**Verdict:** graphify is a decent *forward call-chain explorer* and a fine "what does this method
touch" lens, but for cold-orientation on this subsystem it could not be trusted on its own for the
two questions that most need a reverse-dependency tool — and its confident-but-incomplete `affected`
output is a real hazard. Net, on this real task it was a **mild aid that still required grep to be
correct**, not a replacement for it. I would not have answered Q1/Q3/Q5 correctly with graphify
alone.
