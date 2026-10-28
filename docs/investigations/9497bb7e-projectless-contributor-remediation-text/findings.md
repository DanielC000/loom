# 9497bb7e — investigation narrative (kept out of the decision record to stay under its byte cap)

See `docs/decisions/9497bb7e-projectless-contributor-remediation-text.md` for the summary and the "Do
not" list. This file carries the full Code Review round's own findings and the repro work.

## Code Review of `ac353760` — two BLOCKING Majors

### Finding 1 — the victim set was a re-implementation and understated the damage

The reviewer PROBED this directly: `clearMergeQuarantineByKey` first runs
`reconcileClearedEntryIfPlaceholder` (`identityWideHumanClear:true` only), which re-ingests a now-readable
disk record and unions in its contributors. In the probe, `dryRun` showed `[r,s]`, but the REAL call
lifted `[s,r,q]` — `q`'s quarantine was destroyed with no confirmation. A code trace confirmed a SECOND,
independent gap: `clearMergeQuarantineByKey`'s own tied-pending-twin loop (`~L5755-5765`) adds a REMOVED
twin's own `repoPath`, `contributorRepoPaths`, and blocked `reducedContributorRepoPaths` as additional
candidates — `computeBroadUnionVictimSet` never scans `pendingUnresolvedQuarantines` at all.

**The ruling (lesson 277): shrink the surface, never re-implement the candidate seeding.**
`clearBroadUnion` now refuses outright, on BOTH `dryRun` and the real call, when:
- `isUnreadablePlaceholderEntry(entry)` holds (the placeholder-reconcile gap) — the text names the real
  remedy: restart the daemon (that re-ingests the real record), then retry.
- Any PENDING entry shares `entry.repoPath`'s own identity (`directPathIdentity` match) — the tied-twin
  gap — naming that entry's own `sourceFile`.

A POST-CLEAR BACKSTOP was added on top, for shapes nobody has found yet: if `clearMergeQuarantineByKey`'s
own `liftedRepoPaths` (normalized) is not a subset of the confirmed set, the response is never a bare
`ok` — it carries `unconfirmedLifted` + a loud warning, and the event detail records it too. Factored into
a shared `composeBroadUnionClearResult`, with a `composeBroadUnionClearResultTestOnly` seam so the
backstop itself can be exercised with a fabricated `liftedRepoPaths` — real-world, it is deliberately
UNREACHABLE once both root causes above are refused upstream (verified: every test scenario drives
genuinely clean, exactly-matching lifts; the seam is the only way to see it fire).

`computeBroadUnionVictimSet`'s own doc now says what it actually is: a SCOPED SUBSET of
`clearMergeQuarantineByKey`'s real candidate computation, guarded by the two refusals above plus the
backstop — never "the exact computation," which was the original, now-corrected overclaim.

### Finding 2 — provenanceUnknown/placeholder/pending-twin must never be pointed at a route that refuses them

`remediationTextFor`'s `noHonestClearByPathTarget` branch and `stillQuarantinedReason` both named
`clear-broad-union` unconditionally — including for a `provenanceUnknown` entry, which the route itself
refuses outright. The manager's rule: **every text naming `clear-broad-union` must be for a shape where
that route genuinely accepts.**

**The fix (round 1):** a new shared predicate, `clearBroadUnionAccepts(entry)` — RE-STATES (not shared
code; see round 3 below for why that mattered) `clearBroadUnion`'s own three pre-checks
(`provenanceUnknown`, `isUnreadablePlaceholderEntry`, tied pending twin), applied to whatever `entry` the
CALLER had already independently resolved — computed ONCE per call site, by the caller, who already
holds the real `entry` object (`refuseSelfClearStaleKeyContributors`, `stillQuarantinedReason`, the
clear-by-id ambiguous branch, `assertRepoNotQuarantined`; the one PENDING-only call site passes `false`
directly, since `clearBroadUnion` only ever matches an ACTIVE entry). `remediationTextFor` gained a new
`canUseBroadUnion: boolean` parameter; when false, it never names the route at all (not even to say it
refuses) — it goes straight to the manual-edit escape, worded to cover the provenanceUnknown case
specifically when that is why, or generically otherwise.

**A verified-mechanically test** (`(text-d)` in the Phase 1 test file) enumerates three shapes
(ordinary-accepts, provenanceUnknown-refuses, placeholder-refuses) via a BUILDER function invoked twice
per shape (never a single fixture read twice — see below for why), and asserts `namesRoute === routeAccepts`
for each, where `routeAccepts` is a fresh, independent `clearBroadUnion(...).ok` read.

### The tied-pending-twin shape could not be added to that same enumeration — a real, separate finding

Every remediation-text call site is reached only AFTER resolving the quarantine's own status
(`resolveQuarantineFor`), which has a documented, load-bearing GRADUATION side effect: it absorbs a tied
pending twin of the same identity as a PRECONDITION of answering "is this still quarantined" at all. So by
the time any of these call sites build text, the exact twin `clearBroadUnion`'s own direct refusal exists
to catch has ALREADY been resolved away — `canUseBroadUnion` genuinely reads `true` at that point, and the
text's claim is TRUE, not stale (verified: calling `clearBroadUnion` on the SAME instance immediately
after reading the text does accept). This was first caught as a test-ordering artifact (calling the
mutating `clearMergeQuarantineReporting` before the pure `clearBroadUnion` dry-run check, in the SAME test,
gave inconsistent answers depending on order) before being correctly understood as a genuine property of
the production code, not a test bug to paper over. Filed as its own scenario, `(text-e)`, asserting BOTH
halves honestly: `clearBroadUnion`'s own direct dryRun (never routed through a resolve-first entry point)
still refuses for a genuinely untouched twin; a text generated via the ordinary route's own graduation
side effect correctly accepts, verified true on the same instance right after.

