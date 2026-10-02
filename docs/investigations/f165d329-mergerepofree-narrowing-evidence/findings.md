# f165d329 — evidence for narrowing `mergeRepoFree` (merge-vs-worker gate exclusion) — NO BUILD this round

Card `f165d329` directed an evidence-only pass before deciding whether to narrow `gate-semaphore.ts`'s
`mergeRepoFree` (currently: a `worker` gate is blocked by an active or queued same-repo `merge`; see
`docs/decisions/e4701333-*.md` and `docs/decisions/eb491463-*.md`) now that its two prerequisites
(`fc53ea74`, `a6b1c4c7`) are merged to main. This note records what was found; no source was edited.

## 1. Premise-correction: the effective wait DOES now scale with the gate cap

Computed directly from the real exported functions (`packages/daemon/test/_codex-real-spawn-lock.mjs`'s
`computeCodexLockWaitTimeoutMs`/`computeCodexFileCeilingMs`, invoked via a throwaway Node script, not
hand arithmetic):

| cap | lock WAIT_TIMEOUT_MS | outer ceiling, default-budget file (120s own-work) | outer ceiling, `codex-doctrine-real-spawn` (300s own-work) |
|---|---|---|---|
| 1 | 180,000ms | 300,000ms (headroom 120s) | 480,000ms (headroom 300s) |
| 2 | 180,000ms (floor; unchanged from today) | 300,000ms (headroom 120s) | 480,000ms (headroom 300s) |
| 3 | 360,000ms | 480,000ms (headroom 120s) | 660,000ms (headroom 300s) |

`computeCodexFileCeilingMs(ownWork, cap) = ownWork + computeCodexLockWaitTimeoutMs(cap)` by construction
(`_codex-real-spawn-lock.mjs:142-148`), so the outer per-file SIGTERM ceiling `scripts/test-daemon.mjs`'s
`resolveEffectiveTimeoutMs` (`scripts/test-daemon.mjs:1014-1021`, consumed by `runOne` at `:1417`) now
hands a codex-family file always exceeds the lock's own internal wait timeout by exactly the file's own
work budget, AT EVERY CAP — the previously-confirmed no-op (at cap=2, `WAIT_TIMEOUT_MS`=180s already
exceeded the OLD fixed 120s outer ceiling for 6 of 7 family files, so the harness SIGTERM'd a legitimately
waiting file before its own internal timeout could ever fire — `docs/decisions/fc53ea74-*.md`'s "Amendment"
section) is structurally closed. Note the multiplier only starts moving at cap≥3 (`Math.max(1, cap-1)`
floors at 1 for cap≤2) — unchanged from today's owner-set cap=2 by design, not a gap.

Live wiring confirmed at source: `gateOpIdEnvOverride` (`sessions/service.ts:1376-1378`) stamps
`LOOM_GATE_CONCURRENT_CAP` on every gate child — merge (multiple `runGateSeq` call sites), worker
`run_gate` (`:19398`), deploy (`:4311`) — always from the live `orchestration.maxConcurrentGates`
(`:15597`, `:19257`), never hardcoded.

## 2. What a worker `run_gate` and a merge gate on the same repo could collide on

