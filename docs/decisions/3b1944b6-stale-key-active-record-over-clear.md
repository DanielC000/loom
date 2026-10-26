# 3b1944b6 — stop `/clear` lifting a host's quarantine for a stale-key subdirectory

From `2a169469`'s Code Review (reviewer `85b2edc7`, follow-up; probed on both main and that card's own
branch, identically). `/clear` (`clearMergeQuarantineReporting` -> `clearMergeQuarantine`) on a RESOLVABLE
`R/sub` that holds its own ACTIVE record under a now-stale key LIFTED `R`'s REAL, unrelated quarantine
(`liftedRepoPaths:[R]`) and left `sub`'s own record active — the over-clearing direction: a human asking
to clear a subdirectory lifted the enclosing repo's genuine quarantine instead.

## Root cause

`clearMergeQuarantine`'s resolvable branch unconditionally called `clearMergeQuarantineByKey(canonicalRepoLockKey(repoPath),
repoPath, undefined, true)` — a FRESHLY-WALKED key, by `abccee85`'s own explicit, deliberate design for
the resolvable case. `clearMergeQuarantineByKey` then does a bare `activeQuarantines.get(key)` with no
check that the entry occupying that key is actually `repoPath`'s own identity. If `sub` once had its own
`.git` (its own key, its own independent raise) and that `.git` later disappears while the `sub` directory
itself still exists (`isRepoPathCurrentlyResolvable` only checks the path resolves, not that it has its
own `.git`), `canonicalRepoLockKey(sub)` now walks UP to `R`'s key. The clear then finds and lifts `R`'s
real, unrelated entry — while the identity-scoped pending-sweep inside the SAME function call only ever
helps when `sub`'s own record is PENDING, never when it is ACTIVE (no equivalent identity guard exists for
the active lookup at all).

Real-git repro (marker-only `.git`, the same convention `merge-quarantine-clear-by-path.mjs`'s own
`makeNestedGitFixture` uses): `R` and `R/sub` each get their own `.git` + independent `enterMergeQuarantine`
raise (2 distinct active entries, 2 distinct keys). `sub`'s `.git` is removed (`sub` dir stays resolvable).
`clearMergeQuarantineReporting(sub)` lifted `R` (confirmed gone from `listActiveMergeQuarantines()`,
`assertRepoNotQuarantined(R).ok === true` afterward — the real enforcement agreed `R` was wrongly
unblocked, IN-PROCESS; this repro alone proves nothing about across-reboot durability — see the test
file's own reboot check for that), while `sub`'s own entry stayed fully armed.

**Control, run before any fix**: the IDENTICAL fixture through `clearMergeQuarantineByRecordedPath`
(`/clear-by-path`) does NOT share the hole — it already matches active entries by `directPathIdentity`,
never a freshly-walked key, so it correctly lifted only `sub`'s own record and left `R` genuinely blocked
(`stillQuarantined:true` naming `R`). `clear-by-id` is structurally immune too (per its own doc,
`clearMergeQuarantineLatchFile` resolves to the matched entry's OWN already-known map key, never recomputes
a fresh walking key from a caller-supplied path at all).

## The fix (first attempt, REJECTED — see "Round 2" below for what actually shipped)

The Lead's initial ruling: factor the identity-match-and-clear body (active tier via
`activeMatchesAndLiftedKeysFor`, pending tier via a direct `directPathIdentity` filter, plus the full
disclosure composition) out of `clearMergeQuarantineByRecordedPath` into a shared helper
(`tryClearMergeQuarantineByOwnIdentity`), with `clearMergeQuarantine`'s resolvable branch calling it
UNCONDITIONALLY before falling back to the fresh-key clear on a no-match signal.

Implementing this literally broke TWO existing, passing tests — both calling `clearMergeQuarantine`
directly, both discovered by running the full-suite verification this card's own DoD demanded:

1. **`merge-quarantine-clear-by-path.mjs`'s (AJ) scenario** (card `07e3ad30`'s own pending-loop
   push-during-iteration fixture): a tied pending twin (`Q_reduce`) carrying a PRIVATE token (one NOT part
   of what the active entry's clear was lifting) is supposed to survive, REDUCED to just that private
   token (card `64119847`'s own "reduce, never remove" contract) — not be removed outright. The shared
   helper's own UNCONDITIONAL "matchedPending" sweep (`clearMergeQuarantineByRecordedPath`'s pre-existing,
   correct, `d4b25feb`-round-3 identity-wide-clear semantic) does not distinguish "never touched" from
   "already correctly reduced by an earlier matched active entry's own internal tie" — it re-swept the
   already-reduced twin and destroyed its surviving private token a second time.
2. **`merge-quarantine-raise-protect-failure.mjs`'s own p3 scenario** (`merge-quarantine-raise-protect-failure.mjs:2018`,
   under its "CARD 0dc514dc, Round 2" section): when `repoPath` has NO active match at all (pending-only),
   the shared helper's own "matchedPending" sweep never touches/protects the content physically occupying
   `repoPath`'s OWN fresh key — unlike the OLD `clearMergeQuarantine` behavior, which ALWAYS called
   `clearMergeQuarantineByKey` at the fresh key (even with `entry:undefined`, that call's own
   `keysToLift = [key]` fallback still runs the fresh key's own foreign-occupant file-protection, card
   `07e3ad30`). **Correction: this break is DISCLOSURE-only, never a content-loss bug** — a foreign degraded
   occupant (D) squatting on that exact physical file is never NAMED (losing its `latchKept`/
   `referencingRepoPaths` disclosure for D), but D's own content on disk survives byte-for-byte either way
   (nothing in the shared helper's own pending-only path ever reaches a write/unlink of that file when
   there's no active match to clear at the fresh key in the first place). The disclosure gap alone was
   still enough to reject routing unconditionally through the shared helper — a clear that silently stops
   telling the human "D is still there" is a real regression even when D's content is never destroyed.

Both failures trace to the SAME root cause: `clearMergeQuarantineByRecordedPath`'s own broad,
unconditional "identity-wide clear" semantic is NOT the same contract `clearMergeQuarantine`'s own callers
already rely on and test against (a narrower, per-key semantic that preserves a tied twin's own private
token). Routing `clearMergeQuarantine` through the exact same shared body changes its semantics, not just
its implementation.

## Round 2 — the corrected design that actually shipped

`clearMergeQuarantine`'s resolvable branch does NOT unconditionally reach for the shared helper. It first
computes `activeMatchesAndLiftedKeysFor(identity)` and filters out:
- any match AT the fresh key itself (handled by the plain fallback below either way), and
- any match that is a **degraded dual-arm twin** (`883e29bc`) — an entry ALSO referenced by
  `pendingUnresolvedQuarantines` by object reference. Such a twin (e.g. `64119847`'s own `P`, armed at a
  SECOND key purely for dual-tracking) must be left entirely to the fresh key's own
  `clearMergeQuarantineByKey` call and its internal tie/reduce logic — independently "clearing" it via its
  own secondary key would destroy a surviving private token that call would otherwise correctly preserve.
  This exclusion is itself load-bearing: a worker-written regression test for it (scenario E, below)
  reproduces the AJ/64119847 shape directly against `clearMergeQuarantine` and failed without it.

What remains after that filter (`ownMatchesElsewhere`) is the set of **genuinely independent** active
records sharing `repoPath`'s identity at a key other than the fresh one.

- **If `ownMatchesElsewhere` is empty**: fall through to the byte-identical, pre-card behavior — a single,
  unconditional `clearMergeQuarantineByKey(freshKey, repoPath, undefined, true)` call. This covers the
  ordinary case, the ancestor-collapse fallback (scenario B), every dual-tracked-twin shape (scenario E),
  and the pending-only shape (scenario C) exactly as before.
- **Otherwise**: call the shared `tryClearMergeQuarantineByOwnIdentity(repoPath, false, overrideTargets)`
  helper with `sweepUnrelatedPending: false` (never the broad matchedPending sweep for this caller) and an
  explicit `matchedOverride` target list: the fresh key's own match when one exists, else a `mustRun`
  synthetic target naming the fresh key (so its own foreign-occupant file-protection still runs even with
  nothing currently armed there — but NEVER when the fresh key holds a real entry belonging to a
  DIFFERENT identity, which is exactly the original over-clearing bug), followed by every entry in
  `ownMatchesElsewhere`.

`tryClearMergeQuarantineByOwnIdentity` gained two parameters to make this possible without duplicating the
~250-line active+pending matching and disclosure-composition body:
- `sweepUnrelatedPending: boolean` — gates the broad "matchedPending" sweep. `clearMergeQuarantineByRecordedPath`
  passes `true` (its own established, unchanged semantic). `clearMergeQuarantine` passes `false`.
- `matchedOverride?: Array<{key, repoPath, mustRun?}>` — when given, REPLACES the active-tier `matched`
  list the function would otherwise compute itself; `L`/`activeLiftedKeys` always still come from the
  FULL, unfiltered scan regardless. Only `clearMergeQuarantine` passes this.

Also added (both callers, loop-internal): a defensive skip for a matched key an EARLIER iteration's own
pending-sweep already vacated (a tied sibling removed via `subsetOfClearedTokens` rather than via its own
key) — re-clearing an already-gone key falls into `clearMergeQuarantineByKey`'s `!entry` branch, which
treats every remaining same-identity pending entry as tied-for-removal. A `mustRun` override entry is
exempt from this skip (it must always run, even with nothing currently armed at its key).

## Must not weaken (verified, per scenario in the new test file)

- (B) The ancestor-collapse clear for a registry-bound subdirectory with no independent identity of its
  own — still lifts the host, unchanged.
- (C) A pending-only identity match (no active entry at all) — still lifts repoPath's own pending record
  via the plain fallback's own internal pending-sweep, untouched.
- (D) `abccee85` round 5 finding 3's multi-key-twin shape (two genuinely independent active raises sharing
  one stored repoPath, under two distinct keys) — now reachable through `/clear` too, both lifted.
- (E) A degraded dual-arm twin (`883e29bc`/`64119847`) — its surviving private token is never destroyed a
  second time; the broad human route (`clear-by-path`) still fully lifts it afterward.
- `clearMergeQuarantineReporting`'s own `before` step stays on the real, mutating `resolveQuarantineFor`
  (the `2a169469` "before stays impure" exception) — untouched; this card only changes the actual clear
  call `clearMergeQuarantine` makes, never `before`.

## Known residual, named but out of scope (Round 1 — closed by Round 2 below)

A PENDING-only `repoPath` whose collapsed fresh key coincides with an unrelated, genuinely ACTIVE
ancestor can still have that ancestor's real quarantine wrongly lifted — the same mechanism as the
original bug, but for a pending (never-active) record instead of an active one. `ownMatchesElsewhere` is
computed from `activeMatchesAndLiftedKeysFor` alone (the ACTIVE tier), so it never fires when `repoPath`
has no active match of its own; the plain fallback then unconditionally clears the fresh key exactly as
before, which can still destroy a foreign active entry there. This card's own repro, the Lead's ruling,
and the manager's named test list are all scoped to the ACTIVE-record case; closing the pending variant
needs its own identity check before the plain fallback's own unconditional clear, and is left to a
follow-up card.

**Round 2 note:** the pending-only variant named above IS now closed, as a side effect of Round 2's own
`freshIsForeign` restructuring (a pending-only match now routes through the same `hasOwnPendingMatch`
check as an active one) — see "Round 2" below. The residual framing above is kept, struck through in
spirit but not in text, as the accurate history of what Round 1 actually shipped.

## Round 2 — generalizing the gate to `freshIsForeign` (closes a degraded-twin gap Round 1 missed)

Round 1's own trigger for reaching the shared helper was `ownMatchesElsewhere.length > 0` —
`ownMatchesElsewhere` being `matched` filtered to EXCLUDE both the fresh key's own match and any degraded
dual-arm twin (883e29bc). That exclusion is correct for its own stated reason (a twin must be left to the
fresh key's own tie/reduce logic) — but it has a side effect Round 1 didn't account for: when repoPath's
ONLY own active record IS a degraded twin, `ownMatchesElsewhere` is empty even though repoPath genuinely
has its own record — so Round 1's own code fell through to the plain, unconditional
`clearMergeQuarantineByKey(freshKey, …)`. When the fresh key happens to be occupied by a foreign host R
(the twin's own stale-key collapse, the same shape as the original bug), this wrongly lifted R's real
quarantine all over again — the exact regression this card exists to close, reopened by the very
exclusion that was supposed to protect a different scenario.

**The fix**: key the decision on whether the **fresh key itself** is occupied by a foreign identity, never
on the shape or non-emptiness of `ownMatchesElsewhere`:

```
freshEntry = activeQuarantines.get(freshKey)
freshIsForeign = !!freshEntry && directPathIdentity(freshEntry.repoPath) !== identity
```

- **`!freshIsForeign`** (fresh key empty, or already repoPath's own identity): keep Round 1's code
  EXACTLY — the `ownMatchesElsewhere`/degraded-twin-exclusion logic, unchanged. Scenario A (the original
  active-record bug, fresh key empty after the twin's own key resolved it away), scenario C (pending-only,
  fresh key empty), and scenario E (degraded twin, fresh key is repoPath's OWN still-armed key) all stay
  on this path, byte-identical.
- **`freshIsForeign` and repoPath has NO own record anywhere** (`matched.length === 0` and no
  identity-matched pending entry): today's key-walk — the deliberate, abccee85-documented ancestor
  collapse (scenario B). Unchanged.
- **`freshIsForeign` and repoPath HAS its own record** (an active match elsewhere, and/or a pending
  match): NEVER call `clearMergeQuarantineByKey(freshKey, …)` in this branch — R's quarantine must never
  even be looked at. Clear every one of repoPath's own active records via the shared helper instead,
  `matchedOverride = matched` with **no exclusion** this time — a degraded twin IS included, because the
  reason Round 1 excluded it (defer to the fresh key's own tie/reduce logic) simply does not apply when
  the fresh key isn't repoPath's own key at all; there is no tie/reduce logic to defer to.

**The pending-sweep problem this reopens, and its fix**: the shared helper
(`tryClearMergeQuarantineByOwnIdentity`) only ever had two pending-tier modes — `"broad"` (unconditional
identity-wide drop, `clearMergeQuarantineByRecordedPath`'s own established semantic) and `"none"` (Round
1's own choice for `clearMergeQuarantine`, to avoid re-sweeping an already-reduced twin — the AJ
regression). Neither fits the `freshIsForeign`-with-own-record branch: `"none"` would silently miss a
genuinely independent pending-only record sharing repoPath's identity; `"broad"` would re-destroy a
twin's surviving private token exactly like the AJ regression, since a matched active entry's own clear
can legitimately REDUCE (not remove) a tied pending twin via `clearMergeQuarantineByKey`'s own internal
tie logic.

Added a third mode, `"unreduced"`: the same identity-wide pass as `"broad"`, but excluding any pending
wrapper the active-tier loop just above already reduced in THIS SAME call. Detected by snapshotting each
identity-matched pending wrapper's own `.entry` object reference BEFORE the active-tier loop runs (right
after the pre-existing placeholder-reconcile pass, never before it — reconciling a stale boot placeholder
is not itself a "reduce"), then comparing after: a reduce reassigns `p.entry` in place (via
`replaceEntryEverywhere` and the direct `p.entry = writtenTwin.entry` assignment in
`clearMergeQuarantineByKey`'s own reduce branch), so a changed reference means "already handled, skip";
an unchanged (or newly-appeared) reference means "never touched, eligible."

A FULL removal (not a reduce) already splices the pending wrapper out of `pendingUnresolvedQuarantines`
entirely (the degraded-twin-removal shape, `p.entry === entry`) — such a wrapper is simply absent from the
array by the time the `"unreduced"` filter runs, so no special-casing is needed for it; the snapshot
comparison only ever matters for a wrapper that SURVIVES the active-tier loop with a changed `.entry`.

`clearMergeQuarantine`'s `freshIsForeign` branch passes `"unreduced"`; its `!freshIsForeign` branch keeps
passing `"none"` (Round 1, unchanged); `clearMergeQuarantineByRecordedPath` keeps passing `"broad"`
(unchanged).

**File safety in the `freshIsForeign`-with-own-record branch**: R's own final latch file is never
unlinked here — this branch never calls `clearMergeQuarantineByKey(freshKey, …)` or
`deleteMergeQuarantineLatchByKey` at R's key at all, by construction (the whole point of the restructuring
is that R's key is never a target). Sub's own files are deleted via `deleteMergeQuarantineLatchByKey` per
owned key (inside the active-tier loop, scoped to repoPath's own matched keys) and
`sweepOwnLatchFileUnlessOwnedElsewhere` (inside the pending pass, for sub's own pending `sourceFile`) —
both already protect a file a SURVIVING entry (R's) physically owns: `deleteMergeQuarantineLatchByKey`
via `protectUnincorporatedOccupantBeforeDelete`/content-claimant checks, and
`sweepOwnLatchFileUnlessOwnedElsewhere` via `physicalOwnerRepoPaths`, which scans every live
`activeQuarantines` entry (including R's) for a basename match before ever unlinking. Verified directly,
not assumed: a dedicated scenario arms a pending entry whose `sourceFile` is forced (via the test-only
arming seam) to collide with R's own final basename, and confirms R's file survives the clear.

## Must not weaken (Round 2 additions — verified per scenario in the test file)

- (a) R/sub raised while sub does not exist yet; `mkdir sub` with no `.git`; `/clear(sub)` must lift ONLY
  sub's own record (none exists — `/clear(sub)` genuinely has nothing of sub's own, so this is scenario B,
  the ancestor collapse) OR, when sub DOES hold its own active record at a stale key, must lift sub's own
  record and leave R's real quarantine intact.
- (b) `R/sub` has its own `.git` and its own raise; reboot with `sub` absent (via the real
  `reenterMergeQuarantinesAtBoot`); `sub` reappears without its own `.git` — `/clear(sub)` must lift only
  sub's own (now stale-keyed) record, never R's.
- (twin) `sub`'s ONLY record is a degraded dual-arm twin (883e29bc/64119847's own shape) while the fresh
  key is foreign (occupied by R) — the twin is lifted via its own key, R's real quarantine survives.
- A pending entry whose `sourceFile` is forced to collide with R's own final basename — R's file survives
  the clear.

**The `L`-fail-open-in-principle finding, scoped**: the pre-loop that builds `L` (the full lifted-key
union, computed once before any delegated clear) scans every identity-matching pending entry
UNCONDITIONALLY, regardless of `pendingSweep` mode — a CR finding noted that for `"none"` mode (no outer
pending pass at all), this can add a key to `L` that this call never actually touches, letting some OTHER
key's own protect call wrongly read "already being lifted" off it — fail-open in principle. Fixed
narrowly: `"none"` mode now adds NOTHING to `L` from this pre-loop (that mode's own outer sweep touches
zero pending entries by construction, so there is nothing it could legitimately contribute); `"broad"` and
`"unreduced"` are UNCHANGED (every `"broad"`-swept entry is already known to be touched; an `"unreduced"`
entry not yet known to be reduced-or-swept still needs `L` current for the later matchedPending pass's own
per-entry protect calls, and narrowing it further would require replicating `clearMergeQuarantineByKey`'s
own tie-detection logic externally — left as a named, deliberately out-of-scope residual rather than a
guessed, unverified narrowing).

## Do not (Round 2 additions)

- Do not key the shared-helper decision on `ownMatchesElsewhere.length` — key it on `freshIsForeign`
  instead; the `ownMatchesElsewhere` degraded-twin exclusion is still correct, but only for the
  `!freshIsForeign` branch (see "Round 2" above for the gap this closes).
- Do not exclude a degraded dual-arm twin from the `freshIsForeign`-with-own-record branch's own
  `matchedOverride` — unlike the `!freshIsForeign` branch, there is no fresh-key tie/reduce logic to defer
  to when the fresh key belongs to a different identity entirely; excluding it there would leave it
  unlifted with no other path to lift it.
- Do not pass `"broad"` for the `freshIsForeign`-with-own-record branch — it re-sweeps an already-reduced
  pending twin and destroys its surviving private token a second time (the AJ regression, reopened).
  Use `"unreduced"`.
- Do not build the `identityPendingSnapshot` from `p.entry` values read BEFORE the placeholder-reconcile
  pass — a placeholder reconcile is not itself a "reduce," and snapshotting too early would make every
  reconciled (but not actually reduced) wrapper look falsely "already touched."

## Round 3 — `clearMergeQuarantineReporting`'s own `before` query can ABSORB `sub` into R's union first

Round 2's own new test scenarios ((a)/(b)/(twin)/(file-safety)) all FAILED when routed through the real
`/clear` entry point (`clearMergeQuarantineReporting`), even though `clearMergeQuarantine` itself — called
directly, bypassing the wrapper — was independently verified correct for every one of them. The cause is a
second, wholly separate mechanism:

`clearMergeQuarantineReporting(repoPath)` (merge-quarantine.ts:~6050) calls `before =
resolveQuarantineFor(repoPath)` BEFORE `clearMergeQuarantine` runs. For a resolvable `repoPath` that
reaches `activeMergeQuarantineFor` (merge-quarantine.ts:~5664), whose pre-existing "cross-tier sibling
absorption" (card `8a1bc2ef`, `collectCrossTierSiblingIndices`/`isKeyVerifiedFor`) matches a pending entry
to a foreign active entry purely by CURRENT `canonicalRepoLockKey` equality, with NO identity check at all.
When `sub`'s own pending (or degraded-twin) record collapses onto `R`'s key — exactly the shape this card
is about — this absorption silently UNIONS `sub`'s token into `R`'s already-verified active entry (via
`consumeMatchedPendingsIntoArmedEntry`, merge-quarantine.ts:1632) and REMOVES `sub`'s pending wrapper (and,
for a dual-arm twin, re-points its OTHER active-map slot too, via `replaceEntryEverywhere`) — all before
`clearMergeQuarantine` ever gets a chance to see `sub`'s own record. By the time it runs, `matched` is
empty and no pending entry matches `sub`'s identity any more, so the Round-2 `freshIsForeign` gate's own
`!hasOwnPendingMatch` branch (correctly, from its own point of view) falls to the ancestor-collapse
fallback — which now wrongly clears the UNIONED entry, lifting `R` too.

Confirmed pre-existing, not a Round 1 or Round 2 regression: `collectCrossTierSiblingIndices`/
`isKeyVerifiedFor`/`activeMergeQuarantineFor` were byte-identical at `50b9392c`'s own parent commit. Also
confirmed Round 1's own scenarios A-E never exercised this path: A's `sub` holds an ACTIVE (not pending)
record, and `activeMergeQuarantineFor` returns `direct` immediately whenever `pendingUnresolvedQuarantines`
is empty at query time, short-circuiting past the absorption check entirely.

### The Lead's ruling (verbatim intent, condensed)

The absorption's own enforcement outcome is RIGHT — once `sub`'s key collapses onto `R`, `sub` really is
inside `R`'s tree, and enforcing `sub` through `R`'s union is correct. The defect is narrower: after
absorption, `/clear(sub)` lifts the WHOLE union (R included) instead of removing only `sub`'s own
CONTRIBUTION from it. Fix: REDUCE the union (remove `sub`'s own token(s) and contributor/provenance
membership, leave `R`'s own tokens/file/armed keys intact), the same "reduce, never remove" shape card
`64119847` established for tied twins.

### Checkpoint findings (ordered per the Lead's own 4 questions)

1. **Does absorption record provenance? Is it durable?** IDENTITY-level: yes, durably.
   `consumeMatchedPendingsIntoArmedEntry` computes `losingRepoPaths` (the union's contributing identities
   minus its own winning `repoPath`) and folds them into `unioned.contributorRepoPaths`
   (merge-quarantine.ts:~1646-1650); that field is PERSISTED (serialized, unlike `armedKeys` — see its own
   doc comment). TOKEN-level: NO. Tokens are flat-merged (`unionQuarantineEntries`'s own
   `[...new Set([...older.tokens, ...newer.tokens])]`) with zero tagging of which UUID came from which
   contributor, and the absorbed pending wrapper's own separate entry object (and its `activeQuarantines`
   slot, if any — re-pointed via `replaceEntryEverywhere`) is gone the moment absorption succeeds. So
   "remove `sub`'s own token(s)" as literally worded in the first draft of this ruling is NOT mechanically
   possible without a new field — nothing today records which specific token UUID(s) are `sub`'s.
2. **The reduce design, given (1):** reduce at the IDENTITY level only. Filter `identity` out of the
   foreign union's own `contributorRepoPaths` (undefined when it empties); never touch `tokens`,
   `armedKeys`, `repoPath`, or the physical file. Durably rewrite via the existing `writeMergeQuarantineLatch`
   chokepoint at every key the entry is armed under (`liveArmedKeysOf` + `entryStillOwnsKey`, the same
   ownership gate card `64119847`'s own reduce branch uses), re-pointing every in-memory slot via
   `replaceEntryEverywhere` first. Never calls `deleteMergeQuarantineLatchByKey`/unlinks anything, so `R`'s
   file survives BY CONSTRUCTION — nothing in this path ever targets it for deletion, which is why the
   file-safety scenario needs no separate protection logic.
3. **Ordering — post-absorption state, or a pure pre-absorption peek?** Post-absorption, necessarily. By
   the time `clearMergeQuarantine` runs (invoked from `clearMergeQuarantineReporting` AFTER its own
   mutating `before` call, which the Lead's ruling keeps mutating per `2a169469`'s own boot-unreadable-vs-
   corrupt exception), the absorption has already happened — there is no "prevent it" option without
   reordering `before`. This isn't a weakness: the ruling endorses the absorption itself as correct: the
   fix only needs to react to its RESULT, which reading the post-absorption `contributorRepoPaths` gives
   directly. The pure peek twin (`activeMergeQuarantineForPeek`, used by `stillBlockedEntryFor` for
   disclosure-only checks) has no role in deciding what to mutate here.
4. **Must-not-weaken + parity:** scenarios A-E never populate `contributorRepoPaths` in any fixture (none
   go through this absorption path — A's `sub` is ACTIVE not pending, and the absorption check
   short-circuits whenever `pendingUnresolvedQuarantines` is empty), so the new branch is a no-op for all
   of them; scenario D's two entries share the SAME `repoPath` (no foreign/contributor relationship at
   all), also unaffected. AJ (card `07e3ad30`) and p3 (card `0dc514dc`) touch unrelated pending-tie/
   protect-call mechanics, untouched. Clear-by-path/clear-by-id do NOT share this destructive hole:
   clear-by-path never touches the fresh key at all (card `883e29bc`'s own design) and, if `sub`'s
   identity has already been absorbed away, its own identity-matching finds nothing and it reports
   NOT-FOUND via its existing fallback — never destructive, just currently unable to reduce either (a
   narrower LIMITATION, named as a residual below, not fixed by this card). Clear-by-id addresses a
   specific latch id directly, not an identity, so it is a different question entirely.

### THE TOKEN QUESTION — proven with real-git probes, not inferred

Before approving the reduce design, the Lead required proof that `R`'s own owner is not locked out once
`sub`'s absorbed token is left inside `R`'s union with no provenance naming it. Three probes, each against
a real two-repo fixture (`R` with its own `.git`, raised; `sub = R/sub`, raised while unresolvable, then
made resolvable with no own `.git`, collapsing onto `R`):

- **(i) Can `R`'s own owner still fully lift `R`?** YES, via `R`'s own `/clear(R)`
  (`clearMergeQuarantineReporting(R)`) and `clear-by-path(R)` (`clearMergeQuarantineByRecordedPath(R)`) —
  both unconditional, full clears, verified to fully lift `R` (`activeMergeQuarantineFor(R)` becomes
  `undefined`, `assertRepoNotQuarantined(R).ok` becomes `true`) with `sub`'s absorbed token still present
  going in. Clear-by-id with `R`'s own bare latch id REFUSES — but this is PRE-EXISTING, fail-closed
  ambiguity behavior (card `9a55fb90`, unrelated to this card) for ANY latch id a contributor union makes
  ambiguous, and the refusal text itself points at clear-by-path as the correct route. The ONE route that
  does NOT fully lift `R` alone is the narrower, PER-TOKEN automatic settlement
  (`clearMergeQuarantineByToken(R, R's own token)`, the mechanism `onTreeDeathSettled` closures in
  `git/worktrees.ts`/`git/batch-merge.ts` use) — `sub`'s leftover token keeps the set non-empty, so
  `clearActiveEntryTokenAtKey`'s own `remaining.length === 0` gate never fires. This is the union's
  PRE-EXISTING behavior the instant absorption happens, with or without this card's reduce (verified: it
  depends only on the `tokens` array, never on `contributorRepoPaths`) — never a new regression this
  reduce creates.