## Code Review of `8f983e73` — CR round 3, one BLOCKING Major

### Finding — `clearBroadUnionAccepts` was a MIRROR of the route's own selection, not shared code

Round 1's fix (above) split SELECTION from VERDICT: `clearBroadUnion` picked its own entry inline
(`activeMatchesAndLiftedKeysFor(identity).matched.find((m) => selfClearRefusesForStaleKeyContributors(...))`
— the FIRST refusing active match it iterates to), while `clearBroadUnionAccepts` judged whatever entry
the CALLER had separately resolved (typically via `resolveQuarantineFor`'s own real-key lookup). Those two
selections are not provably the same entry. The reviewer's own probe (`probe-mirror.mjs`) constructed two
DISTINCT active entries sharing one `repoPath` identity under different keys — `B`, a placeholder inserted
first (so it wins Map-iteration order in `clearBroadUnion`'s own scan), and `A`, the ordinary stranded
union the caller's `resolveQuarantineFor` actually resolves to (it recomputes the real canonical key
directly). The route's `clearBroadUnion` selected and refused on `B`; `clearBroadUnionAccepts`, handed
`A`, said `true`. A remediation text could therefore claim `clear-broad-union` "accepts" while a real call
to it refused outright — the exact class finding 2 existed to prevent, reintroduced one layer down.

**The ruling:** selection and verdict must be ONE function, never a caller-supplied entry plus an
independently-reproduced search. `broadUnionTargetFor(repoPath)` now owns both: it reruns the identity
scan, collects every DISTINCT active entry matching, and — if more than one — REFUSES outright, verbatim:
`"<N> DIFFERENT active quarantine entries sharing this exact identity"`. Only when exactly ONE distinct
entry shares the identity does it then filter to `refusingEntries` (that one entry, kept only if
`selfClearRefusesForStaleKeyContributors` actually fires for it); zero survivors refuses too (`"does not
match any union whose self-clear is currently refused"`). Only past BOTH of those gates does it apply the
three further pre-checks (`provenanceUnknown`/placeholder/tied-pending-twin) and return
`{accepts, entry, reason?}`. `clearBroadUnion` and every `remediationTextFor` call site now call this ONE
function with the IDENTITY (never a pre-resolved entry), so there is only ever one selection in the system
to agree or disagree with — eliminating the mirror-drift class by construction, not by checking the two
paths still happen to agree today.

Verified via a two-entry-same-identity fixture added to `(text-d)`'s own shape enumeration (expects
`accepts:false`) plus a direct proof calling `clearBroadUnion` and the ordinary route's text-building path
on the same instance and asserting neither silently prefers `A` or `B`.

Scenario (8) in the Phase 2 test file was also strengthened in this round: its original pending-twin
fixture was untied (no token overlap, no `armedKeys`, no contributors) — `clearMergeQuarantineByKey`'s own
pending-tie loop would have skipped it regardless of whether `clearBroadUnion`'s refusal fired, so
"nothing touched" proved nothing. The twin is now genuinely tied via a token subset (the same condition
that loop checks) and carries its own separate contributor `q` (see CR round 4 below for a further fix to
this scenario's own final assertion).

## Re-review of `a1617f80` — CR round 4, five small findings

1. Scenario (8)'s final check, `!activeMergeQuarantineFor(q)`, can never fail — `q` is never
   active-quarantined in EITHER state, refused or not. Reworded to assert on the REAL call's own
   `liftedRepoPaths`/`unconfirmedLifted` fields instead, where `q`'s identity would actually surface if a
   disabled refusal let it leak (confirmed by the reviewer: under a disabled guard, `q` lands in both).
2. This record quoted a refusal string, `"several quarantines share this identity"`, that does not exist
   in the code — corrected above to the verbatim text, and to describe the `refusingEntries` filter step
   between the multi-entry gate and the three further pre-checks.
3. The pending-only clear-by-id text site (`clearMergeQuarantineLatchFile`, the `matchedPending`-only
   branch) hard-coded `canUseBroadUnion:false` instead of computing it. Now routed through
   `broadUnionTargetFor` too — it genuinely evaluates to `false` there (no `activeMatch` can coexist with
   reaching that branch), but by the SAME shared selector every other site uses, not a separate constant.
   "Every text site computes this the same way" is now true without exception.
4. The two-entries-same-identity test gained two more pinned sites: `assertRepoNotQuarantined(s)`'s own
   reason text, and the clear-by-id ambiguous-branch text — both now also asserted to NOT name
   `clear-broad-union`, alongside the pre-existing `clearMergeQuarantineReporting` assertion.
5. The (text-e) comment's construction-vs-graduation narrative (added in round 3's own follow-up commit)
   was trimmed to a short pointer at its `@decision 9497bb7e` anchor — the full reasoning lives here, not
   duplicated at the call site.

## Items folded in (non-blocking)

- Disclosure-field passthrough (`latchKept`/`referencingRepoPaths`/`contentKeptRepoPaths`/`unattributed`/
  `wasQuarantined`) now flows from `clearMergeQuarantineByKey` through `composeBroadUnionClearResult` into
  BOTH the REST response and the event detail via one `...rest` spread in `gateway/server.ts`, mirroring
  `/clear-by-path`'s own composition (decisions `f5c42043`/`182c01cc`).
- `confirmPaths` elements are validated as non-empty strings at the REST boundary (400), before they ever
  reach `clearBroadUnion`'s own exact-match check, which would otherwise read a bad element as a literal,
  never-matching path and refuse with a confusing "unrecognized" message instead of a clean validation error.
- The `types.ts` doc comment's stale `armedKey` field (never implemented) was dropped in favor of
  accurately describing the `...rest`-forwarded, non-fixed detail shape.
