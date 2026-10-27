// Card 1bf5d9c3: extracted out of batch-merge-late-range-commits.mjs (card 114e96e0's own conversion) so
// batch-merge-late-range-reunion.mjs could reuse the SAME helper rather than carry a second verbatim copy
// — two copies of a field-for-field-equal-to-the-real-writer helper is a shared-unit-divergence trap: the
// next writer change updates one copy and silently strands the other. Both files now import this one.
import { randomUUID } from "node:crypto";

/**
 * Seeds the HELD state a real `mergeBatchTracked` run would produce for a retained candidate — writing
 * through the SAME chokepoint the real writer uses (service.ts ~23318-23322: `this.db.appendEvent({...,
 * kind: "batch_merge_branch_retained", workerSessionId, taskId, detail: {opId, branch, assembledTip,
 * liveTip, phase, landedSha, repoKey}})`), with the SAME detail keys and value shapes — including
 * `landedSha` (a real sha, never omitted/null: the real writer always supplies `lb.sha`, the candidate's
 * own just-landed commit). isBranchHeld (service.ts ~21861) reads ONLY this durable event log, never
 * anything mergeBatchTracked computes in-memory, so a caller that also builds the matching git history (a
 * real worktree at `assembledTip`/`liveTip`, a real commit at `landedSha` on main) gets a hold
 * indistinguishable from a real retain — proved field-for-field, and via isBranchHeld/heldRecordedTip/
 * resolveOwedRange's observable effect through the public reviewWorkerMerge/confirmWorkerMerge surface
 * (all three are private methods), by batch-merge-late-range-commits.mjs's own (equivalence check)
 * scenario — the ONE place that equivalence is proved; a caller of this helper cites that scenario rather
 * than re-deriving the proof.
 * `landedSha` deliberately carries no `Loom-Worker-Branch` trailer. `findLaterBranchSquash` (isBranchHeld's
 * release arm) only greps commits STRICTLY AFTER `landedSha`, so the missing trailer doesn't affect it —
 * but `findLandedSquashCommit` (service.ts ~19072/19199/19639/21367/21374) DOES grep for it on the confirm
 * path; its absence was only MEASURED inert for batch-merge-late-range-commits.mjs's 7 scenarios (outcome-compared), not proven in general.
 */
export function seedHeldBranch(db, { managerSessionId, workerSessionId, taskId, branch, assembledTip, liveTip, landedSha, phase = "pre-stop" }) {
  db.appendEvent({
    id: randomUUID(), ts: new Date().toISOString(), managerSessionId, kind: "batch_merge_branch_retained",
    workerSessionId, taskId,
    detail: { opId: randomUUID(), branch, assembledTip, liveTip, phase, landedSha, repoKey: null },
  });
}
