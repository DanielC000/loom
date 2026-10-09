# 82032b5c — a runtime union writes to the occupant's armed key, and records contributor provenance so clear-by-id can fail closed

From CR `e31c5809` on `9a55fb90` (pre-existing, measured) — coupled with `9a55fb90`'s own "known residual"
(round 2): `canonicalSiblingsFor` only ever scans `pendingUnresolvedQuarantines`, so a sibling absorbed
DIRECTLY into an ACTIVE entry at RUNTIME (`enterMergeQuarantine`'s own `existing` branch) was invisible to
it. Both halves below were reproduced directly on `HEAD` (via throwaway scratch scripts against the real
compiled module) before any fix was written, including the coupling itself — not merely argued.

## The shape

A degraded occupant `X` (unresolvable, armed at its own `resolvedKey` `Ky`), plus a genuinely resolvable
repo `Y` whose own `canonicalRepoLockKey` is ALSO `Ky`. A fresh `enterMergeQuarantine(Y, …)` call hits the
`existing` branch (`activeQuarantines.get(Ky)` already holds `X`'s entry) and appends `Y`'s own token into
the shared object.

**Defect (A) — stray write:** that branch's own durable write passed `writeMergeQuarantineLatch(entry,
true, undefined, true)` — `targetKey=undefined`, so the write recomputed a FRESH
`canonicalRepoLockKey(entry.repoPath)` (`entry.repoPath` is `X`'s own, UNRESOLVABLE path) instead of
writing to `Ky` (the key actually in `armedKeys`). Measured: the union landed at an untracked, unreferenced
hash — `X`'s own walked-up key, never in `armedKeys` — while `Ky`'s OWN tracked file was left STALE
(only `X`'s original token, never `Y`'s).

**Defect (B) — masked hard delete:** clear-by-id on `Ky`'s own hash (`clearMergeQuarantineLatchFile`)
passes `activeMatch.entry.repoPath` as the clearing identity to `clearMergeQuarantineByKey` — the SAME
tautology `9a55fb90` already named for a different call shape (`entry.repoPath !== entry.repoPath` is
always false), so `protectDegradedOccupantBeforeDelete` never runs for this path, by design (it IS the
entry's own identity being cleared). `canonicalSiblingsFor` finds nothing (no separate PENDING entry
represents `Y` — it was absorbed directly, never diverted), so no ambiguity is ever detected either.
Measured: clear-by-id succeeds (`ok:true`) and hard-deletes `Ky`'s file outright.

**The coupling, measured directly:** fixing (A) alone (manually writing the complete, correctly-targeted
union straight to `Ky`'s file, bypassing the bug) and then clear-by-id STILL succeeds and hard-deletes the
now-COMPLETE union — both identities' tokens, gone, with zero protection and zero ambiguity detection. The
stray file from defect (A) was ACCIDENTALLY masking defect (B): it happened to keep a (mislabeled,
untracked) copy of the data around, which is what let a cleared `Y`/`X` come back quarantined on reboot.
Fixing (A) in isolation would remove that accidental backup and turn (B) into a clean, total, unrecoverable
loss. The two defects had to land together.

## The fix

**(a)** `enterMergeQuarantine`'s `existing` branch now writes to EVERY key in `armedKeysForEntry` (the
same list already used for the in-memory update), never `targetKey=undefined`.
**CORRECTION (round 2, see below): this section originally claimed `skipDegradedOccupantGuard` was "safe
to keep `true` for every key either way" — that claim was FALSE and was retracted in round 2, item 2.**
`skipDegradedOccupantGuard=true` (`@decision e1cb7d33`: a raise must persist) applies ONLY to the raise's
own freshly-VERIFIED `key`; every OTHER armed key writes with the guard ON.
Found in passing, same chokepoint: `writeMergeQuarantineLatch`'s own internal sweep
(`sweepTmpResidueForHashIfUnreferenced`) ALSO recomputed from `entry.repoPath` instead of `targetKey` when
given — fixed alongside, or it stays a landmine for the next correct caller.

**(b)** A new, PERSISTED field, `MergeQuarantineEntry.contributorRepoPaths?: string[]` — populated ONLY by
`enterMergeQuarantine`'s `existing` branch, only when the raising repoPath's identity genuinely differs
from the entry's own. A single shared predicate, `ambiguousIdentitiesFor`/`ambiguousIdentitiesForLatchId`
(replacing the narrower `canonicalSiblingsFor`/`canonicalSiblingsForLatchId` at every refusal-text AND
clear-by-id call site — `9a55fb90`'s own rule: text and action must never disagree about one given id),
unifies this with the pre-existing pending-sibling collision check. `clearMergeQuarantineLatchFile`'s
active-match branch now refuses whenever either shape is non-empty, naming every candidate identity and
redirecting to clear-by-path — never hard-deleting a runtime union.

Carried forward (never originated) at every other copy/rebuild site: `unionQuarantineEntries`,
`mergeTokenIntoPendingEntries`, `protectDegradedOccupantBeforeDelete`'s own hand-rolled JSON whitelist, and
all three boot-time JSON-parse whitelists in `reenterMergeQuarantinesAtBootImpl` (PASS 1's main loop, PASS
1b's tmp recovery, the safety-tmp recovery loop) — every other site that touches an entry object is a
plain spread and carries the field automatically.

## DoD narrowing (Lead-approved)

Clear-by-id on a runtime-union entry fails closed. Clear-by-path is UNCHANGED — it already discriminates
correctly (`9a55fb90`) and already protects the degraded occupant's content (`c9114934`), unconditionally,
and continues to proceed (never refuses — `e1cb7d33`'s own retraction). **Accepted, documented residual**
(not fixed here, not hidden either): the protective copy a clear-by-path mints can still carry the
ALREADY-cleared identity's own token too, since `contributorRepoPaths` alone cannot split a union's token
set back into two independently-persisted, independently-queryable identities at clear time — that is
`398f476c`'s own, larger identity-model-redesign scope. Measured directly (not merely argued): in the
concrete X/Y shape this card addresses, the surviving protective copy carries no `resolvedKey` (per
`c9114934`'s own rule), so it never re-occupies `Ky` on a later boot — the cleared identity's own query is
NOT blocked again in practice, even though its token still physically rides along inside the protective
copy under the other identity's name.

## Do not

- Do not recompute a write target from `entry.repoPath` anywhere this module already distinguishes a
  degraded/unresolvable `repoPath` from its own recorded `armedKeys`/`resolvedKey` — pass the key
  explicitly (`targetKey`) instead; this is the SAME rule `97cff6db` already established for every other
  write site in `reenterMergeQuarantinesAtBootImpl`, now extended to `enterMergeQuarantine`'s own
  `existing` branch and to `writeMergeQuarantineLatch`'s internal sweep call.
- Do not infer `contributorRepoPaths` anywhere except `enterMergeQuarantine`'s own `existing` branch — in
  particular, never from a BOOT-TIME union (`armQuarantineKey`/`unionQuarantineEntries`'s own
  identity-differing merges). That shape is `398f476c`'s own, larger scope; this field's job is narrow.
- Do not drop `contributorRepoPaths` at any copy/rebuild site — a dropped field silently re-opens the
  clear-by-id hard-delete this exists to refuse, invisibly, since nothing else signals the loss.
- Do not attempt to split a union's token set back into two independently-queryable identities at
  clear-by-path time to close the accepted residual above — that is a structural rearchitecture
  (`398f476c`'s own scope per `a2f381dc`'s M-2 ruling), not a scoped fix for this card.
- Do not reach for a "shadow pending entry" (pushing a second, parallel `pendingUnresolvedQuarantines`
  reference for the absorbed identity) as an alternative to the field — considered and rejected: it needs
  its own new sync invariant (`clearMergeQuarantineByKey`'s own pending-sweep only clears a same-identity
  pending entry when it's reference/armedKeys/orphanLatchFiles-"tied" to the active entry; a token-only
  link is none of those, so the shadow would survive an ostensibly-successful clear and let the absorbed
  identity re-quarantine ITSELF independently on a later query). A field directly on the entry object
  needs no such invariant — it travels automatically with the object through `replaceEntryEverywhere`.
- Do not rebuild an entry via a bare per-key `.set()` loop, even for a SAME-identity rebuild (round 2,
  item 1) — route through `replaceEntryEverywhere` instead, or a PENDING reference sharing the pre-rebuild
  object by reference (the 883e29bc boot-diverted twin) is silently left stale.
- Do not skip the degraded-occupant guard for every armed key on a raise (round 2, item 2) — ONLY the
  raise's own freshly-verified `key` may skip it; a secondary armed key's CURRENT physical file is not
  guaranteed to still belong to this entry.
- Do not durably rewrite only the ONE key a clear was addressed by once a raise durably writes every
  armed key (round 2, item 3) — a clear must sync every armed key too, or a cleared token resurrects from
  a stale secondary file on the next reboot.

## Round 2 (Code Review `82b5d95e` on commit `aa02ee8b`) — five more findings, each reproduced against `aa02ee8b` first

**1 (CRITICAL) — the `existing` branch's rebuild never re-pointed X's own 883e29bc pending TWIN.** It only
did `activeQuarantines.set(k, entry)` per key, never `replaceEntryEverywhere` — so a PENDING reference
sharing the SAME object (by reference) as the pre-union `existing` object stayed pointed at it. X later
re-raising while STILL unresolvable hits `mergeTokenIntoPendingEntries`, which matches that stale twin and
durably REWRITES Ky's own file FROM it — losing Y's token and `contributorRepoPaths` outright. Fixed by
routing the rebuild through `replaceEntryEverywhere(activeQuarantines, existing, entry)` — safe here since
`existing`/`entry` are the SAME logical identity (unlike `armQuarantineKey`'s own union, which can
genuinely merge two different identities and deliberately excludes this chokepoint for that reason).

**2 (MAJOR) — writing every armed key with the guard unconditionally skipped can overwrite a DIFFERENT,
unresolvable identity's only file.** A dual-armed `E` (its own current key `K1` plus a legacy, stale
`resolvedKey` `K2`) is in-memory bookkeeping only — `K2`'s CURRENT physical file is not guaranteed to still
be E's own; it can genuinely belong to a wholly different, currently-unresolvable identity `W` that
happens to physically occupy `K2`. Writing with `skipDegradedOccupantGuard=true` for EVERY armed key
(round 1's own fix) would silently overwrite `W`'s only durable copy. Fixed: skip the guard ONLY for `key`
itself (the raise's own freshly-verified key, the one `existing` was found at) — every other armed key
writes with the guard ON, so a genuine collision there REFUSES instead of overwriting. Measured: with the
fix, `W`'s file is byte-identical before/after `E`'s re-raise, and `W`'s own token stays enforced
(findable via `activeMergeQuarantineFor(w)`) across a reboot — never the SEPARATE, PRE-EXISTING boot-time
union mechanism (`armQuarantineKey`/`a2f381dc`) that can fold two genuinely-colliding identities together
when BOTH their files are read in one boot pass; that mechanism is unrelated to, and unaffected by, this
fix.

**3 (MAJOR) — `clearActiveEntryTokenAtKey`'s partial-clear branch durably rewrote only ONE key.** Once (a)
durably writes every armed key on a raise, a SECONDARY armed key's file can legitimately carry the full
token set — but the partial-clear path only ever rewrote the single `key` it was called with, leaving a
secondary key's file STALE (still carrying a just-cleared token), which resurrects that token on the next
reboot via boot's own dual-arm/migrate consolidation. Fixed by mirroring `clearPendingEntryByToken`'s own
per-armed-key loop: write every key in `entry.armedKeys`, guarded by `activeQuarantines.get(k) === updated`
(ownership — never write a key this entry no longer genuinely owns), and — unlike a raise — NEVER skip the
degraded-occupant guard for any key here (a clear is never a raise).

**4 (Minor) — stale `contributorRepoPaths` after a contributor's own token is cleared.** No per-token
provenance is tracked (by design — see the field's own doc comment), so there is no SAFE way to tell
"this contributor has zero remaining tokens" from "this contributor raised more than once and still has
one outstanding" without risking an UNSAFE false-positive prune (which would be the dangerous direction:
over-pruning could let clear-by-id proceed on a contributor who is still genuinely outstanding). Rather
than guess, the refusal text at every call site now explicitly hedges that a named contributor's own token
may already be individually cleared — never silently implying every named identity is still definitely
live.

**5 (Minor) — the PENDING branch of clear-by-id never consulted contributor provenance at all.** A
pending entry can carry `contributorRepoPaths` too (e.g. via `protectDegradedOccupantBeforeDelete`'s own
protective copy) — `clearMergeQuarantineLatchFile`'s `matchedPending.length > 0` branch used to proceed
straight to dropping/sweeping the matched entries with no ambiguity check at all. Fixed: that branch now
fails closed whenever any matched pending entry's own `contributorRepoPaths` is non-empty, naming every
candidate and redirecting to clear-by-path — the SAME `contributorRepoPaths` field the active-match branch
already reads, closing the one remaining disagreement between text and action (9a55fb90's own rule).

Follow-up (Lead-boarded, not fixed here): pre-round-2 stray union files may already exist on disk from
when round 1's own fix was live in production — a separate card.

## Round 3 (Code Review `77e22256` on commit `4aee1942`) — one MAJOR (blocking), two minors

**MAJOR (blocking) — the refusal text named a route that verifiably does nothing for a contributor.**
`POST /internal/merge-quarantine/clear-by-path`'s `repoPath` form calls `clearMergeQuarantineByRecordedPath`,
which matches ONLY an entry whose own STORED `repoPath` equals the given identity — never a contributor
folded into a DIFFERENT entry's token set. Measured directly: `clearMergeQuarantineByRecordedPath(y)`
(`y` a contributor) returns `wasQuarantined:false`, and `assertRepoNotQuarantined(y)` still blocks
afterward — the exact "the route does nothing" the CR flagged. **Lead's ruling: do NOT make clear-by-path
honour contributor identities** (that depends on 398f476c's own token-split question) — instead, narrow
what the text claims:
- the entry's OWN `repoPath` (and any resolvable PENDING sibling, which genuinely has its own entry) gets
  `clear-by-path`'s `repoPath` form — verified to work — with an explicit caveat that clearing by it lifts
  the WHOLE entry there, including any unconfirmed-kill quarantine still outstanding under it, so a human
  must first confirm no process is still running under whichever one they pick;
- each CONTRIBUTOR is named separately, with NO `clear-by-path` claim — only the project-resolved `/clear`
  route (projectId-addressed, resolves by canonical KEY via `clearMergeQuarantineByKey`, not stored
  `repoPath`), conditioned honestly on actually being a registered project (this module cannot check that
  itself), verified directly to work (`clearMergeQuarantineReporting(y)` returns `wasQuarantined:true`,
  `assertRepoNotQuarantined(y)` reads clear afterward, while X's own separate quarantine survives
  protected).

  **RETRACTED in round 4 (below): this bullet's own verification was itself incomplete — the SAME route
  is a no-op for a PENDING entry's contributor, and lifts more than expected for a RESOLVABLE active one.
  Do not act on this bullet; read the round 4 section before touching this text again.**

A new shared helper, `remediationTextFor` (plus the `AmbiguousIdentities` struct `ambiguousIdentitiesFor`/
`ambiguousIdentitiesForLatchId` now return, splitting `siblingRepoPaths` from `contributorRepoPaths` rather
than one flattened array), is the ONE place this wording lives — used by all three refusal-text sites
(`clearMergeQuarantineLatchFile`'s active AND pending branches, `assertRepoNotQuarantined`), closing the CR's
own nitpick too: a new scenario drives the REAL function behind every route the text names (never a
stand-in), for every candidate it names.

**MINOR A — `clearActiveEntryTokenAtKey`'s own "ownership guard" was dead code.** Its bare per-key
`activeQuarantines.set(k, updated)` ran BEFORE the write loop's `activeQuarantines.get(k) !== updated`
check — meaning that check could never be false (the `.set()` had already made every key in
`armedKeysForEntry` equal `updated`), silently contradicting round 2's own "never a bare per-key `.set()`"
rule, and — worse — the bare `.set()` itself could CLOBBER a DIFFERENT entry's in-memory slot if a stale
`armedKeys` member had, by then, genuinely been reclaimed by someone else. Fixed: route through
`replaceEntryEverywhere` (which only touches a key that still actually holds the OLD entry by reference)
instead of the bare `.set()`, and gate the write loop on a new shared predicate, `entryStillOwnsKey(key,
entry)` (the generic form of the pre-existing `pendingEntryStillOwnsKey`, renamed — same object OR same
`directPathIdentity` — now used by BOTH this clear loop and the raise loop's own secondary-key write).
Reproduced via TWO SEPARATE boot calls in one process (E dual-arms cleanly in boot #1 while K2 is free;
E's own file is then removed and a genuinely separate, unresolvable W's own file is placed at K2's hash;
boot #2, registering only W, arms it alone at K2 via a fresh local `byRepoKey` that bare-overwrites
whatever boot #1 left there) — this is REACHABLE via real boot mechanics specifically because boot's own
per-file loop reads every `.json` file in the directory regardless of which repos are "registered", and a
SECOND boot call's own local map has no memory of a FIRST call's results.

**MINOR B — the pending-branch refusal never got fix-4's own hedge.** Folded into the same
`remediationTextFor` refactor above, so it can never drift from the other two sites again.

Follow-up (Lead-boarded, not fixed here): pre-round-2 stray union files may already exist on disk from
when round 1's own fix was live in production — a separate card (unchanged from round 2's own note).

## Do not (round 3 additions)

- Do not claim `clear-by-path` clears a contributor — verified directly NOT to work
  (`clearMergeQuarantineByRecordedPath` matches only an entry's own stored `repoPath`).
  **CORRECTION (round 4): the original text here recommended naming the project-resolved `/clear` route
  for a contributor instead — round 4 retracted that too (see below); do not re-add it.**
- Do not hand-roll remediation text at a new refusal-text site — call `remediationTextFor`, the one
  shared builder, or a future wording change will drift between sites exactly as it did before this round.
- Do not "fix" `clearActiveEntryTokenAtKey`'s dead ownership guard by simply deleting the bare `.set()`
  loop without replacing it — that reopens the stale-key resurrection round 2's own item 3 closed. Replace
  it with `replaceEntryEverywhere`, which achieves the same in-memory update SAFELY (reference-scoped).
- Do not assume this exact "stale armedKeys, now a different entry" scenario needs a brand-new test-only
  injection seam — it's reachable via two ordinary `reenterMergeQuarantinesAtBoot` calls in one process,
  the second one registering only the entry that supersedes the first's stale claim.

## Round 4 (Code Review `9e826040` on commit `c61be07f`) — two MAJORs, both refusal text vs. what the route actually does

Round 3's own fix still named a SECOND route (the project-resolved `/clear`, projectId-addressed) for a
contributor — and round 4's re-CR measured EVERY route in 4 shapes (active+resolvable, active+degraded,
pending+resolvable, pending+degraded) and found that route wrong in two of them:

**MAJOR 1 — `/clear(contributor's projectId)` is a NO-OP for a PENDING entry.** Measured directly:
`clearMergeQuarantineReporting(y)` against a pending entry carrying `y` as a contributor returns
`wasQuarantined:false`, and the pending file survives untouched. Its own filter
(`clearMergeQuarantine`/`clearMergeQuarantineByKey`, reached via a resolvable `y`) matches by
`directPathIdentity(entry.repoPath)` against the ACTIVE map only — it never even looks at
`pendingUnresolvedQuarantines`, so it can never find a pending entry's own contributor at all.

**MAJOR 2 — for an ACTIVE entry with a resolvable X, `/clear(y)` lifts the WHOLE union, including X's
own unconfirmed-kill token, with no warning attached to that sentence.** The round-3 test's own "X's own
quarantine survives" assertion passed only because that fixture's `X` happened to be unresolvable
(`clearMergeQuarantineByKey`'s own `protectDegradedOccupantBeforeDelete` call only protects an
UNRESOLVABLE occupant — see that function's own gate). For a RESOLVABLE `X`, nothing protects it: `/clear`
genuinely lifts X's own, still-outstanding, unconfirmed-kill quarantine as a side effect of clearing `y`,
and round 3's own text never warned about this. It is ALSO only true while `Y` itself still resolves —
reversed, this is the exact shape every prior round's own branch-specific route kept failing to cover.

**LEAD'S RULING: stop naming `/clear` in remediation text at all.** It is right only in SOME branches, and
each round that added a branch-specific route produced a NEW text/action mismatch in some OTHER branch.
`remediationTextFor` now names EXACTLY ONE route — `clear-by-path` with the entry's own repoPath (or a
listed sibling) — verified to work in all 4 shapes the CR measured. Its sentence states plainly that
clearing: (a) lifts the WHOLE entry, including every contributor's own folded token AND the entry path's
own outstanding unconfirmed-kill quarantine; (b) requires first confirming no process is still running
under ANY listed path. One flat line covers contributors: "clear-by-path with a contributor's own path
does nothing; clearing by the entry's own path above lifts its token too." No tier/registration branching
survives in the text — this closes items 1, 2, and 4 (round 3's own text hedge, now folded into the single
flat line above rather than a conditional "if registered" branch). The ORDINARY (non-ambiguous) refusal in
`assertRepoNotQuarantined` still separately names the project-resolved `/clear` route in its OWN trailer —
that is a PRE-EXISTING, unrelated caveat for the single-identity case (where `/clear` genuinely has no
"which identity" ambiguity to get wrong) and is now gated to fire ONLY when nothing is ambiguous, never
alongside `remediationTextFor`'s own output.

**Item 6 (comment accuracy, no code change) — a comment claimed the ownership guard was "reference-checked."**
`entryStillOwnsKey` checks IDENTITY (same object reference OR same `directPathIdentity`), never bare
reference equality alone — only the in-memory UPDATE (`replaceEntryEverywhere`) is reference-scoped. Fixed
the comment wording at `clearActiveEntryTokenAtKey`'s own write loop to attribute each check correctly.

**Item 5 (NOT fixed here) — `consumeMatchedPendingsIntoArmedEntry`'s own bare `.set()`** (reached by the
sibling-absorb raise path) is a pre-existing instance of the SAME class of bug MINOR A fixed in round 3 —
Lead is carding it separately rather than folding it into this card.

Tests: reworked `redirect-targets-named-in-refusal-text-actually-clear` into 4 sub-cases
(active+resolvable via a real toplevel X with a subdir contributor Y, active+degraded, pending+degraded,
pending+resolvable via a real X temporarily removed-then-restored around the protect call) — each drives
`clearMergeQuarantineByRecordedPath` (the one real function behind the one route now named) and asserts
the block lifts, AND asserts the refusal text names no `/clear` route anywhere. The round-3 test's own
"X's own quarantine survives" claim (passing only for the degraded-X fixture) was dropped entirely along
with the whole project-route-testing block it lived in, rather than narrowed — the premise it was testing
(driving the project-route for a contributor) no longer applies once that route is never named.
**CORRECTED in round 5: "names no `/clear` route anywhere" overstated scope.** The scenario drove and
checked only ONE of the module's three `remediationTextFor`-adjacent render sites —
`clearMergeQuarantineLatchFile`'s own refusal text — never `assertRepoNotQuarantined`'s ambiguous branch,
which embeds a raised `reason` verbatim and (round 5 MAJOR, below) still named `/clear` in production for
any real unconfirmed-kill raise. "Anywhere" should have read "in the one render site this scenario
exercised."

## Do not (round 4 additions)

- Do not name a route in refusal/remediation text without a test driving that route's REAL function for
  EVERY refusal tier the text appears in (active+resolvable, active+degraded, pending+resolvable,
  pending+degraded, or whatever the card's own tier set is) — every prior round's own branch-specific
  route passed its OWN round's narrower test suite while failing in a tier that round never checked.
- Do not assume a protection mechanism gated on unresolvability (`protectDegradedOccupantBeforeDelete`)
  also protects a resolvable occupant — it structurally cannot, by its own gate, and naming a route that
  depends on it without stating that caveat is how MAJOR 2 happened.
- Do not assume "the route matches by identity" is enough to know it searches PENDING entries — several
  of this module's own clear routes (`clearMergeQuarantineByKey` via `clearMergeQuarantine`) only ever
  scan the ACTIVE map; always check which structure a route's own filter actually walks before naming it
  for a case that could be pending.

## Round 5 (Code Review `14877941` on commit `0e81c24c`) — one MAJOR (blocking), one minor, four test gaps

**MAJOR (blocking) — `assertRepoNotQuarantined`'s ambiguous branch embedded a raised `reason` verbatim,
and a real reason still named `/clear`.** Every real unconfirmed-kill raise builds its `reason` via
`unconfirmedKillReason()` (`batch-merge.ts`, `worktrees.ts`, `writer.ts`), whose shared
`UNCONFIRMED_KILL_WINDOWS_GUIDANCE` ends "...then POST /internal/merge-quarantine/clear".
`assertRepoNotQuarantined`'s ambiguous branch embedded `${q.reason}` directly, so in production the
ambiguous refusal still named `/clear` right next to `remediationTextFor`'s own single-route text —
reopening the exact text/action mismatch round 4 closed, in the ONE render site round 4's own test never
exercised (see the round-4 correction above). Reproduced directly against commit `0e81c24c` before any
fix: a fresh runtime raise built via the real `unconfirmedKillReason()` helper, made ambiguous by a
contributor, read back a refusal containing `"...then POST /internal/merge-quarantine/clear —
refusing..."` verbatim.

Fixed at RENDER time, in the ambiguous branch ONLY: a new exported helper,
`stripUnconfirmedKillRouteClause(reason)`, strips exactly the route-clause SUFFIX of
`UNCONFIRMED_KILL_WINDOWS_GUIDANCE` — derived by slicing the constant itself at its own last `", then "`
marker, never a hand-typed duplicate and never a loose regex — out of an embedded reason. The ORDINARY
(non-ambiguous) branch, and every other site that forwards an already-built refusal `.reason` string
(`batch-merge.ts`, `vault/versioner.ts`, `repo-lock.ts`, `sessions/service.ts`, `orchestration/restart.ts`
— all of which merely display a `.reason` field `assertRepoNotQuarantined`/its callers already built,
never re-embed `q.reason` themselves), are unaffected: `assertRepoNotQuarantined`'s ambiguous branch is
the ONLY site in this module that embeds a raised `reason` inside remediation output. A reason that never
carried the clause (a legacy latch, a non-unconfirmed-kill raise) passes through byte-identical.

**MINOR — the confirm-no-process clause didn't cover contributor paths.** `remediationTextFor`'s own
confirm-no-process clause only ever said "under ANY of the listed paths" — `clearByPathTargets`
(`ownRepoPaths` + `siblingRepoPaths`) — even though clearing lifts every contributor's own folded token
too. Fixed: when `contributorRepoPaths` is non-empty, the clause now also says "and under every
contributor named below."

**TEST GAPS (four, all closed):**
1. A new scenario, `ambiguous-refusal-never-embeds-unconfirmed-kill-clear-route`, drives the MAJOR fix
   directly: a fresh runtime raise built via the REAL `unconfirmedKillReason()` helper on a resolvable X
   with a subdir contributor Y (case A), plus a LEGACY-shaped latch whose STORED reason already carries
   the clause, loaded via a real boot rather than a fresh raise (case B) — both assert the ambiguous
   refusal never matches `/merge-quarantine\/clear(?!-)/` (the bare route, never `/clear-by-path`), that
   the guidance's own diagnostic text survives (only the route clause was stripped, not the whole
   guidance), and drive the `clear-by-path` route the refusal names to confirm it still works.
2. `redirect-targets-named-in-refusal-text-actually-clear`'s active+resolvable and active+degraded
   sub-cases now ALSO parse and drive `assertRepoNotQuarantined`'s own ambiguous refusal (the third
   `remediationTextFor` call site), never only `clearMergeQuarantineLatchFile`'s.
