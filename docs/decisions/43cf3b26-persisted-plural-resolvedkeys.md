# 43cf3b26 — persisted, plural `resolvedKeys`, generalizing Fix 1/48bda567 from one surviving secondary key to N

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 43cf3b26 — persisted, plural `resolvedKeys`, generalizing Fix 1/48bda567 from one surviving secondary key to N

Card `43cf3b26` (widened by gen 417 after this card's own Code Review `cd9b1e3e`). Owns both ACCEPTED
RESIDUALS this record's own "Follow-up 1e739f4a" section documented, plus a FOURTH, independently
reproduced shape never covered by either residual: `consumeMatchedPendingsIntoArmedEntry`'s own
unconditional `resolvedKey: key` self-stamp (`~:1366` pre-fix) silently (no console output anywhere in
the call path, unlike every other collision in this file) discards an already-informative `resolvedKey`
the moment a RESOLVABLE pending entry graduates via a PLAIN QUERY — reachable without 1e739f4a's own
Round-1 divert (removed) ever existing, via the ordinary d163aef5 pending-diversion path alone. Both
residuals and the new silent shape were reproduced hermetically (`merge-quarantine-dual-key-persistence-
43cf3b26.mjs`, scenarios `same-identity-two-tmps`/`different-identity-subpath`/`json-final-loses-to-tmp`/
`pending-consume-no-loss`) before any source edit, per the card's own INVESTIGATE-FIRST instruction.

### The design — widen the existing single-key mechanism, not a new one

`armQuarantineKey` (48bda567) and the PASS 1b promote site (1e739f4a's own Fix 1) already proved out a
safe pattern for preserving exactly ONE secondary key across a boot: never self-stamp an already-
informative scalar `resolvedKey`. The gap was never in-process enforcement (`armedKeys` was already
correct in memory every boot, per this record's own prior "Do not trust armedKeys alone" bullets) — it
was that a scalar field can represent only one secondary identity, so a SECOND one colliding at the same
physical file had nothing to survive in. Rejected alternatives: (a) persist `armedKeys` wholesale,
unconditionally trusted on reboot — reopens the exact "stale persisted value actively misleading" hazard
48bda567's own "Options weighed" flagged, since a key that merely fails to re-arm one boot is not proof it
is permanently invalid; (b) one sidecar file per secondary key — a parallel bookkeeping system (new
naming/scan/orphan-sweep/collision-class) that reuses none of the already-proven `armedKeys` union/clear
machinery; (c) `398f476c`'s own full identity-model redesign (token/key-SET identity, N objects per
union) — correct in the limit but far larger than closing a reboot-persistence gap requires; this fix
never touches the one-union-object-per-key in-memory model `398f476c` owns.

### The fix

A new PERSISTED field, `MergeQuarantineEntry.resolvedKeys?: string[]` — the historical, deduped,
recency-ordered union of every key a logical entry has been armed at, capped at `RESOLVED_KEYS_CAP` (16,
Lead ruling). The legacy scalar `resolvedKey` is UNCHANGED in shape and stays the backward-compat surface
(always one informative key when any exist).

- `unionResolvedKeysRetaining(existing, fresh, label)` (merge-quarantine.ts, next to `isInformativeKey`)
  — the one retention/cap primitive. Moves a re-confirmed key to the end (most-recently-armed); evicts
  from the front past the cap with a loud `console.error` naming the record, the evicted key(s), and this
  card — never silent. A key is removed for NO other reason: no verification in this file proves a key
  that merely fails to re-arm one boot is permanently invalid, so the retention formula is a pure UNION,
  never a fresh recompute that could drop a legitimately-still-valid key that simply wasn't re-armed THIS
  boot.
- `unionQuarantineEntries` folds EACH side's own scalar `resolvedKey` into the result's `resolvedKeys`
  (in addition to unioning any pre-existing arrays) — independent of `explicitResolvedKeyRule`, since this
  is purely additive/historical, never an arbitration concern.
- `consumeMatchedPendingsIntoArmedEntry`'s self-stamp now mirrors `isInformativeKey`'s own guard (never
  overwrite an already-informative scalar) AND folds `unioned.resolvedKey` into `resolvedKeys` directly —
  the single-matched-entry case (case iv's own fixture) never calls `unionQuarantineEntries` at all, so
  this fold is REQUIRED here independently of the union-side fix above. The sibling `raiserUnion` self-
  stamp (the divert branch, still reachable for a genuinely-unreadable degraded occupant) gets the SAME
  `isInformativeKey` guard.
- THE retention formula lives at the ONE write chokepoint, `writeMergeQuarantineLatch`: persist
  `unionResolvedKeysRetaining(entry.resolvedKeys, (entry.armedKeys ?? []).filter(k => k !== ownKey))` —
  the union of whatever was already carried forward with every OTHER key this write's own `armedKeys`
  holds right now, minus the write's own physical target. The scalar `resolvedKey` is re-derived at the
  SAME site: kept as-is when already informative, else promoted from the first surviving `resolvedKeys`
  entry — so an old reader that only ever looks at the scalar still sees exactly one informative key.
- Every boot-time "attempt ONE secondary arm" call site (5 of them: PASS 1's degraded-else-branch and its
  primary+secondary arm, PASS 1b's tmp-residue mirror of both, and the safety-tmp recovery pass) is
  generalized from a single `if (entry.resolvedKey && ...)` into a loop over
  `secondaryKeysToAttempt(entry, anchorKey)` (falls back to the legacy scalar when `resolvedKeys` is
  absent — byte-identical behavior for an old record), threading the accumulator through each attempt
  exactly as the single-key case already did (54054c01's own "second call must build on the first's
  result" rule, now N calls instead of 2).
- PASS 1b's own collision check (the former `console.error` this record's "Follow-up 1e739f4a" section
  shipped) is downgraded to `console.log` — it no longer signals an unrecoverable loss, since both sides
  now survive via `resolvedKeys`; removing it entirely was rejected, since the collision itself (two
  independently-raised quarantines physically sharing one latch file) is still a fact worth a diagnostic
  trail, just no longer an urgent one.
- Every parse site that already whitelists `contributorRepoPaths`/`provenanceTracked` (PASS 1, PASS 1b,
  the safety-tmp recovery pass, the pending-divert reader, `protectOccupantContentBeforeDelete`'s own
  reader) now also whitelists `resolvedKeys` via a shared `parseResolvedKeysField` helper — an unknown
  field in an OLDER record simply parses to `undefined` (no strictness anywhere in this file's parsing:
  `isReadableLatchRecord` only checks `typeof value === "object"`). `protectOccupantContentBeforeDelete`
  and the pending-divert reconciliation path (`~:1997`, the `050a4428` ACCEPTED-RESIDUAL site) both get a
  NEW plural `excludeLiftedResolvedKeys` — the per-element counterpart of the existing
  `excludeLiftedResolvedKey` chokepoint — so a protective copy or a reconciled union can never carry
  forward a key the CURRENT clear/raise is itself lifting, mirroring the scalar's own existing guarantee.

### Backward/forward compatibility

An OLD record (written before this card) has no `resolvedKeys` field at all — every read site falls back
to `[]`/the legacy scalar, byte-identical to pre-card behavior. A NEW record read by an OLD binary: the
old parser's own explicit field whitelist never looks at `resolvedKeys`, so it is silently ignored — no
throw, no corruption — and the old binary's own single-secondary-key behavior applies exactly as before
(a downgrade loses the GENERALIZATION, never any data integrity). Proven directly (`downgrade-compat`
scenario): a real record written by the fixed code, re-parsed through an inlined copy of the OLD
whitelist, still yields exactly one informative scalar `resolvedKey` and never even accesses
`resolvedKeys`.

### Scope note — what this does NOT fix

The union object underlying a multi-key record still carries only ONE `repoPath`/`branch`/`tokens` set —
two colliding identities still cannot be independently cleared from each other (unchanged from before
this card; `7673d096` already treats a same-physical-repo collision this way by design, and a genuinely
different-repo collision is `398f476c`'s own identity-model territory, not narrowed or widened here).
This card closes the REBOOT-PERSISTENCE gap only, exactly as scoped.

### Tests

`merge-quarantine-dual-key-persistence-43cf3b26.mjs` (9 scenarios, all GREEN): the four repro cases above,
plus `registered-y-multi-key` (two reboots, Y registered), `raise-after-boot-multi-key` (a genuine runtime
raise between boot and reboot), `clear-by-path-lifts-all-keys` (every key is lifted by one clear and none
resurrects after a reboot), `resolved-keys-cap-eviction` (17 distinct colliding sources exceed the 16-key
cap; asserts the eviction log fires naming the card and exactly 16 keys survive, all still blocked after a
reboot), and `downgrade-compat` (above). `merge-quarantine-tmp-promotion-dual-arm.mjs`'s own "two-tmps"
scenario is UPDATED (not left as a stale pin) — it now asserts BOTH W1 and W2 stay blocked across two
reboots (the former residual assertion, "W2 unblocked", is retired) and that the boot-0 collision report
moved to `console.log`. All 36 `merge-quarantine*.mjs` files, every other test importing
`merge-quarantine.js`, and `pnpm --filter @loom/daemon guards` re-run clean under both `LOOM_DEV` unset
and `LOOM_DEV=1`.

## Round 2 (Code Review 46c5c492) — SCALAR-ONLY gates that never learned about `resolvedKeys`

Round 1 shipped `resolvedKeys` as a plural, persisted, additive field — but FOUR call sites still gated on
the legacy SCALAR `resolvedKey` alone, reopening fail-opens the plural field was supposed to close.
Reproduced first, hermetically, via the reviewer's own probe scripts (`natural.mjs`, `probe.mjs`,
`probe2.mjs`, `case3.mjs`) before any further source edit.

### CRITICAL (fail-open) — the degraded branch's own divert gate, and PASS 1b's own branch-entry gate

`secondaryKeysToAttempt` already filtered out the walked-up `currentKey`, but the DIVERT-TO-PENDING guard
immediately after the loop (PASS 1's degraded-else branch) still checked only `currentKey !==
entry.resolvedKey` — the bare SCALAR. When the scalar happened to COINCIDE with the degraded, walked-up
`currentKey` (natural.mjs: a dual-armed nested repo Y=R/sub disappears, so Y's own canonical key degrades
to walk up to Kr — the SAME value its own persisted scalar already names), the OTHER key in `resolvedKeys`
still armed correctly, but `currentKey` itself (Y's own identity) was neither armed (this branch never
arms the degraded key directly, by design, 883e29bc) NOR diverted to pending — Y stayed UNBLOCKED even
after being re-created. PASS 1b's own mirror had a WORSE shape: its branch-ENTRY gate itself required
`entry.resolvedKey !== currentKey`, so the same coincidence skipped the whole branch and fell through to a
DIRECT primary arm at the degraded key instead (probe.mjs's "plural" variant: D is never even pending).
`probe2.mjs` found a THIRD shape: the "no key at all" pending gate also checked the scalar alone, so a
record carrying `resolvedKeys` but NO scalar was wrongly treated as a pre-upgrade keyless latch — its own
`resolvedKeys` entry (naming an unrelated repo X) was never even attempted.

**The fix (Lead ruling, verbatim structure):**
- `informativeKeysFor(entry)` — ONE shared helper, the UNION of the scalar and `resolvedKeys` (never
  "array else scalar"). `secondaryKeysToAttempt` is now built on it. Every scalar-only gate (`!entry.
  resolvedKey` at the two "no key at all" pending gates, PASS 1b's own branch-entry gate, the tier-4
  pending match in `findPendingIndicesFor`) now routes through it.
- PASS 1b's branch-entry gate no longer requires `entry.resolvedKey !== currentKey` — ANY unresolvable
  entry enters the degraded branch now, matching PASS 1's own architecture (which never had this
  requirement at entry, only at the exit gate this round also fixes).
- The exit-gate divert push is now UNCONDITIONAL in both PASS 1 and PASS 1b — reached regardless of
  whether the scalar happens to equal `currentKey`, since this branch structurally never arms `currentKey`
  directly either way, so skipping the divert on that coincidence was never safe.
- A SEPARATE, newly-discovered interaction: once a sibling degraded identity sharing the same key
  genuinely lands in `pendingUnresolvedQuarantines` (rather than being silently evicted/unioned into
  `direct`, as the pre-fix code's fallthrough did), `activeMergeQuarantineFor`'s own tier-4 pending
  fallback — purely KEY-based, never identity-based — could shadow an ALREADY-correct `direct` entry with
  an unrelated sibling's content for the exact repoPath being queried. Fixed by skipping the pending
  search entirely when `direct`'s own identity already matches the query (a same-identity `direct` is
  unambiguously the right answer, stronger than anything the pending search could find).

  **Correction (Round 3, Code Review 4c59172f)** — this is NOT a production shadowing scenario the fix
  protects a real caller from. Every production reader of `activeMergeQuarantineFor` reaches it through
  {@link resolveQuarantineFor} (`assertRepoNotQuarantined`/`clearMergeQuarantineReporting`), which for an
  unresolvable `repoPath` already tries `ownIdentityEntryFor` FIRST — a BROADER, identity-based scan of
  every active-or-pending entry — and returns early the instant it finds one. By the time
  `activeMergeQuarantineFor`'s own tier-4 fallback runs inside that call chain, `direct`'s identity can
  never already equal the query's own identity (if it did, `ownIdentityEntryFor` would already have
  matched and returned first), so this guard's own `directPathIdentity(direct.repoPath) !==
  directPathIdentity(repoPath)` condition is always true there — a no-op on that path. The guard is real
  and correct, but it is exercised only by a DIRECT call to the exported `activeMergeQuarantineFor` (a
  test, or any future caller that bypasses `resolveQuarantineFor`), never by the shipped
  `assertRepoNotQuarantined`/clear-reporting call chain. Test coverage added by this round asserts through
  `assertRepoNotQuarantined`, not a bare `activeMergeQuarantineFor` call, for exactly this reason.

### MAJOR (spurious block) — the explicit-rule fail-close only excluded the two SCALARS, never the arrays

`unionQuarantineEntries`'s explicit-rule fail-close (both sides' scalars set and genuinely different) only
ever excluded those two SCALAR values from the `resolvedKeys` fold — `older.resolvedKeys ∪
newer.resolvedKeys` still carried both conflicting keys through UNFILTERED whenever either side ALSO
already had them in its own array (`case3.mjs`'s "newFormat" variant: both records carry `resolvedKeys`
matching their own scalar) — durably blocking the unrelated repo S until a human cleared it, reopening
exactly the fail-closed protection 050a4428/this record's own "Follow-up 4b06875f" established.

**The fix:** decide the conflict over the full KEY SET, not just the scalars — when the explicit rule
fails closed, both conflicting keys are excluded from the ENTIRE union (the pre-existing arrays included),
not merely withheld from being freshly added.

### MINOR (both addressed)

- This record's own "Follow-up 43cf3b26" section (above) claimed the scalar fold was "independent of
  `explicitResolvedKeyRule`" — FALSE, per the MAJOR fix above; recorded here rather than silently amended,
  since the claim was wrong when written, not merely superseded.
- The degraded-else branch's own "every candidate occupied" log wording fired even when there were ZERO
  candidates to attempt (claiming "ALREADY occupied by a VERIFIED entry" when nothing was ever attempted)
  — now gated on `secondaryCandidates.length > 0`, so it only ever fires when every candidate was
  genuinely attempted and refused.

### A further, newly-discovered interaction — a later raise correctly UNIONS with a surviving prior raise

`merge-quarantine-protect-read-failure.mjs`'s own "tp" and "round3-b2" scenarios use the SAME
coincidentally-matching-scalar shape this round's CRITICAL fix targets (D=R/gone-subdir, resolvedKey=Kr=
D's own walked-up key) — but for a DIFFERENT reason (testing a read-failure-during-clear interaction, not
boot-arm generalization). Pre-fix, D's own tautological primary arm EVICTED R (the resolvable repo whose
own key D's degraded identity coincidentally shares) at boot, and R's LATER clear then collaterally
destroyed D's own content as a side effect of clearing R's own key — this is what made D appear to "start
clean" on a later re-raise; it was never actually testing round 3's own stub-removal, since the fixture's
`dTmpFile` never goes through the real stub-minting code path at all. Post-fix, D's own degraded identity
is diverted to pending at boot, INDEPENDENT of R's key — so D's own (real, non-stub) prior content SURVIVES
R's clear untouched, and a later re-raise on D correctly UNIONS with it (this module's own stated
multi-token design: "a repo can be quarantined by more than one outstanding unconfirmed kill at once"),
keeping the older side's branch/reason and BOTH tokens. The affected assertions are UPDATED to assert this
directly (confirmed via a before/after-clear state dump against the fixed code), not silently loosened —
the round-3 M3 checks (no empty/stub branch, no ownership-anchor reason) are UNCHANGED and still pass,
confirming the actual stub-removal mechanism is untouched.

### Tests (Round 2)

Each finding reproduced hermetically via the reviewer's own probe scripts BEFORE any source edit, then
proven RED on commit `16b45535` (round 1) and GREEN after, via committed scenarios:
`merge-quarantine-dual-key-persistence-43cf3b26.mjs` gains `degraded-divert-after-disappear`
(`natural.mjs`), `degraded-branch-scalar-coincidence` (`probe.mjs`, legacy+plural), and
`plural-only-no-scalar` (`probe2.mjs`). `merge-quarantine-raise-protect-failure.mjs` gains a new-format
sibling of its own "UNION RULE case 3/3" (`case3.mjs`). `merge-quarantine-protect-read-failure.mjs`'s own
"tp"/"round3-b1"/"round3-b2" scenarios are UPDATED (3 assertions re-grounded, not silently weakened) to
assert the newly-correct behavior described above. All 36 `merge-quarantine*.mjs` files, every other test
importing `merge-quarantine.js`, and `pnpm --filter @loom/daemon guards` (30/30) re-run clean under BOTH
`env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`.

## Round 3 (Code Review 4c59172f) — the explicit-rule conflict check still compared only the two SCALARS, and PASS 1b's own resolvable secondary-arm loop never threaded its own accumulator

Round 2 shipped `informativeKeysFor` (scalar UNION `resolvedKeys`) at every GATE that decides whether a
key is worth attempting at all — but `unionQuarantineEntries`'s own explicit-rule CONFLICT ARBITRATION
(`explicitRuleFailedClosed`/`conflictExclusions`, ~:706-707 pre-round-3) still compared `older.resolvedKey`
against `newer.resolvedKey` directly — the bare scalars, never the full informative sets. An ARRAY-ONLY
side (a record whose only informative key lives in `resolvedKeys`, with no scalar at all — reachable via
`protectOccupantContentBeforeDelete`'s own separate scalar/array carry-forward filtering, `~:1980-1987` →
`writePendingDivertFile`, `~:1823`) made the scalar comparison see `undefined` on one side, so it took the
"one side undefined, keep the other" branch — the array's OWN conflicting key sailed through UNFILTERED,
durably blocking an unrelated repo S. A SEPARATE, independent finding (missed in round 1, present since
`16b45535`): PASS 1b's own RESOLVABLE secondary-arm loop (the loop pairing PASS 1's `~:4729-4738` primary-
arm-loop; PASS 1b's own copy sat at `~:4948-4953` pre-round-3) passed the SAME `armedTmpEntry` to every
`armKeyUnlessDegradedCollision` call across its iterations instead of threading the prior call's own
result forward — invisible with exactly one secondary key (nothing ever reads the stale accumulator
again), but with TWO OR MORE secondaries this left each key in `byRepoKey` pointing at a DIFFERENT object
for the SAME logical identity: `armQuarantineKey`'s own write (`for (const k of armed.armedKeys ?? [key])
byRepoKey.set(k, armed)`) stamps every key in the RESULT's own `armedKeys` with whatever it was called
with. The pre-loop accumulator's own `armedKeys` holds only the ANCHOR key (`Ky`, from the primary arm run
before the loop) — never any secondary the loop has already processed, since the (buggy) accumulator is
never updated. So the LAST secondary call in iteration order, still built on that un-updated pre-loop
entry, unions `[Ky]` with its own key and writes a FRESH object to BOTH `Ky` AND itself — silently
re-pointing the ANCHOR's own slot away from whatever the EARLIER call(s) had built there. Every
earlier-processed secondary key is left pointing at that earlier, now-orphaned object, which nothing will
ever update again (the loop never revisits it). `assertQuarantineIdentityInvariantTestOnly` then reports
more than the one legitimate active+pending pair for the identity, and clearing via the mounted repo's own
canonical key (`Ky`) only reaches the LAST-processed secondary's object — every EARLIER-processed
secondary key stays armed in-process until a restart re-derives a single, consistent union from disk.
**Round 3's own first test draft got this backwards** (see Code Review `5220fda9`'s correction) — in the
`resolvedKey: K1, resolvedKeys: [K1, K2]` fixture, `informativeKeysFor` enumerates `[K1, K2]` in that
order (scalar first), so K1 is armed FIRST and is the one left orphaned; K2, armed LAST, always ends up
correctly co-located with the anchor even pre-fix in this exact two-secondary case.

### The fix

- `unionQuarantineEntries`'s own conflict decision now computes `A = informativeKeysFor(older)`, `B =
  informativeKeysFor(newer)` FIRST (moved ahead of the scalar `resolvedKey` computation, which now reads
  the result). Lead ruling, the exact SET semantics: if EITHER set is empty, no conflict is possible —
  union everything, exactly as the legacy "one side undefined" rule already did. If BOTH are non-empty,
  keep the INTERSECTION (the keys both sides genuinely agree on) and exclude the WHOLE SYMMETRIC
  DIFFERENCE (A\B ∪ B\A) from the union — arrays included, not merely the two scalars. This reduces
  exactly to the pre-existing scalar rule whenever each side carries exactly one key (equal ⇒ keep; both
  different ⇒ exclude both) — the one-element-set special case of the general rule, not a parallel rule
  living beside it.
- The scalar `resolvedKey` itself is ALSO re-derived against the SAME `conflictExclusions` set (never the
  bare "one side undefined ⇒ keep the other" check alone) — without this, a scalar that happens to be the
  ONLY informative key on its own side could resurrect a key the array-level fold just correctly excluded
  (e.g. `olderArrayOnly`'s own shape: the array side's lone key and the scalar side's lone key are both
  excluded by the symmetric-difference rule at the ARRAY level, but the UNCHANGED pre-round-3 scalar
  branch — "one side undefined, keep the other" — would have handed the scalar side's own key straight
  back as the returned `resolvedKey`, reopening exactly the bug the array-level fix just closed one field
  over). `informativeKeysFor` always unions scalar and array on every future read, so a scalar the
  conflict decision didn't also exclude is just as informative as one the array carries.
- PASS 1b's own resolvable secondary-arm loop now threads its accumulator through each
  `armKeyUnlessDegradedCollision` call exactly like PASS 1's sibling loop and the safety-tmp recovery
  loop already did (`let armedTmpEntry = ...; ...; if (dualArmed !== undefined) { armedTmpEntry =
  dualArmed; byRepoKey.set(currentKey, armedTmpEntry); }`) — the THIRD of three structurally-identical
  loops in this file, now byte-for-byte the same shape as the other two.

### Scope clarification — the tier-4 "shadowing" guard is a direct-call path only

Round 2's own "A SEPARATE, newly-discovered interaction" paragraph (above) described
`activeMergeQuarantineFor`'s tier-4 pending-fallback skip as protecting a real caller from a sibling
shadowing an already-correct `direct` entry. Round 3 (Code Review 4c59172f) found this guard is never
actually reached that way in production: every shipped caller (`assertRepoNotQuarantined`,
`clearMergeQuarantineReporting`) resolves through `resolveQuarantineFor`, which for an unresolvable
`repoPath` already tries the BROADER, identity-based `ownIdentityEntryFor` first and returns the instant
it finds a match — so by the time `activeMergeQuarantineFor`'s own tier-4 fallback would run inside that
call chain, `direct`'s identity can never already equal the query's own identity (if it did,
`ownIdentityEntryFor` would already have matched and returned). The guard is real, correct, and NOT
removed — it is exercised only by a direct call to the exported `activeMergeQuarantineFor` (a test, or any
future caller that bypasses `resolveQuarantineFor`). See the correction inserted directly under Round 2's
own paragraph above for the full argument. The stale comment at the top of PASS 1b's resolvable branch
("`entry.resolvedKey` is guaranteed set here") is also corrected to name `informativeKeysFor(entry)`,
never the bare scalar.

### Tests (Round 3)

Both findings reproduced hermetically (ad hoc scratch scripts against the real compiled module, never the
reviewer's own probe scripts — those lived in a prior session's own scratchpad, unreachable here) before
any source edit, then proven RED on commit `506c3159` (round 2) and GREEN after, via
`pnpm --filter @loom/daemon negative-control --ref HEAD --file packages/daemon/src/git/merge-quarantine.ts
--test <file>`:
- `merge-quarantine-raise-protect-failure.mjs` gains three scenarios beside its own "case 3/3"/new-format
  pair, all asserting through `assertRepoNotQuarantined` (never a bare `activeMergeQuarantineFor` call —
  see the scope clarification above for why that matters here specifically): `olderArrayOnly` (the OLDER
  pending record is array-only, the twin is scalar-only), `twinArrayOnly` (the mirror shape), and
  `[Kt,Ks]-vs-[Ks]` (the OLDER record carries BOTH keys, the twin carries only the agreed one — asserts
  the asymmetric-intersection case directly: S, the agreed key, correctly STAYS blocked, while T, the
  symmetric-difference key, is correctly excluded — the one shape a scalar-only rule could never express
  at all, since a scalar can hold only one value per side).
- `merge-quarantine-tmp-promotion-dual-arm.mjs` gains `identity-invariant-two-secondaries` (Y mounted
  throughout, one tmp carrying two secondary keys, asserts `assertQuarantineIdentityInvariantTestOnly().ok`
  plus that `clearMergeQuarantine(Y)` unblocks BOTH secondaries in-process) and its own remount variant,
  `identity-invariant-two-secondaries-remount` (Y unresolvable at boot-0, so the already-correct degraded
  branch runs first; Y is then created for real and a second boot exercises the FIXED resolvable loop
  against the same on-disk tmp).

**Correction (Code Review `5220fda9`, HEALTHY, no blockers)** — the `identity-invariant-two-secondaries`
(and its remount sibling) post-clear checks originally asserted via a bare `activeMergeQuarantineFor` call;
switched to `assertRepoNotQuarantined(w).ok`, the shipped entry point, matching the other new scenarios'
own posture. The accompanying check LABEL also misnamed which key gets orphaned pre-fix ("K2 pointed at a
DIFFERENT object") — see "The fix" paragraph above (now corrected) for the real mechanism: K1 (armed
FIRST, per `informativeKeysFor`'s own `[scalar, ...array]` enumeration order) is the one left stale; K2
(armed LAST) always shares the anchor's final object even pre-fix in this exact two-secondary case, so
its own check is the non-discriminating sibling of K1's. Re-proven RED on commit `9aab9b03` (test-only,
pre-fix) and GREEN on the restored fix, via the same `negative-control` invocation.

All 36 `merge-quarantine*.mjs` files plus every other test importing `merge-quarantine.js` (50 files total)
re-run clean under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`; `pnpm --filter @loom/daemon
guards` is 30/30; `node packages/daemon/assets/comment-anchor-lint.mjs .` reports `orphanAnchors: 0`.
