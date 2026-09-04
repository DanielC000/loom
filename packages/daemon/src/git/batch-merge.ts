import type { SimpleGit } from "simple-git";
import { withTimeout, boundedSimpleGit } from "./bounded.js";
import { findLandedSquashCommit, changedPathSetDigest, type MergeEmptyKind } from "./worktrees.js";
import { nonInteractiveEnv, stripClaudeSessionTrailer } from "./writer.js";

/**
 * Card dbc6f660 — batch the merge gate: gate K ready branches ONCE, land each on main.
 *
 * OWNER-SPECIFIED DESIGN (see the task card + `.loom/research/batched-merge-gate-feasibility-2026-09-03.md`
 * for the full study): cut a dedicated batch worktree `B` from canonical main's current tip, land each
 * ready branch into `B` in turn, gate `B` ONCE, and on green fast-forward canonical main to `B`'s tip.
 * Canonical main is mutated exactly once, at that fast-forward.
 *
 * 🔴 CARD 6801c0a1 CORRECTION — READ BEFORE TOUCHING THIS FILE: the ORIGINAL shape shipped here (`b577f43`)
 * squash-merged each candidate via {@link mergeBranch} (reused unchanged), landing ONE commit per branch —
 * byte-shape-identical to a solo `worker_merge_confirm`. That was the WRONG commit shape: the owner
 * explicitly asked (verbatim, twice, on card 6801c0a1) for a BATCHED landing to preserve each branch's own
 * commits INDIVIDUALLY on main, squashing away only the MERGE commits (there are none here to begin with —
 * this file never creates one). **Solo `worker_merge_confirm` is UNCHANGED and still squashes** — that
 * behavior is explicitly kept; only the BATCHED path (this file) changed.
 *
 * `assembleBatchBranches` now REBASES (cherry-picks) each candidate's own commit range
 * (`merge-base(batchTip, branch)..branch`) onto the batch tip, ONE COMMIT AT A TIME, in original order —
 * so a branch contributing 3 commits lands 3 commits on main, not 1. No merge commits are ever created
 * (cherry-pick never does). This module deliberately does NOT reuse {@link mergeBranch} (`git merge
 * --squash`) any more for this path — that primitive is fundamentally the wrong shape (it collapses N
 * commits to 1 by construction) and stays reserved for the solo path, untouched.
 *
 * TRAILER PLACEMENT (the card's "real open question"): once a branch contributes N commits instead of 1,
 * "which commit carries `Loom-Worker-Branch`" is no longer answered for free — `scanMergedCommitMap`
 * (`git/worktrees.ts`, off-limits to modify without escalating — see the card) maps branch -> ONE commit
 * via a single-match `git log --grep` scan. **Chosen: (a) the trailer lands on the branch's LAST (tip)
 * commit ONLY, written AFTER that commit is cherry-picked (a rebase rewrites SHAs, so the trailer can only
 * be attached to the commit's FINAL sha, not inherited from the original).** This preserves the existing
 * one-branch-one-trailer invariant `scanMergedCommitMap`/`findLandedSquashCommit` already depend on —
 * zero changes needed to either reader. The non-tip commits from a batched branch carry NO
 * `Loom-Worker-Branch` trailer at all (exactly like any of a repo's other ordinary, non-landing commits) —
 * this is intentional, not a gap: a single trailer per branch is exactly what every existing reader
 * expects, and a branch's ship-state has always been "found via ITS trailer commit", never "every commit
 * this branch happens to touch".
 *
 * ⭐ **`Loom-Worker-PathSet` + `Loom-Worker-Base` are now stamped on EVERY batched branch's tip, regardless
 * of commit count** (card d62dad73 phase 2 — SUBSUMES phase 1's single-commit-only special case, which
 * existed only as a stopgap and has been folded away; see git history for that narrower version if needed).
 * `Loom-Worker-Base: <batchHeadBefore>` records the batch tip as it stood immediately before this branch's
 * OWN cherry-picks began — a real, already-existing commit reachable from HEAD forever once the batch
 * fast-forwards canonical main (a fast-forward never rewrites history, so this ancestry relationship is
 * permanent). `Loom-Worker-PathSet` is the digest of `batchHeadBefore..landedSha` — the branch's ACTUAL
 * landed contribution (ALL of its commits, not just the last one). `verifyPersistedPathSet`
 * (`git/worktrees.ts`) prefers this trailer's base over its default `sha^` fallback, so a multi-commit
 * contribution — where `sha^` would only span the tip's own last commit, not the whole branch — verifies
 * correctly instead of lying. See {@link landBranchCommitsIndividually}'s own implementation: the tip
 * commit lands WITHOUT either trailer first (so its real sha exists), the digest is computed via {@link
 * changedPathSetDigest} against that real sha and `batchHeadBefore`, then BOTH trailers are added via
 * `git commit --amend` (which preserves the original author/date by default — verified empirically, not
 * assumed).
 *
 * 🔴 **WHY THE DIGEST IS COMPUTED FROM THE LANDED RANGE, NOT THE ORIGINAL BRANCH'S OWN DIFF** (card
 * d62dad73's flagged untested assumption — investigated, and the naive alternative it warned against is
 * REAL): a cherry-picked commit's touched-path-set CAN genuinely differ from the same commit's diff on its
 * original branch, with NO conflict at all — reproduced with a clean (`cherry-pick` exit 0, no merge
 * markers) rename on the receiving side: main renames a file the branch also edits ({@code git mv
 * shared.txt shared-renamed.txt}), then a cherry-pick of the branch's edit to `shared.txt` lands cleanly as
 * an edit to `shared-renamed.txt` (git's rename-following 3-way merge). The ORIGINAL branch's own
 * `mergeBase..branchTip` diff says `shared.txt`; the LANDED `batchHeadBefore..landedSha` diff says
 * `shared-renamed.txt` — genuinely different digests for the identical logical change, and this is NOT a
 * conflict the batch's own drop-wholesale policy would ever catch. Computing the trailer from the branch's
 * pre-landing diff (the shape {@link mergeBranchLocked}'s own solo-path stamp USED to use, before card
 * 756a2cd8 fixed it the same way) would make the trailer LIE the moment {@link verifyPersistedPathSet}
 * later recomputes it from the commit's REAL ancestry (either
 * `sha^..sha` or, here, `Loom-Worker-Base..sha` — both are the LANDED range) — a false verification failure
 * (fails closed, so safe, but defeats the point). **This is a semantics point worth restating plainly:
 * `Loom-Worker-PathSet` describes WHAT LANDED on main, NOT what the branch originally touched on its own
 * fork — under rename-following, those two can legitimately differ with no conflict involved. A future
 * reader who diffs a branch's own history against this trailer and finds a mismatch is looking at expected
 * behavior, not a bug to "fix".** The fix that makes this safe: stamp the digest computed from
 * `batchHeadBefore..landedSha` — the branch's ACTUAL landed contribution, using two real, already-existing
 * commits in the batch's own history — which is trivially and unconditionally IDENTICAL to what {@link
 * verifyPersistedPathSet} will recompute later, by construction, regardless of any rename/auto-merge on the
 * receiving side. See `test/batch-merge.mjs` case (7e) for this exact scenario, kept as a permanent
 * regression guard: the landed-range digest verifies GREEN there in precisely the case where a pre-landing
 * digest would have gone red.
 *
 * ⚠️ A branch whose own commit range contains a MERGE commit (e.g. a stale-base auto-forward that unioned
 * main into the worker's worktree mid-work — `mergeMainIntoWorktree`) is DROPPED, not cherry-picked:
 * `git cherry-pick` refuses a merge commit outright without an explicit `-m <parent>` this generic landing
 * has no principled way to choose. Detected up front and dropped with a specific reason (see
 * {@link landBranchCommitsIndividually}) — safe, not a data-loss gap: the branch falls back to the
 * ordinary individual `worker_merge_confirm` path, which already handles this case via its own union step.
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

/** Same seam as {@link boundedGit}, PLUS `nonInteractiveEnv()` on the default factory — matching
 *  `git/worktrees.ts`'s own `boundedMergeGit` convention for a git WRITE (a cherry-pick's own commit step
 *  is exactly that class of call). `gitFactory`, when supplied (the test seam), is used as-is — mirrors
 *  `worktrees.ts`'s identical reasoning: a test injecting a fake doesn't need env scrubbing applied to it. */
