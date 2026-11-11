# cd5a3cf9 — a basename match is never proof of same identity

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up cd5a3cf9 — a basename match is never proof of same identity

CRITICAL over-unblock, pre-existing, IN-PROCESS. `atFilenameIdx`/`atFinalBasenameIdx` matched by
`sourceFile` string equality alone — 6451a749/37452ddd's own fixtures always built that twin as the SAME
identity as the occupant. Repro: Y independently armed at Kb/Kc2; foreign Z2 sits at Kc2's own hash,
resolvedKey->Kb. Clearing Kc2 reached `protectOccupantContentBeforeDelete` for Z2; `atFinalBasenameIdx`
matched Y's own twin (still armed at Kb — a DIFFERENT identity), and `replaceEntryEverywhere` spliced Z2
into Kb, destroying Y's quarantine there, in-process.

**Fix:** gate all SIX union/re-point sites on the matched entry (`atFilenameIdx`'s own union; the outer
branch selection at both indices; the inner re-point/splice when both match; the `else if` when only
`atFinalBasenameIdx` matches; the double-fault re-point) on
`directPathIdentity(matched.repoPath) === directPathIdentity(toPersist.repoPath)` — captured before any
union/mutation (Lesson 196). On mismatch the slot is left untouched; falls to the pre-existing
independent-mint `else` (decision 1922be3a — Lesson 198).

**Code Review found 2 of 6 sites uncaught by the original test** (double-fault re-point; the inner
re-point when BOTH indices match, one genuine twin + one foreign) — both reproduced with realistic
fixtures (an injected EACCES write failure; a pre-existing same-identity pending file alongside the
foreign twin) and closed with two new scenarios. The sixth (the sibling splice, same branch as the inner
re-point) reverts to NO observable effect — `activeQuarantines` already holds the correct reference via
the OTHER gate, so losing only the pending-array bookkeeping entry is invisible to every query. All six
sites now independently verified: single-line reverts (Code Review, then re-confirmed by this worker)
each turn exactly one scenario RED; the splice reverts to zero failures, confirmed twice.

**Reboot checks are DURABILITY, not regression, for this shape:** they pass identically pre- and post-fix
— Y's own parked file genuinely survives either way (Code Review confirmed: nothing in production
deletes/skips it). The committed test labels them accordingly and omits the card's own script's
bootstrap-discard step, which is itself the artifact that made the ORIGINAL repro appear reboot-affected.

**Latent `atFilenameIdx`-mismatch channel, f3c644ca interaction, and the duplicated-index `sourceFile`
staleness (c93e9e7a round 3)** are unchanged from the prior revision of this Follow-up — not reachable in
production / not fixed here / left for a sibling card respectively.

Tests: `merge-quarantine-cd5a3cf9-identity-gate.mjs`, 4 scenarios, 24 checks — RED (9 failures) on HEAD~1
via `negative-control.mjs`, GREEN after, byte-identical restore. All `merge-quarantine*.mjs` run serially
in both env states; `guards` green.
