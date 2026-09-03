import type { SimpleGit } from "simple-git";
import { withTimeout, boundedSimpleGit } from "./bounded.js";
import { mergeBranch } from "./worktrees.js";

/**
 * Card dbc6f660 — batch the merge gate: gate K ready branches ONCE, land each as its own squashed commit.
 *
 * OWNER-SPECIFIED DESIGN (see the task card + `.loom/research/batched-merge-gate-feasibility-2026-09-03.md`
 * for the full study): cut a dedicated batch worktree `B` from canonical main's current tip, squash-merge
 * each ready branch into `B` in turn (one clean commit per branch, exactly today's shape — every commit
 * still carries its own `Loom-Worker-Branch` trailer), gate `B` ONCE, and on green fast-forward canonical
 * main to `B`'s tip. Canonical main is mutated exactly once, at that fast-forward.
 *
 * Deliberately reuses {@link mergeBranch} UNCHANGED for every squash — it's a generic "squash `branch`
 * onto whatever HEAD `repoPath` currently has" primitive, so pointing it at the batch worktree instead of
 * canonical main produces a byte-shape-identical commit (same subject derivation, same trailers, same
 * merge-danger-window bracketing) with zero changes to that function or anything downstream of it
 * (`scanMergedCommitMap`, `findLandedSquashCommit`, boot-reconcile, the merge-residue latches, the
 * content/pathset verification ladder) — main's commit shape after a batch is identical to today's.
 *
 * RED BATCH / CONFLICT POLICY (owner directive — do not "improve" on this without re-reading the card):
 *  - A branch that won't squash cleanly into the batch (a conflict, or any other squash failure) is
 *    DROPPED and the batch continues with the rest — never aborts the whole batch.
 *  - A RED gate on the assembled batch is NOT bisected. The caller falls back to gating every ORIGINAL
 *    candidate individually (today's path) — measured cheaper than recursive bisection at the worker-cap-
 *    bounded batch sizes this repo can ever reach (K<=4; see the feasibility study).
 *  - Canonical main is FORFEITED (refused, not partially advanced) if it moved between the batch being cut
 *    and the fast-forward — the batch's single gate never validated whatever main became in the meantime.
 */

const GIT_OP_TIMEOUT_MS = 15_000;

export interface BatchGitDeps {
  timeoutMs?: number;
  gitFactory?: (repoPath: string, timeoutMs: number) => Pick<SimpleGit, "raw">;
}

function boundedGit(repoPath: string, deps: BatchGitDeps): { git: Pick<SimpleGit, "raw">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const git = deps.gitFactory ? deps.gitFactory(repoPath, timeoutMs) : boundedSimpleGit(repoPath, timeoutMs);
  return { git, timeoutMs };
}

/** One ready branch offered to a batch — the caller (SessionService) resolves this from a worker session. */
export interface BatchCandidate {
  workerSessionId: string;
  taskId: string | null;
  branch: string;
  taskTitle?: string | null;
}

export interface BatchLandedBranch extends BatchCandidate {
  sha: string;
  subject: string;
  /** True when this candidate's content was already present (typically already-landed-elsewhere in the
   *  SAME batch's own ancestry, or already on main before the batch started) — no new commit was needed,
   *  `sha` names the commit that already carries its content. Mirrors {@link mergeBranch}'s own
   *  `ALREADY_MERGED` classification. */
  noop?: boolean;
}

export interface BatchDroppedBranch extends BatchCandidate {
  reason: string;
  conflict?: boolean;
}

export interface BatchAssembleResult {
  landed: BatchLandedBranch[];
  dropped: BatchDroppedBranch[];
}

/** K = min(ready, maxWorkers) — FIXED, never adaptive. The owner ruled out an adaptive-K policy: batch
 *  size is already capped by concurrent-worker throughput, which the feasibility study's own measurement
 *  shows lands the fixed cap inside the model's optimum (K in [2,4], degrading only at K>=5, structurally
 *  unreachable under the cap). Do not make this a function of failure rate, gate reduction eligibility, or
 *  anything else — see the card's explicit prohibition. */
export function computeBatchSize(readyCount: number, maxWorkers: number): number {
  return Math.max(0, Math.min(readyCount, maxWorkers));
}

