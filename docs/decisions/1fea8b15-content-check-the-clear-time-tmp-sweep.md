# 1fea8b15 — content-check the owner-protected tmp sweep on a quarantine clear

From re-review `686bb6ab` of `21ec39e5` round 2 (gen 435). `deleteMergeQuarantineLatchByKey`'s own trailing
`sweepTmpResidueForHashIfUnreferenced` call was left `{mode:"unconditional-owner-protected"}`, on the
strength of a comment claiming `protectForeignTmpResidueBeforeSweep` "already" content-protected it. That
claim was false: `protectForeignTmpResidueBeforeSweep` deliberately skips protecting a tmp whose own
`repoPath` is currently RESOLVABLE (card `d2582692`'s own "a resolvable leftover is safe to overwrite
today" exclusion) and one whose content carries no string `repoPath` at all — the unconditional sweep
right after then deleted exactly those two shapes with NO content check whatsoever.

## The investigation (STEP 1 checkpoint)

Reproduced on a throwaway temp `LOOM_HOME` + throwaway git repos, mirroring the fixture shape
`21ec39e5`'s own `runtime-sweep-protects-foreign-unaccounted-tmp` scenario established: R (real,
resolvable) raises; a foreign tmp D (a subdirectory of R with no own `.git`, so its own
`canonicalRepoLockKey` walks up to R's key) is hand-planted at R's own key hash, holding a disjoint,
uncovered token, while D is unresolvable. D then "remounts" (`fs.mkdirSync`, still no own `.git`, so its
key still collides with R's). A real `clearMergeQuarantine(R)` then destroyed D's tmp with zero record
anywhere (no `contentKeptRepoPaths`, no `stillBlockedCoOccupants`) — the resolvable case. A control with D
left unresolvable showed the content correctly protected/relocated instead, isolating the defect to
resolvability specifically. A third shape (a tmp with no string `repoPath` at all) was also destroyed
blind, regardless of resolvability.

**Caveat, carried forward from the checkpoint:** the card body's own literal wording ("an identity
unresolvable when it raised ... has its rename fail with EPERM") is NOT reachable through a live
`enterMergeQuarantine` call. Traced directly: an unresolvable raise's own write is deliberately hashed off
`directPathIdentity(repoPath)` (`pendingDivertFilenameFor`), never `canonicalRepoLockKey` — card `d4b25feb`
states this explicitly as a "Do not" ("Do not derive a pending-divert entry's on-disk filename from
`canonicalRepoLockKey(repoPath)` — that is precisely the degraded, walked-up value this format exists to
avoid writing under"). So a tmp genuinely written by a live, unresolvable-at-raise-time raise never lands
at the walked-up key's own hash. The real, exploitable surface this card closes is broader and shape-
agnostic: *any* foreign tmp residue that ends up at a shared key's hash — by a boot-time degraded-arm
reconstruction, or by the EXACT same hand-planted-fixture methodology both `21ec39e5` and `d2582692`'s own
tests already use to validate this function — for an identity that is currently resolvable (or whose
content lacks a parseable `repoPath`), was destroyed with zero content check by an ordinary clear. The
repro above demonstrates that mechanism directly, independent of exactly how such a tmp came to exist.

## Ruling: does `d2582692`'s "a resolvable leftover is safe" exclusion still hold?

**No.** `d2582692`'s own design comment states the resolvable-skip "mirrors
`differentUnresolvableOccupantRepoPathAt`'s own `protectResolvableToo: false` default" — the premise being
that a resolvable identity's own leftover is necessarily stale, because that identity can be trusted to
hold its real state elsewhere once resolvable. `21ec39e5` already falsified the general form of this
premise (a tmp CAN be an identity's sole durable copy of a token); the repro above shows the SAME
falsification applies concretely to `protectForeignTmpResidueBeforeSweep`'s own resolvable-skip. The
control scenario (D stays unresolvable) proves the asymmetry is real and specific to resolvability, not a
wholesale break of that function.

## The fix

`deleteMergeQuarantineLatchByKey`'s trailing sweep now runs with `candidateTokens: clearedEntry?.tokens ??
[]` instead of the (now-removed — see "Round 2" below) `unconditional-owner-protected` mode — the same
shared `orphanSweepSafeToDelete` chokepoint every other Fix-A (`21ec39e5`) call site already uses, which
has neither of `protectForeignTmpResidueBeforeSweep`'s own two exclusions (it has no resolvability check,
and a tmp with no string `repoPath` simply falls through to its own generic token-subset check rather than
being specially excluded). Its own reference-owned `keptEntries` are folded into this function's own
`kept` return; its content-only `contentKeptEntries` are returned via a separate `contentKept` field (see
"Round 2" below — this separation is a round-2 fix, not part of the original round-1 shape).

`deleteMergeQuarantineLatchByKey`'s `clearIdentity` parameter is now REQUIRED (`string`, was
`string | undefined`) — all 4 existing call sites already pass a `directPathIdentity(...)` result (which
never returns `undefined`), confirmed by grep and a clean build.

## Companion fixes, found only by running the full `merge-quarantine*.mjs` corpus (not by this card's own
new scenarios alone)

Switching the trailing sweep to content-checked exposed three PRE-EXISTING gaps in shared code that no
prior call site's own test coverage happened to exercise in a way that mattered:

1. **`protectForeignTmpResidueBeforeSweep` never unlinked a tmp it successfully RELOCATED.** A successful
   `protectOccupantContentBeforeDelete` call durably copies a foreign tmp's content to a brand-new,
   disjoint pending-divert filename, but — on success — never self-references the ORIGINAL tmp's basename
   into anything's `orphanLatchFiles` (only a double-fault failure branch does that). The original file was
   left on disk, unreferenced, for the (previously unconditional) trailing sweep to clean up. Once the
   trailing sweep became content-checked, it had no way to know this exact tmp's content was ALREADY
   durably duplicated elsewhere, and kept it forever as a harmless-but-needless duplicate (regressed
   `merge-quarantine-4913e721-provenance-unknown-survives-protect.mjs`'s own `tmp-residue-site-pending-
   twin-carries-mark` scenario). Fixed: after a successful relocate (`r.ok && r.relocated`), unlink the
   original tmp directly inside `protectForeignTmpResidueBeforeSweep`'s own loop — mirroring `92c645cc`'s
   "sweep only after a superseding write succeeds" rule, applied locally.
2. **The content-checked branch's own successful delete never cleared a stale `keptUnreadableLatchFiles`
   mark** — the unconditional branch already did this (`if (unlinkConfirmed) keptUnreadableLatchFiles.
   delete(f)`), but the content-checked branch's own final `fs.unlinkSync` had no equivalent. Fixed to
   match the unconditional branch. **This is regression-avoidance, not merely defensive consistency:**
   on `main`, THIS SAME call site ran the unconditional branch (which already cleared the mark on a
   confirmed delete) before this card switched it to content-checked — so without this fix, switching
   modes would have silently REMOVED a mark-clearing guarantee `main` already provided at this exact
   call site, not merely left an unrelated inconsistency in place. **Correction (round 2, Code Review):**
   this record
   originally (mis-)attributed `merge-quarantine-boot-hardening.mjs`'s own WFR-2/3/4 regression to this
   specific gap. That attribution was WRONG — re-verified directly by reverting ONLY this fix (restoring a
   bare `fs.unlinkSync` with no mark-clearing) while keeping every other round-1/round-2 fix in place: the
   full 75-file corpus still passed, 0 failures, including WFR-2/3/4. The REAL cause of that regression was
   round 1's own flat, cross-file `ownTokens` leak (see "Round 2" below) — WFR-2's own fixture is a
   same-identity stray tmp with an "unaccounted" token, exactly the shape `ownTokens`/`ownTokensByFile`
   exists to cover, independent of this mark-clearing fix entirely. **No test discriminates this
   mark-clearing fix** through any currently-reachable call path — see "Round 2" below for why, and this
   record keeps it anyway as a defensive consistency fix (matching the unconditional branch's own
   established convention), not as a claimed-tested behavior change.
3. **A `keptUnreadableLatchFiles`-marked tmp's own re-ingest proof was computed and then discarded.** When
   `sweepTmpResidueForHashIfUnreferenced` re-ingests a marked basename (`reconcileClearedEntryIfPlaceholder`
   + `markedFinalFullyCoveredByClear`, `656fdf39`'s own mechanism) and proves `dischargeable:true`, the
   RECONCILED entry's own tokens (read from THIS SAME file, genuinely verified, never a guess) were never
   fed into the LATER `orphanSweepSafeToDelete` call for that same file — which still ran only against the
   OUTER, now-stale `candidateTokens` the caller minted before this file was ever re-read (e.g. a
   placeholder's own random UUID token, not the real on-disk token the reconcile just proved). Regressed
   `merge-quarantine-boot-unreadable-vs-corrupt.mjs`'s own `human-clear-after-unreadable-tmp-readable-does-
   not-rearm` scenario: a readable-again tmp whose placeholder had a different, synthetic token than its
   own real content. Fixed: the per-file `reconciled.tokens` (when the dischargeable branch ran) are now
   unioned into the candidate set for THIS FILE's own `orphanSweepSafeToDelete` call — never globally,
   never for any other file in the same sweep.

All three were found and fixed by running the full `merge-quarantine*.mjs` corpus after each fix, never by
this card's own new scenarios alone — consistent with this module's own repeated "Do not trust a fix
verified only against its own new scenario" rule (see `d2582692`'s and `4b6c8d24`'s own records).

## The residual: FAIL-OPEN AT RUNTIME until the next reboot (not merely "bounded") — PARTIALLY CLOSED, see the Update below

The conservative, fail-closed default for `candidateTokens` when `clearedEntry` is `undefined` (nothing
active at this particular key) is an empty array — meaning a legitimately-foreign, currently-resolvable
tmp with no `clearedEntry` context is now KEPT, correctly. **Update (card `25d0d45b`): for a kept tmp
whose content is genuinely ARMABLE (parses with a string `repoPath`/`branch`/`reason`) and not the
clearer's own excluded identity, it is no longer merely sitting on disk unenforced — it is now armed
in-process IMMEDIATELY, closing this exact window.** The paragraphs below describe the PRE-`25d0d45b`
state and remain accurate for the shapes `25d0d45b` does NOT cover: a read-failure keep, a keep with no
parseable `repoPath` (neither shape ever produces an armable record), a kept file attributed to the
clearer's OWN identity (never armed, by design — see `25d0d45b`'s own record), or a keep whose identity
(or canonical key) is already represented elsewhere in this process (the same conservative
already-enforced/key-occupied skip `1dd00dca` established for the `.json` orphan case). For those
remaining shapes, **state the residual plainly as FAIL-OPEN AT RUNTIME, never merely "bounded" or
"self-healing" without that qualifier"** — round 1 of this record undersold the residual by leading with
the recovery property instead of the open window it follows.

**Confirmed, empirically, that a RESTART closes the window.** Simulated the post-fix state directly (the
clearer's own final removed, the foreign tmp surviving, nothing else armed at that key) and ran the REAL
`reenterMergeQuarantinesAtBoot` against it: PASS 1b's early-exit shortcut does not fire (no clean final
exists to parse at that key once the clearer's own record is gone), so the tmp falls into the GENERIC
(non-early-exit) recovery parse, which treats a resolvable, readable tmp-sourced entry as a genuine
recovery candidate and arms/unions it properly — observed log: "recovered a torn-write quarantine latch
... re-armed as the full union." The tmp file itself is then promoted to a real `final` and removed, not
left stranded.

**Correction (second Code Review, probes v9/v9b): a same-identity re-raise does NOT recover the kept tmp
— only a RESTART is a verified true recovery.** The round-2 text above claimed a re-raise "recovers as
the union," attributed to the reviewer's own measurement; that attribution was itself never independently
re-verified at the time, and a later, direct measurement on this record's own main repro shape (resolvable
`D = R/g` with no own `.git`, `D-tmp` holding `[D-ONLY]` kept by `clear(R)`, then
`enterMergeQuarantine(D)`) shows the opposite: the new final holds ONLY D's fresh token, `D-ONLY` is NOT
unioned into it, and the old, kept tmp stays on disk exactly as it was. Independently re-confirmed directly
(same shape) before writing this correction.

So a re-raise does not close the window — it merely RE-BLOCKS D, but under its NEW token, while D's OLD
token stays silently unenforced on the stale, kept tmp. Two further consequences follow directly from
that, neither hypothetical: a token-scoped release of the NEW token (e.g. the caller believing D's
quarantine is now fully resolved) REOPENS the exact same unenforced window the original clear left open,
since nothing about releasing the new token touches the old tmp at all; and a LATER identity-wide
`clear(D)` sweeps that stale tmp as D's own residue (per the `ownTokensByFile`/WFR-2 mechanism above) with
NO disclosure of what was just discarded, since it was never attributed to anything live.

**Only the RESTART escape (verified above) is a confirmed true recovery.** Between a clear and the next
restart, a legitimately-kept, currently-unowned tmp sits inert and genuinely unenforced — the same "kept,
not swept" posture this module already documents elsewhere (`bde5d1fe`'s own "PASS 1b recovers it at
boot; CLEAR paths sweep it instead" framing). A same-identity re-raise does NOT shorten that window; it
can lengthen the PRACTICAL exposure (the re-raise's own fresh quarantine can itself be fully resolved and
walked away from before a restart ever happens, with the stale token never recovered at all until one
eventually occurs). This is NOT independently verified for every possible lifecycle shape beyond the one
directly-tested escape above.

## Round 2 (Code Review `7130eb9f`) — two BLOCKING majors, both found by the reviewer's own probes

**BLOCKING 1 — `ownTokens` was a FLAT list, merged into ONE candidateTokens array shared by every file in
the sweep, so a same-identity stray tmp's own tokens could wrongly cover a DIFFERENT, genuinely foreign
tmp's own check.** Repro (reviewer's own, reproduced independently): plant D-tmp (foreign, resolvable,
tokens `[D-ONLY]`) and R-stray-tmp (same identity as the clearer R, tokens `[R-STRAY, D-ONLY]` —
coincidentally also naming D's own token) at the same hash. `clear(R)` deleted BOTH, with nothing reported
for D — round 1's own `protectForeignTmpResidueBeforeSweep` collected R-stray's tokens into a flat
`ownTokens: string[]`, which the caller merged into the ONE `candidateTokens` array passed to EVERY file's
own `orphanSweepSafeToDelete` check in the trailing sweep — so D-tmp's own check saw `D-ONLY` as "covered"
purely because R-stray's unrelated file happened to also name it.

**Fix:** `protectForeignTmpResidueBeforeSweep` now returns `ownTokensByFile: Array<{sourceFile, tokens}>`
— each entry tagged to the EXACT file its tokens were read from. `sweepTmpResidueForHashIfUnreferenced`
gained a REQUIRED `ownIdentityTokensByFile` parameter (pass `[]` where not applicable — the other 4
pre-existing call sites all do) and, per file, looks up `ownIdentityTokensByFile.find(e => e.sourceFile
=== f)`, applying ONLY that file's own tokens to that file's own check — mirroring
`reconciledPlaceholderTokens`'s pre-existing, identical per-file discipline (round 1 already got THAT one
right; this is the same principle applied to the sibling mechanism round 1 got wrong). Verified: the exact
repro above now keeps D's tmp (reported via `contentKeptRepoPaths`) while still sweeping R-stray's own tmp
(the intended, unaffected WFR-2 behavior for genuine same-identity residue).

**BLOCKING 2 — `contentKeptEntries` (content-parsed, no live entry behind them) were folded into `kept`,
which every caller treats as `stillBlockedCoOccupants` — a channel that implies a working `{id}` clear-by-
id route.** This contradicts `0a783fb2`'s own, pre-existing rule (`keptContentRepoPaths` must never join
`stillBlockedCoOccupants`) and `182c01cc` round 5's own guarantee that a `stillBlockedCoOccupants` entry's
offered route actually works: a content-kept tmp has no live record at all, so the `{id}` a caller might
construct from it resolves to nothing — the human-facing clear report told the human D was "still blocked"
with a route that does not work, while D was actually unenforced at runtime (exactly the residual named
above).

**Fix:** `deleteMergeQuarantineLatchByKey` now returns a separate `contentKept: Array<{repoPath,
sourceFile}>` field, populated ONLY from `trailingSweep.contentKeptEntries` — never folded into `kept`.
All 3 real callers (`clearMergeQuarantineByKey`'s two loops, `clearMergeQuarantineByRecordedPath`'s pending
loop) now fold `r.contentKept` into their own pre-existing `keptContentRepoPaths` map/set (the SAME
chokepoint `foldOrphanSweepResult`'s own content-keep path already feeds for the `.json`-orphan case) —
never into `keptReferencingRepoPaths`. Verified: the same BLOCKING-1 repro's own `clearResult` now shows D
in `contentKeptRepoPaths` ONLY, with `stillBlockedCoOccupants` empty — no non-working route offered.

**Nit — the dead `unconditional-owner-protected` mode and its branch were deleted.** Every production call
site had already migrated to content-checked coverage before this card even started (it was the LAST
one); nothing was left to justify keeping a zero-content-check deletion path reachable at all.
`sweepTmpResidueForHashIfUnreferenced`'s own `policy: TmpSweepPolicy` wrapper was simplified away too —
with only one mode left, the discriminated union added nothing; the function now takes a plain
`candidateTokens: string[]` parameter directly.

**Nit — a misleadingly-labeled assertion.** The `clear-undefined-clearedentry-...` scenario's own first
check was labeled "(undefined-clearedentry) precondition," but it asserts that D's tmp SURVIVES the FIRST
clear — on pre-fix code, that same first clear's own unconditional sweep would have destroyed D's content
blind (same shape as the main resolvable scenario). Relabeled as a `*** THE FIX ***` assertion.

**Investigated, not added: a dedicated test for companion fix 2 (the `keptUnreadableLatchFiles` mark-
clearing fix, round 1).** Reverting ONLY that fix (restoring a bare `fs.unlinkSync` with no mark-clearing,
every other round-1/round-2 fix left in place) and re-running the full 75-file corpus produced ZERO
failures. Traced why: `markedFinalFullyCoveredByClear` (the shared re-ingest-coverage helper
`sweepOwnLatchFileUnlessOwnedElsewhere` and the trailing sweep's own re-ingest branch both call) already
treats ENOENT/EISDIR — i.e. "the file is already gone" — as trivially covered, REGARDLESS of the mark or
of `candidateTokens`'s own value; and `protectForeignTmpResidueBeforeSweep`'s own directory scan
(`fs.readdirSync`) structurally never revisits a basename that no longer exists on disk at all. Every real
call site that re-queries a basename after this fix's own confirmed delete either (a) never happens, since
nothing re-lists a deleted file, or (b) independently self-heals via that SAME ENOENT-is-covered rule,
with or without this fix's own explicit mark-clear. The two call sites that pass NO `candidateTokens` at
all to `sweepOwnLatchFileUnlessOwnedElsewhere` (which would skip that self-heal) live in an unrelated
divert/write-failure path this card's own fix cannot reach. **Conclusion: this fix is kept — it is
regression-avoidance for this exact call site's own pre-existing `main` behavior (see above), not merely
a defensive consistency change invented from nothing — but, with no currently-reachable scenario left in
the CURRENT call graph that still discriminates it, it is recorded here rather than silently claimed as
tested.**

## Accepted trade-off (second Code Review, probe v4): an unattended token-scoped full lift can now
over-block where `main` swept blind

`clearActiveEntryTokenAtKey` (`~:3846`) is `clearMergeQuarantineByToken`'s own helper for the case where
dropping ONE token leaves the entry with none — a FULL lift reached via the TOKEN-scoped route, never
identity-wide (`identityWideHumanClear:false` on this path, exactly like `clearMergeQuarantineByToken`'s
other call sites to `deleteMergeQuarantineLatchByKey`). If the CLEARER's own stray tmp, sharing this same
key's hash, holds a token that is neither currently in memory (not in `clearedEntry.tokens`) nor
tombstoned (not in the global `clearedTokens` set) — e.g. prior-boot residue this process never folded
into anything — this card's own fix now KEEPS it (`contentKept`, naming the clearer itself) where `main`'s
unconditional sweep would have destroyed it blind. The NEXT reboot then re-arms that identity from the
kept tmp: a FAIL-CLOSED over-block (the identity reads quarantined again, needing a human clear) for
residue that boot itself never had a chance to recover, since it was never destroyed to begin with.

**ACCEPTED, not a defect.** This is the direct, intended consequence of gating same-identity "own
latitude" strictly on `identityWideHumanClear` (see the "Do not" bullet above) — a narrower, token-scoped
clear is deliberately never trusted to sweep a same-identity stray tmp it cannot independently verify is
genuinely accounted for, even when the stray tmp belongs to the SAME identity doing the clearing. The cost
is an occasional, human-resolvable over-block on an already-rare shape (prior-boot residue surviving past
whatever boot recovery already ran); the alternative (treating a token-scoped clear's own identity match
as sufficient latitude) would reopen exactly the "unrelated, still-outstanding token destroyed as
collateral" hazard the `identityWideHumanClear` gate exists to prevent in the first place.

## Interaction with card `58ae4b34` (contributor enforcement) and card `2a169469` (queued after, not
touched here)

`58ae4b34` landed on `main` while this card was checkpointed, widening `ownIdentityEntryFor` to also match
an entry's own `contributorRepoPaths`. This card's own fix needed NO changes on that account: every
candidate-token computation here is purely TOKEN-based (`clearedEntry.tokens`, a tmp's own on-disk tokens,
a reconciled entry's own tokens), never identity-based — and `82032b5c`'s own contributor-fold mechanism
already bakes a contributor's own raised token directly into its host's `entry.tokens` at raise time (the
`existing` branch's `baseEntry.tokens = [...existing.tokens, token]`), so a contributor's successfully-
written token is already naturally covered by `clearedEntry.tokens` with no special-casing needed here. A
contributor whose OWN write failed (stranding its own tmp before ever folding in) is handled exactly like
any other foreign, uncovered token — correctly kept, not swept blind — regardless of whether the foreign
identity happens to be a contributor or a wholly unrelated one. Card `2a169469` (contributor-aware clear
*disclosures* — `liftedRepoPaths`/`stillBlockedCoOccupants` reporting) is queued on this file after this
card; nothing here was deliberately shaped to make that harder — in particular, the trailing sweep's own
previously-discarded `keptEntries` are now properly folded into `kept`/`stillBlockedCoOccupants`, and its
`contentKeptEntries` into the SEPARATE `contentKept`/`contentKeptRepoPaths` channel (round 2 — see above),
rather than either being left silently dropped, or the two being conflated, as before.

## Do not

- Do not trust a comment claiming a sibling function "already" covers a case without checking that
  sibling's own exclusions — `protectForeignTmpResidueBeforeSweep`'s two exclusions (resolvable-skip,
  no-string-`repoPath` skip) are deliberate and documented, but they do NOT make the comment's "already
  content-protected above" claim true for those two shapes.
- Do not read the card body's own literal "unresolvable-when-raised, EPERM" wording as the exact repro
  mechanism to reproduce — it is not reachable via a live `enterMergeQuarantine` call (see `d4b25feb`'s own
  "Do not" bullet). The real, exploitable surface is shape-agnostic: any foreign tmp at a shared key's
  hash, however it got there.
- Do not fold `protectForeignTmpResidueBeforeSweep`'s own same-identity tmp tokens into the trailing
  sweep's candidate set for anything OTHER than a genuine identity-wide human clear
  (`identityWideHumanClear`) — a narrower, token-scoped clear must never get this latitude, or an unrelated
  outstanding token for the SAME identity this process never independently learned about could be
  destroyed as collateral.
- Do not return (or merge) `protectForeignTmpResidueBeforeSweep`'s own same-identity tokens as a FLAT,
  cross-file-mergeable list ever again (round 1's own defect) — keep them PER-FILE
  (`ownTokensByFile`/`ownIdentityTokensByFile`), applied ONLY to the exact `sourceFile` they were read
  from. A flat list lets one file's own tokens wrongly "cover" a totally different, genuinely foreign
  file's own check, purely because the two happen to share a token value (round 2, BLOCKING 1).
- Do not fold a `contentKeptEntries`/`contentKept` outcome into `kept`/`keptReferencingRepoPaths` — it has
  no live entry backing it (`0a783fb2`'s own pre-existing rule), so it must flow into
  `keptContentRepoPaths`/`contentKeptRepoPaths` only. Folding it into `kept` reports a content-only keep
  as `stillBlockedCoOccupants`, implying a working `{id}` clear-by-id route that does not exist (round 2,
  BLOCKING 2).
- Do not let `protectForeignTmpResidueBeforeSweep` leave a successfully-RELOCATED tmp's own original file
  on disk — unlink it immediately after `r.ok && r.relocated`, or a later content-checked sweep (lacking
  any memory of the earlier relocate) keeps it forever as a redundant duplicate.
- Do not let a content-checked sweep's own confirmed delete leave a stale `keptUnreadableLatchFiles` mark
  behind — clear it on confirmed delete, exactly like the unconditional branch already does, or a LATER
  query against the same (now-gone) basename reads the ghost mark and wrongly reports it kept.
- Do not discard a `keptUnreadableLatchFiles` re-ingest's own `reconciled.tokens` once `dischargeable` is
  proven true — those tokens were just read from THIS SAME file and are real, verified coverage for it;
  feed them into that file's own `orphanSweepSafeToDelete` call, never only the outer, now-stale
  `candidateTokens` the caller minted before this file was ever re-read.
- Do not trust a fix in this area verified only against its own new test scenarios — all three companion
  fixes above were found ONLY by running the full `merge-quarantine*.mjs` corpus (both env states) after
  each change, never by this card's own new file alone.
- Do not describe the runtime residual as merely "bounded" or "self-healing" without the FAIL-OPEN-AT-
  RUNTIME qualifier (round 2) — the content is genuinely unenforced between a clear and the next restart;
  name that plainly before naming the escape. **(Card `25d0d45b`)** — this now applies ONLY to the
  shapes `25d0d45b` left open (read-failure, no-`repoPath`, own-identity, key-already-occupied); for an
  armable, foreign, unoccupied-key keep, the window is closed in-process immediately — say so instead.
- Do not claim a same-identity re-raise recovers a kept tmp "as the union," and do not relay a measurement
  (your own or another party's) into this record without independently re-verifying it first — a same-
  identity re-raise only RE-BLOCKS the identity under a FRESH token; the old, kept tmp's own old token is
  never unioned in and stays unenforced on disk (second Code Review, probes v9/v9b, independently
  re-confirmed). This record itself briefly carried the wrong claim for exactly this reason.
- Do not conclude "this fix needs no test" from "reverting it alone leaves the corpus green" without
  first tracing WHY — the mark-clearing companion fix's own why (ENOENT/EISDIR is trivially covered
  everywhere this basename could plausibly be re-queried, and a deleted basename is never re-listed by a
  directory scan at all) is itself the finding worth recording; an unexplained green is not the same
  claim as a traced one.

## Tests

`packages/daemon/test/merge-quarantine-1fea8b15-tmp-sweep-content-check.mjs` — eight scenarios:
`clear-resolvable-foreign-tmp-protected` (the main finding, now asserting the EXACT `contentKeptRepoPaths`
channel with no `||`, plus an explicit "not in `stillBlockedCoOccupants`" check — round 2), `clear-
unresolvable-foreign-tmp-still-protected` (control — content durably protected via relocation into
`stillBlockedCoOccupants`, the EXACT opposite channel from the resolvable case, asserted exclusively —
round 2; and the now-redundant original is cleaned up per the companion fix above), `clear-ownTokens-
never-leak-cross-file` (round 2, BLOCKING 1's own repro — a same-identity stray tmp's tokens must never
cover a different, genuinely foreign tmp sharing the same hash), `clear-no-repopath-tmp-protected` (the
second named gap), `clear-still-sweeps-pure-subset-tmp` (positive control — common case unchanged),
`clear-undefined-clearedentry-keeps-foreign-tmp-then-boot-recovers` (the conservative empty-candidateTokens
default, its first clear relabeled as a `*** THE FIX ***` assertion per round 2's own nit, plus the
boot-recovery proof), and two scenarios (`read-failure-vs-no-repopath-both-protected-for-different-
reasons`) closing the card's own named test gap — the `readFailed` vs "readable but no repoPath" split in
`orphanSweepSafeToDelete` (0 prior test hits for `readFailed` in this corpus) — distinguished via each
branch's own distinct log text.

RED→GREEN proven via `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-
quarantine.ts --test packages/daemon/test/merge-quarantine-1fea8b15-tmp-sweep-content-check.mjs`, re-run
after every round-2 fix: assertions fail RED against pre-fix `HEAD`, all pass GREEN after, tree restored
byte-identical.

**Round 2's own mark-clearing investigation** (not a scenario in the file — see "Round 2" above for the
full reasoning): reverted ONLY that one fix, kept every other fix in place, re-ran the full 75-file
corpus — 0 failures. Confirmed via code reading why: `markedFinalFullyCoveredByClear`'s own ENOENT/EISDIR-
is-trivially-covered rule self-heals every real re-query path reachable from this card's own call graph.

Full `merge-quarantine*.mjs` corpus (75 files) run file-by-file: 75/75 clean under the default env state
(`env -u LOOM_DEV -u LOOM_SUPERVISED`), and 75/75 clean under `LOOM_DEV=1 LOOM_SUPERVISED=1` (run in three
25-file batches). `pnpm --filter @loom/daemon guards` — 30/30 green (one working-tree-EOL violation on the
new test file itself, a bare-LF `Write`, was found and repaired before this run — converted to CRLF
directly, matching this repo's `text=auto` default; the file was not yet committed, so the usual
`git rm --cached`/`git checkout HEAD --` repair recipe did not apply).
