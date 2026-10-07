# fd189d91 — a safety-tmp-protected pending entry's own id collided with its colliding sibling's real id

From Code Review `347406a6` of `ef651188` round 2, item (a) — reproduced by the reviewer, not yet verified
by the lead at card-filing time; reproduced again by this card's own worker before any fix was written.

## The bug

A Phase-0-protected pending entry Y's safety-tmp is named `<h>.json.tmp-safety-<pid>-<hex>`, where `<h>`
is the COLLIDING SIBLING's own key hash (`writeSafetyTmpResidueAtHash` has no better identity to key a
pending entry's safety-tmp off — ef651188's own "Accepted residual"). `quarantineLatchFileIdsFor`'s old
pending branch derived a pending entry's id by cutting its `sourceFile` at the first `.json` — for this
shape that recovers `<h>` itself, byte-identical to the colliding sibling's own real `armedKeys`-derived
id. `clearMergeQuarantineLatchFile` checks `activeQuarantines` first and returns immediately on a match,
so clearing "Y's id" silently lifted the sibling's quarantine instead, leaving Y in place. A second clear
of the same id (now that the sibling's active entry is gone) then lifted Y — so the two entries were only
ever reachable one at a time, under the same id, with no indication the first clear had opened the wrong
latch. The response named the sibling's own repoPath, so a careful human could in principle have noticed —
but nothing forced them to look.

This was pre-existing before `ef651188`, but `ef651188` made the ambiguous id PERSIST across reboots
(previously, a pending entry without Phase 0's own safety-tmp protection had no stable id to collide this
way in the first place).

## The fix

**One id-derivation chokepoint, used by both the forward and reverse directions.** `pendingLatchIdFor
(sourceFile)` is the single place that turns a pending entry's `sourceFile` into its latch id. Both
`quarantineLatchFileIdsFor` (entry → id, used by the listing route) and `clearMergeQuarantineLatchFile`'s
own reverse id → entries match call it — so the two can never independently drift into disagreeing about
what id a given `sourceFile` maps to, which is exactly how the original bug's "the listing hands out one
id, the clear route silently resolves it to something else" shape could recur with any future, unrelated
change to either side alone.

**Disambiguate the colliding shape at the source.** For a `.tmp-safety-` shaped `sourceFile` (matched via
the existing `SAFETY_TMP_RE`), `pendingLatchIdFor` hashes the tmp's FULL basename (sha256, sliced to 24
hex chars — the same algorithm `quarantineHashForKey` already uses, just over a different string) instead
of cutting at the embedded hash prefix. This produces an id that cannot collide with any active key's own
`quarantineHashForKey` output (a disjoint hash domain: one hashes a canonical repo-lock key string, the
other hashes a full, randomly-suffixed tmp filename) — in the primary repro, Y and its colliding sibling
now get genuinely different ids at the LISTING step, with no ambiguity for a human to even reach.

**ID stability across reboots.** The disambiguated id is a pure function of the safety-tmp's own
basename, which never gets renamed while Y stays pending: the recovery read loop (the branch that re-reads
an on-disk safety-tmp on a LATER boot) never calls `writeSafetyTmpResidueAtHash` again for an
already-protected entry — it just re-pushes `{entry, sourceFile: f}` with the SAME `f`. Phase 0's own
pending-protection pass (the ONLY call site that ever mints a NEW safety-tmp name) can never re-fire for an
already-tmp-shaped `sourceFile` either: it only protects an entry whose `sourceFile` is a member of
`allBootWriteTargets`, and every member of that set is always a bare `<hash>.json` write-target basename —
never a `.tmp-safety-...`-suffixed name. So a safety-tmp's name, once minted, is immutable until the entry
either graduates (resolves and gets durably written to its real final, at which point it gets a NEW,
armed-key-derived id — expected, not a regression) or a human clears it. Verified directly: a 3-boot
scenario asserts the SAME disambiguated id is returned on every boot while the entry stays pending.