function boundedMergeGit(repoPath: string, deps: BatchGitDeps): { git: Pick<SimpleGit, "raw">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const git = deps.gitFactory ? deps.gitFactory(repoPath, timeoutMs) : boundedSimpleGit(repoPath, timeoutMs, nonInteractiveEnv());
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
 * See the header doc's "WHY THE DIGEST IS COMPUTED FROM THE LANDED RANGE..." section for why the PathSet
 * base must be `batchHeadBefore` (this branch's own pre-cherry-pick batch tip), never the branch's own
 * pre-landing diff.
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
  batchWorktreePath: string, branch: string, deps: BatchGitDeps,
): Promise<LandResult> {
  const { git, timeoutMs } = boundedMergeGit(batchWorktreePath, deps);

  let branchTip: string;
  try {
    branchTip = (await withTimeout(
      git.raw(["rev-parse", "--verify", `${branch}^{commit}`]), timeoutMs, "git rev-parse branch (batch land)",
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
      ? { ok: true, noop: true, emptyKind: "ALREADY_MERGED", sha: landedSha }
      : { ok: true, noop: true, emptyKind: "STAGE_EMPTY_RETRY" };
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

  // A worker's own branch can carry a MERGE commit in this range — e.g. a stale-base auto-forward
  // (`mergeMainIntoWorktree`) that unioned main into the worker's worktree mid-work. `git cherry-pick`
  // refuses a merge commit outright (needs an explicit `-m <parent>`, which this generic per-branch
  // landing has no principled way to pick), so check for one UP FRONT and drop with a specific,
  // diagnosable reason rather than letting the loop below fail on a generic git error a few calls in —
  // same DROP outcome either way (safe: the branch falls back to the individual worker_merge_confirm
  // path, which handles this case natively), just a clearer, cheaper failure.
  let hasMergeCommit: boolean;
  try {
    hasMergeCommit = (await withTimeout(
      git.raw(["rev-list", "--merges", `${mergeBase}..${branchTip}`]), timeoutMs, "git rev-list --merges (batch land, merge-commit probe)",
    )).trim() !== "";
  } catch (e) {
    return { ok: false, reason: `${branch}: failed to probe for merge commits in range: ${(e as Error).message}` };
  }
  if (hasMergeCommit) {
    return { ok: false, reason: `${branch}: its own commit range contains a merge commit — individual-commit batch landing doesn't support that; falling back to individual gating` };
  }

  const identityArgs = (await hasConfiguredGitIdentity(git))
    ? []
    : ["-c", `user.name=${FALLBACK_GIT_IDENTITY.name}`, "-c", `user.email=${FALLBACK_GIT_IDENTITY.email}`];

  const rollback = async (): Promise<void> => {
    try { await withTimeout(git.raw(["cherry-pick", "--abort"]), timeoutMs, "git cherry-pick --abort (batch land)"); } catch { /* best-effort */ }
    try { await withTimeout(git.raw(["reset", "--hard", batchHeadBefore]), timeoutMs, "git reset --hard (batch land rollback)"); } catch { /* best-effort */ }
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
    // EVERY commit cherry-picks with `--no-commit` (never auto-commits) so its message passes through
    // `stripClaudeSessionTrailer` before the one manual `git commit` that lands it — see this function's
    // own doc for why that can't be limited to just the tip.
    try {
      await withTimeout(
        git.raw([...identityArgs, "cherry-pick", "--no-commit", sha]),
        timeoutMs, "git cherry-pick (batch land)",
      );
    } catch (e) {
      let conflicted = false;
      try {
        conflicted = (await withTimeout(git.raw(["ls-files", "--unmerged"]), timeoutMs, "git ls-files --unmerged (batch land)")).trim() !== "";
      } catch { /* treat as a non-conflict failure below */ }
      await rollback();
      return conflicted
        ? { ok: false, conflict: true, reason: `${branch}: conflict cherry-picking ${sha.slice(0, 7)} onto the batch` }
        : { ok: false, reason: `${branch}: cherry-pick of ${sha.slice(0, 7)} failed: ${(e as Error).message}` };
    }
    // Detect an ALREADY-PRESENT (redundant) commit's empty stage EXPLICITLY, before the manual commit
    // below (card 2eb78eb2) — `cherry-pick --no-commit` never errors when its patch is already fully
    // applied (see the FAIL-CLOSED comment further down); it just leaves the index unchanged. The
    // `mergeBase === branchTip` check above only catches a WHOLE branch already landed — it says nothing
    // about ONE redundant commit inside an otherwise-new multi-commit branch (e.g. two branches that
    // cherry-picked the same fix independently). Left undetected here, the manual `git commit` a few
    // lines down runs against a clean index and can itself fail on git's own "nothing to commit, working
    // tree clean" — a REAL git failure, not a Loom bug — landing in this function's generic commit-failure
    // branch below with an opaque "commit failed while landing commit <sha7>: …". The outcome (this branch
    // still drops, same fallback as always) doesn't change; only the diagnosability does — a manager reading
    // that opaque reason has no way to tell "redundant content" apart from an actual Loom defect. `git diff
    // --cached --name-only` (not `--quiet`) is used deliberately: `--quiet` signals "nothing staged" via its
    // EXIT CODE, which is indistinguishable at this call site from any other command failure once it reaches
    // simple-git's `.raw()` rejection path; `--name-only` always exits 0 and reports emptiness through its
    // OUTPUT instead, so detecting "nothing staged" here needs no exit-code guessing.
    let stagedPaths: string;
    try {
      stagedPaths = await withTimeout(
        git.raw(["diff", "--cached", "--name-only"]), timeoutMs, "git diff --cached --name-only (batch land, empty-stage probe)",
      );
    } catch (e) {
      await rollback();
      return { ok: false, reason: `${branch}: failed to probe staged changes after cherry-picking ${sha.slice(0, 7)}: ${(e as Error).message}` };
    }
    if (stagedPaths.trim() === "") {
      // DoD-2's deliberate choice (b): the CONSERVATIVE default. This does NOT skip just the redundant
      // commit and continue landing the rest of the branch — a commit silently skipped is a commit nobody
      // reviewed the absence of. The whole branch drops, exactly like every other failure in this loop,
      // with an honest reason instead of a misleading one.
      await rollback();
      return { ok: false, reason: `${branch}: cherry-pick of ${sha.slice(0, 7)} produced an empty commit — its content was already present in the batch tree; dropping this branch rather than risk amending an unrelated commit` };
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
      return { ok: false, reason: `${branch}: failed to read original commit metadata for ${sha.slice(0, 7)}: ${(e as Error).message}` };
    }
    const { message: cleanedMessage, stripped } = stripClaudeSessionTrailer(originalMessage);
    if (stripped) strippedTrailerCount++;
    const finalMessage = isLast ? `${cleanedMessage}\n\nLoom-Worker-Branch: ${branch}\n` : `${cleanedMessage}\n`;
    try {
      await withTimeout(
        git.raw([...identityArgs, "commit", "--author", `${authorName} <${authorEmail}>`, "--date", authorDate, "-m", finalMessage]),
        timeoutMs, "git commit (batch land)",
      );
    } catch (e) {
      await rollback();
      return { ok: false, reason: `${branch}: commit failed while landing commit ${sha.slice(0, 7)}: ${(e as Error).message}` };
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
      return { ok: false, reason: `${branch}: failed to verify commit landed for ${sha.slice(0, 7)}: ${(e as Error).message}` };
    }
    if (newHead === currentHead) {
      await rollback();
      return { ok: false, reason: `${branch}: cherry-pick of ${sha.slice(0, 7)} produced an empty commit — its content was already present in the batch tree; dropping this branch rather than risk amending an unrelated commit` };
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
      await withTimeout(
        git.raw([...identityArgs, "commit", "--amend", "-m", amendedMessage]),
        timeoutMs, "git commit --amend (batch land, pathset)",
      );
    } catch (e) {
      pathSetStamped = false;
      // eslint-disable-next-line no-console
      console.warn(`[git] landBranchCommitsIndividually: Loom-Worker-Base/PathSet capture failed for ${branch} — ` +
        `commit lands without either trailer: ${(e as Error).message}`);
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
    return { ok: true, sha: landedSha, subject: landedSubject, strippedTrailerCount, pathSetStamped };
  } catch (e) {
    return { ok: false, reason: `${branch}: landed but failed to read the result: ${(e as Error).message}` };
  }
}

/**
 * Land each candidate branch's OWN commits, individually, onto `batchWorktreePath`, IN ORDER — each
 * branch's commits land on top of the previous branch's, so a later candidate's diff is computed against a
 * tree that already contains every earlier LANDED candidate's content (this is what makes the batch's
 * single gate a real test of the combined tree, not an approximation of it). See
 * {@link landBranchCommitsIndividually} for the per-branch mechanism (cherry-pick, not squash — card
 * 6801c0a1) and this file's own header doc for why.
 *
 * A candidate that won't land cleanly (a real conflict on any of its own commits against an earlier
 * candidate in this same batch, or any other cherry-pick/commit failure) is DROPPED — recorded with its
 * reason and the loop continues with the rest. This never throws and never aborts the batch: assembly
 * failure is a per-branch outcome, not a batch-wide one (owner directive — "drop, don't fail").
 */
export async function assembleBatchBranches(
  batchWorktreePath: string, candidates: BatchCandidate[], deps: BatchGitDeps = {},
): Promise<BatchAssembleResult> {
  const landed: BatchLandedBranch[] = [];
  const dropped: BatchDroppedBranch[] = [];
  for (const c of candidates) {
    const r = await landBranchCommitsIndividually(batchWorktreePath, c.branch, deps);
    if (!r.ok) {
      dropped.push({ ...c, reason: r.reason ?? "batch land failed", conflict: !!r.conflict });
      continue;
    }
    if (r.noop) {
      if (r.emptyKind === "ALREADY_MERGED" && r.sha) {
        landed.push({ ...c, sha: r.sha, subject: r.subject ?? (c.taskTitle ?? c.branch), noop: true });
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
    landed.push({ ...c, sha: r.sha, subject: r.subject, strippedTrailerCount: r.strippedTrailerCount, pathSetStamped: r.pathSetStamped });
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
  const assembleStartMs = Date.now();
  const { landed, dropped } = await assembleBatchBranches(batchWorktreePath, candidates, deps);
  const assemblyMs = Date.now() - assembleStartMs;
  if (landed.length === 0) {
    return { ok: false, landed, dropped, baseMainSha, assemblyMs, reason: "nothing landed cleanly into the batch — every candidate was dropped" };
  }
  const gate = await runGate(batchWorktreePath, baseMainSha, landed.length, assemblyMs);
  if (!gate.passed) {
    return { ok: false, landed, dropped, baseMainSha, assemblyMs, gatePassed: false, gateFailed: true, gateDetail: gate, reason: gate.reason ?? "batch gate failed" };
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
    };
  }
  return { ok: true, landed, dropped, baseMainSha, batchHeadSha, assemblyMs, fastForwardMs, gatePassed: true, gateDetail: gate };
}
