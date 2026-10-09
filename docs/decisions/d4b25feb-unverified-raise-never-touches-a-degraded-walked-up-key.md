# d4b25feb — an unverified raise never appends into, or arms at, a degraded walked-up key

From the round-2 Code Review of `883e29bc` (reviewer `16eda3b3`, 2026-10-06) — PRE-EXISTING, merge-quarantine
fail-open, the RUNTIME (`enterMergeQuarantine`) twin of `883e29bc`'s own BOOT-TIME (`reenterMergeQuarantinesAtBoot`
PASS 1/1b) union fix. `883e29bc` stopped boot's own degraded-dual-arm branch from unioning a verified
sibling sharing a walked-up key — but `enterMergeQuarantine` itself reaches the identical shape through
THREE separate, un-fixed call sites, none touched by that card (its own scope was explicitly PASS 1/1b;
`8a1bc2ef` fixed `enterMergeQuarantine`'s `existing`/pending-merge branches for a DIFFERENT, narrower
defect — absorbing a cross-tier sibling pending entry — never this one).

## The three defect shapes

Fixture: `R` (a repo) with `X = R/nested` (its own separate repo, own `.git`) and `T = R/teamA` (a plain
subdir of `R`, no `.git` of its own — collapses onto `R`'s own canonical key the ordinary way, card
`7673d096`). `X` becomes unresolvable (unmounted/missing); `canonicalRepoLockKey(X)` then walks up to `R`'s
own real key `Kr` — a value never actually verified to be `X`'s own identity.

