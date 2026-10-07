# e1cb7d33 — a runtime write never destroys a degraded occupant's only durable copy (clear-side is OUT OF SCOPE, see below)

From Code Review `baecb690` (review of `a2f381dc`) — PRE-EXISTING on main, reproduced on a main-equivalent
dist. `activeMergeQuarantineFor`'s fast-path sibling absorb and lazy-graduation tail (both funnel through
`consumeMatchedPendingsIntoArmedEntry` → `writeMergeQuarantineLatch`) wrote a runtime union straight to a
key's physical file without checking whether that key's own file is a DIFFERENT, currently-unresolvable
entry's (a degraded occupant's) exclusive backing — the boot passes already check this
(`degradedOccupiedKeys`/`bootWriteLatch`), but the runtime write path did not. A worker's first-draft fix
(an unconditional guard inside `writeMergeQuarantineLatch`) turned 18 real boot-path scenarios RED across
`merge-quarantine-identity-split-sync.mjs` (4), `merge-quarantine-latch-id-collision.mjs` (3) and
`merge-quarantine-migrate-source-owner-durable.mjs` (11) — `ef651188`'s Phase 0 safety-tmp already
protects boot writes, so the target file is legitimately overwritten there after a backup exists.

## Do not

- Do not make `writeMergeQuarantineLatch`'s own degraded-occupant guard (`wouldOverwriteDifferentUnresolvableOccupant`
  / `differentUnresolvableOccupantRepoPathAt`) unconditional. It is DEFAULT-ON (fail-closed) with exactly
  TWO explicit opt-out families on `writeMergeQuarantineLatch`'s own `skipDegradedOccupantGuard`
  parameter, never a third without re-deriving why it's safe:
  1. `reenterMergeQuarantinesAtBoot`'s `bootWriteLatch` wrapper (Phase 0's safety-tmp already secures any
     at-risk degraded occupant's content before a boot write that could collide with it runs).
  2. Every one of `enterMergeQuarantine`'s own write call sites — the "brand new entry" branch's direct
     write, the "existing" branch's direct write, and both of its own `consumeMatchedPendingsIntoArmedEntry`
     calls (the "existing" branch's sibling absorb AND the pending-merge branch). A refused RAISE is never
     persisted, so it would be silently LOST at the next reboot (enforcement failing OPEN) — strictly
     WORSE than this shape's own pre-existing behavior (the raise overwrites the degraded occupant's file,
     destroying ITS identity, but the raise itself survives a reboot). See `merge-quarantine-degraded-
     occupant-guard.mjs`'s `fresh-raise-survives-reboot` (the "brand new entry" branch) and
     `pending-merge-fresh-raise-survives-reboot` (the pending-merge branch) scenarios for the verified
     RED/GREEN proof of both this opt-out's necessity AND the occupant-overwrite residual it restores.
  A future RUNTIME caller that forgets the flag must fail CLOSED, never silently inherit an open guard —
  never flip the default, and never add a third opt-out call site without re-deriving why it's safe the
  way `enterMergeQuarantine`'s own reasoning above is. `enterMergeQuarantine`'s opt-out mirrors
  `bootWriteLatch`'s own — never re-add the guard there "for symmetry" with the query-side
  (`activeMergeQuarantineFor`) paths, which correctly stay guarded because a QUERY has nothing to lose by
  refusing (nothing new is being raised).
- Do not assume `activeMergeQuarantineFor`'s own two call sites are the only GUARDED (non-opted-out)
  writes — `clearMergeQuarantineByToken`'s own partial-clear write and `quarantineAllRegisteredFailClosed`
  (the boot-time fail-closed-on-corrupt-latch-directory path) ALSO call `writeMergeQuarantineLatch` with
  no `skipDegradedOccupantGuard` argument (defaulting `false`), so both are guarded too. Their fail-closed
  behavior on refusal: `clearMergeQuarantineByToken`'s partial clear leaves the PRE-EXISTING durable state
  untouched (the just-cleared token stays counted as outstanding until fixed — delays the eventual full
  lift, never a false lift); `quarantineAllRegisteredFailClosed`'s own fail-closed quarantine stays
  enforced in-memory only for that process and does NOT survive a restart until the collision is
  resolved — logged exactly like any other refused write, never silently swallowed.
