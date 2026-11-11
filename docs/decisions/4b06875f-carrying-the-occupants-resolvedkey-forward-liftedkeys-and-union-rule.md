# 4b06875f — carrying the occupant's own on-disk resolvedKey forward (liftedKeys discriminator, union rule, post-union filter)

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 4b06875f — carrying the occupant's own on-disk `resolvedKey` forward (Round 1, SUPERSEDED — see Round 2 below)

Card `4b06875f`, closing the "ACCEPTED RESIDUAL" in `37452ddd`'s own record: `toPersist` (in `protectOccupantContentBeforeDelete`,
`merge-quarantine.ts`) carried the occupant's own on-disk `parsed.resolvedKey` forward, gated by a single
physical-key-equality check — EQUAL (self-consistently filed) ⇒ never carry (the `82032b5c`/`c9114934`
collision shape); DIFFERENT (misfiled twin) ⇒ carry (the `883e29bc` twin shape this card exists to fix).

**Round 2 (Code Review, two findings) proved this guard insufficient — see that section below for the
corrected discriminator, the corrected caller list, and the corrected field-survival trace.** The content
that used to sit here (the single-check "guard" description, a Round-1-only two-direction discrimination,
and a field-survival trace citing `path.basename(final, ".json")`) has been folded into Round 2's own
fuller versions below rather than duplicated — Round 1's own empirical probes (the collision-shape and
twin-shape measurements) still hold as *reported*, but the GUARD they were measuring is no longer the
guard that shipped; read Round 2 for what actually ships.

### Relationship to card `398f476c`

Orthogonal — no sequencing dependency, in EITHER round. `398f476c`'s own scope is the IDENTITY-MODEL
problem of a UNION object representing more than one losing identity's own queryability at once
(token-set-based identity tracking; touches `unionQuarantineEntries`/`armQuarantineKey`/
`activeMergeQuarantineFor`). This card's own union-rule change (Round 2) is narrower: it decides what a
TWO-SIDED union does with ONE scalar field (`resolvedKey`), never which identity wins token-level
ownership of a union overall.

### `armedKeys` — left unfixed (Lead ruling)

Unchanged from the ACCEPTED RESIDUAL section in `37452ddd`'s own record, in both rounds — still fail-closed (over-blocking),
still lower priority, still not addressed.

## Follow-up 4b06875f, Round 2 — a `liftedKeys` discriminator, a union rule, and a post-union filter

Code Review of commit `7282d183` (Round 1's own landed commit) found two further findings, both before any
Round-2 fix was written:

- **Finding 1** — the physical-key-equality guard asks the WRONG question: "does the occupant's
  `resolvedKey` equal the one key `final` is physically filed under right now" never discriminates a
  SECOND armed key of the SAME dual-armed entry that final's write is protecting. Repro (Probe B,
  `merge-quarantine-runtime-union-provenance.mjs`, scenario `4b06875f-dual-arm-clear-resurrection`): Y
  dual-armed at `[Ky, K2]` (legacy stale-`resolvedKey` shape); X degraded, physically at `hash(K2)`, with
  X's own `resolvedKey = Ky` (the OTHER half of Y's own dual-arm, never the key the protect call is
  physically touching). W raises at K2 (W's own canonical key), hitting Y's `existing` branch — the
  Round-1 guard CARRIES `Ky` into X's own protective copy, even though `Ky` is Y's OWN other armed key,
  the very entry this protect call is protecting X FROM.
- **Finding 2** — `readPendingDivertFileAt`'s own field whitelist (`merge-quarantine.ts:2103` region, as it
  stood at `7282d183`) never read `resolvedKey` back off an on-disk pending-divert file at all, and
  `unionQuarantineEntries`'s bare `{...older}` spread let whichever side was OLDER win for any field not in
  its own explicit list — including `resolvedKey`, which wasn't in that list. So even when the raise-side
  guard correctly decided to CARRY `resolvedKey` forward, that value was silently dropped the instant it
  had to union with an EXISTING, OLDER on-disk pending-divert record for the same identity — age-dependent
  (a NEWER pre-existing pending file did not trigger the drop). Repro: Probe C (described under Round 1's
  own Tests, still present in `merge-quarantine-raise-protect-failure.mjs`) plus a no-raise control and a
  newer-pending-file variant, all confirming the mid-window (pre-reboot) in-memory state was fine — only
  the disk round-trip (write via union, re-read at next boot) lost the field.

### The corrected discriminator — `liftedKeys`, computed by each caller from what it already has in scope

`excludeLiftedResolvedKey(resolvedKey, final, liftedKeys)` (`merge-quarantine.ts:1772`) is the ONE place
that decides whether an occupant's own `resolvedKey` may ride onto a protective copy — called BOTH before
any union (on the freshly-read `toPersist`) and AGAIN after one (on whatever `toWrite` the union
produced), so a union can never reintroduce a key this chokepoint already excluded. It excludes on EITHER
condition:

- `resolvedKey` is a member of `liftedKeys` — every key the CURRENT clear/raise operation is itself
  touching, computed by the caller (see the full list below) — OR
- it names the same key `final` is physically filed under right now, via the SAME cut-at-first-`.json`
  technique `pendingLatchIdFor` already established (card `6237bef6`) for telling an ordinary
  `<hash>.json` final apart from a `<hash>.json.tmp-<pid>` tmp residue, since `protectForeignTmpResidueBeforeSweep`
  reaches this same function with the latter shape, not just the raise side's ordinary `.json` shape. This
  is a **caller-independent fallback**, kept deliberately: it is the one part of the guard that degrades
  safely even if some future caller forgets to thread a complete `liftedKeys`. (**Correction, Finding 3**:
  Round 1's own text here previously stated `path.basename(final, ".json")` — that expression is WRONG for
  a tmp-residue path, since `path.basename(path, ext)` only strips `ext` on an exact trailing match; it
  silently fails to strip `.json.tmp-<pid>`, miscomputing the physical key and incorrectly carrying
  `resolvedKey` forward in a self-consistent shape. This was caught by a REAL regression in
  `merge-quarantine-pass1-degraded-union-guard.mjs`'s `d2582692-clear-resolvable-protects-foreign-occupant`
  scenario during Round-2 verification, not reasoned about in the abstract — see that test for the repro.)

