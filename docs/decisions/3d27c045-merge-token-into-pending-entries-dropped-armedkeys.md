# 3d27c045 — `mergeTokenIntoPendingEntries` dropped `armedKeys` too, orphaning an 883e29bc boot-diverted twin's OTHER key — durably (FIXED)

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 3d27c045 — `mergeTokenIntoPendingEntries` dropped `armedKeys` too, orphaning an 883e29bc boot-diverted twin's OTHER key — durably (FIXED)

Found and REPRODUCED by Code Review `533c5698` of this card (`00fd29d7`), 2026-10-17. The root cause is
PRE-EXISTING on `main` (not introduced by `00fd29d7`'s own resolvedKey/resolvedKeys fix above); that fix's
correct behavior WIDENS this gap's post-reboot blast radius, since the merged record now correctly carries
every matched twin's own `resolvedKey(s)` forward — exactly the signal the stale residue this gap leaves
behind needs to durably re-arm from at the next boot.

`mergeTokenIntoPendingEntries` built `merged` as `{...base.entry, tokens, orphanLatchFiles,
contributorRepoPaths, provenanceUnknown, provenanceTracked, resolvedKey, resolvedKeys}` — no `armedKeys`
field at all — even though its own doc comment already names (`@decision 64283e06`) that a matched entry
can be an 883e29bc boot-diverted TWIN: the SAME object reference already armed in `activeQuarantines`
under its own `resolvedKey(s)`. `64283e06` fixed HALF of that shape (routing every matched entry through
`replaceEntryEverywhere` so the ACTIVE side's map slots get re-pointed onto `merged`, by VALUE, regardless
of `armedKeys`) but left the OTHER half open: `merged.armedKeys` itself stays `undefined`, so once it sits
in `activeQuarantines` at two (or more) keys, nothing records that fact ON THE ENTRY ITSELF. Two
clear-path helpers walk "every key this entry is armed under" by reading `entry.armedKeys` directly, with
a `entry.armedKeys?.length ? entry.armedKeys : [key]` fallback to the ONE key already in hand when it's
empty: `clearMergeQuarantineByKey`'s own `keysToLift`, and `clearActiveEntryTokenAtKey`'s own
`armedKeysForEntry` (merge-quarantine.ts). `clearTokenFromPendingIndices`'s own loops do NOT share this
shape — they read `pending.entry.armedKeys ?? []` with no `[key]` fallback at all, so an empty `armedKeys`
there is just zero iterations, never a wrong one; that function is also never reached for THIS shape in
the first place, since a twinned merged entry is always routed through the ACTIVE side (see below).

### Why this is a DURABLE, cross-reboot loss, not a one-boot miss

A fresh raise on a still-unresolvable identity with two or more matched 883e29bc twins merges them all via
`mergeTokenIntoPendingEntries`, folding every non-base matched entry's own `sourceFile` into the merged
record's `orphanLatchFiles` — never deleting them; they survive on disk as inert residue, kept in sync by
every PARTIAL clear's own `rewriteOrphanLatchFilesAfterPartialClear`. Clearing every outstanding token (one
`clearMergeQuarantineByToken` call per token) routes EVERY one of those clears through the ACTIVE side
(`clearMergeQuarantineByToken`'s own `activeMatches`/`nonTwinPendingIndices` split correctly recognizes the
merged entry as a twin and excludes its pending reference from the PENDING clear path every time — it is
never a one-off), landing on whichever ONE key `Map` iteration visits first for the merged entry (insertion
order — stable across every clear call on the same entry). The first three (partial) clears stay IN-MEMORY
consistent regardless of the bug, since `replaceEntryEverywhere` re-points every key BY VALUE — but each
one's own write loop (`clearActiveEntryTokenAtKey`, gated by the SAME `armedKeys?.length ? armedKeys :
[key]` fallback) durably writes the reduced token set to ONLY that one key's own physical final, creating a
brand-new on-disk latch file there for the first time (no physical per-key file existed before — an
883e29bc degraded-divert boot-arm never writes one of its own). The FOURTH, LAST clear reaches
`clearMergeQuarantineByKey`'s full-lift branch — pre-fix, `keysToLift` collapses to that SAME one key, so
only its own `activeQuarantines` slot (and its own physical final) gets deleted. The entry's OTHER armed
key is NEVER deleted from `activeQuarantines`: it survives, in-process, holding a stale (should-be-empty)
token set, so the real repo at that key stays quarantined in-process for as long as the process keeps
running — and because that surviving map slot still points at an object whose `orphanLatchFiles` still
names the two orphan residue files, `clearMergeQuarantineByKey`'s own unreferenced-orphan sweep
(`sweepOrphanLatchFileIfUnreferenced`) finds them STILL referenced and leaves them on disk too, each one's
own on-disk `tokens` field frozen at whatever it held before the final clear (the already-tombstoned LAST
token, never actually removed from their bytes). **A daemon RESTART does not clear any of this — it makes
it WORSE:** PASS 1 re-reads each surviving orphan file at boot, and because it ALSO still carries BOTH
twins' own `resolvedKeys` forward (00fd29d7's own correct fix), it re-arms BOTH real repos, durably, from a
token that was already fully cleared in the prior process — measured directly (see Tests below): BOTH
reboot assertions fail pre-fix, not just the one left stuck in-process.

### The fix — the SAME shared helper family, extracted the same way `unionInformativeResolvedKeys` was

`armedKeys` is now unioned via a new sibling helper, `unionArmedKeys` (in `merge-quarantine.ts`, next to
`unionInformativeResolvedKeys`): the deduplicated union of every matched entry's own `armedKeys`,
normalized back to `undefined` when empty (never a cosmetic `armedKeys: []` on an ordinary pending-only
merge that was never armed anywhere — `divertRaiseEntry`'s own long-standing rule for this exact field).
`divertRaiseEntry`'s own hand-rolled computation (unchanged in behavior) was ALSO switched to call this
shared helper, so the two merge branches can no longer drift apart on this field the way they already had.
Post-fix, `keysToLift` correctly carries BOTH keys, so the full-lift clear deletes both `activeQuarantines`
slots AND correctly finds the two orphan residue files unreferenced, sweeping them too.

### Tests

Committed in `merge-quarantine-raise-protect-failure.mjs` (`*** CARD 3d27c045 ***`-tagged): d9 =
`r9/gone-subdir9` is genuinely unresolvable; M1 (no key, enteredAt 1000, becomes `base`), M2
(resolvedKeys=[Z9], enteredAt 2000) and M3 (resolvedKeys=[W9], enteredAt 3000) are three independent
pending-divert records for d9's own identity — M2 and M3 each graduate into a genuine 883e29bc twin at
boot. A fresh raise on d9 merges all three via `mergeTokenIntoPendingEntries`; the merged record is
asserted to carry BOTH Z9 and W9 forward in its own `armedKeys`. A PARTIAL clear (only m2's and m3's own
tokens, two of the four outstanding) is asserted to leave BOTH Z9's and W9's own real repo blocked, both
in-process AND after a fresh boot-module reimport + `reenterMergeQuarantinesAtBoot` — pinning that an
ordinary partial clear must never OVER-lift either key, the opposite failure from this card's own bug.
Clearing the remaining two tokens (the fourth/last clear) is then asserted, in-process, to leave NEITHER
Z9's nor W9's own real repo blocked, and to leave no stale entry (pending or an orphaned active arm) for
d9's identity — then a second fresh boot-module reimport confirms neither real repo is re-blocked after a
reboot either.

Proven RED on `main` (this card's own `00fd29d7` fix, sha `a7add825`, already applied — `merge-quarantine.ts`
was byte-identical between `a7add825` and `main`'s own tip at verification time) and GREEN after, via
`scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-raise-protect-failure.mjs --ref main`: exactly the five
`*** CARD 3d27c045 ***`-tagged assertions fail pre-fix (5 FAILURE(S), nothing else — every `00fd29d7`/
`d524d1c4`/`050a4428`/`4b06875f`/`d2582692`-tagged scenario, AND the new partial-clear-then-reboot leg,
stays green in BOTH phases), pass post-fix, tree restored clean. All 42 `merge-quarantine*.mjs` files run
serially, exit 0, under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1` — identical, since
`merge-quarantine.ts` reads neither. `pnpm --filter @loom/daemon guards`: all 30 guards pass.

