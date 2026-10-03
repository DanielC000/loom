# ba663984 — reintroduce the watermark-preferred branch pin on the batch fast-forward, fail-closed on a corrupt watermark

## Narrative

Split out of `2a6a292a` by lead `gen 388` (2026-10-02) to keep that card's round 2 scoped. `2a6a292a`'s
own DoD ended with "a following batch refuses" — that needed the batch cut's branch pin
(`expectedBaseBranch`, `sessions/service.ts`'s `mergeBatchTracked`) to PREFER the stored mainline
watermark over the live checkout, exactly the preference `b801bad0` round 3 added and then reverted in the
same card. Round 3 reverted it because `checkMainlineMove` used to silently re-stamp the watermark onto
whatever branch was observed on any branch CHANGE — including the very stray branch a divert refusal had
just caught, corrupting the watermark for exactly one batch (the next batch's cut then either spuriously
refused or agreed with the still-diverted checkout). `2a6a292a` closed that re-stamp: a branch mismatch
under an established watermark now only ALERTS (`mainline_moved_outside_loom`, `evidence:
["branch-diverted"]`) and leaves both `branch` and `sha` untouched, never `store()`s. This card is the
deferred follow-up both records named: reintroduce the preference now that it is safe, mirroring the solo
squash path's identical preference (`expectedMainlineBranch`, `confirmWorkerMerge`, card `d69d4858`,
landed as commit `fb9018f8`).

**Sibling:** `d69d4858` did the identical thing for the SOLO path, two days earlier. This card mirrors it
for the batch path's `fastForwardCanonicalMain` pin (`git/batch-merge.ts`, unchanged — it already accepts
whatever `expectedBaseBranch` the caller passes, since `b801bad0`).

## Design

- **Resolved in `mergeBatchTracked`, right after the op's durable tombstone is minted, before the batch
  worktree is ever cut:** `mainlineWatermarkKey(finalProjectId, batchRepoKey)` → `this.db.getMeta(...)` →
  `parseMainlineWatermark(...)`. The SAME store/helpers `checkMainlineMove` and the solo path read — never
  a second independent mechanism.
