# 21ec39e5 — a `.json.tmp-<pid>` residue is no longer swept (runtime) or deleted (boot PASS 1b) blind

Investigate-first card. `sweepTmpResidueForHashIfUnreferenced` deleted an unreferenced tmp residue
unconditionally, with no content check — the tmp twin of what card `f2cc5f18` already fixed for `.json`
orphans. New evidence from re-review `6847f5dd` of card `702b4241` (landed on main as commit `9f3713c2`)
showed a tmp residue CAN be the only durable copy of a token: when a write's rename fails (EPERM) after
its own fsync succeeds, the tmp is stranded holding a token `final` never received.

## The investigation

Two hermetic repros (own `LOOM_HOME`, own `os.tmpdir()` repos, scratch-only scripts, never committed)
confirmed BOTH halves of the fail-open class, via two DIFFERENT code paths:

1. **Boot-time (PASS 1b's own early-exit, not a sweep function at all):** raise R once (token t1, final
   persists). Raise R again with `fs.renameSync` monkeypatched to throw EPERM for that exact dest — the
   write's own tmp (holding `[t1, t2]`, fsync'd) survives; `final` stays untouched at `[t1]`. A fresh boot
   with R registered hits `reenterMergeQuarantinesAtBootImpl`'s PASS 1b gate
   (`matchedRepo && isRepoPathCurrentlyResolvable(matchedRepo) && cleanlyParsedKeys.has(...)`) and
   unconditionally `fs.unlinkSync`s the tmp with **zero content read** — t2 is gone, permanently, with no
   copy anywhere. Confirmed by contrast: the SAME scenario with R **unregistered** at boot instead logs
   "recovered a torn-write quarantine latch … re-armed as the full union" (the non-early-exited generic
   parse/union path, which is safe) — isolating the early-exit shortcut specifically as the culprit.
