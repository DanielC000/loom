# 3315b08a — `clearTokenFromPendingIndices` re-resolves a REPLACED (not spliced) pending target by its live identity

Found by Code Review `ad5ca27c` of card `9c681680` (commit `578f1692`), reproduced with a hermetic scratch
probe (not committed) before any fix was written. Same CLASS of hazard as `9c681680` — a protect call
reached from this same loop's own "remove" branch can detach a not-yet-processed target's own snapshotted
wrapper from `pendingUnresolvedQuarantines` mid-loop — but a DIFFERENT SHAPE: `9c681680` fixed a SPLICE
(an index shift); this card closes an ASSIGN (`protectOccupantContentBeforeDelete`'s own "`atFilenameIdx`
matches, same identity" branch does `pendingUnresolvedQuarantines[atFilenameIdx] = { entry: written.entry,
… }`), which `9c681680`'s own "resolve `indexOf` fresh, right before use" fix does nothing for: the
detached wrapper is never shifted to a different index, it is simply gone from the array, permanently, for
that reference.

## The hazard

`clearTokenFromPendingIndices`' remove branch reaches `deleteMergeQuarantineLatchByKey` ->
`protectOccupantContentBeforeDelete` for each of its own owned armed keys. When that protect call's own
`atFilenameSameIdentity` branch fires (a not-yet-processed target's own identity happens to be the
occupant whose content a sibling target's armed key is protecting), it ASSIGNS a brand-new wrapper object
into that target's own array slot — never splicing it. `9c681680`'s own fix (snapshot by wrapper object,
resolve `indexOf` fresh) correctly handles a SPLICE (the wrapper stays the SAME reference, just at a
different, shiftable index) but cannot handle an ASSIGN: the snapshotted wrapper is not shifted, it is
detached outright, and no index will ever resolve to it again.

Worse, the stale pre-pass `plan` (remove vs. reduce, plus `ownedArmedKeys`) computed for that target before
any mutation can be WRONG by the time this is discovered — the replace's own union (of the target's
in-memory tokens with real on-disk content the protect call just read) can ADD tokens the pre-pass never
saw, flipping what looked like a full "remove" into a partial "reduce" that must preserve the newly-arrived
token.

## Confirmed repro

A 3-entry pending array: a real clear target at its own canonical pending-divert name (whose identity is
also the one a SECOND target's own armed key's physical file happens to hold, directly on disk, with an
extra token nothing in memory carries yet), the second target itself (owns the armed key), and an unrelated
bystander squatting the armed key's own physical file's basename (confirms `atFinalBasenameIdx` finds a
DIFFERENT identity, so only the ASSIGN fires, never the companion splice `9c681680` already covers).
Clearing the second target's own token: it self-splices cleanly, then its own armed-key cleanup unions the
first target's in-memory record with the real on-disk content and ASSIGNS a fresh wrapper into the first
target's own slot. Processing the first target next, `indexOf` returns -1 — not because it shifted, but
because it is gone.

**Observed, pre-fix (`578f1692`):** the -1 branch logs `console.error` and gives up. The real on-disk
token the clear was meant to lift is NEVER dropped — it (and the token the union just added) both survive,
in memory and on disk, across a reboot. The repo fails CLOSED (needs a human clear) rather than reflecting
the clear that was actually requested.

## The fix

Before trusting the stale pre-pass `plan` at all, check whether the snapshotted wrapper (`pending`) is
still present in the live `pendingUnresolvedQuarantines` array. If so, proceed exactly as before
(`9c681680`'s own fix, byte-identical for this case). If not, re-resolve by `directPathIdentity` instead —
requiring EXACTLY one live same-identity candidate (an ambiguous 0-or->1 match logs loudly and is left
untouched, fail-closed, mirroring the original -1 posture for the genuinely unexpected case) — and
re-derive the WHOLE plan fresh from that live entry's CURRENT tokens: remove when nothing survives
dropping `token`, reduce otherwise, with `ownedArmedKeys` recomputed via `entryStillOwnsKey` against the
live entry rather than reused from the stale pre-pass. The rest of both branches operate on the
re-resolved `live` wrapper in place of `pending`.

## Corrected false text (this card)

- The -1 log's own "nothing stale was left behind" claim is now true ONLY for the genuinely-ambiguous
  fallback (0 or >1 live candidates) — reworded there to say the token MAY be left stuck, since that is
  the one branch where nothing more can safely be done.
- "It is not expected to fire in production" (the ordinary remove branch's own -1 comment) is now
  qualified: a `live` that was just re-resolved (or confirmed live) immediately above the branch makes
  THAT -1 genuinely unexpected again — but the REPLACE shape itself is no longer "not expected to fire in
  production": this card's own repro proves it does.
- The pre-existing `targets` snapshot comment's claim that "every write below resolves its own current
  index … fresh" is restored to its original (now correctly scoped) wording — resolving an index fresh is
  necessary but was never, by itself, sufficient against an ASSIGN; the new re-resolve-by-identity step
  immediately above the remove/reduce dispatch is what closes that gap.

## Do not

- Do not assume `9c681680`'s own "resolve `indexOf` fresh, right before use" fix closes every way a
  snapshotted pending wrapper can go stale — it closes a SPLICE (a shifted index); it does nothing for an
  ASSIGN (`protectOccupantContentBeforeDelete`'s own same-identity `atFilenameIdx` branch), which detaches
  the wrapper outright with no index ever pointing at it again.
- Do not reuse a stale pre-pass `plan` (remove vs. reduce, or `ownedArmedKeys`) once a target's own
  wrapper has been re-resolved by identity — a protect-triggered union can ADD tokens the pre-pass never
  saw, which can flip a "remove" into a "reduce" that must now preserve the newly-arrived token. Re-derive
  the whole plan fresh from the live entry's CURRENT tokens, never just the removal index.
- Do not treat a re-resolution's own ambiguity (0 or more than 1 live same-identity candidate) as safe to
  guess through — leave it untouched and log loudly, exactly like the original -1 posture for a genuinely
  unexpected case; guessing which candidate is "the" target risks destroying or resurrecting the wrong
  one's content.
- Do not scope this fix to `clearTokenFromPendingIndices` alone and assume `clearActiveEntryTokenAtKey`'s
  own dual-tracked-twin loop (project memory: `535fd69d`) is immune to the same ASSIGN shape — it was not
  independently re-verified by this card and may share the identical hazard; a follow-up card should check
  it before assuming otherwise.

## Verification

- `merge-quarantine-3315b08a-replace-not-splice-stale-target.mjs` — the primary hazard above, plus the
  "reduce variant is correct post-fix" check the card's own repro calls out explicitly (the re-derived plan
  for the detached target is a REDUCE, not the stale pre-pass's REMOVE, because the union added a token).
  Proven RED (5 real `FAIL`s, including the exact -1 log line) on `578f1692` / GREEN after / byte-identical
  restore via `negative-control.mjs --ref HEAD`.
- All `merge-quarantine*.mjs` files run individually, in both env states (`env -u LOOM_DEV
  -u LOOM_SUPERVISED` / `LOOM_DEV=1 LOOM_SUPERVISED=1`).
- `pnpm --filter @loom/daemon guards`, committed first.