### Do not

- Do not assume `replaceEntryEverywhere`'s own by-VALUE re-point (`64283e06`) is sufficient to keep a
  merged entry's OTHER armed key(s) alive through a later clear — it keeps the in-memory MAP slots
  consistent, but `clearMergeQuarantineByKey`'s own `keysToLift` and `clearActiveEntryTokenAtKey`'s own
  `armedKeysForEntry` both read the entry's OWN `armedKeys` field directly, with a fallback to the one key
  already in hand — a merge branch that drops that field silently reopens this exact gap at both call
  sites. (`clearTokenFromPendingIndices`'s own loops do NOT share this shape — see the gap's own
  description above for why — do not list it among these helpers again.)
- Do not hand-roll a second `armedKeys` union at a new merge branch — call the shared `unionArmedKeys`
  helper (the same one `divertRaiseEntry` and `mergeTokenIntoPendingEntries` both call), or a future merge
  branch drifts apart from the other two exactly the way `mergeTokenIntoPendingEntries` already had.
- Do not assume this gap is visible with only ONE matched twin — a single armed key collapsing to `[key]`
  via the fallback is indistinguishable from the correct answer; it takes at least TWO twins, each armed
  at a DIFFERENT key, for the drop to manifest as an observably wrong (too-narrow) key set.
- Do not read the surviving key's own in-process stuck state as the whole blast radius — the two orphan
  residue files this card's own repro leaves behind are an independent, SEPARATE consequence (the
  unreferenced-orphan sweep never runs against them either, since the stuck key's own surviving slot still
  "references" them) and are what actually carries the bug across a reboot; a fix (or a future regression)
  that only re-checks the in-process symptom can still miss the durable one.
- Do not touch `clearMergeQuarantineByKey`'s own `keysToLift`/`armedKeysForEntry` fallback-to-`[key]`
  shape as part of this card — the CR that found this gap ALSO found an independent armedKeys-lift
  asymmetry inside `clearMergeQuarantineByKey` itself; that is tracked on its own, separate card.
