# ef651188 — a PENDING entry's own sourceFile is at-risk too, and a structural backstop enforces it

From Code Review `e0777155` of `97cff6db` round 4 — a SEPARATE gap in the same Phase 0 at-risk
computation that round 5 (`docs/decisions/97cff6db-migrate-source-owner-durable-before-write.md`) did not
touch. Pre-existing on main, reproduced by the reviewer in both age orders.

## The bug

`reenterMergeQuarantinesAtBoot`'s Phase 0 at-risk loop (the one that calls `writeSafetyTmpResidue` for a
`migratedSourcesByKey` collision) only ever walks `migratedSourcesByKey` — which is populated exclusively
from entries that get armed into `byRepoKey`. A PENDING entry (one sitting in
`pendingUnresolvedQuarantines` — an unresolvable, pre-upgrade latch with no `resolvedKey`, or a corrupt
latch matched only via an ancestor-walk) never puts anything in `byRepoKey` at all, so its own
`sourceFile` was invisible to that loop even though it can physically BE some OTHER key's write target.

Repro (reviewer, both age orders): `Y = R/ghost` (missing on disk) has its only latch at `sha(Kp).json`
— a pre-upgrade, unresolvable entry, pending. `teamA`'s own stale-keyed latch migrates to `Kp` this same
boot (an ordinary, correct migrate). Phase 1a's write for `teamA` physically lands at `sha(Kp).json`,
destroying `Y`'s only copy with no fault needed. After boot 1, `Y`'s token is on disk nowhere — `Y`'s
quarantine is lost. The deferred-corrupt-tmp "no real sibling data" placeholder write and PASS 2's own
"fresh placeholder" write can reach the identical file the same way, since a pending owner's presence is
invisible to EVERY one of this function's seven boot-write sites, not just the migrate pass.

