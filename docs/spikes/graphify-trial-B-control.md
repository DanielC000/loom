# graphify A/B trial — Arm B (control / baseline)

**Method:** today's standard worker toolset only — `Grep`, `Read` (no graphify, no Explore agent
needed in the end). Subsystem under test: daemon-restart → boot-fleet-resume → boot-reconcile.

> **Orientation note up front (affects every Q):** the 5 questions *pre-named the symbols*
> (`liveFleetResumeSet`, `resumeFleetOnBoot`, `worktreeHasWork`, `daemon-supervisor.mjs`, "exit 75").
> That made grep almost trivially effective — one symbol grep per question landed the file on the
> first try. A genuinely cold orientation where I had to *discover* those names first would be
> meaningfully harder; this trial's questions are closer to "verify/trace a known symbol" than
> "find the unknown entry point." I flag this so the manager weights the comparison fairly.

Total files inspected across all 5 Qs: **7** — `mcp/orchestration.ts`, `orchestration/restart.ts`,
`sessions/service.ts`, `index.ts`, `git/worktrees.ts`, `scripts/daemon-supervisor.mjs`,
`test/restart-fleet.mjs`. Total turns: **~6** (4 batched grep/read rounds + spec read + this write).

---

## Q1 — Call-chain: `daemon_restart` MCP tool → worker PTY re-spawn after the daemon returns

**Answer (the full path):**

1. **MCP tool registered** — `packages/daemon/src/mcp/orchestration.ts:297-316`. The
   `daemon_restart` tool handler calls `sessions.requestDaemonRestart(managerSessionId, reason)`
   (`orchestration.ts:312`).
2. **`requestDaemonRestart`** — `packages/daemon/src/sessions/service.ts:468-524`:
   - guards: must be a `manager` (`:470`) and must be under the supervisor `LOOM_SUPERVISED`
     (`:471-473`);
   - `buildDaemon()` rebuilds *while still alive* — a bad build aborts the restart (`:474-477`,
     impl `orchestration/restart.ts:149-183`);
   - captures the fleet: `const resume = this.liveFleetResumeSet()` (`:490`);
   - snapshots each session's pending inbound FIFO (`:497-506`) + live transcripts (`:512`);
   - `writeRestartIntent({reason, managerSessionId, resume, …pending})` (`:513-519`, writes
     `~/.loom/restart-intent.json` via `restart.ts:117-119`);
   - `setTimeout(() => process.exit(RESTART_EXIT_CODE /*75*/), 300)` (`:522`) — exits *after* the
     MCP response flushes; the manager's own PTY dies with the process.
3. **Supervisor relaunches** — `scripts/daemon-supervisor.mjs:29-44`: the run loop sees
   `runCode === RESTART_EXIT_CODE` (`:40`), rebuilds + `continue`s, re-spawns `node dist/index.js`
   with `LOOM_SUPERVISED=1` (`:39`).
4. **Boot reads the intent** — `packages/daemon/src/index.ts:122` (`readRestartIntent()`), then
   *after* boot-reconcile, `index.ts:290-292` calls
   `sessions.resumeFleetOnBoot(restartIntent)` (intent first `clearRestartIntent()`-ed at `:291`).
5. **`resumeFleetOnBoot`** — `service.ts:584-659`: iterates `resumeSetFromIntent(intent)`
   (`:592`), and for each entry calls `resumeOne(sessionId)` which defaults to
   `this.resume(id)` (`:589-591`).