**Every caller, with its own `liftedKeys` computation — re-grep the symbol names below rather than
trusting these line numbers, which have already moved twice across rounds:**

- **Clear side, the TOP-LEVEL clear shares ONE scope** — `deleteMergeQuarantineLatchByKey(key,
  clearingRepoPath, clearedEntry, clearIdentity, liftedKeysOverride?)` (`merge-quarantine.ts:1455`)
  computes `liftedKeys` from `liftedKeysOverride ?? new Set([key, ...(clearedEntry?.armedKeys ?? [])])`
  (`:1460`) and threads it to all four of its own protect calls: the `clearingRepoPath`-gated
  `protectDegradedOccupantBeforeDelete` call, the `foreignPending`-gated
  `protectOccupantContentBeforeDelete` call, the `clearedEntry`-gated
  `protectUnincorporatedOccupantBeforeDelete` call, and (via its own call to
  `protectForeignTmpResidueBeforeSweep`, which forwards to its own `protectOccupantContentBeforeDelete`
  call) the tmp-residue site. `clearMergeQuarantineByKey`'s OWN top-level loop over `keysToLift` (`:3234`
  as of this writing) calls this with NO override — `clearedEntry.armedKeys` IS already the correct,
  non-stale set there (it's the entity actually being cleared, looked up fresh at this function's own
  top, never a snapshot from an earlier collection).
- **Three OUTER loops pass `liftedKeysOverride` explicitly** (Code Review `be296830`, Minor 1, two passes
  — see "Minor 1" under "Round 4" below for the full history, including a direction mistake caught and
  fixed BEFORE landing), each iterating a COLLECTION of entries gathered earlier by identity match:
  `clearTokenFromPendingIndices`'s own loop (`:2712` as of this writing — this one has NO enclosing
  top-level lift, since `clearMergeQuarantineByToken` calls it BEFORE touching any active entry);
  `clearMergeQuarantineByKey`'s OWN matchedPending loop (`:3269` — **CORRECTED attribution**: an earlier
  draft of this record wrongly placed this loop in `clearMergeQuarantineByRecordedPath`; it is the SAME
  function as the top-level loop immediately above, in its own `pendingUnresolvedQuarantines.filter`
  callback); and `clearMergeQuarantineByRecordedPath`'s own separate matchedPending loop (`:3443`, a
  genuinely different function from the previous one, clearing an identity's EVERY matched active entry
  first and then sweeping pending). **Each now computes `liftedKeys = (keys the enclosing operation
  already lifted) ∪ ownedArmedKeys`**, where `ownedArmedKeys = p.entry.armedKeys FILTERED by
  entryStillOwnsKey` — `keysToLift` for `clearMergeQuarantineByKey`'s own loop; a newly-collected
  `activeLiftedKeys` (every key the matched-active phase above it lifted) for
  `clearMergeQuarantineByRecordedPath`'s own loop; nothing additional for `clearTokenFromPendingIndices`,
  which has no enclosing lift at all. `ownedArmedKeys` is snapshotted ONCE, immediately before the loop;
  the per-key ACT decision (whether to delete/protect a given key at all) stays a SEPARATE, PER-ITERATION
  `entryStillOwnsKey` check inside the loop body, unaffected by the snapshot — this is the shape every one
  of these three loops already had BEFORE any of this card's own changes, just now also passing an
  explicit override alongside it. **Why `ownedArmedKeys` must be FILTERED, never the whole list:**
  `excludeLiftedResolvedKey` DROPS a `resolvedKey` that is a member of `liftedKeys` — dropping a
  legitimate binding is what UNBLOCKS a repo after reboot, so naming an UNOWNED key in `liftedKeys` is the
  FAIL-OPEN direction, never a safe over-inclusion; see "Minor 1" below for the full correction and why an
  earlier landed commit (`f6ccb810`) had this backwards. Historical note: BEFORE this fix existed at all,
  each of these three loops passed `p.entry` as `clearedEntry` with NO override — `deleteMergeQuarantineLatchByKey`'s
  own default then derived `liftedKeys` from `p.entry.armedKeys` WHOLESALE (unfiltered AND with no way to
  fold in an enclosing lift), which is the exact under-reporting/over-reporting defect this fix closes.
- **Raise existing-branch** (`merge-quarantine.ts:2393`) — `liftedKeys = new Set(armedKeysForEntry)`, reusing
  the SAME `armedKeysForEntry` the write-every-armed-key loop already computes a few lines above; threaded
  to `protectUnincorporatedOccupantBeforeDelete` and `resolveRaiseOverwrite`.
- **Raise no-existing front door** (`merge-quarantine.ts:2487`) — `liftedKeys = new Set([key])` (nothing
  else is armed yet at this key); threaded to `protectDegradedOccupantBeforeDelete` and
  `resolveRaiseOverwrite`.
- **`resolveRaiseOverwrite`** (`merge-quarantine.ts:2027`) itself takes `liftedKeys` as a parameter and
  forwards it to its own internal `protectOccupantContentBeforeDelete` call — it is reached ONLY from the
  two raise sites above, never independently, so it never computes its own.

