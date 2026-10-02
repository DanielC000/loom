import type { SimpleGit } from "simple-git";
import { withTimeout, canonicalGit, killableCanonicalRaw, treeDeathUnconfirmed, describeGitFailure } from "./bounded.js";
import { assertRepoNotQuarantined, enterMergeQuarantine, clearMergeQuarantineByToken, unconfirmedKillReason } from "./merge-quarantine.js";
import { withCanonicalIndexLock, RepoQuarantinedError } from "./repo-lock.js";
import { findLandedSquashCommit, changedPathSetDigest, parseLoomTrailerBlock, type MergeEmptyKind } from "./worktrees.js";
import { readHeadShaAndBranch } from "./mainline-watch.js";
import { nonInteractiveEnv, stripClaudeSessionTrailer } from "./writer.js";
import { pauseVaultAutoCommit, resumeVaultAutoCommit } from "../vault/versioner.js";
import { mergeCommitBlocksLinearization, MAX_MERGE_COMMITS_CHECKED } from "./merge-linearization.js";
import { isMergeGateRed } from "../orchestration/gate-semaphore.js";

/**
 * Card dbc6f660 — batch the merge gate: gate K ready branches ONCE, land each on main. Canonical main is
 * mutated exactly once, at the fast-forward. See
 * docs/decisions/dbc6f660-batch-merge-forfeited-is-the-one-failure-mode-batching-worsens.md for the
 * owner-specified design and the forfeit failure mode.
 *
 * @decision 6801c0a1 — each candidate branch's own commits land individually (cherry-picked, oldest
 * first), never squashed via {@link mergeBranch}; the tip's Loom-Worker-Branch trailer is written only
 * after that commit is cherry-picked, never inherited from the pre-rebase sha.
 *
 * @decision d62dad73 — the Loom-Worker-Base/PathSet digest is computed against `batchHeadBefore` (the
 * landed base), never `merge-base(HEAD, branch)` (the pre-landing fork point) nor the tip's own `sha^`
 * once a branch lands more than one commit — both diverge once main has advanced past the fork point.
 *
 * @decision bc2240d7 — a merge commit in a branch's range is skipped only if it is a pure main-forward
 * (non-first parents already on the batch HEAD AND empty `diff-tree --cc`); otherwise the branch is
 * dropped with a reason. Never skip on the subject alone. See {@link landBranchCommitsIndividually}.
 *
 * RED BATCH / CONFLICT POLICY (owner directive — do not "improve" on this without re-reading the card):
 *  - A branch that won't land cleanly into the batch (a conflict on ANY of its own commits, a merge commit
 *    in its range, or any other cherry-pick/commit failure) is DROPPED WHOLESALE — every commit it already
 *    landed into the batch tip during this attempt is rolled back (the batch tip is reset to where it stood
 *    before this branch was attempted) — never a partial landing of some-but-not-all of one branch's own
 *    commits, and never aborts the whole batch.
 *  - A RED gate on the assembled batch is NOT bisected. The caller falls back to gating every ORIGINAL
 *    candidate individually (today's path) — measured cheaper than recursive bisection at the worker-cap-
 *    bounded batch sizes this repo can ever reach (K<=4; see the feasibility study).
 *  - Canonical main is FORFEITED (refused, not partially advanced) if it moved between the batch being cut
 *    and the fast-forward — the batch's single gate never validated whatever main became in the meantime.
 *
 * @decision 8ea85329 — this module has no HTML-entity backstop on a batched commit subject (unlike
 * the solo squash path's `mergeBranchLocked`) — a warn-only advisory covers it instead. Do not add a
 * hard refusal here, and do not read this file's silence on entities as coverage.
 */

const GIT_OP_TIMEOUT_MS = 15_000;

export interface BatchGitDeps {
  timeoutMs?: number;
  gitFactory?: (repoPath: string, timeoutMs: number) => Pick<SimpleGit, "raw">;
  /** Card b801bad0 — the branch canonical HEAD was checked out on when `baseMainSha` (the batch's cut
   *  point) was resolved, passed through to {@link fastForwardCanonicalMain} so it can refuse a fast-forward
   *  that would land on a DIFFERENT branch (e.g. a `GitWriter.createBranch()` checkout that diverted the
   *  canonical checkout while this batch's gate was running — the sha-only forfeit check can't see this,
   *  since a fresh `checkout -b` moves to a branch pointing at the SAME commit). Optional: a caller that
   *  passes none keeps today's behavior (sha-only verification), mirroring `mergeBranchLocked`'s own
   *  optional `expectedBranchTip`. */
  expectedBaseBranch?: string;
}

function boundedGit(repoPath: string, deps: BatchGitDeps): { git: Pick<SimpleGit, "raw">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const git = deps.gitFactory ? deps.gitFactory(repoPath, timeoutMs) : canonicalGit(repoPath, timeoutMs);
  return { git, timeoutMs };
}

/** Same seam as {@link boundedGit}, PLUS `nonInteractiveEnv()` on the default factory — matching
 *  `git/worktrees.ts`'s own `boundedMergeGit` convention for a git WRITE (a cherry-pick's own commit step
 *  is exactly that class of call). `gitFactory`, when supplied (the test seam), is used as-is — mirrors
 *  `worktrees.ts`'s identical reasoning: a test injecting a fake doesn't need env scrubbing applied to it. */
function boundedMergeGit(repoPath: string, deps: BatchGitDeps): { git: Pick<SimpleGit, "raw">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const git = deps.gitFactory ? deps.gitFactory(repoPath, timeoutMs) : canonicalGit(repoPath, timeoutMs, nonInteractiveEnv());
  return { git, timeoutMs };
}

/** Generic, non-personal identity used ONLY when the batch worktree has no git identity configured at
 *  all — DUPLICATED from (not shared with) `git/worktrees.ts`'s own `FALLBACK_GIT_IDENTITY`, matching this
 *  codebase's established convention that each commit-creating path decides its own identity policy (see
 *  that constant's own doc comment). A cherry-pick's commit step needs a resolvable identity exactly like
 *  `git merge --no-edit` does — a CI runner or a fresh end-user host may have none configured. */
const FALLBACK_GIT_IDENTITY = { name: "Loom", email: "loom@localhost" } as const;

/** Whether `git`'s cwd has BOTH `user.name` and `user.email` resolvable (any scope) — verbatim copy of
 *  `git/worktrees.ts`'s own `hasConfiguredGitIdentity`, narrowed to `raw` for the same reason. */
async function hasConfiguredGitIdentity(git: Pick<SimpleGit, "raw">): Promise<boolean> {
  try {
    const name = (await git.raw(["config", "user.name"])).trim();
    const email = (await git.raw(["config", "user.email"])).trim();
    return !!name && !!email;
  } catch {
    return false;
  }
}

/** One ready branch offered to a batch — the caller (SessionService) resolves this from a worker session. */
export interface BatchCandidate {
  workerSessionId: string;
  taskId: string | null;
  branch: string;
  taskTitle?: string | null;
  /** Card bbccf470: the branch tip the caller VERIFIED (the reviewed-tip check). When set, assembly cherry-picks exactly this sha and never re-reads the branch ref,
   *  so a commit added after the check cannot ride into the batch; it is stripped from the landed/dropped rows. */
  tip?: string;
}

