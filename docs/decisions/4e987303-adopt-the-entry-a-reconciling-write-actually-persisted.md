# 4e987303 — adopt the entry a reconciling latch write actually persisted

Confirmed by `84c1046f`'s Code Review (session `690b1e0d`) with a hermetic probe; pre-existing on main.

## The class

In `packages/daemon/src/git/merge-quarantine.ts`, a caller re-points memory to its own `updated`/`entry`
object via `replaceEntryEverywhere` BEFORE calling `writeMergeQuarantineLatch(..., reconciledAlready:false)`.
That write's internal `reconcileMarkedBasenameBeforeWrite` can reingest the genuine on-disk record for a
`keptUnreadableLatchFiles`-marked basename (or, in its generic branch, resurrect tokens/keys from a
genuinely older on-disk record) and persist a DIFFERENT entry — but, pre-fix, the chokepoint returned only
a `boolean`, so the caller never saw that reconciled object and kept enforcing the stale pre-reconcile one.
The successful rename clears the mark, so the NEXT plain write (any ordinary later operation) durably
overwrites the just-recovered genuine record with the stale object — permanent data loss, never a fail-open
(enforcement itself never lapses; only the IDENTITY/token the record carries is lost).

## Per-caller table (re-enumerated on `main`, HEAD `87a41247`, before this card's own fix)

All 12 `writeMergeQuarantineLatch` call sites:

| site | shape | gap? |
|---|---|---|
| `consumeMatchedPendingsIntoArmedEntry` (×2) | pre-folds via `foldInOnDiskTokensIfMarked`, adopts (`armed = folded`), passes `reconciledAlready:true` | no |
| `enterMergeQuarantine` "brand-new" branch | same pre-fold/adopt/`true` shape | no |
| `bootWriteLatch` | externally folds, re-points `byRepoKey`, passes `reconciledAlready:true` only when it actually folded | no |
| `enterMergeQuarantine` "existing" branch, PRIMARY key | pre-folded above, `reconciledAlready: isPrimaryKey` = `true` | no |
| `enterMergeQuarantine` "existing" branch, SECONDARY key(s) | SAME call, `reconciledAlready: isPrimaryKey` = `false` for a secondary key — found during the investigate-first checkpoint, not one of the card's own six named callers | **YES (7th gap)** |
| `clearTokenFromPendingIndices`, armed-key loop | `replaceEntryEverywhere` before the loop, `reconciledAlready:false`, boolean result discarded | **YES** |
| `clearActiveEntryTokenAtKey`, armed-key loop | same shape | **YES** |
| `clearMergeQuarantineByKey`'s pending "reduce" branch, tied-twin armed-key loop | same shape | **YES** |
| `reduceForeignUnionContributor` | same shape — the card's own probed case | **YES** |
| `markIdentityAsReducedOnForeignKey` | same shape, PLUS its own rollback-to-original-`entry` on write failure | **YES** |
| `quarantineAllRegisteredFailClosed` (boot fail-closed-on-unlistable-directory) | fresh placeholder `entry`, `activeQuarantines.set`, boolean result discarded, `out.push(entry)` (never the adopted result) | **YES** |

Every "YES" site shares the identical defect: it points its ownership map at a locally-built object
BEFORE the write, then ignores whatever `writeMergeQuarantineLatch`'s own internal reconcile actually
persisted when `!reconciledAlready` and the target basename was marked.

## The fix — chokepoint, not caller-by-caller

