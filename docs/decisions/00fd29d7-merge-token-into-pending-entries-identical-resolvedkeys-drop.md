# 00fd29d7 — `mergeTokenIntoPendingEntries` had the IDENTICAL drop, made durable by a later partial clear (FIXED)

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 00fd29d7 — `mergeTokenIntoPendingEntries` had the IDENTICAL drop, made durable by a later partial clear (FIXED)

Found and reproduced by Code Review `3555435b` (card `d524d1c4`'s own follow-up), against the compiled
dist, with zero out-of-band fault injection. `mergeTokenIntoPendingEntries` — the `!verified` twin of
`divertRaiseEntry`'s own merge branch above, reached from `enterMergeQuarantine`'s pending-merge branch
whenever the raising `repoPath` is itself still unresolvable (never via the `existing`/write-fault paths
`divertRaiseEntry` serves) — built `merged` as `{...base.entry, tokens, orphanLatchFiles,
contributorRepoPaths, provenanceUnknown, provenanceTracked}`: the SAME structural omission of
resolvedKey/resolvedKeys, dropping every non-base matched entry's own informative key(s) unconditionally.

Unlike the `divertRaiseEntry` shape, a single raise is enough to reach this: `enterMergeQuarantine`'s own
`!verified` branch routes straight into `mergeTokenIntoPendingEntries` whenever one or more pending
entries already match the raising repoPath's own identity — no dual-arm, no write fault, no `existing`
lookup involved at all.

### Why the drop becomes DURABLE, not just a one-boot miss

A dropped key here is worse than `divertRaiseEntry`'s own (pre-fix) drop in one respect: a LATER partial
clear of one of the merged entry's own tokens (`clearMergeQuarantineByToken` → `clearTokenFromPendingIndices`
→ `rewriteOrphanLatchFilesAfterPartialClear`) durably REWRITES every OTHER matched entry's own folded
`orphanLatchFiles` member with the SAME (already key-less) merged content — so even a sibling pending
record whose own original on-disk bytes still named the dropped key gets physically overwritten, and the
key is gone from every surviving copy, not just the merged one. A reboot after that partial clear
unblocks the dropped key's own real repo even though the token that actually owned it was never cleared.

### The fix — the SAME shared helper `unionInformativeResolvedKeys`, extracted from the `divertRaiseEntry` fix above

Rather than re-deriving a second, parallel ALWAYS-UNION-WHEN-INFORMATIVE implementation, `divertRaiseEntry`'s
own computation above was extracted into one shared helper (`unionInformativeResolvedKeys`, in
`merge-quarantine.ts`) and both hand-rolled merge branches now call it — `divertRaiseEntry` unchanged in
behavior (refactor only), `mergeTokenIntoPendingEntries` newly correct. Same rule, same exclusions that do
NOT apply (`explicitResolvedKeyRule`, `excludeLiftedResolvedKey(s)` — see the helper's own doc comment and
the "Follow-up d524d1c4" section above for why neither premise ever arises on either of these two paths):
no input to `mergeTokenIntoPendingEntries` is known-stale (every matched pending entry is matched purely
by `directPathIdentity` against the SAME still-unresolvable raise, exactly like `divertRaiseEntry`'s own
matched set — current knowledge of one identity, never a disk re-read of a possibly-superseded copy), and
this function never touches `final` either (its own doc comment: it never WRITES a new arm of its own at
a canonical key — though a matched entry it absorbs can already BE armed elsewhere, as an 883e29bc
boot-diverted twin; see "Follow-up 3d27c045" below for the gap that left open), so
`excludeLiftedResolvedKey(s)`'s premise (a protective copy about to be superseded by THIS SAME operation's
own fresh write to `final`) never arises here either.

### Tests

Committed in `merge-quarantine-raise-protect-failure.mjs` (`*** CARD 00fd29d7 ***`-tagged): d7 =
`r7/gone-subdir7` is genuinely unresolvable; M1 (no key, enteredAt 1000) and M2 (resolvedKeys=[Z7],
enteredAt 2000) are two independent pending-divert records for d7's own identity. A fresh raise on d7 (via
`enterMergeQuarantine`, still unresolvable) is confirmed to route into `mergeTokenIntoPendingEntries`
(never `divertRaiseEntry`); the merged record (at M1's own sourceFile) is asserted to carry Z7 forward.
`clearMergeQuarantineByToken` then clears M1's own token (a PARTIAL clear — two tokens remain outstanding),
confirmed to durably rewrite M2's own folded orphan file with the SAME reduced content (the mechanism this
card's own durability hazard depends on) — both copies are asserted to still carry Z7 after the clear. A
fresh boot-module reimport + `reenterMergeQuarantinesAtBoot` then confirms Z7's own real repo stays blocked
after a reboot, even though the token that actually owns Z7 (`m2-token`) was never cleared.

Proven RED on `main` (sha `40142d6b` — main's own tip immediately before this follow-up's own fix landed
as `a7add825`) and GREEN after, via `scripts/negative-control.mjs --ref main`: exactly the three
`*** CARD 00fd29d7 ***`-tagged assertions fail pre-fix (3 FAILURE(S), nothing else), pass post-fix, tree
restored clean. All 42 `merge-quarantine*.mjs` files run serially, exit 0 — including the
`050a4428`/`4b06875f`/`d2582692`-tagged scenarios and the `divertRaiseEntry`-side `d524d1c4` scenarios
(Follow-up above), confirming the refactor left that function's own behavior unchanged. The touched test
file re-run under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1` — identical, since
`merge-quarantine.ts` reads neither.

### Do not

- Do not re-derive a second, parallel resolvedKey/resolvedKeys union for `mergeTokenIntoPendingEntries` —
  call `unionInformativeResolvedKeys` (the same helper `divertRaiseEntry` now calls too), or the two
  hand-rolled merge branches drift apart again exactly the way this card's own bug diverged from the
  `divertRaiseEntry` fix in the first place.
- Do not assume a single matched pending entry is enough to prove this fix — the drop is invisible with
  only one matched entry (`base`'s own fields were never the ones either bug dropped); use at least two
  matched entries carrying DISJOINT informative keys (see the `d524d1c4` matrix scenario's own "Do not" on
  overlapping keys above — the same boot-time secondary-key-arming collapse applies here too).
- Do not skip the partial-clear step when verifying this fix — a repro that only checks the merged
  record's own immediate write (never the DURABLE drop a later `rewriteOrphanLatchFilesAfterPartialClear`
  can cause) proves a narrower claim than the one this card's own title makes.
