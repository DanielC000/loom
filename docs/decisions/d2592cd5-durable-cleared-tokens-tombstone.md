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
by this card for exactly this reason). Every one of boot's three raw-token-read sites (PASS 1's primary
`.json` parse, PASS 1b's `.tmp-` recovery, the safety-tmp recovery) routes its freshly-parsed token array
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
unconditional second call) deliberately do NOT durably tombstone

Both sites call only `tombstoneIfNotSurviving` (in-memory), never `tombstoneDurablyIfConfirmed`. This is
a DELIBERATE choice for this round, not an oversight needing a matching fix:

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

## Do not

- Do not move the tombstone sidecar back inside `MERGE_QUARANTINE_DIR` — a test or production sweep that
  diffs that directory's own raw listing would start seeing it as "whatever just changed" there; this is
  not a hypothetical, it is the exact regression this card's own first draft caused and reverted.
- Do not gate the durable tombstone write on the generic in-memory `tombstoneIfNotSurviving` call's own
  firing — that call also fires when the underlying write FAILED, by design. Gate on the SPECIFIC call
  site's own already-tracked write-success signal instead (mutant 2 above proves why).
- Do not widen `filterBootTombstonedTokens`'s call sites beyond the three raw-token-read sites named in
  §C — it must run BEFORE a live entry is constructed from parsed JSON, never after.
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
- Do not add a `tombstoneDurablyIfConfirmed` call to either of the two full-lift branches named above
  without first adding the write/sweep-failure tracking they currently lack — see "The two full-lift
  branches" section for why leaving them in-memory-only is safe as-is, not a gap to close reflexively.
