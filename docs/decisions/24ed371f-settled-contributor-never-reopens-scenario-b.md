# 24ed371f — a settled contributor's own clear never re-opens scenario B against its still-quarantined host

From card `3b1944b6`'s own sixth Code Review (reviewer `ff0f9dca`, `q2.mjs`): a registry-bound subdirectory
`S` (no `.git`) raises while its key collapses onto `R`'s union, so `S` is recorded in `R`'s
`contributorRepoPaths` with its own token. When `S`'s merge settles (`clearMergeQuarantineByToken` releases
`S`'s token: `tokens` 2 → 1), `S` STAYS listed in `R`'s `contributorRepoPaths` — `clearMergeQuarantineByToken`
never touches membership, only tokens. A later `/clear(S)` therefore takes `clearMergeQuarantine`'s existing
contributor-reduce arm (`reduceForeignUnionContributor`, an idempotent no-op once already reduced), never
`abccee85`'s own scenario-B ancestor-collapse lift — the fallback a never-contributor `S` would get.

## The question and the ruling

(a) should a token settle drop the settled identity out of `contributorRepoPaths` so scenario B becomes
reachable again, or (b) is the sticky refuse (routing back to the reduce arm, never scenario B) the
intended behavior? **Ruling: (b).**

## The proof

`clearActiveEntryTokenAtKey` (merge-quarantine.ts ~:4134-4160) deletes the WHOLE entry — file and
`contributorRepoPaths` included — the instant its own `tokens` array empties. So a union that still
EXISTS after one contributor's own token settles always holds someone ELSE's live token (the host's own,
or another contributor's). "This contributor now holds zero remaining tokens" can therefore never, by
itself, prove scenario B's unconditional full lift is safe for that union: re-enabling it would recreate
`3b1944b6`'s own original wrong release (`liftedRepoPaths:[sub, R]`) the next time anyone calls
`/clear(identity)` — just reached via a settle instead of a stale key, rather than fixing anything.

A safe-but-inert variant exists (eagerly calling the existing `reduceForeignUnionContributor` at settle
time instead of waiting for the first post-settle `/clear` call to do it lazily) but was rejected: it adds
a new write site to this trust boundary for zero observable payoff — `isHostOfContributor`
(`stillQuarantinedReason`) already reads `contributorRepoPaths` OR `reducedContributorRepoPaths`
identically, so the disclosure text is the same either way, and the lazy reduce already fires correctly
on the first real `/clear(S)` call.

## Do not

- Do not re-enable `clearMergeQuarantine`'s scenario-B ancestor-collapse clear (merge-quarantine.ts
  ~:5552-5556) for an identity on the basis of its own token count — a union's continued existence after a
  settle is itself proof some other token in it is still outstanding, so "this one now holds zero" can
  never establish that a full lift by its name is safe. See "The proof" above.
- Do not prune `contributorRepoPaths`/`reducedContributorRepoPaths` membership at token-settle time
  (`clearMergeQuarantineByToken`/`clearActiveEntryTokenAtKey`) — the existing, lazy reduce via
  `clearMergeQuarantine`'s own `contributorRepoPaths?.some(...)` / `reducedContributorRepoPaths?.includes(...)`
  branches already closes this safely the first time anyone calls `/clear` on the settled identity; an
  eager settle-time write adds a new mutation site to the trust boundary with no behavioral payoff.
- Do not read `3b1944b6`'s `reducedContributorRepoPaths` field as anything other than permanently sticky —
  see that field's own doc comment (merge-quarantine.ts ~:117-138): it exists specifically so scenario B
  can never become reachable again for an identity once it has ever been a contributor, regardless of what
  later happens to its token.

## Tests

`packages/daemon/test/merge-quarantine-24ed371f-settled-contributor-pin.mjs` — real-git (marker-only
`.git`), one process: (i) a settled contributor's own `/clear` never lifts its still-quarantined host;
(ii) a control — once the host's own last token also settles, the whole union is gone and both read
genuinely clear; (iii) a control — a genuine never-contributor still reaches scenario B, as designed. No
source changes.

## RED proof (done manually, once — never part of the committed suite)

A dist-only mutation that short-circuits both of `clearMergeQuarantine`'s reduce-arm guards
(`contributorRepoPaths?.some(...)` / `reducedContributorRepoPaths?.includes(...)`) to `if (false)`
reproduces the wrong release in a fresh child process, confirming the guard is load-bearing. Run once by
hand (`node 24ed371f-manual-red-proof.mjs <worktree-root>`), never committed — a gate runs several
parallel lanes against ONE worktree's shared `dist/`, so mutating that shared compiled file mid-run would
run broken code in a sibling lane.

```
BEFORE sha256: be5b7a34300464bdf13df5bf206a79d4f2e0d098b3ec244c0b34df6db246f7e5
AFTER (restored) sha256: be5b7a34300464bdf13df5bf206a79d4f2e0d098b3ec244c0b34df6db246f7e5
RESTORE byte-identical: true
CHILD PROCESS RESULT under the mutation:
  liftedRepoPaths: [S's own path, R's own path]   <- both lifted — the wrong release
  rStillActive: false, rOk: true                  <- R falsely reads as genuinely clear
RED CONFIRMED (R wrongly lifted by /clear(S)): true
```
