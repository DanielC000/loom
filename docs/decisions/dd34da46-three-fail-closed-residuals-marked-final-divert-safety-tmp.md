# dd34da46 — three fail-closed residuals left by the raise-divert card (Code Review 96a39432, Minors 1-3)

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up dd34da46 (Code Review 96a39432, Minors 1-3) — three fail-closed residuals left by this card

Manager ruling on three Minor findings from the Code Review of this card. All three are fail-closed (no
fail-open); none regress any "Do not" bullet above.

### Item 1 — a full clear that provably holds every token in a stale-marked `final` may unlink it

An existing-branch divert (the `existing`-truthy call site's own `mustDivert` branch) never touches
`final` — so a `keptUnreadableLatchFiles` mark set by an EARLIER, now-resolved transient read failure
stays set indefinitely (nothing durable ever writes to clear it). A LATER full clear of the same merged
identity (e.g. `clearMergeQuarantineByRecordedPath`) used to keep `final` unconditionally because of that
stale mark alone (round 5 of `63e49ee2`'s own unconditional check), even though reads have since recovered
and a fresh read proves every token physically there is already one this exact clear is dropping. Pre-fix,
the cleared token comes back once after a reboot (PASS 1 re-reads the now-readable, still-kept file).

**The fix:** `markedFinalFullyCoveredByClear(final, candidateTokens)` — a fresh, direct content read of
`final` RIGHT NOW, proving every on-disk token is already in `candidateTokens`. ENOENT/EISDIR (nothing
real there) and corrupt JSON (nothing usable) are trivially covered; any OTHER read failure, or a real
on-disk token not in `candidateTokens`, cannot be proven safe and keeps today's behavior. Wired into
`deleteMergeQuarantineLatchByKey`: when the mark is the ONLY reason `finalProtectOk` would go false, this
check decides whether to drop the mark (and proceed to unlink) or keep `final` exactly as before. This is
NOT the detector-result trust round 5 forbids (`differentUnresolvableOccupantRepoPathAt`/
`unincorporatedOccupantRepoPathAt`'s own identity-only "none") — it is a dedicated, content-level
containment check, gated on `finalProtectOk` already being true from every OTHER protect call (a genuine
foreign-occupant finding from those calls is never overridden here).

### Item 2 — a shape-1 divert plus a query leaves `clearMergeQuarantineLatchFile(id)` correctly refusing; no code change

Investigated directly (empirical probe against the real compiled module, matching shape 1's own fixture):
a shape-1 divert (D pure-pending at R's own real key, R's raise diverts) followed by a QUERY
(`activeMergeQuarantineFor(r)`, triggering lazy graduation) leaves R armed IN-MEMORY at the same key, but
R's own durable write there is REFUSED by the pre-existing degraded-occupant guard (D's content genuinely,
unresolvably occupies that exact physical file). R's own exposed latch id (`quarantineHashForKey`'s own
value for its armed key) therefore coincides EXACTLY with D's own physical file id — R has NO durable
backing at this id at all, while D is the confirmed physical owner, yet `quarantineLatchFileIdsFor`
reports this id for BOTH.

`clearMergeQuarantineLatchFile(id)` ALREADY refuses this case (the pre-existing `differentRepoPending`
check, from card `9a55fb90`/era): it finds the active match (R) AND a pending entry for a DIFFERENT repo
(D) sharing this exact id via `pendingLatchIdFor`, and refuses rather than guessing, naming BOTH
candidates' own `repoPath` and the precise `clear-by-path` remedy (`POST
/internal/merge-quarantine/clear-by-path` with either one). Verified directly: the refusal text already
names `r`, `d`, and the exact route; nothing is cleared by the refused attempt.

**Ruling: smaller safe option, already in place — no code change.** Full disambiguation is NOT safely
achievable here: the ambiguity is genuine, not an implementation gap — BOTH identities are legitimately
reported under this one id (R via its in-memory `armedKeys` claim with no physical backing, D via its
actual physical bytes), so a human's intent cannot be inferred from the id alone. Resolving "in favor of
whoever physically owns the bytes" would silently clear the WRONG identity whenever a human's intent was
actually the OTHER one — exactly the harm `9a55fb90`/`c9114934` exist to prevent. A regression/lock-in
test (`dd34da46-item2` in `merge-quarantine-raise-protect-failure.mjs`) pins this already-correct
behavior; no RED state exists to demonstrate since no source line changed for this item.

**Correction (Round 2, Code Review d42418af, Minor 1, card `95ea8d3f`) — FIXED, see "Follow-up 95ea8d3f"
below.** Following the refusal's own `clear-by-path` remedy, the remedy used to last for R but NOT for
D — a `clear-by-path(D)` after a shape-1 divert plus a query cleared D in-process but did not durably
persist that clear, so D's own token came back after a reboot. Fixed by card `95ea8d3f`; see that
section for the root cause and the fix.

### Item 3 — a double fault (the divert's own pending write ALSO fails) now falls back to a safety-tmp residue

`divertRaiseEntry`'s own `writePendingDivertFile` call, on failure (e.g. ENOSPC), only ever logged —
`entry` stayed enforced IN-PROCESS ONLY (the in-memory push already happened) and was silently LOST after
a reboot, with no durable trace anywhere.

Checked first (per the ruling): `writeSafetyTmpResidueAtHash`'s own output (a `.json.tmp-safety-<pid>-
<hex>` file) IS ALREADY recovered at boot — `reenterMergeQuarantinesAtBoot`'s dedicated safety-tmp
recovery pass (`97cff6db`, round 2) reads every such file and arms/diverts it exactly like an ordinary
latch, recomputing `canonicalRepoLockKey(entry.repoPath)` itself rather than trusting the hash embedded in
the filename — so the hash passed to this fallback need not be "correct" for any given degraded/collided
shape, only distinct from an unrelated `final`.

**The fix:** `attemptDivertSafetyTmpFallback(entry)` — calls `writeSafetyTmpResidueAtHash(quarantineHashFor
(entry.repoPath), entry, true)` as a best-effort fallback, ONLY when the primary pending-divert write
already failed. Wired at both of `divertRaiseEntry`'s own failure branches (the fresh-divert branch, and
the merge-into-existing-pending branch — passing `merged`, the object this process's own in-memory
bookkeeping now tracks, never the raw `entry`). `selfReference: true` bakes the tmp's own basename into the
written bytes' `orphanLatchFiles`, matching every other safety-tmp writer in this module (`ef651188`,
round 2, CRITICAL 1). No new boot-recovery machinery was built — this only reuses the existing recovery
pass. On a TRIPLE fault (the safety-tmp write ALSO fails), this logs loudly and the quarantine genuinely
will not survive a restart — an accepted residual, not chased further by this card.

### Tests

All three items in `merge-quarantine-raise-protect-failure.mjs`:
- **`dd34da46-item1`** — the existing-branch-divert setup (mirrors `s3`/existing-branch), then a LATER
  `clearMergeQuarantineByRecordedPath(d2)` with reads restored. Asserts `final` is unlinked (not kept),
  both tokens lift in-process, and neither resurrects after a reboot through a fresh module import.
- **`dd34da46-item2`** — the shape-1 setup, a query (`activeMergeQuarantineFor(r)`), then
  `clearMergeQuarantineLatchFile(Krhash)`. Asserts the refusal, that it names both repoPaths and the
  precise clear-by-path remedy, and that nothing was actually cleared. No RED state (no code change).
- **`dd34da46-item3`** — the shape-1 setup PLUS an injected `fs.openSync` failure (ENOSPC) targeting the
  divert's own deterministic pending-divert filename. Asserts the raise still persists in-process despite
  the double fault, that a safety-tmp residue carrying the token was written, and that the token survives
  a reboot through a fresh module import.

Items 1 and 3 proven RED on `HEAD` (pre-this-follow-up) and GREEN after, via `scripts/negative-control.mjs`
— item 2 stays green in both phases, as expected for a no-code-change item. All 33 `merge-quarantine*.mjs`
files re-verified individually, each exit 0. All static guards (`pnpm --filter @loom/daemon guards`)
re-verified green (30/30).

## Round 2 (Code Review d42418af of commit `c5c17d17`) — one Major regression, three nitpicks

Items 1 and 2 were judged sound as landed. One Major BLOCKER in Item 3's own fix, plus three nitpicks.

### BLOCKER — `attemptDivertSafetyTmpFallback`/`divertRaiseEntry` wrote the safety-tmp but never re-pointed the in-memory record at it

`writeSafetyTmpResidueAtHash`'s own `selfReference: true` bakes the tmp's own basename into the WRITTEN
BYTES' `orphanLatchFiles` — but round 1's version of the fallback only called this and logged; it never
updated the pending record `divertRaiseEntry` had already pushed, which kept pointing at the
`pending-<hash>.json`/`base.sourceFile` that was never actually written (or is now stale). So an
IN-PROCESS `clearMergeQuarantineByToken`/`clearMergeQuarantineByRecordedPath` swept only that
missing/stale file (a no-op, or a partial rewrite of stale bytes) and left the real safety-tmp an
untracked orphan on disk — a later boot's own recovery pass still finds and re-arms it regardless of the
clear, resurrecting the token.

Repros (both PASS on the parent `c5c17d17`, proving this is a genuine round-2 regression, never present
before Item 3's own fix existed):
- **P3b** (fresh-divert branch) — shape-1 setup, then `enterMergeQuarantine(r)` with every read of `final`
  failing plus an injected ENOSPC on the `pending-<hash>.json` open. `clearMergeQuarantineByToken(r, t)`
  lifts `t` in-process, but the safety-tmp stays on disk, untracked, and `t` comes back after a
  fresh-import reboot.
- **P3g** (the `merged` branch) — `t1` diverts normally (its own pending-divert file is actually written);
  `t2`'s own divert merges into `t1`'s existing pending record, but THAT rewrite fails. Releasing `t1` and
  `t2` in-process sweeps only the STALE pre-existing pending file (still holding just `t1`, untouched by
  the failed rewrite) — both tokens come back after a reboot.

**The fix:** `attemptDivertSafetyTmpFallback` now RETURNS the tmp's own basename (`string | false`) instead
of `void`, and never touches `pendingUnresolvedQuarantines`/`activeQuarantines` itself — purely a write
primitive. Both of `divertRaiseEntry`'s own failure branches, on a successful fallback, now mirror boot
Phase 0's own established pattern (`ef651188`, ~L4163): fold the tmp's own basename into the entry's
`orphanLatchFiles`, `replaceEntryEverywhere` (reaching an ALREADY-ARMED twin too, e.g. the existing-branch
divert's own `baseEntry`), and push the PENDING record at the tmp's own basename — never the
unwritten/stale original filename. The merge-into-existing-pending branch ALSO sweeps the now-superseded
`base.sourceFile` via `sweepOwnLatchFileUnlessOwnedElsewhere` (ownership-checked, never a bare unlink) —
its bytes are stale (the rewrite that would have updated them is exactly what failed) and fully
superseded by the safety-tmp. **Correction (Round 3, Code Review 765f5453, Minor 1):** this sweep is
NOT needed for the committed P3g scenario itself — CR measured that P3g still passes with the sweep call
removed, because a FULL (last-token) release's own `orphanFilesToSweep` loop in `clearPendingEntryByToken`
already sweeps every `orphanLatchFiles` entry (which includes `base.sourceFile`, folded in alongside the
safety-tmp basename) once nothing remains outstanding. The sweep's own real job is a PARTIAL release —
releasing only one of several merged tokens, which never reaches that full-clear loop at all — where
`base.sourceFile`'s stale bytes would otherwise survive on disk, untracked, until something unrelated
happened to fully clear the entry. See `dd34da46-p3g-v1`'s own test for the scenario that actually pins
it. A TRIPLE fault (the safety-tmp write ALSO fails) keeps the pre-existing, accepted-residual shape
(push at the original filename) — unchanged, never chased further.

### N2 — the two new helpers sat between an existing function's jsdoc and its own definition

`markedFinalFullyCoveredByClear` was inserted between `deleteMergeQuarantineLatchByKey`'s own jsdoc
(7 `@decision` anchors) and the function itself; `attemptDivertSafetyTmpFallback` likewise sat between
`divertRaiseEntry`'s own jsdoc and its function. Both helpers (with their own jsdoc) are now moved ABOVE
the jsdoc of the function they precede, so each doc comment attaches to the function it actually
documents again.

### N3 — item3's "a SAFETY-TMP residue was written" check was vacuous

The shared `MERGE_QUARANTINE_DIR` can already hold OTHER scenarios' own safety-tmp residues by the time
item3 runs (this file runs every scenario in one process), so a bare `safetyTmpFiles.length > 0` check
passes regardless of whether item3's OWN fallback ever ran. Fixed to select by r's OWN key hash prefix
(`${Krhash}.json.tmp-safety-` — `quarantineHashFor(r) === Krhash` since `r` is fully resolvable), with the
content check (`includes(rToken)`) kept as a second, independent confirmation.

### N4 — item 1's keep-mark was dropped BEFORE the unlink it was supposed to license, not after

Round 1's `markedFinalFullyCoveredByClear`-based override dropped `keptUnreadableLatchFiles` as soon as
coverage was proven, then attempted the unlink — so an EPERM/EBUSY-shaped unlink failure (silently
swallowed by the pre-existing `catch { /* ENOENT is the common case */ }`) left `final` physically on disk
with the mark ALREADY cleared, and nothing to stop the caller's own `tombstoneIfNotSurviving` from
tombstoning the tokens too (its own gate only checks whether the mark is STILL set).

**The fix:** the unlink attempt now classifies its own outcome (`unlinkConfirmed`: `true` for a genuine
success or ENOENT, `false` for any other error code); the proven-coverage mark is dropped ONLY when
`unlinkConfirmed` is true. An unconfirmed removal leaves the mark set — fail-closed — which, via the
PRE-EXISTING `tombstoneIfNotSurviving` gate (unchanged), also means the tokens are never tombstoned while
the mark survives.

### Tests

`dd34da46-item3`'s own two checks were tightened per N3 (see above). Two new scenarios added to
`merge-quarantine-raise-protect-failure.mjs`: `p3b` (the fresh-divert branch's own BLOCKER repro) and
`p3g` (the merged-branch's own BLOCKER repro, verbatim per the Code Review) — both asserting the token
lifts in-process, the safety-tmp residue is actually SWEPT (never left an untracked orphan) by the clear,
and the token does not resurrect after a fresh-import reboot. Both proven RED on `c5c17d17` (the parent
commit, NOT `HEAD` — the BLOCKER postdates item 1/2's own landing) and GREEN after, via
`scripts/negative-control.mjs --ref c5c17d17`. All 33 `merge-quarantine*.mjs` files re-verified
individually, each exit 0. All static guards (`pnpm --filter @loom/daemon guards`) re-verified green
(30/30). Line endings re-verified CR==LF via `working-tree-eol-guard.mjs` (no `sed -i` used this round).

## Follow-up dd34da46, Round 3 (Code Review 765f5453) — CR2 shipped; test/doc-only follow-up, no src change

CR2 passed Round 2's own fix as SHIP. Three test/doc gaps found in review, closed WITHOUT touching any
source file.

### `dd34da46-p3g-v1` — pins the `base.sourceFile` sweep for a PARTIAL release

CR2 measured that the committed `p3g` scenario passes even with the `base.sourceFile` sweep call (Round 2,
~L1832 at the time) removed — because `p3g` releases BOTH merged tokens, and a full (last-token) release
already sweeps every `orphanLatchFiles` entry (which includes `base.sourceFile`) via
`clearPendingEntryByToken`'s own `orphanFilesToSweep` loop, regardless of whether the EXPLICIT sweep ran
earlier. The sweep call's own real job is a PARTIAL release: releasing only ONE of several merged tokens
takes the partial-clear branch instead, which never looks at `orphanLatchFiles` at all — so without the
explicit sweep, `base.sourceFile`'s stale bytes (still holding only the FIRST token, never rewritten since
that rewrite is what failed) would survive on disk, untracked, and a later reboot re-arms the released
token from them.

`dd34da46-p3g-v1` reproduces the committed `p3g` setup exactly (t1 diverts normally; t2's own divert
merges into t1's pending record, whose rewrite fails) but releases t1 ONLY, then reboots. Asserts: the
stale original pending-divert file is ALREADY swept proactively (at write time, before any clear ever
runs); t1 is lifted in-process and does not resurrect after the reboot; t2 — never released — stays fully
enforced, in-process and after the reboot; d's own unrelated token survives throughout.

Proven RED via a SCRATCH commit (never landed, discarded after use) that removed ONLY the
`sweepOwnLatchFileUnlessOwnedElsewhere(base.sourceFile)` call (a valid, buildable one-line removal) —
`scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-raise-protect-failure.mjs --ref <scratch-sha>` reported the RED
phase (that scratch content) failing exactly `dd34da46-p3g-v1`'s own checks with the build still
succeeding, and the GREEN phase (the real, current content) passing, tree restored byte-identical. The
scratch commit was then discarded — it never reached this branch's real history.

### `dd34da46-n4` — the item1 shape, with the licensed unlink itself failing (EPERM)

Mirrors `dd34da46-item1`'s exact setup (an existing-branch divert leaving `final`'s own degraded entry
D2 kept-and-marked), but patches `fs.unlinkSync` to throw EPERM for `final`'s own path during
`clearMergeQuarantineByRecordedPath(d2)`, restoring it immediately after. Asserts: nothing throws; `final`
stays on disk, byte-for-byte unchanged; D2's own token — backed ONLY by `final`'s own kept bytes — SURVIVES
a fresh-import reboot (the documented, pre-existing "kept until reboot or a later successful read" residual,
`63e49ee2`); R2's own token, which has a SEPARATE durable backing (its own pending-divert record, never
`final` itself, from the existing-branch divert) is unaffected by the failed unlink and is fully,
successfully lifted both in-process and durably. This is the N4 ordering fix's OWN direct test — the
unlink-outcome classification (`unlinkConfirmed`) added in Round 2 is what keeps the mark (and so the
tokens) untouched on this exact failure shape; no separate RED proof was requested or performed for this
scenario, since N4 itself was already proven RED→GREEN in Round 2's own negative-control run.

### Correction — the sentence crediting the sweep with P3g's own survival was wrong

See the corrected paragraph under Round 2's own Item-3 "The fix" section above: the sweep is not what
P3g itself needs (CR2 measured this directly); it is what a PARTIAL release needs, which `p3g-v1` now
pins.

### Tests

`dd34da46-n4` and `dd34da46-p3g-v1` added to `merge-quarantine-raise-protect-failure.mjs`. All 33
`merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings re-verified CR==LF via
`working-tree-eol-guard.mjs`. No source file was touched this round.

## Do not

- **(Follow-up dd34da46, Item 1)** Do not let `markedFinalFullyCoveredByClear` run before every OTHER
  protect call at that site has already had its say — only attempt it when `finalProtectOk` is still
  true going in (nothing else already flagged a confirmed foreign occupant to keep). It is a NARROW,
  content-containment proof, never a general override of round 5's unconditional mark check.
- **(Follow-up dd34da46, Item 2)** Do not "fix" `clearMergeQuarantineLatchFile`'s ambiguous-id refusal
  into an auto-resolve for the shape-1-divert-plus-query collision — the ambiguity is genuine (BOTH
  identities are legitimately exposed under the same id; R has no durable physical backing at all, D
  does), not a gap to close. Resolving in favor of whichever identity happens to physically own the
  bytes would silently clear the wrong one whenever a human's actual intent was the other identity.
- **(Follow-up dd34da46, Item 3)** Do not build new boot-recovery machinery for `divertRaiseEntry`'s own
  double-fault shape — `writeSafetyTmpResidueAtHash`'s own output is ALREADY recovered by
  `reenterMergeQuarantinesAtBoot`'s pre-existing safety-tmp recovery pass; reuse it
  (`attemptDivertSafetyTmpFallback`), never a parallel reimplementation.
- **(Follow-up dd34da46, Item 3)** Do not pass the raw raiser `entry` to the safety-tmp fallback at
  `divertRaiseEntry`'s merge-into-existing-pending branch — pass `merged` (the object this process's own
  in-memory bookkeeping actually tracks going forward), or the fallback durably persists a token set this
  process has already moved past.
- **(Round 2, BLOCKER)** Do not let a safety-tmp fallback write succeed without re-pointing the CALLER's
  own pending record at it — writing the bytes (even with `selfReference: true`) is not enough; a stale
  in-memory `sourceFile` still pointing at the unwritten/stale original leaves the real tmp an untracked
  orphan a later boot still re-arms regardless of an in-process clear. Mirror boot Phase 0's own
  established pattern (`ef651188`, ~L4163): fold the tmp's basename into `orphanLatchFiles`,
  `replaceEntryEverywhere`, and push/rewrite the pending record's own `sourceFile` at the NEW basename.
- **(Round 2, BLOCKER)** Do not leave a merge-into-existing-pending fallback's own `base.sourceFile`
  behind once its content is superseded by a safety-tmp — its bytes are stale (never rewritten, since
  that rewrite is exactly what failed) and a later boot reads it independently of whatever the safety-tmp
  says. Sweep it via `sweepOwnLatchFileUnlessOwnedElsewhere` (ownership-checked, never a bare unlink).
- **(Round 2, N2)** Do not insert a new helper function between an EXISTING function's own jsdoc and that
  function's definition — move the new helper (with its own jsdoc) above the existing jsdoc instead, or
  the existing doc comment silently attaches to the wrong function.
- **(Round 2, N4)** Do not drop `keptUnreadableLatchFiles`' mark before confirming the unlink it licenses
  actually succeeded (or hit ENOENT) — an EPERM/EBUSY-shaped failure (silently swallowed by the
  pre-existing catch-all) must leave the mark set, fail-closed, so the caller's own
  `tombstoneIfNotSurviving` gate (which checks only whether the mark is still set) correctly refuses to
  tombstone the tokens too.
- **(Round 2, N3)** Do not assert "a SAFETY-TMP residue was written" by checking for ANY file matching the
  safety-tmp filename shape in `MERGE_QUARANTINE_DIR` — a multi-scenario test file can already hold OTHER
  scenarios' own residues by the time a later scenario runs. Select by the specific identity's own key
  hash prefix (or content), never a bare existence check.
- **(Round 3)** Do not credit a fix's own write-time side effect (the `base.sourceFile` sweep) with a
  scenario's survival (`p3g`) without first checking whether that scenario still passes with the side
  effect removed — a DIFFERENT code path (the full-clear's own `orphanFilesToSweep` loop) can already
  cover the committed scenario, making the credited mechanism untested until a scenario is written that
  genuinely cannot reach that other path (a PARTIAL release, `p3g-v1`).
- **(Round 3)** Do not assume a scenario's own preconditions hold at the SAME point in the scenario a
  SIBLING scenario's preconditions do — `p3g-v1` mirrors `p3g`'s own setup, but the write-time sweep
  being pinned runs PROACTIVELY, during the divert itself, not only at clear time; a precondition check
  asserting the swept file "still exists" right after the divert is checking the WRONG moment on the
  fixed code (it's already gone) — assert what the fix actually guarantees at that point instead.