export interface BatchLandedBranch extends BatchCandidate {
  /** The branch's TIP commit as landed on the batch worktree — the ONE commit (of possibly several this
   *  branch contributed) that carries the `Loom-Worker-Branch` trailer. NOT a squash commit, and NOT
   *  necessarily this branch's only new commit — see this file's own header doc for why the trailer lives
   *  here specifically. */
  sha: string;
  /** The tip commit's own subject line (the worker's OWN commit message, unmodified) — NOT a synthesized
   *  squash subject and NOT the task title (compare the solo squash path, which rewrites the subject to
   *  the task title; a batched landing preserves each worker commit exactly as authored). */
  subject: string;
  /** True when this candidate's content was already present (typically already-landed-elsewhere in the
   *  SAME batch's own ancestry, or already on main before the batch started) — no new commit was needed,
   *  `sha` names the commit that already carries its content. Mirrors the solo squash path's own
   *  `ALREADY_MERGED` classification. */
  noop?: boolean;
  /** How many of this branch's OWN commits carried a `Claude-Session:` trailer that
   *  {@link stripClaudeSessionTrailer} removed before landing — 0 when none did (the common case).
   *  Non-zero is worth surfacing rather than silently mutating a worker's message: it means a worker
   *  put harness attribution on its own commit, against this project's CLAUDE.md, and this landing path
   *  is what caught it. Omitted (not present) on a `noop` landing, which reuses an already-landed sha. */
  strippedTrailerCount?: number;
  /** Whether the tip commit's follow-up `Loom-Worker-Base`/`Loom-Worker-PathSet` amend (card d62dad73
   *  phase 2) actually landed. `true` for the ordinary case; `false` when that best-effort amend failed
   *  (rare — logged at the stamp site, {@link landBranchCommitsIndividually}) and the branch landed WITHOUT
   *  either trailer, degrading its later verification to the weaker `trailer-only` tier with no other trace
   *  (card 1d3f500e / Code Review `c00a136c` — previously this was a `console.warn` only, invisible to the
   *  batch report). Omitted (not present) on a `noop` landing, which reuses an already-landed commit and so
   *  never attempts a stamp — that omission is what tells a `false` (a REAL, this-run stamp failure) apart
   *  from a commit that predates this trailer entirely or was never stamped for any other reason. Does NOT
   *  fail the merge itself: the commit above already landed and stays valid without the trailers. */
  pathSetStamped?: boolean;
  /** The branch tip the batch ASSEMBLED from (card 42daa283). A commit a worker adds afterwards is not in the
   *  batch and not in this sha, so the finalizer compares the live tip against it and RETAINS the branch +
   *  worktree when it moved, rather than `branch -D`-ing a commit that never landed. */
  assembledTip?: string;
}

export interface BatchDroppedBranch extends BatchCandidate {
  reason: string;
  conflict?: boolean;
}

export interface BatchAssembleResult {
  landed: BatchLandedBranch[];
  dropped: BatchDroppedBranch[];
  /** TYPED (round 4, Code Review b2ebf41f) — true iff assembly STOPPED EARLY because a candidate's own
   *  landing quarantined the canonical repo (an unconfirmed tree-kill). `landed`/`dropped` reflect only
   *  what was processed before the stop; any REMAINING candidate was never attempted at all. The caller
   *  (`runBatchedMerge`) must treat this as an abort of the WHOLE batch — no gate, no fast-forward, no
   *  worktree removal — never a per-candidate drop it can shrug off and continue past. */
  quarantined?: boolean;
}

/** K = min(ready, maxWorkers) — FIXED, never adaptive. The owner ruled out an adaptive-K policy: batch
 *  size is already capped by concurrent-worker throughput, which the feasibility study's own measurement
 *  shows lands the fixed cap inside the model's optimum (K in [2,4], degrading only at K>=5, structurally
 *  unreachable under the cap). Do not make this a function of failure rate, gate reduction eligibility, or
 *  anything else — see the card's explicit prohibition. */
export function computeBatchSize(readyCount: number, maxWorkers: number): number {
  return Math.max(0, Math.min(readyCount, maxWorkers));
}

/** {@link landBranchCommitsIndividually}'s return shape — deliberately mirrors the solo squash path's own
 *  `mergeBranch` return (same field names/meanings for `ok`/`conflict`/`sha`/`subject`/`noop`/`reason`/
 *  `emptyKind`) so {@link assembleBatchBranches}'s classification loop below barely changed shape when this
 *  file stopped calling `mergeBranch` — only `sha`/`subject` now describe the branch's TIP commit (see
 *  {@link BatchLandedBranch}'s own doc), not a squash. */
interface LandResult {
  ok: boolean;
  conflict?: boolean;
  sha?: string;
  subject?: string;
  noop?: boolean;
  reason?: string;
  emptyKind?: MergeEmptyKind;
  strippedTrailerCount?: number;
  pathSetStamped?: boolean;
  /** The branch tip this landing was assembled from (resolved once, at the top of the land). */
  branchTip?: string;
  /** TYPED signal (round 4, Code Review b2ebf41f) — true iff `ok:false` because the CANONICAL repo is
   *  quarantined (already, or as of THIS call's own unconfirmed tree-kill), never inferred by parsing
   *  `reason` text. {@link assembleBatchBranches} checks this to ABORT THE WHOLE BATCH rather than drop
   *  one candidate and continue — a quarantined repo means an earlier commit in this SAME candidate's own
   *  range (or an earlier candidate's) may still be unconfirmed-alive, so nothing already landed in this
   *  batch worktree can be trusted to gate/fast-forward safely. */
  quarantined?: boolean;
}

/**
 * Land ONE candidate branch's own commits, INDIVIDUALLY, onto `batchWorktreePath`'s current HEAD — the
 * per-branch assembly step card 6801c0a1 rewrote (see this file's own header doc for the full rationale).
 *
 * Mechanism: cherry-pick every commit in `merge-base(HEAD, branch)..branch`, OLDEST FIRST, each as its own
 * commit (never squashed, never a merge commit), ALWAYS via `--no-commit` so its message passes through
 * {@link stripClaudeSessionTrailer} (card b7f965d2) before the one manual `git commit` that lands it —
 * this project's CLAUDE.md forbids that harness attribution trailer on EVERY worker commit, not just
 * whichever one happens to end a branch, and this is the only path that lands a worker's own commit
 * bodies verbatim, so it's the only place that trailer can otherwise reach mainline unfiltered (the solo
 * squash path, by contrast, never touches a worker's own commit bodies at all — see mergeBranchLocked).
 * Every commit's original author identity (name/email/date) is read and passed explicitly to that manual
 * commit, matching what cherry-pick's own auto-commit would have preserved. The LAST (tip) commit
 * ADDITIONALLY gets `Loom-Worker-Branch: <branch>` appended, PLUS `Loom-Worker-Base`/`Loom-Worker-PathSet`
 * (card d62dad73 phase 2) via a follow-up `git commit --amend` once the tip's real sha exists — every
 * earlier commit from this branch lands with its (trailer-stripped) message and nothing else appended.
 *
 * @decision d62dad73 — the PathSet base is `batchHeadBefore` (this branch's own pre-cherry-pick batch
 * tip), never the branch's own pre-landing diff (`merge-base(HEAD, branch)`) — they diverge once main
 * has advanced past the fork point.
 *
 * ALL-OR-NOTHING PER BRANCH: if ANY commit in the range fails to cherry-pick (a real conflict, or any
 * other failure), the cherry-pick is aborted and the batch worktree is HARD-RESET back to exactly where it
 * stood before this branch was attempted — so a branch never lands PART of its own commit range. This
 * mirrors the owner's "drop, don't fail" directive at the PER-BRANCH granularity the old squash-based
 * assembly got for free (a squash is atomic by construction; a multi-commit cherry-pick sequence is not,
 * so this function has to enforce that atomicity itself). The batch worktree has no concurrent writer of
 * its own during assembly (it's freshly cut, single-purpose, gated only AFTER this returns) — unlike the
 * canonical repo's own squash path, there is no "might be a human's WIP" concern here, so a plain
 * `reset --hard` is safe without the canonical path's own dirty-tree preconditions.
 */
