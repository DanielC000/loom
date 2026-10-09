# 96e6aa58 — consumeMatchedPendingsIntoArmedEntry's own per-key arm is gated on ownership

From `82032b5c` round 4, item 5 (Lead-carded separately): `consumeMatchedPendingsIntoArmedEntry` still did
a bare `for (const k of armedKeys) activeQuarantines.set(k, armed)`, reached whenever
`enterMergeQuarantine`'s own `existing` branch (or `activeMergeQuarantineFor`'s `direct` fast path) absorbs
a cross-tier sibling while the caller-supplied `extra` entry is genuinely dual-armed — the SAME bug class
round 3 MINOR A fixed for `clearActiveEntryTokenAtKey`, reached here through the sibling-absorb raise path
instead of a partial clear.

**CORRECTED (round 2, see below):** this section originally claimed "a bare pending entry never carries
its own `armedKeys` — the only source of a non-`key` member in this function's `armedKeys` union is an
already-armed `extra`." That premise is **FALSE** for an `883e29bc` boot-diverted twin: PASS 1's own
degraded-divert branch arms a matched entry SINGLY at its own `resolvedKey` (so `armedKeys` on that
object is `[K2]`, non-empty) and ALSO pushes a pending reference to that exact SAME object (by reference)
for lazy re-resolve at its real key `K1` — so a bare pending entry in `matched` absolutely can carry its
own `armedKeys`, with no `extra` involved at all. If a secondary member of ANY matched entry's own
`armedKeys` (not just `extra`'s) has since been reclaimed by a different, currently-unresolvable entry
`W`, the bare loop clobbered `W`'s in-memory `activeQuarantines` slot with the new union, in-process only
(every durable write in this function targets `key` alone — `W`'s own on-disk file is never read or
written here, before or after this fix).

## The fix (round 2 — see "Round 2" below for why round 1's own fix was insufficient)

All three `activeQuarantines.set(` sites in this function route through one shared **anchor set**:
`extra` (when present) plus every `matched[i].entry` — each is, by construction, being consumed into this
union, so re-pointing whatever it already owns is correct and matches main's own behavior for them (see
"Round 2" for why `W`, a genuinely foreign occupant, can never land in this set).

- **L764 (initial arm):** `key` (this call's own caller-verified anchor) is always armed directly. Every
  OTHER member of `armedKeys` is armed when `entryStillOwnsKey(k, o)` holds for ANY anchor `o` (same
  object OR same `directPathIdentity` — the round-3 re-CR's "different object, same identity" shape, which
  a bare reference scan alone cannot reach). `replaceEntryEverywhere(activeQuarantines, o, armed)` is then
  called for EVERY anchor `o`, so any OTHER reference-held slot — and any pending-twin bookkeeping any
  anchor itself covers — is also re-pointed. `W`, a different identity, is never touched by either.
- **L772/L784 (the post-failure rebuilds):** a same-identity rebuild of `armed` itself
  (`replaceEntryEverywhere(activeQuarantines, armed, updated)`) — safe because, after the L764 fix, every
  slot currently holding `armed` by reference was already placed there correctly (never a slot belonging
  to `W`).

No new ownership predicate was written — both `entryStillOwnsKey` and `replaceEntryEverywhere` are the
existing, shared chokepoints `82032b5c`'s own raise/clear loops already use.

## Other `activeQuarantines.set(` sites audited, confirmed safe (unchanged)

- `enterMergeQuarantine`'s "brand new entry" branch — `key` was already checked falsy via `existing` at
  the top of the function with no intervening `await` (fully synchronous); cannot collide.
- `quarantineAllRegisteredFailClosed` — a brand-new single-key entry per repoPath, key freshly derived
  from that same repoPath; no inherited/stale `armedKeys`, no union.
- `reenterMergeQuarantinesAtBootImpl`'s final commit loop — a one-time copy from the boot-local
  `byRepoKey` (already fully resolved via its own in-pass `replaceEntryEverywhere`/`armQuarantineKey`
  calls) into the global `activeQuarantines`, which is guaranteed empty at this point (called once, early
  in boot, before any other access).

## Restart survival

No change to what survives a restart, at any of the three changed sites. `writeMergeQuarantineLatch`
inside this function is called exactly once, always targeting `key` only, unaffected by this fix. The
defect (and its fix) is purely in-memory: pre-fix, `W`'s live object was silently replaced in
`activeQuarantines` for the remainder of that process's life (a query/clear against `W` would misroute to
the union until the next restart, which self-heals by re-reading disk fresh via PASS 1); post-fix, `W`'s
in-memory slot is never touched.