Every boot write of a latch FINAL in this function already funnels through ONE chokepoint,
`bootWriteLatch(targetKey, entry)` (card `97cff6db` round 4) — the seven call sites are: the
deferred-corrupt-tmp "no real sibling data" placeholder, Phase 1a's migrate-write-ALL pass, Phase 2's
tmp-promotion write-ALL pass, Phase 3's re-persist-after-failed-delete-fold, PASS 2's two branches (add
orphan ref to an existing entry; fresh placeholder for one with none), and the end-of-boot safety-tmp
recovery write-back. A pending entry's `sourceFile` can only ever be clobbered this way when it is
`.json`-final-shaped (identical string to some key's own `quarantinePathForKey` basename) — a
`.tmp-<pid>...`/`.tmp-safety-...`-shaped `sourceFile` can never collide, since `allBootWriteTargets` is
built exclusively from `quarantinePathFor(Key)` calls, which always produce a plain `<hash>.json` name.

## The fix

**Phase 0, one generic loop — never a per-site patch.** Immediately after the existing
`migratedSourcesByKey` collidingSources loop, before `fsyncQuarantineDir()` (so both sets of safety-tmps
land under the same directory fsync), `pendingUnresolvedQuarantines` is rebuilt via `.map()`: for every
pending entry `p` whose `sourceFile` is a member of `allBootWriteTargets` (already fully built by this
point — the SAME set `bootWriteLatch` itself checks), `p` is secured and re-pointed.

**No verified key exists for a pending entry — key off the hash the at-risk filename already carries.**
`writeSafetyTmpResidue(key, entry)` (which derives its target hash from a caller-verified `key`) was split
into a new primitive, `writeSafetyTmpResidueAtHash(hash, entry)`, plus a one-line `key`-addressed wrapper
around it (`writeSafetyTmpResidue(key, entry) { return writeSafetyTmpResidueAtHash(quarantineHashForKey(key), entry); }`)
— the one existing call site is unaffected. The new pending-protection loop calls the hash-taking
primitive directly with `hash = p.sourceFile.slice(0, -".json".length)` — the hash already embedded in
the at-risk filename itself, since there is no better identity to key a pending entry's safety-tmp off
(see "Accepted residual" below).

**On success — re-point AND self-reference, mirroring round 4/5's own G1/G1a fix shape.** The pending
entry's `sourceFile` is updated to the safety-tmp's own unique basename, and that SAME basename is folded
into the entry's own `orphanLatchFiles`. Both matter: re-pointing means the at-risk physical file can be
safely overwritten by the colliding write without `Y`'s bookkeeping still pointing at now-stale content;
self-referencing means `sweepTmpResidueForHashIfUnreferenced` (which honours ONLY `orphanLatchFiles`,
never `physicalOwnerRepoPaths`) can never sweep the safety-tmp out from under a later, unrelated,
legitimate clear of whichever sibling ends up durably owning the collision target (the exact G1a shape
`97cff6db` round 5 closed for the migrate-source case, now closed here too for the pending case).
Recovery on a later boot needs zero new code: the pre-existing safety-tmp recovery read loop already
re-pushes a readable, still-unresolvable safety-tmp to `pendingUnresolvedQuarantines` with `sourceFile`
set to its own name — this safety-tmp is indistinguishable from that case once written.

**On failure — block, never fail open.** The at-risk basename joins `blockedWriteTargets`, which every
one of the seven `bootWriteLatch` call sites already checks and refuses on unconditionally. The colliding
write never runs this boot; the pending entry's original file is therefore never touched either. The only
cost is one boot's worth of durability for the colliding sibling's own migration (fail-closed, not
fail-open), and only in the already-rare case where the safety write itself fails.

## The structural backstop

`bootWriteLatch` itself (not just Phase 0) now refuses, and logs loudly, any write whose target basename
equals the `sourceFile` of ANY entry currently in `pendingUnresolvedQuarantines` — checked fresh on every
call, after the `blockedWriteTargets` check and before the `degradedOccupiedKeys` check. This is
deliberately a SECOND, independent line of defense: Phase 0's own loop above argues (by exhaustively
surveying every `pendingUnresolvedQuarantines.push`/mutation site in the function) that no at-risk
pending entry is ever present after Phase 0 runs. The backstop turns that argument from a claim into an
enforced invariant — it should never fire on correctly-functioning code, and exists so a FUTURE push site
(one that starts pushing a `.json`-shaped `sourceFile` after Phase 0, forgetting this card's lesson)
can't silently reopen the exact gap this card closes. Proven to actually fire via a TEST-ONLY injection
seam (`reenterMergeQuarantinesAtBoot`'s new, always-`undefined`-in-production
`testOnlyInjectUnprotectedPending` parameter), which pushes a `.json`-shaped pending entry directly into
`pendingUnresolvedQuarantines` AFTER Phase 0's own protection has already run — a disk layout no real,
post-fix code path can produce, which is exactly why a seam (not a natural fixture) is needed to exercise
it at all.

## Accepted residual — hash mis-attribution on a doubly-unlikely corrupt safety-tmp

Keying a pending entry's safety-tmp off the COLLISION's own hash (rather than any verified identity of the
pending entry itself — there is none) means that IF this new safety-tmp later goes corrupt/unreadable AND
the colliding sibling (e.g. `teamA`) is itself a registered repo, the existing corrupt-safety-tmp fallback
cascade (`hashToRepo` / `unresolvedClaimantsByHash` / `ancestorHashToRepo`) could mis-attribute the
corruption to the sibling instead of to the real (unresolvable, by-hash-unregistered) pending owner. This
is accepted, not fixed, because: (1) it requires BOTH this specific safety-tmp to independently corrupt
AND the pending entry to still be unresolvable at the next boot — already a narrow intersection on top of
an admittedly-unexpected corrupt-safety-tmp case ("Loom writes these itself"); (2) the failure mode stays
fail-closed either way — worst case is an extra, incorrectly-attributed placeholder quarantine, never a
silent drop of real data; and (3) there is no strictly better hash available: the pending entry's own
`canonicalRepoLockKey` is exactly the degraded, walked-up value that produced the collision in the first
place, so keying off it would be circular, not safer.

## Round 2 — Code Review b4742106 (CRITICAL + MAJOR, both reproduced against round-1 commit aea9cac3)

**CRITICAL 1 — the self-reference did not survive a reboot.** `writeSafetyTmpResidueAtHash(hash, p.entry)`
wrote `p.entry` to disk BEFORE the self-reference was added — it existed only in that boot's own
in-memory re-point. On a LATER boot, the safety-tmp recovery loop's own unresolvable-entry branch parsed
the tmp's bytes straight off disk and pushed `{entry, sourceFile: f}` WITHOUT any self-reference — only
the sibling DEGRADED branch added one. So: boot 1 secures the tmp (self-referenced only in memory) → boot
2 reads it back (no self-reference on disk) → a clear of the colliding sibling performed IN boot 2 sweeps
the tmp as "unreferenced" → boot 3 finds nothing — the pending quarantine is OPEN. Fixed on both sides:
(a) `writeSafetyTmpResidueAtHash` gained a `selfReference` parameter that folds the tmp's OWN basename
into `entry.orphanLatchFiles` BEFORE writing, so the persisted bytes themselves carry it (passed `true`
only at this card's own pending-protection call site); (b) the recovery loop's unresolvable branch now
ALSO self-references `f` at READ time, as a generic backstop for any safety-tmp whose bytes don't already
carry it — an older tmp written before this fix, or any other call site's write (e.g. round 4/5's own
migrate-source safety-tmp write, untouched by this card but covered for free by this same backstop).

**MAJOR — a degraded occupant's diverted pending entry was re-protected on EVERY boot (a regression vs
main).** A degraded-divert's pending reference (the `883e29bc` branch's push, via `flushDegradedDiverts`)
carries a `sourceFile` that is a FINAL-shaped basename — its own key's write target, e.g. `sha(Kx).json`
for an entry degraded-occupying key `Kx`. PASS 2's own orphan-reference loop (triggered by any unrelated
corrupt orphan) adds EVERY registered repo's own write target to `allBootWriteTargets` with NO regard for
`degradedOccupiedKeys` — so a registered repo sharing that exact degraded key puts its own basename into
the at-risk set, even though `bootWriteLatch`'s own `degradedOccupiedKeys` check refuses ANY write there
unconditionally, for every call site. Round 1's own Phase 0 loop had no way to tell this apart from a
genuine collision: it wrote a fresh, never-cleaned-up safety-tmp EVERY boot (unbounded residue growth)
and `.map()`-replaced the pushed entry, breaking its reference identity with `byRepoKey`'s own occupant
(so `listActiveMergeQuarantines`' reference-based dedup could no longer collapse the two, inflating the
reported count by one per boot). Fixed by excluding any `allBootWriteTargets` member that is also a
degraded-occupied key's own write target from the pending at-risk set — that write can never happen this
boot regardless, so there is nothing to protect. This also makes re-protection naturally idempotent
across boots: with the exclusion in place, a degraded-divert's own `sourceFile` is never touched at all,
so no write-site ever needs a separate "is one already protecting this" check.