**The clear route's own backstop, for shapes beyond the one disambiguated above.** `clearMergeQuarantineLatchFile`
now computes its active match and its pending match(es) (via the same `pendingLatchIdFor` chokepoint)
WITHOUT acting on either immediately. **Scoped to the active+pending combination only**: one id must
never resolve to an active entry AND a pending entry for two DIFFERENT repos — when an active match
exists AND at least one pending match has a DIFFERENT `directPathIdentity` from the active match's own
`repoPath`, the clear REFUSES (`{ok:false, reason}` — the existing refusal shape, no new field) naming the
active entry's repoPath and every differently-identified pending entry's repoPath, and points at
`/clear-by-path` (by repoPath) instead. This also catches a shape the id-disambiguation above does NOT
cover on its own: a degraded-divert pending entry whose `sourceFile` is FINAL-shaped (`sha(Kx).json`, no
tmp suffix at all) sharing an id with the degraded occupant X genuinely armed at `Kx` — `SAFETY_TMP_RE`
never matches this shape, so `pendingLatchIdFor` still returns the bare hash for it, and the two
legitimately collide. Refusing and naming both is the safe, conservative answer for a shape this card's
own primary fix does not reach.

This does NOT extend to the PENDING-ONLY branch (no active match at all): when an id matches two or more
PENDING entries and nothing active, the existing, pre-existing-by-design behavior is unchanged — it lifts
EVERY matching pending claimant in one call (card `6237bef6`'s own "collect every pending entry sharing
this id, never just the first" rule; see also `f5c42043`'s multi-claimant divert tier). That is a
DIFFERENT, deliberate multi-claimant-sharing-one-physical-file shape, not the two-different-repos
ambiguity this round's own refusal targets — conflating the two would wrongly refuse a legitimate,
long-standing clear.

**The refusal is never more permissive than the listing.** Every id `GET /internal/merge-quarantine/list`
emits corresponds to a real in-memory entry by construction (an id is always *derived from* an entry, not
guessed) — so for every id the list route hands out, `clearMergeQuarantineLatchFile` must either clear it
(`wasQuarantined:true`) or refuse it as ambiguous (`ok:false`); it must never fall through to the
"nothing matches" orphan-sweep branch. Verified directly, not merely argued: a test builds a mixed
active+pending+ambiguous fixture, collects every id the listing would emit, and asserts each one's clear
result is one of those two shapes.

**Not ambiguous: the documented same-entity, two-structures shape.** An entry can legitimately be BOTH
armed in `activeQuarantines` AND present (by the SAME object reference) in `pendingUnresolvedQuarantines`
(`listActiveMergeQuarantines`'s own doc comment: "either way, it must be reported once, never twice").
When every matched pending entry shares the SAME `directPathIdentity` as the active match, this is NOT
ambiguous — it is one entry found via two routes — and the clear proceeds via the existing
`clearMergeQuarantineByKey` path unchanged (which already separately sweeps same-identity pending entries
via its own `identityRepoPath` match, not via this id-derived one).

## Item (d) + card a2f381dc — a logical quarantine reported twice, via two non-reference-equal objects

Item (d) was an "unverified question" in the original card, with an explicit instruction to build a repro
before writing any fix. The repro confirmed a real, distinct defect; the Lead then ruled to FOLD card
a2f381dc (a separate, already-filed card for the same SYMPTOM) into this same round, since both are the
SAME bug class reached from opposite directions.

**The shared root cause.** `reenterMergeQuarantinesAtBootImpl` maintains the SAME logical quarantine
state in two structures: `byRepoKey` (the active/armed side) and `pendingUnresolvedQuarantines` (the
boot-unverifiable side). Several sites in that function REPLACE an entry object with a new one — a fold,
a union, an orphan-reference merge — via a plain object spread. Every one of those sites used to update
only the side it was directly working on, leaving the OTHER structure's matching reference (when one
existed) pointing at the now-stale, pre-replacement object. `listActiveMergeQuarantines`'s own Set-dedup
is BY REFERENCE, so two non-reference-equal objects representing the same logical quarantine are reported
as two DIFFERENT entries.

**Item (d)'s own trigger (fd189d91).** Phase 0's own pending-protection pass (the
`pendingUnresolvedQuarantines = ...map(...)` loop, right before `fsyncQuarantineDir()`) replaces a
pending entry's `.entry` via spread whenever its `sourceFile` collides with `allBootWriteTargets`. A
degraded-divert entry (pushed by `flushDegradedDiverts()`) has `.entry` reference-equal to `byRepoKey`'s
own occupant, and a `sourceFile` that is NEVER `sha(resolvedKey)` by construction — it is the raw,
stale-keyed filename the divert was found under. When that raw filename happens to collide with an
UNRELATED, non-degraded sibling's own migrate target this boot, the replace silently orphans `byRepoKey`'s
own reference — reached with no orphan file and no PASS 2 involvement at all.

**a2f381dc's own trigger (Code Review `b4742106`'s own R3 repro).** PASS 2's own orphan-reference merge
(triggered by an unrelated corrupt orphan latch matching no registered repo) replaces `byRepoKey`'s slot
for an `existing` entry via spread (`updated = {...existing, orphanLatchFiles: [...]}`) with NO re-point
of any pending reference to the OLD `existing` object — the exact OPPOSITE direction from item (d)'s own
trigger (that one replaces the PENDING side and orphans `byRepoKey`; this one replaces the ACTIVE side and
orphans `pendingUnresolvedQuarantines`).

