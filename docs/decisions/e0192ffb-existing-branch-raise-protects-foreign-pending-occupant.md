# e0192ffb — a raise onto an already-armed key durably protects a foreign, unresolvable pending occupant's sole physical copy before overwriting it

A pre-existing fail-OPEN, reproduced by Code Review `d3c36260` of `1922be3a` (`15d20971`) — reproduces
identically with and without that fix. `1922be3a`'s own scope note explicitly left this region unfixed
(see that record's "Scope note" section) pending a token-overlap discriminator, which is what this card
ships.

## The bug

`enterMergeQuarantine`'s `existing`-truthy region (reached when a VERIFIED raiser's own fresh `key` is
already armed in-memory by some other entry, e.g. a cross-tier sibling that just graduated) writes the
primary key with the degraded-occupant guard skipped, in both of its own write call sites — the
sibling-absorb branch (`consumeMatchedPendingsIntoArmedEntry(siblingIndices, key, entry, true)`) and the
armed-key loop's own primary-key write (`writeMergeQuarantineLatch(entry, true, key, true)`, the
`isPrimaryKey` branch). Both skip the guard deliberately (`e1cb7d33`: a refused raise would be silently
lost at the next reboot) — but neither first checks whether `key`'s own physical final
(`quarantinePathForKey(key)`) is a wholly DIFFERENT, currently-unresolvable occupant's sole durable
backing, the exact hazard `1922be3a` fixed for the "no `existing`" region.

Repro (mirrors `merge-quarantine-degraded-occupant-guard.mjs`'s `runtime-lazy-graduation-refuses`
scenario, carried one step further):
1. `X` is pure pending at `sha(K)`. `S = W/teamA` has a stale latch, also pending; `teamA` is missing at
   boot.
2. Boot with `[W]`, then `mkdir teamA`.
3. `activeMergeQuarantineFor(S)` graduates `S` at `K` in memory only (via
   `consumeMatchedPendingsIntoArmedEntry`) — its own write is correctly refused by the degraded-occupant
   guard; `X`'s file is intact.
4. `enterMergeQuarantine(W)` — `W`'s own fresh key is also `K` (teamA collapses onto `W`'s own toplevel
   key) — takes the `existing` branch (`existing = S`, now armed at `K` in memory). Its primary-key write
   skips the guard and overwrites `X`'s file with the `S+W` union.
5. `clearMergeQuarantine(W)`, then reboot: `x-token` exists nowhere on disk, and
   `assertRepoNotQuarantined(X)` wrongly returns `ok`. `X`'s quarantine is lost.

## The fix

A single `protectUnincorporatedOccupantBeforeDelete(quarantinePathForKey(key), entry)` call, placed
immediately after `entry` is rebuilt and `replaceEntryEverywhere` runs, before `siblingIndices` is
collected (the same ordering rule `1922be3a` round 2 established — the protect call can splice
`pendingUnresolvedQuarantines`, so collecting indices first would read the wrong position). A single call
site covers both of this branch's own writes, since both target the same `quarantinePathForKey(key)`.

