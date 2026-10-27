# 3a460d4a — two undefined verdict identities never dedupe-hit

`PendingOpRegistry.attach()`'s until-superseded cache (decision `1555e361`) compared a re-call's
`opts.verdictIdentity` against the identity recorded at the cached verdict's own settle time with a bare
`priorVerdict.identity === opts?.verdictIdentity`. Since `verdictIdentity` is `string | undefined`, this
let two genuinely UNDEFINED identities compare equal and serve a cache hit — even with `identityOptional`
false, i.e. on a call that explicitly did NOT ask for the comparison to be skipped.

## Why this was reachable (not merely a type-theoretic gap)

Both real production callers — `mergeBatchTracked` and `confirmWorkerMergeTracked`, the only two call
sites anywhere in `packages/daemon/src` that pass `retainVerdictUntilSuperseded: true` — resolve
`verdictIdentity` fresh on every call (branch-tip shas, for batch: every chosen candidate's; for solo: the
one worker's branch tip + mainline tip) and only fall back to `undefined` when that resolution genuinely
FAILS (a thrown/unresolvable git read) — never because the caller doesn't care about identity. Both
carry an explicit comment at the catch site: "fail-safe: undefined identity never dedupe-hits". Decision
`1555e361`'s own "Do not" is unambiguous on the same point: "Do not set `identityOptional` merely because
a live worktree's git ref failed to resolve — that's usually transient and must still fail closed to a
fresh mint." The bare `===` comparison achieved exactly the effect that "Do not" forbids, through a
different door — without either caller ever setting `identityOptional`.

Concretely: a candidate/branch's identity fails to resolve on call N (undefined, stored); the same or a
different candidate's identity fails to resolve again on a LATER call N+1 (undefined again) while
`identityOptional` is false on THAT call — the two `undefined`s compared equal and replayed N's stale
verdict instead of minting a fresh op, with no proof the underlying state hadn't changed in between.

**This is NOT card `d240fceb`'s T2 scenario** — a Code Review correction caught this record's own earlier
draft citing it as one. Re-read against d240fceb's record (lines 35-41): T2's actual replay-hit happens on
the batch's THIRD re-fire, by which point `batchAlreadyFinished` (and so `identityOptional`) has become
`true` — the replay goes through the `identityOptional` BYPASS, a different, already-intentional mechanism
this card does not touch. T2's SECOND call (the one that writes `identity: undefined` into the cache) does
have `identityOptional: false`, but writing an undefined identity is not itself the defect — the defect is
a LATER call with `identityOptional: false` comparing its own undefined identity against that stored one
and matching. d240fceb's own "Do not" already says the two cards are independent and both should land; this
card's own mechanism (the bare `===` comparison) is demonstrated instead by the hermetic repro in "Tests"
below, which drives `PendingOpRegistry.attach()` directly rather than through any batch scenario.

The ONLY place that treated "both sides undefined ⇒ hit" as *intentional* was non-production: a doc
comment on `attach()`'s own `opts.verdictIdentity`/`opts.identityOptional` JSDoc ("Omit it and the dedupe
stays identity-agnostic... exactly as `retainVerdictUntilSuperseded` behaved before this opt existed")
and a matching unit test (`pending-ops-registry.mjs`, the "(identity omitted, backward compat)" block),
both modeling a hypothetical caller that never passes `verdictIdentity` at all. No real caller has that
shape — both always attempt resolution and only fall back to `undefined` on failure, a semantically
different situation from "I don't track identity."

## The fix

`attach()`'s comparison now requires the STORED identity to be a defined string before comparing:
`opts?.identityOptional || (priorVerdict.identity !== undefined && priorVerdict.identity === opts?.verdictIdentity)`.
`identityOptional` is unchanged and remains the only sanctioned way to skip the comparison outright — both
real callers already set it, explicitly, for their own already-finished/batch-finished case (where
identity divergence is structurally impossible, not merely unresolved).

## Cost: a persistently-unresolvable identity now always mints fresh

Before this fix, a caller whose identity resolution kept failing (the fault never clearing) got a FREE
ride on the first failure's cached verdict for every subsequent re-call, forever (within process
lifetime). After this fix, EVERY re-call with an unresolved identity and `identityOptional` false mints a
genuinely fresh op — for `confirmWorkerMergeTracked`/`mergeBatchTracked`, a real merge gate run. This is
the correct fail-closed behavior (exactly what both callers' own "fail-safe" comments already claimed
happened), not a regression: the old behavior was unconditionally unsafe, trading a cache hit for no
actual proof of sameness.