**The fix — ONE chokepoint for every SAME-IDENTITY replace, plus a structural invariant.**
`replaceEntryEverywhere(byRepoKey, oldEntry, newEntry)` is the single place that replaces an entry object
representing the SAME logical repo: it scans `byRepoKey` by VALUE (never trusting `oldEntry.armedKeys` to
be complete) and `pendingUnresolvedQuarantines` by reference, updating every matching slot on BOTH sides
in one call. Phase 0's pending-protection map and PASS 2's own orphan-reference merge (a2f381dc's
trigger) are LOAD-BEARING routings — a real repro goes RED if either is reverted. Phase 1b's
degraded-occupied fold is also load-bearing (replacing its own prior hand-rolled `byRepoKey.set` loop AND
manual `p.entry === occupant` re-point with this one call). Phase 2's tmp-promotion write and Phase 3's
two delete-fold branches are routed too, but DEFENSIVELY — no known pending reference reaches any of the
three today (CR `0a408575` reverted each alone and ran the full suite with zero RED); see the site census
below for why they stay routed anyway. A new structural invariant,
`assertQuarantineIdentityInvariantTestOnly` (exported TEST-ONLY — kept out of `packages/daemon/src/**`
imports by this card's own `no-src-testonly-import-guard.mjs`), asserts that for every distinct repo
identity at most one DISTINCT object represents it, and that `listActiveMergeQuarantines`'s own count
equals the number of distinct identities — catching the NEXT spread-replace site a future change might add
without routing through the chokepoint.

**`armQuarantineKey`'s own union is DELIBERATELY excluded — it is a different shape, not an oversight.**
`prior` and `entry` there can be TWO DIFFERENT LOGICAL IDENTITIES that merely SHARE one key (a degraded
occupant and the sibling that degraded-occupies it) — not "the same repo, rebuilt." An earlier draft of
this fix routed `armQuarantineKey` through `replaceEntryEverywhere` too (reasoning that `prior` is always
"the thing being replaced") and it measurably REGRESSED a real, previously-green test
(`round4-G2-recovery-writeback-clobbers-degraded-occupant`'s own "refusal durability" check): re-pointing
every existing pending reference to the degraded occupant's own ALREADY-FLUSHED divert (pushed by an
EARLIER `flushDegradedDiverts()` call, before the union ever ran) onto the post-union object silently
replaced the occupant's own independently-queryable identity with the sibling's — the occupant's own
pending divert then resolved to the SIBLING's repoPath on the next query, making the occupant
unrecoverable by its own identity. Caught only by re-running the full existing suite, not by any of this
card's own new scenarios (none of which exercise a degraded-occupant union at all) — the general lesson:
a shared chokepoint is only safe when every call site's own "old" and "new" objects are PROVABLY the same
logical identity; verify that per call site, never assume it from the shape of the code alone.

**Site census (every `byRepoKey.set(...)` with a newly-constructed object, or a `pendingUnresolvedQuarantines`
entry rebuild, in this function):**
- `armQuarantineKey`'s own union (when `prior` existed) — NOT routed, deliberately (see above) — kept
  exactly as it always was (a bare `byRepoKey.set` loop over `armed.armedKeys`).
- Phase 0's pending-protection map — ROUTED, LOAD-BEARING (item d's own site — a real repro goes RED
  when this one is reverted).
