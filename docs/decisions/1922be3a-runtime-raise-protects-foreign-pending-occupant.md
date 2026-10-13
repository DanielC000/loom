# 1922be3a — a runtime raise durably protects a foreign, unresolvable pending occupant's sole physical backing before overwriting it

From `d163aef5` CR round 5 (`df708ec4`), follow-up 1 — the exact residual `e1cb7d33` documented and
deliberately did NOT fix: "a raise in this exact shape still overwrites the degraded occupant's own
file (pre-existing, unfixed by this card — see the decision record for the precise shape)." PRE-EXISTING,
FAIL-OPEN (a runtime loss), reproduced on main.

## The bug

A RUNTIME `enterMergeQuarantine(W)` can land in `enterMergeQuarantine`'s own "no `existing` armed entry at
`key`" region (no active entry, no pending match for `W`'s own identity, no resolvable sibling) and reach
one of its two writes there — the pending/sibling-consume write (`consumeMatchedPendingsIntoArmedEntry`)
or the brand-new-entry write — both of which pass `writeMergeQuarantineLatch`'s own `skipDegradedOccupantGuard:
true` (an explicit, correct opt-out: `e1cb7d33` ruled a refused raise must never be silently lost at the
next reboot). Neither write first checks whether `key`'s own physical final (`quarantinePathForKey(key)`)
is a wholly DIFFERENT, currently-unresolvable pending occupant `X`'s sole durable backing — e.g. `X =
W/gone-subdir`, a nonexistent path whose own `canonicalRepoLockKey` walks up to `W`'s own real key `K`
tautologically, now sitting in `pendingUnresolvedQuarantines` with `sourceFile` physically AT
`sha(K).json` (via an earlier eviction's own sourceFile inference — see `d163aef5` rounds 3/5/6). The
write overwrites that file with `W`'s own content, destroying `X`'s only durable copy outright; after `W`
is later cleared and the daemon reboots, `x-token` is gone for good.

Confirmed on main (pre-this-card) via the CR's own probe: pending `X` at `sha(K).json` →
`enterMergeQuarantine(W)` → clear `W` by path → reboot → `x-token` lost, while `W` itself lifts correctly.

## The fix

Reuse `d163aef5`'s own protect/ownership machinery rather than inventing a second copy-aside primitive.
Immediately before either of `enterMergeQuarantine`'s two "no `existing`" writes (both reached only when
`verified` is true, i.e. `W`'s own key is genuinely fresh), call
`protectDegradedOccupantBeforeDelete(quarantinePathForKey(key), repoPath)` — the SAME identity-based
check (`differentUnresolvableOccupantRepoPathAt`) `writeMergeQuarantineLatch`'s own (non-opted-out) guard
already uses elsewhere in this module. When `key`'s own final currently names a DIFFERENT,
currently-unresolvable identity, its content is durably copied aside under that identity's own
`pendingDivertFilenameFor` name (re-pointing any pre-existing pending reference onto the new name, never
duplicating it — `protectOccupantContentBeforeDelete`'s own existing re-point logic) BEFORE the write
proceeds. A single call site covers both of this region's writes, since both target the same `final`.

This is a no-op in the overwhelming majority of raises (nothing foreign physically at `key`'s own final).
It never fires for a matched pending/sibling entry already folded into this raise's own write (always
either the raiser's own identity, or currently resolvable — both already excluded by the same identity
check), and it never fires for a still-resolvable different occupant's stale leftover physically at that
key (today's existing, deliberately-unprotected "legitimate overwrite" case — `differentUnresolvableOccupantRepoPathAt`'s
own `protectResolvableToo:false` default, unchanged here).

## Scope note — the `existing`-truthy region is NOT covered by this fix

`enterMergeQuarantine`'s OTHER two opt-out write sites — inside the `if (existing)` block (the
armed-key-loop's own primary-key write, and that block's own sibling-absorb
`consumeMatchedPendingsIntoArmedEntry` call) — are deliberately left untouched. Unlike the region this
card fixes, `key`'s own physical final SHOULD already mirror `existing`'s own in-memory identity there
(whichever side previously won a union's tie-break, possibly an unresolvable identity like `X` itself) —
applying this same identity-based protect call unconditionally in that region risks a FALSE POSITIVE:
treating `existing`'s own already-accounted-for content as "foreign" merely because its `.repoPath` field
differs from the NEW raiser's own identity, and durably forking off a spurious duplicate pending record
for data that was never actually lost. A real fix for that region, if one is ever needed, requires a
TOKEN-OVERLAP discriminator (mirroring `unincorporatedOccupantRepoPathAt`'s own clear-side design,
checking against the about-to-be-written entry's own merged `tokens`, not a bare identity compare).

**Reproduced in Code Review `d3c36260` (the runtime-lazy-graduation shape: X's quarantine is lost after
S graduates and W raises) — tracked as its own, separate card, not fixed here.**

## Round 2 (Code Review `d3c36260`) — the fix's own protect call had two further bugs

### BLOCKER 1 (CRITICAL) — the protect call's own splice corrupted every index collected before it ran

The protect call originally ran AFTER `pendingIndices`/`siblingIndices`/`allPendingIndices` were
collected. `protectOccupantContentBeforeDelete` can SPLICE `pendingUnresolvedQuarantines` (when the
occupant has a "two-file" shape: one copy AT `key`'s own final, a SEPARATE prior-divert copy at its own
pending-divert name) — collecting indices first, then splicing the array out from under them, left every
later index-based access reading the WRONG array position. Reproduced both of the CR's own two
outcomes: a `TypeError` thrown out of `consumeMatchedPendingsIntoArmedEntry` (an index now out of
bounds), and — the more insidious case, and the one this card's own test exercises — the raiser's OWN
fresh token silently unioned into an UNRELATED ghost's entry, because the stale index, after the splice
shifted everything down by one, now resolved to that ghost's new array position instead of the raiser's
own genuine sibling/pending match.

**Fix:** move the protect call to BEFORE index collection — `pendingIndices`/`siblingIndices`/
`allPendingIndices` are now always collected fresh, after any splice the protect call may have already
performed, so they can never go stale.

### BLOCKER 2 (CRITICAL) — minting an independent pending record for an identity already tracked live elsewhere

When the occupant physically sitting at `key`'s own final is ALREADY tracked as a LIVE, ACTIVE entry
elsewhere (e.g. armed at a wholly different key via its own `resolvedKey`), the protect call's own
"neither `atFilenameIdx` nor `atFinalBasenameIdx` matched" branch unconditionally minted a SECOND,
independently-tracked pending record for that SAME identity. A later `clearMergeQuarantineByToken` finds
and lifts only the ACTIVE copy — `clearMergeQuarantineByToken`'s own identity-scan returns as soon as it
finds a match in `activeQuarantines`, never consulting `pendingUnresolvedQuarantines` at all — leaving the
orphaned duplicate pending copy to report the identity as PERMANENTLY quarantined (fail-stuck), surviving
even a reboot.

**Fix:** a new `liveEntrySupersettingTokens` helper scans both `activeQuarantines` and
`pendingUnresolvedQuarantines` for an entry sharing the occupant's own identity whose `tokens` already
form a superset of the content about to be protected. When found, the durable copy's filename is folded
into THAT entry's own `orphanLatchFiles` (via `replaceEntryEverywhere`) instead of minting a new,
independent record — so a later clear of the live entry sweeps it too.

### Tests

`test/merge-quarantine-degraded-occupant-guard.mjs`: `round2-protect-splice-does-not-corrupt-own-sibling-index`
(BLOCKER 1 — a two-file `X` occupant plus a genuine sibling `teamA` and an unrelated ghost `Z`, the
latter two's filenames forced to sort after both of X's, so the splice always shifts their indices),
`round2-protect-does-not-duplicate-already-active-occupant` (BLOCKER 2 — `X` armed live at a distinct
key `K2` via its own `resolvedKey`, plus a separate stale leftover written directly to `Kw`'s own final
AFTER boot, so nothing tracks it yet when the raise's own protect call reads it). Both proven RED on the
round-1-only code and GREEN after, via a manual revert/rebuild/retest/restore cycle (never the full
gate). All 30 `merge-quarantine*.mjs` files re-verified individually, and all 30 static guards re-verified
green.

## Tests

`packages/daemon/test/merge-quarantine-degraded-occupant-guard.mjs`'s `fresh-raise-survives-reboot`
scenario is REWRITTEN in place (its own prior "documented residual, pre-existing" comments/assertions
described exactly this bug, deliberately unfixed by `e1cb7d33`) — it now asserts `X`'s own physical file
and token survive `W`'s raise AND a real reboot, while `W`'s own fresh raise is still durable too. A new
`walkup-raise-protects-pending-occupant-then-clears` scenario, in the same file, reproduces the CR's own
probe literally (`X = W/gone-subdir`, a nonexistent walk-up path under `W` itself, pending at
`sha(K).json`) through the full `enterMergeQuarantine(W)` → `clearMergeQuarantine(W)` by path → reboot
sequence the probe named, asserting `X`'s token and `assertRepoNotQuarantined(x)` block survive the clear
and the reboot. Both proven RED on `main` (pre-fix) and GREEN after. All `merge-quarantine*.mjs` files
re-verified individually (never the full gate), and all static guards (`pnpm --filter @loom/daemon
guards`) re-verified green.

## Round 3 (Code Review `e3b80d6d`) — the shared entry carrying a foreign token still needed its own clear path fixed

Round 2's fix stopped a runtime raise from destroying a degraded occupant's own content. The CR found two
further regressions, both in `clearMergeQuarantineByToken` itself, both pre-existing — never introduced by
this card — but exposed BY the shapes round 2's own protect call can now produce.

### BLOCKER (P1) — the fold into `orphanLatchFiles` is in-memory only; a reboot re-discovers a second record

`protectOccupantContentBeforeDelete`'s `liveEntrySupersettingTokens` branch (round 2) durably writes the
occupant's protected copy to its own divert file, then folds that filename into the LIVE entry's own
`orphanLatchFiles` — but only in memory; it never durably rewrites the live entry's own armed-key latch
file(s) to carry that fold. A reboot that reads ONLY the still-stale on-disk latch re-discovers the
divert file as an UNREFERENCED, independent pending record — the SAME identity now has TWO records on
disk, active and pending, both carrying the same token. `clearMergeQuarantineByToken`'s old
key-fast-path/identity-fallback/return-on-first-match shape stopped at whichever one it found first and
never swept the other, leaving the surviving record fail-stuck forever even after a legitimate clear.

### BLOCKER (P8) — a partial-overlap leftover's own EXTRA token was never swept either

A same-identity leftover pending record can carry a SUPERSET of the live entry's own CURRENT tokens (a
prior clear already lifted one of the live entry's own tokens; the leftover — a separate, never-synced
copy — still carries both). `liveEntrySupersettingTokens` correctly refuses to fold a NON-superset
leftover into the live entry and mints an independent pending record instead (round 2's own fix) — but
the old `clearMergeQuarantineByToken` again stopped at the first match (the active entry) and never swept
that independent pending record, leaving the extra token fail-stuck.

### The fix

`clearMergeQuarantineByToken` now lifts `token` from EVERY record sharing `repoPath`'s own identity OR its
own canonical key, active AND pending, never stopping at the first match:
- The active-side scan is a single pass over `activeQuarantines`, matching an entry on `k === key` (the
  canonical-key match the old fast path provided) OR `directPathIdentity(entry.repoPath) === identity`
  (the old identity-scan fallback), deduped by object reference via a `seen` Set so a multi-key-armed
  entry is cleared exactly once. **The `seen` Set is populated only on an actual match** — marking it on
  every key visited (regardless of match) reopens a Map-iteration-order-dependent bug: an entry armed
  under several keys can be visited at a NON-matching key first, which would otherwise permanently hide
  its own later, genuinely matching key. This was caught live during this round's own verification — an
  earlier draft of the fix flaked on `merge-quarantine-unknown-provenance.mjs`'s
  `partial-clear-persists-marker-and-survives-restart` scenario at roughly a 1-in-2 to 1-in-5 rate,
  entirely explained by which of a dual-armed entry's own keys the boot-time `readdir` happened to surface
  first.
- `clearPendingEntryByToken` is now generalized from a single `findIndex` to every matching index
  (`collectPendingIndices`), applying the same per-entry logic to each in descending index order (mirrors
  `consumeMatchedPendingsIntoArmedEntry`'s own splice-safety pattern) — splice-and-sweep when a record's
  own remaining tokens go empty, durable rewrite-in-place otherwise.
- The pending sweep is now called UNCONDITIONALLY from `clearMergeQuarantineByToken`, never gated on
  "nothing active matched" — a same-identity leftover can carry `token` in a pending record even while an
  active entry elsewhere ALSO carries it (the two-record bug above), and both copies need the token lifted.

### Accepted residual (ruling, round 3)

Round 2's own in-memory-only fold (`liveEntrySupersettingTokens`) is kept AS-IS — this round does not make
it durable. A same-identity leftover's own EXTRA tokens beyond what the live entry currently holds stay
FAIL-CLOSED: the repo stays blocked by that extra token until it is independently cleared by its own
token. This is an accepted, recoverable fail-stuck (never a silent loss, never a false lift) — strictly
safer than the alternative of guessing which tokens are "safe" to drop.

### Tests

`packages/daemon/test/merge-quarantine-degraded-occupant-guard.mjs`:
- `round2-protect-does-not-duplicate-already-active-occupant` now inserts a REAL reboot between the raise
  and the clear (P1's own repro shape) — the clear now runs against the rebooted module's own state,
  proving the sweep lifts both the live and the re-discovered duplicate record even across a restart.
- `partial-overlap-pending-leftover-stays-blocked-until-both-tokens-cleared` (new, P8) — a live entry at
  `[ta, tb]`, a stale leftover snapshot carrying the same two tokens, `tb` cleared from the live entry
  alone, then a raise mints the leftover into an independent pending record; asserts the repo stays
  blocked after clearing `ta` alone (the pending record's own `tb` survives) and is freed only once `tb`
  is also cleared, durably across a reboot.
- `extra-pending-token-stays-blocked-until-cleared` (new, P3) — a live entry carrying only `ta`, a stale
  leftover carrying `ta` PLUS an unrelated extra token `tc` the live entry never held at all; asserts the
  same fail-closed-then-fully-freed shape.

All three proven RED on `main` (post-round-2, pre-round-3) and GREEN after. All 30 `merge-quarantine*.mjs`
files re-verified individually (never the full gate, never `run_gate`), each run at least twice to guard
against the Map-iteration-order flake class this round's own fix closed. All 30 static guards (`pnpm
--filter @loom/daemon guards`) re-verified green.

## Do not

- **(Round 3)** Do not mark an entry `seen` in `clearMergeQuarantineByToken`'s active-side scan until it
  has actually MATCHED (by key or identity) and is about to be cleared — marking it on every key visited
  regardless of match reopens a Map-iteration-order-dependent bug where a non-matching key visited first
  permanently hides the same entry's own later, genuinely matching key. See the round-3 BLOCKER above.
- **(Round 3)** Do not gate `clearPendingEntryByToken`'s own sweep on "nothing active matched" — a
  same-identity leftover can carry `token` in a pending record even while a SEPARATE active entry
  elsewhere also carries it; both need the token lifted, not just whichever is found first.
- **(Round 3)** Do not attempt to make round 2's `liveEntrySupersettingTokens` fold durable as a way to
  "fully fix" P1/P8 — the accepted ruling is FAIL-CLOSED on the leftover's own extra tokens, not a
  guarantee of exactly one record after a reboot; a test asserting "exactly one record" after a reboot is
  asserting something this fix does not (and is not ruled to) provide.

- Do not call `protectDegradedOccupantBeforeDelete`/`protectUnincorporatedOccupantBeforeDelete`
  unconditionally at the TOP of `enterMergeQuarantine`, before `existing` is known — the `existing`-truthy
  region's own physical final can legitimately differ from the NEW raiser's identity while still being
  fully accounted for (a prior union's own winning side); see the scope note above for why this would
  manufacture a spurious duplicate pending record there, not fix a real loss.
- Do not gate this protect call on anything other than `verified` — the `!verified` branches never target
  `quarantinePathForKey(key)` at all (they divert to their own disjoint pending filename instead), so the
  call would be meaningless (and `key` itself is a degraded, untrusted value) for those branches.
- Do not invent a second copy-aside primitive for this shape — `protectDegradedOccupantBeforeDelete` /
  `protectOccupantContentBeforeDelete` already durably re-point a pre-existing pending reference onto the
  new divert name rather than duplicating it; a hand-rolled copy here would reopen that exact bug class.
- **(Round 2)** Do not collect `pendingIndices`/`siblingIndices`/`allPendingIndices` before calling the
  protect function — the protect call can SPLICE `pendingUnresolvedQuarantines`, and indices collected
  against the pre-splice array silently read the wrong position (or go out of bounds) once used.
- **(Round 2)** Do not let `protectOccupantContentBeforeDelete`'s "neither index matched" branch mint an
  independent pending record without first checking `liveEntrySupersettingTokens` — an identity already
  tracked live elsewhere (active or pending) with every token this content carries needs the new divert
  file folded into THAT entry's own `orphanLatchFiles`, never a second, independently-clearable record.
- **(Round 2)** Do not label an in-memory, pre-reboot assertion "*** THE FIX ***" in this file's own
  scenarios — `pendingUnresolvedQuarantines`'/`activeQuarantines`'s in-memory state is untouched by the
  bug either way; only a check that re-derives state from disk after a reboot actually discriminates.
  Label the former "(sanity)" — a mislabeled check reads as proof the fix works when it proves nothing.