- **(ii) Across a reboot:** proven with a real child-process reboot (`reenterMergeQuarantinesAtBoot`
  against the on-disk latch, its `contributorRepoPaths` manually stripped to simulate exactly what the
  reduce's own durable write produces). Boot re-arms `R` with BOTH tokens and no `contributorRepoPaths` at
  all — and (i) still holds identically afterward: the per-token auto-settle still leaves it armed, while
  `R`'s own full `/clear(R)` still fully lifts it.
- **(iii) Does the absorbed pending wrapper's own `sourceFile` survive on disk (durable token-level
  provenance via the leftover file)?** NO. Zero `pending-*.json` files remained after absorption in every
  probe — `consumeMatchedPendingsIntoArmedEntry` deletes every matched `sourceFile` via
  `deleteSourceLatchIfSuperseded` on a successful write. This closes off the one other channel that might
  have given token-level provenance for free.

Both (i) and (ii) held, so the Lead's own pre-committed fork applies: the design is approved as proposed,
implemented as described in (2) above (`reduceForeignUnionContributor`, merge-quarantine.ts), and this
leftover-token behavior is recorded here rather than treated as a defect.

### A real regression, found by the full corpus run: `freshIsForeign` needs `freshKey !== identity` too

`merge-quarantine-degraded-occupant-guard.mjs`'s own W/teamA scenario broke the moment the reduce shipped.
`W` is a REAL repo (its own `.git`), raised directly. `teamA = W/teamA` has NO `.git` of its own and
collapses onto `W`'s key. `teamA`'s OWN stale pending record predates `W`'s raise, so when `W`'s raise
hits `enterMergeQuarantine`'s own `existing` branch, `unionQuarantineEntries`'s age-based winner rule
(older wins the `.repoPath` spread) names the union's own `.repoPath` as `teamA` — NOT `W` — even though
`W` is the one with the real, independent git identity and `teamA` is the path-collapsed one. `W`'s own
raise is folded in as a mere `contributorRepoPaths` entry (the SAME mechanism `enterMergeQuarantine`'s own
`existing` branch uses as `consumeMatchedPendingsIntoArmedEntry`'s absorption, per that field's own doc
comment). The test calls `clearMergeQuarantine(w)` directly, expecting (and needing) the WHOLE union
lifted — `W` asking to clear its OWN, genuinely-owned key must always fully lift whatever sits there,
regardless of which identity's name a naming accident gave the union.