## Round 2 (Code Review `b166c6e6` on commit `b7fff0f4`) — one BLOCKING regression vs main

Round 1's own fix (gating a non-anchor key only against `extra`) left `W` correctly protected, but
regressed a DIFFERENT, pre-existing-on-main shape: an `883e29bc` boot-diverted TWIN is a `matched` pending
entry whose own `.entry` is the SAME object already armed (singly) at its own `resolvedKey` (`K2`) — so
it genuinely carries `armedKeys:[K2]` with no `extra` involved. On the **no-`extra` graduation path**
(`activeMergeQuarantineFor`'s own lazy-graduation tail, reached when nothing is yet armed at `key`), round
1's fix gated purely on `extra` (`undefined` here) — so `K2` was skipped outright AND
`replaceEntryEverywhere` had nothing to re-point either (it was only ever called for `extra`). `K2` kept
pointing at the now-spliced-out twin object forever: it stayed fail-closed (`K2` still blocked; either
identity's own clear still lifted it), but `listActiveMergeQuarantines` reported the SAME logical repo
TWICE — exactly the stale-twin-slot class `82032b5c` round 2's own "Do not" forbids, reached via a THIRD
caller of this chokepoint (the no-`extra` graduation path) round 1 never considered.

**Lead's ruling:** the entries being CONSUMED (each `matched[i].entry`) are folded into the union by
definition — the slots they hold by reference belong to the union, matching main's own behavior for them.
The predicate's job is only ever to protect a genuinely FOREIGN `W`. So the anchor set widens to `extra`
(if any) plus every `matched[i].entry` — see "The fix" above. This also closes a SECOND gap the same CR
found: a different-identity cross-tier sibling that is ITSELF a boot-diverted twin (its own `matched[i]`
entry carrying a stale secondary key) was ALSO only protected by `replaceEntryEverywhere`'s reference
scan under round 1, never by `entryStillOwnsKey`'s identity branch — anchoring on every matched entry,
not just `extra`, closes both at once.

**CORRECTED (re-CR `5c20f004`): the paragraph below originally claimed every matching tier "verifies the
candidate's identity against `key`" — that is WRONG for the `resolvedKey` tier. The real, per-tier reasons
follow.**

**Why `W` (a genuinely foreign occupant, never in `matched`) can never land in the anchor set**, tier by
tier (`activeMergeQuarantineFor`'s own no-`extra` cascade, and `enterMergeQuarantine`'s own narrower
matches):

- **Tier 1 (direct identity)** and **tier 2 (ancestor-alias)** — `directPathIdentity`/`ancestorAwarePathIdentity`
  equality. `ancestorAwarePathIdentity` specifically re-appends whatever trailing segments don't exist yet
  onto a normalized EXISTING-ancestor realpath (see its own doc comment) — it matches only alias
  SPELLINGS of the SAME path (a junction, an 8.3 short name), never a genuinely different path like `R` vs
  `R/teamA`. Both tiers can only ever match the SAME repo as the query.
- **Tier 3 (cross-tier sibling, `collectCrossTierSiblingIndices`)** is the ONLY tier that can match a
  genuinely DIFFERENT identity (the `R`/`R/teamA` collapse). It requires `isRepoPathCurrentlyResolvable(p.entry.repoPath)
  && canonicalRepoLockKey(p.entry.repoPath) === key` — a FRESH, VERIFIED resolution onto the SAME physical
  git toplevel as `key`, never a coincidental occupant.
- **Tier 4 (`resolvedKey`)** is DIFFERENT in kind: it matches any UNRESOLVABLE entry whose own
  self-declared `resolvedKey` equals `key` — it does NOT itself verify a genuine identity relationship to
  `key` the way tiers 1-3 do. It is safe here only because `activeMergeQuarantineFor`'s own early return
  (`if (!isRepoPathCurrentlyResolvable(first.entry.repoPath)) return first.entry;`, right after matching)
  fires UNCONDITIONALLY for a tier-4-only match set — tier 4's own predicate requires
  `!isRepoPathCurrentlyResolvable`, so every entry it matches is, by construction, still unresolvable at
  that check — and this function NEVER reaches `consumeMatchedPendingsIntoArmedEntry` with a tier-4-only
  `matched` set today. `enterMergeQuarantine`'s own two callers use only tier-1-equivalent
  (`directPathIdentity`) and tier-3-equivalent (`collectCrossTierSiblingIndices`) matching — never a
  `resolvedKey`-style match — so they are covered by the tier-1/tier-3 argument above, not this carve-out.

## Minor 1 (re-CR `5c20f004`) — accepted residual, identical to main

A non-anchor object `W2` that shares the SAME `directPathIdentity` as an anchor `o`, but is itself neither
`extra` nor any `matched[i].entry` (a THIRD, independent, not-yet-consolidated record of the SAME logical
repo sitting at a secondary key), is OVERWRITTEN in memory by `entryStillOwnsKey`'s identity branch — not
unioned with. This is NOT a new regression: it is IDENTICAL to main's own pre-existing behavior for this
shape (an identity-only match overwrites rather than unions elsewhere in this module too), so this card
neither introduces nor closes it.

**Reachability is narrow:** it requires a THIRD record of the same identity to exist independently of both
`extra` and every `matched[i].entry` at the moment this function runs — i.e., the same repo raised/diverted
through a path that produced a genuinely separate object no earlier consolidation step ever folded in.
Every construction this card's own tests use (the double-boot `W` shape, the boot-diverted twin, the
different-identity sibling-twin) deliberately keeps `W2`'s identity DISTINCT from every anchor precisely
to avoid this shape — so it is not exercised by this card's own test suite, which tests the FOREIGN-`W`
case this card exists to fix, not this accepted SAME-identity residual.

**Why it is not fail-open:** `W2` shares the SAME identity as an anchor already being folded into `armed`
— overwriting it never destroys an unrelated repo's own quarantine. The worst case is losing whichever of
`W2`'s OWN tokens were not already present on the union — the SAME repo's enforcement narrows rather than
vanishes (any token genuinely still outstanding would need to be re-raised to be re-enforced), never a
different repo silently losing its own, wholly unrelated block.

**Suggested future direction:** union `W2`'s own content into `armed` (via `unionQuarantineEntries`) on an
identity-only (non-reference) match, rather than overwriting it outright — not attempted here, since it
widens this card's own scope beyond the anchor-set fix `5c20f004` reviewed.

## Do not

- Do not revert to a bare `for (const k of armedKeys) activeQuarantines.set(k, armed)` at any of the three
  sites in this function — that is exactly the bug this card closes, reachable via the sibling-absorb
  raise path.
- Do not gate a non-anchor key only on reference equality (a bare `replaceEntryEverywhere` scan alone) —
  that misses the round-3 re-CR's "different object, same identity" shape; `entryStillOwnsKey` is required
  for that, and `replaceEntryEverywhere` is required in addition for reference-held slots outside
  `armedKeys` and for pending-twin bookkeeping. Neither alone is sufficient.
- Do not gate a non-anchor key against `extra` alone (round 2) — a bare `matched[i].entry` can itself
  already be armed (a boot-diverted twin, or a different-identity cross-tier sibling with its own stale
  secondary key), with no `extra` involved at all. The anchor set is `extra` (if any) PLUS every
  `matched[i].entry` — never only the former.
- Do not prune `armed.armedKeys` itself to drop a stale member this fix declines to write — the metadata
  field stays as-is (matching the pre-existing convention at `enterMergeQuarantine`'s own raise loop and
  `clearActiveEntryTokenAtKey`'s own clear loop, neither of which prunes `entry.armedKeys` either); only
  the in-memory map WRITE is gated.
- Do not remove `activeMergeQuarantineFor`'s own early return for an unresolvable `first.entry`
  (`if (!isRepoPathCurrentlyResolvable(first.entry.repoPath)) return first.entry;`) without first
  re-reviewing this function's own anchor-set safety argument for the `resolvedKey` tier specifically —
  that tier's own matching predicate does not itself verify a genuine identity relationship to `key` (see
  "Why `W` ... can never land in the anchor set" above), and its safety today rests ENTIRELY on never
  reaching `consumeMatchedPendingsIntoArmedEntry` at all.
- Do not assume a plain TOPLEVEL repo can ever reproduce the `883e29bc` boot-diverted-twin shape by itself
  — a toplevel repo's own degraded (unresolvable) fallback key is IDENTICAL to its own real key (both
  reduce to "this path, no further walk needed"), so parking it never trips PASS 1's `freshHash !== hash`
  migrate/divert branch at all. The entry must be NESTED inside a surviving ancestor repo (own `.git`,
  never removed) so that removing the entry's OWN directory makes the walk degrade to the ANCESTOR's key
  instead — a DIFFERENT value from the entry's own real key. (Round 2's own first draft of the
  `no-extra-graduation-repoints-twin-slot` test used a bare toplevel repo and was VACUOUS — it passed on
  BOTH the pre-fix commit and this fix, because it never reached the degraded-divert branch at all; caught
  only by checking `armedKeys` directly in the precondition, not just an entry count.)

