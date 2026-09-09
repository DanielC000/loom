# e50600d2 — Keep `run_gate` as every worker's DoD self-check; relieve its cost by reuse, not by removing the gate

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
  for the gate once instead of twice (observed ~35 minutes of gate time saved for one case, per the
  tool's own cost-model text).
- Harder / accepted: reuse is forfeited the moment the branch falls behind main between self-check and
  merge — **not** by a busy or contended gate lane, which does not by itself defeat reuse (measured: reuse
  still fired while a sibling merge gate held the other lane slot for the entire run).
- The targeted-test-file default — not `run_gate` — stays the common case for an ordinary, narrowly-scoped
  change; `run_gate` is an escalation judgement call, never a blanket requirement on every task.

## Evidence

- READ-IN-SOURCE: `CLAUDE.md` line 30 ("Worker DoD test-gate" bullet, current `main`, read via this
  worktree's checkout) states the targeted-test default + `run_gate` escalation verbatim.
- READ-IN-SOURCE: the `run_gate` MCP tool's own live description (read this session, 2026-09-09) states
  the reuse cost model, the `e50600d2`/`b3c04b89` card ids, the `freshBehindMain === 0` forfeit condition,
  and the "a saturated lane does NOT by itself defeat reuse" measurement verbatim.
- READ-IN-SOURCE: project memory note `gate-cap-is-2-is-owner-decision-never-change-silently` (this
  project's shared memory, read at this session's kickoff) records the 2026-07-15 unpinned-gate-spike
  incident that motivated admitting worker self-checks through the shared semaphore in the first place.
- No inline source anchor added: the natural sites for this decision (`run_gate`'s own registration under
  `packages/daemon/src/mcp/**`, and the merge-time reuse check in `git/worktrees.ts`/`sessions/service.ts`)
  are all held by concurrent workers (cards `40f4cae9`, `8ea85329`, `bed49000`) for the duration of this
  task; reported as a remainder.
