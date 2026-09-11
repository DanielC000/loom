# 6436bd5a — `gate-timeout-circuit-breaker.mjs`'s override cost is real git work, not a hang

## Narrative

`gate-timeout-circuit-breaker.mjs` timed out under concurrent gate load but measured ~50-52s
standalone on a quiet host, 3/3 runs, with every stubbed gate call resolving instantly. Its cost is
entirely the real `confirmWorkerMerge` union-merges + `createWorktree` + commits across its 8
blocks — not a hang.

The `TEST_TIMEOUT_OVERRIDES` entry for this file is `300_000` — roughly 6x headroom over the
measured ~50-52s standalone cost, sized for 8 blocks of real union-merges/createWorktree/commits
running under concurrent gate contention rather than the quiet-host measurement alone.

This is one of several specimens behind the general per-test-override design recorded under card
`cc595ca7` — see that record for why a per-test override map exists at all, rather than a raised
blanket ceiling.

## Do not

- Do not read a timeout on this test under concurrent gate load as evidence of a hang — its cost is
  proven real (every stubbed gate call resolves instantly; the time goes into real git/merge work).

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, at the `TEST_TIMEOUT_OVERRIDES`
definition (originally ~line 836, within the block ~830-849). Card `6436bd5a`. Related: `cc595ca7`
(the umbrella design decision this specimen supports).
