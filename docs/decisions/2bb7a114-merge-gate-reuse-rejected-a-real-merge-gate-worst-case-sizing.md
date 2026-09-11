# 2bb7a114 — `merge-gate-reuse.mjs`'s override is sized off a real production rejection, not just the median

## Narrative

`merge-gate-reuse.mjs` rejected an innocent card's merge gate with `exit timeout` in production,
despite being the HEAVIEST of its family by real git-work volume (50 git invocations, 52
`createWorktree`/`confirmWorkerMerge` calls). Measured 7/7 standalone runs on a quiet host: 6
clustered at 52-58s, but one — immediately after a fresh build — spiked to 130s, already past the
blanket 120s ceiling even standalone, before any concurrent-gate contention is added on top.

The `TEST_TIMEOUT_OVERRIDES` entry for this file is `360_000` — roughly 6.7x the steady 52-58s
median, or roughly 2.8x the observed 130s outlier.

This is one of several specimens behind the general per-test-override design recorded under card
`cc595ca7` — see that record for why a per-test override map exists at all, rather than a raised
blanket ceiling.

## Do not

- Do not dismiss the 130s post-fresh-build outlier as noise — it is a reproduced real cost (the
  actual cause of the production `exit timeout` rejection this card fixed), not a flake to average
  away when sizing this override.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, at the `TEST_TIMEOUT_OVERRIDES`
definition (originally ~lines 839-843, within the block ~830-849). Card `2bb7a114`. Related:
`cc595ca7` (the umbrella design decision this specimen supports).
