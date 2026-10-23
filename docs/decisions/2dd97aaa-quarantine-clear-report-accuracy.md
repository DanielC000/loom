# 2dd97aaa — merge-quarantine.ts: three clearMergeQuarantineByKey follow-ups

From re-review of card `702b4241` (gen 435, `21ec39e5` landed as `64162944`, `4913e721` landed as
`3b0b1da6`). Three separate findings against `clearMergeQuarantineByKey`'s own orphan/pending-reduce
machinery, worked one at a time per the card's own instruction.

## Item 1 — a content-keep must never name the identity being cleared as "another repo's claim"

`clearMergeQuarantineByKey`'s own orphan-file sweep (`sweepOrphanLatchFileIfUnreferenced`, called with
`excludeOwnIdentity` = the clearer's own identity) excluded the clearer's own identity ONLY from the
TRUE in-memory referencer scan (the `activeQuarantines`/`pendingUnresolvedQuarantines`/
`physicalOwnerRepoPaths` loops). When that scan found nothing — because the only in-memory referencer
WAS the identity being cleared, now excluded, or the entry's own slot was already removed before this
sweep ran — control fell through to `orphanSweepSafeToDelete`, which does a FRESH on-disk read of the
orphan file and derives `parsedRepoPath` straight from the file's own `repoPath` field, with ZERO
knowledge of `excludeIdentities`. A stale orphan file whose own on-disk content literally named the
SAME identity being cleared (a leftover copy of the clearer's own quarantine data, holding a token never
accounted for in this clear's `candidateTokens`/the global `clearedTokens` tombstone set) was then folded
into `contentKeptRepoPaths`, reporting the identity being cleared back to itself as "1 other repo's own
outstanding token" — a false human-facing message that could send a human to re-clear a ghost claim
against themselves.

Confirmed via a hermetic repro (own LOOM_HOME, real toplevel repo, built on
`merge-quarantine-orphan-sweep-content-aware.mjs`'s own scenario (H), with the planted orphan's
`repoPath` set to the clearer's own identity instead of a genuinely foreign one): `clearMergeQuarantine`
returned `latchKept:true`, `contentKeptRepoPaths` naming the clearer's own path, and a `reason` reading
"...holds 1 other repo's own outstanding token (<the clearer's own path>)..." — matching the card's own
quoted wording byte-for-byte.

**The card's own disjunct (b) ("or whose kept file no longer exists when the clear returns") was NOT
independently reproduced** — every construction attempted found `orphanSweepSafeToDelete` hitting ENOENT
(`safe:true`, no content-keep reported at all) the moment a file is genuinely gone by the time it would
be reported. This does not prove the shape is impossible (a tmp-residue race via a different call path
was not tried), only that it was not found. The fix below still covers it defensively, at no behavioral
cost, since the card asked for it explicitly.

### The fix

- `sweepOrphanLatchFileIfUnreferenced`: when `orphanSweepSafeToDelete`'s own `parsedRepoPath` shares
  `excludeIdentities`' identity, the content-keep is no longer named via `contentKeptRepoPath` — it falls
  through to the existing `anyUnattributed` branch instead (the file still genuinely stays kept on disk,
  fail-closed; only the MISATTRIBUTION is removed, never the safety).
- `clearMergeQuarantineByKey`: right before building its own return value (after every mutation/sweep,
  including the one `tombstoneIfNotSurviving` call), any `keptContentRepoPaths` entry whose own
  `sourceFile` no longer exists on disk is dropped — covers disjunct (b) defensively.

### Tests

`merge-quarantine-orphan-sweep-content-aware.mjs`, new scenario (P): plants an orphan file naming the
clearer's OWN identity, asserts `contentKeptRepoPaths` never names it, the file is still kept on disk
(fail-closed), and the clear reports `unattributed:true` instead of a false foreign claim. Proven
RED-before/GREEN-after via `packages/daemon/scripts/negative-control.mjs` (clean tree restore confirmed).

⚠️ **`negative-control.mjs` gotcha (worth recording, not specific to this fix):** do not pre-set
`LOOM_HOME` in the shell env before invoking `negative-control.mjs`. The test's own `useOwnLoomHome`
only mints a fresh temp home when `process.env.LOOM_HOME` is UNSET at process start — if the invoking
shell already exported one, BOTH the RED-phase and GREEN-phase child test runs inherit and reuse the
SAME directory, letting the RED run's broken-behavior residue leak into the GREEN run and produce a
false "GREEN phase did not pass" (reproduced directly: identical fix, identical test, `LOOM_HOME` preset
⇒ 2 failures; `LOOM_HOME` left unset ⇒ clean pass). Let the test mint its own.

## Item 2 — clearMergeQuarantineByKey's tied-twin "reduce" branch can resurrect the just-dropped overlap token

`clearMergeQuarantineByKey`'s own tied pending-twin reduce branch narrows a twin's own token set (drops
`overlapTokens`, the tokens it shares with the active entry being fully cleared at `key`) and durably
rewrites it via `writePendingDivertFile(p.sourceFile, updated)`. If `p.sourceFile`'s own basename is
marked `keptUnreadableLatchFiles` (a stale mark outliving an earlier, now-resolved read failure —
`702b4241` round 7's own re-read-and-union branch exists precisely for this), `writePendingDivertFile`
re-reads the file fresh and, finding it readable again under the SAME identity, unions its ON-DISK tokens
into the write — which still include the just-dropped `overlapTokens`, since nothing has rewritten that
file since the earlier failure. The written entry (both on disk and the in-memory `p.entry` the function
hands back) ends up holding the dropped token again, silently re-arming a release this same clear just
performed.

Reproduced hermetically (own LOOM_HOME, real on-disk tied twin, `markLatchFileUnreadableTestOnly` — a new
TestOnly export added for this construction, since a genuine, portable non-ENOENT read failure is not
reproducible across this test's own platform matrix). Isolated to THIS specific branch by driving the
clear via `clearMergeQuarantine(y)` (the by-key route, a single call to `clearMergeQuarantineByKey`) —
driving it via `clearMergeQuarantineByToken` instead reaches the SAME union bug, but one call earlier, in
`clearTokenFromPendingIndices`'s own by-token pending pre-pass (see "A broader finding" below), and that
earlier call's own incorrect write gets silently overwritten/corrected by `clearMergeQuarantineByKey`'s
OWN second write when the active entry is also fully cleared in the SAME `clearMergeQuarantineByToken`
call — masking the defect rather than proving its absence.

**The card's own suggested direction ("tombstone overlapTokens before that write, like the two other
partial-clear writers") was checked and found INSUFFICIENT on its own.** `tombstoneIfNotSurviving` only
ever populates the module-global `clearedTokens` set; `unionIntoOnDiskPendingEntry`'s own token union
(`unionQuarantineEntries`) never subtracts `clearedTokens` at all — so even a token already tombstoned
can still be re-added by this exact union, straight from a stale on-disk copy that predates the
tombstoning. Confirmed directly: `clearTokenFromPendingIndices`'s own partial-clear branch (one of the
two writers the card cites as already correctly-ordered) tombstones `[token]` BEFORE its own
`writePendingDivertFile` call, by the established, decision-anchored pattern — and STILL exhibits the
identical union-resurrection when its own `pending.sourceFile` carries a stale `keptUnreadableLatchFiles`
mark (reproduced directly; see "A broader finding" below). Tombstoning changes bookkeeping for a LATER
reconciliation; it does not, by itself, change what THIS write persists.

### The fix

- `writePendingDivertFile` gains an optional `droppedTokens?: ReadonlySet<string>` parameter. When the
  re-read-and-union branch fires, any token in `droppedTokens` is filtered out of the unioned result
  AFTER the union — the union's own "never drop forward" guarantee (the whole point of 702b4241's
  mechanism, for tokens the caller does NOT already know about) is preserved for everything else.
  Omitting the parameter (every pre-existing call site) is byte-identical to before.
- `clearMergeQuarantineByKey`'s reduce branch passes `new Set(entry!.tokens)` (the FULL active entry's
  token set, not just `overlapTokens`) as `droppedTokens` on its own `writePendingDivertFile` call — the
  one named by the card. (Round 2, CR Minor 2 — see below: `overlapTokens` alone missed a stale on-disk
  twin holding OTHER tokens of `entry` already dropped from the twin's own in-memory copy.)
- `card 64119847`'s own decision record explicitly forbids adding a second, per-site
  `tombstoneIfNotSurviving` call to this branch ("the exact multi-call shape decision `8db913e2` round 4
  replaced") — so the fix deliberately does NOT add an early tombstone call here; `clearMergeQuarantineByKey`'s
  own existing end-of-function tombstone call (which already includes `overlapTokens` via
  `candidateTokens.push(...overlapTokens)`) is unaffected and unchanged.

### A broader finding — NOT fixed by this card, reported rather than silently expanded into

The SAME union-resurrection vulnerability is reachable, by the identical mechanism, from at least two
OTHER `writePendingDivertFile` call sites that also perform a narrowing write and were NOT in this
card's own named scope: `clearTokenFromPendingIndices`'s own "remaining" branch (~:3517 at the time of
writing) and `clearActiveEntryTokenAtKey`'s own dual-tracked-twin loop (~:3634). Both already tombstone
before their write (matching the "good" pattern the card cites), and BOTH would still resurrect a
dropped token through the identical stale-mark-plus-union path, since (per the finding above) tombstoning
alone never protects the union. Confirmed for `clearTokenFromPendingIndices` directly, by the same
construction as this card's own repro, routed through `clearMergeQuarantineByToken` instead of
`clearMergeQuarantine`. Left unfixed here — out of this card's own named scope (`clearMergeQuarantineByKey`'s
reduce branch only) — and flagged for a follow-up card to thread `droppedTokens` through those two sites
too, using the SAME `writePendingDivertFile` parameter this card added.

### Tests

`merge-quarantine-2dd97aaa-item2-reduce-stale-mark-union.mjs` — scenario 1: a real on-disk tied pending
twin, marked unreadable via `markLatchFileUnreadableTestOnly` after boot settles, cleared via the by-key
route; asserts the twin's own in-memory AND on-disk tokens end up EXACTLY the reduced set (never the
resurrected superset), and that a further reboot does not bring the dropped token back. Scenario 2 (added
round 2, CR Minor 2 — see below) covers the broader superset case.

**Correction (round 2):** this section previously claimed the fix was "Proven RED on unpatched code /
GREEN after via `negative-control.mjs`". That RED was NOT a demonstration of the actual union-resurrection
behavior — `negative-control.mjs`'s default `--ref HEAD` reverted `merge-quarantine.ts` to the commit
immediately BEFORE this card's own fix landed (`3b0b1da6`), which also predates
`markLatchFileUnreadableTestOnly` (the test-only seam this test needs to construct its precondition — added
in the SAME commit as the fix, `c35b29c9`). Reverting both together produced `TypeError:
markLatchFileUnreadableTestOnly is not a function` — a missing-export crash, not a demonstration that the
dropped token actually resurrects. Confirmed directly: re-running `negative-control.mjs --ref 3b0b1da6`
reproduces that exact `TypeError`, verbatim, every time.

The REAL control for this fix is a `dist` mutation that removes the `droppedTokens` argument from the
reduce branch's own `writePendingDivertFile` call (i.e. simulates the fix never having been applied, while
keeping the test seam intact) — Code Review reproduced 4 real `FAIL`s this way. (Per this project's own
rule against mutating the shared `dist` for a control, any FUTURE re-proof of this specific claim should
use a scratch copy of `dist`, not the real one, and delete `packages/daemon/tsconfig.tsbuildinfo` before
rebuilding afterward.)

