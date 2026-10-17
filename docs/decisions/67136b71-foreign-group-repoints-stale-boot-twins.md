# 67136b71 — the raise-divert branch's `foreignGroups` arm re-points a stale boot twin too, mirroring af948556

From the af948556 Code Review (session `bfa97ca3`) — that record's own "Do not" section explicitly
flagged `foreignGroups` (~L1526-1544) as "a SEPARATE, as-yet-untouched same-class candidate, carded
separately." This card is that candidate: code-read hypothesis, confirmed REACHABLE by a hermetic repro
(including a demonstrated fail-open, not merely an invariant violation), then fixed — the exact same
shape and fix as af948556, one branch over. Round 2 (Code Review `822fbfd0`, MERGE — independently
re-verified RED/GREEN in both env states): the fix stands unchanged; this round corrects the record's own
severity framing, tests list, sweep table, and reachability precondition against directly re-measured
evidence, after the ORIGINAL framing (below in spirit, not in the text that follows) understated or
mis-attributed several of them.

## Severity: a durable, silent loss of an outstanding token — masked only while a co-located token remains

In `consumeMatchedPendingsIntoArmedEntry`'s raise-divert branch (`skipDegradedOccupantGuard` true, the
fold-in read of the raiser's own fresh key returns `"unreadable"`), every matched pending index is
spliced out of `pendingUnresolvedQuarantines` at the top of the function. Pre-fix, the `foreignGroups`
arm (every OTHER identity canonically colliding at the raiser's key, as opposed to `ownGroup` — the
raiser's own identity, fixed by af948556) unioned a `group.length > 1` member's own matched entries into
a NEW `foreignUnion` object and pushed/durably-wrote it to pending — but never called
`replaceEntryEverywhere` for that group. If a foreign-group member is ITSELF an 883e29bc/64283e06 boot
twin (the SAME object reference also armed in `activeQuarantines` at its own stale/degraded key), that
active slot was left holding the STALE, pre-raise object.

Re-measured directly (fix reverted, `dumpDirState`-instrumented re-run of SCENARIO 2, both mid-sequence
and via a fresh-module boot re-entry immediately after the two clears below, before any further query):
clearing F's two ORIGINAL twin tokens one at a time (`clearMergeQuarantineByToken(f, fb)` then `(f, fc)`)
empties the STALE active-side object. Its own empty-sweep (mirroring af948556's own SCENARIO 2 mechanism)
ALSO sweeps the SEPARATE pending-side `foreignUnion` object's own backing file as an unreferenced orphan
— confirmed via the real `[merge-quarantine] deleted orphan latch ...` log lines this produces — even
though `foreignUnion` still logically carried the third, never-cleared token (`s2-tok-fd`). Immediately
after both clears, before any further query: **no file anywhere under `MERGE_QUARANTINE_DIR` mentions
`s2-tok-fd` any more**, and a genuinely fresh module instance re-entering boot from that same durable
state (`reenterMergeQuarantinesAtBoot([])`) never recovers it either — **the loss is DURABLE, not an
in-process-only artifact that a restart would heal.**

What this actually OPENS, precisely: **TOP itself stays BLOCKED** throughout — it has its own, separate,
never-cleared raise token, entirely unaffected by this bug. What opens is **S_F** — the real, unrelated
ancestor-donor repo F's own degraded entry was (over-)blocking at F's stale walked-up key — which
incorrectly reports unblocked once F's two original tokens are cleared, even though F's own third token
was never actually released, just durably lost. So long as F and TOP happen to be queried while TOP's own
separate token is still outstanding, the two repos read as "still blocked" and the loss stays invisible;
the real effect — S_F's over-block silently lifted, and F's own third raise permanently unenforceable —
is masked only by that co-located token, not fixed by it.

## The fix

`for (const p of group) replaceEntryEverywhere(activeQuarantines, p.entry, foreignUnion);`, added inside
the `foreignGroups.values()` loop's `group.length > 1` arm, right after `foreignUnion` is fully assembled
(post `orphanLatchFiles` merge) and before the group's own pending push/write — byte-identical shape to
af948556's own `ownGroup` fix, one branch over, and the same `c9114934` "replacement only, never a union
source" discipline.

## Reachability precondition

All of the following inside ONE synchronous `enterMergeQuarantine` call for a genuinely NEW raiser
identity (TOP) with no `existing` entry at its own key:

1. The raise's own early protect-before-write gate's detector read of TOP's own fresh key's final either
   fails with a non-ENOENT error on THIS call, OR that basename is already marked
   `keptUnreadableLatchFiles` from some EARLIER, unrelated failed read — either way, `protectOk` ends up
   `false` or the basename is already marked, and the mark survives into the next step.
2. `resolveRaiseOverwrite`'s own independent re-read (its "read #2") of that SAME final must SUCCEED, and
   with content that resolves to "proceed, don't divert" — in practice this means a REAL FILE must
   physically exist at TOP's own fresh key's final at this point (an ENOENT here also resolves to
   "proceed", but then step 3 below can never produce `"unreadable"` — see `reconcileMarkedBasenameBeforeWrite`'s
   own ENOENT branch, which returns the entry unchanged, never `"unreadable"`). The simplest reliable
   content is a record sharing TOP's OWN identity (same `repoPath`), which short-circuits `resolveRaiseOverwrite`
   via its same-identity branch without needing to reason about a foreign occupant's surviving tokens.
3. The fold-in read inside `consumeMatchedPendingsIntoArmedEntry` itself (its "read #3", via
   `foldInOnDiskTokensIfMarked` → `reconcileMarkedBasenameBeforeWrite`) must FAIL — landing the literal
   string `"unreadable"` and routing into the raise-divert branch under test.
4. A FOREIGN identity (≠ the raiser's) must have ≥2 matched pending entries at this exact moment — one of
   them (or more) an 883e29bc/64283e06 boot twin (the same object reference also armed in
   `activeQuarantines` at its own stale/degraded key), reachable as a cross-tier sibling of the raiser
   (card 7673d096's toplevel walk — e.g. a subdirectory of the raiser's own repo, or two separately
   registered paths that later turn out to be the same physical repo).

Step 1+3 together need the SAME physical final to be unreadable at the moment of the EARLY check (or
already marked from an earlier one) AND unreadable again moments later at the fold-in check — plausible on
Windows as an AV scanner or search indexer's transient `EBUSY`/lock flap landing on that exact file at (or
just before) that exact moment, but genuinely rare: this is real and durable when it happens, but low
likelihood. Step 4's own precondition (a foreign cross-tier sibling already carrying a pre-existing boot
twin) narrows it further — it is not something an ordinary single-repo raise can ever trigger.

## Sweep (card instruction, 2026-10-17): every multi-source merge/union construction site in this file

Grepped every `unionQuarantineEntries(` call site, every hand-rolled multi-entry merge (`.reduce(`/
`flatMap(` combining more than one source entry), and every `armQuarantineKey`/
`armKeyUnlessDegradedCollision` boot-time union wrapper, PLUS the standalone-entry re-insertion/fold
sites. Each row below either re-points every active slot that held the pre-merge object(s) via
`replaceEntryEverywhere`, is a single-entry evolution already paired with its own re-point, or is a
DELIBERATE standalone/dual-object push by design (not this card's re-union shape at all, so there is no
stale-slot risk to re-point in the first place).

| Site (function, line) | Shape | Status |
|---|---|---|
| `armQuarantineKey` (~L817-833) | boot-time union primitive, `prior`+`entry` | OK — `replaceEntryEverywhere(byRepoKey, prior, armed)` at L829, identity-gated (deliberately: a union across two DIFFERENT identities sharing one key must never auto-replace — see `fd189d91`/`a2f381dc`) |
| `consumeMatchedPendingsIntoArmedEntry` main/non-raise `unioned` (~L1458-1459) | lazy-graduation/sibling-absorb union | OK — `replaceEntryEverywhere` for every anchor (`extra` + every matched entry) at L1557-1561, L1565 |
| `consumeMatchedPendingsIntoArmedEntry` `ownGroup`/`raiserUnion` (~L1498) | raise-divert, raiser's own identity | OK — af948556's own fix, `replaceEntryEverywhere` at L1520 |
| `consumeMatchedPendingsIntoArmedEntry` `foreignGroups`/`foreignUnion`, `group.length > 1` (~L1536) | raise-divert, foreign identity, genuine re-union of ≥2 prior objects | **FIXED this card** — `replaceEntryEverywhere` added |
| `consumeMatchedPendingsIntoArmedEntry` `foreignGroups`, `group.length === 1` (~L1529-1532) | re-inserts the SAME, unchanged object (no new object created) | OK by construction — a re-point — nothing to point, since no new object exists |
| `protectOccupantContentBeforeDelete` `toWriteUnfiltered`/`kept` (~L2091, L2119) | union against on-disk occupant content | OK — both the write-failure (`kept`, L2127) and write-success (`toWrite`, L2150-2151/2157) branches re-point BOTH `atFilenameIdx` and `atFinalBasenameIdx` old entries |
| `unionIntoOnDiskPendingEntry` (~L2403), via `reconcilePendingDivertTarget` | unions a fresh in-memory `entry` against DISK-READ content | OK — never unions an in-memory object REFERENCE (always a fresh disk read on the "old" side), so there is no live reference to strand; its two callers (`mintPendingDivert`, `protectOccupantContentBeforeDelete`) already re-point their own `entry` input |
| `divertRaiseEntry` hand-rolled `merged` (~L2534-2563) | unions every same-identity pending match + the diverted raise itself | OK — `replaceEntryEverywhere` for every `matched` entry (L2562) AND the passed-in `entry` (L2563) |
| `mintPendingDivert` (~L2491-2516) | re-point on reconcile + double-fault safety-tmp fallback | OK — `replaceEntryEverywhere` at L2496 and L2510 |
| `mergeTokenIntoPendingEntries` hand-rolled `merged` (~L2191-2217) | unions every same-identity pending match (still-unresolvable raise) | OK — `replaceEntryEverywhere` for every `matched` entry (L2217) |
| `enterMergeQuarantine`'s `existing`-branch `baseEntry`/`entry` (~L2640-2665) | single-entry evolution (token append, on-disk token fold) of the ONE `existing` object | OK, re-point — `replaceEntryEverywhere` at L2646 (mustDivert path), L2657 (fold-unreadable path), and L2665 (the folded, successful read path) |
| `clearTokenFromPendingIndices` `updated` (~L2967-2974) | single-entry evolution (token removal) of a pending entry | OK, re-point — `replaceEntryEverywhere` at L2974 |
| `clearActiveEntryTokenAtKey` `updated` (~L3029-3039) | single-entry evolution (token removal) of an active entry | OK, re-point — `replaceEntryEverywhere` at L3039 |
| `sourcesOnlyUnion` (~L5273-5281) | unions migrate SOURCES for a degraded-occupied key's own safety-tmp content | **NOT write-only as this record's own prior revision claimed** — its result is pushed LIVE into `pendingUnresolvedQuarantines` at ~L5544-5547 (Phase 1b's own degraded-occupied fold, when a safety-tmp collision exists this pass). This is still OK: that push is a BRAND-NEW pending reference seeded with content that was never previously armed anywhere in `activeQuarantines` — there is no PRE-EXISTING live object of this exact union to strand, so there is nothing for a `replaceEntryEverywhere` to re-point. |
| Standalone per-source pending pushes at ~L5557 and ~L5582 (card 97cff6db) | deliberately SEPARATE, standalone entries (never a shared union) pushed alongside a degraded occupant's own fold | Dual objects BY DESIGN — a different, intentional shape (97cff6db's own "never union two identities one of which may need independent future resolution" rule), not this card's stale-twin-re-union shape at all |
| Boot PASS1/1b/2 single-entry folds (`trimmedPrior` L4583, `folded` L5456/5528/5650/5666, `armedForWrite` L5602, `updated` L5701) | single-entry field evolution (orphanLatchFiles/armedKeys trim, never a multi-entry merge) | OK, re-point — each already paired with its own `replaceEntryEverywhere` immediately after construction |
| `armKeyUnlessDegradedCollision`/`armCurrentKeyUnlessDegradedCollision` (many boot call sites) | wraps `armQuarantineKey` + its own eviction path | OK — delegates to `armQuarantineKey` (already covered) and its own eviction branch re-points via `replaceEntryEverywhere` at L4587 |

**Sweep conclusion, scoped precisely: of every site that constructs a NEW object by re-UNIONING ≥2
PRE-EXISTING, possibly-already-armed objects into one, af948556 (`ownGroup`) and 67136b71
(`foreignGroups`) were the only two that skipped the re-point** — both inside the same function's
raise-divert branch, which is exactly why they were carded as a pair. Every other site in the table is
either a single-entry evolution (re-points by construction, trivially in scope and already correct) or a
genuinely new object with no pre-existing live reference to strand (nothing to re-point, by construction)
— not a THIRD category of "safe because write-only," which this record's own prior revision
mischaracterized for `sourcesOnlyUnion`.

## Do not

- Do not call `replaceEntryEverywhere` with `foreignUnion` as a UNION SOURCE elsewhere in this branch —
  it is a REPLACEMENT target only, consumed by `group`'s own prior values (c9114934), same rule as
  af948556's own `raiserUnion`.
- Do not assume the `group.length === 1` arm needs a matching fix — it re-inserts the EXACT SAME,
  unchanged object reference (no new object is ever created there), so no active-side slot is ever left
  stale by it.
- Do not re-derive the sweep table above by grepping for `readdirSync` or any other single textual marker
  — it was built by reading each site's own code and its immediate neighbours, not by pattern-matching;
  a future change here needs the same manual check, not a regrep of this table's own wording.
- Do not report `sourcesOnlyUnion` (or any other boot-time content builder) as "write-only, so safe"
  without checking where its RESULT actually ends up — round 1 of this record made exactly that mistake;
  it is pushed live into `pendingUnresolvedQuarantines`, and the reason it is still safe is that nothing
  PRE-EXISTING is being replaced, not that nothing is ever written.
- Do not trust a mid-window assertion that runs after `activeMergeQuarantineFor(top)` (or any query of
  TOP's own fresh key) as proof of a SPECIFIC outstanding token, or as proof the invariant stays clean —
  querying a cross-tier sibling legitimately lazy-graduates it together with whatever else shares its
  canonical key (card 8a1bc2ef). In this card's own SCENARIO 2, that query absorbs BOTH TOP's own
  already-known fresh raise token AND a wholly incidental token the test's own junk fixture content at
  TOP's key's final happened to carry (`s2-junk-tok-self` — present on disk from setup, never itself part
  of the bug under test) — directly re-measured: immediately after the query, `activeMergeQuarantineFor(top)`
  carries both tokens, and the SANITY check's own final `!mod2.activeMergeQuarantineFor(top)` fails
  specifically because that incidental junk token is never explicitly cleared by the test. This is not a
  bug — it is correct, designed behavior for genuine cross-tier siblings — but it means a fail-open test's
  own "fully lifted" sanity check must account for EVERY token a query along the way may have absorbed,
  including ones that look like inert fixture scaffolding, not just the ones the test itself explicitly
  raised.
- Do not characterize this bug's effect as "F reports OPEN" in isolation — F has no canonical key of its
  own once it shares TOP's; what concretely opens is the OTHER, real repo (S_F here) that F's degraded
  entry was over-blocking at its own stale walked-up key. State which repo's own over-block actually
  lifts, not just which identity's tokens were involved.

## Tests

`packages/daemon/test/merge-quarantine-foreign-group-stale-twin-67136b71.mjs` — its own dedicated file,
mirroring af948556's own structure (two scenarios, each a freshly-imported module instance).

- **SCENARIO 1** — mid-window, strictly before any query: the GLOBAL identity invariant holds, exactly
  one F-repoPath object exists. Witnesses (exactly 3 reads of the raiser's own fresh key's final; the
  raise diverted rather than overwrote; a pending record for the raiser exists) confirm the raise-divert
  branch was actually reached, not some other path.
- **SCENARIO 2** — THE FAIL-OPEN: F's foreign group has three matched pending members (the 883e29bc
  twin pair, plus a third, wholly separate pending record injected via `reenterMergeQuarantinesAtBootTestOnly`'s
  own seam, modelling a later, independent raise of F while still unresolvable). Clears F's two original
  twin tokens; asserts F/TOP both stay BLOCKED (the third, never-cleared token is still outstanding);
  then clears that third token AND the raiser's own fresh raise token, and confirms both are then fully
  lifted.

Proven RED on pre-fix `HEAD` (only the `replaceEntryEverywhere` line genuinely removed via a hand-edit,
re-verified NOT to be a no-op `git checkout HEAD --` against an already-fixed HEAD — tsconfig.tsbuildinfo
cleared, rebuilt) / GREEN after restoring the exact same line, re-rebuilt. The RED set is exactly:

- SCENARIO 1's two invariant checks (the global identity invariant; exactly-one-object);
- SCENARIO 2's "`S_F` stays BLOCKED" check (this is the one that actually trips — `S_F` incorrectly
  reports UNBLOCKED, confirming the fail-open);
- SCENARIO 2's "F's separate third token is still enforcing" check (fails as a direct consequence of the
  one above — nothing left anywhere reports `s2-tok-fd`, durably);
- the S2 SANITY check — which fails for a DIFFERENT, incidental reason than either of the two above: by
  the time it runs, the earlier "TOP stays BLOCKED too" query has already absorbed the test's own junk
  fixture token (`s2-junk-tok-self`) into TOP via cross-tier-sibling lazy graduation (see the "Do not"
  above) — not itself evidence of the stale-twin bug, but a real RED result on the unmodified pre-fix tree
  all the same, since this absorption path and its downstream token differ depending on whether the
  stale-twin bug is present.

SCENARIO 2's "TOP (F's cross-tier sibling) stays BLOCKED too" check PASSES on both pre-fix and post-fix —
TOP blocks itself via its own, entirely separate raise token throughout; it is never the check that
demonstrates this bug.
