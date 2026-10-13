# 63e49ee2 — a read failure of a foreign occupant's latch file must be UNKNOWN, never "nothing to protect"

Blocker #2 from Code Review `66eab845` of `4900c365` — split out because it is pre-existing, not a
regression. `4900c365`'s own record names this exact gap in its "Known gap tracked separately — read-side
errors" section: a non-ENOENT read error (EACCES, EMFILE on a busy daemon, POSIX mode-000 in a writable
dir, where unlink needs no read access) was treated identically to a genuinely missing/corrupt file —
"nothing to protect" — letting the caller's own unconditional unlink/sweep destroy a foreign occupant's
only durable copy as collateral, lost for good after a reboot: fail-OPEN.

## The bug

Four read sites shared this defect, all in `packages/daemon/src/git/merge-quarantine.ts`:

- `differentUnresolvableOccupantRepoPathAt` (the write-side/clear-side identity detector)
- `unincorporatedOccupantRepoPathAt` (the clear-side token-overlap detector)
- `protectOccupantContentBeforeDelete`'s own read (the shared protect-and-persist tail both detectors'
  wrappers funnel into)
- `protectForeignTmpResidueBeforeSweep`'s own read of a `.json.tmp-<pid>` residue

Each did `try { ... } catch { return <nothing-to-protect> }` with no inspection of the error at all. The
reviewer's `tp-readfail`/`fp-readfail` probes (an injected `fs.readFileSync` EACCES on the foreign file
during a clear) confirmed: the file is deleted, and after a reboot the occupant is gone.

## The fix

A new tri-state `OccupantReadResult` (`{state:"occupant", repoPath} | {state:"none"} | {state:"unknown"}`)
replaces the old `string | undefined` contract on both detectors. `"none"` is reserved for a PROVEN
absence — ENOENT, or genuinely corrupt/invalid JSON (unparsable, or missing/wrong-typed required fields)
— exactly the pre-existing non-read-error branches, unchanged. Every OTHER read error is `"unknown"`.

Every caller treats `"unknown"` exactly like a confirmed occupant for the purpose of never
deleting/overwriting:

- `wouldOverwriteDifferentUnresolvableOccupant` (write-side guard) refuses the write on `"unknown"`, same
  as on a confirmed occupant.
- `protectDegradedOccupantBeforeDelete` / `protectUnincorporatedOccupantBeforeDelete` return `false`
  (their existing "keep `final`, do not unlink" contract — see `4900c365`) directly on `"unknown"`,
  **without** calling `protectOccupantContentBeforeDelete` — there is no `occupantRepoPath` to pass it.
- `protectOccupantContentBeforeDelete`'s own read ALSO distinguishes ENOENT (`true`, unchanged) from
  every other error (`false` — the caller already holds a confirmed `occupantRepoPath`, but there is no
  parsed content left to copy aside or self-own from).
- `protectForeignTmpResidueBeforeSweep` has no boolean its own caller already checks — its caller
  (`deleteMergeQuarantineLatchByKey`) runs an UNCONDITIONAL, separate `sweepTmpResidueForHashIfUnreferenced`
  call right after, by filename, with no idea a read ever happened. So it now returns a `Set<string>` of
  filenames whose read failed for an unknown reason, and `sweepTmpResidueForHashIfUnreferenced` takes an
  optional `excludeFilenames` param to skip exactly those names.

## Why the tmp-residue case needed a DIFFERENT shape than `4900c365` round 2's self-own

`4900c365` round 2's own "Do not" explicitly forbids re-adding an exclude-set/filtered-sweep mechanism to
`sweepTmpResidueForHashIfUnreferenced`/`protectForeignTmpResidueBeforeSweep` — its stated reason: the
self-owned pending record (via `orphanLatchFiles`) already makes every reference-aware sweep in this
module honour a failed protect's kept file, from any call path, so a second, parallel mechanism would
only rot independently. That reasoning is premised on self-own being AVAILABLE, which requires PARSED
CONTENT (a `repoPath`/`branch`/`reason`/`tokens` to build a `MergeQuarantineEntry` from). A READ failure
has no content at all — the read never got far enough to parse anything — so there is nothing to
self-own from, and excluding the filename from the one unconditional sweep that would otherwise destroy
it is the only protection left. This is a genuinely different case from the one `4900c365`'s "Do not"
describes, not a revival of it.

## Known, accepted residual — in-process enforcement is NOT restored when every read fails

Unlike `4900c365`'s own write-failure fix (which has successfully-read content to self-own a fresh
in-memory pending record from), a read failure means there is no content anywhere to self-own FROM.
`clearMergeQuarantineByKey`'s own `keysToLift`/`activeQuarantines.delete` already runs, unconditionally,
BEFORE any protect call — so the occupant's in-memory record is already gone by the time a protect call
could even attempt to re-establish it, and with no parsed content there is nothing to rebuild it from.

Measured directly (`merge-quarantine-protect-read-failure.mjs`, both the final-path and tmp-path
scenarios, with every read of the foreign file injected to fail): the occupant's file survives on disk
byte-for-byte, and a later reboot fully recovers it (both in-memory and `assertRepoNotQuarantined`) — but
`assertRepoNotQuarantined` is genuinely **not** blocked in-process between the failed clear and that
reboot. This matches `4900c365`'s own anticipation verbatim: "the read-side failure happens before any
content is even parsed, so there is nothing yet to protect-write in the first place."