**(A) Raise-side append (the `existing` branch).** `enterMergeQuarantine`'s `existing` branch
(`activeQuarantines.get(key)`) unconditionally did `{...existing, tokens:[...existing.tokens, token]}` —
with no check that the RAISING repoPath (not merely `existing`'s own identity) is verified for `key`.
A raise on `X` while unmounted silently merged `X`'s token into `T`'s own, genuinely separate entry; a
later human `clearMergeQuarantineReporting(T)` then lifted `X`'s still-unconfirmed raise too.

**(B) Fresh-branch degraded arm (the "brand new entry" branch).** When `X` raises FIRST (no existing
entry at `key`, no pending match), this branch recorded `resolvedKey: key, armedKeys: [key]` and armed
directly into `activeQuarantines` at the degraded, walked-up `key` — the exact shape `883e29bc` fixed for
PASS 1/1b, reachable here through a wholly different, un-fixed call site. A later, genuine `T` raise then
walked into defect (A) and merged into `X`'s wrongly-armed entry — the two defects compound.

**(C) Pending-merge branch (found during this card's own gate-checkpoint, in scope by Lead ruling).** The
same root cause, reached when the raising repoPath already has its OWN pending (never-yet-resolved) latch:
`consumeMatchedPendingsIntoArmedEntry(allPendingIndices, key, fresh, true)` arms+writes at the degraded
`key` unconditionally, regardless of whether the raiser is verified for it.

## The fix

`enterMergeQuarantine` computes `verified = isRepoPathCurrentlyResolvable(repoPath)` ONCE, and gates every
`activeQuarantines`-at-`key` touch on it:

- The `existing` lookup (`activeQuarantines.get(key)`) only runs when `verified` — an unverified raiser
  never even LOOKS at whatever occupies the degraded key, let alone merges into it.
- The pending-merge branch only arms+writes via `consumeMatchedPendingsIntoArmedEntry` when `verified`;
  when `!verified`, it instead calls the new `mergeTokenIntoPendingEntries` — merging the fresh token into
  the matched pending entry/entries IN PLACE, never touching `activeQuarantines` and never deriving a
  write target from `key`.
- The brand-new-entry branch only arms at `key` when `verified`; when `!verified`, it diverts into
  `pendingUnresolvedQuarantines` via the new `writePendingDivertFile`, under a brand-new on-disk filename
  format (below) — mirroring `883e29bc`'s own divert, generalized here from boot to runtime.

## The on-disk format decision (per Lead ruling, gen 408)

Before inventing anything, the existing pending-entry machinery was checked for an existing format/naming
that already round-trips a never-resolved pending entry through a reboot — **it does, and this fix reuses
it almost entirely.** `reenterMergeQuarantinesAtBoot`'s PASS 1 read loop is FILENAME-AGNOSTIC: it reads
every `.json` file in `MERGE_QUARANTINE_DIR` via `readdirSync` and classifies each one purely by CONTENT —
`!resolvableNow && !entry.resolvedKey` diverts to `pendingUnresolvedQuarantines` with `sourceFile: f`,
whatever `f` happens to be (merge-quarantine.ts, the "no recorded resolvedKey... could NOT be verified"
branch). Likewise, every pending-aware clear/graduation path (`clearMergeQuarantineByKey`,
`clearMergeQuarantineByRecordedPath`, `activeMergeQuarantineFor`'s lazy-graduation tail,
`consumeMatchedPendingsIntoArmedEntry`, `deleteSourceLatchIfSuperseded`) already matches purely by
{@link directPathIdentity} (CONTENT) and treats `sourceFile` as an opaque string — none of them re-derive
or validate a hash from the filename itself. **Zero changes were needed anywhere in this existing
machinery.**

What did NOT already exist: a PRODUCTION call site that mints a brand-new pending entry's own on-disk file
at RUNTIME, under an arbitrary (non-key-derived) name — every existing writer either targets a canonical/
legacy key hash (`quarantinePathForKey`/`quarantinePathFor`) or recovers an ALREADY-ON-DISK file under
whatever name it was previously written. So this card adds exactly one new piece: a NEW, disjoint on-disk
filename format, `pending-<24hex>.json` (`PENDING_DIVERT_RE`), where the hash is
`sha256(directPathIdentity(repoPath))` — NEVER `canonicalRepoLockKey(repoPath)`, which is precisely the
degraded, walked-up value this format exists to avoid writing under. Determinism (the SAME identity
raising twice while still unresolvable reuses one file) is a convenience, not a correctness requirement —
every match against it is by entry CONTENT, never by filename.

**Disjointness, explicitly:** a canonical or legacy key hash is always a bare `<24hex>.json` with NO
prefix; a safety-tmp/ordinary-tmp residue always carries a `.tmp-...` suffix a bare `.json` final never
has. `pending-<24hex>.json` can therefore never collide with, or be mistaken for, any of them — this is
what lets the format skip `ef651188`'s own Phase 0 "at-risk" protection entirely: nothing else in this
module ever targets a `pending-`-prefixed name, so a pending-divert file is NEVER a boot write target, by
construction, and never needs a safety-tmp of its own.

**The four required properties, each verified:**
1. **Boot's own scan reads it back** — confirmed via `merge-quarantine-unverified-raise-divert.mjs`'s own
   ≥3-reboot scenarios (`raise-into-sibling-key-diverts`, `fresh-degraded-arm-diverts`,
   `second-unverified-raise-merges-in-place`) — zero boot-side code changes were needed.
2. **Graduation writes the canonical file BEFORE deleting the divert file** — already guaranteed by the
   PRE-EXISTING `consumeMatchedPendingsIntoArmedEntry` → `deleteSourceLatchIfSuperseded` ordering (the
   delete is called only `if (writeSucceeded)`); verified by `pending-divert-graduates-on-remount`.
3. **Clear-by-path finds and removes it** — already guaranteed by `clearMergeQuarantineByRecordedPath`'s
   own identity-based matching + `sweepOwnLatchFileUnlessOwnedElsewhere`; verified by
   `clear-by-path-lifts-pending-divert`.
4. **Clear-by-id round-trips** — required ONE small addition: `pendingLatchIdFor` (the sole id-derivation
   chokepoint, card `fd189d91`) gained a `PENDING_DIVERT_RE` branch mirroring its pre-existing
   `SAFETY_TMP_RE` one — hash the FULL basename, since `pending-<24hex>.json`'s own bare stem is not
   itself a valid 24-hex id (`QUARANTINE_LATCH_ID_PATTERN` would reject it). Verified by
   `clear-by-id-roundtrips-pending-divert`. Round 2 (Code Review `beea936c`, MINOR) extended this with a
   sibling `PENDING_DIVERT_TMP_RE` branch for a crash-left `pending-<24hex>.json.tmp-<pid>(-<hex>)?`
   residue — PASS 1b's own pre-existing "no resolvedKey, unresolvable" branch already recovers this shape
   into a proper pending entry with ZERO boot-side changes (a pending-divert entry never carries
   `resolvedKey`), so only the id-derivation needed the extra regex. Verified by
   `clear-by-id-roundtrips-crash-left-pending-tmp`.

## A fourth site found only by running the FULL corpus: `clearMergeQuarantineByToken`

`merge-quarantine-token-set.mjs` (a pre-existing, otherwise-unrelated test exercising the round-7 token-SET
semantics against a repoPath that is a raw, NEVER-created path — deliberately always unverified, since this
module "never touches git or the filesystem for the repoPath itself") went RED after the A/B/C fix alone:
`clearMergeQuarantineByToken` — the ONE in-process auto-clear path (`onTreeDeathSettled(true)` in
`git/worktrees.ts`/`git/batch-merge.ts`) — only ever checked `activeQuarantines.get(key)`. Before this card,
EVERY raise ended up armed in `activeQuarantines` somehow (even via the buggy degraded-arm shapes above),
so this lookup always found something. Once an unverified raise correctly diverts to
`pendingUnresolvedQuarantines` instead, `activeQuarantines.get(key)` always misses for it — the auto-clear
silently no-opped forever, UNDER-protecting nothing (the raise stays quarantined) but never actually
LIFTING it either, even once every raiser's kill is confirmed dead.

**Fix:** a new `clearPendingEntryByToken(repoPath, token)` — the pending twin of
`clearMergeQuarantineByToken`'s own `activeQuarantines` logic, same compare-and-clear SET semantics,
matching by `directPathIdentity` — is called as a fallback whenever `activeQuarantines.get(key)` misses.
The last remaining token delegates to `clearMergeQuarantineByRecordedPath` (the correct full sweep for a
still-unresolvable repoPath); a non-last token is written back in place via `writePendingDivertFile`,
reusing whichever filename the pending entry already has (its own `pending-*.json`, or a legacy/arbitrary
name if it predates this card).

## Interaction with `e1cb7d33` (commit `b74a2f70`) and card `2a6a8073`

`e1cb7d33` is untouched by this card: `writeMergeQuarantineLatch`'s own degraded-occupant guard and its two
opt-out families (`bootWriteLatch`, `enterMergeQuarantine`'s own write call sites) are unchanged. This
card's new `!verified` branches never call `writeMergeQuarantineLatch`/`consumeMatchedPendingsIntoArmedEntry`
at all — they route through the entirely separate `writePendingDivertFile`/`mergeTokenIntoPendingEntries`
instead, so `enterMergeQuarantine`'s own "4 opt-out write sites" (e1cb7d33's own enumeration) are
UNCHANGED in count; they are simply reached less often now (only when `verified`).

Card `2a6a8073` ("a fresh raise overwrites a pure-pending degraded occupant") names the "brand new entry"
branch specifically, with a VERIFIED raiser (`teamA`, which genuinely resolves) colliding with an unrelated,
currently-unresolvable pure-pending ghost occupying its own key. **That shape is UNCHANGED by this card —
still fully open, still reproduced by `merge-quarantine-degraded-occupant-guard.mjs`'s own
`fresh-raise-survives-reboot` scenario.** `verified` there is `true` (the raiser itself resolves), so this
card's new gate never engages; the raise still reaches the pre-existing, opted-out
`writeMergeQuarantineLatch` call and still overwrites the occupant's file, exactly as before.

That same test file's OTHER scenario, `pending-merge-fresh-raise-survives-reboot`, exercises the IDENTICAL
residual CLASS but with an UNVERIFIED raiser (`teamA` never exists on disk in that scenario) merging into
its own pending latch — THIS one IS closed as a direct consequence of this card's fix: `teamA`'s own raise
now diverts via `mergeTokenIntoPendingEntries` instead of ever reaching `writeMergeQuarantineLatch`, so it
no longer overwrites the degraded occupant `X`'s physical file at all. That scenario's own assertions were
updated to prove the NEW (fixed) behavior rather than the old (now-impossible) one — see its own inline
comments for the exact before/after.

**Net: 2a6a8073's own, specifically-named shape (a VERIFIED raiser) is untouched; a narrower, previously
undistinguished UNVERIFIED-raiser variant of the same residual class is closed as a side effect.**

## Round 2 (Code Review `beea936c`) — round 1 was NOT MERGEABLE

Round 1's divert design and the pending-file sweeps were verified sound; one CRITICAL and one MAJOR gap
remained in the CLEAR side, plus three documentation/robustness MINORs.

**CRITICAL — `clearPendingEntryByToken`'s last-token branch cleared the WRONG scope.** It delegated to
`clearMergeQuarantineByRecordedPath(repoPath)` — an IDENTITY-WIDE clear that lifts EVERY entry (active or
pending) sharing that repoPath's identity. Repro: `X` raises once while resolvable (`t1`, armed at its own
true key `Kx`), then again after becoming unresolvable (`t2`, diverted to pending) — the SAME identity now
legitimately carries TWO wholly independent entries. `clearMergeQuarantineByToken(X, t2)` correctly found
`t2`'s pending entry, but its last-token branch then lifted `t1`'s own, unrelated, still-outstanding active
entry too. **Fix:** remove ONLY the one matched pending entry directly — splice it out, lift its own
`armedKeys` (gated by `pendingEntryStillOwnsKey`, same as every other pending-sweep site), sweep its own
`sourceFile` via `sweepOwnLatchFileUnlessOwnedElsewhere`, sweep its own `orphanLatchFiles` — never delegate
to an identity-wide clear function. Verified by `clear-by-token-never-lifts-separate-active-entry-newer-first`
(≥3 reboots).

**A SECOND instance of the identical CRITICAL shape, found empirically while building the "both orders"
scenario the review asked for — in `clearMergeQuarantineByKey` itself, a function this card never touched
directly.** `clearMergeQuarantineByKey`'s own pending-sweep filter removed EVERY pending entry sharing
`identityRepoPath`'s identity, unconditionally — correct for `883e29bc`'s own legitimate shape (a diverted
pending entry IS the literal same object reference as the armed one, or shares its `armedKeys`), but this
card's own new "two independent entries, one identity" shape breaks that assumption: clearing `t1` (active,
via `clearMergeQuarantineByKey(Kx, X)` — the correct, targeted route once `X`'s historical key is known)
collaterally swept `t2`'s wholly unrelated pending entry too. Measured directly (a standalone repro script,
before writing the fix): confirmed the collateral deletion, confirmed the fix closes it, confirmed via a
`git diff` that this function was untouched by round 1. **Fix:** the pending-sweep filter now requires a
same-identity pending entry to ALSO be tied to the entry actually being cleared — same object reference,
shares one of the keys being lifted, OR the active entry's own `orphanLatchFiles` already names the pending
entry's `sourceFile` (the exact shape `97cff6db`'s own standalone-tracking-reference fold produces for a
colliding sibling's migrate source — never `===` the union, never armed, but legitimately swept together).
When nothing is armed at all (`entry` undefined — a pure-pending clear, e.g. card `f5c42043`'s own
multi-claimant design), the pre-existing unconditional identity sweep is kept, since there is no active
entry to confuse a pending one with. **This refinement was itself caught by running the FULL corpus a
second time** — the first draft (reference-or-armedKeys only, no `orphanLatchFiles` check) broke
`merge-quarantine-ancestor-tier-pending-divert.mjs`'s multi-claimant scenario AND
`merge-quarantine-pass1-migrate-union.mjs`'s `in-memory-twin-clear-destroys-degraded-file` scenario (the
one whose "THE FIX" assertions prove `97cff6db`'s own working behavior, deliberately out of this card's own
scope — see card `c9114934`, split out from this card by the Lead). Verified by `clear-by-token-never-lifts-separate-active-entry-older-first`
(≥3 reboots) plus the full corpus re-run clean.