`writeMergeQuarantineLatch`'s return type changed from `boolean` to `MergeQuarantineEntry | false` — it
now returns the entry it ACTUALLY wrote (`entry` unchanged on the ordinary path, or the internally-
reconciled object; `false`, byte-identical failure semantics, on any failure). **The type change alone is
not enough** — `!result` still compiles and is `false` for any truthy object, so a caller that kept its old
boolean-check shape would silently keep discarding the reconciled entry with no compile error. The actual
fix is structural: a single new function, `writeLatchAndAdopt(ownershipMap, current, droppedTokens,
sweepOtherTmpsOnSuccess, targetKey, skipDegradedOccupantGuard, reconciledAlready)`, is now the ONE
permitted call site for `writeMergeQuarantineLatch` — it calls the chokepoint and, on success, re-points
every in-memory reference (`replaceEntryEverywhere`) to the returned entry when it diverged from `current`,
returning the now-active entry (or `false`). Every one of the 12 call sites — including the four that were
already correct — now routes through this helper. Enforced by
`merge-quarantine-writelatch-chokepoint-guard.mjs`, a static TS-AST source-text scan asserting every
`writeMergeQuarantineLatch` identifier reference in the whole file lives inside `writeLatchAndAdopt`'s own
body (comment-stripped first, with a positive control proving the scan can actually detect an injected
aliased reference). Not a member of `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` — it is shape (2) from that list's
own doc comment (a TS-compiler AST-narrowed extraction anchored on a real declared name, immune to a
comment-only diff), the same posture `merge-quarantine-boot-write-chokepoint-guard.mjs` already has.

## Per-armed-key loops thread the adopted entry forward

Six of the seven gaps are per-armed-key write LOOPS (`enterMergeQuarantine`'s secondary keys,
`clearTokenFromPendingIndices`, `clearActiveEntryTokenAtKey`, the `clearMergeQuarantineByKey` reduce
branch, `reduceForeignUnionContributor`, `markIdentityAsReducedOnForeignKey`). Each now reassigns its local
`updated`/`entry` variable to whatever `writeLatchAndAdopt` returns, so a LATER key's own write (and any
reference-equality re-check against the ownership map, e.g. `activeQuarantines.get(k) !== updated`) sees
the adopted object, never a captured-before-the-loop stale local. `bootWriteLatch` (the boot-time twin —
see its own section below) and its 9 call sites get the identical treatment.

## ⛔ CORRECTED (round 2, Code Review `d74446b3`, MAJOR) — the "entry-level" claim below was FALSE

The original text of this section claimed every field a reconcile can recover is an ENTRY-LEVEL concept,
safe to generalize across a whole dual-armed entry's every key. **That claim was false for the REINGEST
branch's own four extra fields** (`contributorRepoPaths`/`reducedContributorRepoPaths`/`orphanLatchFiles`/
`genuineContributorKeys`) — the reingest branch reads them from `latchEntryFromParsedRecord(parsed)`, i.e.
from THAT ONE KEY'S OWN PHYSICAL FILE, not from anything entry-wide. The GENERIC (non-reingest) branch —
reached by a SECOND marked key once the FIRST key's own reingest has already promoted the entry out of
placeholder shape — used to carry forward only `tokens`/`resolvedKeys`/identity, silently dropping these
four FILE-SCOPED fields from memory and, on the very next write, from BOTH physical files.