async function landBranchCommitsIndividually(
  repoPath: string, batchWorktreePath: string, branch: string, deps: BatchGitDeps, pinnedTip?: string,
): Promise<LandResult> {
  // QUARANTINE CHECK — must run before any git call, ALWAYS against the CANONICAL repo (never the
  // ephemeral batch worktree path — see merge-quarantine.ts's own doc for why). A batch's own candidates
  // land SEQUENTIALLY onto the SAME `batchWorktreePath` (assembleBatchBranches' loop), so an active
  // quarantine found here can be a leftover an EARLIER candidate in THIS SAME batch raised, or one already
  // in effect from an entirely separate solo/batch attempt against this repo.
  const quarantineCheck = assertRepoNotQuarantined(repoPath);
  if (!quarantineCheck.ok) return { ok: false, quarantined: true, reason: `${branch}: ${quarantineCheck.reason}` };
  const { git, timeoutMs } = boundedMergeGit(batchWorktreePath, deps);

  let branchTip: string;
  try {
    branchTip = (await withTimeout(
      git.raw(["rev-parse", "--verify", `${pinnedTip ?? branch}^{commit}`]), timeoutMs, "git rev-parse branch (batch land)",
    )).trim();
  } catch (e) {
    return { ok: false, reason: `failed to resolve branch tip: ${(e as Error).message}` };
  }

  let batchHeadBefore: string;
  try {
    batchHeadBefore = (await withTimeout(
      git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (batch worktree, pre-land)",
    )).trim();
  } catch (e) {
    return { ok: false, reason: `failed to read batch worktree HEAD: ${(e as Error).message}` };
  }

  let mergeBase: string;
  try {
    mergeBase = (await withTimeout(
      git.raw(["merge-base", "HEAD", branchTip]), timeoutMs, "git merge-base (batch land)",
    )).trim();
  } catch (e) {
    return { ok: false, reason: `failed to compute merge-base: ${(e as Error).message}` };
  }

  if (mergeBase === branchTip) {
    // The branch's own tip is already an ancestor of the batch's current HEAD — nothing new to land
    // (typically: already landed by an earlier candidate in THIS batch, or already on main before the
    // batch was cut). Classify exactly like the solo path's own noop branch.
    const landedSha = await findLandedSquashCommit(batchWorktreePath, branch, "HEAD", deps);
    return landedSha
      ? { ok: true, noop: true, emptyKind: "ALREADY_MERGED", sha: landedSha, branchTip }
      : { ok: true, noop: true, emptyKind: "STAGE_EMPTY_RETRY", branchTip };
  }

  let commitShas: string[];
  try {
    const out = await withTimeout(
      git.raw(["rev-list", "--reverse", `${mergeBase}..${branchTip}`]), timeoutMs, "git rev-list (batch land, commit range)",
    );
    commitShas = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return { ok: false, reason: `failed to enumerate branch's commit range: ${(e as Error).message}` };
  }
  if (commitShas.length === 0) {
    return { ok: false, reason: "empty commit range — nothing to land" };
  }

  // @decision bc2240d7 — never relax either skip condition (see the file header): skipping a merge that
  // carries resolution content silently loses it; dropping every merge broke cancel-then-rebatch.
  let mergeShas: string[];
  try {
    mergeShas = (await withTimeout(
      git.raw(["rev-list", "--merges", `${mergeBase}..${branchTip}`]), timeoutMs, "git rev-list --merges (batch land, merge-commit probe)",
    )).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return { ok: false, reason: `${branch}: failed to probe for merge commits in range: ${(e as Error).message}` };
  }
  if (mergeShas.length > MAX_MERGE_COMMITS_CHECKED) {
    return { ok: false, reason: `${branch}: ${mergeShas.length} merge commits in its own range (more than ${MAX_MERGE_COMMITS_CHECKED} checked) — rebase onto main` };
  }
  for (const m of mergeShas) {
    const why = await mergeCommitBlocksLinearization(git, m, batchHeadBefore, timeoutMs);
    if (why) return { ok: false, reason: `${branch}: merge commit ${m.slice(0, 7)} ${why} — rebase onto main` };
  }
  if (mergeShas.length > 0) {
    try {
      commitShas = (await withTimeout(
        git.raw(["rev-list", "--reverse", "--no-merges", `${mergeBase}..${branchTip}`]), timeoutMs, "git rev-list --no-merges (batch land, commit range)",
      )).split("\n").map((s) => s.trim()).filter(Boolean);
    } catch (e) {
      return { ok: false, reason: `${branch}: failed to enumerate branch's non-merge commits: ${(e as Error).message}` };
    }
    if (commitShas.length === 0) {
      return { ok: false, reason: `${branch}: only main-forward merge commit(s) in its range — no own commits to land` };
    }
  }

  const identityArgs = (await hasConfiguredGitIdentity(git))
    ? []
    : ["-c", `user.name=${FALLBACK_GIT_IDENTITY.name}`, "-c", `user.email=${FALLBACK_GIT_IDENTITY.email}`];

  // A rollback that itself FAILS (e.g. a canonicalGit refusal that also blocks `reset`) must not vanish: it is recorded here and appended to the failing
  // result's reason by `fail`, so a batch worktree left holding residue reads as such instead of as a clean refusal. (`cherry-pick --abort` erroring is
  // expected when no cherry-pick is in progress, so only the `reset --hard` outcome counts.)
  let rollbackIssue = "";
  // Set true the moment rollback's OWN mutating calls hit an unconfirmed tree-kill — folded into `fail`'s
  // returned LandResult below so a caller sees the TYPED flag, never just reason text.
  let quarantinedByRollback = false;
  // Auto-clear hook: once a kill's real confirmation eventually settles — regardless of whether the outer
  // `killableCanonicalRaw` call already gave up first — lift a quarantine THIS invocation may have
  // entered, against the CANONICAL repo (never the batch worktree path).
  //
  // `raisedToken` (round 6, Code Review #5) — COMPARE-AND-CLEAR: this invocation raises at most one
  // quarantine (every raise site below returns immediately), so a single mutable slot holds the token
  // {@link enterMergeQuarantine} returns; the auto-clear presents that SAME token back, so it can never
  // clear a DIFFERENT op's (still-active, differently-tokened) quarantine on this repo.
  let raisedToken: string | undefined;
  const onTreeDeathSettled = (confirmed: boolean): void => {
    if (confirmed && raisedToken) clearMergeQuarantineByToken(repoPath, raisedToken);
  };
  // @decision 24c0bdba — kill-confirmed: this rollback mutates the same batch worktree a LATER cherry-
  // pick/commit in this loop will touch — an orphaned child here must never survive to corrupt that.
  const rollback = async (): Promise<void> => {
    try {
      await killableCanonicalRaw(batchWorktreePath, ["cherry-pick", "--abort"], timeoutMs, "git cherry-pick --abort (batch land)", deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled, repoPath);
    } catch (e) {
      // @decision bde5d1fe — already quarantined at the re-check (never THIS call's own kill) — refuse,
      // never re-raise (no kill happened here to auto-clear later).
      if (e instanceof RepoQuarantinedError) { quarantinedByRollback = true; rollbackIssue = e.message; return; }
      // Round 4: even this best-effort abort quarantines the CANONICAL repo on an unconfirmed kill — an
      // orphaned abort could still be mutating the SAME worktree a later candidate is about to touch.
      if (treeDeathUnconfirmed(e)) {
        raisedToken = enterMergeQuarantine(repoPath, branch, unconfirmedKillReason("batch rollback (cherry-pick --abort) could not be confirmed dead after a kill"));
        quarantinedByRollback = true; rollbackIssue = describeGitFailure(e).text; return;
      }
      /* otherwise best-effort, as before: expected when no cherry-pick is in progress */
    }
    try {
      await killableCanonicalRaw(batchWorktreePath, ["reset", "--hard", batchHeadBefore], timeoutMs, "git reset --hard (batch land rollback)", deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled, repoPath);
    } catch (e) {
      if (e instanceof RepoQuarantinedError) { quarantinedByRollback = true; rollbackIssue = e.message; return; }
      if (treeDeathUnconfirmed(e)) {
        raisedToken = enterMergeQuarantine(repoPath, branch, unconfirmedKillReason("batch rollback (reset --hard) could not be confirmed dead after a kill"));
        quarantinedByRollback = true; rollbackIssue = describeGitFailure(e).text; return;
      }
      // The failed reset only matters if there was something to roll back: a canonicalGit refusal thrown at the FIRST git call of a candidate changed nothing.
      // Both probes are pure reads (never refused), so this stays truthful either way.
      try {
        const head = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (batch rollback probe)")).trim();
        const dirty = (await withTimeout(git.raw(["status", "--porcelain", "--untracked-files=no"]), timeoutMs, "git status (batch rollback probe)")).trim();
        // An EMPTY cherry-pick leaves CHERRY_PICK_HEAD behind with a clean tree, so that must be absent too (`-q --verify` prints nothing when it is).
        const inProgress = (await withTimeout(git.raw(["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"]), timeoutMs, "git rev-parse CHERRY_PICK_HEAD (batch rollback probe)")).trim();
        if (head === batchHeadBefore && dirty === "" && inProgress === "") return;
      } catch { /* cannot prove it clean — fall through and report the failure */ }
      rollbackIssue = describeGitFailure(e).text;
    }
  };
  const fail = <T extends { reason?: string }>(r: T): T & { quarantined?: boolean } => {
    const withReason = rollbackIssue ? { ...r, reason: `${r.reason} (ROLLBACK FAILED — the batch worktree may hold residue: ${rollbackIssue})` } : r;
    return quarantinedByRollback ? { ...withReason, quarantined: true } : withReason;
  };

  let strippedTrailerCount = 0;
  let pathSetStamped = true;
  // Tracks HEAD across iterations so each commit's own `git commit` can be verified to have actually
  // moved HEAD — see the empty-commit check right after the commit call below for why this can't just
  // be inferred from the commit call resolving.
  let currentHead = batchHeadBefore;
  for (let i = 0; i < commitShas.length; i++) {
    const sha = commitShas[i]!;
    const isLast = i === commitShas.length - 1;
    // @decision a32533a1 — do not coerce or rewrite a batched commit's subject to the card title; it
    // lands verbatim, unlike a solo merge's title-coerced squash (toConventionalSubject never runs here).
    //
    // EVERY commit cherry-picks with `--no-commit` (never auto-commits) so its message passes through
    // `stripClaudeSessionTrailer` before the one manual `git commit` that lands it — see this function's
    // own doc for why that can't be limited to just the tip.
    try {
      // @decision 24c0bdba — kill-confirmed: mutates the same worktree index the commit below (and any
      // later candidate in this loop) will also touch.
      await killableCanonicalRaw(
        batchWorktreePath, [...identityArgs, "cherry-pick", "--no-commit", sha],
        timeoutMs, "git cherry-pick (batch land)", deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled, repoPath,
      );
    } catch (e) {
      // @decision bde5d1fe — already quarantined at the re-check (never THIS call's own kill) — refuse
      // directly; rollback() would just refuse too, so skip it (nothing this call mutated).
      if (e instanceof RepoQuarantinedError) {
        return { ok: false, quarantined: true, reason: `${branch}: cherry-pick of ${sha.slice(0, 7)} refused — canonical repo is quarantined: ${e.message}` };
      }
      // @decision 24c0bdba — fail CLOSED + QUARANTINE on an unconfirmed tree-kill: rollback()'s own reset
      // --hard would race whatever might still be alive, never touch the worktree further in that case.
      if (treeDeathUnconfirmed(e)) {
        raisedToken = enterMergeQuarantine(repoPath, branch, unconfirmedKillReason(`cherry-pick of ${sha.slice(0, 7)} could not be confirmed dead after a kill`));
        return { ok: false, quarantined: true, reason: `${branch}: cherry-pick of ${sha.slice(0, 7)}'s git process tree could not be confirmed dead after a kill — refusing further cleanup to avoid racing it; the batch worktree may need manual inspection: ${(e as Error).message}` };
      }
      let conflicted = false;
      try {
        conflicted = (await withTimeout(git.raw(["ls-files", "--unmerged"]), timeoutMs, "git ls-files --unmerged (batch land)")).trim() !== "";
      } catch { /* treat as a non-conflict failure below */ }
      await rollback();
      return conflicted
        ? fail({ ok: false, conflict: true, reason: `${branch}: conflict cherry-picking ${sha.slice(0, 7)} onto the batch` })
        : fail({ ok: false, reason: `${branch}: cherry-pick of ${sha.slice(0, 7)} failed: ${describeGitFailure(e).text}` });
    }
    // @decision 2eb78eb2 — detect an ALREADY-PRESENT (redundant) commit's empty stage EXPLICITLY, before
    // the manual commit below, via `git diff --cached --name-only` (not `--quiet`, whose exit-code signal
    // is indistinguishable from any other `.raw()` failure here) — so a redundant drop reads distinctly.
    let stagedPaths: string;
    try {
      stagedPaths = await withTimeout(
        git.raw(["diff", "--cached", "--name-only"]), timeoutMs, "git diff --cached --name-only (batch land, empty-stage probe)",
      );
    } catch (e) {
      await rollback();
      return fail({ ok: false, reason: `${branch}: failed to probe staged changes after cherry-picking ${sha.slice(0, 7)}: ${(e as Error).message}` });
    }
    if (stagedPaths.trim() === "") {
      // DoD-2's deliberate choice (b): the CONSERVATIVE default. This does NOT skip just the redundant
      // commit and continue landing the rest of the branch — a commit silently skipped is a commit nobody
      // reviewed the absence of. The whole branch drops, exactly like every other failure in this loop,
      // with an honest reason instead of a misleading one.
      await rollback();
      return fail({ ok: false, reason: `${branch}: cherry-pick of ${sha.slice(0, 7)} produced an empty commit — its content was already present in the batch tree; dropping this branch rather than risk amending an unrelated commit` });
    }
    // Read the ORIGINAL message + author identity (name/email/date), then commit manually — preserving
    // authorship explicitly, since a bare `git commit` here would otherwise stamp the CURRENT committer
    // identity as author too, losing the worker's own authorship (true for every commit, not just the tip).
    let originalMessage: string;
    let authorName: string;
    let authorEmail: string;
    let authorDate: string;
    try {
      originalMessage = (await withTimeout(git.raw(["log", "-1", "--format=%B", sha]), timeoutMs, "git log -1 (batch land, original message)")).replace(/\s+$/, "");
      authorName = (await withTimeout(git.raw(["log", "-1", "--format=%an", sha]), timeoutMs, "git log -1 (batch land, author name)")).trim();
      authorEmail = (await withTimeout(git.raw(["log", "-1", "--format=%ae", sha]), timeoutMs, "git log -1 (batch land, author email)")).trim();
      authorDate = (await withTimeout(git.raw(["log", "-1", "--format=%aI", sha]), timeoutMs, "git log -1 (batch land, author date)")).trim();
    } catch (e) {
      await rollback();
      return fail({ ok: false, reason: `${branch}: failed to read original commit metadata for ${sha.slice(0, 7)}: ${(e as Error).message}` });
    }
    const { message: cleanedMessage, stripped } = stripClaudeSessionTrailer(originalMessage);
    if (stripped) strippedTrailerCount++;
    const finalMessage = isLast ? `${cleanedMessage}\n\nLoom-Worker-Branch: ${branch}\n` : `${cleanedMessage}\n`;
    try {
      // @decision 24c0bdba — kill-confirmed: an orphaned child here must never later land onto whatever
      // this SAME worktree happens to be staging by the time it resumes (rollback, or the next candidate).
      await killableCanonicalRaw(
        batchWorktreePath, [...identityArgs, "commit", "--author", `${authorName} <${authorEmail}>`, "--date", authorDate, "-m", finalMessage],
        timeoutMs, "git commit (batch land)", deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled, repoPath,
      );
    } catch (e) {
      // @decision bde5d1fe — already quarantined at the re-check (never THIS call's own kill) — refuse
      // directly, same reasoning as the cherry-pick catch above.
      if (e instanceof RepoQuarantinedError) {
        return { ok: false, quarantined: true, reason: `${branch}: commit failed landing ${sha.slice(0, 7)} — refused: canonical repo is quarantined: ${e.message}` };
      }
      // @decision 24c0bdba — fail CLOSED + QUARANTINE on an unconfirmed tree-kill, same reasoning as the
      // cherry-pick catch above.
      if (treeDeathUnconfirmed(e)) {
        raisedToken = enterMergeQuarantine(repoPath, branch, unconfirmedKillReason(`commit landing ${sha.slice(0, 7)} could not be confirmed dead after a kill`));
        return { ok: false, quarantined: true, reason: `${branch}: commit failed landing ${sha.slice(0, 7)} — its git process tree could not be confirmed dead after a kill; refusing further cleanup to avoid racing it, the batch worktree may need manual inspection: ${(e as Error).message}` };
      }
      await rollback();
      return fail({ ok: false, reason: `${branch}: commit failed while landing commit ${sha.slice(0, 7)}: ${(e as Error).message}` });
    }
    // FAIL CLOSED on an empty commit (card 43a9182d) — a BACKSTOP behind the explicit empty-stage probe
    // above (card 2eb78eb2), which already catches the ordinary "nothing staged" case before the manual
    // commit is even attempted. This assertion stays as defense-in-depth for the residual case where the
    // stage was non-empty (so the probe above passed) yet the commit still produces no net change and HEAD
    // doesn't move. Left unchecked, control would fall through to the tip-only Loom-Worker-Base/PathSet
    // amend below, which unconditionally amends WHATEVER HEAD currently is — silently rewriting a PRIOR,
    // unrelated commit (e.g. an earlier candidate's own genuinely-new commit this same run) with this
    // branch's message and trailers. Assert the OBSERVABLE (HEAD actually moved) rather than pattern-
    // matching the resolved output text, which is locale- and git-version-fragile.
    let newHead: string;
    try {
      newHead = (await withTimeout(
        git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (batch land, post-commit verify)",
      )).trim();
    } catch (e) {
      await rollback();
      return fail({ ok: false, reason: `${branch}: failed to verify commit landed for ${sha.slice(0, 7)}: ${(e as Error).message}` });
    }
    if (newHead === currentHead) {
      await rollback();
      return fail({ ok: false, reason: `${branch}: cherry-pick of ${sha.slice(0, 7)} produced an empty commit — its content was already present in the batch tree; dropping this branch rather than risk amending an unrelated commit` });
    }
    currentHead = newHead;
    if (!isLast) continue;
    // Stamp `Loom-Worker-Base` + `Loom-Worker-PathSet` via a follow-up amend (card d62dad73 phase 2),
    // computed from the LANDED range (batchHeadBefore..the commit just created) — NOT from this branch's
    // own pre-landing diff, which can genuinely differ with no conflict involved (a clean rename-following
    // cherry-pick reproduced this; see the header doc's "WHY THE DIGEST IS COMPUTED FROM THE LANDED
    // RANGE..." section). `batchHeadBefore` is fixed for this whole call (captured once before the loop
    // above began), so this covers the branch's ENTIRE contribution regardless of commit count — for a
    // single-commit branch it's unconditionally identical to `sha^..sha` (phase 1's now-folded-away special
    // case); for a multi-commit branch it's exactly what {@link verifyPersistedPathSet} needs the explicit
    // `Loom-Worker-Base` trailer for, since its own `sha^..sha` would only span this last commit. Best-
    // effort, matching {@link mergeBranchLocked}'s own PathSet capture: a failure here just omits both
    // trailers (the commit above already landed and stays valid without them, degrading to the existing
    // `trailer-only` tier) rather than failing an otherwise-successful branch.
    try {
      // `currentHead` was just verified (above) to be this commit's own real sha — no need to re-query.
      const digest = await changedPathSetDigest(git, batchHeadBefore, currentHead, timeoutMs);
      const amendedMessage = `${finalMessage.replace(/\s+$/, "")}\nLoom-Worker-Base: ${batchHeadBefore}\nLoom-Worker-PathSet: ${digest}\n`;
      // @decision 24c0bdba — kill-confirmed, same reasoning as the plain commit above.
      await killableCanonicalRaw(
        batchWorktreePath, [...identityArgs, "commit", "--amend", "-m", amendedMessage],
        timeoutMs, "git commit --amend (batch land, pathset)", deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled, repoPath,
      );
    } catch (e) {
      // @decision bde5d1fe — already quarantined at the re-check (nothing spawned, so no HEAD recovery to
      // attempt) — refuse directly, never re-raise.
      if (e instanceof RepoQuarantinedError) {
        return { ok: false, quarantined: true, reason: `${branch}: Loom-Worker-Base/PathSet amend for ${sha.slice(0, 7)} refused — canonical repo is quarantined: ${e.message}` };
      }
      // An unverified amend can still be alive, able to rewrite HEAD again later — never warn-and-continue
      // with an unverified sha, and never let the NEXT candidate's cherry-pick race it. Checked BEFORE the
      // HEAD-based recovery read below, which assumes the child is done mutating.
      //
      // @decision 24c0bdba (round 4, m-a) — fail CLOSED + QUARANTINE, same as every other mutating call.
      if (treeDeathUnconfirmed(e)) {
        raisedToken = enterMergeQuarantine(repoPath, branch, unconfirmedKillReason(`Loom-Worker-Base/PathSet amend for ${sha.slice(0, 7)} could not be confirmed dead after a kill`));
        return { ok: false, quarantined: true, reason: `${branch}: Loom-Worker-Base/PathSet amend for ${sha.slice(0, 7)}'s git process tree could not be confirmed dead after a kill — refusing further cleanup to avoid racing it; the batch worktree may need manual inspection: ${(e as Error).message}` };
      }
      // m2 (Code Review, card 24c0bdba): a hung post-commit hook can outlive this amend's own timeout
      // AFTER the ref already moved (mirroring mergeBranchLocked's own solo-path recovery) — re-verify
      // via HEAD rather than assuming a reported failure means the trailers never landed.
      let amendLanded = false;
      try {
        const headAfterAmendFailure = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (batch land, post-amend-failure verify)")).trim();
        if (headAfterAmendFailure !== currentHead) {
          const [expectedParent, actualParent, body] = await Promise.all([
            withTimeout(git.raw(["rev-parse", `${currentHead}^`]), timeoutMs, "git rev-parse (batch land, post-amend-failure verify parent)"),
            withTimeout(git.raw(["rev-parse", `${headAfterAmendFailure}^`]), timeoutMs, "git rev-parse (batch land, post-amend-failure verify parent)"),
            withTimeout(git.raw(["log", "-1", "--format=%B", headAfterAmendFailure]), timeoutMs, "git log -1 (batch land, post-amend-failure verify)"),
          ]);
          amendLanded = expectedParent.trim() === actualParent.trim() && parseLoomTrailerBlock(body)?.branch === branch;
          if (amendLanded) currentHead = headAfterAmendFailure;
        }
      } catch { /* unknown — treat as not landed, same as before */ }
      if (!amendLanded) {
        pathSetStamped = false;
        // eslint-disable-next-line no-console
        console.warn(`[git] landBranchCommitsIndividually: Loom-Worker-Base/PathSet capture failed for ${branch} — ` +
          `commit lands without either trailer: ${(e as Error).message}`);
      }
    }
  }

  if (strippedTrailerCount > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[git] landBranchCommitsIndividually: stripped a Claude-Session: trailer from ${strippedTrailerCount} ` +
      `of ${branch}'s own commit(s) before landing — this project's mainline commits don't carry harness attribution`);
  }

  try {
    const landedSha = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (batch land, post-commit)")).trim();
    const landedSubject = (await withTimeout(git.raw(["log", "-1", "--format=%s"]), timeoutMs, "git log -1 subject (batch land)")).trim();
    return { ok: true, sha: landedSha, subject: landedSubject, strippedTrailerCount, pathSetStamped, branchTip };
  } catch (e) {
    return { ok: false, reason: `${branch}: landed but failed to read the result: ${(e as Error).message}` };
  }
}

