# d2592cd5 — a durable, identity-scoped cleared-tokens tombstone stops a reboot between clears resurrecting an already-cleared token

Pre-existing on main, confirmed by probe in the `e1572b69` Code Review (reviewer `bc7d387f`). Approved
design (manager ruling): a durable twin of the existing in-memory `clearedTokens`/`tombstoneIfNotSurviving`
mechanism, written ONLY on a clear's own confirmed-successful write, consulted at boot before any latch
file's raw tokens become a live record.

## The bug

`clearedTokens`'s own doc comment claimed resetting it on a reboot was safe because "a genuinely-
destroyed token's own durable write already removed it from disk before the process exited." That
assumes exactly ONE on-disk record per identity. An unresolvable identity can have SEVERAL independent
records (a primary pending-divert latch plus a stranded/orphan `.tmp-` sibling, tracked in-process via
`orphanLatchFiles`). A token durably removed from only ONE of them still durably survives, untouched, in
a SIBLING's own stale bytes. Boot never unified these (card `8bc779f0`'s own "Do not" explicitly forbade
filtering by `clearedTokens` at boot, correctly, since it was always empty there) — each record became
its own independent live entry, and `stillBlockedEntryFor`'s first-match read showed only ONE of them.

Repro (the card's own sequence): raise t1, t2, t3 for an unresolvable repo. Clear t1 with the primary
rename failing (stranded tmp X1, tracked, holds [t2,t3]). Clear t2 with X1's own orphan-rewrite failing
(outer write succeeds, primary durably narrows to [t3]; a NEW stranded tmp X2 holds the correctly-narrowed
[t3]; X1 itself is left stale, still holding [t2,t3]). Reboot BEFORE clearing t3: boot produces THREE
independent records (primary=[t3], X1=[t2,t3], X2=[t3]) for the one identity. Clearing t3 (the only token
the operator can see) narrows X1 to [t2] instead of removing it — the repo stays blocked by t2, whose
holder already cleared it, with nothing left on disk anywhere proving that.

## The fix

A. **Durable sidecar** (`merge-quarantine-cleared-tokens.dat`) — a token-keyed `{direct: string[],
literal: string[]}` map, the durable twin of `clearedTokens`'s own two-namespace shape (`0d3b64c6`/
`8bc779f0`'s cross-identity-bleed protection, preserved exactly). Lives OUTSIDE `MERGE_QUARANTINE_DIR`
entirely — a sibling of it, directly under `LOOM_HOME` — not merely named to dodge a pattern. Several
existing tests (and several existing production sweeps) diff `MERGE_QUARANTINE_DIR`'s own raw directory
listing to find "whatever just changed"; living outside it is what makes the sidecar structurally
invisible to every one of them, present or future, with no per-scan exclusion to maintain. (A first draft
of this fix put the sidecar INSIDE `MERGE_QUARANTINE_DIR`, named to avoid every `.json`-pattern scan by
construction — this broke `merge-quarantine-e1572b69-nested-orphan-tmp.mjs`'s own Scenario A, which finds
"the new stranded tmp" by diffing the directory's raw listing and picked up the sidecar instead, since
`"cleared-tokens-tombstone.dat"` sorts before a `"pending-…"` name. Moving the sidecar out of the
directory altogether closes this structurally, rather than chasing every present-and-future scan one at a
time.)

B. **Write-side gating.** The durable write (`tombstoneDurablyIfConfirmed`) is a SEPARATE, narrower call
from the existing in-memory `tombstoneIfNotSurviving` — it must NEVER piggyback on that function's own
unconditional firing, which also runs when the caller's own underlying write FAILED (by design — see
`clearTokenFromPendingIndices`'s own "never a false lift" comments). Wired in at these three sites
INITIALLY — the Follow-up section below extends the same gate to two more, for five total; see that
section's own "The five call sites" table for the complete, current list — each gated on that site's own
already-tracked write-success signal:
- `clearTokenFromPendingIndices`'s reduce branch — gated on `!writeFailed` (the existing local already
  tracking both its armed-key write loop and its own pending-divert write).
- `clearActiveEntryTokenAtKey`'s reduce branch — gated on its own equivalent `!writeFailed`.
- `clearMergeQuarantineByKey` — gated on a NEW `anyWriteFailed` flag (added, set at its own two existing
  write-failure branches) combined with the SAME expression its own `latchKept` return field already
  uses (`!anyReferencing && !anyKeptUnattributed && keptContentRepoPaths.size === 0`).

A full enumeration of every durable-removal path in this module, and which of them write a tombstone
(and why, or why not), is in the worker's own report on this card — not restated here, to avoid a second
copy that can drift from the source.

C. **Read-side (boot).** `loadClearedTokensTombstoneFileAtBoot` seeds `clearedTokens` from the sidecar
FIRST, before any latch file is read (this is what makes `8bc779f0`'s own "Do not" — filtering by
`clearedTokens` at boot is a structural no-op — no longer true; that record's prohibition is superseded
by this card for exactly this reason). Every one of boot's four raw-token-read sites (PASS 1's primary
`.json` parse, PASS 1b's `.tmp-` recovery, the safety-tmp recovery, and PASS 1b's unarmable-content read —
a field-missing record naming an absolute `repoPath`, card `ad66e57e`) routes its freshly-parsed token array
through `filterBootTombstonedTokens` before constructing a live entry. A record fully covered by the
tombstone (every token subtracted) is deleted rather than armed with zero tokens — this module's own
invariant is that no live record ever has an empty token set.

D. **Bound, cap-only — no in-process pruning.** An in-process prune (`pruneClearedTokensTombstoneIfFullyLifted`,
the original design) was proven UNSAFE and deleted entirely (card `d2592cd5` Follow-up,
`753667c6`/`dc11e3ad`): `merge-quarantine-0d3b64c6-sf1-sf2-tombstone-scope.mjs`'s own "drift route"
scenarios show a LATER operation in the SAME process legitimately reintroducing stale content for an
identity that looked fully-lifted (by disk content) moments earlier (`keptUnreadableLatchFiles`/
reconciliation is a core feature of this module, not an edge case) — "nothing on disk right now" is not
proof nothing will ever surface again for this identity in this process. Bounding is `CLEARED_TOKENS_TOMBSTONE_MAX_ENTRIES`
(5000, oldest-evicted-first) ALONE — evicting an old entry only reverts that ONE token to the pre-existing,
already-accepted, fail-closed (over-blocking) behavior. A safe invocation point (e.g. boot-time, against
the file listing already captured before any phase runs) is left to a follow-up, not yet built.

## Never-fails-open argument

- **Reboot at each step of the card's own sequence:** after step 1 (no clears) — trivially correct.
  After step 2 (primary write failed) — no tombstone written (gated out); boot's union of the stale
  primary and the stranded tmp over-blocks exactly as main did before this card (unchanged, accepted).
  After step 3/4 (the card's own case) — t2 is durably tombstoned (step 3's primary write succeeded);
  every boot-time record for the identity is filtered to `[t3]`; clearing t3 fully lifts it.
- **Crash mid-clear:** before the primary write lands — no tombstone attempt (same as a failed write,
  over-blocks, never under-blocks). After the primary write lands but before the tombstone write
  completes — tombstone missing, union un-subtracted, over-blocks exactly as the pre-fix bug today
  (never worse).
- **A tombstone write that itself fails** (EPERM/ENOSPC, same fault class as every other durable write in
  this module): caught, logged, never thrown, never treated as success — identical residual to the crash
  case. Boot's own READ of the sidecar is ALSO fail-closed: missing/corrupt/unparsable means "nothing
  tombstoned" (assume MORE blocking, never less) — mirrors `63e49ee2`'s established "never let an
  unconfirmed read justify less protection" doctrine.
- **A token re-raised after being cleared:** not reachable by construction. Tokens are random v4 UUIDs,
  minted once by `enterMergeQuarantine`, documented as "never re-minted for a different raise" — a later
  legitimate raise can never collide with an old tombstoned value.

## Verification

- Reproduced hermetically, by content, across a real reboot, BEFORE any fix (scratch script, not
  committed) — confirmed the exact three-record boot state and the resurrection the card describes.
- New test: `packages/daemon/test/merge-quarantine-d2592cd5-reboot-between-clears.mjs`. Scenario A is the
  card's own exact sequence (closed). Scenario B reboots after step 2 ONLY, asserting the fix never
  UNDER-blocks (t1 stays outstanding — no durable tombstone for a write that itself failed). Scenario C
  injects a fault into the tombstone sidecar's OWN rename, asserting the clear never throws and the next
  reboot gets no new protection for that one token (over-blocks, never under-blocks).
- Mutation-tested, two mutants, each restored before the next:
  1. `tombstoneDurablyIfConfirmed` made a no-op — turns Scenario A's own 4 "THE FIX" assertions RED
     (the card's own bug, reproduced), confirming the durable write is load-bearing.
  2. The success-gating at `clearTokenFromPendingIndices`'s reduce branch removed (`true` unconditional
     instead of `!writeFailed`) — turns Scenario B's own "NEVER UNDER-BLOCKS" assertion RED: a token
     whose underlying write FAILED gets wrongly tombstoned and then wrongly dropped at the next boot,
     demonstrating exactly the fail-open regression the gate exists to prevent.
- Negative-controlled (`node packages/daemon/scripts/negative-control.mjs --file
  packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-d2592cd5-
  reboot-between-clears.mjs`, default `--ref HEAD`, the uncommitted fix): RED against HEAD, GREEN after,
  working tree restored byte-identical.