/**
 * Squash-merge each candidate branch into `batchWorktreePath`, IN ORDER — each squash lands on top of the
 * previous one, so a later candidate's diff is computed against a tree that already contains every earlier
 * LANDED candidate's content (this is what makes the batch's single gate a real test of the combined tree,
 * not an approximation of it).
 *
 * A candidate that won't squash cleanly (a real conflict against an earlier candidate in this same batch,
 * or any other squash failure) is DROPPED — recorded with its reason and the loop continues with the rest.
 * This never throws and never aborts the batch: assembly failure is a per-branch outcome, not a batch-wide
 * one (owner directive — "drop, don't fail").
 */
export async function assembleBatchBranches(
  batchWorktreePath: string, candidates: BatchCandidate[], deps: BatchGitDeps = {},
): Promise<BatchAssembleResult> {
  const landed: BatchLandedBranch[] = [];
  const dropped: BatchDroppedBranch[] = [];
  for (const c of candidates) {
    const r = await mergeBranch(batchWorktreePath, c.branch, c.taskTitle ?? undefined, deps);
    if (!r.ok) {
      dropped.push({ ...c, reason: r.reason ?? "squash failed", conflict: !!r.conflict });
      continue;
    }
    if (r.noop) {
      if (r.emptyKind === "ALREADY_MERGED" && r.sha) {
        landed.push({ ...c, sha: r.sha, subject: r.subject ?? (c.taskTitle ?? c.branch), noop: true });
      } else {
        // STAGE_EMPTY_RETRY (or an ALREADY_MERGED with no resolvable sha) — genuinely nothing this batch
        // can prove either way; let the individual fallback path (today's confirmWorkerMerge, which has
        // its own idempotency handling for this exact classification) sort it out rather than guessing here.
        dropped.push({ ...c, reason: `empty diff (${r.emptyKind ?? "unknown"}) — nothing to merge` });
      }
      continue;
    }
    if (!r.sha || !r.subject) {
      dropped.push({ ...c, reason: "merge reported ok with no sha/subject" });
      continue;
    }
    landed.push({ ...c, sha: r.sha, subject: r.subject });
  }
  return { landed, dropped };
}

export interface FastForwardResult {
  ok: boolean;
  /** True iff the refusal is SPECIFICALLY because canonical main moved since the batch was cut (the
   *  forfeit condition, DoD-5) — distinct from an ordinary fast-forward failure (e.g. a dirty canonical
   *  working tree), which the caller should NOT classify as a forfeit. */
  forfeited?: boolean;
  reason?: string;
  currentMainSha?: string;
}

/**
 * Advance canonical main to `targetSha` — but ONLY if canonical HEAD is still exactly `expectedBaseSha`,
 * the sha the batch worktree was cut from. This is the forfeit check (card dbc6f660 DoD-5): if main
 * advanced while the batch's single gate was running, that gate never validated main's real current tree,
 * so this refuses rather than fast-forwarding past unverified state. Canonical repo is left COMPLETELY
 * untouched on every refusal path — the caller falls back to gating every originally-batched branch
 * individually (today's behavior), exactly as if batching had never been attempted.
 */
export async function fastForwardCanonicalMain(
  repoPath: string, expectedBaseSha: string, targetSha: string, deps: BatchGitDeps = {},
): Promise<FastForwardResult> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  let currentMainSha: string;
  try {
    currentMainSha = (await withTimeout(
      git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (canonical, batch fast-forward check)",
    )).trim();
  } catch (e) {
    return { ok: false, reason: `failed to read canonical HEAD: ${(e as Error).message}` };
  }
  if (currentMainSha !== expectedBaseSha) {
    return {
      ok: false, forfeited: true, currentMainSha,
      reason: `canonical main advanced (now ${currentMainSha}) since this batch was cut from ${expectedBaseSha} — this batch's gate never validated main's current tree; falling back to a per-branch re-gate`,
    };
  }
  if (targetSha === expectedBaseSha) return { ok: true }; // nothing landed on top — no-op fast-forward
  try {
    await withTimeout(
      git.raw(["merge", "--ff-only", targetSha]), timeoutMs, "git merge --ff-only (canonical, batch fast-forward)",
    );
  } catch (e) {
    return { ok: false, reason: `fast-forward failed: ${(e as Error).message}` };
  }
  return { ok: true };
}