`freshIsForeign`'s own definition (`!!freshEntry && directPathIdentity(freshEntry.repoPath) !== identity`)
had no way to tell this apart from the card's own target shape (`sub`, which has no own key at all) — both
produce `freshEntry.repoPath !== identity`. The actual discriminator: does `repoPath` ITSELF currently own
its own key, independent of what the union's own `.repoPath` field says? Verified directly (a real-git
probe, not inferred): for a path with its own `.git`, `canonicalRepoLockKey(path) === directPathIdentity(path)`
(both resolve to the same real toplevel); for a path with no own `.git` (this card's own `sub`),
`canonicalRepoLockKey(path)` walks UP to the ancestor's key while `directPathIdentity(path)` stays at the
path's own literal (realpath'd) location — the two values provably diverge.

Fix: `freshIsForeign` now also requires `freshKey !== identity` — a path that owns its own key is NEVER
foreign, no matter what a union sitting there happens to name itself. This affects NEITHER of this card's
own scenarios (`sub` never owns its own key, in any of A/a/b/twin/file-safety) nor scenario E (`y` DOES own
its own key, but `freshEntry.repoPath === y` there too, so `freshIsForeign` was already `false` before this
fix) — confirmed by re-running the full corpus after the fix: the W/teamA regression (and four other files
it had taken down the same way) are green again, and this card's own test file is unaffected.

## Tests

`packages/daemon/test/merge-quarantine-3b1944b6-stale-key-active-record-overclear.mjs` — Round 1 shipped
five scenarios (A-E, as named above; C is now labeled a CONTROL — see "Round 2" above for why — not a fix
witness), each real-git (marker-only `.git`), one process. Round 2/3 add five more — (a), (b), (twin),
(file-safety) (each now asserting the Round 3 REDUCE outcome: R stays active and blocked, R's own latch
file is byte-identical except `contributorRepoPaths`, sub is removed from it, and the result's `reason`
carries the "quarantined by ANOTHER repo's own" wording naming R — not the earlier "lift nothing of R's"
framing Round 2 alone would have produced), plus a new (still-liftable) scenario proving R's own owner can
still fully lift R afterward, in-process and across a real reboot, with sub's leftover token left inside
the union (THE TOKEN QUESTION, see "Round 3" above). (b) and (still-liftable)'s own reboot half run via a
real child-process reboot; the rest in-process. RED on `50b9392c` (crashes on an `ENOENT` reading R's own
final file — the bug's own unconditional lift deleted it; the negative-control tool correctly classifies
this non-zero exit as RED) / GREEN after, tree confirmed byte-identical, via `pnpm --filter @loom/daemon
negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-3b1944b6-stale-key-active-record-overclear.mjs`. Solo runtime ~1.7s
— no `TEST_TIMEOUT_OVERRIDES` entry needed.

Full `merge-quarantine*.mjs` corpus (78 files, this one included) run individually under BOTH the default
env state and `LOOM_DEV=1 LOOM_SUPERVISED=1` — all green (see the worker's own report for the per-batch
breakdown).

## Do not

- Do not route `clearMergeQuarantine`'s resolvable branch through the shared
  `tryClearMergeQuarantineByOwnIdentity` helper unconditionally — see "Round 2" above for the two real
  test regressions (AJ, p3) that caused, and why the `ownMatchesElsewhere` gate is the correct trigger.
- Do not let `clearMergeQuarantine` pass `sweepUnrelatedPending: true` — that broad sweep belongs ONLY to
  `clearMergeQuarantineByRecordedPath`'s own established contract; this caller's narrower, per-key
  semantic (a tied twin's own private token must survive, card `64119847`) depends on it staying `false`.
- Do not drop the dual-arm-twin exclusion from `ownMatchesElsewhere` — a matched entry ALSO referenced by
  `pendingUnresolvedQuarantines` by object reference must never be independently cleared via its own
  secondary key; it must be left to the fresh key's own tie/reduce logic. Scenario E pins this directly.
- Do not drop the vacated-key skip inside `tryClearMergeQuarantineByOwnIdentity`'s matched loop, and do
  not widen it to also skip a `mustRun` override entry — that entry must always run, even with nothing
  currently armed at its key, or `clearMergeQuarantine`'s own foreign-occupant file-protection (card
  `07e3ad30`) silently stops firing for the pending-only shape.
- Do not add a `mustRun` fresh-key target when the fresh key currently holds a real entry belonging to a
  DIFFERENT identity — that is exactly the original over-clearing bug; the fresh key is omitted from the
  target list entirely in that case, never forced.
