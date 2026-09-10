# d1aee5f1 — a retained terminal view, so a settled op is briefly observable after evict-on-settle

## Narrative

Evict-on-settle (see card 27ea069e for the dead-owner exception) is right for the `entries` map — `attach()`'s own dedup/idempotency depends on a `key` going back to "nothing running" the instant it settles, or a retry would dedup-attach to a stale terminal result instead of starting fresh. But it means a settled op's terminal state is essentially never observable via `peek()` — for the Board, that meant the merged/rejected/failed hairline fill had at most one poll's worth of a chance to render before reverting. `opts.retainMs` is opt-in per `attach()` call: at settle time, once the identity-guarded delete from `entries` happens (same guard, same place), the settled view is ALSO written into a separate `retained` map (keyed the same) with an expiry — `peek()` falls back to it (lazily self-evicting once expired) so a viewer sees the terminal state for a brief window instead of it vanishing the instant the gate settles.

## Do not

- Do not read a settled op's absence from `peek()` as "nothing ever ran" — evict-on-settle means a `key` with no `retainMs` opt-in reverts to nothing shown the instant it settles, by design.

## Source

Inline comment in `packages/daemon/src/orchestration/pending-ops.ts` (the class doc's "RETAINED TERMINAL VIEW" paragraph, opening section): lines 252-261, as of commit `507e966583ff18068f5e7e56942acfe67001ee94`. Relocated by card `a1491009` (tranche 1); no wording changed beyond joining wrapped source lines into a flowing paragraph and stripping `*` comment markers.