2. **Runtime (the named function, zero restarts):** R has a live in-memory entry (one real raise). A
   foreign, currently-unresolvable repo D's own stranded tmp (simulating D's own torn write) sits at the
   SAME key hash as R (an ancestor-walk collision — D is a non-existent subdir of R). R raises again
   (hits `enterMergeQuarantine`'s "existing" branch, which writes with `sweepOtherTmpsOnSuccess:true`) —
   `sweepTmpResidueForHashIfUnreferenced` deletes D's tmp, unread, purely as collateral of R's own
   unrelated successful write. D's ENTIRE quarantine (not just one token) is lost with no restart at all.

**Why token loss matters, not just "a stale token nobody uses":** each raise's own token represents an
independent, still-possibly-ongoing caller obligation (SET semantics — the repo stays quarantined until
EVERY outstanding token is cleared, `clearMergeQuarantineByToken`'s own round-7 M1 rule). Losing one
token from the durable record means a LATER clear of a DIFFERENT, still-live token can fully lift the
repo's quarantine while the lost token's own caller never got to signal its own completion — a genuine
fail-open, not merely a harmless dangling id.

## The fix

**Fix A (runtime, the 4 previously-unprotected call sites of `sweepTmpResidueForHashIfUnreferenced` —
`writeMergeQuarantineLatch`'s `sweepOtherTmpsOnSuccess` path, `clearActiveEntryTokenAtKey`'s
partial-clear write loop, and `clearMergeQuarantineLatchFile`'s matched-pending and raw-fallback
branches):** the function gained an optional `candidateTokens?: string[]` parameter. When a caller
supplies one (even `[]`), an unowned tmp is no longer deleted outright — its content is read first via
`orphanSweepSafeToDelete`, the EXACT SAME content-parse helper `sweepOrphanLatchFileIfUnreferenced`
already uses for a `.json` orphan (never forked — the two paths now share one chokepoint, closing the
two-path asymmetry that is the recurring defect class in this module). A caller that omits the parameter
(`undefined`) stays byte-identical to the pre-fix unconditional delete — this is deliberately how the
ONE already-protected call site (`deleteMergeQuarantineLatchByKey`, which already runs
`protectForeignTmpResidueBeforeSweep` first) and any future unaudited call site stay untouched; the fix
is strictly additive per call site, never a blanket behavior change. The return shape gained
`contentKeptEntries` (a content-attributed keep, folded into `contentKeptRepoPaths` at the human-facing
clear routes, never into `stillBlockedCoOccupants` — no live entry backs it, mirroring `8db913e2`'s own
rule for the `.json` sweep) and an explicit `anyUnattributed` boolean (a genuine non-ENOENT read failure
also marks the file `keptUnreadableLatchFiles`, mirroring `protectForeignTmpResidueBeforeSweep`'s own
identical mark — composing directly with `702b4241`'s machinery without touching it).

**Fix B (boot, PASS 1b's own "stale tmp beside a clean final" early-exit,
`reenterMergeQuarantinesAtBootImpl`):** before the unconditional unlink, the tmp's own content is read via
the SAME `orphanSweepSafeToDelete` helper, with `candidateTokens` = the already-clean-parsed final's own
tokens (`byRepoKey.get(canonicalRepoLockKey(matchedRepo))?.tokens`). A genuine subset (the overwhelming
common case — a truly superseded earlier attempt) is still deleted exactly as before, same cost. A
non-subset (repro 1's shape) is NOT deleted — control simply falls through to the SAME generic
read/parse/union/deferred-write pipeline every other (non-early-exited) tmp already goes through a few
lines below, so the union lands durably in `final` BEFORE the tmp is ever unlinked (preserving `92c645cc`'s
"sweep only after a superseding write succeeds" invariant uniformly, rather than as an exception).

**This is a NEW gate added in front of an existing unconditional action, never a restructure of
`702b4241`'s own three try/catch blocks** — `702b4241`'s own record explicitly scoped this exact
early-exit shortcut OUT of its fix and into this card. The two cards' machinery compose cleanly: a genuine
read failure during THIS card's new content-check routes through the identical "mark
`keptUnreadableLatchFiles`, never silently delete" posture `702b4241` established for every other read
site in this function, applied fresh (this is a NEW read site `702b4241` never touched, not a
modification of its own).

## Pre-existing tests corrected (NOT a sign the fix is wrong — see below)

Three pre-existing, decision-anchored tests (two of them named explicitly in card `97cff6db`'s own "Do
not" list as deliberately exercising "a genuinely stale tmp is still swept") used a fixture shaped
`{repoPath: R, tokens: ["some-invented-disjoint-token"]}` beside R's own real final (holding a DIFFERENT,
real token) — and asserted this invented, uncovered token gets swept unconditionally:

- `merge-quarantine-pass1b-clean-parse-gate.mjs`'s `STALE-TMP-STILL-SWEPT` scenario.
- `merge-quarantine-boot-hardening.mjs`'s `TW-stale` sub-scenario (boot-time) AND its separate `WFR-4`
  sub-scenario (runtime, `clearMergeQuarantineByToken`'s partial-clear path — Fix A, not Fix B).
- `merge-quarantine-pass1-degraded-union-guard.mjs`'s `pass1b-resolvable-stale-tmp-still-deleted`
  scenario (card `5b40376c`'s own negative control for a DIFFERENT property — the resolvability gate —
  which this card's content-check does not regress once the fixture is realistic; see below).

**An invented, disjoint token is not a sound stand-in for "genuinely stale."** The ONLY way such a tmp can
legitimately exist beside an already-good final, for the SAME repoPath, is either (a) it is a genuinely
superseded EARLIER attempt for the SAME raise generation — in which case its own token(s) are a SUBSET of
what the final (or `clearedTokens`) already covers, or (b) it represents a raise whose token was later
fully cleared via a real clear (which tombstones it into `clearedTokens`). Neither case needs an invented,
unrelated token to test "genuinely stale" — and a fixture that instead names a wholly disjoint token is
indistinguishable, by construction, from exactly the fail-open shape this card's own repros proved real.
Each of the three was corrected by replacing the invented token with the real, already-covered token the
scenario's own narrative already implies (the real raise's own returned token, or — for `WFR-4` — the
surviving token the partial clear itself leaves behind). This preserves every scenario's own asserted
behavior (still swept, same reason, same entry count) while making the fixture test the shape it always
claimed to test, rather than a shape this investigation shows is unsafe in general.

## Overlap with card `2dd97aaa`

`2dd97aaa` item 3 is the SAME root scenario (a `writePendingDivertFile` rename failure stranding a
pending-divert's own tmp) viewed through a narrower lens — its own fix direction is "boot should reingest
from the safety-tmp/stranded tmp, or the fallback should union," scoped to the pending-divert/safety-tmp
angle specifically. This card's Fix B closes the GENERAL case (repro 1 needs no pending-divert or
collision machinery at all — an ordinary raise's renameSync failure is sufficient) via the PASS 1b
early-exit gate, which is the actual mechanism that destroyed the token in both repros. `2dd97aaa`'s own
safety-tmp-specific angle (its own, separately-named residue shape) remains open and is NOT closed here —
flag this to whoever picks up `2dd97aaa` next so they don't re-fix what this card already closed, and so
they know this card's own fix is already live when reasoning about its own repro.

## Tests

`merge-quarantine-tmp-residue-content-check-21ec39e5.mjs` — new scenarios: `runtime-sweep-protects-foreign-unaccounted-tmp`
(repro 2's shape — RED on a pre-fix build, GREEN after) and `boot-pass1b-early-exit-protects-superset-tmp`
(repro 1's shape — RED/GREEN, both the registered and unregistered variants) plus a positive control for
each (`runtime-sweep-still-deletes-pure-subset-tmp`, `boot-pass1b-still-deletes-pure-subset-tmp` — the
common case is unchanged, same cost, same outcome). Round 2 (below) added three more.

## Round 2 (Code Review of `7be6fbe5`, MERGEABLE-with-fixes) — a rewritten control was vacuous, two keep
paths had no test, an optional-param footgun, and a misleading read-failure inference

**MAJOR — `pass1-degraded-union-guard.mjs`'s `pass1b-resolvable-stale-tmp-still-deleted` (card `5b40376c`'s
own negative control, proving the resolvability gate does not OVER-block a resolvable repo's stale tmp)
went vacuous under round 1's own fixture fix.** With the subset-token fixture, the OVER-blocked path (the
tmp falls through into the generic union/deferred-write pipeline, as if `matchedRepo` were NOT resolvable)
ALSO ends up with exactly 1 surviving token and no surviving tmp — identical to the correct, cheap
early-exit outcome the test means to prove. Reproduced directly: a dist mutation forcing
`isRepoPathCurrentlyResolvable(matchedRepo)` to `false`, at ONLY the PASS 1b early-exit's own gate (dist
line, found via `grep -n "isRepoPathCurrentlyResolvable(matchedRepo)"`; five call sites exist in dist —
only the PASS-1b-early-exit one was mutated), left the round-1 fixture's own single assertion PASSING.
**Fix:** capture the final's own bytes + mtime immediately BEFORE `reenterMergeQuarantinesAtBoot`, and
assert byte- AND mtime-identity AFTER it — the early exit never rewrites `final` at all; the union
pipeline always does (a fresh `fs.writeSync`+`renameSync`), even when the rewritten content happens to be
equivalent. **Verified under the SAME mutation: the new discriminator assertion goes RED** (log line
confirms the union path ran: "recovered a torn-write quarantine latch … re-armed as the full union"),
while the old, now-admittedly-vacuous assertion still passes alongside it — proving the discriminator,
not the original assertion, is what actually catches this. Dist restored from a pre-mutation backup,
`tsconfig.tsbuildinfo` deleted, rebuilt fresh, and confirmed byte-identical to the backup via `cmp` before
trusting anything built from it again.

**Re-checked under the SAME mutation, as asked — naming which mutation each one actually catches:**
- `pass1b-clean-parse-gate.mjs`'s `STALE` scenario and `boot-hardening.mjs`'s `TW-stale` scenario BOTH go
  RED under this exact mutation too — but for a reason that was ALREADY a sound, non-vacuous assertion,
  not a gap: each asserts the recovered entry's own `reason` field equals the REAL raise's text. Under the
  mutation, the union path's own "longest-outstanding-identity-wins" rule picks the stale tmp's own OLDER
  `enteredAt`/branch/reason instead (the fixture's stale tmp is deliberately minted with an old
  `enteredAt`), so the reason text flips and the existing assertion catches it on its own. Neither needed
  the byte/mtime discriminator added to `pass1-degraded-union-guard.mjs`.
- `boot-hardening.mjs`'s `WFR-4` does NOT go red under this mutation, and is not expected to — it is a
  RUNTIME scenario (`clearMergeQuarantineByToken`'s partial-clear path, Fix A) that never reaches PASS 1b
  at all; this mutation only touches the PASS-1b-early-exit's own gate. `WFR-4`'s own sensitivity was
  separately proven in item 2 below, via a revert of its OWN call site's `candidateTokens`, not this one.

**TEST GAP — two of Fix A's four call sites had no keep-path test at all:** `clearActiveEntryTokenAtKey`'s
own partial-clear write loop, and BOTH of `clearMergeQuarantineLatchFile`'s branches (matched-pending,
raw-fallback). Added three scenarios (`partial-clear-protects-foreign-unaccounted-tmp`,
`clear-by-id-matched-pending-protects-foreign-unaccounted-tmp`,
`clear-by-id-raw-fallback-protects-foreign-unaccounted-tmp`), each planting an UNCOVERED, never-tombstoned
foreign tmp sharing the relevant hash and asserting it survives (plus, for the two `clearMergeQuarantineLatchFile`
scenarios, that `contentKeptRepoPaths` names it — `clearActiveEntryTokenAtKey` itself returns `void`, so
that scenario only asserts survival). Each proven RED by temporarily reverting ONLY that one call site's
`policy` argument to `{mode:"unconditional-owner-protected"}`, confirming ONLY that scenario's own checks
failed, then restoring and reconfirming GREEN.

**API FOOT-GUN — `candidateTokens?: string[]` (round 1) made "unconditional" and "content-checked-against-
nothing-yet" indistinguishable by a missing argument, and round 1 itself tripped on exactly this (a stray
default value silently widened an untouched call site).** Replaced with a REQUIRED discriminated union,
`TmpSweepPolicy = {mode:"unconditional-owner-protected"} | {mode:"content-checked", candidateTokens:
string[]}` — every call site must now say which it means, inline, and the ONE genuinely-unconditional site
(`deleteMergeQuarantineLatchByKey`, already protected via `protectForeignTmpResidueBeforeSweep`) states
why at the call.

**MINOR — `orphanSweepSafeToDelete`'s `!parsedRepoPath` was NOT a reliable read-failure signal.** A
readable, validly-parsed JSON object that merely lacks a string `repoPath` (but DOES carry real, uncovered
tokens) ALSO returns `safe:false` with no `parsedRepoPath` — indistinguishable, under round 1's own
inference, from a genuine non-ENOENT read failure. Round 1's own code then wrongly marked such a file
`keptUnreadableLatchFiles` with a misleading "could not be read" log line, even though it WAS read
successfully. **Fix:** `orphanSweepSafeToDelete` now returns an explicit `readFailed?: true` field, set
ONLY in the genuine (non-ENOENT) catch branch; `sweepTmpResidueForHashIfUnreferenced` branches on
`readFailed` first, `parsedRepoPath` second, and a bare "readable but unattributable" third (kept, but
never marked `keptUnreadableLatchFiles` and never logged as unreadable). The record's own prior "Do not"
bullet asserting the opposite is corrected below (the superseded text is removed, not merely appended to).

## Do not

- Do not pass `candidateTokens` to `sweepTmpResidueForHashIfUnreferenced` from a NEW call site without
  first checking whether that call site already runs `protectForeignTmpResidueBeforeSweep` (or an
  equivalent content-aware protection) — doing both is redundant, never incorrect, but the point of this
  card's own doc comment is to let a reader tell the two apart, not to re-derive it from the diff.
- **(Round 2 — SUPERSEDES the original text of this bullet, which claimed the opposite.)** Do not read a
  `!safety.safe` result with no `parsedRepoPath` as proof of a genuine read failure — check the explicit
  `readFailed` field instead. A readable record that merely lacks a string `repoPath`, while carrying
  real uncovered tokens, hits the SAME `!parsedRepoPath` shape with `readFailed` unset; round 1's own code
  conflated the two, and this record's own text originally endorsed that conflation.
- Do not revert the PASS 1b early-exit's fast path (the subset case) to always fall through into the
  generic parse/union pipeline "to simplify" — several existing fault-injection tests
  (`merge-quarantine-pass1b-clean-parse-gate.mjs`'s own R1/MTU scenarios) count on an exact `fs.openSync`
  call count for the write-promotion pass; the fast subset-delete path exists specifically to avoid
  adding an extra write attempt to the overwhelmingly common case.
- Do not treat a test asserting an invented, disjoint token gets swept as evidence the sweep is safe —
  see "Pre-existing tests corrected" above. A new test in this area must derive its "stale" tmp's own
  token from a real, already-covered source, never a fresh, unrelated string literal.
- Do not give `sweepTmpResidueForHashIfUnreferenced` an optional parameter with an implicit default again
  — round 1's own `candidateTokens?: string[]` silently widened the one call site that never passed it.
  `policy: TmpSweepPolicy` is REQUIRED; every call site must say which mode it means, inline.
- Do not trust a subset-token (or any single-dimension) fixture change to preserve an EXISTING negative
  control's own discriminating power without re-deriving what that control actually distinguishes — see
  the Round 2 MAJOR finding above. A fixture fix for one bug can silently make a DIFFERENT, unrelated
  assertion vacuous; re-run the control's own named mutation after any fixture change near it.
