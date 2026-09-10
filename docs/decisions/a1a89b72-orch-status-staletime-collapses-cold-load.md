# a1a89b72 — orchStatusQuery's staleTime collapses a cold load to one request, not two

Source: commit a1a89b726, no board card

## Narrative

`ORCH_STATUS_STALE_MS` (`packages/web/src/lib/api.ts`) is how long a fetched orchestration status counts as FRESH client-side. While the `/ws/fleet` socket is up, this cache is kept live by C5's `status` change-feed, so a mount-time refetch is pure duplication; while the socket is down, `FleetSocketProvider`'s fallback poll already refreshes it on the same 10s cadence.

The value is load-bearing, not just a nicety — it is what makes a cold load cost ONE request rather than two. `FleetSocketProvider`'s connect-time seed and the consumers' own mount fetch observe this same cache entry, and they collapse by one of two mechanisms depending on which happens first:

1. **Seed while the mount fetch is still IN FLIGHT** — react-query returns the in-flight promise, and this window is irrelevant.
2. **Seed AFTER the mount fetch resolved** — the collapse then depends ENTIRELY on the cached entry still being fresh, i.e. on this window.

Measured in-page on one clock (n=5, local e2e fixture): mechanism 1 wins every time, but only by 0.9-9.6ms. That is a race, not a guarantee — a loaded CI runner can invert it. A forced-inversion control confirmed mechanism 2 is real and that this window is what covers it: with the seed deliberately delayed past the mount fetch, 10s here yields 1 request, 0 here yields 2. So the margin (10s) is roughly 1000x the observed race spread (0.9-9.6ms), and the failure this window protects against is bounded anyway — a socket opening more than 10s after the seed fetch would break the feed's own liveness assertions long before this window lapsed.

## Do not

- Do not raise `ORCH_STATUS_STALE_MS` to buy more margin — the existing ~1000x margin over the measured race spread is already generous, and a larger value only delays picking up a genuinely stale status.
- Do not drop it to 0 assuming ordering alone carries the collapse — mechanism 2 (seed after mount fetch resolves) is real and measured, not hypothetical, and a 0 window reopens the duplicate-request case it exists to prevent.

## Source

Inline comment in `packages/web/src/lib/api.ts` (`ORCH_STATUS_STALE_MS`'s doc comment, lines 1176-1193 as of commit `a1a89b726`). Introduced by that commit's own worker sub-commit "docs(web): record why orchStatusQuery's staleTime is load-bearing." Extracted by card `56d6cc53` (tranche 1); wording condensed, no substantive detail dropped.