6. **`resume(sessionId)`** — `service.ts:389-455`: flips the row to `live` (`:420`) then
   **`this.pty.spawn({ … resumeId: session.engineSessionId, role, browserTesting })`**
   (`:421-449`) — **this is the worker PTY being re-spawned** (a `--resume` spawn into the same
   cwd, role re-passed so the worker's `loom-orchestration`/`worker_report` surface returns).
7. Post-resume the worker gets its continuation **nudge** enqueued (`service.ts:620-626`) — not
   part of the spawn itself (resume injects nothing).

- **Method/steps:** `grep daemon_restart` → orchestration.ts; `grep requestDaemonRestart|resumeFleetOnBoot|process\.exit` in service.ts; read restart.ts; read service.ts 460-524 + 389-455; read index.ts 280-300; read supervisor.
- **Files opened:** 5 (orchestration.ts, restart.ts, service.ts, index.ts, daemon-supervisor.mjs).
- **Dead-ends:** none in code. (One non-code dead-end: `tasks_get` rejected short id prefixes;
  needed full UUIDs — unrelated to orientation.)
- **Turns/time:** ~3 turns / ~5 min.
- **Confidence:** **High.** End-to-end chain read directly, both halves (exit + boot) confirmed.

---

## Q2 — Guards preventing a LIVE session's worktree being deleted during boot-reconcile

Boot-reconcile = `reconcileOrchestrationOnBoot(protectedSessionIds)` (`service.ts:2020-2123`),
run from `index.ts:131` *before* fleet-resume. There are **four** distinct guards:

1. **`protectedSessionIds` skip — the restart-intent fleet.** Seeded at `index.ts:122-123` via
   `protectedIdsFromIntent(restartIntent)` (`restart.ts:105-110` — spans the *whole captured
   cross-project fleet*, not just the requester). Checked in **all three passes**:
   `service.ts:2038` (Pass A), `:2081` (Pass A2), `:2106` (Pass B). A session about to be
   resumed has its worktree left intact.
2. **`worktreeHasWork` "safe-to-discard" guard (the primary data-loss fix, P0 2026-06-05).**
   - Pass A: `service.ts:2051` — before `finalizeMerge` would `removeWorktree`, if the worktree
     still holds work it is **kept** (`:2053-2056`). Stops a 0-commit branch (tip == HEAD →
     trivially "merged") from misdetecting a just-`exited` LIVE worker as an orphaned merge.
   - Pass B: `service.ts:2112` — GC of an exited/dead worktree is skipped + kept if
     `worktreeHasWork` (`:2114-2116`).
   - Impl: `git/worktrees.ts:401-435` — returns `true` if (1) dirty working tree
     (porcelain status, daemon `.claude/` noise ignored) **or** (2) branch ahead of base
     (`rev-list --count base..branch > 0`). **Fails SAFE**: any bounded git timeout/parse error
     → `return true` (keep the dir) — `worktrees.ts:417-418, 428, 430`.
3. **`processState`/`resumability` gate in Pass B.** `service.ts:2107` — Pass B only ever
   considers `processState === "exited"` *or* `resumability === "dead"` worktrees. A still-`live`
   row is never a Pass-B GC candidate. (Caveat: `recoverStaleSessions` marks every *prior-run*
   session `exited` at boot, so this gate alone is insufficient for the restart fleet — which is
   exactly why guards #1 + #2 exist.)
4. **`finalizeMerge` ordering + best-effort `removeWorktree`** (defence-in-depth, not strictly a
   "live" guard): `service.ts:1969-1988` — `removeWorktree` is best-effort/swallowed and the
   destructive `deleteBranch` runs last, so a busy/held dir can't cascade into data loss.

- **Method/steps:** `grep reconcileOrchestrationOnBoot|worktreeHasWork|protectedSessionIds` in
  service.ts; read service.ts 1940-2123; read `worktreeHasWork` in worktrees.ts; cross-checked
  the `protectedSessionIds` seed in index.ts + `protectedIdsFromIntent` in restart.ts.
- **Files opened:** 3 (service.ts, worktrees.ts, restart.ts) + index.ts (already open).
- **Dead-ends:** none. The inline comments (`P0 data-loss fix`) confirmed each guard's intent.
- **Turns/time:** ~2 turns / ~4 min.
- **Confidence:** **High.** All four guard sites read in source with their checks.

---

## Q3 — Reverse-deps: changing the return type/shape of `liveFleetResumeSet()`

`liveFleetResumeSet(): RestartResumeEntry[]` is defined at `service.ts:534-543`. Its return type
is the shared interface **`RestartResumeEntry { sessionId; role; parentSessionId }`**
(`restart.ts:45-51`), which is *also* the element type of `RestartIntent.resume`
(`restart.ts:67`). So the blast radius is the whole resume pipeline, not just the call site.

**Production call sites / consumers that break:**
- `service.ts:490` — `const resume: RestartResumeEntry[] = this.liveFleetResumeSet()` in
  `requestDaemonRestart`. Directly typed; feeds `writeRestartIntent({ resume })` (`:513-519`).
- `restart.ts:67` — `RestartIntent.resume?: RestartResumeEntry[]` (the persisted shape). Changing
  the entry shape changes the on-disk intent JSON contract.
- `restart.ts:88-98` `resumeSetFromIntent()` — returns `RestartResumeEntry[]`; its OLD-format
  fallback *constructs* entries (`{sessionId, role, parentSessionId}`) at `:92, :95`.
- `restart.ts:105-110` `protectedIdsFromIntent()` — reads `.sessionId` (`:106`).
- `service.ts:592-655` `resumeFleetOnBoot()` — reads `.sessionId`, `.role`, `.parentSessionId`
  on every entry (`:610, :613-614, :620, :627`). The heaviest consumer.

**Tests that break:**
- `test/restart-fleet.mjs:97-106` — asserts captured entries expose `.sessionId`, `.role`,
  `.parentSessionId` (e.g. `:100-104`); `:219-220` does `.map((e) => e.sessionId)`; `:113-116`
  constructs entries of that shape into an intent.
- `test/agent-runs-primitive.mjs:181` — `liveFleetResumeSet().some((e) => e.sessionId === s3.id)`
  (depends on `.sessionId`).

(Also referenced in prose only — no code coupling — in `test/restart-intent.mjs` comments.)

- **Method/steps:** repo-wide `grep liveFleetResumeSet` (output_mode content) → 4 hits (1 def, 1
  prod call, 2 tests); read the `RestartResumeEntry`/`RestartIntent` types in restart.ts to find
  the *transitive* consumers (resumeSetFromIntent / protectedIdsFromIntent / resumeFleetOnBoot);
  read restart-fleet.mjs to see which fields the tests actually assert.
- **Files opened:** 3 (service.ts, restart.ts, restart-fleet.mjs) — others already open.
- **Dead-ends:** mild — a naive "grep the function name" finds only 2 prod refs and misses the
  real reverse-deps, which are coupled through the *shared type* `RestartResumeEntry`, not the
  function name. Had to pivot from name-grep to type-tracing to get the true blast radius. This
  is the one Q where a call-graph tool would plausibly have saved a step.
- **Turns/time:** ~2 turns / ~4 min.
- **Confidence:** **Medium-High.** Confident on the type-coupled consumers I traced; a renamed
  destructure could hide a usage, but the shared-interface coupling makes the set well-bounded.

---

## Q4 — How a PARKED (rate-limited) session is resumed-live-but-NOT-nudged on boot; the "parked" field

**Field that drives "parked":** **`session.rateLimitedUntil`** (a timestamp). A session is
"parked" iff `rateLimitedUntil` is set **and** in the future:
`service.ts:605-608` —
```
const isParked = (id) => {
  const s = this.db.getSession(id);
  return !!s?.rateLimitedUntil && new Date(s.rateLimitedUntil).getTime() > now.getTime();
};
```

**Flow (in `resumeFleetOnBoot`, `service.ts:584-659`):**
1. A parked session **IS captured** into the resume set — `liveFleetResumeSet` filters only on
   `processState === "live"` (`:541`); a rate-limit cap does not kill the PTY, so a parked
   session is still `live` and gets captured (comment at `service.ts:526-532` + `487-489`).
2. On boot it **IS resumed live**: `resumeOne(e.sessionId)` is still called (`:616`) so the
   PTY comes back — *the rate-limit watcher needs it live to recover it at reset*.
3. But the nudge + pending-replay are **WITHHELD**:
   `service.ts:615, :618` — `if (parked) { skippedParked.push(...); continue; }` runs **before**
   `replayPending(...)` and the worker/manager nudge `enqueueStdin(...)` (`:619-635`). Same for
   the requesting manager: `service.ts:641-643` short-circuits to `skippedParked` before its
   "code is live" prompt (`:644-652`).
4. Its DB park state (`rateLimitedUntil`) is **left intact** — boot never clears it (design note
   `service.ts:578-580`), so the rate-limit watcher resumes the turn later at reset.
5. Result is surfaced in the boot log as `… resumed-but-parked (usage hold honored)`
   (`index.ts:295`).

- **Method/steps:** I'd already read `resumeFleetOnBoot` whole for Q1; re-read `:605-655` for the
  `isParked` predicate + the `if (parked) … continue` guard placement. `grep rateLimitedUntil`
  confirmed it's the only "parked" signal in this path.
- **Files opened:** 1 (service.ts, already open) + index.ts log line.
- **Dead-ends:** none.
- **Turns/time:** ~1 turn / ~2 min (rode on Q1's reading).
- **Confidence:** **High.** Predicate + the early-`continue` that skips nudge/replay both read
  directly; "resumed live but not nudged" is explicit in code + comments.

---

## Q5 — Where the restart sentinel exit code (75) is PRODUCED and CONSUMED

**The constant (single source of truth):** `RESTART_EXIT_CODE = 75`, exported from
`packages/daemon/src/orchestration/restart.ts:35` (with the "MUST match" contract comment at
`:34`).

**PRODUCED (the daemon exits with it):**
- `service.ts:522` — `setTimeout(() => process.exit(RESTART_EXIT_CODE), 300)` inside
  `requestDaemonRestart`, after a green build + intent write. This is the *only* place the daemon
  exits 75.

**CONSUMED (the supervisor relaunches on it):**
- `scripts/daemon-supervisor.mjs:18` — `const RESTART_EXIT_CODE = 75; // must match …restart.ts`
  (a **hardcoded duplicate** — the supervisor is plain `.mjs` and can't import the TS const, so
  the value is mirrored, kept honest only by the paired "must match" comments).
- `scripts/daemon-supervisor.mjs:40-43` — `if (runCode === RESTART_EXIT_CODE) { … continue; }`
  rebuilds + relaunches; **any other exit code falls through to `process.exit(runCode)`**
  (`:44`) so a crash stays down (no crash-loop).

**Coupling risk worth flagging:** the value 75 lives in two files (TS const + `.mjs` literal)
linked only by comment. Changing one without the other silently breaks self-host restart (daemon
would exit a code the supervisor treats as "crash → stop").

- **Method/steps:** `grep 75` scoped to `daemon-supervisor.mjs`; `grep RESTART_EXIT_CODE`
  (already surfaced restart.ts:35 + service.ts:522 in Q1's reads). Three sites, all read.
- **Files opened:** 2 (restart.ts, daemon-supervisor.mjs) — both already open from Q1.
- **Dead-ends:** none.
- **Turns/time:** ~1 turn / ~1 min.
- **Confidence:** **High.** Exhaustive — `RESTART_EXIT_CODE`/`75` greps cover every occurrence.

---

## Overall "how hard was this to orient" (baseline)

**Easy-to-moderate.** With the symbols pre-named in the questions, plain `Grep` (symbol → file,
first hit) + targeted `Read` resolved 4 of 5 questions with high confidence in ~6 turns / ~20 min
and 7 files. The inline comments in this subsystem are unusually rich (ticket refs, "P0 data-loss
fix", "ORDER IS CRASH-CRITICAL", "MUST match") and did most of the heavy lifting — they explain
*why* each guard exists, which is exactly what a graph tool wouldn't surface.

The one place the baseline felt friction was **Q3 (reverse-deps)**: name-grep alone under-counts,
because the real blast radius is coupled through the shared `RestartResumeEntry` *type*, not the
function name — I had to manually pivot to type-tracing. That is the single question where a
call-/type-graph tool would plausibly have beaten grep.