- `merge-quarantine-5332762e-clear-narrowing-tmp-loss.mjs` and `merge-quarantine-e1572b69-nested-orphan-
  tmp.mjs` both re-run green after the fix (the sidecar's relocation outside `MERGE_QUARANTINE_DIR` was
  specifically what fixed a real regression these two caught — see "The fix" §A above).

## Follow-up (three-original-sites round)

The 2 "newly-wired" PENDING-tier identity-wide clear sites (`tryClearMergeQuarantineByOwnIdentity`'s
pending-sweep branch, `clearMergeQuarantineLatchFile`'s matched-pending branch) were gated on
`identityHasAnyPhysicalRecordOnDisk(identity)` — a FRESH, content-verified disk re-scan — before an
earlier round of this card's own work. The Lead's review asked whether the 3 ORIGINAL sites (§B above)
share the same gap. They do: the AE scenario (a wholly separate, untracked on-disk sibling holding the
token being cleared, never folded into anyone's `orphanLatchFiles` — e.g. a `BlockedCoOccupant.alsoClear`
kept file a prior, unrelated clear reported but never persisted anywhere this clear can see) is reachable
at all five `tombstoneDurablyIfConfirmed` call sites, not just two. Repro + fix verified by content,
across a real reboot, before any fix existed.

### The five call sites

| Site | Durable tombstone? | Disk-gated? | Why |
|---|---|---|---|
| `clearTokenFromPendingIndices`'s reduce branch (`!writeFailed`) | yes | **NOW YES** — `identityHasAnyPhysicalRecordHoldingToken(identity, [token], trackedBasenamesForIdentity(identity))` | A PARTIAL clear: the entry's own tracked siblings legitimately keep physically surviving (holding THEIR OWN different remaining tokens) — the bare identity-only check (`identityHasAnyPhysicalRecordOnDisk`) would wrongly treat any such ordinary survivor as a reason to never tombstone, defeating this card's whole purpose. The TOKEN-aware check, scoped to exclude every basename this call's own write/orphan tracking already accounts for, closes the real AE gap without that regression (see "The over-block regression" below). |
| `clearActiveEntryTokenAtKey`'s reduce branch (`!writeFailed`) | yes | **NOW YES** — same helper, same reasoning | Same PARTIAL-clear shape as above, for an ARMED (resolvable) identity instead of a pending-only one. |
| `clearMergeQuarantineByKey` (`!anyWriteFailed && !anyReferencing && !anyKeptUnattributed && keptContentRepoPaths.size===0`) | yes | **NOW YES** — same helper, with `candidateTokens` (every token this call is actually lifting, including a tied-twin's own overlap set) | This function can ALSO reduce a tied pending twin (keeping its own remaining tokens) while fully lifting the main entry — same "legitimate survivor" hazard as the two sites above, at a wider scope (the full `candidateTokens` set, not one token). |
| `tryClearMergeQuarantineByOwnIdentity`'s pending-sweep branch (`!pendingAnyKept`) | yes | yes (pre-existing) — `identityHasAnyPhysicalRecordOnDisk(identity)` | A FULL identity-wide clear: every pending entry for this identity is unconditionally DROPPED (never reduced) in this branch, so by construction nothing should legitimately remain on disk for the identity afterward — the bare identity-only check is correct here (no reduced-sibling false positive is possible). |
| `clearMergeQuarantineLatchFile`'s matched-pending branch (`!pendingAnyKept`) | yes | yes (pre-existing) — same helper | Same FULL identity-wide shape as above. |

### The over-block regression the token-aware helper exists to avoid

A first attempt wired the bare `identityHasAnyPhysicalRecordOnDisk(identity)` (no token/basename
awareness) into the 3 original sites directly. This turned `merge-quarantine-d2592cd5-reboot-between-
clears.mjs`'s own Scenario A RED: the identity's OWN just-narrowed tracked file (or a legitimately
tracked, still-stale stranded tmp from an earlier write failure) always still physically matches the
identity, so the bare check returns `true` on essentially every ordinary partial clear — the durable
tombstone would almost never fire at the 3 original sites again, regressing the card's own primary fix.
`identityHasAnyPhysicalRecordHoldingToken(identity, tokens, excludeBasenames)` fixes this: it is TOKEN-
aware (only a sibling that STILL holds one of the specific tokens being tombstoned counts) and takes an
explicit `excludeBasenames` set — every basename a `trackedBasenamesForIdentity(identity)` scan of
CURRENT, post-mutation `activeQuarantines`/`pendingUnresolvedQuarantines` state already accounts for
(a live armed-key final, a pending entry's own `sourceFile`, or anyone's `orphanLatchFiles`) — so a
known, tracked-but-stale sibling (even one whose own narrowing write failed) is never mistaken for the
genuine, untracked AE danger. Deriving the exclude set fresh from live state, rather than hand-threading a
written-basenames set through each clear path, avoids a missed accumulation silently reopening this same
regression later.

**Clarified (2nd/3rd fix rounds):** "never mistaken for the genuine AE danger" is true of THIS SCAN alone
— it correctly does not treat a tracked-but-write-failed sibling as untracked AE content. It does NOT mean
the write failure is thereby safe to ignore: this scan structurally EXCLUDES that sibling, so it can never
itself DETECT the failure either. Read this paragraph as "the scan doesn't misfire on it," never as "the
scan covers it" — coverage for that case is the separate `writeFailedIdentitiesThisCall` mechanism (2nd/3rd
fix rounds, below).

### A SEPARATE, real regression found and fixed in the same round: a mid-process boot-rescan wiped `clearedTokens`

`loadClearedTokensTombstoneFileAtBoot` (the boot-time seed, §C above) used to unconditionally
`clearedTokens.clear()` before reseeding from the sidecar — its own doc comment claimed this was safe
because the function is "only ever called once, at the very start of a fresh boot, before `clearedTokens`
can hold anything else." That is true in PRODUCTION (`index.ts` calls `reenterMergeQuarantinesAtBoot`
exactly once, genuinely before any clear). It is FALSE for the test corpus: 75+ `merge-quarantine-*.mjs`
files call `reenterMergeQuarantinesAtBoot` more than once per module instance, as a cheap mid-process
re-scan — several AFTER a real in-process clear has already populated `clearedTokens` with a token the
sidecar file was never told about (no durable write happened for it, e.g. a full lift). The destructive
reseed wiped that already-correct in-memory entry, reproduced hermetically (confirmed RED on
`merge-quarantine-raise-protect-failure.mjs`'s own pre-existing "25f6a7dc-tombstoned" scenario, in true
isolation, on commit `3baad4e3` — this card's OWN first commit — never on `main`). Fixed by making the
seed ADDITIVE ONLY (never `.clear()`, union onto any already-live entry for the same token) and guarding
the disk read itself behind a `clearedTokensTombstoneLoadedThisBoot` once-per-process flag (efficiency
only now, not correctness — an additive re-read can never remove protection). `resetClearedTokensTestOnly`
is a new, explicit TEST-ONLY export for a fixture that genuinely needs its OWN prior setup clear to
become invisible (e.g. a relocate/clear/restore trick) — it must reset state EXPLICITLY now, never lean
on the boot-rescan's own side effect to do it, since that side effect no longer exists. It wipes BOTH the
in-memory `clearedTokens` map AND the durable sidecar FILE on disk (best-effort unlink) — an earlier
version of this fix wiped only the map, which left the file to silently re-seed the exact same entries
right back in on the very next boot-rescan in the same process (caught by the full-corpus sweep below,
on `merge-quarantine-pass1b-clean-parse-gate.mjs` and `merge-quarantine-truncation-repro.mjs`, both of
which use the identical relocate/clear/restore trick with no prior `wipeDurableTombstoneSidecar`-style
helper at all — fixed the same way as `merge-quarantine-boot-hardening.mjs`, by calling
`resetClearedTokensTestOnly()` right after each setup-only clear). A `git grep` for
`renameSync.*park|parked` across `packages/daemon/test/merge-quarantine-*.mjs` finds 17 files using some
form of this relocate/park trick; only the two named above (plus `merge-quarantine-boot-hardening.mjs`,
already fixed in an earlier round) were confirmed broken by the full-corpus run — the other 14 either
park a file for an unrelated reason or never follow the park with a clear that durably tombstones
anything read again later in the same scenario. The remaining 14 are NOT audited file-by-file for "could
this latently break under a different sequence" — flagged as a residual, not re-derived here.

### Resolved: is `merge-quarantine-boot-hardening.mjs`'s own fixture wipe (card's TW/WFR-1/P1BPF scenarios,
commit `2a042be3`) masking a real production fail-open, or a genuine test-artifact fix?

GENUINE test-artifact fix, not a masked production bug. Those three scenarios RELOCATE a real latch/tmp
file OUTSIDE `MERGE_QUARANTINE_DIR` entirely (to `os.tmpdir()`), call `clearMergeQuarantine` for a clean
IN-MEMORY slate (pure test setup — nothing in production ever relocates a file out of the quarantine
directory and back), then restore the file to simulate a torn/failed-write boot recovery. No production
code path can ever see "a clear ran while this identity's own physical record was absent from the
directory, then reappeared moments later" — the relocate/restore step is a construction artifact of the
test harness, not a reachable shape. The commit's own fix (wiping the durable sidecar — now, after this
round, ALSO explicitly resetting `clearedTokens` via `resetClearedTokensTestOnly`, see above — right after
the setup-only clear, before restoring the file) is the correct compensation for the test's OWN reset
trick colliding with the clear function's now-real durable/in-memory side effects, not a cover for a
production defect.

