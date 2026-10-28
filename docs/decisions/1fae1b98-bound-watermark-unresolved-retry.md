# 1fae1b98 — bound the stale-generation watermark-unresolved retry

## Narrative

From `05915fc7`'s round-2 CR (`087152f2`), scope confirmed by `1e7d6956`'s own "deliberately NOT touched
here" section. The `"watermark-unresolved"` arm of `resolveStaleGenerationOwnLanding` (sessions/
service.ts) did only a `console.warn` + no-op: silent retry-forever, no escalation. This card bounds it,
mirroring `05915fc7`'s own bound for the content-check's `"transient"` bucket (3 boots OR 1 day) — with
one deliberate split that bucket doesn't have.

## Premise correction (manager-approved before implementation) + failure classes

`resolveMainlineWatermarkRef` (service.ts) and `readBaseSha`/`readRefSha`/`resolveGitDirs`
(git/worktrees.ts) are **pure fs, no git spawn**, by explicit design (their own doc comments — off
boot-reconcile's hot-path git-call discipline). So neither a `CanonicalGitRefusal` nor a spawn/timeout
failure (`isSpawnLevelFailure`/`isWithTimeoutExpiry`) can occur here — the kickoff's own failure-class
list, borrowed from the content-check's git-spawn path, didn't apply. A genuinely stalled fs read would
hang unbounded — a real, separate, still-open hazard this card does not touch (bounds retry COUNT across
boots, not one read's duration). Three REAL causes:

1. **`db.getMeta` throws** → `cause:"read-failed"`. Rare; carries a `.code` nothing inspects.
2. **The stored row fails validation** → `cause:"corrupt"`. A deterministic fact about persisted bytes.
3. **The stored branch's ref doesn't resolve** → `cause:"transient"`. `readRefSha`/`resolveGitDirs`
   blanket-`catch{}` every fs call with zero `.code` inspection, conflating a genuinely-gone branch
   (ENOENT on the loose ref AND packed-refs) with a transient fs/host hiccup on the SAME read (EACCES/
   EMFILE/ENFILE/EIO, or a race against a concurrent gc/repack — this project has prior EMFILE/ENFILE
   incidents elsewhere).

## Ruling: only cause 2 escalates immediately

Unlike the content-check's definitive cases (a candidate's content is permanently malformed — no future
event changes that verdict), a watermark failure is a **blocked precondition**, not a content fact about
any candidate. Causes 1 and 3 (collapsed into one `cause:"transient"`, since the code genuinely cannot
tell ENOENT-missing apart from a host hiccup here) get the bounded give-up the content-check's own
`"transient"` bucket has, REUSING `staleGenerationTransientEscalateAttempts`/`_Ms` directly (`05915fc7`
gave the merge-reconcile wedge its OWN pair only because THAT failure can never self-heal — a different
kind of patience; this one needs the same patience the content-check's transient bucket already has).
Cause 2 (`cause:"corrupt"`) escalates on first sight, no attempts/age grace — mirroring `05915fc7`'s own
"transient→definitive escalates on the first definitive boot regardless of prior transient attempts"
rule: `77b8319b` never overwrites an unreadable row, so silent boots only delay the one human fix (a
mainline-watermark reset).

## Counter design: one row, a nested independent `watermark` sub-counter

`StaleGenerationUnresolvedEntry`'s six original fields are now all OPTIONAL — present only once the
CONTENT-CHECK path has recorded a sighting (keyed on `firstDetectedAt !== undefined`, never row
presence) — plus a new, independently-upserted `watermark?: StaleGenerationWatermarkSubEntry`.
`recordStaleGenerationWatermarkUnresolved`/`markStaleGenerationWatermarkEscalated` touch ONLY
`watermark`; the pre-existing content-check pair touches ONLY the six top-level fields; each spreads the
other side's field(s) through untouched.

**Rejected: reusing the top-level fields directly.** `recordStaleGenerationUnresolved` overwrites `kind`
every call and bumps `attempts` on EVERY call regardless of cause — folding watermark failures in would
conflate two unrelated causes' attempt counts (one watermark failure + two later unrelated content-check
failures reads as `attempts:3`, misattributing the pattern) and force a third, orthogonal cause through
`05915fc7`'s kind-flip machine, tested only for two causes on one axis.

**Rejected: a second `app_meta` key** (mirroring how this entry's own key was split from
`MERGE_RECONCILE_WEDGED_KEY`). The nested-field shape was preferred because it satisfies the card's own
test requirement literally — an UPGRADED-store row (no `kind`, no `watermark`) exercises ONE extended
type guard on ONE row shape, not two independent guards on two populations.

**Trade-off accepted:** two independent one-shot nudges CAN fire for one session. Each stays honestly
scoped to the cause it actually observed.

## A pre-existing, unrelated effect this card's tests surfaced

`eb58b8bd`'s own `unreadableWatermarkSkipCount`/`unresolvableWatermarkRefSkipCount` (Pass A's ORDINARY
finalize-by-scan) ALSO consults `resolveMainlineWatermarkRef` and skips EVERY worker in a project whose
watermark is broken that boot — not just the stale generation Pass A2 handles. Confirmed directly by this
card's own fixtures. Pre-existing, unrelated to this card; named here only because a first draft of those
fixtures wrongly assumed a sibling worker's finalize was independent of the broken watermark.