- **RETRACTED — clear(S) is OUT OF SCOPE for this card, never refuse it.** A draft ruling made
  `clearMergeQuarantineByKey`/`deleteMergeQuarantineLatchByKey` refuse an ORDINARY clear of a resolvable
  repo whenever its own key's physical file turned out to be a DIFFERENT, unresolvable degraded occupant's
  exclusive backing. That draft was tried, built, and tested, then RETRACTED before merge — do not
  re-introduce it. Two independent reasons, both found by running the FULL `merge-quarantine*.mjs` corpus
  (not just this card's own new scenarios) before reporting done:
  1. **Card `d4b25feb` already owns this exact consequence, and the established precedent is that the
     clear PROCEEDS.** `docs/decisions/4480b077-migrate-branch-unions-fresh-hash-target.md`'s own
     "Known-open residual" section states, verbatim: *"`clearMergeQuarantine(y)` (the ordinary, legitimate
     human clear for the resolvable repo)... deletes `sha(Ky).json` — which... is `X`'s own, unrelated,
     physically separate backing file... Measured: it reproduces... not fixed by this card. Tracked on
     card `d4b25feb`."* `test/merge-quarantine-pass1-migrate-union.mjs`'s own
     `in-memory-twin-clear-destroys-degraded-file` scenario (card `4480b077`/`c870618c`) asserts the clear
     PROCEEDS (Y's own stale source is swept, Y does not resurrect) and deliberately only REPORTS, never
     asserts, whether X's file survives — BY DESIGN, because `d4b25feb` is explicitly out of that card's
     own scope too. `test/merge-quarantine-pass1-degraded-union-guard.mjs`'s own
     `stale-armedkeys-no-collateral` scenario (card `883e29bc`) builds the IDENTICAL shape (X unresolvable,
     `resolvedKey` manufactured to collide with real/resolvable Y's own key, X's latch file realistically
     named `sha(Ky).json`) and asserts `clearMergeQuarantine(y)` SUCCEEDS, lifting X's active arm. The
     draft refusal broke both — 7 assertions across the two files — by silently overriding an
     already-established, already-tested architectural decision it never checked against.
  2. **The refusal predicate was ALSO the wrong mechanism, independent of (1).** A bare
     `differentUnresolvableOccupantRepoPathAt(finalForKey, identityRepoPath)` compare, run per-key inside
     `clearMergeQuarantineByKey`'s own `keysToLift` loop, cannot distinguish "this OTHER key's physical
     file is a genuinely unrelated degraded occupant" from "this OTHER key's physical file is the SAME
     logical entity's own co-identity, legitimately dual-armed under more than one key." The UNION-KEYS
     fixture in `test/merge-quarantine-unresolvable-path.mjs` (card `54054c01`) dual-arms ONE entity under
     two keys after a union; clearing via EITHER key is supposed to lift both, by design — the draft
     predicate false-refused this, because it never checked whether the "different" identity it saw was
     actually a member of the SAME entry's own union. **Constraint for any future clear-side fix (for
     `d4b25feb` or otherwise): a candidate predicate must positively distinguish "a genuinely separate,
     unrelated occupant" from "this same entry's own other armed-key identity" — comparing bare repoPath
     strings is not enough; it would need to reason about the entry's own `armedKeys`/union membership
     first.**
  `deleteMergeQuarantineLatchByKey` is therefore back to its original signature (`key: string): void`,
  unconditional, and `clearMergeQuarantineByKey`/`clearMergeQuarantine`/`clearMergeQuarantineByRecordedPath`/
  `clearMergeQuarantineReporting`/`clearMergeQuarantineLatchFile` are all back to their pre-this-card
  shapes — none of them know anything about the degraded-occupant guard. Only the WRITE side and
  `enterMergeQuarantine`'s own opt-out (both ruled on above) remain in scope.
- Do not assume `enterMergeQuarantine`'s "brand new entry" branch (no existing armed entry at `key`, no
  pending match) is unreachable when a degraded occupant shares the same key. It IS reachable, but ONLY
  when the occupant is a genuinely PURE-PENDING entry (no `resolvedKey` recorded at all — a pre-upgrade
  latch) — an occupant WITH a `resolvedKey` matching the query's own key gets ARMED DIRECTLY into
  `activeQuarantines` at that key during boot (PASS 1's degraded-arm branch, `armQuarantineKey(byRepoKey,
  entry.resolvedKey!, entry)` with `prior` usually `undefined`), so `enterMergeQuarantine`'s OWN `existing`
  branch (merge a token into the occupant's own entry, keeping the occupant's own identity/branch/reason)
  is what actually runs in that shape instead — a COMPLETELY DIFFERENT, pre-existing code path this card
  does not touch. Do not conflate the two shapes when reasoning about reachability.
- **The residual this reopens (REPORT UP, do not silently fix):** in the exact fixture shape this reaches
  (a degraded occupant with NO `resolvedKey` recorded — a pre-upgrade/pure-pending latch — physically
  occupying the exact key a BRAND NEW raise targets), the raise's write now PROCEEDS and overwrites that
  occupant's own physical file, destroying its identity outright — this is `enterMergeQuarantine`'s own
  PRE-EXISTING behavior for this shape (verified: identical before any of this card's changes), restored
  rather than introduced by the opt-out above. A real safety-copy mechanism for this one shape (mirroring
  boot's own `writeSafetyTmpResidueAtHash` — write a safety-tmp of the occupant's content at its own hash
  BEFORE letting the raise's write proceed) was deliberately NOT built in this card; the worker reported
  reachability + the exact shape up instead of building it unprompted, per standing doctrine. See
  `merge-quarantine-degraded-occupant-guard.mjs`'s own `fresh-raise-survives-reboot` scenario for the
  verified RED (opt-out dropped ⇒ the raise fails to survive a reboot) / GREEN (opt-out in place ⇒ the
  raise survives, the occupant's own file is overwritten) proof of both halves of this trade-off.
- Do not trust a hand-traced mental model of which boot-time branch (degraded-arm-and-skip vs. the plain
  migrate-write) a given fixture shape will hit, or which identity wins `unionQuarantineEntries`'s own
  "earlier `enteredAt` wins" tie-break — VERIFY empirically against the real dist build before writing
  assertions. Three rounds of this card's own test-writing produced plausible-looking but WRONG traces
  (assuming a degraded occupant always stays pure-pending; assuming a `direct`-fast-path occupant losing
  the tie-break still reaches the write call; forgetting a `reenterMergeQuarantinesAtBoot` call across a
  reboot and mis-attributing the resulting failure to a code defect) — each was only caught by actually
  running the fixture and reading the real returned object, never by re-reading the source more carefully.
  A 4th instance (round 2): a lead ruling assumed the OPPOSITE age order (X older, winning the tie-break)
  would still reach and succeed through the sibling-absorb write call, with teamA's stale latch unlinked.
  Verified FALSE against the real dist build (debug-instrumented): `activeMergeQuarantineFor`'s `direct`
  fast path gates on `isKeyVerifiedFor(direct.repoPath, key)`, true only when the WINNING identity both
  resolves and canonical-keys back to `key` — X never resolves, so whenever X wins, that check is false
  and the function returns early, NEVER reaching the write call at all. The write path is reachable via
  this call ONLY when the RESOLVABLE side wins — structurally, not as a fixture artifact. See
  `merge-quarantine-degraded-occupant-guard.mjs`'s own `absorb-xolder` checks for the verified-true
  assertions this card carries instead (nothing is overwritten and nothing is unlinked, for a DIFFERENT
  reason than the teamA-older case: the write is never attempted, not merely attempted-then-refused).
- Do not write a negative control that merely LOOKS like it exercises a guarded branch — verify it by
  actually disabling that exact branch and confirming the control goes RED for the RIGHT reason, not just
  that something else happens to fail or pass. This card's own `negative-control-resolvable-occupant-still-overwrites`
  scenario passed "for the wrong reason" TWICE, for two DIFFERENT reasons, each only caught by the same
  discipline (disable the branch, confirm the control still — wrongly — passes):
  1. (round 1) The colliding file had already been migrated away by `reenterMergeQuarantinesAtBoot`'s own
     migrate pass before the write it was meant to test ever ran. Round 1's fix: skip the boot call
     entirely and exercise `enterMergeQuarantine`'s own "brand new entry" branch directly against a
     freshly-imported, boot-free module.
  2. (round 2) That round-1 fix was ITSELF vacuous, discovered only after `638136c3` made
     `enterMergeQuarantine` opt OUT of this guard entirely (ruling 3/2 above) — an opted-out caller can
     never exercise a guard it never consults, so "not refused" proved nothing about the guard's own
     resolvability discrimination. Round 2's fix: drive the write through a GUARDED caller instead —
     `activeMergeQuarantineFor`'s own bottom graduation tail, with the resolvable-but-misplaced occupant
     planted directly at the physical hash AFTER a boot call (never through boot's own migrate pass,
     which would otherwise relocate it before the graduation query ever runs — the SAME vacuity trap as
     round 1, reached a different way). Do not assume "drove it through `enterMergeQuarantine`" is
     sufficient ever again — check which of ITS OWN call sites (opted-out, every one) vs.
     `activeMergeQuarantineFor`'s (guarded, both of them) a control actually reaches.

## Scope note (what this card does NOT fix)

Once a degraded occupant's identity is subsumed into a sibling's own union-won identity (whichever side
`unionQuarantineEntries` picks by earlier `enteredAt`), the LOSING side is no longer independently
queryable by its own `repoPath` in that process (`activeMergeQuarantineFor(loser)` returns `undefined`) —
this is the PRE-EXISTING query/identity-model gap card `398f476c` tracks, and it is unaffected by this
card either way: durability (this card's own scope) and query/identity (398f476c's scope) are different
problems. Verified this gap is NOT new and NOT made worse here — the losing side's own physical file stays
fully intact on disk regardless (this card's actual guarantee), recoverable by a human via its own latch id
even while unqueryable by repoPath.

Tests: `packages/daemon/test/merge-quarantine-degraded-occupant-guard.mjs` (5 scenarios, round 2: the
runtime sibling-absorb and lazy-graduation write paths both refuse, in BOTH tie-break age orders (the
sibling-absorb scenario's own `absorb-xolder` checks, plus a 3rd boot for stability — see the hand-traced-
tie-break note above for why the X-older order's VERIFIED-true assertions differ from a naive
expectation); `fresh-raise-survives-reboot` and `pending-merge-fresh-raise-survives-reboot` together prove
BOTH of `enterMergeQuarantine`'s own reachable opt-out shapes restore pre-fix durability for the raise
while documenting the occupant-overwrite residual above; and a negative control (round 2: redesigned to
go through a GUARDED caller — see its own "Do not" bullet above) proving the guard still allows a
legitimate resolvable-different-identity overwrite). The clear-side scenarios from the retracted draft
were removed entirely, not left in a disabled/skipped state. Verified GREEN, with NO regression, against
the FULL `merge-quarantine*.mjs` corpus (all 26 files, serial, each its own `LOOM_HOME`) — including,
specifically, `merge-quarantine-identity-split-sync.mjs`, `merge-quarantine-latch-id-collision.mjs` and
`merge-quarantine-migrate-source-owner-durable.mjs` (the 18 the unconditional first draft had turned RED),
and `merge-quarantine-pass1-degraded-union-guard.mjs`, `merge-quarantine-pass1-migrate-union.mjs` and
`merge-quarantine-unresolvable-path.mjs` (the 3 the now-retracted clear-refusal draft had turned RED) —
all green with the DEFAULT-ON write guard + boot opt-out + `enterMergeQuarantine` opt-out in place, and
no clear-side guard anywhere.