A structurally different mechanism — e.g. threading the caller's own already-in-memory `clearedEntry`
through as a content fallback when the disk read fails — was considered and deliberately NOT attempted
here: `clearedEntry` is not reliably a trustworthy stand-in for "whatever is physically at `final`" in
every call shape this module handles (that is exactly the question `unincorporatedOccupantRepoPathAt`
itself exists to verify, not assume), and this module has already absorbed many multi-round Code Review
corrections for exactly this kind of subtle, call-shape-dependent assumption. Tracked here as an accepted
residual, not fixed; a future fix for it should not assume this card's read ever produces parsed content
to self-own from — it does not, by construction.

## Round 2 (Code Review `91b49a21`) — B1: the kept file was OWNERLESS; B2: a second, independent read

Round 1's fix only made the ONE call site that actually saw the read failure skip its own unlink/sweep.
Nothing in memory ever REFERENCED the kept file — and every OTHER reference-aware sweep in this module
(`sweepOrphanLatchFileIfUnreferenced`, `sweepTmpResidueForHashIfUnreferenced`, `writeMergeQuarantineLatch`'s
`sweepOtherTmpsOnSuccess`, `clearMergeQuarantineByToken`'s partial-clear sweep) only ever checks
`orphanLatchFiles` membership — it has no way to know "some OTHER call site already decided this file is
safe to keep." The round-1 `Set<string>` exclude-set covered exactly one of those sweep call sites
(`deleteMergeQuarantineLatchByKey`'s own); every other call path destroyed the file regardless, the
instant it ran. Four concrete repros, each measured to destroy D's own token via a DIFFERENT such call
path: **fp:clearid**/**tp:clearid** (`clearMergeQuarantineLatchFile(<Kr hash>)`, reached via the "no entry
matches this id" raw fallback's own `sweepOrphanLatchFileIfUnreferenced`/`sweepTmpResidueForHashIfUnreferenced`
calls), **tp:reraise2** (a second `enterMergeQuarantine(r)` call's own `sweepOtherTmpsOnSuccess`), and
**tp:partial** (`clearMergeQuarantineByToken`'s own partial-clear sweep).

**B2**: `protectForeignTmpResidueBeforeSweep`'s own successful read determines the occupant's identity,
then hands off to `protectOccupantContentBeforeDelete`, which independently RE-READS the same path to get
parsed content. If THAT second, independent read fails, the function correctly returned `false` — but
every caller in the `protectForeignTmpResidueBeforeSweep` loop IGNORED that return value entirely, so
nothing kept the file from the very next unconditional sweep.

### The fix — a reference-only ownership anchor

`pushUnknownReadOwnershipStub(basename, candidateIdentity)` pushes a content-less, fail-closed PENDING
record that self-references the kept file's own basename via `orphanLatchFiles` — a pure ownership
anchor, never a content stand-in (this does not reopen the "Do not" below rejecting `clearedEntry` as a
CONTENT source for the kept file's own fields; this anchor carries no such fields at all). Every
reference-aware sweep in this module already checks `orphanLatchFiles` membership unconditionally, so
this one mechanism — called from every "unknown" branch (both detectors' wrappers, `protectOccupantContentBeforeDelete`'s
own read, and `protectForeignTmpResidueBeforeSweep`'s own read) — closes all four B1 repros and B2 at
once, with no per-call-site plumbing. The round-1 exclude-set (`protectForeignTmpResidueBeforeSweep`
returning a `Set<string>`, `sweepTmpResidueForHashIfUnreferenced`'s `excludeFilenames` param) is removed;
`sweepTmpResidueForHashIfUnreferenced` is back to its pre-round-1, single-argument signature.

### The anchor's identity: a measured deviation from the review's own suggestion

The review suggested using "`clearedEntry`'s identity... or the clearing context's identity" as the
stub's placeholder. Measured directly (`fp:clearid`, reverting only this specific choice): using the
CLEARER's own identity (almost always currently RESOLVABLE — e.g. `R` in every fixture) is unsafe. The
very next ordinary query of that same identity — `clearMergeQuarantineReporting`'s own routine post-clear
`resolveQuarantineFor` check — runs `activeMergeQuarantineFor`'s lazy-graduation path, which matches the
stub by DIRECT IDENTITY (tier 1) and, finding it now resolvable, GRADUATES it into `activeQuarantines` as
if it were that identity's own genuine, newly-resolved raise. Once that happens, a wholly ordinary LATER
clear of that SAME identity (e.g. `clearMergeQuarantineLatchFile` resolving to the now-active entry)
legitimately sweeps away "its own" pending leftovers via `clearMergeQuarantineByKey`'s own
identity-matched pending-filter — destroying the real kept file as collateral. This is EXACTLY the
`fp:clearid` failure mode, confirmed via direct instrumentation (an `fs.unlinkSync` stack trace) before
settling on the fix below.

**The fix**: `pushUnknownReadOwnershipStub` uses `candidateIdentity` verbatim ONLY when it is currently
`isRepoPathCurrentlyResolvable`-false (almost always the real foreign occupant, e.g. `D` — which never
graduates this way, since `activeMergeQuarantineFor` only ever graduates a RESOLVABLE `repoPath`, so using
it is both safe and genuinely accurate, not merely a placeholder). A RESOLVABLE candidate instead gets a
synthetic identity, `path.join(MERGE_QUARANTINE_DIR, "unknown-occupant", basename)` — guaranteed never
itself resolvable (nothing is ever written at that subpath), so it can never graduate and can never be
confused with any real registered repo's own identity. This sacrifices the "over-broad in-process
blocking of the clearer" bonus the review's own suggestion would have given a resolvable candidate, but
the alternative is provably unsafe in the review's own named repro.

### Known, accepted residual — UNCHANGED by round 2

The "Known, accepted residual" section above still holds exactly as written for the base final-path/
tmp-path scenarios (no follow-up operation): `protectDegradedOccupantBeforeDelete`'s own stub push runs
BEFORE `protectUnincorporatedOccupantBeforeDelete`'s in `deleteMergeQuarantineLatchByKey`, and
`pushUnknownReadOwnershipStub`'s own "already owned" check means whichever push runs FIRST wins — in
every fixture here, that is the clearer's own (synthetic, unresolvable-by-design) anchor, not the real
occupant's own real identity. So `assertRepoNotQuarantined(d)` in the base scenario is still genuinely NOT
blocked in-process; round 2 fixes DURABILITY across every sweep call path, not in-process answerability
for a query naming the real occupant by its own identity.

## Round 3 (Manager ruling, Code Review `5d01bfbf`) — the stub itself was the bug

Round 2's own fix (`pushUnknownReadOwnershipStub`) closed B1/B2/M3 of its own CR round, but CR round
`5d01bfbf` found the fix unsafe in a DIFFERENT way: pushing a REAL, content-less entry into
`pendingUnresolvedQuarantines` means the entry is IDENTITY-MATCHABLE, and any identity-based clear/list/
raise code path can pick it up and destroy the very file it existed to protect.

- **B1 (Critical, regressed from round 1):** `differentUnresolvableOccupantRepoPathAt`'s own caller
  (`protectDegradedOccupantBeforeDelete`) and `unincorporatedOccupantRepoPathAt`'s own caller
  (`protectUnincorporatedOccupantBeforeDelete`) both pass the **identity being cleared** as the stub's
  candidate — and when that identity is itself unresolvable (the ordinary case for a degraded occupant
  being cleared directly, never via its enclosing resolvable repo), round 2's own "use verbatim when
  unresolvable" rule pushes a stub sharing THAT SAME identity. `clearMergeQuarantineByRecordedPath`'s own
  identity-matched pending sweep, running in the SAME call that just pushed the stub, then finds and
  sweeps the stub's own `orphanLatchFiles` — destroying an unrelated sibling's kept file as collateral.
  Measured directly (`round3-b1` in the test below): real repo R; D=R/gone-subdir; E=R/other-gone; D's own
  content at `final` (genuinely armed via `resolvedKey`), E's content in a `.tmp-998` residue sharing the
  same walked-up key. Injecting a read failure on E's tmp residue, then `clearMergeQuarantine(d)` (clearing
  D itself, not R) destroyed E's tmp residue in the SAME call, before this round's fix.
- **B2 (Major):** the stub is not merely in-memory bookkeeping — it is identity-matchable by
  `enterMergeQuarantine`'s own pending-merge branch too. In the pre-existing B2 fixture (D's content only
  in a tmp residue; `protectForeignTmpResidueBeforeSweep`'s own first read succeeds, learning D's real,
  unresolvable identity; `protectOccupantContentBeforeDelete`'s own second, independent read of the
  identical path fails), the stub is pushed using D's OWN identity verbatim (unresolvable). A subsequent
  `enterMergeQuarantine(d, "REAL-BRANCH", "REAL REASON")` then identity-matches that stub via
  `mergeTokenIntoPendingEntries`, writing `pending-<hash(d)>.json` with the stub's own `branch: ""` and
  anchor `reason` — D's real branch/reason are lost, plus a phantom token folded in alongside the fresh one.
- **M3 (Major):** the synthetic-identity stub (for a RESOLVABLE candidate) is a genuine
  `MergeQuarantineEntry` under `path.join(MERGE_QUARANTINE_DIR, "unknown-occupant", basename)` — it
  appears in `listActiveMergeQuarantines()`/the REST list with that decoy `repoPath`, and clearing it by id
  or by that path unlinks the kept file exactly like a real entry's clear would.

### The fix — an identity-less `Set<string>`, never a pending entry

`keptUnreadableLatchFiles` (a module-level `Set<string>` of basenames) replaces `pushUnknownReadOwnershipStub`
entirely. On an "unknown" read result, the basename is added to the set — no `MergeQuarantineEntry` is
minted, nothing is pushed to `pendingUnresolvedQuarantines` or `activeQuarantines`, and nothing is written
to disk. Every reference-aware sweep/unlink site in the module (`sweepOrphanLatchFileIfUnreferenced`,
`sweepOwnLatchFileUnlessOwnedElsewhere`, `sweepTmpResidueForHashIfUnreferenced`,
`protectForeignTmpResidueBeforeSweep`'s own `alreadyOwned` check, and — defensively —
`deleteSourceLatchIfSuperseded`) now checks this set directly, in addition to its existing
`orphanLatchFiles`/`physicalOwnerRepoPaths` checks. `deleteMergeQuarantineLatchByKey`'s own final unlink
needed no change: it was already gated on the `boolean` return of `protectDegradedOccupantBeforeDelete`/
`protectUnincorporatedOccupantBeforeDelete`, which still return `false` on "unknown" — only what those
functions do internally on that branch changed. Because nothing in the set carries an identity, B1/B2/M3
are closed structurally: there is nothing for an identity-based clear, raise, or list to match.

A basename is removed from the set the moment ANY later read of that exact path succeeds (every one of
the four read sites clears it right after a successful `readFileSync`) — so a transient failure never
pins a file as unreadable forever, matching the mechanism's own process-local, reboot-clears-it lifecycle.

### Known, accepted residual — UNCHANGED by round 3

The "Known, accepted residual" sections above (round 1's base scenarios; round 2's "UNCHANGED by round 2"
note) still hold exactly as written: a read failure never has parsed content to self-own FROM, so
`assertRepoNotQuarantined(d)` is still genuinely NOT blocked in-process right after a failed clear — only
a full reboot (or a later successful read somewhere in the chain) re-establishes in-process answerability
for the real occupant's own identity. Round 3 changes WHICH mechanism durably keeps the file (an
identity-less set instead of an identity-matchable stub); it does not change this residual at all.

## Round 4 (Code Review `e0bdf111` of `387450e3`) — the set un-keeping itself was the bug

CR `e0bdf111` found round 3's own fix unsafe in a THIRD way: every one of the four read sites called
`keptUnreadableLatchFiles.delete(path.basename(final))` on a SUCCESSFUL read — but `deleteMergeQuarantineLatchByKey`
reads `final` up to three times within ONE clear (`protectDegradedOccupantBeforeDelete`, the
`foreignPending`-gated `protectOccupantContentBeforeDelete`, and `protectUnincorporatedOccupantBeforeDelete`),
for genuinely different purposes. If the FIRST read fails (marking the basename kept) and a LATER read of
the SAME path within that SAME clear succeeds (`unincorporatedOccupantRepoPathAt` reaching `"none"`
because the identity equals `clearedEntry` — an entirely unrelated, correct outcome for THAT caller), the
successful read's own `.delete()` erased the keep-mark the failed read had just set. The file then
survived ONLY through the first call's own returned `boolean` — a wholly separate, LATER operation (e.g.
a `clearMergeQuarantineLatchFile` fallback sweep) found nothing in the set and deleted it. Measured
directly (`round4-b1`): a transient failure on the FIRST read of `final` within `clearMergeQuarantineReporting`,
then `clearMergeQuarantineLatchFile(<hash>)` reported `wasQuarantined:false` and deleted the file.

### The fix — grow-only within a process

Manager ruling: `keptUnreadableLatchFiles` is **GROW-ONLY within a process** — every `.delete()` call
removed. This is fail-closed and over-broad (a transiently unreadable file stays marked kept until the
next reboot), matching this card's own accepted residual exactly.

### A second gap, found by the manager's own requested lifecycle test

Removing `.delete()` alone closes `round4-b1` (both reads happen within ONE `deleteMergeQuarantineLatchByKey`
call, whose own `finalProtectOk` boolean already correctly captured the first, failing protect call's
`false` — nothing un-sets it back regardless of what a later call inside the SAME invocation returns). But
the manager's own requested "lifecycle" test (a transient failure, then an ORDINARY, fully-successful
clear of the SAME repo, then a clear-by-id) exposed a DIFFERENT, pre-existing hole:
`deleteMergeQuarantineLatchByKey`'s own unconditional `fs.unlinkSync(final)` is gated PURELY on
`finalProtectOk`, which starts `true` and is only ever narrowed by a protect call that actually RAN
(gated on `clearingRepoPath`/`clearedEntry` being truthy). Once the FIRST clear evicts the key's in-memory
record (the accepted residual: `activeQuarantines.delete(k)` runs unconditionally, before any protect
call), a SECOND, wholly ordinary clear of the same key passes BOTH params as falsy — so NEITHER protect
function ever runs, `finalProtectOk` stays its default `true`, and the file is deleted with the set
never even consulted.

**The fix:** track `anyProtectRan` across all three protect call sites inside `deleteMergeQuarantineLatchByKey`;
fall back to `keptUnreadableLatchFiles.has(path.basename(final))` ONLY when NONE of them ran this call.

**A first attempt at this fix was wrong and is worth recording.** Initializing `finalProtectOk` itself
from `!keptUnreadableLatchFiles.has(...)` (rather than gating the fallback on `anyProtectRan`) seemed
equivalent but was not: once a basename is marked kept, that initial `false` poisons the whole
boolean-AND chain for the REST OF THE PROCESS, even on a call where a protect function DOES run and
returns a fresh, honestly-verified `true` ("none" — nothing foreign here right now). This broke
`merge-quarantine-boot-hardening.mjs`'s own pre-existing WRITE-FAILURE-RESIDUE scenario: it deliberately
creates a DIRECTORY at a latch path to force a rename failure, and reading a directory throws `EISDIR` —
which this card's own tri-state classifier treats as `"unknown"` (keep it) exactly like `EACCES`, marking
the basename kept. The scenario later removes the directory and legitimately reuses the SAME hash for a
real quarantine, clear, and reboot-recovery sequence — and the poisoned-upfront version permanently
refused to delete that hash's file for the rest of the process, even once a fresh, successful read
genuinely confirmed nothing foreign was there. The `anyProtectRan`-gated version only falls back to the
stale mark when there is NO fresh information at all this call, never overriding a fresh, successful
re-verification — which is both the correct safety story and what makes `merge-quarantine-boot-hardening.mjs`
pass again.

### Tests

`round4-b1` (the review's own repro: fail only the FIRST read of `final` within one clear, letting a LATER
read within that SAME clear succeed; the file must survive both the original clear AND a subsequent
clear-by-id, and across a reboot) and `round4-lifecycle` (a transient failure, then a second, wholly
ORDINARY clear of the SAME repo with no injection at all — exercising the `anyProtectRan` gap directly —
then a clear-by-id; the file must survive every step, and across a reboot).

## Round 5 (Code Review `b1d4614c` of `68558fb4`) — `anyProtectRan` reopened the blocker ACROSS calls

CR `b1d4614c` found round 4's own `anyProtectRan` fix unsafe in a FOURTH way: a detector's `"none"`
(same identity) is only a sound reason to allow deletion when the in-memory record genuinely reflects
what is on disk — and after a read-failure eviction, it can stop reflecting it. The in-memory record can
be REBUILT from a wholly DIFFERENT raise generation (its own write never durably landing) while `final`'s
own on-disk bytes still carry an OLDER generation's tokens. `unincorporatedOccupantRepoPathAt`'s own
same-identity check (comparing `repoPath` strings) cannot tell these apart — "same identity" is not "same
content". Measured directly (`round5-b2`): real R; D=R/gone-subdir; `final`={D,[D-TOK],`resolvedKey:Kr`};
boot. Fail only the first read of `final` (EACCES); `clearMergeQuarantineReporting(R)` — `final` kept and
marked, D's in-memory record evicted. `mkdirSync(D)` — D now resolves, and
`canonicalRepoLockKey(D) === Kr`. Fail `fs.renameSync(*, final)` with EIO; `t2 = enterMergeQuarantine(D,
...)` — D is armed IN-MEMORY ONLY at `Kr` with `[t2]`; `final` still physically holds `[D-TOK]`.
`clearMergeQuarantineByToken(D, t2)` → `deleteMergeQuarantineLatchByKey(Kr, undefined, D'sEntry, D)` —
`unincorporatedOccupantRepoPathAt` reads `final` fresh, finds `D === D`, returns `"none"` — under round
4's `anyProtectRan` gate this `true` overrode the kept mark entirely, and `final` (still carrying D-TOK)
was unlinked. Reboot: D-TOK is LOST. The same repro with no read-failure injection at step 2 (the
control) keeps D-TOK, confirming the bug is specific to the read-failure/keep-set path, not the scenario
shape itself.

### The fix — unconditional, with two narrow, durable-write-only exceptions

Manager ruling: `anyProtectRan` is REMOVED entirely. `deleteMergeQuarantineLatchByKey` now checks
`keptUnreadableLatchFiles.has(path.basename(final))` UNCONDITIONALLY, AFTER every protect call this
invocation ran — a marked basename is ALWAYS kept; no detector result, "none" or otherwise, ever
overrides it. Two, and only two, additional sites may clear a mark, both tied to a genuine DURABLE WRITE,
never a read:

1. **Overwrite-by-rename** — right after `fs.renameSync(tmp, final)` succeeds in `writeMergeQuarantineLatch`
   and in `writePendingDivertFile`: the rename just durably replaced that EXACT basename's bytes with
   KNOWN, fresh content, so any earlier read-failure mark on it no longer describes current reality.
2. **Durable copy-aside (the Refinement)** — inside `protectOccupantContentBeforeDelete`'s own SUCCESS
   path (right after its `writePendingDivertFile` call for `final`'s own content succeeds): the content
   has just been durably preserved elsewhere, so `final`'s own basename-mark may be cleared, letting the
   SAME call's own (or a later call's) removal of `final` proceed without leaving a duplicate.

Both are safe for the identical reason the un-keep in round 4 was NOT: each is gated on a WRITE that just
durably happened in THIS process, never on a READ (which proves nothing about whether the content was
ever protected) and never on an identity comparison against possibly-stale disk bytes.

A notable, deliberate side effect: a marked basename whose content later turns out to be CORRUPT
(unparsable JSON — ordinarily classified `"none"`, nothing to protect, safe to delete) is now STILL kept
until reboot, since corruption alone is neither a durable overwrite-by-rename nor a copy-aside. This is
STRICTER (more fail-closed) than pre-round-5 behavior, deliberately: a marked basename's own prior
read-failure history is never erased by merely discovering it looks corrupt NOW — the file could still be
mid-write, or the corruption itself transient — so round 5 keeps it rather than risk destroying content
that was marked unreadable for a real reason.

### Tests

- **`round5-b2`** (the review's own repro, "bug" and "control" variants): fail only the first read of
  `final`; clear R; then a DIFFERENT raise generation of D (same identity, its own durable write injected
  to fail via EIO on rename) is cleared by its OWN fresh token. Asserts `final` survives that clear and a
  reboot. The "control" variant (no read injection at step 1) confirms the pre-existing content-based
  mechanism already handles this shape correctly, isolating the bug to the read-failure/keep-set path.
- **`round5-copy-aside`**: reaches `deleteMergeQuarantineLatchByKey`'s own `foreignPending` branch
  directly — step 1 marks `final` kept via a transient read failure; step 2 manufactures a WRITE failure
  (every `fs.openSync` call) during a fresh raise of R, so D's content self-owns at `sourceFile ===
  finalBasename` (the pre-existing `4900c365` mechanism) WITHOUT overwriting `final`'s own bytes, leaving
  BOTH the keep-set mark AND a `foreignPending`-shaped record true at once; step 3 clears R's own
  in-memory-only entry with no injection — `foreignPending` finds D's self-owned record, copies it aside
  successfully, and `final` is **literally unlinked in that same call**, with exactly one surviving copy
  of D's content (no duplicate).
- **`round5-rename-unmarks`**: marks `final` kept via a transient read failure, then D (now resolvable)
  re-raises ITSELF (same identity, "none", no copy-aside needed) and its own write succeeds this time —
  a LATER, wholly ordinary clear of D's own fresh entry must then actually unlink the file. This is a
  MECHANISM check only (proving the rename cleared the keep-set's mark rather than leaving it stuck
  forever) — **it does NOT certify this fixture's own outcome as fully correct; see the KNOWN GAP
  immediately below**, folded into card `8db913e2` rather than fixed here.

⚠️ **KNOWN GAP (Code Review `fe4bb9ef`) — a pre-existing, RAISE-SIDE token loss, out of this card's own
scope.** On `round5-rename-unmarks`'s own fixture, D's same-identity re-raise OVERWRITES `final` without
UNIONING the ORIGINAL token that was already outstanding there (`d-token-round5-rename-unmarks`) — that
token is lost the instant the re-raise's own write succeeds (BEFORE the test's own clear even runs), and
does not survive a reboot either. Verified directly: a clean rebuild of this exact repro, with no clear
at all, shows the original token already absent from `final`'s own content and from
`listActiveMergeQuarantines()` after a fresh boot. This is a defect in `enterMergeQuarantine`'s own
brand-new-arm branch (it never reads/unions `final`'s own prior content before writing over it) — NOT
something round 5 introduces, fixes, or is scoped to fix; round 5 governs the keep-SET's own mark only,
never token union on a raise. Do not read `round5-rename-unmarks`'s own passing unlink assertion as proof
this token-loss shape is safe or intended — it is neither; it is tracked, and will be fixed, under card
`8db913e2`.

⚠️ **Scope of what each test actually discriminates — read before trusting a RED/GREEN claim for this
round.** Only `round5-b2` goes RED against round 4's own code (`68558fb4`, with `anyProtectRan`) — proven
via `scripts/negative-control.mjs`, run together with `merge-quarantine-boot-hardening.mjs` as a dedicated
non-regression check (it passed clean on BOTH sides, confirming it was never contaminated by either
phase), restored byte-identical after. `round5-copy-aside` and `round5-rename-unmarks` do **NOT**
discriminate against round 4's code as a whole — round 4's own `anyProtectRan` happens to produce the
SAME visible outcome in both of those exact scenarios (for the wrong reason: it ignores the keep-set
entirely whenever any protect call ran at all, which happens to include these two cases). Each was instead
proven RED/GREEN by a DIRECT, LOCAL ablation of its own specific `.delete()` line (commented out, rebuilt,
confirmed that EXACT test's own assertions fail for the EXACT reason named, restored, rebuilt, confirmed
green again) — never trust either of their own named assertions as evidence against round 4 specifically;
only `round5-b2` is that evidence. All `merge-quarantine*.mjs` files (32 total) re-verified individually,
each exit 0. All static guards (`pnpm --filter @loom/daemon guards`) re-verified green.

## Tests

`packages/daemon/test/merge-quarantine-protect-read-failure.mjs` (a sibling of
`merge-quarantine-protect-write-failure.mjs`) — `fs.readFileSync` intercepted for the EXACT foreign path
to throw `EACCES`, mirroring that file's own `fs.openSync`-based write-failure injection technique:

- **final-path**: the `4900c365`-style R/D fixture (D's content directly at `final`, genuinely ARMED via
  an explicit `resolvedKey`). Asserts the file survives a read failure, survives a reboot, and is
  correctly re-blocked after that reboot — plus an explicit, labeled "accepted residual" assertion that
  it is NOT blocked in-process immediately after the failed clear.
- **tmp-path**: the `d2582692` R/D fixture (D's content only in a `.tmp-999` residue). Same assertions,
  reaching `protectForeignTmpResidueBeforeSweep`'s own read instead.
- Each scenario has its own positive control (clean, non-injected run — unchanged behavior, including
  in-process blocking, which a successful read still achieves) and the final-path scenario adds an
  explicit ENOENT control (clearing a repo with nothing armed at its key proceeds exactly as before).
- **Round 2**: `fp:clearid`/`tp:clearid` (both a "p" persistent-injection and a "t" transient-injection
  variant), `tp:reraise2` (both variants), `tp:partial`, and the B2 second-independent-read case — each
  using a new `injectReadFailureFromNth(path, n)` helper (fails only from the Nth read of `path` onward,
  letting B2 pin the SECOND read specifically while the first succeeds). Every round-2 assertion checks
  D's own real TOKEN surviving a reboot directly (`listActiveMergeQuarantines().flatMap(tokens)`), never
  `assertRepoNotQuarantined(d)` — that query can read as "blocked" merely because an UNRELATED entry (R's
  own, or the synthetic anchor) happens to answer for D's own key too, which proves nothing about whether
  D's own real token specifically survived.
- **Round 3**: `round3-b1` (clearing D itself, not R — the `clearMergeQuarantine(d)` → `clearMergeQuarantineByRecordedPath`
  path — with a sibling E's tmp residue's read injected to fail in the SAME call; asserts E's token
  survives in-process and across a reboot), `round3-b2` (the pre-existing B2 fixture's own failed clear,
  followed by `enterMergeQuarantine(d, "REAL-BRANCH", "REAL REASON")`; asserts D ends up with exactly one
  entry, its real branch/reason, and no phantom token), and `M3` (asserts no listed entry's `repoPath`
  ever names the old `unknown-occupant` decoy path, and that no such subdirectory was ever created).
- **Round 4**: `round4-b1` and `round4-lifecycle` — see the "Round 4" section's own "Tests" subsection
  above for both fixtures.
- **Round 5**: `round5-b2`, `round5-copy-aside`, `round5-rename-unmarks` — see the "Round 5" section's own
  "Tests" subsection above, INCLUDING its own scoped note on which of the three actually discriminates
  against round 4's code (only `round5-b2` does — the other two were proven by direct, local ablation).

Proven RED on pre-fix code and GREEN after via `scripts/negative-control.mjs` (tree restored
byte-identical) — round 1's own scenarios RED against round 1's code (pre-this-card) and GREEN after;
round 2's eight new scenarios RED against round 1's CODE (committed, pre-round-2) and GREEN after round
2's fix; round 3's six new assertions (round3-b1 ×3, round3-b2 ×3 — the other three round3-b2 assertions
already passed under round 2's own synthetic-placeholder path and so are not discriminating for this
round) RED against round 2's CODE (committed, pre-round-3, i.e. HEAD) and GREEN after round 3's fix;
round 4's five new assertions (round4-b1 ×2, round4-lifecycle ×3) RED against round 3's CODE (committed,
pre-round-4, i.e. HEAD) and GREEN after round 4's fix, confirmed via a `negative-control.mjs` run
reverting only `merge-quarantine.ts`, run ALONGSIDE `merge-quarantine-boot-hardening.mjs` as a dedicated
no-regression check (its own WRITE-FAILURE-RESIDUE scenario — see the "Round 4" section above for why —
passed clean on BOTH sides, never contaminated by either phase); round 5's TWO new `round5-b2` assertions
RED against round 4's CODE (committed, pre-round-5, i.e. HEAD) and GREEN after round 5's fix, same
negative-control setup, `merge-quarantine-boot-hardening.mjs` again passing clean on both sides — see the
"Round 5" section above for why `round5-copy-aside`/`round5-rename-unmarks` are proven by local ablation
instead, not by this same negative-control run. All `merge-quarantine*.mjs` files (32 total) re-verified
individually, each exit 0. All static guards (`pnpm --filter @loom/daemon guards`) re-verified green.

## Do not

- Do not treat `"unknown"` as `"none"` anywhere in this chain — a read failure other than ENOENT (or
  genuinely corrupt/invalid JSON) may still be a real foreign occupant's only durable copy; the read
  simply could not confirm it right now.
- **(Round 1, SUPERSEDED BY ROUND 2, SUPERSEDED AGAIN BY ROUND 3)** The original text of this bullet said
  never to re-add any content-dependent self-own to the `"unknown"` branches, since "the only available
  protection is to keep the file, unmodified, on disk." Round 2 found that insufficient and added
  `pushUnknownReadOwnershipStub`, a REFERENCE-ONLY anchor. Round 3 found THAT unsafe in turn (see the
  "Round 3" section above) and replaced it with `keptUnreadableLatchFiles`, an identity-less `Set<string>`.
  Do not read any of this as license to add a content-dependent fold back — there still is no parsed
  content on an `"unknown"` outcome — and do not re-add an identity-bearing anchor of any kind (a
  pending/active entry, however content-less) — see the Round 3 section for why that specific shape is
  the defect, not merely an implementation detail.
- **(Round 1, SUPERSEDED BY ROUND 2)** The original text of this bullet warned never to confuse
  `protectForeignTmpResidueBeforeSweep`'s `Set<string>` return with `4900c365` round 1's own exclude-set.
  Round 2 removed that `Set<string>` return entirely (replaced by `pushUnknownReadOwnershipStub`, itself
  later replaced by round 3's `keptUnreadableLatchFiles`) — so there is no longer anything to confuse it
  with. Do not re-add an exclude-set/filtered-sweep PARAMETER to `sweepTmpResidueForHashIfUnreferenced` (or
  an equivalent `Set<string>` RETURN to `protectForeignTmpResidueBeforeSweep`) "to be safe" — a single,
  shared, identity-less ownership set already makes every reference-aware sweep in this module honour a
  read-failure-kept file, from any call path; a second, parallel exclude mechanism would only rot
  independently, exactly as `4900c365` round 2 already ruled for the write-failure case.
- Do not claim or assume "blocked in-process, by the real occupant's own identity" for a read-failure
  scenario where every read along the chain failed — see the "Known, accepted residual — UNCHANGED by
  round 3" section above. A full reboot (or at least one successful read somewhere in the chain) is the
  only guarantee this card's fix makes for in-process answerability of the REAL occupant's own identity.
- Do not route this fix's read-failure classification through `quarantineFileRepoPathIdentity` (the
  separate `final`-content-identity primitive used by `deleteMergeQuarantineLatchByKey`'s `foreignPending`
  check) — a read failure there already biases toward MORE protection (it reads as a confirmed mismatch,
  so the caller attempts `protectOccupantContentBeforeDelete` anyway, which applies this card's own fix),
  not less; changing it is unnecessary and was deliberately left alone.
- **(Round 2, SUPERSEDED BY ROUND 3 — `pushUnknownReadOwnershipStub` no longer exists)** Round 2 required
  never passing a RESOLVABLE candidate identity verbatim to that function, and never deriving its synthetic
  placeholder identity from anything that could itself resolve — both rules existed ONLY because that
  function minted an identity-bearing entry at all. Round 3 removed the function (and the synthetic
  placeholder with it); kept purely as the historical record of why "use the clearer's own identity
  verbatim" was tried and measured unsafe (the `fp:clearid` repro) before round 3's own, different fix.
- **(Round 3)** Do not give `keptUnreadableLatchFiles` (or its basenames) ANY identity of its own — no
  `repoPath`, no synthetic placeholder path, nothing a `directPathIdentity`/canonical-key compare could
  ever match. The instant it carries an identity, it is matchable by an ordinary clear/raise/list, which
  is the exact B1/B2/M3 shape this round closed. If a future change needs richer bookkeeping than a bare
  `Set<string>` membership check, re-derive the safety argument from scratch — do not assume adding a
  field "just for diagnostics" is free.
- **(Round 3)** Do not forget to check `keptUnreadableLatchFiles` at a NEW unlink/rename-over site added to
  this module in the future, the same way every existing sweep site in this file now does — grep for
  `fs.unlinkSync`/`fs.renameSync` in `merge-quarantine.ts` and confirm the new site either can't reach a
  kept-unreadable basename, or checks the set before deleting.
- **(Round 3)** Do not assert `assertRepoNotQuarantined(d)` as the discriminating check for "did D's
  quarantine survive" in a NEW test for this card — it can read `ok: false` merely because an unrelated
  entry (the clearer's own, or a sibling sharing D's key) happens to answer for D's own canonical key too,
  which proves nothing about whether D's own real token specifically survived. Assert on D's own token
  directly (`listActiveMergeQuarantines().flatMap(q => q.tokens ?? [])`), as every round-2/round-3
  scenario does.
- **(Round 4, SUPERSEDED — `keptUnreadableLatchFiles.delete(...)` no longer exists anywhere)** Round 3's
  own "remove the basename once a later successful read protects or consumes it normally" idea (stated in
  this card's own initial design, before round 4) is WRONG: a single clear reads `final` more than once
  for genuinely different purposes, and a LATER caller's successful read does not prove an EARLIER
  caller's failed read was ever actually protected. Do not re-add an in-process un-keep of ANY basename
  without a durable protect/ownership step tied to THAT specific removal — the set is grow-only within a
  process by design; only a reboot resets it.
- **(Round 4, SUPERSEDED BY ROUND 5 — `anyProtectRan` no longer exists)** Round 4's own fix gated
  `deleteMergeQuarantineLatchByKey`'s fallback check on `anyProtectRan` — consulting the set ONLY when
  none of the three protect calls ran this invocation. Round 5 found this unsafe (a detector's `"none"`
  for the SAME identity can still be wrong if disk and memory have diverged — see the "Round 5" section)
  and removed `anyProtectRan` entirely: the set is now checked UNCONDITIONALLY, after every protect call,
  with no override. Kept purely as the historical record of why "poison `finalProtectOk` up front" was
  tried and measured unsafe (the `merge-quarantine-boot-hardening.mjs` EISDIR regression) before landing
  on `anyProtectRan` — itself since superseded in turn.
- **(Round 5)** Do not override `deleteMergeQuarantineLatchByKey`'s unconditional keep-set check with
  ANY detector result — not `"none"`, not a same-identity match, not `anyProtectRan` (removed) or any
  lookalike. "Same identity" compares `repoPath` strings, never content generations; a marked basename's
  physical bytes can belong to an OLDER raise than whatever is currently in memory. Only a genuine durable
  WRITE — an overwrite-by-rename onto that EXACT basename, or a durable copy-aside of its content — may
  ever clear a mark; see the "Round 5" section's own two named call sites.
- **(Round 5)** Do not treat `EISDIR` (or any other non-ENOENT code) as proof of real, unreadable foreign
  content without checking whether this module's OWN tests manufacture that exact condition on purpose
  (e.g. a directory deliberately created at a latch path to force a rename failure) — this card's own
  classifier still treats `EISDIR` as `"unknown"`, by design (unchanged from round 1). Safety for that
  case now comes from the two durable-write-only unmark sites (overwrite-by-rename, durable copy-aside),
  never from a detector result or a call-shape heuristic like the retired `anyProtectRan`.
- **(Round 5)** Do not add a THIRD site that clears a basename's mark without re-deriving the safety
  argument from scratch — the only two that exist (`writeMergeQuarantineLatch`/`writePendingDivertFile`'s
  own rename success, `protectOccupantContentBeforeDelete`'s own copy-aside success) are each tied to a
  durable WRITE this process just performed, of KNOWN content, onto or in place of the EXACT basename
  being unmarked. A new site that reasons from a READ, an identity comparison, or a caller-shape signal
  (like `anyProtectRan`) reproduces this round's own defect under a new name.