**`liftedKeys` is complete only up to `armedKeys` completeness** — every computation above (the top-level
`clearedEntry.armedKeys`, the Round-3/4 `liftedKeysForEntry` unions, `armedKeysForEntry`) assumes the
entry object it reads from carries a complete `armedKeys`. A re-pointed `toWrite`/`kept` object landing in two
slots at once (the double-fault branch this card's own "Follow-up 37452ddd" section documents) can lack
`armedKeys` for a key it nonetheless physically occupies — this is FAIL-CLOSED (the key is simply never
treated as "lifted," never wrongly excluded-as-lifted), the same documented residual as `armedKeys`
itself (see "left unfixed (Lead ruling)" above), not a new gap this round introduces.

Verified by hand against all three shapes: Probe B's existing-branch raise (`liftedKeys={Ky,K2}`, `Ky` ∈
set ⇒ excluded, FIXED); the original `4b06875f` twin (no-existing front door, `liftedKeys={Kr}`, `Ks` ∉ set
⇒ carried, unchanged); the `82032b5c`/`c9114934` collision (`clearedEntry.armedKeys=[ky]`, `liftedKeys={ky}`,
occupant's own tautological `resolvedKey=ky` ∈ set ⇒ excluded, unchanged).

**Why the physical-key check is kept too, alongside `liftedKeys`**: it needs no threading at all — it's
computed purely from `final`'s own bytes, so it's a structural lower bound that holds whenever a caller's
own `liftedKeys` is correctly populated (the physical key being read IS, by construction, one of the keys
the operation touches). A FUTURE call site that forgets to thread `liftedKeys` correctly still gets the
single-key collision case caught by this fallback alone.

### The union rule — `unionQuarantineEntries` (`merge-quarantine.ts:612`), SCOPED (Round 3 correction)

**Correction (Round 3, Code Review `a61d0bec`) — this rule is now OPT-IN, never the function's default.**
The text below describes the EXPLICIT rule exactly as Round 2 shipped it, but Round 2's own mistake was
applying it to EVERY caller of `unionQuarantineEntries` (including `armQuarantineKey`, the chokepoint
every boot-time dual-arm AND migrate-consolidation union reaches) — see "Round 3" below for the
reproduced boot fail-open this caused and the scoping fix. `unionQuarantineEntries` takes an optional
third argument, `{ explicitResolvedKeyRule?: boolean }` (`merge-quarantine.ts:612`), defaulting `false`
(the pre-card `{...older}` semantics — `older.resolvedKey`, unconditionally, regardless of `newer`'s own
value). Only the two protect/pending-divert call sites below pass `true`:

```
const resolvedKey = !options?.explicitResolvedKeyRule ? older.resolvedKey
  : older.resolvedKey === newer.resolvedKey ? older.resolvedKey
  : older.resolvedKey === undefined ? newer.resolvedKey
  : newer.resolvedKey === undefined ? older.resolvedKey
  : undefined;
```

With the explicit rule active: equal (including both undefined) ⇒ keep it. One side undefined ⇒ keep the
other, AGE-INDEPENDENT (this is what makes Finding 2's own age-dependence vanish — verified directly:
Probe C's own "older pending file with no resolvedKey" and its "newer pending file with no resolvedKey"
variant now both correctly preserve the carried key, regardless of which side is older). Both set and
genuinely DIFFERENT ⇒ fail closed (`undefined`) — this function has no `liftedKeys` context of its own to
decide which of two conflicting keys is correct, and guessing risks reopening `82032b5c`. "Fail closed"
here means: the merged record's `resolvedKey` is dropped entirely for this one on-disk generation — no
worse than the pre-`4b06875f` baseline **for the two protect/pending-divert call sites this rule is
scoped to** — until a LATER protect call on the same identity re-reads `final` fresh and re-derives it
correctly (every call recomputes from `final`'s own bytes, so this is not a permanent loss). **This "no
worse than baseline" claim does NOT extend to a caller the rule isn't scoped to** — see "Round 3" below
for the case (a boot-time migrate union landing on `armQuarantineKey`) where applying it WOULD have been
strictly worse than the legacy rule it replaced.

The two scoped call sites are `unionIntoOnDiskPendingEntry` (`merge-quarantine.ts:2163`, called from
`reconcilePendingDivertTarget`, which both `mintPendingDivert` and `protectOccupantContentBeforeDelete`
route through) and the `atFilenameIdx` union inside `protectOccupantContentBeforeDelete` itself
(`merge-quarantine.ts:1856`). Every other caller of `unionQuarantineEntries` — `armQuarantineKey`
(`merge-quarantine.ts:677`, reached from every boot-time dual-arm/migrate union via
`armKeyUnlessDegradedCollision`/`armCurrentKeyUnlessDegradedCollision`),
`consumeMatchedPendingsIntoArmedEntry`'s own `matched`/`raiserUnion`/`foreignUnion` unions, and the boot
safety-tmp `sourcesOnlyUnion` helper — passes no options and gets the legacy rule.

**Correction (Round 3) on the reader claim below** — the ORIGINAL text here (Round 2) claimed the reader
fix (`readPendingDivertFileAt` carrying `resolvedKey` back off disk) was necessary for Probe C's own
"one side undefined" case to work. Round-3 Code Review `a61d0bec` found this claim UNVERIFIED: reverting
*only* the reader line left every committed scenario GREEN, because Probe C's own fixture never puts a
real `resolvedKey` on the side the reader would have to recover — its OLDER pending file carries NO
`resolvedKey` at all, so the reader returning "absent" either way changes nothing there. The reader's
OWN discriminating test is `merge-quarantine-raise-protect-failure.mjs`'s `4b06875f` Probe E (added
Round 3) — see "Round 3" below for why Probe E, not Probe C, is the one that actually needs the reader,
and why the pending file there must be written AFTER boot (never before — see Probe E's own comment for
the "two bugs cancel out" trap that shape avoids).

### The post-union filter — re-applying the SAME exclusion to whatever the union produced

Even with `liftedKeys` correctly excluding a key PRE-union, `reconcilePendingDivertTarget`'s own union
against an on-disk sibling, and/or the `atFilenameIdx` union against an in-memory sibling
(`merge-quarantine.ts:1856-1857` — re-grep `const toWriteUnfiltered` rather than trusting this line number
as this file keeps moving), can still PRODUCE a `resolvedKey` that needs the SAME exclusion applied
again — a union's own job is "combine two records," not "respect what a DIFFERENT function already decided
to exclude." `merge-quarantine.ts:1862-1864` re-applies `excludeLiftedResolvedKey` to whatever
`toWriteUnfiltered.resolvedKey` is, before it becomes `toWrite` — the SAME helper, never a second,
independently-written check, so the two can never drift apart.

**Required repro** (manager's own scenario, Probe D — `merge-quarantine-runtime-union-provenance.mjs`,
scenario `4b06875f-post-union-filter-clear-sticks`): S dual-armed `[Ks, Kr]`; D physically at `hash(Kr)`
(S's own SECOND armed key) with `resolvedKey = Ks` (S's own PRIMARY key); D ALSO has a pre-existing, OLDER
pending-divert file already carrying `resolvedKey = Ks` (simulating an earlier, separate, legitimate
carry). R raises at `Kr`, hitting S's `existing` branch — `liftedKeys = {Ks, Kr}` correctly excludes `Ks`
PRE-union (`toPersist.resolvedKey = undefined`). But the union against D's own older pending file (which
already carries `Ks`) would otherwise let it SURVIVE under "one side undefined → keep the other" — WITHOUT
the post-union filter, `Ks` reintroduced; S then clears its own quarantine, reads unblocked in-process, but
is BLOCKED AGAIN after a reboot (`assertRepoNotQuarantined(s).ok === false`) — the clear-sticks invariant
violated. WITH the filter, `Ks` is excluded again post-union, S's clear genuinely sticks across a reboot,
and D's own identity (its own tokens) stays independently enforced throughout via direct identity.