/**
 * Earliest author date (epoch ms) among ONE candidate branch's own commits — the range that would land,
 * `merge-base(baseSha, branch)..branch` — used ONLY to ORDER branches for landing (card 4763432b). Never
 * used to reorder commits WITHIN a branch; see this file's header doc's "HONEST LIMIT" and
 * {@link sortCandidatesByEarliestAuthorDate}'s own doc for why a sort here can only ever be "branches land
 * oldest-first", never "commits are chronological".
 *
 * Returns `undefined` when the branch's own landing range can't be resolved (an unresolvable branch ref,
 * or nothing new to land — `mergeBase === branchTip`, the same noop condition
 * {@link landBranchCommitsIndividually} checks independently). A candidate in that state is about to be
 * dropped or classified as a noop by the real landing pass for the identical reason, so its sort position
 * is immaterial — the caller sorts it to the END rather than guessing at a date that doesn't exist.
 */
async function earliestAuthorDateMs(
  git: Pick<SimpleGit, "raw">, baseSha: string, branch: string, timeoutMs: number,
): Promise<number | undefined> {
  let branchTip: string;
  try {
    branchTip = (await withTimeout(
      git.raw(["rev-parse", "--verify", `${branch}^{commit}`]), timeoutMs, "git rev-parse branch (batch sort)",
    )).trim();
  } catch {
    return undefined;
  }
  let mergeBase: string;
  try {
    mergeBase = (await withTimeout(
      git.raw(["merge-base", baseSha, branchTip]), timeoutMs, "git merge-base (batch sort)",
    )).trim();
  } catch {
    return undefined;
  }
  if (mergeBase === branchTip) return undefined; // nothing new to land — sort position is immaterial
  let out: string;
  try {
    out = await withTimeout(
      git.raw(["log", `${mergeBase}..${branchTip}`, "--format=%aI"]), timeoutMs, "git log (batch sort, author dates)",
    );
  } catch {
    return undefined;
  }
  const dates = out.split("\n").map((s) => s.trim()).filter(Boolean).map((s) => Date.parse(s)).filter((n) => !Number.isNaN(n));
  return dates.length > 0 ? Math.min(...dates) : undefined;
}

