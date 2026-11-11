# d524d1c4 — `divertRaiseEntry`'s own merge branch dropped the INCOMING raise's resolvedKey/resolvedKeys entirely (a real fail-open, FIXED)

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up d524d1c4 — `divertRaiseEntry`'s own merge branch dropped the INCOMING raise's resolvedKey/resolvedKeys entirely (a real fail-open, FIXED)

Found by Code Review `7b35b79f` (card `050a4428`), from a code read: `divertRaiseEntry`'s merge branch
(`indices.length > 0`, ~L2543-2561) built `merged` as `{...base.entry, tokens, orphanLatchFiles,
armedKeys, contributorRepoPaths, provenanceUnknown, provenanceTracked}` — every field is unioned across
`all` (`base.entry`, every `others` entry, and the incoming `entry`) EXCEPT `resolvedKey`/`resolvedKeys`,
which simply rode through unchanged from `base.entry`'s own spread. The incoming raise's own informative
resolvedKey (and every OTHER matched entry's) was silently dropped whenever it differed from
`base.entry`'s. Unlike the ACCEPTED Step 1 residual above, this function never calls
`unionQuarantineEntries` in any form (its own doc comment: "Built by hand, never via
`unionQuarantineEntries`") — this is a structural omission of the resolvedKey/resolvedKeys fields from
the hand-rolled union, not a narrower edge case of an existing adjudication rule.

**Sibling defect, fixed separately (card `00fd29d7`):** `mergeTokenIntoPendingEntries` — the `!verified`
twin of this same hand-rolled merge, reached from `enterMergeQuarantine`'s own pending-merge branch
instead of the `existing`/write-fault paths this function serves — had the IDENTICAL structural omission.
See "Follow-up 00fd29d7" below for its own repro and fix.

### Confirmed real, reproduced with ZERO out-of-band mutation to establish the premise

A production sequence, no triple fault needed (unlike the MEMORY-ONLY-KEY GUARD above, an ORDINARY
single read fault suffices): (a) D is dual-armed `[K,Kw]` (its own physical slot K, legacy
`resolvedKey=Kw`) via the standing protect/carry-forward mechanism (Follow-up 4b06875f) or boot's PASS 1
migrate dual-arm; (b) a genuinely independent raiser later finds D degraded-occupying ITS OWN write
target, and `protectOccupantContentBeforeDelete` durably mints a separate, reference-distinct pending
record for D's identity (no resolvedKey) at D's own deterministic pending filename — ordinary,
successfully-readable content, no injection; (c) D is raised again (`enterMergeQuarantine`'s `existing`
branch) and this raise's own write to `final` hits a single ordinary I/O fault (EACCES/EBUSY — an
AV/indexer lock, per this module's own documented hazards) — `mustDivert=true`,
`divertRaiseEntry(baseEntry)` runs with `baseEntry.resolvedKey=Kw`, `indices.length>0` matches (b)'s
record, the merge branch drops `Kw` from the written record; (d) D's own original token at `final`/K
later gets legitimately cleared (its now-redundant physical copy removed, mirroring the isolation step
below); (e) next boot: `Kw`'s own real repo is completely unprotected. Hermetic repro against the real
compiled module, direct final-file removal as the isolation step (same technique, same justification, as
the MEMORY-ONLY-KEY GUARD scenario — the premise itself needed zero out-of-band mutation): "CARD
d524d1c4, RESOLVEDKEY SURVIVES A MERGE-BRANCH DIVERT" in `merge-quarantine-raise-protect-failure.mjs`.
RED on main (`negative-control`, reverted `merge-quarantine.ts` to HEAD), GREEN restored, clean tree.

### The fix — ALWAYS-UNION-WHEN-INFORMATIVE across every matched entry plus the incoming one

Lead ruling: do NOT reuse `unionQuarantineEntries`'s `explicitResolvedKeyRule` (its symmetric-difference
exclusion adjudicates a KNOWN-stale side against a fresh one — 4b06875f's own context, and 050a4428's own
analysis of why it excludes the symmetric difference). On this path, NO input is known stale — the
existing pending record(s) and the incoming raise are all current knowledge of the SAME identity — so
excluding a conflicting key would just be a NEW way to drop one, the exact fail-open this card fixes.
Instead: `resolvedKeys` is the deduplicated union of every informative key (scalar `resolvedKey` UNIONED
with the array `resolvedKeys`, via the existing `informativeKeysFor` helper) across ALL of `all`
(`base.entry`, every `others` entry, the incoming `entry`), fed through the existing
`unionResolvedKeysRetaining` cap/eviction helper for consistency with every other call site that
accumulates this field. The scalar `resolvedKey` is kept only when every input that carries one agrees
(all defined scalars are `===`); otherwise it is left `undefined`, with every key still surviving in
`resolvedKeys`.

`excludeLiftedResolvedKey`/`excludeLiftedResolvedKeys` do NOT apply on this path, deliberately: both
exist to stop a protective copy read from `final` from carrying forward a key the SAME operation is about
to overwrite `final` with, or `final`'s own physical key (Follow-up 4b06875f) — `divertRaiseEntry` never
touches `final` at all (its own doc comment: "Never touches `final` itself"), so neither exclusion's
premise ever arises here; there is nothing to subtract. A literal self-reference surviving into
`resolvedKeys` (e.g. a matched entry's own resolvedKey happening to equal some OTHER key in the same
union) is harmless regardless of this: every reader filters self-reference at ARM time, via
`isInformativeKey`/`secondaryKeysToAttempt`'s own anchor-key check, never at write time — confirmed by
code and empirically (the matrix reboot check below re-arms a `resolvedKeys`-only record, no scalar
needed, at every key it carries).

### Confirmed from the code: a `resolvedKeys`-only record (no scalar) IS re-armed at boot for every key

`secondaryKeysToAttempt`/`informativeKeysFor` (the shared helpers every boot-time arm site — PASS 1's
primary-arm secondary loop and its degraded-divert branch alike — already route through) union the scalar
AND the array, never "array else scalar"; neither requires a scalar to be present. Re-verified
empirically, not just by inspection: the matrix scenario below produces a `resolvedKey:undefined,
resolvedKeys:[Y,Z,W]` record, and all three of Y/Z/W's own real repos stay blocked after a reboot.

### Tests

1. **"CARD d524d1c4, RESOLVEDKEY SURVIVES A MERGE-BRANCH DIVERT"** — the repro above, committed. RED on
   main (`negative-control`), GREEN after the fix, clean tree restore.
2. **"CARD d524d1c4, NO-KEY-DROPPED MATRIX"** — `indices.length === 3` (never just 1), M1 scalar-only
   (`Y`), M2 array-only (`[Z]`), M3 no key, incoming scalar `W` (disagrees with M1's `Y`). Asserts the
   output's informative-key set ⊇ `{Y,Z,W}`, the scalar is `undefined` on disagreement, and M2/M3's own
   sourceFiles are folded into `orphanLatchFiles`. **M1/M2/M3's own keys are DELIBERATELY DISJOINT** — a
   first draft gave M2 `resolvedKeys:[Z,Y]` (overlapping M1's own `Y`), and boot's own PRE-EXISTING,
   correct secondary-key-arming (`armQuarantineKey`/`unionQuarantineEntries`, unrelated to this card)
   silently unioned M1 and M2 together AT ARM TIME, before `divertRaiseEntry` ever saw them — collapsing
   the intended 3-input matrix down to 2 distinct objects while `indices.length` still read 3 (two array
   slots pointing at the SAME merged object). This is boot's own pre-existing behavior working correctly,
   not a defect — but it is a real trap for constructing a "3 genuinely independent matched entries"
   fixture: use disjoint keys, or verify distinctness explicitly.

   **CR `3555435b` round 2, three test-only findings, all fixed:**
   - **The distinctness precondition must read IN-MEMORY state, never on-disk bytes.** Boot's arm-time
     union (when it fires) happens entirely in memory and never rewrites either source file — reading
     m1Path/m2Path's own bytes passes identically whether or not they were actually unioned, so a
     file-content check cannot catch the collapse it documents. Fixed: assert via
     `listActiveMergeQuarantines()` instead — two separate live entries for d5's identity, one carrying
     ONLY M1's own token and one carrying ONLY M2's own token (a single merged entry would carry both).
     Proven to actually discriminate: temporarily reverted the fixture to the overlapping `[Z,Y]` shape
     (no source change) — the precondition goes RED; restored byte-identical — GREEN again.
   - **The Y/Z reboot checks didn't discriminate the fix on main.** `divertRaiseEntry` only ever rewrites
     `base.sourceFile` (`m1Path`); `others`' own sourceFiles (`m2Path`, `m3Path`) are folded into
     `orphanLatchFiles` but their ORIGINAL bytes are never swept — so Z would trivially re-arm from M2's
     own still-intact orphan file regardless of whether the merge itself carried Z forward. Fixed:
     `m2Path`/`m3Path` (and `K5FinalPath`, as before) are removed before the reboot, so only the merged
     record at `m1Path` survives — `negative-control --ref HEAD~2` against the genuinely pre-fix source
     now shows Z's AND W's own reboot checks going RED (not just W's). **Y's own reboot check still does
     NOT discriminate even after this fix** — Y is `base`/M1's own key, which the ORIGINAL, buggy
     `{...base.entry}` spread always kept unconditionally regardless of this card's bug (the bug only
     ever dropped `others`'/the incoming entry's own keys, never `base`'s). Confirmed empirically: the
     SAME `--ref HEAD~2` run shows Y's reboot check still PASSING. Relabeled honestly as a sanity check
     (matching this file's own established `(sanity, NOT hazard-discriminating...)` convention), per the
     CR's own stated fallback.
   - A leftover "Z+Y from M2" in one check's own label (stale text from before the disjoint-key fix,
     M2 only ever carried `[Z]`) corrected to "Z from M2".
3. **"CARD d524d1c4, SCALAR KEPT WHEN EVERY INFORMATIVE INPUT AGREES"** — NOT a repro of this card's own
   bug (CR `3555435b` round 2, nitpick): it passes on main too, by construction — a single matched entry
   that IS `base` has its own scalar trivially kept by the ORIGINAL, buggy `{...base.entry}` spread
   regardless of this card's fix. It instead guards against a DIFFERENT, hypothetical regression — some
   future change that drops the scalar to `undefined` any time a union occurs at all, even when every
   informative input agrees on the same key — which the matrix scenario above cannot catch (it only ever
   disagrees).
4. The 050a4428 MEMORY-ONLY-KEY GUARD scenario, every 4b06875f probe, and every `d2582692`-tagged
   scenario in `merge-quarantine-raise-protect-failure.mjs` stay green (same file, re-run in full). All
   42 `merge-quarantine*.mjs` files run serially, exit 0. The touched file re-run under both
   `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1` — the FIRST attempt at the matrix scenario above
   (before the disjoint-key fix) failed under BOTH states when run in isolation, confirming the earlier
   single-env failure seen when run as part of the full file was the SAME fixture bug, not a genuine
   `LOOM_DEV`-conditional behavior (`merge-quarantine.ts` reads neither `LOOM_DEV` nor `isLoomDev()` at
   all) and not even deterministic cross-scenario state bleed — it reproduced standalone, in isolation,
   under both env states identically, once the overlapping-key fixture bug was present.

### Do not

- Do not reuse `unionQuarantineEntries`'s `explicitResolvedKeyRule` for this merge branch — its
  symmetric-difference exclusion assumes one side is known-stale, which is never true here; applying it
  would just be a different-shaped version of the SAME fail-open this card fixes.
- Do not route this merge branch's resolvedKey/resolvedKeys computation through
  `excludeLiftedResolvedKey`/`excludeLiftedResolvedKeys` — `divertRaiseEntry` never touches `final`, so
  neither exclusion's premise (a protective copy about to be superseded by this SAME operation's own
  fresh write to `final`) ever applies here.
- Do not construct a "3 genuinely independent matched pending entries" fixture with overlapping
  informative keys across the matched entries — boot's own secondary-key arming will silently union them
  together before `divertRaiseEntry` ever runs, collapsing the intended input count. Use disjoint keys,
  or assert distinctness explicitly (see Test 2 above).
