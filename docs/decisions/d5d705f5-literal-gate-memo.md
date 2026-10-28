# d5d705f5 — walk the quarantine literal gate once per token read, not once per token

From a round-6 Code Review of `0d3b64c6` (reviewer `6ef22315`): `classifyLiteralGateFromFs`
(`git/merge-quarantine.ts`) does up to `LITERAL_GATE_WALK_MAX_STEPS` (64) synchronous lstat calls on the
daemon event loop, and a single lstat of an unreachable UNC host was measured at ~1.3s — a worst case of
tens of seconds blocking the ENTIRE single-threaded daemon (every project's sessions/HTTP/WS/MCP, not
just the stuck repo). This card was INVESTIGATE-FIRST: measure the real frequency and worst case, fix
only if the measurement showed real exposure.

## Call-path census

`classifyLiteralGateFromFs` is reached only via `classifyLiteralGate` → only via
`tokenTombstonedForIdentity` → only via `readSurvivingOnDiskTokens`'s per-token `.filter()`.
`readSurvivingOnDiskTokens` has ~15 call sites in this file, spanning the raise path
(`enterMergeQuarantine`, `reconcileMarkedBasenameBeforeWrite`, `protectOccupantContentBeforeDelete`), the
clear path (`clearMergeQuarantineByKey`, `sweepOrphanLatchFileIfUnreferenced`), and boot
(`reenterMergeQuarantinesAtBootImpl`). Every top-level entrypoint into this raise/clear machinery
(`enterMergeQuarantine`, `clearMergeQuarantineByToken`/`ByKey`/`ByRecordedPath`) is invoked only from the
git-subprocess-kill-unconfirmed recovery branches (`unconfirmedKillReason(...)` in `batch-merge.ts`/
`worktrees.ts`/`writer.ts`/`vault/versioner.ts` — fires only when a git call timed out, was killed, AND
its death was inconclusive), the human-only REST `/clear`/`/clear-by-path` route, and
`reenterMergeQuarantinesAtBoot` (once per daemon boot/restart). The much hotter per-git-op check,
`assertRepoNotQuarantined` (every canonical git call via `git/bounded.ts`, plus many `sessions/
service.ts`/`batch-merge.ts`/`vault/versioner.ts`/`orchestration/restart.ts` sites), resolves via pure
in-memory map scans and never reaches this walk at all when nothing is currently quarantined — the
steady state for essentially every git op on every healthy project.

## The amplification found

Within ONE `readSurvivingOnDiskTokens` call, `recordIdentity` is identical for every token in `raw` —
`classifyLiteralGate` takes no token input at all — yet `tokenTombstonedForIdentity` recomputed the full
walk independently, once per token that reached it (every token whose `clearedTokens` entry exists but
doesn't match `.direct` for this identity). A record can genuinely carry N>1 tokens:
`enterMergeQuarantine`'s re-raise branch does `tokens: [...existing.tokens, token]` whenever the same
repo hits the unconfirmed-kill branch again before being cleared — i.e. exactly the shape of repeated
retries against a persistently-unreachable mount, the SAME host-distress condition that creates the
quarantine in the first place. So the worst case multiplied by N for zero correctness benefit.

## Measurement

Hermetic temp `LOOM_HOME`, real (uninjected) fs ops, calling the real, built `classifyLiteralGateFromFs`
directly:

| scenario | result | elapsed |
|---|---|---|
| existing path (rule 1, realpath succeeds) | `direct-only` | ~0.3ms |
| missing leaf, shallow existing ancestor | `open` | ~1.2ms |
| missing leaf, 40 real existing ancestor dirs (near the 64-step bound), drive-local | `open` | ~1.5–4ms, avg 1.85ms over 20 runs |

On a healthy, drive-local filesystem the entire walk — even near its full bound — is negligible. The
exposure is not about drive-local paths; this measurement confirms the card's own premise (the UNC/
network-host case) rather than refuting it. The UNC-host ~1.3s/lstat figure itself was not re-measured
here — reproducing a genuinely unreachable network host is unsafe/synthetic-load-adjacent for a hermetic
investigate-first pass — it is carried forward from the round-6 Code Review as given.

## Decision

Memoize ONLY `classifyLiteralGate(recordIdentity)`'s own result, for the lifetime of ONE
`readSurvivingOnDiskTokens` call — a local `{ value?: LiteralGateResult }` cell, created fresh inside
`readSurvivingOnDiskTokens` and threaded through `tokenTombstonedForIdentity`'s new optional third
parameter. Computed lazily (only when the first token that actually needs it reaches that line — a call
where no token reaches the gate still performs zero walks, same as before). Never module-level, never
persisted past the one synchronous call, so no invalidation story is needed and nothing about the walk's
own synchronicity/TOCTOU posture changes. Everything token-specific (`owners.direct`/`owners.literal`
membership) stays per-token, unmemoized.

## Rejected alternatives

- **Per-(path, boot) cache** — would help the cross-call case (the same identity re-queried across
  several `readSurvivingOnDiskTokens` calls during one clear, or across a boot sweep), but needs a
  genuine fail-closed invalidation story: a cached `"open"`/`"direct-only"` verdict must never be served
  stale once the underlying path's resolvability genuinely changes (a network share reconnects mid-
  session). No incident motivates taking on that risk right now — `0d3b64c6` already spent five Code
  Review rounds closing fail-opens in this exact function; a longer-lived cache is a separate, larger
  follow-up if ever pursued, not bundled into this narrow fix.