## Item 3 (re-scoped per the card's own triage note, after `21ec39e5` landed) — the pending-divert
## safety-tmp angle: NOT REPRODUCED, reported as a refutation

The card's own re-scoped concern: after a fresh raiser's `writePendingDivertFile` rename fails (EPERM)
following a successful tmp write, does the resulting combination of a safety-tmp residue
(`attemptDivertSafetyTmpFallback`/`writeSafetyTmpResidueAtHash`, `.tmp-safety-<pid>-<hex>` shaped) and the
plain STRANDED tmp residue the failed write itself leaves behind (never cleaned up by
`writePendingDivertFile`'s own catch branch) lose the fresh raiser's own token at the next boot.

Tried two distinct, realistic constructions, both hermetic (own LOOM_HOME, real raises via the public
`enterMergeQuarantine` API, a one-shot `fs.renameSync` injection targeting the EXACT rename destination):

1. **`mergeTokenIntoPendingEntries`'s own write failure** (the ordinary `!verified` + existing-pending-match
   path `enterMergeQuarantine` takes for a second raise on an always-unresolvable identity). This function
   has NO safety-tmp fallback of its own at all — only the plain stranded tmp survives a failed write.
   Confirmed BOTH tokens still survive a fresh boot anyway: the generic "no resolvedKey, unresolvable"
   recovery path (`702b4241`'s own pre-existing, zero-change-needed branch, per that card's own doc
   comment on `PENDING_DIVERT_TMP_RE`) correctly reads and unions the stranded tmp's own full content.