## Test notes

- The reproduction scenario (`stale-armed-key-survives-sibling-absorb-raise`,
  `merge-quarantine-runtime-union-provenance.mjs`) uses a double-boot construction (dual-arm `E` cleanly
  across two boot calls, then a second boot registering only `W` arms it alone at the freed key) to reach
  the stale-key state — this is the only way to reach it TODAY. The round-3 re-CR noted production never
  reboots twice in one process; this test proves the guard, not that the state is reachable in a single
  production process's lifetime.
- SUB-CASE (b) (same-identity-different-object occupant, round-3 re-CR nitpick-6) is built through the
  REAL `883e29bc` boot-diverted-twin path, with a SECOND boot call (`E2`'s own file removed first, a fresh
  file written at `K2` while `E2` is parked) — never "directly in the map" (there is no such seam; the
  module keeps `activeQuarantines` entirely private). Confirmed empirically via a throwaway scratch repro
  before writing it into the suite.
- SUB-CASE (c) (round 2, CR `b166c6e6` item 3): a genuinely different-identity cross-tier sibling that is
  ITSELF a boot-diverted twin, carrying its own stale secondary key `K3` — confirms `K3` is re-pointed to
  the union too, not only `extra`'s own stale keys.
- A SEPARATE scenario, `no-extra-graduation-repoints-twin-slot` (round 2), drives the no-`extra`
  graduation path directly: a bare boot-diverted twin (nested-repo construction, see "Do not" above),
  queried once nothing is yet armed at its real key. Asserts the secondary key's slot is reference-equal
  to the returned union, and that the repo is listed exactly once afterward (never twice).