- **Fail-closed on a present-but-corrupt watermark (the gap a straight copy of the solo path's one-liner
  would have reopened — see "Round 2 correction" below):** a watermark key that resolves to a VALUE which
  fails `parseMainlineWatermark` (bad JSON, wrong shape, a sha that fails the hex regex), or whose
  `getMeta` call throws, refuses the WHOLE batch outright — before any worktree is cut or gate run — rather
  than falling back to a live read. Only a genuinely ABSENT row (`getMeta` returns `undefined` — true first
  sight, mirroring `checkMainlineMove`'s own `!w` semantics and the solo path's "no watermark yet" case)
  falls back to the live branch, unchanged from before this card. This refusal reuses the existing
  `branchDiverted: true` typing (same no-fallback, same `NEVER_CACHED_OUTCOMES` membership, same
  `classifyOutcome` mapping as an ordinary divert) since the consequence and trust posture are identical —
  but it fires BEFORE `createWorktree`/the gate run (no `phaseTimings`, matching
  `MergeBatchResult.phaseTimings`'s own "never on an early bail-out" doc), and its durable
  `batch_merge_branch_diverted` event carries an extra `watermarkUnreadable: true` marker so it's
  distinguishable from a live-checkout divert in the audit trail.
- **The branch half of the pin only:** `expectedBaseBranch = watermark?.branch ?? baseMainHead?.branch`.
  `baseMainSha` (the pre-existing sha-only forfeit check) is UNCHANGED — it stays live-read-based; only the
  branch half of the pin prefers the watermark, mirroring `b801bad0`'s own "branch half" framing and
  `d69d4858`'s identical split on the solo side.
- **Refusal wording (both the pre-ff and post-ff branch-mismatch refusals in `fastForwardCanonicalMain`,
  `git/batch-merge.ts`) now names BOTH remedies**, mirroring the solo squash path's pre-squash/post-squash
  refusal wording almost verbatim (`requireCanonicalHead`'s branch check and its post-squash twin,
  `git/worktrees.ts`): restore the checkout to the expected branch and re-confirm, OR — if the observed
  branch is actually a deliberate mainline rename — ask the owner to reset the project's mainline baseline
  via `POST /api/projects/:id/mainline-watermark/reset` (loopback, human-only, the route `2a6a292a` added).
  Previously these two reasons named only "something diverted the checkout" / "refusing to report success"
  with no remedy at all.

## Round 1 — a discovered interaction with `checkMainlineMove`'s own "true first sight"

A full sweep of every hermetic test referencing `mergeBatchTracked`/`expectedBaseBranch`/`mainlineWatermarkKey`
(69 files) surfaced ONE genuine regression: `batch-merge-diverted-not-cached.mjs`. Its scenario is a brand
NEW project's FIRST-EVER batch landing diverting mid-gate, followed by a second, correctly-restored re-fire
that must land. Root cause, pre-existing and unrelated to this card: `checkMainlineMove` (`sessions/service.ts`,
card `4fa36502`/`2a6a292a`) runs mid-gate (after the gate passes, before the fast-forward) and, on TRUE first
sight (`!w`, no watermark ever stamped for this project/repoKey), `store()`s UNCONDITIONALLY — whatever branch
is CURRENTLY checked out becomes the new trusted baseline, with nothing yet to compare it against. When the
very FIRST landing attempt happens to divert mid-gate, that silently seeds the watermark with the STRAY
branch, not mainline. Before this card, the batch pin never consulted the watermark, so that seeded value was
harmless. After this card, a SUBSEQUENT batch's pin now prefers that (wrongly-seeded) watermark over the live
read — and the live read is the one telling the truth (checkout correctly restored to mainline) — producing a
false `branchDiverted` refusal on a batch that should have landed.

This is a latent gap in `checkMainlineMove`'s own existing design (2a6a292a's "Do not" list explicitly forbids
changing its `!w` handling here: "Do not read `!w || w.branch !== head.branch` as one condition again" is
about something else, but the TRUE-first-sight branch itself — storing whatever is currently checked out with
nothing to compare against — is exactly what 2a6a292a intentionally kept unconditional). Fixing
`checkMainlineMove` itself is out of scope for this card: it is shared by both the solo and batch paths, and
the same latent risk exists on the solo path too (`confirmWorkerMerge`'s own mid-confirm `checkMainlineMove`
call, card d69d4858) — flagged here for a follow-up card, not fixed by either.

**Fix, scoped to the one affected test:** `batch-merge-diverted-not-cached.mjs` now lands ONE ordinary seed
batch first, via a SEPARATE always-pass `SessionService` instance sharing the same db/repo (so the dedicated
`gateCalls` counter this file's own mechanism depends on stays untouched) — establishing a real, trustworthy
watermark BEFORE the divert scenario it actually tests ever runs. This mirrors `batch-merge-watermark-branch-pin.mjs`'s
own pre-existing seed step, for the identical reason. No other file in the 69-file sweep needed changes;
`batch-merge-gate-history.mjs`'s own apparent 3 "FAIL" lines are literal captured text inside a deliberately-
failing fixture's gate output tail, not check failures (that file's own run exits 0, "All checks passed.").

## Round 2 correction (manager review)

