# 1fc3a561 — the remaining five `armedKeys`-only consumers from `6be6c9ff`'s audit, widened via `liveArmedKeysOf`/`liveArmedKeys`

Found by the Code Review of `c52b290e` (reviewer `b8fad0cf`, at tip `896271d6`). `6be6c9ff`'s own audit
named the ROOT CAUSE as still open — `protectOccupantContentBeforeDelete`'s both-indices re-point branch
re-points every `activeQuarantines` slot pointing at a multi-key twin onto `written.entry` WITHOUT ever
stamping `written.entry.armedKeys` (the `c9114934`/`cd5a3cf9` union gate restricts its source to
`toPersist`/`oldAtFilename` alone) — `written.entry` can carry NO `armedKeys` of its own even though
`activeQuarantines` genuinely maps MULTIPLE keys to it. `c52b290e` fixed four such consumers; this card
closes the five that were left: `clearMergeQuarantineByKey`'s pendingPlan `ownedArmedKeys` (site 1) and
the "remove" loop it feeds (site 3); the reduce-branch write loop (site 2); `clearMergeQuarantineByRecordedPath`'s
`pendingOwnedArmedKeys` (site 4); `quarantineLatchFileIdsFor` (site 5).

## The Lead's ruling

Direction (a) — widen each consumer via `liveArmedKeysOf`/`liveArmedKeys` — is APPROVED, mirroring
`c52b290e`'s own already-landed pattern. Direction (b) — have `protectOccupantContentBeforeDelete`'s
re-point stamp LIVE-DERIVED `armedKeys` onto `written.entry` at the one call site — is REJECTED for this
card: it would cover only ONE producer out of the 20+ `replaceEntryEverywhere` call sites in this file,
several of which have already recurred with the same stale-`armedKeys` shape (`37452ddd`/`d4b25feb`/
`4b06875f`, per `6be6c9ff`'s own record). Widening the CONSUMERS stays robust against any future site
producing the same under-stamped shape; fixing one producer does not.

## Site 1+3 — `clearMergeQuarantineByKey`'s pendingPlan `ownedArmedKeys` → the "remove" loop — FIXED, REPRODUCED

A pending twin `p` — SAME identity as the clear's own `entry`, a DIFFERENT object (never reference-equal),
tied to the clear ONLY via `subsetOfClearedTokens` (never `tiedViaKeyOrOrphanRef`, never by reference) —
can be a `protectOccupantContentBeforeDelete` re-point with `armedKeys:[]` while still LIVE-armed by
reference at its own OTHER key(s). The old `ownedArmedKeys = (p.entry.armedKeys ?? []).filter(...)` read
only the (empty) `armedKeys` list, so `p`'s other live keys were never lifted (map slot untouched,
physical latch untouched) the moment `p` was spliced out of `pendingUnresolvedQuarantines` by the "remove"
branch (site 3, which merely consumes site 1's own output) — the repo stayed fail-closed quarantined via
those other keys while `clearMergeQuarantineByKey` returned a clean, unqualified success.

**Fix:** `ownedArmedKeys = liveArmedKeysOf(p.entry).filter((k) => entryStillOwnsKey(k, p.entry))` — same
shape as `6be6c9ff`'s own `keysToLift` and `c52b290e`'s own `ownedKeysIncluding`/Site-1 fixes. Safe by the
same equivalence argument `c52b290e`'s own "Site 3" used: `liveArmedKeysOf`'s only addition beyond
`armedKeys` is a live `activeQuarantines` scan for exact reference equality, so every added key is one
`p.entry` genuinely, currently occupies — `entryStillOwnsKey` admits it exactly as a fully-accurate
`armedKeys` would have; union-only, never fail-open.

**RED/GREEN:** a REAL `clearMergeQuarantineByKey(kMain, T)` call, `pEntry` dual-tracked by reference at
`kTwinA`/`kTwinB` with real on-disk latches and present in `pendingUnresolvedQuarantines`. Pre-fix: 4/5
checks failed (both physical latches survived, T stayed blocked, the in-memory entry still carried the
token). The 5th check — "the return value is a CLEAN success" — PASSES pre-fix too: the old code also
returns `void` for this exact scenario, since `deleteMergeQuarantineLatchByKey` is never even called for
`kTwinA`/`kTwinB` (nothing to report kept/relocated), so this check cannot by itself catch the regression.
It is kept anyway, honestly labeled, because it documents the actual (dangerous) shape of the bug — a
silent clean success alongside a real stranding — rather than because it discriminates pre/post-fix.
Post-fix: all 5 pass. Proven via the project's own `negative-control` tool — see Verification below for the
exact invocation and why `--ref HEAD` is no longer the right ref to cite.

## Site 2 — the reduce-branch write loop — FIXED, REPRODUCED, re-derived (not a straight copy of sites 1/3)

Same root shape, but a DIFFERENT trigger: `tiedViaKeyOrOrphanRef` (shares `entry.orphanLatchFiles` with
`p.sourceFile`) plus a token OUTSIDE `entry.tokens` (forces "reduce", never "remove" — `subsetOfClearedTokens`
is false here by construction). The old `for (const k of p.entry.armedKeys ?? [])` iterated an EMPTY list
when the twin was a re-pointed `armedKeys:[]` shape — the durable rewrite never reached ANY of the twin's
keys (not just a "second" key; with `armedKeys:[]` the old loop body ran zero times), leaving every
physical latch holding the cleared token for a later restart to resurrect.

**Fix, with ordering care:** `replaceEntryEverywhere(activeQuarantines, p.entry, updated)` re-points every
map slot that pointed at the OLD `p.entry` onto `updated`, BEFORE this loop runs — so the live-occupancy
scan must capture `liveArmedKeysOf(p.entry)` from the OLD object, before that call, not after (scanning
`updated` after the re-point would also work, since `replaceEntryEverywhere` moves the exact same key set,
but scanning the old object is what was verified). This was re-derived, not copy-pasted from sites 1/3,
because the capture point matters here in a way it doesn't at a pre-mutation read site.

**Fail-open check (the Lead's own explicit ask):** does widening this site risk writing a reduced latch
for a key the twin does NOT currently occupy? No — the loop's own PRE-EXISTING `if
(activeQuarantines.get(k) !== updated) continue;` check (unchanged by this fix) re-reads the LIVE map,
POST-`replaceEntryEverywhere`, for every candidate key, including any the live-occupancy union adds. This
is a STRICTER ownership gate than a one-time `entryStillOwnsKey` filter would be — it is evaluated against
current state at the moment of the write, not a snapshot — so a stale `armedKeys` member `liveArmedKeysOf`
carries forward (it is union-only, never filtering) is still correctly skipped here. No separate
`entryStillOwnsKey` filter was added at this site; the existing live-map check already subsumes it.

**RED/GREEN:** same `negative-control` proof as sites 1/3 (one combined run covering all three scenarios —
see Verification). Pre-fix: both `kTwinA` and `kTwinB`'s own physical latches kept the cleared
`sharedToken`. Post-fix: both are durably rewritten, `privateToken` survives on both, T stays correctly
blocked.

## Site 4 — `clearMergeQuarantineByRecordedPath`'s `pendingOwnedArmedKeys` — WIDENED FOR CONSISTENCY, CLOSED NON-REPRODUCIBLE

Byte-identical shape to site 1, in a sibling function. Widened the same way, for consistency and
defense-in-depth — but a standalone repro (a dual-tracked twin, armed by reference at `kTwinA`/`kTwinB`,
cleared via the real `clearMergeQuarantineByRecordedPath(T)` entry point directly) passed clean on BOTH
the unpatched and the patched code, identically.

**Why it's structurally unreachable for this shape:** `activeMatchesAndLiftedKeysFor` scans the WHOLE
`activeQuarantines` map by IDENTITY (`directPathIdentity(entry.repoPath) === identity`), not by reference
to any one object — so whenever a twin is genuinely dual-tracked (armed by reference anywhere in
`activeQuarantines`), it is ALWAYS independently found there too, and gets its own `matched` entry
delegated to `clearMergeQuarantineByKey`. That delegated call (fixed by sites 1/3, above) re-derives ALL
of the twin's live-armed keys via its own `liveArmedKeys` scan, regardless of what this site's
`pendingOwnedArmedKeys` computed. So: whenever there is something live to strand, the already-fixed
active-side path recovers it independently of this site; whenever a pending entry is NOT dual-tracked
(pure pending, no reference anywhere in `activeQuarantines`), there is nothing live to strand in the first
place and this site's own under-inclusion is a no-op. This mirrors `c52b290e`'s own "Site 2 — CLOSED,
NON-REPRODUCIBLE" closure: a structural argument across the reachable branches, not merely one failed
attempt at reproducing it. No test is committed for this site, matching `c52b290e`'s own precedent of not
adding a test for a closed-non-reproducible site.

## Site 5 — `quarantineLatchFileIdsFor` — FIXED, REPRODUCED

A pure read/diagnostic helper (feeds `GET /internal/merge-quarantine/list` and `stillQuarantinedReason`).
`entry.armedKeys?.filter(...) ?? []` on a re-pointed twin (`armedKeys:[]`, live-armed by reference) was
empty, so the function fell through to a `pendingUnresolvedQuarantines.find(p => p.entry === entry)`
match (if pending) or `quarantineHashFor(entry.repoPath)` (a fresh, unrelated hash) — naming NEITHER of
the twin's own real live-armed key ids. No active-stranding consequence (this never deletes or arms
anything), but a human-facing id lookup/diagnostic message would name the wrong file.

**Fix:** `liveArmedKeysOf(entry).filter((k) => entryStillOwnsKey(k, entry))`, same safe pattern as every
other site.

**RED/GREEN:** isolated from the pending flow entirely (active-only twin, never present in
`pendingUnresolvedQuarantines`) — pre-fix returned a single, WRONG fallback id naming neither `kTwinA` nor
`kTwinB`; post-fix returns exactly `[hash(kTwinA), hash(kTwinB)]`.

## Do not

- Do not have `protectOccupantContentBeforeDelete`'s own re-point stamp `armedKeys` onto `written.entry`
  as "the" fix for this shape — the Lead's own ruling rejected this for THIS card specifically because it
  only covers one of 20+ `replaceEntryEverywhere` sites; see `@decision 8db913e2`'s own "Do not" for the
  broader prohibition against copy-forwarding a replaced object's stale `armedKeys`, which this doesn't
  reopen (this card never unions an OLD object's list forward — every site here derives fresh from LIVE
  occupancy).
- Do not add an `entryStillOwnsKey` filter to the reduce-branch write loop (site 2) believing it is
  missing one — the loop's own pre-existing `activeQuarantines.get(k) !== updated` check already is that
  gate, and is stricter (live, post-mutation) than a one-time filter would be. Adding a redundant filter
  is harmless but adds nothing; removing the EXISTING live-map check would reopen a real fail-open.
- Do not add a dedicated regression test for site 4 — it is closed non-reproducible by a structural
  argument (above), not merely an unexplored case; a test asserting a no-op would prove nothing a future
  reader couldn't already derive from `activeMatchesAndLiftedKeysFor`'s own identity-wide scan. If that
  scan's own behavior ever narrows (e.g. stops being identity-wide), re-open this site's own reachability
  question from scratch — do not assume the old argument still holds.
- Do not read "Sites 1/3 and 2 are now fixed" as "every `armedKeys`-only read in this file is now safe" —
  this card closes exactly the five sites named on it (card body, line numbers as of `896271d6`); a future
  `replaceEntryEverywhere` site that grows a NEW `armedKeys`-only consumer is not retroactively covered.
  In particular, `clearTokenFromPendingIndices` (~:3520/:3562/:3646) is LEFT on `armedKeys` deliberately —
  its only caller, `clearMergeQuarantineByToken`, passes non-twin indices only, so `liveArmedKeysOf` would
  add nothing there today. **Two more siblings, `ambiguousIdentitiesForLatchId` (~:532) and
  `writeMergeQuarantineLatch`'s own `freshSecondaryKeys` (~:1399), were left untouched by THIS card — both
  are now closed by card `d69a6744`**, which additionally found `freshSecondaryKeys`'s own gap to be a
  real, reproduced FAIL-OPEN (not merely a theoretical under-inclusion like every site above) — see that
  card's own decision record.

## Verification

- `test/merge-quarantine-1fc3a561-residual-armedkeys-live-scan.mjs` — three scenarios: A (sites 1/3,
  "remove" via `subsetOfClearedTokens`), B (site 2, "reduce" via `tiedViaKeyOrOrphanRef` with a surviving
  token), C (site 5, isolated read-path probe).
- RED/GREEN proof via `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts
  --test packages/daemon/test/merge-quarantine-1fc3a561-residual-armedkeys-live-scan.mjs --ref 6a689870~1`
  (the fix's own parent, `b3f748bd`) — `--ref HEAD` was the correct ref ONLY while the fix was still an
  uncommitted working-tree edit; now that it is committed as `6a689870`, `--ref HEAD` reverts a file to
  itself and is a no-op. A LOGIC-ONLY revert (the tool snapshots the file at its current, fixed state,
  replaces it with the `6a689870~1` pre-fix version, builds, runs — 9/17 checks failed across scenarios
  A/B/C — then restores byte-for-byte and re-proves GREEN). Never an import TypeError: every symbol this
  test imports already existed pre-fix; only the formula inside each of the four widened expressions
  changed.
- Site 4 has no dedicated test — see its own section above for the structural non-reproducibility
  argument that stands in its place.
- Full `merge-quarantine*.mjs` corpus, individually, fresh `LOOM_HOME` per file, both env states
  (`env -u LOOM_DEV -u LOOM_SUPERVISED` / `LOOM_DEV=1 LOOM_SUPERVISED=1`), one lane — see this card's own
  worker report for the pass count.
- `pnpm --filter @loom/daemon guards`, committed first.

See `docs/decisions/6be6c9ff-live-armed-keys-covers-every-key-a-multi-key-twin-reaches.md` and
`docs/decisions/c52b290e-residual-armedkeys-consumers-closed.md`'s own "Do not" sections, both updated to
state this card closes the remaining consumers they tracked.