/**
 * Sort `candidates` by each branch's own {@link earliestAuthorDateMs} (ascending — oldest work first),
 * against `baseSha` (the batch worktree's HEAD BEFORE any candidate has landed — always the un-mutated
 * starting point, never re-derived per candidate, so every branch's earliest-date is measured against the
 * SAME reference regardless of where it ends up in the sorted order). A candidate whose date can't be
 * resolved (see {@link earliestAuthorDateMs}) sorts LAST; ties (including two unresolved candidates) keep
 * their ORIGINAL relative order via an explicit index tie-break (never relying on `Array.prototype.sort`'s
 * stability alone to document that guarantee at the call site).
 *
 * ⚠️ **Card 4763432b's own "HONEST LIMIT":** this guarantees "branches land oldest-first", NEVER "commits
 * are chronological" — branches are worked in parallel, so two branches' own author-date RANGES can
 * overlap, and keeping each branch's commits contiguous (a hard invariant this function's caller relies
 * on — see this file's header doc) makes strict global chronological ordering impossible whenever they do.
 */
async function sortCandidatesByEarliestAuthorDate(
  git: Pick<SimpleGit, "raw">, baseSha: string, candidates: BatchCandidate[], timeoutMs: number,
): Promise<BatchCandidate[]> {
  const dated: Array<{ candidate: BatchCandidate; dateMs: number; index: number }> = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    const dateMs = (await earliestAuthorDateMs(git, baseSha, candidate.branch, timeoutMs)) ?? Number.POSITIVE_INFINITY;
    dated.push({ candidate, dateMs, index });
  }
  dated.sort((a, b) => (a.dateMs !== b.dateMs ? a.dateMs - b.dateMs : a.index - b.index));
  return dated.map((d) => d.candidate);
}

