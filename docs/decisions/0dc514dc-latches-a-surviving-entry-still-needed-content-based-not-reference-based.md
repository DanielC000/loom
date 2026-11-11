# 0dc514dc — two latches a surviving entry still needed, on clear and on raise; content-based, never reference-based

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up `0dc514dc` — two latches a surviving entry still needed, on clear and on raise; CONTENT-based, never reference-based (`9cabd143`)

Round-3 Code Review `22bca242` of `95ea8d3f` found two further FAIL-OPEN findings, both pre-existing on
main (not a regression of `95ea8d3f` itself): a clear, and a raise, could each destroy a latch file that
is a SURVIVING entry's only durable backing — with NOTHING structural (`orphanLatchFiles`/`sourceFile`)
pointing at it from either side, so neither the pre-existing structural veto (`survivingSharedClaimRepoPaths`,
banned by `9cabd143` from considering a bare reference) nor any identity check already in place could
ever have caught it. The CR's own direction: use a CONTENT-based check instead — before destroying a
latch, read its own on-disk tokens via a shared reader, and if any of them is still held by a surviving
active or pending entry OTHER than the one being cleared or raised, protect the content.

### Repro A (clear path) — `deleteMergeQuarantineLatchByKey` had no token-overlap backstop when `entry` is undefined

1. Write `<Krhash>.json` = `{repoPath: r/gone-subdir (D), tokens:[d-token], resolvedKey: Kr}`.
2. `reenterMergeQuarantinesAtBoot([])` — PASS 1 arms D under its own recorded `resolvedKey` (Kr), trusting
   it despite D itself being unverifiable.
3. `clearMergeQuarantineReporting(r)`, with D's own pending-divert write failing — D ends up a self-owned
   pending entry, with `sourceFile = Krhash.json` (`final` itself, untouched; this step's own protect call
   already keeps the file correctly, by the PRE-EXISTING token-overlap-aware protect machinery).
4. Make `r/gone-subdir` its own real git repo — D becomes resolvable, at its OWN key `Kd != Kr`.
5. `activeMergeQuarantineFor(D)` — lazy graduation to ACTIVE at `Kd`, but the write there fails (injected).
   D's only durable backing stays at `Krhash.json` (folded into D's own `orphanLatchFiles`), and its
   pending twin is consumed.
6. `clearMergeQuarantine(r)` — **r has NO quarantine of its own at `Kr` at all.** `entry =
   activeQuarantines.get(Kr)` is `undefined`, so `clearingRepoPath`/`clearedEntry` are BOTH `undefined` —
   neither `protectDegradedOccupantBeforeDelete` nor `protectUnincorporatedOccupantBeforeDelete` even
   runs, and `survivingSharedClaimRepoPaths` finds nothing (D's pending twin was already consumed in step
   5 — nothing in `pendingUnresolvedQuarantines` references `Krhash.json` any more). Pre-fix:
   `Krhash.json` is unlinked outright. d-token is lost after a reboot.

### Repro B(a) (raise path) — `mergeTokenIntoPendingEntries` unconditionally overwrote a shared `sourceFile`

1. Write corrupt `<Krhash>.json` F (or, see the correction above, valid-but-field-missing `{}`).
2. `reenterMergeQuarantinesAtBoot([d1, d2])` — TWO pure-pending placeholders (card `882d6cff`'s own
   shared-corrupt-latch shape), both with `sourceFile = F`.
3. `enterMergeQuarantine(d1)`, while d1 is STILL unresolvable — this reaches `mergeTokenIntoPendingEntries`
   (never `enterMergeQuarantine`'s own `verified` raise-write branches), which durably rewrote `base.sourceFile`
   (here, `F`) with d1's OWN merged content UNCONDITIONALLY, with no check for whether a DIFFERENT,
   surviving pending entry (d2) also depends on that exact file. Pre-fix: F is overwritten with valid JSON
   naming d1 alone. After a reboot d2 is gone, with no clear at all.

### Repro B(b) (raise path) — `differentUnresolvableOccupantRepoPathAt`'s own "resolvable ⇒ safe" shortcut assumed the occupant's real backing lives at its OWN key

In shape A above, after step 5 (D ACTIVE at its own key `Kd`, but with NO physical backing there — its
graduation write failed, so its ONLY durable copy is still `Krhash.json`): `enterMergeQuarantine(r)`
reaches the "no existing" raise-write branch's own `protectDegradedOccupantBeforeDelete` call, which
read `Krhash.json`, found D's own content, and — because D is now RESOLVABLE — took
`differentUnresolvableOccupantRepoPathAt`'s pre-existing "a different identity that is CURRENTLY
RESOLVABLE is also safe" branch (`state: "none"`), on the theory that a resolvable occupant's own real
backing lives at ITS OWN key and whatever sits here is stale, safely-overwritable leftover. That theory
is false in exactly this shape: D's real backing is STILL this exact file. Pre-fix: `r`'s raise overwrites
`Krhash.json` outright (`protectOk` stays `true`, nothing marks the basename, `resolveRaiseOverwrite`'s own
fast path proceeds with no read at all). d-token is lost after a reboot, with no clear at all.

### The fix

Two new shared primitives in `merge-quarantine.ts`:

- `readFinalOnDiskSurvivingTokens(final)` — `final`'s own on-disk SURVIVING tokens (via the existing
  shared `readSurvivingOnDiskTokens`), or `[]` for ENOENT/EISDIR, any other read failure, or corrupt JSON
  — every one of those cases is already governed by this module's other, identity/reference-based checks;
  this helper feeds ONLY the new content-based check below.