Committed test-only FIRST (`6d4d2e61`), confirmed RED when ONLY the post-union filter is removed (keeping
the `liftedKeys` pre-union exclusion and the union rule intact) — note that reverting ALL of Round 2 at
once does NOT discriminate this probe: the pre-Round-2 reader gap accidentally masks the carry (the SAME
"two bugs cancel out" phenomenon Probe B's own clear-side attempt hit — see that scenario's own comment),
so the meaningful RED proof is the targeted single-line removal, not a blanket revert.

### Two-direction discrimination, repeated against the FINAL code (all three directions)

1. `excludeLiftedResolvedKey` forced to always return its input unchanged (both call sites, pre- and
   post-union, defeated at once via the one shared helper): `clear-by-path-still-proceeds-and-protects`
   went RED on "Y's OWN clear genuinely STICKS" — the two-layer guard is still load-bearing for the
   `82032b5c`/`c9114934` invariant.
2. `excludeLiftedResolvedKey` forced to always return `undefined`: 4 of the `4b06875f` checks went RED
   (the original twin check, the no-second-raise variant, Probe C's own main assertion, and its
   newer-pending-file variant) — reproducing the original bug exactly, confirming the guard is still what
   carries the key forward at all.
3. Post-union filter alone removed (described above under Probe D): RED on Probe D specifically.
All GREEN restored after each. `pnpm --filter @loom/daemon negative-control` against the real (uncommitted)
diff: RED on `HEAD` (pre-Round-2), GREEN after, tree restored byte-identical.

### A unit-level check of the union rule's three cases, and a residual it found