**Reproduced by the reviewer's own direct probe**: a placeholder Y armed at k1+k2, BOTH keys marked, each
with a DIFFERENT genuine on-disk record (k1 carrying `contributorRepoPaths:[c1]`/`orphanLatchFiles:[o1]`,
k2 carrying a DIFFERENT `[c2]`/`[o2]`). A fresh raise's per-armed-key loop processes k1 first (pre-folded,
reconciledAlready:true — the reingest branch fires, promoting the entry past placeholder shape) then k2
(reconciledAlready:false — the now-non-placeholder entry takes the GENERIC branch) — k2 lost `c2`/`o2`
on commit `a9e1673a` (this card's own first round) and kept them one commit earlier. Confirmed RED on
`a9e1673a` via `scripts/negative-control.mjs`, GREEN after this round's fix.

**Fix:** the generic branch now carries forward `orphanLatchFiles`/`contributorRepoPaths`/
`reducedContributorRepoPaths` (both-sides union, `undefined` when both sides are empty, never `[]`),
`provenanceUnknown`/`provenanceTracked` (OR), and `genuineContributorKeys` (the SAME
`unionGenuineContributorKeysAbsorbing` rule the reingest branch already uses) — reading each field off the
raw `parsed` JSON the same way `latchEntryFromParsedRecord` does, since the generic branch deliberately
never calls that helper (it would also adopt disk's `branch`/`reason`/`tokens` wholesale, which this branch
must not do — see 702b4241's own rule that only a genuinely OLDER on-disk identity may win there).

**THE TRUE INVARIANT** (replacing the false one above): a reconcile recovers fields that are entry-level
IN INTENT (the logical quarantine's own accumulated contributor/orphan/provenance history) but
FILE-SCOPED IN SOURCE (each key's own physical file can independently carry a different slice of that
history) — so EVERY marked key's own write, reingest OR generic branch alike, must union its own file's
contribution into the in-memory entry; dropping either branch's own union reopens this exact class.

**Accepted direction (Lead ruling):** stamping k1's own `c1` onto k2's physical file (and vice versa) is
the fail-CLOSED OVER-BLOCK direction — a clear-by-id later refuses on a broader-than-strictly-necessary
union, never destroys data. This is acceptable; narrowing it back to per-key-exact unions is out of scope.

**This does NOT retroactively re-write an EARLIER key in the loop** that already wrote its own (then-
correct, now-incomplete) union before a LATER key's own reconcile discovered more to add — in the CR's own
probe, k1 (written FIRST) ends up with only `c1` on disk; k2 (written SECOND, with the full accumulated
union) ends up with both `c1` and `c2`. That asymmetry is the same accepted, self-healing shape `702b4241`
already describes for a marked-then-recovered basename (a later write or boot folds it back in) — re-
writing earlier keys retroactively was considered and rejected as scope creep beyond this card's own
defect (memory never matching what the LATEST write durably persisted), which the fix above fully closes.

## `bootWriteLatch` (boot-time twin) — same return-type fix, threaded through its own 9 call sites

`bootWriteLatch` (a closure inside `reenterMergeQuarantinesAtBootImpl`) already routed through
`writeLatchAndAdopt` internally, but its OWN return type stayed `boolean` — so every ONE of its 9 call
sites still risked the identical class, one level up: a caller that reused its own pre-write local after a
successful write (for a further write, or by storing it for a LATER phase to read) would persist/arm the
stale object. Fixed: `bootWriteLatch` now returns `MergeQuarantineEntry | false` too, and every call site
threads the result forward. Two sites carried a REAL, reachable instance of this (not just a consistency
nit): the matched-corrupt-tmp site (re-writes `armed`/`folded` after an unlink failure) and the
safety-tmp-recovery site (same shape, `unionEntry`/`folded`) — both mirror the already-fixed runtime
corrupt-tmp shape exactly. A THIRD, more subtle instance: PHASE 1a's own `writeOutcomesByKey` map stored
the PRE-write `unionEntry` alongside its `succeeded` flag, read back much later by PHASE 3's own delete
pass — a stale stored value there re-persists over whatever PHASE 1a's own write actually reconciled,
even though nothing in PHASE 1a itself reused the value immediately. Fixed by storing the adopted entry
in the map instead. The remaining call sites (torn-write recovery promote; both orphan-reference branches)
have no reachable reuse of their own local after a successful write today, but are threaded through
identically for consistency and because a future edit adding reuse there would otherwise silently reopen
this exact class with no compiler signal (same reasoning as the structural-guard section below).

## Known residual (round 2 CR, item 3) — `markIdentityAsReducedOnForeignKey`'s own rollback

`markIdentityAsReducedOnForeignKey` loops over several owned keys; if an EARLIER key's write succeeds and
adopts a reconciled entry, then a LATER key's write fails, the function rolls back ALL the way to the
ORIGINAL, pre-loop `entry` — discarding whatever the earlier key's own successful, adopted write already
recovered (and already durably persisted to that earlier key's own physical file). This is a KNOWN,
ACCEPTED residual of the SAME class this card fixes, deliberately NOT changed here: the function's own
rollback-on-partial-failure contract predates this card and changing it is a separate, larger decision
(what should "partial success, then a later failure" mean for this caller) that the Lead is carding
separately — see that card for the eventual resolution. Pinned by code reading only: a cheap test could
assert the loop runs a SECOND iteration after a successful first one (two owned keys, the first marked
and genuinely reconcilable, the second forced to fail its write) and that the end state matches the
PRE-adoption original — but no such test is added here, since this round's own scope is CLOSING gaps in
this class, not changing a pre-existing, independently-carded rollback contract.

## Round 3 (Code Review `b1c952bf`, SHIP WITH FOLLOW-UP) — round 2's own fix caused two fail-closed resurrections

Round 2's cross-key both-sides union (the correction above) introduced a NEW class of bug: it unions a
field forward from disk without ever checking whether the CALLER itself had just explicitly REMOVED that
exact value from `entry` a moment earlier. Two real, reachable resurrections, both direct CR probes:

- **M1 (orphanLatchFiles)**: `consumeMatchedPendingsIntoArmedEntry` strips every matched pending entry's
  own `sourceFile` from the armed entry's `orphanLatchFiles` (`be79f4d5`) before writing — the physical
  file is about to be deleted via `deleteSourceLatchIfSuperseded`. If the marked key's own disk record
  ALREADY (independently) lists that same sourceFile, round 2's union re-added it, and the delete then ran
  anyway — leaving a PERMANENT, DANGLING self-reference to a file that no longer exists. The two boot-time
  siblings of this same strip-then-write shape (PASS1-migrate's own read loop, and the safety-tmp-recovery
  read loop) have the identical gap, one level up (`bootWriteLatch` itself never had a drop parameter at
  all).
- **M2 (contributorRepoPaths)**: `reduceForeignUnionContributor` removes a contributor from
  `contributorRepoPaths` before writing. If the marked key's own disk record already lists that same
  contributor, round 2's union re-added it — `contributorRepoPaths` and `reducedContributorRepoPaths` end
  up listing the SAME identity at once, so the human's first `/clear` of that contributor silently does
  not stick.

### The fix — `dropped: DroppedSets`, threaded exactly like `dropped.tokens` already was

A new `DroppedSets` type (`{tokens, orphanLatchFiles, contributorRepoPaths}`, all `ReadonlySet<string>`)
replaces the old bare `droppedTokens: ReadonlySet<string>` parameter on `reconcileMarkedBasenameBeforeWrite`,
`foldInOnDiskTokensIfMarked`, `writeMergeQuarantineLatch`, and `writeLatchAndAdopt` — all REQUIRED, same
posture `2dd97aaa`/`58957b1e` already established for `droppedTokens`, and `f575cebf` for `ownershipMap`:
a caller cannot forget to pass one, it must name every drop set every time. `bootWriteLatch` (the boot-
time closure, which never had a drop parameter before this round) now takes `dropped: DroppedSets` too —
its own two read-loop strip sites (PASS1-migrate, safety-tmp-recovery) needed it just as much as the
runtime callers. `NO_DROPS` is a single shared instance for "nothing was removed" (not actually frozen —
every reader only ever calls `.has()` on it, never a mutator, so nothing needed enforcing), used at every
call site that drops nothing (most of them) rather than allocating three empty `Set`s per call.

**Both branches of `reconcileMarkedBasenameBeforeWrite`** (reingest and generic) now subtract
`dropped.orphanLatchFiles`/`dropped.contributorRepoPaths` AFTER their respective both-sides unions —
mirroring exactly how `dropped.tokens` is filtered after the token union, in both branches, since
`2dd97aaa`. `undefined` (never `[]`) when the filtered result is empty, matching every other union site's
own convention in this module.

### Per-caller table — what each caller drops (round 3)

| caller | drops | why |
|---|---|---|
| `consumeMatchedPendingsIntoArmedEntry` (both writes) | `orphanLatchFiles = sourceFiles` (the matched pending entries' own sourceFiles, already stripped at `be79f4d5`) | M1's own fix |
| `enterMergeQuarantine` existing/brand-new branches | nothing (`NO_DROPS`) | a raise only ever appends |
| `clearTokenFromPendingIndices` | `tokens = [token]` | the cleared token |
| `clearActiveEntryTokenAtKey` | `tokens = [token]` | the cleared token |
| `clearMergeQuarantineByKey` reduce branch | `tokens = entry!.tokens` (the full overlap set being lifted from this twin) | the lifted tokens |
| `reduceForeignUnionContributor` | `contributorRepoPaths = {identity}` (the normalized `directPathIdentity`, compared by identity at every subtract site — round 4 correction, see below) | M2's own fix |
| `markIdentityAsReducedOnForeignKey` | nothing (`NO_DROPS`) | only ever ADDS to `reducedContributorRepoPaths`, never touches `contributorRepoPaths` |
| `quarantineAllRegisteredFailClosed` | nothing (`NO_DROPS`) | a brand-new placeholder, nothing to drop |
| `bootWriteLatch`'s own matched-corrupt-tmp / torn-write-promote / orphan-reference call sites | nothing (`NO_DROPS`) | each only ever ADDS |
| `bootWriteLatch`'s own PASS1-migrate PHASE 1a call | `orphanLatchFiles = sources` (every file migrated to this key, already stripped at `a6fa60e2`) | M1's boot-time twin |
| `bootWriteLatch`'s own safety-tmp-recovery call | `orphanLatchFiles = [f]` (the one file being recovered, already stripped at `fd189d91`) | M1's second boot-time twin |

### `contributorRepoPaths` subtraction compares by `directPathIdentity` (round 4 correction)

**Round 3's own original design — subtract by RAW string equality, matching the plain string-`Set` union
every other site for this field already uses — was WRONG, reviewer-probed.** `contributorRepoPaths`
stores RAW repoPath strings (never normalized identities, per `84c1046f`'s own note), and disk can spell
the SAME identity differently than the in-memory caller's own removal did — a case difference, or `/` vs
`\` — while `reduceForeignUnionContributor` itself always removes by `directPathIdentity`
(`remainingContributors = entry.contributorRepoPaths.filter(c => directPathIdentity(c) !== identity)`).
A raw-string drop set built from the REMOVED strings only ever matches that ONE spelling — disk's own
differently-spelled copy of the same identity survives the union untouched, and the human's first
`/clear` of that contributor does not stick for that spelling. Reproduced directly by the reviewer's own
probe script (a case/slash variant of the disk-side contributor path).

**Fix:** `DroppedSets.contributorRepoPaths` now holds normalized `directPathIdentity` VALUES, never raw
repoPath strings — `reduceForeignUnionContributor` passes `new Set([identity])` directly (its own
parameter, already normalized — no separate "capture what was removed" computation is needed), and both
branches of `reconcileMarkedBasenameBeforeWrite` subtract via `!dropped.contributorRepoPaths.has(directPathIdentity(c))`
instead of a bare `.has(c)`. `tokens`/`orphanLatchFiles` are UNCHANGED — RAW strings, plain `Set.has` —
tokens are process-unique `randomUUID`s with no spelling-variant question, and orphan names are physical
filenames (a filename has exactly one spelling by construction; there is no "identity" to normalize to).

### Why NOT subtract the whole sticky `reducedContributorRepoPaths` set (the question this round asked)

The obvious-looking alternative — "subtract everything in `reducedContributorRepoPaths` from
`contributorRepoPaths` after every union, unconditionally" — is REJECTED. Code Review `690b1e0d` on
`84c1046f` already warned against exactly this: `reducedContributorRepoPaths` is DELIBERATELY sticky (it
never shrinks — see that field's own doc comment), so an unconditional subtract would also strip a
GENUINE re-raise of a previously-reduced identity (a real, independent raise of `dSub` after an earlier
`/clear(dSub)` reduced it out) the moment any later write touches this key — `contributorRepoPaths` would
never again be able to hold an identity once it has EVER been reduced, even if that identity genuinely
re-contributes later. The fix instead subtracts only THIS call's own one-time removal (`identity`) —
explicit removal — never the accumulated sticky history. `dropped` is scoped to a single write, by
construction, so this distinction falls out naturally rather than needing a special case.

## Round 3, m2 — the torn-write promote site now threads its result for real

`bootWriteLatch(key, armedForWrite)`'s own return was discarded (a bare truthy check) at the torn-write
recovery promote site — `armedForWrite` was only ever read for `.repoPath` afterward (which never changes
across a reconcile), so this was never a reachable bug, but it was the one remaining site in the whole
file that still looked like the pre-fix discard pattern. Threaded for real (the local is now `let`,
reassigned from the write's own return) for consistency, so no future edit near it can copy the discard
shape believing it's an established, safe pattern.

## Round 3, m3 — PHASE 3 reads `byRepoKey` LIVE, never a PHASE-1a-stored snapshot

PHASE 3 (migrate-pass deletes) used to destructure `{unionEntry, succeeded}` from `writeOutcomesByKey`'s
own stored snapshot — taken once, during PHASE 1a. Between PHASE 1a and PHASE 3, several OTHER boot
passes (PHASE 1b's degraded-occupied fold, the torn-write promote, the matched-corrupt-tmp site) can all
still `replaceEntryEverywhere` this SAME key's entry, making the stored snapshot stale relative to what is
actually in `byRepoKey` by the time PHASE 3 runs. Fixed: PHASE 3 now reads `byRepoKey.get(key)` live, and
`writeOutcomesByKey`'s own value type was simplified to `{succeeded: boolean}` alone (the `unionEntry`
field it used to carry became genuinely dead data once PHASE 3 stopped reading it — removed rather than
left unused). **If the live entry is absent** (defensive — every key here was armed into `byRepoKey`
during PASS 1, and nothing in this function ever deletes a `byRepoKey` slot outright, only replaces it, so
this should be unreachable) — PHASE 3 logs loudly and leaves every one of that key's migrate `sources` AS
WRITTEN, the same fail-closed "cannot proceed safely, so don't guess" posture every other such branch in
this function already takes, rather than attempting to rebuild a plausible entry from nothing.

## Structural enforcement correction (round 2 CR, item 1) — the type change alone was insufficient

The original version of this record claimed changing `writeMergeQuarantineLatch`'s return type to
`MergeQuarantineEntry | false` was itself what made ignoring the adopted entry hard. **False**: `!result`
still compiles cleanly against that union type (it is simply `false` for any truthy object), so a caller
that kept its OLD boolean-check shape (`if (!writeMergeQuarantineLatch(...))`) would silently keep
discarding the reconciled entry with no compile error at all. The actual enforcement is, and always was
meant to be, STRUCTURAL: `merge-quarantine-writelatch-chokepoint-guard.mjs` is a static TS-AST scan
asserting every `writeMergeQuarantineLatch` identifier reference in the whole file lives inside
`writeLatchAndAdopt`'s own body — now ALSO asserting (with its own positive control) that
`writeMergeQuarantineLatch`'s own declaration carries no `export` modifier, closing the one remaining way
a future module could import and call it directly, bypassing the in-file scan entirely.

## Failure-path semantics — unchanged

`writeLatchAndAdopt` never rolls anything back on failure — memory is left exactly as the caller already
applied it, matching every pre-fix caller's own failure-path behavior (the in-memory quarantine still takes
effect for THIS process regardless of durable write success — `writeMergeQuarantineLatch`'s own doc).
`markIdentityAsReducedOnForeignKey` is the one caller with its own rollback-to-the-ORIGINAL-`entry`
contract on failure; its loop still rolls back correctly under the new shape (from whatever `updated`
currently is — possibly already adopted from an earlier key in the same loop — back to the untouched
original `entry`), since the rollback call references the ORIGINAL binding, not the loop's own local.

## Ordering hazard — none

`writeMergeQuarantineLatch` is fully synchronous (`fs.openSync`/`writeSync`/`fsyncSync`/`closeSync`/
`renameSync`, never `await`, not `async`) — the whole reconcile-then-persist-then-rename sequence runs
atomically within one JS turn. Adopting the returned entry AFTER the call (rather than only applying the
pre-write local BEFORE it, as before) opens no concurrent-in-process-reader window: nothing else can run
between the pre-write apply and the post-write adopt in a single-threaded event loop with no yield point in
between.

## 84c1046f's own "(s2 precondition)" note

`merge-quarantine-84c1046f-reingest-field-drop.mjs`'s scenario 2 carried a note: "the in-memory
`activeQuarantines` entry stays the pre-reconcile placeholder here — a separately-carded, pre-existing gap
in `reduceForeignUnionContributor` itself, not asserted either way by this test." That gap is THIS card.
The note is now stale (memory DOES match disk after this fix) — see that test file's own updated comment.

## Tests

`merge-quarantine-4e987303-writelatch-adopt.mjs` — four scenarios: (1) the card's own probed case
(`reduceForeignUnionContributor`, the reingest branch, followed by a plain second raise — proves the
durable loss end to end, matching the card's own CONSEQUENCE section); (2) the token-clear route
(`clearActiveEntryTokenAtKey`, the GENERIC non-reingest branch — a genuinely older on-disk record carries
an extra outstanding token the in-memory copy never saw); (3) the secondary-armed-key route (the 7th gap —
a dual-armed entry whose SECONDARY key's own basename is marked, reached through `enterMergeQuarantine`'s
real "existing" branch); (4) **round 2's own CR MAJOR** — the reviewer's 2-marked-key probe (placeholder Y
armed at k1+k2, BOTH marked, DIFFERENT genuine disk records at each) through the SAME real
`enterMergeQuarantine` "existing" branch, asserting BOTH keys' own `contributorRepoPaths`/
`orphanLatchFiles` survive in memory, plus the accepted k1-vs-k2 on-disk asymmetry (k1 written first,
never retroactively updated; k2 written second, carries the full union).

RED/GREEN proven via `scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts
--test packages/daemon/test/merge-quarantine-4e987303-writelatch-adopt.mjs --ref <sha>`: round 1 (`--ref
HEAD` before any commit existed) failed 7 of the file's checks across scenarios 1-3; round 2 (`--ref
a9e1673a`, this card's own first submitted commit) failed 3 of scenario 4's own checks, reproducing the
CR's exact finding (k2's own `contributorRepoPaths`/`orphanLatchFiles` durably dropped); GREEN (restored)
passed all 4 scenarios both times; tree confirmed byte-identical after both runs.
`merge-quarantine-writelatch-chokepoint-guard.mjs` (the structural guard) passes, including its own two
positive controls (the aliased-reference scan, and — round 2's own addition — the no-`export` check).

**Round 3** added scenarios 5 (M1) and 6 (M2), each run as a MARKED/UNMARKED pair (the UNMARKED half is
the discriminating control — the chokepoint's own internal reconcile never fires at all when the
basename isn't marked, so the bug class is structurally unreachable there regardless of fix state).
Scenario 5 graduates a pending entry (sourceFile `S`) into a marked key whose own genuine disk record
already lists `S` in its own `orphanLatchFiles`, asserts `S` is gone from memory AND the durable on-disk
JSON, then writes an unrelated genuine latch directly at `S`'s own freed physical name and confirms
`clearMergeQuarantineLatchFile` against it never mentions the original repo and that repo's own
quarantine is completely unaffected. Scenario 6 drives `reduceForeignUnionContributor` through the real
`clearMergeQuarantine(dId)` entry point (`makeRepoWithTwoSubdirs`'s ancestor-walk-collision construction —
a first attempt using two independent, unrelated directories never even reached `reduceForeignUnionContributor`
at all, confirmed directly by a `wasQuarantined:false` result, before `dId` was given a canonical key
collision with Y's own) against a marked key whose own genuine disk record already lists the same
contributor, and asserts the contributor is gone from `contributorRepoPaths` — in memory AND on disk —
after exactly ONE `/clear` call.

RED proven again via the same negative-control script, `--ref 428c698f` (this card's own round-2
commit): exactly the 4 MARKED-variant checks (2 for M1, 2 for M2) failed; both UNMARKED controls stayed
GREEN even at that ref, confirming the bug is genuinely gated on the basename being marked, not a
construction artifact. GREEN restored; tree byte-identical.

## Do not

- Do not call `writeMergeQuarantineLatch` directly from a new caller — route through `writeLatchAndAdopt`;
  enforced by `merge-quarantine-writelatch-chokepoint-guard.mjs` (its own export-modifier check closes the
  one way a direct caller could otherwise bypass the in-file scan).
- Do not add a per-armed-key write loop that keeps writing a captured-before-the-loop local — thread the
  value `writeLatchAndAdopt` (or `bootWriteLatch`, its boot-time twin) returns forward into the next
  iteration, same as every loop this card fixed, including a map stored for a LATER phase to read back
  (`writeOutcomesByKey`'s own gap) — not just an immediately-reused local.
- Do not assume the GENERIC (non-reingest) branch of `reconcileMarkedBasenameBeforeWrite` is safe to
  reach mid-loop without its own both-sides union of `contributorRepoPaths`/`reducedContributorRepoPaths`/
  `orphanLatchFiles`/`provenanceUnknown`/`provenanceTracked`/`genuineContributorKeys` — round 1 of this
  card shipped exactly that assumption as a FALSE "entry-level" claim; see the correction section above
  for the real invariant and the reviewer's own 2-marked-key probe that disproved it.
- Do not retroactively re-write an earlier key in a loop just because a later key's own reconcile
  diverged from it — that is accepted, self-healing cross-key divergence (`702b4241`'s own shape), not a
  gap this card leaves open; re-writing earlier keys is scope creep, not a fix. (Confirmed asymmetric on
  purpose: in the CR's own probe, k1 — written first — ends up narrower than k2 — written second.)
- Do not read `writeLatchAndAdopt`'s `false` return as license to roll memory back — it never does; a
  caller that wants rollback-on-failure (only `markIdentityAsReducedOnForeignKey` does) implements that
  itself, against the entry it still holds from before the call. Do not assume that rollback is itself
  complete, either — see the "Known residual" section above for the partial-success-then-later-failure
  gap it still has, tracked on a separate card.
- Do not trust a return-TYPE change alone as the enforcement mechanism for "every caller must adopt the
  result" — `!result` compiles fine against `T | false` for any truthy `T`, so a caller that kept its old
  boolean-check shape would silently keep discarding the entry with no compiler error. The enforcement is
  the STRUCTURAL guard (`merge-quarantine-writelatch-chokepoint-guard.mjs`), not the type.
- Do not add `merge-quarantine-writelatch-chokepoint-guard.mjs` to `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` —
  it is shape (2) in that list's own doc comment (AST-narrowed on a real declared name), immune to a
  comment-only diff by construction.
- Do not union a field forward from disk in either branch of `reconcileMarkedBasenameBeforeWrite` without
  also subtracting `dropped`'s own matching set AFTER the union — round 2's own both-sides union, with no
  subtract, is exactly the M1/M2 class round 3 closes. Every NEW field this function ever learns to carry
  forward needs the same pairing from day one, not as a follow-up once a real resurrection is found.
- Do not subtract the WHOLE sticky `reducedContributorRepoPaths` set from `contributorRepoPaths` as a
  shortcut for `dropped.contributorRepoPaths` — `690b1e0d`'s own warning on `84c1046f` applies here too: a
  genuine re-raise of a previously-reduced identity would then never be able to re-enter
  `contributorRepoPaths` again. Subtract only the ONE call's own explicit removal.
- Do not add a new caller of `reconcileMarkedBasenameBeforeWrite`/`foldInOnDiskTokensIfMarked`/
  `writeMergeQuarantineLatch`/`writeLatchAndAdopt`/`bootWriteLatch` without an explicit `dropped: DroppedSets`
  argument — all five are REQUIRED params, same posture as `droppedTokens`/`ownershipMap` before them, so
  there is no silent default left to inherit. Use `NO_DROPS` for "nothing removed," never a freshly
  allocated `{tokens:new Set(), ...}` literal.
- Do not compare `contributorRepoPaths` membership by RAW string equality when building or consuming a
  drop set for it — round 3 shipped exactly that and a reviewer probed a case/slash disk-spelling variant
  through it (round 4). Compare by `directPathIdentity` instead, at every subtract site; `tokens`/
  `orphanLatchFiles` stay raw-string (see `DroppedSets`'s own doc comment for why the two fields differ).