## Round 1 — Code Review (SHIP, with a small round before merge)

**Minor 1 (REPRODUCED latent trap):** `markStaleGenerationEscalated` on a WATERMARK-ONLY row (no content
sighting ever) wrote `escalated:true` with the other five content fields absent — `anyContent` then read
true while `contentValid` read false, so `listStaleGenerationUnresolved`'s all-or-none guard dropped the
WHOLE row on the next read, including an already-escalated `watermark` sub-entry, making its own one-shot
nudge re-fire. Not reachable through either real production call site today (both already have a fresh
`recordStaleGenerationUnresolved` call ahead of them in the same boot) — a latent trap for any future
caller, not a live incident. Fixed: the method also no-ops when `entry.firstDetectedAt === undefined`.
New DB-level test `WATERMARK_ONLY_ESCALATE_SURVIVES` (stale-generation-watermark-unresolved.mjs) seeds a
watermark-only row, escalates its `watermark` sub-entry, then calls `markStaleGenerationEscalated`
directly and asserts the row (and `watermark.escalated`) survive. Proven RED without the fix via a
throwaway `Edit` mutation (dropping the new guard clause), reverted after.

**Minor 2:** the TRANSIENT watermark nudge never named a remedy, unlike the corrupt nudge's `POST
.../mainline-watermark/reset`. Fixed: it now names the SAME route, worded conditionally ("if the stored
branch was renamed or deleted... if it's a host/filesystem condition instead, no action may be needed")
since this cause may self-heal where a corrupt row never does. Asserted directly in `WATERMARK_REF_MISSING`
against the DURABLE nudge text (a new `sentMessages`/`sentMatching` capture on the test's `pty.enqueueStdin`
mock — the pre-existing `warnsMatching` only sees the SHORTER per-boot `console.warn` line, never the full
nudge body).

**Nitpicks, accepted as-is:** a malformed sub-entry (partially-shaped `watermark` or content fields) drops
the WHOLE row — fail-closed, the safe direction. The Minor-1 rollback-re-fire window (before this round's
fix) was low impact: a re-fired nudge is a duplicate human ping, never a correctness loss, and the
reviewer found no live call site that could reach it.

## Tests

NEW file `packages/daemon/test/stale-generation-watermark-unresolved.mjs` (the sibling content-check
file already runs ~5 min solo; this card's own fixtures would push it past the ~8-min split threshold):
`WATERMARK_CORRUPT` (escalates boot 1, sticky), `WATERMARK_REF_MISSING` (bounded give-up, mirrors the
sibling's `BOUND_ATTEMPTS`), `WATERMARK_DB_READ_FAIL` (the other `"transient"` sub-cause, via a surgical
`getMeta` monkeypatch — no production seam exists), `LATER_SUCCESS` (sub-counter stops advancing once
resolvable), `INTERLEAVING` (watermark/content-check/watermark across 3 boots — counters never
conflate), `UPGRADED_STORE` (a no-`kind`/no-`watermark` row survives the type guard),
`WATERMARK_ONLY_ESCALATE_SURVIVES` (round 1, Minor 1 — see above). Three throwaway mutations (`Edit`,
RED, reverted via `Edit` — this card's fix was still uncommitted, never `git stash`/`checkout`): watermark
bumping top-level `attempts` (RED, including `INTERLEAVING`); the type guard requiring `watermark`
present (RED on exactly `UPGRADED_STORE`); dropping the round-1 `firstDetectedAt` guard (RED on exactly
`WATERMARK_ONLY_ESCALATE_SURVIVES`). RED/GREEN against pre-card code proven via `pnpm --filter
@loom/daemon negative-control` against `HEAD` (cut point `16af28e9a55a2ea4874b5d4d8ce898b3471b8520`, the
`1e7d6956` commit).

## Do not

- Do not fold a watermark-read failure into the top-level `attempts`/`kind`/`escalated` fields — use the
  nested `watermark` sub-entry's own pair of methods.
- Do not classify `cause:"corrupt"` like the other causes — it escalates on first sight, no grace.
- Do not claim `isSpawnLevelFailure`/`isWithTimeoutExpiry` or `CanonicalGitRefusal` apply here — no spawn,
  no `withTimeout`, no `canonicalGit` call exists on this path.
- Do not treat ENOENT (branch gone) and a transient fs/host failure on `readRefSha`/`resolveGitDirs` as
  distinguishable today — both collapse to `cause:"transient"`; `.code`-based discrimination is a real,
  separate improvement, not done here.
- Do not assume a sibling worker's landing in the SAME project is unaffected while that project's
  watermark is broken — `eb58b8bd`'s own project-wide skip withholds its ordinary finalize too.
- Do not grow `stale-generation-landedtip-content-check.mjs` with a future watermark-path fixture — use
  `stale-generation-watermark-unresolved.mjs`, or split further if it approaches the same threshold.
- Do not call `markStaleGenerationEscalated` (content-check) expecting it to write on a row that has
  never had a content-check sighting — it is a deliberate no-op there (round 1, Minor 1); use
  `markStaleGenerationWatermarkEscalated` for a watermark-only row.
- Do not remove the conditional wording from the transient-cause nudge's reset remedy (round 1, Minor
  2) — it may self-heal, unlike the corrupt-cause nudge's certain reset; do not merge the two wordings.