| resource | isolated today? | evidence |
|---|---|---|
| test-lane `LOOM_PORT` | Yes — OS-assigned `:0` reservation, genuinely unique per spawn | `scripts/test-daemon.mjs:1383-1384` `reserveLanePort` → `test/_hermetic-port.mjs:44-53` `reserveHermeticPort`. Replaced the old fixed `4400+lane` scheme, which **was a confirmed real cross-process collision** — `427590d2`'s 2026-09-23 reading: a codex MCP submit was lost because another run's lane-0 test held port 4400 concurrently. |
| per-test `LOOM_HOME` | Yes — `fs.mkdtempSync`, kernel-guaranteed-unique | `test/_tmp-fixture.mjs:213-215` `mkdtempManaged`, `:245-246` `useOwnLoomHome` |
| codex-real-spawn cross-process lock | Best-effort, NOT a true mutex (this card's own stated HIGH RISK) | `_codex-real-spawn-lock.mjs`'s own header; `docs/decisions/e4701333-*.md` |
| production `WORKTREES_DIR` (real `~/.loom-worktrees`) | Guarded, with 2 named gaps | `createworktree-loom-home-guard.mjs`: only catches a DIRECT `createWorktree(` call lacking a hermetic-home guard; explicitly does not check the VALUE (gap i) or catch an INDIRECT call through service/merge code (gap ii — ~207/1112 files excluded from its own trigger by design) |
| fixed (non-unique) `os.tmpdir()` fixture paths generally | Partially — mechanically guarded only for the easy sub-case | `fixed-tmpdir-literal-guard.mjs` (new, card `a6b1c4c7`, now in `STATIC_GUARD_REPO_PATHS`, `worktrees.ts:3734`). **Its own header states it structurally cannot see "a parameterized helper called with a hardcoded literal argument at one call site" — the EXACT shape that caused a real, dated incident** (two concurrent worker `run_gate`s red'd via `merge-commit-kill-confirm.mjs`'s fixed paths, 2026-10-01, card `a6b1c4c7`). The card's own DoD asked for a corpus-wide sweep for this shape; only the one incident file was fixed plus a mechanical guard for the narrower zero-interpolation sub-case — the sweep for the actual (parameterized) shape reads as manual-judgment-only, not completed by a checkable pass. |
| daemon-spawning integration tests' own `.listen()` (`mgmt-surface.mjs`, `platform-scope.mjs`, `profiles-rest.mjs`, `scheduler.mjs`) | No — open, deliberately deferred | `docs/decisions/fc53ea74-*.md` "Port-scheme fix" section; carded separately as `2365cc22` (low priority, not fixed) |
| worktree-level exclusivity (a worker's own worktree vs. its own merge) | Yes, untouched by this card | `gate-semaphore.ts` `worktreeFree` (`:412-415`) — a separate mechanism from `mergeRepoFree`; narrowing the latter does not affect it |
| queued-merge starvation by back-to-back worker admissions | Fixed, conditional on the barrier staying | `eb491463` (`mergeWaitingOnRepo`, `gate-semaphore.ts:440-451`) — its own "Do not" #1 warns dropping/narrowing it reopens 87+min starvation |
| a broad worktree-GC sweep racing a *different* worker's live `run_gate` | Not found to exist as a live-gate-time hazard | `gcWorktreeDir` takes an explicit `worktreePath` (the merge's own worktree being finalized), not a directory-wide scan; the only broader sweep located is a boot-time reconcile pass, not a concurrent-gate-time one. **Not exhaustively verified beyond this** — a deeper audit of every periodic/triggered worktree scan was out of scope for this evidence pass. |
| shared `.git` common-dir writes (refs/config/attributes) between a worker's test suite and a concurrent merge's real git writes | Not directly measured this round | `canonical-git-isolation.mjs` (the test built to police exactly this threat class) exercises a throwaway fixture repo it creates itself, never the live project repo, so it doesn't cover this path. Whether any hermetic test performs a REAL write against the live project's shared common `.git` (as opposed to a fixture repo) was not exhaustively checked. |

## 3. `427590d2` corpus — what the overlapping-run data actually shows

- **Richest data point (2026-09-10 direct measurement):** of 155 run-summary rows (150 gate-driven) with
  a codex-family phase, 13 rows had their phase window genuinely OVERLAP another run's family phase; of
  those, **3 failed (23.1%)**. Of the 142 non-overlapping rows, **43 failed (30.3%)**. Overlapping runs
  failed *less* often, not more. n=13 is small — a true ~30% base rate predicts ~4/13, so 3/13 is within
  noise (not a refutation) — but it gives **zero support** for cross-gate lock contention driving the
  family's failure rate.
- The one specimen that originally motivated the concurrency hypothesis (merge `9bde96e3` vs. worker
  `run_gate` `f1981fc2`, both concurrently admitted at cap=2) showed **no actual phase overlap** on direct
  timestamp comparison — `f1981fc2`'s codex phase had already finished ~4 minutes before `9bde96e3`'s began.
- The family's two diagnosed dominant mechanisms (A: trust-dialog CSI-cursor rendering miss, fixed by
  `c0933e57`; B: trust-block teardown silently skipped, card `baa3435a`) are both unrelated to cross-gate
  concurrency.
- A genuinely CONFIRMED cross-process mechanism *was* found in this corpus: the old fixed `4400+lane` port
  scheme (2026-09-23 reading). It is now closed by `fc53ea74` (§2 above).
- As recently as **2026-10-01/02** (the same week `fc53ea74` merged), three fresh, structurally DIFFERENT,
  still-unexplained codex-family failures landed across 3 separate gates within ~2 hours, each under
  2-concurrent-gates conditions: a boot-ready timeout, a missing-output-file, and an exit-code/printed-
  verdict mismatch. None has a confirmed mechanism; a shared-teardown-path hypothesis is open, unconfirmed.
- **Net:** concurrency-as-lock-contention is not supported as the ~31% baseline's driver. But the family's
  baseline flake rate is unexplained and still visibly active in the most recent data, with multiple
  distinct, unresolved shapes — this is not a solved, quiet corpus.

## 4. Recommendation: don't build this round; hold for two cheap things first

1. The `fixed-tmpdir-literal-guard` explicitly cannot catch the exact shape that caused the real
   `a6b1c4c7` incident (a parameterized fixture-path helper called with a hardcoded literal at one call
   site). The card's own DoD asked for a corpus sweep for that shape; it reads as not mechanically
   completed. A manual audit pass is warranted before adding a new concurrency axis (merge+worker on one
   repo) that increases how often a latent bug of exactly this kind gets exercised — `a6b1c4c7`'s own
   incident only manifested "for the first time" once worker-vs-worker concurrency became common; widening
   to merge+worker is the same kind of exposure increase again.
2. The codex-real-spawn family has 3 fresh, unexplained failure shapes from 2026-10-01/02. A few days of
   post-`fc53ea74` data (ports now fixed) would show whether the baseline rate actually drops before adding
   more concurrent-gate surface area on top of it — this costs nothing and is already accruing passively.

If/when built, per the card's own DoD: preserve `eb491463`'s queued-merge barrier exactly (narrowing
`mergeRepoFree` further must not touch `mergeWaitingOnRepo`), keep `gate-semaphore-concurrency.mjs` and
`gate-merge-starvation.mjs` green, add the specified worker+merge concurrency test, run a real soak of
several concurrent gates, and route through Code Review (mandatory, per the card).

**Residual risk, stated plainly:** the codex lock remains a best-effort `os.tmpdir()` file lock, not a
true cross-process mutex. Its own historical worst case (card `14e6cf5f`) was a measured, intermittent
(~2/36 trials) full-boot stall under genuinely concurrent real codex spawns. Narrowing `mergeRepoFree`
increases the FREQUENCY of exactly the condition that worst case needs — two real-codex-spawning gate
processes running at once on the same repo — even though no analysis to date shows it dominating the
current baseline. That absence of evidence comes from a window where true concurrent overlap was itself
rare (n=13); a widened exclusion would, by construction, make the untested regime (frequent overlap) the
common case instead of the rare one.