The kickoff described this card's corrupt-watermark handling as "mirror the solo path's existing
treatment." **That description does not hold under inspection — flagged, not silently copied.** The solo
path's own resolution (`confirmWorkerMerge`, `sessions/service.ts` ~14728) is the SAME bare one-liner this
card started from: `parseMainlineWatermark(this.db.getMeta(...))?.branch` — `parseMainlineWatermark` itself
returns `null` uniformly for a missing row (`!raw`), a JSON-parse failure, and a wrong-shaped value (see
its own implementation, `git/mainline-watch.ts`), so `?.branch` collapses "absent" and "present-but-corrupt"
to the identical `undefined` with no way to tell them apart from the return value alone. `checkMainlineMove`
reads the same way: `2a6a292a`'s own design section states "TRUE first sight = `!w`" — i.e. by that card's
OWN definition, "no watermark" is keyed off `parseMainlineWatermark`'s return, which does not distinguish a
corrupt row from an absent one either. **There is no existing code anywhere in this codebase, on either
path, that already does what the kickoff asked to be mirrored.** This card introduces the distinction fresh,
for the batch path only: raw `getMeta()` is read and checked for `undefined` BEFORE handing it to
`parseMainlineWatermark`, so "absent" (fall back) and "present but unparseable" (refuse) are now
distinguishable. The solo path (`d69d4858`) and `checkMainlineMove` (`2a6a292a`) carry the SAME latent gap
today — flagged for a human decision on a follow-up card, not fixed here (out of scope: this card owns the
batch fast-forward pin only).

## Round 3 (Code Review `1f8652d6`, APPROVE with two Minors)

1. **The early watermark-unreadable refusal settled with no `batchGateVerdict`, so `onSettle` wrote a BARE
   settled row** (`db.settlePendingGateOp(opId, undefined)`) — a direct violation of `@decision 92eeb319`'s
   "never a bare row" rule (that decision's own doc only enumerated two no-gate-ran cases, `batchAllDropped`
   and a pre-worktree-cut throw; this refusal is a THIRD, uncovered one). Fixed: `MergeBatchResult` gained a
   new `watermarkUnreadable?: boolean` field, set alongside `branchDiverted:true` on this refusal only;
   `onSettle` synthesizes `{kind:"skipped", payload:{reason, skipReason:"watermark-unreadable",
   batchBranchCount:0, batchLanded:false, ...timing}}` for it — the SAME shape `batchAllDropped` already
   uses for "no gate ever ran," per that field's own doc comment in `db.ts` (`PendingGateOpVerdict.skipReason`),
   which is literally the authority `@decision 92eeb319` cites for this exact pattern. `"skipped"`, not
   `"fail"`: no gate ever ran (this refusal fires before the worktree is even cut), matching the established
   convention (`a228dfb5`: "a merge with an inert-diff-skipped gate must map to skipped, never pass/fail").
