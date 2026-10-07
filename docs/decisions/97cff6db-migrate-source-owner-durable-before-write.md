# 97cff6db — a migrating key's own data is durably secured BEFORE any write that could clobber its stale source

From the `4480b077` round-3 Code Review (reviewer `3ac19e17`, 2026-10-06), finding 1 (MAJOR) + Minor 2.
Lead decision: `4480b077` landed (net improvement over main, where the same per-file overwrite shape
already existed mid-loop); this card is the follow-up. **Round 5** (this revision) is a small, targeted
fix on top of round 4's own fix, which Code Review `e0777155` found NOT MERGEABLE on one blocking gap
(the branch stayed SAFER than main overall — 21/22 durability scenarios RED on main, GREEN on this
branch). **Round 4** replaces round 3's own fix, found NOT MERGEABLE by Code Review `2b079f86` — the
branch was WORSE than main in two shapes (G1, G2 below). Round 3 itself replaced round 2's own fix, found
NOT MERGEABLE by Code Review `b8a7b74f` at commit `cae8e750`. Rounds 1-4's own narratives are kept below,
compressed, because the counter-examples that killed each are exactly what the next round's design answers.

## The bugs (round 1's own framing — all four still accurate as PROBLEM statements)

**Finding 1 (MAIN)** — a sibling key's successful write in the SAME write-all pass can destroy a failed
key's only durable copy: `teamA`'s stale latch sits at `sub`'s own stale-collision target `sha(Kp).json`
(the `migrate-source-collides-with-sibling-target` shape `4480b077` round 3 already established).
`teamA`'s write succeeds; `sub`'s own write (to `sub`'s fresh target) FAILS (an open/write fault — never a
rename fault, which already leaves a recoverable fsync'd tmp); the failure branch's "left in place so
nothing is lost" log was FALSE the instant `teamA`'s write had already overwritten that exact file.

**Finding 1a** — the identical hazard existed, completely unguarded, at a SECOND write call site: PASS
1b's own tmp-promotion write never consulted `migratedSourcesByKey` or any cross-pass protection at all.

**Finding 1b** — "no fault needed": the degraded-occupied skip folds a colliding sibling's migrate source
into the DEGRADED occupant's own in-memory `orphanLatchFiles` ONLY, with no separate identity recorded
anywhere for the sibling. An ORDINARY, correct clear of the unrelated degraded entry then deletes the
sibling's only durable copy as pure collateral, via `sweepOrphanLatchFileIfUnreferenced`'s "nothing
references it, delete" check. Mirrors (opposite direction) card `d4b25feb`'s own tracked "in-memory twin"
issue; fixed HERE by Lead ruling, not deferred.

**Minor 2** — the degraded-occupied fold's own `byRepoKey` mutation (a NEW object, via spread) runs AFTER
`flushDegradedDiverts()` already snapshotted the PRE-fold object into `pendingUnresolvedQuarantines`;
`listActiveMergeQuarantines` (Set-dedupes by reference, never value) reports the same quarantine twice.

## Round 1's fix — NOT MERGEABLE (Code Review `85f0f345` at `0f324c36`)

Round 1 added `writeSafetyTmpResidue` (a `.json.tmp-<pid>-<hex>` residue — INDISTINGUISHABLE by name from
an ordinary stale tmp), called it INLINE inside the migrate-pass's own per-key loop immediately before
that key's own real write, gated on an `isAtRisk` check computed from `migratedSourcesByKey` and
`tmpsToUnlinkByKey` alone, and added per-source `pendingUnresolvedQuarantines` entries (using each
source's own standalone entry, `originalEntryBySource`) for the degraded-occupied fold. The reviewer
confirmed `originalEntryBySource`, the Minor 2 re-point, removing a (redundant) tmp-promotion safety-tmp,
and the `isAtRisk` gating mechanism itself as SOUND — all four survive into round 2 unchanged. Three
findings killed the rest:

**CRITICAL 1 — wrong ORDERING, not just an ungated write.** The safety-tmp was written immediately before
the SAME key's own write, never before a SIBLING's write that could clobber its source FIRST. With
`readdirSync`/Map-insertion order putting `teamA` ahead of `sub`, `teamA`'s ENTIRE write-and-fold iteration
could complete — overwriting `sub`'s only copy — before `sub`'s own loop iteration, and therefore its own
safety-tmp, had even started. Reproduced with NO fault injection at all (repro D): snapshot the disk at the
exact instant `sub`'s safety-tmp open begins, "crash" (discard anything written after), reboot — `sub` is
gone. A write-fault-only test (round 1's own `finding1` scenario) structurally cannot see an ordering bug.

**CRITICAL 2 — two OTHER boot-time writes were completely ungated.** `reenterMergeQuarantinesAtBoot` has
MORE than the two write-all passes round 1 protected: (a) the deferred-corrupt-tmp resolution's "no real
sibling data" branch fabricates and writes a placeholder DIRECTLY, with no deferral and no gating at all
(repro B: `teamA`'s only evidence is a CORRUPT torn-write tmp at its own hash; this write destroys `sub`'s
still-present stale source before `sub`'s own (round-1-inline, and therefore too-late) protection could
ever run); (b) PASS 2's own orphan-reference writes — BOTH its "existing, add orphan ref" branch AND its
"no existing entry, fresh placeholder" branch — are equally ungated (repro C: an unrelated orphan file
makes PASS 2 fabricate a placeholder for `repo`/`teamA`, sharing one key with no entry of their own, and
that write lands on `sub`'s own still-present stale source). `sub` survived repro C in round 1's own
testing only by the accident that round 1's `isAtRisk` set happened to be non-empty for an unrelated
reason in that specific fixture — not because PASS 2 was protected.

**MAJOR 3 — the "blind-delete is always safe for a safety-tmp" premise was FALSE.** PASS 1b's "tmp beside
a clean final → delete" shortcut gates on `cleanlyParsedKeys`, which ANY non-placeholder `.json` resolving
to a key populates — not specifically the one true, already-at-its-own-hash final. Repro A: `sub` has TWO
stale sources — `s1` at the usual colliding path, and a second, entirely non-colliding `s2` (an ordinary
extra raise). `s2`'s own clean parse populates `cleanlyParsedKeys` for `sub`'s key BEFORE `sub`'s own fresh
final has ever been durably written this boot. On a restart after `sub`'s real write fails, PASS 1b finds
`sub`'s (round-1-shaped, indistinguishable-by-name) safety-tmp, sees `cleanlyParsedKeys.has(Ksub)` already
true (because of `s2`, not because `sub`'s own final exists), and BLIND-DELETES the safety-tmp — `s1`'s
token/reason/branch/opId are gone, permanently. Inferring "this must be a safety-tmp, so it's safe to
delete" from circumstantial state (an at-the-time-plausible but unverified premise) is exactly the mistake
Lead ruling 2 below closes structurally.

## Round 2's fix — NOT MERGEABLE (Code Review `b8a7b74f` at `cae8e750`)

Round 2 closed round 1's three findings (CRITICAL 1/2, MAJOR 3) and its own ordering/naming/idempotence
held up; the reviewer confirmed repros A–D closed. Two findings remained, both in the SAME blind spot —
every write site round 2 gated assumed the at-risk key's own data was reachable via `byRepoKey.get(key)`'s
`.repoPath`, which silently fails once a DEGRADED entry's own unresolvable identity is mixed into that
union:

**CRITICAL (repro E, NO fault needed) — a degraded-occupied migrate source got no protection at all.**
Phase 0's own at-risk computation `continue`d past any key in `degradedOccupiedKeys`, reasoning that
nothing writes to a degraded-occupied key's OWN target this boot (true) — but never asked whether some
OTHER, non-degraded sibling's write could land on THAT key's migrate SOURCE anyway. It can: `sub`'s only
latch sits at `sha(Kp).json` (the usual collision — `teamA`'s own correct target), and `sub`'s migrate
TARGET key `Ksub` is degraded-occupied by an unrelated, currently-unresolvable entry `X`. With `Ksub`
skipped, `sub` gets no safety-tmp, nothing blocks `teamA`'s write, and PHASE 1a's write for `teamA`
**physically overwrites `sub`'s only copy** with no fault needed at all — the card's own original finding
(b) under a different name. After clearing the unrelated `X` and rebooting, `sub` is no longer quarantined.

**MAJOR/CRITICAL (repro F) — the end-of-boot safety-tmp recovery write-back was itself ungated.** A
leftover safety-tmp from a PRIOR boot gets recovered and re-persisted at the very end of this function
(Lead ruling 2) — but that write never consulted `allBootWriteTargets`/`blockedWriteTargets`, and derived
its own write target from `canonicalRepoLockKey(unionEntry.repoPath)` rather than the key actually being
recovered. When `sub`'s own securing fails (an injected fault) and a `teamA` safety-tmp from an earlier
boot shares `sub`'s own collision filename, this ungated recovery write physically overwrites `sub`'s only
remaining copy — the same physical-overwrite shape as CRITICAL E, reached through the recovery path round
2 itself introduced rather than through Phase 0's main at-risk loop.

Two minors, both artifacts of extending protection asymmetrically: an unparseable safety-tmp got silent
handling (no fail-closed placeholder, unlike its `deferredCorruptJsons`/`deferredCorruptTmps` siblings),
and the deferred-corrupt-tmp "no real sibling data" placeholder write wasn't tracked in
`writeTargetsThisPass`, so phase 3's delete pass could mistake it for a superseded migrate source and
delete it moments after it was durably written.

**Lead ruling for round 3 — ONE source of truth for "every write this boot performs," no exceptions for
degraded keys.** The governing principle extends unchanged: every boot write site must (a) have its target
in `allBootWriteTargets` before Phase 0, (b) check `blockedWriteTargets`, and (c) apply the same
resolvability/degraded rules as every other site. A degraded-occupied key's own migrate SOURCES are
exactly as at-risk as any other — secure them with a safety-tmp named for the SOURCE OWNER's own key
(the migrate target key, never the union's identity, which can be the degraded occupant's own unresolvable
`repoPath`), or block every write targeting them.

## Round 1's and round 2's shared fix, carried forward into round 3

**Lead ruling 1 — ONE phase, before ANY boot write, from a single source of truth.** A dedicated phase,
positioned immediately after PASS 1 AND PASS 1b have BOTH finished reading (so `migratedSourcesByKey`,
`tmpsToUnlinkByKey`, `degradedOccupiedKeys`, `deferredCorruptTmps`, and `orphanFilenames` are all fully
known), computes `allBootWriteTargets` — the UNION of every write target this ENTIRE boot could reach:
- Every non-degraded-occupied key's own target in `migratedSourcesByKey`.
- Every non-degraded-occupied, resolvable key's own target in `tmpsToUnlinkByKey`.
- Every `deferredCorruptTmps` entry's `matchedRepo`'s own target (its resolution hasn't run yet at this
  point — the ARRAY alone is enough; whether it'll actually take the write branch is never pre-computed,
  over-inclusion here is harmless, under-inclusion is the exact hazard CRITICAL 2 names).
- Every `registeredRepoPaths` entry's own target, whenever `orphanFilenames.length > 0` (PASS 2 always
  touches every registered repo in that case, regardless of which of its two branches each one takes).

(`deferredCorruptJsons`' own resolution needs no separate scan: its resolvable branch only ever DEFERS
into `migratedSourcesByKey` — same as round 1 — and that resolution already ran, with no immediate write,
before this phase; see "Why `deferredCorruptJsons` needed no change" below.)

For every key in `migratedSourcesByKey` whose own stale source is ALSO in `allBootWriteTargets` (excluding
its own target), `writeSafetyTmpResidue` runs RIGHT HERE — before the deferred-corrupt-tmp resolution, the
migrate/tmp-promotion write passes, or PASS 2 have run a single write. Every safety-tmp is individually
fsync'd (`writeSafetyTmpResidue`'s own discipline, unchanged from round 1); once every one has been
attempted, `fsyncQuarantineDir()` fsyncs the directory itself too (best-effort; not every platform supports
a directory-handle fsync, and the per-file fsync is what actually matters for each file's own durability).
Only once ALL of that has settled does control reach the deferred-corrupt-tmp resolution loop, the two
write-all passes, or PASS 2.

**The safety-write-itself-failing case — `blockedWriteTargets` (round 2's own addition, beyond the
original plan).** If `writeSafetyTmpResidue` itself fails for an at-risk key, round 1 skipped only THAT
key's own write — but did nothing to stop the COLLIDING sibling's write from destroying the (now
unprotected) source anyway, which is exactly repro B's/C's shape once the fault lands on the safety-tmp
open itself rather than the real write's. Round 2 instead adds every one of that key's colliding sources
to `blockedWriteTargets` — a set every later write site (the deferred-corrupt-tmp placeholder, phase 1a's
OTHER keys, phase 2, both of PASS 2's branches) checks before writing anywhere, refusing (staying
in-memory-only, fail-closed for this process) rather than writing to a blocked target. This closes the
residual gap where "couldn't protect A" would otherwise still let B proceed to destroy A's only copy.

**Lead ruling 2 — a safety-tmp is NAME-DISTINGUISHABLE, and recovery ALWAYS unions it (never blind-
deletes).** `writeSafetyTmpResidue` now names its residue `<hash>.json.tmp-safety-<pid>-<hex>` — disjoint
BY REGEX from the ordinary tmp pattern (`\.json\.tmp-\d+(-[0-9a-f]+)?$`, which requires digits immediately
after `.tmp-`; `SAFETY_TMP_RE` requires the literal `safety-` token there instead). The initial directory
scan now collects `safetyTmpFiles` SEPARATELY from `tmpFiles`, so PASS 1b's own "tmp beside a clean final"
shortcut — unchanged, still a blind delete — NEVER SEES a safety-tmp at all, closing MAJOR 3 structurally
(not by inference about what state a file happens to be in, but because the two categories can never be
confused by construction). A safety-tmp found at boot is instead: (1) read EARLY (right after PASS 1b's
own main loop, before the deferred-corrupt-tmp resolution or Phase 0 itself), parsed, and ARMED into
`byRepoKey` at its own key (unresolvable → diverted to `pendingUnresolvedQuarantines` directly, same idiom
as everywhere else in this function) — so its data participates in whatever union the REST of this boot's
processing builds for that key; (2) at the very end of the function, after every other pass has had its
chance to contribute, `writeMergeQuarantineLatch`'d UNCONDITIONALLY for that key's current union — this is
genuinely idempotent when nothing else changed the key's data, and resurrects nothing wrong when something
did (a union can only ever add, never remove, data) — and deleted only once that write durably succeeds.

**Why `deferredCorruptJsons` needed no change.** Its own resolvable branch (Site A) never writes
immediately — it only pushes into `migratedSourcesByKey`, exactly like round 1 (and `4480b077` before it).
Phase 0 reads `migratedSourcesByKey` AFTER this resolution has already run, so Site A's own eventual write
is already correctly covered by the ordinary migrate-pass machinery above, with no separate scan needed.

## Round 3's fix — NOT MERGEABLE (Code Review `2b079f86`)

**Finding E closed — a degraded-occupied key's migrate sources are secured too, named for the key, never
the union's identity.** Phase 0's at-risk loop no longer `continue`s past a `degradedOccupiedKeys` member.
For a NON-degraded key the at-risk content stays `byRepoKey.get(key)` (its own `.repoPath` always
canonical-keys back to `key` by construction); for a DEGRADED key the content is instead the union of just
the migrate SOURCES themselves (`originalEntryBySource`, never the shared `byRepoKey.get(key)` union,
whose `.repoPath` can be the degraded occupant's own unresolvable identity, per `unionQuarantineEntries`'s
"older wins" tie-break). Both `writeSafetyTmpResidue` and `writeMergeQuarantineLatch` now take the target
KEY explicitly (`writeSafetyTmpResidue(key, entry)`; `writeMergeQuarantineLatch(entry, sweep, targetKey?)`)
instead of deriving the write path from `entry.repoPath` — the one change needed everywhere a degraded
identity could otherwise silently name the wrong file.

A degraded key's own safety-tmp survives only on disk until a LATER boot's recovery mechanism reads it.
⚠️ **ROUND 4 CORRECTION:** this round's own parenthetical claim here — "the same key's own data is never
written to its real final while the occupant stays degraded" — was FALSE. Round 3 added `degradedOccupiedKeys`
protection to Phase 0/1a/1b and to the recovery READ loop's own pending-divert, but NEVER to the recovery
WRITE-BACK (the end-of-boot loop two paragraphs below) — that site had no `degradedOccupiedKeys` check of
its own at all. See round 4's finding G2 below for the exact repro and the fix (the chokepoint closes this
structurally, not with a parallel check at this one site). So an ORDINARY, legitimate clear of the
UNRELATED degraded occupant must not sweep the safety-tmp away as "unowned" in the interim, either. The safety-tmp recovery READ loop now gives a degraded-occupied recovery its OWN independent
`pendingUnresolvedQuarantines` entry, self-referencing its own filename in `orphanLatchFiles` — mirroring
phase 1b's existing "give each migrating source its own pending reference" fold, but for the ACROSS-BOOT
recovery path phase 1b itself never reaches. Without this, `clearMergeQuarantineByKey` removes the shared
union from `activeQuarantines` BEFORE `deleteMergeQuarantineLatchByKey`'s own `sweepTmpResidueForHashIfUnreferenced`
sweep runs, so only a SURVIVING, self-referencing entry (never the about-to-be-removed shared union) keeps
the file from being read as unreferenced and deleted.

**Finding F closed — the end-of-boot safety-tmp recovery write-back is a boot write site like any other.**
Its own eventual write target is now registered in `allBootWriteTargets` (consulted while Phase 0 still
runs, since the recovery READ loop that populates `safetyTmpRecoveryByFile` already runs before Phase 0).
The write-back itself now checks `blockedWriteTargets` and `isRepoPathCurrentlyResolvable(unionEntry.repoPath)`
before writing (refusing and leaving the residue in place if either fails, exactly like every other gated
site), and targets `key` explicitly via `writeMergeQuarantineLatch`'s new `targetKey` parameter rather than
re-deriving the path from the recovered union's own (possibly degraded) identity.

**Minor 3 closed — an unparseable safety-tmp gets a fail-closed placeholder.** Mirrors
`deferredCorruptJsons`/`deferredCorruptTmps`: the catch branch now extracts the hash from the safety-tmp's
own filename, looks it up in `hashToRepo`, and pushes a `PLACEHOLDER_BRANCH_CORRUPT` pending entry for a
match — never silence alone. (A genuinely corrupt safety-tmp is never expected in practice, since Loom
writes these itself.)

**Minor 4 closed — the deferred-corrupt-tmp placeholder's own write is now tracked in
`writeTargetsThisPass`.** `writeTargetsThisPass` is declared earlier now (before the deferred-corrupt-tmp
resolution loop, not after it) so that loop's own successful "no real sibling data" placeholder write can
register its target there too — phase 3's delete pass already refuses to delete anything in
`writeTargetsThisPass`, so this placeholder now survives being mistaken for a different key's superseded
migrate source, the same physical-overwrite shape as findings E and F reached through a THIRD write site.

## Round 4's fix (current) — Code Review `2b079f86` found round 3 WORSE than main in two shapes

Every pre-round-4 degraded-occupant test gave the occupant X an OLDER `enteredAt` than the sibling it
collides with, so `unionQuarantineEntries`' tie-break always kept X's own (unresolvable) identity — this
accidentally masked both findings below behind an UNRELATED, already-existing resolvability check. Round
4's own tests additionally run every reparametrizable degraded scenario under BOTH age orders.

**Finding G1 — a same-process graduation of a degraded migrate source could delete a live sibling's
file.** Phase 1b's degraded-occupied fold gave each migrating source its own `pendingUnresolvedQuarantines`
entry whose `sourceFile` was the RAW, collided filename — a file a DIFFERENT, non-degraded sibling's own
Phase 1a write may have ALREADY claimed earlier in the SAME pass. That dangerous reference was never
reached by any of the existing tests, which always REBOOT before re-querying — and a reboot's own
safety-tmp-recovery read loop (finding E) mints a SAFE pending reference (pointing at the safety-tmp's own
uniquely-suffixed filename) that supersedes it first. The real hazard needs a SAME-PROCESS clear of the
unrelated degraded occupant (vacating `activeQuarantines`' shared slot) followed by a SAME-PROCESS query —
at that point `consumeMatchedPendingsIntoArmedEntry` graduates the dangerous reference and
`deleteSourceLatchIfSuperseded` unlinks the sibling's own live, correct file with no check that anything
else now owns it.

Fixed with BOTH layers, each independently sufficient (verified: the repro is GREEN with only one layer
active at a time):
- **(A) preventive:** Phase 1b now points a migrating source's pending reference at the SAFETY-TMP's own
  basename (when Phase 0 already secured one for this key, because at least one source collided) instead
  of the raw source filename — a safety-tmp's randomly-suffixed name can never collide with anything.
  Falls back to the original per-source behavior when no safety-tmp exists (nothing collided this pass).
- **(B) structural backstop:** `deleteSourceLatchIfSuperseded` now ALSO refuses (returns `true`, nothing
  to fold — it is no longer ours to track) when a DIFFERENT, currently-ACTIVE entry physically owns the
  filename, via `physicalOwnerRepoPaths` — the SAME ownership check `sweepOrphanLatchFileIfUnreferenced`
  already relies on (decision 9cabd143); this function never had its own copy until now. The entry being
  written is excluded from that ownership check (a legitimately dual-armed entry's own alternate-key file
  must not be mistaken for a different repo's live ownership). This also automatically hardens every OTHER
  `deleteSourceLatchIfSuperseded` call site (Phase 3's own delete pass, `consumeMatchedPendingsIntoArmedEntry`'s
  own delete loop) against the identical shape, for free.

**Finding G2 — the end-of-boot safety-tmp recovery write-back never had a `degradedOccupiedKeys` check.**
Round 3's line-189 claim (now corrected above) was false specifically because of this site: BOOT 1 secures
a degraded migrate source's safety-tmp (same collision shape as finding E). BOOT 2, with the age order
flipped (the migrating source now OLDER than the degraded occupant), `unionQuarantineEntries`' tie-break
resolves the recovery read loop's own union to the migrating source's RESOLVABLE identity — which lets the
write-back's own PRE-EXISTING resolvability/`blockedWriteTargets` checks pass, reaching code that had NO
`degradedOccupiedKeys` check at all, and physically overwrites the degraded occupant's own real backing
file with the wrong identity. Fixed structurally: this site is now routed through `bootWriteLatch` (below),
which supplies the missing check — not a parallel, site-specific check that could rot independently.

**The structural fix — ONE boot-write chokepoint, `bootWriteLatch(targetKey, entry)`.** A closure declared
inside `reenterMergeQuarantinesAtBoot`, capturing `allBootWriteTargets`/`blockedWriteTargets`/
`degradedOccupiedKeys`/`writeTargetsThisPass` directly. Refuses (logs, writes nothing, returns `false`)
when: (a) `targetKey`'s own basename is not in `allBootWriteTargets` (an unanticipated write site — a
structural backstop for anything not yet imagined, not merely today's known hazards); (b) it is in
`blockedWriteTargets`; (c) `targetKey` is in `degradedOccupiedKeys`; (d) for a NON-placeholder entry only,
`!isRepoPathCurrentlyResolvable(entry.repoPath)` — a placeholder is EXEMPT from (d) because it carries no
real identity to protect, and PASS 2's own "fresh placeholder" branch legitimately writes one for a
CURRENTLY-unresolvable registered repo (main's own existing behavior; refusing it would be a silent
regression, not a fix). `targetKey` steers the WRITE PATH only (via `writeMergeQuarantineLatch`'s own
`targetKey` parameter) — **it never mutates `entry.resolvedKey`**; an earlier version of this chokepoint
DID stamp `resolvedKey` unconditionally and regressed `merge-quarantine-clear-by-path.mjs`'s own (P)/(P2)
scenarios — stamping a resolvedKey onto an unresolvable PASS-2 placeholder made a LATER, still-unresolvable
boot arm it ACTIVELY under that now-stale key instead of correctly leaving it PENDING for lazy re-resolve.

Every boot write site inside `reenterMergeQuarantinesAtBoot` now routes through `bootWriteLatch`: Phase 1a's
migrate write, Phase 2's tmp-promotion write, the deferred-corrupt-tmp "no real sibling data" placeholder
write, BOTH of PASS 2's own branches (closing card **d163aef5**'s Repro C below), the end-of-boot
safety-tmp recovery write-back (closing finding G2), and Phase 3's own re-persist-after-failed-delete-fold
write (defense-in-depth; its own target was already provably safe). A dedicated guard,
`test/merge-quarantine-boot-write-chokepoint-guard.mjs`, parses the (comment-stripped) source via the
TypeScript compiler API and asserts — by AST identifier reference, not a `name(` substring match, so an
EVASIVE alias (`const w = writeMergeQuarantineLatch; w(entry)`) is caught too — that no reference to
`writeMergeQuarantineLatch` exists anywhere in that function's body outside `bootWriteLatch`'s own
declaration. (A hand-rolled `ts.createScanner` brace-counting approach was tried first and abandoned:
decision `2154b6ad`'s own "Do not" already warns it desyncs on template-literal interpolation — confirmed
firsthand against this very file's own `${...}` console.error/warn calls. The AST's own `FunctionDeclaration.body`
node gives exact boundaries directly.) `writeOutcomesByKey`/`writeTargetsThisPass` bookkeeping that used to
live inline at each site is unchanged in shape — only the write ATTEMPT itself (and its own
refusal-condition checks) are now centralized.

**Card `d163aef5` — folded in, except its own "unverified sibling" angle.** d163aef5's Repro C (PASS 2's
orphan re-persist bypassing `degradedOccupiedKeys`, writing based on `existing.repoPath` recomputed fresh
rather than the key actually being iterated) is closed by routing both PASS 2 branches through
`bootWriteLatch`, gated on `targetKey` explicitly rather than any repoPath recompute — verified via
`round4-d163aef5-pass2-degraded-bypass`, which shows the OLD code attempting (and the NEW code refusing) a
write for a degraded-occupied key's own registered sibling, landing at a STRAY, unrelated file (not
necessarily the occupant's own real backing file — a broader failure mode than the card's own narrower
"exposes D's identity at E's hash" framing, same root cause). d163aef5's OWN SEPARATE, explicitly-labeled
"unverified sibling" claim — that `armQuarantineKey`'s `armedKeys` propagation from a dual-armed entry can
carry a degraded constituent into a key NOT in `degradedOccupiedKeys`, via PASS 2's
`for (const k of existing.armedKeys...) byRepoKey.set(k, updated)` IN-MEMORY assignment — is a DIFFERENT
class of hazard (in-memory `byRepoKey` clobbering, never a disk write) that `bootWriteLatch` does NOT
address (it only gates the write attempt, never an in-memory `.set()`). Round 4 did not reproduce or fix
this; it stays OPEN, tracked under card d163aef5 itself, not closed by this card.

**Minor 1 closed — the safety-tmp recovery READ loop now runs BEFORE `flushDegradedDiverts()`, not after.**
PASS 1/1b's own degraded diverts are fully populated by the time the recovery loop starts (both read loops
have already finished), so reordering is a pure, safe move: `flushDegradedDiverts()` now snapshots
`byRepoKey`'s POST-recovery-union value, instead of a stale pre-union object that then double-reports
alongside the union once `activeQuarantines` is populated at the end of boot. (A same-shaped double-report,
reached via Phase 1b's own fold rather than the recovery loop, is the ORIGINAL Minor 2 — already closed,
unchanged, by the Minor-2 fix narrated above.)

**Minor 2 closed — an unparseable safety-tmp now gets the SAME 3-tier fallback cascade its siblings have.**
The catch branch used to consult `hashToRepo` only; now mirrors `deferredCorruptJsons`/`deferredCorruptTmps`
exactly: `hashToRepo`, then `unresolvedClaimantsByHash` (multiple unresolvable claimants sharing one
degraded hash, each gets its OWN placeholder — never just one "winner"), then `ancestorHashToRepo`, and
finally joins the ordinary `orphanFilenames` sweep when nothing matches at all (previously: silent drop,
no fail-closed coverage and no path to a human clear ever).

### Verification (round 4)

`test/merge-quarantine-migrate-source-owner-durable.mjs` gained: `round4-G1-same-boot-graduation-deletes-sibling-target`,
`round4-G2-recovery-writeback-clobbers-degraded-occupant`, `round4-minor1-safety-recovery-double-report`,
`round4-minor2-unparseable-safety-tmp-full-fallback`, `round4-d163aef5-pass2-degraded-bypass`, and the
age-order reparametrizations `round4-finding1b-sub-older`/`round4-minor2-sub-older`/`round4-E-sub-older`
(the three pre-round-4 degraded scenarios that could meaningfully run under the other age order). All
RED at round 3's own tip, GREEN after. G1's two independent fix layers were each verified sufficient ALONE
(the other temporarily disabled) before verifying them together. A new, separate guard,
`test/merge-quarantine-boot-write-chokepoint-guard.mjs`, is a source/AST scan (not a `--scenario=` entry in
the durability suite) with its own positive control (an injected aliased reference) and its own confirmed
RED/GREEN against a real, reverted call site. All 23 pre-existing `merge-quarantine*.mjs` files re-run
clean — no regressions (one was CAUGHT and fixed during this round: an earlier draft of `bootWriteLatch`
unconditionally stamped `resolvedKey`, regressing `merge-quarantine-clear-by-path.mjs`'s (P)/(P2); see the
chokepoint's own doc comment above). `pnpm --filter @loom/daemon negative-control --file
packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-migrate-source-owner-durable.mjs`
run against BOTH `--ref 30e7e9b9` (the true pre-round-1 parent) and `--ref 260c892a` (round 3's own,
NOT-MERGEABLE tip): both report RED on the revert, GREEN restored, tree byte-identical after — measured
directly off the tool's own summary, never hand-reasoned. `pnpm --filter @loom/daemon guards` — all 27
guards pass (the new test file staged via `git add` first, per `STATIC_GUARD_REPO_PATHS`'s own diff-scoped
core-scan requirement for an as-yet-uncommitted file). Read-only `ls ~/.loom/merge-quarantines | wc -l`
unchanged at 15, never written to the real `~/.loom`.

## Round 5's fix (current) — Code Review `e0777155` found ONE blocking gap in round 4's own fix

**BLOCKING — Phase 1b's own G1 layer A left its pushed pending reference UNPROTECTED against a same-boot
clear that never queries the protected key.** The round-4 fix pointed a migrating source's pending
reference AT the safety-tmp's own basename (`protectiveSourceFile`), but never put that basename into
the PUSHED entry's own `orphanLatchFiles` — and `sweepTmpResidueForHashIfUnreferenced` (the function a
same-boot `clearMergeQuarantineByKey`/`deleteMergeQuarantineLatchByKey` of the unrelated degraded occupant
X actually calls) honours ONLY `orphanLatchFiles`, never a bare pending reference's `sourceFile` field
alone. Repro (X older than sub, no reboot and no in-process query of sub between the clear and the
reboot that follows — the exact sequence round 4's own `round4-G1-same-boot-graduation-deletes-sibling-
target` test never exercised, since IT queries sub immediately after clearing X, which graduates sub
in-process and durably rewrites its real final before anything else can matter): `clearMergeQuarantine(x)`
→ `clearMergeQuarantineByKey(Ksub, x)` → `deleteMergeQuarantineLatchByKey(Ksub)` →
`sweepTmpResidueForHashIfUnreferenced(hash(Ksub))` finds the safety-tmp, sees no owner (the pending
entry's own `orphanLatchFiles` doesn't list it), and deletes it — sub's ONLY durable copy, since teamA's
own Phase 1a write already overwrote sub's raw stale source at `sha(Kp).json` this same boot. A REBOOT
after this point finds nothing to recover sub from: sub is OPEN. Measured in the X-older order. The other
age order (sub older) was also attempted, and found NON-DISCRIMINATING for an unrelated, pre-existing
reason — see the new test's own `round5-G1a-same-boot-clear-then-reboot-sub-older` scenario and its
comment: under that order, `sub` (a resolvable registered repo) ALSO gets armed directly into
`byRepoKey[Ksub]` via the ordinary stale-key migration arm, producing a REAL union of X's and sub's data
whose `repoPath` becomes `sub` (tie-break: older wins) — at that point nothing anywhere still carries
`repoPath: x`, so `clearMergeQuarantine(x)` is a documented no-op (`wasQuarantined:false`) under this
order regardless of any fix, and there is no operation that clears "the unrelated X" without also
touching sub's own entry. The X-older order is the one where the union's `repoPath` stays `x` and a clear
BY `x`'s own identity is a genuinely distinct, reachable operation — the one this round's fix protects.

Fixed by self-referencing `protectiveSourceFile` into the pushed entry's own `orphanLatchFiles`, mirroring
the safety-tmp recovery read loop's own pre-existing self-reference (the `degradedOccupiedKeys` branch
right after `safetyTmpRecoveryByFile.set(f, currentKey)`) — the exact same protection pattern, now applied
at the SECOND site (Phase 1b's in-pass fold) that pushes a pending reference pointing at a safety-tmp.

**Minor 1 (liveness) — Phase 0's `allBootWriteTargets` registration recomputed a write target from
`e.repoPath` instead of from the key being iterated.** `bootWriteLatch` checks a write's target against
`allBootWriteTargets` via `quarantinePathForKey(targetKey)`, but Phase 0 populated that set via
`quarantinePathFor(e.repoPath)` — a FRESH recompute of `canonicalRepoLockKey(e.repoPath)` that can
disagree with `key` whenever `e.repoPath` carries a stale `resolvedKey` (an older, resolvable teamA whose
`resolvedKey` is stale, plus a newer stale-named sub migrating to that same key): the legitimate write is
then refused as UNANTICIPATED on every boot — fail-closed, but a liveness bug, never a data-loss one.
Fixed by registering `quarantinePathForKey(key)` at both keyed sites (the migrate-pass and tmp-promotion
loops), never a `repoPath` recompute — the same "never derive a write target from `entry.repoPath`" rule
this card's own "Do not" list already states for every OTHER site in this function.

Regression test added (`round5-minor1-stale-resolvedkey-registration-liveness`, the Lead's own requested
repro): an OLDER, independently-resolvable teamA whose own CORRECTLY-PLACED latch carries a STALE
`resolvedKey` field pointing at sub's real key (dual-arming teamA at both its own key and sub's, via
PASS 1's ordinary dual-arm fall-through), plus a NEWER sub whose own latch is a stale-named file that
must migrate to that same key. Asserts: the write lands on boot 1, sub is quarantined at its real key, no
`UNANTICIPATED` warning fires, and a second boot stays stable. Measured RED (3 named failures, including
the literal `UNANTICIPATED` log line) with ONLY the migrate-pass registration line reverted to
`quarantinePathFor(e.repoPath)`, GREEN restored — confirmed directly off the scenario's own PASS/FAIL
output, never hand-reasoned.

**Minor 2 (latent) — `deleteSourceLatchIfSuperseded` and `consumeMatchedPendingsIntoArmedEntry`'s own
failure-branch fold derived the written/target file from `armed.repoPath`/`writtenEntry.repoPath` while
the write itself used `key`.** Both now take `key` explicitly (`deleteSourceLatchIfSuperseded(sourceFile,
writtenEntry, key)`) and derive the comparison file via `quarantinePathForKey(key)`, never a `repoPath`
recompute — same rule, same reasoning, applied at the two remaining sites this function's own prior rounds
had not yet reached. (A third call site, Phase 3's own success-branch delete loop, already had `key` in
scope and was updated too, for free, to stay consistent — not a separately-reviewed finding.)

**Minor 3 (test honesty) — `round4-finding1b-sub-older` does not discriminate.** Measured directly (the
test run with `merge-quarantine.ts` temporarily reverted to the true pre-round-1 parent `30e7e9b9`, per
this record's own "Do not trust a hand-reasoned RED/GREEN count" rule): this scenario is GREEN even on
code with NONE of this card's fixes, while the ORIGINAL `finding1b-degraded-skip-clear-destroys-sibling`
(X older) is RED on that same reverted code. Under the sub-older age order, finding1b's own defect never
fires, for a reason not yet root-caused — the test's own comment is relabeled as a non-discriminating
parity check (kept to confirm this age order's own behavior stays unregressed), rather than left reading
as if it exercises the fix.

**Minor 4 (guard scope honesty) — `merge-quarantine-boot-write-chokepoint-guard.mjs`'s own header
overclaimed via omission and mis-cited CLAUDE.md's shape taxonomy.** The guard proves only that no
`writeMergeQuarantineLatch` reference exists outside `bootWriteLatch` inside
`reenterMergeQuarantinesAtBoot`'s own body — it says nothing about `quarantineAllRegisteredFailClosed`
(reachable from inside that same body on a readdir failure, before anything is read, with its own
separate write primitive), `writeSafetyTmpResidue` (a different primitive, deliberately outside this
chokepoint), or a direct `fs.unlinkSync`/`fs.writeFileSync` call anywhere in the file. The guard's header
now states this scope explicitly rather than letting a reader infer "no boot write bypasses" from a green
run. The header's own citation of CLAUDE.md's `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` comment-immunity
taxonomy was also wrong — it said "shape 1/2"; the real citation is **shape (3)** ("an EXPLICIT
comment-stripped whole-file scan"), per that list's own doc comment in `worktrees.ts`.

### Verification (round 5)

`finding1b-degraded-skip-clear-destroys-sibling` re-run RED against the true pre-round-1 parent
`30e7e9b9` (confirming the baseline negative control is still sound), `round4-finding1b-sub-older` re-run
GREEN against that SAME reverted code (confirming it does not discriminate — Minor 3 above), both measured
directly off `node test/merge-quarantine-migrate-source-owner-durable.mjs --scenario=<name>`'s own PASS/
FAIL output, never hand-reasoned.

New scenario `round5-G1a-same-boot-clear-then-reboot-destroys-safety-tmp` (X older): RED with ONLY the
blocking fix (the `orphanLatchFiles` self-reference) reverted — round 4's own Minor 1/2 fixes left in
place — and GREEN restored, measured directly off the scenario's own PASS/FAIL output. New scenario
`round5-G1a-same-boot-clear-then-reboot-sub-older`: measured GREEN under BOTH states (fix present, fix
reverted) — confirmed, before committing, to be a genuine non-discriminating parity check and not a
silently-vacuous assertion (traced via `listActiveMergeQuarantines()`/`clearMergeQuarantine()`'s own
return value — see the scenario's own comment and the repro paragraph above); its assertions and comment
were rewritten to say so plainly rather than claim "fix holds" for an operation that is a no-op either
way. New scenario `round5-minor1-stale-resolvedkey-registration-liveness` (added after the Lead's own
review flagged its absence as a missing DoD item): RED (3 named failures, including the literal
`UNANTICIPATED` log line) with only the migrate-pass registration line reverted to `quarantinePathFor(e.
repoPath)`, GREEN restored — see Minor 1's own section above. `pnpm --filter @loom/daemon build` clean
after every revert/restore cycle, tree confirmed byte-identical after restoring the round-5 fix. All 23
`merge-quarantine*.mjs` files (including this one) re-run SERIALLY (never a parallel batch, to avoid
competing with a concurrent gate investigation on the host) — all PASS, `exit=0` for every file.

## Do not

- Do not name a safety-tmp residue the same way an ordinary torn-write tmp is named — the two MUST be
  distinguishable by filename alone (Lead ruling 2); inferring "this must be a safety-tmp" from
  circumstantial state (an at-the-time-plausible key/final relationship) is exactly MAJOR 3's own mistake.
- Do not union an ORDINARY stale tmp into an existing final in PASS 1b's "already covered" shortcut — it
  stays a blind delete, deliberately, and three pre-existing tests (`merge-quarantine-boot-hardening.mjs`
  TW-stale, `merge-quarantine-pass1b-clean-parse-gate.mjs` STALE,
  `merge-quarantine-pass1-degraded-union-guard.mjs` `pass1b-resolvable-stale-tmp-still-deleted`) assert
  exactly that for a genuinely-stale, now-superseded earlier raise attempt.
- Do not write a migrating key's safety-tmp inline, immediately before that SAME key's own write — write
  EVERY at-risk key's safety-tmp in ONE phase, fully, before ANY write anywhere in this function runs.
  Per-key inline ordering is exactly what CRITICAL 1 exploited (a sibling's write completing first).
- Do not assume gating the two write-ALL passes (migrate, tmp-promotion) is sufficient — the
  deferred-corrupt-tmp "no real sibling data" placeholder write and BOTH of PASS 2's own write branches
  are separate, ungated call sites in this same function (CRITICAL 2) that must consult the SAME
  `allBootWriteTargets`/`blockedWriteTargets` machinery, not a parallel, independently-derived one.
- Do not skip a safety-tmp write for a key just because its OWN write hasn't failed yet, nor skip
  `blockedWriteTargets` propagation when the safety-tmp write itself fails — the colliding sibling's write
  must also be blocked, or "couldn't protect A" still lets B destroy A's only copy moments later.
- Do not add a safety-tmp write to the tmp-promotion pass — its own surviving tmp(s) already ARE its
  durable backup (never deleted until that promote succeeds); a second copy is pure redundant I/O, and
  costs every ordinary (non-colliding) torn-write recovery an extra `fs.openSync` call several existing
  fault-injection tests (notably `merge-quarantine-pass1b-clean-parse-gate.mjs`'s own R1 scenario) count
  on precisely matching today's call count.
- Do not use the shared union object (`folded`/`occupant`) as the `.entry` for a colliding sibling's own
  NEW `pendingUnresolvedQuarantines` entry (finding 1b's own fix, unchanged from round 1) — use that
  source's own standalone entry (`originalEntryBySource`). The shared union's `repoPath` is whichever side
  won the union's own tie-break, and a clear of THAT side will match and sweep the sibling's own
  protective entry away too.
- Do not forget to re-point an EARLIER `pendingUnresolvedQuarantines` divert of the degraded occupant's
  pre-fold object when the fold mutates it to a new object (Minor 2's own fix, unchanged from round 1).
- Do not trust a hand-reasoned RED/GREEN count — read it off `pnpm --filter @loom/daemon negative-control`'s
  own per-scenario PASS/FAIL output, reverted to the TRUE parent of round 1/2/3's commits (not merely
  `HEAD`, which by the time a later round lands is the PRIOR round's own, already-superseded fix).
- Do not skip a `degradedOccupiedKeys` member in Phase 0's at-risk computation just because nothing
  writes to ITS OWN target this boot (finding E) — its migrate SOURCES are exactly as at-risk as any
  other key's, from a DIFFERENT, non-degraded sibling's own write.
- Do not derive a write's target path from `entry.repoPath`/`unionEntry.repoPath` at a site that can see a
  degraded identity — a union's own `.repoPath` can be the degraded occupant's unresolvable identity
  (`unionQuarantineEntries`'s tie-break), which does not canonical-key back to the key actually being
  written. Pass the key explicitly (`writeSafetyTmpResidue(key, entry)`,
  `writeMergeQuarantineLatch(entry, sweep, targetKey)`) wherever this can happen.
- Do not assume gating the two write-ALL passes PLUS the deferred-corrupt-tmp placeholder PLUS PASS 2 is
  the complete write-site list — the end-of-boot safety-tmp recovery write-back (finding F) is a FIFTH,
  separate call site that needs the identical `allBootWriteTargets`/`blockedWriteTargets`/resolvability
  gating, not a parallel, independently-derived check.
- Do not let a degraded-occupied recovery's own safety-tmp go unprotected against an ordinary clear of the
  UNRELATED degraded occupant — give it its OWN `pendingUnresolvedQuarantines` entry that self-references
  its own filename in `orphanLatchFiles`, or `sweepTmpResidueForHashIfUnreferenced` (which runs AFTER
  `clearMergeQuarantineByKey` has already removed the shared union from `activeQuarantines`) finds nothing
  referencing it and deletes it.
- Do not test ONLY the age order where the degraded occupant is OLDER — every pre-round-4 degraded test
  did exactly this, and it is what hid findings G1 and G2 from review for three rounds (G1's own trigger
  doesn't depend on age order at all; G2's does, via an unrelated resolvability check that only happens to
  mask it when the occupant wins the union tie-break). Run every reparametrizable degraded scenario under
  BOTH orders.
- Do not point a degraded-occupied migrate source's pending reference at its OWN raw, collided filename
  (finding G1) — that filename can be a DIFFERENT, non-degraded sibling's own live write target from
  earlier in the SAME pass, and the existing per-sibling pending-reference protection (finding 1b) only
  guards the SWEEP/CLEAR path, never `deleteSourceLatchIfSuperseded`'s own graduation-time delete. Point
  it at the safety-tmp's own uniquely-named residue instead (when Phase 0 secured one for this key).
- Do not assume `deleteSourceLatchIfSuperseded`'s existing two checks (self-target, a still-pending
  sibling) are a complete ownership test — also check `physicalOwnerRepoPaths` (decision 9cabd143's own
  mechanism) before unlinking anything, excluding the entry's own identity from that check.
- Do not add a NEW boot-write site's own ad hoc `blockedWriteTargets`/resolvability/degraded check instead
  of routing it through `bootWriteLatch` — a parallel, independently-derived check is exactly how finding
  G2 (the recovery write-back) and card d163aef5's Repro C (PASS 2) went unnoticed across three rounds:
  each site that implemented its OWN copy of "the" gating logic quietly diverged from its siblings.
- Do not have `bootWriteLatch` (or any future write chokepoint in this function) mutate `entry.resolvedKey`
  as a side effect of being told the write's own target key — `targetKey` is for PATH DERIVATION only.
  Stamping it onto an unresolvable PASS-2 placeholder regressed `merge-quarantine-clear-by-path.mjs`'s own
  (P)/(P2) scenarios: a later, still-unresolvable boot then arms the placeholder ACTIVELY under that
  now-stale key instead of correctly leaving it PENDING. If a caller genuinely needs resolvedKey set, it
  must do so explicitly before calling the chokepoint (as PASS 1's migrate branch and Phase 2's
  `armedForWrite` already do).
- Do not drive a hand-rolled `ts.createScanner` brace-counting loop to find a function body's own
  boundaries in a source-scanning test — decision `2154b6ad`'s own "Do not" already names this exact
  failure (desyncs on template-literal interpolation); use the real AST's `FunctionDeclaration.body` node.
- Do not scan for a bare-call `name(` substring when a source-scanning test's real concern is "does any
  OTHER code reach this function" — an aliased reference (`const w = target; w(...)`) reaches the same
  code while evading that match. Count AST identifier references instead.
- Do not push a pending reference that POINTS AT a safety-tmp's basename without also putting that exact
  basename into the pushed entry's OWN `orphanLatchFiles` (round 5) — `sweepTmpResidueForHashIfUnreferenced`
  honours only `orphanLatchFiles`; a bare `sourceFile` pointer offers no protection against a same-boot
  clear of the unrelated occupant that never queries (and therefore never graduates) the protected key.
- Do not register a key's boot-write target in `allBootWriteTargets` via a fresh `quarantinePathFor(e.
  repoPath)` recompute (round 5, Minor 1) — use `quarantinePathForKey(key)`, the SAME key `bootWriteLatch`
  itself checks against; a stale `resolvedKey` on `e.repoPath` can recompute to a different path than
  `key`'s own target, refusing a legitimate write as UNANTICIPATED on every boot.
- Do not derive `deleteSourceLatchIfSuperseded`'s (or `consumeMatchedPendingsIntoArmedEntry`'s failure-
  branch fold's) own comparison file from `writtenEntry.repoPath`/`armed.repoPath` (round 5, Minor 2) —
  pass `key` explicitly and derive it via `quarantinePathForKey(key)`, matching the write it follows.
- Do not claim a source-scanning guard's green proves "no boot write bypasses [some broad property]"
  without stating its exact scope (round 5, Minor 4) — name what it does NOT see (a different write
  primitive, a different call site reachable from the same function, a direct unlink/write) in the
  guard's own header, not just in a decision record a reader may never open.

## Verification (rounds 1-3 — round 4's own additions are in its own section above)

`test/merge-quarantine-migrate-source-owner-durable.mjs` now has TWENTY-TWO scenarios total (round 4 added
eight — see "Verification (round 4)" above); the FOURTEEN described below are rounds 1-3's own (each its
own child process, own fresh `LOOM_HOME`): the original six from round 1 (`finding1-migrate-pass-sibling-collision`,
`finding1a-tmp-promotion-pass-sibling-collision`, `finding1b-degraded-skip-clear-destroys-sibling`,
`minor2-stale-snapshot-double-report`, `safety-tmp-recovery-always-unions-into-existing-final` — rewritten
for ruling 2: now proves a union, not a blind-delete safety property — and
`safety-tmp-crash-after-success-before-delete-is-fail-closed`), round 2's own four
(`round2-A-second-noncolliding-source-defeats-blind-delete-premise`,
`round2-B-deferred-corrupt-tmp-placeholder-write-ungated`, `round2-C-pass2-orphan-placeholder-write-ungated`,
`round2-D-crash-shaped-no-fault-ordering-hazard` — D uses a disk snapshot-and-restore at the exact
dangerous instant, never fault injection), plus round 3's own four
(`round3-E-degraded-occupied-source-clobbered`, `round3-F-safety-recovery-write-ungated` — both reproduce
the Code Reviewer `b8a7b74f`'s own scratch repro (scenarios E/F) verbatim, never committed as the
reviewer's own copy — `round3-minor3-unparseable-safety-tmp-gets-placeholder`, and
`round3-minor4-deferred-corrupt-placeholder-survives-phase3-delete`).

`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-migrate-source-owner-durable.mjs --ref 30e7e9b9` (`30e7e9b9` is the
true parent of round 1's, round 2's, AND round 3's commits — reverting to it exercises the genuinely
pre-fix code, never a prior round's own already-superseded attempt): measured directly off the tool's own
per-scenario output (never hand-reasoned, per this record's own "Do not" above), ALL FOURTEEN scenarios
RED on that revert, all fourteen GREEN restored, tree confirmed byte-identical after.

`--ref cae8e750` (round 2's own tip — the NOT-MERGEABLE state this round replaces): round 1's and round
2's own ten scenarios stay GREEN (their own fixes are genuinely intact and unregressed), while exactly the
four round-3 scenarios (`round3-E`/`round3-F`/`round3-minor3`/`round3-minor4`) go RED — the precise,
narrower red this round's own fix is responsible for, GREEN restored after, tree byte-identical.

Every other `merge-quarantine*.mjs` file (21 total, run individually) re-run clean — no regressions.
Read-only `ls ~/.loom/merge-quarantines | wc -l` unchanged at 15 both before and after this round's own
work — never written to the real `~/.loom`. The Code Reviewer's own `b8a7b74f` scratch repro script
(scenarios E–H) was also re-run directly against this round's fixed code: all four PASS, including G and
H, which the reviewer had already verified SOUND in round 2 and which this round does not touch — no
regression on the repros the reviewer's own prior round already closed. `pnpm --filter @loom/daemon
guards` — all 27 guards pass.