- `W`'s own assertions: in-memory identity survives (reference AND `directPathIdentity` unequal to the
  union, before vs. after), `activeMergeQuarantineFor(W.repoPath)`/`assertRepoNotQuarantined(W.repoPath)`
  still name `W`'s own identity/reason, `W`'s on-disk latch file is byte-unchanged, and `W`'s quarantine
  still resolves correctly after a restart.
- Round 2's own fix was ALSO verified against the CR's exact mutation (drop the anchor-based loop, keep a
  bare `activeQuarantines.set(key, armed)` plus `replaceEntryEverywhere` for `extra` alone) — sub-case
  (a)/`W` stayed protected under it, while sub-case (b), sub-case (c), and
  `no-extra-graduation-repoints-twin-slot` all went RED, confirming each is a genuine, non-vacuous
  discriminator and not merely a restatement of sub-case (a)'s own check.

Verification: `negative-control --ref <pre-fix sha> --file packages/daemon/src/git/merge-quarantine.ts
--test packages/daemon/test/merge-quarantine-runtime-union-provenance.mjs`, run RED against the real
pre-fix code (never an early-return mutation in the test itself), GREEN after, clean restore — run against
BOTH round 1 (commit `b7fff0f4`, the no-extra-graduation scenario and sub-case (c) RED, sub-case (a)/(b)
still GREEN) and HEAD (round 2's own fix, everything GREEN). Full `merge-quarantine*.mjs` corpus run
serially (one file at a time), `pnpm --filter @loom/daemon guards`, and `pnpm --filter @loom/daemon
build`, all green.