**Nit 3 — the test seam is now structurally unreachable from production**, not merely unused:
`testOnlyInjectUnprotectedPending` moved off the exported `reenterMergeQuarantinesAtBoot` signature
entirely (production calls a zero-second-arg wrapper) into a separate, test-only
`reenterMergeQuarantinesAtBootTestOnly` export that `index.ts` never imports.

**Nit 4 — `bootWriteLatch` now checks `degradedOccupiedKeys` BEFORE the pending backstop**, so a refusal
for a degraded-occupied target logs its real, more specific reason rather than the generic "UNPROTECTED"
one — the two conditions CAN now legitimately coincide, since the MAJOR fix above deliberately leaves a
degraded-occupied key's own pending reference pointed at that exact basename.

**Nit 5 — site #5's own SKIP rationale restated structurally**: Phase 0 protects by TARGET BASENAME SET
membership, computed once, globally, before any write site runs — never by WHICH of the seven call sites
performs the write. Site #5's own write target is counted in the identical `allBootWriteTargets` set
every other site's scenario already exercises, so no site-specific scenario can discriminate;
`bootWriteLatch`'s own structural backstop is a second, independent guarantee, equally indifferent to
call site.

## Do not

- Do not walk `migratedSourcesByKey` alone when computing Phase 0's at-risk set — a pending entry's own
  `sourceFile` is never a member of that map (it has no `byRepoKey` entry at all) but can be physically
  identical to some other key's write target. Check `pendingUnresolvedQuarantines` separately, against
  the SAME `allBootWriteTargets` set.