2. **`divertRaiseEntry`'s own genuine double fault** (forced via a transient read failure on the raise's
   own key-final, pushing a VERIFIED/resolvable raise through the divert path twice for the same
   identity, so the second raise's own union-into-existing-pending write is the one forced to fail) — this
   DOES produce the exact combination the card describes: a real `.tmp-safety-` residue AND a separate
   stranded ordinary tmp, both holding the full `{t1,t2}` set, with the original pending final swept.
   Confirmed BOTH tokens still survive a fresh boot: boot's own torn-write recovery (`"recovered a
   torn-write quarantine latch ... re-armed as the full union"`) found and correctly unioned the residue.

**Neither construction reproduces the claimed token loss.** This is reported as a refutation, not a
negative result to quietly drop — `21ec39e5`'s own record already names the GENERAL case (an ordinary
raise's renameSync failure, no pending-divert/collision machinery needed) as closed by its Fix B, and
flagged the pending-divert/safety-tmp angle specifically as the one thing it did NOT close. Having now
tried the two realistic shapes that angle could take, both recover correctly — the pre-existing generic
boot-time tmp-residue recovery pipeline (unrelated to `21ec39e5`'s own PASS-1b-early-exit fix, which only
ever applies to a RESOLVABLE repo's own hash-keyed final) already covers it. No fix was made for item 3;
none is believed needed based on this evidence. The two repro scripts are kept as committed regression
tests, locking in the current, correct recovery behavior for both shapes.

### Tests

- `merge-quarantine-2dd97aaa-item3-pending-divert-safety-tmp.mjs` — construction 1 above.
- `merge-quarantine-2dd97aaa-item3-divert-double-fault.mjs` — construction 2 above (the genuine
  double-fault, matching the card's own literal framing most closely).

Both assert the POSITIVE claim ("both tokens survive a reboot") rather than merely the absence of an
error, so either would go RED if a future regression reopened the loss this card asked about.

**Correction (round 2, CR Minor 3):** both item-3 test files originally asserted several
IMPLEMENTATION-DETAIL observations (which on-disk file shape a recovery path happened to leave behind —
e.g. whether a stranded tmp residue or a swept base file was left in a particular form) as FAILING
`check(...)` calls, mislabeled `(diagnostic)` in their own log text despite being wired to fail the suite.
Those are not the card's own claim under test (whether a token survives a reboot) and have been demoted to
a separate, non-failing `diagnose(...)` helper — informational log lines only, never counted toward
`failures`. The POSITIVE "both tokens survive a reboot" checks are unaffected and remain the only
failing assertions in either file.

## Round 2 (pre-landing polish, CR passed `c35b29c9` MERGEABLE)

- **CR Minor 2** (item 2): `clearMergeQuarantineByKey`'s reduce branch now passes `new Set(entry!.tokens)`
  instead of `new Set(overlapTokens)` as `droppedTokens` — a strict superset, always safe, since this
  clear lifts every one of `entry`'s tokens. Covers a stale on-disk twin holding OTHER tokens of `entry`
  that were already dropped from the twin's own in-memory copy by an earlier, unmodeled reduce whose
  durable write never landed — `overlapTokens` alone (the twin's own in-memory intersection) would miss
  those and let the union resurrect them. New scenario 2 in
  `merge-quarantine-2dd97aaa-item2-reduce-stale-mark-union.mjs` constructs exactly this case (W carries two
  tokens; P's in-memory copy overlaps on only one; P's stale on-disk copy carries both). Proven RED (on
  `overlapTokens`-only code) / GREEN (on `entry!.tokens` code) via `negative-control.mjs --ref HEAD`
  (default — the fix was an uncommitted edit on top of `c35b29c9` at the time), clean tree restore
  confirmed.
- **CR Minor 3** (item 3): see the correction immediately above.
- **Nit 4**: `merge-quarantine-2dd97aaa-item3-pending-divert-safety-tmp.mjs`'s scenario-1 comment named
  `divertRaiseEntry`'s own union-into-existing branch as what the second raise exercises; the construction
  actually goes through `mergeTokenIntoPendingEntries`'s own union-into-existing branch (`divertRaiseEntry`
  is exercised by the SIBLING test, `-divert-double-fault.mjs`, not this one). Corrected.
- **Doc correction** (item 2's own "Tests" section, above): the original "Proven RED via
  `negative-control.mjs`" claim was itself wrong — see the correction inline there.

## Follow-up 535fd69d — the two other narrowing writers item 2's own "broader finding" named are fixed

Card `535fd69d`. Both sites the Code Reviewer confirmed by reading (not by repro) — `clearTokenFromPendingIndices`'s
own "reduce" branch and `clearActiveEntryTokenAtKey`'s own dual-tracked-twin loop — were reproduced
directly and fixed the same way item 2 was: `droppedTokens` threaded into their own `writePendingDivertFile`
call.

**Why each one's own `tombstoneIfNotSurviving` call does not protect it, and the two sites fail for
slightly different reasons, both resolving to the same root cause (`tombstoneIfNotSurviving`'s own
"is this token surviving ANYWHERE in memory" scan returns a false negative whenever some OTHER in-memory
record still legitimately holds the token at that instant):**

- `clearTokenFromPendingIndices` is `clearMergeQuarantineByToken`'s own by-token **pending pre-pass** —
  it runs BEFORE that function's second phase ever touches a matching ACTIVE entry. So when the token
  being cleared is also held by an active entry W (reproduced: W holds `[wa-token, wc-token]`, a separate
  non-twin pending entry P holds `[wa-token, p-token]`), the tombstone call inside the pending pre-pass
  finds `wa-token` still "surviving" on W (not yet cleared) and never adds it to `clearedTokens` at all.
  P's own write is then exposed exactly like item 2's reduce branch: a stale `keptUnreadableLatchFiles`
  mark on P's own `sourceFile` lets the re-read-and-union resurrect `wa-token` from P's unchanged on-disk
  copy.
- `clearActiveEntryTokenAtKey`'s own dual-tracked-twin loop runs AFTER that SAME function's own
  `replaceEntryEverywhere` + `tombstoneIfNotSurviving` calls — so in the ordinary single-entity case the
  token IS already genuinely tombstoned by the time this loop's own write runs, and the gap cannot be
  observed from that shape alone. It is reproducible all the same: an UNRELATED active entry Q,
  independently holding the identical token value and not yet visited by `clearMergeQuarantineByToken`'s
  own active-entry iteration (inserted into `activeQuarantines` after the entry being cleared, so Map
  iteration order processes it later), is "surviving" at the exact instant this function's own tombstone
  call runs for the entry it IS clearing — defeating it for the SAME reason as the pending-pre-pass case,
  despite the different call ordering. Reproduced on X (a degraded, `resolvedKey`-dual-tracked occupant,
  `883e29bc`-style) holding `[dx-ta, dx-tb]`, with Q crafted to independently also hold `dx-ta`.

Both repros proven RED-before (`negative-control.mjs --ref HEAD`, 5 real `FAIL`s across the two
scenarios) / GREEN-after / byte-identical restore.

**CR Minor 1 — `droppedTokens` made a REQUIRED parameter on `writePendingDivertFile`, at every call
site, per the card's own instruction (mirrors `21ec39e5`'s identical "Do not give an optional parameter
with an implicit default" rule for this module's OTHER tmp-sweep policy parameter).** Auditing every call
site to decide what each one passes found a NINTH site sharing the `writePendingDivertFile` chokepoint
that had never threaded a `droppedTokens`-shaped parameter through at all:
`rewriteOrphanLatchFilesAfterPartialClear`'s own internal write (it rewrites a partial clear's folded
orphan-reference files, and already RECEIVES `droppedTokens` as its own parameter — passed to
`orphanRewriteOwnershipConfirmed` — but never forwarded it to its own `writePendingDivertFile` call).

**This ninth site is NOT an independently reproducible vulnerability, unlike the two above — reported as
a refutation, not silently fixed as if it were equivalent.** `orphanRewriteOwnershipConfirmed` REFUSES
outright, unconditionally, as its very first check, whenever the target file's basename is marked
`keptUnreadableLatchFiles` — exactly the one precondition the union-resurrection vulnerability needs to
fire inside `writePendingDivertFile` itself. So by the time this call site could ever reach
`writePendingDivertFile`, the mark is already confirmed ABSENT, and `writePendingDivertFile`'s own
re-read-and-union branch (gated on that exact same mark) structurally cannot fire. Threading the caller's
real `droppedTokens` through anyway is still correct — it is the only value consistent with "every call
site states whether it narrows," and a future change to `orphanRewriteOwnershipConfirmed`'s own gate
should not have to also remember to wire this parameter in for the first time — but no repro was written
for it, and none should be invented.

**Every other `writePendingDivertFile` call site passes an explicit empty `droppedTokens` set** — each
one unions or mints a record and never narrows a token the caller already knows is gone:
`consumeMatchedPendingsIntoArmedEntry`'s `foreignUnion` write, `protectOccupantContentBeforeDelete`'s
`toWrite` write (its own `tokens` field is already filtered through `clearedTokens` at READ time, via
`readSurvivingOnDiskTokens` — a different mechanism from this card's `droppedTokens`, not a second
instance of it), `mergeTokenIntoPendingEntries`'s `merged` write, `mintPendingDivert`'s `toWrite` write,
and `divertRaiseEntry`'s `merged` write.

### Tests

`merge-quarantine-535fd69d-bytoken-stale-mark-union.mjs` — two scenarios, one per site, both described
above. Each asserts the in-memory AND on-disk reduced state immediately after the clear, plus survival
across a real reboot.

## Follow-up 58957b1e — the ARMED-KEY write path (a SEPARATE chokepoint from writePendingDivertFile)

Card `58957b1e`, from Code Reviewer `8aa0750e`'s review of `535fd69d`. `reconcileMarkedBasenameBeforeWrite`
(the chokepoint EVERY `writeMergeQuarantineLatch` call runs through for a marked basename) had the
IDENTICAL defect as `writePendingDivertFile`'s own re-read-and-union — it only ever consulted the global
`clearedTokens` tombstone, never a caller's own known-dropped set — but on the ARMED-KEY final, not the
pending-divert record. Fixed the same way: `droppedTokens: ReadonlySet<string>` made a REQUIRED parameter
on `reconcileMarkedBasenameBeforeWrite`, `foldInOnDiskTokensIfMarked`, and `writeMergeQuarantineLatch`
itself (inserted as the 2nd positional param, right after `entry`, since several existing params already
carry defaults and TypeScript forbids a required param after an optional one).

**This is a SEPARATE 9-site call-site audit from 535fd69d's own 9-site `writePendingDivertFile` audit
above — the two never overlap, and neither total describes the other.** Of `writeMergeQuarantineLatch`'s
9 call sites, THREE narrow (pass the caller's own dropped token(s)): `clearActiveEntryTokenAtKey`'s own
armed-key loop (the card's own named repro — reproduced directly, same "unrelated active entry Q, visited
later in Map order" technique as 535fd69d's own scenario 2) and `clearMergeQuarantineByKey`'s own
tied-twin reduce branch's armed-key write (reproduced directly — this one needs NO "unrelated Q" trick at
all, since this function defers its one tombstone call to the very end, well after this write, so
`clearedTokens` is simply never populated yet) both pass the dropped token(s); the THIRD,
`clearTokenFromPendingIndices`'s own armed-key loop, is fixed the same way but NOT independently
reproduced — per decision `64283e06`'s own posture, that loop is unreachable today (its sole caller,
`clearMergeQuarantineByToken`, only ever hands it non-twin pending indices). The other SIX call sites
never narrow (raises, unions, boot writes, a fresh fail-closed placeholder mint) and pass an explicit
empty `droppedTokens` set.

### Tests

`merge-quarantine-58957b1e-armed-latch-stale-mark-union.mjs` — two scenarios (the two independently
reproduced sites above), each asserting the in-memory AND on-disk reduced state immediately after the
clear, plus survival across a real reboot. Proven RED-before (`negative-control.mjs --ref HEAD`, 4 real
`FAIL`s across the two scenarios) / GREEN-after / byte-identical restore.

## Do not

- Do not fold a content-parsed `parsedRepoPath` into a human-facing `contentKeptRepoPaths`/
  `contentKeptRepoPath` field without checking it against the clear's own `excludeIdentities` first — the
  referencer scan excludes the clearer's own identity; the content-parsed fallback must too, or a stale
  self-referencing leftover gets reported as a foreign claimant against the very identity being cleared.
- Do not read a dropped-via-this-card `contentKeptRepoPaths` entry as proof the underlying file was
  deleted — the fix only suppresses the MISATTRIBUTED report; the file stays exactly as kept/unkept as it
  was before, fail-closed either way.
- Do not pre-set `LOOM_HOME` in your own shell env before invoking `negative-control.mjs` against a test
  that calls `useOwnLoomHome` — see the gotcha above.
- Do not assume tombstoning a token before a `writePendingDivertFile` call protects it from that SAME
  call's own re-read-and-union — `unionQuarantineEntries` never subtracts `clearedTokens`. Pass the
  caller's own known-dropped set via `droppedTokens` instead; tombstoning only affects a LATER
  reconciliation, never the write it (mistakenly) appeared to precede.
- Do not assume `writePendingDivertFile`'s own `droppedTokens` parameter is optional, or give it an
  implicit default, at any NEW call site — it is REQUIRED (card `535fd69d`), so a new site is forced to
  decide, explicitly, whether its own write narrows (pass the dropped tokens) or not (pass `new Set()`),
  rather than silently inheriting the "no, I don't narrow" default an optional parameter would have given
  it for free.
- Do not assume a call site reaching `writePendingDivertFile` through ANOTHER function's own content/
  ownership gate is automatically exposed to this union-resurrection class just because it shares the same
  underlying write — check whether that gate's own precondition is actually compatible with
  `keptUnreadableLatchFiles` being set. `rewriteOrphanLatchFilesAfterPartialClear`'s own write is gated by
  `orphanRewriteOwnershipConfirmed`, which refuses outright whenever that exact mark is present — making
  this one site structurally unreachable with the vulnerability's own precondition, unlike the two sites
  above (card `535fd69d`'s own "Follow-up" section).
- Do not read item 3's "not reproduced" result as proof no pending-divert/safety-tmp loss can EVER occur
  — it means two specific, realistic constructions (the two named above) did not lose data; a materially
  different construction was not tried and is not ruled out by this record.
- Do not pass a narrowing write's own in-memory `overlapTokens`/`candidateTokens` subset as
  `droppedTokens` when a WIDER set is already known safe to drop — `clearMergeQuarantineByKey`'s reduce
  branch passes the FULL `entry!.tokens` precisely because a stale on-disk twin can carry other tokens of
  `entry` the in-memory intersection alone would miss (round 2, CR Minor 2).
- Do not wire an implementation-detail observation (which on-disk file shape a recovery path happened to
  leave behind) to the SAME failing `check(...)` helper as the card's own claim under test — use a
  separate, non-failing `diagnose(...)` helper for anything merely informational, or a future
  implementation change that doesn't affect the real claim will fail the suite for the wrong reason
  (round 2, CR Minor 3).
- Do not assume fixing a function's `writePendingDivertFile` call (the pending-divert record) also covers
  its OWN `writeMergeQuarantineLatch` call (the armed-key final) — they are two STRUCTURALLY SEPARATE
  writes, each with its own chokepoint and its own `droppedTokens` parameter. `clearTokenFromPendingIndices`'s
  own partial-clear branch and `clearActiveEntryTokenAtKey`'s own dual-tracked-twin loop each had this
  exact gap: card `535fd69d` fixed only their `writePendingDivertFile` call, leaving their SEPARATE
  `writeMergeQuarantineLatch` call (reached through `reconcileMarkedBasenameBeforeWrite`) sharing the
  identical vulnerability, unfixed until card `58957b1e`.