**Token overlap, never repoPath identity, is the discriminator** — reusing `unincorporatedOccupantRepoPathAt`
(the SAME helper `d163aef5`/`d2582692` already ship for the clear side) rather than
`differentUnresolvableOccupantRepoPathAt` (the identity-only helper `1922be3a` uses for the "no
`existing`" region). `key`'s own physical final SHOULD already mirror `existing`'s own in-memory
identity here (`1922be3a`'s own scope note on why an identity-based check in THIS region would
false-positive — `existing`/`entry.repoPath` can legitimately be an unresolvable identity like `X` itself,
the winning side of an earlier union): an identity-only check would wrongly flag `existing`'s own
already-accounted-for content as foreign merely because its `.repoPath` differs from the new raiser's own
identity (`repoPath`, here `W`), and durably fork off a spurious duplicate pending record for data that
was never actually lost. `unincorporatedOccupantRepoPathAt` already exempts the SAME identity as
`entry.repoPath` (the common case — content physically matching `existing`'s own prior write) and falls
back to token overlap against `entry.tokens` only when identity differs: content whose tokens are already
a subset of `entry.tokens` is this raise's own union-won data (safe to overwrite); content carrying a
token the union does not hold is a wholly different, unincorporated occupant (`X`'s shape) and gets
durably copied aside first, via the existing `protectOccupantContentBeforeDelete` machinery — no second
copy-aside primitive invented.

## Tests

`packages/daemon/test/merge-quarantine-degraded-occupant-guard.mjs`:
- `existing-branch-raise-protects-foreign-pending-occupant` — the card's own repro above, through the full
  `enterMergeQuarantine(W)` → `clearMergeQuarantine(W)` → reboot sequence; asserts `X`'s own token and
  physical file survive the raise, the clear, AND a reboot, and `assertRepoNotQuarantined(x)` still
  blocks after the reboot. Proven RED on `main` (pre-fix) and GREEN after, via `scripts/negative-control.mjs`.
- `existing-branch-raise-still-overwrites-own-union-content` — a NO-OVER-PROTECTION control, not a
  pre-fix/post-fix discriminator: `S`'s own prior content (not a foreign occupant's) is what physically
  sits at `key`'s own final when `W` raises; asserts the write still proceeds normally (no spurious
  divert/pending record is created, and the union is durable across a reboot). This one PASSES on `main`
  too — its job is proving the fix does not over-protect the raiser's own already-incorporated data, never
  discriminating the fix's presence (CR `aad53fa6`: it also passes under an identity-only mutant, since
  identity alone already exempts this shape — see the next scenario for the check that actually pins the
  card's own token-overlap discriminator).
- `existing-branch-raise-token-overlap-pins-no-spurious-divert` (CR `aad53fa6` BLOCKER) — pins the card's
  own core discriminator, TOKEN OVERLAP never repoPath identity. Shape: `teamA` wins an EARLIER boot-time
  tie-break (its own `enteredAt` OLDER than `X`'s), so the in-memory union's winning identity is `teamA`,
  already carrying `X`'s own token from that boot-time union — but `X`'s OWN original physical file is
  STILL what's at `Kp` (its own migrate write was refused, same as `existing-branch-raise-still-overwrites-
  own-union-content`'s own fixture). A later `enterMergeQuarantine(teamA)` must recognize `X`'s on-disk
  token is ALREADY a subset of the fresh union about to be written and skip protection — an IDENTITY-ONLY
  check (comparing `X`'s repoPath against `teamA`'s, ignoring tokens entirely) would wrongly flag this as
  foreign and mint a spurious, never-synced `pending-<hash>.json` divert for `X` that a later clear of
  `teamA` can never reach, stranding `X` blocked forever. Asserts no such divert file is ever created, and
  that clearing `teamA` then `repo` fully frees `x` (`assertRepoNotQuarantined(x).ok === true`) with no
  latch files left behind. Proven RED under an IDENTITY-ONLY mutant — `protectDegradedOccupantBeforeDelete`
  swapped in for `protectUnincorporatedOccupantBeforeDelete` at this card's own call site, patched directly
  into a copy of the compiled `dist/git/merge-quarantine.js` (never a `src` edit) — and GREEN under the
  real fix; the patched `dist` was restored byte-for-byte afterward.

All `merge-quarantine*.mjs` files re-verified individually (never the full gate, never `run_gate`), and all
static guards (`pnpm --filter @loom/daemon guards`) re-verified green.

## Accepted residual — a stale disk copy of the raiser's own already-superseded tokens can be misread as foreign

The token-overlap check compares disk content against `entry.tokens` as computed RIGHT NOW — if `key`'s own
physical final is a STALE copy of the SAME entry's own historical data, carrying a token the live in-memory
entry has since DROPPED (e.g. a partial clear lifted one token but the file was never durably rewritten),
that dropped token is no longer a subset of `entry.tokens`, and this call misreads the stale copy as a
foreign occupant — minting a spurious-but-recoverable pending record that carries the already-cleared
token. The outcome is a fail-closed TOKEN RESURRECTION (an already-lifted token re-blocking the repo via its
own independent pending record), never a data loss — the same accepted-residual class `1922be3a` round 3
documents for its own `partial-overlap-pending-leftover`/`extra-pending-token` scenarios (both resolved by
clearing the resurrected token independently). Not fixed here, for the same reason round 3 didn't fix it:
fail-closed-but-recoverable beats guessing which tokens are "safe" to drop from a stale copy.

## Deliberate asymmetry — the two write regions' protect calls differ on resolvability, on purpose

`enterMergeQuarantine`'s "no `existing`" region (`1922be3a`) calls `protectDegradedOccupantBeforeDelete`,
which is backed by `differentUnresolvableOccupantRepoPathAt` — identity-only, and explicitly NEVER protects
a DIFFERENT identity that is CURRENTLY RESOLVABLE (`protectResolvableToo` stays `false` there; today's
existing, legitimate "stale different repo's leftover file" overwrite case). This card's own `existing`-
truthy region instead calls `protectUnincorporatedOccupantBeforeDelete`, backed by
`unincorporatedOccupantRepoPathAt` — token-overlap, with NO resolvability exclusion at all: a different
identity whose tokens aren't yet incorporated gets protected regardless of whether that identity is
currently resolvable. This means the `existing` branch can durably divert a RESOLVABLE different occupant's
leftover that the `no-existing` branch would have silently, legitimately overwritten. This is DELIBERATE,
not an oversight — the `existing` branch inherited the SAME helper the CLEAR side already uses
(`d163aef5`/`d2582692`), precisely because identity alone false-positives on the UNION-KEYS shape those
cards document; adding a resolvability exclusion on top would reopen exactly the false-positive risk
`1922be3a`'s own scope note warned about for an identity-only check in this region. Over-protecting here is
FAIL-CLOSED (one extra, recoverable re-block the next time that identity is queried) — strictly safer than
under-protecting, which is a silent, unrecoverable loss.

## Do not

- Do not use `differentUnresolvableOccupantRepoPathAt` (identity-only) for this region — `existing`'s own
  physical final can legitimately differ from the NEW raiser's identity while still being fully
  accounted for (a prior union's own winning side); see `1922be3a`'s own scope note. Use
  `unincorporatedOccupantRepoPathAt` (token-overlap) instead, exactly as the clear side already does.
- Do not collect `siblingIndices` (or any other `pendingUnresolvedQuarantines` index) before calling the
  protect function in this region — the protect call can splice that array, and indices collected against
  the pre-splice array silently read the wrong position.
- Do not invent a second copy-aside primitive for this shape — `protectUnincorporatedOccupantBeforeDelete`/
  `protectOccupantContentBeforeDelete` already durably re-point a pre-existing pending reference onto the
  new divert name rather than duplicating it.
- Do not gate this protect call on anything other than being inside the `existing`-truthy branch — both of
  this branch's own writes (sibling-absorb and the primary-key loop write) target the same
  `quarantinePathForKey(key)`, so one call site before either covers both.
- Do not add a resolvability exclusion (`protectResolvableToo`-style) to this region's own protect call —
  see "Deliberate asymmetry" above; over-protecting a resolvable different occupant's leftover here is an
  accepted, fail-closed tradeoff, not a bug to narrow.
- Do not trust a control that passes on both pre-fix `main` AND an identity-only mutant as proof the
  token-overlap discriminator is pinned (CR `aad53fa6`) — a control where the on-disk occupant's identity
  already matches `entry.repoPath` exercises the identity-exemption branch, which an identity-only check
  would ALSO pass. The discriminating shape needs identity to DIFFER while tokens are already a full
  subset (see `existing-branch-raise-token-overlap-pins-no-spurious-divert`).
