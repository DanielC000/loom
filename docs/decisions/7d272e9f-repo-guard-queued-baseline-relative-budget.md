# 7d272e9f — scenario (A)'s "repo guard queued" precondition needs a baseline-relative budget, not a bare fixed one

CR `543456ed` (review of `d4b25feb`) measured `merge-quarantine-reunion-service.mjs` scenario (A) ("repo
guard queued") arriving at ~11.8s against its old fixed 10s budget, 3/3 runs — and reproduced the SAME
timing swapping main's old `merge-quarantine.js` into dist. Not a `d4b25feb` regression: the pre-wait
setup on this exact path (before `confirmWorkerMerge` ever reaches the wait this scenario polls for) is
unchanged by that branch.

## What actually runs before the wait

Real `git` child processes, sequentially, on the (A) path (docs-only branch, no `owedBase`):
`findLandedSquashCommit` (1 spawn — no trailer match, returns immediately), `mergeMainIntoWorktree`'s
early-ancestor-shortcut (2 — `rev-parse HEAD` + `merge-base`, main hasn't moved yet at this point so it
returns before ever running a real merge), `preWaitBranchHead`'s `resolveGitRef` (1), and
`isInertMergeDiff` (up to 7 — one `changedPathsBetween` diff, plus one `git grep` per
`INERT_MERGE_PATH_PREFIXES` entry (1: `"docs/"`) and per `INERT_MERGE_EXACT_PATHS` entry (5: `README.md`,
`CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`), run to completion on this
fixture since none of those tokens are referenced elsewhere in the tiny test repo). That's ~11 real
`git` spawns before the "queued" state this test observes even exists — each pays a real, variable
`CreateProcess`-class cost that balloons under host contention unrelated to the code under test.

## Measurement (card 7d272e9f)

- **Quiet host** (16-core, no induced load): N=10 runs, delta (test-holder guard acquired → confirmWorkerMerge's own wait begins) 1530-1944ms. Never close to the old 10s budget.
- **3 tracked CPU spinners** (the DoD's prescribed load): N=5, delta 1530-1712ms — indistinguishable from quiet. This host has 16 cores; 3 busy-loops don't dent it. Confirms the DoD's load recipe alone does not reproduce the CR's host condition here — that's a finding, not a gap: it means the slowdown is real but host-dependent, not reproducible with this host's spare capacity.
- **20 tracked CPU spinners** (deliberately saturating all 16 cores, ~125% oversubscription, run separately to actually find the knee): N=10 across two batches, delta 11050-18158ms — comfortably **exceeding** the old fixed 10000ms budget on every run. This is the live reproduction: the old fixed budget would have false-FAILed reliably under genuine host contention, matching (and exceeding) the CR's ~11.8s report. Confirms: real, load-sensitive, not a code regression.

## The fix

`measureBaselineGitSpawnMs(repoPath)` samples the real cost of a single `git rev-parse HEAD` spawn in
the scenario's own fixture repo, right before `confirmWorkerMerge` fires — a fair, content-free, live
proxy for "how expensive is spawning a git process on this host right now," mirroring the baseline-
relative bound card `758486bc` built for the event-loop probe
(`emit-compare-gate-test-importers.mjs` scenario I: `bound = max(FLOOR, MULTIPLIER × baseline)`, there
sampled via an isolated child process since that check also needed the sampler off its own event loop;
this check has no such concern — the whole file is linear — so it samples in-process via `execSync`).

`budget = max(10_000ms, 4 × 12 × baselineMs)` — spawn-count estimate 12 (the ~11 real spawns above,
rounded up with a little margin; see the inline `@decision 7d272e9f` comment at its declaration — do not
shrink it without re-deriving the real spawn count on that path) times a 4× safety multiplier.

## Do not

- Do not set the multiplier back to 2×: measured directly (two batches under the same 20-spinner load) —
  a 5-sample baseline draw landing in a brief lull produced a floored 10_000ms budget while the REAL wait
  reached ~13.5s on the same run, a live false-FAIL. The sample count was raised 5→10 and the multiplier
  2→4 together to close this; a future change to either number must re-run the same 20-spinner
  measurement before trusting a smaller value.
- Do not revert to a bare fixed-ms budget for this scenario — it is exactly what caused the original CR
  finding, and the pre-wait git-spawn count on this path (~11 spawns) is not going to shrink on its own.
- Do not read this fix as a claim the old 10s number was "wrong" on a quiet host — it was never close to
  binding there (max observed 1944ms across 10 quiet runs); the floor stays 10_000ms for exactly that
  case, unchanged.