- **Short-circuit for drive-local paths** — not well-defined: a mapped network drive, or a junction
  whose target is a UNC path, is indistinguishable from an ordinary local path by spelling alone, which
  is exactly the failure mode `classifyLiteralGateFromFs`'s walk exists to catch. Skipping the walk for a
  "looks local" path would silently reopen the hazard it was built to close.
- **Do nothing** — the drive-local measurement is clean, but doesn't touch the UNC tail risk, which is
  real (given, not refuted) and was shown here to be N×-amplifiable by the token-redundancy above; the
  blast radius (the whole single-threaded daemon, every project) is severe enough to warrant the narrow
  fix even though the base exposure's frequency is low.

## Named residual

- **First-token cost against a genuinely unreachable UNC host is unchanged.** Memoization removes the
  redundant re-walks for every token/call after the first; it does not reduce the cost of the ONE walk
  that must still run the first time an identity reaches the gate. That cost is inherent to doing the
  check at all (correctly fail-closed) and is not addressed here, in either round.

## Round 2 (M1/M2/M3 follow-up — card d5d705f5, same id, new commits)

A Code Review of round 1 found two more sites paying the same per-token cost for the same reason:

- **M1 — `directPathIdentity(recordIdentity)` was still being recomputed once PER TOKEN**, even after
  round 1 memoized `classifyLiteralGate`. It is equally identity-dependent (never token-dependent), so it
  belongs in the SAME per-call memo. The memo cell is now a named type, `IdentityGateMemo { directIdentity?:
  string; literalGate?: LiteralGateResult }`, and `tokenTombstonedForIdentity`'s own third parameter is
  renamed from `literalGateMemo` to `memo` to reflect that it now caches both.
- **M2 — the three residual sites named in round 1's own "Named residual"**
  (`markedFinalFullyCoveredByClear`, `orphanFileTokensAccountedForByUpdate`, `orphanSweepSafeToDelete`)
  each called `readSurvivingOnDiskTokens(parsed, recordIdentity)` once, then re-looped the SAME
  `onDiskTokens`/`recordIdentity` pair a second time in their own `.every()`, unmemoized — so a record
  with N tokens reaching the gate still re-walked up to N times in that second loop alone.
  `readSurvivingOnDiskTokens` now takes an optional `callerMemo: IdentityGateMemo`; all three sites create
  ONE cell before their own read, pass it into `readSurvivingOnDiskTokens`, and pass the SAME cell into
  their own `.every()`'s `tokenTombstonedForIdentity` calls — one memo shared across both loops, never two.
  All three reads-then-`.every()` pairs were verified to sit in one synchronous frame with no write and no
  await in between, before threading the memo through.
- **M3** — proven with a record whose tokens are tombstoned ONLY via the LITERAL key (never direct): a
  token raised and cleared while its identity resolves through a real directory junction, then re-read
  after the junction is removed. `directPathIdentity`'s realpath-failure fallback no longer matches the
  resolved form recorded at clear time (direct fails), but `literalRepoPathKey` — pure lexical, never
  resolving anything — still matches, and the gate must classify `"open"` for `.literal` to be consulted
  at all. A second such token in the same loop survives (or not) purely off the FIRST token's own cached
  `"open"` verdict, proving the cache is load-bearing for the literal path too, not just the direct one.

Measured call-count proof (`test/merge-quarantine-d5d705f5-literal-gate-memo.mjs`, instrumenting the real
`fs.realpathSync.native`/`fs.readdirSync`): for the original 4-token/1-record fixture, M1 drops
`fs.realpathSync.native` calls from 6 (one `directPathIdentity` call per token, plus the already-memoized
gate's 2) to 3 (1 + 2, computed once total). For `markedFinalFullyCoveredByClear` driven directly via a
new `markedFinalFullyCoveredByClearTestOnly` seam against a 3-token record, M2 drops the SAME call from 12
(3 unmemoized in the internal read, 9 more unmemoized across the `.every()` recheck) to 3, and `readdir`
calls from 4 to 1.

## Do not

- Do not widen `IdentityGateMemo`'s lifetime past the one synchronous call/frame that creates it — it is
  not a cache in the sense the "rejected alternatives" section above describes, and must never become one
  by incremental widening (module-level storage, a longer-lived object reused across calls) without first
  re-deriving the fail-closed invalidation story that was deliberately not taken on here.
- Do not memoize anything token-specific (`owners.direct.has(...)`/`owners.literal.has(...)`) on
  `IdentityGateMemo` — those differ per token even when the identity is shared; only an identity-dependent
  classification (`directPathIdentity`'s result, `classifyLiteralGate`'s result) is safe to share across a
  loop over a record's own tokens.
- Do not assume the three M2 sites are now immune to a FUTURE second unmemoized re-loop over the same
  `recordIdentity` being added later in the same function — the fix is "one memo cell, created once,
  threaded through every `tokenTombstonedForIdentity`/`readSurvivingOnDiskTokens` call in that frame," not
  a property of the function as a whole; a new loop added later must explicitly reuse the same cell.
- Do not call `markedFinalFullyCoveredByClearTestOnly` (or any other `TestOnly`-suffixed export this
  module adds) from production code — `no-src-testonly-import-guard.mjs` matches `/TestOnly$/`
  specifically to catch exactly that.