2. **The settle-nudge text was hard-coded for a live divert** ("Restore the canonical checkout… a solo
   confirm now would land off mainline") even for this refusal, where the checkout may be perfectly fine —
   it is the STORED RECORD that is untrustworthy. Fixed: a new, dedicated `[loom:merge-batch-watermark-unreadable]`
   nudge branch, checked BEFORE the generic `branchDiverted` branch (both in the async settle-nudge builder
   and nowhere else needs it, since the tombstone-verdict synthesis above doesn't build human-facing prose),
   naming the reset route and explicitly NOT claiming a divert.

Both verified RED-then-GREEN style: before the fix, `batch-merge-divert-unverified-nudge-text.mjs`'s new
scenario (C) and `batch-merge-watermark-branch-pin.mjs`'s (U1)/(U2) gate_status checks could not have
passed (the field/branches didn't exist yet); after, all pass. Full per-file results: `batch-merge-watermark-branch-pin.mjs`
44/44, `batch-merge-diverted-not-cached.mjs` 15/15, `batch-merge-divert-unverified-nudge-text.mjs` 18/18
(new scenario C), plus all 11 other hermetic tests referencing `settlePendingGateOp` (139 total PASS across
them, 0 real FAIL — two files' apparent "FAIL" grep hits are literal captured-fixture-output text, not
check failures, confirmed by each file's own `exit 0`/"ALL PASS" banner). `pnpm --filter @loom/daemon guards`:
25/25.

## Do not

- Do not read a watermark row's `getMeta()` result straight into `parseMainlineWatermark(...)?.branch` as a
  single expression on the batch path — that collapses "absent" and "present-but-corrupt" into the same
  `undefined` and silently falls back to a live read for BOTH, reopening the exact pre-existing-divert gap
  this pin exists to close for the one case most likely to be tampering (a hand-edited/corrupted record).
  Check `getMeta()`'s raw return for `undefined` FIRST.
- Do not treat a `getMeta()` throw as equivalent to "no watermark" — wrap the read and refuse on a throw,
  exactly like a present-but-unparseable value; both mean "the stored baseline is untrustworthy right now."
- Do not let the corrupt-watermark refusal cut a batch worktree or run a gate first — it is cheap to detect
  and belongs with the other early bail-outs in `mergeBatchTracked` (ownership/repo-mismatch,
  too-few-candidates, no gateCommand), not buried after an expensive gate run.
- Do not invent a new `MergeBatchResult` field for this outcome — reuse `branchDiverted: true` (same
  no-fallback/no-cache/classify semantics an ordinary divert already gets correctly); distinguish it in the
  durable event detail (`watermarkUnreadable: true`) instead, where an auditor actually needs to tell the
  two apart.
- Do not change `baseMainSha`'s resolution — it is the separate, live-read-only sha forfeit check and is
  not part of this card's "branch half of the pin" scope.
- Do not drop the reset-route remedy from either `fastForwardCanonicalMain` refusal string once added —
  both now mirror the solo path's two-remedy wording; a reader with a deliberate mainline rename needs the
  reset-route option named, not just "restore the checkout."
- Do not assume `b801bad0`'s or `2a6a292a`'s own "Do not reintroduce this pin" bullets are still a standing
  prohibition after this card lands — both are satisfied/historical as of this card; see the correction
  notes appended to each record.
- Do not let ANY early (pre-worktree-cut) refusal settle without explicitly synthesizing a verdict in
  `onSettle` — `batchGateVerdict` is only ever set once `runGate`'s own closure resolves, so a refusal
  returning before that point is settled with a bare row unless its own case is added to that synthesis
  (round 3; the same mistake this card itself made with the watermark-unreadable refusal).
- Do not let the settle-nudge text treat `watermarkUnreadable` and a live `branchDiverted` as the same
  wording — the checkout may be fine in the former; never claim "a solo confirm now would land off
  mainline" or "restore the canonical checkout" for a refusal that is about a corrupt STORED RECORD, not an
  observed divert (round 3).

## Tests

`packages/daemon/test/batch-merge-watermark-branch-pin.mjs` (real git) — (W1)/(P1) FLIPPED from "proceeds
despite a wrong/stale watermark" to "refuses", now asserting the refusal names the expected branch, the
observed branch, and the reset-route remedy; (P2)/(P3) unchanged (confirmed unaffected: P2's divert happens
mid-gate on an already-correct pin, P3 has no watermark and a detached HEAD). New (U1)/(U2) scenarios:
(U1) a watermark value that fails to parse (`db.setMeta` with non-JSON content) on an otherwise-undiverted
canonical refuses with `watermarkUnreadable`-shaped guidance and lands nothing; (U2) a `getMeta` read that
throws (monkey-patched for the one key under test) refuses the same way. Round 3 added a `gate_status(opId)`
check to both (U1)/(U2): `state:"settled"`, `passed:false`, and `reason` matching the refusal's own reason —
proving the tombstone never settles bare for this exit.

`packages/daemon/test/batch-merge-diverted-not-cached.mjs` — updated (Round 1 above) to seed a trustworthy
watermark via a dedicated always-pass `SessionService` instance before its own divert/cache scenario runs.

`packages/daemon/test/batch-merge-divert-unverified-nudge-text.mjs` — Round 3 added scenario (C): a corrupt
watermark row with NO live divert at all (checkout stays on mainline throughout), forced onto the async
settle path (`syncAttachBudgetMs:1`). Asserts the dedicated `[loom:merge-batch-watermark-unreadable]` tag
(never the generic `-diverted` one), the reset-route remedy, that it NEVER claims a divert or "a solo
confirm now would land off mainline", and — extracting the opId from the nudge text itself —
`gate_status(opId)` resolving as `settled`/`passed:false` with a real reason naming the watermark record.