### Confirmed: `merge-quarantine-9f387d7e-orphan-union-per-identity.mjs`'s own sidecar snapshot/restore
fix (commit `7bfcb31c`) is a genuine fixture-isolation fix

Confirmed in one line: `assertUnionSurvivesEitherClear`'s two legs (`tk1`/`tk2`) share ONE `loomHome` and
each boots a fresh module instance from the SAME pre-clear `MERGE_QUARANTINE_DIR` snapshot to prove either
token can be cleared independently — without also snapshotting/restoring the durable sidecar alongside
the directory listing, leg `tk1`'s own durable write would leak into leg `tk2`'s supposedly-independent
derivation. Pure cross-leg test isolation; no production shape involved.

### New tests (Scenarios H, I, J)

`merge-quarantine-d2592cd5-reboot-between-clears.mjs` gained three scenarios, one per original site, each
planting an AE-shaped UNTRACKED stray sibling (same identity, holding the token about to be cleared,
never named in anyone's `orphanLatchFiles`) and asserting the identity is still blocked by that token
after a real reboot:
- **Scenario H** — `clearTokenFromPendingIndices`'s reduce branch (pending-only, unresolvable identity,
  two tokens). Asserts via `listActiveMergeQuarantines()` unioned across every boot-time record for the
  identity, never `stillBlockedEntryFor`'s first-match read — this identity genuinely has TWO independent
  on-disk records after boot (the tracked, narrowed copy and the untracked stray), the same multi-record
  shape the card's own root cause describes.
- **Scenario I** — `clearActiveEntryTokenAtKey`'s reduce branch (a real, resolvable git repo so the raise
  ARMS directly into `activeQuarantines`).
- **Scenario J** — `clearMergeQuarantineByKey`'s own deferred call, reached via
  `clearMergeQuarantineByRecordedPath`'s ACTIVE branch (a resolvable repo, a single token fully lifted).

Mutation-tested (one mutant covering all three, since all three route through the same helper): made
`identityHasAnyPhysicalRecordHoldingToken` an unconditional `return false` (API-keeping — same signature,
parameters marked used via `void`) — turns Scenarios H/I/J's own three "THE FIX" assertions RED, and ONLY
those three (every other scenario in the file stayed green under the mutant), confirming the gate is
load-bearing specifically for these three sites and nothing else. Reverted; `git diff` confirmed
byte-identical to pre-mutant.

Negative-controlled (`node packages/daemon/scripts/negative-control.mjs --file
packages/daemon/src/git/merge-quarantine.ts --file packages/daemon/test/merge-quarantine-d2592cd5-
reboot-between-clears.mjs --file packages/daemon/test/merge-quarantine-boot-hardening.mjs --test
packages/daemon/test/merge-quarantine-d2592cd5-reboot-between-clears.mjs --test packages/daemon/test/
merge-quarantine-raise-protect-failure.mjs --test packages/daemon/test/merge-quarantine-boot-hardening.mjs
--ref 2a042be3`): RED against this card's own pre-Follow-up branch tip, GREEN after, working tree restored
byte-identical.

## Follow-up (fix round, Code Review `dc9e3326`)

A Code Review of this card's own tip found `persistClearedTokensTombstoneFile` serializing the WHOLE
in-memory `clearedTokens` map — so any later, UNRELATED successful clear durably tombstoned every
gated-off entry already sitting in that map too (one whose own write had failed, or whose AE disk
re-verification withheld it). Reproduced RED as Scenarios P1/P2 (a second identity's own successful
`clearByToken` making an earlier, gated-off token durable). Fixed by introducing a SEPARATE
`durablyTombstonedTokens` map, populated ONLY by `tombstoneDurablyIfConfirmed`'s own narrow, per-call
token+identity set (never a bulk copy of `clearedTokens`); `persistClearedTokensTombstoneFile` now
serializes only that map, and cap eviction operates on it alone, never on the live `clearedTokens`.
`loadClearedTokensTombstoneFileAtBoot` additively seeds BOTH maps now (a token read back from the
sidecar is, by construction, already durably confirmed, so a later persist must not drop it).
`tombstoneDurablyIfConfirmed`'s own signature grew two REQUIRED parameters (`tokens`, `clearingIdentity`
— the latter accepting either one raw repoPath or an array of raw spellings, for the one call site that
spans several distinct spellings of the same identity) so every call site states exactly what it is
confirming, rather than relying on whatever happened to be sitting in the shared map.