- Do not derive a pending entry's safety-tmp hash from a "key" — a genuinely pending entry has no
  verified key, by construction (`canonicalRepoLockKey(entry.repoPath)` degrades to the same kind of
  walked-up value that caused the collision in the first place). Use the hash already embedded in its own
  at-risk `sourceFile` basename instead, via `writeSafetyTmpResidueAtHash`.
- Do not re-point a pending entry's `sourceFile` at its new safety-tmp's basename without ALSO
  self-referencing that basename into the entry's own `orphanLatchFiles` — `sweepTmpResidueForHashIfUnreferenced`
  honours only `orphanLatchFiles`, never `physicalOwnerRepoPaths`, so a bare re-point leaves the safety-tmp
  defenseless against a later, unrelated clear of whichever sibling ends up owning the collision target
  (the exact `97cff6db` round 5 G1a shape, now reproduced and closed here for the pending case too).
- Do not skip `blockedWriteTargets` propagation when the pending entry's own safety-tmp write fails — the
  colliding write must be blocked too, or "couldn't protect the pending entry" still lets the sibling's
  write destroy its only copy moments later (the same round-2 rule `97cff6db` already states for a
  migrate-source collision, applied symmetrically here).
- Do not treat the `bootWriteLatch` backstop (pending-sourceFile check) as the primary fix, and do not
  remove it as "redundant" once Phase 0's own loop is in place — it is deliberately a SECOND, independent
  line of defense against a FUTURE push site reopening this exact gap, not a restatement of Phase 0's own
  argument. It should never fire post-fix; that is the point, not a sign it is dead code.
- Do not try to exercise the backstop with a real on-disk fixture — no post-fix code path in this
  function can ever leave a `.json`-shaped pending entry present after Phase 0 runs (that is the whole
  argument the backstop exists to enforce as an invariant, not merely assert). Use the test-only
  `reenterMergeQuarantinesAtBootTestOnly` export's injection seam instead (round 2: moved off the
  production `reenterMergeQuarantinesAtBoot` signature entirely, never merely an always-undefined param
  on a shared export).
- Do not assume this closes every possible boot-write-vs-pending-entry collision shape without re-deriving
  the survey in "The bug" above first — it was built by exhaustively checking every
  `pendingUnresolvedQuarantines.push`/mutation site in the function for filename SHAPE (`.json`-final vs
  `.tmp-...`), not by assumption; a new push site added later must be re-checked against that same
  survey, or (per the backstop above) will simply be refused rather than silently reopening the gap.
- Do not bake a safety-tmp's self-reference into `orphanLatchFiles` only via an in-memory re-point after
  the write — write it INTO the persisted bytes (`writeSafetyTmpResidueAtHash`'s own `selfReference`
  param) or rely on the generic read-time backstop in the recovery loop; relying on the in-memory
  re-point ALONE means the self-reference never survives a reboot (round 2, CRITICAL 1).