`merge-quarantine-raise-protect-failure.mjs`'s `4b06875f-union-both-diff` scenario (case 3/3, both SET and
DIFFERENT): confirmed the `S`-side key is correctly excluded. Building it ALSO surfaced a separate,
UN-FIXED residual, reported rather than silently dropped: D's own IN-MEMORY pending-divert entry — loaded
by PASS 1 at BOOT, sitting in `pendingUnresolvedQuarantines`, never touched by the current raise at all —
is a SEPARATE copy from the fresh disk re-read `reconcilePendingDivertTarget` uses for the FIRST union. The
`atFilenameIdx` union (`merge-quarantine.ts:1856-1857`) then unions AGAIN against that STALE copy, which
still carries its own ORIGINAL `resolvedKey` (a wholly UNRELATED third-party key — never in this raise's
own `liftedKeys`, never matching `final`'s own physical key either) completely unfiltered — it was loaded
before this raise ever ran, so `excludeLiftedResolvedKey` never touched it. The first union's own correct
"both different ⇒ `undefined`" verdict is then treated by the SECOND union as "nothing to see here, keep my
own value" rather than "already adjudicated, stay dropped," and the unrelated key survives where the
originally-conflicting key correctly does not. The test itself asserts only what is true (the direct
conflict excludes correctly) and documents the residual inline rather than asserting something false.

## Follow-up 4b06875f, Round 3 (Code Review `a61d0bec`) — scoping the explicit union rule away from boot-time arming

Code Review of commit `e36a5974` (Round 2's own landed commit) BLOCKED it on one CRITICAL finding, one
MAJOR (the reader claim corrected above), and one Minor (the `liftedKeys` precision fix folded into "The
corrected discriminator" section above). This section covers the CRITICAL finding and its fix.

**The finding:** Round 2's own explicit `resolvedKey` union rule applied GLOBALLY — every caller of
`unionQuarantineEntries` got it, because the function had no way to opt out. `armQuarantineKey`
(`merge-quarantine.ts:677`) is the chokepoint every boot-time dual-arm AND migrate-consolidation union
reaches (via `armKeyUnlessDegradedCollision`/`armCurrentKeyUnlessDegradedCollision`), and it is a REAL
production path, not a protect/pending-divert edge case. A dual-armed entry's own legacy
`resolvedKey` field (the `883e29bc` self dual-arm shape: a correctly-filed final whose own stored
`resolvedKey` names a SECOND key to arm at) can collide with an UNRELATED `resolvedKey` a boot-time
MIGRATE union stamps onto a different, co-located latch (a stale-key-filed sibling resolving to the
SAME current key) — both set, genuinely different, so the explicit rule's own "fail closed ⇒ undefined"
branch drops the legacy dual-arm's `resolvedKey` entirely. Unlike the protect/pending-divert case this
rule was designed for, there is no LATER re-derivation here: the dropped value gets durably WRITTEN
(the boot migrate-write pass persists whatever `byRepoKey` ends up holding), so the NEXT boot's own self
dual-arm mechanism has nothing left to re-arm the second key with — a REPRODUCED fail-open, in BOTH
age orders (the migrate branch's own `resolvedKey` stamp is always the migrating file's OWN currentKey,
which differs from the legacy field regardless of which side the union calls "older").

**The fix:** `unionQuarantineEntries` takes the `{ explicitResolvedKeyRule?: boolean }` option described
under "The union rule" above. Only `unionIntoOnDiskPendingEntry` and `protectOccupantContentBeforeDelete`'s
own `atFilenameIdx` union pass `true`. Every other caller — `armQuarantineKey`,
`consumeMatchedPendingsIntoArmedEntry`'s `matched`/`raiserUnion`/`foreignUnion` unions, and the boot
safety-tmp `sourcesOnlyUnion` helper — passes no option and gets the legacy `{...older}` semantics (the
bare `older.resolvedKey`, unconditionally). `consumeMatchedPendingsIntoArmedEntry`'s own `matched` and
`raiserUnion` results are UNAFFECTED either way, since both are immediately overwritten with an explicit
`resolvedKey: key` right after the union — only `foreignUnion` lets whatever the union computed flow
through unmodified, which is exactly why it needed to be confirmed on the legacy side.

**Required repro** (`merge-quarantine-runtime-union-provenance.mjs`, scenario
`4b06875f-migrate-union-drops-dual-arm`): Y dual-armed via the legacy stale-`resolvedKey` shape (Y's own
real file at `hash(Ky)`, its own stored `resolvedKey` is `Kw`, mirroring `buildDualArmFixture`) — Y's own
`enteredAt` is deliberately OLDER. A second latch, filed under a STALE key (never Y's own), with
`repoPath` = Y's own subdirectory (so its CURRENT canonical key resolves to `Ky` too), triggers PASS 1's
own migrate branch, which stamps its in-memory `resolvedKey` to `Ky` and falls through to the SAME
primary-arm code as any ordinary file — unioning into Y's already-dual-armed entry at `Ky`. Boot-0 itself
dual-arms `Ky`/`Kw` correctly (the union's resolvedKey LOSS is invisible in-memory: `armedKeys` is set
directly regardless of what the union computes for the `resolvedKey` field) — only a FRESH REBOOT, which
re-reads the now-corrupted `Ky` file from disk, exposes it. Confirmed RED on `e36a5974` (the global rule)
and GREEN after scoping, via `pnpm --filter @loom/daemon negative-control`. The OPPOSITE age order (the
migrating latch older than Y) is a PRE-EXISTING, separately-carded fail-open under the LEGACY rule too
(board card `48bda567`) — deliberately not fixed or asserted by this scenario.

### Do not (Round 3)

- Do not pass `{ explicitResolvedKeyRule: true }` to `unionQuarantineEntries` from `armQuarantineKey`,
  from `consumeMatchedPendingsIntoArmedEntry`'s `foreignUnion`, or from any OTHER caller reached by
  boot-time dual-arm/migrate consolidation — only the two protect/pending-divert call sites named above.
  Confirmed: applying it globally reproduces a boot fail-open (`4b06875f-migrate-union-drops-dual-arm`).
- Do not trust `readPendingDivertFileAt`'s own resolvedKey field being read back correctly merely because
  Probe C stays GREEN — Probe C's own OLDER pending file never carries a real `resolvedKey`, so it cannot
  discriminate the reader at all (see the correction under "The union rule" above). Use Probe E
  (`merge-quarantine-raise-protect-failure.mjs`) for that, and if either probe is ever rewritten, re-check
  which side of its union genuinely needs a disk-read resolvedKey rather than assuming the existing
  "in-memory boot-loaded copy" fallback will carry it regardless.
- Do not write Probe E's own pre-existing pending file BEFORE the first `reenterMergeQuarantinesAtBoot`
  call (the shape every other probe in this file uses for "a prior protect already happened") — PASS 1's
  own untouched boot-time reader would then load it into `pendingUnresolvedQuarantines`, and the
  `atFilenameIdx` in-memory union would rescue `resolvedKey` regardless of whether
  `readPendingDivertFileAt` itself works, defeating the probe's own purpose silently (it would stay GREEN
  under a reverted reader too). Write it AFTER boot instead, so the only route to its own `resolvedKey` is
  the fresh disk read at reconcile time.

## Follow-up 4b06875f, Round 4 (Code Review `be296830` of commit `fd03e317`) — liftedKeysOverride precision, and Probe E's own realism answered

### Minor 1 — the override under-reported an enclosing clear's own already-lifted keys, and the ownership gate was precomputed

Round 3's own first `liftedKeysOverride` draft (landed in `fd03e317`) computed `actuallyLiftedKeys =
(p.entry.armedKeys ?? []).filter((k) => entryStillOwnsKey(k, p.entry))` ONCE, before the per-key loop, and
passed exactly that filtered set as the override. Code Review `be296830` found two problems with this.

1. **Under-reporting.** `clearMergeQuarantineByKey`'s own top-level loop (`:3209` as of this writing)
   deletes every key in `keysToLift` from `activeQuarantines` BEFORE its own matchedPending loop ever runs.
   `entryStillOwnsKey(k, p.entry)` for any `k` ALSO in `keysToLift` therefore reads `false` regardless of
   whether `p.entry` itself ever held that key — the draft's filter silently dropped it from the override,
   so an occupant discovered via the matchedPending loop could wrongly carry forward a `resolvedKey` that
   named one of those keys, even though THIS SAME overall clear operation was lifting it. The fix unions
   the override with whatever the enclosing phase already lifted (`keysToLift` for
   `clearMergeQuarantineByKey`'s own loop; a newly-collected `activeLiftedKeys` — every key the
   matched-active phase lifted — for `clearMergeQuarantineByRecordedPath`'s own separate matchedPending
   loop; nothing additional for `clearTokenFromPendingIndices`, which has no enclosing top-level lift at
   all, see the discriminator section for why).
2. **Precomputed ownership check.** Filtering `armedKeys` ONCE, before the loop, uses a check that's only
   valid for keys as they stood BEFORE any iteration ran — but `deleteMergeQuarantineLatchByKey`'s own
   protect calls (for an earlier key in the SAME loop) can `replaceEntryEverywhere`, changing what a LATER
   key's own `entryStillOwnsKey` check would see. The PER-ITERATION check (iterate the entry's full
   `armedKeys` directly, `continue` when `entryStillOwnsKey` fails that specific key, right there in the
   loop body) was kept throughout as the gate for whether to ACT on a given key — that part of the
   original draft was already correct and untouched by either correction below.

**Correction (second pass, same finding) — the FIRST fix shipped (commit `f6ccb810`) got the override's
own asymmetry BACKWARDS.** That commit made the override the entry's own FULL, unfiltered `armedKeys`
(unioned with the enclosing lift), reasoning that over-inclusion was the "safe, fail-closed direction."
**That is false, and was caught before landing.** `excludeLiftedResolvedKey` EXCLUDES (drops) a
`resolvedKey` that is a MEMBER of `liftedKeys` — dropping a legitimate binding is EXACTLY what unblocks a
repo after a reboot (the ORIGINAL `4b06875f` fail-open this whole card exists to close). So a key named in
`liftedKeys` that this operation does NOT actually, currently touch causes a WRONGFUL drop — **over-
inclusion is the FAIL-OPEN direction**, not fail-closed; round-2 Code Review `a61d0bec`'s own Minor 1
said exactly this ("its legitimate binding is dropped. That is the fail-open direction"). Under-including
a key, conversely, is FAIL-CLOSED (an over-block that round-3 Code Review `be296830`'s own Minor 1 is
about) — the asymmetry runs the OPPOSITE way from `f6ccb810`'s own stated reasoning.

**The corrected set**: `liftedKeys = (keys the ENCLOSING phase already lifted) ∪ (p.entry.armedKeys
FILTERED by entryStillOwnsKey)` — `ownedArmedKeys`, never the whole list. This is the MINIMAL correct set:
every key it names is one this operation can actually prove it is touching (either the enclosing phase's
own unconditional lift, or a key `p.entry` genuinely, currently owns), so `excludeLiftedResolvedKey` never
drops a binding this operation isn't really retiring. `ownedArmedKeys` is computed ONCE, from the SAME
`entryStillOwnsKey` filter, immediately before the loop — a deliberately separate concern from the
per-iteration ACT gate above: if a key's ownership changes mid-loop (an earlier key's own protect call
re-pointing a later key's slot), the snapshot used for the SET can go slightly stale in either direction.
No repro exists for that staleness in EITHER direction, and none was attempted — the tie-breaker is "prefer
fail-closed" (per the same asymmetry established above), not a claim that the snapshot is race-free.

**"ADD one scenario... RED with mutation (g)... GREEN with the fix" — reported, not fabricated.** I spent
a large, deliberate effort attempting to construct a committed repro for this exact shape (a pending `p`,
genuinely a DIFFERENT object from the entity being cleared, whose own `armedKeys` both (a) names a key
already lifted by the enclosing operation at the TOP level and (b) GENUINELY, CURRENTLY owns at least one
OTHER key — the second condition being necessary to trigger an actual protect call at all). Every
construction method available in this module converges to one of three outcomes, never the needed fourth:
- **Merge** — two same-identity entries colliding at a key, where NEITHER is resolvable (or both are),
  always UNIONS via `armQuarantineKey` rather than staying separate (`armKeyUnlessDegradedCollision`'s own
  "different identity" eviction gate never fires for the SAME identity, and its resolvable-vs-unresolvable
  mismatch gate only ever REFUSES, never preserves a stale multi-key claim — see case 3 below).
- **Trim** — a genuine eviction (`armKeyUnlessDegradedCollision`'s own `remainingKeys.length > 0` branch)
  removes the LOST key from the displaced object's `armedKeys` before pushing it to pending, so the
  displaced copy never retains a stale claim on the key it lost — it retains only what it still, genuinely
  owns.
- **Refuse** — a degraded entity whose `resolvedKey` collides with a DIFFERENT, currently-VERIFIED entry's
  key (the `d163aef5` guard) is refused outright and left standalone with `armedKeys` entirely `undefined`
  — never multi-key.
- A degraded-divert SUCCESS arm (the only way to get a genuinely separate, non-merged, non-refused pending
  object with a REAL, non-empty `armedKeys` at all) is always exactly ONE key (`883e29bc`'s own rule: arm
  ONLY at `resolvedKey`, never also at the degraded walked-up current key) — never two, so it can never
  independently satisfy BOTH conditions (a) and (b) above on its own.
I could not find a combination that escapes this triage. **The fix is applied regardless** — it is correct
by code-read (confirmed by the reviewer's own mutation (g)) and the corrected set (`ownedArmedKeys`,
FILTERED, never the whole list — see "Minor 1" below) is the MINIMAL set this operation can actually
prove it touches, so it carries no systematic bias toward either direction, only the narrow, unreproduced
mid-loop staleness already noted. It defends against a shape that may become reachable under a FUTURE
change even if it is not reachable today. If a reachable path exists that this analysis missed, it is a
finding for the next reader, not one I could locate.

### Q1 — Probe E's own realism, answered: the double-fault `kept` branch

Code Review `be296830` also asked whether ANY runtime path leaves a same-identity pending-divert file on
disk with no in-memory record pointing at it (Probe E's own premise). One exists:
`protectOccupantContentBeforeDelete`'s own double-fault branch (`merge-quarantine.ts:1872`, firing when
`writePendingDivertFile(filename, toWrite)` returns `false`) re-points in-memory tracking for this
identity to `sourceFile: finalBasename` (`:1889`/`:1891`), NEVER to `filename` (the deterministic
`pendingDivertFilenameFor` path) — regardless of whether `filename` already held a PRIOR, durably-written
generation for this SAME identity from an EARLIER, successful protect call. If `filename` already existed
on disk before this failure (a real prior write), its bytes are untouched by the failed write (the
attempt never completed), but NOTHING in memory now points at it — the ONLY route back to its own
`resolvedKey` is a FRESH disk read via `readPendingDivertFileAt`, exactly Probe E's own shape. A LATER
(third) protect call for the same identity reaches `reconcilePendingDivertTarget` fresh, computes the SAME
`filename`, and finds `atFilenameIdx < 0` (nothing tracks it) — so the disk read is load-bearing. This
closes the open question from "Probe E realism" above with a named, cited path rather than a soft
disclaimer; Probe E's own comment and this record both now carry it.
- Do not derive a clear-side loop's own `liftedKeys` from `p.entry.armedKeys` wholesale when a prior
  `entryStillOwnsKey` filter has already excluded some of those keys from being lifted THIS operation —
  pass the SAME filtered set as `deleteMergeQuarantineLatchByKey`'s own `liftedKeysOverride` (see "The
  corrected discriminator" above for the three call sites this applies to).

### Accepted residual — card `050a4428` ("fix(git): stop a second union resurrecting an excluded quarantine resolvedKey")

**Ruling: accepted, not designed in this round.** It only arises after a both-different, fail-closed union
has ALREADY run (the "both SET and genuinely DIFFERENT ⇒ `undefined`" case above), and its effect is an
UNRELATED key surviving — which over-blocks a query at the NEXT reboot (fail-closed: queries that key as
blocked when it should read clear), never fail-open (nothing that should stay blocked ever becomes
unblocked by this). **The shape:** a stale IN-MEMORY pending entry for D — loaded by PASS 1 at boot, never
touched by the current raise — reaches the `atFilenameIdx` union still carrying its own original,
unfiltered `resolvedKey`; that union treats the first union's own deliberate `undefined` as "no opinion
yet" rather than "deliberately excluded, do not resurrect," and keeps the stale entry's value instead.
Closing it needs that exact concept — a `resolvedKey` that is DELIBERATELY EXCLUDED must survive a LATER
re-union against a stale copy, not just the one union that excluded it — which is a bigger change than a
scalar-field guard and is why it is carded separately rather than attempted here.

### Stale-target analysis — does carrying `resolvedKey` ever re-block a key WORSE than before, if the real occupant's own quarantine was legitimately cleared in between?

No — confirmed from the code, not merely argued, and UNCHANGED by Round 2 (the analysis is about what
PASS 1 does with a carried key at the NEXT boot, independent of which round's own guard decided to carry
it). The carried `resolvedKey` is consumed by `reenterMergeQuarantinesAtBootImpl`'s degraded-divert branch
(`merge-quarantine.ts:4426-4439` as of Round 1; re-verify the current line range if this file has moved
again by the time you read this — the mechanism, `armKeyUnlessDegradedCollision`, is what to grep for),
which already fails CLOSED, never worse, in both directions a legitimate intervening clear can leave it in:
- If the carried key is now UNOCCUPIED (nothing currently armed there): the degraded entry arms it
  unopposed — the SAME over-blocking behavior the original (pre-raise) latch already produced at every
  prior boot; this card's fix restores that pre-existing, accepted trade-off of the `883e29bc` mechanism
  across a raise, it does not introduce a new one.
- If the carried key is now occupied by a DIFFERENT, currently-VERIFIED entry (e.g. the real repo
  genuinely re-raised its own fresh quarantine since): `armKeyUnlessDegradedCollision` returns `undefined`
  (the `d163aef5` guard) and the degraded claim is refused outright, left as a standalone pending entry —
  the verified occupant is never touched, unioned, or overwritten.
Either way this is IDENTICAL to what the SAME `resolvedKey` field, consumed by the SAME code, already did
at any boot before the raise — this fix adds no new risk, it only stops the raise from silently disabling
an already-existing, already fail-closed mechanism.

### Field survival, both protect branches, corrected for Round 2 (reader → union → post-union filter → write → boot read)

- **Success path:** `occupantResolvedKey` → `excludeLiftedResolvedKey` (pre-union, `:1822`) → `toPersist.resolvedKey`
  → `diskReconciled.toWrite` (`reconcilePendingDivertTarget` — unchanged on the ENOENT fast path;
  `unionQuarantineEntries`'s own EXPLICIT rule otherwise, SCOPED since Round 3 to this call site via
  `{ explicitResolvedKeyRule: true }` — not the old implicit spread, and not the function's default) →
  `toWriteUnfiltered` (possibly ALSO unioned again, with the SAME explicit option, against the
  `atFilenameIdx` in-memory entry) → `excludeLiftedResolvedKey` AGAIN (post-union) → `toWrite` →
  `writePendingDivertFile`, which strips ONLY `armedKeys` before `JSON.stringify` — `resolvedKey` survives
  serialization intact. (Re-grep `const toWriteUnfiltered`/`const toWrite: MergeQuarantineEntry`/
  `writePendingDivertFile` rather than trusting line numbers here — this file keeps moving.)
- **Double-fault `kept` path:** `kept = { ...toWrite, orphanLatchFiles: [...] }` (re-grep `const kept:
  MergeQuarantineEntry` rather than trusting a line number copied here — stale twice already) spreads the
  ALREADY-POST-UNION-FILTERED `toWrite`, so `kept.resolvedKey` is inherited correctly with no further code
  needed — this is WHY the post-union filter runs before `kept` is built, not after.
- **Boot reader:** PASS 1's primary per-file read loop — `resolvedKey: typeof parsed.resolvedKey === "string"
  ? parsed.resolvedKey : undefined` (3 occurrences in this file as of Round 2: PASS 1 proper, PASS 1b's tmp
  reader, and the safety-tmp recovery reader — grep for this exact literal rather than trusting a single
  line number) is the line that actually consumes it back into memory, feeding the
  `!resolvableNow && !entry.resolvedKey` check and on into the degraded-divert arm-at-resolvedKey branch.

### Tests

`merge-quarantine-raise-protect-failure.mjs`: Round 1's own `37452ddd-twin-repoint-finalbasename` extension
and `4b06875f-no-second-raise` fixture (both still present, now GREEN under the Round-2/3 guard too), plus
Probe C with its no-raise control and newer-pending-file variant (Finding 2's own repro), the union-rule
unit check (case 3/3) described above, and (Round 3) Probe E — the reader's own discriminating test, added
after Round 3's Code Review found Probe C insufficient for that (see the correction under "The union
rule" above). `merge-quarantine-runtime-union-provenance.mjs`: Probe B (Finding 1's own repro), Probe D
(the post-union filter's own repro, the manager's exact Round-2 scenario), and (Round 3)
`4b06875f-migrate-union-drops-dual-arm` (the CRITICAL finding's own boot-union repro). All 34
`merge-quarantine*.mjs` files re-verified individually, each exit 0. `pnpm --filter @loom/daemon
build:native` re-verified. All static guards (`pnpm --filter @loom/daemon guards`) re-verified green.

### Do not

- Do not drop EITHER half of `excludeLiftedResolvedKey`'s own exclusion (the `liftedKeys` membership check
  OR the physical-key-equality fallback) — Finding 1 is what the `liftedKeys` half closes (a sibling armed
  key, never visible to the physical-key check alone); the `82032b5c`/`c9114934` collision shape is what
  the physical-key fallback closes unconditionally, independent of whether a caller threads `liftedKeys`
  correctly. Confirmed directly: disabling the shared helper entirely reopens the collision regression;
  forcing it to always return `undefined` reopens the original fail-open.
- Do not apply `excludeLiftedResolvedKey` ONLY pre-union — Finding 2/the post-union filter exists because a
  union (against an on-disk OR in-memory sibling) can reintroduce a key the pre-union call already
  excluded; apply it again to whatever the union actually produced, via the SAME helper, never a
  second, independently-written check.
- Do not carry forward a REPLACED IN-MEMORY OBJECT's own `resolvedKey` directly (uncritically, with no
  exclusion at all) instead of the occupant's own `parsed.resolvedKey` read off `final`'s bytes — that is
  the ALREADY-REJECTED Round-1 variant, and it fails for a different reason (the replaced object can belong
  to a different identity than what `parsed` actually says). **Correction (Finding 4):** this does NOT mean
  a replaced in-memory object's own `resolvedKey` can never reach `toWrite` at all — `toWrite` is exactly
  `unionQuarantineEntries(diskReconciled.toWrite, pendingUnresolvedQuarantines[atFilenameIdx]!.entry, {
  explicitResolvedKeyRule: true })` when `atFilenameIdx >= 0`, and that SECOND operand IS an in-memory
  entry; its own `resolvedKey` legitimately flows into the union (and is then subject to the SAME
  post-union filter, same as every other source). What stays forbidden is using that in-memory object's
  field as the PRIMARY, unguarded source the way the rejected Round-1 variant did — never bypassing
  `excludeLiftedResolvedKey` for it.
- Do not extend this same guarded carry-forward to `armedKeys` — that field is a SEPARATE question (purely
  in-memory bookkeeping, never persisted) with its own, independent fail-closed/fail-open analysis in the
  ACCEPTED RESIDUAL section in `37452ddd`'s own record; conflating the two risks treating a lower-priority, already-safe gap as
  though it shared this one's urgency or fix shape.
- Do not trust the union-rule's "one side undefined ⇒ keep the other" case as proof against EVERY possible
  re-union — see "Accepted residual — card `050a4428`" in `050a4428`'s own record: a STALE, never-filtered in-memory copy can
  still reintroduce a wholly unrelated key via a SECOND union the first union's own correct "both
  different" verdict never anticipated. ACCEPTED (fail-closed, over-blocks only), tracked on `050a4428`,
  not attempted here.
- **(Round 3)** Do not apply the explicit `resolvedKey` union rule to any caller outside the two scoped
  protect/pending-divert sites — see "Round 3" above and its own "Do not" list for the reproduced boot
  fail-open this causes and the full list of callers that must keep the legacy rule.