- Phase 1b's degraded-occupied fold — ROUTED, LOAD-BEARING (replaces its own prior hand-rolled re-point).
- Phase 2's tmp-promotion write (`armedForWrite`, merge-quarantine.ts:~2402) — ROUTED, DEFENSIVE: CR
  `0a408575` reverted the routing here alone and ran the full 19-file (at the time) suite with ZERO RED —
  no known pending reference reaches this site today. Kept routed for the SAME reason `bootWriteLatch`
  itself is a structural backstop (CLAUDE.md's own "unanticipated" posture): if a future change ever makes
  a pending reference reach here, this is already correct rather than silently reopening the bug class.
- Phase 3's success-with-failed-unlink fold (merge-quarantine.ts:~2447) — ROUTED, DEFENSIVE (same CR
  finding: reverted alone, 0 RED across the full suite).
- Phase 3's write-failure fold (merge-quarantine.ts:~2463) — ROUTED, DEFENSIVE (same CR finding: reverted
  alone, 0 RED across the full suite).
- PASS 2's "existing entry, add orphan ref" branch — ROUTED, LOAD-BEARING (a2f381dc's own site).
- PASS 2's "no existing entry, fresh placeholder" branch — NOT routed: a brand-new entry, nothing old to
  orphan a reference to.
- PASS 1/1b's own dual-arm `byRepoKey.set(currentKey, ...)` restatements (three sites) — NOT routed:
  each re-sets a key to the EXACT object `armQuarantineKey`'s own preceding call already wrote there
  (verified: the object's own `armedKeys` already includes that key by the time this runs) — a redundant
  restatement, not an independent replace.

## Item (b) — a graduated safety-tmp recovery kept a dangling self-reference forever

Same Code Review, item (b). The safety-tmp recovery read loop's plain resolvable-and-not-degraded branch
(the one that arms a recovered safety-tmp's content once its repoPath is verifiable again, with nothing
degraded-occupying its key) never stripped `f` (the tmp's own basename) from the parsed `entry`'s
`orphanLatchFiles` before arming it. When that field already carried `f` — baked in on an EARLIER boot
while this same entry was still pending (round 2 CRITICAL 1's self-reference fix) — the entry graduated
with the self-reference still attached, the end-of-boot write-back durably persisted it (still carrying
`f`) and deleted `f` itself, leaving the durable final permanently naming a file that no longer exists.

Fixed by stripping `f` from `entry.orphanLatchFiles` immediately after parsing, before any of the three
branches (unresolvable / resolvable-plain / resolvable-degraded) run — mirroring the existing strip-then-
selectively-readd pattern at `a6fa60e2` (PASS 1b's own migrate-branch strip) and `be79f4d5`
(`consumeMatchedPendingsIntoArmedEntry`'s strip). The other two branches already explicitly re-add `f` via
their own `[...new Set([...orphanLatchFiles, f])]` spread immediately after, so stripping first is a no-op
for them — only the plain branch's final output changes.

## Do not

- Do not derive a pending entry's latch id by cutting its `sourceFile` at the first `.json` for a
  `.tmp-safety-` shaped name — that recovers the COLLIDING SIBLING's own real key hash, not anything
  unique to the pending entry. Use `pendingLatchIdFor`, which dispatches on `SAFETY_TMP_RE` first.
- Do not let the listing (`quarantineLatchFileIdsFor`) and the clear route
  (`clearMergeQuarantineLatchFile`) compute a pending entry's id via two independently-maintained filters
  — route both through `pendingLatchIdFor`, the one chokepoint, or a future unrelated change to either
  side can silently reopen "the listing hands out one id, the clear route resolves it to something else."
- Do not refuse a clear as "ambiguous" just because an id matches both an active entry AND a pending entry
  found via that same entry's own self-divert (`listActiveMergeQuarantines`'s documented "same object, two
  structures" shape) — compare `directPathIdentity` first; only a GENUINE two-different-repos collision is
  ambiguous.
- Do not assume `pendingLatchIdFor`'s disambiguated id is stable without checking HOW a safety-tmp's name
  could change — it depends on the invariant that `allBootWriteTargets` only ever contains bare
  `<hash>.json` write-target basenames, never a `.tmp-...`-suffixed one. If a future change ever adds a
  tmp-shaped member to that set, this stability guarantee breaks silently; re-verify this record's own
  3-boot stability test still passes before trusting it unexamined.
- Do not add a new response field to make this refusal legible — it reuses the existing `{ok:false,
  reason}` shape both merge-quarantine-clear routes already return on any other refusal; this is a values
  change, not a response-shape change, and none of CLAUDE.md's response-field-set guards apply to it.
- Do not arm a recovered safety-tmp's parsed `entry` into `byRepoKey` without first checking whether its
  own `orphanLatchFiles` already names `f` (its own basename) — strip it up front; the unresolvable and
  degraded branches already re-add it themselves where it is still needed.
- Do not add a NEW site that replaces an entry object via spread (a fold, a union, an orphan-ref merge)
  with its own hand-rolled `byRepoKey.set(...)` loop and/or its own manual `p.entry === oldEntry` pending
  scan — route it through `replaceEntryEverywhere` instead, or the next such site reopens this exact bug
  class, just at a new location (that is literally how a2f381dc and item (d) arose independently).
- Do not trust `oldEntry.armedKeys` as a complete list of where `oldEntry` is stored when replacing it —
  `replaceEntryEverywhere` scans `byRepoKey` by VALUE instead, a structural guarantee rather than an
  inference from bookkeeping that could itself be stale.
- Do not route `armQuarantineKey`'s own union through `replaceEntryEverywhere` — `prior` there can be a
  DIFFERENT logical identity than the union's own result (a degraded occupant sharing a key with the
  sibling that occupies it), and re-pointing its already-flushed pending divert onto the union destroys
  that occupant's own separately-queryable identity. Measured as a real regression; see above.

## Verification

`test/merge-quarantine-latch-id-collision.mjs`: the primary repro (Y pending+safety-tmp vs the colliding
sibling active, both age orders) — list shows DISTINCT ids, clearing either id lifts only that one side;
the ambiguity backstop (an active entry X at Kx vs an unrelated degraded-divert pending entry sharing
`sourceFile = sha(Kx).json`, both age orders) — clearing `hash(Kx)` refuses and names both candidates; a
same-identity self-divert regression guard — clearing that entry's id does NOT refuse; a 3-boot id
stability scenario; ONE committed act-after-reboot scenario (clear-by-path); and the "every listed id is
clearable or refused, never not-found" invariant check over a mixed fixture. The clear-by-new-id
act-after-reboot variant was checked BY HAND during Code Review `0a408575` (not committed as its own
scenario) and behaves correctly. Every scenario run both degraded-occupied and non-degraded where the
axis applies.
Also: a self-referencing safety-tmp that graduates via the plain resolvable branch durably persists with
NO dangling `orphanLatchFiles` entry for its own deleted tmp; the degraded-branch and unresolvable-branch
self-references are confirmed unchanged (regression guards); a 3-boot sequence (write while pending,
graduate, confirm the clean final survives a further reboot with nothing resurrected).
Measured RED against this fix reverted, GREEN restored.

`test/merge-quarantine-identity-split-sync.mjs` (item (d) + a2f381dc, folded): both trigger sites — Phase
0's pending-protection pass (item d) and PASS 2's orphan-reference merge (a2f381dc) — each asserted to
report their logical quarantine EXACTLY once, never twice; a 3-boot count-stability scenario per site; an
act-after-reboot variant per site (clear by id for site 1, clear by recorded path for site 2), each
confirming no resurrection on a further reboot; `assertQuarantineIdentityInvariantTestOnly` asserted after
EVERY boot in every scenario, not just the final one. Item (d)'s own fixture has no natural "age order"
axis in the classic sense (both orders reparametrize which of the two colliding files sorts first in
readdir — confirmed non-discriminating, per this record's own established pattern for Phase-0-vs-PASS1
ordering); a2f381dc's own fixture likewise has no natural order axis (PASS 2 iterates `registeredRepoPaths`,
not a readdir-ordered colliding pair) — its "order-b" scenario is a determinism/parity re-run under a
different tag, stated as such rather than left implying a genuine second order. Measured RED against this
fix reverted (both trigger sites report count=2, non-reference-equal objects), GREEN restored.