- Do not treat the pending-only-collides-with-an-active-ancestor shape as still open — it IS closed, by
  Round 2's `hasOwnPendingMatch` check when the pending record survives to be seen, and by Round 3's
  reduce when `clearMergeQuarantineReporting`'s own `before` has already absorbed it away first. The
  stale claim this bullet once made (and the record's own earlier "Round 2 note" correcting it) is kept
  only in spirit; read "Round 3" above for the current, accurate mechanism.

## Do not (Round 3 additions)

- Do not attempt token-level removal in `reduceForeignUnionContributor` even if a future field makes it
  look possible — see "Round 3"'s own THE TOKEN QUESTION section: a real probe proved the union's owner
  can still fully lift it with the leftover token left in, so there is no safety reason to attempt it.
- Do not call `reduceForeignUnionContributor` with anything other than the CURRENT, post-absorption
  `freshEntry` object — it must be re-pointed via `replaceEntryEverywhere` before `liveArmedKeysOf`/
  `entryStillOwnsKey` are consulted, or the write loop computes owned keys against a stale object.
- Do not read `clearMergeQuarantineReporting`'s own return type as carrying a `stillQuarantined` field —
  it never has one; the still-blocked disclosure rides in `reason` alone (via the wrapper's own `after =
  stillBlockedEntryFor` check), and a test asserting otherwise will pass for the wrong reason or fail on
  a false negative. `clearMergeQuarantine`'s OWN internal return type is a different shape; do not conflate
  the two.
- Do not extend this card to also fix clear-by-path's own inability to reduce a contributor — it is a
  named, deliberately out-of-scope residual (see below), not a destructive bug like the one this card
  fixes; a human calling clear-by-path for a contributor-absorbed identity gets a truthful NOT-FOUND
  disclosure today, never a wrongful lift.

## Known residual, named but out of scope (Round 3)

- **Clear-by-path/clear-by-id cannot reduce a contributor membership either** — only `/clear`
  (`clearMergeQuarantine`, via this card's new `reduceForeignUnionContributor`) can. Clear-by-path, when
  `sub`'s identity has already been absorbed away, correctly reports NOT-FOUND-but-still-blocked (never
  destructive) but has no route to drop `sub` from `R`'s own `contributorRepoPaths`. Extending the same
  reduce to clear-by-path is a natural follow-up, not required by this card.
- **Card `3be11be4`'s own mirror shape is NOT closed by this card.** `3be11be4` describes the OPPOSITE
  absorption direction: `sub` raises first (its key already collapsed onto `R`), BECOMES the union's own
  `.repoPath` (the PRIMARY identity), and `R` raises second, folding in as a mere contributor. There,
  `/clear(sub)` hits the UNCHANGED `!freshIsForeign` branch (false, since the union's own `.repoPath` IS
  `sub`'s identity) and falls through Round 1's own `ownMatchesElsewhere`-empty path straight to the
  unconditional fresh-key clear — reproducing `3be11be4`'s own "lifted:[sub, R]" bug exactly. This card's
  reduce lives entirely in the `freshIsForeign` branch and does not reach this mirrored shape. The same
  token-granularity wall applies there too, in a HARDER form: reducing away the PRIMARY identity would
  require promoting a surviving contributor to the new `.repoPath`, and without token-level attribution
  there is no principled way to decide which of the union's tokens would go with that promotion. Left to
  `3be11be4`'s own ruling — possibly a refusal, matching clear-by-id's own posture for an ambiguous latch,
  rather than an attempted promotion.

## Round 4 — Code Review `b9cef62a`'s own CRITICAL finding: a SECOND `/clear(sub)` reopens the over-clear

Code Review `b9cef62a` (the SECOND review of this card, at commit `d94dcb8d`, which shipped Round 2/3
above) found Round 3's own reduce leaves no durable trace that `sub` was ever folded in:
`reduceForeignUnionContributor` drops `sub` from `R`'s `contributorRepoPaths` — the ONLY record of its
membership — so a SECOND `/clear(sub)` (in-process, or after a reboot) sees `contributorRepoPaths` come
up empty, `matched` empty, no pending match, and falls through `clearMergeQuarantine`'s `freshIsForeign`
branch to scenario B's ancestor-collapse clear, lifting `R`'s WHOLE union a SECOND time. Measured directly
on `d94dcb8d`: `clear1` → `lifted:[]` (R blocked, correct); `clear2` → `lifted:[sub, R]` (R UNBLOCKED). The
same shape reproduces across a real `reenterMergeQuarantinesAtBoot`, in the degraded-dual-arm-twin shape,
and in the "(b)" real-reboot-then-collapse construction above (Round 2's own scenario (b)).

### The Lead's ruling

Keep a durable marker that `sub`'s membership was reduced: a new field,
`MergeQuarantineEntry.reducedContributorRepoPaths` (a `string[]` of `directPathIdentity` values, not raw
paths — see the field's own doc comment), written by the SAME `writeMergeQuarantineLatch` call the reduce
already makes. `clearMergeQuarantine`'s `freshIsForeign` routing now checks this field ALONGSIDE
`contributorRepoPaths`: an identity present in `reducedContributorRepoPaths` routes BACK to
`reduceForeignUnionContributor` (an idempotent no-op — nothing left to drop, `R` stays blocked, `sub` is
still reported as blocked under `R`'s quarantine) and must NEVER reach scenario B. The marker:

- is carried forward at every copy/rebuild site `contributorRepoPaths` itself is — byte-for-byte the same
  treatment, at every one of its own sites: `unionQuarantineEntries`, `reconcileClearedEntryIfPlaceholder`,
  `protectOccupantContentBeforeDelete`'s own protective copy, `mergeTokenIntoPendingEntries`,
  `divertRaiseEntry`, `readPendingDivertFileAt`, `latchEntryFromParsedRecord`, and every one of PASS
  1/1b/safety-tmp's own boot-time parses;
- dies with the entry's own latch: a genuine lift of `R`'s own union (its own `/clear`/clear-by-path/
  clear-by-id) discards the whole record, this field included — a fresh raise on `R` afterward starts
  clean;
- never implies the identity's own token was removed (it was not, and per Round 3's own "THE TOKEN
  QUESTION" section above, cannot be) — membership history only.

`stillQuarantinedReason`'s own `isHostOfContributor` check is widened to ALSO treat a
`reducedContributorRepoPaths` match as "host of a contributor" — restoring the disclosure the reduce's
own membership-drop otherwise loses on a SECOND clear (the token stays outstanding either way, so the
wording stays accurate for both).

### Minor fixes (same Code Review)

- **Minor 2 — `reduceForeignUnionContributor` could mint a NEW latch file at `sub`'s own OLD key.**
  `sub`'s absorption into `R`'s union had already deleted that file, but `sub`'s in-memory slot had been
  re-pointed to `R`'s union object, so an unqualified `liveArmedKeysOf`/`entryStillOwnsKey` scan counted
  the old key as "owned" anyway. Fixed: the durable rewrite loop now additionally requires
  `fs.existsSync(quarantinePathForKey(k))` — it only ever rewrites a key that already has a real file on
  disk, never mints one where absorption left nothing. The function's own prior doc comment claiming it
  "never touches... the physical latch file" was corrected (it does, at an owned, already-present key)
  rather than restated.
- **Minor 3 — the (still-liftable) scenario's own `*** THE FIX ***` labels were relabeled `CONTROL`** —
  that safety property (`R`'s own owner can still fully lift `R` after the reduce) held before this card
  too; this round changes nothing about it.
- **Minor 4 — scenario (a)'s `JSON.parse(fs.readFileSync(...))` reads of `R`'s own latch file threw
  ENOENT on `50b9392c`** (the bug's own unconditional lift had already deleted the file), aborting the
  whole test file before (b)/(twin)/(file-safety)/(still-liftable) ever ran. Fixed with an
  existence-tolerant `readLatchFileIfExists` helper (returns `null` rather than throwing) used everywhere
  this file reads `R`'s own latch — every scenario's own RED is now independently observable.

### Tests (Round 4 additions)

Four new scenarios, each going through the REAL `/clear` entry point (never the inner function directly
— lesson 249): `(round4-cc)` clear → clear, in-process; `(round4-crc)` clear → reboot → clear (a real
child-process reboot between the two clears, proving the marker survives the `reenterMergeQuarantinesAtBoot`
parse); `(round4-twin)` the degraded-dual-arm-twin shape, re-cleared a second time after its own first
reduce; `(round4-crb)` the "(b)" shape above — reboot, collapse, then clear TWICE inside the same child
process. Each is RED on `d94dcb8d` (R unblocked on the second clear) and GREEN after this round's fix. The
existing (still-liftable) CONTROL is extended with a precondition check that the marker is actually
present after the first reduce, and a post-full-lift check that it is gone afterward.

RED/GREEN counts AS THIS ROUND LANDED (commit `3c2c213e`; superseded below, kept for history — do not
read these as the current count): `50b9392c` — 40 FAILED. `d94dcb8d` — 17 FAILED (5 marker-presence
assertions on the pre-existing (a)/(b)/(twin)/(file-safety)/(still-liftable) scenarios, plus every check
in the 4 new round4-cc/crc/twin/crb scenarios). HEAD — 0 FAILED. Solo runtime ~1.25s.

### Round 4, continued — the directory-listing blind spot (commit `a29f09b1`, no separate CR round number)

`sameExceptContributors` (the byte-identical-latch-file check used throughout this round) can only ever
prove `R`'s OWN final latch file is unchanged — it is blind to a SECOND, stray file appearing elsewhere in
`MERGE_QUARANTINE_DIR`, which is exactly CR2's own Minor-2 repro. Added `checkDirListingExactly`: asserts
the FULL `fs.readdirSync(MERGE_QUARANTINE_DIR)` listing (sorted) against an exact expected set — computed
per scenario as `[a scenario-local baseline snapshotted at the TOP of the block] ∪ {R's own basename}`
(plus, at a pre-absorption "right after reboot" checkpoint in (b) and (round4-crb) specifically, also
`∪ {sub's own pre-removal key basename}`, since that file legitimately still exists at that exact
instant) — added in all 8 scenarios where `reduceForeignUnionContributor` runs: (a), (b), (twin),
(file-safety), (round4-cc), (round4-crc), (round4-twin), (round4-crb), after every clear and after every
reboot the scenario has. Calibrated empirically against HEAD first (a scratch probe script, not assumed),
confirmed on `d94dcb8d` to go RED in exactly 8 of the 15 new assertions — (b) and (twin) after their own
clear (the two shapes CR2 itself measured: a stray file resurrected at sub's old key, and one minted at
the synthetic secondary key respectively), plus all four round4-* scenarios after their second clear
(where the broader over-clear bug deletes `R`'s own file outright, failing even "just R's file"). The
other 7 pass on `d94dcb8d` too — no reduce ever runs in those shapes.

**Current, accurate RED/GREEN counts for the full file as of `a29f09b1`** (same negative-control method —
two scratch `git worktree`s under `$LOOM_SCRATCH_DIR`, each `pnpm install --prefer-offline` + built):
`d94dcb8d` — **25 FAILED** (the 17 above, PLUS the 8 new Minor-2 directory-listing REDs just described).
HEAD — 0 FAILED. Solo runtime ~1.2s. The `50b9392c` figure (40 FAILED) is unaffected by this addition —
every scenario there was already failing for an unrelated, earlier reason before any directory-listing
check could even run.

## Do not (Round 4 additions)

- Do not drop `reducedContributorRepoPaths` at any copy/rebuild site — exactly the same rule
  `contributorRepoPaths` itself carries, for exactly the same reason: a dropped field silently reopens the
  second-clear bug this round closes.
- Do not store raw repoPath strings in `reducedContributorRepoPaths` — it holds `directPathIdentity`
  values (the SAME normalized form `clearMergeQuarantine`'s own `identity` variable already is), so a
  membership check is a plain `.includes(identity)`, never a `directPathIdentity(c) === identity`
  map/filter like `contributorRepoPaths` needs.
- Do not widen `reduceForeignUnionContributor`'s own owned-keys write loop back to an unqualified
  `liveArmedKeysOf`/`entryStillOwnsKey` scan — Minor 2 above is exactly the bug that shape reproduces.

## Round 5 — Code Review `aaa1c93f` (the THIRD review, at `a29f09b1`): the same marker covers a second entry shape, plus a `liftedRepoPaths` under-report and a test-gap fill

CR3 ran the real `/clear` route and real child-process reboots end to end, and confirmed the Round 4
marker design holds on every CR2 CRITICAL shape (the 25-FAILED negative control above). It found one more
CRITICAL-class reopening (item 4, pre-existing — Round 1's own scenario A), one MINOR under-report (item
3), and a genuine test-coverage gap (item 4's own tail, item 5).

### Item 2/4 (CRITICAL, Lead ruling) — "shape A": the marker covers a SECOND entry shape

Round 1's own scenario A: `sub` holds its own genuinely INDEPENDENT active record (its own real raise, own
key) — never folded into `R`'s union at all, no absorption, no `contributorRepoPaths` membership ever
existed. `sub`'s `.git` is then removed, collapsing its fresh key onto a wholly separate, foreign `R`. The
FIRST `/clear(sub)` correctly lifts ONLY `sub`'s own record (`clearMergeQuarantine`'s `freshIsForeign`
branch routes it through `tryClearMergeQuarantineByOwnIdentity`'s "unreduced" own-identity path, never
`reduceForeignUnionContributor` — there is no union here to reduce) and truthfully tells the caller `R` is
"a separate quarantine that this clear never addressed." But once `sub`'s own record is gone, nothing
records that `sub` was ever here — a SECOND `/clear(sub)` (in-process, or after a reboot) sees `matched`
empty and `contributorRepoPaths` empty (it was never populated to begin with) and falls through to
scenario B's ancestor-collapse clear, lifting `R` too. The SAME user-visible harm CR2 called CRITICAL,
reached through a structurally DIFFERENT path than Round 4's own fix covers.

**The Lead's ruling:** the SAME `reducedContributorRepoPaths` marker covers this shape too — never a
second, parallel field. When `/clear(sub)` clears `sub`'s own record while `sub`'s fresh key is occupied
by a foreign entry (`R`), ALSO record `sub`'s identity in `R`'s own `reducedContributorRepoPaths`, via the
same one-tmp-plus-rename write discipline `reduceForeignUnionContributor` already uses. New function
`markIdentityAsReducedOnForeignKey(entry, identity)` does exactly this (idempotent — a no-op if already
marked).

**(SUPERSEDED BY ROUND 6 — do NOT follow this ordering.)** This call originally ran AFTER
`tryClearMergeQuarantineByOwnIdentity` succeeded (right after `sub`'s own record was already cleared).
CR4 (Round 6) found that NOT atomic and fail-OPEN — a crash or write failure in that exact window left
`sub`'s record gone and `R` unmarked, reopening this same CRITICAL. See Round 6's own item 1/2 for the
corrected ordering (stamp FIRST, refuse the whole clear on a write failure) and the shared chokepoint
every clear route now calls through. A later `/clear(sub)` then finds
`R.reducedContributorRepoPaths.includes(identity)` true and routes to the SAME idempotent refuse arm
Round 4 already built, never reaching scenario B.

Tests: `(round5-shapeA-cc)` clear → clear, in-process; `(round5-shapeA-crc)` clear → reboot → clear (a
real child-process reboot between the two). Both through the real `/clear` entry point. RED at `a29f09b1`
(3 checks each, 6 total — R wrongly unblocked on the second clear); GREEN after.

### Item 3 (MINOR) — `liftedRepoPaths` under-reports after a full clear of the reducing union

After a reduce, `/clear(R)` genuinely lifts `sub`'s still-outstanding token too (its token never left the
union's flat token set — see Round 3's own "THE TOKEN QUESTION") and genuinely unblocks `sub` — but
`liftedRepoPaths` named only `[R]`, never `[R, sub]`, because the candidate-identity seeding at every
`resolveGenuinelyLiftedRepoPaths` call site only ever read `contributorRepoPaths` (already stripped by
the reduce), never `reducedContributorRepoPaths`. Fixed by feeding `reducedContributorRepoPaths` into
`candidateIdentities` too, at all three seeding sites (`clearMergeQuarantineByKey`'s own active-entry seed
and its pending-loop seed, and `tryClearMergeQuarantineByOwnIdentity`'s own pending-loop seed — its
active-side seed reaches the same fix TRANSITIVELY, by harvesting the delegated `clearMergeQuarantineByKey`
call's own `result.liftedRepoPaths`).

**(SUPERSEDED BY ROUND 6 — do NOT follow this safety claim.)** This originally read "safe
unconditionally: every candidate is re-resolved... so it can never cause an over-report." CR4 (Round 6,
probe2) measured that FALSE: `ownIdentityEntryFor`/`resolveGenuinelyLiftedRepoPaths` run AFTER this
clear's own mutations, so once the OWNER entry is genuinely, fully deleted (unlike probe2's own kept/
protected construction, where it survives), the post-clear re-resolution finds nothing either way and
cannot tell a genuinely-entangled candidate apart from a ghost that never was. See Round 6's own item 3
for the real fix (`ownIdentityEntryFor` widened + a "blocked-before" snapshot taken before the delete).

Test: `(round5-liftedpair)` — reduces, then fully clears `R`, and asserts the result names BOTH `R` and
`sub`, compared via `directPathIdentity` on both sides (never literal string equality: `reducedContributorRepoPaths`
stores the NORMALIZED identity, not `sub`'s raw, as-typed path — see that field's own doc comment). RED at
`a29f09b1` (reported `[R]` alone); GREEN after.

### Item 4 (test gap) / Item 5 (ACCEPTED, no code change) — clear-by-path/clear-by-id after a reduce

Added `(round5-clearbypath-noreboot)`, `(round5-clearbypath-reboot)`, `(round5-clearbyid-noreboot)`,
`(round5-clearbyid-reboot)` — each reduces `R`'s union first, then clears `R` by path or by id (with and
without an intervening real reboot), and asserts: the clear fully lifts `R`; `assertRepoNotQuarantined(R)`
flips true; `sub`'s own leftover token is ALSO lifted (named explicitly below); and 0 latch files remain
on disk referencing `R`'s own key. All four PASS already, both at `a29f09b1` and at HEAD — this is a pure
test-coverage gap-fill, not a fix: `clearMergeQuarantineByKey`'s full-entry delete path doesn't consult
`contributorRepoPaths`/`reducedContributorRepoPaths` for THIS behavior at all, so nothing here was ever
broken, it simply had no scenario proving it.

**Item 5, recorded as deliberate (no change):** a human clearing `R`'s own quarantine by path or by id
lifts EVERYTHING held under `R`, including `sub`'s own leftover token folded in by an earlier reduce. This
is intended, not a residual bug — a human addressing `R`'s own quarantine directly is asking to clear
everything `R` is currently blocking, and (per this card's own history) already separately asked to clear
`sub` once, which is precisely how `sub`'s token ended up folded in here to begin with.

### Item 6 — NOT fixed here (carded separately)

After `R`'s own token settles (e.g. via `clearMergeQuarantineByToken`), a later `/clear(sub)` is refused
with text saying `sub` is quarantined by "ANOTHER repo's own, separate quarantine" — which reads as false
in that exact state (the blocker is no longer `R`'s own raise, it's `sub`'s OWN reduced-marker routing).
The REMEDY (clear-by-path/clear-by-id on `R`) still works; only the wording is misleading. The Lead is
carding this separately — no change in this round.

### RED/GREEN counts for Round 5's own new scenarios, at `a29f09b1` (same negative-control method)

`(round5-shapeA-cc)`: 3/3 checks RED. `(round5-shapeA-crc)`: 3/3 checks RED. `(round5-liftedpair)`: 1/1
check RED (the other 2 checks in that scenario pass — they don't depend on this round's own fix).
`(round5-clearbypath-noreboot)`, `(round5-clearbypath-reboot)`, `(round5-clearbyid-noreboot)`,
`(round5-clearbyid-reboot)`: 0/0 RED (pure test-gap fill, pass unconditionally — see item 4 above). Total:
7 new RED checks at `a29f09b1`, all in the two shape-A scenarios plus the liftedpair scenario; GREEN after
this round's fix. HEAD — 0 FAILED for the whole file. Solo runtime timed separately in the worker report.

## Do not (Round 5 additions)

- Do not add a second marker field for "shape A" — `markIdentityAsReducedOnForeignKey` reuses the exact
  same `reducedContributorRepoPaths` field `reduceForeignUnionContributor` already writes; the routing
  check in `clearMergeQuarantine` is a single `.includes(identity)` test regardless of which of the two
  functions actually wrote the mark.
- **(SUPERSEDED BY ROUND 6 — do NOT follow this bullet)** This used to say never to filter
  `reducedContributorRepoPaths` candidates by hand, reasoning that `resolveGenuinelyLiftedRepoPaths`'s own
  post-clear re-resolution already covers it. CR4 (Round 6) measured that false: once the OWNER entry is
  genuinely, fully deleted (the normal case for a full lift, not probe2's own kept/protected construction),
  `resolveGenuinelyLiftedRepoPaths` runs AFTER the evidence is gone and finds nothing either way — it
  cannot discriminate a candidate that was genuinely entangled from one that never was. See Round 6's own
  item 3 for the real fix: a hand-rolled "blocked-before" snapshot, taken BEFORE the owner's own deletion.
- Do not read item 6's wording defect as part of this card's own scope — it is carded separately; fixing
  the message text here would silently expand this card past the Lead's own ruling.

## Round 6 — Code Review `0a642436` (the FOURTH review, delta `a29f09b1..c925e5da`): atomicity, the CLASS of clear routes, and the real over-report mechanism

Reviewer `0a642436` ran the real `/clear` route and real child-process reboots end to end against the
full Round 5 marker design and confirmed it holds on every CR2 CRITICAL shape (141/0 checks + the
218-scenario merge-quarantine-runtime-union-provenance.mjs corpus, both green at HEAD). It then measured
two further BLOCKING findings (both reproduced with scratch probes before any fix) and one MINOR.

### Finding 1 (BLOCKING) — the marker was NOT atomic with the clear it protects, and failed OPEN

`tryClearMergeQuarantineByOwnIdentity` deleted `sub`'s own latch FIRST; only then did
`markIdentityAsReducedOnForeignKey` write `R`'s latch. A crash between the two, or a write failure (e.g.
a Windows rename EPERM — the pre-existing write-failure branch only logged and still reported success),
left `sub`'s record gone and `R` unmarked. Reboot + `/clear(sub)` then lifted `[sub, R]` — the SAME
CRITICAL Round 5 was supposed to close, reached by racing its own fix instead of bypassing it.

**The Lead's ruling (the reviewer's own reasoning, accepted as-is):** stamp and PERSIST the marker on the
foreign entry BEFORE the own-identity clear runs. If that write fails, REFUSE the whole clear (keep
`sub`'s record, name the failure in the reason) rather than proceeding unmarked. A marker on `R` while
`sub`'s own record still exists is harmless — the NEXT call's own non-empty `matched` already wins over
the ancestor-collapse clear regardless of whether the marker is there too — so refusing on a write failure
costs nothing but a retry, while the old ordering's own crash/failure window could never be recovered from.

**The fix:**
- `markIdentityAsReducedOnForeignKey` now returns `boolean` (was `void`). On a durable-write failure, it
  ROLLS BACK its own in-memory mutation (re-points back to the original, unmarked entry) before returning
  `false` — or a same-process retry would see `reducedContributorRepoPaths.includes(identity)` already
  `true` (the idempotent-no-op check) and skip the write attempt entirely, stranding the marker
  in-memory-only forever with nothing durable backing it across the exact crash/reboot it exists to survive.
- `clearMergeQuarantine`'s own "shape A" branch now calls the mark step BEFORE
  `tryClearMergeQuarantineByOwnIdentity`, and refuses (`stillQuarantined:true`, a reason naming the
  failure, `liftedRepoPaths:[]`) instead of proceeding when it returns `false`.

Tests: `(round6-markfail)` — a stubbed `fs.openSync` failure at `R`'s own final path (the same injection
pattern `merge-quarantine-raise-protect-failure.mjs` already established) forces the marker write to
fail; asserts the clear is refused, `sub`'s own record is KEPT (never touched), and `R`'s own latch file
is byte-identical to before. `(round6-crashsim)` — constructs the marker's own POST-WRITE, PRE-OWN-CLEAR
end state directly (the same test-only-seam technique the (twin)/(E) scenarios already use), proving a
LATER `/clear(sub)` still clears `sub` correctly and leaves `R` blocked once the marker already exists.
Both through the real `/clear` entry point. `(round6-markfail)`'s own core assertion ("sub's own record is
KEPT") is RED at `c925e5da` (the old ordering let the clear proceed regardless of the write outcome);
`(round6-crashsim)` passes unchanged at both commits — it exercises the ROUTING (Round 4's own
already-correct `reducedContributorRepoPaths.includes(identity)` check), not the ordering bug itself, so
it is a non-regression proof, not a RED witness.

### Finding 2 (BLOCKING, Lead ruling) — the stamp lived ONLY at the `/clear` call site

`clearMergeQuarantineByRecordedPath` (clear-by-path), `clearMergeQuarantineLatchFile` (clear-by-id), and
`clearMergeQuarantineByToken` (clear-by-token) each independently clear `sub`'s own record too, and NONE
of them stamped the foreign entry first — a later `/clear(sub)` lifted `R` through every one of them
(measured directly, each route, before any fix). Lesson 251: a fix ruled on ONE call site regresses the
moment a sibling route reaches the identical shape through its own, separately-written clear logic.

**The Lead's ruling:** move the stamp into ONE shared step every route calls — never duplicate the
mark-or-refuse logic per site again. New function `preClearForeignKeyStamp(repoPath)`: computes
`freshKey`/`identity`/`freshEntry`/`freshIsForeign` fresh (deliberately — redundant with what
`clearMergeQuarantine` already computed, but self-contained, so no two copies of this logic can ever
drift against each other), no-ops when the fresh key isn't foreign or `repoPath` is currently
unresolvable (mirroring `clearMergeQuarantine`'s own resolvability gate — `canonicalRepoLockKey` degrades
to an untrustworthy walked-up ancestor for an unresolvable path).

**(SUPERSEDED BY ROUND 7 — a third no-op condition was missing.)** The sentence above, as Round 6 shipped
it, named only two no-op conditions. Round 7's own finding 1 adds a third: `repoPath`'s own identity must
ALSO have an own active-or-pending record genuinely about to be cleared right now — see "Round 7" below.
Without it, this chokepoint stamped a foreign entry for an identity it was never actually clearing (a
contributor-token settle, a never-raised plain dir). Otherwise calls
`markIdentityAsReducedOnForeignKey`, returning `{ok:false, reason}` on a write failure. Every one of the
four routes now calls this FIRST:
- `clearMergeQuarantine` — already covered by finding 1's own fix above (the SAME call site).
- `clearMergeQuarantineByRecordedPath` — called at the very top, before `tryClearMergeQuarantineByOwnIdentity`.
- `clearMergeQuarantineLatchFile` — called at BOTH its own clear points: the ACTIVE-match branch (before
  `clearMergeQuarantineByKey`) AND the PENDING-only branch (once per matched pending identity, before the
  splice) — a shape the reviewer's own probe never exercised (it always raised `sub` as active), but the
  identical class applies, so both were fixed.
- `clearMergeQuarantineByToken` — its own `_repoPath` parameter, previously UNUSED (kept only for
  signature stability — this clear is process-wide BY TOKEN ALONE), is now genuinely used for this ONE
  purpose. Per the Lead's own ruling for this route specifically: on a write failure, the function KEEPS
  `repoPath`'s own token outstanding and logs, rather than silently releasing it unmarked — it returns
  `void` already, so there is no result shape to report a refusal through.

Tests: `(round6-route-path)`, `(round6-route-id)`, `(round6-route-token)` — each clears `sub` via the
named route, then calls the real `/clear(sub)` again and asserts `R` stays blocked, `assertRepoNotQuarantined(R).ok`
stays `false`, and the second call never names `R` in `liftedRepoPaths`. RED at `c925e5da` (3 checks each,
9 total — `R` wrongly unblocked through every route); GREEN after.

### Finding 3 (MINOR) — `liftedRepoPaths` could OVER-report via the SAME mechanism Round 5 trusted

Round 5's own "safe unconditionally" claim (see the correction above) was falsified directly: `probe2.mjs`
placed a GHOST identity (`xSub`, never genuinely raised) into a foreign `X` entry's
`reducedContributorRepoPaths`, then cleared `X` — `xSub` was wrongly reported as lifted, even though it
was never blocked by anything. Two independent root causes, both fixed:

1. **`ownIdentityEntryFor` never consulted `reducedContributorRepoPaths`.** Widened its own `isContributor`
   check to also test `entry.reducedContributorRepoPaths?.includes(identity)` (already normalized, never
   re-mapped through `directPathIdentity`). This is the ONE function shared by `resolveQuarantineFor`,
   `stillBlockedEntryFor`, and `resolveGenuinelyLiftedRepoPaths` — widening it here also makes
   `assertRepoNotQuarantined`/`clearMergeQuarantineReporting` correctly report a reduced-out identity as
   still blocked once it becomes unresolvable, closing a related (previously silent) gap as a side effect.
2. **The `~5004` protected-occupant exclusion propagated `contributorRepoPaths` but not
   `reducedContributorRepoPaths`.** Widened to add both fields' own members to `excludeRepoPaths` once the
   owner itself is excluded (kept/protected, not genuinely verified).
3. **A THIRD, independent measure — "require blocked-before for reduced candidates."** Fix (1) alone
   only helps when the owner entry SURVIVES the clear (probe2's own construction, via its degraded-ghost
   protection); the NORMAL case for a genuine full lift is that the owner entry is fully, durably DELETED
   — at which point even the widened `ownIdentityEntryFor`, evaluated AFTER the delete (inside
   `resolveGenuinelyLiftedRepoPaths`), finds nothing regardless of whether the candidate was ever
   genuinely entangled. Every `reducedContributorRepoPaths`-sourced candidate add is now gated on
   `ownIdentityEntryFor(c)` evaluated BEFORE any deletion: inline, at the two `clearMergeQuarantineByKey`
   seed sites (both run before their own entry's/pending-twin's removal); via a pre-filter SNAPSHOT
   (`reducedCandidateBlockedBefore`) at `tryClearMergeQuarantineByOwnIdentity`'s own pending seed, taken
   BEFORE that function's own `pendingUnresolvedQuarantines` filter removes the evidence — evaluating
   inline there, same as the other two sites, would already be too late.

**(SUPERSEDED BY ROUND 7, item 3 above — do NOT follow this mechanism.)** "Evaluated BEFORE any deletion,
gated on `ownIdentityEntryFor(c)`" is a TAUTOLOGY, not a fix: the entry still being processed always
self-matches its own `reducedContributorRepoPaths` member via `isContributor`, so this check could never
actually return false — it filtered nothing. It happened to pass probe2's own ghost-candidate repro only
because that repro's own owner SURVIVES the clear (fix (1) alone already covered that shape); it was never
exercised against a candidate whose owner is genuinely, fully deleted with nothing else blocking the
candidate. Round 7's own `(round7-p6)` repro (stamp via shape A, then let the candidate genuinely regain
its own key with nothing else blocking it) reproduces the over-report this "fix" never actually closed.
Replaced by `reducedCandidateStillEntangled` — see "Round 7" below for the real discriminator and why a
bare exclusion of the entry being cleared ALSO regresses `(round5-liftedpair)`'s own genuine entanglement
case.

Verified directly: `probe2.mjs`, re-run after the fix, reports `reducedContributorRepoPaths` and
`contributorRepoPaths` behaving IDENTICALLY (`xSub` correctly excluded, and now also correctly reported
blocked beforehand) — confirmed against this repo's own build, not merely argued. The existing `(L)`
fixture in `merge-quarantine-4b6c8d24-lifted-identities-disclosure.mjs` (CR4's own reference point for
this finding) re-runs green, unaffected.

## Do not (Round 6 additions)

- Do not revert `markIdentityAsReducedOnForeignKey`'s own rollback-on-failure — without it, a failed write
  still leaves the in-memory marker looking "already set," and a same-process retry would skip the write
  attempt entirely (the idempotent-no-op check), permanently stranding an unpersisted marker.
- Do not call `markIdentityAsReducedOnForeignKey` directly from a NEW clear route — call
  `preClearForeignKeyStamp(repoPath)` instead, and call it FIRST, before touching that route's own record.
  A new route re-deriving this logic by hand is exactly how finding 2 happened the first time.
- Do not gate `preClearForeignKeyStamp` on `repoPath` being resolvable using any check OTHER than
  `isRepoPathCurrentlyResolvable` — `canonicalRepoLockKey` for an unresolvable path degrades to a walked-up
  ancestor fallback that is not a trustworthy "this used to be my own key" signal.
- Do not evaluate a `reducedContributorRepoPaths` candidate's "blocked-before" state AFTER the owner
  entry's own deletion/splice — by then the evidence is gone regardless of what `ownIdentityEntryFor` now
  checks. Snapshot it BEFORE, or gate inline at a site that genuinely runs before the removal (verify the
  exact ordering for each site; it is not the same in every function — see finding 3's own fix).

## Round 7 — delta Code Review on `f056d721` (the FIFTH review, reviewer `a2afe071`): the stamp had no own-record check, a refusal's reason was dropped, the blocked-before gate was still a tautology, and the Round 6 regression test was itself a tautology

CR5 confirmed CR4's findings 1+2 (atomicity, class-wide routing) fixed on all three routes, and the
in-memory rollback byte-identical — 10 REDs at `c925e5da` confirmed. It then found four more issues: one
MAJOR, two MINOR, and one test-quality gap.

### Finding 1 (MAJOR) — `preClearForeignKeyStamp` stamped unconditionally on `freshIsForeign`, with no check that `repoPath` has an own record actually being cleared

`preClearForeignKeyStamp` is called from four routes. On `/clear` (`clearMergeQuarantine`), the caller
ALREADY gates the call behind `matched.length > 0 || hasOwnPendingMatch` before ever reaching it — so that
one call site was never exposed. The other three routes call it UNCONDITIONALLY whenever the fresh key is
foreign, with no equivalent gate of their own:

- **Scenario D (the token route):** a registry-bound subdirectory `S` (no `.git`, ever) raised while `R`
  is already quarantined gets folded into `R`'s union purely as a `contributorRepoPaths` member — `S`
  never has an own active or pending record anywhere. Settling `S`'s token via
  `clearMergeQuarantineByToken(S, token)` is a PURE contributor-token release, never "`S`'s own record
  being cleared" — but the old code stamped `R.reducedContributorRepoPaths += [S]` anyway, durably
  recording membership-reduction for an identity that was never independently entangled to begin with.
- **Scenario D2 (clear-by-path):** `clearMergeQuarantineByRecordedPath`'s own top-of-function call runs
  BEFORE any match is even looked for — a plain, never-raised subdirectory with NO record of its own at
  all (`wasQuarantined:false`) still durably marked its foreign ancestor.

**The fix:** move the gate INTO `preClearForeignKeyStamp` itself (so no caller can forget it, mirroring
lesson 251's own "rule on the CLASS" principle that created this chokepoint in the first place): after
confirming `freshIsForeign`, additionally compute `activeMatchesAndLiftedKeysFor(identity)` and a
pending-tier identity scan, and no-op (`{ok:true}`) when BOTH are empty — the exact same
`matched.length === 0 && !hasOwnPendingMatch` shape `clearMergeQuarantine`'s own caller already used,
now enforced at the chokepoint instead of trusted per-caller.

Tests: `(round7-d)` raises `S` as a pure pending contributor, triggers the absorption explicitly, settles
its token via `clearMergeQuarantineByToken`, and asserts `R`'s own `reducedContributorRepoPaths` never
gains `S`'s identity. `(round7-d2)` clears a never-raised plain subdirectory by path and asserts the same.
Both through the real routes. RED at `f056d721`, GREEN after.

### Finding 2 (MINOR) — `clearMergeQuarantineReporting` dropped a refused clear's own reason

Its own `if (after)` branch always recomputed the reason via `stillQuarantinedReason(after, repoPath)`,
discarding `clearMergeQuarantine`'s own `clearResult.reason` even when the clear had REFUSED outright (a
`preClearForeignKeyStamp` write failure) — the human-readable result then read "quarantined by ANOTHER
repo's own, separate quarantine," which is false in that exact state (the real cause is a marker-write
failure, and `repoPath`'s own record was never touched). Fixed: when `clearResult?.stillQuarantined` is
true and it carries its own `reason`, forward that verbatim as the base reason (still composed with any
relocated-co-occupant clause on top, unchanged).

**(SUPERSEDED BY ROUND 8 — "produces an identical reason either way" is FALSE.)** The pre-existing
still-blocked disclosure case can ALSO set `stillQuarantined:true` with a `reason` that ALREADY has its
own relocated-co-occupant clause composed in (`tryClearMergeQuarantineByOwnIdentity`'s own `if (after)`
branch) — reusing it here and then composing the clause AGAIN on top DUPLICATED it (q4.mjs, a real,
measured user-visible regression via REST `/clear`). See "Round 8" below for the real fix
(`refusedBeforeClear`, never a bare `stillQuarantined` check).

Test: `(round7-reportreason)` — the same `fs.openSync` injection pattern `(round6-markfail)` established,
through `clearMergeQuarantineReporting` this time (not the inner function) — asserts the result's `reason`
names the real write failure and never falls back to the misleading wording. RED at `f056d721`, GREEN
after.

### Finding 3 (MINOR) — the `reducedContributorRepoPaths` "blocked-before" gate was STILL a tautology, and a BARE exclusion is the wrong fix

Round 6's own fix (3) for its Finding 3 — "evaluate `ownIdentityEntryFor(c)` BEFORE any deletion" — never
actually filtered anything: the entry still being processed always self-matches its own
`reducedContributorRepoPaths` member via `isContributor`, so the check could never return false. It
happened to pass probe2's own repro only because that repro's own owner SURVIVES the clear (a shape
Round 6's fix (1) alone already covered) — it was never exercised against a candidate whose owner is
genuinely, fully deleted with nothing else blocking the candidate.

**Repro `(round7-p6)`:** stamp `R` via shape A (an independent `sub` raise, now collapsed and cleared, with
`R` durably marked `reducedContributorRepoPaths=[sub]`), then let `sub` genuinely regain its OWN key (its
`.git` restored, never re-raised) — `assertRepoNotQuarantined(sub).ok` is confirmed `true` BEFORE the
second clear. Fully clearing `R` still named `sub` in `liftedRepoPaths`, over-reporting an identity that
was never blocked by this clear at all.

**The wrong fix, tried first and rejected:** a bare exclusion of the entry being cleared from
`ownIdentityEntryFor`'s own scan (`ownIdentityEntryFor(c, excludeEntry)`) DOES close `(round7-p6)` — but it
also regresses `(round5-liftedpair)`, a genuine, deliberately-tested union-contributor case where `sub`'s
own token is STILL physically folded inside `R`'s union and IS correctly freed when `R` is fully cleared
(card `4b6c8d24`'s own CR3 item 3 fix). Both shapes land `c` in the exact same `reducedContributorRepoPaths`
array and, excluding the entry being cleared, both report "blocked by nothing else" — the two are
indistinguishable by identity/contributor-membership alone, however the check is phrased.

**The fix shipped this round:** a NEW function, `reducedCandidateStillEntangled(c, entry)` — the
discriminator is PHYSICAL, not identity-based: does `c`'s own CURRENT canonical key still resolve onto
`entry` right now? A union-contributor whose own `.git` was never restored still collapses onto `entry`'s
key (still entangled — count it). A shape-A member whose own `.git` came back owns its own key again
(already free — do NOT count it). An unresolvable `c` can't be verified this way at all — conservatively
counted (`true`, matching the pre-fix behavior for that case). Replaces `ownIdentityEntryFor(c)` at all
three seed sites: the two inline seeds in `clearMergeQuarantineByKey` (active-side and
pending-twin-removal-side) and the pre-filter snapshot in `tryClearMergeQuarantineByOwnIdentity`'s own
pending seed.

**(SUPERSEDED BY ROUND 8 — `reducedCandidateStillEntangled` is DELETED, not merely refined.)** It checked
`activeQuarantines.get(canonicalRepoLockKey(c)) === entry` — the ACTIVE map only — so it silently returned
`false` whenever `entry` itself was a PENDING entry (q3.mjs: a candidate genuinely blocked through
`stillBlockedEntryFor`'s own tier-3/4 pending resolution was wrongly excluded). See "Round 8" below for
`reducedCandidateBlockedByEntry`, the replacement.

Test: `(round7-p6)` (above), comparing `liftedRepoPaths` via `directPathIdentity` — never literal string
equality, same established rule `(round5-liftedpair)` already follows (a first draft of this test used a
raw `.includes(sub)` comparison and silently passed on BOTH sides of the fix; caught by deliberately
re-verifying RED at `f056d721` with the corrected comparison before trusting it). RED (corrected) at
`f056d721`, GREEN after. `(round5-liftedpair)` and the four `(round5-clearbypath-*)`/`(round5-clearbyid-*)`
scenarios — the genuine union-contributor cases this fix must not regress — re-verified green.

### Finding 4 (test-quality gap) — `(round6-crashsim)` was itself a confirmed tautology; replaced with a real cross-reboot probe

`(round6-crashsim)` constructed the post-mark state via the test-only seam but left `sub`'s own record
GENUINELY INTACT (never cleared) and called `/clear(sub)` only ONCE, in the SAME process. `matched.length
> 0` (sub's own still-present record) was already sufficient to avoid scenario B with or without the
marker — the scenario passed identically at `50b9392c` (before the marker mechanism even existed) and at
`d94dcb8d`, and would still pass today if `reducedContributorRepoPaths` were deleted entirely.

Replaced with the reviewer's own probe A: leave the marker durable, leave `sub`'s own latch file ALSO
genuinely on disk (the real crash window — the own-identity clear that should have followed the marker
write never ran), REBOOT INTO A FRESH CHILD PROCESS (forcing a genuine re-ingest from disk, never reused
in-memory state), then `/clear(sub)` TWICE in that same child. Verified empirically (a scratch probe, not
assumed) before writing the scenario: at boot, PASS 1 migrates `sub`'s own stale-keyed latch directly into
`R`'s union (tokens unioned; `sub`'s own independent record is gone), so BOTH post-reboot clears depend
entirely on the durable marker surviving the boot parse, never on in-memory convenience — `R` stays
active, `liftedRepoPaths` names it 0 times across both clears. A companion control scenario
(`round7-probeA-control`) runs the IDENTICAL construction with the marker NEVER written at all, and
confirms it DOES wrongly lift `R` — proving the probe discriminates rather than passing vacuously.

### Tests (Round 7 summary)

`(round7-d)`, `(round7-d2)`, `(round7-reportreason)`, `(round7-p6)`, `(round7-probeA)`,
`(round7-probeA-control)` — six new scenarios in
`merge-quarantine-3b1944b6-stale-key-active-record-overclear.mjs`, replacing `(round6-crashsim)`. RED/GREEN
at `f056d721`, verified via a scratch `git worktree` (not the live repo), with the corrected test file
copied in and built against that commit's own source: 5 FAILED (`(round7-d)` 1 check, `(round7-d2)` 1
check, `(round7-reportreason)` 2 checks, `(round7-p6)` 1 check) / HEAD — 0 FAILED. `(round7-probeA)`/
`(round7-probeA-control)` are a test-quality replacement, not tied to this round's own code fix — both
pass at HEAD; the control alone (not a RED/GREEN comparison against an older commit) is what proves the
probe is non-vacuous. Full file: 0 FAILED at HEAD. Also run directly, unaffected by this round:
`merge-quarantine-runtime-union-provenance.mjs`, `merge-quarantine-4b6c8d24-lifted-identities-disclosure.mjs`,
`merge-quarantine-clear-by-path.mjs` — all green.

## Do not (Round 7 additions)

- Do not call `preClearForeignKeyStamp` from a new route and assume its own `freshIsForeign` check is a
  sufficient gate — it is not, on its own; the function now ALSO requires an own active-or-pending record
  for `repoPath`'s identity before it stamps anything.
  **(SUPERSEDED BY ROUND 8 — "an own record SOMEWHERE" is not the same claim as "THIS clear is clearing
  that record," and is NOT sufficient for the token route.)** A holder of the specific token being
  released can have a DIFFERENT identity than `repoPath`'s own record even while `repoPath` separately has
  an unrelated own record elsewhere (q2.mjs's "contrib" case) — see "Round 8" below for
  `ownRecordBeingCleared` and why `clearMergeQuarantineByToken` cannot rely on the chokepoint's own default
  computation.
- Do not re-add a bare `ownIdentityEntryFor(c)` (or any exclusion-only variant of it) as the
  `reducedContributorRepoPaths` "blocked-before" gate — see Finding 3 above for why neither shape can
  distinguish a genuine union-contributor from an already-freed shape-A member.
  **(SUPERSEDED BY ROUND 8 — `reducedCandidateStillEntangled` itself is DELETED, not a model to follow.)**
  It checked the active map only, missing tier-3/4 PENDING resolution (q3.mjs). Use
  `reducedCandidateBlockedByEntry` instead (the shared pure mirror `stillBlockedEntryFor`, snapshotted
  before the clear) — see "Round 8" below.
- Do not compare a `liftedRepoPaths` entry against a raw, as-typed path with `.includes()` — compare via
  `directPathIdentity` on both sides, same as `(round5-liftedpair)`'s own established rule. A first draft
  of `(round7-p6)` got this wrong and silently passed on both sides of the fix; only a deliberate RED
  re-check against `f056d721` caught it.
- Do not trust a regression test's own "it fails on the old commit" claim without checking it reproduces
  with the SAME shape the fix addresses, not a coincidentally-similar one — `(round6-crashsim)` passed at
  both `50b9392c` and `d94dcb8d` for a reason unrelated to the marker it was meant to protect. Prefer a
  construction with its own non-vacuous control (`(round7-probeA-control)`) over trusting a single
  RED/GREEN pair in isolation.

## Round 8 — delta Code Review on `5defdc99` (the SIXTH review, reviewer `ff0f9dca`): "has an own record" is not "clearing THIS record," a duplicated reason clause, and the blocked-before fix had its own pending-tier gap

CR6 confirmed D/D2 fixed (no marker, scenario B preserved), `(round7-p6)` fixed, and A/B/C/E unaffected;
the Round 7 gate and entanglement mutations both confirmed RED at their own commit; purity unaffected.
Three remaining findings, worked against probes `q2.mjs`/`q2b.mjs`/`q3.mjs`/`q4.mjs`.

### Finding 1 (MAJOR) — the stamp gate checked "has an own record," not "THIS clear is clearing that record"

Round 7's own fix gated `preClearForeignKeyStamp` on `matched.length > 0 || hasOwnPendingMatch` for
`repoPath`'s identity — "does this identity have an own record ANYWHERE." The token route
(`clearMergeQuarantineByToken`) calls the chokepoint BEFORE even knowing which holder `token` will
actually match, so that gate answers the wrong question for it: `sub` can genuinely have its own
independent record (satisfying the gate) while the SPECIFIC token being released belongs to a totally
different holder — a contributor token folded into a foreign union, or no holder at all.

- **`q2.mjs`:** `sub` raises twice — once with no `.git` (folds directly into `R`'s union as a
  contributor, token `tC`), then again after gaining its own `.git` (an independent record, own key,
  token `tO`). `sub`'s `.git` is removed again, collapsing its fresh key onto `R`. Settling `tC`
  (`clearMergeQuarantineByToken(sub, tC)`) durably stamped `R` — even though `tC`'s own holder is `R`'s
  union, never `sub`'s own record.
- **`q2b.mjs`:** `clearMergeQuarantineByToken(sub, "no-such-token")` — releases nothing anywhere, and
  still stamped `R`.

**The Lead's ruling:** the chokepoint decides from what the route WILL actually clear, not from a generic
identity scan. `preClearForeignKeyStamp` gained an optional `ownRecordBeingCleared?: boolean` parameter
that, when passed, REPLACES its own internal matched/pending recompute. Only `clearMergeQuarantineByToken`
passes it, computed precisely: a holder of `token` (active or pending) whose own `directPathIdentity`
equals `repoPath`'s. The other three routes are unaffected — for them, "has an own record" and "is
clearing that record" are the same question (they only ever reach the chokepoint once they already know
they're about to clear a match for that exact identity), so their own internal recompute stays correct and
unchanged.

Tests: `(round8-q2)` — a parameterized loop over `["own", "contrib"]` reproducing `q2.mjs`'s exact
construction, settling `tO` (must stamp — genuinely `sub`'s own record) and `tC` (must NOT stamp —
`sub`'s own record is untouched by it) through the real route. `(round8-q2b)` — the bogus-token shape.
Both RED at `5defdc99`, GREEN after.

### Finding 2 (MINOR, a measured user-visible regression via REST `/clear`) — the forwarded reason duplicated the relocated-co-occupant clause

Round 7's own fix forwarded `clearResult.reason` verbatim whenever `clearResult?.stillQuarantined` was
true. That gate is too broad: `tryClearMergeQuarantineByOwnIdentity`'s own GENUINE still-blocked branch
ALSO sets `stillQuarantined:true`, with a `reason` that has ALREADY composed its own relocated-co-occupant
clause (`composeReasonWithRelocated(stillQuarantinedReason(after, repoPath), combinedRelocated)`, inside
that function). `clearMergeQuarantineReporting`'s own outer code then composed
`splitCoOccupants(stillBlocked, ...).relocated` onto `baseReason` a SECOND time — appending the exact same
"this clear also found N other, unrelated identit(y/ies)..." clause twice in one reason string.

`q4.mjs`: `sub` raises normally; a FOREIGN occupant's content (`X`, a never-raised identity) is planted at
`sub`'s own physical latch file; `sub`'s `.git` is removed. Clearing `sub` discovers `X` at that file and
durably relocates it — a genuine, correct relocation — but the human-facing reason named it twice.
Measured directly: 2 occurrences at `5defdc99`, 1 at HEAD.

**The fix:** the three genuine preClear-refusal return sites (`clearMergeQuarantine`,
`clearMergeQuarantineByRecordedPath`, and both of `clearMergeQuarantineLatchFile`'s own preClear calls —
four call sites, one shared refusal shape) now set a distinct `refusedBeforeClear: true` flag alongside
`stillQuarantined: true`. `clearMergeQuarantineReporting`'s own `if (after)` branch checks
`refusedBeforeClear` FIRST — forwarding that reason verbatim, with NO further composition (its own
`stillBlockedCoOccupants` is always `[]` for a refusal, so there is nothing to compose anyway) — and falls
through to the ORIGINAL, always-fresh `composeReasonWithRelocated(stillQuarantinedReason(after, repoPath), ...)`
computation for every other `stillQuarantined` case, never reusing `clearResult.reason` for those. This
closes the duplication unconditionally: the outer wrapper no longer ever composes on top of an
already-composed inner reason, for any shape.

Test: `(round8-q4)` — asserts the `"this clear also found"` substring appears EXACTLY once in the result's
`reason`, and that the relocated identity is still genuinely named in `stillBlockedCoOccupants`. RED (2
occurrences) at `5defdc99`, GREEN (1 occurrence) at HEAD.

### Finding 3 (MINOR) — the Round 7 "blocked-before" fix checked the active map only, missing pending-tier resolution

`reducedCandidateStillEntangled`'s own check, `activeQuarantines.get(canonicalRepoLockKey(c)) === entry`,
can only ever be true when `entry` itself is CURRENTLY an active-map entry. `q3.mjs` constructs a shape
where the entry being cleared (`G`) is itself PENDING (unresolvable — its own directory was deleted
entirely) and durably carries a (synthetically forced, for test purposes) `reducedContributorRepoPaths`
member (`sub`) that IS genuinely still blocked by `G` through `stillBlockedEntryFor`'s own tier-3/4
pending-resolution path — never reachable via a bare active-map lookup at all. The old check always
returned `false` for this shape, silently dropping `sub` from `liftedRepoPaths` when `G` is cleared.
Marked "disclosure only" by the Lead: `q3.mjs`'s own construction is synthetic (nothing in production ever
genuinely entangles an identity with a now-fully-deleted, never-queried pending entry this way), so the
old gap was never a correctness/safety issue — only an under-reported disclosure.

**The fix:** delete `reducedCandidateStillEntangled`; replace it with `reducedCandidateBlockedByEntry(c,
entry)`, which snapshots `c`'s REAL current blocker via the shared pure mirror `stillBlockedEntryFor` —
covering every tier `stillBlockedEntryFor` itself resolves (active, pending, ancestor-alias,
cross-tier-sibling) — called BEFORE `entry`'s own deletion/splice, and compares the blocker's own identity
to `entry`'s. This is NOT a key-based check at all anymore; it reuses the SAME pure helper every other
disclosure site in this module already trusts, so it inherits that helper's own tier coverage for free
rather than re-deriving a parallel, narrower one.

Measured directly (via the adapted `q3.mjs` probe, both commits): at `5defdc99`, `lifted=["gone"]` only
(`sub` under-reported); at HEAD, `lifted=["gone","sub"]` (correct). `(round5-liftedpair)` and
`(round7-p6)` — the two cases the Round 7 fix was built to keep correct — re-verified green with the new
function (same underlying facts, `stillBlockedEntryFor` agrees with the old key-based check on both:
`(round5-liftedpair)`'s `sub` still resolves to `R`'s own union; `(round7-p6)`'s `sub`, with its `.git`
restored, resolves to nothing).

### Tests (item 4) — a clear-by-id PENDING-route scenario, and probeA's raw `.includes(R)` fixed

`(round6-route-id)` only ever exercised clear-by-id's ACTIVE-match branch. `(round8-route-id-pending)`
raises `sub` while absent (pending-only), captures its pending id via `quarantineLatchFileIdsFor`, makes it
resolvable with no own `.git` (collapsing onto `R`, but staying pending — never queried/absorbed), clears
it by id (hitting `clearMergeQuarantineLatchFile`'s own PENDING branch), then asserts a later `/clear(sub)`
still never lifts `R`. This is a pure coverage gap-fill (the pending branch already called
`preClearForeignKeyStamp` correctly since Round 6) — green at both `5defdc99` and HEAD.

`(round7-probeA)`/`(round7-probeA-control)`'s own `liftedRepoPaths.includes(R)` checks were raw, as-typed
comparisons — the exact shape this record's own Round 7 "Do not" section already warns against. Fixed to
compare via `directPathIdentity` on both sides, matching every other scenario's established convention.

### Tests (Round 8 summary)

`(round8-q2)` (×2, "own"/"contrib"), `(round8-q2b)`, `(round8-q4)`, `(round8-route-id-pending)` — five new
scenarios, plus the two `directPathIdentity` fixes to `(round7-probeA)`/`(round7-probeA-control)`, in
`merge-quarantine-3b1944b6-stale-key-active-record-overclear.mjs`. RED/GREEN verified via a scratch `git
worktree` at `5defdc99` (not the live repo), corrected test file copied in and built against that commit's
own source: 3 FAILED (`(round8-q2-contrib)`, `(round8-q2b)`, `(round8-q4)`) / HEAD — 0 FAILED.
`(round8-q2-own)` and `(round8-route-id-pending)` pass at both commits (not regressions — coverage only).
Full file: 0 FAILED at HEAD. Also run directly, unaffected by this round:
`merge-quarantine-runtime-union-provenance.mjs`, `merge-quarantine-4b6c8d24-lifted-identities-disclosure.mjs`,
`merge-quarantine-clear-by-path.mjs` — all green.

## Do not (Round 8 additions)

- Do not assume `preClearForeignKeyStamp`'s own default "has an own record" recompute is correct for a
  NEW route — it is correct ONLY for a route that already knows, by construction, that it is about to
  clear a match for `repoPath`'s own identity (every route except the token one). A route matching by some
  OTHER key (a token, a latch id ambiguous across identities) must compute its own precise
  `ownRecordBeingCleared` and pass it explicitly — see Finding 1 above.
- Do not key `clearMergeQuarantineReporting`'s "forward verbatim, don't recompose" branch on
  `stillQuarantined` — see Finding 2 above for the exact duplication this causes. `refusedBeforeClear` is
  the only correct discriminator; it is set at exactly the four preClear-refusal return sites, nowhere
  else.
- Do not compute a `reducedContributorRepoPaths` candidate's "blocked-before" state from
  `activeQuarantines` directly, in any form — it cannot see a PENDING entry being cleared. Always go
  through `stillBlockedEntryFor` (or `activeMergeQuarantineForPeek`), snapshotted before the clear.
- Do not forget the `directPathIdentity` comparison rule applies to EVERY `liftedRepoPaths`/`includes()`
  check added to this file, including ones that look like they're reusing an existing, already-correct
  scenario's shape — `(round7-probeA)` copied `(round6-markfail)`'s own raw-path style without re-deriving
  whether it needed the normalized comparison.

## Round 8 follow-up — Code Review `6c72373d` (the SEVENTH review, delta on `da6570f7`): HEALTHY, two small items folded in

CR7 confirmed all 3 CR6 findings fixed and caught by tests, no regression on the p5/p6 probe set, and the
REST response shape unchanged. Two small items, plus one accepted, record-only question.

### Item 1 (test gap) — nothing in this file covered the Finding-3 fix itself

Restoring Round 7's own `reducedCandidateStillEntangled` body (the active-map-only check) in place of
`reducedCandidateBlockedByEntry` still passed the WHOLE REST of this file — `(round5-liftedpair)` and
`(round7-p6)` both only ever exercise an `entry` that is ACTIVE, never pending, so neither one depends on
`stillBlockedEntryFor`'s own pending-tier resolution at all.

Added `(round8-q3)`, porting CR6's own `q3.mjs` shape into the card's real reboot harness: `G = R/gone`
raises normally, then gets a (synthetic, test-only) `reducedContributorRepoPaths = [sub]` marker stamped
onto its own durable latch, then its entire directory is deleted (fully unresolvable). After a real
reboot, `G`'s own latch survives as a PENDING entry (never active). Clearing `G` must report BOTH `gone`
and `sub` in `liftedRepoPaths`.

**A real construction trap, found and fixed before trusting this test:** a first draft ALSO raised `R`
(matching this file's own established convention for nearly every other scenario) — and the test then
FAILED at HEAD, not just at the old commit. `R`'s own active entry, once raised, is exactly what `sub`'s
fresh ancestor-walk (no `.git` of its own) resolves to FIRST via the ordinary active-map tier — a
genuinely correct match, but for the WRONG reason, masking the pending-tier path this scenario exists to
exercise. `q3.mjs` itself deliberately never raises `R` for precisely this reason. Verified directly
against the reviewer's own unmodified probe (never raising `R`) before reinstating the fix in the card's
own file.

RED at `5defdc99` (confirmed via the same scratch-`git worktree` method as every other round) alongside
the pre-existing `(round8-q2-contrib)`/`(round8-q2b)`/`(round8-q4)` REDs; GREEN at HEAD.

### Item 2 (hardening) — `ownRecordBeingCleared` is now a REQUIRED parameter

Round 8's own fix for Finding 1 made `preClearForeignKeyStamp`'s `ownRecordBeingCleared` OPTIONAL, falling
back to an internal `matched.length > 0 || hasOwnPendingMatch` recompute when omitted — correct for every
EXISTING caller, but a silent trap for a FUTURE one: a new route that forgets to pass it would silently
inherit the coarse, per-identity-only answer Finding 1 itself proved insufficient (the shared-unit
divergence risk lesson 251 already names).

**The fix:** `ownRecordBeingCleared` is now REQUIRED (no default, no internal fallback) — every call site
must state what it already knows. The generic recompute is kept as a named helper,
`identityHasOwnRecordAnywhere(identity)`, for the two callers that genuinely need it:

- `clearMergeQuarantine` — passes its own already-computed `matched.length > 0 || hasOwnPendingMatch`
  (the exact fact that routed it into this branch in the first place).
- `clearMergeQuarantineByRecordedPath` — calls `identityHasOwnRecordAnywhere` itself, since this route's
  own call happens BEFORE any match is looked for.
- `clearMergeQuarantineLatchFile`'s ACTIVE branch — also calls `identityHasOwnRecordAnywhere`, even
  though `activeMatch` was found BY this exact identity (so the answer is always `true` by construction)
  — using the named helper instead of a hardcoded literal keeps this call site correct even if the
  matching logic above it ever changes, at the cost of one redundant (but cheap) recompute.
- `clearMergeQuarantineLatchFile`'s PENDING branch — passes `true` directly; `p.entry` was found BY this
  exact identity's own pending match, same reasoning as the active branch, no recompute needed.
- `clearMergeQuarantineByToken` — unchanged; still passes its own precise per-token-holder
  `tokenHolderIsOwnRecord` check (Round 8's own Finding 1 fix).

No new test needed — this is a type-level hardening (a missing argument is now a compile error, not a
silently-wrong runtime default), verified by `pnpm --filter @loom/daemon build` succeeding with every call
site passing an explicit value.

### Item 3 (accepted, record only) — a two-token own-record settling the first token still stamps, deliberately

CR7's own question: when `sub`'s own independent record holds TWO tokens (e.g. two raises of the same
identity before either settles) and the FIRST is settled via `clearMergeQuarantineByToken`, the stamp
still fires (`ownRecordBeingCleared` is `true`, since a holder of that token IS `sub`'s own record) even
though `sub`'s own record is NOT fully removed yet — it still holds its second, outstanding token.

**Accepted as deliberate, no code change.** This is the SAME "marker present while the record it names is
also still present" state Round 6's own `(round6-crashsim)`-shape analysis already showed is harmless: the
marker's only effect is to route a LATER `/clear(sub)` to the idempotent `reduceForeignUnionContributor`
refuse-arm instead of falling through to scenario B — and that routing decision is correct regardless of
whether `sub`'s own record still exists (if it does, the NEXT call's own non-empty `matched` already wins
over the marker check first; the marker only matters once the record is GONE). Invariant 1 (no clear of a
stale-key subdirectory may ever lift its host's genuine, unrelated quarantine) holds throughout.

### Tests (CR7 follow-up summary)

`(round8-q3)` — one new scenario in `merge-quarantine-3b1944b6-stale-key-active-record-overclear.mjs`. RED
at `5defdc99`, GREEN at HEAD. Full file + guards re-run after this round's own commit (no further routes
touched; the 78-file corpus run from the prior round is not re-run for this delta, per the Lead's own
instruction — CR7 is a small-delta review, not a new round of findings).

## Do not (CR7 follow-up additions)

- Do not give `preClearForeignKeyStamp`'s own `ownRecordBeingCleared` parameter a default value or an
  internal fallback ever again — a future route that omits it must fail to compile, not silently inherit
  `identityHasOwnRecordAnywhere`'s coarse answer. If a new route genuinely needs that generic computation,
  it must call `identityHasOwnRecordAnywhere` itself, explicitly, at its own call site.
- Do not add a scenario to this file that raises `R` without first checking whether the scenario's own
  candidate identity (`sub`, `G`, etc.) has no `.git` of its own — raising `R` makes it a real, active
  ancestor match that can mask whatever PENDING-tier behavior the scenario is trying to isolate. See
  `(round8-q3)`'s own construction note for the real trap this caused.