- `survivingTokenHolderRepoPaths(tokens, excludeIdentity)` — repoPaths of every SURVIVING active or
  pending entry, OTHER than `excludeIdentity` ({@link directPathIdentity}), that currently holds ANY of
  `tokens`. Purely content-based — unlike `survivingSharedClaimRepoPaths`, this never looks at
  `orphanLatchFiles`/`sourceFile` at all (`9cabd143` bans a reference-based veto). Excludes by IDENTITY
  (never by object reference), so every record sharing the clearer/raiser's own identity is correctly
  treated as "the one being cleared or raised," never as a foreign survivor of itself — this is what
  keeps the check from firing on `95ea8d3f-r3-orphanref` (bToken is held only by B, which is being
  cleared: excluding B's own identity leaves nothing else holding it).

**Repro A's fix — `deleteMergeQuarantineLatchByKey`:** `contentClaimants` is computed ONCE, at the TOP of
the function, BEFORE any protect call runs — **not** at the end, alongside `sharedClaimants`, as a first
draft of this fix tried. Two reasons, both found only by running the full corpus, not by this card's own
new scenarios:
1. **Timing (the TOCTOU-shaped regression).** A protect call that SUCCEEDS during this SAME invocation
   (relocating a genuinely foreign occupant's content into a fresh pending-divert copy) leaves `final`'s
   OLD bytes physically unchanged until the unlink actually runs. A content check computed AFTER that
   protect call would read those stale bytes and find the SAME tokens ALSO present in the fresh copy it
   just created — a transient, self-inflicted "duplicate" that wrongly blocks a legitimate unlink
   (`in-memory-twin-clear-destroys-degraded-file`'s own precondition: "Y legitimately owns Ky now"
   regressed to `FAIL` under the naive end-of-function placement). Computing it BEFORE any protect call
   runs in this invocation sees the world as it was independent of this clear's own actions.
2. **Read-count fragility.** Several existing tests (`merge-quarantine-protect-read-failure.mjs`'s
   `round4-b1`/`round4-lifecycle`) inject a read failure keyed to a specific call NUMBER (e.g. "fail only
   the 1st read of `final`"). An unconditional extra read anywhere ahead of the EXISTING protect call's
   own read silently steals that slot, letting the protect call's own read see success one call later
   than the test expects — turning a correctly-marked-kept file into a wrongly-unlinked one. **The fix is
   gated** — `contentClaimants` is only ever computed when NEITHER `clearingRepoPath` NOR `clearedEntry`
   is given (this card's own Repro A shape: `entry` is `undefined`, so neither protect call would ever
   read `final` anyway) — so it never adds a read ahead of one that already exists. This is a narrower
   scope than "every clear," by design: it closes exactly the gap Repro A demonstrates, not a general
   content scan on every clear.
3. **Correction (Round 2, CR `582ce5a9`).** This section previously claimed "a token already in
   `clearedEntry.tokens` is excluded, in addition to the identity exclusion" — FALSE, no such code
   exists. `contentClaimants` is gated OFF entirely whenever `clearedEntry` is given (point 2 above), so
   there is never a call where BOTH a `clearedEntry` and a non-empty `contentClaimants` scan coexist —
   nothing to exclude its tokens from in the first place. The identity exclusion (`clearIdentity`) alone
   is what this gate's one reachable shape (Repro A: `clearedEntry` undefined) needs, and is all the
   code does.

**Repro B(a)'s fix — `mergeTokenIntoPendingEntries`:** before writing `merged` to `base.sourceFile`, check
`survivingSharedClaimRepoPaths(base.sourceFile)` (the EXISTING structural check, reused — not a new
content check: a placeholder's own tokens never appear in its file, so content cannot discriminate this
shape at all, exactly the card's own ruling). `matched`'s own entries are already spliced out of
`pendingUnresolvedQuarantines` earlier in the same function, so this sees only a genuinely OTHER surviving
claimant. A non-empty result diverts via `divertRaiseEntry(merged)` instead of writing to the shared file
— reusing `divertRaiseEntry` rather than inventing a second copy-aside primitive.

**Repro B(b)'s fix — `differentUnresolvableOccupantRepoPathAt`'s own "resolvable" branch:** no longer
unconditionally returns `{state:"none"}` for a different, currently-resolvable identity. It now re-reads
that identity's own on-disk tokens (reusing the SAME read this function already performed — never a
second read) and checks `survivingTokenHolderRepoPaths(surviving, directPathIdentity(ownIdentityRepoPath))`;
only when NOTHING else still holds those tokens does it fall through to `"none"`. Otherwise it returns
`{state:"occupant", repoPath: existing.repoPath}` exactly like a genuinely unresolvable occupant would —
which routes through the SAME pre-existing `protectOccupantContentBeforeDelete` copy-aside the unresolvable
branch already uses, **not** a divert of the raiser's own write. This mirrors shape 1's own
protect-then-overwrite pattern: D's content is durably relocated to its own pending-divert file BEFORE
r's write proceeds, and `final` legitimately ends up holding r's own content afterward — d-token is never
lost, but `final`'s bytes are **not** expected to stay byte-for-byte unchanged (an earlier draft of this
card's own test asserted exactly that, and had to be corrected once the real behavior was observed).

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`carda`** — Repro A, ported verbatim. Asserts `final` SURVIVES the clear, the clear reports
  `latchKept` naming D, and d-token is enforced both in-process and after a fresh-import reboot — measured
  directly via `listActiveMergeQuarantines().flatMap(q => q.tokens ?? [])`, never `assertRepoNotQuarantined`.
- **`cardba`** — Repro B(a), ported verbatim. Asserts F's own corrupt content is UNCHANGED by d1's raise,
  d1's own raise persists, and d2 survives a fresh-import reboot (d2's own token is not expected
  byte-identical across boots — a generic placeholder mints a fresh `randomUUID()` per boot, since
  nothing usable was ever parsed; only its identity surviving is the real guarantee, same discipline as
  `95ea8d3f-r2-shared`).
- **`cardbb`** — Repro B(b), ported verbatim. Asserts d-token is NEVER LOST (found via
  `listActiveMergeQuarantines`, not a `final`-content byte-compare) both immediately after r's raise and
  after a fresh-import reboot, and that r's own raise persists too.
- **`crnit2`** — the Code Review item 2 correction's own fixture (the `{}`-content variant of B(a)'s
  shared-latch setup, plus a transient read failure on `r`'s own raise to mark the basename kept). Asserts
  the clear's own `latchKept` result names d2 SPECIFICALLY (`referencingRepoPaths` non-empty) — the
  discriminating proof that `survivingSharedClaimRepoPaths`'s own veto, not the generic unattributed-kept
  bucket, is what kept the file — and that d2 survives a fresh-import reboot.

`cardba` and `crnit2` both hard-reset `MERGE_QUARANTINE_DIR` at their own start (`fs.rmSync` +
`fs.mkdirSync`, mirroring `merge-quarantine-migrate-source-owner-durable.mjs`'s own precedent) — this file
runs 30+ scenarios sharing one directory, and both of these repros are sensitive to an unrelated, earlier
scenario's own leftover orphan residue being broadcast onto their own `d1`/`d2` by PASS 2's "every
registered repo's entry references an unmatched orphan" mechanism. Every OTHER new scenario in this card
does not need the reset — their own precondition checks don't depend on exact file content/count.

**Correction (Round 2, CR `582ce5a9`) — the original "all four new scenarios proven RED" claim was
imprecise.** `negative-control`'s own verdict is for the WHOLE test FILE (a single exit code), not
per-assertion — it genuinely proves "something in this file regresses on the reverted source," never
"every new scenario's every check goes RED." Measured precisely, per scenario:
- `carda`: genuinely RED pre-fix (`final` gets unlinked outright) and GREEN after.
- `cardba`: the IN-PROCESS checks (F's content unchanged, d1's own raise persists) already pass
  pre-fix too — `mergeTokenIntoPendingEntries`'s own overwrite doesn't touch d1's own in-memory state,
  only d2's durable backing. It goes RED **only at the reboot assertion** (d2 does not survive).
- `cardbb`: same shape as `cardba` — the in-process "d-token is NEVER LOST" check already passes
  pre-fix (D's own in-memory active entry is untouched by what happens to `final`'s physical bytes); RED
  is at the reboot assertion only.
- `crnit2`: GREEN on the parent too, by design — see the correction inserted at the "sweep-path
  structural veto" section above. This fixture pins already-correct, pre-existing (`95ea8d3f`) behavior
  and corrects the record's own wrong claim about it; it was never expected to discriminate this card's
  own code change, and does not.

All `merge-quarantine*.mjs` files re-verified individually, each exit 0. `95ea8d3f-r3-orphanref`
re-verified green, unaffected — bToken is excluded by the identity-exclusion rule, never because the
content check happens not to run.

## Do not

- **(Follow-up `0dc514dc`)** Do not compute a new content-based read of `final` unconditionally, or at
  the END of a clear function alongside an existing structural check — a protect call that SUCCEEDS
  earlier in the SAME invocation leaves `final`'s stale bytes physically present until the unlink runs,
  and a content check reading them AFTER that protect call will find its own fresh copy as a false
  "survivor." Compute it BEFORE any protect call in the same function can run, or gate it to the exact
  shape where no protect call would run at all.
- **(Follow-up `0dc514dc`)** Do not add a content-based read of `final` anywhere a test in this corpus
  injects a read failure keyed to a specific call NUMBER, without re-checking every such test — an extra
  read ahead of an existing one silently shifts which call sees the injected failure. Gate narrowly
  (this card's own fix: only when neither `clearingRepoPath` nor `clearedEntry` is given) rather than
  widen a content check's reach "while you're in there."
- **(Follow-up `0dc514dc`)** Do not exclude only by `directPathIdentity` when deciding whether a token
  found on disk is "owed elsewhere" on the CLEAR path — also exclude any token already present in
  `clearedEntry.tokens` itself. A degraded dual-arm union can carry a different contributor's own token
  under the entry actually being cleared, with that contributor's own bare `repoPath` never matching
  `clearIdentity` — excluding by identity alone re-flags content the clearer's own bookkeeping already
  safely accounts for.
- **(Follow-up `0dc514dc`)** Do not add a content-based veto to `mergeTokenIntoPendingEntries` for the
  B(a) shape — a placeholder's own tokens never appear in its on-disk content, so a content check would
  be a silent no-op there. Reuse the EXISTING structural check (`survivingSharedClaimRepoPaths`), never a
  parallel content-based mechanism that cannot discriminate this shape at all.
- **(Follow-up `0dc514dc`)** Do not "fix" B(b) by adding a content check inside `resolveRaiseOverwrite`'s
  own fast path (`protectOk && !marked`) — a first draft of this fix did exactly that, and it reproduces
  the IDENTICAL transient-duplicate false positive as computing Repro A's own check too late: a
  successful protect-then-overwrite (shape 1's own established pattern) leaves `final`'s stale bytes
  physically present until the write runs, and the fast-path check would find its own fresh copy as a
  false "survivor," wrongly diverting a write that should legitimately proceed
  (`merge-quarantine-raise-protect-failure.mjs`'s own `fp:reraise` positive control regressed under this
  draft). Fix the ROOT detector (`differentUnresolvableOccupantRepoPathAt`'s own "resolvable ⇒ none"
  shortcut) instead, reusing the read it already performs — never add a second, independent read at a
  DIFFERENT call site for the same decision.
- **(Follow-up `0dc514dc`)** Do not assert that `final`'s own bytes stay byte-for-byte unchanged as the
  discriminating proof for B(b)'s own fix — the actual fix routes D through the SAME protect-then-overwrite
  pattern shape 1's own positive control already exercises (content durably relocated, then `final`
  legitimately overwritten by the raiser). Assert that D's own token is never lost (present in
  `listActiveMergeQuarantines`'s own flattened tokens), in-process and after a reboot — the same
  discipline every other card in this module already uses, not a new, stricter claim this fix never made.
- **(Follow-up `0dc514dc`)** Do not trust `markedFinalFullyCoveredByClear`'s own "provably covered" result
  as proof that `final` holds a GENUINE latch — it is vacuously `true` for a `final` holding valid JSON
  with ZERO on-disk tokens (e.g. `{}`), which is simultaneously exactly what PASS 1's own boot
  classification treats as corrupt enough to mint a `882d6cff` placeholder. The Round-3 "direct tension"
  argument that the sweep-path placeholder veto is structurally unreachable assumed otherwise, and was
  wrong — see the correction inserted at that section in `4dba1d37`'s own record, and `crnit2`'s own fixture.