**MAJOR — `clearMergeQuarantineByToken`'s pending fallback only ran when `current` was ABSENT.** This
card's own shape (`T` genuinely armed at `Kr`, `X`'s own raise unverified and diverted under that SAME
`Kr`) has `current` PRESENT (T's entry) but lacking `X`'s token — the old code returned immediately,
leaving `X`'s own in-process auto-clear permanently dead. **Fix:** fall back to
`clearPendingEntryByToken` whenever `current` doesn't hold `token` — not only when `current` is undefined.
`clearPendingEntryByToken` matches by `directPathIdentity`, so it can never touch `T`'s own tokens either
way. Verified by `clear-by-token-finds-pending-despite-sibling-occupying-key` (confirms both that `X`'s
entry lifts AND that `T`'s own tokens stay exactly `[tokT]`).

**MINOR (ruled "correct, don't redesign") — `writePendingDivertFile`'s own doc overclaimed.** It is called
not only by `enterMergeQuarantine`'s fresh-divert branch (which DOES mint a brand-new, disjoint
`pending-<24hex>.json` name) but also by `mergeTokenIntoPendingEntries` and `clearPendingEntryByToken`'s
own partial-clear branch, both of which rewrite an ALREADY-EXISTING pending entry's own `sourceFile` IN
PLACE — which can be a canonical-shaped name, a `.tmp-...` residue, or a filename shared by multiple
unresolvable claimants (card `882d6cff`). The disjointness guarantee applies ONLY to a freshly-minted
name, never to a reused `sourceFile` — the doc comment now says so explicitly. Also added: a
`fsyncQuarantineDir()` call after each write (this function's calls are never naturally batched the way
boot's own safety-tmp writes are, so each one fsyncs the directory on its own), and an explicit note that
this is a THIRD write site (alongside `bootWriteLatch` and `enterMergeQuarantine`'s own 4) that
intentionally never calls `writeMergeQuarantineLatch` — because its own write target is never a degraded
occupant's exclusive backing.

**MINOR — the shared-file overwrite `in-memory-twin-clear-destroys-degraded-file` reproduces is
PRE-EXISTING, not introduced by this card** (confirmed: it reproduces identically on `b74a2f70`, before
this card's own first commit) — out of scope here, split out and tracked on card `c9114934` per the
Lead's own ruling (round 3).

**Nitpick fixed:** a stale comment in `merge-quarantine-degraded-occupant-guard.mjs`'s own
`pending-merge-fresh-raise-survives-reboot` scenario (it claimed flipping that call site's own
`skipDegradedOccupantGuard` argument would reproduce a loss — that call site no longer reaches
`writeMergeQuarantineLatch` at all after this card's fix, so there is no such argument to flip there
anymore) was corrected to point at this card's own negative-control instead.

## Round 3 (Code Review `543456ed`) — round 2 was NOT MERGEABLE on one MAJOR

Round 2's own CRITICAL and MAJOR were verified fixed; one new MAJOR and three MINORs remained, found
largely because round 2's own fix (the identity-scan in `clearMergeQuarantineByToken`) is itself new
surface that needed the SAME discipline applied to it.

**MAJOR — `clearMergeQuarantineByRecordedPath` returned success before ever reaching its own pending
branch.** It cleared every ACTIVE match (now correctly narrow, per round 2's fix to
`clearMergeQuarantineByKey`) and returned immediately — never falling through to sweep a remaining,
INDEPENDENT pending entry for the same identity. A human's `/clear-by-path(X)` — exactly the route the
refusal text `assertRepoNotQuarantined` itself names — reported success while `X` stayed quarantined via
its own separate pending raise. **Fix:** this function now ALWAYS also sweeps every remaining
same-identity pending entry, never only when `matched.length === 0` — its own job is a BROAD,
identity-wide clear (unlike `clearMergeQuarantineByKey`'s own deliberately-narrow scope), so it must
finish what the narrow helper leaves behind. Verified by `clear-by-recorded-path-lifts-whole-identity`:
`assertRepoNotQuarantined(X)` passes, in memory and across ≥3 reboots.

**MINOR (ruled "include it") — `clearMergeQuarantineByToken`'s pending fallback couldn't find a SEPARATE
ACTIVE entry either.** The real repro (`X` nested under `R`): `t1` armed at `X`'s own true key `Kx`; `X`
unmounts; `t2` diverted to pending. `clearMergeQuarantineByToken(X, t1)` computes the DEGRADED key `Kr` —
`current` there is empty (or an unrelated sibling's) — and the only fallback (`clearPendingEntryByToken`)
searches PENDING only, so `t1`'s own auto-clear was permanently lost. **Fix:** a new identity-scan (by
`directPathIdentity`, never key) runs between the fast path and the pending fallback, finding `t1`'s own
entry at its historical TRUE key regardless of what `X`'s OWN degraded key currently resolves to — same
token-SET semantics, factored into a new shared `clearActiveEntryTokenAtKey(key, entry, token)` used by
both the fast path and this scan (so neither can silently diverge). Verified by redoing BOTH "both orders"
scenarios — `clear-by-token-never-lifts-separate-active-entry-newer-first`/`-older-first` — entirely
through `clearMergeQuarantineByToken` with NESTED `X` (never `clearMergeQuarantineByKey` directly; no
production caller — `git/worktrees.ts`, `git/batch-merge.ts`, `git/writer.ts`, `vault/versioner.ts` — ever
calls that function with a hand-derived key).

**A SECOND, symmetric instance of finding #3 (below), found empirically while testing finding #2's own
fix, before writing anything.** The brand-new `clearActiveEntryTokenAtKey` updated every `activeQuarantines`
slot but never touched a `pendingUnresolvedQuarantines` entry sharing the SAME object reference
(883e29bc's own boot-diverted twin) — the exact mirror image of finding #3's own `clearPendingEntryByToken`
gap, just reached from the opposite direction. A standalone repro script confirmed it: after one partial
clear, `listActiveMergeQuarantines()` reported TWO non-reference-equal objects for one identity — one
correctly updated, one stale with the just-cleared token still present. **Fix:** both
`clearActiveEntryTokenAtKey` and `clearPendingEntryByToken`'s own partial-clear branch now call the
existing `replaceEntryEverywhere(activeQuarantines, oldEntry, newEntry)` chokepoint — it already scans
`activeQuarantines` BY VALUE (robust against a stale `armedKeys`) and re-points any
`pendingUnresolvedQuarantines` entry sharing the exact reference, in one call, rather than hand-rolling a
narrower, direction-specific loop at each site.

**MINOR (include it) — `clearPendingEntryByToken`'s own partial-clear branch had the identical gap, named
directly.** Same fix as above (`replaceEntryEverywhere`), plus: the durable per-key rewrite loop is now
gated on `activeQuarantines.get(k) === updated` (confirmed still genuinely owned AFTER the re-point), never
blindly looping over a possibly-stale `armedKeys` snapshot. Verified by
`partial-clear-syncs-armed-twin-across-reboot-and-remount`: a manufactured 883e29bc-shape twin (nested `X`,
`resolvedKey=Kx`, two tokens) survives a partial clear as exactly ONE object, with the physical file at
`Kx` also durably correct — across ≥3 reboots while still parked, AND after remounting `X` and re-querying
directly (confirming graduation never re-unions the cleared token).

**MINOR (include it) — `assertQuarantineIdentityInvariantTestOnly`'s own invariant was now too strict.**
"At most one object per identity, always" would flag this card's own legitimate new shape (one active +
one independent pending entry, disjoint tokens) as a violation. **Fix:** the invariant now accepts exactly
TWO objects for one identity ONLY when one is genuinely active-only, the other genuinely pending-only, and
their token sets are completely disjoint — anything else (3+, or 2 that share a token — the exact
staleness the findings above fix) remains a violation. The reported-count comparison was also corrected to
compare against the total distinct OBJECT count (`new Set(allRaw).size`), never the identity count — one
identity can now legitimately own two objects, so the identity count alone under-counts. Verified by
`identity-invariant-accepts-two-legitimate-rejects-overlap`.

**Citations corrected:** the in-memory-twin clear-path defect (the shared-file overwrite
`in-memory-twin-clear-destroys-degraded-file` reproduces) was mis-cited in rounds 1-2 as card `d163aef5`
(a DIFFERENT, pre-existing card about PASS 2's own orphan re-persist) — it is actually tracked on card
`c9114934`, split out from this card by the Lead specifically for it. Fixed everywhere it was cited: this
record (the "Round 2" section above, the Do-not list below) and
`merge-quarantine-pass1-migrate-union.mjs`'s own `in-memory-twin` report string. Separately,
`writePendingDivertFile`'s own doc comment overstated that its write target is "never a degraded
occupant's exclusive backing" as an unconditional claim — true for a freshly-minted name, but a REUSED
`sourceFile` (the partial-clear/merge case) could in principle coincide with an unrelated occupant
elsewhere; that residual is card `2a6a8073`'s own, now cited explicitly in the comment rather than implied.

## Do not

- Do not append a raise's token into whatever `activeQuarantines.get(key)` returns without first checking
  `isRepoPathCurrentlyResolvable(repoPath)` (the RAISING repoPath, never `existing.repoPath`) — a degraded,
  walked-up `key` may already belong to a wholly unrelated sibling/ancestor's own entry.
- Do not arm a degraded, unresolvable repoPath directly into `activeQuarantines` at its own walked-up
  `key`, in ANY of `enterMergeQuarantine`'s three branches (existing, pending-merge, brand-new) — divert to
  `pendingUnresolvedQuarantines` instead, exactly like `883e29bc`'s own boot-time fix.
- Do not derive a pending-divert entry's on-disk filename from `canonicalRepoLockKey(repoPath)` — that is
  precisely the degraded, walked-up value this format exists to avoid writing under. Use
  `sha256(directPathIdentity(repoPath))`, under the disjoint `pending-<24hex>.json` format.
- Do not reuse `legacyQuarantineHashFor`'s own hash value (even though it happens to compute the identical
  `sha256(directPathIdentity(...))`) for a NEW write — that function's own doc freezes it for backward-compat
  MATCHING only; writing new data under its hash would blur that boundary for a future reader.
- Do not add a new boot-write site, or any special-casing in `reenterMergeQuarantinesAtBoot`, for the
  pending-divert format — PASS 1's own existing, filename-agnostic classification already handles it; the
  format was deliberately designed so boot needs ZERO changes.
- Do not forget `pendingLatchIdFor` (the one id-derivation chokepoint, card `fd189d91`) when adding a new
  pending-entry filename shape — a bare `pending-<24hex>` stem is not itself a valid 24-hex id
  (`QUARANTINE_LATCH_ID_PATTERN`); hash the FULL basename, mirroring the `SAFETY_TMP_RE` branch, or
  `quarantineLatchFileIdsFor`/`clearMergeQuarantineLatchFile` silently stop round-tripping for it.
- Do not assume gating `enterMergeQuarantine`'s own three branches is a complete fix without re-running the
  FULL `merge-quarantine*.mjs` corpus — `clearMergeQuarantineByToken`'s own `activeQuarantines`-only lookup
  was a FOURTH site this fix broke, found only by `merge-quarantine-token-set.mjs` (a test with no obvious
  relation to this card) going RED. Route it through the new `clearPendingEntryByToken` fallback.
- Do not conflate this card's own scope with card `c9114934`'s ("the clear-path loss of X's file via the
  in-memory twin", a BOOT-TIME `armQuarantineKey` union of two DIFFERENT identities genuinely sharing one
  TRUSTED `resolvedKey`) — that is a materially different, bigger-blast-radius shape (touches the shared
  `armQuarantineKey` primitive every boot pass uses), split out into its own card by Lead ruling and
  deliberately NOT addressed here.
- Do not assume `unionQuarantineEntries` is the right tool for merging two PENDING entries' tokens
  together — it also unions `armedKeys`, which a pure-pending entry must never carry (always `undefined`,
  never armed anywhere); `mergeTokenIntoPendingEntries` builds the merged entry by hand instead.
- Do not delegate a pending entry's last-token clear to any IDENTITY-WIDE clear function
  (`clearMergeQuarantineByRecordedPath`, or any future equivalent) — it will lift every entry (active or
  pending) sharing that identity, not just the one matched entry. Remove the matched entry directly.
- Do not assume a same-identity pending entry found during ANY clear is safe to sweep just because the
  identity matches — once this card's own fix lets one identity legitimately carry two INDEPENDENT entries
  (one active, one pending, from two different raises at two different times), every clear path that
  scans `pendingUnresolvedQuarantines` by identity (not just the two this round fixed) is a candidate for
  the same hazard. `clearMergeQuarantineByKey`'s own fix (same reference, shared armedKeys, or named in
  the active entry's own `orphanLatchFiles`) is the template — re-derive it per call site, never assume
  "identity match" alone is sufficient, and never assume a fix verified against ONE such function's own
  test suite rules out the same defect in a sibling function with its own independent pending-sweep logic.
- Do not trust a pending-sweep fix without re-running the FULL corpus a second time after refining it — the
  first-draft `clearMergeQuarantineByKey` fix (reference-or-armedKeys only) passed its OWN new scenarios
  but broke two PRE-EXISTING, unrelated scenarios elsewhere in the corpus; only the full re-run caught it.
- Do not let `clearMergeQuarantineByRecordedPath` (the broad, identity-wide human clear route) return
  immediately after clearing active matches — it must ALWAYS also sweep remaining same-identity pending
  entries, every time, never only when no active match was found; that narrow behavior belongs to
  `clearMergeQuarantineByKey` alone (round 2's own deliberate narrowing), not to this function's job.
- Do not call `clearMergeQuarantineByKey` directly to clear a repoPath's own token-level quarantine in a
  test or anywhere else — no production caller ever does (`git/worktrees.ts`, `git/batch-merge.ts`,
  `git/writer.ts`, `vault/versioner.ts` all use `clearMergeQuarantineByToken` exclusively); always exercise
  the real entry point, which now includes its own round-3 identity-scan fallback for exactly this case.
- Do not add a new call site that updates an `activeQuarantines` (or `pendingUnresolvedQuarantines`) slot
  in place without also considering whether the SAME object reference sits in the OTHER structure
  (883e29bc's own boot-diverted-twin shape) — use the existing `replaceEntryEverywhere(activeQuarantines,
  oldEntry, newEntry)` chokepoint, never a hand-rolled, direction-specific loop; this card's own round-3
  fix found and fixed the IDENTICAL gap independently in TWO different functions because the first fix
  didn't reach for it.
- Do not assume `assertQuarantineIdentityInvariantTestOnly`'s "at most one object per identity" invariant
  still holds after this card — exactly TWO is legitimate when one is active-only, one is pending-only, and
  their tokens are disjoint; update any FUTURE caller's own expectations accordingly, and compare
  `listActiveMergeQuarantines()`'s reported count against the total distinct OBJECT count, never the
  identity count (one identity can now legitimately own two objects).
- Do not cite card `d163aef5` for the in-memory-twin clear-path defect (`in-memory-twin-clear-destroys-
  degraded-file`) — that card is a different, pre-existing PASS-2-orphan-re-persist issue. The in-memory-twin
  defect is tracked on card `c9114934`.

## Verification

`test/merge-quarantine-unverified-raise-divert.mjs` — 14 scenarios, each its own child process, own fresh
`LOOM_HOME`: `raise-into-sibling-key-diverts` (defect A, ≥3 reboots), `fresh-degraded-arm-diverts` (defect
B, ≥3 reboots, plus the compound check that a later genuine sibling raise arms cleanly),
`second-unverified-raise-merges-in-place` (defect C), `pending-divert-graduates-on-remount` (convergence
once the path resolves again), `clear-by-id-roundtrips-pending-divert`, `clear-by-path-lifts-pending-divert`,
`negative-control-verified-raise-unchanged` (the ordinary, fully-verified path is byte-for-byte unchanged),
round 2's own four — `clear-by-token-never-lifts-separate-active-entry-newer-first`/`-older-first` (redone
in round 3 with NESTED X, entirely through `clearMergeQuarantineByToken`, ≥3 reboots each),
`clear-by-token-finds-pending-despite-sibling-occupying-key`, and
`clear-by-id-roundtrips-crash-left-pending-tmp` — and round 3's own three:
`clear-by-recorded-path-lifts-whole-identity` (finding #1, ≥3 reboots),
`partial-clear-syncs-armed-twin-across-reboot-and-remount` (findings #2's own symmetric gap + #3, ≥3 reboots
plus a remount), and `identity-invariant-accepts-two-legitimate-rejects-overlap` (finding #4).

`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-unverified-raise-divert.mjs --test
packages/daemon/test/merge-quarantine-token-set.mjs --test
packages/daemon/test/merge-quarantine-ancestor-tier-pending-divert.mjs --test
packages/daemon/test/merge-quarantine-pass1-migrate-union.mjs --test
packages/daemon/test/merge-quarantine-identity-split-sync.mjs --test
packages/daemon/test/merge-quarantine-migrate-source-owner-durable.mjs`: run TWICE — once at
`--ref afe1cfce` (round 2's own tip, isolating round 3's own incremental delta) and once at
`--ref b74a2f70` (the true original pre-fix parent, proving the full cumulative diff) — all RED on both
reverts, all GREEN restored, tree confirmed byte-identical after both, measured directly off the tool's
own summary (never hand-reasoned — and note the negative-control script's own revert/rebuild/restore cycle
genuinely mutates the working tree for its duration; checking the file mid-run, before its own completion
marker, reads a transient, not-yet-restored state — not a real regression).

All 27 `merge-quarantine*.mjs` files re-run SERIALLY, each its own process, THREE times across this card's
three review rounds: all green, `exit=0` for every file every time. The 12 other test files outside that
family calling `enterMergeQuarantine`/`clearMergeQuarantineByToken` (kill-confirm, batch-worktree,
vault-commit, deploy-own-project, etc.) also re-run clean across rounds — 3 timing-sensitive
kill-confirm-family failures were observed in total (git child kill-confirmation under a fixed ms budget;
nothing touching quarantine key/identity logic), each confirmed a host-load flake by a clean, deterministic
retry immediately after, never claimed as "pre-existing" without that retry evidence.
`merge-quarantine-reunion-service.mjs` occasionally misses its own 10s budget on this host, on `main` too
(a separate, pre-existing card, not this one's). `pnpm --filter @loom/daemon guards` — all 30 guards pass.