- Do not treat a basename's presence in `allBootWriteTargets` as proof a write will actually land there
  this boot — PASS 2's own orphan loop adds every registered repo's own target with NO regard for
  `degradedOccupiedKeys`, so a degraded-occupied key's own target can be a member too, even though
  `bootWriteLatch` refuses it unconditionally. Exclude degraded-occupied targets from the pending at-risk
  set, or a degraded-divert's own pending reference gets "re-protected" every boot against a write that
  can never happen (round 2, MAJOR — a regression vs main: unbounded safety-tmp residue plus a
  `.map`-broken identity with `byRepoKey`'s own occupant).

## Verification

`test/merge-quarantine-migrate-source-owner-durable.mjs` gained a parametrised pending-collision helper,
run against representative write sites (not the full 7 sites × 2 degraded-states × 2 age-orders matrix —
every site shares the identical `allBootWriteTargets`/`blockedWriteTargets`/`bootWriteLatch` gate this
fix extends, so correctness does not depend on which site performs the colliding write; sites not given a
dedicated scenario are named with their reason in the test's own header rather than silently omitted):

- The primary repro (Phase 1a migrate-write-ALL pass colliding with a pending entry), both age orders.
- PASS 2's "fresh placeholder" branch colliding with a pending entry, both age orders (chosen as the
  generality check: structurally the most different site from the migrate pass — a single-key branch
  reached via an orphan-file trigger, not a write-ALL loop).
- The deferred-corrupt-tmp placeholder write colliding with a pending entry.
- The collision target additionally degraded-occupied by an unrelated third entry, both age orders
  (confirms the new protection fires independently of `degradedOccupiedKeys` membership).
- Injected safety-tmp-write failure — confirms `blockedWriteTargets` propagation refuses the colliding
  write too, and both the pending entry's original file and the sibling's data survive untouched.
- Same-boot clear of the colliding sibling, then a reboot-sim — confirms the pending entry's safety-tmp
  is NOT swept (self-reference via `orphanLatchFiles` holds) and the pending entry is still recoverable.
- Negative control: a pending entry whose `sourceFile` does not collide with anything — confirms no
  spurious safety-tmp write.
- The `bootWriteLatch` backstop itself, via the test-only `reenterMergeQuarantinesAtBootTestOnly` export's
  injection seam — confirms it refuses and both sides (the injected pending entry's original file, and
  the entry whose write it blocked) survive.

**Round 2 (Code Review b4742106) added:**

- CRITICAL 1 — boot 1 (create the collision) → boot 2 (a REAL reboot, reading the safety-tmp back via the
  ordinary unresolvable branch) → clear the colliding sibling IN boot 2 → boot 3 — the pending entry's
  quarantine still survives. Both age orders (`ef651188-multiboot-clear-in-boot2-order-a/b`), plus a
  4-boot variant with an extra, clear-free reboot in between to prove stability
  (`ef651188-multiboot-4boot-stability`). Each proven RED against round-1 commit `aea9cac3` (not merely
  against this round's own revert).
- MAJOR — a degraded-divert pending entry (its own `sourceFile` a FINAL-shaped basename shared with a
  separately-registered repo's own key) under PASS 2's orphan loop, run across 3 boots with no clear at
  all: the reported count and the on-disk safety-tmp count both stay FLAT across every boot
  (`ef651188-degraded-divert-pass2-orphan-no-growth`) — proven RED (growing count, growing tmp count)
  against commit `aea9cac3`.

Every scenario proven RED on main AND (where named above) against round-1 commit `aea9cac3` (a NAMED
failure, never a bare non-zero exit) and GREEN after, via `pnpm --filter @loom/daemon negative-control`.
All `merge-quarantine*.mjs` files run SERIALLY. `pnpm --filter @loom/daemon guards` green.
`pnpm --filter @loom/daemon build` clean.