Six API-keeping mutants (same gates' own signature, logic disabled) were found still surviving the full
corpus and each independently killed with a new scenario (M1-M6, `merge-quarantine-d2592cd5-reboot-
between-clears.mjs`): `!writeFailed` at `clearActiveEntryTokenAtKey`'s reduce branch; `!anyWriteFailed`
and the `!anyReferencing && !anyKeptUnattributed && keptContentRepoPaths.size===0` term at
`clearMergeQuarantineByKey`; `!pendingAnyKept` at BOTH pending-tier full-identity-wide sites (a foreign
content-kept orphan discriminates these from Scenario E's own same-identity-kept shape, which does not);
and the unreadable-file `return true`→`continue` fail-closed branch in both
`identityHasAnyPhysicalRecordHoldingToken` and `identityHasAnyPhysicalRecordOnDisk`.

### The two full-lift branches (`clearTokenFromPendingIndices`'s remove branch; `clearActiveEntryTokenAtKey`'s
unconditional second call) deliberately do NOT durably tombstone — SUPERSEDED by card `3d4467cf` below

**Superseded.** Card `3d4467cf` (see the Follow-up section below) found a real fail-to-remember gap this
reasoning missed and added the durable call at both sites after all — kept here for the history of why it
was *originally* believed unnecessary, not as current guidance. The reasoning below was wrong about the
cost (no new failure-tracking turned out to be needed — see the superseding section for why), not about
the shape of the two sites themselves.

Both sites call only `tombstoneIfNotSurviving` (in-memory), never `tombstoneDurablyIfConfirmed`. This WAS
treated as a DELIBERATE choice for this round, not an oversight needing a matching fix:

- Adding it would require NEW write/sweep-failure tracking these branches don't currently have —
  `clearTokenFromPendingIndices`'s remove branch discards `deleteMergeQuarantineLatchByKey`'s own
  per-key outcome and `sweepOwnLatchFileUnlessOwnedElsewhere`'s own kept/unattributed signal entirely;
  `clearActiveEntryTokenAtKey`'s second call is reached only AFTER its own delegated
  `clearMergeQuarantineByKey` call has ALREADY made its own (correctly gated) durable attempt for every
  token that call knows about — this second call exists only to also tombstone `token` in-memory for the
  "released, not re-attributed" case (`8db913e2` Follow-up `d6efbc9b`), which that delegated call's own
  `touchedFinalBasenames` gate can miss.
- Leaving both in-memory-only is SAFE, never fail-open: when the underlying delete/unlink genuinely
  succeeds (the common case), there is nothing left on disk for this token anyway, so a durable tombstone
  would be a no-op. The ONLY place it would matter is the AE shape — an untracked foreign sibling also
  holding this exact token, never touched by this clear — and withholding the durable write there simply
  keeps the existing, already-accepted over-blocking posture (the repo stays correctly blocked by that
  stray) rather than under-blocking. No repro shows this fail open.
- Accepted as a residual: a future card can add the write/sweep-failure tracking these two branches lack
  if the AE-on-full-lift shape becomes a real operational problem; it is not required for this card's own
  closure (card `d2592cd5`'s own bug — a reboot resurrecting an already-durably-cleared token — cannot
  occur here, since nothing is ever durably cleared at these two sites).

### The `.literal` namespace vs `directPathIdentity` drift question — traced, not a confirmed issue

Every one of this round's five `tombstoneDurablyIfConfirmed` call sites passes the RAW `repoPath` (or,
at the one site spanning several raw spellings, the full set of them) — never a value a caller already
normalized via `directPathIdentity` — exactly mirroring `tombstoneIfNotSurviving`'s own established
discipline (`0d3b64c6` round 2 S1). `tombstoneDurablyIfConfirmed` itself re-derives both `directPathIdentity`
and `literalRepoPathKey` from each raw identity it's given, the same two-namespace split `tombstoneIfNotSurviving`
already uses. Traced against all five call sites: no drift is introduced by this round's fix. The
broader `0d3b64c6`-class question (whether `classifyLiteralGate`'s own open/closed read-time
classification could itself go stale between a token's write and a later read) is a PRE-EXISTING,
general question about the mechanism as a whole — this card touches only WHAT gets persisted, never the
literal-gate classification itself, so it is unchanged, and out of scope, here.

## Follow-up (card `6bdd2e87`) — the READDIR-failure branch, a different branch than the Round 2 mutants above

The Round 2 mutants above killed the per-file `readFileSync` unreadable-file branch (`return
true`→`continue`) in both gates. Neither gate's OWN FIRST fs call — `fs.readdirSync(MERGE_QUARANTINE_DIR)`
itself, `catch { return true; }`, before either function ever looks at a single file — was ever exercised
by any scenario in this file; a `return false` mutant there survived the full corpus clean (99/99 green).

Closed with two new scenarios in `merge-quarantine-d2592cd5-reboot-between-clears.mjs`: Scenario K
(`identityHasAnyPhysicalRecordHoldingToken`, at `clearTokenFromPendingIndices`'s reduce branch — the same
AE shape as Scenario H) and Scenario L (`identityHasAnyPhysicalRecordOnDisk`, at
`tryClearMergeQuarantineByOwnIdentity`'s pending-sweep branch via `clearMergeQuarantineByRecordedPath` —
the same shape as Scenario D). Both plant an untracked AE stray holding the token BEFORE the clear, then
fault `fs.readdirSync` for `MERGE_QUARANTINE_DIR` only (a new `injectReaddirFaultAt` helper, same shape as
this file's own `injectRenameFaultAt`/`injectUnlinkFaultAt`) around the clear call, restoring it before
reboot. Every OTHER `fs.readdirSync(MERGE_QUARANTINE_DIR)` call this module makes during a clear (the
tmp-residue sweeps) already fails SOFT on its own catch, so faulting the real `fs.readdirSync` for the
whole clear call never breaks the clear's own write — verified: the tracked copy still narrows/lifts
correctly under the fault in both scenarios.

Mutation-tested, each independently: `identityHasAnyPhysicalRecordOnDisk`'s readdir catch → `return
false` turned exactly Scenario L's own "THE FIX" assertion RED (110/111, nothing else); the identical
mutant on `identityHasAnyPhysicalRecordHoldingToken` turned exactly Scenario K's own assertion RED
(110/111, nothing else) — confirming each readdir-failure branch is independently load-bearing and the
two new scenarios don't overlap with any pre-existing one. Dist restored byte-identically after each
mutant (`tsconfig.tsbuildinfo` deleted before rebuild, `cmp` confirmed against a pre-mutant backup).

## Follow-up (card `3d4467cf`) — the two full-lift branches now DO durably tombstone

Supersedes "The two full-lift branches … deliberately do NOT durably tombstone" above: both of those
sites (`clearTokenFromPendingIndices`'s remove branch; `clearActiveEntryTokenAtKey`'s unconditional second
call) now ALSO call `tombstoneDurablyIfConfirmed`, gated the same way as the three original sites —
`!identityHasAnyPhysicalRecordHoldingToken(identity, [token], trackedBasenamesForIdentity(identity))`.

### The bug this closes

A full lift deletes the entry's own tracked record and never called `tombstoneDurablyIfConfirmed`. If an
untracked AE-shaped stray sibling for this identity still physically holds the token, a reboot correctly
keeps over-blocking on it (accepted, as before) — but when NEITHER a failed delete NOR a stray survives,
the token was never durably remembered as cleared at all, leaving a reboot's boot-time union free to
re-arm a later, unrelated stray for the same identity (migrated under a stale key, or an AE sibling raised
after this clear) and silently resurrect the already-cleared token. Repro (`merge-quarantine-3d4467cf-
full-lift-stray-reblock.mjs`, Scenarios A-G2): full-lift a token for an identity with a genuine untracked
AE stray holding it — the gate correctly WITHHOLDS the durable tombstone; with nothing contending it, the
gate durably tombstones it, closing the gap. This revised Scenario A's own original form (which the test
file's own header used to call out explicitly): a genuine untracked stray still physically holding the
lifted token MUST stay fail-closed BOTH BEFORE AND AFTER this fix — that is the required, never-fail-open
safety property, not a bug this fix removes. This fix's actual value is narrower — the ORDINARY case (see
Scenario B) now gets durably recorded instead of permanently leaving a sidecar gap, and (at
`clearActiveEntryTokenAtKey`'s own backstop specifically) an UNRELATED kept/referenced co-occupant no
longer permanently blocks this token's own, otherwise-safe durable confirmation (see Scenario G1).

### Why no new write/sweep-failure tracking is needed at the full-lift record's OWN basename — true, but
INCOMPLETE; see "Follow-up (fix round, Code Review)" below for the gap this section missed

At a full-lift site the record's own basename is no longer tracked anywhere in live state the moment the
lift runs (it is being DELETED, not reduced), so `identityHasAnyPhysicalRecordHoldingToken`'s fresh, post-
splice/post-delegation disk re-verification sees exactly the right thing either way FOR THAT ONE
BASENAME, without the caller tracking its own delete's outcome at all: a failed delete leaves the record
still physically on disk, so the scan sees it and withholds; a successful delete with no untracked AE
stray leaves nothing for the scan to find, so it durably tombstones. This part of the reasoning stands.

What it missed: the SAME call can ALSO touch a DIFFERENT basename — `clearActiveEntryTokenAtKey`'s
delegated `clearMergeQuarantineByKey` call can itself REDUCE a TIED PENDING TWIN sharing this identity
(never just delete the full-lift record itself), and `clearTokenFromPendingIndices`'s own batch can
likewise process a "reduce" target alongside a "remove" target for the SAME identity in one call. Either
sibling's own narrowing write can fail — and its basename stays `trackedBasenamesForIdentity`-excluded
from the disk scan REGARDLESS of that write's outcome (the exclusion means "a known, tracked,
legitimately-surviving sibling", not "a sibling whose write definitely succeeded"), so a bare disk scan
alone cannot see it. See "Follow-up (fix round, Code Review)" below for the fix: threading the sibling's
own write-failure signal explicitly into the gate, rather than relying on the scan alone.

### Mutant M5 re-aim (`merge-quarantine-d2592cd5-reboot-between-clears.mjs`) — see "Follow-up (fix round,
Code Review)" below for a SECOND re-aim of this same scenario, correcting this section's own premise

The pre-existing Scenario M5 (a content-kept FOREIGN orphan surviving `clearMergeQuarantineByKey`'s own
full lift, proving the `!anyReferencing && !anyKeptUnattributed && keptContentRepoPaths.size===0` term) was
re-aimed to call `clearMergeQuarantineByKey` directly, with `identityWideHumanClear:false`, rather than
through `clearMergeQuarantineByToken`, the public dispatcher it used before this card. Calling through
the dispatcher would let this card's own new backstop gate (`clearMergeQuarantineByToken`'s own full-lift
branch) independently durably-tombstone M5's own token on its own, unrelated disk re-verification — that
token has no AE stray of its own, only the foreign orphan the scenario is about does — masking the mutant
this scenario exists to kill. **Superseded by the fix-round Code Review below: `false` turned out to be
the WRONG isolation — see that section's own M5 re-aim for why, and for the scenario's current shape.**

### Verification

New scenarios A-G2 in `packages/daemon/test/merge-quarantine-3d4467cf-full-lift-stray-reblock.mjs`.
Negative-controlled with an EXPLICIT pre-fix ref (`node packages/daemon/scripts/negative-control.mjs
--file packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-3d4467cf-
full-lift-stray-reblock.mjs --ref f44f6b51`, confirmed `f44f6b51` carries the tests but not the fix): RED
against that pre-fix tip, GREEN restored, working tree confirmed byte-identical. Full corpus — all 124
`merge-quarantine-*.mjs` files (including the M5 re-aim) — green. `pnpm --filter @loom/daemon guards`
(35/35) and the lesson-299 ungated-landing list (9/9) both green.

## Do not

- Do not move the tombstone sidecar back inside `MERGE_QUARANTINE_DIR` — a test or production sweep that
  diffs that directory's own raw listing would start seeing it as "whatever just changed" there; this is
  not a hypothetical, it is the exact regression this card's own first draft caused and reverted.
- Do not gate the durable tombstone write on the generic in-memory `tombstoneIfNotSurviving` call's own
  firing — that call also fires when the underlying write FAILED, by design. Gate on the SPECIFIC call
  site's own already-tracked write-success signal instead (mutant 2 above proves why).
- Do not widen `filterBootTombstonedTokens`'s call sites beyond the four raw-token-read sites named in
  §C (the three plus PASS 1b's unarmable-content read, card `ad66e57e`) — it must run BEFORE a live entry
  is constructed from parsed JSON, never after.
- Do not arm a boot-time record with zero surviving tokens after filtering — delete the file and skip it;
  this module's own invariant is that no live record ever has an empty token set.
- Do not reintroduce an in-process prune of the durable tombstone sidecar — see §D above; it is unsafe by
  construction (a later operation in the SAME process can legitimately reintroduce stale content for an
  identity that looked fully-lifted moments earlier). Bounding stays cap-only.
- Do not gate a PARTIAL (reduce) clear's durable tombstone on the bare, identity-only
  `identityHasAnyPhysicalRecordOnDisk` — use the TOKEN-aware `identityHasAnyPhysicalRecordHoldingToken`
  with an `excludeBasenames` set derived fresh from live state (`trackedBasenamesForIdentity`), or a
  legitimately-reduced sibling will near-permanently defeat the tombstone at that site (see "The
  over-block regression" above).
- Do not reintroduce `clearedTokens.clear()` inside `loadClearedTokensTombstoneFileAtBoot` — a mid-process
  boot-rescan (the test corpus's own established, 75+-file pattern) must never discard an already-correct
  in-memory tombstone the sidecar file was never told about. A fixture that genuinely needs a clean slate
  calls `resetClearedTokensTestOnly` explicitly instead.
- Do not let `persistClearedTokensTombstoneFile` serialize `clearedTokens` again, in bulk or otherwise —
  this is the exact CRITICAL regression the fix round closed (Scenarios P1/P2). It must serialize ONLY
  `durablyTombstonedTokens`, and that map must only ever be grown by `tombstoneDurablyIfConfirmed`'s own
  per-call token+identity set or the boot-load's additive union, never by copying `clearedTokens`.
- Neither full-lift branch (`clearTokenFromPendingIndices`'s remove branch; `clearActiveEntryTokenAtKey`'s
  unconditional second call) calls `tombstoneDurablyIfConfirmed` directly any more, on the token path — do
  not reintroduce a direct call at either site. Since the 3rd fix round, both PUSH a `DeferredTombstoneJob`
  onto the shared, call-scoped array instead; `clearMergeQuarantineByToken` decides and writes every job
  exactly once, via `decideDeferredTombstones`, after every phase of the whole public call (including
  every delegate) has settled. **No durable tombstone may ever be written mid-call, by any site or
  delegate, on the token path — push a job; the verdict is decided at end-of-call.** See "Follow-up (3rd
  fix round)" and "Follow-up (4th fix round)" below.
- Do not let a backstop that re-decides a delegated clear's own durable tombstone AND in that delegate's
  own `anyReferencing`/`latchKept`/`contentKeptRepoPaths` signals — those are the foreign-co-occupant
  withhold this backstop deliberately overrides by design (Scenario G1/G2). AND in `anyWriteFailed` ONLY.
  Still true as of the 4th fix round — unchanged by any round's own refactor of WHERE/WHEN the decision
  actually runs.
- Do not decide ANY site's own durable-tombstone verdict mid-call, or trust its own push-time verdict as
  final — a tied sibling for the SAME identity, in the SAME batch or a LATER phase of the SAME public
  call, can fail its own write either before or after any one site's own decision point, and its basename
  reads "tracked" (excluded from the disk scan) regardless of that outcome. (History: round 1 deferred
  only the "remove" target's decision, ANDed against a batch-local set; the 2nd fix round made that set
  CALL-SCOPED (`writeFailedIdentitiesThisCall`) and deferred "reduce" too; the 3rd fix round found the set
  alone still wasn't enough — a decision WRITTEN immediately, before a later phase's own failure could
  ever be known, is still wrong — and moved every site to PUSH a job instead, decided+written exactly
  once, at the very end, via `decideDeferredTombstones`.)
- Do not trust a job's own push-time `nonFailureOk` (nor the write-failed set alone) as the FINAL word,
  even after the 3rd round's defer-the-write fix — see "Follow-up (4th fix round)" below:
  `decideDeferredTombstones` ALSO re-derives `identityHasAnyPhysicalRecordHoldingToken` fresh, at decide
  time, because a delete/unlink failure that never gets folded into the write-failed set at all (the
  round-4 reproduced gap) can leave a push-time scan looking clean while the record it was pushed for
  still physically holds the token right now.
- Do not assume a non-ENOENT unlink failure inside `deleteMergeQuarantineLatchByKey` is safe to log and
  drop — the file still physically holds the token. Fold it into the caller's own `anyWriteFailed`/
  `writeFailedIdentitiesThisCall`, same as every other write-failure branch in this module.

## Follow-up (fix round, Code Review of card `3d4467cf`)

A Code Review of card `3d4467cf`'s own tip found one BLOCKING defect in the two full-lift branches added
there, confirmed the manager's ruling that this fix must override ONLY the foreign-co-occupant withhold
(never the write-failure withhold), and made several follow-on corrections to this record and its tests.

### BLOCKING: the bare disk scan under-blocks when a TIED SIBLING's own reduce-write fails

`clearActiveEntryTokenAtKey`'s own full-lift SECOND call (after its delegated `clearMergeQuarantineByKey`
call returns) re-decided its durable tombstone from `identityHasAnyPhysicalRecordHoldingToken` ALONE, with
no knowledge of the delegated call's own `anyWriteFailed`. That delegated call can itself REDUCE a tied
pending twin sharing the same identity (card `64119847`'s own precondition shape) while fully lifting the
main entry — and if the twin's own narrowing write fails, its basename still excludes it from the disk
scan (`trackedBasenamesForIdentity` tracks it as a known, legitimately-surviving sibling, not as "its
write definitely succeeded") — so the backstop wrongly durably tombstoned the token anyway.

Repro (`merge-quarantine-d2592cd5-reboot-between-clears.mjs`, Scenario M7, driven through the PUBLIC
`clearMergeQuarantineByToken` — M4's own direct `clearMergeQuarantineByKey` call never reaches this
backstop at all): W armed `[s]` at `Kw`; a tied pending twin P `[s,v]`, `armedKeys:[Kw]`; a rename fault on
P's own narrowing write. On the pre-fix tip, `s` gets durably tombstoned and a reboot resurrects W with
only `v` outstanding. Fixed by having `clearMergeQuarantineByKey` return a new required `anyWriteFailed`
field on every return path, and ANDing `!result.anyWriteFailed` into the backstop's own gate —
**never** ANDing in `result.latchKept`/`referencingRepoPaths`/`contentKeptRepoPaths`, which the backstop
deliberately overrides by design (the manager's ruling: option (b) overrides ONLY the G1/G2
foreign-co-occupant withhold, never the write-failure withhold).

### The SAME blind spot, audited and found at the PENDING-site backstop too

The reviewer's own finding was scoped to the active-entry backstop; the Lead's own fix-round instructions
asked for the identical audit at `clearTokenFromPendingIndices`'s own "remove" (full-lift) branch. It has
the SAME gap, reached a DIFFERENT way: `collectPendingIndices` can match SEVERAL independent pending
wrappers for one identity into ONE `clearTokenFromPendingIndices([idx...], token)` call (this card's own
root-cause shape — see "The bug" above). If one of them is a "remove" target (R, holding only `token`)
and another is a "reduce" target (Q, holding `token` plus another), R's own tombstone decision used to be
made INLINE, at the moment R is processed in the batch's loop — scanning disk with Q's own sourceFile
EXCLUDED as "tracked", regardless of whether Q's own narrowing write (dropping `token`) later succeeds or
fails. A failed Q write leaves Q's on-disk copy genuinely still holding `token`, yet R's decision never
sees it either way, because the exclusion is unconditional on Q simply being a known, live, tracked
pending entry for the identity — not on Q's write actually having succeeded.

Repro: Scenario M8, the same shape (R + Q, same identity, Q's own rename faulted), driven through the
PUBLIC `clearMergeQuarantineByToken`. Fixed by deferring every "remove" target's own tombstone decision
to a pass that runs AFTER the whole batch (every reduce AND remove in it) has already executed its own
write/delete, ANDed against a new `reduceWriteFailedForIdentity` set populated as each "reduce" target's
own write actually resolves during the batch's main loop. The actual mutation/delete/splice ordering is
untouched — only the FINAL tombstone decision for a "remove" target is deferred; nothing else in the
batch's existing, already-audited "REPLACED (not spliced)" dynamic re-resolution logic changes.

### `anyReferencing`/`anyKeptUnattributed` do NOT need the same treatment — by design, not by omission

**CORRECTED by the 2nd Code Review (see "Follow-up (2nd fix round...)" below) — the "by definition" claim
in this section's own title and body is FALSIFIED:** a 2nd Code Review's own P2 repro showed
`clearMergeQuarantineByKey`'s delegate CAN return `referencingRepoPaths` naming the SAME identity being
cleared (not only a foreign one), via a mechanism this section never accounted for. The RULING survives —
`anyReferencing`/`anyKeptUnattributed`/`keptContentRepoPaths` must still NEVER be ANDed into any backstop
— but the REASON stated below ("structurally cannot see it either way") is not reliable as a general
argument; the real guard against a same-identity write failure is the separate, call-scoped
`writeFailedIdentitiesThisCall` set (2nd fix round), never an assumption that this disk scan's own
`referencingRepoPaths` output is foreign-only.

The Lead's own fix-round instructions asked whether these two signals (and `keptContentRepoPaths`) need
the same AND-in treatment as `anyWriteFailed`. They do not, and reproducing why requires `clearMergeQuarantineByKey`'s
own disk-scan helper, `identityHasAnyPhysicalRecordHoldingToken(identity, ...)`: it matches files by
CONTENT IDENTITY (`directPathIdentity(repoPath) === identity`), never by basename pattern alone. A foreign
co-occupant (the G1/G2 shape) carries a DIFFERENT repoPath/identity than the identity being cleared, by
definition — so this identity-scoped scan structurally cannot see it either way, write-failure or not.
`anyReferencing`/`anyKeptUnattributed`/`keptContentRepoPaths` are ABOUT that foreign co-occupant, not
about this identity's own write; ANDing them into the backstop would reintroduce exactly the regression
Scenario G1 exists to prevent (an unrelated kept/referenced co-occupant permanently blocking this token's
own, otherwise-safe durable confirmation) with no corresponding safety benefit, since the write-failure
case they'd be guarding against is already covered by `anyWriteFailed` alone.

### M5 re-aimed a second time — `identityWideHumanClear:false` was itself the wrong isolation

The prior "Mutant M5 re-aim" section above re-aimed M5 to call `clearMergeQuarantineByKey` directly with
`identityWideHumanClear:false` to dodge `clearMergeQuarantineByToken`'s own full-lift backstop. That
premise no longer holds: grepping every call site, `false` is reachable in PRODUCTION from exactly one
caller — `clearActiveEntryTokenAtKey`'s own full-lift backstop call — which (by the BLOCKING fix above)
unconditionally re-decides this exact withhold right after, on purpose (G1/G2). A standalone `false` call
no longer represents any real caller's own final word on the token. M5 now calls
`clearMergeQuarantineByRecordedPath(m5)` instead — the SAME identity-wide `true` route Scenario J already
uses, which no backstop ever re-decides afterward.

**A separate finding, surfaced while re-verifying this scenario, not fixed by this re-aim:** M5's own
orphan fixture (a readable, well-formed latch record for a resolvable `foreignRepoM5`) is NOT genuinely
"content-kept" (`keptContentRepoPaths`) in practice — `sweepOrphanLatchFilesUnioned`'s own arm-then-
classify logic (card `9f387d7e`/`25d0d45b`) successfully arms any readable, well-formed orphan record in
memory and classifies it as a live, referencing co-occupant instead, REGARDLESS of `identityWideHumanClear`
or whether the orphan's own repoPath happens to resolve. Verified directly (mutation-tested): nullifying
ONLY the `keptContentRepoPaths.size===0` clause of the gate, leaving `!anyReferencing &&
!anyKeptUnattributed` intact, does NOT turn M5 red — `anyReferencing` alone already withholds. Nullifying
the WHOLE combined term (the mutant as actually documented above and in the Round-2 mutant list) DOES
turn M5 red (and only M5), so M5's own "KILLS MUTANT 3" claim is correct for the term as documented — but
its label (and comment) overclaim exclusivity to the content-kept clause specifically, which M5 has
evidently never isolated on its own. Constructing a genuine `keptContentRepoPaths`-only repro (one where
`armForeignOrphanContentInMemoryIfUnenforced` returns `"already-enforced"` yet `classifyKeptRepoPath`
still reports non-live — a deliberate canonical-key collision) is a real, separate gap in this corpus's
own mutant coverage, left as a residual for a future card rather than solved here.

### Verification (fix round)

New scenarios M7, M8 in `packages/daemon/test/merge-quarantine-d2592cd5-reboot-between-clears.mjs`.
Negative-controlled (`node packages/daemon/scripts/negative-control.mjs --file
packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-d2592cd5-
reboot-between-clears.mjs --ref a8164cf2`): exactly M7's and M8's own four new assertions (the sidecar-
content check and the post-reboot resurrection check, for each) went RED against `a8164cf2` (the branch
tip carrying card `3d4467cf`'s own fix but not this round's), GREEN restored, working tree confirmed
byte-identical. M5's re-aim re-verified mutation-tested against the WHOLE documented term (see above).
Full `merge-quarantine-*.mjs` corpus, `guards`, and the lesson-299 ungated-landing list: see the worker's
own report on this fix round for the exact sweep and counts.

## Follow-up (2nd fix round, Code Review of card `3d4467cf`)

A 2nd Code Review of the fix round above found the `anyWriteFailed`-ANDing fix still under-blocks two
further ways, both within the SAME public `clearMergeQuarantineByToken` call.

### BLOCKING (P2): a NON-TWIN pending sibling's own earlier write failure is invisible to the full-lift
backstop

M7's own fix threads `result.anyWriteFailed` into `clearActiveEntryTokenAtKey`'s full-lift backstop —
but `result` comes from `clearMergeQuarantineByKey`'s own delegate call, which only ties a pending entry
via `pendingPlan` (shared `armedKeys`, a shared orphan-file reference, or a proven token subset — see
`clearMergeQuarantineByKey`'s own tie predicate). A wholly separate pending record P sharing the SAME
identity as the active entry W, but with none of those ties (no `armedKeys`, a different object — the
`535fd69d` shape), is invisible to that delegate's own `pendingPlan` entirely. If P was already reduced,
and its own narrowing write failed, EARLIER in this same `clearMergeQuarantineByToken` call's own
pre-pass (`clearTokenFromPendingIndices`'s `nonTwinPendingIndices` pass), the full-lift backstop's own
bare disk re-scan excludes P's basename as "tracked" (P is still a live pending entry) regardless of its
write having failed — so `s` gets durably tombstoned anyway.

Repro (`merge-quarantine-d2592cd5-reboot-between-clears.mjs`, Scenario P2, through the PUBLIC
`clearMergeQuarantineByToken`): W active `[s]` at `Kw`; a NON-twin pending P `[s,v]` (no `armedKeys`),
same identity as W; a rename fault on P's own narrowing write. The pre-pass reduces P (its write fails,
withheld correctly FOR P's own decision); the active loop then full-lifts W, and the backstop — seeing no
failure of its OWN (`result.anyWriteFailed:false`, since P was never in its `pendingPlan`) — wrongly
tombstones `s`.

### MAJOR, pre-existing (P1): two REDUCE targets in one batch, decided inline, miss each other's failure

The first fix round deferred a "remove" target's own decision past the whole batch, ANDed against
`reduceWriteFailedForIdentity` — but left a "reduce" target's own decision INLINE, at
`clearTokenFromPendingIndices`'s own reduce branch. Two independent pending REDUCE targets Q1 `[tok,a]`
and Q2 `[tok,b]` sharing one identity, in ONE `clearTokenFromPendingIndices` batch: whichever one's own
write fails, the OTHER (succeeding) sibling's own inline decision scans disk with the failed sibling's
basename excluded as "tracked" — regardless of its write outcome — and wrongly durably tombstones `tok`
anyway. Reproduced in BOTH iteration orders (Scenarios P1a, P1b) — this was never an artifact of which
sibling happens to fail or be visited first.

### Minor findings

(a) The "remove"-deferred fix (first round) was only ever exercised with the reduce target (Q) processed
BEFORE the remove target (R) in the batch — a mutant that reverted R's own decision back to INLINE, while
still ANDing the per-batch failure set at that earlier point, would still have passed. Scenario M8B (Q at
the LOWER index, processed AFTER R) closes this coverage gap; it does not reproduce a live bug on this
round's own predecessor code (R's decision was already correctly deferred there), only on the described
hypothetical mutant.

(b) `clearMergeQuarantineByKey`'s own `anyWriteFailed` field, on its CLEAN return path (no `latchKept` at
all), was never directly pinned — a mutant clearing it ONLY on that return branch survived the corpus.
Pinned by Scenario M4-AWF, reusing M4's own construction (a tied twin's reduce-write fails during a full
lift, which never sets `anyReferencing`/`anyKeptUnattributed`/`keptContentRepoPaths`, so the result
reaches the clean-return branch with `anyWriteFailed:true`).

### The fix: ONE call-scoped `writeFailedIdentitiesThisCall` set, shared across every phase

**SUPERSEDED IN PART by "Follow-up (3rd fix round)" below** — the bullet list immediately below describes
this round's own fix as written THEN; the 3rd Code Review found it still writes durably MID-CALL at two
more sites (the `clearMergeQuarantineByKey` delegate's own internal decision, never threaded this set at
all; and every site here deciding+WRITING immediately rather than deferring the WRITE itself past the
whole call) — see that section for the current, correct shape. Kept here for the history of what this
round actually changed, not as current guidance for where/when the write happens.

`clearMergeQuarantineByToken` now creates ONE `Set<string>` (identities, matching
`tombstoneDurablyIfConfirmed`'s own namespace) and threads it through every phase it runs: both
`clearTokenFromPendingIndices` invocations (the pre-pass and the post-arm pass) and the active loop's own
`clearActiveEntryTokenAtKey` calls. Every durable-tombstone decision in the whole call ANDs in "this
identity is not in the set", on top of its own pre-existing checks:

- `clearTokenFromPendingIndices`'s reduce branch no longer decides inline — EVERY target (reduce AND
  remove) is now pushed onto ONE `deferredTombstoneJobs` list and decided in a single pass AFTER the
  whole batch has settled, closing P1 regardless of order.
- `clearActiveEntryTokenAtKey`'s full-lift backstop and its own reduce branch both fold their own write
  failure into the shared set (`if (<writeFailed>) writeFailedIdentitiesThisCall.add(identity)`) and AND
  the set into their own `tombstoneDurablyIfConfirmed` call, closing P2 — a same-identity failure from an
  EARLIER phase of this same call now withholds a LATER phase's decision too, even when the two phases
  never directly tie the two records together at all.
- The backstops still override ONLY the foreign-co-occupant withhold (`anyReferencing`/`latchKept`/
  `contentKeptRepoPaths` — G1/G2, unchanged) — never write-failure, per the manager's original ruling.

`identityHasAnyPhysicalRecordHoldingToken`'s own doc comment (previously claiming a tracked-but-stale
sibling "is exactly what the tombstone exists to cover for") is corrected: that disk scan structurally
EXCLUDES a tracked sibling by design, so it alone can never see a same-identity write failure — every
caller now ANDs `writeFailedIdentitiesThisCall` separately, never relying on the scan for this case.

### Verification (2nd fix round)

New scenarios P2, P1a, P1b, M8B, M4-AWF in
`packages/daemon/test/merge-quarantine-d2592cd5-reboot-between-clears.mjs`. Negative-controlled (`node
packages/daemon/scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-d2592cd5-reboot-between-clears.mjs --ref e40e3c1f`): P2's and P1a's/
P1b's own assertions (the sidecar-content check and the post-reboot resurrection check, for each) went RED
against `e40e3c1f` (the branch tip carrying this card's 1st fix round but not this one), GREEN restored,
working tree confirmed byte-identical. M8B and M4-AWF stayed green against `e40e3c1f` (as expected — see
"Minor findings" above; they pin mutant-only gaps, not a live `e40e3c1f` bug).

Three API-keeping mutants, each independently reverted after:
1. Every `writeFailedIdentitiesThisCall.add(identity)` call replaced with a no-op — turned Scenario B,
   M1, M7, M8, P2, P1a, P1b, and M8B all RED (the set being populated at all is load-bearing broadly).
2. The full-lift backstop's own `!writeFailedIdentitiesThisCall.has(identity) &&` term dropped (keeping
   `result.anyWriteFailed`'s own `.add()` call intact) — turned exactly M7 and P2 RED.
3. The deferred-decision pass's own `!writeFailedIdentitiesThisCall.has(job.identity) &&` term dropped —
   turned Scenario B, M1, M7, M8, P2, P1a, P1b, and M8B all RED (this decision point is load-bearing for
   every target in the module, not just P1's own two-reduce-target shape).

Full `merge-quarantine-*.mjs` corpus (124 files, by name, one lane), `pnpm --filter @loom/daemon guards`,
and the lesson-299 ungated-landing list: see the worker's own report on this round for the exact sweep and
counts.

## Follow-up (3rd fix round, Code Review `fc10277f` of the 2nd fix round)

A 3rd Code Review found the 2nd round's own fix still writes a durable tombstone MID-CALL at two more
places, both reproduced across a real reboot before any fix was written.

### BLOCKING 1: the `clearMergeQuarantineByKey` delegate's own internal decision never saw the shared set

The delegate's own `tombstoneDurablyIfConfirmed` call (reached via `clearActiveEntryTokenAtKey`'s
full-lift branch) decided and WROTE immediately, gated only on its OWN local `anyWriteFailed` — it never
received `writeFailedIdentitiesThisCall` at all, so a failure recorded by ANY OTHER phase of the same
public call (including a non-twin pending sibling's own pre-pass failure, invisible to the delegate's
`pendingPlan` entirely) could never withhold it. The 2nd round's own P2 scenario passed only
INCIDENTALLY — `injectRenameFaultAt` leaves a real stranded `.json.tmp-*` file that the delegate's own
unrelated orphan/co-occupant scan happens to notice (setting `anyReferencing`, which already withholds
independently of this gap). Scenario P3 closes the gap genuinely: the SAME shape, faulted at
`fs.openSync` instead of `fs.renameSync`, so NOTHING is ever stranded on disk — P3 is RED on `dbaa253d`,
where P2 is GREEN only by accident.

### BLOCKING 2: reverse cross-phase order — an earlier phase's decision was written before a later
phase's failure could ever be known

Every site's own fix (2nd round) deferred its DECISION past its own batch/call, then WROTE immediately
at that point. When phase N's decision is written before phase N+1 even runs, phase N+1's own later
failure (same identity) can never retroactively un-write it. Scenario P4 (pre-pass decides EARLY,
succeeds; active-reduce fails LATER) and Scenario P5 (active full-lift decides EARLY, succeeds; a
pending record armed MID-CALL and caught only by the POST-ARM pass fails LAST) are both RED on
`dbaa253d` for exactly this reason.

### The structural fix (Lead ruling): no durable tombstone is written mid-call, by any phase or delegate

`clearMergeQuarantineByToken` creates ONE call-scoped `deferredTombstoneJobs: DeferredTombstoneJob[]`
array (type defined just above `tombstoneDurablyIfConfirmed`), shared with `writeFailedIdentitiesThisCall`
across every phase AND threaded into the `clearMergeQuarantineByKey` delegate. Every site that used to
decide-and-write (`clearTokenFromPendingIndices`'s remove AND reduce branches, `clearActiveEntryTokenAtKey`'s
full-lift backstop AND its own reduce branch, and `clearMergeQuarantineByKey`'s own internal decision when
called with the two new optional trailing params) instead computes `nonFailureOk` — its own foreign-
co-occupant/disk-scan verdict, PLUS any write failure the site itself already knows about (its own local
`anyWriteFailed`/`writeFailed`), exactly as before — and PUSHES `{identity, tokens, repoPath, nonFailureOk}`
onto the shared array, never calling `tombstoneDurablyIfConfirmed` itself. ONLY after every phase of the
public call has run (pre-pass, active loop, post-arm pass — in that order, unchanged) does
`clearMergeQuarantineByToken` walk the array ONCE and decide+write each job:
`tombstoneDurablyIfConfirmed(job.nonFailureOk && !writeFailedIdentitiesThisCall.has(job.identity), ...)`.
A crash before this final pass only OVER-blocks (fail-closed; no worse than the pre-existing, already-
accepted posture) — nothing is ever written early enough to be wrong.

`clearMergeQuarantineByKey`'s own two new trailing params (`deferredWriteFailedIdentitiesThisCall?:
Set<string>`, `deferredTombstoneSink?: DeferredTombstoneJob[]`) are BOTH optional and used ONLY by the
token path; every OTHER caller (the three identity-wide human-clear routes: `clearMergeQuarantineByRecordedPath`'s
four call sites, `tryClearMergeQuarantineByOwnIdentity`'s matched loop, `clearMergeQuarantine`'s own
direct call) omits both and keeps the pre-existing decide-and-write-immediately behavior byte-identical —
this round touches NOTHING about `identityWideHumanClear:true` callers.

`clearTokenFromPendingIndicesTestOnly` (the one seam that bypasses the public dispatcher entirely) now
decides+writes its own jobs immediately, right after calling the now-deferred `clearTokenFromPendingIndices`
— mirroring what the real dispatcher would do for a call with exactly one phase, so this seam's own
external behavior is unchanged.

### Item 4 (investigate-first): `tryClearMergeQuarantineByOwnIdentity`'s matched loop — NOT CONSTRUCTED by any existing fixture; the union mechanism leaves it open, not closed

The Lead's own fix-round instructions asked whether `tryClearMergeQuarantineByOwnIdentity`'s `matched`
loop (several `clearMergeQuarantineByKey(m.key, m.repoPath, L, true)` delegate calls, one per matched
active entry sharing one identity, each deciding durably with only its own local `anyWriteFailed`, no
shared set threaded between iterations) has the same class of gap — two matches for the same identity
overlapping tokens, where a later match's own write failure should withhold an earlier match's already-
decided tombstone.

**RETRACTED (round 4): "provably unreachable" was WRONG — premise (2) below is FALSE.**
`unionQuarantineEntries` (merge-quarantine.ts ~:1647) unconditionally unions BOTH sides' `.tokens` into
the returned object, regardless of whether the two sides share an identity. `armQuarantineKey`
(~:1709-1711) only re-points EVERY in-memory reference to the losing side (`replaceEntryEverywhere`) when
that side shares the WINNING side's identity — on a genuine key COLLISION between two DIFFERENT
identities, the losing side's own pre-union object can survive, still referenced by a pending wrapper
nothing re-points, while the exact same token value it carries is now ALSO present in the winning side's
own, differently-identified `armed` object. That is exactly the "two matched entries share a literal
token" shape premise (2) claimed could never happen.

1. `activeMatchesAndLiftedKeysFor` (the source of `matched`) dedupes by OBJECT REFERENCE
   (`seen.has(entry)`) — still true, and still correct on its own terms: two array entries for one
   identity are two genuinely distinct `MergeQuarantineEntry` objects.
2. ~~A token is minted once, into exactly ONE entry object's own `.tokens` array.~~ **FALSE** — see above;
   a key-collision union can duplicate a token value across two DIFFERENT identities' own objects.
3. `test/merge-quarantine-c93e9e7a-cross-entry-liftedkeys.mjs`'s own `"recorded-path-threading-pin"`
   scenario constructs a two-matched-active-entries-one-identity shape with DISJOINT tokens — that remains
   true of THAT fixture, but no longer supports "disjoint is the only producible shape" now that (2) is
   retracted.

**Conclusion: NOT CONSTRUCTED, not PROVABLY UNREACHABLE.** No existing fixture in this corpus builds the
shared-token shape through the union mechanism above, so this round found no reproducible fail-open to
fix here — but the mechanism itself leaves the door open, and a future fixture (or a future production
sequence) could walk through it. The human-route cross-phase shape (this `matched` loop, and the
union-collision mechanism above) is tracked on a separate card per the Lead's own round-4 ruling, not
fixed here.

### Verification (3rd fix round)

New scenarios P3, P4, P5, P6 in `packages/daemon/test/merge-quarantine-d2592cd5-reboot-between-clears.mjs`.
P3/P4/P5 are negative-controlled (`node packages/daemon/scripts/negative-control.mjs --file
packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-d2592cd5-
reboot-between-clears.mjs --ref dbaa253d`): their own six assertions (two each) went RED against
`dbaa253d` (the branch tip carrying the 2nd fix round but not this one), GREEN restored, working tree
confirmed byte-identical via the script's own CLEAN check. P6 is a COVERAGE PIN, not RED on `dbaa253d`
(mirrors M8B/M4-AWF above) — see the next paragraph for its own mutant proof.

Three API-keeping mutants, each gated behind a temporary `process.env.LOOM_MUTANT_*` check, run, then
reverted (`git diff` confirmed byte-identical to pre-mutant):
1. `LOOM_MUTANT_DECIDE_IMMEDIATELY` — decide+write every phase's own jobs right after that phase, instead
   of once at the very end. Turned P4 and P5 RED (4 checks); P3 and P6 stayed green (their own gap is
   closed by mutant 2/the set-check alone, not by timing-within-this-mutant's-scope).
2. `LOOM_MUTANT_DELEGATE_WRITES_DIRECTLY` — `clearMergeQuarantineByKey` writes directly even when given
   the deferred sink. Turned P3 and P5 RED (4 checks).
3. `LOOM_MUTANT_IGNORE_WRITE_FAILED_SET` — the final decide pass ignores `writeFailedIdentitiesThisCall`
   entirely. Turned Scenario B, M1, M7, M8, P1a, P1b, M8B, P3, P4, P5, AND P6 all RED (24 checks) —
   confirming the final pass's own set-check is load-bearing for every scenario in the file, including
   P6's own coverage-pin shape.

Full `merge-quarantine-*.mjs` corpus (124 files, by name, one lane, sequential): 124/124 exit 0.
`pnpm --filter @loom/daemon guards`: 35/35 passed. The lesson-299 ungated-landing list (9 files, run
directly by name): all 9 passed.

## Follow-up (4th fix round, Code Review `b23c7ad9` of the 3rd fix round)

A 4th Code Review found the 3rd round's own structural fix still has a reproduced CRITICAL fail-open
across a reboot: `deleteMergeQuarantineLatchByKey`'s own non-ENOENT unlink failure for `final` was
swallowed outside `provenCoverage` — never surfaced into `anyWriteFailed`, never folded into
`writeFailedIdentitiesThisCall`, and never re-checked at decide time. A sibling job for the SAME identity,
pushed EARLIER (while `final` was still a live, "tracked" in-memory record, so the push-time disk scan
correctly excluded it), sailed through decide-time unchallenged: its stale `nonFailureOk:true` durably
tombstoned the token even though `final` still physically held it. After a reboot, boot deleted the
kept-but-un-unlinked `final` as "covered by the tombstone," and the quarantine failed open — the card's
own original stranding symptom, reopened by a different mechanism.

### The Lead's binding ruling

A token still physically held by a record whose write FAILED anywhere in a public clear call must NEVER
be durably tombstoned by ANY decision in that same call. Two independent, redundant fixes, BOTH required:

1. **A failed unlink IS a write failure.** `deleteMergeQuarantineLatchByKey` now returns `writeFailed?:
   true` whenever its own `fs.unlinkSync(final)` fails with a non-ENOENT code outside `provenCoverage`
   (the `provenCoverage` branch already logged but never surfaced it either — now it does, implicitly, by
   feeding the same new field). Every caller folds it into its own `anyWriteFailed`
   (`clearMergeQuarantineByKey`'s two call sites) or directly into `writeFailedIdentitiesThisCall`
   (`clearTokenFromPendingIndices`'s own "remove" branch, which has no `anyWriteFailed` local of its own).
2. **The decide-time verdict is RE-DERIVED, not trusted.** `decideDeferredTombstones` (the new,
   extracted, single decision point — see "Structural" below) re-runs
   `identityHasAnyPhysicalRecordHoldingToken(job.identity, job.tokens, trackedBasenamesForIdentity(job.identity))`
   fresh, for every job, at the very end of the whole public call — never trusting `job.nonFailureOk` (a
   push-time snapshot) alone. This is strictly fail-closed on top of the two push-time conditions: ANDing
   a third, freshly-re-read check can only ever turn a `true` into a `false`.

### Structural

- `clearMergeQuarantineByKey`'s two independently-optional trailing params
  (`deferredWriteFailedIdentitiesThisCall?`, `deferredTombstoneSink?`) are collapsed into ONE optional
  `deferred?: { writeFailed: Set<string>; sink: DeferredTombstoneJob[] }`, discriminated via TypeScript
  overloads on `identityWideHumanClear`: the `false` overload (the token path's one real caller,
  `clearActiveEntryTokenAtKey`) REQUIRES `deferred` at compile time; the `true` overload (every
  identity-wide human-clear route) takes none. A token-path call site that forgets `deferred` can no
  longer compile — this was previously enforceable only by convention.
- `decideDeferredTombstones(jobs, writeFailedIdentitiesThisCall)` is the ONE place every deferred decision
  is made, used by both `clearMergeQuarantineByToken`'s own end-of-call loop and
  `clearTokenFromPendingIndicesTestOnly` (which used to hand-copy the same loop).

### The empirical finding: both rulings are independently redundant for THIS reproduced shape

Verified by temporarily neutering each fix in isolation and re-running the full scenario corpus (reverted
after each check; `git diff` confirmed byte-identical):

- Ruling 1 alone disabled (the unlink-failure fold reverted, ruling 2 intact): Scenario P7 (below) still
  passes — `decideDeferredTombstones`'s own fresh disk re-scan independently catches it, since a full lift
  always deletes its own basename from live tracking regardless of whether the physical unlink succeeded.
- Ruling 2 alone disabled (the decide-time re-derivation reverted to a no-op, ruling 1 intact): P7 still
  passes — the unlink failure still reaches the PRE-EXISTING, round-2/3 `writeFailedIdentitiesThisCall`
  set via ruling 1's fold, and EVERY job already ANDs against that set at decide time.
- BOTH rulings disabled together: exactly P7's own three "THE FIX"/"NEVER FAIL-OPEN" assertions go RED
  (171 → 168 PASS), and nothing else regresses — a clean, surgical proof that P7 depends on "ruling 1 OR
  ruling 2," never on one specifically. The Lead's own "do ALL" instruction was correct caution, not
  redundant busywork: either fix alone closes this exact reproduced shape, which is why no single-mutant
  test can cleanly attribute the fix to one ruling over the other — only the combined mutant discriminates.
- The pre-existing round-3 mutant (`decideDeferredTombstones` ignoring `writeFailedIdentitiesThisCall`
  entirely) still turns the SAME 24 checks RED across the SAME scenario families (B, M1, M7, M8, P1a,
  P1b, M8B, P3, P4, P5, P6) as documented above — unaffected by the refactor, and P7 is NOT among them
  (consistent with the previous bullet: P7 does not depend on the set alone).

### Verification (4th fix round)

New Scenario P7 in `packages/daemon/test/merge-quarantine-d2592cd5-reboot-between-clears.mjs`, modelled
directly on the reviewer's own scratch probe (not committed): W active, holding `[s]` alone, full lift; a
non-twin pending P, same identity, also holding `[s]` alone, its own job pushed in the pre-pass; W's own
final unlink faulted (EPERM). Negative-controlled (`node packages/daemon/scripts/negative-control.mjs
--file packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-d2592cd5-
reboot-between-clears.mjs --ref fef745b0`): P7's own assertions RED against `fef745b0` (the branch tip
carrying the 3rd fix round but not this one), GREEN restored, working tree confirmed byte-identical.

Full `merge-quarantine-d2592cd5-reboot-between-clears.mjs` (171/171) and
`merge-quarantine-3d4467cf-full-lift-stray-reblock.mjs` (55/55) both green after the fix.

### What this round did NOT fix — named explicitly, not silently dropped

- **Two OTHER sites with the same class of swallow, found while auditing "the other delete/sweep sites in
  the token path" per the Lead's own instruction, neither fixed in this round:**
  `sweepTmpResidueForHashIfUnreferenced`'s own same-hash loop (merge-quarantine.ts ~:6568-6572) silently
  discards a non-ENOENT unlink failure for a tmp residue that was never already `keptUnreadableLatchFiles`-
  marked — strictly WORSE than the fixed site (it doesn't even set `anyUnattributed`, let alone a
  write-failure signal). `orphanLatchFileSweepDecision`'s own bare `unlinkLatchFile(filename)` call (its
  "safe to delete" branch) similarly never surfaces an unlink failure. Both are structurally the same
  pattern this round closed at `deleteMergeQuarantineLatchByKey`, but neither is exercised by this round's
  own reproduced CRITICAL (which is specific to a full-lift's own `final`), and fixing them correctly
  needs its own investigation of each function's own surrounding invariants — flagged for a follow-up
  card, not fixed here. **Since closed by card `59f4ebe8`** — see `59f4ebe8-surface-swallowed-sweep-unlink-failures.md`.
- **`clearTokenFromPendingIndices`'s own "remove" branch fix (`removeWriteFailed`, ruling 1's second
  required site) is pinned by scenario P8 (reboot-between-clears test) — a triple-masked, so triple-redundant, pin.** Its own `plan.ownedArmedKeys` loop
  (where the fix lives) is only ever non-empty for a pending entry whose `armedKeys` are STILL "owned" per
  `entryStillOwnsKey` — which, for a purely pending-only entry, requires either the exact same object also
  being live in `activeQuarantines` (a genuine dual-tracked twin — which is structurally EXCLUDED from
  ever reaching `clearTokenFromPendingIndices` at all, since `clearMergeQuarantineByToken`'s own
  `activeMatches`-based filter routes it to `clearActiveEntryTokenAtKey`/`clearMergeQuarantineByKey`
  instead) or the established "key-drift" shape (a DIFFERENT, subset-token object currently occupying
  that key under the same identity). P8 builds the latter (pending P names Kw; a different subset-token Q occupies it) and forces an EPERM unlink on Kw's final. THREE independent masks withhold the durable tombstone there: `removeWriteFailed`, `decideDeferredTombstones`'s decide-time rescan, and the remove branch's push-time `nonFailureOk` (computed after the in-memory delete, so it already sees the surviving final). Only ALL THREE off flips P8 (two assertions); with `removeWriteFailed` alone back on and the other two still off, P8 stays green. So P8 pins the observable never-tombstone contract, NOT `removeWriteFailed` in isolation. The remove branch also folds an unattributed `kept` from its own sourceFile sweep into `removeWriteFailed`.
  (RED/GREEN evidence: the mutant table in the round-4 report; not restated here); the fix also did not regress the existing
  171+55 passing checks.
