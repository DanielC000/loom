# 25d0d45b — arm a kept foreign `.tmp-residue` latch in memory at clear time

The `.tmp-residue` twin of `1dd00dca` (docs/decisions/1dd00dca-arm-foreign-orphan-latch-in-memory.md),
discovered by that card's own "Deliberately deferred" section. When `sweepTmpResidueForHashIfUnreferenced`
(merge-quarantine.ts) KEEPS a `.tmp-<pid>` residue because its content names a foreign repo T's real,
uncovered token, T was not enforced in-process until the next daemon boot — the exact same gap `1dd00dca`
closed for the `.json` orphan-latch sweep, left open here per `1fea8b15`'s own "FAIL-OPEN-AT-RUNTIME"
residual. Reproduced on current main via a hermetic scratch repro (own `LOOM_HOME`, real git repos)
before any fix was written: `assertRepoNotQuarantined(T)` read `{ok:true}` in the same booted module
instance right after a clear that kept T's own foreign, resolvable tmp — mirroring `1dd00dca`'s own repro
shape exactly.

## The fix

`sweepTmpResidueForHashIfUnreferenced`'s own content-kept branch now collects an `ArmableOrphanRecord` +
every contributing basename PER IDENTITY, across its WHOLE per-hash loop (`armableByIdentity`), and arms
each identity ONCE, after the loop, via `1dd00dca`'s own `armForeignOrphanContentInMemoryIfUnenforced` —
reused, never copied. The union is necessary (not merely convenient): boot's own PASS 1b batches and
unions every tmp sharing a key before arming (see "Why boot's own tmp recovery is NOT a simple per-file
arm" below), so arming only the first-processed file's own tokens would durably SPLIT this process's
in-memory state from what the next real boot would re-derive from the identical bytes — the exact shape
`1dd00dca` round 3 was corrected for on the `.json` side (never subtract a token the next boot would
still see on disk), now proven and closed on the `.tmp` side too (see the UNION test scenario below).

The helper's own signature widened additively: `basename: string` → `basenames: string[]` (so a union's
several contributing files can all land in the armed entry's own `orphanLatchFiles`), plus an optional
`kind: "orphan" | "tmp-residue" = "orphan"` used ONLY in the helper's own two log lines' wording — the
pre-existing orphan caller (`sweepOrphanLatchFileIfUnreferenced`) now passes `[filename]` (a 1-element
array) and stays otherwise byte-identical; nothing else about the helper's own gate, entry shape, or
disk-touching behavior (still none) changed.

## Why boot's own tmp recovery is NOT a simple per-file arm (investigated before any fix was written)

Boot's own `reenterMergeQuarantinesAtBootImpl` ("PASS 1b") batches every `.tmp-<pid>` residue sharing a
key hash (`tmpsToUnlinkByKey`, card `92c645cc`'s own "a key can carry MORE THAN ONE tmp") and unions them
via `armQuarantineKey`/`armKeyUnlessDegradedCollision` before a single deferred write — the SAME
freshness/eviction-dance machinery `1dd00dca` explicitly refused to replicate at runtime ("a correctness
minefield not worth opening"). This card does not replicate it either: the runtime union above is
strictly `armable.tokens` UNION across files sharing an identity, using the FIRST file's own
branch/reason/enteredAt as representative — this is sufficient because `assertRepoNotQuarantined`'s own
verdict depends only on WHETHER an entry exists for an identity, never on its exact branch/reason text,
and the required invariant (see the UNION test below) is stated on that verdict, not on byte-for-byte
entry equality with whatever boot's own eviction dance would eventually produce for a genuinely degraded
multi-identity collision (out of scope here, as it was for `1dd00dca`).

## The `excludeIdentities` gap — found during investigation, approved by the Lead before implementation

Unlike `sweepOrphanLatchFileIfUnreferenced`, which has always taken an `excludeIdentities?:
ReadonlySet<string>` param (every call site passes the identity/identities currently being cleared, so a
just-cleared identity's own stale content is never offered to the arm helper — `1dd00dca`'s own test
scenario (B)), `sweepTmpResidueForHashIfUnreferenced` had NO equivalent parameter. Of its five real call
sites (its own doc comment named only four — fixed, see "Do not" below):

1. `writeMergeQuarantineLatch`'s `sweepOtherTmpsOnSuccess` path — SAFE UNCHANGED. Verified empirically
   (two hermetic probes): the ONE real caller passing `sweepOtherTmpsOnSuccess:true`
   (`enterMergeQuarantine`'s `existing`/re-raise branch) always writes its own entry back into
   `activeQuarantines` at the SAME key either just before or as part of the very write that triggers this
   sweep, so `armForeignOrphanContentInMemoryIfUnenforced`'s own `stillBlockedEntryFor` gate always finds
   it already represented — "already-enforced", a correct no-op. Confirmed directly for both the
   brand-new-raise shape (where this sweep never even runs — `sweepOtherTmpsOnSuccess` is `false` there)
   and the re-raise shape (where it does run and correctly no-ops): one in-memory representation, in-
   process verdict === post-reboot verdict, in both probes.
2. `deleteMergeQuarantineLatchByKey`'s own trailing sweep — LOAD-BEARING. `clearMergeQuarantineByKey`'s
   own caller deletes `clearIdentity` from `activeQuarantines` BEFORE this sweep runs, for BOTH an
   identity-wide human clear AND a token-route full lift. For the TOKEN-route full lift specifically
   (`identityWideHumanClear:false`), `protectForeignTmpResidueBeforeSweep`'s own `ownTokensByFile` — which
   would otherwise unconditionally cover every on-disk token of a same-identity stray tmp — is
   deliberately WITHHELD from this call (`1fea8b15` round 2: "a narrower token-scoped clear must never
   get it"), so a same-identity stray tmp holding an uncovered extra token reaches this card's own
   content-kept+armable branch. Without excluding `clearIdentity`, this would re-arm the identity THIS
   EXACT CALL just fully lifted, in the same synchronous flow. Fixed: pass `new Set([clearIdentity])` —
   the identity is already in scope as this function's own required param.
3. `clearActiveEntryTokenAtKey`'s partial-clear branch (direct call, not via `deleteMergeQuarantineLatchByKey`)
   — SAFE UNCHANGED, same reasoning as (1): the reduced entry `updated` stays ACTIVE at this exact key
   through this call, so `stillBlockedEntryFor` always finds it first.
4. `clearMergeQuarantineLatchFile`'s own matchedPending branch — LOAD-BEARING. Every matched pending
   entry is removed from `pendingUnresolvedQuarantines` BEFORE this sweep runs; a same-identity stray tmp
   sharing the SAME pending-divert hash (used directly as this call's own `hash`/`id`) would resurrect the
   identity this exact REST clear-by-id call just lifted. The sibling `.json` sweep two lines above
   already excludes `matchedIdentities` for this exact reason — this call now passes the SAME set.
5. `clearMergeQuarantineLatchFile`'s own "no entry matches this id" fallback — SAFE, by construction:
   nothing in memory ever matched `id`, so there is no "own identity" to exclude.

New, OPTIONAL trailing parameter `excludeIdentities?: ReadonlySet<string>` (mirrors the orphan sweep's
own shape exactly); sites 1/3/5 pass nothing (byte-identical prior behavior), sites 2/4 pass the set
already in scope at their own call site.

## Investigated, NOT reachable as a RED test: identity-wide human clear by key (site 2, `identityWideHumanClear:true`)

Verified directly (not merely asserted): `protectForeignTmpResidueBeforeSweep`'s own `ownTokensByFile`
capture is UNCONDITIONAL — it captures EVERY on-disk token of a same-identity tmp, regardless of whether
that token overlaps the identity's own CURRENT raise — whenever `clearIdentity` is set, which it always
is for this route. So a same-identity stray tmp (even one holding a token outside the live raise) is
always either pre-accounted-for (safe to delete) or caught by the pre-existing "owners" ownership scan
before this card's own content-kept+armable branch is ever reached, for ANY identity-wide-clear-by-key
path. `excludeIdentities` is a correct, cheap, defensive backstop at this call site — never load-bearing
through any currently-reachable production route. The test file's own `(exclA, investigated)` scenario
pins this finding directly (a same-identity stray tmp holding an extra, non-raise token is swept CLEAN,
never kept, never armed, under an ordinary `clearMergeQuarantine`) rather than fabricating a RED case that
does not exist.

## Site #1 — verified empirically rather than assumed safe

Per the Lead's own instruction: constructed the ACTUAL shape that calls `sweepOtherTmpsOnSuccess:true`
(a brand-new raise never triggers this sweep at all — only `enterMergeQuarantine`'s own `existing`/re-
raise branch does, confirmed by grep: exactly one call site in the whole module passes `true`) with the
raising identity's own stray same-key tmp already on disk. Result: exactly one in-memory representation,
no split between in-process and post-reboot verdicts, in both the brand-new-raise shape (sweep never
runs) and the re-raise shape (sweep runs, correctly no-ops via "already-enforced"). No change needed.

## Round 2 (Code Review `22016cca`) — two MAJORs, no blocking

The in-memory arm itself and the union's own boot-equivalence were both confirmed sound. Two reporting
defects, both PROBED (reproduced directly, not merely argued):

**MAJOR 1 — the clear result MISREPORTED an armed identity as content-kept.** Repro: raise R; plant a
tmp for D=R/ghost (no own `.git`, so the SAME key K) holding an uncovered token; `mkdir` D;
`clearMergeQuarantine(R)`. Round-1 result: `{liftedRepoPaths:[R], latchKept:true,
contentKeptRepoPaths:[D], stillBlockedCoOccupants:[]}` — yet `assertRepoNotQuarantined(R)`, queried
immediately after, STILL REFUSES: R's own clear just ran this card's new arm phase on D's kept tmp, and
because D shares R's EXACT canonical key K, `assertRepoNotQuarantined(R)`'s own key-based lookup finds
D's newly-armed entry sitting at that key and reports R quarantined again — an operator who just
successfully lifted R sees it reported as un-lifted on the very next query, with the result's own
`contentKeptRepoPaths` giving no hint that anything is now a REAL, live block rather than a mere
disclosure. `1fea8b15` round 2's own premise ("a content-kept entry has no live entry backing it, so it
must never be reported as a blocked co-occupant") stopped being true the instant this card starts arming
content from inside that same function — the premise was correct when written, and broke only because
this card changed what "kept" can now mean.

**Fix:** `armResultIsLiveReferencer(armResult)` — ONE new shared predicate, called identically from both
`sweepOrphanLatchFileIfUnreferenced` (the `.json` orphan path, `1dd00dca`'s own) and
`sweepTmpResidueForHashIfUnreferenced` (the `.tmp` path, this card's own) — is `true` for `"armed-active"`/
`"armed-pending"`, `false` for `"already-enforced"`/no-arm-attempted. When `true`, the repoPath is routed
into `referencingRepoPaths`/`keptEntries` (the SAME channel a true, pre-existing in-memory referencer
already uses), never `contentKeptRepoPath`/`contentKeptEntries`. Every caller's own pre-existing fold
logic already turns a true referencer into a working `stillBlockedCoOccupants` entry — no caller-side
change was needed once both sweep functions report the arm outcome correctly. For the `.tmp` side, since
the union arm phase runs AFTER the whole per-hash loop (see "Why boot's own tmp recovery..." above), each
file's own final disposition (content-kept vs live referencer) is now DEFERRED (`deferredArmableKept`)
until its own identity's arm outcome is known, then resolved in one pass.

Both the `.json` and `.tmp` paths got their own dedicated scenario (`merge-quarantine-25d0d45b-...mjs`'s
own REPORT-TMP/REPORT-JSON) asserting `result-says-blocked === assertRepoNotQuarantined-refuses`, AND
actually clearing the reported identity BY ITS OWN `{id}` route to prove the route genuinely works, not
merely that it's structurally present. `1fea8b15`'s own test file (`resolvable`/`ownleak`/
`undefined-clearedentry` scenarios) updated the same way — see "Tests" below.

**MAJOR 2 — the test simplification (the single-clear `undefined-clearedentry` scenario) silently
dropped coverage of a real, now-reachable behavior change.** With the ORIGINAL two-clear shape (R raised,
then cleared TWICE): the first clear arms D; the SECOND clear of R then finds D's own just-armed entry
occupying K (not `clearedEntry===undefined`) and — via the pre-existing, unrelated `1872935d` "a self-
clear by key can also release a co-located foreign occupant" mechanism — DURABLY releases D too:
`liftedRepoPaths` names both R and D, D's own tmp residue is deleted, and a later boot finds D unblocked.
Pre-fix, D never got far enough to be armed at all, so this exact path never existed — Round 2's own CR
showed the IDENTICAL end state (D durably released, unenforced) was already reachable pre-fix, via a
REBOOT landing between the two clears instead of a second in-process clear. So this is WIDENED EXPOSURE
from this card, not a new defect CLASS.

**Fix:** restored the original two-clear shape as its OWN scenario
(`clear-undefined-clearedentry-TWO-CLEAR-second-clear-durably-releases-D`), pinning the current,
disclosed behavior exactly as described above — kept ALONGSIDE the simplified single-clear scenario,
which still isolates the genuinely-undefined-`clearedEntry` shape on its own. The real mitigation for the
widened exposure is MAJOR 1's own fix, not a behavior change to the second clear itself: once D correctly
reports as a blocked co-occupant with its OWN working `{id}` route after the FIRST clear (never silently
as content-kept), an operator reading that result is handed the correct, deliberate route to clear D on
purpose — never steered into a second, unrelated clear of R that happens to release D as a side effect.

The CR's own MINOR (a PENDING arm inserted mid-`clearMergeQuarantineByToken` isn't re-visited by that same
call's own loop) is tracked separately on card `028837ad` — not touched here.

## Round 3 (re-CR `6e97c9da` on tip `b1d734c5`) — shrink the heuristic to ENFORCEMENT TRUTH, plus restored
## coverage

**BLOCKING (restored coverage):** Round 2's own MAJOR 1 fix (routing an armed outcome through
`referencingRepoPaths` instead of `contentKeptRepoPath`) had flipped EVERY pre-existing positive assertion
across the touched test files toward "referencing," including several that should have stayed
content-kept (a genuinely non-armable keep). Restored via two new scenarios, one per sweep
(COVERAGE-TMP/COVERAGE-ORPHAN in this card's own test file): a foreign tmp/orphan whose content is missing
`branch` (so {@link orphanSweepSafeToDelete}'s own `armableByPass1` gate can never arm it) must stay
`contentKeptRepoPaths` forever, never `stillBlockedCoOccupants` — proven RED under a scoped dist mutation
that forces the shared disposition predicate to always answer "blocked."

**MINOR 2/3 — the REAL defect this round fixes:** Round 2's own `armResultIsLiveReferencer(armResult)`
gate decided a kept file's disposition from THIS CALL's own arm *attempt* outcome alone — `"armed-active"`/
`"armed-pending"` → blocked, `"already-enforced"` (or no attempt) → content-kept. That conflates two
structurally different reasons an attempt can be unnecessary: genuinely nothing is enforcing this identity
(truly content-kept, MINOR 1/2's own restored coverage above), and a DIFFERENT identity's own entry is
ALREADY enforcing it right now via a shared canonical key (D2 co-located with D1 at key K — D2's own arm
attempt answers `"already-enforced"` the instant D1 is armed, yet D2 is now genuinely, actively blocked).
The old gate reported the second shape as content-kept — wrong, and exactly the shape `1fea8b15`'s own
residual text already disclosed as fail-open-at-runtime, now silently MISREPORTED as closed instead.

**The fix:** replace the arm-outcome gate with `repoPathIsLiveBlockedCoOccupant(repoPath)` — a thin,
shared, documented alias for `stillBlockedEntryFor(repoPath) !== undefined`, called AFTER the arm
attempt (the `.tmp` side's whole per-hash union arm phase; the `.json` side's own single attempt) has run.
This asks the real question — "is ANYTHING enforcing this identity right now" — rather than "did THIS
call's own attempt succeed." On the `.tmp` side, EVERY non-own-content attributed file (armable or not)
is now deferred to this same post-arm-phase check (`deferredAttributedKept`, widened from Round 2's
armable-only `deferredArmableKept`) — a non-armable sibling of an identity armed via a DIFFERENT file in
the same hash group now correctly reports blocked too, never dual-reported as content-kept alongside its
armed sibling (since both resolve the IDENTICAL, stable `stillBlockedEntryFor` answer for the same
repoPath — there is no window for them to disagree).

**Routing the `{id}`:** `blockedCoOccupantForReferencer` (the shared helper every caller already used to
turn a bare `referencingRepoPaths` membership into a working `{id}` route) is widened the same way: its own
"find repoPath's OWN entry" lookup (an exact `e.repoPath === repoPath` match) is replaced by the SAME
`stillBlockedEntryFor` peek — so D2, which never gets an entry of its own, still resolves to D1's own
entry's id (the one actually occupying their shared key) rather than a route with no `id` at all. Every
pre-existing, genuinely-own-entry case resolves to the identical entry either way (`stillBlockedEntryFor`
subsumes the narrower exact-match check for anything that already has its own representation) — this is a
strict widening, not a behavior change for any caller already relying on the old lookup.

**NITs:** (6) the `.tmp` sweep's own per-file "UNTOUCHED (left stale) ... fail-closed" log no longer fires
for an attributed, non-own-content file at loop time (its disposition isn't known until the arm phase
runs) — moved to the post-arm-phase resolution loop instead, where it correctly says either "now ARMED and
enforced" or "left stale/fail-closed," per file, matching the `.json` orphan sweep's own conditional
wording. (7) Every test-side `xCoOccupant.route.id` dereference across the touched test files (this card's
own, plus `1fea8b15`'s and `2a169469`'s) is now guarded — a RED run reports a FAIL at that check, never an
uncaught `TypeError` that aborts the process and hides every later scenario; the `21ec39e5` pending/raw
clear-by-id scenarios also gained an explicit route-id-presence assertion, not just a
`referencingRepoPaths` membership check. (5) `clearActiveEntryTokenAtKey`'s own token-route full-lift
summary log (~`:4752`) now also names a `kept` (never relocated) co-occupant — previously destructured from
`splitCoOccupants` and silently discarded, so an armed co-occupant surfaced through THIS specific call path
was logged nowhere at all.

**Out of scope, carded separately:** CR MINOR 4 (the `.json` orphan path arms per file rather than unioning
per identity the way the `.tmp` side does) and the `/clear` `liftedRepoPaths` truthfulness residual for an
identity whose OWN clear immediately re-occupies its shared key via a sibling's surviving content (see the
MINOR2 test's own note on why a round-trip clear-by-id there deliberately stops short of asserting the
cleared identity becomes unblocked — it provably cannot, while a co-located sibling's content still
occupies the same key; this is `assertRepoNotQuarantined`'s existing, correct ancestor-key-collapse
semantics, not a new residual).

## Round 4 (final re-CR `5ac3b82b` on tip `9513fe1c`) — a design correction, not an extension: Round 3's
## item 2 is WRONG when the blocking entry is an INDEPENDENT identity

**The defect PROBED:** Round 3's rule — "blocked if `stillBlockedEntryFor(X)`, routed to THAT entry's
id" — is correct only when the entry blocking X IS X's own content. When it is a wholly INDEPENDENT
identity Y (X = `Y/ghost`, no own `.git`, so X's real canonical key is always Y's), Round 3 still routed
X to Y's own id. Two concrete failures, both probed directly (not merely reasoned):
1. On `clearMergeQuarantine`/`clearMergeQuarantineLatchFile`, the kept-tmp path flows via
   `protectForeignTmpResidueBeforeSweep`'s own `r.kept` → the PLAIN `blockedCoOccupant(rp, sf)` (never
   the referencer-aware helper) at three sites — X's offered `route.id` ends up being the hash of R's
   OWN just-cleared key (`sf` is R's own tmp residue, not X's), a DEAD route: nothing is armed there by
   the time an operator follows it.
2. Even where the id WAS a real, resolvable entry's id (Round 3's own D1/D2 shape, routing D2 to D1's
   id), following it lifts the WRONG identity (D1, not D2) while D2 itself stays fail-open in-process —
   an in-process/reboot split, with the report actively steering the operator into causing it.

**The corrected rule:** report a kept identity X as a BLOCKED CO-OCCUPANT with a clear route ONLY when
the entry backing that route is X's OWN entry (physical ownership of its own file, or an exact identity
match elsewhere in memory) — `blockedCoOccupantForReferencer`, REVERTED to its pre-Round-3, exact-match
contract. In EVERY other case X is CONTENT-KEPT (boot-deferred, exactly the ORIGINAL card's own ruling
for a key-occupied/already-represented T) — with an explicit `blockedBy: {repoPath, id?}` disclosure
naming whichever DIFFERENT identity's own entry is refusing X right now, when one exists. Clearing that
OTHER identity's own route never releases X — the disclosure's own wording says so.

**The fix:** one shared classifier, `classifyKeptRepoPath(repoPath, sourceFile)` — calls the (reverted)
`blockedCoOccupantForReferencer`; if it resolves a real `{id}`, X is live, and the resulting
`BlockedCoOccupant` is used AS-IS (never rebuilt via the bare `blockedCoOccupant`, which would reintroduce
defect 1 above for a `sourceFile` that isn't genuinely X's own file). If it resolves no id, `X` is
content-kept, and `stillBlockedEntryFor(X)` is consulted ONCE MORE to build the `blockedBy` disclosure
when something is in fact refusing X. Replaces Round 3's `repoPathIsLiveBlockedCoOccupant` (deleted)
inside both sweep functions' own disposition decisions, AND — the part Round 3 never touched — every
GENERIC "kept `{repoPath, sourceFile}` pair → final disposition" consumption site in the module:
`deleteMergeQuarantineLatchByKey`'s own return is unioned from TWO sources (`protectForeignTmpResidueBeforeSweep`'s
own double-fault `kept`, and the tmp sweep's own `keptEntries`) and both can carry a non-own-identity
entry, so classification must run again at the CONSUMER, never be assumed inherited from the producer.
Two shapes of fix, both load-bearing:
- `clearMergeQuarantineByKey`: a new shared `reclassifyNonLiveReferencing(referencing, contentKept,
  contentKeptBlockedBy, relocated)` helper mutates its own `keptReferencingRepoPaths`/
  `orphanReferencingRepoPaths` Maps in place, late, right before the final result is built — moving any
  non-live entry OUT of the "referencing" bucket and INTO "content-kept, with blockedBy" instead. The
  `relocated` exemption: a repoPath found both relocated (via `protectOccupantContentBeforeDelete`'s own
  successful relocate) AND kept under its old name always has its OWN freshly-MINTED entry (the relocate
  itself creates it), so that combo is always genuinely live and never needs reclassifying.
- `tryClearMergeQuarantineByOwnIdentity` already stored its OWN `keptReferencingRepoPaths` as
  `Map<string, BlockedCoOccupant>` (not bare sourceFile strings), fed from THREE sources: `kept` co-
  occupants forwarded from an already-fixed `clearMergeQuarantineByKey` call (safe — pre-classified
  upstream), `sweepOwnLatchFileUnlessOwnedElsewhere`'s own true-physical-ownership referencers (safe, by
  that function's own established contract), and its OWN separate `deleteMergeQuarantineLatchByKey` call
  in its pending loop (RISKY — same mixed provenance as `clearMergeQuarantineByKey`'s). Classified INLINE
  at that one risky fold site, since the Map there already stores built `BlockedCoOccupant` values rather
  than raw sourceFile strings. `clearMergeQuarantineLatchFile`'s own matched-pending and raw-fallback
  branches needed NO classification fix at all — every repoPath they fold into `keptCoOccupants` already
  comes from a sweep function's own ALREADY-classified `referencingRepoPaths`/`keptEntries`, or from
  `sweepOwnLatchFileUnlessOwnedElsewhere` (always physical ownership) — only the missing `blockedBy`
  THREADING needed adding at every one of their own `contentKept*` folds, mirroring the other two.

**The disclosure plumbing:** a new `ContentKeptBlockedBy = {repoPath, id?}` (the blocker) and a wrapper
`ContentKeptBlockedByEntry = {repoPath, blockedBy}` (which content-kept identity the disclosure is FOR —
required because a single clear result can content-keep more than one repoPath, so the bare disclosure
alone is ambiguous without it) are threaded as a NEW, additive `contentKeptBlockedBy?:
ContentKeptBlockedByEntry[]` field alongside the existing `contentKeptRepoPaths?: string[]` on every
exported clear-result-returning function (`clearMergeQuarantineByKey`, `clearMergeQuarantine`,
`clearMergeQuarantineByRecordedPath` (delegates to `tryClearMergeQuarantineByOwnIdentity`, no own fix
needed), `clearMergeQuarantineReporting`, `clearMergeQuarantineLatchFile`). `foldOrphanSweepResult`
gained an optional 4th `blockedByOut?: Map<string, ContentKeptBlockedBy>` parameter, written only when
the folded sweep result actually carries one.

**Consequences, checked and pinned (test scenarios below):**
- MINOR3 (one identity behind an armable plus a non-armable tmp, or two orphan files, for the SAME
  identity): unchanged outcome — E's blocking entry IS E's own, so it is still reported blocked, exactly
  once. (Item b: the "exactly once" count can never fail — both `keptReferencingRepoPaths` and
  `keptContentRepoPaths` are repoPath-keyed Maps, so Map dedupe alone guarantees it; the REAL
  discriminator, kept as the headline assertion, is that E is never ALSO present in `contentKeptRepoPaths`
  — never dual-reported across the live/content-kept boundary.)
- D1/D2 at one shared key: D1 (whichever is armed first, genuinely its OWN entry) is blocked and routed;
  D2 is CONTENT-KEPT with `blockedBy` naming D1 — REVERSING Round 3's own (wrong) "both routed" result.
  The CR-measured convergence — following the reported routes frees BOTH in exactly 2 (follow-up) clears
  — is pinned directly: clearing D1's own route succeeds (`ok:true`) but does NOT, by itself, make D1's
  own PATH read unblocked (D1's canonical key is the SAME shared key, and D2's own surviving, uncovered
  tmp immediately re-arms the instant that key frees — ancestor-key collapse, not a bug); THAT SAME clear
  call's own result reports D2 as NOW genuinely live, with its OWN real route, since D2 gets armed by
  its own trailing sweep; following D2's newly-reported route (the second of the two follow-up clears)
  finally frees both. A fresh reboot run right after the FIRST clear (clearing R alone, no follow-ups)
  independently re-derives the same BLOCKED verdict for both D1 and D2 (boot unions both tmps into ONE
  entry at the shared key — it does not distinguish "D1" from "D2" as separate identities the way the
  in-process disclosure now does; the verdicts agree, the internal representation differs).
- The CR's own probe shape (NEW scenario): Y independently quarantined; X = `Y/ghost` (X's real
  canonical key is always Y's); X's own armable tmp sits at a WHOLLY DIFFERENT, unrelated repo R's hash
  (a stray/mismatched residue — R's own trailing sweep is what examines it, never X's own). Clearing R
  reports X as content-kept with `blockedBy` naming Y — NEVER a routed co-occupant — and R's own clear
  result never lifts, addresses, or otherwise names Y at all. Proven RED at tip `9513fe1c` (Round 3's own
  code): that code reported X as blocked and routed it to a dead id derived from R's own just-cleared key.

**Also (test-harness/doc/log items, final re-CR):**
- (a) `withDistMutation` (this card's own test helper) now reports a FAIL via the shared `check()` helper,
  never throws, when its own find-text is absent from the dist copy — a stale find-text used to crash the
  whole test process before any LATER scenario (e.g. MINOR2/MINOR3) got a chance to run at all.
- (d) the tmp sweep's own per-identity "is now ARMED and enforced" log (post-arm-phase resolution loop)
  no longer claims the arm just happened "now" unconditionally — `classification.live` can be true purely
  because a SAME-identity sibling tmp was armed earlier in this SAME loop; worded as plainly "ARMED",
  never "now ARMED".

## Do not

- Do not re-litigate any of `1dd00dca`'s own rulings for the shared helper — arm IN-MEMORY ONLY; never
  union into an existing representation; never replicate boot's own degraded-collision eviction dance;
  gate via the pure `stillBlockedEntryFor`, never a mutating resolve; call the helper only from inside the
  SAME synchronous decision that proved a file safe to keep. All carry over unchanged to the `.tmp` side.
- Do not revert `sweepTmpResidueForHashIfUnreferenced`'s own union collection (`armableByIdentity`) back
  to a per-file inline arm "to simplify" — see the UNION test scenario below for the real in-process/
  post-reboot split that regresses.
- Do not read the union collection-then-arm as reopening `1dd00dca`'s own "call the helper only inside
  the same synchronous decision" rule — the whole per-hash loop plus the post-loop arm phase is ONE
  synchronous function call with no `await`/timer/I/O callback anywhere in between; nothing can observe
  or mutate `activeQuarantines`/`pendingUnresolvedQuarantines` in the gap.
- Do not add `excludeIdentities` to call sites 1/3/5 (`writeMergeQuarantineLatch`'s success sweep,
  `clearActiveEntryTokenAtKey`'s partial-clear branch, `clearMergeQuarantineLatchFile`'s no-match
  fallback) "for defensive symmetry" without re-verifying the premise first — all three are safe today
  because the relevant identity stays represented in `activeQuarantines`/`pendingUnresolvedQuarantines`
  through the call; see "Site #1" above for how that was actually checked, not assumed.
- Do not assume `excludeIdentities` is load-bearing at site 2 for `identityWideHumanClear:true` — it is
  not, through any currently-reachable production path (see the dedicated section above); it remains
  correct as a defensive backstop, not as a claimed-tested-RED behavior.
- Do not describe the original two-clear shape as merely "not what the scenario means to test" without
  ALSO pinning what it actually does (Round 2's own fix) — it is RESTORED as its own dedicated scenario
  (`...TWO-CLEAR-second-clear-durably-releases-D`), kept alongside the simplified single-clear one, never
  dropped. Say plainly: the second clear durably releases D too (named in `liftedRepoPaths`, tmp deleted,
  unblocked after a later boot) — and that MAJOR 1's own fix (D reporting as a genuine blocked
  co-occupant after the FIRST clear) is what stops an operator being steered into that second clear by
  accident, not a behavior change to the second clear itself.
- Do not report a genuinely live-blocked outcome via `contentKeptRepoPath(s)` at EITHER sweep function —
  route it through `referencingRepoPaths`/`keptEntries` instead, via the shared `classifyKeptRepoPath`
  classifier (Round 4 — REPLACES Round 3's own `repoPathIsLiveBlockedCoOccupant`, which routed a
  co-occupant to WHATEVER entry blocked it, even a wholly independent identity's own — a dead or
  wrong-target route; see "Round 4" above). Do not let the two sweep functions, OR any of the module's
  generic "kept pair → disposition" consumption sites, diverge on this decision again.
- Do not gate a kept file's disposition on `armForeignOrphanContentInMemoryIfUnenforced`'s own return
  value (`"armed-active"`/`"armed-pending"`/`"already-enforced"`) ever again, at either sweep — that
  return only answers "did THIS call's own attempt succeed," never "is this identity blocked right now,
  and by its OWN content or a different identity's." Call `classifyKeptRepoPath(repoPath, sourceFile)`
  AFTER the arm attempt instead (Round 4).
- Do not defer a `.tmp`-residue file's `contentKeptEntries`/`keptEntries` push to BEFORE its own identity's
  arm phase has fully run — `deferredAttributedKept` (covers EVERY non-own-content attributed file,
  armable or not) exists precisely because disposition is decided from `classifyKeptRepoPath`, which can
  only be answered correctly once every identity sharing this hash has had its own chance to arm.
- Do not widen `blockedCoOccupantForReferencer`'s own lookup to `stillBlockedEntryFor` again (Round 3's
  own mistake, REVERTED in Round 4) — it must stay the exact-identity/physical-ownership match. Routing a
  co-occupant to an INDEPENDENT identity's own id is a dead route on every clear-by-id path, and following
  it (when it happens to resolve) lifts the WRONG identity. Use `classifyKeptRepoPath` to decide WHETHER
  to report a co-occupant as live at all; use `blockedCoOccupantForReferencer` only to build the route
  once that's already established.
- Do not convert a `protectForeignTmpResidueBeforeSweep`-sourced or tmp-sweep-sourced "kept `{repoPath,
  sourceFile}`" pair into a `BlockedCoOccupant` via the bare `blockedCoOccupant(rp, sf)` at ANY new
  consumption site — it blindly assumes `sf` is `rp`'s own physical file, which is false for exactly the
  shape this round fixes. Reclassify via `classifyKeptRepoPath`/`reclassifyNonLiveReferencing` first.
- Do not read `1fea8b15`'s "FAIL-OPEN AT RUNTIME" framing as fully retracted — it still applies, unchanged,
  to a read-failure keep, a no-`repoPath` keep, the clearer's own excluded identity, and a key already
  represented elsewhere. Only the armable/foreign/unoccupied-key shape is closed. See that record's own
  updated residual section.
- Do not trust `sweepTmpResidueForHashIfUnreferenced`'s own doc comment's claim of "four" call sites
  without re-grepping — it was stale (a fifth, `clearMergeQuarantineLatchFile`'s matchedPending branch,
  was missing); fixed in this card's own diff, but a future added/removed call site can drift it again.
- Do not assume clearing a co-occupant's own reported `{id}` route durably frees the SHARED canonical key
  when a sibling identity's own content still occupies it — the sibling's own surviving, uncovered tmp
  residue immediately re-arms the instant that key frees, so the key stays occupied either way UNTIL that
  sibling's own (now-live, now-reported) route is ALSO followed. **Round 4 correction:** do not read this
  as "2 clears can never fully free both" — they CAN and DO, in exactly 2 follow-up clears past the
  original clear that first disclosed them (MINOR2's own CR-measured convergence) — only the SINGLE,
  FIRST follow-up clear's own immediate aftermath leaves the shared key still occupied, by design.
- Do not omit `contentKeptBlockedBy` threading at a NEW `contentKeptRepoPaths`-returning site — the two
  fields are a matched pair (one names WHO is content-kept, the other discloses WHY/BY-WHOM, when known)
  and drift between them reopens exactly the "operator steered into a dead-end clear" shape this round
  closes.

## Tests

`packages/daemon/test/merge-quarantine-25d0d45b-arm-foreign-tmp-residue-in-memory.mjs`:
- (MAIN) a genuinely foreign, resolvable tmp residue is armed ACTIVE in-process immediately, asserted at
  the consumer (`assertRepoNotQuarantined`), same posture as `1dd00dca`'s own scenario (A).
- (EXCL-B) token-route full lift: the clearer's own stray tmp, holding an extra uncovered token, is
  content-kept but correctly NOT re-armed, verified in-process. RED PROOF via a scoped dist-copy mutation
  (same `withDistMutation` technique as `1dd00dca`'s own scenario (I)) stripping `excludeIdentities` at
  this exact call site — the SAME scenario then WRONGLY re-arms the clearer from its own content. The
  real `dist/git/merge-quarantine.js` is verified byte-identical before and after.
- (EXCL-C) REST clear-by-id matchedPending: same shape, for an unresolvable identity cleared by its own
  pending-divert hash, with a same-hash stray tmp residue. Same RED-proof technique.
- (EXCL-A, investigated, not a RED test) identity-wide human clear by key: pins the finding above directly
  — a same-identity stray tmp (extra token) is swept clean, never kept, never armed.
- (UNION) two SEPARATE foreign tmp residues for one unenforced identity T, sharing a hash: armed ONCE with
  the union of both files' own tokens (and both basenames in `orphanLatchFiles`). Releasing only the
  FIRST file's own token then asserts the governing invariant directly: T's in-process verdict ===
  its post-reboot verdict (both correctly still blocked on the second file's own outstanding token) —
  the real in-process/post-reboot split this scenario rules out, reproducible by reverting the union
  collection back to a per-file inline arm.
- A source-text pin confirming the function's own doc comment names FIVE call sites, not four.
- (REPORT-TMP, Round 2) the `.tmp` path's own MAJOR-1 proof: `clearMergeQuarantine` (not the token route,
  which returns no result) on an armed, resolvable, foreign tmp — asserts `result-says-blocked ===
  assertRepoNotQuarantined-refuses`, then actually clears the identity BY its own reported `{id}` to
  prove the route is genuinely working, not merely present.
- (REPORT-JSON, Round 2) the SAME proof for the `.json` orphan path (`sweepOrphanLatchFileIfUnreferenced`,
  owned by `1dd00dca`, whose own test file never exercises a `clearResult` object) — this card's own
  regression coverage for the shared disposition path on that side.
- (COVERAGE-TMP/COVERAGE-ORPHAN, item 1) a genuinely non-armable foreign keep (content missing `branch`,
  no key collision with anything) must stay `contentKeptRepoPaths` forever, never `stillBlockedCoOccupants`
  — RED-under-mutation proof via a scoped dist copy whose shared `classifyKeptRepoPath` always answers
  "live" (re-targeted in Round 4, since the predicate it mutates changed; `withDistMutation` itself now
  reports a FAIL rather than throwing when its own find-text is absent — item a).
- (PROBE, Round 4) the final re-CR's own probe shape: Y independently quarantined; X = `Y/ghost` (X's
  real canonical key is always Y's); X's own armable tmp sits at a WHOLLY DIFFERENT repo R's hash. Clearing
  R reports X as content-kept with `blockedBy` naming Y — never a routed co-occupant — and never lifts,
  addresses, or names Y at all. RED at tip `9513fe1c` (Round 3's own code wrongly routed X to a dead id).
- (MINOR2, Round 4) D1 and D2, two distinct foreign identities co-located at one shared canonical key via
  two separate torn tmps at the same hash: whichever is processed first is genuinely armed and reported
  live+routed; the OTHER is CONTENT-KEPT with `blockedBy` naming the winner (REVERSING Round 3's own wrong
  "both routed" result) — with a real id in the disclosure. Pins the CR-measured 2-clear convergence:
  following the winner's own route succeeds but does not by itself unblock the winner's own PATH (the
  loser's surviving tmp immediately re-arms at the shared key); that SAME clear's own result reports the
  loser as NOW live, with its own real route; following THAT route frees both. A companion scenario
  (MINOR2-REBOOT) confirms a fresh reboot right after the first clear alone independently re-derives the
  same blocked verdict for both (boot unions both tmps into one entry; the verdicts agree, the
  representation differs).
- (MINOR3-TMP/MINOR3-ORPHAN) one identity behind an armable tmp AND a non-armable tmp (or two orphan
  files) sharing the same hash/identity: unchanged outcome from Round 3 (E's blocking entry is its own).
  Item b: the "exactly once" count can never fail (Map dedupe) — the real, headline discriminator kept is
  that the identity is never ALSO present in `contentKeptRepoPaths` (no dual reporting across the
  live/content-kept boundary).

Every scenario cross-checks the pure `stillBlockedEntryFor` peek against the real, mutating
`resolveQuarantineFor` (via `resolveQuarantineForTestOnly`) for enforcement-equivalence, same posture as
`1dd00dca`'s own `crossCheck`.

`packages/daemon/test/merge-quarantine-1fea8b15-tmp-sweep-content-check.mjs` extended: the main
`clear-resolvable-foreign-tmp-protected` scenario, `clear-ownTokens-never-leak-cross-file`, and the
`clear-undefined-clearedentry-keeps-foreign-tmp-then-boot-recovers` scenario (simplified to a single
clear — R is never raised, see "Do not" above) each gained an in-process `assertRepoNotQuarantined`
assertion; the latter's boot leg is kept, now asserting in-process === post-reboot (no split) rather than
"boot is the only recovery." Round 2 (MAJOR 1) then flipped all three's own `contentKeptRepoPaths`/
`stillBlockedCoOccupants` assertions to the new truth (armed ⇒ a genuine, working-route blocked
co-occupant, never content-only) and added the explicit `result-says-blocked ===
assertRepoNotQuarantined-refuses` cross-check, plus a real round-trip clear-by-id proof on the main
scenario. Round 2 (MAJOR 2) also ADDED a new, dedicated
`clear-undefined-clearedentry-TWO-CLEAR-second-clear-durably-releases-D` scenario restoring and pinning
the original two-clear shape as current, disclosed behavior — kept alongside, never replacing, the
simplified single-clear one.

RED→GREEN proven via `pnpm --filter @loom/daemon negative-control --ref <pre-fix sha>`. All
`merge-quarantine*.mjs` run individually, serially, in both `env -u LOOM_DEV -u LOOM_SUPERVISED` and
`LOOM_DEV=1 LOOM_SUPERVISED=1`. `pnpm --filter @loom/daemon guards` green.

**Round 3 verification:** RED→GREEN re-proven via `node scripts/negative-control.mjs --file
packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-25d0d45b-arm-foreign-tmp-residue-in-memory.mjs
--ref HEAD` (HEAD at the time == tip `b1d734c5`, Round 2's own code) — RED against Round 2's code, GREEN
restored, tree byte-identical after. The full `merge-quarantine*.mjs` corpus (95 files, including this
round's own new/extended ones) run individually, serially, 95/95 clean in BOTH
`env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1 LOOM_SUPERVISED=1`. `pnpm --filter @loom/daemon guards`
— 31/31 green.

**Round 4 verification:** RED→GREEN re-proven via `node scripts/negative-control.mjs --file
packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-25d0d45b-arm-foreign-tmp-residue-in-memory.mjs
--ref 9513fe1c` (the EXPLICIT Round 3 tip, never `--ref HEAD`, per the final re-CR's own instruction) —
RED against Round 3's code (confirmed failing at the MAIN scenario's own first assertion, not vacuously),
GREEN restored, tree byte-identical after. The full `merge-quarantine*.mjs` corpus (95 files) run
individually, serially, 95/95 clean in BOTH `env -u LOOM_DEV -u LOOM_SUPERVISED` and
`LOOM_DEV=1 LOOM_SUPERVISED=1` (190 total runs, 0 failures). `pnpm --filter @loom/daemon guards` — 31/31
green.
