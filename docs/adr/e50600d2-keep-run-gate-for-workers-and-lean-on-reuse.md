# e50600d2 — Keep `run_gate` as every worker's DoD self-check; relieve its cost by reuse, not by removing the gate

⚠️ Spans two decisions, both anchored in `sessions/service.ts`: this ADR (why `run_gate` stays mandatory,
relieved by reuse not removal), and `LastWorkerGateCheck` (the record that makes the reuse possible — see
the section at the end). `resolveRecord` serves exactly one file per id, so a second `e50600d2-*.md` file
would have been silently unreachable; folded here (card `6de8956e`).

## Status

accepted

## Context

A worker's build/test self-check could in principle be removed or made optional to cut shared gate load,
or it could stay mandatory and pay its cost through a cheaper mechanism instead. Running a worker's own
gate via an unbounded raw-Bash recipe let total concurrent test-lanes spike uncapped across the fleet (the
2026-07-15 incident: a single unpinned gate spiked to 8 lanes and starved the host) — the reason `run_gate`
exists at all.

## Decision

`run_gate` stays the worker-self-check mechanism — not removed, not made optional by default — admitted
through the same daemon-global `GateSemaphore`/`maxConcurrentGates` budget as every merge/deploy gate. A
worker's DoD *default* is the targeted-test-file-first escalation ladder (`CLAUDE.md`'s "Worker DoD
test-gate" + the `/worker` doctrine), reaching for `run_gate` only for load-bearing, many-subsystem, or
blast-radius-unnameable changes. The lever for reducing `run_gate`'s *cost*, once invoked, is **reuse**,
not removal: a green `run_gate` self-check can be reused at merge time and skip the merge gate's own
re-run entirely when — re-derived fresh at merge time, never assumed — the branch is
`freshBehindMain === 0` against main's then-current HEAD and the worktree is clean with no drift since the
self-check settled (card `e50600d2`; corrected by card `b3c04b89` — an earlier claim that this result is
never consulted by the merge gate's own re-gate was false, and is retracted).

## Do not

- Do not disable or bypass `run_gate` for a worker's DoD self-check in favor of an unbounded raw-Bash
  recipe — that reintroduces exactly the semaphore-bypassing self-check `run_gate` exists to replace.
- Do not assume a reused green result is exempt from re-derivation — `freshBehindMain` and worktree
  cleanliness are checked fresh at merge time, every time, never carried over from the self-check.
- Do not paste a gate command or a `LOOM_GATE_TEST_CONCURRENCY=` recipe into a worker kickoff.

## Consequences

- Easier: a worker whose branch stays current with main until merge gets its self-check reused, paying
  for the gate once instead of twice (observed ~35 minutes of gate time saved for one case).
- Harder / accepted: reuse is forfeited the moment the branch falls behind main — **not** by a busy or
  contended gate lane, which does not by itself defeat reuse (measured: reuse still fired while a sibling
  merge gate held the other lane slot for the entire run).
- The targeted-test-file default — not `run_gate` — stays the common case; `run_gate` is an escalation
  judgement call, never a blanket requirement.

## Evidence

- READ-IN-SOURCE: `CLAUDE.md`'s "Worker DoD test-gate" bullet + `run_gate`'s own live tool description
  state the targeted-test default, the reuse cost model, the `e50600d2`/`b3c04b89` card ids, the
  `freshBehindMain === 0` forfeit condition, and "a saturated lane does NOT by itself defeat reuse",
  verbatim.
- READ-IN-SOURCE: project memory `gate-cap-is-2-is-owner-decision-never-change-silently` records the
  2026-07-15 unpinned-gate-spike incident that motivated admitting worker self-checks through the shared
  semaphore.
- No inline anchor added by the `92cfc09e` task that wrote this ADR: the natural sites were held by
  concurrent workers (`40f4cae9`, `8ea85329`, `bed49000`) at kickoff; reported as a remainder.
- OBSERVED (card `f42c545f`, 2026-09-09): that fence cleared. `sessions/service.ts`'s merge-time reuse
  check — `if (freshHead && !freshStamp.dirty && stampDiffers === false && freshBehindMain === 0)` — was
  unheld; a `// @decision e50600d2` anchor was added there.

## Second decision: `LastWorkerGateCheck` records a worker's most recent settled self-check for reuse

### Narrative

A worker's most recent settled `run_gate` self-check outcome (reuse a green self-check instead of
re-running the identical gate at merge). Recorded by `SessionService.runWorkerGate` on every settled
(`ran:true`) outcome, pass or fail — overwriting whatever was there before — so a later failing (or racy)
self-check at the exact same commit always supersedes an earlier green one; a stale green can never be
resurrected by this record alone.

`stamp` is the same `WorktreeGateStamp` `runWorkerGate` took at settle (equivalent to its start/admit
stamps whenever `headCurrent` is true — see `describeGateHeadCurrency`) — `confirmWorkerMerge` compares a
fresh stamp against this one via `gateStampsDiffer` to prove (or refute) the worktree is byte-identical to
what this run validated.

In-memory only, same posture as `gateStartStamps`: a restart between self-check and merge confirm loses
this record, which is fine — the reuse check fails closed on a missing record (re-runs the gate), never
on a false "nothing changed" guess.

### Do not

- Do not resurrect a stale green `LastWorkerGateCheck` after a later self-check at the same commit
  overwrote it, and do not treat a missing record (e.g. post-restart) as proof nothing changed —
  `confirmWorkerMerge` must fail closed and re-run the gate either way.

### Source

Inline comment in `sessions/service.ts` (`LastWorkerGateCheck` type's top-of-type doc), originally lines
1044-1061 as of tranche 6's HEAD. Relocated by card `5dcc1e98` (tranche 6). Folded into this pre-existing
ADR by card `6de8956e`.