3. Round 3's own "contributor path does nothing" assertion
   (`clearMergeQuarantineByRecordedPath(contributor).wasQuarantined === false`) — dropped entirely by
   round 4 along with the whole project-route-testing block it lived in — is restored in both the
   active+resolvable sub-case and the new scenario's case A.
4. Every sub-case in `redirect-targets-named-in-refusal-text-actually-clear`, and both cases in the new
   scenario, now assert the blocking identity is genuinely BLOCKED (`assertRepoNotQuarantined(...).ok ===
   false`) immediately before its clear — non-vacuity: without this, a "reads clear afterward" check
   proves nothing if the identity was never actually blocked to begin with.

**NITPICK (comment accuracy, no behavior change) — the `AmbiguousIdentities` doc comment's
`contributorRepoPaths` bullet was stale.** It still claimed the project-resolved `/clear` route
"genuinely does work" for a contributor — round 4 had already retracted that (a NO-OP for a pending
entry's contributor, and an over-lift for an active resolvable one). Corrected in place. The round-4
verification paragraph's own "asserts the refusal text names no `/clear` route anywhere" is corrected the
same way, in place, above.

## Do not (round 5 additions)

- Do not embed a free-text `reason` (or any other caller-supplied string) in remediation/refusal output
  without checking whether it can itself carry a route this call site must not repeat — a reason built
  elsewhere (here, by `unconfirmedKillReason()`) can smuggle a route name past a text-only audit of the
  render site's own literal strings.
- Do not hand-type a duplicate of a guidance constant's route clause to match/strip it — derive the match
  from the constant itself (e.g. by slicing at a stable marker), so a future wording edit to the constant
  can't silently desync the stripper from what it's supposed to catch.
- Do not claim a test "asserts X anywhere" when it drove only ONE of several render sites that could
  carry X — name the specific site(s) actually exercised, or the next reader inherits a false sense of
  completeness (exactly how this round's MAJOR went unnoticed through three prior rounds' own re-CRs).

## Verification

`packages/daemon/test/merge-quarantine-runtime-union-provenance.mjs` — 15 scenarios, each in its own
child process with its own fresh `LOOM_HOME`, mirroring every sibling `merge-quarantine*.mjs` file.

Round 1 (8 scenarios): `runtime-union-targets-armed-key` (defect A), `clear-by-id-refuses-runtime-union` +
`refusal-text-names-both-identities-and-drops-bare-id` (defect B), `clear-by-path-still-proceeds-and-protects`
(the DoD-narrowed residual, asserted explicitly), `contributor-provenance-persists-across-reboot` (the
field survives a restart — Lead's item b.1), `protective-copy-carries-contributor-field` (the one copy
site a plain object-spread can't cover — Lead's item b.3), `ordinary-clear-by-id-unaffected` (negative
control: a non-colliding clear-by-id stays byte-identical), `multi-reboot-stability-after-refused-clear`
(no duplicate/stray file across ≥2 reboots).

Round 2 (4 more scenarios, one per CRITICAL/MAJOR/MAJOR/Minor finding — item 4 is text-only, verified via
the existing refusal-text scenarios' own output rather than a dedicated scenario):
`pending-twin-survives-reraise-while-unresolvable` (item 1), `secondary-armed-key-never-overwrites-different-occupant`
(item 2, via a new `buildDualArmFixture` helper reproducing the legacy stale-`resolvedKey` dual-arm shape),
`partial-clear-syncs-every-armed-key` (item 3), `pending-entry-with-contributors-refuses-clear-by-id`
(item 5).

Round 3 (2 more scenarios): `redirect-targets-named-in-refusal-text-actually-clear` (the MAJOR blocker,
AT THE TIME — superseded in round 4, see below) and
`stale-armed-key-owned-by-different-entry-survives-partial-clear` (MINOR A — the two-boot-call
construction described above, unaffected by round 4).

Round 4 (`redirect-targets-named-in-refusal-text-actually-clear` COMPLETELY REWORKED, no new scenario
names added): the SAME scenario name now covers 4 sub-cases in one run — active+resolvable (a real
toplevel X with a subdir contributor Y), active+degraded, pending+degraded, pending+resolvable (a real X
temporarily removed-then-restored around the protect call) — each driving `clearMergeQuarantineByRecordedPath`
(the ONE real function behind the ONE route now named) and asserting both that the block lifts AND that
the refusal text names no `/clear` route anywhere. Round 3's own "X's own quarantine survives" assertion
(and the whole project-route-testing block it lived in) was dropped entirely, not narrowed — the premise
it tested no longer applies once that route is never named.

Proven via `negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-runtime-union-provenance.mjs`, run FIVE times, once per round:
round 1 (against the pre-round-1 state, 7 of 8 scenarios RED, `ordinary-clear-by-id-unaffected` its own
negative control passing on both), round 2 (against commit `aa02ee8b`, the 4 new scenarios RED, all 8
round-1 scenarios still GREEN on both sides), round 3 (against commit `4aee1942`, the 2 new scenarios RED,
all 12 prior scenarios still GREEN on both sides), round 4 (against commit `c61be07f`, all 8 checks
across the 4 reworked sub-cases RED, all 13 other scenarios still GREEN on both sides), round 5 (against
commit `0e81c24c`, the new `ambiguous-refusal-never-embeds-unconfirmed-kill-clear-route` scenario's
MAJOR-fix checks RED, all 14 other scenarios — including the newly-added `assertRepoNotQuarantined`
checks folded into `redirect-targets-named-in-refusal-text-actually-clear` — still GREEN on both sides).
All five runs: GREEN restored, clean byte-identical tree restore confirmed — no regression across any
round. Full `merge-quarantine*.mjs` corpus (28 files, including this one) and 13 adjacent-caller tests
(kill-confirm/batch/vault-commit/quarantine-reason flows exercising this module indirectly) re-run
serially, one file at a time, after EACH round, all green.