/** What the caller's gate callback reports back for the ONE batch gate run — the batching orchestrator
 *  itself is gate-mechanism-agnostic (it never spawns a process or touches GateSemaphore directly), so any
 *  real integration wires `runGate` to whatever this daemon already uses for a real gate run. */
export interface BatchGateResult {
  passed: boolean;
  /** DoD's "measured interaction" note: batching unions K branches' changed paths, so a batch is far less
   *  likely to qualify for a reduced gate than a single un-batched merge — recorded here for the follow-up
   *  telemetry card (4f7f6854) to tell an absorbed-free gate from a genuinely-saved one, never ACTED on
   *  (no reduction-aware batch selection — see this file's own header doc). */
  emitCompareReduced?: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface RunBatchedMergeResult {
  ok: boolean;
  landed: BatchLandedBranch[];
  dropped: BatchDroppedBranch[];
  baseMainSha: string;
  batchHeadSha?: string;
  gatePassed?: boolean;
  gateFailed?: boolean;
  forfeited?: boolean;
  reason?: string;
  gateDetail?: BatchGateResult;
}

/**
 * The top-level batch orchestrator. `batchWorktreePath` must already exist, cut from canonical main's
 * CURRENT tip (`baseMainSha`) — creating/destroying that worktree is the caller's job (reuse the same
 * `createWorktree`/cleanup every worker worktree already uses; this module has no opinion on provisioning).
 *
 * Assembles `candidates` into the batch worktree, gates the result ONCE via the injected `runGate`
 * callback, and on green fast-forwards canonical main. On a RED gate or a forfeit, this does NOT retry or
 * bisect — it reports the outcome and leaves canonical main untouched; the caller is expected to fall back
 * to gating every ORIGINAL candidate individually (today's path).
 *
 * `runGate`'s third argument is the ACTUAL landed-branch count for this gate run — `landed.length` AFTER
 * any conflict/assembly drop-outs, never the requested K — so a caller stamping this onto the gate child's
 * env (card dbc6f660's `LOOM_GATE_BATCH_SIZE`) reports what the gate genuinely covered.
 */
export async function runBatchedMerge(
  repoPath: string, batchWorktreePath: string, baseMainSha: string, candidates: BatchCandidate[],
  runGate: (worktreePath: string, baseMainSha: string, landedCount: number) => Promise<BatchGateResult>,
  deps: BatchGitDeps = {},
): Promise<RunBatchedMergeResult> {
  const { landed, dropped } = await assembleBatchBranches(batchWorktreePath, candidates, deps);
  if (landed.length === 0) {
    return { ok: false, landed, dropped, baseMainSha, reason: "nothing squashed cleanly into the batch — every candidate was dropped" };
  }
  const gate = await runGate(batchWorktreePath, baseMainSha, landed.length);
  if (!gate.passed) {
    return { ok: false, landed, dropped, baseMainSha, gatePassed: false, gateFailed: true, gateDetail: gate, reason: gate.reason ?? "batch gate failed" };
  }
  const { git, timeoutMs } = boundedGit(batchWorktreePath, deps);
  let batchHeadSha: string;
  try {
    batchHeadSha = (await withTimeout(
      git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (batch worktree, post-gate)",
    )).trim();
  } catch (e) {
    return { ok: false, landed, dropped, baseMainSha, gatePassed: true, gateDetail: gate, reason: `failed to read batch worktree HEAD after a green gate: ${(e as Error).message}` };
  }
  const ff = await fastForwardCanonicalMain(repoPath, baseMainSha, batchHeadSha, deps);
  if (!ff.ok) {
    return {
      ok: false, landed, dropped, baseMainSha, batchHeadSha, gatePassed: true, gateDetail: gate,
      forfeited: !!ff.forfeited, reason: ff.reason,
    };
  }
  return { ok: true, landed, dropped, baseMainSha, batchHeadSha, gatePassed: true, gateDetail: gate };
}
