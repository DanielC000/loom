# 64119847 — a tied pending twin's own private tokens survive a key/orphan-file-addressed clear

Found by a Code Reviewer (probe G, through the `reenterMergeQuarantinesAtBootTestOnly` inject seam),
reproduced and traced by this card's own worker. PRE-EXISTING, CRITICAL-CLASS over-unblock in
`clearMergeQuarantineByKey`'s pending-filter (`merge-quarantine.ts`).

## The bug

W active at key K, tokens `{s}`. P pending, same identity, tokens `{s,v}`, armedKeys `[K]`. Clearing
token `s` (`clearMergeQuarantineByToken`) reduces P to `{v}` first (the by-token pending pass), then
fully clears W — which calls `clearMergeQuarantineByKey(K, …)`. That function's own pending-filter ties P
to W's clear via `keysToLift.some((k) => p.entry.armedKeys?.includes(k))` — a bare, STRUCTURAL key-overlap
check with no proof that P's own (already-reduced) tokens are actually a subset of what this call is
lifting (`entry.tokens`, W's token set) — and sweeps P WHOLE, durably losing `v` both in-memory and across
a reboot, even though `v` was never part of what this call cleared.

The SAME shape existed in a second OR-branch of the same `tiedToThisEntity` check:
`!!entry.orphanLatchFiles?.includes(p.sourceFile)` (the `97cff6db` migrate-source-tracking-placeholder
reference). Both were independently reproduced with a real repro against the compiled module, each
isolated from the other (removing the OTHER branch's own trigger condition made the bug disappear,
confirming each branch independently causes the loss).

Two of the five OR-branches in `tiedToThisEntity` are provably safe and were left unchanged: `!entry`
(pure pending clear, nothing to compare against), `p.entry === entry` (true reference-identity twin, no
distinct tokens can exist), and `subsetOfClearedTokens` (every one of P's own tokens is already inside
`entry.tokens`, which this call is fully lifting — nothing is lost).

## Do not

- Do not treat a shared armed key, or an orphan-file reference, as proof that a tied pending twin's own
  tokens are fully covered by the active entry's clear — only `p.entry === entry` (the trivial same-object
  twin) and a proven token subset (every one of P's tokens already inside `entry.tokens`) license a full
  removal. A structural tie (key/file overlap) is necessary but not sufficient.
- Do not fully remove a tied pending twin that still holds a token outside `entry.tokens` after
  subtracting the overlap — reduce it in place (mirror `clearTokenFromPendingIndices`'s own
  non-empty-remaining shape: `replaceEntryEverywhere`, update the array slot, durably rewrite every key
  still genuinely pointing to the updated object plus the twin's own `sourceFile`), never drop it.
- Do not touch a reduced twin's `armedKeys` field, or delete any of its `activeQuarantines` map slots, as
  part of a reduce (this was the Lead's own correction on this card, mid-review): if the twin survives
  holding an outstanding token, it keeps EVERY key it was armed on exactly as it was. Stripping an armed
  key out from under a still-outstanding private token lets that key admit merges while the token is
  outstanding — the SAME over-unblock this fix exists to close, one level down. That bookkeeping (lifting
  keys, deleting physical latches) stays scoped to the full-removal path only.
- Do not push a reduced twin's FULL original token list into `candidateTokens` — push only the OVERLAP
  tokens (the ones actually being lifted by this call). The full list would get tombstoned alongside the
  survivor's own still-outstanding token, and this module's `clearedTokens` tombstone set is GLOBAL and
  process-wide (see its own doc comment) — tombstoning a token that is still legitimately outstanding
  elsewhere would let a later, unrelated reconciliation wrongly treat it as already gone.
- Do not add a second, per-site `tombstoneIfNotSurviving` call for the reduce path. `clearMergeQuarantineByKey`
  already defers to ONE call at the very end of the function (decision `8db913e2` round 4, CR3 BLOCKER 1) —
  as long as the durable rewrite happens inside the pending-filter loop (before that one call), the
  "durable write before tombstone" ordering the Lead required is satisfied by the EXISTING architecture;
  adding a second call would reintroduce the exact multi-call shape that decision replaced.
- Do not widen `rewriteOrphanLatchFilesAfterPartialClear`'s signature to accept multiple cleared tokens at
  once just to serve this card. It is called once per overlap token, mirroring every other caller's own
  per-token contract. When `overlapTokens.length >= 2`, this DETERMINISTICALLY leaves a folded orphan file
  stale, every time: each call's own ownership-confirmed check accounts only for `updated.tokens` plus the
  ONE token passed THAT call, so a file still on-disk-holding the OTHER not-yet-accounted overlap token
  fails every call's check in turn, never on just some of them — this is an ACCEPTED, pre-existing-shaped,
  fail-CLOSED residual the helper's own doc already names ("a skipped, left-stale file... can never
  un-quarantine anyone else as a side effect"), not a new regression. Reachable ONLY via the by-key/human
  routes (`clearMergeQuarantine`, `clearMergeQuarantineByRecordedPath`, `clearMergeQuarantineLatchFile`'s
  active-match branch) — these call `clearMergeQuarantineByKey` with WHATEVER full token set the active
  entry currently holds, which can be 2+. The by-token route (`clearMergeQuarantineByToken` →
  `clearActiveEntryTokenAtKey`) can NEVER produce this shape: it only delegates to
  `clearMergeQuarantineByKey` when removing ONE token leaves the entry's own remaining set EMPTY, so
  `entry` at that delegation point always holds exactly the one token just being removed.
- Do not assume the human route (`clearMergeQuarantineByRecordedPath`) needed a change. It reaches the
  same `clearMergeQuarantineByKey` pending-filter via its own active-match loop, but its SEPARATE, broad,
  unconditional pending sweep (identity-matched, no "tied" check at all) runs right after and drops every
  same-identity pending entry regardless — by design, since a human resolving this by hand does not
  necessarily hold (or need) every outstanding token. The reduce-not-drop fix is harmless there: whatever
  a reduced P survives the inner pass with, the outer unconditional sweep still removes it.
- Do not conflate this card with `c93e9e7a` (parked, branch `loom/dbc76bd19a0e`, "compute pending-twin
  lifted keys before any delete in clear loops") — that card is scoped separately and resumes after this
  one; the `remainingTokens`/`overlapTokens` computed from `entry.tokens` captured before any delete (this
  function's pre-existing `keysToLift`/`candidateTokens` capture point) is the same shape that card is
  expected to build on, not a duplicate of it.
- Do not reassign `arr[idx]` (the pending-filter's own `.filter((p, idx, arr) => …)` third/fourth params)
  after calling `replaceEntryEverywhere(activeQuarantines, p.entry, updated)` — that call already mutates
  `p.entry` in place (its own doc: `for (const p of pendingUnresolvedQuarantines) if (p.entry === oldEntry)
  p.entry = newEntry;`), and `p` here IS the live `pendingUnresolvedQuarantines` element (never a copy), so
  a subsequent `arr[idx] = {...}` is dead code (round-2 CR finding) that silently depends on the SAME
  mutation it looks like it's performing itself. If a future change ever made `replaceEntryEverywhere`
  non-mutating, removing the dead reassignment is what lets the committed test's own explicit
  in-memory-equality check ("the in-memory pending entry's own tokens are EXACTLY the reduced set") go RED
  instead of passing by coincidence.

## Verification

Reproduced via a standalone repro (scratch, not committed) against the compiled module, using the real
`clearMergeQuarantineByToken` route — confirmed RED pre-fix (both `v-token` lost in-memory and across a
simulated reboot) for both the armedKeys-overlap and orphanLatchFiles-reference branches independently,
each isolated by removing the other branch's own trigger condition.

Round 2 (Code Review `0fcdf25b`) found a real test gap: disabling EITHER of the reduce path's two durable
writes (the armed-key `writeMergeQuarantineLatch` loop, or the `rewriteOrphanLatchFilesAfterPartialClear`
call) left every committed scenario fully green, because none of them gave the tied twin a SECOND armed
key it genuinely occupies (the `883e29bc` dual-tracked-twin shape, via `setActiveQuarantineTestOnly`) or
its OWN `orphanLatchFiles` entry. Two new scenarios close this: a dual-tracked twin armed at both the
cleared key and an independent second key, with a real folded orphan file, driven via both the by-key and
by-token routes — asserting the EXACT on-disk token set of the second key's own latch and of the orphan
file, plus that the cleared token never resurrects across a reboot. Each of the two writes was disabled
individually (tsbuildinfo cleared, rebuilt) and confirmed the corresponding new check(s) alone go RED,
isolated from the other write and from every prior scenario, then restored byte-identical and rebuilt.

Committed regression coverage: `packages/daemon/test/merge-quarantine-64119847-tied-twin-private-tokens.mjs`.
