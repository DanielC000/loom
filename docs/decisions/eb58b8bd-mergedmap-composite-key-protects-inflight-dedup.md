# eb58b8bd — the merged-commit map's composite (repoPath, base) key protects the in-flight dedup race, not the settled cache's answer

## Narrative

Found by Code Review `509f716a` of `d69d4858`'s round-1 extension (card `eb58b8bd`, 2026-10-03). Round 1
widened `mergedMapCache` and `mergedMapInFlight` from a bare `repoPath` key to a composite `(repoPath,
base)` key, once boot-reconcile Pass A started requesting a scan `base` other than `"HEAD"` for the same
repo. The round-1 doc comment on `MERGED_MAP_CACHE_MAX_ENTRIES` justified this as: "a bare repoPath key
would otherwise serve one caller's base-pinned scan to a different caller still on the default `"HEAD"`
base, or vice versa" — framed as a correctness risk for `mergedMapCache` itself.

That framing is misleading. `mergedMapCache`'s own entries are keyed off `headSha`, re-derived per call
from `readBaseSha(repoPath, base)` for THAT call's own `base` — so even under a bare-repoPath cache key, a
call for `base: B` comparing its freshly-resolved `B`-sha against a cached entry whose `headSha` was
stamped for a *different* base `A` would almost always see a mismatch and correctly fall through to a
fresh scan. The freshness check already defends the cache's correctness.

What the freshness check does **not** defend is `mergedMapInFlight` (`getOrStartMergedMapScan`): that
map's dedup is a synchronous check-and-register, race-free specifically because `.get`/`.set` have no
`await` between them. Two concurrent calls for DIFFERENT bases on the SAME repoPath, under a bare-repoPath
in-flight key, would have the second call's `mergedMapInFlight.get(repoPath)` return the FIRST call's
already-registered promise — and the second call would simply `await` and receive the FIRST base's scan
result, silently wrong, with no freshness check anywhere in that path to catch it (the dedup exists
*to skip* the resolve-and-compare step for a call that joins an in-flight scan).

## Design

- Keep the composite `(repoPath, base)` key on BOTH `mergedMapCache` and `mergedMapInFlight` — removing it
  from either map independently reopens a gap, but the two maps fail differently:
  - `mergedMapInFlight` without the composite key: a correctness bug under concurrency (one base's scan
    silently served to a different base's caller, with nothing downstream positioned to catch it).
  - `mergedMapCache` without the composite key: not a correctness bug on its own (the freshness check
    saves it), but a PERFORMANCE one — two bases sharing one cache slot evict each other's entry on every
    alternating read, so a repo scanned under two different bases in steady rotation never actually gets
    cache hits, re-paying a full `git log -n 5000` walk on every call instead.
- The doc comment on `MERGED_MAP_CACHE_MAX_ENTRIES` (`packages/daemon/src/git/worktrees.ts`) now states
  both reasons explicitly and separately, rather than the single (and partially inaccurate) correctness
  framing round 1 shipped.

## Do not

- Do not "simplify" `mergedMapInFlight`'s key back to bare `repoPath` on the belief that
  `mergedMapCache`'s own sha-freshness check already covers correctness — that check runs on the SETTLED
  cache, after a scan completes; it never runs for a call that joins an in-flight promise via the dedup
  map, which is exactly the path a bare-repoPath in-flight key would miscompute.
- Do not justify the composite key to a future reader as solely a `mergedMapCache` correctness fix — cite
  both the in-flight dedup race (the one that would actually misbehave) and the cache-thrash cost (the one
  that wouldn't misbehave, just waste work) as two separate, independent reasons.

## Tests

`packages/daemon/test/boot-reconcile-orphan-sweep-watermark-branch-pin.mjs` scenario (E) exercises the
composite key SEQUENTIALLY (two calls, one per base, neither overlapping in time) — real behavior, but it
cannot exercise the in-flight dedup race itself, since by the time either call reaches
`getOrStartMergedMapScan` the other has already settled and cleared its in-flight entry. Scenario (E2)
adds a CONCURRENT pair (`Promise.all` over the same two bases on a fresh, not-yet-cached repo/branch) that
does exercise the race window. Verified RED by temporarily re-keying `mergedMapInFlight`'s cache-key
function (`mergedMapCacheKey`) on bare `repoPath` alone, rebuilding, and re-running (E2): the concurrent
`base:"HEAD"` and `base:<mainline ref>` calls then collided on one in-flight promise and (E2)'s "disagree"
assertion failed, confirming the composite in-flight key — not merely the cache's freshness check — is
what the race actually depends on. Reverted and re-confirmed green afterward.