/**
 * Land each candidate branch's OWN commits, individually, onto `batchWorktreePath`, IN ORDER — each
 * branch's commits land on top of the previous branch's, so a later candidate's diff is computed against a
 * tree that already contains every earlier LANDED candidate's content (this is what makes the batch's
 * single gate a real test of the combined tree, not an approximation of it). See
 * {@link landBranchCommitsIndividually} for the per-branch mechanism (cherry-pick, not squash — card
 * 6801c0a1) and this file's own header doc for why.
 *
 * @decision 4763432b — landing order is `candidates` sorted oldest-author-date-first (see
 * {@link sortCandidatesByEarliestAuthorDate}), never caller-supplied order; branches never reorder their
 * own commits, and ties break on original index, never assumed `Array.prototype.sort` stability alone.
 *
 * A candidate that won't land cleanly (a real conflict on any of its own commits against an earlier
 * candidate in this same batch, or any other cherry-pick/commit failure) is DROPPED — recorded with its
 * reason and the loop continues with the rest. This never throws and never aborts the batch: assembly
 * failure is a per-branch outcome, not a batch-wide one (owner directive — "drop, don't fail", see this
 * file's own header doc).
 */
export async function assembleBatchBranches(
  repoPath: string, batchWorktreePath: string, candidates: BatchCandidate[], deps: BatchGitDeps = {},
): Promise<BatchAssembleResult> {
  const landed: BatchLandedBranch[] = [];
  const dropped: BatchDroppedBranch[] = [];
  const { git: sortGit, timeoutMs: sortTimeoutMs } = boundedGit(batchWorktreePath, deps);
  let initialHead: string | undefined;
  try {
    initialHead = (await withTimeout(
      sortGit.raw(["rev-parse", "HEAD"]), sortTimeoutMs, "git rev-parse HEAD (batch sort, initial)",
    )).trim();
  } catch {
    initialHead = undefined; // extremely unlikely (the worktree was just cut) — fall back to caller order below
  }
  const orderedCandidates = initialHead
    ? await sortCandidatesByEarliestAuthorDate(sortGit, initialHead, candidates, sortTimeoutMs)
    : candidates;
  for (const cWithTip of orderedCandidates) {
    const { tip: pinnedTip, ...c } = cWithTip;
    const r = await landBranchCommitsIndividually(repoPath, batchWorktreePath, c.branch, deps, pinnedTip);
    if (!r.ok) {
      dropped.push({ ...c, reason: r.reason ?? "batch land failed", conflict: !!r.conflict });
      // A quarantining candidate STOPS assembly outright, never just a per-candidate drop: an unconfirmed
      // tree-kill means the canonical repo itself may still be under mutation, so nothing already landed
      // in this batch worktree can be trusted to gate/ff safely, and no FURTHER candidate should be
      // attempted against it either.
      //
      // @decision 24c0bdba (round 4)
      if (r.quarantined) return { landed, dropped, quarantined: true };
      continue;
    }
    if (r.noop) {
      if (r.emptyKind === "ALREADY_MERGED" && r.sha) {
        landed.push({ ...c, sha: r.sha, subject: r.subject ?? (c.taskTitle ?? c.branch), noop: true, assembledTip: r.branchTip });
      } else {
        // STAGE_EMPTY_RETRY (or an ALREADY_MERGED with no resolvable sha) — genuinely nothing this batch
        // can prove either way; let the individual fallback path (today's confirmWorkerMerge, which has
        // its own idempotency handling for this exact classification) sort it out rather than guessing here.
        dropped.push({ ...c, reason: `empty diff (${r.emptyKind ?? "unknown"}) — nothing to land` });
      }
      continue;
    }
    if (!r.sha || !r.subject) {
      dropped.push({ ...c, reason: "batch land reported ok with no sha/subject" });
      continue;
    }
    landed.push({ ...c, sha: r.sha, subject: r.subject, strippedTrailerCount: r.strippedTrailerCount, pathSetStamped: r.pathSetStamped, assembledTip: r.branchTip });
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
  /** TYPED (round 4) — true iff refused because the canonical repo is QUARANTINED. Distinct from every
   *  other refusal here: the caller must NOT treat this as an ordinary "fall back to per-branch re-gate"
   *  outcome (that would be a further canonical-mutating attempt against a quarantined repo) — abort and
   *  leave the batch worktree for a human, exactly like an assembly-time quarantine. */
  quarantined?: boolean;
  /** Card b801bad0 — true iff refused because the canonical checkout is not on the expected mainline
   *  branch, either BEFORE the fast-forward (a checkout diverted the repo while this batch's gate was
   *  running) or AFTER it (the `--ff-only` landed, but not on the branch this batch believes it advanced) —
   *  only set when the caller passed `expectedBaseBranch` (see {@link BatchGitDeps}). Distinct from
   *  `forfeited`: the sha-forfeit check alone cannot see a same-commit branch divert. */
  branchDiverted?: boolean;
  /** Card b801bad0 (fix round, Code Review MINOR 2) — true iff the POST-ff RE-READ itself could not be
   *  completed (e.g. a transient timeout) after an apparently-successful `--ff-only`. Distinct from a
   *  CONFIRMED `branchDiverted`: a failed re-read proves nothing either way — the `--ff-only` call itself
   *  did not throw, so the landing most likely DID happen, it just could not be verified. The caller must
   *  treat this like `branchDiverted` for the purpose of NOT running a per-candidate fallback (a fallback
   *  squash risks a second, divergent landing on top of content that's probably already on main), but
   *  should record and surface it as a DISTINCT, less alarming outcome — a human can confirm with a plain
   *  `git log` rather than treating it as a confirmed security-relevant divert. */
  unverified?: boolean;
  /** Card b801bad0 (fix round) — the branch canonical was actually found checked out on when a
   *  `branchDiverted` outcome was detected (pre- or post-ff); `null` when detached. Absent (never) on
   *  `unverified`, since that outcome is specifically the case where this could not be read. Lets the
   *  caller's durable event/typed field name both sides of the divert without re-parsing `reason` text. */
  observedBranch?: string | null;
}

/**
 * Advance canonical main to `targetSha` — but ONLY if canonical HEAD is still exactly `expectedBaseSha`,
 * the sha the batch worktree was cut from. This is the forfeit check (card dbc6f660 DoD-5): if main
 * advanced while the batch's single gate was running, that gate never validated main's real current tree,
 * so this refuses rather than fast-forwarding past unverified state. Canonical repo is left COMPLETELY
 * untouched on every refusal path — the caller falls back to gating every originally-batched branch
 * individually (today's behavior), exactly as if batching had never been attempted.
 *
 * The forfeit-check read + the `--ff-only` merge both run INSIDE `withCanonicalIndexLock` (round 6,
 * BLOCKER 1 — this call used to take no lock at all): a genuinely independent entry point from
 * `runBatchedMerge`'s own quarantine check — the gate this function's caller runs between assembly and
 * this call can take many minutes, long enough for a quarantine to be raised by an entirely separate op in
 * the meantime — and the lock's own quarantine check now covers that case for free, so this function no
 * longer re-derives its own copy.
 */
export async function fastForwardCanonicalMain(
  repoPath: string, expectedBaseSha: string, targetSha: string, deps: BatchGitDeps = {},
): Promise<FastForwardResult> {
  // @decision 87a3c87e — same vault-auto-commit pause bracket as the solo squash path (mergeBranch,
  // git/worktrees.ts); resume stays in `finally` so a throw never leaves the lease held.
  const pauseToken = pauseVaultAutoCommit(repoPath);
  try {
    return await withCanonicalIndexLock(repoPath, async () => {
      const { git, timeoutMs } = boundedGit(repoPath, deps);
      // @decision b801bad0 — ONE spawn for BOTH the forfeit sha-check and (when pinned) the branch divert
      // pre-check: `readHeadShaAndBranch` (git/mainline-watch.ts), not two separate rev-parse/symbolic-ref
      // calls — see that function's own doc for the exact invocation and why flag order matters here.
      const entry = await readHeadShaAndBranch(git, timeoutMs, "git rev-parse HEAD + symbolic-full-name HEAD (canonical, batch fast-forward check)");
      if (!entry) return { ok: false, reason: "failed to read canonical HEAD (and checked-out branch)" };
      const currentMainSha = entry.sha;
      if (currentMainSha !== expectedBaseSha) {
        return {
          ok: false, forfeited: true, currentMainSha,
          reason: `canonical main advanced (now ${currentMainSha}) since this batch was cut from ${expectedBaseSha} — this batch's gate never validated main's current tree; falling back to a per-branch re-gate`,
        };
      }
      // Pin the checked-out BRANCH too, not just the sha: a same-commit checkout divert (e.g.
      // GitWriter.createBranch()) defeats the sha-only forfeit check above. Optional: a caller passing no
      // `expectedBaseBranch` keeps today's sha-only behavior.
      if (deps.expectedBaseBranch !== undefined && entry.branch !== deps.expectedBaseBranch) {
        return {
          ok: false, branchDiverted: true, observedBranch: entry.branch,
          // Card b801bad0 (fix round 3) — NEVER "falling back to a per-branch re-gate" here: unlike an
          // ordinary forfeit (above), a branchDiverted refusal runs NO per-candidate fallback at all (the
          // solo path pins only a sha, never a branch, and would risk landing onto this same stray branch)
          // — see the caller's own `result.branchDiverted` handling, sessions/service.ts.
          reason: `canonical repo is checked out on "${entry.branch ?? "(detached)"}", not the expected mainline branch "${deps.expectedBaseBranch}" — something diverted the checkout since this batch was cut`,
        };
      }
      if (targetSha === expectedBaseSha) return { ok: true }; // nothing landed on top — no-op fast-forward
      // @decision bde5d1fe (item 2) — kill-confirmed, same helper + quarantine treatment as the solo
      // squash commit (mergeBranchLocked): a bare withTimeout here abandoned an orphaned ff-only/post-merge
      // hook child on timeout, exactly the race 24c0bdba closed everywhere else on this path.
      let raisedToken: string | undefined;
      const onTreeDeathSettled = (confirmed: boolean): void => {
        if (confirmed && raisedToken) clearMergeQuarantineByToken(repoPath, raisedToken);
      };
      // @decision b801bad0 — verify the LANDED RESULT after an apparently-successful ff-only (ONE spawn,
      // same helper as above); refuse on a mismatch rather than report ok:true. Gated ENTIRELY on
      // `expectedBaseBranch` — unset pays nothing extra here, mirroring `expectedBranchTip`'s contract.
      const verifyLanded = async (): Promise<FastForwardResult> => {
        if (deps.expectedBaseBranch === undefined) return { ok: true };
        const post = await readHeadShaAndBranch(git, timeoutMs, "git rev-parse HEAD + symbolic-full-name HEAD (canonical, post-ff verify)");
        // Card b801bad0 (fix round, Code Review MINOR 2) — a failed RE-READ is NOT a confirmed divert: the
        // `--ff-only` call above did not throw, so the landing most likely happened and this is only a
        // verification failure. Typed distinctly (`unverified`, never `branchDiverted`) so the caller can
        // treat it as "probably landed, could not confirm" rather than a security-relevant divert.
        if (!post) return { ok: false, unverified: true, reason: "fast-forward appeared to succeed but canonical HEAD (and checked-out branch) could not be re-read to verify — the landing likely happened but could not be confirmed" };
        if (post.sha !== targetSha) {
          return { ok: false, branchDiverted: true, observedBranch: post.branch, reason: `fast-forward appeared to succeed but canonical HEAD reads ${post.sha}, not the expected ${targetSha} — refusing to report success` };
        }
        if (post.branch !== deps.expectedBaseBranch) {
          return { ok: false, branchDiverted: true, observedBranch: post.branch, reason: `fast-forward landed on "${post.branch ?? "(detached)"}", not the expected mainline branch "${deps.expectedBaseBranch}" — refusing to report success` };
        }
        return { ok: true };
      };
      try {
        await killableCanonicalRaw(
          repoPath, ["merge", "--ff-only", targetSha], timeoutMs, "git merge --ff-only (canonical, batch fast-forward)",
          deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled,
        );
      } catch (e) {
        if (e instanceof RepoQuarantinedError) return { ok: false, quarantined: true, reason: `fast-forward refused — canonical repo is quarantined: ${e.message}` };
        if (treeDeathUnconfirmed(e)) {
          raisedToken = enterMergeQuarantine(repoPath, "(batch fast-forward)", unconfirmedKillReason("fast-forward merge could not be confirmed dead after a kill"));
          // @decision d8bb2074 — no HEAD re-read here (an unconfirmed kill means "touch nothing else");
          // name the already-known target sha so a reader knows main may already be there, not just stalled.
          return { ok: false, quarantined: true, reason: `fast-forward merge's git process tree could not be confirmed dead after a kill — refusing further cleanup to avoid racing it (canonical main may already be at ${targetSha} if the merge itself landed before the kill); canonical repo may need manual inspection: ${(e as Error).message}` };
        }
        // A hung post-merge hook can outlive the timeout AFTER HEAD already moved — re-verify before
        // reporting a false failure (mirrors mergeBranchLocked's own post-commit-failure HEAD re-read).
        let headAfterFailure: string | undefined;
        try {
          headAfterFailure = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (canonical, post-ff-failure verify)")).trim();
        } catch { /* unknown — fall through to the ordinary failure below */ }
        if (headAfterFailure === targetSha) return await verifyLanded();
        return { ok: false, reason: `fast-forward failed: ${(e as Error).message}` };
      }
      return await verifyLanded();
    });
  } catch (e) {
    if (e instanceof RepoQuarantinedError) return { ok: false, quarantined: true, reason: e.message };
    throw e;
  } finally {
    resumeVaultAutoCommit(repoPath, pauseToken);
  }
}

/** What the caller's gate callback reports back for the ONE batch gate run — the batching orchestrator
 *  itself is gate-mechanism-agnostic (it never spawns a process or touches GateSemaphore directly), so any
 *  real integration wires `runGate` to whatever this daemon already uses for a real gate run. */
export interface BatchGateResult {
  passed: boolean;
  /** @decision 13571c71 — the batch was withdrawn while queued; no gate ran, so this is never a verdict (`passed:false` alone would read as a red). */
  cancelled?: boolean;
  /** @decision d422e279 — this field's earlier doc asserted a RETRACTED measured claim about how often a
   *  batch's union is reducible. The field itself is RECORD-ONLY: nothing reads it back — `gate_history`
   *  is populated independently, from the same local variables the caller's `runGate` closure computes. */
  emitCompareReduced?: boolean;
  /** Card d422e279: present ONLY when `emitCompareReduced` is `true` — the SAME surfacing obligation
   *  `EmitCompareGateResult`'s own doc (git/worktrees.ts) mandates for a solo reduced merge
   *  (notHermeticExcluded/inertPathsSkipped/changedAssetPaths/isolation caveat), worded for a batch: this
   *  green is a claim about EVERY branch the batch landed, not just one, so the isolation caveat (card
   *  cf4aa7d1 — files run via `test:daemon --only=`, never exercising the rest of the suite around them)
   *  covers the whole landed set at once, not a single branch. The caller threads this onto
   *  `MergeBatchResult.reducedGateWarning`, mirroring how `retryWarning` is already threaded from this
   *  same interface. */
  reducedGateWarning?: string;
  reason?: string;
  detail?: Record<string, unknown>;
  /** Card 67030bb9: whether this batch's gate retried a small set of files in isolation before reaching
   *  `passed` (a comma-joined name list for N>1, a bare name for N=1 — see gate-runner.ts's
   *  `identifyRetriableTestFiles`), and whether that retry itself passed. `undefined` on the overwhelming
   *  majority of batches (no such retry ever fired) — this orchestrator never reads either field itself
   *  (still gate-mechanism-agnostic, per this interface's own header doc); they exist purely so the
   *  caller's OWN post-`runBatchedMerge` handling (sessions/service.ts's `mergeBatch`) can render a
   *  weaker-pass note naming the batch's branch count, which matters more here than on a solo merge: a
   *  green batch retry lands EVERY branch in the batch on the strength of one isolated re-run. */
  retriedFile?: string;
  retryPassed?: boolean;
  /** Card 67030bb9: attempt 1's own output tail — lets the caller's weaker-pass wording distinguish a
   *  timeout-kill retry from a genuine-assertion retry (see `formatWeakerPassWarning`'s own
   *  `isTimeoutKillEntry` check), the same distinction the solo path already makes. CORRECTED (Code
   *  Review round 2, minor #2): an earlier version of this doc claimed `undefined` whenever `retriedFile`
   *  is — false; the real producer (sessions/service.ts's own `runGate` closure) sets this UNCONDITIONALLY
   *  from the SAME gate run's own result, outside the `retriedFile`-gated spread, so it is present on
   *  every genuinely-ran gate regardless of whether a retry fired. Only ever consumed (via
   *  `isTimeoutKillEntry`) when `retriedFile` is ALSO truthy — a caller reading this alongside a null
   *  `retriedFile` simply has nothing to do with it, not evidence of a missing value. */
  outputTail?: string;
}

export interface RunBatchedMergeResult {
  ok: boolean;
  landed: BatchLandedBranch[];
  dropped: BatchDroppedBranch[];
  baseMainSha: string;
  batchHeadSha?: string;
  gatePassed?: boolean;
  gateFailed?: boolean;
  /** @decision 13571c71 — mirrors `BatchGateResult.cancelled`; never also `gateFailed`. */
  cancelled?: boolean;
  forfeited?: boolean;
  /** Card b801bad0 — mirrors {@link FastForwardResult.branchDiverted}: the fast-forward refused because the
   *  canonical checkout was not on the expected mainline branch, either before or after the `--ff-only`. */
  branchDiverted?: boolean;
  /** Card b801bad0 (fix round) — mirrors {@link FastForwardResult.unverified}: the POST-ff re-read itself
   *  failed, so the landing's actual outcome is unknown — distinct from a confirmed `branchDiverted`. */
  unverified?: boolean;
  /** Card b801bad0 (fix round) — mirrors {@link FastForwardResult.observedBranch}: the branch canonical was
   *  actually found checked out on when `branchDiverted` fired. Absent on `unverified` (that outcome is
   *  specifically the case where this could not be read). */
  observedBranch?: string | null;
  reason?: string;
  gateDetail?: BatchGateResult;
  /** Set iff `forfeited` is true — the canonical HEAD `fastForwardCanonicalMain` observed instead of
   *  `baseMainSha` (card 456f63a4: this was computed by `fastForwardCanonicalMain` but previously
   *  dropped here instead of reaching the caller). */
  currentMainSha?: string;
  /** Card 6cc803b2 — phase instrumentation: wall time of the {@link assembleBatchBranches} call above
   *  (cherry-picking every candidate's own commit range onto the batch tip), ALWAYS present once that
   *  call returns — set regardless of outcome (including the `landed.length === 0` early return), since
   *  assembly genuinely ran either way. This is the ONE phase this instrumentation card measures that
   *  predates gate admission entirely — `mergeBatch`'s own `build_gate` event (sessions/service.ts) only
   *  ever fires once a gate is actually invoked, which never happens on a nothing-landed batch. */
  assemblyMs?: number;
  /** Card 6cc803b2 — phase instrumentation: wall time of the {@link fastForwardCanonicalMain} call below,
   *  present iff that call was actually attempted (a green gate on a non-empty landed set) — `undefined`
   *  on every earlier return (nothing landed, or a rejected/errored gate), where fast-forward is never
   *  reached at all. Covers the forfeit-check read+compare AND, when not forfeited, the `--ff-only`
   *  merge itself — both happen inside the ONE `fastForwardCanonicalMain` call this times, so there is no
   *  finer split between "checking" and "advancing" to report. */
  fastForwardMs?: number;
  /** TYPED (round 4, Code Review b2ebf41f) — true iff this result is a QUARANTINE abort: the canonical
   *  repo was already quarantined at entry, a candidate's own landing quarantined it mid-assembly, or
   *  `fastForwardCanonicalMain` found it quarantined. The caller (`mergeBatchTracked`, sessions/service.ts)
   *  MUST treat this as distinct from every other failure: no per-candidate fallback confirm, and no
   *  batch-worktree removal — leave it for a human. Never inferred from `reason` text. */
  quarantined?: boolean;
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
 * env (card dbc6f660's `LOOM_GATE_BATCH_SIZE`) reports what the gate genuinely covered. Its FOURTH argument
 * (card 6cc803b2) is the wall time {@link assembleBatchBranches} just took, handed through so the caller's
 * own gate-settle audit event (which fires before this function knows anything about fast-forward — see
 * `RunBatchedMergeResult.fastForwardMs`'s own doc) can report the assembly phase on the SAME event.
 */
export async function runBatchedMerge(
  repoPath: string, batchWorktreePath: string, baseMainSha: string, candidates: BatchCandidate[],
  runGate: (worktreePath: string, baseMainSha: string, landedCount: number, assemblyMs: number) => Promise<BatchGateResult>,
  deps: BatchGitDeps = {},
): Promise<RunBatchedMergeResult> {
  // QUARANTINE CHECK (round 4, convergence point) — before assembly even starts, so a repo already
  // quarantined by an unrelated op never burns worktree/assembly work, let alone a shared gate slot.
  const quarantineCheck = assertRepoNotQuarantined(repoPath);
  if (!quarantineCheck.ok) {
    return { ok: false, landed: [], dropped: [], baseMainSha, quarantined: true, reason: quarantineCheck.reason };
  }
  const assembleStartMs = Date.now();
  const { landed, dropped, quarantined } = await assembleBatchBranches(repoPath, batchWorktreePath, candidates, deps);
  const assemblyMs = Date.now() - assembleStartMs;
  // A candidate quarantining the repo mid-assembly ABORTS THE WHOLE BATCH (round 4, ruling 1c): no gate,
  // no fast-forward, no per-candidate fallback — the caller must also skip worktree removal on this flag.
  if (quarantined) {
    return { ok: false, landed, dropped, baseMainSha, assemblyMs, quarantined: true, reason: "a candidate's own unconfirmed tree-kill quarantined the canonical repo mid-assembly — aborting the whole batch" };
  }
  if (landed.length === 0) {
    return { ok: false, landed, dropped, baseMainSha, assemblyMs, reason: "nothing landed cleanly into the batch — every candidate was dropped" };
  }
  const gate = await runGate(batchWorktreePath, baseMainSha, landed.length, assemblyMs);
  if (!gate.passed) {
    return { ok: false, landed, dropped, baseMainSha, assemblyMs, gatePassed: false, gateFailed: isMergeGateRed(gate), ...(gate.cancelled ? { cancelled: true } : {}), gateDetail: gate, reason: gate.reason ?? "batch gate failed" };
  }
  const { git, timeoutMs } = boundedGit(batchWorktreePath, deps);
  let batchHeadSha: string;
  try {
    batchHeadSha = (await withTimeout(
      git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (batch worktree, post-gate)",
    )).trim();
  } catch (e) {
    return { ok: false, landed, dropped, baseMainSha, assemblyMs, gatePassed: true, gateDetail: gate, reason: `failed to read batch worktree HEAD after a green gate: ${(e as Error).message}` };
  }
  const ffStartMs = Date.now();
  const ff = await fastForwardCanonicalMain(repoPath, baseMainSha, batchHeadSha, deps);
  const fastForwardMs = Date.now() - ffStartMs;
  if (!ff.ok) {
    return {
      ok: false, landed, dropped, baseMainSha, batchHeadSha, assemblyMs, fastForwardMs, gatePassed: true, gateDetail: gate,
      forfeited: !!ff.forfeited, reason: ff.reason, currentMainSha: ff.currentMainSha,
      ...(ff.quarantined ? { quarantined: true } : {}), ...(ff.branchDiverted ? { branchDiverted: true } : {}),
      ...(ff.unverified ? { unverified: true } : {}), ...(ff.observedBranch !== undefined ? { observedBranch: ff.observedBranch } : {}),
    };
  }
  return { ok: true, landed, dropped, baseMainSha, batchHeadSha, assemblyMs, fastForwardMs, gatePassed: true, gateDetail: gate };
}
