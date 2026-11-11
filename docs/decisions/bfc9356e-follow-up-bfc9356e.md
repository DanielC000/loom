# bfc9356e — follow-up to the raise-divert card (see the section body)

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up bfc9356e

Investigate-first card `bfc9356e` (2026-10-17), filed by worker `721c1123` while building `d524d1c4`'s
own fixture: a real `clearMergeQuarantineByToken(d4, "<d4's original token>")` on that exact dual-armed
fixture did not remove `d4`'s own final file and produced an "unconfirmed-kill identity collision"
refusal on a later query. **Verdict: correct fail-closed behaviour, not a bug.**

By the time that call ran, the fixture's active entry was already a UNION of THREE outstanding tokens —
`d4`'s own original, an independent raiser's own token folded in as a contributor by the merge-branch
divert (same mechanism this record's own "FOLLOW-UP (card d524d1c4)" section above describes), and the
re-raiser's own fresh token. `clearMergeQuarantineByToken` is documented compare-and-clear SET semantics:
one call removes ONLY its own token; the repo stays quarantined until the set is empty. Clearing 1-of-3
correctly left the final file in place (content rewritten to the 2-token remainder, never removed) and
left `assertRepoNotQuarantined` (`merge-quarantine.ts:4379`) refusing with its pre-existing
ambiguous-collision clause (built at `merge-quarantine.ts:4390-4402`, governed by `@decision 9a55fb90` /
`@decision abccee85`) — that refusal is unrelated to the clear call itself; the union already had more
than one contributor the instant the re-raise merged with the independent raiser's divert, before any
clear ever ran.

Clearing the REMAINING two tokens (via the same `clearMergeQuarantineByToken`) resolves it cleanly: the
entry is fully lifted, both latch files (the final and the pending-divert twin) are gone, and both repos
report `ok:true`. The mechanism is not stuck — it was simply doing its job of removing one of three.

Pinned by `*** CARD bfc9356e ***` in `merge-quarantine-raise-protect-failure.mjs` (right after the
`d524d1c4` scenario): partial clear stays active + ambiguous (asserted against the real refusal text,
confirmed to carry both the "unconfirmed-kill" and "ambiguous"/"collide" wording `721c1123` described),
full clear resolves cleanly.