This cost is bounded — never an UNBOUNDED loop — though one caller IS a loop, corrected below:
- `worker_merge_confirm` and `merge_batch` (the two MCP tools reaching these methods) are called once per
  invocation — there is no automatic retry/poll loop anywhere in the daemon that re-invokes `attach()` on
  these keys on a timer.
- **Corrected (Code Review):** `confirmWorkerMergeUntilSettled` (the REST route behind
  `gateway/server.ts`'s merge-confirm handler) loops `while (!r.settled && Date.now() < deadline)`, calling
  `confirmWorkerMergeTracked` again each iteration — a genuinely NEW call, not merely re-awaiting the same
  one. While the underlying op is still RUNNING, that new call attaches to it (no re-mint). But if the op
  SETTLES in the gap between one iteration's return and the next iteration's call, the entry is gone by
  the time the next iteration calls `attach()` — that next call is a genuinely fresh attach, which
  re-resolves `verdictIdentity` from scratch and can mint a real second gate run if the freshly-resolved
  identity doesn't match what just settled. This is NOT a regression this card introduces — the SAME
  re-mint-on-mismatch shape already existed for two DEFINED, differing identities before this card; this
  card only changes what counts as a mismatch (an unresolved identity now mismatches too, where it used to
  falsely match). Either way it is bounded by `deadline` (`gateCommandTimeoutMs * 6` or the platform
  default), the same ceiling that already bounds this loop's worst case — not an unbounded loop.
- `mergeBatchTracked`'s own `runFallback` calls `confirmWorkerMergeTracked` once per fallback candidate,
  within one batch invocation — not a repeating loop across separate batch calls.
- `reconcileOrphanedGateOps`/`reconcileUnsurfacedPendingGateOps` (boot-time sweeps) never call
  `confirmWorkerMergeTracked`/`mergeBatchTracked` at all — they push an advisory nudge telling a human/
  manager to re-run `worker_merge_confirm` by hand; the re-call, if any, is still manager-initiated.
- Nothing else in `packages/daemon/src` passes `retainVerdictUntilSuperseded: true` (verified by a
  repo-wide grep for the literal).

So the worst case is: a manager that keeps re-confirming/re-firing while a git fault persists pays for a
real gate run on every one of ITS OWN re-calls, bounded by how often it chooses to retry; and, separately,
a single REST merge-confirm request can itself pay for more than one real gate run across its own
internal poll loop, bounded by that loop's own `deadline`. Neither is an automatic background loop that
outlives its own triggering call.

## The TTL'd `retained` map is not a second door

`usableRetainedHit` (the TTL `retained`-map read) never consults identity at all — by design, it is the
pre-identity mechanism (decision `33172f01`) that predates `verdictIdentity`/`retainVerdictUntilSuperseded`
and remains the correct, identity-blind behavior for a caller that never opts into
`retainVerdictUntilSuperseded` at all (see `pending-ops-registry.mjs`'s "(ch2)" test, which deliberately
omits `retainVerdictUntilSuperseded` to exercise exactly that path).

For a key that DOES opt into `retainVerdictUntilSuperseded` (both real callers), the `retained` map's own
identity-blind hit is structurally unreachable once the until-superseded check has a verdict to compare
against, for two independent reasons:

1. `untilSupersededVerdicts` and `retained` are written together, synchronously, on every cacheable settle
   (no `await` between the two `.set()`/`retain()` calls) — so by the time ANY second `attach()` call can
   observe either map, both are already populated in lockstep. The until-superseded check runs FIRST; on a
   miss (which an unresolvable/mismatched identity now is) it sets `untilSupersededMiss`, which forces
   `retainedHit` to `undefined` too (`(untilSupersededMiss || opts?.bypassRetained) ? undefined : ...`) —
   the mismatch never falls through to the TTL map.
2. Independently, `usableRetainedHit` itself refuses any entry whose classified `outcome` is in
   `NEVER_CACHED_OUTCOMES`, regardless of identity — the one shape where `retained` could be populated
   while `untilSupersededVerdicts` is NOT (a never-cached outcome skips the until-superseded write but not
   the TTL one) is exactly the shape `usableRetainedHit` excludes on its own.

So there is no window, before or after this fix, where an unresolvable/mismatched identity could reach a
stale verdict via the TTL `retained` map for a `retainVerdictUntilSuperseded` key. This is covered by a
dedicated test (see "Tests" below) rather than left as an unverified structural claim.

## Do not

- Do not let two `undefined` identities compare equal in `attach()`'s until-superseded check — an
  unresolvable identity must fail closed to a fresh mint, same as a genuine mismatch.
- Do not add `identityOptional` to a caller merely because its identity resolution can fail — that is
  exactly the forbidden shortcut decision `1555e361`'s own "Do not" already names; `identityOptional` is
  for a context where divergence is structurally impossible, never for "couldn't resolve it this time".
- Do not read the TTL'd `retained` map's own identity-blindness as a residual gap for a
  `retainVerdictUntilSuperseded` key — it is structurally unreachable there (see above), not merely
  believed safe; it stays identity-blind ONLY because it is the pre-identity mechanism for a caller that
  never opts into `retainVerdictUntilSuperseded` at all.
- Do not restore the "(identity omitted, backward compat)" framing in `pending-ops-registry.mjs` — no real
  caller has that shape, and both real callers' own comments contradict it.

## A distinct `freshMint.reason`, not a relabeled mismatch (Code Review)

The registry's `FreshMintInfo.reason` gains `"identity-unresolved"`, DISTINCT from `"identity-mismatch"`:
the latter now means (post-fix) two DEFINED, different identities were actually compared; the former
means one or both sides never resolved at all. `mcp/orchestration.ts`'s `freshMintNote` had a single
`"identity-mismatch"` branch whose fallback text ("an earlier state" / "a different commit") would have
silently reused the SAME wording for an unresolved identity — falsely implying a commit was confirmed to
have moved when nothing was ever confirmed. The split gives each case its own honest wording, covering
both the fully-unresolved (both sides undefined) and mixed (prior defined, current unresolved — or vice
versa) variants.

## Tests

`packages/daemon/test/pending-ops-registry.mjs`:
- The "(identity omitted, backward compat)" block (`id4`) is flipped: two `undefined`-identity calls, both
  with `identityOptional:false`, now mint TWO real ops (a miss), not one, announced as
  `identity-unresolved` — proved RED against the pre-fix comparison, GREEN after.
- `id5` mirrors the hermetic repro used in this card's own investigation (ok:true arm, long-lived): two
  calls with `retainVerdictUntilSuperseded:true`, `identityOptional:false`, `verdictIdentity:undefined` on
  both — asserts a fresh mint, `freshMint?.reason === "identity-unresolved"`, and that
  `identityOptional:true` still dedupe-hits the identical shape (the one sanctioned bypass, unaffected by
  this fix).
- `id6` proves the TTL `retained` map is not a second door on the ok:true arm: a second call landing
  WITHIN the TTL window, with an unresolvable identity, still mints fresh rather than being served from
  `retained` — `cacheHit` absent, `freshMint` present.
- `id7` covers the MIXED variant: a prior verdict under a DEFINED identity, this call's own resolution
  unresolved — still a miss, still `identity-unresolved`, carrying the prior verdict's real identity as
  `priorIdentity` (never silently dropped).
- `id8`/`id9` (Code Review follow-up) mirror `id5`/`id6` on the ok:false (THROWN) settle arm — the thrown
  branch has its OWN `untilSupersededVerdicts.set()` write and its own identity source
  (`opts.verdictIdentity` directly, since there is no settled value to derive one from), so it needed its
  own proof rather than being assumed covered by the ok:true case.
- `cv1`/`cv2` (card `171297dc`'s own cancel-not-cached proofs) now pass a DEFINED, consistent
  `verdictIdentity` instead of omitting it — Code Review found that omitting it made these proofs
  unfalsifiable against this card's own fix: with both sides undefined, the fix alone now forces a fresh
  mint regardless of whether the `NEVER_CACHED_OUTCOMES` veto on the write still works, so a broken veto
  could no longer turn them RED. A defined, matching identity restores that: verified directly (not merely
  argued) by two temporary, uncommitted mutations, each rebuilt and run, each confirmed to turn `cv1`/`cv2`
  RED, then reverted and rebuilt back to GREEN — (M1) dropping the `NEVER_CACHED_OUTCOMES` veto on the
  ok:true until-superseded write (`pending-ops.ts`'s `if (opts?.retainVerdictUntilSuperseded && ...)`
  line), and (M2) removing `"cancelled"` from `NEVER_CACHED_OUTCOMES` itself.
