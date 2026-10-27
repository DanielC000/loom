import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { SimpleGit } from "simple-git";
import { WORKTREES_DIR } from "../paths.js";
import { nonInteractiveEnv, localNonInteractiveEnv, stripClaudeSessionTrailer, gitError, unsafeBranchNameShapeReason } from "./writer.js";
import { pauseVaultAutoCommit, resumeVaultAutoCommit, isLoomHomeOrAncestor, OPERATIONAL_HOME_GIT_WRITE_ERROR } from "../vault/versioner.js";
import { withTimeout, canonicalGit, killableCanonicalRaw, treeDeathUnconfirmed, treeDeathConfirmed, CANONICAL_GIT_CONFIG_ARGS, CanonicalGitRefusal, describeGitFailure, canonicalFailureMessage, isNotAGitRepositoryError, localReadGitEnv, resolveGitBinaryForSpawn, FALLBACK_GIT_IDENTITY, resolveGitIdentityFallbackArgs, unpinnedProbeFactoryFromLegacy, detectShallowCanonicalRepo, defaultTrustedMainRoot, type CheckCommondirTrustOpts } from "./bounded.js";
import { withCanonicalIndexLock, RepoQuarantinedError, CanonicalIndexLockPresentError, resolveGitDirsSync } from "./repo-lock.js";
import { enterMergeDangerWindow, exitMergeDangerWindow } from "./merge-danger-window.js";
import { assertRepoNotQuarantined, enterMergeQuarantine, clearMergeQuarantineByToken, unconfirmedKillReason } from "./merge-quarantine.js";
import { isDoctrineArtifactPath, isDoctrineSkillsPath } from "../pty/claude-doctrine.js";
import { isCodexDoctrinePath } from "../pty/codex-doctrine.js";
import { checkTitleHtmlEntities, CONVENTIONAL_TYPES } from "../tasks/title-guard.js";
import { mergeCommitBlocksLinearization, MAX_MERGE_COMMITS_CHECKED } from "./merge-linearization.js";
import { readHeadShaAndBranch } from "./mainline-watch.js";
import {
  emitCompareSoundnessOk,
  transpileIgnoringCommentsAndWhitespace,
  type EmitCompareSoundnessScope,
  type TypeScriptModuleLike,
} from "../emit-compare-soundness.js";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  /** The repo's HEAD sha at the moment of this call — the worktree branch's FORK POINT off main, not the
   *  worktree's own branch (a worktree's own branch as its own base is always a 0-diff no-op). */
  mainSha: string;
  /**
   * Set ONLY when this call REUSED an existing worktree dir (a checkout retained from a prior
   * hard-stopped or rejected-merge attempt on the same task — the `fs.existsSync(worktreePath)` branch of
   * {@link createWorktree}) AND it still carries real leftover uncommitted work after the existing reuse
   * lifecycle (the stale-branch recut) has run. Absent for a freshly-created worktree, a
   * reattached-branch-only worktree (always a clean fresh checkout), or a reused-but-clean worktree —
   * byte-identical to before this field existed. Board card 2250836c: read-only signal — createWorktree
   * never cleans the tree on account of this (Loom never silently discards a hard-stopped worker's
   * leftover edits; they may be a nearly-complete change worth finishing).
   */
  reusedDirtyWorktree?: ReusedDirtyWorktreeInfo;
  /**
   * Set ONLY for a REUSED/reattached branch (either reuse path of {@link createWorktree}) whose history
   * is missing commits current main HEAD carries — a RECOVERY branch (>0 commits ahead of ITS OWN base,
   * so {@link recutStaleReusedBranch}'s 0-ahead fail-safe correctly leaves it untouched) whose base has
   * since fallen behind main (board card 5150fdc2 — the mockups-first systematic case: a build re-spawned
   * onto this branch silently roots at the ORIGINAL fork point forever). Absent for a fresh `-b` branch
   * (always forks current HEAD), a 0-ahead branch (already re-cut onto current main above), OR a stale
   * branch that was successfully auto-forwarded (see {@link resolveStaleBase}) — only present when the
   * staleness is STILL THERE for the manager/worker to see.
   */
  staleBase?: StaleBaseInfo;
  /**
   * Set ONLY when this call REUSED an existing 0-ahead worktree/branch (the `fs.existsSync(worktreePath)`
   * branch of {@link createWorktree}) AND {@link recutStaleReusedBranch}'s `git reset --hard` actually
   * discarded real tracked work in the process (board card 13cc2300). Captured BEFORE that reset — the
   * only moment the worktree still carries what is about to be destroyed — so it survives to be reported
   * even though the files themselves do not. DISTINCT from {@link reusedDirtyWorktree}: that field means
   * "survived and is still dirty" (read AFTER the recut, on whatever a >0-ahead recovery branch or a
   * daemon-noise-filtered leftover left behind); this one means "was destroyed" (a 0-ahead branch's
   * tracked edits, reverted to the main-branch version by the reset). A caller must be able to tell the
   * two facts apart, never conflate them into one field. Absent for a fresh worktree, a reattached-branch-
   * only worktree, a reused worktree that was already clean, or a >0-ahead recovery branch (never recut —
   * see {@link mayRecutOntoMain}).
   */
  discardedOnRecut?: DiscardedOnRecutInfo;
  /**
   * True ONLY when this call actually cut a FRESH `-b branch forkFrom` worktree — never for a reuse or a
   * reattach (either case silently ignores `forkFrom`). A caller must gate `Session.reviewBaseSha`
   * stamping on THIS, never on "a `reviewOf*` option was passed".
   *
   * @decision 37fe091c — an aliased reuse/reattach spawn must stamp `reviewBaseSha: null`, never the
   * reviewed tip, or boot-reconcile reads the author's real unmerged work as 0-ahead.
   */
  forkedFromReviewed: boolean;
  /**
   * True whenever this call genuinely advanced the branch's cut base to `mainSha` — a fresh `-b` cut
   * (always; `mainSha` is real mainline's HEAD at cut time regardless of `forkFrom`), OR a reuse/reattach
   * whose {@link recutStaleReusedBranch} actually ran its 0-ahead `reset --hard` onto `mainSha`. False for
   * a retained >0-ahead recovery branch (left untouched, or merge-forwarded by {@link resolveStaleBase} —
   * forwarding only catches the SAME lineage up to newer commits, it never changes the TRUE original fork
   * point). A caller must stamp `Session.cutBaseSha = mainSha` only when this is true; otherwise it must
   * preserve whatever `cutBaseSha` was already recorded for this worktree (carried forward, never
   * silently overwritten with the reuse-time HEAD).
   *
   * @decision 0eaaa693 — never derive a cut base from the branch's own current ancestry; once a union
   * merge has run that ancestry is already polluted by the injected target tip.
   */
  cutBaseAdvanced: boolean;
}

/** {@link WorktreeInfo.reusedDirtyWorktree} — a bounded summary of a reused worktree's leftover uncommitted work. */
export interface ReusedDirtyWorktreeInfo {
  /** Bounded (~30 lines / ~2KB) list of leftover uncommitted paths, one per line — daemon-injected
   *  `.claude/` noise filtered out (see {@link uncommittedWorkFiles}), so this only ever names real
   *  worker-authored changes. */
  statusSummary: string;
  /** Total count of real uncommitted paths found — may exceed the number of lines actually shown in
   *  `statusSummary` when `truncated` is true. */
  fileCount: number;
  /** True when `statusSummary` was capped (by line count or byte length) and does not list every path. */
  truncated: boolean;
}

/** {@link WorktreeInfo.discardedOnRecut} — same shape as {@link ReusedDirtyWorktreeInfo} (a bounded
 *  `statusSummary`/`fileCount`/`truncated` triple), a deliberate type ALIAS rather than a duplicate
 *  interface: the two are structurally identical bounded-porcelain-summary shapes, and reusing the type
 *  keeps them from drifting apart. The DISTINCT FACT the card requires lives in the FIELD NAME on {@link
 *  WorktreeInfo}, not the type — see that field's own doc for what separates "destroyed" from "survived
 *  and still dirty". */
export type DiscardedOnRecutInfo = ReusedDirtyWorktreeInfo;

/** {@link WorktreeInfo.staleBase} — card 5150fdc2: a reused/reattached branch's base is behind current
 *  main, and no clean auto-forward was possible (see {@link resolveStaleBase}). */
export interface StaleBaseInfo {
  /** The branch's fork point off main — `git merge-base <branch> <mainSha>` — BEFORE any forward attempt. */
  baseSha: string;
  /** `git rev-list --count <branch>..<mainSha>` — how many commits current main carries that this
   *  branch's history is missing. Always > 0 (an undefined/0 result is never surfaced as staleBase). */
  behindBy: number;
  /** Bounded (~30) list of files that changed on main between `baseSha` and current main HEAD — enough
   *  for a worker kickoff note to see the scope of what it's rooted behind, without growing the spawn
   *  result/prompt unboundedly. */
  changedFiles: string[];
  /** True when `changedFiles` was capped and does not list every changed path. */
  truncated: boolean;
}

// @decision 44c28799 — bound EVERY git op in this file to 15s, via boundedGit/boundedMergeGit: a hung child
// never throws, so try/catch alone can't catch it (the 2026-06-03 boot-outage fix). Don't lower the ceiling
// casually — it's sized to fail a genuinely wedged op fast, not to rush a slow-but-legitimate one.
export const GIT_OP_TIMEOUT_MS = 15_000; // exported so a test can assert the floored value, not restate it

// @decision f2c976ea — do not lower this back toward GIT_OP_TIMEOUT_MS: the checkout is a bulk
// filesystem write, not a ref op, and 15s already confirmed-killed two real adds under ordinary
// foreign-gate host load. Do not raise it past this without re-measuring the canonical-lock hold-time cost.
export const WORKTREE_ADD_TIMEOUT_MS = 60_000; // exported so a test can assert the floored value, not restate it

/**
 * Injectable seam for the bounded git ops. Lets a test simulate a hanging git child with a tiny budget
 * and assert the call returns/throws within the window (not never). `gitFactory` defaults to a simpleGit
 * whose `block` timeout KILLS a no-output (hung) child; `timeoutMs` bounds BOTH the simpleGit block
 * timeout and the {@link withTimeout} race below, so a never-settling git promise — a real child wedged,
 * or an injected fake that never resolves — still unblocks the function.
 */
export interface BoundedGitDeps {
  gitFactory?: (repoPath: string, blockTimeoutMs: number) => Pick<SimpleGit, "raw">;
  timeoutMs?: number;
  /** @decision 3a5c5d4a — the real canonical main checkout root, for a caller whose own `repoPath` is a
   *  worker's own linked WORKTREE. Never defaulted. `attemptCodexAutoCommit` needs this explicitly — see
   *  its own call sites' doc for why it can't just inherit `quarantineRepoPath`'s default here. */
  trustedMainRoot?: string;
  /** @decision 2267e8fa — TEST SEAM ONLY, a DIFFERENT seam than `gitFactory` above (that one's 2-arg
   *  shape has no `env` to assert on) — overrides the identity probe's own git construction. Production
   *  never sets this. */
  identityProbeGitFactory?: (cwd: string, timeoutMs: number, env: Record<string, string | undefined>) => Pick<SimpleGit, "raw">;
  /**
   * Injectable KILLABLE directory removal for removeWorktree's backstop (defaults to
   * {@link killableRemoveDir}). Lets a test simulate either a CLEAN reject (settles fast, `removed:false,
   * killed:false` — the transient EBUSY/EPERM handle-lag case) or a genuine HANG (a promise that never
   * resolves) and prove removeWorktree still returns within `timeoutMs` either way.
   */
  removeDir?: (target: string, timeoutMs: number) => Promise<RemoveDirResult>;
  /**
   * Card 7e5b23e7 — TEST SEAM ONLY: overrides {@link mergeMainIntoWorktree}'s own dedicated
   * `UNION_MERGE_TIMEOUT_FLOOR_MS` floor for its two mutating merge calls. Production code never sets
   * this (so the floor always applies); a test shrinks it to make a real slow-hook repro settle in a
   * reasonable wall-clock time instead of waiting out the real 45s+ floor on every case.
   */
  unionMergeTimeoutFloorMs?: number;
  /**
   * Card 7e5b23e7 round 2 — gates {@link mergeMainIntoWorktree}'s own one-bounded-retry (both the plain
   * union and owed-landing branches) OFF. Defaults to `true` (every existing caller unaffected) except
   * `reunionAtAdmission`'s own call (sessions/service.ts), which passes `false`: that call runs INSIDE
   * `runExclusive`, holding a scarce, fleet-shared GateSemaphore slot — a retry there would double the
   * worst-case time ANY OTHER queued merge on the fleet is blocked behind (recomputed ~195s/attempt,
   * ~390s for two — see that card's own decision record), for a failure a plain re-confirm can recover
   * from more cheaply (it just re-queues this op, it doesn't hold the slot). The pre-admission union-merge
   * call and the inert-reclassification re-union (only a repo-guard-only hold, not a semaphore slot) both
   * keep the retry, unaffected.
   */
  allowRetry?: boolean;
  /** @decision a5d9c458 — do not check this only once before {@link removeWorktree}'s retry loop starts;
   *  re-consult it before EVERY attempt, or a claim arriving mid-retry goes unnoticed until too late. */
  abortIfClaimed?: () => boolean;
  /**
   * Card f2c976ea — TEST SEAM ONLY: overrides {@link createWorktree}'s own `worktree add` call
   * specifically, independent of `timeoutMs` above (which still bounds its sibling `prune`/
   * `branch --list` calls in the same locked sequence). Production code never sets this (so
   * {@link WORKTREE_ADD_TIMEOUT_MS} always applies to `add`); a test shrinks it to prove the two calls
   * are bounded independently without paying either real-world duration.
   */
  addWorktreeTimeoutMs?: number;
  /**
   * @decision c684d00d — a start-only phase diagnostic can misread "step finished, something later
   * threw" as "this step is hung"; the terminal mark on every exit below is what closes that gap.
   *
   * DIAGNOSTIC-ONLY seam: fired at the START of each named sub-step on {@link createWorktree}'s
   * fresh-cut path ("toplevel-guard", "rev-parse-HEAD", "prune", "branch-list", "worktree-add",
   * "add-failure-cleanup"), plus a TERMINAL mark on every exit — "done" on success, or
   * `"threw:<ErrorClass>:<message>"` on any throw (the whole cut body is wrapped in one try/catch for
   * exactly this). `atMs` is elapsed time since this `createWorktree` call began. Absent ⇒
   * byte-identical: no extra git call, no timeout/ordering change. Wrapped in try/catch at the call
   * site — a throwing observer must never break a worktree cut.
   */
  onPhase?: (phase: string, atMs: number) => void;

  // @decision c13666c6 — must stay OPT-IN: never default or widen this to fire for a caller that omits
  // it, or a project-less/test call silently starts refusing a landing it used to accept.

  /** DB-resolved facts for the branch-gone forged-trailer gate ({@link verifyGoneBranchLanding}),
   *  threaded down from a caller that knows the project/repoKey/mainline-branch (sessions/service.ts,
   *  mcp/tasks.ts) — this module is pure-git and has no DB of its own. */
  goneBranchLedger?: GoneBranchLedgerFacts;
}

/**
 * The branch-gone ledger-cutover gate's DB-side inputs for ONE (project, repoKey) scope — card c13666c6
 * round 2. Callback-shaped (never a pre-fetched snapshot): the SET of shas worth querying depends on a
 * git-computed chain the caller doesn't know ahead of time, so this module calls back into the DB only
 * for exactly the shas it needs, each query an indexed point lookup. All three are synchronous
 * (better-sqlite3) and branch-INDEPENDENT (never scoped to a specific branch name — see
 * `docs/decisions/c13666c6-*.md` finding 5).
 */
export interface GoneBranchLedgerFacts {
  /** The durable pre-ledger cutover boundary sha for this scope, or `null` when the scope has NO ledger
   *  rows at all — the whole gate is then a no-op (today's self-consistent-trailer check alone decides).
   *  See `Db.resolveGoneBranchLedgerBoundary`'s own doc for how/when this is established. */
  resolveBoundary: () => string | null;
  /** The ledger rows (any branch) among `tips` that exist for this scope — an indexed `tip IN (...)`
   *  lookup, never a table scan. */
  rowsByTips: (tips: readonly string[]) => readonly { base: string; tip: string }[];
  /** The highest ledger row id for this scope, or `null` with no rows — the verdict memo's own
   *  cache-invalidation key (a new landing bumps this, so a stale memoized verdict is never reused). */
  maxRowId: () => number | null;
  /** `${projectId}:${repoKey}` — round 4, card c13666c6: a stable, DB-known identifier for THIS scope,
   *  used ONLY to rate-limit the `"error"`-verdict log line (never any DB query or caching decision) so a
   *  genuinely transient, repeatedly-failing lookup doesn't spam the log once per board read. */
  scopeKey: string;
}

// @decision 0f965ab7 — catch simple-git's synchronous construct throw once, centrally, via this stub
// proxy: a new caller hitting a construct-time throw routes through boundedGit/boundedMergeGit/
// boundedDiffGit (which already apply this), never its own per-caller try/catch around simpleGit(...).
//
// ⛔ `then`/`catch`/`finally` (symbol-keyed too) MUST resolve to `undefined`, never a rejecting function —
// trapping them makes this proxy thenable, and a trapped `then` ignoring its (resolve,reject) args would
// leave an awaiting promise NEVER SETTLING.
export function gitConstructFailure<T extends object>(err: unknown): T {
  const rejection = err instanceof Error ? err : new Error(String(err));
  return new Proxy({} as T, {
    get: (_target, prop) => {
      if (typeof prop === "symbol" || prop === "then" || prop === "catch" || prop === "finally") return undefined;
      return () => Promise.reject(rejection);
    },
  });
}

// `boundedGit`'s own doc above characterizes most of its ~20+ callers as "read-mostly or worktree-scoped"
// (never the canonical squash-merge write — see `boundedMergeGit`'s doc for that distinct path), but NOT
// all of them equally trust-sensitive (round 3, S3: `computeEmitCompareGate` decides whether the batch
// merge gate gets REDUCED, so IT needs the real, CHECKED path, not this opt-out — see its own call sites
// in `sessions/service.ts`, which now thread `deps.trustedMainRoot` explicitly). This const is applied
// ONLY when a caller does NOT supply its own `trustedMainRoot` — a caller that does gets the REAL
// verification instead, never silenced by this opt-out. It narrows ONLY the "no trustedMainRoot at all"
// case either way, never the DIRECTORY-shape check or the `CanonicalGitBoundWorktreeRefusal` case.
// @decision 3a5c5d4a (round 2/3, S2/S3) — per-caller, keyed on whether `deps.trustedMainRoot` is set.
const BOUNDED_GIT_ADVISORY_READ: CheckCommondirTrustOpts = { commondirCheck: "advisory-read" };

/** Build the bounded git instance + resolve the timeout for one op, applying the seam's defaults. Never
 *  throws — see {@link gitConstructFailure}. A caller that supplies `deps.trustedMainRoot` gets the REAL
 *  checkCommondirTrust verification; one that doesn't gets the advisory-read opt-out, same as before. */
function boundedGit(repoPath: string, deps: BoundedGitDeps): { git: Pick<SimpleGit, "raw">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const makeGit = deps.gitFactory ?? ((p, ms) => canonicalGit(p, ms, undefined, undefined, undefined, deps.trustedMainRoot, deps.trustedMainRoot === undefined ? BOUNDED_GIT_ADVISORY_READ : undefined));
  let git: Pick<SimpleGit, "raw">;
  try {
    git = makeGit(repoPath, timeoutMs);
  } catch (e) {
    git = gitConstructFailure<Pick<SimpleGit, "raw">>(e);
  }
  return { git, timeoutMs };
}

/**
 * Same seam as {@link boundedGit} (block-timeout + the `withTimeout` race, both defaulting to
 * {@link GIT_OP_TIMEOUT_MS}), PLUS `localNonInteractiveEnv()` (`GIT_TERMINAL_PROMPT=0` etc., transport
 * family stripped) on the default factory — matching `git/reader.ts` and `git/writer.ts`'s own convention
 * for a LOCAL git write. Used only by {@link mergeBranchLocked} and
 * {@link scanCanonicalReposForMergeResidue}: the squash-merge onto the canonical repo is this codebase's
 * highest-consequence git write (board card 44c28799), so it gets the same non-interactive posture as
 * every other writer. Deliberately NOT folded into {@link boundedGit} itself — that helper backs ~20 other
 * call sites in this file (worktree creation, branch listing, diffing) that are read-mostly or
 * worktree-scoped; changing their environment behavior is out of scope here and would need its own
 * verification. `gitFactory`, when supplied (the test seam), is used as-is — a test injecting a hanging
 * fake doesn't need env scrubbing applied to it.
 *
 * @decision a746a3eb — `localNonInteractiveEnv()`, not `nonInteractiveEnv()`: this instance's own
 * `.raw()` is called DIRECTLY (never through `killableCanonicalRaw`'s immune raw-spawn path) for ops on
 * the canonical repo that never touch a remote — the transport family must be stripped, not left blocked.
 */
function boundedMergeGit(repoPath: string, deps: BoundedGitDeps): { git: Pick<SimpleGit, "raw">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  // @decision 3a5c5d4a (round 4, B-1) — thread deps.trustedMainRoot when the caller supplies one
  // (mergeBranchLocked's own identity-fallback callers already do), else default to the REAL resolved
  // toplevel of repoPath itself (never bare repoPath — a subdir-bound project has no .git there at all).
  const makeGit = deps.gitFactory ?? ((p, ms) => canonicalGit(p, ms, localNonInteractiveEnv(), undefined, undefined, deps.trustedMainRoot ?? defaultTrustedMainRoot(repoPath)));
  let git: Pick<SimpleGit, "raw">;
  try {
    git = makeGit(repoPath, timeoutMs);
  } catch (e) {
    git = gitConstructFailure<Pick<SimpleGit, "raw">>(e);
  }
  return { git, timeoutMs };
}

/** One line of git's own KNOWN, benign `worktree add` progress output — printed on every successful add,
 *  split across stdout (`HEAD is now at …`) and stderr (`Preparing worktree (…)`). See the doc on this
 *  constant's one caller ({@link createWorktree}'s `worktree add` catch, card af436c99) for why this
 *  narrow allowlist exists and what it deliberately does NOT match. */
const BENIGN_WORKTREE_ADD_LINE = /^(Preparing worktree \(.*\)|HEAD is now at [0-9a-f]+.*)$/;

/** True only when `message` consists ENTIRELY of lines matching {@link BENIGN_WORKTREE_ADD_LINE} (and is
 *  non-empty) — i.e. it carries no `fatal:`/`error:` line and none of `withTimeoutKillingChild`'s own
 *  wrapper suffixes ("git child killed" / "giving up … hung git child?"), both of which fail this check
 *  by construction (they never match the allowlisted patterns). */
function isBenignWorktreeAddNoise(message: string): boolean {
  const lines = message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => BENIGN_WORKTREE_ADD_LINE.test(l));
}

/** Independently confirms a `worktree add` actually landed: the directory + its `.git` link exist, and
 *  the checked-out branch is really `branch`. Used ONLY alongside {@link isBenignWorktreeAddNoise} — belt
 *  and suspenders, never trusted alone — so a benign-looking message can't paper over an add that, for
 *  some other reason, didn't actually leave a valid worktree behind. */
async function worktreeAddLanded(worktreePath: string, branch: string, gitDeps: BoundedGitDeps): Promise<boolean> {
  if (!fs.existsSync(worktreePath) || !fs.existsSync(path.join(worktreePath, ".git"))) return false;
  try {
    const { git, timeoutMs } = boundedGit(worktreePath, gitDeps);
    // card 967eb326 — `symbolic-ref HEAD` is never ambiguity-shortened, unlike `rev-parse --abbrev-ref
    // HEAD` (which can resolve to "heads/<name>" beside a same-named tag or refs/remotes/<name>/HEAD;
    // see docs/decisions/2a6a292a-* "Round 13"). Compare the full ref, not a shortened name.
    const head = (await withTimeout(
      git.raw(["symbolic-ref", "HEAD"]), timeoutMs, "git symbolic-ref HEAD (post-add benign-noise verify)",
    )).trim();
    return head === `refs/heads/${branch}`;
  } catch {
    return false;
  }
}

/** TEST-ONLY seam (card 967eb326): `worktreeAddLanded` itself has no production export — every other
 *  caller of it reaches it only through {@link createWorktree}'s own benign-noise handling, which needs a
 *  genuine ambiguity-shortened `git worktree add` warning to exercise. This alias lets a test call it
 *  directly instead of manufacturing that warning end-to-end. */
export const worktreeAddLandedTestOnly = worktreeAddLanded;

/**
 * Injectable seam for {@link diffBranch}, mirroring {@link BoundedGitDeps} — same
 * block-timeout + {@link withTimeout} race, same `timeoutMs` default of {@link GIT_OP_TIMEOUT_MS} — but
 * its `gitFactory` returns `diffSummary`/`diff` too (not just `raw`), since diffBranch uses simple-git's
 * convenience methods rather than raw plumbing for its diffstat/patch. Kept separate from
 * {@link BoundedGitDeps} rather than widening that shared interface: `BoundedGitDeps.gitFactory` backs
 * ~20 other call sites (and their test fakes) that only ever implement `raw` — widening it there would
 * break every one of those fakes for a need only diffBranch has.
 */
export interface DiffBranchDeps {
  gitFactory?: (repoPath: string, blockTimeoutMs: number) => Pick<SimpleGit, "raw" | "diffSummary" | "diff">;
  timeoutMs?: number;
  /**
   * An ALREADY-RESOLVED branch tip (e.g. a review-spawn's `headSha`, also used for its `reviewBaseSha`
   * stamp).
   * @decision 56c10535 — when set, {@link diffBranch} skips its own `resolveBranchTip` call and diffs
   * THIS sha, so two logically-identical reads can never diverge; `branch` is then display-only.
   */
  resolvedTip?: string;
  /** @decision 3a5c5d4a — the real main checkout root, when `repoPath` is a worker's own WORKTREE
   *  (e.g. `workerDiff`'s uncommitted-diff branch). Never defaulted to `repoPath` — that would compare
   *  the worktree's commondir against itself. Omit when `repoPath` already IS the main checkout. */
  trustedMainRoot?: string;
}

/** Build the bounded git instance + resolve the timeout for {@link diffBranch}'s ops, applying the seam's defaults. */
function boundedDiffGit(repoPath: string, deps: DiffBranchDeps): { git: Pick<SimpleGit, "raw" | "diffSummary" | "diff">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  // @decision 3a5c5d4a — pass `deps.trustedMainRoot` AS-IS when the caller supplies one (the WORKTREE
  // case, never defaulted to `p` — that would compare the worktree's commondir against itself).
  // @decision 3a5c5d4a (round 4, B-1) — when the caller omits it (the "`p` already IS the main
  // checkout" case), default to `p`'s own resolved toplevel, never bare `p` — a subdir-bound project
  // has no `.git` at `p` itself; a healthy main checkout resolves back to `p` immediately either way.
  const makeGit = deps.gitFactory ?? ((p, ms) => canonicalGit(p, ms, undefined, undefined, undefined, deps.trustedMainRoot ?? defaultTrustedMainRoot(p)));
  let git: Pick<SimpleGit, "raw" | "diffSummary" | "diff">;
  try {
    git = makeGit(repoPath, timeoutMs);
  } catch (e) {
    git = gitConstructFailure<Pick<SimpleGit, "raw" | "diffSummary" | "diff">>(e);
  }
  return { git, timeoutMs };
}

/**
 * Filesystem- and ref-safe key for a task: 12 hex chars of sha256(taskId). Keyed off the FULL id,
 * not `taskId.slice(0,8)` — two human-readable task ids sharing the first 8 chars used to collide
 * onto the same branch/worktree (H1.3). Deterministic, so the SAME task always resolves to the same
 * worktree (re-spawn after a rejected merge, and recycle which carries the stored path forward).
 */
export function taskKey(taskId: string): string {
  return createHash("sha256").update(taskId).digest("hex").slice(0, 12);
}

/**
 * The exact shape {@link taskKey} always produces — 12 hex characters, by construction. Shared (never
 * re-derived) so a repoKey check and this module's own worktree-cut backstop can never silently drift
 * apart from what `taskKey` actually emits (card c994ffeb — the same drift class 98039b36's decision
 * record warns against for `isRegisteredRepoKeyName`).
 */
export const TASK_KEY_SHAPE_RE = /^[0-9a-f]{12}$/i;

/**
 * The deterministic worktree dir path `createWorktree` cuts for a task — same formula it uses
 * internally (taskKey + {@link WORKTREES_DIR} + projectId + optional repoKey axis, card 49136451).
 * Exported so a caller can know the path BEFORE calling createWorktree (card a5d9c458 —
 * pre-checking/clearing stale wedged-worktree tracking for a path about to be claimed, done in
 * `sessions/service.ts` rather than threading a DB dependency into this module).
 */
export function resolveWorktreePath(projectId: string, taskId: string, repoKey?: string | null): string {
  const key = taskKey(taskId);
  return repoKey && repoKey !== "primary" ? path.join(WORKTREES_DIR, projectId, repoKey, key) : path.join(WORKTREES_DIR, projectId, key);
}

type RenameSyncFn = (from: string, to: string) => void;
let renameDirAsideImpl: RenameSyncFn = fs.renameSync;
/** Test-only seam (card a5d9c458): `fs`'s ESM namespace import can't be monkeypatched directly —
 *  see `pty/claude-config.ts`'s identical `__setRenameSyncForTest` for the same constraint — so a
 *  deterministic rename-FAILURE test for {@link renameWorktreeDirAside} needs this instead of relying on
 *  a real, platform-specific OS condition. `undefined` restores the real `fs.renameSync`. */
export function __setRenameDirAsideForTest(fn?: RenameSyncFn): void { renameDirAsideImpl = fn ?? fs.renameSync; }

let worktreeCollisionBackstopEnabled = true;
/** Test-only seam (card c994ffeb, widened by card ceeb188b): disables BOTH rename-aside collision
 *  backstops that guard against destroying a live repo-axis dir — `createWorktree`'s own reverse check
 *  AND `SessionService.reclaimWedgedWorktreePathForSpawn`'s pre-spawn wedge-reclaim check (service.ts) —
 *  so a test can prove either backstop is actually load-bearing by reproducing the pre-fix wrongful-
 *  rename-aside behavior on demand, rather than only asserting it fires. ONE switch governs both sites
 *  deliberately (card ceeb188b review decision) — do not add a second seam for the reclaim side; read
 *  the shared flag via {@link isWorktreeCollisionBackstopEnabled} instead. Omit the arg (or pass `true`)
 *  to restore the real, enabled check. */
export function __setWorktreeCollisionBackstopForTest(enabled?: boolean): void { worktreeCollisionBackstopEnabled = enabled ?? true; }

let unsafeBranchNameShapeReasonImpl: typeof unsafeBranchNameShapeReason = unsafeBranchNameShapeReason;
/** Test-only seam (card abbda4f5): overrides `createWorktree`'s entry branch-shape guard. `branch` is
 *  always `loom/${taskKey(taskId)}` — a shape that can never legitimately trip the real check — so there
 *  is no other way to dynamically exercise this guard's wiring. `undefined` restores the real function. */
export function __setUnsafeBranchNameShapeReasonForTest(fn?: typeof unsafeBranchNameShapeReason): void {
  unsafeBranchNameShapeReasonImpl = fn ?? unsafeBranchNameShapeReason;
}
/** Read-only counterpart to {@link __setWorktreeCollisionBackstopForTest} — lets a caller outside this
 *  module (`SessionService.reclaimWedgedWorktreePathForSpawn`) consult the SAME shared flag before
 *  running its own nested-worktree-child check, so the one test seam above governs both backstops. */
export function isWorktreeCollisionBackstopEnabled(): boolean { return worktreeCollisionBackstopEnabled; }

export interface RenameAsideResult {
  ok: boolean;
  /** The computed `<targetPath>.stale-<ts>` destination — present on BOTH outcomes, so a failure message
   *  can still name where the rename was attempted TO. */
  staleAside: string;
  error?: Error;
}

/**
 * Rename `targetPath` aside to `<targetPath>.stale-<ts>` — NEVER delete it (it may hold uncommitted work
 * from whatever wedged/orphaned the original removal attempt that left it there). Shared by
 * `createWorktree`'s own half-removed-dir detection (below) and
 * `SessionService.reclaimWedgedWorktreePathForSpawn` (card a5d9c458) — a single rename
 * implementation so the two can't drift, with each caller deciding its OWN failure policy on a non-`ok`
 * result: `createWorktree` throws (refusing to reuse/overwrite an orphan it can't even move out of the
 * way); `reclaimWedgedWorktreePathForSpawn` ALSO throws (refusing the spawn outright) rather than
 * silently letting a fresh spawn reuse whatever is left sitting there in an unknown state.
 */
export function renameWorktreeDirAside(targetPath: string): RenameAsideResult {
  const staleAside = `${targetPath}.stale-${Date.now()}`;
  try {
    renameDirAsideImpl(targetPath, staleAside);
    return { ok: true, staleAside };
  } catch (e) {
    return { ok: false, staleAside, error: e as Error };
  }
}

/**
 * Card C2/C3: the Codescape `worktreeId` for a worker session — the SAME opaque key naming its
 * `loom/<key>` branch + worktree dir (above), so the daemon's Codescape MCP URL (C2) and its later
 * DELETE-on-drop (C3) always agree on which worktree they mean. `null` for a taskless spawn (no stable
 * id to key off — see `createWorktree`'s `taskId ?? claimKey` carve-out) or a non-worktree session
 * (manager/plain), so those get the 2-segment (no-worktree-scope) MCP URL instead.
 */
export function codescapeWorktreeId(taskId: string | null | undefined): string | null {
  return taskId ? taskKey(taskId) : null;
}

/**
 * Resolve `ref` (a branch name or sha) to its current commit sha in `repoPath`, or `null` if it doesn't
 * resolve to a real commit. Used by the review-spawn path (card 47bbdc3f) to VALIDATE a `reviewOf*`-
 * resolved branch actually exists BEFORE cutting the reviewer's own branch from it via `createWorktree`'s
 * `forkFrom` — a bad/stale branch name must fail loudly here, not silently fall back to HEAD (which would
 * reintroduce the wrong-tree-read bug this whole mechanism exists to close). BOUNDED like every other op
 * in this file (a hung `rev-parse` must not wedge the spawning manager's turn).
 */
export async function resolveGitRef(repoPath: string, ref: string, deps: BoundedGitDeps = {}): Promise<string | null> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // @decision 868e0135 — `--end-of-options` added: round-2 CR retracted the compound-suffix exemption this relied on.
    const out = await withTimeout(git.raw(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]), timeoutMs, "git rev-parse --verify");
    const sha = out.trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * The BRANCH-qualified sibling of {@link resolveGitRef}: resolves `branch`'s tip to its commit sha, or
 * `null` if `refs/heads/<branch>` does not exist — via `git for-each-ref`, never `rev-parse`/`merge-base`.
 * @decision 56c10535 — every `resolveGitRef` caller passing a worker/loom BRANCH NAME must call THIS
 * function instead; never blanket-prefix inside `resolveGitRef` itself (other callers pass a sha/"HEAD"/
 * mainline name, which `refs/heads/`-prefixing would silently break).
 * @decision 56c10535 — `refs/heads/<branch>^{commit}` is NOT exact (git's own DWIM can resolve a PLANTED
 * decoy when the real branch is missing, confirmed on real git) — use `for-each-ref` + exact `%(refname)`
 * equality instead, never a prefix/startsWith check (it also pattern-matches sub-paths).
 */
export async function resolveBranchTip(repoPath: string, branch: string, deps: BoundedGitDeps = {}): Promise<string | null> {
  const wanted = `refs/heads/${branch}`;
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // card 59e53710 — never resolve a ref's existence by exit code alone (simple-git's `raw()` does not
    // reliably reject on an exit-code-only failure, e.g. `show-ref --verify --quiet`); for-each-ref's
    // verdict is read from its OUTPUT CONTENT (the exact-refname filter below), never from whether the
    // call itself threw.
    const out = await withTimeout(
      git.raw(["for-each-ref", "--format=%(refname)%00%(objectname)", "--", wanted]),
      timeoutMs, "git for-each-ref (exact branch tip)",
    );
    for (const line of out.split("\n")) {
      if (!line) continue;
      const sepIdx = line.indexOf("\x00");
      if (sepIdx === -1) continue;
      if (line.slice(0, sepIdx) === wanted) {
        const sha = line.slice(sepIdx + 1).trim();
        return sha || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Card 42daa283 — is there a commit on HEAD's history, STRICTLY AFTER `afterSha`, carrying a `Loom-Worker-Branch: <branch>` trailer? That is the
 * durable git fact that a branch a merge_batch retained was later landed by a real squash of its live tip (only the merge code writes those
 * trailer commits, and a held branch is never re-assembled, so a later one can only be a deliberate confirm). Three-valued and FAIL-CLOSED:
 * "error" (a git failure/timeout, or `afterSha` not being an ancestor of HEAD so "strictly after" cannot be proven) must be read by the caller as
 * "not released", never as "none found means released" — the next boot or confirm simply retries.
 */
export async function findLaterBranchSquash(repoPath: string, branch: string, afterSha: string, deps: BoundedGitDeps = {}): Promise<"found" | "none" | "error"> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // Compare merge-base OUTPUT to afterSha (never `--is-ancestor`: simple-git resolves its exit-1 "no" as success — see batch-merge.ts).
    // @decision 868e0135 — `--end-of-options` right after "merge-base": `afterSha` is always a daemon-
    // recorded landed sha, but an option-shaped value would otherwise re-enter merge-base's option parser.
    const mb = (await withTimeout(git.raw(["merge-base", "--end-of-options", afterSha, "HEAD"]), timeoutMs, "git merge-base (later branch squash)")).trim();
    if (mb !== afterSha) return "error";
    // The grep is a PREFILTER only (card f62ef199); the verdict is the parsed final trailer block, so a commit that merely quotes the line never counts.
    // @decision 868e0135 — `--end-of-options` immediately before the range (already the last positional):
    // an option-shaped `afterSha` would otherwise risk the range token being misread by the revision parser.
    const out = await withTimeout(
      git.raw(["log", "--fixed-strings", `--grep=Loom-Worker-Branch: ${branch}`, "--format=%B%x1e", "--end-of-options", `${afterSha}..HEAD`]),
      timeoutMs, "git log --grep (later branch squash)",
    );
    return out.split("\x1e").some((message) => parseLoomTrailerBlock(message)?.branch === branch) ? "found" : "none";
  } catch {
    return "error";
  }
}

/**
 * Per-creation ceiling for the at-creation dep install. Generous (a warm-store frozen install is
 * usually seconds), but BOUNDED so a wedged/slow `pnpm install` can never hold up the spawn path
 * indefinitely. Far larger than {@link GIT_OP_TIMEOUT_MS} because an install legitimately takes longer
 * than a git ref op; on timeout the child is killed and provisioning DEGRADES (the worker installs on
 * its own, exactly as before this change) rather than wedging the daemon.
 */
const PROVISION_TIMEOUT_MS = 180_000;

/**
 * Per-creation ceiling for the MONOREPO BUILD step (only run after a successful install — see
 * {@link provisionWorktreeDeps}). INDEPENDENT of {@link PROVISION_TIMEOUT_MS} (the install's own budget)
 * so a slow-but-successful install can never crowd out the build's window — each phase gets its own full
 * bound rather than sharing one clock. Same order of magnitude as the install bound for the same reason
 * (a cold monorepo build can legitimately take a while); on timeout the child is killed and the build
 * DEGRADES (the worker builds sibling packages itself) rather than wedging the daemon.
 */
const PROVISION_BUILD_TIMEOUT_MS = 180_000;

/**
 * The JS package managers we provision for, in DETERMINISTIC precedence order when several lockfiles
 * coexist in one worktree root (see {@link detectPackageManager}): pnpm → npm → yarn.
 */
type PackageManager = "pnpm" | "npm" | "yarn";

/**
 * Injectable seam for {@link provisionWorktreeDeps}. A test can swap in a fake installer (to assert the
 * gate/bounding AND which package manager was detected, without running a real install) and/or shrink
 * the timeout. Defaults to the real bounded installer for the detected manager. The fake receives the
 * detected `manager` as a 3rd arg so a hermetic test can prove npm→npm / yarn→yarn dispatch off the
 * lockfile marker alone (the real installer functions ignore the extra arg).
 */
export interface ProvisionDeps {
  provision?: (worktreePath: string, timeoutMs: number, manager: PackageManager) => Promise<{ ok: boolean; reason?: string }>;
  timeoutMs?: number;
  /**
   * Injectable seam for the MONOREPO BUILD step — only invoked after a successful install, and only
   * when {@link isWorkspaceMonorepo} detects a workspace root. Defaults to the real bounded runner for
   * {@link WORKSPACE_BUILD_COMMANDS}. Lets a test assert the build fires/skips/degrades without running
   * a real build.
   */
  build?: (worktreePath: string, timeoutMs: number, manager: PackageManager) => Promise<{ ok: boolean; reason?: string }>;
  /** Overrides {@link PROVISION_BUILD_TIMEOUT_MS} for the build step specifically — INDEPENDENT of the
   *  install's `timeoutMs`, so a test (or a slow install) can never starve the build's own budget. */
  buildTimeoutMs?: number;
  /** @decision 503cd822 — `runBuild` is NOT derived from `noCommit` alone: a review spawn additionally
   *  gates the BUILD phase on `reviewDiffNeedsBuild` (does the reviewed diff touch a test-shaped file?) —
   *  building every no-commit review worktree unconditionally would defeat runBuild:false's latency win. */
  runBuild?: boolean;
}

/**
 * Bound on the captured stdout+stderr TAIL kept per provisioning child — enough to diagnose a real
 * failure (the actual tool error, e.g. an npm/pnpm/yarn error block) without letting a noisy/failing
 * install grow the buffer unboundedly in memory before the child is killed or exits. Mirrors the
 * markitdown provisioning-status pattern's captured ~4KB error tail (see CLAUDE.md).
 */
const OUTPUT_TAIL_MAX_CHARS = 4000;

/** Append `chunk` to `tail`, keeping only the LAST {@link OUTPUT_TAIL_MAX_CHARS} chars — a bounded ring
 *  so a chatty child's captured output can never grow without limit. Exported so the ring itself (the
 *  cap + which end is retained) has direct unit coverage, independent of spawning a real child. */
export function appendTail(tail: string, chunk: Buffer | string): string {
  const next = tail + chunk.toString("utf8");
  return next.length > OUTPUT_TAIL_MAX_CHARS ? next.slice(next.length - OUTPUT_TAIL_MAX_CHARS) : next;
}

/** Format a captured output tail for inclusion in a failure `reason` — empty string when nothing was
 *  captured (e.g. the child errored before producing any output), so a clean failure message doesn't
 *  grow a dangling empty section. Exported for direct unit coverage alongside {@link appendTail}. */
export function formatTail(tail: string): string {
  return tail.trim() ? `\n--- output tail ---\n${tail.trim()}` : "";
}

/** Bounded, non-interactive `pnpm install --frozen-lockfile --prefer-offline`, killing the child past
 *  `timeoutMs`. ASYNC (spawn, NEVER spawnSync) — createWorktree awaits this on the worker-spawn hot path,
 *  and spawnSync would freeze the single-threaded daemon event loop for the whole install. Command is
 *  HARDCODED (never agent input, no gateCommand-style trust concern); never rejects; output tail captured. */
function pnpmInstall(worktreePath: string, timeoutMs: number): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const child = spawn("pnpm install --frozen-lockfile --prefer-offline", {
      cwd: worktreePath,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    });
    let tail = "";
    child.stdout?.on("data", (d) => { tail = appendTail(tail, d); });
    child.stderr?.on("data", (d) => { tail = appendTail(tail, d); });
    let settled = false;
    const done = (r: { ok: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done({ ok: false, reason: `pnpm install exceeded ${timeoutMs}ms (killed)${formatTail(tail)}` });
    }, timeoutMs);
    child.on("error", (e) => done({ ok: false, reason: e.message }));
    child.on("exit", (code) => done(code === 0 ? { ok: true } : { ok: false, reason: `pnpm install exited ${code ?? "null"}${formatTail(tail)}` }));
  });
}

/** Shared bounded, non-interactive install/build runner for {@link npmInstall}/{@link yarnInstall} and
 *  the monorepo build step ({@link WORKSPACE_BUILD_COMMANDS}) — structurally identical to
 *  {@link pnpmInstall}, which keeps its own copy so that path stays byte-identical. `command` is ALWAYS
 *  hardcoded (never agent input); ASYNC spawn only; never rejects; output tail captured. */
function runBoundedInstall(command: string, worktreePath: string, timeoutMs: number): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: worktreePath,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    });
    let tail = "";
    child.stdout?.on("data", (d) => { tail = appendTail(tail, d); });
    child.stderr?.on("data", (d) => { tail = appendTail(tail, d); });
    let settled = false;
    const done = (r: { ok: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done({ ok: false, reason: `${command} exceeded ${timeoutMs}ms (killed)${formatTail(tail)}` });
    }, timeoutMs);
    child.on("error", (e) => done({ ok: false, reason: e.message }));
    child.on("exit", (code) => done(code === 0 ? { ok: true } : { ok: false, reason: `${command} exited ${code ?? "null"}${formatTail(tail)}` }));
  });
}

/**
 * npm provisioning: `npm ci` (the exact-lock, fast, reproducible install — it wipes node_modules and
 * installs strictly from package-lock.json), FALLING BACK to `npm install` when `npm ci` fails. `npm ci`
 * hard-fails on ANY drift between package.json and the lockfile (or a missing lock), so a worktree without
 * an exact lock match must still DEGRADE to a best-effort `npm install`, not hard-fail. The two runs SHARE
 * the `timeoutMs` budget: if `npm ci` exhausts it (a timeout-kill), the fallback is SKIPPED rather than
 * doubling the bound. Mirrors {@link pnpmInstall}'s best-effort + bounded posture; never rejects.
 */
async function npmInstall(worktreePath: string, timeoutMs: number): Promise<{ ok: boolean; reason?: string }> {
  const startedAt = Date.now();
  const ci = await runBoundedInstall("npm ci", worktreePath, timeoutMs);
  if (ci.ok) return ci;
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) return ci; // budget spent (likely a timeout-kill) → don't pile a 2nd install onto the bound
  const fallback = await runBoundedInstall("npm install", worktreePath, remaining);
  return fallback.ok ? fallback : { ok: false, reason: `npm ci failed (${ci.reason}); npm install fallback failed (${fallback.reason})` };
}

/**
 * yarn provisioning: `yarn install --immutable` — Yarn Berry's "fail if the lockfile would change" mode,
 * the parallel of pnpm's --frozen-lockfile. Classic Yarn (v1) doesn't understand --immutable and errors;
 * that error is SWALLOWED upstream (best-effort) and the worker installs on its own, so we don't probe the
 * yarn version on the spawn hot path. Mirrors {@link pnpmInstall}'s best-effort + bounded posture.
 */
function yarnInstall(worktreePath: string, timeoutMs: number): Promise<{ ok: boolean; reason?: string }> {
  return runBoundedInstall("yarn install --immutable", worktreePath, timeoutMs);
}

/** Real bounded installer per detected package manager. The {@link ProvisionDeps.provision} seam overrides this. */
const INSTALLERS: Record<PackageManager, (worktreePath: string, timeoutMs: number) => Promise<{ ok: boolean; reason?: string }>> = {
  pnpm: pnpmInstall,
  npm: npmInstall,
  yarn: yarnInstall,
};

/**
 * Which JS package manager owns this worktree, by LOCKFILE MARKER at the worktree root — the same
 * marker-in-the-tree signal as the original pnpm-only gate, just broadened. DETERMINISTIC precedence when
 * several coexist: pnpm (pnpm-lock.yaml) → npm (package-lock.json) → yarn (yarn.lock). Returns null when no
 * recognized lockfile is present (the bare temp repos in tests, a non-JS repo) → provisioning is a no-op.
 */
function detectPackageManager(worktreePath: string): PackageManager | null {
  if (fs.existsSync(path.join(worktreePath, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(worktreePath, "package-lock.json"))) return "npm";
  if (fs.existsSync(path.join(worktreePath, "yarn.lock"))) return "yarn";
  return null;
}

/**
 * Is `worktreePath` the root of a JS WORKSPACE MONOREPO (as opposed to a single-package repo) for
 * `manager`? A plain install never builds workspace packages, so a monorepo worktree needs an
 * ADDITIONAL build step (see {@link provisionWorktreeDeps}) before sibling packages' `dist` output
 * exists — without it a fresh worktree hits `ERR_MODULE_NOT_FOUND … <pkg>/dist/…` on the worker's first
 * gate run, forcing a manual shared→dependent build before anything else can proceed.
 *
 * Detected via each tool's OWN standard workspace marker, matching {@link detectPackageManager}'s
 * marker-in-the-tree style: pnpm uses a `pnpm-workspace.yaml` file at the root; npm and yarn both use a
 * `"workspaces"` field in the root `package.json` (array form, or yarn's `{packages: [...]}` object
 * form). Fails CLOSED (returns false) on any read/parse error — a missing/malformed `package.json` is
 * simply not a detectable workspace root, never a reason to throw past provisioning.
 */
function isWorkspaceMonorepo(worktreePath: string, manager: PackageManager): boolean {
  if (manager === "pnpm") return fs.existsSync(path.join(worktreePath, "pnpm-workspace.yaml"));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktreePath, "package.json"), "utf8")) as { workspaces?: unknown };
    return Array.isArray(pkg.workspaces) || (typeof pkg.workspaces === "object" && pkg.workspaces !== null);
  } catch {
    return false;
  }
}

/**
 * HARDCODED, best-effort monorepo BUILD command per package manager — run AFTER a successful install so
 * sibling workspace packages' `dist` output exists before a worker's gate runs. `pnpm build` is the exact
 * top-level command this repo's own CLAUDE.md documents (turbo's `^build` dependency order builds
 * `shared` first); `npm run build --if-present` and `yarn build` invoke the SAME root `package.json`
 * "build" script for their respective tools — `--if-present` keeps npm from hard-failing when a repo has
 * no root build script, while a missing script under yarn/pnpm degrades the same way through
 * {@link provisionWorktreeDeps}'s existing best-effort catch. ALWAYS a hardcoded constant, keyed only by
 * the DETECTED manager — never agent input.
 */
const WORKSPACE_BUILD_COMMANDS: Record<PackageManager, string> = {
  pnpm: "pnpm build",
  npm: "npm run build --if-present",
  yarn: "yarn build",
};

/** Make a freshly-created worktree BUILD-READY: install deps, then (on a JS workspace monorepo) build so
 *  sibling packages' `dist` exists — best-effort + bounded in two phases (install; build, only after a
 *  successful install, only on a workspace root, only when `runBuild !== false`). ⛔ NEVER
 *  share/symlink/junction node_modules across worktrees (native modules + concurrent install-state would
 *  break) — see CLAUDE.md's "Worktree dep-provisioning". MUST NEVER throw past createWorktree. */
export async function provisionWorktreeDeps(worktreePath: string, deps: ProvisionDeps = {}): Promise<void> {
  const manager = detectPackageManager(worktreePath);
  if (!manager) return; // no recognized JS lockfile → nothing to provision
  const timeoutMs = deps.timeoutMs ?? PROVISION_TIMEOUT_MS;
  const run = deps.provision ?? INSTALLERS[manager];
  let installOk = false;
  const installStartedAt = logProvisionStart("install", manager, worktreePath);
  try {
    const res = await run(worktreePath, timeoutMs, manager);
    installOk = res.ok;
    if (res.ok) logProvisionSuccess("install", manager, worktreePath, installStartedAt);
    else logProvisionFailure("install", manager, worktreePath, res.reason ?? "unknown reason", installStartedAt);
  } catch (e) {
    // A provisioner should never throw, but belt-and-suspenders: a throw here must NOT abort createWorktree.
    logProvisionFailure("install", manager, worktreePath, (e as Error).message, installStartedAt);
  }

  if (!installOk || !isWorkspaceMonorepo(worktreePath, manager)) return;
  // @decision 503cd822 — this is the actual gate: skip the BUILD phase only, never the INSTALL above it —
  // a no-commit review rig still needs node_modules to read/run the repo even when reviewDiffNeedsBuild
  // (checked by the caller before setting runBuild:false) says the reviewed diff needs no build.
  if (deps.runBuild === false) return; // build-free rig (e.g. a noCommit review role) — install only, skip the monorepo build

  const buildTimeoutMs = deps.buildTimeoutMs ?? PROVISION_BUILD_TIMEOUT_MS;
  const buildRunner = deps.build ?? ((wt: string, ms: number, mgr: PackageManager) => runBoundedInstall(WORKSPACE_BUILD_COMMANDS[mgr], wt, ms));
  const buildStartedAt = logProvisionStart("build", manager, worktreePath);
  try {
    const res = await buildRunner(worktreePath, buildTimeoutMs, manager);
    if (res.ok) logProvisionSuccess("build", manager, worktreePath, buildStartedAt);
    else logProvisionFailure("build", manager, worktreePath, res.reason ?? "unknown reason", buildStartedAt);
  } catch (e) {
    // A builder should never throw, but belt-and-suspenders: a throw here must NOT abort createWorktree.
    logProvisionFailure("build", manager, worktreePath, (e as Error).message, buildStartedAt);
  }
}

/** @decision 82b4d9ac — log START/OK/FAILED as a matched triple per phase, never failure-only — a
 *  completed window must be distinguishable from one that never ran. Plain console log, not an
 *  `orchestration_event` row: this call site runs before any worker session row exists to key one on. */
function logProvisionStart(stage: "install" | "build", manager: PackageManager, worktreePath: string): number {
  const startedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[worktree:provision:START] ${manager} ${stage} for ${worktreePath} at ${new Date(startedAt).toISOString()}`);
  return startedAt;
}

/** Success counterpart to {@link logProvisionStart} — see its doc comment for why this is a plain log,
 *  not an `orchestration_event`. Emitted on EVERY successful phase (the gap this card fixes: the old
 *  code logged nothing at all on success, making a completed provisioning window indistinguishable from
 *  one that never ran). Carries both endpoints' ISO timestamps plus the derived duration. */
function logProvisionSuccess(stage: "install" | "build", manager: PackageManager, worktreePath: string, startedAt: number): void {
  const endedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[worktree:provision:OK] ${manager} ${stage} for ${worktreePath} started ${new Date(startedAt).toISOString()} ended ${new Date(endedAt).toISOString()} (${endedAt - startedAt}ms)`);
}

/**
 * CLASSIFIED, LOUD failure log for one provisioning phase (install or the monorepo build step) — the fix
 * for the old silent `console.warn`, which gave no signal that a worktree shipped un-build-ready. Names
 * the exact phase + detected package manager + worktree path, the worker-facing consequence, and the
 * underlying reason — which for a real command failure already carries a captured stdout+stderr TAIL
 * (see {@link appendTail}/{@link formatTail}), mirroring the markitdown provisioning-status pattern: a
 * specific classified reason plus enough context to diagnose without re-running the command by hand.
 * `console.error` (not `.warn`) so it isn't lost among the daemon's routine warnings. Still purely a log
 * — this never throws or blocks {@link provisionWorktreeDeps}/createWorktree. `startedAt` (from {@link
 * logProvisionStart}) lets a failure's window be read directly too — the same START/OK-pair shape,
 * just with a reason instead of an OK.
 */
function logProvisionFailure(stage: "install" | "build", manager: PackageManager, worktreePath: string, reason: string, startedAt: number): void {
  const endedAt = Date.now();
  const consequence = stage === "install"
    ? "the worker will install its own dependencies before it can build"
    : "the worker will build sibling workspace packages (e.g. a monorepo's shared package) itself before its gate can pass";
  // eslint-disable-next-line no-console
  console.error(`[worktree:provision:FAILED] ${manager} ${stage} for ${worktreePath} started ${new Date(startedAt).toISOString()} ended ${new Date(endedAt).toISOString()} (${endedAt - startedAt}ms) — did not complete — ${consequence}.\nReason: ${reason}`);
}

/**
 * Decide whether {@link recutStaleReusedBranch} may run its DESTRUCTIVE `reset --hard`, from the raw
 * `git rev-list --count <mainSha>..<branch>` output. Re-cut is safe ONLY when the branch is provably 0
 * commits ahead of current main (an empty/stale branch). FAIL SAFE: an unparseable / non-finite count
 * (NaN) — OR any positive count — means the branch MAY carry real unmerged recovery work, so we must NOT
 * reset. The prior `parseInt(...) || 0` collapsed a NaN to 0 and then reset anyway, so a single malformed
 * count would DESTROY a recovery branch's work (the recovery invariant is load-bearing). PURE (no I/O) so
 * the fail-safe gate is unit-testable without git.
 */
export function mayRecutOntoMain(aheadRaw: string): boolean {
  const ahead = parseInt(aheadRaw.trim(), 10);
  return Number.isFinite(ahead) && ahead === 0;
}

// @decision 13cc2300 — re-cutting a stale (0-ahead) reused branch onto main is deliberate and destructive
// (the fix for the 2026-06-04 stale-base bug); a >0-ahead recovery branch is NEVER reset/re-cut — the
// recovery flow relies on branch reuse being preserved; this is load-bearing.
async function recutStaleReusedBranch(
  repoPath: string, worktreePath: string, branch: string, deps: BoundedGitDeps = {},
): Promise<{ recut: boolean; discardedOnRecut?: DiscardedOnRecutInfo }> {
  const { git: repoGit, timeoutMs: repoTimeoutMs } = boundedGit(repoPath, deps);
  const mainSha = (await withTimeout(repoGit.raw(["rev-parse", "HEAD"]), repoTimeoutMs, "git rev-parse HEAD")).trim();
  // @decision 56c10535 — resolve the tip via resolveBranchTip's EXACT lookup, count against that SHA
  // (never a `refs/heads/<branch>` string — DWIM-reachable when the branch is missing); unresolvable
  // is treated the same as an unparseable count below — never re-cut.
  const branchTip = await resolveBranchTip(repoPath, branch, deps);
  if (!branchTip) return { recut: false };
  // @decision 4b559feb — `--end-of-options` before the range: both sides are resolved shas, but an
  // option-shaped value would otherwise be re-entered into rev-list's own option parser.
  const aheadRaw = await withTimeout(
    repoGit.raw(["rev-list", "--count", "--end-of-options", `${mainSha}..${branchTip}`]), repoTimeoutMs, "git rev-list --count (ahead of main)",
  );
  // FAIL SAFE: only re-cut a PROVABLY-empty branch (0 ahead). A recovery branch (>0 ahead) OR a malformed/
  // unparseable count (NaN) → leave the branch EXACTLY as-is; never let a bad count fall through to the
  // DESTRUCTIVE reset below (the `|| 0`-treats-NaN-as-0 data-loss footgun). See {@link mayRecutOntoMain}.
  if (!mayRecutOntoMain(aheadRaw)) return { recut: false };
  // Snapshot what's about to be destroyed BEFORE the reset — see this function's own doc above.
  const discardedOnRecut = await captureDiscardedOnRecut(worktreePath, deps);
  // Empty/stale branch → re-cut its pointer + checkout onto current main (SHA, never a branch name).
  // @decision 356538ef — `nonInteractiveEnv()`, not `localNonInteractiveEnv()`: canonicalGit's env-less
  // transport-key strip is now unconditional, so an explicit non-stripped env keeps GIT_ASKPASS/
  // GIT_SSH_COMMAND available for an implicit LFS smudge this reset's checkout may trigger.
  // @decision 3a5c5d4a (round 4, B-1) — `repoPath`'s resolved TOPLEVEL threaded explicitly as
  // `trustedMainRoot` ONLY (never bare `repoPath`); `quarantineRepoPath` (position 8) stays at its own
  // unchanged default.
  await killableCanonicalRaw(worktreePath, ["reset", "--hard", mainSha], repoTimeoutMs, "git reset --hard (recut stale reused branch)", deps.gitFactory, nonInteractiveEnv(), undefined, undefined, undefined, defaultTrustedMainRoot(repoPath));
  // @decision 0eaaa693 — `recut:true` here is what later licenses WorktreeInfo.cutBaseAdvanced: this
  // branch's tip was just reset to mainSha, so its cut base genuinely advances to it.
  return { recut: true, discardedOnRecut };
}

/** Cap on {@link ReusedDirtyWorktreeInfo.statusSummary} (and its {@link DiscardedOnRecutInfo} twin) —
 *  enough for a manager (or an injected worker kickoff note) to see real leftover changes without growing
 *  the spawn result/prompt unboundedly. */
const REUSED_DIRTY_SUMMARY_MAX_LINES = 30;
const REUSED_DIRTY_SUMMARY_MAX_CHARS = 2000;

/** Bound + shape a real-work file list into the {@link ReusedDirtyWorktreeInfo}/{@link
 *  DiscardedOnRecutInfo} triple (they're the same type — see that type's own doc) — the ONE place both
 *  {@link detectReusedDirtyWorktree} and {@link captureDiscardedOnRecut} apply {@link
 *  REUSED_DIRTY_SUMMARY_MAX_LINES}/{@link REUSED_DIRTY_SUMMARY_MAX_CHARS}, so the two can never apply that
 *  bound differently. `undefined` on an empty list — "nothing to report" is never a zero-length summary. */
function summarizeDirtyFiles(files: string[]): ReusedDirtyWorktreeInfo | undefined {
  if (files.length === 0) return undefined;
  let truncated = files.length > REUSED_DIRTY_SUMMARY_MAX_LINES;
  let statusSummary = files.slice(0, REUSED_DIRTY_SUMMARY_MAX_LINES).join("\n");
  if (statusSummary.length > REUSED_DIRTY_SUMMARY_MAX_CHARS) {
    statusSummary = statusSummary.slice(0, REUSED_DIRTY_SUMMARY_MAX_CHARS);
    truncated = true;
  }
  return { statusSummary, fileCount: files.length, truncated };
}

/**
 * Read-only check (board card 2250836c) for the `fs.existsSync(worktreePath)` REUSE branch of {@link
 * createWorktree}: does this retained worktree still carry real leftover uncommitted work? Called AFTER
 * {@link recutStaleReusedBranch} has already run, so it reports whatever is genuinely still dirty once the
 * existing reuse lifecycle has had its say — this function itself never writes to the tree, only reads
 * `git status --porcelain` and reuses {@link uncommittedWorkFiles}'s daemon-noise filter (so injected
 * `.claude/` churn never false-positives a clean reuse as dirty).
 *
 * FAILS SAFE: any git error/timeout is read as "not dirty" (`undefined`) rather than blocking the spawn —
 * the worst case is a missed flag, never a spawn failure. BOUNDED (card c801d688) via {@link boundedGit}/
 * {@link withTimeout} — a timeout falls into the same catch-all below as any other git error, so bounding
 * this changes nothing about the existing fail-safe semantics, only the ceiling before they kick in.
 */
async function detectReusedDirtyWorktree(worktreePath: string, deps: BoundedGitDeps = {}): Promise<ReusedDirtyWorktreeInfo | undefined> {
  try {
    const { git, timeoutMs } = boundedGit(worktreePath, deps);
    const porcelainZ = await withTimeout(
      git.raw(["-c", "core.quotePath=false", "status", "--porcelain", "-z"]), timeoutMs, "git status --porcelain -z",
    );
    return summarizeDirtyFiles(uncommittedWorkFiles(porcelainZ));
  } catch {
    return undefined; // FAIL SAFE — a status-check hiccup must never block or alter the spawn
  }
}

/**
 * Board card 13cc2300 — the {@link uncommittedWorkFiles} paths a `git reset --hard` will actually revert:
 * TRACKED entries only (status not `??`). An untracked file is untouched by `reset --hard` and survives
 * it, so it must never be reported as "discarded" — that distinction is the whole point of this filter
 * existing separately from {@link uncommittedWorkFiles} itself. Implemented as a POST-filter on that
 * function's own already-daemon-noise-filtered output (re-parsing the SAME `-z` records via
 * {@link parsePorcelainStatusZ} — card 8cc047d3, replacing a hand-rolled v1-text dequote that would
 * otherwise disagree with {@link uncommittedWorkFiles}'s now-lossless paths) rather than a parallel
 * parsing loop, so the two can never drift on what counts as daemon noise vs. real work — only the
 * tracked/untracked split is new here. A rename/copy's OLD half is tracked too (it existed in HEAD).
 */
function discardedByResetFiles(porcelainZ: string): string[] {
  const tracked = new Set<string>();
  for (const e of parsePorcelainStatusZ(porcelainZ)) {
    if (e.untracked) continue; // `??` — reset --hard leaves it untouched
    if (e.oldPath) tracked.add(e.oldPath);
    tracked.add(e.path);
  }
  return uncommittedWorkFiles(porcelainZ).filter((p) => tracked.has(p));
}

/**
 * Board card 13cc2300 — the pre-recut twin of {@link detectReusedDirtyWorktree}: same read (`git status
 * --porcelain -z`), same bound ({@link summarizeDirtyFiles}), same FAIL-SAFE posture (a capture hiccup
 * reads as "nothing to report", never blocking or altering the caller's reset) — but filtered through
 * {@link discardedByResetFiles} instead of {@link uncommittedWorkFiles}, so it names only what a `reset
 * --hard` actually destroys (tracked work), never an untracked leftover that will survive the reset
 * untouched. Called by {@link recutStaleReusedBranch} IMMEDIATELY BEFORE that reset — the only moment
 * this is still true to read.
 */
async function captureDiscardedOnRecut(worktreePath: string, deps: BoundedGitDeps = {}): Promise<DiscardedOnRecutInfo | undefined> {
  try {
    const { git, timeoutMs } = boundedGit(worktreePath, deps);
    const porcelainZ = await withTimeout(
      git.raw(["-c", "core.quotePath=false", "status", "--porcelain", "-z"]), timeoutMs, "git status --porcelain -z",
    );
    return summarizeDirtyFiles(discardedByResetFiles(porcelainZ));
  } catch {
    return undefined; // FAIL SAFE — a capture hiccup must never block or alter the reset
  }
}

/** Cap on {@link StaleBaseInfo.changedFiles} — enough for a worker kickoff note to see the scope of
 *  what changed without growing the spawn result/prompt unboundedly. */
const STALE_BASE_FILES_MAX = 30;

/** @decision 5150fdc2 — detect + auto-forward a reused/reattached branch whose base has fallen behind
 *  main (a recovery branch recutStaleReusedBranch correctly left untouched); purely advisory — an error
 *  past the count read must read as "not stale," never block or alter a spawn. */
async function detectStaleBase(repoPath: string, branch: string, mainSha: string, deps: BoundedGitDeps = {}): Promise<StaleBaseInfo | undefined> {
  const behindBy = await countCommitsBehind(repoPath, branch, mainSha, deps);
  if (!behindBy || behindBy <= 0) return undefined;
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // @decision 868e0135 — `--end-of-options` right after "merge-base": mainSha is always rev-parse-derived; the other arg is already refs/heads/-qualified.
    const baseSha = (await withTimeout(git.raw(["merge-base", "--end-of-options", `refs/heads/${branch}`, mainSha]), timeoutMs, "git merge-base")).trim();
    // @decision 4b559feb — `--end-of-options` before the first bare ref positional: both are resolved
    // shas, but an option-shaped value would otherwise be re-entered into diff's own option parser.
    const filesRaw = await withTimeout(git.raw(["diff", "--name-only", "--end-of-options", baseSha, mainSha]), timeoutMs, "git diff --name-only");
    const allFiles = filesRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return {
      baseSha, behindBy,
      changedFiles: allFiles.slice(0, STALE_BASE_FILES_MAX),
      truncated: allFiles.length > STALE_BASE_FILES_MAX,
    };
  } catch {
    return undefined;
  }
}

/**
 * Card 5150fdc2 part 3 — OPTIONAL auto-forward for a stale reused/reattached branch, attempted ONLY when
 * {@link detectStaleBase} found real staleness. Reuses {@link mergeMainIntoWorktree} VERBATIM — the exact
 * clean-merge-only, abort-on-conflict-or-failure primitive `confirmWorkerMerge`'s own union-merge already
 * uses (card c0aeb5b2) — rather than reimplementing it. NEVER rebases (that would rewrite the retained
 * history {@link mayRecutOntoMain}'s 0-ahead fail-safe exists to protect) and never forces past a conflict:
 * `mergeMainIntoWorktree` itself aborts cleanly (no `MERGE_HEAD`, no partial index) on anything but a clean
 * merge, leaving the worktree byte-identical to before this call.
 *
 * Returns `undefined` on a clean forward (branch now carries main's tip — merge-base == main HEAD — so
 * there's nothing left to tell the worker/manager); returns the ORIGINAL `info` unchanged on a conflict or
 * any other failure, so the caller still surfaces it (never silent either way).
 */
async function autoForwardStaleBase(
  repoPath: string, worktreePath: string, info: StaleBaseInfo,
): Promise<StaleBaseInfo | undefined> {
  const forward = await mergeMainIntoWorktree(repoPath, worktreePath);
  if (forward.ok) {
    // eslint-disable-next-line no-console
    console.log(`[worktree:stale-base] auto-forwarded ${worktreePath} — was ${info.behindBy} commit(s) behind (fork ${info.baseSha}), now caught up to main`);
    return undefined;
  }
  return info;
}

/** Combines {@link detectStaleBase} + the optional {@link autoForwardStaleBase} for ONE reuse/reattach
 *  path of {@link createWorktree} (card 5150fdc2, parts 1+3). `deps` threads only to {@link
 *  detectStaleBase} — {@link autoForwardStaleBase}'s `mergeMainIntoWorktree` call is a separate,
 *  already-settled bounding question (card c801d688 scope) and is untouched here.
 *
 *  `forwarded` (card 047af53b item 4) is a SEPARATE signal from the returned `staleBase`, because
 *  `staleBase` is `undefined` on BOTH "never stale" and "successfully forwarded" (see its own doc) — a
 *  caller that needs to know specifically "did a real file mutation via {@link mergeMainIntoWorktree} just
 *  happen, possibly bringing in a package.json/lockfile change" cannot derive that from `staleBase` alone. */
async function resolveStaleBase(
  repoPath: string, worktreePath: string, branch: string, mainSha: string, deps: BoundedGitDeps = {},
): Promise<{ staleBase: StaleBaseInfo | undefined; forwarded: boolean }> {
  const info = await detectStaleBase(repoPath, branch, mainSha, deps);
  if (!info) return { staleBase: undefined, forwarded: false };
  const after = await autoForwardStaleBase(repoPath, worktreePath, info);
  return { staleBase: after, forwarded: after === undefined };
}

/**
 * Create (or re-attach) an isolated git worktree for a worker (phase-2 §A5): a checkout under
 * ~/.loom/worktrees on branch `loom/<key>` off the repo's current HEAD. Worktrees share the repo's
 * object store (cheap) and live outside the repo so parallel workers can't corrupt one tree.
 *
 * TOLERANT of a pre-existing branch/worktree (H1.2) — re-spawning a worker on a task whose merge
 * was rejected (worktree + branch intentionally retained) must NOT fatal with "already exists":
 *   - worktree dir present  → reuse it as-is (the retained checkout carries the worker's changes);
 *   - branch present, dir gone → attach a fresh worktree to the existing branch (no -b);
 *   - neither               → fresh worktree on a new branch (-b).
 *
 * For BOTH reuse paths, an EMPTY/STALE branch (0 commits ahead of current main) is re-cut onto main
 * first (see {@link recutStaleReusedBranch}); a branch carrying unmerged work (recovery) is left
 * untouched. The fresh `-b` path already cuts off current HEAD, so it needs no re-cut.
 *
 * @decision 13cc2300 — that re-cut is DELIBERATELY destructive, not a bug: don't make it non-destructive
 * without updating the recovery contract it protects. What it destroys is only ever REPORTED
 * (`discardedOnRecut`, snapshotted just before the reset), never prevented — the trade is intentional.
 *
 * @decision 49136451 — `repoKey` adds a repo axis to the worktree dir only for a non-primary repo; never add
 * one to the branch name (branches are already a per-repo namespace). Omitted/`undefined`/`"primary"` must keep
 * the ORIGINAL 2-segment path — a live worktree from before this param existed must survive a daemon upgrade.
 */
export async function createWorktree(
  repoPath: string, projectId: string, taskId: string, deps: ProvisionDeps = {}, repoKey?: string | null,
  /**
   * OPTIONAL branch name (or sha) to cut a FRESH branch FROM, instead of the repo's current HEAD — the
   * review-spawn mechanism (card 47bbdc3f): a review-only worker's own branch starts at the TIP of the
   * branch under review, so its worktree's content is byte-identical to what's being reviewed at spawn
   * time, instead of ~mainline. Omitted (every caller before this existed, and every non-review spawn)
   * is BYTE-IDENTICAL to before — the branch still forks the repo's current HEAD. Only consulted on the
   * FRESH branch-cut path (worktree dir doesn't exist AND the branch name doesn't already exist) — a
   * review spawn always keys off a brand-new claimKey, so it can never hit the reuse/reattach paths below,
   * which stay untouched. `mainSha` in the returned {@link WorktreeInfo} is STILL the repo's actual current
   * HEAD either way (used by the staleness machinery below), not `forkFrom`'s own tip — callers that need
   * the review branch's tip resolve it themselves before calling (see `spawnWorker`'s `reviewForkFrom`).
   */
  forkFrom?: string,
  /**
   * Injectable seam (card c801d688) for the git ops createWorktree's OWN body performs directly (the
   * `mainSha` rev-parse, and the prune/branch-list/worktree-add sequence below) — threaded on to {@link
   * recutStaleReusedBranch}/{@link detectReusedDirtyWorktree}/{@link resolveStaleBase} too, so a test can
   * inject one hanging `gitFactory` and prove every one of this function's six bare git call sites
   * returns within a bound instead of hanging the spawn path forever. Defaults to the real bounded git
   * (see {@link boundedGit}) — every existing caller (there is exactly one, `sessions/service.ts`
   * `spawnWorker`) is byte-identical when omitted.
   */
  gitDeps: BoundedGitDeps = {},
): Promise<WorktreeInfo> {
  // Card c684d00d — diagnostic-only phase marker (see BoundedGitDeps.onPhase's own doc). `atMs` is
  // elapsed time since THIS call began, not wall-clock — never let a throwing observer break the cut.
  const createWorktreeStartedAt = Date.now();
  const firePhase = (phase: string): void => {
    if (!gitDeps.onPhase) return;
    try { gitDeps.onPhase(phase, Date.now() - createWorktreeStartedAt); } catch { /* observer must never break a worktree cut */ }
  };
  // @decision c684d00d — every throw path below must emit ONE terminal phase (never hand-add a firePhase
  // before each throw site instead of this wrap) — see the decision record for why a start-only marker
  // misreads a completed-then-threw step as a hang.
  try {
    return await doCut();
  } catch (err) {
    firePhase(`threw:${err instanceof Error ? `${err.constructor.name}:${err.message.slice(0, 160)}` : String(err).slice(0, 160)}`);
    throw err;
  }

  async function doCut(): Promise<WorktreeInfo> {
  // QUARANTINE CHECK — kept here (round 6: not deleted as a "copy-pasted assert the lock now covers")
  // because the REUSE path below (`recutStaleReusedBranch`/`resolveStaleBase` when `worktreePath` already
  // exists) never calls `withCanonicalIndexLock` at all — it mutates the WORKTREE's own index via `git
  // reset --hard`/`mergeMainIntoWorktree`, not the canonical repo's, so the lock-level check the fresh-cut
  // path below now ALSO gets (via its own `withCanonicalIndexLock` call) would never fire for a reuse. This
  // function has no `{ok:false}` refusal shape (every existing caller treats it as throw-or-succeed), so a
  // quarantined repo refuses the same way every other failure here already does.
  const quarantineCheck = assertRepoNotQuarantined(repoPath);
  if (!quarantineCheck.ok) throw new Error(quarantineCheck.reason);
  const { git: headGit, timeoutMs: headTimeoutMs } = boundedGit(repoPath, gitDeps);
  // Refuse a worktree cut (and the branch/merge that would follow it) whose RAW `repoPath`, OR whose
  // git-resolved TOPLEVEL, is Loom's own operational home (`LOOM_HOME`) or an ancestor of it — mirrors
  // `GitWriter.refuseIfOperationalHome` (git/writer.ts) EXACTLY: same path-relation-only predicate
  // (never `isOperationalVaultDir`'s content sniff — a descendant of LOOM_HOME with its own `.git`, e.g.
  // a `project_init`-created project nested under the workspace root, resolves its OWN toplevel and is
  // NOT refused), same fail-closed toplevel probe (only an affirmative "not a git repository" falls
  // through; a timeout/killed-child/other error refuses rather than risk a worktree inside LOOM_HOME/.git).
  // `git worktree add` (below) registers a new worktree AND a new branch ref under the repo's own
  // `.git` — a mutating call exactly like GitWriter's checkout/commit/createBranch — so it needs the
  // identical guard, checked BEFORE the mutating call (and before the read-only HEAD rev-parse next,
  // so neither git call below ever runs against an operational home).
  //
  // @decision 37e15c26 — this closes the git-worktree/merge half of the reserved-home hazard; the
  // session-start half (refusing any fresh session whose RESOLVED role is "manager" against a project
  // that resolves here) is a separate guard, `refuseManagerIntoReservedHome` (sessions/service.ts).
  if (isLoomHomeOrAncestor(repoPath)) throw new Error(OPERATIONAL_HOME_GIT_WRITE_ERROR);
  firePhase("toplevel-guard");
  try {
    const toplevel = (await withTimeout(
      headGit.raw(["rev-parse", "--show-toplevel"]), headTimeoutMs, "git rev-parse --show-toplevel (operational-home guard)",
    )).trim();
    if (toplevel && isLoomHomeOrAncestor(toplevel)) throw new Error(OPERATIONAL_HOME_GIT_WRITE_ERROR);
  } catch (e) {
    if (e instanceof Error && e.message === OPERATIONAL_HOME_GIT_WRITE_ERROR) throw e;
    if (!isNotAGitRepositoryError(e)) {
      throw new Error(`could not verify this repo's location; refusing to cut a worktree (${(e as Error).message})`);
    }
    // An affirmative "not a git repository" — there is genuinely no toplevel to check. Fall through;
    // the real rev-parse HEAD below fails on its own, clean terms (unchanged from before this guard).
  }
  const key = taskKey(taskId);
  const branch = `loom/${key}`;
  // @decision abbda4f5 — defense-in-depth against a FUTURE change in how `branch` is built: `--end-of-
  // options` can't close the `worktree add` call below (measured — it only steers WHICH commit a
  // dash-prefixed name detaches at), so entry-shape validation is the only fix for that call.
  const branchShapeReason = unsafeBranchNameShapeReasonImpl(branch);
  if (branchShapeReason) throw new Error(`refusing to cut a worktree: ${branchShapeReason}`);
  const worktreePath = resolveWorktreePath(projectId, taskId, repoKey);
  // Card c994ffeb — cut-time backstop against a repoKey spelled like (or, on a case-insensitive
  // filesystem, case-colliding with) a task's own 12-hex worktree-dir name. `validateRepoRegistry`
  // rejects this shape for a NEW repos key (projects/repos.ts), but a key grandfathered in via its own
  // `existingKeys` exemption carries no such protection — this is the independent, structural backstop
  // for that gap, checked on EVERY cut regardless of when the colliding key was registered, in BOTH
  // directions (whichever of the two colliding tasks happens to be cut second).
  if (worktreeCollisionBackstopEnabled) {
    if (repoKey && repoKey !== "primary") {
      // FORWARD: this task's own repo-axis dir (one level up from worktreePath) may already BE some
      // OTHER task's PRIMARY worktree (that task's taskKey === this repoKey) — nesting a secondary-repo
      // worktree inside it would silently plant it inside that other task's own checked-out tree.
      const axisDir = path.dirname(worktreePath);
      if (worktreeHasGitLink(axisDir)) {
        throw new Error(`repoKey "${repoKey}" collides with an existing task worktree at ${axisDir} (it already has its own .git link) — refusing to cut a secondary-repo worktree nested inside it`);
      }
    } else if (fs.existsSync(worktreePath) && !worktreeHasGitLink(worktreePath)) {
      // REVERSE: this PRIMARY task's own worktree dir may already BE a repo-axis dir (repoKey === this
      // task's own taskKey) holding real nested worktrees for OTHER tasks — the ordinary "exists with no
      // .git link" branch just below would otherwise mistake it for a half-removed orphan and rename the
      // whole thing (and everything live nested inside it) aside.
      const nestedChild = findNestedWorktreeLikeChild(worktreePath);
      if (nestedChild) {
        throw new Error(`${worktreePath} already exists and is not a half-removed orphan — it contains "${nestedChild}", itself a real git worktree (a taskKey-shaped name with its own .git link FILE) — refusing to cut a primary worktree over it`);
      }
    }
  }
  // The repo's CURRENT HEAD — the fork point this worktree's branch is (or was) cut off, captured up
  // front so it's correct for every path below (fresh cut, reuse, and reattach all fork off THIS sha).
  // BOUNDED (card c801d688): a hung rev-parse now throws within the bound instead of stalling the spawn
  // forever — this call has no local catch, so the throw propagates to createWorktree's own caller
  // exactly as an unbounded failure already did, just with a ceiling on how long that takes.
  firePhase("rev-parse-HEAD");
  const mainSha = (await withTimeout(headGit.raw(["rev-parse", "HEAD"]), headTimeoutMs, "git rev-parse HEAD")).trim();
  if (fs.existsSync(worktreePath) && !worktreeHasGitLink(worktreePath)) {
    // @decision a5d9c458 — never reuse/recut a dir with no `.git` link as if it were a retained
    // worktree; rename it aside (never delete) and fresh-cut instead.
    const rename = renameWorktreeDirAside(worktreePath);
    if (!rename.ok) {
      throw new Error(`${worktreePath} exists with no .git link (a half-removed orphan) and could not be renamed aside to ${rename.staleAside} (${rename.error!.message}) — refusing to reuse or overwrite it`);
    }
    // eslint-disable-next-line no-console
    console.warn(`[worktree] ${worktreePath} existed with no .git link (half-removed orphan) — renamed aside to ${rename.staleAside} (never deleted) and cutting a fresh worktree at the original path.`);
    // falls through to the fresh branch-cut path below — worktreePath is now clear.
  } else if (fs.existsSync(worktreePath)) {
    // Retained worktree → reuse (already provisioned). Re-cut an empty/stale branch onto current main
    // first; a recovery branch (unmerged work) is left exactly as-is. Board card 13cc2300: for a 0-ahead
    // branch this is exactly the DESTRUCTIVE step — recutStaleReusedBranch snapshots what it's about to
    // discard BEFORE the reset (the only moment it's still there), so it can still be reported below even
    // though detectReusedDirtyWorktree's own post-recut read (next) will find it already gone.
    const { recut: dirReuseRecut, discardedOnRecut } = await recutStaleReusedBranch(repoPath, worktreePath, branch, gitDeps);
    // Board card 2250836c: surface (never clean) any real leftover uncommitted work on this reused
    // worktree — read-only, runs after the recut above so it reports the ACTUAL post-recut state.
    const reusedDirtyWorktree = await detectReusedDirtyWorktree(worktreePath, gitDeps);
    // Card 5150fdc2 parts 1+3: a recovery (>0-ahead) branch whose base has since fallen behind main is
    // detected and, when possible, auto-forwarded — see resolveStaleBase. Runs AFTER the dirty-leftover
    // read above so that read reflects the PRE-merge state (the leftover uncommitted work a manager/
    // worker should see is whatever was there before Loom does anything else to the tree).
    const { staleBase, forwarded } = await resolveStaleBase(repoPath, worktreePath, branch, mainSha, gitDeps);
    // Card 047af53b item 4: this reused worktree's node_modules normally predates this call and needs no
    // reinstall ("already provisioned" — true for the ordinary case, unlike the reattach path below, which
    // always starts from an empty checkout). But a `forwarded` auto-forward is a REAL file mutation that
    // can bring in a package.json/lockfile change (same reasoning the reattach path's own
    // provisionWorktreeDeps ordering comment gives) — reinstall in exactly that case, best-effort + bounded
    // like every other provisionWorktreeDeps call, so a failure here never blocks the worktree return.
    // Card 1008e305: ALSO reinstall when node_modules is not INTACT (absent, or a partial/corrupted
    // residue left by a wedged reclaim attempt — see hasIntactNodeModules's own doc) — the node_modules
    // reclaimer (reclaimNodeModulesDir) can remove it from a retained-but-currently-dead worktree between
    // spawns, which invalidates the "already provisioned" assumption above for exactly this reuse path.
    // Without this, a worktree reused after a reclaim would silently ship with no (or partial) deps and
    // nothing to trigger installing them.
    if (forwarded || !hasIntactNodeModules(worktreePath)) await provisionWorktreeDeps(worktreePath, deps);
    firePhase("done");
    return {
      worktreePath, branch, mainSha, forkedFromReviewed: false, // reuse path — forkFrom was never consulted
      // @decision 0eaaa693 — advances the cut base ONLY when a real 0-ahead recut just reset this
      // branch onto mainSha; a retained >0-ahead recovery branch (dirReuseRecut:false) must not.
      cutBaseAdvanced: dirReuseRecut,
      ...(discardedOnRecut ? { discardedOnRecut } : {}),
      ...(reusedDirtyWorktree ? { reusedDirtyWorktree } : {}),
      ...(staleBase ? { staleBase } : {}),
    };
  }

  // BOUNDED (card c801d688) — same rationale as the rev-parse above: no local catch, so a timeout
  // propagates exactly like any other git failure already did, just bounded instead of unbounded.
  const timeoutMs = gitDeps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  // @decision f2c976ea — `add` alone gets its own, larger budget (see WORKTREE_ADD_TIMEOUT_MS's own doc);
  // `prune`/`branch --list` below stay on `timeoutMs`, unchanged.
  const addTimeoutMs = gitDeps.addWorktreeTimeoutMs ?? WORKTREE_ADD_TIMEOUT_MS;
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  // @decision 2fcd5eae — serialize prune -> branch --list -> add per canonical repo under
  // withCanonicalIndexLock; never wrap provisionWorktreeDeps in it (an install can take minutes and would
  // serialize every spawn behind it).
  //
  // Release the lock only once the child is confirmed dead — never on a
  // bare withTimeout race.
  const boundedLockedRaw = (args: string[], label: string, ms: number = timeoutMs): Promise<string> =>
    killableCanonicalRaw(repoPath, args, ms, label, gitDeps.gitFactory);
  // @decision 62c4953a — deliberately NO `checkIndexLock`: a held lock must never block a worker/review
  // spawn (`worktree prune`/`branch --list`/`worktree add` all work fine with one present, real git 2.47).
  const branchExists = await withCanonicalIndexLock(repoPath, async () => {
    firePhase("prune");
    await boundedLockedRaw(["worktree", "prune"], "git worktree prune"); // drop any stale admin record for a since-deleted dir
    firePhase("branch-list");
    // @decision 7eac6366 — `--end-of-options` must sit immediately before the bare `branch` token, never
    // before `--list`/`-D` themselves (there it is swallowed as the branch name instead, measured).
    const exists = (await boundedLockedRaw(["branch", "--list", "--end-of-options", branch], "git branch --list")).trim() !== "";
    try {
      firePhase("worktree-add");
      // git >= 2.48 CAN write a relative gitdir/commondir pointer (checkCommondirTrust now correctly
      // verifies one — see that function's own doc), but Loom's OWN worktrees should keep the
      // absolute-pointer shape already measured and trusted. Harmless on git < 2.48 (key unused there).
      // @decision 3a5c5d4a (round 3, S1) — a defense-in-depth belt, not a requirement of the fix itself.
      await boundedLockedRaw(exists
        ? ["-c", "worktree.useRelativePaths=false", "worktree", "add", worktreePath, branch]              // branch survived a worktree removal → re-attach
        : forkFrom
          ? ["-c", "worktree.useRelativePaths=false", "worktree", "add", worktreePath, "-b", branch, forkFrom] // review spawn → fresh branch off the reviewed tip
          : ["-c", "worktree.useRelativePaths=false", "worktree", "add", worktreePath, "-b", branch],          // fresh task → new branch off current HEAD
        "git worktree add", addTimeoutMs);
    } catch (addErr) {
      // @decision af436c99 — recognize git worktree add's own benign progress text (mistaken for failure by a
      // simple-git exitCode race) as success, only once independently confirmed landed via worktreeAddLanded;
      // never widen the pattern to swallow a real fatal:/error: line or a killed-child suffix.
      if (isBenignWorktreeAddNoise((addErr as Error).message ?? "")
        && (await worktreeAddLanded(worktreePath, branch, gitDeps))) {
        return exists;
      }
      // @decision 1a858805 — best-effort recovery of a locked .git/worktrees/ admin record left by a killed
      // `worktree add`, via `git worktree remove -f -f` — ONLY inside this SAME canonical lock, never outside
      // it (that would reopen the race the lock exists to close).
      //
      // @decision fdfe8a56 — SKIP that recovery when the add's child isn't confirmed dead (PATH-2 "giving up
      // (hung git child?)"): racing a possibly-still-alive child can wipe worktreePath's admin record while it
      // keeps writing, leaving no .git link — worse than a self-healing locked residue.
      //
      // ⛔ A cleanup failure here must NEVER throw past createWorktree or mask the ORIGINAL add error —
      // swallow it and rethrow addErr unchanged either way.
      // @decision d8bb2074 — a RepoQuarantinedError means `add` itself never spawned anything (the
      // per-call re-check refused it first) — nothing to clean up, and the cleanup call below would be
      // refused the SAME way, logging a spurious "cleanup also failed" warning for an intended refusal.
      if (addErr instanceof RepoQuarantinedError) throw addErr;
      const isPath2GiveUp = /giving up \(hung git child\?\)/.test((addErr as Error).message ?? "");
      if (!isPath2GiveUp) {
        firePhase("add-failure-cleanup");
        await boundedLockedRaw(["worktree", "remove", worktreePath, "-f", "-f"], "git worktree remove -f -f (add-failure cleanup)")
          .catch((cleanupErr: unknown) => {
            const cleanupMsg = (cleanupErr as Error).message;
            // "is not a working tree" is the COMMON, EXPECTED shape (addErr's add failed without ever
            // creating worktreePath — e.g. "already used by worktree at <other path>" — so there is
            // nothing here to remove); logging it as a warning on every such ordinary failure would be
            // noise on a log shared across every tenant on the host. Warn only on a genuinely unexpected
            // cleanup failure.
            if (!/is not a working tree/i.test(cleanupMsg)) {
              // eslint-disable-next-line no-console
              console.warn(`[worktree] best-effort locked-record cleanup after a failed worktree add also failed: ${cleanupMsg}`);
            }
          });
      }
      throw addErr;
    }
    return exists;
  });
  let staleBase: StaleBaseInfo | undefined;
  let reattachRecut = false;
  if (branchExists) {
    // Re-attached an existing branch at its old tip → same re-cut: empty/stale → current main; a
    // recovery branch (unmerged work) → untouched. This worktree dir did NOT exist a moment ago (the
    // `fs.existsSync` check above was false) — `git worktree add` just cut a FRESH checkout of the
    // branch's own committed tip, so there is structurally nothing dirty for the recut below to discard;
    // its `discardedOnRecut` return is intentionally not surfaced on this path (see {@link
    // WorktreeInfo.reusedDirtyWorktree}'s own doc: "a reattached-branch-only worktree (always a clean
    // fresh checkout)" — the same reasoning applies here).
    ({ recut: reattachRecut } = await recutStaleReusedBranch(repoPath, worktreePath, branch, gitDeps));
    // Card 5150fdc2 parts 1+3 — same detect+auto-forward as the dir-exists reuse path above, BEFORE
    // provisionWorktreeDeps below so a package.json/lockfile change the forward brings in is what
    // actually gets installed. `forwarded` is unused here (unlike the dir-exists path above) — this
    // branch's provisionWorktreeDeps call below is already unconditional, since a reattach always starts
    // from an empty checkout regardless of whether a forward also happened.
    ({ staleBase } = await resolveStaleBase(repoPath, worktreePath, branch, mainSha, gitDeps));
  }

  // Populate node_modules so the worker is build-ready without paying a full `pnpm install` first.
  // Best-effort + bounded; on failure the worker just installs on its own (see provisionWorktreeDeps).
  await provisionWorktreeDeps(worktreePath, deps);
  // @decision 37fe091c — true ONLY for the genuine `-b branch forkFrom` cut (branchExists false AND
  // forkFrom given); a reattach (branchExists true) never consulted forkFrom at all. See
  // WorktreeInfo.forkedFromReviewed's own doc for why a caller must gate reviewBaseSha stamping on this.
  const forkedFromReviewed = !branchExists && !!forkFrom;
  // @decision 0eaaa693 — a fresh `-b` cut always advances the cut base (branchExists false); a reattach
  // advances it only when recutStaleReusedBranch actually ran its reset (reattachRecut).
  const cutBaseAdvanced = !branchExists || reattachRecut;
  firePhase("done");
  return staleBase
    ? { worktreePath, branch, mainSha, staleBase, forkedFromReviewed, cutBaseAdvanced }
    : { worktreePath, branch, mainSha, forkedFromReviewed, cutBaseAdvanced };
  } // end doCut
}

/**
 * Delete a worker's branch after a merge (H1.1) — `git branch -D` (FORCE). Under SQUASH the branch is NOT
 * in main's ancestry (the squash lands the branch's *content* as a new commit, not the branch ref itself),
 * so the safe `git branch -d` would REFUSE it as "not fully merged". Force-delete is correct here because
 * deleteBranch is only ever reached AFTER a confirmed-successful squash commit (finalizeMerge from the
 * interactive merge OR boot-reconcile Pass A); the rejected merge paths return early WITHOUT deleting, so a
 * retained (rejected/recovery) branch keeps its work. Without this, re-spawning on the same task hit "a
 * branch named 'loom/…' already exists". Best-effort: the merge already succeeded, and createWorktree
 * tolerates a leftover branch anyway, so a delete hiccup is logged, not fatal.
 *
 * BOUNDED: called by finalizeMerge during boot-reconcile Pass A, so a hung `git branch -D` (busy ref
 * lock) must not wedge boot. The op runs through the same block-timeout + {@link withTimeout} guard;
 * a timeout-throw is swallowed + warned exactly like any other delete failure.
 */
export async function deleteBranch(repoPath: string, branch: string, deps: BoundedGitDeps & {
  /** COMPARE-AND-SWAP (card 42daa283): delete only if the branch still points at exactly this commit —
   *  `git update-ref -d refs/heads/<b> <expectedTip>` instead of `branch -D`. A tip that moved since the caller
   *  read it (a worker's late commit) makes git refuse, and the branch is RETAINED. Omitted ⇒ unchanged `branch -D`. */
  expectedTip?: string;
} = {}): Promise<boolean> {
  // QUARANTINE CHECK — kept here (round 6: this path CANNOT take `withCanonicalIndexLock`, so the lock-
  // level check doesn't cover it) — `git branch -D`/`update-ref -d` never routes through that lock (ref
  // deletion doesn't touch the index the lock protects), so this is its own convergence point. Fail closed
  // rather than silently no-op, so a caller (finalizeMerge, boot-reconcile) sees this as a real refusal
  // (`false`, matching the CAS-moved/retained shape below), never a false "already gone".
  if (!assertRepoNotQuarantined(repoPath).ok) return false;
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    // @decision d8bb2074 — deliberately NOT kill-confirmed (killableCanonicalRaw): `update-ref -d`/
    // `branch -D` are single, hook-free ref writes with no shared index to leave staged residue in — the
    // entry quarantine check above is the whole story for this path.
    if (deps.expectedTip) {
      await withTimeout(git.raw(["update-ref", "-d", `refs/heads/${branch}`, deps.expectedTip]), timeoutMs, "git update-ref -d (compare-and-swap)");
    } else {
      // @decision 7eac6366 — `--end-of-options` right before `branch`, never before `-D` (placed earlier
      // it is consumed as a flag instead of the bare name).
      await withTimeout(git.raw(["branch", "-D", "--end-of-options", branch]), timeoutMs, "git branch -D");
    }
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    // `branch '…' not found` is the DESIRED idempotent end state (the branch is already gone — e.g. a
    // re-run after a prior delete, or a never-created branch) — treat as success, no warn. Keep warning
    // on genuine failures (busy ref lock, timeout, etc.).
    if (/not found/i.test(msg)) return true;
    if (deps.expectedTip) {
      // The CAS refused. Distinguish "already gone" (idempotent success) from "moved" (RETAINED, returns false).
      // `--quiet` + no match prints nothing (simple-git resolves a silent non-zero exit), so read the OUTPUT.
      try {
        const cur = (await withTimeout(git.raw(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]), timeoutMs, "git rev-parse (deleteBranch CAS follow-up)")).trim();
        if (!cur) return true;
        // An UNMOVED tip means the CAS failed for some OTHER reason (ref lock, timeout): that is a plain delete
        // failure — reported by the generic warning below, never a bogus "moved" retain.
        if (cur !== deps.expectedTip) {
          // eslint-disable-next-line no-console
          console.warn(`[worktree] branch ${branch} RETAINED: tip is now ${cur.slice(0, 8)}, not the expected ${deps.expectedTip.slice(0, 8)} (${msg})`);
          return false;
        }
      } catch { /* fall through to the generic failure warning */ }
    }
    // eslint-disable-next-line no-console
    console.warn(`[worktree] could not delete merged branch ${branch}: ${msg}`);
    return true;
  }
}

/**
 * Does `branch` still exist in `repoPath`? Multi-repo epic (49136451) phase 2, Major 1 fix:
 * `checkTaskRepoKeyRebind` (projects/rebind.ts) uses this to tell whether a session bound to a task whose
 * worktree dir is already gone still has an undeleted branch (e.g. a retained-on-reject branch whose
 * worktree was separately force-removed) — either signal means the session is still physically rooted in
 * that repo and a `repoKey` retarget past it would risk the silent ship-state divergence the whole guard
 * exists to prevent. BOUNDED (mirrors {@link deleteBranch}/{@link findLandedSquashCommit}): a hung `git
 * branch --list` must not wedge the human/manager write path calling this. FAILS SAFE to `true` (treat as
 * still-existing, i.e. still blocking) on any git error/timeout — a check we can't complete must never be
 * read as "confirmed gone."
 */
export async function branchExistsInRepo(repoPath: string, branch: string, deps: BoundedGitDeps = {}): Promise<boolean> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // @decision 7eac6366 — `--end-of-options` right before `branch` (see git/worktrees.ts:1300 for the
    // full placement rule).
    const out = await withTimeout(git.raw(["branch", "--list", "--end-of-options", branch]), timeoutMs, "git branch --list");
    return out.trim() !== "";
  } catch {
    return true; // fail safe: can't confirm gone ⇒ treat as still present
  }
}

/** Chunk size for {@link deleteBranches}' batched `git branch -D <n1> <n2> ...` calls — a defensive cap
 *  against a pathological backlog (and, in principle, Windows's CreateProcess argv length limit; a
 *  realistic `loom/<12-hex>` name is ~17 chars, so 200 of them is nowhere near it). Never hit at today's
 *  measured 275-branch backlog (card 09f268a5) — this is headroom, not a tuned-for-today number. */
const DELETE_BRANCHES_CHUNK_SIZE = 200;

/** @decision 09f268a5 — batch `git branch -D` for large deletion backlogs (~14x faster at 275 branches);
 *  fall back to verified per-branch deletes only within a FAILED chunk, never abandon the whole chunk —
 *  git exits non-zero if any one branch failed, so a naive all-or-nothing read would undercount `deleted`. */
export async function deleteBranches(repoPath: string, branches: string[], deps: BoundedGitDeps = {}): Promise<{ deleted: string[] }> {
  // QUARANTINE CHECK — kept here (round 6: this path CANNOT take `withCanonicalIndexLock` either, same
  // reasoning as `deleteBranch`'s own check above). The BATCHED primary path below is also a SEPARATE git
  // call from `deleteBranch`'s own check (which only covers this function's per-branch FALLBACK), so this
  // needs its own. Refuse the whole call rather than a silent no-op.
  if (!assertRepoNotQuarantined(repoPath).ok) return { deleted: [] };
  const deleted: string[] = [];
  for (let i = 0; i < branches.length; i += DELETE_BRANCHES_CHUNK_SIZE) {
    const chunk = branches.slice(i, i + DELETE_BRANCHES_CHUNK_SIZE);
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    try {
      // @decision 7eac6366 — `--end-of-options` before the WHOLE chunk (one option-shaped name in the
      // batch must not be swallowed as a flag for the rest); see git/worktrees.ts:1300 for the rule.
      await withTimeout(git.raw(["branch", "-D", "--end-of-options", ...chunk]), timeoutMs, "git branch -D (batch)");
      deleted.push(...chunk); // git's own exit code 0 means every named branch in THIS chunk is gone
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[worktree] batched delete of ${chunk.length} branch(es) failed, falling back to ` +
        `per-branch deletes for this chunk only (one bad ref must not cost the rest): ${(e as Error).message}`);
      for (const b of chunk) {
        await deleteBranch(repoPath, b, deps);
        if (!(await branchExistsInRepo(repoPath, b, deps))) deleted.push(b);
      }
    }
  }
  return { deleted };
}

/** Directories a nested-repo scan never descends into — every one is bulk ephemeral build/dep output
 *  that never legitimately contains a nested clone (and can otherwise burn the whole scan budget before
 *  the walk ever reaches a real nested repo sitting alongside it); a worktree's own root `.git` linkage
 *  is not itself a finding either. */
const NESTED_REPO_SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next", "coverage"]);

/** Hard cap on directory entries visited by {@link findNestedGitRepos} — a pathological tree stops the
 *  scan rather than running unbounded. Hitting this is signalled via `truncated`, NOT silently reported
 *  as clean — see the doc below for why a truncated scan must never be treated as "nothing found". */
const NESTED_REPO_SCAN_MAX_ENTRIES = 20_000;

/** {@link findNestedGitRepos}'s result. `truncated:true` means the scan hit {@link
 *  NESTED_REPO_SCAN_MAX_ENTRIES} before finishing — `repos` is then only a PARTIAL result, and callers
 *  MUST fail safe (treat the worktree as if a nested repo were found) rather than trust an empty `repos`
 *  as "confirmed clean". */
export interface NestedRepoScanResult {
  repos: string[];
  truncated: boolean;
}

/** @decision b6d41db1 — scan a worker worktree for nested git repos before removal; a truncated scan
 *  (hit NESTED_REPO_SCAN_MAX_ENTRIES) MUST fail safe (treated as found), never as "confirmed clean" — a
 *  wide ordinary build-output sibling could otherwise exhaust the budget before reaching a real nested repo. */
export async function findNestedGitRepos(worktreePath: string): Promise<NestedRepoScanResult> {
  const repos: string[] = [];
  let visited = 0;
  let truncated = false;
  async function walk(dir: string): Promise<void> {
    if (visited >= NESTED_REPO_SCAN_MAX_ENTRIES) { truncated = true; return; }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= NESTED_REPO_SCAN_MAX_ENTRIES) { truncated = true; return; }
      visited++;
      if (!entry.isDirectory() || NESTED_REPO_SCAN_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const hasGit = await fs.promises.access(path.join(full, ".git")).then(() => true, () => false);
      if (hasGit) {
        repos.push(full);
        continue; // a repo's own tree needs no further descent
      }
      await walk(full);
    }
  }
  await walk(worktreePath);
  return { repos, truncated };
}

/** Result of one {@link killableRemoveDir} attempt. */
export interface RemoveDirResult {
  /** `target` is confirmed GONE from disk after this attempt. */
  removed: boolean;
  /**
   * The removal child was force-KILLED because it exceeded its timeout — i.e. genuinely WEDGED, as
   * opposed to a clean/settled failure (the child exited on its own, just not successfully: a transient
   * EBUSY/EPERM handle-lag). Callers use this to distinguish "worth a short, fast bounded retry right
   * here" (false) from "not worth retrying again THIS call — hand it to a slower, longer-lived retry
   * policy instead" (true; SessionService tracks it and retries it on a SLOW cadence, not forever-skip).
   */
  killed: boolean;
}

/** Injectable seam for the removal child itself (defaults to {@link defaultSpawnRemoveChild}). Lets a
 *  test substitute a REAL OS process that hangs forever — standing in for a genuinely wedged `rmdir`/
 *  `rm -rf` — so the KILL mechanism itself (not just removeWorktree's bounding) is proven end-to-end. */
export type SpawnRemoveChild = (target: string) => ChildProcess;

/** The real removal child: `rmdir /s /q` via cmd on win32 (a cmd built-in — no subprocess tree to
 *  track), `rm -rf` on posix. Args passed as an array (never a shell string) so `target` needs no
 *  manual quoting/escaping. */
function defaultSpawnRemoveChild(target: string): ChildProcess {
  return process.platform === "win32"
    ? spawn("cmd.exe", ["/c", "rmdir", "/s", "/q", target], { stdio: "ignore", windowsHide: true })
    : spawn("rm", ["-rf", target], { stdio: "ignore" });
}

/** Force-kill the removal child. `taskkill /T /F` on win32 additionally kills the process TREE (belt-
 *  and-suspenders in case the platform command ever spawns a subprocess); `SIGKILL` on posix cannot be
 *  caught/ignored, so both give an unconditional, immediate OS-level termination. */
function killRemoveChild(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* best effort */ }
  }
  try { child.kill("SIGKILL"); } catch { /* already gone / no permission */ }
}

/** @decision bd9fc808 — run directory removal in a killable CHILD PROCESS, never fs.promises.rm (libuv
 *  threadpool) — a wedged handle there leaks a threadpool slot forever, with no way to cancel it. Never loop
 *  a retry directly on a KILLED (wedged) removal in-process; hand it to the caller's slow-cadence retry. */
export function killableRemoveDir(
  target: string, timeoutMs: number, spawnChild: SpawnRemoveChild = defaultSpawnRemoveChild,
): Promise<RemoveDirResult> {
  return new Promise((resolve) => {
    if (!fs.existsSync(target)) { resolve({ removed: true, killed: false }); return; }
    let settled = false;
    const finish = (killed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ removed: !fs.existsSync(target), killed });
    };
    const child = spawnChild(target);
    const timer = setTimeout(() => { killRemoveChild(child); finish(true); }, timeoutMs);
    child.on("error", () => finish(false));
    child.on("exit", () => finish(false));
  });
}

/** `await`able delay — used by the short bounded clean-reject retries in {@link removeWorktree} and
 *  {@link removeDirWithCleanRetry}. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Attempts for a CLEAN (settled, non-hang) removal reject — a transient EBUSY/EPERM handle-lag right
 *  after a worker exits, which SETTLES quickly and is worth a couple of short retries. A genuinely
 *  wedged (killed) removal is NEVER looped — see {@link removeWorktree}. */
const REMOVE_DIR_CLEAN_RETRY_ATTEMPTS = 3;
const REMOVE_DIR_CLEAN_RETRY_DELAY_MS = 500;

/** Outcome of one {@link raceRemoval} attempt — a STRUCTURAL discrimination (which branch settled first/
 *  at all), never a message-string classification (see `git/bounded.ts`'s own `treeDeathUnconfirmed` doc
 *  for why sniffing error text is the wrong tool for exactly this kind of distinction).
 *
 * @decision c2fc8d84 — moved here from `projects/work-dir.ts`; do not re-inline a per-caller copy of
 * this discrimination again — every `killableRemoveDir` caller must share this ONE function.
 */
export type RemovalRaceOutcome =
  | { kind: "result"; result: RemoveDirResult }
  | { kind: "timeout" }
  | { kind: "rejected"; message: string };

/**
 * Races `p` against a plain timer, but — unlike `git/bounded.ts`'s generic `withTimeout` — never
 * conflates "my own timer fired" with "the underlying promise rejected for some other reason": a real
 * `killableRemoveDir` call can itself reject if its `spawnChild` throws SYNCHRONOUSLY inside the Promise
 * executor (e.g. a genuinely failed `spawn()`) — that is a removal that never even STARTED, not a wedge,
 * and must never be logged as one.
 *
 * @decision c2fc8d84 — never collapse `"timeout"` and `"rejected"` back into one message-string-free
 * `{removed:false,killed:true}` via a bare `.catch` — that reintroduces the "a never-started removal
 * gets logged as wedged" bug. Use `raceRemoval` at every `killableRemoveDir` call site.
 */
export function raceRemoval(p: Promise<RemoveDirResult>, ms: number): Promise<RemovalRaceOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, ms);
    p.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "result", result });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "rejected", message: err instanceof Error ? err.message : String(err) });
      },
    );
  });
}

/** {@link removeDirWithCleanRetry}'s result — carries enough for a caller to reconstruct its OWN warn
 *  wording (each call site keeps its own message/tag, per `c2fc8d84`'s review direction) without
 *  re-deriving the classification itself.
 *  - `"removed"` — success.
 *  - `"wedged"` — genuinely killed (either {@link raceRemoval}'s own outer timeout won the race, or
 *    `removeDir`'s OWN internal timeout fired first and resolved with `killed:true` — both mean the same
 *    thing to a caller: never retry, treat as wedged).
 *  - `"rejected"` — `removeDir` itself rejected (never started) rather than timing out; `rejectionMessage`
 *    carries the real error text.
 *  - `"clean-failure"` — every attempt settled (not killed, not rejected) but never actually removed the
 *    target; the retry budget is exhausted. */
export interface RemoveDirCleanRetryOutcome {
  result: RemoveDirResult;
  kind: "removed" | "wedged" | "rejected" | "clean-failure";
  rejectionMessage?: string;
}

/** Options for {@link removeDirWithCleanRetry} — mirrors the per-site `deps: {removeDir?, timeoutMs?}`
 *  seam every caller already exposed, plus the retry budget those callers used to hardcode individually. */
export interface RemoveDirCleanRetryOpts {
  timeoutMs: number;
  attempts: number;
  delayMs: number;
  removeDir?: (target: string, timeoutMs: number) => Promise<RemoveDirResult>;
}

/**
 * The shared shape behind a ONE-OFF (no later sweep) bounded directory removal with a short CLEAN-failure
 * retry: try up to `attempts` times, waiting `delayMs` between a CLEAN (settled, non-killed, non-
 * rejected) failure's attempts, and NEVER retrying a killed (wedged) or rejected (never-started) outcome
 * — card `8e32605d`'s own load-bearing invariant, now owned by this ONE function instead of being
 * re-implemented per caller (lesson 155).
 *
 * @decision c2fc8d84 — deliberately does NOT own the final warn/log line (each caller keeps its own
 * wording) and must NOT be forced onto `removeWorktree`/`sweepUnresumableScratchDirs`/`removeRunSnapshot`/
 * `sweepAllRunSnapshots` — those keep their own retry semantics; only swap their `.catch` for `raceRemoval`.
 */
export async function removeDirWithCleanRetry(
  dir: string,
  opts: RemoveDirCleanRetryOpts,
): Promise<RemoveDirCleanRetryOutcome> {
  const removeDir = opts.removeDir ?? ((p, ms) => killableRemoveDir(p, ms));
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    const outcome = await raceRemoval(removeDir(dir, opts.timeoutMs), opts.timeoutMs);
    if (outcome.kind === "timeout") {
      return { result: { removed: false, killed: true }, kind: "wedged" };
    }
    if (outcome.kind === "rejected") {
      return { result: { removed: false, killed: true }, kind: "rejected", rejectionMessage: outcome.message };
    }
    if (outcome.result.removed) {
      return { result: outcome.result, kind: "removed" };
    }
    if (outcome.result.killed) {
      return { result: outcome.result, kind: "wedged" };
    }
    if (attempt < opts.attempts) await delay(opts.delayMs);
  }
  return { result: { removed: false, killed: false }, kind: "clean-failure" };
}

// Windows extended-length path prefixes, spelled out via concatenation of a single escaped backslash
// rather than a multi-backslash literal — easier to get right than counting backslashes by eye.
const WIN32_BACKSLASH = "\\";
const WIN32_EXTENDED_PREFIX = WIN32_BACKSLASH + WIN32_BACKSLASH + "?" + WIN32_BACKSLASH; // \\?\
const WIN32_EXTENDED_UNC_PREFIX = WIN32_EXTENDED_PREFIX + "UNC" + WIN32_BACKSLASH; // \\?\UNC\

/** Normalize for containment comparison: resolved, no trailing separator, case-folded on win32 — and, on
 *  win32, with a Windows extended-length ("\\?\" / "\\?\UNC\") prefix folded to its ordinary drive/UNC
 *  form FIRST, so a long-path-prefixed form and its plain twin always compare equal. `fs.realpathSync`
 *  can hand back either form for the exact same path depending on length and the API that produced it;
 *  every containment check in this file ({@link pathsOverlap}, {@link worktreeRemovalRefusal}) fails
 *  OPEN — treats the two forms as unrelated paths — without this fold (card `623a7a62` round 3). */
export function normForCompare(p: string): string {
  let input = p;
  if (process.platform === "win32") {
    const upper = input.toUpperCase();
    if (upper.startsWith(WIN32_EXTENDED_UNC_PREFIX.toUpperCase())) {
      input = WIN32_BACKSLASH + WIN32_BACKSLASH + input.slice(WIN32_EXTENDED_UNC_PREFIX.length);
    } else if (upper.startsWith(WIN32_EXTENDED_PREFIX.toUpperCase())) {
      input = input.slice(WIN32_EXTENDED_PREFIX.length);
    }
  }
  const r = path.resolve(input).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/**
 * The ONE key every worktree-protection/GC-decision Set/Map (`handledWorktrees`,
 * `protectedWorktreePaths`, {@link reviewBaseShaConsensusByPath}) uses for identity, so two rows naming
 * the SAME dir with a case/slash variant collapse to one. fs/git calls keep the raw path — only
 * Set/Map identity comparisons route through this.
 *
 * @decision 40b63f1c — never key one of these structures on the raw `worktreePath` string; a repoKey
 * re-case or a cross-boot LOOM_HOME casing change can make two rows for the same dir disagree on spelling.
 */
export function worktreeIdentityKey(p: string): string {
  return normForCompare(p);
}

/** `child` is strictly below `parent` (never equal). Both already normalized. */
function isStrictlyUnder(child: string, parent: string): boolean {
  return child.startsWith(parent + path.sep) && child.length > parent.length + 1;
}

/** Every normalized form of `p` worth comparing for containment: the resolved (`normForCompare`) form
 *  always, PLUS the realpath-resolved form when `p` actually exists on disk — additive only, so a
 *  non-existent path still gets its resolved form checked (errs toward refusing, never skipped for
 *  absence). Shared by {@link worktreeRemovalRefusal} and {@link pathsOverlap} (directly, or via {@link
 *  pathOverlapKindAgainstForms} when a caller hoists one side's forms out of a loop) so all three compare
 *  on the SAME realpath+win32-case-fold normalisation. */
export function containmentForms(p: string): string[] {
  const out = [normForCompare(p)];
  try { out.push(normForCompare(fs.realpathSync(p))); } catch { /* absent path: the resolved form alone applies */ }
  return out;
}

/**
 * {@link pathOverlapKind}, but against an already-computed {@link containmentForms} set for the fixed
 * ("target") side — lets a caller comparing ONE target against MANY candidates (e.g.
 * `findLiveSessionClaimingWorktreePath`, card `623a7a62` round 3) hoist that side's `containmentForms()`
 * call out of its loop instead of recomputing it once per candidate. `targetForms`/`other` are NOT
 * interchangeable the way `pathOverlapKind`'s `a`/`b` are: `targetForms` must already be `other`'s own
 * containment forms if the caller means to compare `other` against itself, but the overlap test itself
 * is still symmetric between the two sides' forms.
 */
export function pathOverlapKindAgainstForms(targetForms: readonly string[], other: string): "exact" | "nested" | null {
  const otherForms = containmentForms(other);
  for (const x of targetForms) for (const y of otherForms) { if (x === y) return "exact"; }
  for (const x of targetForms) for (const y of otherForms) { if (isStrictlyUnder(x, y) || isStrictlyUnder(y, x)) return "nested"; }
  return null;
}

/**
 * Overlap classification between `a` and `b`: `"exact"` when they resolve to the same path, `"nested"`
 * when one strictly contains the other (either direction) without being equal, or `null` for no overlap
 * at all — checked over every {@link containmentForms} pair of both sides, so either side's realpath
 * form (when it resolves) is compared against both forms of the other. `a`/`b` are interchangeable; this
 * is deliberately NOT a one-directional "is-contained-by" check — see card `623a7a62`: a removal target
 * that CONTAINS a live worktree destroys it recursively just as surely as one that sits INSIDE it.
 */
export function pathOverlapKind(a: string, b: string): "exact" | "nested" | null {
  return pathOverlapKindAgainstForms(containmentForms(a), b);
}

/** The boolean form of {@link pathOverlapKind} — `true` for either an exact or a nested overlap. Most
 *  callers only need the yes/no answer; a caller that must react differently to an exact hit vs. a
 *  containment hit (card `623a7a62` round 3) calls {@link pathOverlapKind} directly instead. */
export function pathsOverlap(a: string, b: string): boolean {
  return pathOverlapKind(a, b) !== null;
}

/**
 * The ONE predicate every worktree directory removal must pass (null = allowed, else the refusal reason).
 * @decision e21cfd5f — a removal target must be strictly under the worktrees root and neither equal nor contain a registered repo path;
 * never relax it to "not equal the repo" (a repo's PARENT is as fatal), and never bypass it at a call site.
 */
export function worktreeRemovalRefusal(
  target: string,
  repoPaths: readonly string[],
  worktreesRoot: string = WORKTREES_DIR,
): string | null {
  const roots = containmentForms(worktreesRoot);
  const targets = containmentForms(target);
  for (const t of targets) {
    if (!roots.some((r) => isStrictlyUnder(t, r))) return `${target} is not strictly under the worktrees root ${worktreesRoot}`;
  }
  for (const repo of repoPaths) {
    if (!repo) continue;
    const repoForms = containmentForms(repo);
    for (const t of targets) for (const rp of repoForms) {
      if (t === rp) return `${target} is a registered repo path (${repo})`;
      if (isStrictlyUnder(rp, t)) return `${target} contains the registered repo path ${repo}`;
    }
  }
  return null;
}

/**
 * Remove a worker's worktree and prune the admin record. Branch deletion (after merge) is
 * #16's concern, not here.
 *
 * @decision c6a6f405 — the FILESYSTEM removal below stays deliberately UNLOCKED: wrapping the whole
 * function in withCanonicalIndexLock reflexively "to be safe" risks holding it across an fs.rm that can
 * wedge, and the lock is not re-entrant, so an already-locked caller would deadlock.
 *
 * @decision 83e0573a — the git-metadata steps (unlock+prune) below now DO take that lock, narrowly: an
 * unlocked `prune` can delete the shared `.git/worktrees` container out from under a concurrent,
 * different `createWorktree` add's own mkdir of its own entry.
 *
 * @decision 79b8d8a9 — the directory goes first through the killable filesystem removal (never git's own recursive delete,
 * which follows a junction planted inside the tree — see e21cfd5f); a KILLED (wedged) attempt is never retried here, only a
 * clean reject gets short in-session retries. Git's admin record is then unlocked and pruned.
 *
 * Guarded (e21cfd5f) against `worktreePath` itself being outside the worktrees root or being/containing `repoPath`; a junction
 * planted INSIDE the tree is defused by the removal order above, not by that predicate.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  deps: BoundedGitDeps = {},
): Promise<{ removed: boolean; wedged: boolean; aborted: boolean }> {
  const refusal = worktreeRemovalRefusal(worktreePath, [repoPath]);
  if (refusal) {
    // eslint-disable-next-line no-console
    console.warn(`[worktree] REFUSED to remove ${worktreePath} — ${refusal}. Nothing was touched.`);
    return { removed: false, wedged: false, aborted: false };
  }
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const removeDir = deps.removeDir ?? ((p, ms) => killableRemoveDir(p, ms));
  let removed = true;
  let wedged = false;
  // Distinct from `wedged`/plain `!removed`: the loop was stopped by `deps.abortIfClaimed`, never by a
  // failed/killed `removeDir` call. The directory itself was never touched on THIS call — a respawn
  // claimed the path (correct, safe behaviour), not a removal failure.
  let aborted = false;
  // Set ONLY on a "rejected" (never-started) outcome — see `raceRemoval`'s own doc (card c2fc8d84) for
  // why that must never share "genuinely wedged" wording with a real timeout.
  let rejectionMessage: string | null = null;
  for (let attempt = 1; attempt <= REMOVE_DIR_CLEAN_RETRY_ATTEMPTS; attempt++) {
    // @decision a5d9c458 — re-consulted on EVERY iteration (never just once before the loop): a claim
    // can land during a PRIOR iteration's own removeDir await or retry delay, so only a fresh check right
    // here catches it before the NEXT attempt actually touches the directory.
    if (deps.abortIfClaimed?.()) {
      // This fires on attempt 1 just as readily as on a later retry (the caller's claim can land before
      // this call's own first removeDir ever runs) — so the wording is CONDITIONAL on which: "Nothing
      // was touched" is only true on attempt 1 (no removeDir call has run yet); by attempt > 1 one or
      // more PRIOR attempts already called removeDir (even though each rejected cleanly), so it's
      // "nothing FURTHER was touched" — this abort itself touches nothing more, but something already did.
      // eslint-disable-next-line no-console
      console.warn(`[worktree] aborting removal of ${worktreePath} — the path is now claimed (attempt ${attempt}/${REMOVE_DIR_CLEAN_RETRY_ATTEMPTS}). ${attempt === 1 ? "Nothing was touched." : "Nothing further was touched."}`);
      removed = false; wedged = false; aborted = true; break;
    }
    // Only skip a RETRY (attempt > 1) if the dir vanished between attempts (e.g. removed some other way) —
    // the first attempt always calls removeDir unconditionally, mirroring the pre-existing force-remove
    // semantics (a target that's already gone is simply a no-op removal, not specially short-circuited).
    if (attempt > 1 && !fs.existsSync(worktreePath)) { removed = true; wedged = false; break; }
    const outcome = await raceRemoval(removeDir(worktreePath, timeoutMs), timeoutMs);
    if (outcome.kind === "timeout") { removed = false; wedged = true; break; } // genuinely wedged — hand to the caller's slow-retry policy, NEVER loop a hang HERE
    if (outcome.kind === "rejected") { removed = false; wedged = true; rejectionMessage = outcome.message; break; } // never-started — never retried either, but logged distinctly below
    removed = outcome.result.removed;
    if (removed) { wedged = false; break; }
    if (outcome.result.killed) { wedged = true; break; } // removeDir's OWN internal timeout won the race — same "genuinely wedged" treatment
    if (attempt < REMOVE_DIR_CLEAN_RETRY_ATTEMPTS) await delay(REMOVE_DIR_CLEAN_RETRY_DELAY_MS); // clean reject → short bounded retry
  }
  if (!removed && !aborted) {
    // An abort is reported above, distinctly and non-alarmingly — skip this generic "could not remove"
    // warn for it entirely, so the two logs never contradict each other (the old behaviour logged BOTH
    // "aborting... nothing further was touched" AND "could not remove dir ... left on disk for a later
    // GC" for the exact same event).
    const reason = rejectionMessage !== null
      ? `removal failed to start: ${rejectionMessage}`
      : wedged ? "genuinely wedged — caller retries it slowly" : "left on disk for a later GC";
    // eslint-disable-next-line no-console
    console.warn(`[worktree] could not remove dir ${worktreePath} (${reason})`);
  }
  // The dir is gone (if `removed`), so `prune` alone would leave a LOCKED record (a killed-mid-checkout
  // marker) behind: unlock first, best-effort (a not-locked worktree makes this exit non-zero, which is
  // fine). Never `worktree remove` here — it recurses through junctions.
  //
  // @decision 83e0573a — `unlock`+`prune` now run INSIDE `withCanonicalIndexLock`, kill-confirmed via
  // `killableCanonicalRaw` (same as `createWorktree`'s own locked `prune`) — closes a race where an
  // unlocked `prune` deletes the shared `.git/worktrees` container under a concurrent add's own mkdir.
  //
  // "Kill-confirmed" bounds the WAIT, not the outcome: an unconfirmed-kill give-up is swallowed below
  // like any other prune failure, releasing this lock while that child may still be alive — strictly
  // better than main's prior unlocked bare `withTimeout`, never a confirmed-dead guarantee.
  //
  // @decision d8bb2074 — this closes that card's own named-but-not-closed residual (these two calls used
  // to be exempt from kill-confirmation) as a side effect of the lock above, not its own goal.
  try {
    await withCanonicalIndexLock(repoPath, async () => {
      if (removed) {
        try {
          await killableCanonicalRaw(repoPath, ["worktree", "unlock", worktreePath], timeoutMs, "git worktree unlock", deps.gitFactory);
        } catch { /* not locked, or already unregistered */ }
      }
      try {
        await killableCanonicalRaw(repoPath, ["worktree", "prune"], timeoutMs, "git worktree prune", deps.gitFactory);
      } catch {
        // A hung/failed prune must NOT throw past removeWorktree (which would re-introduce the boot hang
        // via finalizeMerge / Pass B). A stale admin record is harmless — createWorktree prunes on reuse.
      }
    });
  } catch {
    // A quarantine (or any other lock-acquisition-time throw — e.g. RepoQuarantinedError from
    // withCanonicalIndexLock's own entry check) must not throw past removeWorktree either, same
    // best-effort contract the unlock/prune calls themselves already have. Net effect on a quarantined
    // repo: unlock+prune are SKIPPED entirely (the callback never runs) while the filesystem removal
    // above still ran — same "fs removed, admin record left stale" shape createWorktree's own reuse
    // path already tolerates.
  }
  return { removed, wedged, aborted };
}

/** Cap on filesystem entries visited by {@link measureDirSize} — mirrors {@link
 *  NESTED_REPO_SCAN_MAX_ENTRIES}'s bounded-walk shape so a pathological `node_modules` tree can't run the
 *  size measurement unbounded. Hitting this is signalled via `truncated`; a truncated sum is a LOWER
 *  BOUND on the real size, never a "confirmed accurate" total — card 1008e305's own sibling investigation
 *  (`83cd04dc`) reported its own whole-tree `du` undercounting for the identical reason (concurrent-
 *  removal races), so a truncated partial sum here is reported the same honest way. */
const DIR_SIZE_SCAN_MAX_ENTRIES = 200_000;

/** Bounded, best-effort recursive byte-size sum for `dir` (regular files only — directory entries and
 *  symlinks are not themselves counted) — walks via `fs.promises` so it never blocks the event loop for
 *  long. A path that vanishes mid-walk (e.g. a concurrent process racing this scan) contributes 0 for
 *  that entry rather than throwing — this is an advisory MEASUREMENT only, never a gate on removal. */
export async function measureDirSize(dir: string): Promise<{ bytes: number; truncated: boolean }> {
  let bytes = 0;
  let visited = 0;
  let truncated = false;
  async function walk(d: string): Promise<void> {
    if (visited >= DIR_SIZE_SCAN_MAX_ENTRIES) { truncated = true; return; }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return; // vanished/unreadable mid-walk — contributes 0, not a scan failure
    }
    for (const entry of entries) {
      if (visited >= DIR_SIZE_SCAN_MAX_ENTRIES) { truncated = true; return; }
      visited++;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          bytes += (await fs.promises.stat(full)).size;
        } catch {
          // vanished mid-walk — contributes 0, not a scan failure
        }
      }
    }
  }
  await walk(dir);
  return { bytes, truncated };
}

/**
 * Ceiling for a `node_modules` removal (card 1008e305 review finding [2]) — deliberately its OWN budget,
 * never borrowed from {@link GIT_OP_TIMEOUT_MS} (15s, sized for a git ref op, not a bulk filesystem
 * delete). Measured on a real 15,923-entry/277.5MB node_modules: a comparable delete took ~5.1s, so 120s
 * leaves generous headroom while staying far short of {@link PROVISION_TIMEOUT_MS} (a full reinstall is
 * slower than deleting). A killed attempt still degrades exactly like any other {@link killableRemoveDir}
 * caller — see {@link reclaimNodeModulesDir}'s own decision record bd9fc808 — this only shrinks how often
 * that path is reached in practice.
 */
const NODE_MODULES_RECLAIM_TIMEOUT_MS = 120_000;

/** Per-package-manager marker file written INSIDE `node_modules` only once an install has genuinely
 *  finished (mirrors {@link detectPackageManager}'s own lockfile-based manager detection). Used by {@link
 *  hasIntactNodeModules} as a best-effort INTEGRITY signal — see that function's own doc for why plain
 *  existence isn't enough. */
const NODE_MODULES_INTEGRITY_MARKER: Record<PackageManager, string> = {
  pnpm: ".modules.yaml",
  npm: ".package-lock.json",
  yarn: ".yarn-integrity",
};

/**
 * True when `worktreePath`'s `node_modules` looks like a genuinely COMPLETE install, not merely present
 * (card 1008e305 review finding [2]). A wedged/partial {@link killableRemoveDir} attempt (bounded, never
 * retried — see {@link reclaimNodeModulesDir}) can leave `node_modules` on disk with a real fraction of
 * its packages already deleted; `fs.existsSync(node_modules)` alone can't tell that apart from a healthy
 * install, and reusing a partially-deleted `node_modules` is worse than reusing none — some packages
 * resolve, others don't, which is exactly the concurrent/partial install state `CLAUDE.md` documents as
 * load-bearing to avoid. Checks for the detected package manager's own completion marker instead; falls
 * back to plain existence when no recognized lockfile is present (nothing to validate against, matching
 * {@link provisionWorktreeDeps}'s own no-op in that case).
 */
function hasIntactNodeModules(worktreePath: string): boolean {
  const nodeModulesPath = path.join(worktreePath, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) return false;
  const manager = detectPackageManager(worktreePath);
  if (!manager) return true;
  return fs.existsSync(path.join(nodeModulesPath, NODE_MODULES_INTEGRITY_MARKER[manager]));
}

/** {@link reclaimNodeModulesDir}'s result. */
export interface NodeModulesReclaimOutcome {
  worktreePath: string;
  nodeModulesPath: string;
  /** "missing": nothing to reclaim (already absent — a harmless no-op, not an error). "removed": actually
   *  deleted — `bytesReclaimed` is a real MEASURED total (a lower bound when `sizeTruncated`). "wedged":
   *  the removal was force-killed (genuinely stuck, see {@link killableRemoveDir}'s decision record
   *  bd9fc808) and is NEVER retried by this function; nothing was reclaimed. "left-on-disk": a clean
   *  (non-hang) removal failure (e.g. a transient handle lock); also nothing reclaimed. "rejected": the
   *  removal never even STARTED — `removeDir`'s own promise rejected (e.g. a synchronous `spawn()`
   *  failure inside {@link killableRemoveDir}'s executor, see {@link raceRemoval}'s own doc, card
   *  3640abf5) — distinct from "wedged" (which means a kill genuinely happened) and never retried either;
   *  `rejectionMessage` carries the real error text. */
  outcome: "missing" | "removed" | "wedged" | "left-on-disk" | "rejected";
  /** Measured (never estimated) bytes actually freed. `null` unless `outcome === "removed"`. */
  bytesReclaimed: number | null;
  /** True when the size measurement hit {@link DIR_SIZE_SCAN_MAX_ENTRIES} — `bytesReclaimed` is then a
   *  LOWER BOUND, not a complete total. Always false when `bytesReclaimed` is null. */
  sizeTruncated: boolean;
  /** Set ONLY when `outcome === "rejected"` — the real error text from the never-started removal. */
  rejectionMessage?: string;
}

/**
 * Reclaim ONE worktree's `node_modules` directory (card 1008e305). Deliberately narrow: this function
 * knows nothing about liveness, retention, or age — a caller (SessionService) decides WHETHER a worktree
 * is eligible; this only ever removes exactly `<worktreePath>/node_modules`, nothing else, and never
 * touches git state at all (node_modules is gitignored — there is no git call anywhere in this function,
 * so a worktree's HEAD/branch/tracked-file state is structurally unaffected by calling it). Routes
 * through {@link killableRemoveDir} via {@link raceRemoval} (card 3640abf5) — same primitive
 * {@link removeWorktree} already uses — so a synchronous `spawn()` rejection is classified and returned
 * as a structured outcome, never left to propagate as an unhandled rejection past this function.
 * @decision bd9fc808 — a single removal attempt, never a retry loop on a killed (wedged) OR rejected result.
 */
export async function reclaimNodeModulesDir(
  worktreePath: string,
  timeoutMs: number = NODE_MODULES_RECLAIM_TIMEOUT_MS,
  deps: {
    removeDir?: (target: string, timeoutMs: number) => Promise<RemoveDirResult>;
    measureSize?: (dir: string) => Promise<{ bytes: number; truncated: boolean }>;
    /** Every registered repo path (all projects, archived included) the removal must never equal or contain (e21cfd5f). */
    protectedRepoPaths?: readonly string[];
  } = {},
): Promise<NodeModulesReclaimOutcome> {
  const nodeModulesPath = path.join(worktreePath, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    return { worktreePath, nodeModulesPath, outcome: "missing", bytesReclaimed: null, sizeTruncated: false };
  }
  // e21cfd5f: `node_modules` may itself BE a junction/symlink (a worker can plant one) — the predicate resolves it, so a link into a repo (or anywhere
  // outside the worktrees root) is refused rather than removed. Reported as "left-on-disk" (nothing reclaimed) to keep the outcome contract unchanged.
  const refusal = worktreeRemovalRefusal(nodeModulesPath, deps.protectedRepoPaths ?? []);
  if (refusal) {
    // eslint-disable-next-line no-console
    console.warn(`[worktree] REFUSED to reclaim ${nodeModulesPath} — ${refusal}. Nothing was touched.`);
    return { worktreePath, nodeModulesPath, outcome: "left-on-disk", bytesReclaimed: null, sizeTruncated: false };
  }
  const measureSize = deps.measureSize ?? measureDirSize;
  const { bytes, truncated } = await measureSize(nodeModulesPath);
  const removeDir = deps.removeDir ?? ((p, ms) => killableRemoveDir(p, ms));
  const raceOutcome = await raceRemoval(removeDir(nodeModulesPath, timeoutMs), timeoutMs);
  if (raceOutcome.kind === "timeout") {
    return { worktreePath, nodeModulesPath, outcome: "wedged", bytesReclaimed: null, sizeTruncated: false };
  }
  if (raceOutcome.kind === "rejected") {
    // eslint-disable-next-line no-console
    console.warn(`[worktree] could not reclaim ${nodeModulesPath} (removal failed to start: ${raceOutcome.message})`);
    return {
      worktreePath, nodeModulesPath, outcome: "rejected",
      bytesReclaimed: null, sizeTruncated: false, rejectionMessage: raceOutcome.message,
    };
  }
  const result = raceOutcome.result;
  if (result.removed) {
    return { worktreePath, nodeModulesPath, outcome: "removed", bytesReclaimed: bytes, sizeTruncated: truncated };
  }
  return {
    worktreePath, nodeModulesPath,
    outcome: result.killed ? "wedged" : "left-on-disk",
    bytesReclaimed: null, sizeTruncated: false,
  };
}

/**
 * Card ad34efb5 — the basename shape {@link renameWorktreeDirAside} always produces.
 *
 * @decision ad34efb5 — a basename match alone is NEVER sufficient to conclude "safe to delete": a
 * registered repoKey can also match this shape. Always cross-check the live registry too.
 */
export const STALE_ASIDE_SUFFIX_RE = /\.stale-\d+$/;

/** Whether `p`'s basename matches the renamed-aside leftover naming contract (see {@link STALE_ASIDE_SUFFIX_RE}). */
export function isStaleAsideWorktreeDir(p: string): boolean {
  return STALE_ASIDE_SUFFIX_RE.test(path.basename(p));
}

/** One entry in {@link listStaleAsideWorktrees}'s result. Deliberately carries NO byte size — see that
 *  function's own doc for why bytes are a separate, opt-in measurement. */
export interface StaleAsideWorktreeEntry {
  path: string;
  projectId: string;
  /** Parsed straight from the `.stale-<ts>` suffix itself (the rename's own `Date.now()`) — free, no stat call needed. */
  staleSinceMs: number;
}

/** Cap on directory entries visited by {@link listStaleAsideWorktrees} — mirrors the other bounded scans
 *  in this file (e.g. {@link NESTED_REPO_SCAN_MAX_ENTRIES}). Never expected to be hit in practice: this
 *  function only ever lists DIRECTORY NAMES (project dirs, then one level under each), never descends
 *  into a candidate's own file content. */
const STALE_ASIDE_SCAN_MAX_ENTRIES = 20_000;

function parseStaleSinceMs(basename: string): number | null {
  const m = STALE_ASIDE_SUFFIX_RE.exec(basename);
  if (!m) return null;
  const ts = Number(basename.slice(m.index + ".stale-".length));
  return Number.isFinite(ts) ? ts : null;
}

/** A planted junction/symlink named to look like a leftover must never be treated as one. MEASURED (card
 *  e3fcd8ea) on Node 22.16/Win11: both `fs.readdirSync(..., {withFileTypes:true})`'s Dirent and
 *  `fs.lstatSync` report a real directory junction as `isSymbolicLink()===true` / `isDirectory()===false`
 *  — so the `!entry.isDirectory()`/`!leaf.isDirectory()` skip at every call site below ALREADY excludes a
 *  junction before this function is ever reached, making it redundant on this Node/libuv version. Kept
 *  anyway, deliberately, as declared defence-in-depth: junction/Dirent reporting is libuv-/Node-version-
 *  dependent and may change, this guards a host-path DELETE, and a single name-matched `lstatSync` costs
 *  nothing. `junction-dirent-shape.mjs` PINS the measured Dirent shape on
 *  win32 so a future Node upgrade that changes it fails loudly instead of silently reopening the gap this
 *  function exists to close.
 *  @decision ad34efb5 — single `lstatSync`, called ONLY on a name-matched candidate, never scan-wide. */
function isLikelyJunctionOrSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Card ad34efb5: enumerate every renamed-aside stale worktree dir under `worktreesRoot` — a cheap,
 * bounded, purely synchronous `readdirSync` (no `fs.stat`/`measureDirSize`, no descent into a
 * candidate's own content, besides the single name-matched-candidate `lstatSync` above). Layout (see
 * {@link resolveWorktreePath}): `worktreesRoot/<projectId>/<taskKey>` (primary) or
 * `worktreesRoot/<projectId>/<repoKey>/<taskKey>` (secondary-repo axis, card 49136451) — covered by a
 * 2-level-deep readdir, since a stale-aside rename only ever suffixes the LEAF basename.
 * `repoKeysByProject` (see {@link repoKeysByProjectFromProjects}) names which level-2 entries are REAL
 * registered repoKey dirs worth probing one level deeper; omitted, this degrades to primary-axis-only.
 *
 * @decision ad34efb5 — the registry check runs BEFORE the basename-shape check at EVERY level: a
 * registered repoKey is NEVER a stale leaf, even if its name also matches the suffix (see
 * STALE_ASIDE_SUFFIX_RE's own doc). Never add byte measurement, and never guess from name shape instead.
 */
/**
 * Whether `name` is a registered repoKey in `keys` — exact match first, falling back to a WIN32-ONLY
 * case-folded scan. The ONE place either call site below compares a repoKey name against the registry.
 *
 * @decision 98039b36 — never re-introduce a second, independently-written repoKey-name comparison; route
 * every such check through this helper instead (see the full record for why the two previously drifted).
 */
function isRegisteredRepoKeyName(name: string, keys: ReadonlySet<string> | undefined): boolean {
  if (!keys) return false;
  if (keys.has(name)) return true;
  if (process.platform !== "win32") return false;
  const folded = name.toLowerCase();
  for (const k of keys) if (k.toLowerCase() === folded) return true;
  return false;
}

export function listStaleAsideWorktrees(
  worktreesRoot: string = WORKTREES_DIR,
  repoKeysByProject?: ReadonlyMap<string, ReadonlySet<string>>,
  // Card 04e4262d — opt-in only, so an un-opted-in caller (served-status.ts's polled read) stays
  // byte-identical in both output AND cost.
  //
  // @decision ad34efb5 — round 3 amends this record's own "do not widen the probe" rule with a narrow,
  // explicitly opt-in exception; see that record for the full reasoning.
  opts: { probeUnregistered?: boolean } = {},
): StaleAsideWorktreeEntry[] {
  const probeUnregistered = opts.probeUnregistered === true;
  const entries: StaleAsideWorktreeEntry[] = [];
  let visited = 0;
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(worktreesRoot, { withFileTypes: true });
  } catch {
    return entries; // WORKTREES_DIR missing/unreadable — nothing to report, not a scan failure
  }
  for (const projectDir of projectDirs) {
    if (visited >= STALE_ASIDE_SCAN_MAX_ENTRIES) break;
    visited++;
    if (!projectDir.isDirectory()) continue;
    const projectId = projectDir.name;
    const projectPath = path.join(worktreesRoot, projectId);
    const repoKeys = repoKeysByProject?.get(projectId);
    let level2: fs.Dirent[];
    try {
      level2 = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch { continue; }
    for (const entry of level2) {
      if (visited >= STALE_ASIDE_SCAN_MAX_ENTRIES) break;
      visited++;
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(projectPath, entry.name);
      // Registry FIRST, always — a registered repoKey is never a stale leaf, regardless of its basename.
      // Via isRegisteredRepoKeyName (not a bare `.has()` — see that helper's own doc).
      if (isRegisteredRepoKeyName(entry.name, repoKeys)) {
        if (isLikelyJunctionOrSymlink(entryPath)) continue; // never probe through a planted link
        let level3: fs.Dirent[];
        try {
          level3 = fs.readdirSync(entryPath, { withFileTypes: true });
        } catch { continue; }
        for (const leaf of level3) {
          if (visited >= STALE_ASIDE_SCAN_MAX_ENTRIES) break;
          visited++;
          if (!leaf.isDirectory()) continue;
          const leafPath = path.join(entryPath, leaf.name);
          const leafStaleSinceMs = parseStaleSinceMs(leaf.name);
          if (leafStaleSinceMs !== null && !isLikelyJunctionOrSymlink(leafPath)) {
            entries.push({ path: leafPath, projectId, staleSinceMs: leafStaleSinceMs });
          }
        }
        continue; // a registered repoKey dir is never itself a stale leaf — nothing more to do with it
      }
      const staleSinceMs = parseStaleSinceMs(entry.name);
      if (staleSinceMs !== null) {
        // Unchanged from before card 04e4262d: a renamed-aside leaf is reported purely by its own
        // basename, with NO `.git`-presence check — `renameWorktreeDirAside` is a bare `fs.renameSync`
        // that never touches contents, and NOT every caller guarantees the leaf had no `.git` link
        // before the rename (`createWorktree` does; `reclaimWedgedWorktreePathForSpawn`'s wedge-retry
        // rename does not — see its own doc). Checking `.git` here would wrongly hide exactly the
        // leftover this function exists to surface.
        if (isLikelyJunctionOrSymlink(entryPath)) continue;
        // Card 04e4262d round 3 Code Review M3 — collision backstop, now UNCONDITIONAL (previously gated
        // behind the same opt-in as the rest of this probe, which let `served_status` OVERcount relative
        // to the GET listing for this one shape). One extra bounded `readdirSync` per suffix-named
        // UNREGISTERED candidate — a rare entry, not the per-poll "readdir every live worktree" cost the
        // decision record's "do not widen" rule targets. A removed-or-never-registered repoKey axis dir
        // can itself be named like a leftover (the round-2 "svc.stale-1" collision shape, this time NOT in
        // the registry) while still holding a LIVE nested worktree one level below.
        // `findNestedWorktreeLikeChild` is the exact shape+`.git`-FILE proof c994ffeb already established
        // for this — never "any `.git` entry".
        if (findNestedWorktreeLikeChild(entryPath)) continue;
        entries.push({ path: entryPath, projectId, staleSinceMs });
        continue;
      }
      if (!probeUnregistered) continue; // today's behavior, byte-identical in output AND cost when off
      // Card 04e4262d Code Review M1: never descend into an entry shaped like a PRIMARY task worktree key
      // (12 lowercase hex chars) — `validateRepoRegistry` (projects/repos.ts) rejects any NEW repoKey of
      // this shape outright, so it can never legitimately be a repo-axis container going forward; the
      // ONLY way this name shape appears here is as an actual primary task worktree (whose own `.git` may
      // be transiently absent — e.g. mid-`git worktree add`, or between a wedge-retry rename-aside and its
      // own completion) or a grandfathered legacy repoKey predating that guard. Descending into either
      // would list and reclaim real user content from inside a live task worktree (the exact repro: a
      // primary worktree missing its `.git` link, holding a `.stale-<ts>`-suffixed subdir of its own).
      // Undercounting a grandfathered legacy repoKey this way is an accepted, narrow tradeoff — it was
      // already excluded from re-validation on write (existingKeys), and this probe has no way to tell it
      // apart from a real task worktree without a registry lookup this branch (by construction) already
      // failed to resolve.
      if (TASK_KEY_SHAPE_RE.test(entry.name)) continue;
      // Card 04e4262d — the gap-closing probe: `entry` is neither suffix-shaped nor a currently-registered
      // repoKey, but it may be a (removed, or never-registered) repo-axis container whose LEAVES are still
      // worth surfacing. Only ever descend once proven this entry holds NO `.git` entry of its OWN, of any
      // kind (file, dir, or link, readable or not — a plain name match in the listing below, never a
      // stat) — a live primary worktree, an ordinary nested clone/submodule, or a worktree mid-`git
      // worktree add` all have one, and in every one of those cases the rest of its content is arbitrary,
      // user-controlled checkout content, never a Loom-managed container shape, so it must never be read.
      if (isLikelyJunctionOrSymlink(entryPath)) continue; // never probe through a planted link
      let level3: fs.Dirent[];
      try {
        level3 = fs.readdirSync(entryPath, { withFileTypes: true });
      } catch { continue; }
      // Card 04e4262d Code Review M2: fold case ON WIN32 ONLY (mirrors isRegisteredRepoKeyName's own
      // platform-conditional fold) — a bare `c.name === ".git"` missed a differently-cased `.GIT` entry on
      // a real win32 filesystem, which IS the same container to the OS (case-insensitive) even though this
      // in-memory Dirent-name comparison is not.
      const hasOwnGitEntry = level3.some((c) => c.name === ".git")
        || (process.platform === "win32" && level3.some((c) => c.name.toLowerCase() === ".git"));
      if (hasOwnGitEntry) continue;
      for (const child of level3) {
        if (visited >= STALE_ASIDE_SCAN_MAX_ENTRIES) break;
        visited++;
        if (!child.isDirectory()) continue;
        const childPath = path.join(entryPath, child.name);
        const childStaleSinceMs = parseStaleSinceMs(child.name);
        if (childStaleSinceMs !== null && !isLikelyJunctionOrSymlink(childPath)) {
          entries.push({ path: childPath, projectId, staleSinceMs: childStaleSinceMs });
        }
      }
    }
  }
  return entries;
}

/** Build the `repoKeysByProject` map {@link listStaleAsideWorktrees} wants, from a list of projects
 *  (structural typing only — never imports `Project` from `shared`, to keep this module DB-type-free).
 *  Omits a project with no registered secondary repos (nothing to widen detection for). */
export function repoKeysByProjectFromProjects(
  projects: readonly { id: string; repos?: readonly { key: string }[] }[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const p of projects) {
    const keys = new Set((p.repos ?? []).map((r) => r.key));
    if (keys.size > 0) map.set(p.id, keys);
  }
  return map;
}

/** The ONE place that builds {@link listStaleAsideWorktrees}'s `repoKeysByProject` map from a live Db
 *  handle — `served-status.ts`, boot-reconcile, and both stale-leftover service methods previously each
 *  hand-wrote this same two-line composition (card ad34efb5 round 2 nit). Structural typing only, same
 *  posture as {@link repoKeysByProjectFromProjects} itself — never imports `Db` from the daemon root. */
export function staleAsideRepoKeysByProject(
  db: {
    listAllProjects(): readonly { id: string; repos?: readonly { key: string }[] }[];
    listArchivedProjects(): readonly { id: string; repos?: readonly { key: string }[] }[];
  },
): Map<string, Set<string>> {
  return repoKeysByProjectFromProjects([...db.listAllProjects(), ...db.listArchivedProjects()]);
}

/**
 * Whether `targetPath` IS (not merely under) a registered repoKey axis dir — `worktreesRoot/<projectId>/
 * <repoKey>` for a repoKey the project (active OR archived) has registered. Independent of {@link
 * listStaleAsideWorktrees}'s own registry-first enumeration order — see that function's own doc and
 * STALE_ASIDE_SUFFIX_RE's own doc for why the listing fix alone is not enough and reclaim must also
 * refuse this on its own (card ad34efb5 round 2, Major). Name comparison is {@link isRegisteredRepoKeyName}.
 *
 * @decision 98039b36 — never re-derive this comparison inline here; see that helper's own doc.
 */
export function isRegisteredRepoKeyAxisDir(
  targetPath: string,
  repoKeysByProject: ReadonlyMap<string, ReadonlySet<string>>,
  worktreesRoot: string = WORKTREES_DIR,
): boolean {
  const rel = path.relative(path.resolve(worktreesRoot), path.resolve(targetPath));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return false; // only the axis-dir shape itself: worktreesRoot/<projectId>/<repoKey>
  const [projectId, repoKey] = parts as [string, string];
  return isRegisteredRepoKeyName(repoKey, repoKeysByProject.get(projectId));
}

/** Ceiling for a renamed-aside stale-leftover removal — same order of magnitude as {@link
 *  NODE_MODULES_RECLAIM_TIMEOUT_MS}: these dirs are node_modules-shaped (they're half-removed/wedged
 *  WORKTREE dirs, so they typically still carry a full node_modules), same bulk-filesystem-delete cost
 *  profile. */
const STALE_LEFTOVER_RECLAIM_TIMEOUT_MS = 120_000;

/** {@link reclaimStaleAsideWorktreeDir}'s result. `"refused"` covers BOTH the basename-shape check and
 *  {@link worktreeRemovalRefusal} — `reason` names which. `"rejected"` (card 3640abf5) means the removal
 *  never even STARTED — `removeDir`'s own promise rejected (see {@link raceRemoval}'s own doc) — distinct
 *  from "wedged" (a genuine kill) and never retried either; `rejectionMessage` carries the real error. */
export interface StaleAsideReclaimOutcome {
  path: string;
  outcome: "removed" | "missing" | "wedged" | "left-on-disk" | "refused" | "rejected";
  bytesReclaimed: number | null;
  sizeTruncated: boolean;
  reason?: string;
  /** Set ONLY when `outcome === "rejected"` — the real error text from the never-started removal. */
  rejectionMessage?: string;
}

/**
 * Card ad34efb5 — the mutating, pure-filesystem counterpart to {@link listStaleAsideWorktrees}: reclaim
 * exactly ONE renamed-aside stale leftover dir. Deliberately does NOT re-derive eligibility or check for a
 * live claimant itself (both need DB/session state this module doesn't have) — see
 * `SessionService.reclaimStaleWorktreeLeftover` for those guards; this function is the mechanical tail
 * every one of its checks must pass through first.
 *
 * No quarantine check, unlike `gcWorktreeDir`: a renamed-aside dir carries NO live git-worktree admin
 * registration pointing at it by construction (`createWorktree` only renames aside a dir with no `.git`
 * link; `reclaimWedgedWorktreePathForSpawn` only renames aside a dir already on the wedged-retry list,
 * whose own prior removal attempt already ran `git worktree prune` against the now-vacated original
 * path) — this is a pure filesystem removal, same shape as {@link reclaimNodeModulesDir}'s own delete
 * (which also runs no git ops). Routes through {@link killableRemoveDir} via {@link raceRemoval} (card
 * 3640abf5), exactly like {@link reclaimNodeModulesDir} — a synchronous `spawn()` rejection is classified
 * and returned as a structured "rejected" outcome, never left to propagate past this function.
 * @decision bd9fc808 — a single removal attempt, never a retry loop on a killed (wedged) OR rejected result.
 */
export async function reclaimStaleAsideWorktreeDir(
  targetPath: string,
  timeoutMs: number = STALE_LEFTOVER_RECLAIM_TIMEOUT_MS,
  deps: {
    removeDir?: (target: string, timeoutMs: number) => Promise<RemoveDirResult>;
    measureSize?: (dir: string) => Promise<{ bytes: number; truncated: boolean }>;
    /** Every registered repo path (all projects, archived included) the removal must never equal or contain (e21cfd5f). */
    protectedRepoPaths?: readonly string[];
    /** Card ad34efb5 round 2 (Major, fix b): INDEPENDENT of the caller's own fresh-listing re-derivation —
     *  refuses `targetPath` outright if it IS a registered repoKey axis dir, never trusting "the listing
     *  didn't show it to me" as the only guard. See {@link isRegisteredRepoKeyAxisDir}'s own doc.
     *  @decision e3fcd8ea — never make this optional again: an optional shape let a future TYPED caller
     *  silently lose this refusal by omitting it, uncaught by the compiler. */
    repoKeysByProject: ReadonlyMap<string, ReadonlySet<string>>;
    worktreesRoot?: string;
  },
): Promise<StaleAsideReclaimOutcome> {
  // Narrower than worktreeRemovalRefusal below, and specific to THIS endpoint's purpose: restricts
  // reclaim to ONLY ever deleting a renamed-aside leftover, never a generically-named worktree dir that
  // happens to sit under WORKTREES_DIR.
  if (!isStaleAsideWorktreeDir(targetPath)) {
    return {
      path: targetPath, outcome: "refused", bytesReclaimed: null, sizeTruncated: false,
      reason: `${targetPath} is not a renamed-aside stale worktree dir (basename does not match .stale-<ts>)`,
    };
  }
  // Fail CLOSED, never silently skip the registry-axis refusal below, when a non-typechecked caller
  // omits repoKeysByProject (`deps?.` also tolerates `deps` itself being omitted).
  if (!deps?.repoKeysByProject) {
    const reason = "reclaimStaleAsideWorktreeDir requires deps.repoKeysByProject — the independent registry-axis refusal (isRegisteredRepoKeyAxisDir) is load-bearing and must never be silently skipped. Pass an empty Map() if this call genuinely has no registry context.";
    // eslint-disable-next-line no-console
    console.warn(`[worktree] REFUSED to reclaim stale leftover ${targetPath} — ${reason}. Nothing was touched.`);
    return { path: targetPath, outcome: "refused", bytesReclaimed: null, sizeTruncated: false, reason };
  }
  if (isRegisteredRepoKeyAxisDir(targetPath, deps.repoKeysByProject, deps.worktreesRoot ?? WORKTREES_DIR)) {
    const reason = `${targetPath} is a registered repoKey axis dir — refusing even though its basename matches .stale-<ts>`;
    // eslint-disable-next-line no-console
    console.warn(`[worktree] REFUSED to reclaim stale leftover ${targetPath} — ${reason}. Nothing was touched.`);
    return { path: targetPath, outcome: "refused", bytesReclaimed: null, sizeTruncated: false, reason };
  }
  const refusal = worktreeRemovalRefusal(targetPath, deps.protectedRepoPaths ?? []);
  if (refusal) {
    // eslint-disable-next-line no-console
    console.warn(`[worktree] REFUSED to reclaim stale leftover ${targetPath} — ${refusal}. Nothing was touched.`);
    return { path: targetPath, outcome: "refused", bytesReclaimed: null, sizeTruncated: false, reason: refusal };
  }
  if (!fs.existsSync(targetPath)) {
    return { path: targetPath, outcome: "missing", bytesReclaimed: null, sizeTruncated: false };
  }
  const measureSize = deps.measureSize ?? measureDirSize;
  const { bytes, truncated } = await measureSize(targetPath);
  const removeDir = deps.removeDir ?? ((p, ms) => killableRemoveDir(p, ms));
  const raceOutcome = await raceRemoval(removeDir(targetPath, timeoutMs), timeoutMs);
  if (raceOutcome.kind === "timeout") {
    return { path: targetPath, outcome: "wedged", bytesReclaimed: null, sizeTruncated: false };
  }
  if (raceOutcome.kind === "rejected") {
    // eslint-disable-next-line no-console
    console.warn(`[worktree] could not reclaim ${targetPath} (removal failed to start: ${raceOutcome.message})`);
    return {
      path: targetPath, outcome: "rejected",
      bytesReclaimed: null, sizeTruncated: false, rejectionMessage: raceOutcome.message,
    };
  }
  const result = raceOutcome.result;
  if (result.removed) {
    return { path: targetPath, outcome: "removed", bytesReclaimed: bytes, sizeTruncated: truncated };
  }
  return {
    path: targetPath,
    outcome: result.killed ? "wedged" : "left-on-disk",
    bytesReclaimed: null, sizeTruncated: false,
  };
}

/** @decision 9cb0287a — test-only: ZERO production call sites since boot-reconcile Pass A switched to
 *  positive squash-trailer proof (findLandedSquashCommit) instead. Don't remove it as "dead code" until
 *  card 0f965ab7's pending review of the fail-safe siblings that still reference it resolves. */
export async function isBranchMerged(repoPath: string, branch: string, base = "HEAD", deps: BoundedGitDeps = {}): Promise<boolean> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    // @decision 7eac6366 — `--end-of-options` right before `branch` (`--list`'s own argument slot, not
    // `--merged`'s — `base` there always resolves as a literal revision regardless of shape, measured);
    // see git/worktrees.ts:1300 for the full placement rule.
    return (await withTimeout(git.raw(["branch", "--merged", base, "--list", "--end-of-options", branch]), timeoutMs, "git branch --merged")).trim() !== "";
  } catch {
    return false;
  }
}

/** @decision 787dd2a7 — distinguish a genuine no-default from a TRANSIENT read failure (a timeout, a
 *  spawn error) by git's own message, never by the exit code — a killed child can exit non-zero with
 *  empty stderr, which simple-git resolves as success, and that must never read as "no default". */
export type MainlineDefaultBranchState = { state: "resolved"; branch: string } | { state: "no-default" } | { state: "failed" };

const NOT_A_SYMBOLIC_REF = /fatal:\s*ref\s.*\sis not a symbolic ref/i;

// @decision 09f268a5 — resolve mainline via refs/remotes/origin/HEAD, never HEAD itself (which can be
// parked on an arbitrary branch here); FAILS CLOSED with NO guessed "main" fallback — a repo with no
// resolvable origin/HEAD (a plain `git init`, no remote) is a known gap, not a bug to "fix" with a guess.
export async function resolveMainlineBranchState(repoPath: string, deps: BoundedGitDeps = {}): Promise<MainlineDefaultBranchState> {
  const { git, timeoutMs } = boundedGit(repoPath, {
    ...deps,
    gitFactory: deps.gitFactory ?? ((p, ms) => canonicalGit(p, ms, localReadGitEnv(process.env, { LC_ALL: "C", LANGUAGE: "C" }))),
  });
  try {
    const out = await withTimeout(
      git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]),
      timeoutMs,
      "git symbolic-ref origin/HEAD",
    );
    const ref = out.trim(); // e.g. "refs/remotes/origin/main" — full ref, never ambiguity-shortened
    // card 967eb326 — `--short` shortens ambiguously (a colliding local ref can make this resolve to a
    // longer disambiguated form); strip the known-fixed `refs/remotes/origin/` prefix in JS instead.
    const branch = ref.startsWith("refs/remotes/origin/") ? ref.slice("refs/remotes/origin/".length) : ref;
    // Card 787dd2a7 round 3: empty output on a successful exit is a killed-child/transient read, never a
    // genuine no-default — the @decision above already rules this must defer like a "failed" read, not
    // seed like a settled "no-default" (never observed for real git; defensive only).
    return branch ? { state: "resolved", branch } : { state: "failed" };
  } catch (e) {
    // Card f96b9d7c: this catch used to be silent, so a repo with a genuinely NO resolvable origin/HEAD
    // (the expected, permanent case) was indistinguishable from a TRANSIENT read failure (a timeout under
    // boot-time load, a git error) — both just produced `null` with zero log output. Log the real cause
    // here; resolveMainlineBranch below still treats both as "skip this repo, fail closed" (unchanged
    // behavior for every one of ITS callers), but the reason is now visible instead of silently swallowed,
    // and distinguishable by THIS function's own return state for a caller that needs the distinction.
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.warn(`[git] resolveMainlineBranch failed for ${repoPath}: ${msg}`);
    return NOT_A_SYMBOLIC_REF.test(msg) ? { state: "no-default" } : { state: "failed" };
  }
}

/** @decision 787dd2a7 — kept byte-identical in contract (still `string | null`) so every existing caller
 *  stays unaffected by the tri-state split above; a caller that needs the failure modes told apart uses
 *  {@link resolveMainlineBranchState} directly instead. */
export async function resolveMainlineBranch(repoPath: string, deps: BoundedGitDeps = {}): Promise<string | null> {
  const r = await resolveMainlineBranchState(repoPath, deps);
  return r.state === "resolved" ? r.branch : null;
}

/** @decision f96b9d7c — every local `loom/*` branch merged into `mainlineBranch`, which MUST come from {@link
 *  resolveMainlineBranch} (never a literal/`HEAD`); fails safe to `{branches:[]}`, with a `failed`
 *  discriminator + logged cause — never restore the old silent catch, indistinguishable from a real zero. */
export async function listMergedLoomBranches(repoPath: string, mainlineBranch: string, deps: BoundedGitDeps = {}): Promise<{ branches: string[]; failed: boolean }> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    // card 967eb326 — `%(refname:short)` shortens ambiguously (e.g. to "heads/<name>" beside a
    // same-named tag or refs/remotes/<name>/HEAD); `%(refname:lstrip=2)` strips refs/heads/
    // unconditionally instead (same fix as 1bc9602b; see docs/decisions/2a6a292a-* "Round 13").
    const out = await withTimeout(
      git.raw(["branch", "--list", "loom/*", "--merged", mainlineBranch, "--format=%(refname:lstrip=2)"]),
      timeoutMs,
      "git branch --list --merged",
    );
    return { branches: out.split("\n").map((l) => l.trim()).filter(Boolean), failed: false };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[git] listMergedLoomBranches failed for ${repoPath} (mainline '${mainlineBranch}'): ${(e as Error).message} — failing safe to empty (nothing reclaimed this pass for this repo)`);
    return { branches: [], failed: true };
  }
}

/**
 * Every branch currently checked out in ANY worktree of this repo (the primary checkout, every live
 * worker, every leftover) — parsed from `git worktree list --porcelain`'s `branch refs/heads/<name>`
 * lines. This is git's OWN ground truth, independent of any DB session row (a stale/missing session row
 * can never cause a checked-out branch to look safe to delete). Card 09f268a5's branch-ref sweep uses
 * this as the final safety gate before deleting a merged `loom/*` branch — a checked-out branch is
 * skipped even when merged.
 *
 * UNLIKE {@link listMergedLoomBranches}, this does NOT fail safe to an empty result on error — an empty
 * `Set` here would mean "nothing is checked out," which is the UNSAFE direction (it would let a
 * checked-out branch through). It THROWS instead; the caller must catch and skip the whole repo's sweep
 * for this pass rather than treat a failed read as "nothing to protect."
 */
export async function listCheckedOutBranches(repoPath: string, deps: BoundedGitDeps = {}): Promise<Set<string>> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  const out = await withTimeout(git.raw(["worktree", "list", "--porcelain"]), timeoutMs, "git worktree list --porcelain");
  const branches = new Set<string>();
  for (const line of out.split("\n")) {
    const m = /^branch (refs\/heads\/.+)$/.exec(line.trim());
    const ref = m?.[1];
    if (ref) branches.add(ref.slice("refs/heads/".length));
  }
  return branches;
}

/**
 * How many commits does `base` (default the repo's current HEAD) carry that `branch`'s history is
 * missing — `git rev-list --count <branch>..<base>`. Card 5150fdc2: the ONE counting primitive shared by
 * both the spawn-time stale-base detector ({@link detectStaleBase}, part 1) and the merge-review backstop
 * (`reviewWorkerMerge`'s `worker_merge` step, part 4) — a manager reviewing a worker's branch sees this
 * even independent of whether the spawn-time check already ran for it (a worker spawned before this fix,
 * or one whose branch fell behind mid-session). BOUNDED (mirrors {@link isBranchMerged}'s hardening — this
 * can run on the same review/merge hot path) and FAILS SAFE to `undefined` on any error/timeout/parse
 * failure — advisory-only, so a check hiccup must never block or alter a spawn or a review.
 */
export async function countCommitsBehind(repoPath: string, branch: string, base = "HEAD", deps: BoundedGitDeps = {}): Promise<number | undefined> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    const raw = await withTimeout(git.raw(["rev-list", "--count", `refs/heads/${branch}..${base}`]), timeoutMs, "git rev-list --count (behind base)");
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Does `git status --porcelain -z` represent REAL worker work, or only daemon-injected `.claude/` noise
 *  (skill injection, Claude's own `settings.local.json` writes)? ⛔ Two noise classes are dropped — any
 *  untracked `.claude/` path, and the injected `.claude/skills/` subtree at ANY status — everything else
 *  (incl. a tracked non-skills `.claude/` file) counts as work; without this a merged worktree reads dirty
 *  and blocks its own cleanup. Exported so the guard is unit-testable in isolation. Takes `-z` output
 *  (card 8cc047d3) — a v1 (non-`-z`) porcelain string parses as one bogus record and is WRONG. */
export function worktreeStatusHasWork(porcelainZ: string): boolean {
  return uncommittedWorkFiles(porcelainZ).length > 0;
}

/**
 * One parsed record from `git status --porcelain -z ...` (card 8cc047d3 — generalized from the
 * codex-auto-commit-only {@link parseAutoCommitStatusZ}). `-z` NUL-delimits records and prints every path
 * VERBATIM — no C-quoting/octal-escaping of non-ASCII bytes, and no `" -> "` substring to mis-split — so
 * `café.txt`, a path containing a literal `" -> "`, and a renamed/copied path are all parsed losslessly.
 * A combined rename/copy record occupies TWO consecutive `-z` fields (`XY new\0old\0`): `path` is the NEW
 * half, `oldPath` the OLD half. Each CALLER decides whether it needs `oldPath` — see
 * {@link parseAutoCommitStatusZ}'s own doc for why the auto-commit path drops it (the old half is never
 * itself stageable), versus {@link filteredWorkEntries}'s callers, which want the complete path set.
 */
interface PorcelainZEntry {
  status: string;
  path: string;
  oldPath?: string;
  untracked: boolean;
}

/** Shared `-z` record parser — see {@link PorcelainZEntry}'s own doc. */
function parsePorcelainStatusZ(porcelainZ: string): PorcelainZEntry[] {
  const fields = porcelainZ.split("\0");
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop(); // trailing NUL leaves an empty tail field
  const out: PorcelainZEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const rec = fields[i++];
    if (!rec || rec.length < 3) continue; // defensive: malformed/short record
    const status = rec.slice(0, 2);
    const p = rec.slice(3);
    let oldPath: string | undefined;
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
      oldPath = fields[i++]; // consume the OLD path field (rename/copy source)
    }
    out.push({ status, path: p, oldPath, untracked: status === "??" });
  }
  return out;
}

/**
 * The filtered, noise-excluded `git status --porcelain -z` RECORDS (not just paths) — the shared
 * foundation both {@link uncommittedWorkFiles} and {@link computeWorktreeGateStamp}'s `dirtyHash` build
 * on, so every consumer of "what counts as real work" agrees. Two daemon-noise classes are dropped: an
 * UNTRACKED (`??`) path under `.claude/` (skill injection + Claude's own `.claude/settings.local.json`
 * permission writes), AND the daemon-injected `.claude/skills/` subtree at ANY status (a re-copy over a
 * tracked colliding skill name surfaces as a tracked modification, not `??`). Everything else — tracked
 * modifications elsewhere (incl. a tracked non-skills file under `.claude/`), staged/unstaged changes,
 * untracked paths OUTSIDE `.claude/` — is the worker's product and kept. Card 887e10b8 Item 1: codex's
 * injected AGENTS.md is the SAME kind of doctrine noise, untracked-only (a repo's own real, already-
 * TRACKED AGENTS.md would show a different status and is never touched by injectCodexDoctrine in the
 * first place).
 */
function filteredWorkEntries(porcelainZ: string): PorcelainZEntry[] {
  const out: PorcelainZEntry[] = [];
  for (const e of parsePorcelainStatusZ(porcelainZ)) {
    if (e.untracked && isDoctrineArtifactPath(e.path)) continue;
    if (isDoctrineSkillsPath(e.path)) continue;
    if (e.untracked && isCodexDoctrinePath(e.path)) continue;
    out.push(e);
  }
  return out;
}

/**
 * The REAL-work paths in a `git status --porcelain -z` output — the list form of
 * {@link worktreeStatusHasWork} (which is now just `length > 0`), built on the same
 * {@link filteredWorkEntries} filter so the two (and {@link computeWorktreeGateStamp}'s `dirtyHash`)
 * can't drift apart. Exported so the worker_report(done) pre-check can NAME the uncommitted files in its
 * refusal. A rename/copy record contributes BOTH halves (card 8cc047d3: unlike
 * {@link parseAutoCommitStatusZ}'s staging-only semantic, a precheck/gate-stamp consumer wants the
 * COMPLETE dirty path set, not just what's stageable) — paths are the exact bytes git reported, never
 * quoted or escaped.
 */
export function uncommittedWorkFiles(porcelainZ: string): string[] {
  const paths: string[] = [];
  for (const e of filteredWorkEntries(porcelainZ)) {
    if (e.oldPath) paths.push(e.oldPath);
    paths.push(e.path);
  }
  return paths;
}

/**
 * @decision 6796c9ea — the ONE dirty-worktree predicate for merge finalize's worktree removal (solo + batch); `unknown` (git
 * error/timeout on a worktree that still has its `.git` link) is retained, never removed. A missing directory or one with no `.git` link reads `clean`.
 */
/** The ONE dead-leftover test (a pure fs stat, never a git op): a directory with NO `.git` link is no longer a git worktree, so git holds nothing there
 *  to lose. Shared by boot Pass B's leftover GC and {@link readWorktreeUncommittedState}. A `.git` that exists but points at a pruned gitdir is deliberately
 *  NOT a dead leftover here (git cannot read it, so it may still hold work — callers fail closed). */
export function worktreeHasGitLink(worktreePath: string): boolean {
  return fs.existsSync(path.join(worktreePath, ".git"));
}

/**
 * Find a child of `dirPath` that looks like a REAL repo-axis-held task worktree: its NAME matches
 * {@link TASK_KEY_SHAPE_RE} AND its `.git` entry is a FILE (a worktree link), never a directory.
 *
 * @decision c994ffeb — never match on "any child with a `.git` entry" alone — that over-matches a
 * half-removed orphan holding a real nested clone/submodule, refusing a cut that should be renamed
 * aside instead, with an error that wrongly implies a colliding repoKey exists.
 *
 * Returns the matching child's NAME (so the caller's error can describe what was actually found, never
 * asserting a specific repoKey exists) or `null` if nothing matches. Fails safe to `null` on any read
 * error. Bounded `readdirSync`, never a recursive scan.
 *
 * Exported (card ceeb188b) so `SessionService.reclaimWedgedWorktreePathForSpawn` (service.ts) can
 * consult the SAME predicate before its own unconditional rename-aside — the ONE shared signature for
 * "this dir is really a repo-axis dir holding a live nested worktree", never a second copy.
 */
export function findNestedWorktreeLikeChild(dirPath: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !TASK_KEY_SHAPE_RE.test(e.name)) continue;
    try {
      if (fs.statSync(path.join(dirPath, e.name, ".git")).isFile()) return e.name;
    } catch {
      // not a worktree-shaped child (no .git, or an unreadable one) — keep scanning.
    }
  }
  return null;
}
export type WorktreeUncommittedState = { state: "clean" } | { state: "dirty"; files: string[] } | { state: "unknown"; reason: string };
/** @decision b4cc7114 — `repoPath` (the real trusted main) is REQUIRED so the dirty-check below can
 *  verify the worktree's own commondir rather than opt out of verifying it; every caller already has it
 *  (finalizeMerge's gcWorktreeDir already takes a repoPath). */
export async function readWorktreeUncommittedState(repoPath: string, worktreePath: string, deps: BoundedGitDeps = {}): Promise<WorktreeUncommittedState> {
  // A missing dir, or a dead leftover with no `.git` link (the Windows busy-handle case: `git worktree remove` dropped the registration but the dir survived),
  // has nothing git can lose — it must reach removal, or the re-finalize paths built for exactly this leftover would never clean it.
  if (!worktreeHasGitLink(worktreePath)) return { state: "clean" };
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  // @decision b4cc7114 — this dirty check gates REAL worktree removal (finalizeMerge's retainIfUncommitted
  // path), not a misleading read only, so it threads the real trusted main instead of the opt-out. A
  // classified refusal lands in the catch below as state:"unknown", which the caller already retains on.
  const makeGit = deps.gitFactory ?? ((p, ms) => canonicalGit(p, ms, undefined, undefined, undefined, deps.trustedMainRoot ?? defaultTrustedMainRoot(repoPath)));
  try {
    const porcelainZ = await withTimeout(
      makeGit(worktreePath, timeoutMs).raw(["-c", "core.quotePath=false", "status", "--porcelain", "-z"]), timeoutMs, "git status --porcelain -z (finalize dirty check)",
    );
    // Untracked `node_modules/` is the worktree's own provisioned dependency install (createWorktree's dep-provisioning), regenerable and never a
    // worker's product — in a repo whose .gitignore lacks it, counting it would retain EVERY worktree. A TRACKED change under node_modules still counts.
    const files: string[] = [];
    for (const e of filteredWorkEntries(porcelainZ)) {
      if (e.untracked && /(^|\/)node_modules(\/|$)/.test(e.path)) continue;
      if (e.oldPath) files.push(e.oldPath);
      files.push(e.path);
    }
    return files.length > 0 ? { state: "dirty", files } : { state: "clean" };
  } catch (e) {
    return { state: "unknown", reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface DoneReportPrecheck {
  /** the working tree has REAL uncommitted changes (ignoring daemon-injected `.claude/` noise) → REFUSE the done. */
  uncommitted: boolean;
  /** the offending paths (porcelain, `.claude/` noise filtered) — named in the refusal so the worker knows what to commit. */
  files: string[];
  /** clean working tree, but the assigned branch is 0 commits ahead of base — a legit no-op done, surfaced as a WARNING (never a refusal). */
  zeroAhead: boolean;
  /** commits ahead of base on the assigned branch, when the `rev-list --count` step actually ran and
   *  parsed cleanly (0 when {@link zeroAhead} is true) — undefined whenever that step didn't run or
   *  failed (the dirty-tree short-circuit, no branch, or any git error/timeout under the FAIL SAFE
   *  degrade below). A caller that needs to distinguish "verified N commits ahead" from "couldn't
   *  determine" must check this is a number before trusting it — a falsy/undefined value is NOT 0. */
  aheadCount?: number;
}

/**
 * The ONE predicate for "is this a USABLE review-base sha" — `null`/`undefined`/`""` all mean "no review
 * base". Returns the usable sha itself (narrowed to `string`) or `null`.
 *
 * @decision 37fe091c — every call site needing this predicate routes through here, never a duplicated
 * ad hoc inline check that can drift from `workerBaseRef`'s own fallback.
 */
export function normalizeReviewBaseSha(reviewBaseSha: string | null | undefined): string | null {
  return typeof reviewBaseSha === "string" && reviewBaseSha.length > 0 ? reviewBaseSha : null;
}

/**
 * The value to stamp on `Session.reviewBaseSha` at spawn time — the reviewed tip ONLY when `createWorktree`
 * actually took the fresh forkFrom cut (`WorktreeInfo.forkedFromReviewed`); `null` for an aliased
 * reuse/reattach, exactly like a non-review spawn.
 *
 * @decision 37fe091c — every spawn-time stamping call site routes through here, never a duplicated
 * gating expression that could silently drift from what a test exercises.
 */
export function reviewBaseShaToStamp(forkedFromReviewed: boolean, reviewedHeadSha: string | null | undefined): string | null {
  return forkedFromReviewed ? (reviewedHeadSha ?? null) : null;
}

/**
 * The ONE place that decides what a worker's OWN work is measured against: a review spawn's branch is cut
 * from the REVIEWED branch's tip (`createWorktree`'s `forkFrom` param), not mainline, so it starts out
 * already carrying every commit the reviewed branch had at fork time — none of which the reviewer
 * authored. Comparing against mainline `HEAD` makes every inherited commit count as "the worker's own
 * ahead-of-base work", which is wrong for a review spawn and right for everyone else. `Session.reviewBaseSha`
 * (stamped once at spawn, card b866ab64) already records the correct base for a review spawn; `null`/
 * absent (the overwhelming majority) keeps comparing against mainline `HEAD`, byte-identical to before
 * this function existed.
 *
 * @decision 37fe091c — every ahead-of-base caller routes through this, never through an inline fallback.
 */
export function workerBaseRef(reviewBaseSha: string | null | undefined): string {
  return normalizeReviewBaseSha(reviewBaseSha) ?? "HEAD";
}

/**
 * The ONE place that decides whether a set of session rows sharing ONE worktree PATH agree on a
 * trustworthy `reviewBaseSha` — trusted ONLY when EVERY row is TASKLESS (`taskId` null; a taskless
 * row's own path can never be aliased, see project memory `worktreepath-is-per-task-not-per-spawn`) AND
 * they all agree on the same non-empty value; `null` otherwise (→ `workerBaseRef` falls back to
 * mainline `HEAD`). Pass every row sharing the path, never a single row in isolation — a TASKED path
 * CAN be shared by an aliasing sibling (the CR-round-2 defect), so trust must be decided PATH-level, not
 * per-row, or it depends on which row happens to be visited/read first.
 *
 * @decision 37fe091c — the ONE shared trust primitive every ahead-of-base-trust caller routes through —
 * both Pass B (via `reviewBaseShaConsensusByPath` below, grouping a full session set) and
 * `commitsAheadOfBase` (fed this row's freshly-read siblings) — never a duplicated predicate.
 */
export function trustedReviewBaseSha(
  rows: ReadonlyArray<{ taskId?: string | null; reviewBaseSha?: string | null }>,
): string | null {
  if (rows.length === 0 || !rows.every((r) => r.taskId == null)) return null;
  const seen = new Set<string | null>();
  for (const r of rows) seen.add(normalizeReviewBaseSha(r.reviewBaseSha));
  return seen.size === 1 ? [...seen][0]! : null;
}

/**
 * Groups every session row by `worktreePath` and resolves, per path, the `reviewBaseSha` to trust via
 * {@link trustedReviewBaseSha}. `sessions` is typically the FULL session set for a project boot pass,
 * never a filtered subset — a narrowed set would silently hide a real alias elsewhere in the full set.
 *
 * @decision 37fe091c — defense-in-depth half of the aliasing fix (the other half gates stamping at the
 * source — see `WorktreeInfo.forkedFromReviewed`); see that record's "Round 2"/"Round 3" sections.
 */
// @decision 40b63f1c — grouped (and must be looked up, via `worktreeIdentityKey`) by IDENTITY, never the
// raw `worktreePath` string — see that function's own doc for why two rows' raw strings can disagree.
export function reviewBaseShaConsensusByPath(
  sessions: ReadonlyArray<{ worktreePath?: string | null; taskId?: string | null; reviewBaseSha?: string | null }>,
): Map<string, string | null> {
  const byPath = new Map<string, Array<{ taskId?: string | null; reviewBaseSha?: string | null }>>();
  for (const s of sessions) {
    if (!s.worktreePath) continue;
    const key = worktreeIdentityKey(s.worktreePath);
    const rows = byPath.get(key) ?? [];
    rows.push({ taskId: s.taskId, reviewBaseSha: s.reviewBaseSha });
    byPath.set(key, rows);
  }
  const consensus = new Map<string, string | null>();
  for (const [key, rows] of byPath) consensus.set(key, trustedReviewBaseSha(rows));
  return consensus;
}

/** @decision 907b9f50 — catch a worker's forgotten commit AT THE SOURCE, before `done` reaches review;
 *  dirty tree ⇒ hard refusal, 0-ahead clean ⇒ warn-only, else reports the verified `aheadCount`. FAILS
 *  SAFE (ALLOW) on any git error/timeout — never wedge a legitimate done on a flaky/timed-out git call. */
export async function precheckWorkerDone(
  repoPath: string,
  worktreePath: string,
  branch: string | null,
  base = "HEAD",
  deps: BoundedGitDeps = {},
): Promise<DoneReportPrecheck> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  // @decision 3a5c5d4a (round 2, S2) — a reviewed advisory-read residual site: a read-only dirty check.
  const makeGit = deps.gitFactory ?? ((p, ms) => canonicalGit(p, ms, undefined, undefined, undefined, undefined, BOUNDED_GIT_ADVISORY_READ));

  // (1) Dirty working tree? Read porcelain status IN the worktree (its own index + working tree),
  //     ignoring daemon-injected untracked `.claude/` noise (see uncommittedWorkFiles).
  try {
    const wt = makeGit(worktreePath, timeoutMs);
    const porcelainZ = await withTimeout(
      wt.raw(["-c", "core.quotePath=false", "status", "--porcelain", "-z"]), timeoutMs, "git status --porcelain -z",
    );
    const files = uncommittedWorkFiles(porcelainZ);
    if (files.length > 0) return { uncommitted: true, files, zeroAhead: false };
  } catch {
    return { uncommitted: false, files: [], zeroAhead: false }; // FAIL SAFE: never block a legitimate done
  }

  // (2) Clean working tree. Is the assigned branch 0 commits ahead of base? → WARN-only signal.
  if (branch) {
    try {
      // @decision 4b559feb — `--end-of-options` before the range: defense-in-depth, same class as 868e0135.
      const ahead = parseInt(
        (await withTimeout(git.raw(["rev-list", "--count", "--end-of-options", `${base}..refs/heads/${branch}`]), timeoutMs, "git rev-list --count")).trim(),
        10,
      );
      if (Number.isFinite(ahead) && ahead === 0) return { uncommitted: false, files: [], zeroAhead: true, aheadCount: 0 };
      if (Number.isFinite(ahead)) return { uncommitted: false, files: [], zeroAhead: false, aheadCount: ahead };
    } catch {
      return { uncommitted: false, files: [], zeroAhead: false }; // FAIL SAFE
    }
  }

  return { uncommitted: false, files: [], zeroAhead: false };
}

// ── Codex worker auto-commit (board card 00a6cdd6) ──────────────────────────────────────────────────
//
// Owner-approved boundary (card 00a6cdd6, request 54aba8b2): daemon-side, worktree-scoped, branch-
// scoped, NO push, triggered ONLY by a codex-harness worker's own `done` report. This is the ONLY caller
// this code exists for — SessionService.workerReport calls it, immediately before precheckWorkerDone
// and AFTER every earlier done-report refusal (pending-direction, the auto-recovery dedupe) AND after
// its own `report.noChanges` check (a worker DECLARING no changes must never be auto-committed for,
// even if real dirty files are present — see the Code Review fix on card 00a6cdd6, "B1") — so a report
// that's refused, or that declares noChanges, commits NOTHING.

/** Basenames that change the BEHAVIOR of a later git operation (filter/diff driver dispatch, submodule
 *  remote URLs, LFS endpoint config) rather than just data. Matched by basename at ANY depth — a nested
 *  `sub/.gitattributes` governs its own subtree exactly like a root one. Refused from the codex auto-
 *  commit's automatic staging unconditionally, so a change to any of them always gets a human's eyes
 *  before it's committed via this path — regardless of whether codex's own sandbox can currently define
 *  a NEW filter command (it can't: that lives in `.git/config`, which its DENY ACE already blocks). */
const AUTOCOMMIT_REFUSED_BASENAMES = new Set([".gitattributes", ".gitmodules", ".lfsconfig"]);

/** Reserved metadata directory names (codex's own `PROTECTED_METADATA_PATH_NAMES`) — a path under any of
 *  these shouldn't appear in `git status --porcelain` output at all; checked anyway since it's free. */
const AUTOCOMMIT_PROTECTED_DIR_NAMES = new Set([".git", ".agents", ".codex"]);

/**
 * Why a candidate path must NOT be auto-staged, or `undefined` if it's fine. Three checks, in order:
 * (1) a basename that redefines git behavior ({@link AUTOCOMMIT_REFUSED_BASENAMES}); (2) a path segment
 * naming a protected metadata dir; (3) a SYMLINK whose target resolves outside the worktree (git itself
 * only ever stores the link TEXT as the blob — never follows it — so this is about not letting an
 * out-of-tree path reference land in a commit at all, not about data exfiltration, which this can't do
 * either way) — checked even when the link is DANGLING (Code Review fix, "S3"): `fs.realpathSync`
 * throws ENOENT for a dangling target exactly like it would for a genuinely absent PATH, so the two
 * must be told apart at the `lstatSync` layer, never conflated by catching both the same way. A
 * candidate path that no longer exists AT ALL (a deletion — `lstatSync` itself throws ENOENT) is NOT
 * anomalous; any OTHER stat failure (permission, etc.) fails CLOSED (flagged), matching this feature's
 * narrow, err-on-the-side-of-a-human-looks posture.
 */
function autoCommitAnomalyReason(worktreePath: string, relPath: string): string | undefined {
  const base = path.basename(relPath);
  if (AUTOCOMMIT_REFUSED_BASENAMES.has(base)) {
    return `${relPath} changes git behavior (filter/submodule/LFS config) and needs human review`;
  }
  const segments = relPath.split(/[\\/]/);
  if (segments.some((s) => AUTOCOMMIT_PROTECTED_DIR_NAMES.has(s))) {
    return `${relPath} sits under a protected metadata directory`;
  }
  const abs = path.resolve(worktreePath, relPath);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs); // the candidate path ITSELF doesn't exist → ENOENT here → genuine deletion
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    return `${relPath} could not be verified (${gitError(e)})`;
  }
  if (st.isDirectory()) {
    // Code Review "should-fix 1": a NESTED repo (a directory carrying its own `.git`) is exactly the
    // one directory shape `git status` refuses to expand even under `--untracked-files=all` — it stays
    // collapsed to the bare directory name, which is how this candidate can even BE a directory here at
    // all (an ordinary untracked directory is always expanded into its own files by `-uall`, so it
    // never reaches this scan as a directory candidate). Staging it would record a GITLINK — a tree
    // entry pointing at the nested repo's OWN commit sha, not its content — never real, reviewable data.
    if (fs.existsSync(path.join(abs, ".git"))) {
      return `${relPath} is a directory containing its own .git — staging it would create a gitlink, not real content`;
    }
    return undefined;
  }
  if (!st.isSymbolicLink()) return undefined;

  const worktreeReal = fs.realpathSync(worktreePath);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    // DANGLING symlink: the link itself exists (lstat above proved it), but its target does not, so
    // realpathSync throws — that throw must NOT be read as "nothing to check" (the bug this fixes): the
    // link's own TEXT can still name an out-of-tree path. Resolve it syntactically instead, against the
    // symlink's own directory (matching how a relative symlink target is actually interpreted).
    const linkTarget = fs.readlinkSync(abs);
    real = path.isAbsolute(linkTarget) ? path.resolve(linkTarget) : path.resolve(path.dirname(abs), linkTarget);
  }
  const rel = path.relative(worktreeReal, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return `${relPath} is a symlink resolving outside the worktree (${real})`;
  }
  return undefined;
}

/**
 * `git status --porcelain -z --untracked-files=all` into one entry per STAGEABLE path (Code Review "S1"),
 * built on the shared {@link parsePorcelainStatusZ} (card 8cc047d3 — this used to have its own parsing
 * loop; that generalized into the shared one, this is now a thin projection over it). A combined
 * rename/copy record's OLD half is ALREADY staged — it exists nowhere `git add` could act on, so
 * re-adding it fails outright ("pathspec did not match any files", verified directly) — {@link
 * parsePorcelainStatusZ} still consumes that field to stay positioned for the next record, but this
 * wrapper drops it rather than emitting it. Separate from {@link uncommittedWorkFiles} on purpose:
 * that caller wants the OLD half too (the complete dirty path set), this one must not stage it. An
 * UNSTAGED rename (a plain filesystem move, since a codex worker can't run `git mv`) never reaches the
 * rename branch at all: it arrives as two independent `D`/`??` records, each already its own entry.
 */
function parseAutoCommitStatusZ(porcelainZ: string): { path: string; untracked: boolean }[] {
  return parsePorcelainStatusZ(porcelainZ).map((e) => ({ path: e.path, untracked: e.untracked }));
}

/** First non-empty line of `text`, trimmed; `""` for empty/whitespace-only input. */
function firstLine(text: string): string {
  return (text ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** Everything after the first line of `text`, trimmed; `undefined` if there is no second line. */
function restAfterFirstLine(text: string): string | undefined {
  const idx = (text ?? "").indexOf("\n");
  if (idx === -1) return undefined;
  const rest = text.slice(idx + 1).trim();
  return rest || undefined;
}

/**
 * {@link toConventionalSubject} bounded to `maxLen` (default 72, the conventional git-subject-line
 * convention) — preserves the coerced `type(scope)?: ` prefix and truncates only the description, so a
 * long card title or a long worker summary line still reads as a valid conventional subject rather than
 * being blindly sliced mid-prefix.
 */
export function boundConventionalSubject(raw: string, maxLen = 72): string {
  const subject = toConventionalSubject(raw);
  if (subject.length <= maxLen) return subject;
  const m = /^([a-z]+(?:\([^)]+\))?!?: )([\s\S]*)$/.exec(subject);
  if (!m) return `${subject.slice(0, Math.max(0, maxLen - 1))}…`;
  const prefix = m[1] ?? "";
  const desc = m[2] ?? "";
  const room = maxLen - prefix.length - 1;
  if (room <= 0) return `${(prefix + desc).slice(0, Math.max(0, maxLen - 1))}…`;
  return `${prefix}${desc.slice(0, room).trimEnd()}…`;
}

/** Discriminated outcome of {@link attemptCodexAutoCommit} — see that function's own doc. */
export interface CodexAutoCommitResult {
  /** Whether the feature actually evaluated the worktree (false only on a fail-safe infra skip, e.g. a
   *  HEAD-read error/timeout — mirrors precheckWorkerDone's own fail-safe-on-flakiness posture). */
  attempted: boolean;
  committed: boolean;
  sha?: string;
  fileCount?: number;
  subject?: string;
  /** Set when attempted but deliberately NOT committed for a reason other than a HEAD mismatch (an
   *  anomalous path, or a git error during add/commit). The caller falls through to the pre-existing
   *  precheckWorkerDone-based "uncommitted" refusal, which will re-see the same dirty tree — this text
   *  is appended to THAT refusal so the report stays actionable. */
  skippedReason?: string;
  /** Set ONLY on an AFFIRMATIVE HEAD/branch mismatch (a successful read that disagrees) — the caller
   *  short-circuits with its OWN distinct refusal instead of falling through, since precheckWorkerDone
   *  doesn't check ref identity at all and would otherwise let a wrong-branch worktree through silently. */
  headMismatch?: { head: string };
  /** Code Review "B1 residual": set when a failure struck AFTER `add` started and this function could
   *  NOT determine whether the commit actually landed (HEAD itself became unreadable). Distinct from
   *  ordinary `committed:false` — the caller must FAIL CLOSED (refuse the done outright) rather than
   *  fall through to precheckWorkerDone, which could find a since-cleaned worktree and wrongly accept
   *  a done with no audit trail for a commit that may or may not exist. */
  commitStateUnknown?: boolean;
  error?: string;
}

/**
 * `core.hooksPath` override target (Code Review "B2"): a NON-DIRECTORY, so nothing can ever plant a
 * hook into it. A prior design used a fresh `mkdtemp`'d directory under `os.tmpdir()`, reasoning the
 * daemon's own single JS turn left no window to react — but that only covers the DAEMON's event loop,
 * not a genuinely-concurrent OS process the worker started earlier: `os.tmpdir()` sits inside codex
 * `workspace-write`'s default writable set on macOS/Linux (confirmed via `pty/codex-host.ts` — Loom
 * passes no `--add-dir`/`exclude_slash_tmp`/`exclude_tmpdir_env_var`), and codex runs as the daemon's own
 * uid, so a background process could poll for the new dir and plant a hook before our `commit` reads it.
 * `os.devNull` closes this structurally: `<devNull>/<hookname>` can never exist, so git's `find_hook()`
 * always reports "no such hook" — verified against real git via a shell-free spawned child (this
 * host's own `/dev/null` could otherwise be a bash-layer artifact, not proof git itself resolves it);
 * see `test/codex-worker-auto-commit.mjs`'s header for which platform(s) that proof actually ran on.
 */
const AUTOCOMMIT_HOOKS_PATH = os.devNull;

/**
 * Owner-approved (card 00a6cdd6): commit a codex-harness worker's own uncommitted worktree changes onto
 * its OWN assigned branch, as a side effect of handling its `done` report — never called for a
 * claude-harness worker, no new agent-callable tool, never pushes. See {@link autoCommitAnomalyReason},
 * {@link parseAutoCommitStatusZ}, and {@link AUTOCOMMIT_HOOKS_PATH}'s own doc for the load-bearing
 * sub-decisions; this function is the A→D sequence over all three.
 */
export async function attemptCodexAutoCommit(
  worktreePath: string,
  branch: string,
  subjectSource: { taskTitle?: string; summary: string },
  deps: BoundedGitDeps = {},
): Promise<CodexAutoCommitResult> {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  // Code Review "S4": the extra `unsafe` allowances this feature needs (`allowUnsafeHooksPath`/
  // `allowUnsafeFsMonitor`, for the `-c` args below) are passed ONLY through THIS dedicated default
  // factory, via boundedSimpleGit's own opt-in `extraUnsafe` param — never added to that shared
  // chokepoint's unconditional allowlist, so no OTHER caller's `unsafe` set is widened by this feature.
  // @decision a746a3eb — `localNonInteractiveEnv()`: every read/write below calls this instance's own
  // `.raw()` directly against the worktree, which never touches a remote.
  //
  // @decision 967eb326 — pin LC_ALL/LANGUAGE=C at construction, never via a LATER `.env()` mutation on
  // this instance — the detached-HEAD classification below needs git's fatal text in English regardless
  // of host locale, or it silently disarms and fails safe to "not stranded"/"skip the auto-commit".
  // @decision 3a5c5d4a — `deps.trustedMainRoot`, never defaulted to `worktreePath`: see BoundedGitDeps's
  // own doc for why this caller specifically cannot inherit `quarantineRepoPath`'s default here.
  const makeGit = deps.gitFactory
    ?? ((p, ms) => canonicalGit(p, ms, localReadGitEnv(localNonInteractiveEnv(), { LC_ALL: "C", LANGUAGE: "C" }), undefined, { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true }, deps.trustedMainRoot));
  let git: Pick<SimpleGit, "raw">;
  try {
    git = makeGit(worktreePath, timeoutMs);
  } catch {
    return { attempted: false, committed: false }; // FAIL SAFE: construct failure → skip, existing flow handles it
  }
  const cfg = ["-c", `core.hooksPath=${AUTOCOMMIT_HOOKS_PATH}`, "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"];

  // (A) HEAD check. card 967eb326 — `symbolic-ref HEAD` is never ambiguity-shortened, unlike
  // `rev-parse --abbrev-ref HEAD` (see docs/decisions/2a6a292a-* "Round 13") — a same-named tag or
  // refs/remotes/<name>/HEAD can otherwise make this read "heads/<branch>" and silently skip the
  // auto-commit.
  let headRef: string | null = null;
  try {
    const raw = (await withTimeout(
      git.raw([...cfg, "symbolic-ref", "HEAD"]), timeoutMs, "codex-auto-commit symbolic-ref HEAD",
    )).trim();
    // card 967eb326 (Code Review minor 2) — a SUCCESSFUL-but-EMPTY read is a killed/transient child
    // (card 787dd2a7's own precedent), never a confirmed detached HEAD: a genuinely detached HEAD
    // THROWS with NOT_A_SYMBOLIC_REF's text below, so an empty resolve means the read was interrupted
    // before it could say anything — fail safe exactly like an unreadable HEAD does, rather than report
    // a false headMismatch naming "HEAD".
    if (!raw) return { attempted: false, committed: false };
    headRef = raw;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!NOT_A_SYMBOLIC_REF.test(msg)) {
      return { attempted: false, committed: false }; // FAIL SAFE: unreadable HEAD → skip, never refuse on infra flakiness
    }
    headRef = null; // CONFIRMED detached HEAD — the read completed and said so
  }
  const head = headRef
    ? (headRef.startsWith("refs/heads/") ? headRef.slice("refs/heads/".length) : headRef)
    : "HEAD"; // detached HEAD, matching what `rev-parse --abbrev-ref HEAD` used to report for the same state
  if (headRef !== `refs/heads/${branch}`) return { attempted: true, committed: false, headMismatch: { head } };

  // (B) status, filtered. `-z --untracked-files=all`: the `-z` half (Code Review "S1") NUL-delimits and
  // never quotes/escapes a path — see parseAutoCommitStatusZ's own doc; `--untracked-files=all` is
  // load-bearing on its own — without it, an entirely-untracked directory collapses to ONE porcelain
  // line naming the directory itself, hiding a nested `sub/.gitattributes` from the anomaly scan below
  // (its basename check would only ever see the string "sub") and staging the whole directory instead
  // of the exact files in it.
  let porcelainZ: string;
  try {
    porcelainZ = await withTimeout(
      git.raw([...cfg, "status", "--porcelain", "-z", "--untracked-files=all"]), timeoutMs, "codex-auto-commit status --porcelain -z",
    );
  } catch {
    return { attempted: false, committed: false }; // FAIL SAFE
  }
  const candidates = [...new Set(
    parseAutoCommitStatusZ(porcelainZ)
      .filter((e) => !(e.untracked && isDoctrineArtifactPath(e.path)))
      .filter((e) => !isDoctrineSkillsPath(e.path))
      .filter((e) => !(e.untracked && isCodexDoctrinePath(e.path)))
      .map((e) => e.path),
  )];
  if (candidates.length === 0) return { attempted: true, committed: false };

  // (C) anomaly scan — any hit aborts the WHOLE attempt, never a partial stage.
  const anomalies = candidates
    .map((rel) => autoCommitAnomalyReason(worktreePath, rel))
    .filter((r): r is string => !!r);
  if (anomalies.length > 0) {
    return {
      attempted: true, committed: false,
      skippedReason: `Loom's automatic commit for this codex worker was skipped — ${anomalies.length} path(s) need human review: ${anomalies.join("; ")}`,
    };
  }

  // (D) subject/body.
  const subject = boundConventionalSubject(subjectSource.taskTitle?.trim() || firstLine(subjectSource.summary) || "worker changes");
  const rawBody = subjectSource.taskTitle?.trim() ? subjectSource.summary : restAfterFirstLine(subjectSource.summary);
  const body = rawBody?.trim() ? stripClaudeSessionTrailer(rawBody).message.trim() : undefined;

  // Code Review "B1 residual": the pre-commit HEAD, read BEFORE `add` runs, is the reference point every
  // later recovery check below compares against — the only way to tell "the commit call reported
  // failure but the ref moved anyway" apart from "it genuinely never landed".
  let preCommitSha: string;
  try {
    preCommitSha = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "codex-auto-commit rev-parse HEAD (pre-commit)")).trim();
  } catch {
    return { attempted: false, committed: false }; // FAIL SAFE — same posture as every earlier read
  }

  // Card 27ac3c2d: on a host where git can't resolve an identity for this commit (e.g. a fresh
  // end-user machine with no git identity configured), the commit call below otherwise fails with
  // "Author identity unknown" and this codex worker's `done` report would then be refused outright.
  // Falls back via the ONE shared helper (resolveGitIdentityFallbackArgs, git/bounded.ts) ONLY when git
  // itself can't determine an identity — a host whose own identity git CAN resolve commits
  // byte-identically to before this change. `baseEnv` is this commit's own env (`nonInteractiveEnv()`,
  // the same env `killableCanonicalRaw` below is called with) so the probe reads identity under the
  // SAME env the real commit will run under.
  // @decision 2267e8fa (card 7b59e981) — PER-ROLE env overrides, merged into the commit's own explicit env below, never
  // spliced into argv.
  // @decision 3a5c5d4a (round 3, B2) — thread `deps.trustedMainRoot`, same real root `makeGit` above
  // already uses; a refusal here fails safe exactly like every other read in this function.
  let identityEnv: Record<string, string>;
  try {
    identityEnv = await resolveGitIdentityFallbackArgs(
      worktreePath, timeoutMs,
      deps.identityProbeGitFactory ?? (deps.gitFactory ? unpinnedProbeFactoryFromLegacy(deps.gitFactory) : undefined),
      nonInteractiveEnv(),
      deps.trustedMainRoot,
    );
  } catch {
    return { attempted: false, committed: false }; // FAIL SAFE — same posture as every earlier read
  }

  try {
    // Code Review "S2": `--literal-pathspecs` is a GLOBAL flag (before the subcommand, alongside the
    // `-c` args) — `--` alone does NOT stop pathspec magic/globbing, so a candidate literally named `*`
    // or `:(glob)**` would otherwise expand against the filesystem and stage paths this scan never saw
    // (verified directly: `git add -- '*'` matches every file in the dir without this flag).
    await withTimeout(
      git.raw(["--literal-pathspecs", ...cfg, "add", "--", ...candidates]), timeoutMs, "codex-auto-commit add",
    );
  } catch (e) {
    // `add` never moves HEAD, so a failure here genuinely stages nothing — the ordinary fall-through to
    // precheckWorkerDone's uncommitted-files refusal is correct as-is, no recovery check needed.
    return { attempted: true, committed: false, error: gitError(e) };
  }

  // Code Review "B1 residual": `commit` is the ONE call here that MUTATES the ref, so it is the one
  // that must never be abandoned mid-flight by a bare `withTimeout` race — a "failure" it reports could
  // otherwise still be followed by the real git child finishing the commit moments later, unobserved.
  // @decision 24c0bdba — `killableCanonicalRaw` (git/bounded.ts) only settles once the child is CONFIRMED
  // dead, closing that window structurally; the test seam (`deps.gitFactory`) stays a plain `withTimeout`.
  //
  // @decision bde5d1fe — DELIBERATE EXEMPTION from "always pass the real canonical repo as
  // `quarantineRepoPath`": `24c0bdba` already disables hooks here (core.hooksPath=devNull, unrelated
  // reason — see this function's own factory), so there's no hook-escape vector to close; left at default.
  // @decision 3a5c5d4a — `trustedMainRoot` is passed EXPLICITLY (`deps.trustedMainRoot`), never left to
  // inherit `quarantineRepoPath`'s own default above — that default is `worktreePath` itself (the above
  // exemption), which would make checkCommondirTrust compare the worktree's commondir against itself.
  const messageArgs = body ? ["-m", subject, "-m", body] : ["-m", subject];
  const commitArgs = [...cfg, "commit", "--no-verify", ...messageArgs];
  const commitLabel = "codex-auto-commit commit";
  let commitThrew: unknown;
  try {
    await killableCanonicalRaw(worktreePath, commitArgs, timeoutMs, commitLabel, deps.gitFactory, { ...nonInteractiveEnv(), ...identityEnv }, undefined, undefined, undefined, deps.trustedMainRoot);
  } catch (e) {
    commitThrew = e;
  }

  // Whichever path above ran, verify what ACTUALLY happened via HEAD rather than trusting `commit`'s own
  // success/failure signal alone (Code Review "B1 residual"): a post-commit read failing after a
  // genuinely successful commit must never be reported as `committed:false` — that would let the
  // caller's fall-through precheck see a clean tree and accept the done with no audit trail at all. ONE
  // retry: a bare `rev-parse HEAD` is cheap and a single transient failure (unlike `commit` itself,
  // already protected above) shouldn't be enough to declare the state permanently unknown.
  let headAfter: string | undefined;
  for (let attempt = 0; attempt < 2 && headAfter === undefined; attempt++) {
    try {
      headAfter = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "codex-auto-commit rev-parse HEAD (post-commit)")).trim();
    } catch { /* retried once below; if both attempts fail, handled via commitStateUnknown */ }
  }

  if (headAfter !== undefined && headAfter !== preCommitSha) {
    // HEAD moved — a commit landed, whether or not `commit` itself reported success. Recover it.
    return { attempted: true, committed: true, sha: headAfter, fileCount: candidates.length, subject };
  }
  if (!commitThrew) {
    // `commit` reported success (git only does that after actually moving the ref), yet HEAD reads as
    // unchanged or unreadable — a contradiction that must NEVER be reported as a plain "not committed":
    // fail CLOSED rather than let a real commit go unaudited and undiscovered.
    return {
      attempted: true, committed: false, commitStateUnknown: true,
      error: headAfter === undefined ? "commit reported success but HEAD is now unreadable" : "commit reported success but HEAD did not move",
    };
  }
  if (headAfter === undefined) {
    // `commit` failed/timed out AND HEAD is unreadable — genuinely unknown whether it landed anyway.
    return { attempted: true, committed: false, commitStateUnknown: true, error: gitError(commitThrew) };
  }
  // `commit` failed/timed out, HEAD is readable, and it did NOT move — genuinely failed, tree still
  // dirty, the ordinary fall-through to precheckWorkerDone's uncommitted-files refusal is correct.
  return { attempted: true, committed: false, error: gitError(commitThrew) };
}

/** @decision 9cb0287a — SAFE-TO-DISCARD guard for boot-reconcile Pass B (the 2026-06-05 P0 data-loss fix);
 *  "work" = dirty tree OR branch ahead of base; FAILS SAFE to TRUE (assume work) — a wedged/locked check must
 *  never be why a live worktree is deleted.
 *
 *  Don't re-apply this to Pass A; its squash-trailer proof is the
 *  stronger replacement. */
export async function worktreeHasWork(
  repoPath: string,
  worktreePath: string,
  branch: string | null,
  base = "HEAD",
  deps: BoundedGitDeps = {},
): Promise<boolean> {
  // boundedGit itself never throws on a bad repoPath (board card 0f965ab7 — it degrades to a git handle
  // whose methods reject instead), so the ops below already see that as an ordinary bounded failure and
  // fail safe through their own catches; no separate wrap is needed here.
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  // @decision b4cc7114 — this `wt` handle feeds a REAL GC-deletion decision, not a misleading read only,
  // so it threads the real trusted main instead of the 3a5c5d4a advisory-read opt-out (same pattern
  // diffBranch's own worktree-scoped read already uses).
  const makeGit = deps.gitFactory ?? ((p, ms) => canonicalGit(p, ms, undefined, undefined, undefined, deps.trustedMainRoot ?? defaultTrustedMainRoot(repoPath)));

  // (1) Dirty working tree? Read porcelain status IN the worktree (its own index + working tree),
  //     ignoring daemon-injected untracked `.claude/` noise (see worktreeStatusHasWork).
  try {
    const wt = makeGit(worktreePath, timeoutMs);
    const porcelainZ = await withTimeout(
      wt.raw(["-c", "core.quotePath=false", "status", "--porcelain", "-z"]), timeoutMs, "git status --porcelain -z",
    );
    if (worktreeStatusHasWork(porcelainZ)) return true;
  } catch {
    return true; // bounded failure → fail SAFE (assume work, keep the dir)
  }

  // (2) Branch ahead of the canonical base? Any commit reachable from the branch but not from `base`.
  // @decision 56c10535 — resolved via resolveBranchTip's exact for-each-ref lookup, never a bare
  // `refs/heads/<branch>` STRING (still DWIM-reachable once the branch is missing). A null resolve
  // fails SAFE to true (assume work) — see decision 9cb0287a's own "Do not" on this function's default.
  if (branch) {
    try {
      const branchTip = await resolveBranchTip(repoPath, branch, deps);
      if (!branchTip) return true; // missing/unreadable branch → fail SAFE / has work
      // @decision 4b559feb — `--end-of-options` before the range: defense-in-depth, same class as 868e0135.
      const ahead = parseInt(
        (await withTimeout(git.raw(["rev-list", "--count", "--end-of-options", `${base}..${branchTip}`]), timeoutMs, "git rev-list --count")).trim(),
        10,
      );
      if (!Number.isFinite(ahead) || ahead > 0) return true; // NaN (parse error) or >0 → fail SAFE / has work
    } catch {
      return true; // bounded failure → fail SAFE
    }
  }

  return false;
}

export interface StrandedWork {
  /** AFFIRMATIVE only: true ⇒ the worktree carries committed work that is NOT on the assigned branch. */
  stranded: boolean;
  /** the divergent (self-created) branch the worktree is actually on. */
  branch?: string;
  /** short SHA of that branch's tip — the commit that would be silently lost. */
  commit?: string;
  /** commits on the divergent branch but not on canonical main. */
  ahead?: number;
  /** @decision b4cc7114 — true only when a commondir-trust refusal on the WORKTREE's own `wt` probe
   *  forced stranded:true; branch/commit/ahead are absent then — word a refusal around verification
   *  failure, never a named branch/commit. See `refusalText` for the sibling REPO-level case. */
  verificationRefused?: boolean;
  /** @decision b4cc7114 (round 2, m1) — set ONLY for a classified refusal from the REPO-level `git`
   *  handle (never the `wt` probe — see `verificationRefused`): the real `describeGitFailure`-classified
   *  message (e.g. a pin-mismatch's own repin guidance), never the worktree-commondir wording. */
  refusalText?: string;
}

/** MERGE-GATE BACKSTOP (2026-06-10): catches a worker whose commits are STRANDED on a self-created
 *  branch instead of its assigned `loom/<key>` (incident: worker `712fd5aa`, commit `1309552` silently
 *  lost via an empty squash merge). FAILS SAFE to `{stranded:false}` on any ORDINARY error.
 *
 *  @decision b4cc7114 — a classified commondir-trust refusal on the `wt` probe fails safe the OTHER way,
 *  to `{stranded:true, verificationRefused:true}` — an unverifiable worktree must never read as clean.
 *  @decision b4cc7114 (round 2, m1) — a refusal from the REPO-level `git` handle (e.g. a durable
 *  commondir-trust PIN mismatch on `repoPath` itself) is a DIFFERENT object with its own remedy (repin
 *  guidance, never "the worktree's commondir") — scoped to its own try block below, see `refusalText`. */
export async function detectStrandedWork(
  repoPath: string,
  worktreePath: string,
  assignedBranch: string,
  deps: BoundedGitDeps = {},
): Promise<StrandedWork> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  // @decision 967eb326 — pin LC_ALL/LANGUAGE=C at construction so the detached-HEAD classification
  // below matches git's fatal text under any locale — an unpinned read would otherwise silently fail
  // safe to stranded:false even for a worktree genuinely stranded on a detached HEAD.
  // @decision b4cc7114 — `wt` below gates a real merge-refusal decision, not a misleading read only, so
  // it threads the real trusted main instead of the 3a5c5d4a advisory-read opt-out.
  const makeGit = deps.gitFactory ?? ((p, ms) => canonicalGit(p, ms, localReadGitEnv(process.env, { LC_ALL: "C", LANGUAGE: "C" }), undefined, undefined, deps.trustedMainRoot ?? defaultTrustedMainRoot(repoPath)));

  let mainSha: string;
  try {
    mainSha = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD")).trim();

    // (1) Work on the ASSIGNED branch? Any commit reachable from it but not from canonical main ⇒ the
    //     normal path — not stranded, regardless of what the worktree is checked out on.
    // card 967eb326 — qualify as refs/heads/ so a same-named tag can never win over the real branch
    // (a bare revision resolves a same-named tag first; see docs/decisions/2a6a292a-* "Round 13").
    // @decision 4b559feb — `--end-of-options` before the range: defense-in-depth, same class as 868e0135.
    const assignedAhead = parseInt(
      (await withTimeout(git.raw(["rev-list", "--count", "--end-of-options", `${mainSha}..refs/heads/${assignedBranch}`]), timeoutMs, "git rev-list --count assigned")).trim(),
      10,
    );
    if (Number.isFinite(assignedAhead) && assignedAhead > 0) return { stranded: false };
  } catch (e) {
    // @decision b4cc7114 (round 2, m1) — this phase reads ONLY the REPO-level `git` handle (never `wt`);
    // a classified refusal here is worded via its OWN describeGitFailure classification (e.g. a
    // pin-mismatch's own repin guidance), never `verificationRefused`'s worktree-commondir wording.
    if (e instanceof CanonicalGitRefusal) {
      const d = describeGitFailure(e);
      return { stranded: true, refusalText: canonicalFailureMessage(d, `could not determine whether this worktree holds stranded work: ${d.text}`) };
    }
    return { stranded: false }; // FAIL SAFE: a check error/timeout must never block a legitimate merge
  }

  // (2) Assigned branch is empty (0 ahead). Inspect the WORKTREE's actual checked-out branch.
  // card 967eb326 — `symbolic-ref HEAD` is never ambiguity-shortened, unlike `rev-parse --abbrev-ref
  // HEAD` (which can resolve to "heads/<name>" beside a same-named tag or refs/remotes/<name>/HEAD).
  try {
    const wt = makeGit(worktreePath, timeoutMs);
    let wtBranchRef: string | null = null;
    try {
      const raw = (await withTimeout(wt.raw(["symbolic-ref", "HEAD"]), timeoutMs, "git symbolic-ref HEAD")).trim();
      // card 967eb326 (Code Review minor 2) — a SUCCESSFUL-but-EMPTY read is a killed/transient child
      // (card 787dd2a7's own precedent), never a confirmed detached HEAD: a genuinely detached HEAD
      // THROWS with NOT_A_SYMBOLIC_REF's text below, so an empty resolve means the read was interrupted
      // before it could say anything at all — fail safe exactly like the old `!wtBranch` guard did,
      // rather than treat an ambiguous empty read as "confirmed detached".
      if (!raw) return { stranded: false };
      wtBranchRef = raw;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!NOT_A_SYMBOLIC_REF.test(msg)) throw e; // genuine read failure → outer catch fails safe
      wtBranchRef = null; // CONFIRMED detached HEAD — the read completed and said so
    }
    const wtBranch = wtBranchRef
      ? (wtBranchRef.startsWith("refs/heads/") ? wtBranchRef.slice("refs/heads/".length) : wtBranchRef)
      : "HEAD";
    if (wtBranchRef === `refs/heads/${assignedBranch}`) return { stranded: false }; // same branch ⇒ no divergence

    // @decision 4b559feb — `--end-of-options` before the range: defense-in-depth, same class as 868e0135.
    const wtAhead = parseInt(
      (await withTimeout(wt.raw(["rev-list", "--count", "--end-of-options", `${mainSha}..HEAD`]), timeoutMs, "git rev-list --count worktree")).trim(),
      10,
    );
    if (!Number.isFinite(wtAhead) || wtAhead <= 0) return { stranded: false }; // nothing committed anywhere ⇒ nothing to strand

    const commit = (await withTimeout(wt.raw(["rev-parse", "--short", "HEAD"]), timeoutMs, "git rev-parse --short HEAD")).trim();
    return { stranded: true, branch: wtBranch, commit, ahead: wtAhead };
  } catch (e) {
    // @decision b4cc7114 — a classified commondir-trust refusal on the WORKTREE's own probe fails safe
    // the OTHER way (assume stranded), never as clean/not-stranded; an ordinary error/timeout keeps the
    // fail-safe below. Scoped to THIS try block only (round 2, m1) — a repo-level refusal is handled above.
    if (e instanceof CanonicalGitRefusal) return { stranded: true, verificationRefused: true };
    return { stranded: false }; // FAIL SAFE: a check error/timeout must never block a legitimate merge
  }
}

export interface CanonicalDirtyOverlap {
  /** AFFIRMATIVE only: true ⇒ the canonical repo has UNSTAGED tracked changes on a path this branch also touches, AND `git merge --squash` would actually need to write there. */
  overlap: boolean;
  /** the overlapping paths — present only when overlap:true. */
  paths?: string[];
  /** Card 4b7ff996 CR follow-up: true ONLY when the probe itself errored/timed out (never set on a clean
   *  "genuinely no overlap" result) — see the catch below for why this exists: a probe that silently fails
   *  open forever is indistinguishable from a clean repo without it. */
  probeFailed?: boolean;
}

/** @decision 4b7ff996 — admission-time preflight for a squash that can structurally never land: canonical has
 *  unstaged TRACKED changes on a path the branch touches, asked cheaply before the ~8-17min gate.
 *
 *  Never widen
 *  to "any unstaged status on the path set" (false-refuses already-landed/deleted/gitlink paths); fails safe
 *  on error. */
export async function detectCanonicalDirtyOverlap(
  repoPath: string,
  branch: string,
  deps: BoundedGitDeps = {},
): Promise<CanonicalDirtyOverlap> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  // @decision 56c10535 — qualified: a bare `branch` revision resolves a same-named tag ahead of the
  // real branch (refs/tags/ outranks refs/heads/ in git's own revision priority), which could hide a
  // real overlap.
  const branchRef = `refs/heads/${branch}`;
  try {
    const statusRaw = await withTimeout(
      git.raw(["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=no"]),
      timeoutMs, "git status --porcelain (canonical, dirty-overlap preflight)",
    );
    // XY<space>path (a rename/copy is "R  old -> new" / "C  old -> new"): Y (index 1) is the WORKTREE
    // status. Narrowing (ii): only Y === "M" (a real unstaged MODIFICATION) is a candidate — see this
    // function's own doc for why an unstaged DELETE (Y === "D") is deliberately excluded here. Untracked
    // files never appear (--untracked-files=no), so every surviving line is a TRACKED path.
    const dirtyUnstaged = new Set<string>();
    for (const line of statusRaw.split("\n")) {
      if (line.length < 4) continue;
      if (line[1] !== "M") continue;
      const rawPath = line.slice(3);
      // Only a REAL rename/copy line (X === "R"/"C") is "old -> new" — gate on the STATUS CHAR, not a
      // naive `" -> "` substring search, which would mis-split an ordinary path that legitimately
      // contains that literal substring (CR follow-up nitpick).
      const isRenameOrCopy = line[0] === "R" || line[0] === "C";
      const p = isRenameOrCopy && rawPath.includes(" -> ") ? rawPath.split(" -> ").pop()! : rawPath;
      dirtyUnstaged.add(p);
    }
    if (dirtyUnstaged.size === 0) return { overlap: false };

    // @decision 868e0135 — `--end-of-options` right after "merge-base": branchRef is already `refs/heads/${branch}`-qualified; HEAD is literal.
    const mergeBase = (await withTimeout(git.raw(["merge-base", "--end-of-options", "HEAD", branchRef]), timeoutMs, "git merge-base (canonical, dirty-overlap preflight)")).trim();
    const changed = await changedPathsBetween(git, mergeBase, branchRef, timeoutMs);
    let overlapping = changed.filter((p) => dirtyUnstaged.has(p));
    if (overlapping.length === 0) return { overlap: false };

    // Narrowing (iii): drop any overlap-candidate that is a gitlink (submodule) entry — its "content" is a
    // recorded commit sha, not the tree content `--squash` can conflict on the way it does for an ordinary
    // blob. Scoped to just the small candidate set already computed above, not a whole-repo scan.
    const gitlinkStage = await withTimeout(
      git.raw(["-c", "core.quotePath=false", "ls-files", "--stage", "--", ...overlapping]),
      timeoutMs, "git ls-files --stage (canonical, dirty-overlap gitlink check)",
    );
    const gitlinkPaths = new Set<string>();
    for (const line of gitlinkStage.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const mode = line.slice(0, tab).trim().split(/\s+/)[0];
      if (mode === "160000") gitlinkPaths.add(line.slice(tab + 1));
    }
    overlapping = overlapping.filter((p) => !gitlinkPaths.has(p));
    if (overlapping.length === 0) return { overlap: false };

    // Narrowing (i): drop any remaining candidate whose content is IDENTICAL between canonical HEAD and
    // the branch tip RIGHT NOW — deliberately re-diffed against `HEAD` here (not the `mergeBase` used
    // above only to find the branch's OWN candidate set), since this is the question that actually decides
    // whether `--squash` touches the working tree: has HEAD since independently converged on what the
    // branch would apply, regardless of what the branch changed relative to its own fork point.
    const stillDiffersFromHead = new Set(await changedPathsBetween(git, "HEAD", branchRef, timeoutMs));
    overlapping = overlapping.filter((p) => stillDiffersFromHead.has(p));
    if (overlapping.length === 0) return { overlap: false };

    return { overlap: true, paths: overlapping };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[git] detectCanonicalDirtyOverlap: probe failed for branch ${branch} in ${repoPath} — ` +
      `falling through to the real gate/squash instead of pre-refusing: ${(e as Error).message}`);
    return { overlap: false, probeFailed: true }; // FAIL SAFE: a check error/timeout must never block a legitimate merge
  }
}

export interface CanonicalUntrackedOverlap {
  /** AFFIRMATIVE only: true ⇒ the canonical repo has an UNTRACKED file on a path this branch's own commits
   *  also touch, AND the branch's tip still carries that path — this is the shape `git merge --squash`
   *  actually refuses on ("The following untracked working tree files would be overwritten by merge"). */
  overlap: boolean;
  /** the overlapping paths — present only when overlap:true. */
  paths?: string[];
  /** true ONLY when the probe itself errored/timed out (mirrors {@link CanonicalDirtyOverlap.probeFailed}). */
  probeFailed?: boolean;
}

/** @decision 98d6264d — sibling admission-time preflight to {@link detectCanonicalDirtyOverlap} for an
 *  UNTRACKED collision: unlike the tracked case, git refuses REGARDLESS of content identity (verified on real
 *  git 2.47) — never apply the identical-content narrowing here; use an existence check instead. */
export async function detectCanonicalUntrackedOverlap(
  repoPath: string,
  branch: string,
  deps: BoundedGitDeps = {},
): Promise<CanonicalUntrackedOverlap> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  // @decision 56c10535 — qualified: a bare `branch` revision resolves a same-named tag ahead of the
  // real branch (refs/tags/ outranks refs/heads/ in git's own revision priority), which could hide a
  // real overlap.
  const branchRef = `refs/heads/${branch}`;
  try {
    const statusRaw = await withTimeout(
      git.raw(["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"]),
      timeoutMs, "git status --porcelain (canonical, untracked-overlap preflight)",
    );
    // "?? path" — `--untracked-files=all` (NOT the default "normal") lists individual files rather than
    // collapsing a wholly-untracked directory into one "?? dir/" entry, so every surviving line here names
    // one real untracked FILE, matching what `changedPathsBetween` below also returns (individual file
    // paths, never a directory).
    const untracked = new Set<string>();
    for (const line of statusRaw.split("\n")) {
      if (line.length < 4) continue;
      if (line[0] !== "?" || line[1] !== "?") continue;
      untracked.add(line.slice(3));
    }
    if (untracked.size === 0) return { overlap: false };

    // @decision 868e0135 — `--end-of-options` right after "merge-base": same reason as the dirty-overlap preflight call above.
    const mergeBase = (await withTimeout(git.raw(["merge-base", "--end-of-options", "HEAD", branchRef]), timeoutMs, "git merge-base (canonical, untracked-overlap preflight)")).trim();
    const changed = await changedPathsBetween(git, mergeBase, branchRef, timeoutMs);
    const candidates = changed.filter((p) => untracked.has(p));
    if (candidates.length === 0) return { overlap: false };

    // Narrowing: drop any candidate the branch's tip no longer carries — see this function's own doc for
    // the direct repro proving the squash writes nothing there (a genuine no-op, never a refusal).
    const overlapping: string[] = [];
    for (const p of candidates) {
      try {
        await withTimeout(
          git.raw(["cat-file", "-e", `${branchRef}:${p}`]), timeoutMs, "git cat-file -e branch:path (canonical, untracked-overlap existence check)",
        );
        overlapping.push(p);
      } catch {
        // the branch tip doesn't carry this path — nothing for squash to write here
      }
    }
    if (overlapping.length === 0) return { overlap: false };

    return { overlap: true, paths: overlapping };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[git] detectCanonicalUntrackedOverlap: probe failed for branch ${branch} in ${repoPath} — ` +
      `falling through to the real gate/squash instead of pre-refusing: ${(e as Error).message}`);
    return { overlap: false, probeFailed: true }; // FAIL SAFE: a check error/timeout must never block a legitimate merge
  }
}

/**
 * Sibling admission-time preflight to {@link detectCanonicalDirtyOverlap} (card 4b7ff996 CR follow-up):
 * the STAGED-canonical-dirt case was already refused UNCONDITIONALLY by {@link mergeBranchLocked}'s own
 * entry check (see `stagedCanonicalDirtRefusalMessage`'s doc) — but that check runs INSIDE the squash,
 * which means it only fires AFTER a full build/DoD gate has already run, burning the exact gate lane
 * DoD-1 exists to save. This is the identical, UNCONDITIONAL check (any staged content refuses, regardless
 * of path overlap — a staged residue could be a daemon-restart-interrupted squash for ANY branch, not just
 * this one) hoisted to admission time, sharing `stagedCanonicalDirtRefusalMessage`'s wording so the two
 * call sites can never say different things about the identical condition.
 *
 * FAILS SAFE like its sibling: any git error/timeout returns `{staged:false}` — never blocks a legitimate
 * merge on a probe failure; `mergeBranchLocked`'s own unconditional check remains the backstop.
 */
export interface CanonicalStagedDirt {
  staged: boolean;
  /** raw `git diff --cached --name-only` output — present only when staged:true. */
  paths?: string;
}
export async function detectCanonicalStagedDirt(repoPath: string, deps: BoundedGitDeps = {}): Promise<CanonicalStagedDirt> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    // REGRESSION FIX (card 4b7ff996, second-round self-test): an IN-PROGRESS-MERGE residue (a stale
    // `MERGE_HEAD`, or unmerged/conflicted index entries left after one was deleted) also shows up in
    // `git diff --cached --name-only` — verified directly: a real conflicted merge with MERGE_HEAD removed
    // leaves `README.md` in `git status --porcelain` as `UU README.md` AND in `git diff --cached
    // --name-only`, even though nothing is genuinely staged in the sense this check means to catch.
    // `mergeBranchLocked` itself CLEARS exactly this residue (`git reset --merge HEAD`) BEFORE its own
    // staged-entry check ever runs — so checking staged-ness here, at admission, BEFORE that clear has
    // ever happened, would refuse on residue the real squash goes on to clear and merge successfully.
    // (Caught by this file's own merge-confirm-idempotent.mjs scenario (d), a PRE-EXISTING test this
    // card's first draft silently broke — not a new control, but real coverage doing its job.) Mirror
    // mergeBranchLocked's own two-probe residue signal here and defer entirely (`staged:false`) whenever
    // it's affirmative — mergeBranchLocked's own post-clear check remains the authoritative one for this
    // rare combined case (residue AND genuine separate staged work at once); this admission preflight
    // just doesn't attempt to get ahead of a clear it doesn't perform itself (deliberately read-only).
    const unmergedAtEntry = (await withTimeout(git.raw(["ls-files", "--unmerged"]), timeoutMs, "git ls-files --unmerged (canonical, dirty-overlap preflight, residue check)")).trim() !== "";
    let mergeHeadAtEntry = false;
    try {
      mergeHeadAtEntry = (await withTimeout(git.raw(["rev-parse", "-q", "--verify", "MERGE_HEAD"]), timeoutMs, "git rev-parse MERGE_HEAD (canonical, dirty-overlap preflight, residue check)")).trim() !== "";
    } catch { /* no MERGE_HEAD ⇒ that signal is simply false */ }
    if (unmergedAtEntry || mergeHeadAtEntry) return { staged: false };

    const stagedAtEntry = (await withTimeout(
      git.raw(["diff", "--cached", "--name-only"]), timeoutMs, "git diff --cached (canonical, dirty-overlap preflight, staged check)",
    )).trim();
    if (stagedAtEntry === "") return { staged: false };
    return { staged: true, paths: stagedAtEntry };
  } catch {
    return { staged: false }; // FAIL SAFE: a check error/timeout must never block a legitimate merge
  }
}

/**
 * Shared wording for the STAGED-canonical-dirt refusal (card `9e77050f`/`06b5c47f`'s original text; card
 * `4b7ff996` extracted it into one function so {@link mergeBranchLocked}'s own entry check and
 * {@link detectCanonicalStagedDirt}'s new admission-time caller can never drift apart on the identical
 * condition — see both call sites).
 */
export function stagedCanonicalDirtRefusalMessage(branch: string, stagedPaths: string): string {
  // The text below is the ONLY part of this refusal a caller (a manager, mid-fleet, who has never read
  // card 9e77050f/06b5c47f) actually sees — so it has to make the required action unmistakable on its
  // own, not rely on this comment. It must say, explicitly: this is not the branch's fault (retrying
  // does nothing); a HUMAN has to act on the canonical checkout, their call how; and the refusal itself
  // is deliberate, not a bug — auto-clearing was rejected precisely because it could destroy real work.
  return `MERGE REFUSED — the canonical repo has STAGED, uncommitted changes that predate this merge and are unrelated to branch '${branch}'. This is NOT a problem with '${branch}' or its code: retrying this merge (or any other) against this repo will refuse again identically until a HUMAN resolves the canonical checkout by hand — inspect \`git status\`/\`git diff --cached\` there, then commit, unstage, or discard whatever is staged (your call which). This refusal is DELIBERATE, not a bug: the staged state may be a daemon-restart-interrupted squash (a \`--squash\` commits the INDEX, which is exactly what can corrupt a merge), or it may be someone's real staged work, and Loom cannot tell the two apart from git state alone — auto-clearing it (e.g. \`git reset --hard\`) risks silently destroying that work, so it refuses instead. (Unstaged tracked changes elsewhere in the checkout — ordinary WIP, or a submodule whose checked-out commit differs from its recorded pointer — do NOT block a merge; only staged content does.) Once the canonical repo's index is clean, merges resume normally with no further action needed. Staged state:\n${stagedPaths}`;
}

/**
 * The worktree's current HEAD commit sha — the gate-timeout circuit breaker's (card 3564fd1e) "did the
 * branch move" signal: a breaker trip must clear once a NEW commit lands (the plausible fix for a hanging
 * test), not lock the branch out of gating for the rest of the daemon's uptime. Bounded + fail-safe,
 * mirroring {@link detectStrandedWork}'s posture: any error/timeout returns `null` rather than throwing —
 * a check failure here must never block a legitimate gate run; the caller treats `null` as "can't tell,
 * don't reset" (stays conservatively tripped rather than risking a spurious reset).
 */
export async function getWorktreeHeadSha(worktreePath: string, deps: BoundedGitDeps = {}): Promise<string | null> {
  try {
    // Constructing the bounded git instance is INSIDE the try, not just the `raw()` call below —
    // simpleGit's constructor validates `worktreePath` and can throw SYNCHRONOUSLY (not a rejection) when
    // it doesn't exist/isn't a directory, which a non-existent or not-yet-created worktree path genuinely
    // can be (the circuit breaker calls this speculatively; fail-safe applies just as much to that case).
    const { git, timeoutMs } = boundedGit(worktreePath, deps);
    return (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (worktree)")).trim();
  } catch {
    return null;
  }
}

/** @decision 3564fd1e — the gate-timeout breaker's "did a real fix land" signal, INVARIANT to
 *  `mergeMainIntoWorktree`'s union-merge (which otherwise makes plain {@link getWorktreeHeadSha} return a new
 *  merge sha every confirm once main advances, permanently defeating the breaker)
 *
 *  — walks first-parent,
 *  skipping merges. Fails safe to `null`. */
export async function getWorktreeLatestNonMergeSha(worktreePath: string, deps: BoundedGitDeps = {}): Promise<string | null> {
  try {
    const { git, timeoutMs } = boundedGit(worktreePath, deps);
    const out = (await withTimeout(
      git.raw(["rev-list", "--first-parent", "--no-merges", "HEAD", "--max-count=1"]),
      timeoutMs, "git rev-list --first-parent --no-merges HEAD (worktree)",
    )).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * A fingerprint of a worktree's state at a point in time — the `run_gate` result-consumption fix (card
 * 50c1e0d0): {@link SessionService.runWorkerGate} stamps ONE of these the moment a gate run actually
 * starts, so a LATER re-call — whether it lands mid-flight (the op is still running) or is being served
 * the SAME settled result back from a brief post-settle retention window — can tell whether the worktree
 * it's asking about is still the one the gate actually validated, or has moved on since (a new commit, or
 * an uncommitted edit). See {@link gateStampsDiffer}.
 */
export interface WorktreeGateStamp {
  /** `git rev-parse HEAD` in the worktree, or `null` only if the worktree was unreadable (a git
   *  error/timeout) — see {@link computeWorktreeGateStamp}'s fail-safe direction. */
  head: string | null;
  /** Whether the worktree carried any REAL uncommitted work (via {@link uncommittedWorkFiles}'s
   *  daemon-noise filter) at the moment this stamp was taken. */
  dirty: boolean;
  /** sha256 over the {@link filteredWorkEntries}-filtered `git status --porcelain -z` records + a `git
   *  diff HEAD` scoped to those SAME survivor paths, when `dirty` — content-level for TRACKED changes
   *  (staged or unstaged). `null` when clean or unreadable. Card dc281db8: BOTH inputs are filtered
   *  through the same daemon-noise exclusion `dirty` itself uses (`uncommittedWorkFiles`) — an EARLIER
   *  version hashed the raw, unfiltered porcelain + full `diff HEAD`, so pure `.claude/` noise on an
   *  already-dirty tree could flip this hash even though `dirty` correctly stayed governed by the
   *  filtered view; that mismatch is what this comment now documents as fixed. Card 8cc047d3: the diff's
   *  pathspec is now built from LOSSLESS `-z`-parsed paths (verbatim bytes) rather than quoted/C-escaped
   *  v1 text, which used to make the diff half of this hash silently blind to a real content edit on a
   *  non-ASCII-named tracked file (the escaped pathspec matched nothing). KNOWN GAP: editing the CONTENT
   *  of an already-untracked new file IN PLACE (no `git add`, no commit) changes neither input, so that
   *  exact edit is invisible to this hash — accepted here because the reported incidents (card 50c1e0d0)
   *  were edits to an EXISTING tracked file, not a brand-new untracked one.
   */
  dirtyHash: string | null;
}

/**
 * Fingerprint the worktree's current HEAD + uncommitted state (see {@link WorktreeGateStamp}).
 * FAIL-SAFE like its siblings ({@link getWorktreeHeadSha}, {@link detectStrandedWork}) in that it never
 * throws — but, DELIBERATELY, in the OPPOSITE direction: those helpers fail toward "don't block a
 * legitimate merge/gate" (an unreadable signal is treated as if nothing changed). This one is read by
 * {@link gateStampsDiffer} to decide whether to WARN a caller that a gate's outcome may not reflect the
 * current worktree — silently treating "can't tell" as "unchanged" would recreate exactly the green-but-
 * stale trap this stamp exists to catch, so an unreadable `head` here is ALWAYS treated as stale by
 * `gateStampsDiffer`, never as "confirmed unchanged".
 */
export async function computeWorktreeGateStamp(worktreePath: string, deps: BoundedGitDeps = {}): Promise<WorktreeGateStamp> {
  try {
    const { git, timeoutMs } = boundedGit(worktreePath, deps);
    const head = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "gate-stamp rev-parse HEAD")).trim();
    const porcelainZ = await withTimeout(
      git.raw(["-c", "core.quotePath=false", "status", "--porcelain", "-z"]), timeoutMs, "gate-stamp status --porcelain -z",
    );
    const workEntries = filteredWorkEntries(porcelainZ);
    if (workEntries.length === 0) return { head, dirty: false, dirtyHash: null };
    // Card dc281db8: hash the FILTERED entries/paths — the same daemon-noise exclusion `dirty` uses — not
    // the raw porcelain, and scope the diff to those same survivor paths, so noise-only churn (e.g. a
    // re-copied `.claude/skills/` file) that `uncommittedWorkFiles` correctly ignores can never flip this
    // hash either. Card 8cc047d3: paths come from the LOSSLESS `-z` parse (verbatim bytes, no C-escaping)
    // rather than the old quoted/escaped v1 text — a `git diff HEAD -- <path>` pathspec built from an
    // escaped path silently matches nothing, which used to make a real content edit to a non-ASCII-named
    // tracked file invisible to this hash. A rename/copy's OLD half is included too (it complicates the
    // path set `dirty` is scoped to, even though it typically diffs to nothing on its own).
    const files = [...new Set(workEntries.flatMap((e) => (e.oldPath ? [e.oldPath, e.path] : [e.path])))];
    // Best-effort: a `diff HEAD` failure still yields a (slightly weaker, porcelain-only) comparable hash
    // rather than aborting the whole stamp — the outer try/catch is reserved for a genuinely unreadable
    // worktree (rev-parse/status themselves failing).
    // @decision 4b559feb — `--end-of-options` before `HEAD`: no risky ref here (HEAD is a literal,
    // `files` are pathspecs after `--`), kept for guard-satisfaction consistency; MEASURED harmless.
    const diff = await withTimeout(git.raw(["diff", "HEAD", "--end-of-options", "--", ...files]), timeoutMs, "gate-stamp diff HEAD").catch(() => "");
    const canonical = workEntries.map((e) => `${e.status} ${e.oldPath ?? ""}\0${e.path}`).join("\n");
    const dirtyHash = createHash("sha256").update(canonical).update(diff).digest("hex");
    return { head, dirty: true, dirtyHash };
  } catch {
    return { head: null, dirty: false, dirtyHash: null };
  }
}

/**
 * Did the worktree change between two {@link WorktreeGateStamp}s taken at different times? `true` means
 * stale — assume the worktree moved on (a new commit, or an uncommitted edit) — and is the ONLY answer
 * when either stamp's `head` is `null` (an unreadable read on either side never gets to assert "unchanged"
 * — see {@link computeWorktreeGateStamp}'s fail-safe direction).
 */
export function gateStampsDiffer(a: WorktreeGateStamp, b: WorktreeGateStamp): boolean {
  if (a.head === null || b.head === null) return true;
  if (a.head !== b.head) return true;
  if (a.dirty !== b.dirty) return true;
  if (a.dirty && a.dirtyHash !== b.dirtyHash) return true;
  return false;
}

/**
 * The branch's ref-reflog shas, NEWEST FIRST, or `null` when unreadable. The gate wrapper snapshots it before each gate spawn and at
 * settle: `computeWorktreeGateStamp`'s head compare is blind to a tip that moved T1→T2 and BACK to T1 (the settle head equals the
 * pre-spawn head), but that round trip appends reflog entries.
 *
 * @decision d099087f — a head compare cannot see an ABA round trip; the reflog delta can.
 */
export async function branchReflogShas(repoPath: string, branch: string, deps: BoundedGitDeps = {}): Promise<string[] | null> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    const out = await withTimeout(git.raw(["reflog", "show", "--format=%H", `refs/heads/${branch}`, "--"]), timeoutMs, "branch reflog");
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

/** The worktree's OWN HEAD reflog (per-worktree in a linked worktree), NEWEST FIRST, or `null` when unreadable. A HEAD-only round trip
 *  (detach → commit → checkout back, another branch and back, an aborted rebase) writes NO `refs/heads/<branch>` entry, so the branch reflog alone misses it. */
export async function worktreeHeadReflogShas(worktreePath: string, deps: BoundedGitDeps = {}): Promise<string[] | null> {
  try {
    const { git, timeoutMs } = boundedGit(worktreePath, deps);
    const out = await withTimeout(git.raw(["reflog", "show", "--format=%H", "HEAD", "--"]), timeoutMs, "worktree HEAD reflog");
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

/** Both reflogs a gate's ABA check reads, snapshotted together (each `null` when unreadable). */
export interface GateReflogSnapshot { branch: string[] | null; head: string[] | null }

export async function snapshotGateReflogs(repoPath: string, branch: string, worktreePath: string, deps: BoundedGitDeps = {}): Promise<GateReflogSnapshot> {
  const [b, h] = await Promise.all([branchReflogShas(repoPath, branch, deps), worktreeHeadReflogShas(worktreePath, deps)]);
  return { branch: b, head: h };
}

/**
 * Did one reflog gain an entry that is not `preHead` between two snapshots (newest first)? The delta is anchored on the before-snapshot's
 * newest entry by POSITION and sha (`after[after.length - before.length] === before[0]`), never on length alone: an expiry/rewrite during the
 * gate breaks the anchor and reads as "moved". Fail-closed on unreadable or shrunken input. Pure.
 */
function reflogGainedForeignEntry(preHead: string, before: string[] | null, after: string[] | null): boolean {
  if (before === null || after === null || after.length < before.length) return true;
  const anchor = after.length - before.length;
  if (before.length > 0 && after[anchor] !== before[0]) return true;
  return after.slice(0, anchor).some((sha) => sha !== preHead);
}

/** Did the branch tip / the worktree HEAD leave `preHead` at any point between two {@link GateReflogSnapshot}s — even if it came back? */
export function gateReflogLeftHead(preHead: string, before: GateReflogSnapshot, after: GateReflogSnapshot): boolean {
  return reflogGainedForeignEntry(preHead, before.branch, after.branch) || reflogGainedForeignEntry(preHead, before.head, after.head);
}

/** Could either {@link GateReflogSnapshot} of a before/after pair not be READ (a git timeout/error => `null`)? {@link gateReflogLeftHead} fails
 *  closed on that and reads "left"; this lets a caller tell "could not verify" apart from a real move. Pure. */
export function gateReflogUnreadable(before: GateReflogSnapshot, after: GateReflogSnapshot): boolean {
  return before.branch === null || before.head === null || after.branch === null || after.head === null;
}

/** Where a gate's WORKTREE HEAD sits relative to the BRANCH ref the verdict is keyed on. `onBranch:"unverified"` when either side could not be read. */
export interface GateHeadOnBranch { onBranch: true | false | "unverified"; head: string | null; branchTip: string | null }

/**
 * THE shared "did the gate run on the commit its verdict names?" rule (card 01777ceb): a gate reads the WORKTREE's HEAD, every verdict/merge is keyed on the
 * BRANCH ref, and a worktree left detached (or on another branch) makes them differ — the gate ran on content the branch does not name. Pure: each gate path
 * (the merge gate's `captureGatedTip`, `run_gate`'s settle stamp, the reuse proof at confirm time) feeds it the two reads it already has.
 *
 * @decision 01777ceb — one helper for the merge gate, the run_gate self-check and the reuse proof; never a third local head-vs-ref check.
 */
export function gateHeadOnBranch(head: string | null | undefined, branchTip: string | null | undefined): GateHeadOnBranch {
  const h = head ?? null;
  const b = branchTip ?? null;
  return { onBranch: h === null || b === null ? "unverified" : h === b, head: h, branchTip: b };
}

/**
 * What a landing squash is pinned to, as a DISCRIMINATED input so a skip path that forgets its tip is a TYPE error (and a caller that cannot build one refuses, fail closed).
 * `gate`: the tip the REAL gate ran on. `skip`: the tip a NO-GATE decision covered (`reuse` = a reused self-check, `inert` = an inert-diff skip; a new skip kind gets its own
 * literal and MUST carry its decision's tip). `unpinned`: a landing with nothing to pin, with a NAMED reason — only `no-gate-configured` (a project with no gate command has no verdict about any tip).
 * The gate-OFF skip (`gate-disabled`) and the gate-INTERVAL skip (`gate-interval`, card 6f13746c) are `skip` variants carrying the tip their decision covered.
 */
export type LandingPin =
  | { kind: "gate"; tip: string }
  | { kind: "skip"; skip: "reuse" | "inert" | "gate-interval" | "gate-disabled"; tip: string }
  | { kind: "unpinned"; reason: "no-gate-configured" };

/**
 * THE one place that turns a {@link LandingPin} into `mergeBranch`'s `expectedBranchTip` (checked INSIDE its lock): the pinned tip, or `undefined` only for an explicit `unpinned`.
 *
 * @decision 35cfcbe0 — every no-gate landing is pinned to the tip its decision covered; one helper + a discriminated input so a new skip path cannot forget it.
 */
export function expectedTipForLanding(pin: LandingPin): string | undefined {
  return pin.kind === "unpinned" ? undefined : pin.tip;
}

/** A branch's changes since it diverged from base — the manager's pre-merge diff review (#16). */
/** One row of a diffstat — a changed file with its insertion/deletion counts (0/0 for binary). */
export interface DiffstatFile {
  file: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  /**
   * Change-type letter from `git diff --name-status`, populated ONLY when `diffBranch` is called with
   * `includeStatus:true` (card d5d3bdc9's deny-glob merge-review warning — the only consumer today).
   * `undefined` on every other diffBranch caller (byte-identical) and on any entry `diffNameStatus`
   * couldn't confidently attribute (a rename/copy pairing line, an unparseable row) — status is
   * best-effort and fails safe to "no status" rather than a guess. "A" (added) is the only value the
   * deny-glob matcher (`matchAddedDenyGlobs`) treats as an addition.
   */
  status?: "A" | "M" | "D" | "T" | "U" | "X" | "B";
  /**
   * The pre-rename path, present ONLY for a rename row — from {@link parseNumstatZ}'s own `-z` record,
   * never reconstructed from `--stat`'s `{old => new}`/`old => new` DISPLAY text (card fdf09672; see that
   * function's own doc for why the display form is lossy). `file` is always the real POST-rename path.
   */
  renameFrom?: string;
}

/**
 * Decodes `git diff --numstat -z`'s own machine-readable record format — never `--stat`'s (or plain
 * `--numstat` without `-z`) DISPLAY text. Throws on a malformed token stream (real git under `-z` never
 * produces one).
 * @decision fdf09672 — never parse `--stat`/`--numstat`/`--name-status` DISPLAY text (no `-z`) for a path
 * identity; always add `-z` and go through a record parser like this one. See the full record for the
 * verified defects (C-quoting, rename-as-text-collapse) and the exact `-z` record shape.
 */
export function parseNumstatZ(out: string): DiffstatFile[] {
  const tokens = out.split("\0");
  const files: DiffstatFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (i === tokens.length - 1 && tokens[i] === "") break; // trailing NUL terminator
    const head = tokens[i];
    const m = head === undefined ? null : /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(head);
    if (!m) throw new Error(`parseNumstatZ: malformed numstat -z record at token ${i}: ${JSON.stringify(head)}`);
    const [, insRaw, delRaw, pathField] = m;
    const binary = insRaw === "-" || delRaw === "-";
    const insertions = binary ? 0 : Number(insRaw);
    const deletions = binary ? 0 : Number(delRaw);
    i++;
    if (pathField === "") {
      const oldPath = tokens[i];
      const newPath = tokens[i + 1];
      // card fdf09672 (CR 7b67f7b5, finding 2) — an EMPTY token (not just a missing/undefined one) is
      // ALSO truncation: a path is never legitimately the empty string, so `"" ` here means the stream
      // ran out mid-record, same as `undefined` — never a real rename with a blank name.
      if (!oldPath || !newPath) {
        throw new Error(`parseNumstatZ: truncated rename record at token ${i} (missing old/new path)`);
      }
      files.push({ file: newPath, renameFrom: oldPath, insertions, deletions, binary });
      i += 2;
    } else {
      files.push({ file: pathField!, insertions, deletions, binary });
    }
  }
  return files;
}

/** @decision 91d847db — a bare leading `*` with no `/` anywhere (e.g. `*service.ts`) is auto-prefixed with
 *  `**​/` before translation — `*` alone stays within one segment and would silently match 0 files,
 *  indistinguishable from "no changes"; never widen this to a pattern already containing `/` or `**`. */
function pathGlobToRegExp(rawGlob: string): RegExp {
  const glob = rawGlob.startsWith("*") && !rawGlob.startsWith("**") && !rawGlob.includes("/")
    ? `**/${rawGlob}`
    : rawGlob;
  const SPECIAL = /[.+^${}()|[\]\\]/g;
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!; // i < glob.length ⇒ defined (noUncheckedIndexedAccess)
    if (c === "*" && glob[i + 1] === "*") {
      const slashBefore = i === 0 || glob[i - 1] === "/";
      const j = i + 2;
      const slashAfter = glob[j] === "/";
      if (slashBefore && slashAfter) { re += "(?:.*/)?"; i = j + 1; continue; } // `**/` -> zero-or-more dirs
      re += ".*"; i = j; continue; // bare `**` -> anything incl. `/`
    }
    if (c === "*") { re += "[^/]*"; i++; continue; }
    if (c === "?") { re += "[^/]"; i++; continue; }
    re += c.replace(SPECIAL, "\\$&"); i++;
  }
  return new RegExp(re + "$");
}

/**
 * Best-effort `git diff --name-status -z <range>` → `Map<path, status>`, used ONLY by `diffBranch`'s
 * `includeStatus` opt (card d5d3bdc9). Deliberately narrow and fail-safe: `reviewWorkerMerge` must
 * NEVER throw on a weird diff, so any parse miss silently drops that entry's status rather than guessing.
 * @decision fdf09672 — `-z` (never plain `--name-status`), so a non-ASCII path is never C-quoted into a
 * key that can't match `diffBranch`'s own (equally `-z`-sourced) real path.
 *
 * - A rename/copy record (`R100\0old\0new\0` / `C100\0old\0new\0`) carries TWO paths — attributing status
 *   to either would be a guess (is the new path "added"? is the old path "deleted"?), so these records
 *   are skipped entirely (both their paths' NUL tokens consumed); both paths end up with no status, same
 *   as an untracked file.
 * - Any git failure (missing range, non-repo, etc.) OR a `timeoutMs` timeout (a hung `git diff` child)
 *   returns an empty map — the caller degrades to "no status available", not an error or a hang.
 */
async function diffNameStatus(git: Pick<SimpleGit, "raw">, range: string, timeoutMs: number): Promise<Map<string, DiffstatFile["status"]>> {
  const map = new Map<string, DiffstatFile["status"]>();
  const SINGLE_PATH_STATUS = new Set(["A", "M", "D", "T", "U", "X", "B"]);
  try {
    // @decision 4b559feb — never drop this marker: a left-side `--output=`/`-O`/`--src-prefix=` value is
    // matched by PREFIX (not exact equality), so unguarded it silently writes a file or discards the diff.
    const raw = await withTimeout(git.raw(["diff", "--name-status", "-z", "--end-of-options", range]), timeoutMs, "git diff --name-status -z (diffBranch)");
    const tokens = raw.split("\0");
    let i = 0;
    while (i < tokens.length) {
      if (i === tokens.length - 1 && tokens[i] === "") break; // trailing NUL terminator
      const code = tokens[i];
      i++;
      const letter = code?.[0];
      if (letter === "R" || letter === "C") { i += 2; continue; } // rename/copy — two paths, skip both
      if (!letter || !SINGLE_PATH_STATUS.has(letter)) { i += 1; continue; } // unrecognized — skip its one path token
      const file = tokens[i];
      i++;
      if (file) map.set(file, letter as DiffstatFile["status"]);
    }
  } catch {
    // fail-safe: a name-status failure never blocks or alters the diffstat/review — just no status.
  }
  return map;
}

export async function diffBranch(
  repoPath: string, branch: string, base = "HEAD",
  opts: { includePatch?: boolean; files?: string[]; pathGlob?: string; includeStatus?: boolean; includeMachinePathSet?: boolean } = {},
  deps: DiffBranchDeps = {},
): Promise<{ filesChanged: number; insertions: number; deletions: number; files: DiffstatFile[]; allFiles: DiffstatFile[]; patch: string; hint?: string; machinePathSet?: { paths: string[] } | { truncated: true } }> {
  // The full unified `patch` is UNBOUNDED — on a large change it overflows an MCP display limit, blinding a
  // manager exactly when the diff is biggest/riskiest. So the patch is OPT-IN: callers that only need a
  // bounded summary pass includePatch:false and skip the expensive `git diff` entirely. Defaults to true so
  // existing callers (the orchestration view's workerDiff) stay byte-identical. The `files` diffstat — built
  // from the summary git already computes — is always returned and is the bounded review surface.
  const includePatch = opts.includePatch ?? true;
  // BOUNDED (card 53518a56): every op below now goes through the same block-timeout + withTimeout race as
  // the sibling reconcile ops reviewWorkerMerge already calls alongside this one (detectStrandedWork,
  // countCommitsBehind) — a hung diffSummary/diff/name-status child used to be able to wedge
  // reviewWorkerMerge (and thus the manager's worker_merge gate) forever; the outer try/catch there only
  // ever caught an ERROR, never a HANG.
  const { git, timeoutMs } = boundedDiffGit(repoPath, deps);
  // @decision 56c10535 — resolved via resolveBranchTip's exact lookup, never a bare `refs/heads/<branch>`
  // STRING (DWIM-reachable when missing). `deps.resolvedTip`, if set, skips the second read so it can
  // never diverge from it. An unresolvable branch throws; every caller already tolerates that.
  const branchTip = deps.resolvedTip ?? (await resolveBranchTip(repoPath, branch, deps));
  if (!branchTip) throw new Error(`diffBranch: could not resolve ${branch}'s current tip (refs/heads/${branch} is unreadable or missing)`);
  const range = `${base}...${branchTip}`; // 3-dot: changes on `branch` since the merge-base with `base`
  // @decision fdf09672 — machine-readable `-z` numstat, never `--stat`'s DISPLAY text (`diffSummary()`'s
  // own call) — see parseNumstatZ's own doc + the full record for the verified defects this replaces.
  // @decision 4b559feb — never drop this marker: a left-side `--output=`/`-O`/`--src-prefix=` value is
  // matched by PREFIX (not exact equality), so unguarded it silently writes a file or discards the diff.
  const numstatOut = await withTimeout(git.raw(["diff", "--numstat", "-z", "--end-of-options", range]), timeoutMs, "git diff --numstat -z (diffBranch summary)");
  const allFiles: DiffstatFile[] = parseNumstatZ(numstatOut);

  // OPTIONAL status enrichment (includeStatus): a second, best-effort `git diff --name-status` call,
  // merged onto allFiles by path. Off by default — every existing caller pays no extra git call and
  // stays byte-identical; only reviewWorkerMerge's deny-glob check opts in.
  if (opts.includeStatus) {
    const statusByPath = await diffNameStatus(git, range, timeoutMs);
    for (const f of allFiles) {
      const s = statusByPath.get(f.file);
      if (s) f.status = s;
    }
  }

  // OPTIONAL machine-readable path set (includeMachinePathSet, round 5): computed from this SAME `range`
  // — never re-derived independently — so it can never describe a different diff than allFiles above.
  // Off by default; only reviewWorkerMerge's stale-generation-attribution stamp opts in.
  const machinePathSet = opts.includeMachinePathSet ? await machineReadablePathSet(repoPath, range, deps) : undefined;

  // OPTIONAL scope-down filter (files/pathGlob): narrows the diffstat + patch to matching file(s) so a
  // manager can pull one file's hunk at a time instead of the whole patch. ADDITIVE — with neither param
  // set, `filtering` is false and every field below is computed exactly as before (byte-identical).
  const needles = (opts.files ?? []).map((f) => f.replace(/\\/g, "/")).filter((f) => f.length > 0);
  const globRe = opts.pathGlob ? pathGlobToRegExp(opts.pathGlob) : undefined;
  const filtering = needles.length > 0 || globRe !== undefined;
  const files = filtering
    ? allFiles.filter((f) => {
        // @decision fdf09672 — `f.file` is already the real post-rename path; never re-derive it from
        // `--stat` display text. Match a rename's old name via `f.renameFrom`, never display-text
        // concatenation.
        const matches = (p: string) => needles.some((n) => p.includes(n)) || (globRe ? globRe.test(p) : false);
        return matches(f.file) || (f.renameFrom !== undefined && matches(f.renameFrom));
      })
    : allFiles;

  const filesChanged = files.length;
  const insertions = files.reduce((s, f) => s + f.insertions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);

  // @decision fdf09672 — `--literal-pathspecs` (never add where there is no `--` pathspec) and
  // `-c core.quotepath=false` (a patch's `+++`/`---` lines stay C-quoted under `-z` too) are GLOBAL
  // flags, must precede the subcommand — every patch call here goes through `.raw([...])`.
  // @decision 4b559feb — never drop this marker on either branch: a left-side `--output=`/`-O`/
  // `--src-prefix=` value is matched by PREFIX, so unguarded it silently writes a file or discards the
  // diff; MEASURED harmless alongside `--literal-pathspecs` and a trailing `--` pathspec.
  const patch = includePatch
    ? filtering
      ? (files.length > 0 ? await withTimeout(git.raw(["-c", "core.quotepath=false", "--literal-pathspecs", "diff", "--end-of-options", range, "--", ...new Set(files.flatMap((f) => f.renameFrom !== undefined ? [f.file, f.renameFrom] : [f.file]))]), timeoutMs, "git diff (diffBranch patch, filtered)") : "")
      : await withTimeout(git.raw(["-c", "core.quotepath=false", "diff", "--end-of-options", range]), timeoutMs, "git diff (diffBranch patch)")
    : "";

  // pathGlob matched ZERO of the N actually-changed files: without this, the result is `filesChanged:0`
  // — indistinguishable from "nothing changed" (the bug this hint exists to prevent; recurred ≥3x in
  // real orchestrator use). Only fires for pathGlob (not a plain `files` substring miss, which is
  // unambiguous) and only when there WERE changes to miss.
  const hint = globRe && files.length === 0 && allFiles.length > 0
    ? `pathGlob \`${opts.pathGlob}\` matched 0 of ${allFiles.length} changed file(s). Note: a bare ` +
      `\`*name\` pattern with no \`/\` is auto-matched anywhere (as \`**/*name\`), but any pattern ` +
      `containing \`/\` scopes to that literal directory structure and won't match elsewhere. Changed ` +
      `files: ${allFiles.map((f) => f.file).join(", ")}. The \`files\` substring filter matches nested ` +
      `paths reliably as an alternative.`
    : undefined;

  // allFiles is the UNFILTERED branch diff, always — independent of the opts.files/pathGlob display
  // narrowing (which only scopes `files`/`patch`/the totals). A caller that needs "did this branch
  // change X anywhere" (e.g. the deny-glob check) must not have that answer silently narrowed by a
  // manager's unrelated "show me just this one file" review filter.
  return { filesChanged, insertions, deletions, files, allFiles, patch, ...(hint ? { hint } : {}), ...(machinePathSet ? { machinePathSet } : {}) };
}

/**
 * The deny-glob merge-review warning's matching primitive (card d5d3bdc9): files a branch ADDED
 * (`status:"A"`, from `diffBranch({ includeStatus: true })`) whose path matches any of a project's
 * `denyGlobs`. A file only MODIFIED under a deny path (already on main, or added by a prior commit and
 * merely edited here) does NOT match — this card's scope is deliberately "adds files", not "touches".
 * Reuses the same glob semantics as `pathGlob` (`**`/`*`/`?`, POSIX repo-relative, anchored). Returns
 * `[]` when `denyGlobs` is empty (a project opted out) or no file was newly added under any of them.
 */
export function matchAddedDenyGlobs(files: DiffstatFile[], denyGlobs: string[]): string[] {
  if (denyGlobs.length === 0) return [];
  const regexes = denyGlobs.map(pathGlobToRegExp);
  return files.filter((f) => f.status === "A" && regexes.some((re) => re.test(f.file))).map((f) => f.file);
}

/**
 * Generic "does `filePath` look like a test file" check — ecosystem-wide JS/TS testing conventions (a
 * `test`/`tests`/`__tests__`/`spec`/`e2e` path SEGMENT, or a `*.test.*`/`*.spec.*` filename), deliberately
 * NOT scoped to any one project's own test-directory name: this file provisions worktrees for every
 * project the daemon manages, not just this one, so a heuristic here must stay project-agnostic. Segment
 * matching (not substring) means `src/testament.ts` and `contest/foo.ts` do NOT match — see {@link
 * reviewDiffNeedsBuild}'s test for the negative-control proof this isn't a bare substring check.
 */
export function looksLikeTestFile(filePath: string): boolean {
  const TEST_DIR_NAMES = new Set(["test", "tests", "__tests__", "spec", "e2e"]);
  const segments = filePath.replace(/\\/g, "/").split("/");
  if (segments.some((seg) => TEST_DIR_NAMES.has(seg.toLowerCase()))) return true;
  const base = segments[segments.length - 1] ?? "";
  return /\.(test|spec)\.[^./]+$/i.test(base);
}

/** @decision 503cd822 — build a review worktree only when the REVIEWED diff touches a test-shaped file (a
 *  build-free reviewer can read source but never EXECUTE a `dist/`-importing test). FAILS OPEN (build) on any
 *  diff error — an undetectable diff must never silently reproduce the build-free-can't-run-tests bug. */
export async function reviewDiffNeedsBuild(
  repoPath: string, branch: string, base = "HEAD", deps: DiffBranchDeps = {},
): Promise<boolean> {
  try {
    const { filesChanged, allFiles } = await diffBranch(repoPath, branch, base, { includePatch: false }, deps);
    if (filesChanged === 0) return false; // nothing changed on the reviewed branch → nothing to run
    return allFiles.some((f) => looksLikeTestFile(f.file));
  } catch {
    return true; // undetectable → fail OPEN (build), never silently reproduce the bug this closes
  }
}

/**
 * Builds a LINE-ANCHORED marker regex: the phrase must stand ALONE on its own line — optionally under
 * markdown heading/bullet/blockquote/bold decoration (`#`, `*`, `_`, `>`, `-`, whitespace, a trailing
 * `:`) — with nothing else on that line. The decoration char classes deliberately exclude letters/digits
 * AND newlines, so a real sentence ("...and retracted before I'd checked.", "...the retracted count-floor
 * idea...") can never satisfy the "nothing else on this line" requirement no matter where it falls, and
 * the marker can never straddle two physical lines.
 */
function lineAnchoredMarker(phrase: string): RegExp {
  return new RegExp(`^[ \\t#*_>-]{0,12}${phrase}[ \\t#*_>:-]{0,12}$`, "im");
}

/**
 * Leading "declaration" decoration for {@link lineStartMarker} — the ASCII markdown/list/quote/emphasis
 * set {@link lineAnchoredMarker} uses, WIDENED (card 299a33ae) to any run of non-alphanumeric symbols a
 * human prefixes a heading with — a corpus read of the unmatched population (see that card's doc comment
 * below) found real "emoji-prefixed heading" retractions (e.g. `❌ RETRACTED BY THE MANAGER:`, `🔴🔴
 * RETRACTION —`) the old fixed ASCII class rejected.
 */
const LEADING_DECORATION = "[^\\p{L}\\p{N}\\n]{0,16}";

/** @decision 299a33ae — widened sibling of {@link lineAnchoredMarker} for the "retracted" family: still
 *  anchored at a true line START (excludes mid-sentence false positives), but no longer requires the phrase to
 *  be the WHOLE line.
 *
 *  Never drop `excludeAfter`'s `-premise\b` guard — this file's own `RETRACTED-PREMISE:`
 *  template would otherwise false-positive on itself. */
function lineStartMarker(phrase: string, excludeAfter?: string): RegExp {
  const guard = excludeAfter ? `(?!${excludeAfter})` : "";
  return new RegExp(`^${LEADING_DECORATION}${phrase}${guard}`, "imu");
}

/** @decision cf60a32a — deliberate markers a human writes to declare a card's premise dead, each as its OWN
 *  line, never merely mentioned in prose (a bare substring match had 2 confirmed false positives: `e7bcb0df`,
 *  `66d91a11`).
 *
 *  Never add a bare "RETRACTION" noun marker — it fires at least as often on a checklist label
 *  whose verdict is the OPPOSITE of a retraction. */
const RETRACTION_MARKER_RES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "retracted", re: lineStartMarker("retracted", "-premise\\b") },
  { label: "premise retracted", re: lineStartMarker("premise\\s+(?:partly\\s+|fully\\s+)?retracted") },
  { label: "won't-do", re: lineAnchoredMarker("won'?t-do") },
  { label: "not a bug", re: lineAnchoredMarker("not a bug") },
];

/** @decision cf60a32a — retraction-vs-title merge-review warning: an un-retitled `fix(…)` whose body
 *  carries a standalone retraction marker stamps a fix for a bug that never existed into mainline history.
 *
 *  KNOWN BLIND SPOT: reads the card's CURRENT title+body only — never widen to session transcripts without
 *  new measurement; the one confirmed transcript-only specimen (`c7bf65aa`) never actually merged. */
export function matchRetractedPremiseTitle(title: string, body: string): string | null {
  if (!title.trim().startsWith("fix(")) return null;
  for (const { label, re } of RETRACTION_MARKER_RES) {
    if (re.test(body)) return label;
  }
  return null;
}

export interface WorkerDiff {
  filesChanged: number;
  insertions: number;
  deletions: number;
  patch: string;
  /** the diff includes UNCOMMITTED working-tree edits read from the live worktree (case 1). */
  uncommitted?: boolean;
  /** the branch was already merged + deleted; this is the landed diff reconstructed from the
   *  merge commit (case 3). */
  merged?: boolean;
}

/**
 * Does `branch` still exist as a ref in `repoPath`? (A completed merge deletes it.) BOUNDED (card
 * c6a6f405 — mirrors {@link branchExistsInRepo}/{@link deleteBranch}/{@link isBranchMerged}, every
 * sibling git op in this file): a hung `git branch --list` must not wedge workerDiff's on-demand HTTP
 * request indefinitely; was previously a bare `simpleGit(repoPath)` with no block-timeout and no
 * {@link withTimeout} race.
 */
async function branchExists(repoPath: string, branch: string, deps: BoundedGitDeps = {}): Promise<boolean> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // @decision 7eac6366 — `--end-of-options` right before `branch` (see git/worktrees.ts:1300 for the
    // full placement rule).
    return (await withTimeout(git.raw(["branch", "--list", "--end-of-options", branch]), timeoutMs, "git branch --list (workerDiff branchExists)")).trim() !== "";
  } catch {
    return false;
  }
}

/** @decision e076d2a2 — content-reachability check: does `sha`'s tree ACTUALLY contain `branch`'s own
 *  changes, not merely carry its trailer text (a squash+commit race can bear one branch's trailer while its
 *  content belongs to another)?
 *
 *  @decision c0d0eac9 round 4 (finding B1) — returns a {@link CheckVerdict}, not a bare boolean: `"error"`
 *  on any git-call failure here is NON-DEFINITIVE (unknown, not confirmed-absent) and must never be read by
 *  a caller as the same thing as a genuine `"fail"` content mismatch — see `walkCandidates`'s own doc. */
async function branchContentLandedInCommit(
  repoPath: string, branch: string, sha: string, mergeBase: string, deps: BoundedGitDeps,
): Promise<CheckVerdict> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // @decision 56c10535 — qualified: a bare `branch` revision resolves a same-named tag ahead of
    // the real branch (refs/tags/ outranks refs/heads/), which would misclassify ALREADY_MERGED.
    const branchRef = `refs/heads/${branch}`;
    // @decision 4b559feb — never drop this marker: a left-side `--output=`/`-O`/`--src-prefix=` value in
    // `mergeBase` is matched by PREFIX, so unguarded it silently writes a file or discards the diff.
    const changedFiles = (await withTimeout(
      git.raw(["diff", "--name-only", "--end-of-options", `${mergeBase}..${branchRef}`]), timeoutMs, "git diff --name-only (content check)",
    )).trim();
    if (!changedFiles) return "pass"; // branch has no changes of its own relative to its fork point — vacuously landed
    const files = changedFiles.split("\n").filter(Boolean);
    // @decision 4b559feb — `--end-of-options` before `sha` protects both trailing positionals: `sha`
    // is untrusted, and `branchRef` reaches the array as a plain variable, not a literal template.
    const diffOutput = (await withTimeout(
      git.raw(["diff", "--name-only", "--end-of-options", sha, branchRef, "--", ...files]), timeoutMs, "git diff --name-only (content check, candidate vs branch)",
    )).trim();
    return diffOutput === "" ? "pass" : "fail"; // no output ⇒ zero difference on any of the branch's own paths ⇒ content matches
  } catch {
    return "error";
  }
}

/**
 * @decision cc9bce38 — the `Loom-Landed-Tip:` trailer a SOLO squash carries: the branch tip the squash actually ran on (`resolvedBranchHead`), so the tip that landed is recoverable
 * from main itself with no fresh read. A recovery caller pins its finalize CAS to THIS, never to a fresh read or a content check (both bless a late whole-file revert). A squash
 * with no trailer (pre-cc9bce38, or an unresolved head) falls back to a stable-tip read.
 */
/**
 * {@link readLandedTipTrailer}'s UNVERIFIABLE sentinel (card f2b4d684) — never hex-shaped, so it can
 * never equal a real resolved tip and can never collide with a genuine `Loom-Landed-Tip` value. Distinct
 * from `null`: `null` (ABSENT) means the commit message was read fine and genuinely carries no
 * `Loom-Landed-Tip` field; this sentinel (UNVERIFIABLE) means EITHER a trailer was recorded but could not
 * be verified as its own exact commit object, OR the commit message itself could not even be read (CR
 * round 3 — an unreadable message is "could not confirm", never "confirmed nothing's there"). NOT safe
 * to treat the same as ABSENT at every caller — see each caller's own doc for which treatment it needs,
 * and never persist this literal string value anywhere a later read could feed it back into git argv or
 * trust it verbatim (CR round 3's own Major: round 2 persisted it into a durable event's own field).
 */
export const TRAILER_TIP_UNVERIFIABLE = "\0trailer-tip-unverifiable\0";

/**
 * Reads the `Loom-Landed-Tip:` trailer off `sha`'s message via {@link parseLoomTrailerBlock}, then
 * resolves it through {@link resolveExactTrailerObjectId} (never re-implemented here). Returns ONE of
 * three states — `null` (ABSENT: the message was read fine but carries no `Loom-Landed-Tip` field at
 * all), {@link TRAILER_TIP_UNVERIFIABLE} (UNVERIFIABLE: a trailer value was parsed but failed
 * exact-object-id resolution, the validation call itself threw, OR the commit message could not even be
 * read), or the resolved tip string (VALID) — never conflate the first two: a caller must choose its own
 * treatment for UNVERIFIABLE rather than assume it is safe to fold into ABSENT (see each caller's own
 * doc; `pinnedTipForLandedSquash` must NOT fold it).
 *
 * @decision f2b4d684 (round 6) — corrects this comment's own earlier claim: `heldRecordedTip` does NOT
 * fold UNVERIFIABLE into ABSENT either — it returns a distinct `{tip:null, unverifiable:true}` pair that
 * `resolveOwedRange`/`finishAlreadyMerged` classify as never-cacheable, unlike a genuinely absent tip.
 *
 * @decision f2b4d684 (CR round 3) — never re-validate a trailer value at a NEW call site instead of
 * here, and never map the OUTER (log-read) catch to ABSENT: an unreadable commit message must stay
 * UNVERIFIABLE, same as a failed validation call — both are "could not confirm", never "nothing to pin".
 */
export async function readLandedTipTrailer(repoPath: string, sha: string, deps: BoundedGitDeps = {}): Promise<string | null> {
  let git: Pick<SimpleGit, "raw">, timeoutMs: number, body: string;
  try {
    ({ git, timeoutMs } = boundedGit(repoPath, deps));
    // @decision 868e0135 — `--end-of-options` before `sha` (same measured reason as batch-merge.ts's own log -1 reads).
    body = await withTimeout(git.raw(["log", "-1", "--format=%B", "--end-of-options", sha]), timeoutMs, "git log -1 (landed-tip trailer)");
  } catch {
    return TRAILER_TIP_UNVERIFIABLE; // UNVERIFIABLE: couldn't even read the commit message — could not confirm either way
  }
  const parsed = parseLoomTrailerBlock(body)?.landedTip ?? null;
  if (!parsed) return null; // ABSENT: the message parsed fine, but carries no Loom-Landed-Tip field
  try {
    const resolved = await resolveExactTrailerObjectId(git, timeoutMs, parsed);
    return resolved ?? TRAILER_TIP_UNVERIFIABLE; // UNVERIFIABLE: present but failed exact-object-id resolution
  } catch {
    return TRAILER_TIP_UNVERIFIABLE; // UNVERIFIABLE: a trailer WAS parsed, but the validation call itself threw
  }
}

/**
 * The Loom trailers a landing commit carries, as parsed by {@link parseLoomTrailerBlock}. `landedTip` is the `Loom-Landed-Tip:` value (a hex sha, solo squashes only);
 * `base` is `Loom-Worker-Base:` and `pathSet` is `Loom-Worker-PathSet:` (see {@link changedPathSetDigest}).
 *
 * @decision d62dad73 — `base` stamps the LANDED base (`sha^`, or a batch's `batchHeadBefore`), never `merge-base(HEAD, branch)` (the branch's pre-landing fork point, which
 * diverges once main has advanced past it).
 */
export interface LoomTrailers {
  branch: string;
  landedTip: string | null;
  base: string | null;
  pathSet: string | null;
}

/**
 * The ONE reader of every Loom merge trailer (`Loom-Worker-Branch`, `Loom-Landed-Tip`, `Loom-Worker-Base`, `Loom-Worker-PathSet`) — card f62ef199. Both landing layouts (the solo
 * squash in `mergeBranchLocked`, the batch tip in `batch-merge.ts`) end the message with a SEPARATE final paragraph holding `Loom-Worker-Branch:` and further `Key: value` lines
 * ONLY, so that final paragraph is the only place a Loom trailer is real. `Loom-Worker-Branch:` may sit on ANY line of it (a commit-msg hook can insert e.g. `Change-Id:` ahead
 * of ours; a hook or `-s` may append `Signed-off-by:` after) — the every-line-is-`Key: value` rule is what keeps a quoted line out. Remaining limit: a hook that adds a
 * non-`Key: value` line (e.g. `[skip ci]`) or a folded continuation line to that paragraph yields `null`. A worker body is passed through verbatim by a batch landing, so a `Loom-*:` line
 * anywhere earlier in the message (or in a non-final paragraph) is worker prose — never a trailer. Returns `null` when the final paragraph is not such a block.
 *
 * BOUND: this proves the trailer sits in the message's final block, not that Loom wrote it — a worker whose LAST paragraph is exactly a `Loom-Worker-Branch:` line on a
 * batch NON-tip commit (which gets no trailer of its own) is indistinguishable from a real trailer by text alone.
 *
 * @decision 1d3f500e — never a first-match lookup over the whole body (a quoted example line at column 0 would shadow the real trailer); f62ef199 tightens "last match" to
 * "final block only", since a last-match over the whole body still reads a quoted line on a commit that has no real trailer.
 */
/** The per-line shape {@link parseTrailerParagraph} (and so every caller of it) requires for ANY line
 *  inside a candidate trailer paragraph — factored out so {@link isTrailerShapedParagraph} (card
 *  45036494) can test the SAME shape without a second, independently-drifting regex. */
const TRAILER_LINE_RE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*?)[ \t]*$/;

/**
 * Parses ONE paragraph (not a whole message) as a Loom trailer block — the exact per-line field-
 * extraction {@link parseLoomTrailerBlock} already applied to the message's own LAST paragraph, factored
 * out here (card 45036494) so {@link tolerantFindLoomTrailerBlock} can apply the IDENTICAL rules to an
 * ARBITRARY paragraph without a second, independently-drifting copy. Never exported — {@link
 * parseLoomTrailerBlock}'s own "final paragraph only" semantics (card 95940402's "Do not": never change
 * its reader semantics) are UNCHANGED by this factor-out; every existing caller still gets byte-identical
 * behavior, since `parseLoomTrailerBlock` now simply calls this on the last paragraph instead of inlining
 * the same loop.
 */
function parseTrailerParagraph(paragraph: string): LoomTrailers | null {
  const lines = paragraph.split("\n");
  let branch: string | null = null;
  const out: LoomTrailers = { branch: "", landedTip: null, base: null, pathSet: null };
  for (const line of lines) {
    const kv = TRAILER_LINE_RE.exec(line);
    if (!kv) return null; // a prose line ⇒ this paragraph is not a trailer block
    const value = kv[2]!;
    if (kv[1] === "Loom-Worker-Branch") branch = /^\S+$/.test(value) ? value : null;
    else if (kv[1] === "Loom-Landed-Tip") out.landedTip = /^[0-9a-f]{40,64}$/.test(value) ? value : null;
    else if (kv[1] === "Loom-Worker-Base") out.base = /^\S+$/.test(value) ? value : null;
    else if (kv[1] === "Loom-Worker-PathSet") out.pathSet = /^\S+$/.test(value) ? value : null;
  }
  if (!branch) return null;
  out.branch = branch;
  return out;
}

export function parseLoomTrailerBlock(message: string): LoomTrailers | null {
  // A run of 2+ newlines (blank lines) separates paragraphs — never a single blank, or a 3-newline gap leaves an empty first line (commit.cleanup=verbatim, the batch writer's own append).
  const paragraphs = message.replace(/\r\n/g, "\n").replace(/\s+$/, "").split(/\n(?:[ \t]*\n)+/);
  if (paragraphs.length < 2) return null; // git never treats the SUBJECT line as a trailer — the block is always a paragraph AFTER the first
  return parseTrailerParagraph(paragraphs[paragraphs.length - 1] ?? "");
}

/** True iff every line of `paragraph` is `Key: value`-shaped (see {@link TRAILER_LINE_RE}) — the git
 *  trailer shape {@link loomTrailerBlockDisplaced} already treats as "an honest hook, not a forgery",
 *  reused here (card 45036494) to bound {@link tolerantFindLoomTrailerBlock}'s own tolerance: a single
 *  prose line anywhere in a paragraph it is asked to skip past is refused, never silently walked through. */
function isTrailerShapedParagraph(paragraph: string): boolean {
  return paragraph.split("\n").every((line) => TRAILER_LINE_RE.test(line));
}

/** {@link tolerantFindLoomTrailerBlock}'s own bound on how many trailing paragraphs (after the identified
 *  Loom block) it will walk past — each one individually required to be {@link isTrailerShapedParagraph}.
 *  Past this, refuses rather than silently widening further (card 45036494). */
const TOLERANT_TRAILER_MAX_TRAILING_PARAGRAPHS = 3;

/** {@link tolerantFindLoomTrailerBlock}'s own bound on the TOTAL line count across every trailing
 *  paragraph it walks past — independent of {@link TOLERANT_TRAILER_MAX_TRAILING_PARAGRAPHS}, since a
 *  bounded paragraph COUNT alone does not bound a pathological single paragraph with many lines
 *  (card 45036494). */
const TOLERANT_TRAILER_MAX_TRAILING_LINES = 12;

/**
 * @decision 45036494 — never trust this function's result on its own; every call site must still run its
 * own independent, non-trailer verifier on the candidate before treating it as landed.
 *
 * DISCOVERY-ONLY tolerant reader for a landing's Loom trailer block, closing (for the "displaced" shape
 * only — see below) the residual card c13666c6 left open: that card gated the
 * branch-gone ledger arm against forgery, but never widened DISCOVERY itself, so a commit whose trailer a
 * repo's own commit-msg hook legitimately DISPLACED (appended a paragraph after Loom's own — the exact
 * shape `verifyLoomTrailersExactAndReadable`'s `"displaced"` kind already classifies as honest, not
 * forged) was — and without this function, still is — never FOUND by the `git log --grep` + parse loop
 * every discovery call site runs, regardless of any ledger/content check downstream, because that check is
 * only ever consulted AFTER a candidate sha is found.
 *
 * {@link parseLoomTrailerBlock} is UNCHANGED and remains the real reader every WRITE/TRUST-layer consumer
 * uses (card 95940402's own "Do not" forbids altering its semantics — every other caller, hold-release/
 * `readLandedTipTrailer`/`pinnedTipForLandedSquash`/the solo-path identity-recovery check/
 * `verifyLoomTrailersExactAndReadable`'s own round-trip, relies on exactly today's "final paragraph only"
 * behavior and must keep doing so). This function exists ONLY for a discovery-time grep+parse loop to
 * locate a CANDIDATE — it is never itself a trust decision, and every call site that uses it MUST still run
 * its own independent, non-trailer verifier (content equality, or c13666c6's ledger gate) on the result
 * before trusting it; see each call site's own comment (card 45036494) for which verifier that is.
 *
 * Accepts a Loom trailer block that is NOT the message's final paragraph only when:
 *  1. Exactly ONE paragraph in the message (never the subject) parses as a self-contained, well-formed
 *     Loom block via {@link parseTrailerParagraph} — more than one is ambiguous (never guess which is
 *     real) and refuses with `null`, same as zero.
 *  2. Every paragraph AFTER that one block is ITSELF a well-formed `Key: value`-only block (git trailer
 *     shape — {@link isTrailerShapedParagraph}, the same shape {@link loomTrailerBlockDisplaced} already
 *     treats as an honest hook) — bounded by {@link TOLERANT_TRAILER_MAX_TRAILING_PARAGRAPHS} and {@link
 *     TOLERANT_TRAILER_MAX_TRAILING_LINES}; a single prose line, or exceeding either bound, refuses. A
 *     hook that does something stranger than append a few trailer-shaped lines is not this function's job
 *     to parse.
 *  3. (round 2 — never round 1's self-derived scan) The identified block, parsed on its own, is turned
 *     into a CANONICAL-case `expected` set, and the reserved-namespace scan of the WHOLE message (not just
 *     the identified block) must exactly equal that set — the SAME exact-match core ({@link
 *     reservedNamespaceExactlyMatches}) {@link verifyLoomNamespaceExact}/{@link loomTrailerBlockDisplaced}
 *     already apply for a KNOWN `expected` set. This catches a duplicate, an UNKNOWN, or a CASE-VARIANT
 *     reserved key sitting anywhere else in the message (the `5e323196`/`6cc1333f` shape
 *     `RESERVED_LOOM_TRAILER_KEY`'s own doc names: an earlier paragraph quoting a trailer line verbatim) —
 *     and, because `expected` now carries real values instead of being self-derived, also a genuine value
 *     mismatch. Round 1's self-derived-scan version of this step silently accepted a lone case-variant or
 *     unknown reserved key (Code Review 04cfeb36, round 2, BLOCKING) — see this card's decision record.
 *
 * **OUT OF SCOPE, deliberately: "unreadable" discovery.** That kind is foreign content folded INTO the
 * SAME paragraph as Loom's own trailer, with no blank-line paragraph boundary at all — there is no
 * boundary this function could walk past, so it cannot and does not attempt it. See
 * docs/decisions/45036494-*.md for the full reasoning; the batch landing path still treats an
 * "unreadable" LANDING as advisory (never a hard failure), this function just can never DISCOVER one
 * after the fact.
 */
export function tolerantFindLoomTrailerBlock(message: string): LoomTrailers | null {
  const normalized = normalizeMessageNewlines(message).replace(/\s+$/, "");
  const paragraphs = normalized.split(/\n(?:[ \t]*\n)+/);
  if (paragraphs.length < 2) return null; // same subject-is-never-a-trailer rule as parseLoomTrailerBlock

  // Cheap bailout: nothing reserved anywhere — the common non-Loom-commit case, no need to parse further.
  if (scanLoomNamespaceLines(normalized).length === 0) return null;

  // Step 1: exactly one paragraph (never the subject) parses as a self-contained Loom block.
  const blockCandidates: number[] = [];
  for (let i = 1; i < paragraphs.length; i++) {
    if (parseTrailerParagraph(paragraphs[i]!) !== null) blockCandidates.push(i);
  }
  if (blockCandidates.length !== 1) return null;
  const blockIdx = blockCandidates[0]!;

  // Step 2: every paragraph AFTER the block is itself trailer-shaped, bounded.
  const trailing = paragraphs.slice(blockIdx + 1);
  if (trailing.length > TOLERANT_TRAILER_MAX_TRAILING_PARAGRAPHS) return null;
  let trailingLines = 0;
  for (const p of trailing) {
    trailingLines += p.split("\n").length;
    if (trailingLines > TOLERANT_TRAILER_MAX_TRAILING_LINES || !isTrailerShapedParagraph(p)) return null;
  }

  // @decision 45036494 (round 2) — built from the PARSE, never the raw scan: a raw-scan-derived set
  // silently accepted a lone case-variant or unknown reserved key, since nothing then checked every
  // scanned key was one of the four canonical ones.
  //
  // Step 3: the identified block, parsed on its own, must be the ONLY reserved content anywhere in the
  // message — checked via the SAME exact-match rule `verifyLoomNamespaceExact`/`loomTrailerBlockDisplaced`
  // apply. This also catches a duplicate of the real key hiding in an earlier, otherwise-unparseable
  // paragraph (the `5e323196`/`6cc1333f` shape), since the dedup scans the WHOLE message.
  const parsed = parseTrailerParagraph(paragraphs[blockIdx]!);
  if (!parsed) return null;
  const canonicalExpected: Record<string, string> = { "Loom-Worker-Branch": parsed.branch };
  if (parsed.landedTip !== null) canonicalExpected["Loom-Landed-Tip"] = parsed.landedTip;
  if (parsed.base !== null) canonicalExpected["Loom-Worker-Base"] = parsed.base;
  if (parsed.pathSet !== null) canonicalExpected["Loom-Worker-PathSet"] = parsed.pathSet;
  if (!reservedNamespaceExactlyMatches(normalized, canonicalExpected).exact) return null;
  return parsed;
}

/**
 * Loom's RESERVED commit-trailer namespace — exactly the keys {@link parseLoomTrailerBlock}/
 * {@link readLandedTipTrailer} parse (`Loom-Worker-Branch`, `Loom-Worker-Base`, `Loom-Worker-PathSet`,
 * `Loom-Landed-Tip`), generalized to the two PREFIX families those keys fall under
 * (`Loom-Worker-*`/`Loom-Landed-*`, case-insensitive) so an older/foreign key under either prefix is also
 * caught — the real `5e323196`/`6cc1333f` shape: an earlier `Loom-Worker-Branch:` paragraph quoted
 * verbatim inside a worker's own commit body.
 *
 * A non-Loom project's own subject/prose using the bare word "loom" ("loom-bridge: fix crash", a
 * `loom-cli:` line) is a legitimate, UNRESERVED use and must never trip this — round 3's own
 * `scanLoomNamespaceLines` matched any `loom-*` key, which is exactly what made such a line refuse the
 * whole batch.
 *
 * @decision 95940402 (round 4, A1) — this constant is the fix, and the ONE definition
 * {@link scanLoomNamespaceLines}, {@link stripReservedLoomTrailerLines}, and `batch-merge.ts`'s own
 * subject check all share — never a second, independently-drifting copy of this regex.
 */
const RESERVED_LOOM_TRAILER_KEY = /^(?:loom-worker|loom-landed)-[a-z0-9-]*$/i;

/**
 * Matches one line shaped like `<key>: <value>` where `<key>` is in Loom's {@link RESERVED_LOOM_TRAILER_KEY}
 * namespace — tolerating leading whitespace/tabs and a space or tab before the colon (round 3's own
 * space-colon/tab-colon/lead-ws probe modes must stay caught by whatever reads this). Returns the parsed
 * `{key, value}` (key verbatim as written, so a caller can tell `Loom-Worker-Branch` apart from
 * `loom-worker-branch`) or `null` when the line isn't `key: value`-shaped at all, or its key isn't
 * reserved. The ONE shared predicate every reserved-trailer check in this file (and `batch-merge.ts`)
 * builds on — never a second, independently-drifting regex (card 95940402 round 4, A1).
 */
export function matchReservedLoomTrailerLine(line: string): { key: string; value: string } | null {
  const m = /^[ \t]*([A-Za-z][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
  if (!m) return null;
  const key = m[1]!;
  if (!RESERVED_LOOM_TRAILER_KEY.test(key)) return null;
  return { key, value: m[2]! };
}

/**
 * Normalizes every `\r\n` pair to a bare `\n` — the ONE shared first step {@link scanLoomNamespaceLines}
 * and {@link stripReservedLoomTrailerLines} both apply before splitting `message` into paragraphs/lines,
 * so a CRLF-terminated line reads identically in both.
 *
 * Before this, only the scanner normalized; the strip split on a bare `\n`, leaving a trailing `\r` on
 * every line, which `matchReservedLoomTrailerLine`'s own `[ \t]*$` anchor (excluding `\r`) then silently
 * rejected — a `Loom-Worker-Branch: x\r\n` line evaded the strip while the scanner still flagged it.
 *
 * @decision 95940402 (round 5, F1) — authored via `commit-tree`/`--cleanup=verbatim`, which skips the
 * normalization an ordinary `git commit -m` applies.
 */
function normalizeMessageNewlines(message: string): string {
  return message.replace(/\r\n/g, "\n");
}

/**
 * Every line ANYWHERE in `message` (any paragraph) shaped like a RESERVED Loom trailer key (see
 * {@link matchReservedLoomTrailerLine}) — the raw material for an EXHAUSTIVE audit of Loom's reserved
 * namespace, unlike {@link parseLoomTrailerBlock}, which only structurally reads the FINAL paragraph's
 * trailers and cannot see a duplicate, a case variant, or a line planted in an earlier paragraph. `key` is
 * verbatim as written (so a caller can tell `Loom-Worker-Branch` apart from `loom-worker-branch`);
 * `finalParagraph` is true only when the line's own paragraph is the message's LAST one (paragraphs split
 * the same way `parseLoomTrailerBlock` splits them: a run of one-or-more blank lines).
 *
 * @decision 95940402 (round 4, A1) — NARROWED from "any `loom-*:` line" to the RESERVED namespace only;
 * see {@link RESERVED_LOOM_TRAILER_KEY}'s own doc for why the broader match was itself a bug.
 */
export function scanLoomNamespaceLines(message: string): { key: string; value: string; finalParagraph: boolean }[] {
  const paragraphs = normalizeMessageNewlines(message).replace(/\s+$/, "").split(/\n(?:[ \t]*\n)+/);
  const lastIdx = paragraphs.length - 1;
  const out: { key: string; value: string; finalParagraph: boolean }[] = [];
  paragraphs.forEach((para, idx) => {
    for (const line of para.split("\n")) {
      const m = matchReservedLoomTrailerLine(line);
      if (m) out.push({ key: m.key, value: m.value, finalParagraph: idx === lastIdx });
    }
  });
  return out;
}

/**
 * The POSITION-AGNOSTIC core of "does the reserved-namespace scan of `message` exactly equal `expected`'s
 * key/value set, with no duplicate/extra/missing/case-variant reserved line" — the rule {@link
 * verifyLoomNamespaceExact} and {@link loomTrailerBlockDisplaced} each inlined as their own copy of this
 * same loop before card 45036494 factored it out here, so a third copy (needed by {@link
 * tolerantFindLoomTrailerBlock}'s own round-trip) would not become a third, independently-drifting one.
 * Every scanned line's key must be a property of `expected` (an unknown OR case-variant key — `expected`
 * is keyed by exact canonical case — fails immediately, same as a genuine value mismatch); a duplicate of
 * an expected key also fails immediately; the final `exact` flag additionally requires every key in
 * `expected` to have actually been seen (catches a key `expected` lists but the scan never found).
 * Callers layer their OWN `finalParagraph` requirement (or deliberate lack of one) on top of `lines`.
 *
 * @decision 45036494 (round 2) — verified behaviorally equivalent to the two pre-existing inlined copies
 * for every input the declared `Readonly<Record<string, string>>` type allows; see this card's decision
 * record (Round 3) for the case-by-case argument AND the one documented boundary of that equivalence.
 */
function reservedNamespaceExactlyMatches(
  message: string, expected: Readonly<Record<string, string>>,
): { exact: boolean; lines: ReturnType<typeof scanLoomNamespaceLines> } {
  const lines = scanLoomNamespaceLines(message);
  const seen = new Set<string>();
  for (const l of lines) {
    const want = expected[l.key];
    if (want === undefined || seen.has(l.key) || want !== l.value) return { exact: false, lines };
    seen.add(l.key);
  }
  return { exact: seen.size === Object.keys(expected).length, lines };
}

/**
 * Strips every line in Loom's RESERVED trailer namespace (see {@link matchReservedLoomTrailerLine}) out of
 * `message`, NEVER touching line 0 (the subject) even when it happens to match — a reserved-shaped
 * SUBJECT is a distinct hazard `batch-merge.ts` refuses the whole candidate for instead of silently
 * stripping (card 95940402 round 4, A2). Operates on the raw message line-by-line (never a paragraph
 * rejoin, so a reserved line sitting in the MIDDLE of a paragraph can't accidentally merge the lines
 * around it). When nothing is stripped, returns the ORIGINAL `message` untouched, byte-for-byte including
 * its original line endings; when something IS stripped, the rebuilt message's lines are joined with a
 * bare `\n`, then any resulting run of 3+ newlines collapses to exactly 2 (mirrors
 * {@link stripClaudeSessionTrailer}'s own collapse rule) so removing a reserved line doesn't leave a
 * visible gap where it sat. Returns `{message, strippedCount}` rather than mutating silently —
 * `strippedCount` lets a caller surface a non-blocking notice and feed a landing total.
 *
 * @decision 95940402 (round 5, F1) — splits via {@link normalizeMessageNewlines}, the SAME normalization
 * {@link scanLoomNamespaceLines} applies, so the two can never disagree on where a line ends.
 */
export function stripReservedLoomTrailerLines(message: string): { message: string; strippedCount: number } {
  const lines = normalizeMessageNewlines(message).split("\n");
  if (lines.length === 0) return { message, strippedCount: 0 };
  const subject = lines[0]!;
  let strippedCount = 0;
  const rest = lines.slice(1).filter((l) => {
    if (matchReservedLoomTrailerLine(l)) { strippedCount++; return false; }
    return true;
  });
  if (strippedCount === 0) return { message, strippedCount: 0 };
  const cleaned = [subject, ...rest].join("\n").replace(/\n{3,}/g, "\n\n");
  return { message: cleaned, strippedCount };
}

/**
 * A batch-landed commit's RESERVED Loom namespace must match `expected` EXACTLY (up to surrounding
 * whitespace — {@link scanLoomNamespaceLines}'s own regex trims a value's leading/trailing spaces/tabs
 * before this ever compares it, round 4, R5): every key once, correct value, in the message's FINAL
 * paragraph, canonical case, nothing else in the reserved namespace anywhere (a duplicate, a case
 * variant, a hidden-paragraph line, or `Loom-Landed-Tip` on a batch tip all fail this).
 *
 * Foreign (non-reserved) trailers stay untouched by this check, so a real commit-msg hook adding one — or
 * a non-Loom project's own "loom-bridge:"-shaped line (round 4, A1: no longer even scanned, see
 * {@link RESERVED_LOOM_TRAILER_KEY}) — never breaks a landing.
 *
 * @decision 95940402 (round 3, Code Review 820ce6e3) — pass `{}` to assert a NON-TIP commit carries zero
 * reserved-namespace lines at all.
 */
export function verifyLoomNamespaceExact(message: string, expected: Readonly<Record<string, string>>): boolean {
  const { exact, lines } = reservedNamespaceExactlyMatches(message, expected);
  return exact && lines.every((l) => l.finalParagraph);
}

/**
 * True when `message` carries EXACTLY `expected`'s reserved Loom namespace (every key once, correct
 * value, nothing extra) but NOT all in the final paragraph — the shape a commit-msg hook produces by
 * appending its OWN paragraph (prose, or a foreign trailer block) after Loom's own, intact trailer
 * paragraph. This is a DISTINCT, honest failure from a real forgery (wrong value, extra namespace key, a
 * duplicate): the trailers Loom wrote are completely unmolested, they are just no longer the message's
 * last paragraph, so {@link parseLoomTrailerBlock} (and this card's own `verifyLoomNamespaceExact`) can no
 * longer see them as such. Never call this before `verifyLoomNamespaceExact` has already returned `false`
 * for the same `message`/`expected` pair — it does not independently verify value-correctness beyond what
 * the exact-set check below already establishes.
 */
export function loomTrailerBlockDisplaced(message: string, expected: Readonly<Record<string, string>>): boolean {
  if (Object.keys(expected).length === 0) return false; // nothing expected ⇒ nothing to displace
  const { exact, lines } = reservedNamespaceExactlyMatches(message, expected);
  if (!exact) return false;
  return !lines.every((l) => l.finalParagraph); // the exact right set exists, just not all in the last paragraph
}

/**
 * The outcome of {@link verifyLoomTrailersExactAndReadable} — `kind` is set only on `ok:false` and
 * distinguishes three honestly-different causes a caller must word differently:
 *  - `"forged"` — the reserved namespace itself is wrong (missing/extra/duplicate/case-variant key, or a
 *    wrong value) — the generic "may have been tampered with" wording.
 *  - `"displaced"` — the exact right namespace exists, intact, just not in the message's final paragraph
 *    (see {@link loomTrailerBlockDisplaced}) — a commit-msg hook appended a paragraph after it.
 *  - `"unreadable"` — the namespace audit (`verifyLoomNamespaceExact`) reports exact, but the READER
 *    ({@link parseLoomTrailerBlock}, every mainline caller's only way to actually read a trailer) still
 *    can't read it back as the same values — a commit-msg hook altered Loom's own trailer paragraph
 *    without changing any reserved line's OWN text.
 *
 * @decision 95940402 (round 4, R1) — a prose line folded into the trailer paragraph with no blank-line
 * separator, an indented continuation, or a zero-width-character-prefixed key all produce `"unreadable"`:
 * each breaks the reader's per-line `key: value` requirement while staying invisible to the narrower scan.
 */
export type LoomTrailerVerification = { ok: true } | { ok: false; kind: "forged" | "displaced" | "unreadable" };

/**
 * Composes {@link verifyLoomNamespaceExact} + {@link loomTrailerBlockDisplaced} with a REAL round-trip
 * through {@link parseLoomTrailerBlock} — the one reader every other mainline consumer (hold-release,
 * `findLandedSquashCommit`, the merged-commit map, `readLandedTipTrailer`, mainline-watch) actually uses.
 * Round 3's own exact-set audit could report "exact" while that reader still returned `null` or a
 * DIFFERENT value, because `scanLoomNamespaceLines`'s per-line match and `parseLoomTrailerBlock`'s
 * per-line `key: value` requirement are not the same test — a line that breaks the SECOND without
 * matching the reserved-key shape the FIRST looks for (a prose line folded into the trailer paragraph, an
 * indented continuation, a zero-width-prefixed key) passed round 3's check while leaving the commit's own
 * trailers unreadable to every real reader (card 95940402 round 4, R1).
 *
 * `expected`'s `"Loom-Worker-Branch"` entry (when present) is also what this function round-trips against
 * the reader: `parseLoomTrailerBlock(message)` must return non-null with `.branch`/`.landedTip`/`.base`/
 * `.pathSet` each equal to `expected`'s own `"Loom-Worker-Branch"`/`"Loom-Landed-Tip"`/`"Loom-Worker-Base"`/
 * `"Loom-Worker-PathSet"` entry (or `null` when `expected` carries none of the latter three) — never a
 * literal `null` hardcoded for `landedTip`.
 *
 * A batch tip never passes a `"Loom-Landed-Tip"` entry (so `landedTip` must be `null` there, unchanged
 * batch behavior); the SOLO squash path's `mergeBranchLocked` DOES write it (`cc9bce38`).
 *
 * @decision 95940402 (round 5, F3) — compare against `expected["Loom-Landed-Tip"] ?? null`, never a
 * hardcoded `null`, so card `f224632d` can reuse this for the solo path too.
 *
 * @decision 95940402 (round 4, R1) — when `expected` has no `"Loom-Worker-Branch"` entry (the non-tip
 * case, `expected: {}`), there is nothing to round-trip — the exact-set check already proved zero
 * reserved lines exist.
 */
export function verifyLoomTrailersExactAndReadable(
  message: string, expected: Readonly<Record<string, string>>,
): LoomTrailerVerification {
  if (!verifyLoomNamespaceExact(message, expected)) {
    return { ok: false, kind: loomTrailerBlockDisplaced(message, expected) ? "displaced" : "forged" };
  }
  const expectedBranch = expected["Loom-Worker-Branch"];
  if (expectedBranch === undefined) return { ok: true }; // nothing to round-trip (e.g. a non-tip commit)
  const parsed = parseLoomTrailerBlock(message);
  if (!parsed) return { ok: false, kind: "unreadable" };
  if (parsed.branch !== expectedBranch) return { ok: false, kind: "unreadable" };
  if ((parsed.landedTip ?? null) !== (expected["Loom-Landed-Tip"] ?? null)) return { ok: false, kind: "unreadable" };
  if ((parsed.base ?? null) !== (expected["Loom-Worker-Base"] ?? null)) return { ok: false, kind: "unreadable" };
  if ((parsed.pathSet ?? null) !== (expected["Loom-Worker-PathSet"] ?? null)) return { ok: false, kind: "unreadable" };
  return { ok: true };
}

/**
 * The flag portion of every `changedPathsBetween`-family diff invocation, factored out to ONE array so a
 * new caller can never drift its own copy out of parity with this one (card c862f14c — {@link
 * stagedPathsAgainstHead}'s own doc explains why flag parity, not staged-vs-range timing, is the actual
 * divergence hazard between a pre-commit staged read and a post-commit range read). See {@link
 * changedPathsBetween}'s own doc for why `--no-renames` and `core.quotePath=false` are each load-bearing.
 */
const NAME_ONLY_DIFF_FLAGS = ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames"] as const;

/** @decision db9b0130 — the ONE shared git-diff invocation {@link changedPathSetDigest} and {@link
 *  isInertMergeDiff} both build on (extracted after the two drifted into byte-identical flag copies).
 *
 *  Never
 *  drop `--no-renames` — proven on git 2.47 it lets a renamed source file relocated into an allowlisted
 *  prefix misclassify as inert.
 *
 *  @decision 65b2b002 — `--end-of-options` guards the range token against an option-shaped `base`/`ref`;
 *  never bake it into {@link NAME_ONLY_DIFF_FLAGS} itself — see that decision record. */
async function changedPathsBetween(
  git: Pick<SimpleGit, "raw">, base: string, ref: string, timeoutMs?: number,
): Promise<string[]> {
  const args = [...NAME_ONLY_DIFF_FLAGS, "--end-of-options", `${base}..${ref}`];
  const raw = timeoutMs === undefined
    ? await git.raw(args)
    : await withTimeout(git.raw(args), timeoutMs, "git diff --name-only (changed paths)");
  return raw.split("\n").map((s) => s.replace(/\r$/, "")).filter(Boolean);
}

/**
 * The pre-commit counterpart to {@link changedPathsBetween}: the currently-STAGED index diffed against
 * `HEAD`, using the identical {@link NAME_ONLY_DIFF_FLAGS} so the two invocations cannot silently drift
 * out of flag parity (card c862f14c). Used by {@link mergeBranchLocked} to capture the
 * `Loom-Worker-PathSet` digest from the staged index BEFORE the squash commit lands, instead of
 * recomputing it from `sha^..sha` in a follow-up amend afterward — card c862f14c's DoD-1 proves the two
 * are the SAME two tree objects (a commit's tree is exactly the index it was made from, and its parent is
 * exactly what `HEAD` was before it), so this is not an approximation of the old value, it's the same
 * value read earlier.
 */
async function stagedPathsAgainstHead(
  git: Pick<SimpleGit, "raw">, timeoutMs?: number,
): Promise<string[]> {
  const args = [...NAME_ONLY_DIFF_FLAGS, "--cached", "HEAD"];
  const raw = timeoutMs === undefined
    ? await git.raw(args)
    : await withTimeout(git.raw(args), timeoutMs, "git diff --cached --name-only (staged changed paths)");
  return raw.split("\n").map((s) => s.replace(/\r$/, "")).filter(Boolean);
}

/** @decision f621f185 — deterministic digest over the SORTED changed-path set, never a content hash — a
 *  prototyped blob-hash approach was falsified against real git (disagrees on an entirely honest concurrent
 *  edit).
 *
 *  Never compute from the branch's pre-landing diff (`mergeBase..branch`) — digest the LANDED range
 *  instead, closing the identical-bytes and rename-following false-negative routes. */
export async function changedPathSetDigest(
  git: Pick<SimpleGit, "raw">, base: string, ref: string, timeoutMs?: number,
): Promise<string> {
  return pathSetDigest(await changedPathsBetween(git, base, ref, timeoutMs));
}

/**
 * The staged counterpart to {@link changedPathSetDigest} — same sort+hash over {@link
 * stagedPathsAgainstHead}'s pre-commit path list, so a digest captured before the squash commit lands is
 * byte-identical to one {@link changedPathSetDigest} would have computed from `sha^..sha` afterward (card
 * c862f14c DoD-1/DoD-3).
 */
async function stagedPathSetDigest(git: Pick<SimpleGit, "raw">, timeoutMs?: number): Promise<string> {
  return pathSetDigest(await stagedPathsAgainstHead(git, timeoutMs));
}

/** Shared sort+hash core for {@link changedPathSetDigest} and {@link stagedPathSetDigest} — kept as ONE
 * function so the two can never compute the digest differently from the same path list. */
function pathSetDigest(paths: string[]): string {
  return createHash("sha256").update([...paths].sort().join("\n")).digest("hex");
}

/** @decision db9b0130 — path prefixes PROVEN (via a read-call grep, not assumed) to hold nothing
 *  compiled/tested/read by the Loom daemon suite — never widen without re-running that grep first.
 *
 *  `assets/skills/**` is deliberately EXCLUDED (real tests read it as a comparison oracle); LOOM-ONLY, so
 *  {@link isInertMergeDiff} re-verifies PER-REPO via {@link repoTreeReferencesInertPrefix}. */
const INERT_MERGE_PATH_PREFIXES = ["docs/"];

/** @decision 82662e98 — root-level EXACT-match inert files (a `startsWith` prefix can't express a filename
 *  with no directory component), measured zero real test reads.
 *
 *  `CLAUDE.md` is DELIBERATELY, PERMANENTLY
 *  EXCLUDED — `test/kickoff-real-spawn.mjs` has a real behavioral dependency on its content; two pinned
 *  regressions (`merge-gate-inert-diff.mjs` (M), `emit-compare-gate.mjs` (O)) assert this. */
const INERT_MERGE_EXACT_PATHS = ["README.md", "CHANGELOG.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "SECURITY.md"];

/** Escapes every ERE metacharacter in `s` so it can be interpolated into {@link
 *  repoTreeReferencesInertPrefix}'s `git grep -E` pattern as a LITERAL — needed the moment a token can
 *  contain a real metacharacter (a root filename's `.`, e.g. `README.md`), unlike every prefix
 *  {@link INERT_MERGE_PATH_PREFIXES} has held so far (`docs` has none). An unescaped `.` only WIDENS the
 *  match (matches any character in its place), which is the safe direction (a spurious match just forces
 *  one extra full gate) — but a precise match is still what this function is for, so escape rather than
 *  rely on that asymmetry. */
function escapeEreLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a single path falls under an {@link INERT_MERGE_PATH_PREFIXES} prefix OR matches an {@link
 * INERT_MERGE_EXACT_PATHS} entry exactly — the ONE predicate both {@link isInertMergeDiff} (below) and
 * {@link computeEmitCompareGate}'s classification loop (further down this file) test against, so the
 * boundary semantics `merge-gate-inert-diff.mjs` scenario (G) pins (`docs-internal/`, `docsfoo.md` must
 * NOT match) can never drift between the two call sites — card b97f643d, Code Review: reusing the LIST
 * alone still left the `startsWith` PREDICATE written twice, which is the identical divergence risk one
 * level down from a second hand-copied list. The exact-path arm (card 82662e98) cannot have that same
 * boundary failure mode at all — `===` never matches a path that merely shares a prefix or suffix with a
 * listed name (`sub/README.md`, `README.md.bak`, `NOTREADME.md` all correctly fail), so it needs no
 * analogous pinned scenario for false-widening, only for the CLAUDE.md exclusion (see that list's own
 * doc).
 */
function isInertMergePath(p: string): boolean {
  return INERT_MERGE_PATH_PREFIXES.some((prefix) => p.startsWith(prefix)) || INERT_MERGE_EXACT_PATHS.includes(p);
}

/** @decision 1c0d4aa4 — whether every changed path falls under an inert allowlist prefix: a PROVABLE property
 *  of the changed-path SET, not a coverage prediction (the deferred `1055f5e3` idea infers coverage — NOT
 *  this).
 *
 *  FAILS CLOSED to `false` on every uncertain case: a git error, zero paths, an unrecognized path, or a
 *  per-repo re-scan that can't confirm absence. */
export async function isInertMergeDiff(
  repoPath: string, baseSha: string, ref: string | undefined, deps: BoundedGitDeps = {},
): Promise<boolean> {
  // @decision 35cfcbe0 — `ref` is the branch SHA the caller pins its squash to (never the branch NAME, which can move between classification and pin: a T1→T2→T1 ABA).
  // An unreadable tip (undefined) fails closed to "not provably inert" — the real gate.
  if (!ref) return false;
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  let paths: string[];
  try {
    paths = await changedPathsBetween(git, baseSha, ref, timeoutMs);
  } catch {
    return false;
  }
  if (paths.length === 0) return false;
  if (!paths.every(isInertMergePath)) return false;
  // Card 1c0d4aa4 (Code Review finding on b97f643d): INERT_MERGE_PATH_PREFIXES above is certified by
  // MEASURING Loom's own test corpus (card db9b0130's doc comment) — but this function runs for every
  // project this daemon serves, not just Loom. Re-verify the measurement PER-REPO, against THIS repo's
  // corpus at `baseSha`, before trusting it for a project it was never measured against. See
  // {@link repoTreeReferencesInertPrefix}'s own doc for the fail-closed contract.
  for (const prefix of INERT_MERGE_PATH_PREFIXES) {
    const bareToken = prefix.replace(/\/+$/, "");
    const referenced = await repoTreeReferencesInertPrefix(repoPath, baseSha, bareToken, timeoutMs);
    if (referenced) return false;
  }
  // Card 82662e98: same per-repo re-verification, extended to the exact-path list — a project other than
  // Loom whose own tests genuinely read one of these root filenames (a real, non-Loom-specific risk this
  // list's own doc already reasons about for CLAUDE.md) must not have its gate silently skipped either.
  // `escapeEreLiteral` is required here (unlike the prefix loop above, which has never held a token with
  // an ERE metacharacter): a bare "README.md" would let the "." match ANY character in `git grep -E`,
  // over-matching — safe (forces an unnecessary full gate, never a missed one) but imprecise, so escape
  // rather than lean on that asymmetry.
  for (const exactPath of INERT_MERGE_EXACT_PATHS) {
    const referenced = await repoTreeReferencesInertPrefix(repoPath, baseSha, escapeEreLiteral(exactPath), timeoutMs);
    if (referenced) return false;
  }
  return true;
}

/** `git grep`'s own exit code for "searched the tree, found nothing" — the ONLY outcome {@link
 *  repoTreeReferencesInertPrefix} treats as a confirmed, real absence. Any other exit code (a bad
 *  revision, a corrupt object, git erroring) means the absence was never actually proven. */
const GIT_GREP_NO_MATCH_EXIT_CODE = 1;

/** @decision 1c0d4aa4 — the per-repo read-call+anchor scan requires a real-source-tree anchor (`__dirname`
 *  etc.) alongside the read-call name — never drop it; without it a throwaway test fixture path falsely reads
 *  as a genuine project read.
 *
 *  NOT a perfect discriminator: 3 named fail-OPEN pattern-coverage gaps
 *  (indirection, nested parens, multi-line calls) remain accepted. */
const INERT_PREFIX_READ_CALL_NAMES = "(readFileSync|existsSync|readdirSync|createReadStream|readFile|opendirSync|globSync)";
/** See {@link INERT_PREFIX_READ_CALL_NAMES}'s own doc — the anchor alternation checked on either side of
 *  the token. `import\\.meta\\.dirname` (Node ≥20.11; this repo targets 22) added alongside the original
 *  four (Code Review, card 1c0d4aa4). */
const INERT_PREFIX_ANCHOR_PATTERN = "(__dirname|__filename|process\\.cwd\\(\\)|import\\.meta\\.url|import\\.meta\\.dirname)";

/**
 * The COMPLETE extension vocabulary a file must carry for {@link INERT_PREFIX_READ_CALL_NAMES}/{@link
 * INERT_PREFIX_ANCHOR_PATTERN} to have any chance of matching it — plain JS, its module variants
 * (`.mjs`/`.cjs`), and TypeScript incl. JSX/TSX and the `.mts`/`.cts` module variants. Deliberately
 * EXHAUSTIVE rather than a sample: the read-call names and anchor tokens above are Node/JS/TS API surface,
 * so this list is not a heuristic guess at "what a JS/TS project looks like" — it is the complete set of
 * extensions any file would need for those literal tokens to be syntactically meaningful in it at all. That
 * completeness is what lets {@link repoTreeHasJsTsSourceFile} bound its own applicability question (see
 * that function's doc) without reintroducing the same per-language guessing game this card fixes.
 *
 * Also reused as {@link repoTreeReferencesInertPrefix}'s `git grep` pathspec (card d05831a7), so its scan
 * can never again search non-JS/TS files (e.g. markdown quoting the pattern as a literal example) with no
 * vocabulary check at all. Keep it one shared array, never two hand-copied lists.
 */
const JS_TS_SOURCE_EXTENSIONS = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];
const JS_TS_SOURCE_EXTENSION_PATTERN = new RegExp(`\\.(?:${JS_TS_SOURCE_EXTENSIONS.join("|")})$`, "i");

/** @decision 0910531e — is the read-call/anchor scan's JS/TS vocabulary even APPLICABLE to this repo's
 *  tracked tree? In a repo with zero JS/TS-extension files, a "no match" is a TAUTOLOGY, not evidence —
 *  never trust that grep's result without checking this FIRST; fails closed on any git error/timeout. */
function repoTreeHasJsTsSourceFile(
  repoPath: string, treeish: string, timeoutMs: number,
): Promise<{ applicable: boolean; degradedReason?: string }> {
  return new Promise((resolve) => {
    // @decision 868e0135 — `--end-of-options` before `treeish`: every caller resolves it from `rev-parse
    // HEAD`/`union.mainSha` first (never caller input), but an option-shaped value would otherwise be
    // read as an ls-tree flag, same class as `fullTreeEntries`'s identical shape above.
    const child = spawn(resolveGitBinaryForSpawn(), [...CANONICAL_GIT_CONFIG_ARGS, "ls-tree", "-r", "--name-only", "--end-of-options", treeish], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    child.stdout?.on("data", (d) => { out += d; });
    let settled = false;
    const done = (r: { applicable: boolean; degradedReason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done({ applicable: false, degradedReason: `git ls-tree exceeded ${timeoutMs}ms (killed)` });
    }, timeoutMs);
    child.on("error", (e) => { done({ applicable: false, degradedReason: `spawn failed (${e.message})` }); });
    child.on("close", (code) => {
      if (code !== 0) {
        done({ applicable: false, degradedReason: `git ls-tree exited ${code ?? "null"} (likely an unresolvable treeish)` });
        return;
      }
      const found = out.split("\n").some((line) => JS_TS_SOURCE_EXTENSION_PATTERN.test(line.trim()));
      done({ applicable: found });
    });
  });
}

/** @decision 0910531e — whether THIS repo's own corpus (at `treeish`) actually reads paths under `bareToken`,
 *  via a direct `git grep` spawn (never simple-git's `.raw()`) so the real exit code is observable:
 *
 *  ONLY a
 *  confirmed no-match (1) is trusted; every other outcome (spawn error, bad treeish, timeout, a
 *  blobless-partial-clone fetch 128) fails closed to `true` and is LOGGED, not silent. */
export async function repoTreeReferencesInertPrefix(
  repoPath: string, treeish: string, bareToken: string, timeoutMs: number,
): Promise<boolean> {
  const { applicable, degradedReason } = await repoTreeHasJsTsSourceFile(repoPath, treeish, timeoutMs);
  if (!applicable) {
    const reason = degradedReason ?? "no JS/TS-extension file found in tracked tree";
    console.warn(`[git:inert-prefix-scan] ${reason} for ${repoPath}@${treeish} — the read-call/anchor scan is JS/TS vocabulary and cannot confirm an absence for token "${bareToken}" on this repo's language — failing closed, treating as referenced`);
    return true;
  }
  return new Promise((resolve) => {
    // Plain capturing groups, NOT `(?:...)` — git grep's -E is POSIX ERE, which has no non-capturing-group
    // syntax at all (measured: git rejects it outright with "Invalid preceding regular expression", exit
    // 128 — itself fail-closed, but this is the fix, not a case to rely on failing closed for).
    const pattern = `${INERT_PREFIX_READ_CALL_NAMES}\\([^)]*(${INERT_PREFIX_ANCHOR_PATTERN}[^)]*${bareToken}|${bareToken}[^)]*${INERT_PREFIX_ANCHOR_PATTERN})`;
    // card d05831a7: scoped to the SAME JS/TS extension vocabulary repoTreeHasJsTsSourceFile already
    // gated on above — without this pathspec the scan searched the WHOLE tree (markdown included), so a
    // doc merely QUOTING this pattern as a literal example (a real docs/decisions/1c0d4aa4-*.md hit) could
    // falsely confirm the token "referenced" and disable the docs/-inert skip repo-wide.
    const child = spawn(resolveGitBinaryForSpawn(), [...CANONICAL_GIT_CONFIG_ARGS, "grep", "-I", "-l", "-E", pattern, treeish, "--", ...JS_TS_SOURCE_EXTENSIONS.map((ext) => `*.${ext}`)], {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderrTail = "";
    child.stderr?.on("data", (d) => { stderrTail = appendTail(stderrTail, d); });
    const warnDegraded = (reason: string) => {
      console.warn(`[git:inert-prefix-scan] ${reason} for ${repoPath}@${treeish} (token "${bareToken}") — failing closed, treating as referenced${formatTail(stderrTail)}`);
    };
    let settled = false;
    const done = (r: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      warnDegraded(`git grep exceeded ${timeoutMs}ms (killed)`);
      done(true); // couldn't confirm absence within the bound ⇒ fail closed
    }, timeoutMs);
    child.on("error", (e) => { warnDegraded(`spawn failed (${e.message})`); done(true); }); // fail closed, cannot confirm absence
    // "close" (not "exit" — card 0910531e nitpick): "exit" can fire before piped stderr has fully
    // flushed, truncating warnDegraded's diagnostic tail on exactly the degraded outcomes it exists to
    // surface. "close" waits for the stdio streams to end too.
    child.on("close", (code) => {
      if (code === 0 || code === GIT_GREP_NO_MATCH_EXIT_CODE) { done(code !== GIT_GREP_NO_MATCH_EXIT_CODE); return; }
      warnDegraded(`git grep exited ${code ?? "null"} (neither a confirmed match nor a confirmed no-match)`);
      done(true);
    });
  });
}

/** Prefix under which a Loom-bundled skill asset lives. Only Loom's OWN self-hosted repo ever has a path
 *  under this prefix at all — every other project's diff simply never matches it, so {@link
 *  changedSkillNames} is a true no-op there (card 64a30c79's negative control). Deliberately unrelated to
 *  {@link INERT_MERGE_PATH_PREFIXES} above (a gate-SKIP allowlist) — this is a liveness-WARNING detector,
 *  never a gate-eligibility signal; an assets/skills/** diff still gates exactly as before this existed. */
const SKILL_ASSET_PREFIX = "packages/daemon/assets/skills/";

/** @decision 13965c93 — per-skill info for what a diff touched under skill assets, split into distinct
 *  facts — never collapse them back into one warning line, that was the exact miscommunication this split
 *  fixed. Fails closed to `[]`; only ever describes what the DIFF touched, never store/session state. */
export interface ChangedSkillInfo {
  name: string;
  /** `true` iff this diff touched `<name>/SKILL.md` itself (the ambiently-read file). */
  skillMdChanged: boolean;
  /** `true` iff every touched path under `<name>/` sits under `references/` — i.e. `SKILL.md` was NOT
   *  touched, so nothing about this diff is ambient; an agent only sees it if it happens to open that
   *  specific reference file. */
  referencesOnly: boolean;
  /**
   * `true` iff `<name>/SKILL.md` was DELETED by this diff (a `D` row from `git diff --name-status`) — the
   * entrypoint asset is gone from the tree at `ref`. Distinct from `skillMdChanged`/`referencesOnly`: a
   * caller should check this FIRST, since neither "live at the next restart" (pristine) nor "needs an
   * explicit adopt" (customized) holds for a deletion — `seedGlobalSkills()` is seed-if-absent and never
   * removes an orphaned store dir unless its name is on the hardcoded `RETIRED_BUNDLED_SKILL_NAMES`
   * allowlist (`skills/store.ts`), which a fully-deleted skill is deliberately never added to.
   */
  deleted: boolean;
}

/**
 * Same flag discipline as {@link NAME_ONLY_DIFF_FLAGS} (`--no-renames` so a moved/renamed file always
 * appears as a plain `A`+`D` pair rather than an unattributable `R`/`C` row; `core.quotePath=false` so a
 * non-ASCII path isn't octal-escaped past the {@link SKILL_ASSET_PREFIX} prefix check) — kept as its own
 * array rather than reusing `NAME_ONLY_DIFF_FLAGS` because `--name-only` and `--name-status` are mutually
 * exclusive diff output modes.
 */
const NAME_STATUS_DIFF_FLAGS = ["-c", "core.quotePath=false", "diff", "--name-status", "--no-renames"] as const;

/**
 * `--name-status` counterpart to {@link changedPathsBetween} — same flags, same `base..ref` range shape,
 * but returns the change-type LETTER (`A`/`M`/`D`/`T`/`U`/`X`/`B`) per path instead of just the path.
 * Local to {@link changedSkillNames}'s `deleted` detection (its only caller) rather than a third shared
 * helper. Best-effort like {@link diffNameStatus}: a row that doesn't parse as `<letter>\t<path>` is
 * skipped, never guessed — `--no-renames` above means an `R`/`C` row should never occur here in the first
 * place, so this is defensive, not the primary path.
 */
async function changedPathStatusesBetween(
  git: Pick<SimpleGit, "raw">, base: string, ref: string, timeoutMs?: number,
): Promise<Map<string, string>> {
  // @decision 65b2b002 — `--end-of-options` guards the range token the same way {@link changedPathsBetween} does; see that decision record.
  const args = [...NAME_STATUS_DIFF_FLAGS, "--end-of-options", `${base}..${ref}`];
  const raw = timeoutMs === undefined
    ? await git.raw(args)
    : await withTimeout(git.raw(args), timeoutMs, "git diff --name-status (changed skill statuses)");
  const map = new Map<string, string>();
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 1) continue; // no tab, or an empty status column — can't parse
    const letter = line[0];
    if (!letter) continue;
    const rest = line.slice(tab + 1);
    if (rest.includes("\t")) continue; // a second tab means more than one path on this row — skip
    if (!rest) continue;
    map.set(rest, letter);
  }
  return map;
}

export async function changedSkillNames(
  repoPath: string, base: string, ref: string, deps: BoundedGitDeps = {},
): Promise<ChangedSkillInfo[]> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  let statuses: Map<string, string>;
  try {
    statuses = await changedPathStatusesBetween(git, base, ref, timeoutMs);
  } catch {
    return [];
  }
  const bySkill = new Map<string, string[]>();
  for (const p of statuses.keys()) {
    if (!p.startsWith(SKILL_ASSET_PREFIX)) continue;
    const rest = p.slice(SKILL_ASSET_PREFIX.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    const subPath = slash === -1 ? "" : rest.slice(slash + 1);
    if (!name) continue;
    const list = bySkill.get(name);
    if (list) list.push(subPath); else bySkill.set(name, [subPath]);
  }
  return [...bySkill.keys()].sort().map((name) => {
    const subPaths = bySkill.get(name)!;
    return {
      name,
      skillMdChanged: subPaths.includes("SKILL.md"),
      referencesOnly: subPaths.length > 0 && subPaths.every((s) => s.startsWith("references/")),
      deleted: statuses.get(`${SKILL_ASSET_PREFIX}${name}/SKILL.md`) === "D",
    };
  });
}

/** Compiled-source, non-compiled-script, and non-compiled-test path scopes {@link computeEmitCompareGate}
 *  classifies changed paths into — see that function's own doc for why only these, and why everything
 *  else fails closed. {@link EMIT_COMPARE_SCRIPTS_PREFIX} (card 82662e98) is classified through the SAME
 *  transpile-compare mechanism as {@link EMIT_COMPARE_SRC_PREFIX}, but at a DIFFERENT compiler `target`
 *  (see that classification arm's own comment for why: an `.mjs` script is never compiled — the checked-
 *  in source IS what Node runs — so downleveling any syntax at all would compare something that never
 *  executes). */
const EMIT_COMPARE_SRC_PREFIX = "packages/daemon/src/";
const EMIT_COMPARE_TEST_PREFIX = "packages/daemon/test/";
const EMIT_COMPARE_ASSETS_PREFIX = "packages/daemon/assets/";
const EMIT_COMPARE_SCRIPTS_PREFIX = "packages/daemon/scripts/";

/** Whether `p` falls inside any of the four scopes {@link computeEmitCompareGate} classifies against —
 *  shared by the classification loop's own per-path checks and by {@link EmitCompareNotApplicableKind}'s
 *  `"repo-out-of-domain"` vs `"path-out-of-scope"` split, which asks this of the WHOLE diff first (not just
 *  the one path that tripped the catch-all) as a cheap pre-check before falling back to a real `git ls-tree`
 *  against the repo's own tree — see that catch-all's own doc for why the diff-only question alone is not
 *  sufficient to answer a claim about the REPO. */
function isEmitCompareInScopePath(p: string): boolean {
  return p.startsWith(EMIT_COMPARE_SRC_PREFIX) || p.startsWith(EMIT_COMPARE_TEST_PREFIX)
    || p.startsWith(EMIT_COMPARE_ASSETS_PREFIX) || p.startsWith(EMIT_COMPARE_SCRIPTS_PREFIX);
}

/** The static source-TEXT guards (Code Review, card 2154b6ad — see
 *  docs/decisions/2154b6ad-emit-compare-skips-the-runtime-suite-not-the-whole-gate.md) — these
 *  grep raw file content rather than compiled behavior, so {@link computeEmitCompareGate}'s emit-compare
 *  proof does not cover them; a reduced gate built from {@link buildReducedGateCommand} always runs them
 *  unconditionally, same as it always runs `pnpm build`. Repo-root-relative: the real `gateCommand` (e.g.
 *  `"pnpm build && pnpm --filter @loom/daemon test:daemon"`) always runs from repo root, so a reduced
 *  command built from these paths must match that convention to `&&`-chain into {@link splitGateSteps}
 *  the identical way.
 *
 *  MEMBERSHIP CRITERION (card a1734000) — why these five and not every `test/*guard*.mjs`: a guard
 *  belongs here only if something OTHER than a behavioural `.ts` edit can invalidate what it asserts. A
 *  behavioural `.ts` edit already fails {@link computeEmitCompareGate} closed to the FULL gate, where
 *  every guard under `packages/daemon/test/` runs anyway via the corpus walk — so a guard whose ONLY
 *  invalidator is that kind of edit needs no seat on the reduced path; it is never reachable-but-unrun.
 *  `emit-compare-soundness-guard.mjs` is deliberately excluded on exactly this ground: it is the
 *  regression test FOR `emitCompareSoundnessOk` (`../emit-compare-soundness.ts`, imported below) — the
 *  SOUNDNESS PRECONDITION this function's own doc comment describes — and that precondition is re-checked
 *  LIVE, fail-closed, on every reduced-path call regardless of this guard. Its own correctness can
 *  therefore only be broken by editing `emit-compare-soundness.ts` itself or this file's own call site,
 *  either of which is itself a behavioural `.ts` edit under `packages/daemon/src`. Investigated + confirmed
 *  at card a1734000 (re-verified against the `bafc68e7` consolidation); do not re-add it here without
 *  re-deriving the argument against the criterion above, and do not read its absence as an oversight.
 *
 *  ⛔ NOT A GLOB, DELIBERATELY: `grep -l readdirSync packages/daemon/test/*guard*.mjs` finds every
 *  corpus-wide-scanning guard — a DISCOVERABLE family sitting right next to this HARDCODED list, which
 *  is an intentional divergence, not an oversight. Membership here is a JUDGEMENT call against the
 *  criterion above; a glob would silently re-admit `emit-compare-soundness-guard.mjs` on the next guard
 *  file that happens to match the name pattern and reverse this decision without anyone deciding it.
 *  Adding a guard here means deciding against the criterion above, never "the filename matches so it
 *  belongs."
 *
 *  @decision 6bb60fd0 — a `readdirSync`-presence filter is wrong as a proxy for this list's membership
 *  criterion in a SECOND way, independent of `a1734000` above: WHICH files it wrongly drops or picks up drifts
 *  on its own clock — never cite a specific file as a standing counter-example; run `pnpm --filter
 *  @loom/daemon guards` instead of re-deriving this list from `readdirSync`.
 *
 *  `packages/daemon/test/_emit-compare-fixtures.mjs`'s `GUARD_BASENAMES` (consumed by `emit-compare-
 *  gate.mjs` and its siblings to assert each guard actually appears in the reduced gate command
 *  {@link buildReducedGateCommand} builds) is DERIVED from this list at test-load time, not hand-copied
 *  (card f645b481) — so an addition or removal here needs no matching edit there; the two cannot drift.
 *
 *  EXPORTED (card 245a3708) so `scripts/run-static-guards.mjs` (the `pnpm guards` command) can run
 *  exactly this list without restating it — see that script's own header for why a second copy of these
 *  paths anywhere is worse than not having a runner at all.
 */
export const STATIC_GUARD_REPO_PATHS = [
  "packages/daemon/test/clock-path-regression-guard.mjs",
  "packages/daemon/test/fixed-wait-negative-guard.mjs",
  "packages/daemon/test/onexit-discard-guard.mjs",
  "packages/daemon/test/codescape-privacy-guard.mjs",
  // Card 5e51e778 (Code Review finding): a reduced gate for a test-only diff runs ONLY this list plus the
  // changed test file(s) themselves — never the full ~668-test suite. Without this entry, a diff that
  // ADDS an unwitnessed raw-sleep site to test/*.mjs (exactly the diff class this guard exists to police)
  // took the reduced path and never ran it at all: it wasn't a static guard, and it wasn't "the changed
  // test file" unless the diff happened to touch this exact file. Diff-scoped (not a corpus-wide scan
  // like its three siblings above), but that's orthogonal to WHERE it must run — it still greps live
  // source-TEXT (a real `git diff`, not compiled behavior), so it belongs in this list on the same
  // grounds `fixed-wait-negative-guard.mjs` already does.
  "packages/daemon/test/fixed-wait-witness-guard.mjs",
  // Card 7a5948bd: a corpus-wide scan (same shape as its siblings above) asserting that
  // `process.env.LOOM_REAL_HOME` (card d1e10795) is read only by its allowlisted consumer(s), and that
  // every read resolves exclusively to a `gate-timing/` (telemetry-only) path. See the guard's own header
  // for the full reasoning: without this entry, a NEW test file reading this var to reach the real
  // `~/.loom` (which holds `loom.db`) would ship on the reduced gate path with nothing catching it — the
  // exact hermetic-guard blind spot (`requireHermeticEnv` cannot see this var) this card closed.
  "packages/daemon/test/real-home-scope-guard.mjs",
  // Card 2b099e48 (HarnessAdapter seam, Phase 0): a corpus-wide scan of packages/daemon/src/**/*.ts asserting
  // no claude-specific `.claude`/'claude' literal exists outside the adapter module's own file allowlist —
  // see the guard's own header for the comment/code classification and why it exists (the seam this card just
  // extracted has no structural way to stop a FUTURE file from reintroducing the same scattered coupling).
  "packages/daemon/test/harness-adapter-claude-literal-guard.mjs",
  // Card 4cbbc343: a corpus-wide, comment-stripped scan of packages/daemon/src/**/*.ts asserting no trust decision
  // reads a peer address or compares to a loopback literal outside the single predicate (`requestClass`,
  // gateway/trust-tier.ts) — a trust-boundary invariant, seated here on the same ground as the harness-literal
  // guard above (owner-directed: it must run on every reduced gate regardless of diff shape).
  "packages/daemon/test/remote-trust-single-predicate-guard.mjs",
  // Card 4f2c493a (comment corrected by card a9728787): reads working-tree BYTES ON DISK to catch a
  // Write-tool (or equivalent) wholesale rewrite silently flipping a tracked text file's line endings.
  // `git diff HEAD`, `git diff --numstat`, and `git show HEAD:<file>` are blind to that flip in every
  // state, but `git status --porcelain` DOES see it while unstaged — it only goes blind once staged
  // (`git add`). This guard skips status because of THAT staging step, not because status is blind
  // outright, and skips the other three because they're blind regardless (see the guard's own header for
  // the full mechanism). Belongs here on
  // the same ground as fixed-wait-witness-guard.mjs above: a CRLF flip of a packages/daemon/src/**/*.ts or
  // packages/daemon/test/**/*.mjs file changes zero compiled/runtime behaviour, so it can pass through
  // computeEmitCompareGate's reduced path (which reasons about compiled-output/test-pass equivalence, not
  // raw bytes) without ever re-running the corpus-wide guards this array feeds the reduced gate too.
  "packages/daemon/test/working-tree-eol-guard.mjs",
  // Card e211ec89: a corpus-wide source-text scan asserting no `packages/daemon/test/*.mjs` reaches the
  // REAL `currentDeployStaleness()` (served-status.ts) unfixtured — either via a `resumeFleetOnBoot(...)`
  // call omitting its `deployStaleness` test seam, or via a direct import/call of `currentDeployStaleness`
  // itself (which has no override at all). Belongs here on the same ground as its siblings above: this is
  // a source-TEXT property (an omitted argument, a bare identifier reference), not a compiled-output/
  // test-pass-equivalence property `computeEmitCompareGate`'s reduced path can reason about — a diff that
  // adds a new unfixtured `resumeFleetOnBoot` call could take the reduced path and never trip a single
  // assertion, exactly the merge-gate incident (six assertions across four files, reproduced on card
  // 062fa934's branch) this guard exists to stop from recurring. See the guard's own header for the full
  // reproduced cache-replay chain and for what this guard deliberately does NOT flag (bare
  // `computeDeployStaleness()` calls, and `buildServedStatus()`'s two deliberate real-tree tests).
  "packages/daemon/test/deploy-staleness-fixture-guard.mjs",
  // Card 27d6c5a4 (Code Review finding #3): a corpus-wide source-TEXT scan consolidating six "this
  // human-only surface is NEVER an MCP tool" sub-assertions that used to live only inside their own full
  // behavioral test files (setup-project-init-rest.mjs, setup-templates-rest.mjs, companion-lead-mode.mjs,
  // event-trigger-mcp-absence.mjs, update-endpoint.mjs, shell-terminal.mjs) — none of those files were in
  // this list, so a comment-only src/mcp/**\/*.ts edit quoting a forbidden literal (e.g. a doc comment
  // citing "/api/setup/project-init") took the reduced path and never tripped a single one of them: exactly
  // the merge-gate incident shape this array exists to close. See the guard's own header for the full
  // enumeration, the sweep that found it (10 raw "no MCP" hits, 4 ruled out as purely dynamic), and why (4)
  // and (5) below scan SOURCE `.ts` rather than the COMPILED `.js` their origin tests use (same content,
  // consistent with every other member here).
  "packages/daemon/test/human-only-surface-leak-guard.mjs",
  // Card 82bb198a: the gate's own verdict (`runOne` in scripts/test-daemon.mjs) is exit-code-only — a
  // hermetic test file whose `check()`/`failures` bookkeeping never reaches a real `process.exit`/
  // `finishAndExit`/`process.exitCode=`/`node:test`/`node:assert`/`throw new` route exits 0 by Node's own
  // default regardless of printed FAIL lines, so the gate reports PASS for a file that actually failed.
  // Confirmed once for real (merge-confirm-verdict-cache.mjs, fixed in this same card). Belongs here on the
  // same ground as its corpus-wide-scan siblings above: a source-TEXT property the reduced/emit-compare
  // path cannot reason about, so a NEW test file missing this route must still be caught even when the
  // diff that adds it doesn't happen to touch this guard file itself. See the guard's own header for why a
  // static source scan (this) was chosen over a runner-level output-scan backstop (the guard self-tests in
  // this corpus that deliberately print failure-shaped text as their own positive control would false-
  // positive an output scan — see card 2f0b2e57).
  "packages/daemon/test/exit-code-verdict-guard.mjs",
  // Card 3c4a19cb: a corpus-wide source-text scan asserting that any `packages/daemon/test/*.mjs` object
  // literal setting `failingTestCount:` also sets `failTierTest:`/`failTierTestCount:` — omitting them
  // silently loses the merge gate's single-file retry (`identifyRetriableTestFile`, gate-runner.ts reads
  // ONLY `failTierTest*`, never `failingTest*`; see card 0e5b2045's decoupling). This bit twice, hours
  // apart, fixed by commit a995d7bc. Belongs here on the same ground as its corpus-wide-scan siblings
  // above: a source-TEXT property the reduced/emit-compare path cannot reason about — a diff that ADDS a
  // new mis-paired test double to test/*.mjs (exactly the incident class this guard exists to police)
  // would otherwise take the reduced path (that changed test file only runs ITS OWN assertions via
  // `--only=`, never this separate guard) and never trip a single check. See the guard's own header for
  // its one named exemption (merge-gate-concurrency-verdict.mjs) and why a narrower, `failingTestCount:`-
  // gated rule was chosen over the wider "any failingTest:" shape.
  "packages/daemon/test/failing-test-tier-pairing-guard.mjs",
  // @decision 82662e98 — the standing backstop for INERT_MERGE_EXACT_PATHS: a read-call-scoped literal scan
  // of the WHOLE test/ corpus.
  //
  // PROVABLY BLIND to CLAUDE.md's own real-read indirection shape (an anchor on an
  // earlier line, the filename read through that constant later) — never auto-classify a hit as "real" vs.
  // "synthetic fixture"; every hit fails loudly and gets hand-verified.
  "packages/daemon/test/inert-exact-path-corpus-guard.mjs",
  // Card d05831a7: this scan's own sibling above (inert-exact-path-corpus-guard.mjs) was already in this
  // array, but this file — the one that actually pins repoTreeReferencesInertPrefix's per-repo re-scan,
  // including check (4)'s LIVE assertion against Loom's own real HEAD — was not. A reduced gate for a
  // worktrees.ts-only diff never ran the one test guarding its own premise, which is how a missing
  // git-grep pathspec (the scan searching markdown, not just JS/TS) shipped green: main went red only
  // because a later docs-only commit happened to add prose quoting the scan's own pattern as an example.
  "packages/daemon/test/inert-prefix-repo-scan.mjs",
  // Multi-harness epic df1f94b0 Phase 1, card 353f6dc4, lead ruling #5: a corpus-scoped source-text scan
  // (a pinned method-name list against pty/host.ts, not the whole test/ corpus) asserting every
  // AGNOSTIC-classified PtyHost method this card migrated routes its session lookup through the shared
  // `findAnyLive` resolver, with no leftover `this.live.get` — the structural backstop ruling #5 required
  // against the codex(`liveCodex`)/claude(`live`) two-registry drift hazard: a future AGNOSTIC method that
  // reads `this.live` directly would silently ignore every codex session, the same silent-wrong-answer
  // class this array's other guards exist to catch for their own respective source-TEXT properties.
  // Belongs here on the same ground as its siblings above: a real `pty/host.ts` edit that regresses one of
  // the 28 pinned methods back onto `this.live.get` changes zero compiled/runtime behavior FOR CLAUDE (the
  // codex-specific behavior it silently breaks has no claude-side test to catch it), so it could otherwise
  // take the reduced path and never trip a single check.
  "packages/daemon/test/pty-agnostic-methods-findanylive-guard.mjs",
  // Card d34dd208 (the "structured field that lies" class): a corpus-scoped source-text scan (re-derives
  // PROFILE_FIELD_NAMES from profiles/validate.ts's own zod schema, not hand-copied) asserting every
  // Profile field the validator accepts has a registered, re-verified consumer, a legitimate closed-enum
  // exemption, or a declared+carded open gap (a real Loom board card id — see field-consumers.ts's own
  // header) on every supported harness. Belongs here on the same ground as its siblings above: a NEW
  // field added to profileSchema with no matching field-consumers.ts entry, or a refactor that silently
  // drops a real consumption line one of the existing entries' `proofs[].pattern` still claims, changes
  // zero compiled/runtime behavior on its own (it's a missing DECLARATION, not a type error) — exactly
  // the "caught by a human reading the artifact, never by CI" failure mode this card exists to close, so
  // it could otherwise take the reduced path and never trip a single check. Currently green with 5 known,
  // carded gaps (tracked by card 0770d916) printed loudly at every run — see the guard's own header.
  "packages/daemon/test/profile-field-consumer-guard.mjs",
  // Card 3791b14e (lead-requested follow-up): a corpus-wide readdirSync scan (this array's own dominant
  // shape, not the one diff-scoped exception above) asserting every test file that imports
  // `acquireCodexRealSpawnLock` from `_codex-real-spawn-lock.mjs` is a registered member of that module's
  // `CODEX_REAL_SPAWN_BASENAMES` — the list `scripts/test-daemon.mjs` schedules sequentially. A caller that
  // forgets to register silently runs in the ORDINARY CONCURRENT POOL alongside real `codex` processes
  // instead — passing standalone, failing only once it collides with a sibling under real gate contention,
  // the exact class card 3791b14e's own fix exists to remove. Belongs here (readdirSync, not diff-scoped)
  // specifically because the motivating incident was an entirely UNCOMMITTED new file — a diff-scoped
  // check would have been blind to it until a commit landed; this guard sees it the instant it exists on
  // disk. Verified directly against the real motivating shape (a real, uncommitted file physically added
  // to the test/ directory, not just a synthetic fixture), not merely reasoned about.
  "packages/daemon/test/codex-real-spawn-lock-membership-guard.mjs",
  // Card 69547e0e: a corpus-wide source-text scan forbidding the fragile message-text regex idiom
  // (`/waitUntil: timed out/.test(err?.message ?? "")`) that this card's own migration replaced across
  // all 75 real call sites with the structured `err?.exhaustedOnThrow !== false` check (see `_wait.mjs`'s
  // own doc comment — the source of truth for the canonical form, added by card d5ca8d57). Belongs here
  // on the same ground as its corpus-wide-scan siblings above: a NEW wrapper copied from an older
  // reference/example regenerating the retired idiom is a source-TEXT property the reduced/emit-compare
  // path cannot reason about (it changes zero compiled/runtime behavior on its own), so it could otherwise
  // take the reduced path and never trip a single check.
  "packages/daemon/test/waituntil-message-regex-guard.mjs",
  // Card f103dd2d: a corpus-wide source-text scan asserting every test file that calls the real
  // `createWorktree(` sets a temp LOOM_HOME (`useOwnLoomHome(`/`process.env.LOOM_HOME =`) before its first
  // `../dist/` import, or `requireHermeticEnv()`s before the call — WORKTREES_DIR is a sibling of
  // LOOM_HOME, so a bare run of a file that sets nothing leaks real worktrees into the owner's real
  // `~/.loom-worktrees` (card aac489a2's two files). Belongs here on the same ground as its siblings: a NEW
  // test .mjs reintroducing that changes zero `.ts` source, so neither the transpile-identity path nor any
  // `.ts`-keyed scanner list would ever see it. See the guard's header for why harness-provided-only is NOT
  // a pass, and for its named gaps.
  "packages/daemon/test/createworktree-loom-home-guard.mjs",
  // Card 27383e5a: a corpus-wide AST scan (same shape as its onexit-discard-guard.mjs sibling above)
  // asserting every test-local `class X extends PtyHost` (bare-identifier heritage, never
  // `createSeamHost(PtyHost)`) overrides `reapExitedDescendants` to a no-op, outside a small documented
  // exemption list (see the guard's own header). Without this, a NEW such subclass with a hardcoded
  // fictional pid would reintroduce the exact flaky-lane risk card d634cd2e fixed for the shared fixture
  // — a source-TEXT property (a missing class member) the reduced/emit-compare path cannot reason about,
  // so it could otherwise take the reduced path and never trip a single check.
  "packages/daemon/test/pty-subclass-reap-seam-guard.mjs",
  // Card a06650d2 (delta-review fix round 2 on the 3de74275 decision record): a corpus-wide, comment-
  // stripped scan asserting the ONLY two literal `humanAuthorized: true` grants anywhere in
  // packages/daemon/src are the two bearer-guarded human-only REST routes in gateway/server.ts (the
  // createAgentCore/cloneAgentCore/applyWorkflowTemplate field-check opt-out) — a new 3rd grant site would
  // silently widen the bypass with no agent-facing symptom to notice it by. Belongs here on the same
  // ground as its corpus-wide-scan siblings above: a source-TEXT property (which call sites pass this
  // literal) the reduced/emit-compare path cannot reason about, so a new grant site could otherwise take
  // the reduced path and never trip a single check.
  "packages/daemon/test/human-authorized-call-site-allowlist-guard.mjs",
  // Card acd3c688: the sibling corpus-wide, comment-stripped scan for a DIFFERENT bypass flag
  // (`spawnHumanAuthorized: true`, deliberately a different name from the mechanism above — see the
  // decision record) — asserting the ONLY six literal grants anywhere in packages/daemon/src are the
  // six explicit-role start* calls in gateway/server.ts's POST /api/agents/:id/sessions route. Same
  // ground as its sibling immediately above: a new grant site would silently widen the bypass with no
  // agent-facing symptom, and this is a source-TEXT property the reduced/emit-compare path cannot reason
  // about.
  "packages/daemon/test/explicit-role-grant-carryover-allowlist-guard.mjs",
  // Card 37310431 (round 2): round 1's LOOM_HOME write-deny unioned the static registry with a live
  // `readdirSync` pass, so any new LOOM_HOME-rooted path was automatically caught; round 2 drops that
  // pass (it broke the Platform/Setup homes' own legitimate LOOM_HOME-rooted note writes), so a NEW
  // `path.join(LOOM_HOME, …)` call site now reaches neither the deny nor any acknowledgement unless this
  // guard catches it. Belongs here on the same ground as `profile-field-consumer-guard.mjs` above: a
  // source-TEXT scan cross-referenced against compiled registry DATA, changing zero behavior the
  // reduced/emit-compare path can reason about on its own, so a NEW unregistered call site could
  // otherwise take the reduced path and never trip a single check.
  "packages/daemon/test/loom-home-write-deny-registry-guard.mjs",
  // Card 5df4e7d1 (from 3b4e2bbe): a corpus-wide readdirSync scan of packages/daemon/test/*.mjs asserting
  // no file binds a hermetic port by passing hermeticPort()'s raw return into .listen() (the WinNAT/
  // Hyper-V-reserved-range EACCES shape that redded b801bad0's 52-minute full gate) without ALSO importing
  // one of the two sanctioned helpers (reserveHermeticPort()/listenHermetic()). Belongs here on the same
  // ground as its corpus-wide-scan siblings above: a NEW test file reintroducing the raw bind is a
  // source-TEXT property the reduced/emit-compare path cannot reason about (zero compiled/runtime-behavior
  // change for a .mjs test file, which has no compile step at all), so it could otherwise take the reduced
  // path and never trip a single check.
  "packages/daemon/test/hermetic-port-listen-guard.mjs",
  // Card 5df4e7d1 (from a6b1c4c7): a corpus-wide readdirSync scan of packages/daemon/test/*.mjs (a 35-site
  // baseline) asserting no NEW `path.join(os.tmpdir(), <fully fixed literal>)` fixture ships — the same
  // concurrent-collision shape that bit merge-commit-kill-confirm.mjs's makeRepo/makeWorktree. Same ground
  // as clock-path-regression-guard.mjs immediately above (and hermetic-port-listen-guard.mjs just added):
  // a NEW test file reintroducing a fixed-literal tmp path is a source-TEXT property the reduced/
  // emit-compare path cannot reason about, so it could otherwise take the reduced path and never trip a
  // single check.
  "packages/daemon/test/fixed-tmpdir-literal-guard.mjs",
  // Card 2365cc22: a corpus-wide scan of packages/daemon/test/*.mjs asserting every real
  // `spawn(process.execPath, [...])` of the real `dist/index.js` daemon also sets
  // `LOOM_SUPPRESS_FIRST_RUN_LAUNCH` in that same spawn's env — without it, a fresh LOOM_HOME with zero
  // ordinary projects (true for every one of these tests at boot, before it seeds its own first project)
  // unconditionally fires the real Setup Assistant first-run auto-launch (setup/first-run.ts), spawning a
  // genuine claude.exe. MEASURED LIVE against board-consistency.mjs before this fix: a real claude.exe
  // (role "setup") spawned and lived ~29s during an ordinary run, invisible to that test's own
  // assertions. Belongs here on the same ground as its corpus-wide-scan siblings above: a NEW test file
  // that spawns the real daemon without this flag is a source-TEXT property the reduced/emit-compare path
  // cannot reason about (a .mjs test file has no compile step, and the daemon-side behavior it risks
  // triggering — a real session spawn — has no compiled-output signature the transpile-identity check
  // could ever see), so it could otherwise take the reduced path and never trip a single check.
  "packages/daemon/test/first-run-suppress-guard.mjs",
  // Card 500fe2df: a corpus-wide scan of packages/daemon/test/*.mjs asserting every test that raises a
  // REAL `enterMergeQuarantine(` (directly, or indirectly via a `mergeBranch(...)` call carrying its own
  // `timeoutMs`, which can raise one internally on an unconfirmed kill) sets a temp LOOM_HOME before the
  // dist import, or `requireHermeticEnv()`s before the call — same chokepoint
  // `createworktree-loom-home-guard.mjs` already polices for `WORKTREES_DIR`, but for
  // `MERGE_QUARANTINE_DIR` instead. Without this entry, a real boot found 13+ stale latch files re-armed
  // from temp test repos (`loom-mhdwq-*`, among others) — six test files were leaking this way, none of
  // which touch `createWorktree(` at all, so the existing guard above never saw them. Belongs here on the
  // same ground as its corpus-wide-scan siblings: a NEW test file reintroducing this shape is a
  // source-TEXT property the reduced/emit-compare path cannot reason about (a .mjs test file has no
  // compile step), so it could otherwise take the reduced path and never trip a single check.
  "packages/daemon/test/merge-quarantine-loom-home-guard.mjs",
  // Card fd189d91, item (c): a corpus-wide scan of packages/daemon/src/**/*.ts asserting no production
  // file imports any export whose name ends in `TestOnly` — a test-only injection seam (e.g.
  // reenterMergeQuarantinesAtBootTestOnly) is only "structurally unreachable from production" as long as
  // nothing imports it; this was previously an unchecked claim. Belongs here on the same ground as
  // harness-adapter-claude-literal-guard.mjs above: a source-TEXT property neither the reduced gate nor
  // the emit-compare transpile-identity check can see.
  "packages/daemon/test/no-src-testonly-import-guard.mjs",
  // Card 849acf9b: a corpus-wide, comment-stripped scan of packages/daemon/test/*.mjs asserting every test
  // that reaches the REAL `ensureTrusted`/`ensureTrustedResilient` (pty/claude-config.ts) — a direct call,
  // or a real (unsubclassed/super-delegating) `PtyHost.createPty()` via the `LOOM_CLAUDE_BIN` real-process-
  // substitution technique — redirects `CLAUDE_CONFIG_DIR` (or `HOME`+`USERPROFILE`) BEFORE that call, so it
  // can never reach the owner's real `~/.claude.json`. Same ground as `createworktree-loom-home-guard.mjs`/
  // `merge-quarantine-loom-home-guard.mjs` above: a NEW test file reintroducing this shape is a source-TEXT
  // property neither the reduced gate nor the emit-compare transpile-identity check can see. Exempts
  // `scripts/test-daemon.mjs`'s own `NOT_HERMETIC` set — see the guard's own header for why those files are
  // a documented, different (surgically self-cleaning, manual-only) case.
  "packages/daemon/test/ensure-trusted-config-dir-redirect-guard.mjs",
  // Card b8122303: a corpus-wide, comment-stripped scan of packages/daemon/src/**/*.ts asserting no
  // expression reading a trailer-derived value (`trailers.base`/`trailers.landedTip`/`trailers.pathSet`/
  // `.baseSha`) reaches a git argv anywhere except a named, allowlisted site — see the guard's own header
  // and docs/decisions/b8122303-*.md.
  // @decision 4b559feb — kept as a reviewer-chosen OVER-INCLUSION on the trust-boundary ground (never
  // weakens the reduced gate; runs in ~1s) — never "owner-directed" (no owner request verified).
  "packages/daemon/test/trailer-derived-value-git-argv-guard.mjs",
];

/** The test files that actually read REAL, checked-in content under `packages/daemon/assets/**` — run
 *  {@link buildReducedGateCommand} whenever the diff touches that tree (card 3fbd95e0). Distinct from
 *  {@link STATIC_GUARD_REPO_PATHS} above in ONE way: those always run, on every reduced gate, regardless of
 *  diff shape; this list only needs to run when `packages/daemon/assets/**` is actually in the diff — same
 *  conditional-inclusion shape {@link EmitCompareGateResult.changedTestFiles} already has for a changed test
 *  file, not the unconditional one.
 *
 *  MEMBERSHIP CRITERION — a test belongs here only if it reads REAL, checked-in content from THIS repo's own
 *  `packages/daemon/assets/**` tree such that editing that tree can change what the test observes or asserts.
 *  That happens through TWO distinct routes, and a deriver must check BOTH, not just the first:
 *    (1) a DIRECT read — a `__dirname`/`process.cwd()`-derived path into the tree, or an import of a
 *        `paths.ts` constant that resolves there (e.g. `VAULT_LINT_SCRIPT`);
 *    (2) an INDIRECT read THROUGH A SEED/STORE FUNCTION — the test calls `seedGlobalSkills()` (or another
 *        function with the same shape) with `LOOM_ASSET_SKILLS` UNSET, so `skills/seed.ts`'s own
 *        `process.env.LOOM_ASSET_SKILLS || path.join(__dirname, "..", "..", "assets", "skills")` resolves to
 *        the real tree — the asset read sits on the FAR SIDE of the seed call, so the test's own source
 *        carries no path token naming `assets/` anywhere near it (`platform-home.mjs`/
 *        `skills-store-durability.mjs` are exactly this shape — card 3fbd95e0, Code Review finding: an
 *        earlier derivation pass, scoped to route (1) alone, missed both). The mechanical question for route
 *        (2), stated so a future deriver can ASK it rather than grep for a token that may not exist near the
 *        read: "does this test call a seed/store function that reads the asset dir, with `LOOM_ASSET_SKILLS`
 *        unset?" — `skills-seed-asset-override.mjs`/`skills-seed-asset-override-default.mjs`'s own
 *        `LOOM_ASSET_SKILLS` overrides are the control that makes this discriminate at all: a test setting it
 *        redirects `seedGlobalSkills()` to a SYNTHETIC dir and is excluded by the SAME question, not by a
 *        separate rule.
 *  ⛔ NOT a test that merely uses a SYNTHETIC fixture directory also named `assets` or `assets/skills` (a temp
 *  dir under `os.tmpdir()`, or a throwaway git-fixture worktree built by the test itself) — that shape's
 *  outcome depends on the `.ts` SOURCE CODE implementing the classification/seeding logic under test, not on
 *  real asset CONTENT, so a real `assets/**` diff (no `.ts` change) cannot move it. `codescape-privacy-guard.mjs`
 *  — the one file that DOES read real assets AND already sits in {@link STATIC_GUARD_REPO_PATHS} (it always
 *  runs) — is deliberately OMITTED here rather than duplicated; see that array's own membership doc for why a
 *  `.ts`-edit-only invalidator gets no seat on a conditional list. `working-tree-eol-guard.mjs` is the
 *  identical case (also always-run, also omitted here).
 *
 *  ⚠️ THE BUILD-MIRROR INDIRECTION, HISTORICAL — name it, don't re-derive a stale version of it: until card
 *  `bce50c22`, `spawn-command-line-preflight.mjs` and `kickoff-real-spawn.mjs` read `.claude/skills/worker/
 *  SKILL.md`, a BUILD-TIME (not diff-time) mirror `scripts/sync-claude-skills.mjs` regenerates from
 *  `assets/skills/**` — an assets-only diff with no rebuild in between left that mirror still showing the
 *  OLD content, so neither test was actually sensitive to the diff at classification time, and this list
 *  deliberately excluded both (see the superseded "Do not" bullet on card 3fbd95e0's own record, below).
 *  Card `bce50c22` removed that indirection: both tests now `readFileSync` `assets/skills/worker/SKILL.md`
 *  DIRECTLY (the canonical, tracked source — see each file's own comment at its `workerSkill` read), for
 *  the same reason every other member below is here — the real asset's bytes flow straight into what the
 *  test asserts, no rebuild required. So both are now INCLUDED, by the ordinary direct-read criterion, not
 *  as an exception to it.
 *
 *  @decision 3fbd95e0 — DERIVED BY HAND, ONCE (DoD-3), never by a glob — same posture {@link
 *  STATIC_GUARD_REPO_PATHS} documents:
 *
 *  a naive `grep -rl "assets/skills" packages/daemon/test/` both
 *  UNDER-shoots (misses indirect/differently-spelled real readers) AND OVER-shoots (wrongly includes
 *  synthetic-fixture tests shaped like the real tree).
 *
 *  `packages/daemon/test/_emit-compare-fixtures.mjs`'s `ASSET_TEST_BASENAMES` (consumed by the emit-compare
 *  gate tests to assert each of these actually appears in a reduced gate command built for an assets-only
 *  diff) is DERIVED from this list at test-load time, not hand-copied — same reuse discipline
 *  `GUARD_BASENAMES` already established for {@link STATIC_GUARD_REPO_PATHS}, so an addition or removal here
 *  needs no matching edit there.
 */
export const ASSET_READING_TEST_REPO_PATHS = [
  // Card 61d0c029: a corpus-wide readdirSync scan of the top-level packages/daemon/assets/*.mjs files
  // asserting none spawns git via a literal bare "git" command (the sibling of
  // canonical-git-helper-guard.mjs's check (3), which scans src/**/*.ts only and structurally cannot see
  // this tree). Direct reader (route (1)): editing ANY file in that directory can flip what it finds.
  "packages/daemon/test/assets-git-literal-guard.mjs",
  "packages/daemon/test/codescape-prompt-block.mjs",
  "packages/daemon/test/decision-records.mjs",
  "packages/daemon/test/dev-server.mjs",
  "packages/daemon/test/ensure-obsidian.mjs",
  // Card 61d0c029: asserts packages/daemon/assets/git-resolve.mjs (the standalone win32 absolute-git-path
  // resolver the two shipped session hooks import) stays behaviorally identical to its dist/git/bounded.js
  // counterpart. Direct reader (route (1)): editing git-resolve.mjs changes what this test asserts.
  "packages/daemon/test/git-resolve-assets-parity.mjs",
  "packages/daemon/test/kickoff-real-spawn.mjs",
  "packages/daemon/test/manager-context-block.mjs",
  "packages/daemon/test/merge-orphaned-to-main.mjs",
  "packages/daemon/test/platform-dev-flag.mjs",
  "packages/daemon/test/platform-home.mjs",
  "packages/daemon/test/redirect-discoverability.mjs",
  "packages/daemon/test/role-surface-tools-named-in-doctrine.mjs",
  "packages/daemon/test/serve-static.mjs",
  "packages/daemon/test/serve-static-parity-guard.mjs",
  "packages/daemon/test/skills-codescape-reconcile.mjs",
  "packages/daemon/test/skills-conditional.mjs",
  "packages/daemon/test/skills-seed-asset-override-default.mjs",
  "packages/daemon/test/skills-store-durability.mjs",
  "packages/daemon/test/spawn-command-line-preflight.mjs",
  "packages/daemon/test/vault-lint.mjs",
];

/** The test files that raw-scan real, uncompiled `packages/daemon/src/**` TEXT and/or compiled `dist/**`
 *  TEXT (not merely import either as a module) and pattern-match that content — run by
 *  {@link buildReducedGateCommand} whenever the diff contains a changed compiled `.ts` file (card
 *  `abaaf16e`; widened to cover `src/**` readers, not just `dist/**` ones, by card `fab07aba` — see
 *  docs/decisions/fab07aba-src-text-scanners-share-the-dist-text-scanners-trigger.md for why this is ONE
 *  widened list rather than a third one: both populations are unrun-but-reachable on the IDENTICAL trigger
 *  `computeEmitCompareGate` already computes — `changedTsPaths.length > 0` — so a separate list would
 *  duplicate that condition for no benefit). Modelled on {@link ASSET_READING_TEST_REPO_PATHS} immediately
 *  above: same conditional-inclusion shape (unlike {@link STATIC_GUARD_REPO_PATHS}, which always runs
 *  regardless of diff shape), a SEPARATE list rather than folded into either sibling because it answers a
 *  DIFFERENT question — not "does this diff touch `packages/daemon/assets/**`" but "does this diff touch a
 *  compiled `.ts` file at all", the one case {@link computeEmitCompareGate}'s own transpile-comparison
 *  reduces the gate on. Run via bare `node <path>` (the {@link STATIC_GUARD_REPO_PATHS} shape), never
 *  through the `test:daemon --only=` harness (the {@link ASSET_READING_TEST_REPO_PATHS} shape) — every
 *  member below is independently verified to set up its OWN hermetic `LOOM_HOME`/temp-dir env (or needs
 *  none — several members are pure fs/regex, no daemon/DB at all) (see each file's own header), so none of
 *  them needs the harness wrapper's fresh env the way an arbitrary changed test file might.
 *
 *  @decision dd4349ff
 *
 *  WHY THIS LIST EXISTS: `computeEmitCompareGate` proves a changed `.ts` file's COMPILED BEHAVIOR unchanged
 *  by transpiling with `removeComments:true` forced and, when identical, skips the
 *  ~668-test runtime suite.
 *
 *  @decision 2154b6ad
 *
 *  That proof is sound for ordinary runtime behavior — but a HANDFUL of runtime
 *  tests don't exercise compiled behavior at all; they `fs.readFileSync` real `dist/**` output OR the
 *  real, pre-compile `src/**` `.ts` source it was compiled FROM, and pattern-match that TEXT. Neither tsc's
 *  real `dist/**` emit nor the `src/**` file on disk ever has comments stripped (no `removeComments`
 *  anywhere in this repo's own tsconfig chain — only the isolated proof-comparison above forces it). For a
 *  member of THIS list, a comment-only diff that happens to introduce (or remove) matching text can flip
 *  the test's own verdict even though the reduced-gate's transpile-comparison correctly proved the diff
 *  behaviorally inert — exactly the gap that let one such test (`agent-runs-keys.mjs`'s "G3") sail through
 *  a reduced gate on a comment-only diff and only fail a later, UNRELATED full gate, misattributed to
 *  whoever merged then. A `src/**` reader has the identical failure shape as a `dist/**` reader — it reads
 *  a `.ts` FILE the diff can touch directly, one step further upstream of the same comment-preserving
 *  compile than a `dist/**` reader is.
 *
 *  MEMBERSHIP CRITERION — a test belongs here only if it does a RAW, UNSTRIPPED whole-file (or
 *  large-region) text scan of real `packages/daemon/src/**` `.ts` source and/or compiled `dist/**` output,
 *  where a comment anywhere in the scanned region can change what the scan matches. THIS IS A JUDGEMENT
 *  CALL, not a grep-derivable property — no single literal search finds every member (or excludes every
 *  non-member): the card `abaaf16e` sweep that built the original `dist/**` half of this list found
 *  `agent-runs-keys.mjs`'s G3 check missing from the naive `grep -l "readFileSync(.*dist"
 *  packages/daemon/test/*.mjs` (the read's `dist` path segment is built on an EARLIER line than the
 *  `readFileSync(` call, so the two never share a line), while a broader `readFileSync|readdirSync` + `dist`
 *  sweep over-shot into ~180 files dominated by ordinary `await import("../dist/...")` module loading
 *  (irrelevant: importing EXECUTES code, so comments never reach the parser either way, unlike a text
 *  scan). Card `fab07aba`'s own sweep for the `src/**` half found the identical pattern one level up: a
 *  `"..", "src"`/`../src/` grep both missed real readers built through an intermediate path variable and
 *  wrongly flagged files that merely construct a SYNTHETIC fixture directory happening to be named `src`
 *  (the same "synthetic fixture ≠ real content" trap {@link ASSET_READING_TEST_REPO_PATHS}'s own doc
 *  already names for `assets/**`) — see docs/decisions/abaaf16e-dist-text-scanner-list-derived-by-hand-not-by-grep.md
 *  and docs/decisions/fab07aba-src-text-scanners-share-the-dist-text-scanners-trigger.md for the full sweep
 *  methodology and the shapes deliberately excluded below (that list is a judgment call, not exhaustive —
 *  see its own closing note).
 *
 *  @decision fab07aba
 *
 *  ⛔ NOT a test whose src/dist-text read is one of the shapes below — each is comment-immune by
 *  construction, so a comment-only diff cannot flip it:
 *    (1) a BOUNDED, NAMED-DECLARATION extraction whose captured content is DATA, never comment syntax —
 *        e.g. `task-deferred-items-migration.mjs`/`task-deferred-until-event-migration.mjs`/
 *        `task-manual-deferral-migration.mjs`, which each extract only the `` const SCHEMA = `...`; ``
 *        template-literal BODY via a bounded regex. A template literal's string content is never comment
 *        syntax, so tsc's `removeComments` cannot touch it regardless of what any comment elsewhere in the
 *        file says. Same immunity, different shape — `anchor-re-parity.mjs` (real `src/**` reader; card
 *        `fab07aba` Code Review) matches `/^const ANCHOR_RE = (.+);\s*$/m`: `^`/`m`-ANCHORED to a line
 *        starting with the bare keyword `const`, which no comment in this codebase's `//`/`/** ` convention
 *        ever does — so a comment can neither introduce a false match nor reposition which line the real
 *        one resolves to. NOT added to this list for exactly that reason.
 *    (2) a TS-COMPILER AST-NARROWED function/method-body extraction, where the anchor is a real DECLARED
 *        NAME (found via the TypeScript compiler's own parser, not a text search) and the text check runs
 *        only against that one extracted region — e.g. `codescape-spawn-repopath-guard.mjs`,
 *        `loopback-write-guard.mjs` (§G), `task-version-guard.mjs` (§5), `project-memory-version-guard.mjs`,
 *        and — reading real `src/**` this time, not `dist/**` — `boot-listen-not-blocked.mjs` and
 *        `gate-verdict-field-classification-exhaustive.mjs`, both of which call `ts.createSourceFile` and
 *        walk the real parsed AST rather than matching raw text (card `fab07aba`).
 *        `loopback-write-guard.mjs`'s own inline comment documents it was BURNED by comment-anchoring once
 *        (a heading comment relocated by an unrelated extraction pass silently zeroed its anchor) and was
 *        deliberately re-anchored on a real code token to fix it — precedent that this shape is the
 *        intentionally-hardened one. Residual risk is only an interior comment INSIDE that one extracted
 *        function/method matching the check's own pattern — several orders narrower than a whole-file scan,
 *        and out of scope for card `abaaf16e`.
 *    (3) an EXPLICIT comment-stripped whole-file scan — `codescape-supervisor-shutdown-wiring.mjs` calls its
 *        own local `stripComments()` (with its own sanity check that the stripper actually strips) before
 *        every assertion, documented as sharing that per-line discipline with `exit-code-verdict-guard.mjs`/
 *        `harness-adapter-claude-literal-guard.mjs` — both already unconditional members of
 *        {@link STATIC_GUARD_REPO_PATHS} above. Already immune by construction; adding it here would be
 *        redundant with running it on every reduced gate anyway.
 *    (4) a PRESENCE-ONLY assertion of a real code token — `loopback-secret.mjs` (D) asserts
 *        `/timingSafeEqual\(/.test(src)` against compiled `dist/gateway/loopback-secret.js`. ⚠️ CORRECTED
 *        (card `f862f9c5`, Code Review): this entry previously claimed a single-token regex like this one
 *        "has no internal position for a comment to land" — MEASURED FALSE. `ts.transpileModule` shows real
 *        tsc emit REPRINTS from the parsed AST rather than preserving source bytes verbatim: a WHITESPACE-only
 *        source edit (e.g. a bare newline before the `(`) does NOT survive into the emitted output (both
 *        before/after reprint to the identical text), but a COMMENT DOES survive — tsc keeps comment trivia
 *        attached to its nearest node — so `timingSafeEqual /* c *\/(a, b)` emits with the comment intact and
 *        breaks this exact regex. `loopback-secret.mjs` (D) was therefore a KNOWN, PRE-EXISTING fail-open
 *        vector for an inline-comment diff specifically (not a whitespace-only one) — do not cite this
 *        entry as proof the check is immune. ✅ FIXED by card `f5ea0cdb`: `loopback-secret.mjs` is now a
 *        genuine MEMBER of {@link CHANGED_TS_TEXT_SCANNER_REPO_PATHS} below (next to `gateway-token.mjs`,
 *        the structurally identical sibling check it was already missing alongside), not an exclusion —
 *        do not remove it on a future re-assertion of the "single-token is immune" argument.
 *        ⚠️ `test-daemon-codex-real-spawn-preset.mjs`'s own `scripts/test-daemon.mjs` check
 *        (`scriptSource.includes("resolveSelectionForCliMode(HERMETIC, cliMode, CODEX_REAL_SPAWN_BASENAMES)")`)
 *        was PREVIOUSLY documented here as "the same shape one level up" and therefore ALSO immune —
 *        MEASURED FALSE for a further, independent reason: a `.mjs` script has no compile/emit step at all,
 *        so the raw scanner reads the committed file's bytes directly, with no AST-reprint to normalize
 *        whitespace away the way real tsc emit does for `dist/**`. BOTH a comment AND a plain whitespace-only
 *        edit (an added newline, altered spacing) survive unchanged into what this scanner reads — confirmed
 *        directly against `gate-runner-harness-marker-coupling.mjs`'s own needle locator, where a bare newline
 *        inserted right after its `callPrefix` (no comment at all) already makes `.find()` miss the line. This
 *        file is therefore a genuine member of {@link CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS} below, not an
 *        exclusion — see that list's own doc.
 *    (5) a BYTE-LEVEL / non-textual property — `no-nul-in-tracked-ts.mjs` scans every tracked `.ts` file for
 *        embedded NUL bytes. An ordinary comment edit (added, moved, or deleted prose) can never introduce
 *        or remove a NUL byte, so this is immune by the KIND of property it checks, not by where it looks
 *        or how it's bounded — orthogonal to (1)-(4). Added by card `fab07aba`.
 *    (6) a precondition ALREADY RE-VERIFIED LIVE by `computeEmitCompareGate` itself on every reduced-path
 *        call — `emit-compare-soundness-guard.mjs` (A) walks `packages/daemon/src/**` `.ts` files for a
 *        `const enum` declaration, but `emitCompareSoundnessOk` (`../emit-compare-soundness.ts`, called
 *        fail-closed inside `computeEmitCompareGate` whenever `changedTsFiles.length > 0`) runs the
 *        IDENTICAL walk+regex against the worktree's OWN current tree before ever returning `eligible:true`.
 *        A comment-only diff that introduced `const-enum`-shaped text anywhere under `src/**` would already
 *        flip THAT live check to `notReducible`, forcing the full gate — so this test's own correctness can
 *        only be broken by editing `emit-compare-soundness.ts` or `worktrees.ts` itself, already excluded
 *        on the SAME "that's a behavioural `.ts`
 *        edit" ground {@link STATIC_GUARD_REPO_PATHS}'s own doc gives for this exact file, one list over.
 *        Its (B) positive-control section is separately immune under shape (4) (a presence-only check on a
 *        real declaration name). Added by card `fab07aba`. ⚠️ This shape-(6) immunity covers ONLY (A)/(E)'s
 *        const-enum walk — card `8abf427f` gave this SAME file a genuine, non-immune seat below for an
 *        unrelated read its (G)/(H) sections added (the real scope CONSTANTS, not the const-enum walk);
 *        do not read this file's presence in the list below as contradicting the immunity argument here.
 *  This is a judgment call, not a closed taxonomy — see the record's own closing note before assuming a
 *  new candidate's absence from these six proves it belongs on THIS list instead.
 *  card `abaaf16e`'s own report names option (b) — teaching the raw scanners below to strip comments the
 *  same way (3) already does — as legitimate COMPLEMENTARY hardening (card `36afbbdd`), NOT a substitute
 *  for this list: {@link buildReducedGateCommand} folding this list in is what makes a comment-only diff
 *  that introduces matching text get CAUGHT AT THE REDUCED GATE, correctly blaming the introducing commit
 *  — the blame-routing defect this card closes. Comment-stripping would remove the false-positive risk
 *  these scanners carry (a real, separate improvement worth doing), but wouldn't by itself fix WHERE a
 *  real hit gets reported, so it doesn't replace this list.
 *
 *  ✅ FIXED by card `f862f9c5` (was a known, deliberately deferred gap under card `fab07aba` DoD-1's other
 *  half): `packages/daemon/scripts/**` readers on the `changedScriptFiles.length > 0` trigger — a DIFFERENT
 *  trigger than this list's own `changedTsPaths.length > 0` (folding a `scripts/**` reader into THIS list
 *  would be wrong both ways: it would run on any `.ts` change that never touched `scripts/**`, and still
 *  miss the actual case — a `scripts/**`-only diff — such a reader needs it for) — now have their own list,
 *  {@link CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS}, folded into `buildReducedGateCommand` on that trigger.
 *  See that list's own doc for the sweep that re-derived its membership (including the correction to this
 *  list's own shape-(4) entry above) and docs/decisions/fab07aba-src-text-scanners-share-the-dist-text-scanners-trigger.md
 *  for the original deferral's reasoning.
 *
 *  `packages/daemon/test/_emit-compare-fixtures.mjs`'s `CHANGED_TS_SCANNER_BASENAMES` is DERIVED from this
 *  list at test-load time, not hand-copied — same reuse discipline `GUARD_BASENAMES`/`ASSET_TEST_BASENAMES`
 *  already establish, so an addition or removal here needs no matching edit there.
 */
export const CHANGED_TS_TEXT_SCANNER_REPO_PATHS = [
  "packages/daemon/test/agent-runs-keys.mjs",
  "packages/daemon/test/event-trigger-mcp-absence.mjs",
  "packages/daemon/test/gateway-token.mjs",
  // Card f5ea0cdb: (D) raw-scans compiled dist/gateway/loopback-secret.js for /timingSafeEqual\(/ — the
  // SAME presence-only shape as gateway-token.mjs immediately above; was wrongly excluded on the
  // now-corrected "single-token regex is immune" argument (see shape-(4) above).
  "packages/daemon/test/loopback-secret.mjs",
  "packages/daemon/test/update-endpoint.mjs",
  "packages/daemon/test/shutdown-snapshot.mjs",
  "packages/daemon/test/periodic-snapshot.mjs",
  "packages/daemon/test/git-log-locale-pin.mjs",
  "packages/daemon/test/graceful-shutdown-epipe-resilience.mjs",
  // Card 3fba0cd2: (wiring section) reads real dist/index.js SOURCE and does a raw, unstripped
  // indexOf("installCrashHandlers();") / indexOf("installEpipeTolerantStdio(") to assert call order — tsc
  // keeps comments, so a comment-only edit to index.ts containing "installCrashHandlers();" above the real
  // installEpipeTolerantStdio() call would flip this. Same shape as its sibling immediately above.
  "packages/daemon/test/epipe-tolerant-stdio.mjs",
  // Card 5b97da80 round 3 (Code Review f82607a6): (E) raw-reads real src/pty/host.ts SOURCE and does an
  // unstripped indexOf("protected createPty(opts: SpawnOpts")-then-windowed-includes("this.ensureTrustedAndReportDegrade(")
  // check, proving createPty itself still calls that extracted method (the rest of the file tests the
  // method directly, bypassing createPty, and can't see this wiring on its own). Same raw-scan shape as
  // its siblings above — a comment-only edit near that call site could defeat it.
  "packages/daemon/test/trust-lock-incarnation-guard.mjs",
  // Card 9c8ce2b2: extractMaxGenerations() raw-scans real packages/daemon/src/crashlog.ts SOURCE for
  // /CRASHLOG_MAX_GENERATIONS\s*=\s*(\d+)/ — an unanchored, whole-file `.match()` (not `^`/`m`-anchored to
  // a bare `const` line the way anchor-re-parity.mjs's immune shape is). MEASURED: inserting a plausible
  // comment-only historical note ("// historically this was CRASHLOG_MAX_GENERATIONS = 3…") immediately
  // above the real declaration flips the extracted value from 5 to 3. The file's OTHER check (the
  // rotateCrashlog() body comparison) is comment-stripped internally and immune on its own, but the
  // file's overall verdict is not, so the whole file belongs here.
  "packages/daemon/test/crashlog-supervisor-rotation-parity.mjs",
  // Card 175a7eb2: extractFunctionBody() raw-scans real crashlog.ts SOURCE for
  // "function installEpipeTolerantStdio(...) {" and its body text (comment-stripped internally, but the
  // function-start regex and the presence of the function itself are not) — same drift-guard shape as
  // crashlog-supervisor-rotation-parity.mjs immediately above, comparing against a local duplicate in
  // scripts/lib/epipe-tolerant-stdio.mjs. A comment-only edit ABOVE the real declaration (this file's own
  // crashlog-supervisor-rotation-parity.mjs precedent showed exactly this shape flips an unanchored
  // `.match()`) is the reduced-gate hole this registration exists to close.
  "packages/daemon/test/epipe-tolerant-stdio-supervisor-parity.mjs",
  "packages/daemon/test/project-memory.mjs",
  "packages/daemon/test/session-archive.mjs",
  // card fab07aba — real packages/daemon/src/**/*.ts readers, same trigger as the dist/** readers above.
  "packages/daemon/test/companion-lead-mode.mjs",
  "packages/daemon/test/decisions-for-tool.mjs",
  "packages/daemon/test/emit-compare-branch-capture-order-guard.mjs",
  // Card 18bfe989: (A)/(B) raw-scan real emit-compare-soundness.ts SOURCE (never dist/**, which has no
  // types once compiled) for the ScriptTarget/target type narrowing — a presence-only real-code-token
  // match, same shape as gateway-token.mjs/loopback-secret.mjs above, immune to no comment shape.
  "packages/daemon/test/emit-compare-transpile-target-narrowing.mjs",
  "packages/daemon/test/gate-intent-no-firing-coupling.mjs",
  "packages/daemon/test/give-up-exhausted-durable.mjs",
  "packages/daemon/test/inert-skip-branch-capture-order-guard.mjs",
  "packages/daemon/test/log-message-content-gate.mjs",
  "packages/daemon/test/operator-surface.mjs",
  "packages/daemon/test/orchestration-mcp-role-guard.mjs",
  "packages/daemon/test/pty-codex-agnostic-methods.mjs",
  "packages/daemon/test/redelivery-parked-notice-suppression.mjs",
  "packages/daemon/test/redirect-discoverability.mjs",
  // Card f349f5cb: reads real packages/daemon/src/index.ts SOURCE directly (never dist/**, so shape-(4)'s
  // tsc-emit-reprint reasoning does not apply here) and asserts, by comment-stripped substring search,
  // that the onExit hook wires reconcileNeverStartedRecycleSuccessor(exited.id, info.intended) after
  // archiveOnExit(exited) — a literal call-text/ordering match with no other check re-verifying it.
  "packages/daemon/test/recycle-successor-onexit-wiring.mjs",
  "packages/daemon/test/setup-project-init-rest.mjs",
  "packages/daemon/test/setup-templates-rest.mjs",
  "packages/daemon/test/shell-terminal.mjs",
  "packages/daemon/test/skill-edit.mjs",
  // Card bafc68e7 (Code Review correction, same day — an earlier version of this guard wrongly claimed
  // exclusion): its `function <name>(` declaration regex is a presence-only real-code-token match — but
  // MEASURED, `function walkTsFiles(x)` vs `function walkTsFiles/* c */(x)` transpile IDENTICALLY under
  // `removeComments:true` while the guard's own (now-hardened, but not proven immune) regex is the exact
  // shape-(4) hazard `loopback-secret.mjs`/`gateway-token.mjs` were added here for.
  "packages/daemon/test/emit-compare-soundness-single-definition-guard.mjs",
  // Card 8abf427f (Code Review F3/F5 on bafc68e7): its (G)/(H) sections read the REAL
  // `WORKTREES_EMIT_COMPARE_SCOPE` (this file) and `DEPLOY_STALENESS_EMIT_COMPARE_SCOPE`
  // (deploy-staleness.ts) object literals as TEXT and pattern-match them — a genuinely NEW read, not one
  // already re-verified live the way (A)/(E)'s const-enum walk is (shape (6) above): nothing in production
  // ever re-derives "does the hand-copied DAEMON_SCOPE/DAEMON_SHARED_SCOPE literal still match the real
  // constant", so there is no live twin to inherit immunity from — the same reasoning
  // emit-compare-soundness-single-definition-guard.mjs's own header already gives for its seat here.
  "packages/daemon/test/emit-compare-soundness-guard.mjs",
  // Card ea5fb00a (Code Review 9f02dee5): (16) raw-scans compiled dist/pty/host.js for the ABSENCE of
  // `const ESC_C0_C1_RE\s*=` (an unanchored .test() over the whole file, not `^`/`m`-anchored the way
  // anchor-re-parity.mjs's immune shape is) — a comment-only edit reintroducing that literal text in prose
  // (e.g. "this file used to define `const ESC_C0_C1_RE = ...` here") would flip it even though nothing
  // behavioral changed; tsc keeps comments in dist/** by default. Its companion presence-check in the same
  // section (matching the `security/control-chars.js` import path, a string-literal token) is immune under
  // shape (1) — comments can't land inside a string literal — but one non-immune check is enough to seat
  // the whole file here, same posture emit-compare-soundness-guard.mjs's own entry above documents.
  "packages/daemon/test/project-memory-control-chars.mjs",
  // Card b966962b: section (1) reads the REAL git/worktrees.ts, git/batch-merge.ts and git/writer.ts
  // SOURCE as text and pattern-matches each `enterMergeQuarantine(...)` call line for the
  // `unconfirmedKillReason(...)` wrapper — a genuinely new read with no live twin to inherit immunity
  // from, same posture emit-compare-soundness-guard.mjs's own entry above documents. tsc keeps comments,
  // so a comment-only edit could in principle land a decoy "enterMergeQuarantine(" + "unconfirmedKillReason("
  // pair in prose above a real bypassing call and mask it — belongs here on the same grounds.
  "packages/daemon/test/quarantine-reason-windows-guidance.mjs",
  // Card 0dc09fab (Code Review c6f36aa7, round 2 item 6): two SEPARATE raw, unstripped reads of the
  // compiled dist/graceful-teardown.js SOURCE — the win32-exit-code-race patch anchor (section E,
  // `withPatchedWin32PsScript`'s regex over `const ps = ...; execFileSync("powershell.exe", ...)`) and the
  // structural check asserting the round-5 gating contract (the PS script's own `exit 1` branches plus the
  // `if (!winCustomExitConfirmed)` gate, and the absence of the superseded `killedWithCustomCode` name) —
  // both genuinely new reads with no live production re-derivation to inherit immunity from, same posture
  // emit-compare-soundness-guard.mjs's own entry above documents. tsc keeps comments, so a comment-only
  // edit near either anchor could in principle shift what the regex matches or what the structural
  // substring search finds.
  "packages/daemon/test/graceful-teardown-hard-exit-backstop.mjs",
  // Card 6b8822d2 (Delta review round 2): its (STRUCTURAL) section reads real sessions/service.ts SOURCE
  // directly (never dist/**) and checks, via a bounded text-gap search, that detectCanonicalStagedDirt/
  // detectCanonicalDirtyOverlap/detectCanonicalUntrackedOverlap's call sites carry no lock-closing
  // sequence between them — a genuinely new read with no live production re-derivation to inherit
  // immunity from, same posture as quarantine-reason-windows-guidance.mjs's entry above. tsc keeps
  // comments in source, so a comment-only edit inserting decoy call-site text between the real calls
  // could in principle shift what the gap search finds.
  "packages/daemon/test/merge-staged-dirt-lock-race.mjs",
  // Card 54434e27: its (6) static guard reads real db.ts SOURCE directly and, per-line, checks that no
  // `CREATE INDEX` line also contains the literal `halted_recycle_pending_for` — a genuinely new read with
  // no live production re-derivation to inherit immunity from, same posture as this list's other entries.
  // tsc is irrelevant here (this reads src/**, never dist/**), but the hazard is the same shape: a
  // comment-only line that happens to combine both tokens (e.g. a stray "// CREATE INDEX ... on
  // halted_recycle_pending_for" note) would land on the SAME line the regex scans and flip the verdict.
  "packages/daemon/test/halted-recycle-pending-schema-migration.mjs",
  // Card 282107e8: its codex-exclusion control raw-reads real pty/host.ts SOURCE directly (never
  // dist/**) and does an unstripped indexOf-bounded region slice (createCodexPty...captureCodexEngineSessionId)
  // then checks that region for the LOOM_PASTED_CONTENT_SYSTEM_PROMPT/--append-system-prompt tokens — a
  // genuinely new read with no live production re-derivation to inherit immunity from, same posture as
  // this list's other entries. A comment-only edit inserting either token's text inside that region (or
  // relocating the region's own anchor comments) could in principle flip the verdict.
  "packages/daemon/test/spawn-args.mjs",
  // Card 4319d6b1: withDistMutation anchors on literal, unstripped lines of compiled dist/git/
  // merge-quarantine.js (via a throwaway copy of its minimal import closure, never the real shared dist —
  // see the file's own db0a9db0-round-3 doc comment) to pin six carry-forward sites, plus two further
  // scenarios ((7)+ in the same family) pinning provenanceTracked's own carry. A comment-only edit to
  // merge-quarantine.ts near any pinned anchor (e.g. relocating one of the db0a9db0 decision-comments
  // this file's own find-text embeds) could shift what withDistMutation's exact-occurrence find matches,
  // same hazard class as this list's other dist-text readers — no live re-derivation elsewhere covers it.
  "packages/daemon/test/merge-quarantine-unknown-provenance.mjs",
  // Card 4319d6b1 sweep: structural pin (s) raw-scans real src/sessions/service.ts and
  // src/orchestration/pending-ops.ts SOURCE, unstripped, for exact literal call-site counts
  // (`rejectNotify("canonical_...")`/`squashRefusedResult({ merged: false`) and a `classifyOutcome`/
  // `NEVER_CACHED_OUTCOMES` presence match — a genuinely new read with no live production re-derivation to
  // inherit immunity from, same posture as merge-staged-dirt-lock-race.mjs's entry above. A comment-only
  // edit near any of these call sites could shift the counted occurrences or the presence match.
  "packages/daemon/test/merge-confirm-squash-refusal-recall.mjs",
  // Card 4319d6b1 sweep: mirrors merge-confirm-squash-refusal-recall.mjs's own structural-pin scenario (s)
  // one entry above — same two real src files, same unstripped presence-match shape, for the
  // reducedGateOnlyFileFailed outcome instead of squashRefused.
  "packages/daemon/test/merge-confirm-reduced-gate-only-file-recall.mjs",
  // Card 4319d6b1 sweep: mirrors merge-confirm-squash-refusal-recall.mjs's own structural-pin scenario (s)
  // again, raw-reading real src/sessions/service.ts for the batch runGate closure's own ReducedGateOnlyFileError
  // handling — one of its own regexes embeds a literal comment ("// Card 92be634e: best-effort cleanup")
  // as part of what it matches, so moving or rewording that comment alone could flip the verdict.
  "packages/daemon/test/batch-merge-reduced-gate-only-file-failure.mjs",
  // Card 043d83d2: raw-reads real src/sessions/service.ts SOURCE, unstripped, for the batch runGate
  // closure's own computeEmitCompareGate call-site text — asserting it passes the pinned assembledTipSha,
  // never the literal "HEAD" (the pre-gate reduced-gate steer this card closes). A comment landing inside
  // the call's own argument list is the same shape hazard as this sweep's other entries above.
  "packages/daemon/test/batch-merge-head-moved-emitcompare-arg-guard.mjs",
  // Card 4319d6b1 sweep (manager ruling): raw-reads real src/git/mainline-watch.ts, src/gateway/server.ts
  // and src/pty/host.ts, but its own local `strip`/`stripL` helpers remove only whole-line `//` comments
  // by deliberate choice (the file's own inline note: a block-comment stripper would mis-pair the `/*`
  // inside the gateway's route glob strings) — so an inline `/* */` comment landing inside one of its
  // matched expressions is NOT stripped and could in principle flip a verdict. Included anyway: the
  // author accepted that residual as a risk to the TEST's own verdict, not as a reason to skip running
  // it on a reduced gate — a seat here only means it also runs when a compiled .ts path changes, which
  // is strictly safer and costs nothing extra on a gate that would otherwise skip it.
  "packages/daemon/test/mainline-watch-boot-reader.mjs",
];

/** @decision f862f9c5 — never fold this list into {@link CHANGED_TS_TEXT_SCANNER_REPO_PATHS} or its
 *  `changedTsPaths` trigger:
 *
 *  this list's trigger is the SEPARATE `changedScriptFiles.length > 0` (a changed
 *  `packages/daemon/scripts/**\/*.mjs` file) — folding it into the `.ts` trigger would run it on unrelated
 *  `.ts` diffs and still miss a `scripts/**`-only one. Never re-derive membership from a script-name grep
 *  alone (83 raw hits, only 2 genuine members) — import/execution of a script is comment-immune, never a
 *  member; only a RAW, UNSTRIPPED text scan a comment can flip qualifies.
 *
 *  `packages/daemon/test/_emit-compare-fixtures.mjs`'s `CHANGED_SCRIPT_SCANNER_BASENAMES` is DERIVED from
 *  this list at test-load time, not hand-copied — same reuse discipline `GUARD_BASENAMES`/
 *  `ASSET_TEST_BASENAMES`/`CHANGED_TS_SCANNER_BASENAMES` already establish, so an addition or removal here
 *  needs no matching edit there.
 */
export const CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS = [
  "packages/daemon/test/gate-runner-harness-marker-coupling.mjs",
  "packages/daemon/test/test-daemon-codex-real-spawn-preset.mjs",
  // Card 5d4765b9: raw-reads real packages/daemon/scripts/test-daemon.mjs SOURCE directly (never dist/**
  // — a .mjs script has no compile/emit step) and walks its STATIC relative imports, transitively through
  // each local sibling, asserting every one is mirrored by writeRealTestDaemonScript's hand-maintained
  // fixture file list (_emit-compare-fixtures.mjs). Belongs here on the SAME `changedScriptFiles` trigger
  // as its two siblings immediately above, both of which already read this exact file: a NEW static
  // import added to test-daemon.mjs (or a scripts/**-rooted sibling it statically imports) with no
  // matching fixture-list entry is a source-TEXT property with zero compiled/runtime-behavior change the
  // reduced/emit-compare path can reason about on its own (this is plain .mjs, not compiled .ts), so it
  // could otherwise take the reduced path and never trip a single check — exactly the op a450e3dd / card
  // fc53ea74 incident class this guard exists to catch.
  "packages/daemon/test/test-daemon-fixture-import-guard.mjs",
  // Card fc53ea74: comment-stripped (same `_strip-comments.mjs` discipline as
  // test-daemon-fixture-import-guard.mjs immediately above) raw-read of real
  // packages/daemon/scripts/test-daemon.mjs SOURCE, asserting `runOne`'s own port-assignment call site is
  // literally `port = await reserveLanePort()` and never the retired `4400 + lane` literal. Same
  // membership ground as its sibling above: a plain `.mjs` script has no compile/emit step for the
  // reduced/emit-compare path to reason about on its own, so a CODE-level change to this exact call site
  // (not merely a comment) has nothing else re-verifying it before a reduced gate could otherwise skip
  // straight past the regression this test exists to catch (Code Review of fc53ea74's own first landing).
  "packages/daemon/test/test-daemon-port-allocation.mjs",
  // Card d5432aff: comment-stripped raw-read of real packages/daemon/scripts/test-daemon.mjs SOURCE,
  // asserting `runOne`'s own per-child `env` object carries the win32-only PSModuleAnalysisCachePath
  // wiring (closes the ~14% of test files that never import test/_guard.mjs, which carries the same
  // var as its own fallback). Same membership ground as its siblings above: a plain `.mjs` script has
  // no compile/emit step for the reduced/emit-compare path to reason about on its own, so a comment-only
  // edit to that env object could in principle flip this presence-only check.
  "packages/daemon/test/ps-module-analysis-cache-cwd-guard.mjs",
];

/** @decision fd0d34da — a coarse, PATH-FREE classification of WHY `notApplicable:true`, safe to leave
 *  unredacted cross-project (unlike the `reason` string it sits beside, which can embed a path). Every
 *  value must name a CATEGORY, never a path/filename/error string — never widen a value to embed one. */
export type EmitCompareNotApplicableKind =
  | "repo-out-of-domain"
  | "path-out-of-scope"
  | "harness-config-unavailable"
  | "typescript-unresolvable"
  | "git-operation-failed"
  | "empty-diff"
  | "unparseable-diff";

/** {@link computeEmitCompareGate}'s verdict. */
export interface EmitCompareGateResult {
  /** `true` ⇒ the caller may run {@link buildReducedGateCommand}'s output in place of the real
   *  `gateCommand` — the ~668-test `test:daemon` runtime suite is PROVABLY unable to change outcome for
   *  this diff. `false` ⇒ run the full gate exactly as today; `reason` names why, for diagnostics only. */
  eligible: boolean;
  /** Repo-root-relative paths of changed, non-helper `test/*.mjs` files to run — populated only when
   *  `eligible`. A changed test file never BLOCKS eligibility on its own; it only ever ADDS itself here.
   *  {@link buildReducedGateCommand} runs every name here THROUGH THE HARNESS (`test:daemon --only=`),
   *  never as a bare `node <path>` — card dd4349ff: a bare invocation can't supply the fresh temp
   *  `LOOM_HOME`/`LOOM_PORT` the harness contract requires, so a file needing that env doesn't merely run
   *  weaker, it doesn't run AT ALL (refuses at 0s, no assertion ever executes) — exactly the shape that
   *  made this field's PRIOR doc claim of "strictly stronger [than the full suite]" false for that class.
   *  Routed through the harness, running the file here really is at least as strong as leaving it unrun
   *  in a full suite pass it would have passed anyway — the guarantee this field now actually delivers.
   *  ⚠️ Card edbf9bd1: despite the NAME, by return time this is the already-WIDENED SELECTED set, not the
   *  literally-changed one — {@link foldInTestImporters} (card 72769424) pushes every transitive importer
   *  of a changed/deleted test file into this SAME array. Kept under its original name (a rename would
   *  ripple across gate_status/gate_history and their consumers); `formatReducedGateWarning` renders its
   *  `.length` as "N selected test file(s)", never "changed", for exactly this reason. */
  changedTestFiles: string[];
  /** Card 17cd1f30: repo-relative paths of changed, non-helper `test/*.mjs` files that were EXCLUDED from
   *  {@link changedTestFiles} because the harness's own `NOT_HERMETIC` set (scripts/test-daemon.mjs) names
   *  them — a legitimate, maintained test that simply can't run through `test:daemon --only=` (needs a
   *  manually-started daemon, a real `claude`, or mutates shared build output). Distinct from a genuinely
   *  not-a-test path (fixtures/census, underscore helper): those fail the WHOLE diff closed above. A
   *  `NOT_HERMETIC` file does NOT block eligibility — it only ever moves itself here instead of into
   *  {@link changedTestFiles} — because the FULL gate never runs it either (`test:daemon` with no `--only`
   *  resolves to the discovered `hermetic` set, which already excludes every `NOT_HERMETIC` name by
   *  construction). Populated only when `eligible`. The caller MUST surface this list by name wherever it
   *  reports the reduced gate's result — a silent drop would gate a branch while quietly verifying nothing
   *  for these files, indistinguishable from a clean run. See {@link buildReducedGateCommand}'s caller in
   *  sessions/service.ts for where this is declared (`emitCompareWarning`). */
  notHermeticExcluded: string[];
  /** Card 8ee4f11e: repo-relative paths of changed paths that were EXCLUDED from classification entirely
   *  because {@link isInertMergePath} (backed by {@link INERT_MERGE_PATH_PREFIXES}, e.g. `docs/**`) already
   *  proved them inert — see the classification loop's own `if (isInertMergePath(p)) continue;` (card
   *  b97f643d). Same shape and same "populated only when `eligible`" discipline as
   *  {@link notHermeticExcluded} above, and the same surfacing obligation applies with MORE force, not
   *  less: `notHermeticExcluded`'s own doc already mandates "The caller MUST surface this list by name
   *  wherever it reports the reduced gate's result — a silent drop would … [be] indistinguishable from a
   *  clean run", and a `NOT_HERMETIC` exclusion is the WEAKER case (the full gate skips those files too,
   *  exactly like an inert path does). The full gate would have skipped these paths too — that's exactly
   *  what "inert" certifies — so this is not a coverage gap the reduction introduces, but it must still
   *  never read as a silent, unaccounted-for drop. See {@link buildReducedGateCommand}'s caller in
   *  sessions/service.ts for where this is declared (`emitCompareWarning`). */
  inertPathsSkipped: string[];
  /** Card 3fbd95e0: repo-relative paths of changed, non-excluded `packages/daemon/assets/**` paths — a
   *  changed asset path never BLOCKS eligibility on its own; it only ever ADDS itself here AND causes
   *  {@link buildReducedGateCommand} to fold {@link ASSET_READING_TEST_REPO_PATHS} into the reduced run
   *  (unconditionally, the same "always run this fixed certified set" posture as the static guards — there
   *  is no per-file identity proof for a markdown/script asset the way there is for a compiled `.ts` file, so
   *  ANY change under this prefix, any status, widens to the whole certified set rather than trying to
   *  predict which of it a given file could affect). Populated only when `eligible`. Diagnostic-only past
   *  that — surfaced by the caller in its own reduced-gate warning, same discipline
   *  {@link notHermeticExcluded}/{@link inertPathsSkipped} above already follow, so a reduced gate never
   *  silently drops accounting for why the certified asset-reading tests ran. */
  changedAssetPaths: string[];
  /** Card `abaaf16e`: repo-relative paths of changed compiled `.ts` files (the SAME population classified
   *  into `changedTsFiles` internally, just surfaced) — populated only when `eligible`. Drives
   *  {@link buildReducedGateCommand}'s conditional fold-in of {@link CHANGED_TS_TEXT_SCANNER_REPO_PATHS}: a
   *  test/docs-only diff (this empty) can never change compiled `dist/**` text, so those tests would only
   *  ever prove what they already proved on a prior run — folding them in unconditionally, the
   *  {@link ASSET_READING_TEST_REPO_PATHS} shape, would be correct but wasteful for the common case where
   *  no `.ts` file changed at all. Deliberately NOT reusing `identicalFileCount` (which also counts changed
   *  `packages/daemon/scripts/**\/*.mjs` files) — a script is never compiled by this repo's tsconfig chain
   *  into `dist/**` the way a `.ts` file is (see `EMIT_COMPARE_SCRIPTS_PREFIX`'s own doc), so a
   *  scripts-only diff cannot possibly change what a dist-text scanner reads and must NOT trigger this
   *  list. See {@link CHANGED_TS_TEXT_SCANNER_REPO_PATHS}'s own doc for the full membership reasoning. */
  changedTsPaths: string[];
  /** Card `f862f9c5`: repo-relative paths of changed `packages/daemon/scripts/**\/*.mjs` files (the SAME
   *  population classified into `changedScriptFiles` internally, just surfaced — mirrors `changedTsPaths`
   *  immediately above) — populated only when `eligible`. Drives {@link buildReducedGateCommand}'s
   *  conditional fold-in of {@link CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS}, on ITS OWN trigger, independent
   *  of `changedTsPaths` (a diff can set either, both, or neither) — see that list's own doc for why a
   *  `scripts/**` reader must never fold into the `.ts`-triggered list instead. */
  changedScriptFiles: string[];
  /** Count of changed compiled `.ts` files PLUS changed `packages/daemon/scripts/**\/*.mjs` files (card
   *  82662e98) proven transpile/parse-identical — diagnostic only, surfaced by the caller so a skip is
   *  never silent (card 2154b6ad DoD-5). Deliberately ONE combined count, not two: both populations are
   *  proven inert by the identical "compare before/after with comments+whitespace stripped" mechanism,
   *  just at a different compiler `target` (see {@link EMIT_COMPARE_SCRIPTS_PREFIX}'s own doc for why) —
   *  splitting this into a second field would mean threading a new field through every persisted consumer
   *  of this one (sessions/service.ts's `emitCompareIdenticalCount` rides a reconciliation event payload,
   *  not just this return value) for a distinction that's diagnostic wording only, not behavior. */
  identicalFileCount: number;
  reason?: string;
  /** @decision 2db8a3dd — `false` (`notReducible`) is a REAL, informative "ran, not reduced" verdict; `true`
   *  (`notApplicableHere`) means the predicate doesn't apply at all — never stamp an operational failure
   *  `false` (card 4def0708).
   *
   *  FIRST-TERMINAL-WINS over changed paths in git's emitted order, never "any
   *  out-of-scope path wins". */
  notApplicable: boolean;
  /** Card fd0d34da: set IFF `notApplicable:true` — see {@link EmitCompareNotApplicableKind}'s own doc for
   *  the full per-value discipline. `undefined` whenever `notApplicable` is `false` (both on `eligible:true`
   *  and on a `notReducible` `eligible:false`) — never a fabricated category for a real, informative
   *  reducibility verdict. */
  notApplicableKind?: EmitCompareNotApplicableKind;
}

/** Shell-safe allowlist for a `test/*.mjs` repo-relative path that will be interpolated into
 *  {@link buildReducedGateCommand}'s shell-executed command string — shared by the classification loop's
 *  own check (a CHANGED path) and {@link foldInTestImporters} (an UNCHANGED path discovered only via the
 *  import-graph scan) so the two checks can never hand-copy apart. See the classification loop's own
 *  comment (Code Review, card 2154b6ad) for the full interpolation-hazard reasoning. */
const TEST_PATH_SHELL_SAFE_RE = /^[A-Za-z0-9_.\-/]+$/;

/** Minimal `typescript` surface {@link foldInTestImporters} needs to find the REAL import/re-export/
 *  dynamic-import edges between `packages/daemon/test/**\/*.mjs` files — via a genuine parse
 *  (`createSourceFile` + `forEachChild`), never a hand-rolled regex/`ts.createScanner` loop.
 *  @decision 2154b6ad already forbids `ts.createScanner` for the transpile-comparison case because it
 *  desyncs on template-literal interpolation; a plain regex scan has the SAME failure mode here PLUS a
 *  second one, measured directly on this repo's own corpus (card 72769424):
 *  `test/codex-real-spawn-lock-membership-guard.mjs` embeds the literal text
 *  `'import { thing } from "./thing.mjs";'` as a synthetic-fixture object-literal VALUE, never a real
 *  import — a regex over raw source text cannot tell that apart from a genuine import declaration; a real
 *  AST only ever matches an actual ImportDeclaration/ExportDeclaration/dynamic-`import()` node. Deliberately
 *  a SEPARATE, wider interface from {@link TypeScriptModuleLike} (emit-compare-soundness.ts) rather than
 *  widening that shared one — `deploy-staleness.ts`, the other consumer of that interface, has no need for
 *  AST access, and widening a shared type for one caller's need is exactly the kind of divergence this
 *  file's other decisions warn against. */
interface TestImportTsModuleLike {
  createSourceFile(fileName: string, sourceText: string, languageVersion: number, setParentNodes?: boolean, scriptKind?: number): unknown;
  forEachChild(node: unknown, cbNode: (node: unknown) => void): void;
  isImportDeclaration(node: unknown): boolean;
  isExportDeclaration(node: unknown): boolean;
  isCallExpression(node: unknown): boolean;
  isStringLiteralLike(node: unknown): boolean;
  SyntaxKind: Record<string, number>;
  ScriptTarget: Record<string, number>;
  ScriptKind: Record<string, number>;
}

interface TsNodeLike { kind: number }
interface TsModuleSpecifierNodeLike extends TsNodeLike { moduleSpecifier?: TsNodeLike & { text?: string } }
interface TsImportCallNodeLike extends TsNodeLike { expression?: TsNodeLike; arguments?: (TsNodeLike & { text?: string })[] }
/** A string literal longer than this can never be a filename/CLI-selector argument — excluded from
 *  {@link extractModuleSpecifiers}'s `spawnEdgeLiterals` purely to bound cost (a fixture embedding a large
 *  text blob as a string literal shouldn't pay the per-corpus-basename `includes` scan below); never a
 *  correctness boundary, since a real spawn target name is always short. */
const SPAWN_EDGE_MAX_LITERAL_LEN = 300;

/** One file's extracted module-specifier edges — every literal relative specifier found via a static
 *  import, a re-export (`export ... from`), or a dynamic `import()` call, PLUS whether this file contains
 *  a dynamic `import()` call whose argument is NOT a plain string literal — a computed/templated specifier
 *  this scan can never resolve, which could point anywhere, including at a changed test file — PLUS every
 *  OTHER string literal in the file (bounded by {@link SPAWN_EDGE_MAX_LITERAL_LEN}), for the conservative
 *  textual SPAWN edge {@link findSpawnTargetEdges} builds from it (round 4, card 72769424): a file that
 *  `spawn()`s another corpus file as a child process never `import`s it, so it has no edge of its own kind
 *  here — see that function's own doc.
 *
 *  @decision 72769424 — this is an UNCONDITIONAL hazard, never classified away by an AST walk again: a
 *  classifier here previously produced two more false-SAFE bugs on review (a shadowed identifier, a
 *  case-sensitive segment check) on top of the ones it was built to fix.
 *
 *  Deliberately OUT OF SCOPE (round 4, see the decision record's "KNOWN RESIDUAL"): `eval(...)`/`new
 *  Function(...)`-constructed source, and a `require(...)`/`createRequire(...)` resolution — neither is an
 *  AST-visible literal naming another corpus file the way a plain string literal is.
 *
 *  See {@link foldInTestImporters}'s own doc for how a hazard is handled (folded in as a wildcard importer,
 *  never a kill switch). An import declaration's own module specifier is ALWAYS a string literal per ES
 *  module grammar (the parser itself enforces this) — only the dynamic `import()` arm can ever set
 *  `hasUnresolvedDynamicImport`. */
function extractModuleSpecifiers(
  ts: TestImportTsModuleLike, fileName: string, content: string,
): { specifiers: string[]; hasUnresolvedDynamicImport: boolean; spawnEdgeLiterals: string[] } {
  const specifiers: string[] = [];
  let hasUnresolvedDynamicImport = false;
  const spawnEdgeLiterals: string[] = [];
  // @decision 18bfe989 — narrow explicitly rather than cast: `noUncheckedIndexedAccess` types this lookup
  // `number | undefined`, and a missing Latest/JS must fail this file closed (hasUnresolvedDynamicImport),
  // never reach `createSourceFile` with an undefined languageVersion/scriptKind.
  const languageVersion = ts.ScriptTarget.Latest;
  const scriptKind = ts.ScriptKind.JS;
  if (languageVersion === undefined || scriptKind === undefined) return { specifiers: [], hasUnresolvedDynamicImport: true, spawnEdgeLiterals: [] };
  let sourceFile: unknown;
  try {
    sourceFile = ts.createSourceFile(fileName, content, languageVersion, false, scriptKind);
  } catch {
    // Not expected — createSourceFile tolerates malformed syntax by producing error nodes rather than
    // throwing — but a genuine exception is the same "can't resolve" shape as a non-literal dynamic
    // import: we cannot know what this file imports, so the caller must fail closed.
    return { specifiers: [], hasUnresolvedDynamicImport: true, spawnEdgeLiterals: [] };
  }
  const visit = (node: unknown) => {
    // Unconditional — independent of the import/export/dynamic-import branches below, so a literal in ANY
    // syntactic position (an object property value, an array element, a bare call argument) is still
    // collected; a real AST node, never a raw-text regex match (same soundness reasoning as the rest of
    // this scan — see this file's own `codex-real-spawn-lock-membership-guard.mjs` false-positive case).
    if (ts.isStringLiteralLike(node)) {
      const text = (node as { text?: string }).text;
      if (typeof text === "string" && text.length <= SPAWN_EDGE_MAX_LITERAL_LEN) spawnEdgeLiterals.push(text);
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = (node as TsModuleSpecifierNodeLike).moduleSpecifier;
      // An `export { x }` with no moduleSpecifier is a LOCAL re-export, not a cross-file edge — nothing to
      // record for it.
      if (spec && ts.isStringLiteralLike(spec) && typeof spec.text === "string") specifiers.push(spec.text);
    } else if (ts.isCallExpression(node)) {
      const call = node as TsImportCallNodeLike;
      if (call.expression && call.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = call.arguments?.[0];
        if (arg && ts.isStringLiteralLike(arg) && typeof arg.text === "string") specifiers.push(arg.text);
        else hasUnresolvedDynamicImport = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { specifiers, hasUnresolvedDynamicImport, spawnEdgeLiterals };
}

/** @decision 72769424 — a conservative, over-inclusive textual edge for the subprocess-spawn dependency
 *  form the import-graph scan can't otherwise see. Never narrow the basename/`--only=` match below to
 *  "literal must sit in a call-argument position" — a spawn target name can appear in any string literal. */
function findSpawnTargetEdges(
  literals: readonly string[], basenameToRelPaths: ReadonlyMap<string, readonly string[]>, stemToRelPaths: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const targets = new Set<string>();
  for (const literal of literals) {
    if (literal.startsWith("--only=")) {
      for (const token of literal.slice("--only=".length).split(",")) {
        for (const relPath of stemToRelPaths.get(token) ?? []) targets.add(relPath);
      }
    }
    for (const [basename, relPaths] of basenameToRelPaths) {
      if (literal.includes(basename)) for (const relPath of relPaths) targets.add(relPath);
    }
  }
  return targets;
}

/** Recursively lists every `packages/daemon/test/**\/*.mjs` file under `testDirAbs`, as POSIX-style paths
 *  RELATIVE TO THAT DIRECTORY (e.g. `"fixed-wait-witness-guard.mjs"`, `"census/lib.mjs"`) — built with `/`
 *  directly (never via `path.join` for the RETURNED string), since every repo-relative path elsewhere in
 *  this file is `/`-separated like git's own output, and a Windows backslash here would break every
 *  comparison against one. Reads the WORKTREE's own disk content, not `git show ref:path` per file —
 *  sound because `ref` IS this worktree's own HEAD (@decision fe848bfc), the same precedent
 *  {@link loadHarnessSetExport} already establishes for reading real worktree files directly rather than
 *  paying for one `git show` subprocess per file; unlike that loader, this is a pure parse of static text
 *  (never an `import()`/execution of worktree code), so it needs no child-process/timeout isolation. */
function listAllTestMjsFilesRelative(testDirAbs: string, relBase = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(testDirAbs, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listAllTestMjsFilesRelative(path.join(testDirAbs, entry.name), rel));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) out.push(rel);
  }
  return out;
}

/** {@link foldInTestImporters}'s verdict — a discriminated union so a caller can route a mechanism failure
 *  through `notApplicableHere` and a real "can't safely reduce" finding through `notReducible`, the same
 *  split {@link computeEmitCompareGate}'s own `notReducible`/`notApplicableHere` constructors already
 *  enforce (@decision 2db8a3dd) for every other verdict in that function. */
type TestImporterFoldInResult =
  | { ok: true; addChangedTestFiles: string[]; addNotHermeticExcluded: string[] }
  | { ok: false; notApplicable: true; notApplicableKind: EmitCompareNotApplicableKind; reason: string }
  | { ok: false; notApplicable: false; reason: string };

/** {@link scanTestImporterClosure}'s verdict — the RAW discovered-importer closure (before NOT_HERMETIC/
 *  EXCLUDED_DIR_NAMES classification, which {@link foldInTestImporters} does itself, in-process, over the
 *  small `visited` list this returns). `kind` mirrors the two mechanism-failure {@link
 *  EmitCompareNotApplicableKind} values {@link foldInTestImporters} already used before this was split out. */
type TestImporterClosureScanResult =
  | { ok: true; visited: string[] }
  | { ok: false; kind: "typescript-unresolvable" | "harness-config-unavailable"; reason: string };

/** @decision 72769424 — never call this from the host's own event loop; it froze every project's
 *  HTTP/WS/MCP/PTY traffic for its whole duration. Exported only so a child process can `import()` and
 *  call it — see {@link scanTestImporterClosureInChildProcess} immediately below. */
export async function scanTestImporterClosure(
  testDirAbs: string, roots: readonly string[],
): Promise<TestImporterClosureScanResult> {
  let tsModule: TestImportTsModuleLike;
  try {
    const imported = (await import("typescript")) as unknown as { default?: TestImportTsModuleLike } & TestImportTsModuleLike;
    tsModule = imported.default ?? imported;
  } catch {
    return { ok: false, kind: "typescript-unresolvable", reason: "typescript module not resolvable while scanning test-file importers (expected on a shipped end-user install)" };
  }

  let relFiles: string[];
  try {
    relFiles = listAllTestMjsFilesRelative(testDirAbs);
  } catch {
    return { ok: false, kind: "harness-config-unavailable", reason: "could not list packages/daemon/test/**/*.mjs while scanning test-file importers" };
  }

  // Basename/stem -> repo-relative path(s) — built once from the file LISTING alone (cheap, no I/O), so
  // every file's content scan below (including the spawn-edge literal match) can look a name up in O(1)
  // instead of re-deriving it. More than one file can share a basename/stem across subdirectories.
  const basenameToRelPaths = new Map<string, string[]>();
  const stemToRelPaths = new Map<string, string[]>();
  for (const rel of relFiles) {
    const repoRelPath = `${EMIT_COMPARE_TEST_PREFIX}${rel}`;
    const basename = path.posix.basename(rel);
    const stem = basename.slice(0, -".mjs".length);
    (basenameToRelPaths.get(basename) ?? basenameToRelPaths.set(basename, []).get(basename) as string[]).push(repoRelPath);
    (stemToRelPaths.get(stem) ?? stemToRelPaths.set(stem, []).get(stem) as string[]).push(repoRelPath);
  }

  // importer repo-relative path -> Set of imported repo-relative test/*.mjs paths it resolves to.
  const edges = new Map<string, Set<string>>();
  // Files with a non-literal dynamic import() argument — treated as importing EVERYTHING (see
  // foldInTestImporters's own doc above), never as a reason to abort the whole scan.
  const wildcardImporters: string[] = [];
  for (const rel of relFiles) {
    const repoRelPath = `${EMIT_COMPARE_TEST_PREFIX}${rel}`;
    let content: string;
    try {
      content = fs.readFileSync(path.join(testDirAbs, rel), "utf8");
    } catch {
      return { ok: false, kind: "harness-config-unavailable", reason: `could not read ${repoRelPath} while scanning test-file importers` };
    }
    const { specifiers, hasUnresolvedDynamicImport, spawnEdgeLiterals } = extractModuleSpecifiers(tsModule, repoRelPath, content);
    if (hasUnresolvedDynamicImport) wildcardImporters.push(repoRelPath);
    const targets = new Set<string>();
    for (const spec of specifiers) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // bare/absolute specifier — can never resolve into test/
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(repoRelPath), spec));
      if (resolved.startsWith(EMIT_COMPARE_TEST_PREFIX) && resolved.endsWith(".mjs")) targets.add(resolved);
    }
    for (const spawnTarget of findSpawnTargetEdges(spawnEdgeLiterals, basenameToRelPaths, stemToRelPaths)) targets.add(spawnTarget);
    if (targets.size > 0) edges.set(repoRelPath, targets);
  }

  // Reverse edges: imported path -> Set of importer paths — so a BFS can walk OUTWARD from the changed
  // files to find who imports them, transitively. A `visited` set (not a depth counter) bounds the walk,
  // so a real import cycle terminates cleanly rather than looping — it's simply never a special case here.
  const reverse = new Map<string, Set<string>>();
  for (const [importer, targets] of edges) {
    for (const target of targets) {
      let importers = reverse.get(target);
      if (!importers) { importers = new Set(); reverse.set(target, importers); }
      importers.add(importer);
    }
  }

  const rootSet = new Set<string>(roots);
  const visited = new Set<string>();
  const queue: string[] = [...rootSet];
  // Wildcard importers are NOT roots (roots bypass classification in foldInTestImporters) — seed them
  // into visited/queue directly so each one still goes through the NOT_HERMETIC/EXCLUDED_DIR_NAMES/
  // helper/shell-safe gate, exactly like a textually-discovered importer.
  for (const w of wildcardImporters) {
    if (rootSet.has(w) || visited.has(w)) continue;
    visited.add(w);
    queue.push(w);
  }
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const importer of reverse.get(current) ?? []) {
      if (rootSet.has(importer) || visited.has(importer)) continue;
      visited.add(importer);
      queue.push(importer);
    }
  }
  return { ok: true, visited: [...visited] };
}

/** Bound on running {@link scanTestImporterClosure} in a child process (see {@link
 *  scanTestImporterClosureInChildProcess}) — generous relative to the ~9.4s measured on this repo's real
 *  1324-file corpus; exists only so a hung/looping scan can never wedge a merge. A timeout fails the whole
 *  diff closed, same as every other mechanism failure this scan can hit. */
export const TEST_IMPORTER_SCAN_TIMEOUT_MS = 120_000;

/** @decision db669d74 — decodes via `setEncoding("utf8")`, never per-chunk `Buffer#toString()`, so a
 *  multi-byte character split across two stdout chunks is never corrupted into U+FFFD.
 *
 *  Exported for direct unit testing against a deterministic chunk-split fixture (a real OS pipe's chunk
 *  boundaries aren't controllable from outside), and shared by both this file's child-stdout call sites. */
export function collectUtf8Stdout(stdout: NodeJS.ReadableStream | null | undefined, maxLen: number): { value: string } {
  const acc = { value: "" };
  stdout?.setEncoding("utf8");
  stdout?.on("data", (chunk: string) => { if (acc.value.length < maxLen) acc.value += chunk; });
  return acc;
}

/** Evaluated by the child (`node --input-type=module -e`). `url` is THIS SAME compiled module's own
 *  `import.meta.url` — never a worktree's copy; the scan LOGIC must stay the host's trusted code, only the
 *  DATA it reads (`testDirAbs`, and `roots` over stdin) points into the worktree under test. Prints one
 *  JSON line and force-exits so a stray handle can't keep the child alive.
 *
 *  @decision db669d74 — reads `roots` from STDIN, never a JSON argv element: a diff touching several
 *  hundred test files can serialize past the Windows ~32767-char combined command-line limit, silently
 *  losing the reduction (fails closed, safe) the moment `spawn` fails. Stdin has no such ceiling. */
const TEST_IMPORTER_SCAN_PROBE_SOURCE =
  "const [url,testDirAbs]=process.argv.slice(1);" +
  "let rootsJson='';" +
  "process.stdin.setEncoding('utf8');" +
  "process.stdin.on('data',(c)=>{rootsJson+=c});" +
  "process.stdin.on('end',()=>{" +
  "import(url).then(" +
  "(m)=>m.scanTestImporterClosure(testDirAbs,JSON.parse(rootsJson))" +
  ".then((r)=>{process.stdout.write(JSON.stringify(r));process.exit(0)})" +
  ".catch(()=>process.exit(4))," +
  "()=>process.exit(2));" +
  "});";

/** @decision 72769424 — same killable-child-process isolation {@link loadHarnessSetExport} already
 *  established (card fca110cf): async spawn only, never `spawnSync`. Any mechanism failure here fails
 *  closed to `"harness-config-unavailable"`, same as {@link scanTestImporterClosure}'s own internal ones.
 *
 *  @decision db669d74 — writes `roots` to the child's stdin, never a JSON argv element — see
 *  {@link TEST_IMPORTER_SCAN_PROBE_SOURCE}'s own anchor for why. */
function scanTestImporterClosureInChildProcess(
  testDirAbs: string, roots: readonly string[], timeoutMs: number,
): Promise<TestImporterClosureScanResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess;
    const done = (r: TestImporterClosureScanResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killRemoveChild(child);
      done({ ok: false, kind: "harness-config-unavailable", reason: "test-importer-scan child process timed out" });
    }, timeoutMs);
    try {
      child = spawn(process.execPath, ["--input-type=module", "-e", TEST_IMPORTER_SCAN_PROBE_SOURCE, import.meta.url, testDirAbs], {
        stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      });
    } catch {
      done({ ok: false, kind: "harness-config-unavailable", reason: "could not spawn test-importer-scan child process" });
      return;
    }
    const stdoutAcc = collectUtf8Stdout(child.stdout, 1_000_000);
    // Best-effort: a child that fails to spawn properly or exits before reading stdin can make this write
    // error (e.g. EPIPE) — the `"error"`/`"close"` handlers below already cover every such outcome.
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end(JSON.stringify(roots));
    } catch {
      // Best-effort — see the stdin "error" listener's own comment just above.
    }
    child.on("error", () => done({ ok: false, kind: "harness-config-unavailable", reason: "test-importer-scan child process errored" }));
    child.on("close", (code) => {
      if (code !== 0) { done({ ok: false, kind: "harness-config-unavailable", reason: `test-importer-scan child process exited with code ${code}` }); return; }
      try {
        done(JSON.parse(stdoutAcc.value.trim()) as TestImporterClosureScanResult);
      } catch {
        done({ ok: false, kind: "harness-config-unavailable", reason: "could not parse test-importer-scan child process output" });
      }
    });
  });
}

/** @decision 72769424 — a file whose dynamic import(s) can't be resolved to a plain string literal (see
 *  {@link extractModuleSpecifiers}'s own doc) is UNCONDITIONALLY a hazard, never classified away.
 *
 *  It's folded in as a WILDCARD IMPORTER: seeded into the BFS as if it were ALREADY FOUND to import
 *  something in `roots`, since by construction we cannot rule that out either. This keeps the fail-closed
 *  INTENT (such a file, and everything that transitively depends on it, still gets pulled into the run set)
 *  without the fail-closed BLAST RADIUS this function exists to avoid (aborting the ENTIRE diff's reduction
 *  over a file nothing else in the diff actually reaches). A wildcard importer still goes through the SAME
 *  NOT_HERMETIC/EXCLUDED_DIR_NAMES classification as any other discovered importer below — it is seeded
 *  into `visited`, never into `roots` (which bypasses that classification for paths already known-clean
 *  from the caller).
 *
 *  Never fold a discovered importer (wildcard or textual) into `changedTestFiles` without first classifying
 *  it against NOT_HERMETIC/EXCLUDED_DIR_NAMES, same as a directly-changed path. */
async function foldInTestImporters(
  worktreePath: string,
  changedTestFiles: readonly string[],
  notHermeticExcluded: readonly string[],
  deletedTestFiles: readonly string[],
  getExcludedDirNames: () => Promise<Set<string> | null>,
  getNotHermeticNames: () => Promise<Set<string> | null>,
): Promise<TestImporterFoldInResult> {
  const testDirAbs = path.join(worktreePath, "packages", "daemon", "test");
  // Card 72769424 fix round: `deletedTestFiles` are graph SEEDS only, same shape as changedTestFiles/
  // notHermeticExcluded for the purpose of "who imports this", but they can never be run (they no longer
  // exist) so they never reach `addChangedTestFiles`/`addNotHermeticExcluded` — a real edge is purely
  // textual (an importer's own `import "./foo.mjs"` line doesn't care whether foo.mjs still exists on
  // disk), so a deleted-but-still-imported file's importers must still be found.
  const roots = [...changedTestFiles, ...notHermeticExcluded, ...deletedTestFiles];
  const scan = await scanTestImporterClosureInChildProcess(testDirAbs, roots, TEST_IMPORTER_SCAN_TIMEOUT_MS);
  if (!scan.ok) return { ok: false, notApplicable: true, notApplicableKind: scan.kind, reason: scan.reason };
  if (scan.visited.length === 0) return { ok: true, addChangedTestFiles: [], addNotHermeticExcluded: [] };

  let excludedDirNames: Set<string> | null | undefined;
  let notHermeticNames: Set<string> | null | undefined;
  const addChangedTestFiles: string[] = [];
  const addNotHermeticExcluded: string[] = [];
  for (const p of scan.visited) {
    const relToTestDir = p.slice(EMIT_COMPARE_TEST_PREFIX.length);
    const dirSegments = relToTestDir.split("/").slice(0, -1);
    if (dirSegments.length > 0) {
      if (excludedDirNames === undefined) excludedDirNames = await getExcludedDirNames();
      if (excludedDirNames === null) return { ok: false, notApplicable: true, notApplicableKind: "harness-config-unavailable", reason: `could not load EXCLUDED_DIR_NAMES while classifying discovered importer ${p}` };
      if (dirSegments.some((seg) => (excludedDirNames as Set<string>).has(seg))) continue; // fixtures/census pass-through node — never a run target, same as a directly-changed one
    }
    if (relToTestDir.split("/").some((seg) => seg.startsWith("_"))) continue; // helper pass-through node — never a run target
    if (!TEST_PATH_SHELL_SAFE_RE.test(p)) return { ok: false, notApplicable: false, reason: `discovered importer path contains a character outside the shell-safe allowlist: ${p}` };
    if (dirSegments.length === 0) {
      // NOT_HERMETIC only ever names test/'s TOP-LEVEL files (mirrors the classification loop's own
      // comment above) — a nested importer can never match it.
      const harnessName = p.slice(EMIT_COMPARE_TEST_PREFIX.length, -".mjs".length);
      if (notHermeticNames === undefined) notHermeticNames = await getNotHermeticNames();
      if (notHermeticNames === null) return { ok: false, notApplicable: true, notApplicableKind: "harness-config-unavailable", reason: `could not load NOT_HERMETIC while classifying discovered importer ${p}` };
      if (notHermeticNames.has(harnessName)) { addNotHermeticExcluded.push(p); continue; }
    }
    addChangedTestFiles.push(p);
  }
  return { ok: true, addChangedTestFiles, addNotHermeticExcluded };
}

/** One directly-matching test file plus HOW MANY distinct touched dist modules it imports — the input
 *  to {@link rankAndCapRunSet}'s descending-count ranking (LEAD ruling on cee17efe). */
export interface DirectDistImporterMatch {
  path: string;
  /** Count of DISTINCT `touchedDistRelPaths` entries this file's own specifiers resolve to. */
  touchedCount: number;
}

/** {@link scanDirectDistImporters}'s verdict — the RAW (pre-classification) direct-importer match, same
 *  split {@link scanTestImporterClosure}/{@link foldInTestImporters} use: the AST walk happens in a child
 *  process and returns raw paths; classification against NOT_HERMETIC/EXCLUDED_DIR_NAMES happens
 *  afterward, in the host process, in {@link computeDirectDistImporterRunSet} below. */
export type DirectDistImporterScanResult =
  | { ok: true; matched: DirectDistImporterMatch[]; wildcardImporters: string[] }
  | { ok: false; kind: "typescript-unresolvable" | "harness-config-unavailable"; reason: string };

/**
 * @decision cee17efe — never fold this into {@link scanTestImporterClosure}/{@link foldInTestImporters}
 * (a deliberate LEAD ruling, not duplication to clean up); a non-literal dynamic import folds into
 * `wildcardImporters`, never silently dropped — same fail-closed rule decision 72769424 established.
 *
 * The DIRECT (non-transitive) counterpart to {@link scanTestImporterClosure}: for every real
 * `packages/daemon/test/**\/*.mjs` file, extracts its own import/dynamic-import specifiers (the SAME
 * {@link extractModuleSpecifiers} parse {@link scanTestImporterClosure} already uses) and reports a MATCH
 * when any specifier resolves to one of `touchedDistRelPaths` (repo-relative compiled module paths, e.g.
 * `"packages/daemon/dist/sessions/service.js"`). No BFS, no reverse-edge graph — Option B (design card
 * 71a77fb2 §5) is explicitly a direct-importer scan only.
 *
 * Returns the RAW matched/wildcard paths, not yet classified against NOT_HERMETIC/EXCLUDED_DIR_NAMES —
 * see {@link computeDirectDistImporterRunSet} for that half. Exported only so a child process can
 * `import()` and call it (via {@link scanDirectDistImportersInChildProcess} immediately below).
 */
export async function scanDirectDistImporters(
  testDirAbs: string, touchedDistRelPaths: readonly string[],
): Promise<DirectDistImporterScanResult> {
  let tsModule: TestImportTsModuleLike;
  try {
    const imported = (await import("typescript")) as unknown as { default?: TestImportTsModuleLike } & TestImportTsModuleLike;
    tsModule = imported.default ?? imported;
  } catch {
    return { ok: false, kind: "typescript-unresolvable", reason: "typescript module not resolvable while scanning for direct dist importers (expected on a shipped end-user install)" };
  }
  let relFiles: string[];
  try {
    relFiles = listAllTestMjsFilesRelative(testDirAbs);
  } catch {
    return { ok: false, kind: "harness-config-unavailable", reason: "could not list packages/daemon/test/**/*.mjs while scanning for direct dist importers" };
  }
  const touched = new Set(touchedDistRelPaths);
  const matched: DirectDistImporterMatch[] = [];
  const wildcardImporters: string[] = [];
  for (const rel of relFiles) {
    const repoRelPath = `${EMIT_COMPARE_TEST_PREFIX}${rel}`;
    let content: string;
    try {
      content = fs.readFileSync(path.join(testDirAbs, rel), "utf8");
    } catch {
      return { ok: false, kind: "harness-config-unavailable", reason: `could not read ${repoRelPath} while scanning for direct dist importers` };
    }
    const { specifiers, hasUnresolvedDynamicImport } = extractModuleSpecifiers(tsModule, repoRelPath, content);
    if (hasUnresolvedDynamicImport) { wildcardImporters.push(repoRelPath); continue; }
    // Card cee17efe (LEAD ruling): count DISTINCT touched matches, not a boolean — rankAndCapRunSet ranks
    // on this count, descending, so a file importing more of the touched modules runs first under a cap.
    const matchedTouched = new Set<string>();
    for (const spec of specifiers) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // bare/absolute specifier — never resolves into dist/
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(repoRelPath), spec));
      if (touched.has(resolved)) matchedTouched.add(resolved);
    }
    if (matchedTouched.size > 0) matched.push({ path: repoRelPath, touchedCount: matchedTouched.size });
  }
  return { ok: true, matched, wildcardImporters };
}

/** @decision 72769424 (shared posture) — never call {@link scanDirectDistImporters} from the host's own
 *  event loop. Mirrors {@link scanTestImporterClosureInChildProcess} exactly (same probe-source/stdin
 *  technique, same bounded timeout, same killable-child isolation) with ONE payload difference: this
 *  scan's input is `touchedDistRelPaths` (dist module paths), not `roots` (test-file paths) — still sent
 *  over stdin, never argv, for the same Windows command-line-length reason (@decision db669d74). */
const DIRECT_DIST_IMPORTER_SCAN_PROBE_SOURCE =
  "const [url,testDirAbs]=process.argv.slice(1);" +
  "let touchedJson='';" +
  "process.stdin.setEncoding('utf8');" +
  "process.stdin.on('data',(c)=>{touchedJson+=c});" +
  "process.stdin.on('end',()=>{" +
  "import(url).then(" +
  "(m)=>m.scanDirectDistImporters(testDirAbs,JSON.parse(touchedJson))" +
  ".then((r)=>{process.stdout.write(JSON.stringify(r));process.exit(0)})" +
  ".catch(()=>process.exit(4))," +
  "()=>process.exit(2));" +
  "});";

/** Mirrors {@link TEST_IMPORTER_SCAN_TIMEOUT_MS}'s own generous bound — same corpus, same class of walk. */
export const DIRECT_DIST_IMPORTER_SCAN_TIMEOUT_MS = 120_000;

function scanDirectDistImportersInChildProcess(
  testDirAbs: string, touchedDistRelPaths: readonly string[], timeoutMs: number,
): Promise<DirectDistImporterScanResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess;
    const done = (r: DirectDistImporterScanResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killRemoveChild(child);
      done({ ok: false, kind: "harness-config-unavailable", reason: "direct-dist-importer-scan child process timed out" });
    }, timeoutMs);
    try {
      child = spawn(process.execPath, ["--input-type=module", "-e", DIRECT_DIST_IMPORTER_SCAN_PROBE_SOURCE, import.meta.url, testDirAbs], {
        stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      });
    } catch {
      done({ ok: false, kind: "harness-config-unavailable", reason: "could not spawn direct-dist-importer-scan child process" });
      return;
    }
    const stdoutAcc = collectUtf8Stdout(child.stdout, 1_000_000);
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end(JSON.stringify(touchedDistRelPaths));
    } catch {
      // Best-effort — see the sibling stdin "error" listener's own comment on scanTestImporterClosureInChildProcess.
    }
    child.on("error", () => done({ ok: false, kind: "harness-config-unavailable", reason: "direct-dist-importer-scan child process errored" }));
    child.on("close", (code) => {
      if (code !== 0) { done({ ok: false, kind: "harness-config-unavailable", reason: `direct-dist-importer-scan child process exited with code ${code}` }); return; }
      try {
        done(JSON.parse(stdoutAcc.value.trim()) as DirectDistImporterScanResult);
      } catch {
        done({ ok: false, kind: "harness-config-unavailable", reason: "could not parse direct-dist-importer-scan child process output" });
      }
    });
  });
}

/** The fully-classified verdict of {@link computeDirectDistImporterRunSet} — `candidates` is NOT yet
 *  ranked or capped (LEAD ruling on cee17efe: ranking/capping is pure logic, owned by
 *  `orchestration/dist-importer-check.ts`'s `rankAndCapRunSet`, not this git-facing function). A
 *  wildcard (non-literal-dynamic-import) candidate carries `touchedCount: 0` — unknown/unconfirmed, so it
 *  ranks last under `rankAndCapRunSet`'s descending-count sort, never first. */
export type DirectDistImporterCheckResult =
  | { ok: true; candidates: DirectDistImporterMatch[]; corpusSize: number }
  | { ok: false; reason: string };

/**
 * Card cee17efe — the full "which test files are eligible to run" computation for one isolated
 * worktree: scans (in a child process) for every test file directly importing one of
 * `touchedDistRelPaths`, then classifies each candidate against NOT_HERMETIC/EXCLUDED_DIR_NAMES/the
 * `_`-prefixed-helper convention — the SAME three exclusions {@link foldInTestImporters} applies to its
 * own discovered importers, duplicated here (not shared via a refactor of that function) per the LEAD
 * ruling to leave it untouched. A shell-unsafe discovered path is dropped rather than failing the whole
 * check closed (unlike `foldInTestImporters`'s refusal for the merge-reduction case): this signal is
 * advisory-only, so losing one candidate test file is an acceptable, silent-to-the-manager cost; failing
 * the whole advisory closed over one odd path is not worth the loss of coverage for every OTHER touched
 * module. Ranking/capping the returned `candidates` down to an actual run set is the CALLER's job (see
 * `rankAndCapRunSet`) — this function never truncates.
 */
/** @decision cee17efe — never let candidate classification and the corpus-size count drift apart on
 *  what "runnable" means.
 *
 *  Card cd3a5943 — this used to be a THIRD hand-copy of the "runnable hermetic test" rule (alongside
 *  `foldInTestImporters`'s own classification loop and the harness's real `discoverHermeticTests`,
 *  scripts/test-daemon.mjs). Both the corpus-size denominator AND the candidate classification in
 *  {@link computeDirectDistImporterRunSet} below now derive from {@link loadHermeticTestNames} — the
 *  harness's own `discoverHermeticTests()`, evaluated against THIS worktree's own test dir in the same
 *  killable child process {@link loadHarnessSetExports} already uses — so the two can no longer drift
 *  apart BY CONSTRUCTION, never by two independent implementations of the same three exclusions happening
 *  to agree. `discoverHermeticTests` additionally requires a candidate to `looksLikeTest` (an
 *  assertion-marker scan) — a fourth, strictly NARROWER check the old hand-rolled version here never
 *  applied; in practice this never diverges from the old corpusSize on a real corpus, since a
 *  `looksLikeTest` violation makes the harness itself refuse to run at all (scripts/test-daemon.mjs's own
 *  discovery-violation exit path) — one can never survive to a landed commit this check runs against.
 *
 *  Deliberately NOT extended to `foldInTestImporters`/`computeEmitCompareGate`'s own classification loop
 *  (the SECOND hand-copy) — that is the load-bearing REDUCED MERGE GATE, explicitly protected by decision
 *  record 72769424's ruling that those two functions "stay untouched... regardless of how similar their
 *  AST-walk shape looks". Routing that path through content-reading `discoverHermeticTests` would add a
 *  new per-file read to a gate that decides whether the WHOLE test suite runs, for an advisory-only
 *  payoff (this check never blocks a merge — see this section's own anchor above). Left as a tracked,
 *  understood duplication, not an oversight. */

export async function computeDirectDistImporterRunSet(
  worktreePath: string, touchedDistRelPaths: readonly string[], scanTimeoutMs: number = DIRECT_DIST_IMPORTER_SCAN_TIMEOUT_MS,
): Promise<DirectDistImporterCheckResult> {
  const testDirAbs = path.join(worktreePath, "packages", "daemon", "test");
  const scan = await scanDirectDistImportersInChildProcess(testDirAbs, touchedDistRelPaths, scanTimeoutMs);
  if (!scan.ok) return { ok: false, reason: scan.reason };
  // @decision cee17efe (LEAD ruling 7) — load this UNCONDITIONALLY, before the corpus-size count below, so
  // the cap's denominator is always the RUNNABLE hermetic count, never the raw walk (which would silently
  // inflate `computeDistImporterCap`'s denominator).
  //
  // Card cd3a5943: sourced from the harness's own `discoverHermeticTests()` via {@link
  // loadHermeticTestNames}, not a hand-rolled re-implementation — see this function's own leading doc
  // comment above for the full rationale.
  const hermeticNames = await loadHermeticTestNames(worktreePath);
  if (hermeticNames === null) {
    return { ok: false, reason: "could not load discoverHermeticTests() from the isolated worktree's own scripts/test-daemon.mjs" };
  }
  const corpusSize = hermeticNames.size;
  const rawCandidates: DirectDistImporterMatch[] = [
    ...scan.matched,
    ...scan.wildcardImporters.map((p) => ({ path: p, touchedCount: 0 })),
  ];
  if (rawCandidates.length === 0) return { ok: true, candidates: [], corpusSize };
  const candidates: DirectDistImporterMatch[] = [];
  for (const c of rawCandidates) {
    const p = c.path;
    const relToTestDir = p.slice(EMIT_COMPARE_TEST_PREFIX.length);
    if (!hermeticNames.has(relToTestDir.slice(0, -".mjs".length))) continue;
    if (!TEST_PATH_SHELL_SAFE_RE.test(p)) continue; // advisory-only: drop rather than fail the whole check closed
    candidates.push(c);
  }
  return { ok: true, candidates, corpusSize };
}

/**
 * Card cee17efe — the changed `packages/daemon/src/**\/*.ts` repo-relative paths for ONE already-landed
 * commit (a squash commit always has exactly one parent, so `<sha>^..<sha>` is unambiguous). A thin,
 * standalone `git diff --name-status` read — deliberately NOT a reuse of {@link computeEmitCompareGate}'s
 * own inline classification loop, which is scoped to a pre-merge WORKTREE diff against a base ref (gate
 * reduction) and carries test/asset/script classification this advisory signal doesn't need. `null` on
 * any git failure (unreadable sha, timeout) — the caller treats that as "nothing to check", never as an
 * empty-but-real diff.
 */
export async function changedDaemonSrcTsPathsForCommit(
  repoPath: string, sha: string, deps: BoundedGitDeps = {},
): Promise<string[] | null> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  let out: string;
  try {
    // @decision 4b559feb — `--end-of-options` before `${sha}^`: a caller-supplied landed-commit sha; the
    // RETRACTED compound-suffix exemption (868e0135) applies — `${sha}^` has no safe literal prefix.
    out = (await withTimeout(
      git.raw(["diff", "--name-status", "--no-renames", "--end-of-options", `${sha}^`, sha, "--", "packages/daemon/src"]),
      timeoutMs, "git diff --name-status (dist-importer-check)",
    )).trim();
  } catch {
    return null;
  }
  if (!out) return [];
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const p = line.slice(tab + 1).trim();
    if (p.startsWith("packages/daemon/src/") && p.endsWith(".ts")) paths.push(p);
  }
  return paths;
}

/** @decision 2154b6ad — skips the ~668-test RUNTIME SUITE only (never the whole gate): proven via isolated
 *  transpile-comparison per changed file — never a hand-rolled scanner (desyncs on template literals), never
 *  "comments-only" (a real comment can flip a static guard).
 *
 *  Re-checks its soundness precondition LIVE; fails
 *  closed on every uncertain case.
 *  @decision 44968963 — ANY `fixtures/`/`census/` touch fails the WHOLE diff closed. Never build a textual
 *  fixture-consumer resolver to preserve reduced-gate speed here — it can only ever observe it hasn't missed
 *  a consumer, never prove it, and a wrong skip is a bad merge while a wrong full-run only costs minutes.
 *  @decision fe848bfc — takes `worktreePath` only, never a separate `repoPath` — the old two-path signature
 *  produced card d422e279's bug (a batch worktree's "HEAD" diffed against canonical's own checkout).
 *
 *  Never
 *  justify reintroducing a second path with "a worktree shares its parent's object database" — that's false
 *  for refs (HEAD is per-worktree). */
export async function computeEmitCompareGate(
  worktreePath: string, baseSha: string, ref: string | undefined, deps: BoundedGitDeps = {},
): Promise<EmitCompareGateResult> {
  // Card 4def0708: replaces the old single `notEligible(reason, notApplicable = false)` — a DEFAULTED
  // boolean param let a forgotten call site silently stamp the INFORMATIVE value (12 of 16 original call
  // sites never opted in to `notApplicable:true`, three of them plainly wrong: a git error, an empty diff,
  // and an unparseable line, none of which are verdicts about reducibility). Two explicitly-named
  // constructors mean a call site can no longer express the wrong one BY OMISSION — every return below
  // picks one on purpose. See {@link EmitCompareGateResult.notApplicable}'s own doc.
  const notReducible = (reason: string): EmitCompareGateResult => ({ eligible: false, changedTestFiles: [], notHermeticExcluded: [], inertPathsSkipped: [], changedAssetPaths: [], changedTsPaths: [], changedScriptFiles: [], identicalFileCount: 0, reason, notApplicable: false });
  // Card fd0d34da: `kind` is now a required second argument (never a defaulted/optional param) — the same
  // "no call site can express the wrong thing by omission" discipline card 4def0708 already applied to the
  // `notReducible`/`notApplicableHere` split itself, one layer in.
  const notApplicableHere = (reason: string, kind: EmitCompareNotApplicableKind): EmitCompareGateResult => ({ eligible: false, changedTestFiles: [], notHermeticExcluded: [], inertPathsSkipped: [], changedAssetPaths: [], changedTsPaths: [], changedScriptFiles: [], identicalFileCount: 0, reason, notApplicable: true, notApplicableKind: kind });
  // @decision 56c10535 — `ref` is the branch SHA the caller already resolved (mirrors
  // isInertMergeDiff's own contract), never a bare branch NAME; an unreadable tip fails closed here.
  if (!ref) return notApplicableHere("branch tip unreadable", "git-operation-failed");
  const { git, timeoutMs } = boundedGit(worktreePath, deps);

  let entries: string[];
  try {
    // `--no-renames` and `-c core.quotePath=false` carry the SAME load-bearing reasons {@link
    // changedPathsBetween}'s own doc gives (this call needs `--name-status`, which that shared helper
    // doesn't produce, so it's a separate invocation rather than a third copy of that helper's flag list) —
    // most concretely now that a changed path is tested against {@link isInertMergePath}'s `startsWith`
    // allowlist here too (card b97f643d): a renamed-into-`docs/` source file or an unquoted non-ASCII
    // `docs/` filename would otherwise misclassify exactly as `isInertMergeDiff` warns against.
    // @decision 65b2b002 — `--end-of-options` guards the range token the same way {@link changedPathsBetween} does; see that decision record.
    const raw = (await withTimeout(
      git.raw(["-c", "core.quotePath=false", "diff", "--name-status", "--no-renames", "--end-of-options", `${baseSha}..${ref}`]),
      timeoutMs, "git diff --name-status (emit-compare classify)",
    )).trim();
    entries = raw ? raw.split("\n").map((s) => s.replace(/\r$/, "")).filter(Boolean) : [];
  } catch {
    // Card 4def0708: a git error is a MECHANISM failure, not a verdict about reducibility — it proves
    // nothing either way, so it must OMIT (notApplicableHere), never stamp an informative "not reduced".
    return notApplicableHere("git error reading the diff", "git-operation-failed");
  }
  if (entries.length === 0) return notApplicableHere("empty diff — nothing to prove inert from", "empty-diff");

  const changedTsFiles: string[] = [];
  // Card 82662e98: changed packages/daemon/scripts/**/*.mjs paths proven transpile-identical — same
  // "proven inert via comparison" shape as changedTsFiles, kept as a SEPARATE list (not folded into
  // changedTsFiles) purely so the two populations stay distinguishable for anyone reading this function;
  // both fold into the SAME `identicalFileCount` diagnostic on the way out (see the return statement).
  const changedScriptFiles: string[] = [];
  const changedTestFiles: string[] = [];
  // Card 17cd1f30: paths classified as NOT_HERMETIC (see EmitCompareGateResult.notHermeticExcluded's own
  // doc) — filtered OUT of changedTestFiles rather than blocking eligibility.
  const notHermeticExcluded: string[] = [];
  // Card 72769424 fix round: a DELETED test/*.mjs path — never a run target (nothing left to run), but
  // still a valid graph SEED for foldInTestImporters's reverse-BFS (an unrelated, unchanged test file can
  // still textually `import` a path that this diff just deleted — the edge is purely textual and doesn't
  // care whether the target still exists on disk). See foldInTestImporters's own doc for how this is used.
  const deletedTestFiles: string[] = [];
  // Card 8ee4f11e: paths short-circuited by the `isInertMergePath(p)` skip just below — see
  // EmitCompareGateResult.inertPathsSkipped's own doc for why this must be surfaced, not just dropped.
  const inertPathsSkipped: string[] = [];
  // Card 3fbd95e0: changed packages/daemon/assets/** paths — see EmitCompareGateResult.changedAssetPaths's
  // own doc for why ANY status here (not just "M") widens to the whole ASSET_READING_TEST_REPO_PATHS set.
  const changedAssetPaths: string[] = [];
  // Lazily loaded (only if a test/*.mjs path with a subdirectory actually shows up below) and cached for
  // the rest of this call. `undefined` = not attempted yet; `null` = attempted and failed (fail closed);
  // a `Set` = the real names, loaded straight from THIS diff's own worktree copy of test-daemon.mjs.
  let excludedDirNames: Set<string> | null | undefined;
  // Same lazy-load-and-cache shape as excludedDirNames above, but for the harness's NOT_HERMETIC export —
  // loaded only if a top-level (non-deleted) test/*.mjs path actually reaches the classification below.
  let notHermeticNames: Set<string> | null | undefined;
  // @decision 758486bc (Code Review round 4) — every lazy-fill site below awaits THIS shared promise,
  // never `loadExcludedTestDirNames`/`loadNotHermeticNames` directly, so a diff needing both
  // `excludedDirNames`/`notHermeticNames` still pays for exactly one spawn.
  let harnessSetExportsPromise: Promise<HarnessSetExportsResult> | undefined;
  const loadHarnessSetExportsOnce = (): Promise<HarnessSetExportsResult> => {
    if (harnessSetExportsPromise === undefined) {
      harnessSetExportsPromise = loadHarnessSetExports(worktreePath, HARNESS_CONFIG_LOAD_TIMEOUT_MS);
    }
    return harnessSetExportsPromise;
  };
  for (const line of entries) {
    const tab = line.indexOf("\t");
    // Card 4def0708: an unparseable line is the same mechanism-failure shape as the git error above — omit.
    if (tab < 0) return notApplicableHere(`unparseable diff line: ${line}`, "unparseable-diff");
    const status = line[0];
    const p = line.slice(tab + 1);
    // @decision b97f643d — skip a path already certified inert by isInertMergePath, REUSING that exact
    // predicate — never hand-copy a second one.
    //
    // Does NOT by itself guarantee an all-inert diff never reaches
    // this function via admission-time reclassification — the empty-set guard below covers that narrow,
    // judged-acceptable window.
    if (isInertMergePath(p)) { inertPathsSkipped.push(p); continue; }
    if (p.startsWith(EMIT_COMPARE_SRC_PREFIX) && p.endsWith(".ts")) {
      if (status !== "M") return notReducible(`non-modify status "${status}" on compiled file ${p}`);
      changedTsFiles.push(p);
      continue;
    }
    // Card 82662e98: packages/daemon/scripts/**/*.mjs — the harness/tooling scripts that fell to the
    // catch-all below before this existed (e.g. an added pointer comment in test-daemon.mjs forcing a
    // full ~17.5min gate for a provably comment-only change). Same fail-closed shape as the .ts arm above
    // (non-modify status refuses outright), but proven via a DIFFERENT compiler `target` — see the
    // transpile-compare loop below and EMIT_COMPARE_SCRIPTS_PREFIX's own doc for why.
    if (p.startsWith(EMIT_COMPARE_SCRIPTS_PREFIX) && p.endsWith(".mjs")) {
      if (status !== "M") return notReducible(`non-modify status "${status}" on script file ${p}`);
      changedScriptFiles.push(p);
      continue;
    }
    if (p.startsWith(EMIT_COMPARE_TEST_PREFIX) && p.endsWith(".mjs")) {
      // @decision 815b4b30 — an excluded-dir path (fixtures/, census/) isn't a test at all; reuses the REAL
      // EXCLUDED_DIR_NAMES via a dynamic import of this diff's own test-daemon.mjs — never hand-copy a second
      // list, and never re-check loom:not-a-test:/loom:gate-exempt: markers here (banner-only, no information).
      // @decision 44968963 — any such path then fails the WHOLE diff closed; never treat the forced full gate
      // on a fixture-plus-unrelated-test-file diff as a regression — the accepted cost of closing a real,
      // measured cross-consumer exposure (this repo's own fixtures have 6 and 3 consumers respectively).
      const relToTestDir = p.slice(EMIT_COMPARE_TEST_PREFIX.length);
      const dirSegments = relToTestDir.split("/").slice(0, -1);
      if (dirSegments.length > 0) {
        if (excludedDirNames === undefined) excludedDirNames = (await loadHarnessSetExportsOnce()).excludedDirNames;
        if (excludedDirNames === null) return notApplicableHere(`could not load EXCLUDED_DIR_NAMES from this diff's own scripts/test-daemon.mjs to classify ${p}`, "harness-config-unavailable");
        if (dirSegments.some((seg) => (excludedDirNames as Set<string>).has(seg))) {
          return notReducible(`${p} sits inside an EXCLUDED_DIR_NAMES subtree (fixtures/, census/) — its consumers outside this diff can't be proven unaffected, so the full gate runs (card 44968963)`);
        }
      }
      // Mirrors scripts/test-daemon.mjs's own discovery rule: an underscore-prefixed segment anywhere in
      // the path (the file's own name, or a containing directory like `_scratch/`) marks a non-test helper
      // whose standalone-run behavior isn't guaranteed — fail closed rather than assume it's safe to run
      // in isolation or silently drop it.
      if (p.split("/").some((seg) => seg.startsWith("_"))) return notReducible(`underscore-prefixed test helper path: ${p}`);
      // Code Review (card 2154b6ad): `buildReducedGateCommand` interpolates this path directly into a
      // shell-executed `&&` chain (`node ${p}`) — the prefix/suffix checks above constrain WHERE the path
      // sits, not WHICH CHARACTERS it contains. A committed filename carrying shell metacharacters (a
      // narrow but real vector — this repo's own gateCommand trust model already treats a committed
      // filename as untrusted-until-checked, see `--no-renames`'s doc above) must fail closed here, not
      // reach the shell string at all. Mirrors sibling card 344ce950's `identifyRetriableTestFile`, which
      // guards the analogous interpolation with an explicit allowlist before building its own command
      // string — same subsystem, same posture.
      if (!TEST_PATH_SHELL_SAFE_RE.test(p)) return notReducible(`test file path contains a character outside the shell-safe allowlist: ${p}`);
      if (status === "A" || status === "M") {
        // Card 17cd1f30: classify against the harness's own NOT_HERMETIC set BEFORE pushing into
        // changedTestFiles — a NOT_HERMETIC file is a real, maintained test (not a fixture/helper, both of
        // which already returned above), it just can't run through `test:daemon --only=` (needs a
        // manually-started daemon, a real `claude`, or mutates shared build output). Same bare-name shape
        // buildReducedGateCommand's own `--only=` list construction uses (repo-relative path minus the
        // test/ prefix and .mjs suffix), so a top-level file's name here is exactly what `NOT_HERMETIC`
        // keys on; a nested file's name (containing a `/`) can never match a NOT_HERMETIC entry, which is
        // correct — NOT_HERMETIC only ever names test/'s top-level files.
        if (notHermeticNames === undefined) notHermeticNames = (await loadHarnessSetExportsOnce()).notHermeticNames;
        if (notHermeticNames === null) return notApplicableHere(`could not load NOT_HERMETIC from this diff's own scripts/test-daemon.mjs to classify ${p}`, "harness-config-unavailable");
        const harnessName = p.slice(EMIT_COMPARE_TEST_PREFIX.length, -".mjs".length);
        if (notHermeticNames.has(harnessName)) {
          notHermeticExcluded.push(p);
        } else {
          changedTestFiles.push(p);
        }
      } else if (status === "D") {
        // Card 72769424 fix round: nothing left to run directly, but an unrelated, unchanged test file may
        // still textually import this now-gone path — see deletedTestFiles's own doc above.
        deletedTestFiles.push(p);
      }
      continue;
    }
    // Card 3fbd95e0: a changed packages/daemon/assets/** path never blocks eligibility on its own — unlike
    // the compiled-.ts case above, there is no transpile-identity (or any other) proof available for a
    // markdown/script asset, so this doesn't try to prove the change is behavior-inert. It only records the
    // path here; buildReducedGateCommand widens to run the whole certified ASSET_READING_TEST_REPO_PATHS set
    // whenever this list is non-empty. Every status (A/M/D) is accepted — a deleted or renamed-away asset can
    // still change what a certified test observes (e.g. skills-seed-asset-override-default.mjs reading the
    // real assets/skills/worker/SKILL.md), and unlike a test/*.mjs path this string is never interpolated
    // into a shell command (the reduced command always runs the FIXED certified list by name, never this
    // path), so none of the shell-safety/excluded-dir checks above apply here.
    if (p.startsWith(EMIT_COMPARE_ASSETS_PREFIX)) { changedAssetPaths.push(p); continue; }
    // Card 2db8a3dd: THE primary structural case — a repo whose sources don't live under
    // `packages/daemon/src|test/` (i.e. every project that isn't Loom's own daemon package) fails HERE, on
    // the first changed path, every time, before any other classification below is even consulted. Also
    // reachable on a Loom-shaped diff that touches a path this predicate simply doesn't cover (e.g.
    // `packages/web/**`) — equally `notApplicable`, for the identical reason: the predicate never had this
    // path in its domain, so "not reduced" would overclaim there too.
    //
    // Card fd0d34da: the two reachability shapes just described are exactly `EmitCompareNotApplicableKind`'s
    // `"repo-out-of-domain"` vs `"path-out-of-scope"` — first cheaply by rescanning the WHOLE
    // already-in-memory `entries` list (not just what this loop has consumed up to `p`) for ANY path this
    // predicate's four scopes cover at all. Rescanning the whole list, not just what's left to iterate, is
    // required BECAUSE of the FIRST-TERMINAL-WINS ordering this catch-all's own doc names: an in-scope path
    // can sit LATER in `entries`, after the one that just tripped this return, in the exact `fdf1291f`-shaped
    // diff that doc cites.
    const repoHasAnyInScopePath = entries.some((line) => {
      const t = line.indexOf("\t");
      return t >= 0 && isEmitCompareInScopePath(line.slice(t + 1));
    });
    if (repoHasAnyInScopePath) {
      return notApplicableHere(`path outside emit-compare scope: ${p}`, "path-out-of-scope");
    }
    // Code Review (blocking, this card): `repoHasAnyInScopePath` alone only ever answers "does THIS DIFF
    // touch an in-scope path" — it says NOTHING about the REPO's actual structure. Stamping
    // `"repo-out-of-domain"` purely off that would assert a fact about the REPO (per
    // `EmitCompareNotApplicableKind`'s own doc: "this repo's sources don't live under any scope … on ANY
    // diff") from evidence that only ever covers ONE diff — wrong for any Loom-shaped merge whose own
    // branch-vs-main diff happens to touch none of the four scopes (a `packages/web/**`-only fix, a
    // `packages/shared/**`-only change, a `CLAUDE.md`-only edit): those would read `repo-out-of-domain`
    // even though this repo plainly IS shaped like Loom's own daemon package — state 2 asserted for a
    // state 3 row, CONFIDENTLY WRONG rather than the honest `null` it replaces. So when the diff alone
    // doesn't decide it, ask the REPO's own tree directly: does `ref` (independent of what THIS diff
    // touches) actually contain any of the four scope directories at all. One bounded `git ls-tree` call,
    // firing ONLY on this already-rare catch-all branch — the same cost class as the `git diff
    // --name-status` call this function already makes unconditionally above.
    let repoIsInDomain: boolean;
    try {
      // @decision 868e0135 — `--end-of-options` before `ref` (the `--` pathspec separator stays after it):
      // `ref` is always a resolved sha (56c10535), but an option-shaped value would otherwise be consumed
      // as an ls-tree flag, silently shifting the first pathspec into the tree-ish slot.
      const lsTreeOut = (await withTimeout(
        git.raw(["ls-tree", "-d", "--name-only", "--end-of-options", ref, "--",
          EMIT_COMPARE_SRC_PREFIX.slice(0, -1), EMIT_COMPARE_TEST_PREFIX.slice(0, -1),
          EMIT_COMPARE_ASSETS_PREFIX.slice(0, -1), EMIT_COMPARE_SCRIPTS_PREFIX.slice(0, -1)]),
        timeoutMs, "git ls-tree (emit-compare repo-domain check)",
      )).trim();
      repoIsInDomain = lsTreeOut.length > 0;
    } catch {
      // FAIL CLOSED ON DOUBT (Code Review, this card): an unresolvable domain check must NEVER stamp the
      // confident-but-possibly-wrong `"repo-out-of-domain"` — that is the exact failure mode this fix
      // closes. Routed through the SAME mechanism-failure bucket every other git read in this function
      // already uses on error, never a guessed reducibility verdict.
      return notApplicableHere(`could not verify repo domain while classifying ${p} (path outside emit-compare scope)`, "git-operation-failed");
    }
    // `repoIsInDomain:true` means the SAME actionable fact `repoHasAnyInScopePath` above already covers —
    // the predicate applies to this repo, just not (fully, or at all) to THIS diff — so it shares
    // `"path-out-of-scope"`'s label; `repoIsInDomain:false` is the one case left where NEITHER the diff NOR
    // the repo's own tree has anything the predicate covers — a genuinely non-Loom-shaped project.
    return notApplicableHere(`path outside emit-compare scope: ${p}`, repoIsInDomain ? "path-out-of-scope" : "repo-out-of-domain");
  }

  if (changedTsFiles.length === 0 && changedScriptFiles.length === 0 && changedTestFiles.length === 0 && notHermeticExcluded.length === 0 && changedAssetPaths.length === 0) {
    // Every remaining changed path was a DELETED test/*.mjs file, or one already certified inert by
    // INERT_MERGE_PATH_PREFIXES and skipped above (card b97f643d) — an excluded-dir (fixtures/, census/)
    // path already returned notEligible above (card 44968963), so it can never reach here. Nothing left
    // needing behavioral proof, but nothing PROVEN inert either — fail closed rather than report a green
    // run that proved nothing.
    //
    // THIS is the actual backstop for the admission-time reclassification call site (service.ts ~:13064,
    // gated only on a PRIOR eligible classification, never re-consulting isInertMergeDiff) — the one path
    // by which a diff that has become entirely inert CAN still reach this function (see the skip's own doc
    // above the classification loop). The skip does not itself guarantee anything survives to classify;
    // this guard is what fails such a diff closed, not the skip.
    return notReducible("no eligible changed path left to prove inert");
  }
  // Card 17cd1f30 DoD-3: a diff whose ONLY changed test-shaped path(s) are NOT_HERMETIC (empty
  // changedTestFiles, non-empty notHermeticExcluded) stays eligible rather than failing closed here — the
  // caller declares the exclusion by name (see EmitCompareGateResult.notHermeticExcluded's own doc) and
  // buildReducedGateCommand emits build + static guards only, no test:daemon step. This is deliberately
  // NOT a refusal: the FULL gate never runs a NOT_HERMETIC file either (test:daemon with no --only resolves
  // to the discovered hermetic set, which already excludes it), so the reduced gate's coverage here is
  // exactly the full gate's own coverage — zero — not a regression the reduction introduced.

  // Card 72769424: widen changedTestFiles/notHermeticExcluded to the TRANSITIVE IMPORTERS of every already-
  // classified changed test file (see foldInTestImporters's own doc + docs/decisions/72769424-test-importer-
  // fold-in.md) — the fix for the fixed-wait-witness-guard-selftest.mjs gap: a diff touching only the guard
  // file used to reduce to `--only=fixed-wait-witness-guard` alone and never run the selftest that imports
  // from it. Only worth running when at least one test-shaped path (changed OR deleted — fix round, see
  // deletedTestFiles's own doc above) was actually classified above.
  if (changedTestFiles.length > 0 || notHermeticExcluded.length > 0 || deletedTestFiles.length > 0) {
    const folded = await foldInTestImporters(
      worktreePath, changedTestFiles, notHermeticExcluded, deletedTestFiles,
      async () => { if (excludedDirNames === undefined) excludedDirNames = (await loadHarnessSetExportsOnce()).excludedDirNames; return excludedDirNames; },
      async () => { if (notHermeticNames === undefined) notHermeticNames = (await loadHarnessSetExportsOnce()).notHermeticNames; return notHermeticNames; },
    );
    if (!folded.ok) {
      return folded.notApplicable ? notApplicableHere(folded.reason, folded.notApplicableKind) : notReducible(folded.reason);
    }
    changedTestFiles.push(...folded.addChangedTestFiles);
    notHermeticExcluded.push(...folded.addNotHermeticExcluded);
  }

  if (changedTsFiles.length > 0) {
    // TS-ONLY precondition (emitDecoratorMetadata / const enum) — N/A to changedScriptFiles below, which
    // is why this check is gated on changedTsFiles specifically rather than the combined condition on the
    // shared `typescript` import just below. See EMIT_COMPARE_SCRIPTS_PREFIX's own doc for why: a plain
    // `.mjs` script is never compiled by THIS repo's tsconfig chain at all (it's not part of the `dist/`
    // build `emitCompareSoundnessOk` reasons about), so neither mechanism can apply to it.
    if (!emitCompareSoundnessOk(worktreePath, WORKTREES_EMIT_COMPARE_SCOPE)) {
      return notReducible("soundness precondition (emitDecoratorMetadata / const enum) not verified");
    }
  }
  if (changedTsFiles.length > 0 || changedScriptFiles.length > 0) {
    let tsModule: TypeScriptModuleLike;
    try {
      const imported = (await import("typescript")) as unknown as { default?: TypeScriptModuleLike } & TypeScriptModuleLike;
      tsModule = imported.default ?? imported;
    } catch {
      return notApplicableHere("typescript module not resolvable (expected on a shipped end-user install)", "typescript-unresolvable");
    }
    if (changedTsFiles.length > 0) {
      // @decision 18bfe989 — narrow explicitly rather than cast: `noUncheckedIndexedAccess` types this
      // lookup `number | undefined`, and a missing ES2022 must fail this gate closed (notApplicableHere),
      // never reach `transpileModule` with an undefined target (see emit-compare-soundness.ts's anchor).
      const es2022Target = tsModule.ScriptTarget.ES2022;
      if (es2022Target === undefined) {
        return notApplicableHere("typescript module's ScriptTarget has no ES2022 (unexpected typescript resolution)", "typescript-unresolvable");
      }
      for (const p of changedTsFiles) {
        let before: string;
        let after: string;
        try {
          before = await withTimeout(git.raw(["show", `${baseSha}:${p}`]), timeoutMs, "git show (emit-compare before)");
        } catch {
          // Card 4def0708: a failed git read is the same mechanism-failure shape as the diff-read error above.
          return notApplicableHere(`could not read base content for ${p}`, "git-operation-failed");
        }
        try {
          after = await withTimeout(git.raw(["show", `${ref}:${p}`]), timeoutMs, "git show (emit-compare after)");
        } catch {
          return notApplicableHere(`could not read branch content for ${p}`, "git-operation-failed");
        }
        const outBefore = transpileIgnoringCommentsAndWhitespace(before, p, tsModule, es2022Target).outputText;
        const outAfter = transpileIgnoringCommentsAndWhitespace(after, p, tsModule, es2022Target).outputText;
        if (outBefore !== outAfter) return notReducible(`${p} is not transpile-identical — a real code change`);
      }
    }
    if (changedScriptFiles.length > 0) {
      // Card 82662e98: `.mjs` scripts, at `ESNext` (NOT ES2022, unlike the .ts loop above — see
      // EMIT_COMPARE_SCRIPTS_PREFIX's own doc). `ESNext` is the only target that structurally cannot
      // downlevel any syntax the compiler recognizes at all (there is no ceiling below "newest known"), so
      // this comparison is a faithful comment/whitespace-stripped REPRINT of what Node actually executes —
      // never a lossy transform that could map two genuinely different scripts onto the same output. Spiked
      // directly (2026-09-04): at `target: ES2022` (the .ts loop's choice), a `using` declaration explodes
      // into ~30 lines of disposal-helper machinery that has nothing to do with what an untranspiled `.mjs`
      // actually runs; at `ESNext` the same input reprints unchanged.
      const esNextTarget = tsModule.ScriptTarget.ESNext;
      if (esNextTarget === undefined) {
        return notApplicableHere("typescript module's ScriptTarget has no ESNext (unexpected typescript resolution)", "typescript-unresolvable");
      }
      for (const p of changedScriptFiles) {
        let before: string;
        let after: string;
        try {
          before = await withTimeout(git.raw(["show", `${baseSha}:${p}`]), timeoutMs, "git show (emit-compare before)");
        } catch {
          return notApplicableHere(`could not read base content for ${p}`, "git-operation-failed");
        }
        try {
          after = await withTimeout(git.raw(["show", `${ref}:${p}`]), timeoutMs, "git show (emit-compare after)");
        } catch {
          return notApplicableHere(`could not read branch content for ${p}`, "git-operation-failed");
        }
        const outBefore = transpileIgnoringCommentsAndWhitespace(before, p, tsModule, esNextTarget).outputText;
        const outAfter = transpileIgnoringCommentsAndWhitespace(after, p, tsModule, esNextTarget).outputText;
        if (outBefore !== outAfter) return notReducible(`${p} is not transpile-identical — a real code change`);
      }
    }
  }

  return {
    eligible: true, changedTestFiles, notHermeticExcluded, inertPathsSkipped, changedAssetPaths,
    // Card abaaf16e: the SAME population classified into changedTsFiles above, just surfaced — see
    // EmitCompareGateResult.changedTsPaths's own doc for why this drives buildReducedGateCommand's
    // CHANGED_TS_TEXT_SCANNER_REPO_PATHS fold-in and why it's deliberately NOT the combined identicalFileCount.
    changedTsPaths: changedTsFiles,
    // Card f862f9c5: mirrors changedTsPaths immediately above, surfacing the SAME changedScriptFiles
    // population classified during the loop — see EmitCompareGateResult.changedScriptFiles's own doc for
    // why this drives buildReducedGateCommand's CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS fold-in on its own,
    // independent trigger.
    changedScriptFiles,
    // Card 82662e98: both populations are "proven inert via parse/transpile comparison" — folded into ONE
    // diagnostic count rather than a second field threaded through every persisted consumer of this one
    // (sessions/service.ts's emitCompareIdenticalCount is part of a reconciliation event payload, not just
    // this function's own return). See EmitCompareGateResult.identicalFileCount's own doc.
    identicalFileCount: changedTsFiles.length + changedScriptFiles.length, notApplicable: false,
  };
}

/** Bound on evaluating the worktree's harness config in a child process. Card fd6d497e: raised from
 *  20_000 to align with {@link TEST_IMPORTER_SCAN_TIMEOUT_MS}/{@link DIRECT_DIST_IMPORTER_SCAN_TIMEOUT_MS}
 *  — measured ~2.2s idle (solo and 3-concurrent), but real full-gate load showed eligible:false/ok:false
 *  right at the old 20s bound. Every consumer fails closed, so the only cost of this raise is worst-case
 *  latency before falling back to the full gate, never a correctness regression. */
export const HARNESS_CONFIG_LOAD_TIMEOUT_MS = 120_000;

/** argv[1] of the child is deliberately `process.execPath` (a real, resolvable path that is NOT the script):
 *  test-daemon.mjs's main-module guard realpaths `process.argv[1]` and REFUSES (exit 1) if it can't, so under
 *  `-e` the first user arg must be a real path or loading the script for its exports would never succeed.
 *  Evaluated by the child (`node --input-type=module -e`). Imports the worktree's script ONCE and reads
 *  `EXCLUDED_DIR_NAMES`/`NOT_HERMETIC` off that SAME module object — folds what used to be two separate
 *  child spawns into one (card 758486bc; see {@link loadHarnessSetExports}'s own anchor for why). When
 *  `wantHermetic==='1'` it ALSO calls the harness's own exported `discoverHermeticTests(testDirAbs)` and
 *  reports its `hermetic` names (card cd3a5943 — see {@link loadHermeticTestNames}) — gated behind this
 *  flag so a caller that only needs the two Sets (e.g. {@link computeEmitCompareGate}'s hot reduced-gate
 *  path) never pays for the extra per-file content read `discoverHermeticTests` does. A missing/throwing
 *  `discoverHermeticTests` (a synthetic test-only harness script with no such export) never fails the
 *  whole probe — only the `HERMETIC` field degrades to `{ok:false}`.
 *  Prints ONE JSON line and force-exits so a stray timer/handle in the branch's module can't keep the child
 *  alive. An import that never settles (top-level await) makes node itself exit non-zero with no output. */
const HARNESS_EXPORT_PROBE_SOURCE =
  "const [url,testDirAbs,wantHermetic]=process.argv.slice(2);" +
  "import(url).then(m=>{" +
  "const pick=(n)=>{const v=m[n];return v instanceof Set?{ok:true,values:[...v].map(String)}:{ok:false}};" +
  "let hermetic={ok:false};" +
  "if(wantHermetic==='1'){try{const d=m.discoverHermeticTests(testDirAbs);if(d&&Array.isArray(d.hermetic))hermetic={ok:true,values:d.hermetic.map(String)};}catch{}}" +
  "process.stdout.write(JSON.stringify({ok:true,EXCLUDED_DIR_NAMES:pick('EXCLUDED_DIR_NAMES'),NOT_HERMETIC:pick('NOT_HERMETIC'),HERMETIC:hermetic})+'\\n');" +
  "process.exit(0)},()=>process.exit(2));";

/** The combined shape {@link loadHarnessSetExports} resolves — every field read from ONE child
 *  evaluation of the worktree's harness script. `ok:false` is a MECHANISM failure (spawn error, timeout,
 *  non-zero exit, unparseable output) — every field is `null` in that case, same fail-closed default the
 *  public wrappers already returned before this card. `ok:true` with an individual field `null` means
 *  the module loaded fine but that particular export was missing/malformed (or, for `hermeticNames`, was
 *  never requested — see {@link loadHarnessSetExports}'s `includeHermeticNames` param) — also fails
 *  closed, per-field, unchanged from the pre-758486bc per-export contract. */
interface HarnessSetExportsResult {
  ok: boolean;
  excludedDirNames: Set<string> | null;
  notHermeticNames: Set<string> | null;
  hermeticNames: Set<string> | null;
}
const HARNESS_SET_EXPORTS_FAIL: HarnessSetExportsResult = { ok: false, excludedDirNames: null, notHermeticNames: null, hermeticNames: null };

/** @decision fca110cf — the worktree's harness config is evaluated in a killable CHILD PROCESS, never an
 *  in-process `import()`. Fails closed to {@link HARNESS_SET_EXPORTS_FAIL} on ANY failure.
 *
 *  @decision 758486bc — ALWAYS spawns fresh, no cross-call cache in front of this (round 4 removed one
 *  that used to sit here — see the decision record for why).
 *
 *  `includeHermeticNames` (default `false`, card cd3a5943) opts into also running the harness's own
 *  `discoverHermeticTests()` in the SAME child evaluation — omit it (every pre-existing caller does) to
 *  stay byte-identical to before this param existed. */
function loadHarnessSetExports(
  worktreePath: string, timeoutMs: number, includeHermeticNames = false,
): Promise<HarnessSetExportsResult> {
  return new Promise((resolve) => {
    const scriptPath = path.join(worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs");
    const testDirAbs = path.join(worktreePath, "packages", "daemon", "test");
    let settled = false;
    let child: ChildProcess;
    const done = (r: HarnessSetExportsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killRemoveChild(child);
      done(HARNESS_SET_EXPORTS_FAIL);
    }, timeoutMs);
    try {
      // Windows: import() needs a file:// URL, never a bare drive-letter path (ERR_UNSUPPORTED_ESM_URL_SCHEME).
      child = spawn(process.execPath, [
        "--input-type=module", "-e", HARNESS_EXPORT_PROBE_SOURCE, process.execPath,
        pathToFileURL(scriptPath).href, testDirAbs, includeHermeticNames ? "1" : "0",
      ], {
        cwd: worktreePath, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      });
    } catch {
      done(HARNESS_SET_EXPORTS_FAIL);
      return;
    }
    // @decision db669d74 — shares {@link collectUtf8Stdout} with the test-importer scan's own child-stdout
    // collector, for the same chunk-split-corruption reason.
    const stdoutAcc = collectUtf8Stdout(child.stdout, 1_000_000);
    child.on("error", () => done(HARNESS_SET_EXPORTS_FAIL));
    child.on("close", (code) => {
      if (code !== 0) { done(HARNESS_SET_EXPORTS_FAIL); return; }
      try {
        const line = stdoutAcc.value.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
        const parsed = JSON.parse(line) as {
          ok?: boolean;
          EXCLUDED_DIR_NAMES?: { ok?: boolean; values?: unknown };
          NOT_HERMETIC?: { ok?: boolean; values?: unknown };
          HERMETIC?: { ok?: boolean; values?: unknown };
        };
        if (parsed.ok !== true) { done(HARNESS_SET_EXPORTS_FAIL); return; }
        const extract = (field: { ok?: boolean; values?: unknown } | undefined): Set<string> | null =>
          field?.ok === true && Array.isArray(field.values) ? new Set(field.values as string[]) : null;
        done({
          ok: true,
          excludedDirNames: extract(parsed.EXCLUDED_DIR_NAMES),
          notHermeticNames: extract(parsed.NOT_HERMETIC),
          hermeticNames: extract(parsed.HERMETIC),
        });
      } catch {
        done(HARNESS_SET_EXPORTS_FAIL);
      }
    });
  });
}

/** @decision 815b4b30 — loads the REAL `EXCLUDED_DIR_NAMES` Set from the diff's OWN `worktreePath` checkout
 *  (never this daemon's own installed copy, and never a hand-copied list). Fails closed to `null` on any
 *  error — a caller getting `null` MUST fail the whole diff closed.
 *
 *  ALWAYS spawns fresh (card 758486bc — no cross-call cache; see the decision record for why one was tried
 *  and removed). `computeEmitCompareGate` does NOT call this directly — it shares ONE spawn between this
 *  export and {@link loadNotHermeticNames} via its own local `loadHarnessSetExportsOnce`; this standalone
 *  export remains for any OTHER caller (and for tests) that only needs the one set. */
export function loadExcludedTestDirNames(
  worktreePath: string, timeoutMs: number = HARNESS_CONFIG_LOAD_TIMEOUT_MS,
): Promise<Set<string> | null> {
  return loadHarnessSetExports(worktreePath, timeoutMs).then((r) => r.excludedDirNames);
}

/**
 * Card 17cd1f30 — the same reuse shape as {@link loadExcludedTestDirNames} immediately above, applied to
 * the harness's OTHER driftable name set: `NOT_HERMETIC` (scripts/test-daemon.mjs). Loaded from THIS
 * diff's OWN worktree copy of the script (never a hand-copied second list — the precise pattern card
 * 815b4b30 established and forbids re-diverging from). ALWAYS spawns fresh, same as
 * {@link loadExcludedTestDirNames} — an edit to this set is seen on the VERY NEXT call, unconditionally,
 * because there is nothing cached to go stale. Same fail-closed contract: `null` on any load/parse error,
 * timeout or a non-`Set` export — a caller that gets `null` MUST fail the whole diff closed, same as the
 * `EXCLUDED_DIR_NAMES` case.
 */
export function loadNotHermeticNames(
  worktreePath: string, timeoutMs: number = HARNESS_CONFIG_LOAD_TIMEOUT_MS,
): Promise<Set<string> | null> {
  return loadHarnessSetExports(worktreePath, timeoutMs).then((r) => r.notHermeticNames);
}

/**
 * Card cd3a5943 — the single source of truth for "which `packages/daemon/test/**\/*.mjs` files are
 * actually runnable hermetic tests", for any caller that needs that set/count (today:
 * {@link computeDirectDistImporterRunSet}'s cap denominator and candidate classification). Returns the
 * harness's own `discoverHermeticTests()` result's `hermetic` names (bare, extension-stripped, `/`-
 * separated — same shape {@link computeDirectDistImporterRunSet} already works in), evaluated against
 * THIS worktree's OWN `scripts/test-daemon.mjs` and `test/` dir in the same killable child process
 * {@link loadExcludedTestDirNames}/{@link loadNotHermeticNames} already use — never a hand-rolled
 * re-implementation of the EXCLUDED_DIR_NAMES/underscore-helper/NOT_HERMETIC/`looksLikeTest` rule (see
 * {@link computeDirectDistImporterRunSet}'s own leading doc comment for why that hand-copy was retired).
 * Same fail-closed contract as its siblings: `null` on any load/parse error or timeout — a caller that
 * gets `null` MUST fail closed, same as the `EXCLUDED_DIR_NAMES`/`NOT_HERMETIC` case. ALWAYS spawns fresh
 * (card 758486bc's no-cross-call-cache rule applies here too).
 */
export function loadHermeticTestNames(
  worktreePath: string, timeoutMs: number = HARNESS_CONFIG_LOAD_TIMEOUT_MS,
): Promise<Set<string> | null> {
  return loadHarnessSetExports(worktreePath, timeoutMs, true).then((r) => r.hermeticNames);
}

/** @decision bafc68e7 — never re-add a local soundness-predicate/walker/transpile-helper copy here; they
 *  live in the shared `emit-compare-soundness.ts` module now, parameterized by this file's own scope. */
const WORKTREES_EMIT_COMPARE_SCOPE: EmitCompareSoundnessScope = {
  tsconfigRelPaths: ["tsconfig.base.json", path.join("packages", "daemon", "tsconfig.json")],
  srcDirRelPaths: [path.join("packages", "daemon", "src")],
};

/** A safety margin under cmd.exe's real ~8191-char command-line ceiling for a reduced gate's `--only=`
 *  step (shell:true, gate-runner.ts) — see {@link buildReducedGateCommand}'s own doc.
 *  @decision 92be634e — do not raise this toward the real ceiling, or shrink its margin, without
 *  re-deriving both the real ceiling and the step's own prefix length. */
export const REDUCED_GATE_ONLY_INLINE_MAX_CHARS = 6000;

/** Thrown by {@link buildReducedGateCommand} when the `--only=` selection exceeds
 *  {@link REDUCED_GATE_ONLY_INLINE_MAX_CHARS} and either no `onlyFilePath` was supplied, or writing it failed.
 *  @decision 92be634e — never resolve either case to a silent fallback onto the over-length inline `--only=`. */
export class ReducedGateOnlyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReducedGateOnlyFileError";
  }
}

/** Real, production default for {@link BuildReducedGateCommandOpts.writeOnlyFile}. `onlyFilePath`'s own
 *  parent (`GATE_SPILL_DIR`, orchestration/gate-spill.ts) is never pre-created on a fresh LOOM_HOME — this
 *  mkdir's it lazily first, same "caller mkdir's it on first write" contract {@link gateOnlyListPath}'s own
 *  doc already states, mirroring `gateSpillPath`'s identical contract for the sibling output-spill file.
 *  Exported only so a test can call it directly without going through `buildReducedGateCommand`'s own
 *  threshold logic. */
export function writeReducedGateOnlyFileReal(onlyFilePath: string, content: string): void {
  fs.mkdirSync(path.dirname(onlyFilePath), { recursive: true });
  fs.writeFileSync(onlyFilePath, content, "utf8");
}

export interface BuildReducedGateCommandOpts {
  /** Where to write the `--only=` selection when it crosses {@link REDUCED_GATE_ONLY_INLINE_MAX_CHARS}.
   *  A production caller derives this from its own opId (e.g. `gateOnlyListPath(opId)`,
   *  orchestration/gate-spill.ts). Omitted is fine as long as the selection never crosses the threshold.
   *  @decision 92be634e — do not default this to an implicit `os.tmpdir()` path when it's missing and the
   *  threshold IS crossed — throw `ReducedGateOnlyFileError` instead; see the docs/decisions record. */
  onlyFilePath?: string;
  /** Injectable writer, defaulting to {@link writeReducedGateOnlyFileReal}. A test crossing the threshold
   *  can inject a fake here to assert the written content without touching the real filesystem; a test
   *  proving the real end-to-end behavior (real file, real shell spawn) omits it to exercise the real
   *  default. Any throw from this — injected or real — is wrapped in a {@link ReducedGateOnlyFileError}
   *  naming `onlyFilePath` and the underlying cause; it must never be swallowed into a silent fallback to
   *  the over-length inline `--only=` form. */
  writeOnlyFile?: (onlyFilePath: string, content: string) => void;
}

/** @decision dd4349ff — a changed test file runs THROUGH THE HARNESS (`test:daemon --only=`), never as
 *  bare `node <path>` — a bare invocation left a hermetic-env-needing file unable to even start (exit 99,
 *  0s, no assertion run). `changedTestFiles` must already exclude `NOT_HERMETIC` names; never re-filter here.
 *  @decision abaaf16e — `changedTsPaths` folds {@link CHANGED_TS_TEXT_SCANNER_REPO_PATHS} into `steps` (bare
 *  `node <path>`, the {@link STATIC_GUARD_REPO_PATHS} shape), never into `testPaths`/`--only=` — every member
 *  sets up its own hermetic env, so it needs none of what the harness wrapper provides.
 *  @decision f862f9c5 — `changedScriptFiles` folds {@link CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS} in on its
 *  OWN condition, independent of `changedTsPaths` — never gate it on the `.ts` trigger or the combined
 *  `identicalFileCount`. A diff can set either trigger, both, or neither.
 *  @decision 92be634e — do not re-derive a second overflow mechanism for the `--only=` step; reuse
 *  `--only-file=` (scripts/test-daemon.mjs, card cee17efe) exactly as below. */
export function buildReducedGateCommand(
  input: Pick<EmitCompareGateResult, "changedTestFiles" | "changedAssetPaths" | "changedTsPaths" | "changedScriptFiles">,
  opts: BuildReducedGateCommandOpts = {},
): string {
  const { changedTestFiles, changedAssetPaths, changedTsPaths, changedScriptFiles } = input;
  const steps = ["pnpm build", ...STATIC_GUARD_REPO_PATHS.map((p) => `node ${p}`)];
  if (changedTsPaths.length > 0) steps.push(...CHANGED_TS_TEXT_SCANNER_REPO_PATHS.map((p) => `node ${p}`));
  if (changedScriptFiles.length > 0) steps.push(...CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS.map((p) => `node ${p}`));
  const testPaths = changedAssetPaths.length > 0
    ? [...new Set([...changedTestFiles, ...ASSET_READING_TEST_REPO_PATHS])]
    : changedTestFiles;
  if (testPaths.length > 0) {
    const names = testPaths.map((p) => p.slice(EMIT_COMPARE_TEST_PREFIX.length, -".mjs".length));
    const inlineStep = `pnpm --filter @loom/daemon test:daemon --only=${names.join(",")}`;
    if (inlineStep.length > REDUCED_GATE_ONLY_INLINE_MAX_CHARS) {
      if (!opts.onlyFilePath) {
        throw new ReducedGateOnlyFileError(
          `the reduced gate's --only selection (${names.length} file(s), ${inlineStep.length} chars) exceeds ` +
          `the safe inline command-line length (${REDUCED_GATE_ONLY_INLINE_MAX_CHARS}) and no onlyFilePath was ` +
          "supplied — the caller must provide one rather than defaulting to an implicit temp path",
        );
      }
      try {
        (opts.writeOnlyFile ?? writeReducedGateOnlyFileReal)(opts.onlyFilePath, names.join("\n"));
      } catch (err) {
        throw new ReducedGateOnlyFileError(
          `could not write the reduced gate's --only selection (${names.length} file(s)) to ${opts.onlyFilePath}: ` +
          `${(err as Error).message}`,
        );
      }
      steps.push(`pnpm --filter @loom/daemon test:daemon --only-file=${JSON.stringify(opts.onlyFilePath)}`);
    } else {
      steps.push(inlineStep);
    }
  }
  return steps.join(" && ");
}

/** @decision c0d0eac9 round 4 (finding B1) — tri-state outcome for a sub-check: `"pass"`/`"fail"` (the
 *  check ran, DEFINITIVE either way) vs `"error"` (it could not run — never collapse into `"fail"`).
 *  {@link verifyPersistedPathSet} and {@link branchContentLandedInCommit} both return this. */
type CheckVerdict = "pass" | "fail" | "error";

/** @decision c0d0eac9 round 5 (finding 1) — a value must match this shape before it ever reaches git;
 *  `Loom-Worker-Base` itself is parsed far more loosely (`/^\S+$/`), so this is the real shape gate. */
const OBJECT_ID_SHAPE_RE = /^[0-9a-f]{40,64}$/;

/**
 * Resolves a candidate-supplied, trailer-derived hex string to its own RAW COMMIT object id — `null` on
 * any ambiguity (non-hex shape, nonexistent, resolves to a DIFFERENT object than its own literal text, or
 * exists but isn't a commit). A thrown git error is NOT caught here — it propagates to the caller's own
 * try/catch, which must classify it as `"error"`, never collapse it into this function's definitive `null`.
 *
 * @decision c0d0eac9 round 5-7 — never peel a TAG through to its commit, and never accept a resolution
 * that doesn't echo the input back EXACTLY (round 7: a 41-64-hex value can resolve as a REF NAME instead
 * of the literal object id when a same-named ref also exists).
 * @decision b8122303 — shared by {@link verifyPersistedPathSet}'s `baseOverride` and
 * {@link verifyReviewedTipChain}'s `live`; never re-implement this at a third call site.
 */
async function resolveExactTrailerObjectId(
  git: Pick<SimpleGit, "raw">, timeoutMs: number, candidate: string,
): Promise<string | null> {
  if (!OBJECT_ID_SHAPE_RE.test(candidate)) return null;
  // @decision 868e0135 — `--end-of-options` added: round-2 CR retracted the compound-suffix exemption this relied on.
  const resolved = (await withTimeout(
    git.raw(["-c", "core.warnAmbiguousRefs=false", "rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{object}`]),
    timeoutMs, "git rev-parse --verify --quiet (trailer-derived object existence)",
  )).trim();
  if (resolved === "" || resolved !== candidate) return null;
  const objectType = (await withTimeout(
    git.raw(["-c", "core.warnAmbiguousRefs=false", "cat-file", "-t", resolved]),
    timeoutMs, "git cat-file -t (trailer-derived object type)",
  )).trim();
  return objectType === "commit" ? resolved : null;
}

/** @decision 756a2cd8 — verifies a squash commit's persisted path-set trailer purely from its OWN ancestry
 *  (survives branch deletion + `git gc`).
 *
 *  A `"pass"` proves only the SAME FILE SET, never the same CONTENT —
 *  never read it as content-verified; two branches sharing an identical path set are NOT distinguishable by
 *  this check alone.
 *
 * @decision c0d0eac9 round 5 (finding 1) — `baseOverride` is CANDIDATE-SUPPLIED; malformed/nonexistent is
 * the candidate's own claim being false, a DEFINITIVE `"fail"`, never `"error"` — never catch-and-collapse
 * this existence check into the same bucket as a genuine git/spawn failure.
 */
async function verifyPersistedPathSet(
  git: Pick<SimpleGit, "raw">, timeoutMs: number, sha: string, expectedDigest: string, baseOverride?: string,
): Promise<CheckVerdict> {
  try {
    let parent: string;
    if (baseOverride !== undefined) {
      // @decision b8122303 — shared with {@link verifyReviewedTipChain}'s `live`; see
      // {@link resolveExactTrailerObjectId}'s own doc for the c0d0eac9 round 5-7 mechanics.
      const resolved = await resolveExactTrailerObjectId(git, timeoutMs, baseOverride);
      if (resolved === null) return "fail";
      parent = resolved;
    } else {
      // @decision c0d0eac9 round 6 (finding 2) — `${sha}^` throws for a PARENTLESS (root) commit — a
      // real shape (a candidate merged on as a second parent). Read the parent list first instead.
      // @decision 4b559feb — `--end-of-options` before `sha`: defense-in-depth, same class as 868e0135.
      const parentsOut = (await withTimeout(
        git.raw(["rev-list", "--parents", "-n1", "--end-of-options", sha]), timeoutMs, "git rev-list --parents -n1 (path-set verify parent)",
      )).trim();
      const tokens = parentsOut.split(/\s+/).filter(Boolean);
      // @decision c0d0eac9 round 7 (finding 3) — `sha` is already known-real (it came from the same
      // `git log` scan that found this candidate), so empty/mismatched output here is a FAULT, never a
      // legitimate "no parent" — only a genuine first token echoing `sha` back may answer that question.
      if (tokens.length === 0 || tokens[0] !== sha) return "error";
      if (tokens.length < 2) return "fail"; // no parent — a root commit; definitive, never an error
      parent = tokens[1]!;
    }
    const actual = await changedPathSetDigest(git, parent, sha, timeoutMs);
    return actual === expectedDigest ? "pass" : "fail";
  } catch {
    return "error";
  }
}

/**
 * Bound on the `sha..refTip` ANCESTRY-PATH walk {@link classifyAgainstLedgerUncached}'s RECORDED leg uses
 * to find candidate ledger-row tips (round 2's original per-row scan replaced by round 4's ancestry-path
 * walk — see docs/decisions/c13666c6-*.md). Past this many commits, fails CLOSED (`"unrecorded"`), logged
 * once per (sha, scanned-ref tip, max ledger row id) via the memo below. **Round 5: this no longer bounds
 * the trivial solo/batch-final case at all** — see {@link classifyAgainstLedgerUncached}'s own doc for why
 * a direct `sha === row.tip` match is checked FIRST, with zero git spawns and no cap, before this walk ever
 * runs.
 *
 * @decision c13666c6 round 4/5 — applies ONLY to the RECORDED leg's walk, in ANCESTRY-PATH commits (not
 * first-parent-only — a merge-heavy stretch reaches it sooner). Decision record's round 5 has the measured
 * real-repo gap and walk cost.
 */
export const GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP = 20000;

/**
 * Bound (round 5, card c13666c6) on how many SURVIVING candidate ledger rows {@link
 * classifyAgainstLedgerUncached}'s RECORDED leg will spawn a `git rev-list --first-parent row.base..row.tip`
 * call for, after the zero-spawn prune (round 5 fix 1(b)) has already dropped every row that CANNOT
 * possibly contain `sha`. **Round 6 correction:** this is NOT what bounds a genuinely unrecorded `sha`'s
 * cost against many unrelated rows — the PRUNE is (under the writer invariant, an unrecorded `sha` has
 * ZERO survivors once pruned, so this cap never even sees that case). This cap instead binds only on a
 * ledger shape the writers cannot produce — duplicate rows, or an invariant violation — where SEVERAL rows
 * genuinely, simultaneously contain `sha`; see the decision record's round 6 section for the measured
 * distinction and a possible follow-up (deduping survivors by `(base, tip)`).
 *
 * @decision c13666c6 round 5/6 — past this many GENUINELY-containing survivors, fails CLOSED
 * (`"unrecorded"`) — a real landing can read as unmerged on this pathological shape. Same posture as
 * {@link GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP}'s own overflow.
 */
const GONE_BRANCH_LEDGER_ROW_SPAWN_CAP = 8;

/**
 * Rate-limits the `"error"`-verdict LOG line (round 4, card c13666c6) — the VERDICT itself stays uncached
 * and fail-closed always (see {@link LedgerCutoverVerdict}'s own doc); this bounds only how often the same
 * repeatedly-failing `(sha, scope)` pair spams the log (e.g. once per board read). Keyed by
 * `${sha}\u0000${scopeKey}` — independent of `refTip`/`maxRowId`, since the failure itself doesn't depend
 * on those. Process-local, bounded at {@link GONE_BRANCH_LEDGER_ERROR_LOG_MAX}, insertion-order eviction.
 */
const GONE_BRANCH_LEDGER_ERROR_LOG_RATE_LIMIT_MS = 10 * 60 * 1000;
const GONE_BRANCH_LEDGER_ERROR_LOG_MAX = 500;
const goneBranchLedgerErrorLogTimestamps = new Map<string, number>();

function logGoneBranchLedgerErrorRateLimited(sha: string, scopeKey: string, message: string): void {
  const key = `${sha}\u0000${scopeKey}`;
  const now = Date.now();
  const last = goneBranchLedgerErrorLogTimestamps.get(key);
  if (last !== undefined && now - last < GONE_BRANCH_LEDGER_ERROR_LOG_RATE_LIMIT_MS) return;
  if (last === undefined && goneBranchLedgerErrorLogTimestamps.size >= GONE_BRANCH_LEDGER_ERROR_LOG_MAX) {
    const oldestKey = goneBranchLedgerErrorLogTimestamps.keys().next().value;
    if (oldestKey !== undefined) goneBranchLedgerErrorLogTimestamps.delete(oldestKey);
  }
  goneBranchLedgerErrorLogTimestamps.delete(key); // re-set moves it to the end — eviction targets truly stale keys
  goneBranchLedgerErrorLogTimestamps.set(key, now);
  // eslint-disable-next-line no-console
  console.warn(message);
}

/** {@link classifyAgainstLedger}'s verdict. `"skip"` means `deps.goneBranchLedger` was absent or the
 *  project's ledger holds no rows for this scope — the gate makes no claim either way. `"error"` (card
 *  c13666c6 round 3) means a git call this classification needed failed transiently (a timeout, a read
 *  error, a boundary sha that no longer resolves) — fails closed exactly like `"unrecorded"` but is NEVER
 *  memoized, so a later clean lookup for the same sha can still resolve correctly instead of being wedged
 *  behind a cached failure forever. */
type LedgerCutoverVerdict = "skip" | "pre-ledger" | "recorded" | "unrecorded" | "error";

/**
 * Round-2 bound on {@link goneBranchLedgerVerdictCache}'s own size — process-local, so this bounds worst-
 * case memory, never correctness (an evicted entry just recomputes, same as a cold cache).
 */
const GONE_BRANCH_LEDGER_VERDICT_CACHE_MAX = 500;

/**
 * Memoizes {@link classifyAgainstLedgerUncached}'s verdict per `(sha, resolved-ref-tip, maxRowId)` — card
 * c13666c6 round 2 (finding: `tasks_list` fans this lookup out across every card on every board read, so
 * a repeat lookup for the SAME sha/ref/ledger-state must cost nothing). `maxRowId` in the key is what
 * invalidates a stale entry: a new landing bumps it, so a later lookup for the same sha naturally misses
 * and recomputes against the now-larger ledger, never serving a memo that predates a row that might now
 * matter. Simple insertion-order eviction once {@link GONE_BRANCH_LEDGER_VERDICT_CACHE_MAX} is exceeded.
 */
const goneBranchLedgerVerdictCache = new Map<string, LedgerCutoverVerdict>();

function cacheGoneBranchLedgerVerdict(key: string, verdict: LedgerCutoverVerdict): void {
  if (goneBranchLedgerVerdictCache.size >= GONE_BRANCH_LEDGER_VERDICT_CACHE_MAX) {
    const oldestKey = goneBranchLedgerVerdictCache.keys().next().value;
    if (oldestKey !== undefined) goneBranchLedgerVerdictCache.delete(oldestKey);
  }
  goneBranchLedgerVerdictCache.set(key, verdict);
}

/**
 * The uncached per-sha classification, round 4's acceptance RULE (card c13666c6) — round 5 only reorders/
 * prunes the RECORDED leg's OWN internal work for performance, see the decision record's round 5 section:
 * - `"pre-ledger"` when `sha` is a genuine ancestor of (or equal to) the scope's durable boundary — a
 *   bare, UNBOUNDED ancestor check (no first-parent requirement, no cap): the boundary is a FIXED sha
 *   whose own ancestry can never change (canonicalGit neutralizes replace-refs/grafts/shallow/commit-
 *   graph — see `boundedGit`), so a forgery planted AFTER the boundary can never become its ancestor,
 *   regardless of whether it was later merged in via a first or second parent.
 * - `"recorded"` when `sha` is BOTH a genuine ancestor of `refTip` (any path) AND a literal member of some
 *   ledger row's own first-parent range (`sha === row.tip`, or `sha` appears in `rev-list --first-parent
 *   row.base..row.tip`). Candidate rows are found via one bounded `rev-list --ancestry-path sha..refTip`
 *   (ALL parents — restricted to commits that are both descendants of `sha` and ancestors of `refTip`, so
 *   it correctly follows a merge's SECOND parent, unlike a first-parent-only walk) — but ONLY after the
 *   trivial `sha === row.tip` case is checked directly, with zero spawns and no cap (round 5).
 * - `"unrecorded"` when neither leg holds; `"error"` when a git call either leg needed failed transiently
 *   (never cached — see {@link LedgerCutoverVerdict}'s own doc; the LOG is rate-limited, not the verdict).
 *
 * @decision c13666c6 round 4 — a forged `F` landed as a merge's SECOND parent fails the RECORDED leg: no
 * row's own first-parent range ever contains `F` (the row for whatever landed ON `F`'s merge starts AT or
 * after it). Never accept on `rows.length > 0` alone — the PER-ROW membership check is what discriminates.
 *
 * @decision c13666c6 round 4 — never reintroduce a first-parent-of-`refTip` precondition ahead of EITHER
 * leg (round 3's defect, closed here) — it rejected a real landing the moment ANY legitimate merge (e.g.
 * `project_checkout_branch create:true`) sat between it and `refTip` (round-3 review's probe4 A/B).
 *
 * @decision c13666c6 round 5/6 — the zero-spawn row prune is an ELIMINATION filter, never a membership
 * proof, and is PERF/AVAILABILITY-only, never a soundness guard — dropping it costs availability (more
 * row-spawn-cap overflow), never soundness (the per-row walk alone already refuses ADV1-4 regardless).
 */
async function classifyAgainstLedgerUncached(
  git: Pick<SimpleGit, "raw">, timeoutMs: number, sha: string, refTip: string, ledger: GoneBranchLedgerFacts,
): Promise<LedgerCutoverVerdict> {
  const boundary = ledger.resolveBoundary();
  if (boundary === null) return "skip";

  // Boundary existence (round 3): a separate, explicit probe from the merge-base call below, so "the
  // boundary itself no longer resolves" gets its OWN named log distinct from a generic transient
  // merge-base failure. Never cached, so a later repair (the app_meta row healed, or the object restored)
  // is retried rather than refused forever.
  try {
    // `-t` (type), never `-e` (exists): `simple-git`'s `raw()` was measured to resolve `cat-file -e` on a
    // nonexistent object with empty output instead of rejecting (its exit-code handling doesn't flag it),
    // while `-t` on the same input correctly rejects via a real "could not get object info" fatal error.
    await withTimeout(git.raw(["cat-file", "-t", boundary]), timeoutMs, "git cat-file -t (ledger boundary existence)");
  } catch {
    logGoneBranchLedgerErrorRateLimited(sha, ledger.scopeKey,
      `[git] classifyAgainstLedger: the scope's own pre-ledger boundary ${boundary.slice(0, 7)} no longer ` +
      "resolves in this repo — refusing to trust this lookup without caching the result (card c13666c6 round 4)");
    return "error";
  }

  // PRE-LEDGER (round 4): dropped round 3's first-parent precondition + cap entirely — see this
  // function's own doc for why a bare, unbounded ancestor check against the fixed boundary is sound.
  try {
    // @decision 868e0135 — `--end-of-options` right after "merge-base": both sha and boundary are resolved shas/ledger-internal values.
    const mb = (await withTimeout(
      git.raw(["merge-base", "--end-of-options", sha, boundary]), timeoutMs, "git merge-base (ledger boundary check)",
    )).trim();
    if (mb === sha) return "pre-ledger";
  } catch {
    logGoneBranchLedgerErrorRateLimited(sha, ledger.scopeKey,
      `[git] classifyAgainstLedger: the ${sha.slice(0, 7)} pre-ledger boundary check failed (transient git ` +
      "error) — refusing to trust this lookup without caching the result (card c13666c6 round 4)");
    return "error";
  }

  // RECORDED (round 4/5): sha must be a genuine ancestor of refTip, AND literally inside some ledger row's
  // own first-parent range — see this function's own doc for why this replaces round 3's precondition.
  try {
    if (sha !== refTip) {
      // @decision 868e0135 — `--end-of-options` right after "merge-base": same reason as the pre-ledger boundary check above.
      const mbRef = (await withTimeout(
        git.raw(["merge-base", "--end-of-options", sha, refTip]), timeoutMs, "git merge-base (ledger ancestor-of-refTip check)",
      )).trim();
      if (mbRef !== sha) return "unrecorded"; // sha isn't even reachable (by any path) from refTip
    }

    // Round 5 fix 1(a)/minor 3: check sha directly against the ledger FIRST — zero git spawns, no cap —
    // before the (bounded) ancestry-path walk below ever runs. This is what gives the trivial solo/batch-
    // final case (sha === some row's own tip) an UNBOUNDED horizon at zero extra cost: the capped walk
    // below exists only to find an intra-batch INTERMEDIATE candidate, never this direct case.
    if (ledger.rowsByTips([sha]).some((row) => row.tip === sha)) return "recorded";
    if (sha === refTip) return "unrecorded"; // no further candidates possible when sha IS refTip

    // @decision 4b559feb — `--end-of-options` before the range: defense-in-depth, same class as 868e0135.
    const out = await withTimeout(
      git.raw(["rev-list", "--ancestry-path", `--max-count=${GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP + 1}`, "--end-of-options", `${sha}..${refTip}`]),
      timeoutMs, "git rev-list --ancestry-path (ledger candidate tips)",
    );
    const candidateTips = out.split("\n").map((s) => s.trim()).filter(Boolean);
    if (candidateTips.length > GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP) {
      // eslint-disable-next-line no-console
      console.warn(`[git] classifyAgainstLedger: the ${sha.slice(0, 7)}..${refTip.slice(0, 7)} ancestry-path ` +
        `exceeds the ${GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP}-commit scan cap — treating as unrecorded rather than ` +
        "scanning further; card c13666c6 round 4");
      return "unrecorded";
    }
    if (candidateTips.length === 0) return "unrecorded"; // no intra-batch intermediate candidate possible

    // Round 5 fix 1(b): prune WITHOUT any git spawn — a row can contain sha only if row.base is a PROPER
    // ancestor of sha. row.base === sha fails that (the half-open range excludes the base itself); row.base
    // being a member of candidateTips also fails it, since every candidateTips member is, by construction
    // of --ancestry-path, a DESCENDANT of sha — and sha's own ancestor can never also be its descendant.
    const descendantsOfSha = new Set(candidateTips);
    const rows = ledger.rowsByTips(candidateTips);
    const survivors = rows.filter((row) => row.base !== sha && !descendantsOfSha.has(row.base));
    if (survivors.length === 0) return "unrecorded";
    if (survivors.length > GONE_BRANCH_LEDGER_ROW_SPAWN_CAP) {
      // eslint-disable-next-line no-console
      console.warn(`[git] classifyAgainstLedger: ${sha.slice(0, 7)} has ${survivors.length} surviving candidate ` +
        `ledger rows, past the ${GONE_BRANCH_LEDGER_ROW_SPAWN_CAP}-row spawn cap — treating as unrecorded rather ` +
        "than spawning a membership check for each; card c13666c6 round 5");
      return "unrecorded";
    }

    // Round 5 fix 1(c): spawn the actual membership walk only for rows the prune above could not rule out.
    // @decision 4b559feb — `--end-of-options` before the range: defense-in-depth, same class as 868e0135.
    for (const row of survivors) {
      const out2 = await withTimeout(
        git.raw(["rev-list", "--first-parent", "--end-of-options", `${row.base}..${row.tip}`]),
        timeoutMs, "git rev-list --first-parent (ledger row-membership check)",
      );
      const rowMembers = out2.split("\n").map((s) => s.trim()).filter(Boolean);
      if (rowMembers.includes(sha)) return "recorded"; // a batch row's own intermediate candidate
    }
    return "unrecorded";
  } catch {
    logGoneBranchLedgerErrorRateLimited(sha, ledger.scopeKey,
      `[git] classifyAgainstLedger: the ${sha.slice(0, 7)} recorded-leg check failed (transient git error) — ` +
      "refusing to trust this lookup without caching the result (card c13666c6 round 4)");
    return "error";
  }
}

/**
 * The memoizing wrapper every caller actually uses — resolves `ref` to its current sha ONCE (so the
 * per-sha walk below is pinned to an exact chain, not a moving branch name), builds the cache key, and
 * logs the "refusing to treat as landed" warning exactly once per key (a cache HIT never re-logs — card
 * c13666c6 round 2, closing the "logs on every board read" finding). An `"error"` verdict (round 3) is
 * never written to the cache, by returning before {@link cacheGoneBranchLedgerVerdict} either way.
 */
async function classifyAgainstLedger(
  git: Pick<SimpleGit, "raw">, timeoutMs: number, sha: string, ref: string, ledger: GoneBranchLedgerFacts,
): Promise<LedgerCutoverVerdict> {
  const maxRowId = ledger.maxRowId();
  if (maxRowId === null) return "skip";
  let refTip: string;
  try {
    // @decision abbda4f5 — `--verify` + `--end-of-options` right before `ref` (measured: `--end-of-options`
    // ALONE, with no `--verify`, makes rev-parse echo "--end-of-options" back as a literal extra output
    // line even for a well-formed ref — `--verify` is what makes it a true no-op for the ordinary case).
    refTip = (await withTimeout(git.raw(["rev-parse", "--verify", "--end-of-options", ref]), timeoutMs, "git rev-parse (ledger per-sha ref resolve)")).trim();
  } catch {
    logGoneBranchLedgerErrorRateLimited(sha, ledger.scopeKey,
      `[git] classifyAgainstLedger: could not resolve ref "${ref}" to a sha — refusing to trust this ` +
      "lookup without caching the result (card c13666c6 round 4)");
    return "error"; // fail closed — never cached, so a transient resolve failure can't wedge future lookups
  }
  const cacheKey = `${sha}\u0000${refTip}\u0000${maxRowId}`;
  const cached = goneBranchLedgerVerdictCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const verdict = await classifyAgainstLedgerUncached(git, timeoutMs, sha, refTip, ledger);
  if (verdict === "error") return verdict; // round 3 — never memoized
  if (verdict === "unrecorded") {
    // eslint-disable-next-line no-console
    console.warn(`[git] classifyAgainstLedger: ${sha.slice(0, 7)} carries a well-formed Loom trailer for a branch ` +
      "that is now gone, but is neither pre-ledger nor reachable from any row of Loom's own " +
      "mainline_landed_commits ledger — refusing to treat it as a real landing (card c13666c6)");
  }
  cacheGoneBranchLedgerVerdict(cacheKey, verdict);
  return verdict;
}

/** TEST-ONLY direct passthrough (card abbda4f5): every production path into {@link classifyAgainstLedger}
 *  couples its `ref` to the SAME `base`/`ref` value a preceding `git log` call already uses (and that
 *  call now fails first on an option-shaped value, via this card's OWN sibling fix) — so this site's own
 *  rev-parse guard has no public call path to exercise independently. Zero behavior change; mirrors
 *  {@link worktreeAddLandedTestOnly}'s own pattern. */
export const classifyAgainstLedgerForTest = classifyAgainstLedger;

/**
 * The branch-gone landing's FULL verification, shared by {@link findLandedSquashCommit} and {@link
 * resolveMergedCommitMapHit} so the two can never drift apart on this check again: the existing
 * self-consistent {@link verifyPersistedPathSet} check, PLUS (when `deps.goneBranchLedger` is threaded)
 * the {@link classifyAgainstLedger} gate against `ref` — `sha` must come back `"skip"`, `"pre-ledger"` or
 * `"recorded"`; `"unrecorded"` and `"error"` (round 3 — a transient git failure, fails closed exactly
 * like `"unrecorded"`) both refuse. `deps.goneBranchLedger` absent skips the ledger gate entirely.
 *
 * `ref` must be the SAME ref the caller scanned to find `sha` in the first place (never a separately-
 * resolved watermark branch) — a mismatch (e.g. a fresh `project_checkout_branch` target the watermark
 * hasn't caught up to yet) would silently scope the ledger lookup to the wrong history. `pathSet === null`
 * (the pre-f621f185 degraded tier) still runs the ledger gate: a commit with no path-set trailer is even
 * MORE trivially forgeable than a self-consistent one, so it gets the same gate, never a weaker one.
 *
 * @decision c13666c6 round 2 — never pass a resolved watermark branch here as `ref`; always the caller's
 * own scanned ref, or this re-opens finding 5 (a fresh-checkout branch losing its gate).
 *
 * @decision c0d0eac9 round 3 — `positiveProof` is ledger `"recorded"` ONLY, never a PathSet trailer (self-
 * consistent only, decision `756a2cd8`).
 *
 * @decision c0d0eac9 round 4 (finding B1) — `error` (renamed from round 3's `ledgerError`) is true on
 * EITHER a non-definitive PathSet check OR a ledger `"error"` verdict. A caller must abort the WHOLE
 * lookup on it (see `walkCandidates`), regardless of strict/tolerant.
 */
async function verifyGoneBranchLanding(
  git: Pick<SimpleGit, "raw">, timeoutMs: number, sha: string, ref: string, pathSet: string | null, baseOverride: string | undefined,
  deps: BoundedGitDeps,
): Promise<{ passed: boolean; positiveProof: boolean; error: boolean }> {
  if (pathSet !== null) {
    const pathSetVerdict = await verifyPersistedPathSet(git, timeoutMs, sha, pathSet, baseOverride);
    if (pathSetVerdict === "error") return { passed: false, positiveProof: false, error: true };
    if (pathSetVerdict === "fail") return { passed: false, positiveProof: false, error: false };
  }
  const ledger = deps.goneBranchLedger;
  if (!ledger) return { passed: true, positiveProof: false, error: false };
  const verdict = await classifyAgainstLedger(git, timeoutMs, sha, ref, ledger);
  const passed = verdict === "skip" || verdict === "pre-ledger" || verdict === "recorded";
  return { passed, positiveProof: verdict === "recorded", error: verdict === "error" };
}

/** @decision c0d0eac9 — bounds verification attempts (never the scan itself) in the "newest verified
 *  wins" walk below; do not remove this cap — an unbounded walk lets a `.git`-write attacker force
 *  unbounded git spawns per lookup by planting many newer candidates that each fail verification. */
const MIXED_VERIFY_CAP = 5;

/** @decision c0d0eac9 — never let the fallback below return LESS than round 2's own strict-first answer:
 *  it must keep trying strict-only candidates past {@link MIXED_VERIFY_CAP}, bounded here, before failing
 *  closed — sized to the same scale as {@link GONE_BRANCH_LEDGER_ROW_SPAWN_CAP}. */
const STRICT_FALLBACK_VERIFY_CAP = 8;

/** @decision c0d0eac9 round 4 (finding N2) — rate-limits the cap-exceeded warn below; a UI-polled caller
 *  must not log once per poll. Keyed by (caller, branch); see the decision record for the measured need. */
const WALK_CAP_WARN_RATE_LIMIT_MS = 10 * 60 * 1000;
const WALK_CAP_WARN_MAX = 500;
const walkCapWarnTimestamps = new Map<string, number>();

function logWalkCapExceededRateLimited(caller: string, branch: string, message: string): void {
  const key = `${caller}\u0000${branch}`;
  const now = Date.now();
  const last = walkCapWarnTimestamps.get(key);
  if (last !== undefined && now - last < WALK_CAP_WARN_RATE_LIMIT_MS) return;
  if (last === undefined && walkCapWarnTimestamps.size >= WALK_CAP_WARN_MAX) {
    const oldestKey = walkCapWarnTimestamps.keys().next().value;
    if (oldestKey !== undefined) walkCapWarnTimestamps.delete(oldestKey);
  }
  walkCapWarnTimestamps.delete(key); // re-set moves it to the end — eviction targets truly stale keys
  walkCapWarnTimestamps.set(key, now);
  // eslint-disable-next-line no-console
  console.warn(message);
}

/**
 * @decision c0d0eac9 round 3 (finding 4) — the ONE shared walk findLandedSquashCommit and
 * resolveMergedCommitMapHitList both use, so the two can never drift (round 2's finding 1 was such a drift).
 *
 * @decision c0d0eac9 round 4 (finding B1, superseding round 3) — `outcome.error` on ANY candidate (strict
 * OR tolerant) aborts the WHOLE lookup to `null`; the walk can't tell a stale older candidate from the
 * right one once a status is UNKNOWN, so it takes the floor. See the decision record's round-4 section.
 */
async function walkCandidates<C extends { strict: boolean }, R>(
  branch: string, caller: string, candidates: C[],
  verify: (candidate: C) => Promise<{ passed: boolean; positiveProof: boolean; error: boolean; resolved: R | null }>,
): Promise<{ candidate: C; resolved: R } | null> {
  const hasAnyStrictCandidate = candidates.some((c) => c.strict);

  // PHASE 1 — "newest verified wins": walk the full newest-first candidate list, verifying up to
  // MIXED_VERIFY_CAP of them, returning the first that passes.
  let mixedAttempts = 0;
  let strictAttempts = 0;
  for (const candidate of candidates) {
    if (mixedAttempts >= MIXED_VERIFY_CAP) break;
    mixedAttempts++;
    if (candidate.strict) strictAttempts++;
    const outcome = await verify(candidate);
    if (outcome.error) return null; // round 4 (B1): ANY non-definitive outcome aborts the WHOLE lookup
    if (!outcome.passed || outcome.resolved === null) continue;
    // A TOLERANT candidate may only win over a competing STRICT one with POSITIVE PROOF of authorship —
    // without it, this pass doesn't count; keep walking toward an older strict candidate instead.
    if (!candidate.strict && hasAnyStrictCandidate && !outcome.positiveProof) continue;
    return { candidate, resolved: outcome.resolved };
  }

  // PHASE 2 (fallback) — the round-2 FLOOR: keep trying STRICT candidates only, past MIXED_VERIFY_CAP, up
  // to STRICT_FALLBACK_VERIFY_CAP total strict attempts (counting phase 1's own strict attempts above,
  // never a second independent budget). Never re-verifies a candidate phase 1 already tried (this loop
  // starts at `mixedAttempts`, strictly past everything phase 1 just walked).
  for (let i = mixedAttempts; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    if (!candidate.strict) continue;
    if (strictAttempts >= STRICT_FALLBACK_VERIFY_CAP) {
      // @decision c0d0eac9 round 4 (finding N2) — this branch is UNREACHABLE from the map path's own
      // caller: scanMergedCommitMap never stores more than STRICT_FALLBACK_VERIFY_CAP strict entries per
      // branch, so there is never a (cap+1)th strict candidate left for it to try.
      logWalkCapExceededRateLimited(caller, branch, `[git] ${caller}: ${branch} has more than ${STRICT_FALLBACK_VERIFY_CAP} ` +
        "strict trailer candidates that all failed verification — refusing to treat any of them as " +
        "landed (card c0d0eac9)");
      break;
    }
    strictAttempts++;
    const outcome = await verify(candidate);
    if (outcome.error) return null; // round 4 (B1): applies in phase 2 too
    if (outcome.passed && outcome.resolved !== null) return { candidate, resolved: outcome.resolved };
  }
  return null;
}

/** @decision 6ee48e4d — locates the squash-merge commit via the deterministic `Loom-Worker-Branch:` trailer.
 *
 *  RE-TASK GUARD confirms the trailer commit is NOT an ancestor of the branch tip when the branch still exists
 *  (a re-cut DESCENDS from it; a genuine orphan diverges) — never `--is-ancestor` (misreads); use merge-base
 *  equality. FAILS SAFE to `null`.
 *
 *  @decision c0d0eac9 — picks the newest VERIFIED candidate (strict or tolerant), not the newest STRICT
 *  one unconditionally; do not revert to unconditional strict-priority — it hides a newer genuine
 *  tolerant landing behind an older strict one. */
export async function findLandedSquashCommit(
  repoPath: string, branch: string, base = "HEAD", deps: BoundedGitDeps = {},
  onPreFixTrailerNotice?: (branch: string, sha: string) => void,
): Promise<string | null> {
  try {
    // boundedGit itself never throws on a nonexistent/moved repoPath (board card 0f965ab7 — it degrades
    // to a git handle whose methods reject), so this constructor call no longer NEEDS to be inside the
    // try for that reason; it stays here anyway since every other op in this function already lives in
    // this one try, and a rejected git.raw() below still needs it to reach the catch and resolve to null.
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // %x1f-separated sha+body in ONE call (mirrors scanMergedCommitMap) — the body carries the
    // Loom-Worker-PathSet trailer this function needs once the branch is gone (below).
    // The grep is only a cheap PREFILTER (card f62ef199): it matches the text anywhere in a message, so no --max-count — the first hit may be a commit that merely
    // QUOTES the line, hiding the real one behind it. The verdict comes from the parsed final trailer block.
    const out = await withTimeout(
      // @decision abbda4f5 — `base` moved LAST with `--end-of-options` immediately before it: placed
      // right after "log" (ahead of -F/--grep/--format) it would also swallow those real flags as
      // literal positionals and break the ordinary case (measured) — reordering is the fix shape here.
      git.raw(["log", "-F", `--grep=Loom-Worker-Branch: ${branch}`, "--format=%H%x1f%B%x1e", "--end-of-options", base]),
      timeoutMs, "git log --grep trailer",
    );
    // @decision c0d0eac9 — collect EVERY matching candidate (never break on the first strict hit — that
    // was round 2's own mistake, hiding a newer genuine tolerant landing behind an older strict one).
    // Zero extra cost: `out` above already holds the full matching output from the one git call.
    const candidates: Array<{ sha: string; trailers: LoomTrailers; strict: boolean }> = [];
    for (const record of out.split(MERGED_MAP_RECORD_SEP)) {
      const sepIdx = record.indexOf("\x1f");
      if (sepIdx === -1) continue;
      const sha = record.slice(0, sepIdx).trim();
      const body = record.slice(sepIdx + 1);
      const strict = parseLoomTrailerBlock(body);
      if (strict?.branch === branch) { candidates.push({ sha, trailers: strict, strict: true }); continue; }
      // Tolerant fallback ONLY, never instead of the strict parse; the per-candidate verifier below
      // independently verifies whatever this discovers before it is ever trusted.
      const tolerant = tolerantFindLoomTrailerBlock(body);
      if (tolerant?.branch === branch) candidates.push({ sha, trailers: tolerant, strict: false });
    }
    if (candidates.length === 0) return null;

    // @decision c0d0eac9 round 3 (finding 1) — NOT separately try/caught: a throw here reaches this
    // function's OWN outer catch, failing the whole call to `null` — never degrade to `branchPresent:
    // false` (see resolveMergedCommitMapHitList's identical fix for the map path, which had that bug).
    // @decision 7eac6366 — `--end-of-options` right before `branch` (see git/worktrees.ts:1300).
    const branchPresent = (await withTimeout(
      git.raw(["branch", "--list", "--end-of-options", branch]), timeoutMs, "git branch --list",
    )).trim() !== "";

    // Shared per-candidate verifier — the branch-present/branch-gone logic itself is UNCHANGED from
    // before this card; only WHICH candidate(s) get a turn at it has changed. Returns `positiveProof`/
    // `error` alongside `passed` (round 2 finding 2 / round 4 finding B1 — see verifyGoneBranchLanding's
    // own doc); branch-present's content check is NEVER positive proof (an attacker who can write to the
    // shared .git can craft a decoy whose tree matches the live branch, without being its real author).
    //
    // @decision c0d0eac9 round 4 (finding B1, supersedes round 2 here) — the outer catch now returns
    // `error: true`, not a bare fail: an uncaught throw (e.g. the re-task-guard's merge-base call) is
    // non-definitive, so walkCandidates aborts the whole lookup on it instead of treating it as a fail.
    const verify = async (candidate: { sha: string; trailers: LoomTrailers; strict: boolean }): Promise<{ passed: boolean; positiveProof: boolean; error: boolean; resolved: string | null }> => {
      try {
        if (branchPresent) {
          // Re-task guard: if the trailer commit is an ANCESTOR of the branch tip, the branch was re-cut
          // onto it (a re-spawned task carrying NEW live work) — NOT an orphaned squash-merge.
          //
          // @decision c0d0eac9 round 5 (CR4's reasoned point) — `git merge-base` with NO common ancestor
          // exits 1, empty output, no throw at all (empirically, via simple-git) — DEFINITIVE "unrelated",
          // never "error". Short-circuit here rather than feed an empty `mergeBase` into the content check.
          // @decision 868e0135 — `--end-of-options` right after "merge-base": refs/heads/-qualified + a ledger candidate's own sha.
          const mergeBase = (await withTimeout(
            git.raw(["merge-base", "--end-of-options", candidate.sha, `refs/heads/${branch}`]), timeoutMs, "git merge-base",
          )).trim();
          if (mergeBase === "") return { passed: false, positiveProof: false, error: false, resolved: null };
          if (mergeBase === candidate.sha) return { passed: false, positiveProof: false, error: false, resolved: null };
          // Content-reachability is the NON-TRAILER verifier for this arm.
          const contentVerdict = await branchContentLandedInCommit(repoPath, branch, candidate.sha, mergeBase, deps);
          if (contentVerdict === "error") return { passed: false, positiveProof: false, error: true, resolved: null };
          const ok = contentVerdict === "pass";
          return { passed: ok, positiveProof: false, error: false, resolved: ok ? candidate.sha : null };
        }
        // Branch gone (card f621f185): verify against the persisted path-set trailer if this commit has
        // one, PLUS (card c13666c6) the ledger-cutover gate — see verifyGoneBranchLanding's own doc.
        const pathSet = candidate.trailers.pathSet;
        if (!pathSet && onPreFixTrailerNotice) {
          onPreFixTrailerNotice(branch, candidate.sha);
        } else if (!pathSet) {
          // eslint-disable-next-line no-console
          console.info(`[git] findLandedSquashCommit: ${branch} is gone and its landed commit ${candidate.sha.slice(0, 7)} ` +
            "carries no Loom-Worker-PathSet trailer — trusting Loom-Worker-Branch presence alone (card f621f185)");
        }
        // Phase 2 (card d62dad73) + card 756a2cd8: prefer the commit's own Loom-Worker-Base trailer as the
        // path-set verification base when present; undefined falls back to sha^ — see verifyPersistedPathSet's doc.
        const { passed, positiveProof, error } = await verifyGoneBranchLanding(git, timeoutMs, candidate.sha, base, pathSet, candidate.trailers.base ?? undefined, deps);
        return { passed, positiveProof, error, resolved: passed ? candidate.sha : null };
      } catch {
        return { passed: false, positiveProof: false, error: true, resolved: null }; // fail safe: an UNCAUGHT throw is non-definitive (round 4) — walkCandidates aborts the whole lookup on it
      }
    };

    const walked = await walkCandidates(branch, "findLandedSquashCommit", candidates, verify);
    return walked?.resolved ?? null;
  } catch {
    return null; // fail safe: unknown signal → NOT landed → caller KEEPS the worktree
  }
}

/** How many older same-branch trailer commits {@link findIntroducingSquashCommit} will inspect. */
const INTRODUCING_COMMIT_MAX_OLDER = 16;

/** @decision 293d418e — ATTRIBUTION ONLY: never use for gating, verification or pinning (the section "Attribution" in that record says why); those stay on {@link findLandedSquashCommit}.
 *
 *  Given the sha that lookup returned (the NEWEST qualifying trailer commit), returns the oldest of the unbroken run of older same-branch trailer commits that pass the same per-commit
 *  checks, i.e. the one that brought the branch's content in. Returns `landedSha` unchanged on any error, a gone branch, a branch with no changes of its own, or an unlisted sha. */
export async function findIntroducingSquashCommit(
  repoPath: string, branch: string, landedSha: string, base = "HEAD", deps: BoundedGitDeps = {},
): Promise<string> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // @decision 56c10535 — qualified: a bare `branch` revision resolves a same-named tag ahead of
    // the real branch (refs/tags/ outranks refs/heads/; attribution-only, but still identity).
    const branchRef = `refs/heads/${branch}`;
    // @decision 7eac6366 — `--end-of-options` right before `branch` (see git/worktrees.ts:1300).
    if ((await withTimeout(git.raw(["branch", "--list", "--end-of-options", branch]), timeoutMs, "git branch --list (attribution)")).trim() === "") return landedSha;
    const out = await withTimeout(
      // @decision abbda4f5 — `base` moved LAST with `--end-of-options` immediately before it: placed
      // right after "log" (ahead of -F/--grep/--format) it would also swallow those real flags as
      // literal positionals and break the ordinary case (measured) — reordering is the fix shape here.
      git.raw(["log", "-F", `--grep=Loom-Worker-Branch: ${branch}`, "--format=%H%x1f%B%x1e", "--end-of-options", base]),
      timeoutMs, "git log --grep trailer (attribution)",
    );
    const shas: string[] = [];
    for (const record of out.split(MERGED_MAP_RECORD_SEP)) {
      const sepIdx = record.indexOf("\x1f");
      if (sepIdx === -1) continue;
      if (parseLoomTrailerBlock(record.slice(sepIdx + 1))?.branch === branch) shas.push(record.slice(0, sepIdx).trim());
    }
    const at = shas.indexOf(landedSha);
    if (at === -1) return landedSha;
    // @decision c0d0eac9 round 6 (finding 3) — was interpolated into the diff range below with no empty
    // check: "no common ancestor" would silently become `..branchRef`. Guard it like the loop's own below.
    // @decision 868e0135 — `--end-of-options` right after "merge-base": branchRef is already refs/heads/-qualified; landedSha is a resolved sha.
    const landedMergeBase = (await withTimeout(git.raw(["merge-base", "--end-of-options", landedSha, branchRef]), timeoutMs, "git merge-base (attribution)")).trim();
    if (!landedMergeBase) return landedSha; // no common ancestor — fails conservatively, same as any other ambiguity here
    // @decision 4b559feb — never drop this marker: a left-side `--output=`/`-O`/`--src-prefix=` value in
    // `landedMergeBase` is matched by PREFIX, so unguarded it silently writes a file or discards the diff.
    const ownChanges = (await withTimeout(
      git.raw(["diff", "--name-only", "--end-of-options", `${landedMergeBase}..${branchRef}`]),
      timeoutMs, "git diff --name-only (attribution)",
    )).trim();
    if (!ownChanges) return landedSha;
    let introducer = landedSha;
    for (const older of shas.slice(at + 1, at + 1 + INTRODUCING_COMMIT_MAX_OLDER)) {
      // @decision 868e0135 — `--end-of-options` right after "merge-base": same reason as the landed-mergeBase call above.
      const mergeBase = (await withTimeout(git.raw(["merge-base", "--end-of-options", older, branchRef]), timeoutMs, "git merge-base (attribution)")).trim();
      if (!mergeBase || mergeBase === older) break; // re-cut onto it: the branch descends from this commit
      // Attribution-only (decision 293d418e) — treats "error" the same as "fail" here, unlike the gating
      // walk's own tri-state handling; this function already fails conservatively (returns landedSha) on
      // any ambiguity via its own outer catch, so a non-pass of either kind just stops the older-walk.
      if ((await branchContentLandedInCommit(repoPath, branch, older, mergeBase, deps)) !== "pass") break;
      introducer = older;
    }
    return introducer;
  } catch {
    return landedSha;
  }
}

/**
 * ALL commits on `base` carrying a `Loom-Worker-Branch: <branch>` trailer, newest-first, with parsed trailers — never breaks on the first
 * match and never applies {@link findLandedSquashCommit}'s re-task guard. READ-ONLY; a caller must still verify each candidate's CONTENT.
 * @decision e5458ccd — never use for gating/finalize; a trailer match alone does not attribute to any one generation sharing this branch.
 */
export async function findAllLandedTrailerCommits(
  repoPath: string, branch: string, base = "HEAD", deps: BoundedGitDeps = {},
): Promise<Array<{ sha: string; trailers: LoomTrailers }>> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    const out = await withTimeout(
      // @decision abbda4f5 — `base` moved LAST with `--end-of-options` immediately before it: placed
      // right after "log" (ahead of -F/--grep/--format) it would also swallow those real flags as
      // literal positionals and break the ordinary case (measured) — reordering is the fix shape here.
      git.raw(["log", "-F", `--grep=Loom-Worker-Branch: ${branch}`, "--format=%H%x1f%B%x1e", "--end-of-options", base]),
      timeoutMs, "git log --grep trailer (all-candidates)",
    );
    const found: Array<{ sha: string; trailers: LoomTrailers }> = [];
    for (const record of out.split(MERGED_MAP_RECORD_SEP)) {
      const sepIdx = record.indexOf("\x1f");
      if (sepIdx === -1) continue;
      const body = record.slice(sepIdx + 1);
      // @decision 45036494 (round 2 correction) — tolerant fallback ONLY. ONLY the caller's no-`landedTip`
      // arm content-checks `sha`; a `landedTip`-carrying candidate instead chain-checks the TRAILER VALUE,
      // never `sha`'s own content — no NEW capability, but "every candidate is content-checked" was wrong.
      const parsed = parseLoomTrailerBlock(body) ?? tolerantFindLoomTrailerBlock(body);
      if (parsed?.branch === branch) found.push({ sha: record.slice(0, sepIdx).trim(), trailers: parsed });
    }
    return found;
  } catch {
    return [];
  }
}

/** Bounds for {@link machineReadablePathSet} — see its own doc for why an over-cap diff truncates rather
 *  than stamping a partial (and therefore misleading) list. */
export const FILES_CHANGED_PATHS_MAX_COUNT = 500;
export const FILES_CHANGED_PATHS_MAX_BYTES = 32_000;

/**
 * Round 5 (Code Review 7fb963b2, findings 1+2 — replacing round 4's `diffstatPathSet`): the review-time
 * path set for `range`, from a DEDICATED machine-readable call — `git diff --name-status -z`, NUL-
 * delimited, taking BOTH sides of an `R`/`C` row as separate fields — NEVER parsed from `git diff --stat`'s
 * own DISPLAY text (round 4's `diffstatPathSet` did, via `normalizeDiffstatPath`/`diffstatRenameSource`).
 * That text form is lossy in two measured, exploitable ways: a non-ASCII name is C-quoted
 * (`"caf\303\251.txt"`) by `--stat`'s own rendering, so it never matches the real file as a pathspec and
 * silently drops out of the content check; and a name genuinely containing `{`/`}` (`{{tpl}}/a.txt`)
 * collides with `normalizeDiffstatPath`'s own rename-collapse syntax and is rewritten into a path that
 * doesn't exist at all. Both let a partial landing's missing file go unchecked — the content check
 * "matches" vacuously against a pathspec that resolves to nothing on either side.
 * `--name-status -z` has neither defect: `-z` disables C-quoting outright regardless of `core.quotepath`
 * (verified empirically: a non-ASCII name's raw UTF-8 bytes come through unquoted under `-z` alone — no
 * `-c core.quotepath=false` needed), and `--name-status` never does `--stat`'s own `{old => new}`
 * collapsing in the first place.
 * Round 5 also tried adding that redundant `-c core.quotepath=false` anyway, and every call read as
 * truncated as a result — but NOT because simple-git's `blockUnsafeOperationsPlugin` rejects the key (it
 * doesn't; `core.quotepath` isn't on that plugin's fixed block-list at all — see `K`/`Y` in
 * `@simple-git/argv-parser`'s own source). Round 6 (Code Review `e319ea92`) found the real cause: the
 * flag was placed AFTER the subcommand (`["diff", "-c", "core.quotepath=false", ...]`), which git parses
 * as `git diff -c` (COMBINED-DIFF mode, an unrelated flag meaning) followed by an unrecognized revision —
 * a plain `fatal: ambiguous argument`, caught by this function's own `try/catch` and misdiagnosed at the
 * time as a plugin rejection. A GLOBAL `-c` placed BEFORE the subcommand works fine through real
 * `canonicalGit` (measured directly); only a FIXED key list is ever actually blocked — see `K`/`Y` in
 * `@simple-git/argv-parser`'s own source (the same source cited above) for the current list, never a
 * restatement here — and a key on that list needs the explicit `allowUnsafe*` opt-in
 * (`attemptCodexAutoCommit`'s own `cfg` + `extraUnsafe` wiring, this file, is a real example).
 *
 * `diffBranch` calls this with the SAME `range` it already resolved (never re-derived independently), so
 * the stamp can never describe a different diff than the diffstat computed beside it. Bounded identically
 * to round 4's cap (same constants): over either cap, or on a failed read, returns `{truncated:true}` —
 * never a partial or empty list, which the caller would otherwise misread as "genuinely zero changes."
 * @decision c7dc99bf — a stamp must read as UNKNOWN (truncated) on any read failure, never as empty.
 */
/**
 * Round 6 (Code Review `e319ea92`, finding 3, minor) — pure-function extraction of
 * {@link machineReadablePathSet}'s own `-z` record parse, so a malformed/short token stream can be unit-
 * tested directly rather than only through a real git spawn. A record whose declared path field(s) run
 * past the end of the token stream (an R/C row missing its second path, or any status with no path at
 * all) now fails CLOSED to `{truncated:true}` — the prior version's `if (!p) continue` silently dropped
 * just that one field and kept going, producing a PARTIAL list (missing exactly the field that ran out)
 * instead of the unknown-stamp signal the caller actually needs. Byte accounting now uses
 * `Buffer.byteLength` (UTF-8 bytes), not `.length` (UTF-16 code units) — the two diverge for any non-ASCII
 * path, under- or over-counting against `FILES_CHANGED_PATHS_MAX_BYTES` depending on the surrogate shape.
 * @decision c7dc99bf — a stamp must read as UNKNOWN (truncated) on any read failure, never as empty OR
 * as a partial list that looks complete.
 */
export function parseNameStatusZ(out: string): { paths: string[] } | { truncated: true } {
  const tokens = out.split("\0").filter((t) => t.length > 0);
  const paths: string[] = [];
  let bytes = 0;
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    i++;
    if (!status) return { truncated: true };
    // R/C (rename/copy) rows carry TWO paths (old, new); every other status carries exactly one.
    const need = status[0] === "R" || status[0] === "C" ? 2 : 1;
    if (i + need > tokens.length) return { truncated: true }; // declared fields run past the stream end
    for (let k = 0; k < need; k++) {
      const p = tokens[i + k];
      if (!p) return { truncated: true };
      paths.push(p);
      bytes += Buffer.byteLength(p, "utf8");
      if (paths.length > FILES_CHANGED_PATHS_MAX_COUNT || bytes > FILES_CHANGED_PATHS_MAX_BYTES) return { truncated: true };
    }
    i += need;
  }
  return { paths };
}

export async function machineReadablePathSet(
  repoPath: string, range: string, deps: BoundedGitDeps = {},
): Promise<{ paths: string[] } | { truncated: true }> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // @decision 4b559feb — never drop this marker: a left-side `--output=`/`-O`/`--src-prefix=` value is
    // matched by PREFIX (not exact equality), so unguarded it silently writes a file or discards the diff.
    const out = await withTimeout(
      git.raw(["diff", "--name-status", "-z", "--end-of-options", range]),
      timeoutMs, "git diff --name-status -z (machine-readable path set)",
    );
    return parseNameStatusZ(out);
  } catch {
    return { truncated: true };
  }
}

/**
 * Full recursive tree listing of `ref` as `path -> "<mode> <type> <sha>"`, via ONE `git ls-tree -r -z
 * <ref>` call with NO pathspec argument at all — so no hazardous name (a literal backslash, bracket/brace
 * glob-magic, non-ASCII, a leading `-`, a space) is ever interpreted as pathspec syntax; every key is
 * compared by plain string equality, with NO additional normalization applied on top of that decode (no
 * backslash<->slash, no case folding, no Unicode NFC/NFD) — a case-variant pair (`A.txt` vs `a.txt`) is
 * two distinct keys, matching git's own case-sensitive tree storage regardless of the host filesystem's
 * own case-folding behavior. Shared by both {@link recordedTipContentLanded} and
 * {@link stampedPathsPlausible} — `recordedTip`'s own listing is loop-invariant across every candidate in
 * a scan, so a caller should read it ONCE and pass the result to both functions' optional
 * `recordedTipEntries` param instead of letting either one re-read it per candidate.
 *
 * `git.raw()` (simple-git) returns the subprocess's stdout as a UTF-8-DECODED JS string, not raw bytes —
 * a path whose real on-disk bytes are NOT valid UTF-8 decodes LOSSILY (Node's decoder substitutes U+FFFD,
 * the replacement character, for each invalid byte sequence), so two genuinely DIFFERENT raw byte paths
 * can decode to the IDENTICAL string and collide as one Map key. Fails closed to `null` if any decoded
 * key contains U+FFFD, or if a decoded key collides with one already in the map (the two symptoms of the
 * same underlying risk) — never silently keeps whichever entry happened to be seen first.
 * @decision 1cf79e64 — fails closed to `null` on any read failure, a malformed record (a line with no tab
 * separator), a decoded key containing U+FFFD, or a duplicate decoded key — the WHOLE map is untrustworthy
 * then, never a partial one that looks complete.
 */
export async function fullTreeEntries(
  repoPath: string, ref: string, deps: BoundedGitDeps = {},
): Promise<Map<string, string> | null> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // @decision 868e0135 — `--end-of-options` before `ref`: every caller passes an already-resolved sha
    // (this function's own doc above), but an option-shaped value would otherwise be read as a flag.
    const out = await withTimeout(
      git.raw(["ls-tree", "-r", "-z", "--end-of-options", ref]), timeoutMs, "git ls-tree -r (full tree entries)",
    );
    const map = new Map<string, string>();
    for (const rec of out.split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      if (tab === -1) return null; // malformed record — fail the whole map closed, never a partial one
      const p = rec.slice(tab + 1);
      if (p.includes("�")) return null; // a lossily-decoded (non-UTF-8) path can't be trusted as a key
      if (map.has(p)) return null; // a duplicate decoded key — a genuine collision or a lossy one; either way, untrustworthy
      map.set(p, rec.slice(0, tab)); // path -> "<mode> <type> <sha>"
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Round 5 (Code Review 7fb963b2 ruling c): a fail-closed sanity net on the STAMPED set itself, run once
 * per candidate before trusting {@link recordedTipContentLanded}'s verdict against it. A stamped path
 * absent from BOTH `recordedTip`'s own tree AND its merge-base with `otherSha` means the stamp and the
 * repo disagree — the stamp can no longer be trusted to describe anything real for that path, so the
 * candidate is rejected (never attributed on a stamp this check cannot corroborate).
 *
 * Round 6 (Code Review `e319ea92`, finding 2, BLOCKING — measured cost): the original per-PATH design
 * (`ls-tree --name-only -z <ref> -- <p>`, up to 2 spawns per path) made this net the dominant cost on the
 * boot-reconcile path — measured 500 paths at ~29.5s per candidate when every path exists, ~98.4s when
 * all 500 are absent (2 ls-tree reads apiece). Fixed by reading each tree ONCE as a full recursive
 * listing into a `Set`, then testing membership locally — 3 total spawns per candidate (merge-base + 2
 * tree reads) regardless of how many paths are checked. Listing the WHOLE tree also closes a correctness
 * bug the per-path pathspec design had: git normalizes `\` in a pathspec argument (Windows), so a path
 * genuinely containing a literal backslash (e.g. a plumbing-built `back\slash.txt`) never matched its own
 * pathspec on either side, even when the file truly existed unchanged on both — this net fails closed on
 * that path and the TRUE positive (a genuine attribution) was escalated anyway, never a safety hole; but
 * it wrongly escalated every such file, trivial self-comparison included (measured:
 * `stampedPathsPlausible(tip, tip, [thatPath])` read `false`). A full-tree listing carries no pathspec to
 * normalize — membership is exact string equality against the raw, `-z`-delimited (unquoted) tree entries.
 *
 * The Lead's ruling (round 6, finding 2) also moved this net to run AFTER {@link recordedTipContentLanded}
 * returns `"attributed"`, never before — this net only ever REJECTS a positive attribution (see the "fail-
 * closed sanity net" doc above); it can never turn a `"no-match"` into anything else, so running it
 * against a candidate whose content already failed is pure waste. Most candidates in a real scan fail the
 * (single, cheap) content diff; only the one that would otherwise be attributed now pays this net's cost.
 * See `attributeStaleGenerationOwnLanding` (sessions/service.ts) for the call-site ordering.
 * @decision c7dc99bf — fails closed to `false` on any ambiguity (a failed git read, an unresolvable
 * merge-base, or a genuinely absent path on both sides), never `true` on a shaky read.
 * @decision 1cf79e64 — now built on the shared {@link fullTreeEntries} helper instead of its own bespoke
 * `--name-only` tree-set read; `recordedTipEntries`, when passed, is used in place of a fresh read of
 * `recordedTip`'s own tree (the caller's shared-read optimization — see that function's own doc).
 */
export async function stampedPathsPlausible(
  repoPath: string, recordedTip: string, otherSha: string, paths: string[], deps: BoundedGitDeps = {},
  recordedTipEntries?: Map<string, string> | null,
): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    const mergeBase = (await withTimeout(
      // @decision 868e0135 — `--end-of-options` right after "merge-base": both recordedTip/otherSha are resolved shas.
      git.raw(["merge-base", "--end-of-options", recordedTip, otherSha]), timeoutMs, "git merge-base (stamped-path plausibility)",
    )).trim();
    if (!mergeBase) return false;
    const [recordedMap, mergeBaseMap] = await Promise.all([
      recordedTipEntries !== undefined ? recordedTipEntries : fullTreeEntries(repoPath, recordedTip, deps),
      fullTreeEntries(repoPath, mergeBase, deps),
    ]);
    if (!recordedMap || !mergeBaseMap) return false;
    for (const p of paths) {
      if (!recordedMap.has(p) && !mergeBaseMap.has(p)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The per-candidate half: does `candidateSha` carry the SAME content as `recordedTip` over exactly `files`
 * (the review-time stamped path set {@link machineReadablePathSet} produced, used as-is — see its own
 * doc)? The sha-parameterized sibling of {@link branchContentLandedInCommit} — that one diffs the LIVE
 * branch ref, which is wrong once the branch has been reused by a different generation.
 *
 * Built on {@link fullTreeEntries} (mode+type+blob-sha tree-entry comparison) rather than a pathspec-based
 * `git diff`, so a hazardous stamped name (a literal backslash, bracket/brace glob-magic, …) is compared
 * by exact string equality, never reinterpreted as pathspec syntax. `files.length === 0` fails closed to
 * `"no-match"` — never a vacuous `"attributed"`, since an empty stamp proves nothing about any candidate.
 * `recordedTipEntries`, when passed, replaces a fresh read of `recordedTip`'s own tree — see
 * `fullTreeEntries`'s own doc for why a caller looping over candidates should share this read.
 * @decision e5458ccd — fails closed to `"no-match"` on any ambiguity, never `"attributed"` on a shaky read.
 * @decision 1cf79e64 — do not reintroduce a pathspec-based diff here: a literal backslash in a stamped
 * path defeats ANY pathspec (no flag/magic/env override exists) and silently reads as a vacuous content
 * match for a candidate that genuinely omits that file, or even an unrelated candidate entirely.
 */
export async function recordedTipContentLanded(
  repoPath: string, recordedTip: string, candidateSha: string, files: string[], deps: BoundedGitDeps = {},
  recordedTipEntries?: Map<string, string> | null,
): Promise<"attributed" | "no-match"> {
  if (files.length === 0) return "no-match";
  try {
    const recordedMap = recordedTipEntries !== undefined ? recordedTipEntries : await fullTreeEntries(repoPath, recordedTip, deps);
    if (!recordedMap) return "no-match";
    const candidateMap = await fullTreeEntries(repoPath, candidateSha, deps);
    if (!candidateMap) return "no-match";
    for (const p of files) {
      if (recordedMap.get(p) !== candidateMap.get(p)) return "no-match";
    }
    return "attributed";
  } catch {
    return "no-match";
  }
}

/** @decision c6a6f405 — the orchestration-view diff for a worker, robust across its WHOLE lifecycle (live
 *  worktree / committed branch / merged+deleted branch) — fixes the "/orchestration diffs are all empty" bug.
 *
 *  Never let a git call here skip the bounded {@link boundedDiffGit}/{@link withTimeout} convention — an
 *  unbounded call reintroduces the hang risk. */
export async function workerDiff(
  repoPath: string,
  opts: { branch: string | null; worktreePath: string | null },
  deps: DiffBranchDeps = {},
): Promise<WorkerDiff | null> {
  const { branch, worktreePath } = opts;

  // 1. Live/retained worktree → include uncommitted work (diff from spawn point to the working tree).
  if (branch && worktreePath && fs.existsSync(worktreePath)) {
    try {
      const { git, timeoutMs } = boundedDiffGit(repoPath, deps);
      const base = (await withTimeout(git.raw(["merge-base", "HEAD", `refs/heads/${branch}`]), timeoutMs, "git merge-base (workerDiff uncommitted)")).trim();
      // @decision 3a5c5d4a (round 4, B-1) — `worktreePath` is a worker's own linked worktree; pass the
      // real main's resolved TOPLEVEL, never bare `repoPath` (which may itself be subdir-bound), or a
      // rewritten worktree commondir pointer would redirect this review-facing diff to a decoy.
      const { git: wt } = boundedDiffGit(worktreePath, { ...deps, trustedMainRoot: defaultTrustedMainRoot(repoPath) });
      const summary = await withTimeout(wt.diffSummary([base]), timeoutMs, "git diff --stat (workerDiff uncommitted)"); // <base> with one arg = base..WORKING-TREE
      const patch = await withTimeout(wt.diff([base]), timeoutMs, "git diff (workerDiff uncommitted)");
      return {
        filesChanged: summary.files.length, insertions: summary.insertions,
        deletions: summary.deletions, patch, uncommitted: true,
      };
    } catch { /* worktree gone/wedged mid-read → fall through to the committed-branch paths */ }
  }

  // 2. Branch still on the canonical repo (committed, not yet merged) → committed 3-dot diff.
  if (branch && await branchExists(repoPath, branch, deps)) {
    try { return await diffBranch(repoPath, branch, "HEAD", {}, deps); } catch { /* fall through */ }
  }

  // 3. Branch merged + deleted → reconstruct the landed diff from the SQUASH commit, found by the
  //    deterministic Loom-Worker-Branch trailer (under squash there is no merge commit to grep for).
  if (branch) {
    try {
      const sha = await findLandedSquashCommit(repoPath, branch, "HEAD", deps);
      if (sha) {
        const { git, timeoutMs } = boundedDiffGit(repoPath, deps);
        const range = `${sha}^..${sha}`; // the squash commit's own changes (single parent)
        const summary = await withTimeout(git.diffSummary([range]), timeoutMs, "git diff --stat (workerDiff merged)");
        const patch = await withTimeout(git.diff([range]), timeoutMs, "git diff (workerDiff merged)");
        return {
          filesChanged: summary.files.length, insertions: summary.insertions,
          deletions: summary.deletions, patch, merged: true,
        };
      }
    } catch { /* squash commit unfindable → null below */ }
  }

  return null;
}

// @decision 31552de1 — diff cache for the polled orchestration-view endpoint: correctness over hit-rate (a
// false HIT serves a stale diff, worse than the perf cost it saves) — never treat a HIT as free, it still
// walks the tree; the TTL fast path only bounds how OFTEN the walk runs.
//
// Measured ~2x, not an
// order-of-magnitude reduction.

const DIFF_CACHE_MAX_ENTRIES = 500;
const DIFF_FINGERPRINT_MAX_ENTRIES = 20_000;
/** How long a live-worktree entry's content fingerprint (the walk) is trusted without re-walking — see
 *  the TTL fast-path note above. Anchored to the last REAL walk, never bumped by a fast-path hit. */
const DIFF_FINGERPRINT_TTL_MS = 12_000;

interface DiffCacheEntry {
  key: string;
  result: WorkerDiff | null;
  /** headSha component of a live-worktree (`wt:...`) `key`, used by the TTL fast path to cheaply
   *  re-verify staleness without a walk. Null for a `branch:`/`merged:` entry — no worktree, so no walk
   *  was ever paid for it, and so no fast path to take. */
  wtHeadSha: string | null;
  /** When this entry's content fingerprint was last actually walked (real recompute, not a fast-path
   *  hit). The TTL is measured from here. */
  fingerprintedAt: number;
}

const diffCache = new Map<string, DiffCacheEntry>();

/** Loose-or-packed ref resolution via fs only (no `git rev-parse`). `refName` like `refs/heads/<branch>`. */
async function readRefSha(gitDir: string, refName: string): Promise<string | null> {
  try {
    const content = (await fs.promises.readFile(path.join(gitDir, refName), "utf8")).trim();
    if (content) return content;
  } catch { /* not a loose ref; fall through to packed-refs */ }
  try {
    const packed = await fs.promises.readFile(path.join(gitDir, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      if (!line || line[0] === "#" || line[0] === "^") continue;
      const sp = line.indexOf(" ");
      if (sp === -1) continue;
      if (line.slice(sp + 1).trim() === refName) return line.slice(0, sp).trim();
    }
  } catch { /* no packed-refs either */ }
  return null;
}

/**
 * Resolve the two git-dir roles `repoPath`'s `.git` entry actually implies, fs-only, no `git` spawn.
 * `privateDir` is where THIS checkout's own per-checkout files live (`HEAD`, `index`, `logs/HEAD`) —
 * always read HEAD from here. `commonDir` is where SHARED refs live (`refs/**`, `packed-refs`) — always
 * resolve a ref from here, never `privateDir` for a linked worktree.
 *
 * `.git` a DIRECTORY: both roles are that same directory. `.git` a FILE (`gitdir: <path>`): that target
 * is `privateDir`; if it has its own `commondir` file (a linked worktree), `commonDir` resolves from it;
 * otherwise (a submodule or `--separate-git-dir` repo) `commonDir` is `privateDir` itself.
 *
 * STAYS ASYNC (never wrapped around the sync twin): sits on the merged-map/worker-diff cache hot path,
 * where this repo's event-loop discipline bans blocking I/O. `git/repo-lock.ts`'s `resolveGitDirsSync` is
 * the SYNC TWIN, for callers (skills/inject.ts, pty/codex-doctrine.ts) that can't go async — the two must
 * stay byte-identical in behavior; `test/gitdirs-sync-async-parity.mjs` asserts this directly, and a
 * future edit to either must update the other. Exported (card 25389c3c) solely so that test can import it.
 *
 * @decision 472f14d1 — do not change that fallback to `null`: a submodule/`--separate-git-dir` repo has
 * no `commondir` file by design, and `HEAD`/`refs/**`/`packed-refs` all live directly in `privateDir`;
 * `null` would make such a repo's ref resolution permanently fail instead of correctly resolving.
 */
export async function resolveGitDirs(repoPath: string): Promise<{ privateDir: string; commonDir: string } | null> {
  const gitPath = path.join(repoPath, ".git");
  let stat: import("node:fs").Stats;
  try { stat = await fs.promises.stat(gitPath); } catch { return null; }
  if (stat.isDirectory()) return { privateDir: gitPath, commonDir: gitPath };
  let pointer: string;
  try { pointer = await fs.promises.readFile(gitPath, "utf8"); } catch { return null; }
  const m = pointer.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m || !m[1]) return null; // not the `gitdir: <path>` shape every real .git FILE has
  const privateDir = path.resolve(repoPath, m[1]);
  try { await fs.promises.stat(path.join(privateDir, "HEAD")); } catch { return null; } // bad pointer target
  try {
    const commondirRaw = (await fs.promises.readFile(path.join(privateDir, "commondir"), "utf8")).trim();
    return { privateDir, commonDir: path.resolve(privateDir, commondirRaw) };
  } catch {
    return { privateDir, commonDir: privateDir }; // submodule / --separate-git-dir: no indirection
  }
}

/** The canonical repo's current HEAD sha, resolved via fs only (handles both symbolic and detached HEAD,
 *  and a `.git` that's a directory OR a gitfile pointer — see {@link resolveGitDirs}). */
async function readHeadSha(repoPath: string): Promise<string | null> {
  try {
    const dirs = await resolveGitDirs(repoPath);
    if (!dirs) return null;
    const head = (await fs.promises.readFile(path.join(dirs.privateDir, "HEAD"), "utf8")).trim();
    if (head.startsWith("ref:")) return readRefSha(dirs.commonDir, head.slice(4).trim());
    return head || null; // detached HEAD: a raw sha
  } catch {
    return null;
  }
}

/**
 * Card eb58b8bd: the merged-commit map cache's freshness-key sha for an arbitrary scan `base`, not just
 * `"HEAD"`. `base === "HEAD"` is BYTE-IDENTICAL to the pre-card behavior — `readHeadSha`'s own `?? "-"`
 * degrade happens HERE, so a missing/unreadable HEAD (a fake repoPath, as several hermetic tests use)
 * still resolves to the cacheable constant `"-"`, never `null`. For any other `base` (a
 * `refs/heads/<branch>` ref), this resolves via {@link readRefSha} (reads packed-refs too) and returns
 * `null` — never the literal `base` string — when unresolvable: a constant key would serve a stale map
 * forever for that base. `null` is returned ONLY for a non-`"HEAD"` base; the caller treats it as "bypass
 * the cache for this call", never cache it.
 *
 * Exported (card eb58b8bd round 2) so boot-reconcile Pass A can reuse this SAME fs-only resolvability
 * check for its own stored-watermark-ref liveness guard, rather than hand-deriving a second one.
 */
export async function readBaseSha(repoPath: string, base: string): Promise<string | null> {
  if (base === "HEAD") return (await readHeadSha(repoPath)) ?? "-";
  const dirs = await resolveGitDirs(repoPath);
  if (!dirs) return null;
  return readRefSha(dirs.commonDir, base);
}

/**
 * Bounded, git-free recursive fingerprint of a worktree's files (path + mtime + size + mode), so a
 * repeat poll can PROVE no uncommitted edit happened without shelling out to git. Returns null if the
 * walk exceeds {@link DIFF_FINGERPRINT_MAX_ENTRIES} (can't cheaply prove unchanged -> caller always
 * recomputes) — never wrong, just no speedup for a pathologically large tree. Exported (card 31552de1)
 * purely so a test can wrap it as a counting seam via {@link getWorkerDiffCached}'s `deps.fingerprint` —
 * mirrors why {@link workerDiff} itself is exported as the default for `deps.compute`.
 */
export async function fingerprintWorktree(worktreePath: string): Promise<string | null> {
  const parts: string[] = [];
  let overflowed = false;
  async function walk(dir: string): Promise<void> {
    if (overflowed) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir vanished mid-walk (worktree being torn down concurrently) -> best-effort
    }
    for (const entry of entries) {
      if (overflowed) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue; // skip symlinks etc.
      if (parts.length >= DIFF_FINGERPRINT_MAX_ENTRIES) { overflowed = true; return; }
      try {
        const st = await fs.promises.stat(full);
        parts.push(`${full}:${st.mtimeMs}:${st.size}:${st.mode}`);
      } catch { /* file vanished mid-walk -> ignore this entry, best-effort */ }
    }
  }
  await walk(worktreePath);
  if (overflowed) return null;
  parts.sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

/**
 * Compute the cache freshness key for one workerDiff() call, or null if it can't be cheaply proven. Also
 * returns the resolved `headSha` (always one or two small fs reads — `.git/HEAD` then, when it's a
 * symbolic ref, `refs/heads/<branch>`, falling through to scan `packed-refs` when refs are packed — never
 * a walk) so the caller can drive the TTL fast path without a second read. `fingerprint` is an injectable
 * seam (defaults to the real {@link fingerprintWorktree}) purely so a test can count actual WALK
 * invocations.
 */
async function computeDiffCacheKey(
  repoPath: string, branch: string, worktreePath: string | null,
  fingerprint: typeof fingerprintWorktree = fingerprintWorktree,
): Promise<{ key: string | null; headSha: string }> {
  const headSha = (await readHeadSha(repoPath)) ?? "-";
  if (worktreePath && fs.existsSync(worktreePath)) {
    const contentFp = await fingerprint(worktreePath);
    if (contentFp === null) return { key: null, headSha };
    return { key: `wt:${headSha}:${contentFp}`, headSha };
  }
  const dirs = await resolveGitDirs(repoPath);
  const branchSha = dirs ? await readRefSha(dirs.commonDir, `refs/heads/${branch}`) : null;
  if (branchSha) return { key: `branch:${branchSha}`, headSha };
  // Branch merged+deleted (or unknown): stage 3 searches history from HEAD, so HEAD alone is the key.
  return { key: `merged:${headSha}`, headSha };
}

/**
 * Cached wrapper around {@link workerDiff} for the polled orchestration-view diff endpoint. `deps.compute`
 * is an injectable seam (defaults to the real {@link workerDiff}) so a test can count git-subprocess-
 * triggering calls without mocking `simple-git`/`child_process`. `deps.fingerprint` is the matching seam
 * for {@link fingerprintWorktree} (defaults to the real walk) so a test can count WALK invocations
 * separately — the two are no longer the same thing once the TTL fast path (see the comment block above
 * this cache) can skip the walk on a poll that still cheaply re-reads HEAD. `deps.now` defaults to
 * `Date.now` and lets a test drive the TTL deterministically without a real sleep.
 */
export async function getWorkerDiffCached(
  repoPath: string,
  opts: { branch: string; worktreePath: string | null },
  deps: { compute?: typeof workerDiff; fingerprint?: typeof fingerprintWorktree; now?: () => number } = {},
): Promise<WorkerDiff | null> {
  const compute = deps.compute ?? workerDiff;
  const fingerprint = deps.fingerprint ?? fingerprintWorktree;
  const now = deps.now ?? Date.now;

  const hasLiveWorktree = !!(opts.worktreePath && fs.existsSync(opts.worktreePath));
  const cached = diffCache.get(opts.branch);

  // TTL fast path: a live-worktree entry whose content fingerprint was walked within the last
  // DIFF_FINGERPRINT_TTL_MS is trusted WITHOUT re-walking — only a cheap re-read of the CANONICAL repo's
  // HEAD runs (one or two small file reads, plus a packed-refs scan when refs are packed — never a walk),
  // so the canonical repo's own branch moving (e.g. another worker's PR landing on main, which shifts the
  // merge-base this diff is computed from) is still caught immediately even inside the TTL window. A
  // worker's own commit needs no separate handling here: it writes no working-tree bytes beyond what a
  // plain uncommitted edit would, so it's bounded by the same TTL as any other working-tree write (see the
  // comment block above this cache for why). `hasLiveWorktree` also gates this — a worktree that vanished
  // since this entry was cached (the worker merged and its worktree was removed) must NOT be served from
  // this stale live-worktree entry, TTL or not. `fingerprintedAt` is deliberately NOT bumped here, so
  // continuous polling still forces a real walk at least once per TTL.
  if (cached && hasLiveWorktree && cached.wtHeadSha !== null
    && now() - cached.fingerprintedAt < DIFF_FINGERPRINT_TTL_MS) {
    const headSha = (await readHeadSha(repoPath)) ?? "-";
    if (headSha === cached.wtHeadSha) {
      diffCache.delete(opts.branch); // move to the Map's end (most-recently-used)
      diffCache.set(opts.branch, cached);
      return cached.result;
    }
    // The canonical repo's HEAD moved -> fall through to a full recompute below (a real walk).
  }

  const { key, headSha } = await computeDiffCacheKey(repoPath, opts.branch, opts.worktreePath, fingerprint);
  // Derived from `key` itself (computeDiffCacheKey's OWN existence check), not from the outer
  // `hasLiveWorktree` sampled above — the worktree could vanish BETWEEN the two checks, and `key` is the
  // one that's authoritative for what was actually computed just now. Keeping a single source of truth
  // makes a `wt:...`-keyed entry with a null `wtHeadSha` (or vice versa) structurally impossible.
  const wtHeadSha = key !== null && key.startsWith("wt:") ? headSha : null;
  if (key !== null) {
    const existing = diffCache.get(opts.branch);
    if (existing && existing.key === key) {
      // Confirmed unchanged by a REAL walk just now -> refresh the TTL window forward from here.
      const refreshed: DiffCacheEntry = { ...existing, fingerprintedAt: now() };
      diffCache.delete(opts.branch);
      diffCache.set(opts.branch, refreshed);
      return refreshed.result;
    }
  }
  const result = await compute(repoPath, { branch: opts.branch, worktreePath: opts.worktreePath });
  if (key !== null) {
    diffCache.delete(opts.branch);
    diffCache.set(opts.branch, { key, result, wtHeadSha, fingerprintedAt: now() });
    while (diffCache.size > DIFF_CACHE_MAX_ENTRIES) {
      const oldest = diffCache.keys().next().value;
      if (oldest === undefined) break;
      diffCache.delete(oldest);
    }
  }
  return result;
}

/** TEST-ONLY: clear the diff cache between hermetic test cases that reuse the same temp dirs/branches. */
export function __resetWorkerDiffCacheForTest(): void {
  diffCache.clear();
}

/** TEST-ONLY: current diff-cache size, to prove the LRU bound actually evicts. */
export function __workerDiffCacheSizeForTest(): number {
  return diffCache.size;
}

/** @decision 52e978ad — the three verification modes are NOT interchangeable: `"content"` (byte-for-byte,
 *  strongest), `"pathset"` (same file set only, survives branch deletion), `"trailer-only"` (trailer PRESENCE
 *  alone, weakest — two indistinguishable causes). Never render all three as one flat "verified" tick. */
export type MergedVerificationMode = "content" | "pathset" | "trailer-only";

/** A task's landed squash-merge commit on main, as surfaced by {@link getTaskMergedInfo}. */
export interface MergedCommitInfo {
  /** Short (7-char) sha of the squash-merge commit. */
  sha: string;
  /** Strict ISO-8601 author date of that commit (git's `%aI`). */
  date: string;
  /**
   * Which of the three verification modes answered this — see {@link MergedVerificationMode}. Absent
   * means unknown/not computed by this caller (e.g. a persisted cache row written before this field
   * existed) — NEVER read absence as either "verified" or "unverified", just "no signal either way".
   */
  verification?: MergedVerificationMode;
}

/**
 * Bounded window over `base`'s history for {@link scanMergedCommitMap} — recent-first, so a repo with a
 * very long history can't make a `list_all_tasks`/`project_task_get` read scan unboundedly. A task
 * whose landed squash commit falls OUTSIDE this window resolves to `merged: null` — indistinguishable
 * from a genuinely never-merged task; see the fail-safe note on {@link getTaskMergedInfo}.
 */
const MERGED_LOOKUP_SCAN_LIMIT = 5000;

const MERGED_MAP_FIELD_SEP = "\x1f";
const MERGED_MAP_RECORD_SEP = "\x1e";

/**
 * Per-branch map entry: the landed commit's persisted `Loom-Worker-PathSet` digest, if this commit
 * carries one (card f621f185), else `null` for pre-fix history. `baseSha` (card d62dad73 phase 2, extended
 * to the solo path by card 756a2cd8) is the commit's own `Loom-Worker-Base` trailer value, if present — the
 * commit's explicit verification base (load-bearing for a batched multi-commit landing, redundant-but-
 * uniform for a solo squash); `null` for a commit that predates either fix, where `resolveMergedCommitMapHit`
 * falls back to `sha^` exactly as before (see {@link verifyPersistedPathSet}'s own doc). Exported (card
 * 6ee48e4d) only because it's structurally part of {@link MergedCommitScan}, itself exported for {@link
 * getMergedCommitMapCached} — {@link getTaskMergedInfo}'s own public return stays the plain {@link
 * MergedCommitInfo} shape.
 */
export interface MergedMapEntry extends MergedCommitInfo {
  pathSetDigest: string | null;
  baseSha: string | null;
  /** @decision c0d0eac9 — whether THIS candidate's own trailer parsed strict or tolerant; the map path's
   *  "newest verified wins, strict-first floor" walk ({@link resolveMergedCommitMapHitList}) needs this
   *  per-candidate, not just per-branch, now that a branch can carry more than one candidate. */
  strict: boolean;
}

/**
 * {@link scanMergedCommitMap}'s result, PLUS whether the scan was truncated by {@link
 * MERGED_LOOKUP_SCAN_LIMIT} — card 6ee48e4d. `truncated: false` means the scan saw FEWER commits than
 * the limit, i.e. it read `base`'s ENTIRE history: a `map` miss is then AUTHORITATIVE (the branch has no
 * `Loom-Worker-Branch` trailer anywhere reachable from `base`), not merely "not found in this window".
 * `truncated: true` covers both a genuine limit-hit AND any scan failure/timeout (the existing fail-safe
 * empty map) — a caller that wants to treat a miss as authoritative must check this flag first; treating
 * every miss as authoritative without it would silently narrow full-history detection.
 *
 * @decision c0d0eac9 — each branch now maps to a bounded, newest-first LIST of candidates (strict and
 * tolerant together), not a single "best guess" entry — see {@link resolveMergedCommitMapHitList}.
 */
export interface MergedCommitScan {
  map: Map<string, MergedMapEntry[]>;
  truncated: boolean;
}

/** @decision c0d0eac9 — caps how many candidates {@link scanMergedCommitMap} retains PER BRANCH; must stay
 *  >= `MIXED_VERIFY_CAP + STRICT_FALLBACK_VERIFY_CAP`, or the map path's own fallback walk could run out of
 *  retained strict candidates before `findLandedSquashCommit`'s own unbounded, fresh-per-call scan would. */
const MAP_CANDIDATE_LIST_CAP = MIXED_VERIFY_CAP + STRICT_FALLBACK_VERIFY_CAP;

/** @decision 6ee48e4d — one bounded `git log` pass building a `branch -> {sha, date, pathSetDigest, baseSha}`
 *  map, plus whether the scan was TRUNCATED — count EVERY record seen, never only trailer-matching ones, or a
 *  truncated scan can falsely report "complete". FAILS SAFE to an empty map with `truncated:true`. */
async function scanMergedCommitMap(
  repoPath: string, base = "HEAD", deps: BoundedGitDeps = {},
): Promise<MergedCommitScan> {
  const map = new Map<string, MergedMapEntry[]>();
  // @decision c0d0eac9 round 2 (finding 1, CRITICAL) — kept SEPARATE from `list.length`: a single shared
  // cap let enough tolerant-shaped candidates evict a genuine strict landing from the list entirely.
  // Mirrors findLandedSquashCommit's own two-phase walk AT STORAGE TIME — see that function's own doc.
  const perBranchCounts = new Map<string, { mixed: number; strict: number }>();
  let recordCount = 0;
  try {
    // boundedGit's simpleGit(repoPath, ...) constructor throws SYNCHRONOUSLY for a nonexistent baseDir
    // (GitConstructError) — this must be INSIDE the try, not before it, or a vault-only/moved-repo
    // project's repoPath breaks the fail-safe contract instead of resolving to an empty map.
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    const format = `%H${MERGED_MAP_FIELD_SEP}%aI${MERGED_MAP_FIELD_SEP}%B${MERGED_MAP_RECORD_SEP}`;
    // @decision abbda4f5 — same reorder as findLandedSquashCommit's own `log` call: `base` moved LAST
    // with `--end-of-options` immediately before it, so --format/-n stay real flags.
    const out = await withTimeout(
      git.raw(["log", `--format=${format}`, "-n", String(MERGED_LOOKUP_SCAN_LIMIT), "--end-of-options", base]),
      timeoutMs, "git log merged-commit scan",
    );
    for (const record of out.split(MERGED_MAP_RECORD_SEP)) {
      if (!record.trim()) continue;
      recordCount++;
      const sep1 = record.indexOf(MERGED_MAP_FIELD_SEP);
      const sep2 = record.indexOf(MERGED_MAP_FIELD_SEP, sep1 + 1);
      if (sep1 === -1 || sep2 === -1) continue;
      const sha = record.slice(0, sep1).trim();
      const date = record.slice(sep1 + 1, sep2).trim();
      const body = record.slice(sep2 + 1);
      if (!sha) continue;
      const strict = parseLoomTrailerBlock(body);
      // Tolerant fallback ONLY, never instead of the strict parse; every reader of this map
      // (resolveMergedCommitMapHit) independently verifies a candidate (content check / c13666c6's ledger
      // gate) before trusting it.
      const trailers = strict ?? tolerantFindLoomTrailerBlock(body);
      if (!trailers) continue;
      const branch = trailers.branch;
      let list = map.get(branch);
      if (!list) { list = []; map.set(branch, list); }
      let counts = perBranchCounts.get(branch);
      if (!counts) { counts = { mixed: 0, strict: 0 }; perBranchCounts.set(branch, counts); }
      const isStrict = strict !== null;
      // @decision c0d0eac9 — newest-first: the first MIXED_VERIFY_CAP candidates of ANY kind are kept;
      // past that, ONLY strict ones, up to STRICT_FALLBACK_VERIFY_CAP — a tolerant one past the mixed
      // window is dropped outright, never occupying a slot a strict candidate might still need.
      if (counts.mixed < MIXED_VERIFY_CAP) {
        list.push({ sha, date, pathSetDigest: trailers.pathSet, baseSha: trailers.base, strict: isStrict });
        counts.mixed++;
        if (isStrict) counts.strict++;
      } else if (isStrict && counts.strict < STRICT_FALLBACK_VERIFY_CAP) {
        list.push({ sha, date, pathSetDigest: trailers.pathSet, baseSha: trailers.base, strict: true });
        counts.strict++;
      }
    }
  } catch {
    return { map, truncated: true }; // fail safe: empty map + inconclusive -> every lookup misses AND must fall back
  }
  // @decision 6ee48e4d — log the no-PathSet-trailer count ONCE PER SCAN, never per lookup —
  // getTaskMergedInfo runs per task on every polled board read, so per-lookup logging would flood the daemon
  // log.
  let noPathSetTrailerCount = 0;
  for (const list of map.values()) for (const entry of list) if (entry.pathSetDigest === null) noPathSetTrailerCount++;
  if (noPathSetTrailerCount > 0) {
    // eslint-disable-next-line no-console
    console.info(`[git] scanMergedCommitMap: ${noPathSetTrailerCount} candidate(s) in ${repoPath} carry no ` +
      "Loom-Worker-PathSet trailer (pre-f621f185 legacy history, or a best-effort Base/PathSet stamp that " +
      "failed to land — logged at the stamp site when it happens) — trusting Loom-Worker-Branch presence " +
      "alone for those once their branch is gone, until re-merged");
  }
  return { map, truncated: recordCount >= MERGED_LOOKUP_SCAN_LIMIT };
}

/** Keyed per (REPO, scan BASE) pair (not per branch/task like {@link diffCache}) — card eb58b8bd widened
 *  this from per-REPO-alone once a caller (boot-reconcile Pass A) could request a scan base OTHER than
 *  `"HEAD"` for the same repoPath. Entry count is still bounded — by distinct (repo, base) pairs, never by
 *  board/task size, and in practice a repo has at most a small, fixed number of distinct bases ever
 *  requested (`"HEAD"` plus, at most, one stored mainline watermark ref per repoKey).
 *
 *  @decision eb58b8bd — the composite key's load-bearing job is protecting {@link mergedMapInFlight}'s
 *  dedup race, not `mergedMapCache`'s answer (which the sha freshness check already protects); never
 *  simplify it back to bare repoPath. */
const MERGED_MAP_CACHE_MAX_ENTRIES = 100;

interface MergedMapCacheEntry {
  headSha: string;
  map: Map<string, MergedMapEntry[]>;
  truncated: boolean;
}

/** Card eb58b8bd: a NUL can't appear in a real filesystem path or git ref name, so it's a safe join for a
 *  composite (repoPath, base) cache key without a collision risk a printable delimiter would carry. */
const mergedMapCacheKey = (repoPath: string, base: string): string => `${repoPath}\u0000${base}`;

const mergedMapCache = new Map<string, MergedMapCacheEntry>();

/**
 * In-flight scan promises, keyed by {@link mergedMapCacheKey} — CR follow-up (card 9983eed6): a cold cache
 * invalidates on EVERY HEAD move, i.e. every merge, which is exactly when a manager/companion board read
 * fans out across many tasks (`listProjectTasks`'s `Promise.all` over a project's tasks, or
 * `list_all_tasks` over many projects, or a companion + a manager reading concurrently). Without this map,
 * ALL of those callers would pass the `mergedMapCache` miss check before any of them finishes scanning
 * (`readHeadSha`'s fs read resolves far faster than the `git log -n 5000` subprocess), each spawning its
 * OWN full scan — N concurrent git-log-5000 processes on one repo instead of one. Registering the promise
 * HERE, SYNCHRONOUSLY, before any await (see {@link getOrStartMergedMapScan}), closes that race: every
 * caller that arrives while a scan is in flight joins the SAME promise instead of starting a new one.
 */
const mergedMapInFlight = new Map<string, Promise<MergedMapCacheEntry>>();

/**
 * Synchronous check-and-register: returns the ALREADY in-flight promise for this (repoPath, base) pair if
 * one exists, else starts exactly one and registers it before returning — so two calls issued back-to-back
 * (as `Array.prototype.map`/`Promise.all` do) can never both see "no scan in flight" and each start their
 * own. Not `async` itself — the async work lives in the IIFE, whose synchronous prefix (up to its first
 * `await`) still runs before this function returns, but the `mergedMapInFlight.set` below happens with NO
 * await in between the `.get` check and the `.set`, which is what makes the dedup race-free.
 *
 * `base === "HEAD"` is unchanged from before card eb58b8bd. For any other `base`, {@link readBaseSha} can
 * come back `null` (the ref genuinely doesn't resolve, e.g. a stored watermark branch that no longer
 * exists) — that call BYPASSES the cache entirely rather than caching under a constant key, which would
 * otherwise serve a stale scan forever for that base (see {@link readBaseSha}'s own doc).
 */
function getOrStartMergedMapScan(repoPath: string, base: string, deps: BoundedGitDeps): Promise<MergedMapCacheEntry> {
  const cacheKey = mergedMapCacheKey(repoPath, base);
  const existing = mergedMapInFlight.get(cacheKey);
  if (existing) return existing;
  const scan = (async (): Promise<MergedMapCacheEntry> => {
    try {
      const headSha = await readBaseSha(repoPath, base);
      if (headSha === null) {
        // Unresolvable non-HEAD base: never read from or write to mergedMapCache for this call — see
        // readBaseSha's doc for why a fallback key would be wrong, not merely imprecise.
        const { map, truncated } = await scanMergedCommitMap(repoPath, base, deps);
        return { headSha: "-", map, truncated };
      }
      const cached = mergedMapCache.get(cacheKey);
      if (cached && cached.headSha === headSha) {
        mergedMapCache.delete(cacheKey);
        mergedMapCache.set(cacheKey, cached); // move to the Map's end (most-recently-used)
        return cached;
      }
      const { map, truncated } = await scanMergedCommitMap(repoPath, base, deps);
      const entry: MergedMapCacheEntry = { headSha, map, truncated };
      mergedMapCache.delete(cacheKey);
      mergedMapCache.set(cacheKey, entry);
      while (mergedMapCache.size > MERGED_MAP_CACHE_MAX_ENTRIES) {
        const oldest = mergedMapCache.keys().next().value;
        if (oldest === undefined) break;
        mergedMapCache.delete(oldest);
      }
      return entry;
    } finally {
      // Always clear, even on an (unexpected — scanMergedCommitMap itself never throws) failure, so a
      // one-off error can't permanently wedge every future read of this (repo, base) pair behind a dead
      // in-flight slot.
      mergedMapInFlight.delete(cacheKey);
    }
  })();
  mergedMapInFlight.set(cacheKey, scan);
  return scan;
}

/**
 * Cached wrapper around {@link scanMergedCommitMap}: reuses the map (and its `truncated` flag — see
 * {@link MergedCommitScan}) across repeat reads of the same repo state for the same scan `base` (default
 * `"HEAD"`, unchanged for every caller that doesn't pass one), keyed on that base's own current sha
 * (fs-only, no subprocess — the SAME freshness-key idiom as {@link getWorkerDiffCached}'s `diffCache`). A
 * merge landing on `base` advances its sha, which invalidates the cache on the VERY NEXT read for that
 * base — a just-merged task resolves as soon as its base moves, never stale. Concurrent callers on a
 * cold/stale entry are deduped onto ONE scan by {@link getOrStartMergedMapScan} — see its comment for why
 * that dedup has to be synchronous, and for the non-`"HEAD"`-base cache-bypass case.
 */
export async function getMergedCommitMapCached(
  repoPath: string, base = "HEAD", deps: BoundedGitDeps = {},
): Promise<MergedCommitScan> {
  const entry = await getOrStartMergedMapScan(repoPath, base, deps);
  return { map: entry.map, truncated: entry.truncated };
}

/** {@link resolveMergedCommitMapHit}'s resolved answer: the verified sha PLUS which mode verified it —
 *  see {@link MergedVerificationMode}. `positiveProof` mirrors {@link verifyGoneBranchLanding}'s own
 *  field (card c0d0eac9 round 2) — `false` unconditionally for `verification: "content"` (branch-present
 *  never counts as positive authorship proof), threaded through for the two branch-gone tiers. */
interface ResolvedMergedHit {
  sha: string;
  verification: MergedVerificationMode;
  positiveProof: boolean;
}

/**
 * Shared verification body for a {@link scanMergedCommitMap} entry, factored out of {@link
 * getTaskMergedInfo} so {@link findLandedSquashCommitViaMap} can apply the IDENTICAL re-task-ancestry-
 * guard + content/path-set check a map hit needs, rather than a second hand-copied verification. Same
 * fail-safe contract as every verification in this file: any ambiguity returns `passed:false`/
 * `resolved:null` — never resolve ambiguity to `hit.sha`.
 *
 * `branchPresent` is a REQUIRED caller-supplied param (hoisted by {@link resolveMergedCommitMapHitList}),
 * never computed internally. Always returns all four fields (never a bare null), so {@link
 * walkCandidates} can see `error` — true on ANY non-definitive sub-check (a throw, or a `"error"` {@link
 * CheckVerdict}), never collapsed into a definitive `fail` (round 4, finding B1) — even when `passed` is
 * false; `resolved` is non-null exactly when `passed` is true.
 */
async function resolveMergedCommitMapHit(
  repoPath: string, branch: string, hit: MergedMapEntry, ref: string, branchPresent: boolean, deps: BoundedGitDeps,
): Promise<{ passed: boolean; positiveProof: boolean; error: boolean; resolved: ResolvedMergedHit | null }> {
  const fail = { passed: false, positiveProof: false, error: false, resolved: null };
  const errorOut = { passed: false, positiveProof: false, error: true, resolved: null };
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    if (branchPresent) {
      // @decision c0d0eac9 round 5 — same classification as findLandedSquashCommit's own re-task-guard
      // merge-base: empty output (no common ancestor) is DEFINITIVE, never "error" — see that call's own
      // comment for the full reasoning.
      // @decision 868e0135 — `--end-of-options` right after "merge-base": refs/heads/-qualified + a merged-commit-map hit's own sha.
      const mergeBase = (await withTimeout(
        git.raw(["merge-base", "--end-of-options", hit.sha, `refs/heads/${branch}`]), timeoutMs, "git merge-base",
      )).trim();
      if (mergeBase === "") return fail;
      if (mergeBase === hit.sha) return fail; // re-cut onto its own prior squash: live again, not landed
      const contentVerdict = await branchContentLandedInCommit(repoPath, branch, hit.sha, mergeBase, deps);
      if (contentVerdict === "error") return errorOut;
      if (contentVerdict !== "pass") return fail;
      return { passed: true, positiveProof: false, error: false, resolved: { sha: hit.sha, verification: "content", positiveProof: false } };
    }
    // Branch gone (card f621f185): verify against the persisted path-set trailer when this hit has one,
    // PLUS (card c13666c6) the ledger-cutover gate — see verifyGoneBranchLanding's own doc. `hit.baseSha`
    // (card d62dad73 phase 2 + card 756a2cd8) prefers the commit's own Loom-Worker-Base trailer when
    // present; undefined/null falls back to sha^ for a commit that predates either fix, exactly as before.
    // A pre-fix hit with no path-set trailer still runs the ledger gate — not logged here either way:
    // scanMergedCommitMap already logs the pre-fix count once per actual scan — see its own comment.
    const { passed, positiveProof, error } = await verifyGoneBranchLanding(git, timeoutMs, hit.sha, ref, hit.pathSetDigest, hit.baseSha ?? undefined, deps);
    if (!passed) return { passed: false, positiveProof, error, resolved: null };
    return { passed: true, positiveProof, error, resolved: { sha: hit.sha, verification: hit.pathSetDigest ? "pathset" : "trailer-only", positiveProof } };
  } catch {
    return errorOut; // fail safe: an UNCAUGHT throw is non-definitive (round 4)
  }
}

/** {@link resolveMergedCommitMapHitList}'s resolved answer: the winning candidate entry PLUS its verified
 *  result — callers need the entry back (e.g. for its `.date`) since the winner isn't always `list[0]`. */
interface ResolvedMergedHitList {
  entry: MergedMapEntry;
  resolved: ResolvedMergedHit;
}

/** @decision c0d0eac9 — the map path's twin of findLandedSquashCommit's own walk (both now delegate to
 *  the shared {@link walkCandidates}) — must stay behaviorally symmetric or the two readers can disagree
 *  on whether the same branch is landed. */
async function resolveMergedCommitMapHitList(
  repoPath: string, branch: string, candidates: MergedMapEntry[], ref: string, deps: BoundedGitDeps,
): Promise<ResolvedMergedHitList | null> {
  // @decision c0d0eac9 round 3 (finding 1, CRITICAL) — a branch-list failure fails the WHOLE lookup to
  // `null` (matching findLandedSquashCommit). Round 2's `branchPresent:false` degrade silently routed a
  // LIVE branch onto the branch-gone arm, skipping the re-task guard — never a false accept.
  let branchPresent: boolean;
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // @decision 7eac6366 — `--end-of-options` right before `branch` (see git/worktrees.ts:1300).
    branchPresent = (await withTimeout(git.raw(["branch", "--list", "--end-of-options", branch]), timeoutMs, "git branch --list")).trim() !== "";
  } catch {
    return null;
  }

  const walked = await walkCandidates(branch, "resolveMergedCommitMapHitList", candidates,
    (entry) => resolveMergedCommitMapHit(repoPath, branch, entry, ref, branchPresent, deps));
  return walked ? { entry: walked.candidate, resolved: walked.resolved } : null;
}

/** Batch-primitive sibling of {@link findLandedSquashCommit}: looks `branch` up against the shared cached
 *  map instead of paying its own `--grep` walk. `base` (card eb58b8bd) matches `findLandedSquashCommit`'s
 *  own `(repoPath, branch, base, deps)` convention — default `"HEAD"`, unchanged for every caller that
 *  doesn't pass one; a caller holding a resolved mainline watermark ref can pin the scan to it instead, to
 *  avoid trusting whatever the canonical checkout happens to be sitting on.
 *
 *  @decision 6ee48e4d — never treat `{hit:false}` as authoritative without checking `scanComplete` first —
 *  a `false` (truncated/errored scan) MUST fall back to {@link findLandedSquashCommit} directly (with the
 *  SAME `base`). */
export async function findLandedSquashCommitViaMap(
  repoPath: string, branch: string, base = "HEAD", deps: BoundedGitDeps = {},
): Promise<{ hit: true; sha: string | null } | { hit: false; scanComplete: boolean }> {
  const { map, truncated } = await getMergedCommitMapCached(repoPath, base, deps);
  const candidates = map.get(branch);
  if (!candidates || candidates.length === 0) return { hit: false, scanComplete: !truncated };
  const resolved = await resolveMergedCommitMapHitList(repoPath, branch, candidates, base, deps);
  return { hit: true, sha: resolved?.resolved.sha ?? null };
}

/** One entry of the Git tab's worker-branch enrichment — see {@link resolveWorkerBranchInfo}. */
export interface WorkerBranchInfo {
  branch: string;
  /** The branch's task title, from a batched DB lookup (`Db.getWorkerBranchTaskMap`) — `null` when no
   *  task mapping exists (a hand-created branch, or one whose task was since deleted). */
  taskTitle: string | null;
  /** This branch's git-derived ship state — `true` only for a VERIFIED landed squash (never a guess). */
  merged: boolean;
}

/**
 * Enrich a project's git branches with their resolved task title + merged flag for the Git tab's
 * branches endpoint (card e03b7ee4, follow-up to a044b33b). `taskMap` is the caller's already-batched
 * branch → task lookup (one query for the whole project, `Db.getWorkerBranchTaskMap`) — this function
 * makes no DB call itself.
 *
 * The merged flag REUSES {@link findLandedSquashCommitViaMap} — same cached {@link
 * getMergedCommitMapCached} map {@link getTaskMergedInfo} itself reads, so labelling N branches costs
 * ONE bounded `git log` scan per repo (shared + cache-gated on repo HEAD, same as every other caller of
 * that map), not one git subprocess per branch. Never throws: both the map scan and the per-hit
 * verification it delegates to are fail-safe (see their own docs), so a git error degrades every
 * affected branch to `merged: false` rather than failing this whole enrichment.
 */
export async function resolveWorkerBranchInfo(
  repoPath: string, branches: string[], taskMap: Map<string, { taskId: string; taskTitle: string }>,
  deps: BoundedGitDeps = {},
): Promise<WorkerBranchInfo[]> {
  return Promise.all(branches.map(async (branch) => {
    const result = await findLandedSquashCommitViaMap(repoPath, branch, "HEAD", deps);
    return {
      branch,
      taskTitle: taskMap.get(branch)?.taskTitle ?? null,
      merged: result.hit && result.sha !== null,
    };
  }));
}

/** @decision 52e978ad — is `taskId` merged? Keyed by the `Loom-Worker-Branch:` trailer, NEVER by title text
 *  — a title can be edited/coerced after merge, the trailer never drifts.
 *
 *  `null` covers several causes (never
 *  merged, outside scan window, re-task in progress, git error) — NEVER read as authoritative "never
 *  merged". */
export async function getTaskMergedInfo(
  repoPath: string, taskId: string, deps: BoundedGitDeps = {},
): Promise<MergedCommitInfo | null> {
  const branch = `loom/${taskKey(taskId)}`;
  const { map } = await getMergedCommitMapCached(repoPath, "HEAD", deps);
  const candidates = map.get(branch);
  if (!candidates || candidates.length === 0) return null;
  // Verification delegated to {@link resolveMergedCommitMapHitList} (card 6ee48e4d factored the
  // single-candidate verifier out of a hand-inlined copy here so boot-reconcile Pass A's {@link
  // findLandedSquashCommitViaMap} shares the IDENTICAL re-task-guard + content/path-set check; card
  // c0d0eac9 widened this to a bounded multi-candidate walk) — reports which of the two verification
  // means (or the pre-fix degrade) answered it (card 52e978ad) — see {@link MergedVerificationMode}.
  // `date` comes from the WINNING entry (`resolved.entry`), never `candidates[0]` — the winner isn't
  // always the newest candidate once the strict-fallback floor (card c0d0eac9) kicks in.
  const resolved = await resolveMergedCommitMapHitList(repoPath, branch, candidates, "HEAD", deps);
  if (!resolved) return null;
  return { sha: resolved.resolved.sha.slice(0, 7), date: resolved.entry.date, verification: resolved.resolved.verification };
}

/** TEST-ONLY: clear the merged-commit map cache (settled + in-flight) between hermetic test cases reusing the same temp repos.
 * ⚠️ GLOBAL clear — unlike the per-repo `withCanonicalIndexLock` (repo-lock.ts), which keys on `repoPath`, this
 * wipes EVERY repo's entries at once. Concurrent scenarios in different temp repos sharing this reset can
 * clobber each other's cache/in-flight state mid-scan — unaudited whether that yields a wrong value or a redundant recompute. */
export function __resetMergedCommitMapCacheForTest(): void {
  mergedMapCache.clear();
  mergedMapInFlight.clear();
}

/** Already-conventional subject: `type` (optional `(scope)`) (optional `!`) `: ` + a non-empty description.
 *  `CONVENTIONAL_TYPES` (the allowed type list, documented once in CLAUDE.md) now lives in
 *  `tasks/title-guard.js` — card 3a833d94 moved it there so the write-boundary type guard
 *  (`checkTitleConventionalType`) and this coercion regex read the SAME array instead of two
 *  hand-maintained copies; imported above alongside `checkTitleHtmlEntities`. */
const CONVENTIONAL_RE = new RegExp(
  `^(?:${CONVENTIONAL_TYPES.join("|")})(?:\\([^)]+\\))?!?: .+`,
);

/** Leading legacy bracket: `[Type]` or `[Type, Priority]` (case-insensitive on the type word). */
const LEGACY_BRACKET_RE = /^\[\s*([A-Za-z][A-Za-z/ ]*?)\s*(?:,[^\]]*)?\]\s*(.*)$/;

/** Legacy `[Type]` word → Conventional Commits type. Unknown / unmapped → `chore`. */
const LEGACY_TYPE_MAP: Record<string, string> = {
  bug: "fix",
  feature: "feat",
  refactor: "refactor",
  perf: "perf",
  docs: "docs",
  test: "test",
  maintenance: "chore",
  hardening: "fix",
  release: "chore",
};

/**
 * Coerce a commit subject into Conventional Commits form — the merge-code safety-net so every squash
 * commit on main is conventional even if a card title slips. PURE (no I/O), unit-tested.
 *
 * - Already-conventional (`^type(scope)!?: …`) → returned UNCHANGED.
 * - Legacy bracket (`[Bug, P2] …` / `[Release] …`) → map the type via {@link LEGACY_TYPE_MAP} (unknown →
 *   `chore`), strip the bracket → `"<type>: <rest>"`. A multi-type bracket (e.g. `[Bug/Docs]`) takes the
 *   FIRST listed type.
 * - Bare prose → prepend `"chore: "`.
 *
 * Description casing is left untouched; this only guarantees a valid lowercase type prefix.
 */
export function toConventionalSubject(raw: string): string {
  const subject = raw.trim();
  if (CONVENTIONAL_RE.test(subject)) return subject;

  const bracket = LEGACY_BRACKET_RE.exec(subject);
  if (bracket) {
    // First listed type in a multi-type bracket (e.g. "Bug/Docs" → "Bug"); ", Priority" already stripped.
    const typeWord = bracket[1]!.trim().split(/[/,]/)[0]!.trim().toLowerCase();
    const rest = bracket[2]!.trim();
    const type = LEGACY_TYPE_MAP[typeWord] ?? "chore";
    return rest ? `${type}: ${rest}` : `${type}:`;
  }

  return `chore: ${subject}`;
}

/** @decision 7a1a76e9 — taskless-merge fallback subject: the branch TIP commit's subject (`git log -1`),
 *  never the branch NAME (guaranteed unfindable on main after a squash) and never the FIRST commit either
 *  — the tip is closer to "what actually shipped." Fails safe to `undefined` on any error. */
export async function deriveTasklessSubject(repoPath: string, branch: string, deps: BoundedGitDeps = {}): Promise<string | undefined> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    const raw = await withTimeout(git.raw(["log", "-1", "--format=%s", `refs/heads/${branch}`]), timeoutMs, "git log -1 --format=%s (taskless subject)");
    const subject = raw.trim().split(/\r?\n/)[0]?.trim();
    return subject ? subject : undefined;
  } catch {
    return undefined;
  }
}

/** Bounds for {@link deriveWorkerCommitLogBody} — see that function's own doc for why both exist. */
const WORKER_COMMIT_LOG_MAX_ENTRIES = 20;
const WORKER_COMMIT_LOG_MAX_CHARS = 2000;

/** @decision 8b7b81e0 — recovers a worker's own per-commit messages into the squash BODY, never a new trailer
 *  (trailers are single-token facts, not prose) — `--no-merges` excludes the union-merge commit (main's own
 *  history replayed, never the worker's own work). BOUNDED with visible, never-silent truncation. */
async function deriveWorkerCommitLogBody(
  repoPath: string, branch: string, mergeBase: string, subject: string, deps: BoundedGitDeps = {},
): Promise<string | undefined> {
  let subjects: string[];
  try {
    // boundedGit's simpleGit(repoPath, ...) constructor throws SYNCHRONOUSLY for a nonexistent baseDir
    // (GitConstructError, see scanMergedCommitMap's own doc) — kept INSIDE this try, not before it, so
    // that failure degrades this best-effort body exactly like every other failure mode below.
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // @decision 868e0135 — `--end-of-options` immediately before the range (already the last positional): round-2 CR retracted the compound-suffix exemption this relied on.
    const raw = await withTimeout(
      git.raw(["log", "--no-merges", "--reverse", "--format=%s", "--end-of-options", `${mergeBase}..refs/heads/${branch}`]),
      timeoutMs, "git log (canonical, worker commit-log body)",
    );
    subjects = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return undefined; // best-effort: the squash still lands with a title-only body, exactly as before this card
  }
  // Each subject is checked DIRECTLY against matchReservedLoomTrailerLine (the SAME predicate
  // stripReservedLoomTrailerLines itself wraps) — no message-shaped probe/placeholder line needed, since
  // there is no "line 0 is the subject" exemption to route around when checking a bare subject list.
  // @decision 112b8d5d (round 2) — do not fold a worker subject into this body unstripped.
  const beforeStrip = subjects.length;
  subjects = subjects.filter((s) => !matchReservedLoomTrailerLine(s));
  const strippedCount = beforeStrip - subjects.length;
  if (strippedCount > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[git] mergeBranchLocked: stripped ${strippedCount} reserved Loom-* trailer line(s) from ` +
      `${branch}'s own commit(s) before folding them into the squash body — a worker's own commit carried a ` +
      `line in Loom's reserved merge-trailer namespace`);
  }
  // 8b7b81e0's own "pure duplicate" dedup — a lone surviving subject that merely repeats the squash
  // subject carries no new information, whether or not anything was ALSO stripped; the strip marker
  // below still surfaces independently of this dedup.
  if (subjects.length === 1 && subjects[0]!.toLowerCase() === subject.trim().toLowerCase()) subjects = [];
  if (subjects.length === 0 && strippedCount === 0) return undefined;

  const lines: string[] = [];
  let omitted = 0;
  let usedChars = 0;
  for (const s of subjects) {
    if (lines.length >= WORKER_COMMIT_LOG_MAX_ENTRIES) { omitted++; continue; }
    const bullet = `- ${s}`;
    if (usedChars + bullet.length + 1 > WORKER_COMMIT_LOG_MAX_CHARS) { omitted++; continue; }
    lines.push(bullet);
    usedChars += bullet.length + 1;
  }
  // A nonzero strippedCount keeps the body alive even when every surviving subject was too long to fit
  // (or none survived at all) — 8b7b81e0's "never truncate silently" contract extends to this strip too,
  // never silently degrading to a title-only commit the way a run with nothing stripped still correctly does.
  // @decision 112b8d5d (round 2) — the strip itself must stay VISIBLE, never silent.
  if (lines.length === 0 && omitted === 0 && strippedCount === 0) return undefined;
  if (omitted > 0) lines.push(`- …(${omitted} more commit${omitted === 1 ? "" : "s"})`);
  if (strippedCount > 0) {
    lines.push(`- …(${strippedCount} reserved-shaped worker commit subject(s) removed)`);
  }
  return `Worker commits:\n${lines.join("\n")}`;
}

/** @decision 591906ae — recovers a batched branch's non-tip commit subjects, which `ownTipSubject` alone
 *  misses (`merge_batch` lands every commit verbatim, never a squash) — never rely on `ownTipSubject` alone
 *  for a batched branch.
 *
 *  Reuses the SAME truncation caps as {@link deriveWorkerCommitLogBody}, never a second
 *  pair. */
export async function deriveOwnNonTipCommitSubjects(
  repoPath: string, branch: string, base = "HEAD", deps: BoundedGitDeps = {},
): Promise<{ subjects: string[]; truncated: boolean } | undefined> {
  let all: string[];
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    // @decision 868e0135 — `--end-of-options` right after "merge-base": `base`'s one caller always passes
    // the literal "HEAD" and `refs/heads/${branch}` is already qualified, but an option-shaped `base`
    // would otherwise be re-entered into merge-base's own option parser.
    const mergeBase = (await withTimeout(
      git.raw(["merge-base", "--end-of-options", base, `refs/heads/${branch}`]), timeoutMs, "git merge-base (own non-tip commit subjects)",
    )).trim();
    // @decision 868e0135 — `--end-of-options` immediately before the range (already the last positional): round-2 CR retracted the compound-suffix exemption this relied on.
    const raw = await withTimeout(
      git.raw(["log", "--no-merges", "--reverse", "--format=%s", "--end-of-options", `${mergeBase}..refs/heads/${branch}`]),
      timeoutMs, "git log (canonical, own non-tip commit subjects)",
    );
    all = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return undefined;
  }
  // Drop the tip — the LAST entry in this oldest-first range — it's already covered by ownTipSubject.
  const nonTip = all.slice(0, -1);
  if (nonTip.length === 0) return undefined;

  const subjects: string[] = [];
  let usedChars = 0;
  let truncated = false;
  for (const s of nonTip) {
    if (subjects.length >= WORKER_COMMIT_LOG_MAX_ENTRIES || usedChars + s.length + 1 > WORKER_COMMIT_LOG_MAX_CHARS) {
      truncated = true;
      continue;
    }
    subjects.push(s);
    usedChars += s.length + 1;
  }
  return { subjects, truncated };
}

/** @decision 2eddf573 — `mergeBranchLocked`'s squash-merge is IDEMPOTENT: never trust a staged-set snapshot
 *  from review time — re-derive at merge time from a clean index, distinguishing `"ALREADY_MERGED"` from
 *  `"STAGE_EMPTY_RETRY"` via `emptyKind`.
 *
 *  Never `reset --hard` on dirty tracked state at entry — refuse
 *  instead. */
export type MergeEmptyKind = "ALREADY_MERGED" | "STAGE_EMPTY_RETRY";

// ── Canonical-repo index mutex ───────────────────────────────────────────────────────────────────────
//
// `mergeBranchLocked` below stages + commits directly against the CANONICAL repo's shared git index — a
// process-wide, un-namespaced resource that `GitWriter.commit`/`checkout`/`createBranch` (git/writer.ts)
// can ALSO write to (the human-only REST git surface and the LOOM_DEV-gated Platform Lead tools). Both are admitted
// through the SAME `withCanonicalIndexLock` (git/repo-lock.ts — see that module for the full incident
// history, the "no timeout here" reasoning, and the non-reentrancy trace for this exact function).

/** @decision c0aeb5b2 — merges main's tip INTO the worktree BEFORE the gate — a REAL merge, never a rebase
 *  or squash, so `mainSha` becomes the merge-base the later squash diffs against. FAIL-CLOSED: any conflict or
 *  inconclusive failure returns `ok:false` — this function is itself a gate, never a best-effort probe. */
// Identity fallback (this merge runs unattended — the card-5150fdc2 stale-base auto-forward — so a host
// with no resolvable identity would otherwise fail the commit step) goes through the one shared helper,
// resolveGitIdentityFallbackArgs (card 2267e8fa, git/bounded.ts) — see that helper's own doc.

// Card eda70da6 (CR follow-up): `mainSha` is REQUIRED on every `ok:true` variant, by type, not just by
// convention — a future early-success return that forgot it would otherwise typecheck clean while silently
// making confirmWorkerMerge's `gateBaseMainHead` capture (and therefore mergeBranch's requireCanonicalHead
// re-check) vanish, fail-OPEN. The `ok:false` variant carries no such guarantee (nothing was unioned) and
// keeps its existing optional fields.
//
// `owedBase` (card 13fc5227): set ONLY for a HELD (batch-retained) branch, whose earlier commits main already carries as the batch's own cherry-picks. A plain `git merge` would
// resurrect main's copy of a file the branch's LATE commit deleted, so the union commit's tree is main plus the branch's still-owed COMMITS ({@link computeOwedLanding}), and the
// ordinary squash that follows lands exactly those. {@link verifyReviewedTipChain}'s `extraUnionBases` accepts a merge built this way.
//
// @decision 7e5b23e7 — this floor applies ONLY to the two mutating merge calls below, never the cheap
// reads elsewhere in this function or the shared per-call `gitOpMs` other callers pass as `timeoutMs`;
// do not raise 44c28799's file-wide 15s ceiling instead of this dedicated one.
const UNION_MERGE_TIMEOUT_FLOOR_MS = 45_000;

/** Matches the SHAPE of a `withTimeout`/`withTimeoutKillingChild` timeout rejection ("<label> exceeded
 *  <n>ms …") regardless of whether a real child was spawned (production) or the test-seam `gitFactory` was
 *  used (no real child to kill, so `withTimeout` alone produces this shape) — never an ordinary git
 *  conflict/refusal, whose text is git's own stderr instead. Checked ONLY after {@link treeDeathUnconfirmed}
 *  has already ruled out the unconfirmed-kill shape (a DIFFERENT, more specific message), so a match here
 *  always means either "confirmed dead" (a real spawn) or "abandoned, nothing left to confirm" (the test
 *  seam) — never a still-possibly-alive orphan. */
const TIMEOUT_SHAPED_RE = /exceeded \d+ms/;

/**
 * @decision 8c3d6c04 — do not add a code to this set on a hunch, and do not treat an unlisted code (incl.
 * `ENOENT`/`EACCES`) as transient: a missing/unexecutable git binary does not heal on retry, so caching
 * toward "deterministic" by default is the safe failure mode.
 */
const TRANSIENT_SPAWN_ERROR_CODES: ReadonlySet<string> = new Set(["EAGAIN", "EMFILE", "ENFILE", "EBUSY"]);

/** True iff `e` carries one of {@link TRANSIENT_SPAWN_ERROR_CODES} — a STRUCTURED check (the OS-assigned
 *  `.code`), never a message-text match. */
function isTransientSpawnErrorCode(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && TRANSIENT_SPAWN_ERROR_CODES.has(code);
}

export async function mergeMainIntoWorktree(
  repoPath: string, worktreePath: string, deps: BoundedGitDeps = {}, owedBase?: string, branch?: string,
): Promise<{ ok: true; merged: boolean; mainSha: string } | { ok: false; conflict?: boolean; reason?: string; quarantined?: boolean; transient?: boolean; residuePossible?: boolean; dirtyWorktree?: boolean; worktreeMissing?: boolean }> {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  // @decision 7e5b23e7 — only the two mutating merge calls below use this floor; every other git call in
  // this function (the cheap reads above/below, and computeOwedLanding's own merge-tree probes) keeps the
  // plain `timeoutMs` — see this constant's own doc for why.
  const mergeTimeoutMs = Math.max(timeoutMs, deps.unionMergeTimeoutFloorMs ?? UNION_MERGE_TIMEOUT_FLOOR_MS);
  // `wtGit` below is read-only (rev-parse/status/ls-files post-merge/post-abort inspection) — the actual
  // mutating merge calls thread `repoPath` as `trustedMainRoot` explicitly via `killableCanonicalRaw`
  // further down. `repoGit` reads `repoPath` itself (a DIRECTORY-shaped `.git`), which this opt-out never
  // affects either way.
  // @decision 3a5c5d4a (round 2, S2) — a reviewed advisory-read residual site.
  const makeGit = deps.gitFactory ?? ((p, ms) => canonicalGit(p, ms, undefined, undefined, undefined, undefined, BOUNDED_GIT_ADVISORY_READ));
  const repoGit = makeGit(repoPath, timeoutMs);
  // @decision c30952c1 — a missing worktree makes this constructor THROW SYNCHRONOUSLY (simple-git's own
  //  `GitConstructError`); every caller of this function assumes a `{ok:false,...}` result, never a thrown
  //  exception, so this must be caught here and turned into one, not left to propagate uncaught.
  let wtGit: ReturnType<typeof makeGit>;
  try {
    wtGit = makeGit(worktreePath, timeoutMs);
  } catch (e) {
    // @decision 89bc3b86 — never label this worktreeMissing when the path still exists on disk: every
    //  caller maps that flag to a distinct "worktree is gone" refusal, which would misreport a different,
    //  still-present-path failure (e.g. a transient fs/git-binary error) as the wrong cause.
    if (!fs.existsSync(worktreePath)) {
      return { ok: false, worktreeMissing: true, reason: `the worktree no longer exists: ${(e as Error).message}` };
    }
    return { ok: false, reason: `failed to construct a git handle for the worktree: ${(e as Error).message}` };
  }

  let mainSha: string;
  try {
    mainSha = (await withTimeout(repoGit.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (main)")).trim();
  } catch (e) {
    // @decision 8c3d6c04 — nothing lands from this bare read (no mutation), so a timeout OR a transient
    // spawn-error code here is always safe to mark `transient:true`; never add kill-confirmation to this
    // read as part of closing that gap — file a separate card instead (see the decision record).
    const transient = TIMEOUT_SHAPED_RE.test((e as Error)?.message ?? "") || isTransientSpawnErrorCode(e);
    // This read can carry a CanonicalGitRefusal (e.g. a commondir redirect) — route through
    // canonicalFailureMessage so its human guidance survives, not just the bare `.message`.
    const mainTipFailure = describeGitFailure(e);
    return { ok: false, reason: `failed to resolve main tip: ${canonicalFailureMessage(mainTipFailure, mainTipFailure.text)}`, ...(transient ? { transient: true } : {}) };
  }

  // `mainSha` (card eda70da6) rides along on EVERY success return below — it's the canonical main tip
  // THIS call actually read and unioned into the worktree, i.e. the exact sha the resulting worktree tree
  // (and therefore whatever gate validates it next) is provably based on. A caller that later needs to
  // re-verify canonical main hasn't moved since must compare against THIS sha, not a fresh HEAD read of
  // its own taken at some LATER point (e.g. gate admission) — the gap between this call and that later
  // point is exactly the window a fresh read would leave open. See confirmWorkerMerge's own doc for why.
  //
  // Already caught up? (worktree HEAD already has mainSha as an ancestor — the common case for a
  // freshly-cut branch.) A merge-base probe failure isn't fatal — fall through and let the merge attempt
  // below settle it either way.
  // A HELD branch (owedBase) never takes this shortcut: a worker's own merge of main can already contain main yet still carry a resurrected copy of what its late commit deleted.
  if (!owedBase) try {
    // @decision 868e0135 — `--end-of-options` right after "merge-base": mainSha is always rev-parse-derived.
    const mergeBase = (await withTimeout(wtGit.raw(["merge-base", "--end-of-options", "HEAD", mainSha]), timeoutMs, "git merge-base (worktree)")).trim();
    if (mergeBase === mainSha) return { ok: true, merged: false, mainSha };
  } catch { /* fall through to attempt the merge */ }

  // `git merge --no-edit` (and the owedBase branch's `commit-tree`, below) creates a real commit — on a
  // host where git can't resolve an identity for this commit (e.g. a CI runner) that step fails even
  // though the merge itself is clean. Falls back to a generic identity ONLY when git itself can't
  // determine one (card 2267e8fa) — a host whose own identity git can resolve (by ANY of its normal
  // rules, not just `user.name`/`user.email` config) is unaffected.
  // @decision 2267e8fa (card 7b59e981) — PER-ROLE env overrides, merged into each commit call's own explicit env below,
  // never a shared `-c user.*` pair spliced into argv.
  // @decision 3a5c5d4a (round 3, B2; round 4, B-1) — thread the probe's own `trustedMainRoot` as
  // `repoPath`'s resolved TOPLEVEL (never bare `repoPath`, which may itself be subdir-bound); a refusal
  // must fail this attempt closed, same posture as the main-tip resolve's own failure return above.
  let identityEnv: Record<string, string>;
  try {
    identityEnv = await resolveGitIdentityFallbackArgs(
      worktreePath, timeoutMs,
      deps.identityProbeGitFactory ?? (deps.gitFactory ? unpinnedProbeFactoryFromLegacy(deps.gitFactory) : undefined),
      undefined,
      defaultTrustedMainRoot(repoPath),
    );
  } catch (e) {
    // canonicalFailureMessage keeps a classified canonical-git refusal's human guidance here too —
    // `probeGitIdentResolvable` rethrows a CanonicalGitRefusal (e.g. a pinMismatch) verbatim.
    // canonicalFailureMessage's own refusal branches already open with "refused,"/"refusing," — dropping
    // "refused:" from this prefix avoids a literal doubled "refused: refused".
    const identityProbeFailure = describeGitFailure(e);
    return { ok: false, reason: `identity-fallback probe: ${canonicalFailureMessage(identityProbeFailure, identityProbeFailure.text)}` };
  }

  // @decision 7e5b23e7 — every mutating call below pins `quarantineRepoPath` to the CANONICAL `repoPath`,
  // never this worktree: a linked worktree shares the canonical repo's hooks dir + object database, so an
  // orphan here is the same hazard batch-merge.ts's own worktree calls already quarantine canonical for.
  let raisedToken: string | undefined;
  const onTreeDeathSettled = (confirmed: boolean): void => {
    if (confirmed && raisedToken) clearMergeQuarantineByToken(repoPath, raisedToken);
  };
  const quarantineLabel = branch ?? `(worktree union-merge: ${path.basename(worktreePath)})`;

  if (owedBase) {
    // @decision 13fc5227 — a HELD branch's union is built from the COMMITS it still owes (computeOwedLanding), never from a chosen merge base: the commit is (tip, main) with tree = main + those commits.
    // The commit is made by hand (commit-tree, then a fast-forward of the worktree) because `git merge` cannot produce that tree.
    let tip: string;
    let landing: OwedLanding;
    let commit: string;
    try {
      const wtRaw = (args: string[]) => withTimeout(wtGit.raw(args), timeoutMs, `git ${args[0]} (owed landing)`);
      tip = (await wtRaw(["rev-parse", "--verify", "HEAD"])).trim();
      landing = await computeOwedLanding(wtRaw, owedBase, tip, mainSha, timeoutMs);
      if (!landing.ok) return { ok: false, ...(landing.kind === "conflict" ? { conflict: true } : {}), reason: describeOwedFailure(landing) };
      // @decision 868e0135 — `--end-of-options` added: round-2 CR retracted the compound-suffix exemption this relied on.
      const tipTree = (await wtRaw(["rev-parse", "--verify", "--end-of-options", `${tip}^{tree}`])).trim();
      // @decision 868e0135 — `--end-of-options` right after "merge-base": tip/mainSha are both rev-parse-derived in this worktree.
      const mainIsAncestor = (await wtRaw(["merge-base", "--end-of-options", tip, mainSha])).trim() === mainSha;
      if (mainIsAncestor && landing.tree === tipTree) return { ok: true, merged: false, mainSha }; // the branch already IS main plus its owed commits
      // @decision 2267e8fa (card 7b59e981) — a one-off `canonicalGit` instance carries the fallback ONLY
      // when actually needed; `wtGit` is reused byte-identically otherwise, including under a test
      // gitFactory (never `.env()` on `wtGit` itself).
      //
      // CR ff3eec9f: `localReadGitEnv`, never a bare `{...nonInteractiveEnv(), ...identityEnv}` spread —
      // `commit-tree` had NO explicit env before this card, so simple-git's `blockUnsafeOperationsPlugin`
      // never ran on it; ANY explicit env arms that plugin, and `nonInteractiveEnv()` alone doesn't satisfy
      // it (scrubs editor/pager keys only, never the transport family) — an ambient `GIT_ASKPASS` (e.g.
      // VS Code's terminal) would throw "not permitted without allowUnsafeAskPass" otherwise.
      // `commit-tree` never touches a remote, so stripping the transport family here is safe.
      // Same advisory-read posture as `wtGit` above: `commit-tree` writes a dangling object only (no ref
      // moves), and a forged commondir here would just land the object in the wrong store, making the
      // later `--ff-only` land (trustedMainRoot-protected, below) fail loudly on a missing object.
      // @decision 3a5c5d4a (round 2, S2) — a reviewed advisory-read residual site.
      const commitTreeGit = (Object.keys(identityEnv).length > 0 && !deps.gitFactory)
        ? canonicalGit(worktreePath, timeoutMs, localReadGitEnv(nonInteractiveEnv(), identityEnv), undefined, undefined, undefined, BOUNDED_GIT_ADVISORY_READ)
        : wtGit;
      commit = (await withTimeout(
        commitTreeGit.raw(["commit-tree", landing.tree, "-p", tip, "-p", mainSha, "-m", `Merge main into branch (owed commits over ${owedBase.slice(0, 8)})`]),
        timeoutMs, "git commit-tree (owed landing)",
      )).trim();
    } catch (e) {
      const d = describeGitFailure(e);
      // @decision 8c3d6c04 — these are bare-`withTimeout` reads/a `commit-tree` write of a dangling object
      // (nothing lands: no ref moves, no working-tree mutation), so the SAME "nothing lands, retry is
      // always safe" reasoning as the main-tip resolve above applies to a timeout here too.
      const transient = !d.refusal && (TIMEOUT_SHAPED_RE.test(d.text) || isTransientSpawnErrorCode(e));
      return { ok: false, reason: canonicalFailureMessage(d, `late-range union of main into the worktree failed: ${d.text}`), ...(transient ? { transient: true } : {}) };
    }

    // `--ff-only` either lands instantly or fails with NO merge in progress (no MERGE_HEAD, no partial
    // index) — there is no conflict-cleanup step here, only verify-landed (did it land right at the kill
    // boundary?) and verify-clean (is it safe to retry?).
    const verifyOwedLanded = async (): Promise<boolean> => {
      try { return (await withTimeout(wtGit.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (owed landing, verify)")).trim() === commit; }
      catch { return false; }
    };
    const verifyOwedCleanAt = async (expectedHead: string): Promise<boolean> => {
      try {
        const head = (await withTimeout(wtGit.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (owed landing, clean-check)")).trim();
        const dirty = (await withTimeout(wtGit.raw(["status", "--porcelain", "--untracked-files=no"]), timeoutMs, "git status (owed landing, clean-check)")).trim();
        return head === expectedHead && dirty === "";
      } catch { return false; }
    };
    // @decision 8c3d6c04 round 3 — the owed-landing `--ff-only` path's own pre-attempt dirt check, matching
    // the plain-union path's `preMergeStamp`/`preMergeDirty` (declared further below, out of this branch's
    // reach since this `if (owedBase)` block always returns before falling through to it).
    const preOwedStamp = await computeWorktreeGateStamp(worktreePath, { timeoutMs, gitFactory: deps.gitFactory });
    const preOwedDirty = preOwedStamp.dirty;

    for (let attempt = 1; ; attempt++) {
      try {
        await killableCanonicalRaw(worktreePath, ["merge", "--ff-only", commit], mergeTimeoutMs, "git merge --ff-only (owed landing)", deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled, repoPath);
        return { ok: true, merged: true, mainSha };
      } catch (e) {
        if (e instanceof RepoQuarantinedError) return { ok: false, quarantined: true, reason: e.message };
        if (treeDeathUnconfirmed(e)) {
          raisedToken = enterMergeQuarantine(repoPath, quarantineLabel, unconfirmedKillReason("owed-landing fast-forward could not be confirmed dead after a kill"));
          return { ok: false, quarantined: true, reason: `owed-landing fast-forward's git process tree could not be confirmed dead after a kill — refusing further cleanup to avoid racing it: ${(e as Error).message}` };
        }
        const d = describeGitFailure(e);
        const isConfirmedKillTimeout = !d.refusal && TIMEOUT_SHAPED_RE.test(d.text);
        if (isConfirmedKillTimeout && (await verifyOwedLanded())) return { ok: true, merged: true, mainSha };
        // @decision 8c3d6c04 round 3 — matches the plain-union path: a NON-timeout failure on a tree
        // already dirty before this attempt classifies as dirtyWorktree, never on a confirmed-kill timeout
        // (residue there may need more than a plain commit) and never on a refusal (its own cause).
        if (preOwedDirty && !isConfirmedKillTimeout && !d.refusal) {
          return { ok: false, reason: `late-range union of main into the worktree failed: ${d.text} (the worktree already carried uncommitted changes before this merge was attempted)`, dirtyWorktree: true };
        }
        // Card 7e5b23e7 — ONE bounded retry, gated on all three: (i) a confirmed-kill timeout (never
        // treeDeathUnconfirmed/a refusal, both already returned above), (ii) verify-landed just said no,
        // (iii) the worktree is independently verified back at its pre-attempt state.
        // Card 7e5b23e7 round 2 — `deps.allowRetry === false` (set only by `reunionAtAdmission`'s own
        // call, which holds a scarce fleet-shared gate slot) skips the retry outright; see BoundedGitDeps.
        if (deps.allowRetry !== false && isConfirmedKillTimeout && attempt === 1 && (await verifyOwedCleanAt(tip))) {
          // eslint-disable-next-line no-console
          console.log(`[union-merge] owed-landing fast-forward timed out (confirmed dead), worktree verified clean — retrying once (${worktreePath})`);
          continue;
        }
        // @decision 8c3d6c04 — a confirmed-kill timeout here (even one that already exhausted the one
        // internal retry above) still describes momentary host/process conditions, not the branch's or
        // main's content; same for a transient spawn-error code. Never set alongside a refusal.
        const transient = isConfirmedKillTimeout || (!d.refusal && isTransientSpawnErrorCode(e));
        return { ok: false, reason: canonicalFailureMessage(d, `late-range union of main into the worktree failed: ${d.text}`), ...(transient ? { transient: true } : {}) };
      }
    }
  }

  // Plain union producer. `verifyUnionLanded`/the post-abort clean-check below mirror
  // fastForwardCanonicalMain's own post-failure HEAD re-read (batch-merge.ts) — a hung post-merge hook can
  // outlive the timeout AFTER the merge commit already landed; re-verify before reporting a false failure.
  //
  // Card 7e5b23e7 — deliberately NOT gated on `MERGE_HEAD` absence: VERIFIED directly against real git
  // (2.47) that `MERGE_HEAD` is still present while `post-merge` itself is running, even though HEAD has
  // already moved to the real merge commit — checking it here would misreport an already-landed merge as
  // still mid-merge whenever the kill lands during a slow post-merge hook (exactly the case this check
  // exists to catch). `merge-base(HEAD, mainSha) === mainSha` alone is the correct, sufficient signal: a
  // genuinely unfinished/conflicted merge leaves HEAD at its OLD tip, which this can never satisfy.
  const verifyUnionLanded = async (): Promise<boolean> => {
    try {
      // @decision 868e0135 — `--end-of-options` right after "merge-base": mainSha is always rev-parse-derived.
      return (await withTimeout(wtGit.raw(["merge-base", "--end-of-options", "HEAD", mainSha]), timeoutMs, "git merge-base (verify landed)")).trim() === mainSha;
    } catch { return false; }
  };
  const verifyWorktreeCleanAt = async (expectedHead: string): Promise<boolean> => {
    let mergeHeadPresent = false;
    try {
      mergeHeadPresent = (await withTimeout(wtGit.raw(["rev-parse", "-q", "--verify", "MERGE_HEAD"]), timeoutMs, "git rev-parse MERGE_HEAD (post-abort clean-check)")).trim() !== "";
    } catch { /* absent, as expected after a clean abort */ }
    if (mergeHeadPresent) return false;
    try {
      const head = (await withTimeout(wtGit.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (post-abort clean-check)")).trim();
      const dirty = (await withTimeout(wtGit.raw(["status", "--porcelain", "--untracked-files=no"]), timeoutMs, "git status (post-abort clean-check)")).trim();
      return head === expectedHead && dirty === "";
    } catch { return false; }
  };
  // @decision 8c3d6c04 round 2 — reuses `computeWorktreeGateStamp` (never a second, hand-rolled dirt
  // check) for the pre-attempt HEAD and whether the worktree was ALREADY dirty before this merge ran.
  const preMergeStamp = await computeWorktreeGateStamp(worktreePath, { timeoutMs, gitFactory: deps.gitFactory });
  const preAttemptHead = preMergeStamp.head ?? undefined;
  const preMergeDirty = preMergeStamp.dirty;

  for (let attempt = 1; ; attempt++) {
    let mergeThrew = false;
    let mergeErr = "";
    let mergeRefused = false;
    // @decision a8bc0404 (Code Review m6) — the WHOLE describeGitFailure() result, never per-field
    // copies (why mergePinMismatch had to be added by hand) — a future field reaches the site below free.
    let mergeDescribe: ReturnType<typeof describeGitFailure> | undefined;
    // @decision 8c3d6c04 — the raw error object, kept alongside `mergeErr`'s extracted text so a later
    // spawn-error-code check (`isTransientSpawnErrorCode`) can read its structured `.code`.
    let mergeErrObj: unknown;
    try {
      await killableCanonicalRaw(worktreePath, ["merge", "--no-edit", mainSha], mergeTimeoutMs, "git merge main into worktree", deps.gitFactory, { ...nonInteractiveEnv(), ...identityEnv }, onTreeDeathSettled, repoPath);
    } catch (e) {
      if (e instanceof RepoQuarantinedError) return { ok: false, quarantined: true, reason: e.message };
      if (treeDeathUnconfirmed(e)) {
        raisedToken = enterMergeQuarantine(repoPath, quarantineLabel, unconfirmedKillReason("git merge main into worktree could not be confirmed dead after a kill"));
        return { ok: false, quarantined: true, reason: `git merge main into worktree's process tree could not be confirmed dead after a kill — refusing further cleanup to avoid racing it: ${(e as Error).message}` };
      }
      mergeThrew = true; // a conflict OR a real failure — the explicit checks below decide which
      const d = describeGitFailure(e); // surfaced in the reason: a canonicalGit refusal (unblankable merge driver) must not read as a bare "failed"
      mergeErr = d.text;
      mergeRefused = d.refusal;
      mergeDescribe = d;
      mergeErrObj = e;
    }

    const isConfirmedKillTimeout = mergeThrew && !mergeRefused && TIMEOUT_SHAPED_RE.test(mergeErr);
    if (isConfirmedKillTimeout && (await verifyUnionLanded())) {
      // @decision 7e5b23e7 — a kill during a slow `post-merge` hook can leave MERGE_HEAD/MERGE_MSG/
      // MERGE_MODE/AUTO_MERGE behind after a landed merge; clear with `--quit` ONLY when they provably
      // belong to THIS merge, never some other, unrelated in-progress one.
      // @decision 7e5b23e7 round 3 — tri-state read: a read failure (e.g. a timeout) is never "absent".
      const readMergeHead = async (): Promise<{ state: "absent" } | { state: "present"; sha: string } | { state: "unreadable"; error: string }> => {
        try {
          const out = (await withTimeout(wtGit.raw(["rev-parse", "-q", "--verify", "MERGE_HEAD"]), timeoutMs, "git rev-parse MERGE_HEAD (post-kill cleanup check)")).trim();
          return out === "" ? { state: "absent" } : { state: "present", sha: out };
        } catch (e) { return { state: "unreadable", error: (e as Error).message }; }
      };
      const mergeHeadRead = await readMergeHead();
      if (mergeHeadRead.state === "unreadable") {
        // Same rule as the `--quit` failure below: never silently report ok:true over something we could
        // not actually confirm — a failed read is not evidence of absence.
        // @decision 8c3d6c04 round 2 — this block is gated on `isConfirmedKillTimeout && verifyUnionLanded()`:
        // the union ALREADY LANDED (HEAD moved) — never `transient` ("nothing changed" would be false here).
        return { ok: false, reason: `the merge of main landed, but MERGE_HEAD could not be read to confirm whether cleanup is needed: ${mergeHeadRead.error} — re-confirm to continue (the branch tip has moved)` };
      }
      if (mergeHeadRead.state === "absent") return { ok: true, merged: true, mainSha }; // the common case: nothing left to clean up
      const mergeHeadSha = mergeHeadRead.sha;
      if (mergeHeadSha === mainSha) {
        let headSecondParent: string | undefined;
        try {
          const out = (await withTimeout(wtGit.raw(["rev-parse", "-q", "--verify", "HEAD^2"]), timeoutMs, "git rev-parse HEAD^2 (post-kill cleanup check)")).trim();
          headSecondParent = out === "" ? undefined : out;
        } catch { /* unreadable — leave MERGE_HEAD in place rather than guess; the re-check below still fires */ }
        if (headSecondParent === mainSha) {
          try {
            await killableCanonicalRaw(worktreePath, ["merge", "--quit"], timeoutMs, "git merge --quit (post-kill MERGE_HEAD cleanup)", deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled, repoPath);
          } catch (e) {
            if (e instanceof RepoQuarantinedError) return { ok: false, quarantined: true, reason: e.message };
            if (treeDeathUnconfirmed(e)) {
              raisedToken = enterMergeQuarantine(repoPath, quarantineLabel, unconfirmedKillReason("post-kill MERGE_HEAD cleanup (merge --quit) could not be confirmed dead after a kill"));
              return { ok: false, quarantined: true, reason: `post-kill MERGE_HEAD cleanup (merge --quit)'s process tree could not be confirmed dead after a kill — refusing further cleanup to avoid racing it: ${(e as Error).message}` };
            }
            // @decision 7e5b23e7 — deliberately NOT swallowed: silently reporting ok:true with MERGE_HEAD
            // still present would reinstate the bug this fix closes. Fall through to the re-check below.
          }
        }
      }
      // @decision 7e5b23e7 — MERGE_HEAD is only safe to call "cleared" once re-verified absent; a leftover
      // here means the NEXT mergeMainIntoWorktree call would hit "You have not concluded your merge" —
      // report that now, loudly, instead of a false ok:true.
      const mergeHeadAfterRead = await readMergeHead();
      if (mergeHeadAfterRead.state === "unreadable") {
        return { ok: false, reason: `the merge of main landed, but could not confirm MERGE_HEAD was cleared afterward: ${mergeHeadAfterRead.error} — re-confirm to continue (the branch tip has moved)` };
      }
      if (mergeHeadAfterRead.state === "present") {
        return { ok: false, reason: `the merge of main landed, but its in-progress merge state (MERGE_HEAD) could not be cleared: MERGE_HEAD still present (${mergeHeadAfterRead.sha.slice(0, 8)}) — re-confirm to continue (the branch tip has moved)` };
      }
      return { ok: true, merged: true, mainSha };
    }

    let conflicted: boolean;
    try {
      conflicted = (await withTimeout(wtGit.raw(["ls-files", "--unmerged"]), timeoutMs, "git ls-files --unmerged (worktree)")).trim() !== "";
    } catch (e) {
      // Can't even determine the merge state — fail closed rather than assert a false "clean".
      return { ok: false, reason: `failed to inspect worktree merge state: ${(e as Error).message}` };
    }

    if (conflicted) {
      try {
        await killableCanonicalRaw(worktreePath, ["merge", "--abort"], timeoutMs, "git merge --abort (worktree)", deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled, repoPath);
      } catch (e) {
        if (e instanceof RepoQuarantinedError) return { ok: false, quarantined: true, conflict: true, reason: `conflict cleanup (merge --abort) refused — canonical repo is quarantined: ${e.message}` };
        if (treeDeathUnconfirmed(e)) {
          raisedToken = enterMergeQuarantine(repoPath, quarantineLabel, unconfirmedKillReason("conflict cleanup (merge --abort) could not be confirmed dead after a kill"));
          return { ok: false, quarantined: true, conflict: true, reason: `conflict cleanup (merge --abort)'s process tree could not be confirmed dead after a kill — refusing further cleanup to avoid racing it: ${(e as Error).message}` };
        }
        return { ok: false, conflict: true, reason: `conflict cleanup (merge --abort) failed — worktree may have unmerged residue: ${(e as Error).message}` };
      }
      return { ok: false, conflict: true };
    }
    if (mergeThrew) {
      // Symmetric with the conflict cleanup above: `merge --abort` also resets the working tree, and
      // additionally clears a stale MERGE_HEAD if the errored merge happened to leave one (a plain
      // `reset --hard HEAD` would not) — `git merge --abort` is a no-op error when there's nothing to
      // abort, so its failure here is swallowed exactly like the conflict path's own best-effort intent,
      // UNLESS it's itself a quarantine-worthy outcome (already-quarantined, or a fresh unconfirmed kill).
      let abortQuarantined = false;
      let abortQuarantineReason = "";
      try {
        await killableCanonicalRaw(worktreePath, ["merge", "--abort"], timeoutMs, "git merge --abort (worktree)", deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled, repoPath);
      } catch (e) {
        if (e instanceof RepoQuarantinedError) { abortQuarantined = true; abortQuarantineReason = e.message; }
        else if (treeDeathUnconfirmed(e)) {
          raisedToken = enterMergeQuarantine(repoPath, quarantineLabel, unconfirmedKillReason("post-failure cleanup (merge --abort) could not be confirmed dead after a kill"));
          abortQuarantined = true;
          abortQuarantineReason = `post-failure cleanup (merge --abort)'s process tree could not be confirmed dead after a kill — refusing further cleanup to avoid racing it: ${(e as Error).message}`;
        }
        /* otherwise best-effort, as before: expected when there's nothing to abort */
      }
      if (abortQuarantined) return { ok: false, quarantined: true, reason: abortQuarantineReason };
      // mergeDescribe is always set alongside mergeRefused (same catch block, same assignment) — the `!`
      // mirrors the same guaranteed-together invariant mergeErr/mergeRefused already relied on.
      if (mergeRefused) return { ok: false, reason: canonicalFailureMessage(mergeDescribe!, mergeErr) };

      // @decision 8c3d6c04 round 3 — `!isConfirmedKillTimeout` is load-bearing: a confirmed-kill timeout on
      // an already-dirty tree must fall through to the ordinary residue/transient handling below, unchanged
      // — "commit" advice is wrong when the interrupted merge may have folded residue into that same dirt.
      if (preMergeDirty && !isConfirmedKillTimeout) {
        return { ok: false, reason: (mergeErr ? `git merge main into worktree failed: ${mergeErr}` : "git merge main into worktree failed") + " (the worktree already carried uncommitted changes before this merge was attempted)", dirtyWorktree: true };
      }

      // Card 7e5b23e7 — ONE bounded retry, gated on all three: (i) a confirmed-kill timeout, (ii)
      // verify-landed already said no (checked above), (iii) the worktree is independently verified back
      // at ITS OWN pre-attempt HEAD (never racing whatever the abort may or may not have cleaned up).
      // Card 7e5b23e7 round 2 — `deps.allowRetry === false` (set only by `reunionAtAdmission`'s own
      // call, which holds a scarce fleet-shared gate slot) skips the retry outright; see BoundedGitDeps.
      if (deps.allowRetry !== false && isConfirmedKillTimeout && attempt === 1 && preAttemptHead !== undefined && (await verifyWorktreeCleanAt(preAttemptHead))) {
        // eslint-disable-next-line no-console
        console.log(`[union-merge] git merge main into worktree timed out (confirmed dead), worktree verified clean after abort — retrying once (${worktreePath})`);
        continue;
      }
      // @decision 7e5b23e7 — a confirmed-kill timeout reaching here may be a kill during `pre-merge-commit`
      // that left STAGED merge content with no MERGE_HEAD (so `merge --abort` above had nothing to act
      // on) — name that possibility rather than a bare "failed".
      const residueNote = isConfirmedKillTimeout
        ? " (a confirmed-kill timeout here can leave staged, uncommitted merge content in the worktree with no MERGE_HEAD to abort — merge --abort had nothing to act on; inspect/reset the worktree before retrying)"
        : "";
      // @decision 8c3d6c04 — a confirmed-kill timeout (even one that already exhausted the one internal
      // retry above) or a transient spawn-error code describes momentary host/process conditions, not the
      // branch's or main's content. Never set alongside a refusal (`mergeRefused` already returned above).
      const transient = isConfirmedKillTimeout || (!mergeRefused && isTransientSpawnErrorCode(mergeErrObj));
      // @decision 8c3d6c04 round 2 — `residuePossible` mirrors `residueNote`: a caller must never claim
      // "nothing was changed" when this is true (staged, uncommitted merge content may be sitting there).
      return { ok: false, reason: (mergeErr ? `git merge main into worktree failed: ${mergeErr}` : "git merge main into worktree failed") + residueNote, ...(transient ? { transient: true } : {}), ...(residueNote ? { residuePossible: true } : {}) };
    }
    return { ok: true, merged: true, mainSha };
  }
}

/**
 * Card bbccf470 — the STRUCTURAL check behind "is this branch's tip still the tip the manager reviewed, plus only Loom's own advances?". Derived from git alone
 * (nothing is stored, so nothing can be forged, overwritten or left behind): walk back from `live`; a step prev→cur is a daemon advance only if
 *  (a) `cur` is on canonical main's history and `reviewed` is an ancestor of `cur` (a fast-forward through main — e.g. the stale-base forward of a branch with no own
 *      commits), which ends the walk as unmoved; or
 *  (b) `cur` is a merge commit whose parents are exactly [prev, M], with M on canonical main and `cur`'s tree equal to `git merge-tree --write-tree prev M` — i.e. exactly
 *      what {@link mergeMainIntoWorktree}'s `git merge` produces; the walk continues from `prev`.
 * Reaching `reviewed` ⇒ ok. Anything else (a worker commit, a merge with conflict-resolution content, a foreign parent) ⇒ not ok. Bounded (`REVIEWED_TIP_WALK_MAX_HOPS`) and
 * FAIL CLOSED on any git error. Read-only.
 *
 * @decision bbccf470 — never store or trust a per-branch "advanced to" record (a shared ref/file is agent-writable and was forged in review); never accept "some merge commit" as daemon-authored.
 */
export const REVIEWED_TIP_WALK_MAX_HOPS = 32;

/**
 * Card 13fc5227 — the work a HELD branch still owes main, modelled as COMMITS and never as a merge base (three merge-base rules were each defeated by some history): the NON-MERGE commits of
 * `base..tip` (`base` = the tip a retaining merge landed) that are not reachable from `main`, in TOPOLOGICAL order (`--topo-order`: parents first whatever the committer dates say), each
 * cherry-picked onto main with git's own three-way (`merge-tree --write-tree --merge-base=<c>^ <cur> <c>`, i.e. what `cherry-pick` computes) into throwaway commit objects: nothing is checked
 * out and no ref moves. Merge commits are skipped ONLY when `merge_batch`'s own predicate allows it ({@link mergeCommitBlocksLinearization}: every non-first parent on main and no resolution
 * content of its own) or when the merge is Loom's own union (its tree is exactly what this function makes of its parents); any other merge REFUSES (`kind:"merge"`), because skipping it would
 * silently lose what it carries (card bc2240d7). A commit that does not apply fails closed naming it (`kind:"conflict"`, never auto-resolved); one that applies as a no-op is skipped and flagged
 * `emptyOnMain`. `tree` is main plus the owed commits — what worker_merge_confirm lands and the gate tests, and what worker_merge shows. ONE function, so review and landing cannot diverge;
 * every merge-tree pins `--attr-source=<tip>` so worktree and canonical callers read the same merge drivers. THROWS on a git error (callers fail closed). Needs git >= 2.40.
 */
export type OwedLanding =
  | { ok: true; tree: string; mainTree: string; commits: { sha: string; subject: string; emptyOnMain: boolean }[] }
  | { ok: false; kind: "conflict"; commit: string; subject: string }
  | { ok: false; kind: "merge"; commit: string; subject: string; why: string };

export async function computeOwedLanding(
  raw: (args: string[]) => Promise<string>, base: string, tip: string, main: string, timeoutMs: number, depth = 0,
): Promise<OwedLanding> {
  const oid = /^[0-9a-f]{40,64}$/;
  const lines = (text: string) => text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const identity = ["-c", `user.name=${FALLBACK_GIT_IDENTITY.name}`, "-c", `user.email=${FALLBACK_GIT_IDENTITY.email}`];
  // @decision 868e0135 — `--end-of-options` before `sha`: MEASURED, `git log -1 --format=%s --all` (option-shaped) would otherwise silently read some OTHER commit's subject instead of erroring.
  const subjectOf = async (sha: string) => (await raw(["log", "-1", "--format=%s", "--end-of-options", sha])).trim();
  // @decision 4b559feb — `--end-of-options` right after `--not`, before `main`: `--not` must stay BEFORE
  // the marker (MEASURED: any earlier placement swallows `--not` itself, flipping the range's sign too).
  // The range needs no marker of its own — see the decision record for why.
  const merges = lines(await raw(["rev-list", "--merges", `${base}..${tip}`, "--not", "--end-of-options", main]));
  if (merges.length > MAX_MERGE_COMMITS_CHECKED) return { ok: false, kind: "merge", commit: merges[0]!, subject: await subjectOf(merges[0]!), why: `is one of ${merges.length} merge commits in the range (more than ${MAX_MERGE_COMMITS_CHECKED} are checked)` };
  for (const m of merges) {
    const why = await mergeCommitBlocksLinearization({ raw: raw as unknown as SimpleGit["raw"] }, m, main, timeoutMs);
    if (!why) continue;
    // Loom's own union commit (parents [previous tip, main-at-the-time], tree = that tip plus main plus the owed commits) legitimately differs from a plain merge; accept exactly that shape.
    // @decision 4b559feb — `--end-of-options` before `m`: a sha read back from the `rev-list --merges` call above.
    const parents = lines(await raw(["rev-list", "--parents", "-n", "1", "--end-of-options", m])).flatMap((l) => l.split(/\s+/)).slice(1);
    let ownUnion = false;
    if (parents.length === 2 && depth < 8) {
      const inner = await computeOwedLanding(raw, base, parents[0]!, parents[1]!, timeoutMs, depth + 1);
      // @decision 868e0135 — `--end-of-options` added: round-2 CR retracted the compound-suffix exemption this relied on.
      ownUnion = inner.ok && inner.tree === (await raw(["rev-parse", "--verify", "--end-of-options", `${m}^{tree}`])).trim();
    }
    if (!ownUnion) return { ok: false, kind: "merge", commit: m, subject: await subjectOf(m), why };
  }
  // @decision 4b559feb — `--end-of-options` right after `--not`, same placement/reason as the `merges` read above.
  const owed = lines(await raw(["rev-list", "--reverse", "--topo-order", "--no-merges", `${base}..${tip}`, "--not", "--end-of-options", main]));
  // @decision 868e0135 — `--end-of-options` added: round-2 CR retracted the compound-suffix exemption this relied on.
  const mainTree = (await raw(["rev-parse", "--verify", "--end-of-options", `${main}^{tree}`])).trim();
  let cur = main;
  let curTree = mainTree;
  const commits: { sha: string; subject: string; emptyOnMain: boolean }[] = [];
  for (const sha of owed) {
    const subject = await subjectOf(sha);
    const out = lines(await raw([`--attr-source=${tip}`, "merge-tree", "--write-tree", `--merge-base=${sha}^`, cur, sha]));
    if (out.length !== 1 || !oid.test(out[0]!)) return { ok: false, kind: "conflict", commit: sha, subject };
    const empty = out[0] === curTree;
    commits.push({ sha, subject, emptyOnMain: empty });
    if (empty) continue;
    curTree = out[0]!;
    cur = (await raw([...identity, "commit-tree", curTree, "-p", cur, "-m", `owed ${sha.slice(0, 8)}`])).trim();
  }
  return { ok: true, tree: curTree, mainTree, commits };
}

/** The refusal/warning text for a failed {@link computeOwedLanding}: one wording for the union, the review and the confirm. */
export function describeOwedFailure(f: Extract<OwedLanding, { ok: false }>): string {
  return f.kind === "conflict"
    ? `the late commit ${f.commit.slice(0, 8)} ("${f.subject}") does not apply cleanly onto current main — nothing was changed; rebase the late commits onto main, then re-run`
    : `the merge commit ${f.commit.slice(0, 8)} ("${f.subject}") in the branch's late range ${f.why} — nothing was changed; a merge that carries its own content, or merges a branch that is not on main, cannot be replayed: rebase the late commits onto main, then re-run`;
}

/**
 * Card 13fc5227 — what landing a HELD branch would put on main, for review: {@link computeOwedLanding}'s tree diffed against main, with the same commit list, so the subjects and the diffstat
 * come from one computation. `failure` carries the refusal when the owed work cannot be replayed; `undefined` on any git error (the caller says so).
 */
export async function diffOwedLanding(repoPath: string, tip: string, owedBase: string, deps: BoundedGitDeps = {}): Promise<
  { failure: Extract<OwedLanding, { ok: false }> } | { failure?: undefined; filesChanged: number; insertions: number; deletions: number; files: DiffstatFile[]; commits: { sha: string; subject: string; emptyOnMain: boolean }[]; commitSubjects: string[] } | undefined
> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    const raw = (args: string[]) => withTimeout(git.raw(args), timeoutMs, `git ${args.find((a) => !a.startsWith("-")) ?? args[0]} (owed landing)`);
    const main = (await raw(["rev-parse", "--verify", "HEAD"])).trim();
    const landing = await computeOwedLanding(raw, owedBase, tip, main, timeoutMs);
    if (!landing.ok) return { failure: landing };
    // @decision fdf09672 — `-z` + parseNumstatZ, never a hand-rolled line/regex parse of plain `--numstat`
    // text (which C-quotes a non-ASCII path and collapses a rename into unusable "old => new" text).
    // @decision 4b559feb — `--end-of-options` before the first tree-ish positional: both are computed
    // tree ids, but a single marker protects both trailing positionals, same class as 868e0135.
    const files = parseNumstatZ(await raw(["diff", "--numstat", "-z", "--end-of-options", landing.mainTree, landing.tree]));
    const insertions = files.reduce((s, f) => s + f.insertions, 0);
    const deletions = files.reduce((s, f) => s + f.deletions, 0);
    return { filesChanged: files.length, insertions, deletions, files, commits: landing.commits, commitSubjects: landing.commits.map((c) => c.subject) };
  } catch {
    return undefined;
  }
}
export async function verifyReviewedTipChain(
  repoPath: string, reviewed: string, live: string, deps: BoundedGitDeps = {}, extraUnionBases: readonly string[] = [],
  // @decision e5458ccd — do not call this for stale-generation attribution without passing the resolved
  // mainline watermark ref here; every confirm-path caller omits it (default "HEAD", byte-identical).
  mainRef = "HEAD",
): Promise<{ ok: true; hops: number } | { ok: false; reason: string }> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  // Replace refs are ignored on EVERY call by the shared `canonicalGit` factory (`core.useReplaceRefs=false`), not per call site.
  const raw = (args: string[], label: string) => withTimeout(git.raw(args), timeoutMs, label);
  // `rev-list -n1 A ^B` prints a commit iff A is NOT reachable from B (a real git error throws, unlike `merge-base --is-ancestor`'s exit 1).
  // @decision 4b559feb — `--end-of-options` before `a`: `^${from}` is already a qualified, exempt
  // template (literal "^" prefix); `a` is the one bare positional needing protection.
  const reachable = async (a: string, from: string) => (await raw(["rev-list", "-n1", "--end-of-options", a, `^${from}`], "git rev-list (reviewed-tip reachability)")).trim() === "";
  const short = (x: string) => x.slice(0, 8);
  try {
    // @decision b8122303 — `live` may be a trailer-derived value (e.g. `Loom-Landed-Tip`) that is only
    // shape-validated at parse time; resolve it to its own exact object id here, at entry, before any
    // later call can be influenced by a same-named decoy ref. See resolveExactTrailerObjectId's own doc.
    if ((await resolveExactTrailerObjectId(git, timeoutMs, live)) === null) {
      return { ok: false, reason: `${short(live)} could not be resolved to its own exact, well-formed commit object id` };
    }
    let cur = live;
    for (let hops = 0; hops <= REVIEWED_TIP_WALK_MAX_HOPS; hops++) {
      if (cur === reviewed) return { ok: true, hops };
      if (await reachable(cur, mainRef) && await reachable(reviewed, cur)) return { ok: true, hops };
      // @decision 4b559feb — `--end-of-options` before `cur`: defense-in-depth, same class as 868e0135.
      const parents = (await raw(["rev-list", "--parents", "-n1", "--end-of-options", cur], "git rev-list --parents (reviewed-tip walk)")).trim().split(/\s+/).slice(1);
      if (parents.length !== 2) return { ok: false, reason: `${short(cur)} is not a merge of main (${parents.length} parent(s)) — a commit made after the review` };
      const [prev, m] = parents as [string, string];
      if (!(await reachable(m, mainRef))) return { ok: false, reason: `${short(cur)} merges ${short(m)}, which is not on main` };
      // @decision 868e0135 — `--end-of-options` added: round-2 CR retracted the compound-suffix exemption this relied on.
      const tree = (await raw(["rev-parse", "--verify", "--end-of-options", `${cur}^{tree}`], "git rev-parse tree (reviewed-tip walk)")).trim();
      // The daemon's union ran in the WORKTREE, so it used the BRANCH's attributes (e.g. `merge=union`); merge-tree here runs in canonical, so point it at `prev`'s tree.
      // `merge-tree --write-tree` exits 1 on a conflict WITHOUT throwing through simple-git: the conflicted tree oid is the first line and the conflict info follows —
      // so anything but exactly one oid line is a conflict, never a clean union.
      const mt = (await raw([`--attr-source=${prev}`, "merge-tree", "--write-tree", prev, m], "git merge-tree (reviewed-tip walk)")).trim().split(/\r?\n/);
      let unionOk = mt.length === 1 && /^[0-9a-f]{40,64}$/.test(mt[0]!) && tree === mt[0];
      // Card 13fc5227: a HELD branch's union is main plus the commits it still owes (see mergeMainIntoWorktree's `owedBase`): accepted only when its tree is EXACTLY what {@link computeOwedLanding}
      // makes of `prev` and `m` for the caller's owed base — a merge of main adds nothing else, and a non-merge commit never reaches this point (it fails the two-parent check above).
      for (const base of unionOk ? [] : extraUnionBases) {
        const landing = await computeOwedLanding((args) => raw(args, `git ${args.find((a) => !a.startsWith("-")) ?? args[0]} (owed landing walk)`), base, prev, m, timeoutMs);
        if (landing.ok && landing.tree === tree) { unionOk = true; break; }
      }
      if (!unionOk) return { ok: false, reason: `${short(cur)} could not be verified as a clean union of ${short(prev)} and ${short(m)} (conflicted, or not what merging main would produce)` };
      cur = prev;
    }
    return { ok: false, reason: `more than ${REVIEWED_TIP_WALK_MAX_HOPS} steps between the reviewed tip and the branch tip` };
  } catch (e) {
    return { ok: false, reason: `could not verify (${(e as Error).message.split("\n")[0]})` };
  }
}

export async function mergeBranch(
  repoPath: string, branch: string, taskTitle?: string, deps: BoundedGitDeps = {}, requireCanonicalHead?: string,
  gateBaseBranchHead?: string, opId?: string, expectedBranchTip?: string, expectedMainlineBranch?: string, expectedMainlineRef?: string,
  // @decision 0eaaa693 (round 5) — typed `string | null`, never `| undefined` (the `= null` default is
  // what excludes `undefined` — TS1016 forbids a bare required param after these optional ones): an
  // omitting caller now gets the SAME logged legacy/grandfathered path as explicit `null`, never a silent skip.
  expectAlreadyLanded?: boolean, cutBaseSha: string | null = null,
): Promise<{ ok: boolean; conflict?: boolean; sha?: string; subject?: string; noop?: boolean; reason?: string; emptyKind?: MergeEmptyKind; gateBaseInvalidated?: boolean; dirtyOverlap?: boolean; branchTipMoved?: { live: string | null }; landedTip?: string; landedBase?: string; landedVerify?: "verified" | "rejected" | "uncaptured"; trailerAdvisory?: "displaced" | "unreadable"; branchDiverted?: boolean; observedBranch?: string | null; unverified?: boolean; divertedSha?: string; quarantined?: boolean; transient?: boolean; residuePossible?: boolean; landedContentDiverged?: boolean; indexLockPresent?: boolean; forkPointDiverged?: boolean; forkPointUnverified?: boolean; branchTipUnresolvable?: boolean; canonicalRepoShallow?: boolean }> {
  // MUTEX (card e076d2a2, widened to GitWriter by e41dbb58): the whole residue-clear→squash→conflict-check
  // →commit sequence below reads and writes the CANONICAL repo's shared git index — serialize it per
  // canonical repo path so a concurrent merge for a DIFFERENT branch of the SAME repo, or a concurrent
  // GitWriter.commit/checkout/createBranch against the same repo, can never interleave with this one. See
  // the lock's own doc (git/repo-lock.ts) for the exact corruption this closes.
  //
  // @decision 24c0bdba (round 6) — the lock itself now refuses (RepoQuarantinedError) a quarantined repo
  // BEFORE mergeBranchLocked ever runs; catch it here and translate to this function's own {ok:false,
  // reason} shape rather than letting it escape as an unhandled rejection.
  //
  // @decision 356538ef (card 7ebb4acf, item 13) — checked FIRST, before even the lock, and flagged
  // canonicalRepoShallow so confirmWorkerMerge maps it before the generic squashRefused fallthrough — this
  // IS the in-flight backstop for a repo that turns shallow after confirmWorkerMerge's own top check.
  const shallowReason = await detectShallowCanonicalRepo(repoPath, deps.timeoutMs ?? GIT_OP_TIMEOUT_MS, deps.gitFactory);
  if (shallowReason) return { ok: false, reason: shallowReason, canonicalRepoShallow: true };
  // @decision 87a3c87e — never drop this pause/resume bracket.
  // @decision 6e6b342d — pause/resume now live INSIDE the lock callback (taken at admission, resumed in
  // this callback's own `finally`), never before `withCanonicalIndexLock` is admitted.
  try {
    return await withCanonicalIndexLock(repoPath, async () => {
      const pauseToken = pauseVaultAutoCommit(repoPath);
      try {
        return await mergeBranchLocked(repoPath, branch, taskTitle, deps, requireCanonicalHead, gateBaseBranchHead, opId, expectedBranchTip, expectedMainlineBranch, expectedMainlineRef, expectAlreadyLanded, cutBaseSha);
      } finally {
        resumeVaultAutoCommit(repoPath, pauseToken);
      }
    // @decision 62c4953a (round 2 scope) — opts in: the squash writes the canonical index.
    }, { checkIndexLock: true });
  } catch (e) {
    // @decision 8d8fa497 — mirror every in-function quarantine site below: set `quarantined:true` here too.
    if (e instanceof RepoQuarantinedError) return { ok: false, reason: e.message, quarantined: true };
    // @decision 62c4953a — a real `.git/index.lock` found present before this op ever touched the
    // canonical index; typed distinctly so a caller can skip any "pre-existing residue" framing — nothing
    // here ran at all.
    if (e instanceof CanonicalIndexLockPresentError) return { ok: false, reason: e.message, indexLockPresent: true };
    throw e;
  }
}

// Round 3 (card 9f5ae011): a short, bounded, WITNESSED delay before trusting a lock is genuinely
// abandoned — not a disguised fixed wait, since the persistence check below re-stats and compares rather
// than merely sleeping and assuming. Within the card's own suggested ~1-2s range; not empirically tuned
// against a live contending git process (unreproducible deterministically) — raise it if a real false
// removal ever surfaces.
const LOCK_PERSISTENCE_CHECK_DELAY_MS = 1500;

// MEASURED on this host (card 9f5ae011, round 3 self-test): `fs.statSync(...).mtimeMs` can read UP TO
// ~2ms AHEAD of a `Date.now()` sample taken immediately after the write that produced it — Node's
// `Date.now()` and the filesystem's own mtime clock are not the same clock. Without this tolerance, the
// upper-bound check below could spuriously refuse OUR OWN just-written lock as "postdating" a
// `killConfirmedAt` captured a few microseconds earlier, purely from clock skew, not a real foreign
// process. Generous margin over the measured ~2ms, while still far tighter than any real race window.
const LOCK_MTIME_CLOCK_SKEW_TOLERANCE_MS = 50;

type LockRemovalResult =
  | { removed: true; reason: string; lockPath: string; mtimeMs: number }
  | {
      removed: false;
      reasonCode: "no-lock" | "unresolved-git-dir" | "predates-attempt" | "postdates-confirmation" | "disappeared" | "unstable" | "unlink-failed";
      reason: string;
      lockPath?: string;
      mtimeMs?: number;
    };

/**
 * `resetOrSkip`'s own lock-removal guard: a real `.git/index.lock` a CONFIRMED-killed reset left behind
 * makes the next retry fail at once (reproduced via `taskkill /T /F` on Windows) — this removes it, but
 * ONLY when every one of these holds, so a retry is never gambled against unrelated state:
 *   (a) the caller has already checked {@link treeDeathConfirmed} on the error that triggered this —
 *       never an unconfirmed kill or an unrelated non-kill failure, both of which never call this;
 *   (b) the lock file's own mtime falls INSIDE this attempt's own window, each bound widened by
 *       {@link LOCK_MTIME_CLOCK_SKEW_TOLERANCE_MS} (MEASURED on this host: `fs.statSync(...).mtimeMs` and
 *       `Date.now()` are not the same clock and can disagree by ~1-2ms either direction — without this,
 *       the guard could spuriously refuse OUR OWN lock from clock noise alone): not older than
 *       `attemptStartedAt` (this reset attempt's own wall-clock start — a long-lived unrelated lock is
 *       never touched) and not newer than `killConfirmedAt` (round 3 — captured by the caller in its catch
 *       block, BEFORE calling this, the instant OUR OWN kill was confirmed dead; our own child cannot have
 *       written the lock any later than that, so a lock newer than this belongs to a DIFFERENT, still-live
 *       git process — an IDE refresh, an owner shell, a second daemon — racing us);
 *   (c) the lock PERSISTS byte-for-byte (same mtime + size) across a short, WITNESSED wait (round 3,
 *       {@link LOCK_PERSISTENCE_CHECK_DELAY_MS}) — a live process still holding the lock typically renames
 *       or rewrites it quickly (git renames `index.lock` onto `index` the instant it finishes), so a lock
 *       that visibly changes or vanishes during this delay is live, not abandoned;
 *   (d) the canonical-index mutex is held — true BY CONSTRUCTION here: this is only ever reached from
 *       `resetOrSkip`, itself only ever reached from `mergeBranchLocked`, which only ever runs INSIDE
 *       `withCanonicalIndexLock`. This is an IN-PROCESS guard ONLY (round 3) — it excludes a concurrent
 *       call from elsewhere in THIS daemon, never a foreign OS process that never acquires our mutex at
 *       all. The residual (b)+(c) do NOT close: guard (b)'s own window spans this reset attempt's actual
 *       duration (≈ `resetTimeoutMs`, ≥15s at the floor) — NOT narrow in wall-clock terms. What actually
 *       limits the risk there is git's own `O_EXCL` lock-creation semantics: a SECOND process cannot
 *       create the same `index.lock` path while ours still exists, so whatever lock we observe can only
 *       ever be one process's at a time, regardless of how wide window (b) is. Guard (c) is the guard that
 *       genuinely narrows: it catches only a foreign operation whose own hold on the lock lasts SHORTER
 *       than `LOCK_PERSISTENCE_CHECK_DELAY_MS` (round 3, 1.5s) — a foreign process holding the lock for
 *       1.5s or longer would still pass every guard here. Narrowed to that residual, never eliminated.
 * Resolved via {@link resolveGitDirsSync}'s `privateDir` (where `index`/`index.lock` actually live),
 * never a bare `path.join(repoPath, ".git", "index.lock")` — the robust resolution this codebase already
 * uses elsewhere, correct even though the canonical repo is always an ordinary checkout in practice.
 * Exported for `removeLeakedCanonicalIndexLockIfSafe`'s own direct hermetic test (round 3), same
 * precedent as {@link GIT_OP_TIMEOUT_MS}'s own export.
 *
 * @decision 9f5ae011 — any failed guard returns `removed:false` and the caller must give up rather than
 * retry (a retry against a lock still present fails identically) — EXCEPT `reasonCode: "no-lock"`, where
 * the caller MAY retry anyway since there's nothing to remove.
 */
export async function removeLeakedCanonicalIndexLockIfSafe(
  repoPath: string,
  attemptStartedAt: number,
  killConfirmedAt: number,
): Promise<LockRemovalResult> {
  const dirs = resolveGitDirsSync(repoPath);
  if (!dirs) return { removed: false, reasonCode: "unresolved-git-dir", reason: "could not resolve the canonical repo's git directory" };
  const lockPath = path.join(dirs.privateDir, "index.lock");
  let stat: fs.Stats;
  try { stat = fs.statSync(lockPath); } catch { return { removed: false, reasonCode: "no-lock", reason: "no .git/index.lock is present" }; }
  if (stat.mtimeMs < attemptStartedAt - LOCK_MTIME_CLOCK_SKEW_TOLERANCE_MS) {
    return {
      removed: false, reasonCode: "predates-attempt",
      reason: `lock mtime (${new Date(stat.mtimeMs).toISOString()}) predates this reset attempt's own start (${new Date(attemptStartedAt).toISOString()}) by more than the ${LOCK_MTIME_CLOCK_SKEW_TOLERANCE_MS}ms clock-skew tolerance`,
      lockPath, mtimeMs: stat.mtimeMs,
    };
  }
  if (stat.mtimeMs > killConfirmedAt + LOCK_MTIME_CLOCK_SKEW_TOLERANCE_MS) {
    return {
      removed: false, reasonCode: "postdates-confirmation",
      reason: `lock mtime (${new Date(stat.mtimeMs).toISOString()}) postdates this kill's own confirmation (${new Date(killConfirmedAt).toISOString()}) by more than the ${LOCK_MTIME_CLOCK_SKEW_TOLERANCE_MS}ms clock-skew tolerance — our own child was already confirmed dead by then, so a DIFFERENT, still-live git process must have created it`,
      lockPath, mtimeMs: stat.mtimeMs,
    };
  }
  await new Promise<void>((resolve) => setTimeout(resolve, LOCK_PERSISTENCE_CHECK_DELAY_MS));
  let restat: fs.Stats;
  try {
    restat = fs.statSync(lockPath);
  } catch {
    return {
      removed: false, reasonCode: "disappeared",
      reason: `a live process was still actively using it`,
      lockPath, mtimeMs: stat.mtimeMs,
    };
  }
  if (restat.mtimeMs !== stat.mtimeMs || restat.size !== stat.size) {
    return {
      removed: false, reasonCode: "unstable",
      reason: `the lock changed during a ${LOCK_PERSISTENCE_CHECK_DELAY_MS}ms persistence check (mtime/size differ) — a live process is still actively writing it`,
      lockPath, mtimeMs: stat.mtimeMs,
    };
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (e) {
    return { removed: false, reasonCode: "unlink-failed", reason: `failed to remove it: ${(e as Error).message}`, lockPath, mtimeMs: stat.mtimeMs };
  }
  return {
    removed: true,
    reason: `mtime ${new Date(stat.mtimeMs).toISOString()}, attempt started ${new Date(attemptStartedAt).toISOString()}, persisted unchanged across the ${LOCK_PERSISTENCE_CHECK_DELAY_MS}ms check`,
    lockPath, mtimeMs: stat.mtimeMs,
  };
}

/** Give-up wording for `resetOrSkip`'s retry gate (round 3, CR item 3) — branches on WHY the lock removal
 *  was refused so the message never claims a lock is present when it already isn't, or vice versa.
 *  `"no-lock"` never reaches this — `resetOrSkip` retries on it instead of giving up.
 *
 * @decision 9f5ae011 (round 4) — every clause stays ownership-NEUTRAL ("found", never "left"/"held", since
 * the caller already says "was confirmed-killed") and never repeats a conclusion `removal.reason` states. */
export function describeLockGiveUp(removal: LockRemovalResult & { removed: false }): string {
  const lockPath = removal.lockPath ?? ".git/index.lock";
  switch (removal.reasonCode) {
    case "unlink-failed":
      return `left a leaked ${lockPath} that could not be removed (${removal.reason})`;
    case "predates-attempt":
    case "postdates-confirmation":
    case "unstable":
      return `found a ${lockPath} that may not be ours (${removal.reason}) — before removing it by hand, check whether a git process is still running against this repo first`;
    case "disappeared":
      return `found a ${lockPath} that vanished during a persistence check (${removal.reason}) — likely a live process, not our own leaked lock, so nothing was removed`;
    case "unresolved-git-dir":
      return `could not even be checked for a leaked lock (${removal.reason})`;
    case "no-lock":
      return removal.reason; // unreachable — resetOrSkip retries on "no-lock" before ever calling this
  }
}

/** {@link checkCutBaseAncestry}'s outcome. */
export interface CutBaseAncestryCheck {
  ok: boolean;
  /** True when `cutBaseSha` was null/absent — a legacy worker. GRANDFATHERED: the caller must land as
   *  before this check existed, never refuse, but should mark its own result/event with
   *  `cutBaseUnknown: true` and log one line. See docs/decisions/0eaaa693-fork-point-ancestry-check.md,
   *  "Legacy branches", for why no best-effort backfill is attempted instead. */
  unknown?: boolean;
  /** Set only when `ok === false` — the sha that failed the ancestry check, for the refusal message. */
  cutBaseSha?: string;
  /** @decision 0eaaa693 (round 3) — true iff `ok === false` because `git merge-base` ITSELF threw, never
   *  because it ran and resolved to a real non-ancestor. Callers must branch on this before treating
   *  `ok: false` as a confirmed divergence (conflating the two was a real CR-found bug). */
  probeFailed?: boolean;
  /** Set only when `probeFailed` is true — the real underlying git error's message, for an honest
   *  "could not verify" refusal (never the divergence remedy). */
  probeError?: string;
}

/**
 * Checks whether `cutBaseSha` (the worker branch's RECORDED cut base — the canonical repo's HEAD at the
 * moment this worker's worktree was cut, captured ONCE before the worker's first commit or any
 * `mergeMainIntoWorktree` union merge ever ran) is an ancestor of `targetTip` (the canonical repo's live
 * target tip — the caller must read this FRESH, immediately before calling, never pass in a stale value).
 * Both shas are FIXED, pre-existing commits: this never walks the worker branch's OWN (possibly
 * union-merge-polluted) history, which is why it doesn't false-positive on a branch that has union-merged
 * main any number of times — a union merge only ever ADDS commits ahead of the branch's own tip, it
 * cannot move or rewrite `cutBaseSha`. See docs/decisions/0eaaa693-fork-point-ancestry-check.md for the
 * full mechanism, the grandfathering of a null `cutBaseSha`, and why the naive alternative (walking the
 * branch's current ancestry) is unsafe.
 *
 * Compares `merge-base` OUTPUT to `cutBaseSha` directly, never `merge-base --is-ancestor`'s exit status
 * (mirrors `isAncestorCommit`, `mainline-watch.ts`): simple-git's `raw()` resolves that subcommand's
 * non-zero "not an ancestor" exit as a SUCCESS with empty output. Fail-closed on a real git failure too
 * (an unresolvable sha, a timeout) — both read as `ok: false`.
 *
 * @decision 0eaaa693 — never derive this check's inputs from the branch's own current ancestry.
 */
export async function checkCutBaseAncestry(
  git: Pick<SimpleGit, "raw">, timeoutMs: number, cutBaseSha: string | null | undefined, targetTip: string,
): Promise<CutBaseAncestryCheck> {
  if (!cutBaseSha) return { ok: true, unknown: true };
  try {
    // @decision 868e0135 — `--end-of-options` right after "merge-base": cutBaseSha/targetTip are always recorded/resolved shas.
    const out = (await withTimeout(
      git.raw(["merge-base", "--end-of-options", cutBaseSha, targetTip]), timeoutMs, "git merge-base (cut-base ancestry check)",
    )).trim();
    return out === cutBaseSha ? { ok: true } : { ok: false, cutBaseSha };
  } catch (e) {
    return { ok: false, cutBaseSha, probeFailed: true, probeError: (e as Error).message };
  }
}

/**
 * Shared parent+tree(+single-parent) identity check for "is `sha` the exact commit a just-completed `git
 * commit`/`git commit --amend` call produced" — reused by the solo squash path ({@link mergeBranchLocked}'s
 * own `verifyLandedAsOwnCommit` closure, below) and the batch cherry-pick path (`git/batch-merge.ts`'s
 * `landBranchCommitsIndividually`).
 *
 * @decision 95940402 — a bare post-commit `rev-parse HEAD` re-read and a `Loom-Worker-Branch:` trailer are
 * both forgeable by anyone with `.git` write access; never trust either as proof of a commit's identity in
 * place of this check.
 *
 * `ok` is `true` only when `sha` has EXACTLY one parent, that parent equals `expectedParent`, and `sha`'s
 * own tree equals `expectedTree`; `false` (never throws) on any mismatch or git-read failure. `body` (card
 * 95940402 round 2) is the raw commit MESSAGE — present whenever the `cat-file -p` read itself succeeded,
 * even if `ok` is `false` on a parent/tree mismatch — so a caller that also needs to inspect trailers
 * (e.g. a `Loom-Worker-Branch:` block) doesn't need a second read of the same object.
 */
export async function verifyCommitParentAndTree(
  git: Pick<SimpleGit, "raw">, timeoutMs: number, sha: string, expectedParent: string, expectedTree: string,
): Promise<{ ok: boolean; body?: string }> {
  try {
    const raw = await withTimeout(git.raw(["cat-file", "-p", sha]), timeoutMs, "git cat-file -p <sha> (canonical, own-commit parent-count verify — immune to grafts/replace-refs)");
    const headerEnd = raw.indexOf("\n\n");
    const header = (headerEnd === -1 ? raw : raw.slice(0, headerEnd)).split(/\r?\n/);
    const body = headerEnd === -1 ? "" : raw.slice(headerEnd + 2);
    const parentLines = header.filter((l) => l.startsWith("parent "));
    if (parentLines.length !== 1) return { ok: false, body }; // exactly one parent
    if (parentLines[0]!.slice("parent ".length).trim() !== expectedParent) return { ok: false, body }; // and it must be ours
    // @decision 868e0135 — `--end-of-options` added: round-2 CR retracted the compound-suffix exemption this relied on.
    const tree = (await withTimeout(git.raw(["rev-parse", "--verify", "--end-of-options", `${sha}^{tree}`]), timeoutMs, "git rev-parse <sha>^{tree} (canonical, own-commit tree verify)")).trim();
    return { ok: tree === expectedTree, body };
  } catch {
    return { ok: false };
  }
}

// `opId` (board card 5a7692a4): purely for attribution on the in-memory danger-window tracker (see
// merge-danger-window.ts) — a caller with no op identity handy (a test, or any future caller) just gets an
// unattributed window entry (repo/branch only), never a functional difference in what this function does.
async function mergeBranchLocked(
  repoPath: string, branch: string, taskTitle?: string, deps: BoundedGitDeps = {}, requireCanonicalHead?: string,
  gateBaseBranchHead?: string, opId?: string, expectedBranchTip?: string, expectedMainlineBranch?: string, expectedMainlineRef?: string,
  // @decision 0eaaa693 (round 5) — same required-`string | null` posture as {@link mergeBranch}'s own
  // param; see that signature's comment for why `= null` (not a bare `?`) is what achieves it here.
  expectAlreadyLanded?: boolean, cutBaseSha: string | null = null,
): Promise<{ ok: boolean; conflict?: boolean; sha?: string; subject?: string; noop?: boolean; reason?: string; emptyKind?: MergeEmptyKind; gateBaseInvalidated?: boolean; dirtyOverlap?: boolean; branchTipMoved?: { live: string | null }; landedTip?: string; landedBase?: string; landedVerify?: "verified" | "rejected" | "uncaptured"; trailerAdvisory?: "displaced" | "unreadable"; branchDiverted?: boolean; observedBranch?: string | null; unverified?: boolean; divertedSha?: string; quarantined?: boolean; transient?: boolean; residuePossible?: boolean; landedContentDiverged?: boolean; forkPointDiverged?: boolean; forkPointUnverified?: boolean; branchTipUnresolvable?: boolean }> {
  // QUARANTINE CHECK moved to the TRUE convergence point, `withCanonicalIndexLock` (git/repo-lock.ts) —
  // this function only ever runs INSIDE that lock (see `mergeBranch` above), so a check re-derived here
  // would be unreachable dead code: a quarantined repo now never gets this far.
  //
  // @decision 24c0bdba (round 6)
  //
  // BOUNDED + NON-INTERACTIVE (board card 44c28799): this is the repo's highest-consequence git write
  // (see boundedMergeGit's own doc), so it gets the same block-timeout + withTimeout race as every other
  // bounded op in this file, plus nonInteractiveEnv() to match git/reader.ts + git/writer.ts. Before this
  // fix, `git = simpleGit(repoPath)` here had NEITHER — a hung git child (e.g. a wedged commit hook) never
  // settled, which (post-e076d2a2) wedged the per-repo merge mutex PERMANENTLY, not just this one op.
  const { git, timeoutMs } = boundedMergeGit(repoPath, deps);
  // @decision eda70da6 — re-verify HERE, first after the lock (zero side effects on mismatch,
  // gateBaseInvalidated:true) — never hold the lock across the gate run or re-run the gate once locked.
  //
  // The
  // preLanded path needs its OWN gateBaseBranchHead discriminator or routine main-movement turns an idempotent
  // re-confirm into a spurious refusal.
  // @decision 7efc2bff — the squash target is resolved to a frozen sha HERE, never the branch NAME —
  // `git merge --squash <name>` re-resolves at squash time and could silently pick up a late commit that
  // landed after the gate-base check.
  // @decision 56c10535 — resolved via {@link resolveBranchTip} (exact `for-each-ref`, never a bare
  // revision). A FAILED resolve now REFUSES (zero side effects) rather than falling back to squashing
  // the bare branch NAME (7efc2bff's old rule) — that fallback is the identical hazard this closes.
  const resolvedBranchHead = (await resolveBranchTip(repoPath, branch, deps)) ?? undefined;
  // @decision 56c10535 (Round 3, item 2) — DISTINCT from the generic merge_failed fallthrough: nothing
  // was attempted here, and it is never a content/conflict problem fixable by rebasing. The flag lets
  // service.ts give this its own honest wording instead of a misleading "re-task a rebase."
  if (resolvedBranchHead === undefined) {
    return {
      ok: false, branchTipUnresolvable: true,
      reason: `the branch tip for '${branch}' could not be resolved exactly (refs/heads/${branch} is unreadable or missing) — canonical repo and worktree are untouched; nothing was squashed`,
    };
  }
  const squashTarget = resolvedBranchHead;
  // @decision 975c774b — a gated PASS covers only the tip the gate spawned on; refuse (zero side effects) if the branch moved
  // since, or its tip can't be read. Optional: callers that pass no expected tip keep today's behavior.
  if (expectedBranchTip !== undefined && resolvedBranchHead !== expectedBranchTip) {
    return {
      ok: false, branchTipMoved: { live: resolvedBranchHead ?? null },
      reason: "the branch tip moved after this merge's gate spawned — canonical repo and worktree are untouched; re-confirm to gate the new tip",
    };
  }
  let branchStableSinceGateBase = false;
  if (gateBaseBranchHead && resolvedBranchHead) {
    branchStableSinceGateBase = resolvedBranchHead === gateBaseBranchHead;
  }
  if (requireCanonicalHead && !branchStableSinceGateBase) {
    let currentHead: string;
    try {
      currentHead = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (canonical, gate-base check)")).trim();
    } catch (e) {
      return { ok: false, reason: `failed to verify canonical HEAD before honoring this merge's gate: ${(e as Error).message}` };
    }
    if (currentHead !== requireCanonicalHead) {
      return {
        ok: false, gateBaseInvalidated: true,
        reason: "canonical main advanced since this merge's gate-validated tree was fixed (a benign race between concurrent merges/commits on this repo, not a problem with this branch) — canonical repo and worktree are untouched; re-confirm to re-gate against the current tree",
      };
    }
  }
  // @decision d69d4858 — pin the CHECKED-OUT BRANCH too, not just the sha above: a same-commit divert
  // passes the sha-only check trivially. Gated entirely on expectedMainlineBranch; unset ⇒ unchanged.
  if (expectedMainlineBranch !== undefined) {
    const pre = await readHeadShaAndBranch(git, timeoutMs, "git rev-parse HEAD + symbolic-full-name HEAD (canonical, mainline-branch pre-check)");
    if (!pre) {
      // Fail CLOSED: a read error/timeout is NOT proof of anything either way, so this refuses exactly
      // like a confirmed divert rather than silently proceeding on an unverified checkout.
      return {
        ok: false, unverified: true,
        reason: `failed to verify the canonical checkout's branch before honoring this merge (expected mainline branch "${expectedMainlineBranch}") — canonical repo and worktree are untouched; re-confirm once resolved`,
      };
    }
    if (pre.branch !== expectedMainlineBranch) {
      return {
        ok: false, branchDiverted: true, observedBranch: pre.branch,
        reason: `canonical repo is checked out on "${pre.branch ?? "(detached)"}", not the expected mainline branch "${expectedMainlineBranch}" — something diverted the checkout (a human REST GitWriter checkout/branch create, the Platform Lead's own git_checkout/git_create_branch, or a stray manual checkout) since this project's mainline baseline was established. Check out "${expectedMainlineBranch}" again in the canonical repo and re-confirm; if "${pre.branch ?? "(detached)"}" is actually a deliberate mainline rename, ask the owner to reset this project's mainline baseline first (POST /api/projects/:id/mainline-watermark/reset, loopback, human-only). Canonical repo and worktree are untouched; nothing was squashed. This refusal is never cached.`,
      };
    }
  }
  // @decision 0eaaa693 — refuse a landing whose fork point is off the current mainline. Reads the
  // canonical target tip FRESH, right here under the lock, rather than reusing an earlier-computed sha —
  // nothing between here and the squash below can move the target again once this read happens.
  if (cutBaseSha !== undefined) {
    let cutBaseTargetTip: string;
    try {
      cutBaseTargetTip = (await withTimeout(
        git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (canonical, cut-base ancestry check)",
      )).trim();
    } catch (e) {
      // @decision 0eaaa693 (round 5) — a transient read failure, never a confirmed divergence: same
      // `forkPointUnverified` outcome as a failed `checkCutBaseAncestry` probe, not the generic
      // merge-failed fallthrough's "squash was attempted... Re-task a rebase" (wrong on both counts here).
      return {
        ok: false, forkPointUnverified: true,
        reason: `could not verify the canonical target tip before honoring this merge's cut-base check (git error: ${(e as Error).message}) — canonical repo and worktree are untouched; nothing was squashed. This looks like a transient git/host condition, not a confirmed divergence — re-confirm to re-check. This refusal is never cached.`,
      };
    }
    const ancestry = await checkCutBaseAncestry(git, timeoutMs, cutBaseSha, cutBaseTargetTip);
    if (ancestry.unknown) {
      // eslint-disable-next-line no-console
      console.warn(`[merge] ${branch}: no recorded cut base (legacy worker) — landing without the fork-point ancestry check`);
    } else if (ancestry.probeFailed) {
      // @decision 0eaaa693 (round 3) — a TRANSIENT git failure, never the divergence remedy: fail closed
      // (nothing lands on an unverified check) but say so honestly — a plain re-confirm is the right next
      // step, not a recycle/fresh-worker dispatch.
      return {
        ok: false, forkPointUnverified: true,
        reason: `could not verify this worker's fork point against the current mainline target (git error: ${ancestry.probeError ?? "unknown"}) — canonical repo and worktree are untouched; nothing was squashed. This looks like a transient git/host condition, not a confirmed divergence — re-confirm to re-check. This refusal is never cached.`,
      };
    } else if (!ancestry.ok) {
      return {
        ok: false, forkPointDiverged: true,
        // @decision 0eaaa693 — a recycle/rebase of THIS worker can NEVER clear this refusal: recycleWorker
        // carries the SAME recorded cutBaseSha forward (Session.cutBaseSha's own doc), and a rebase never
        // re-derives it. Say so explicitly, and name only the remedies that actually work.
        reason: `this worker's branch was cut from ${ancestry.cutBaseSha!.slice(0, 8)}, which is not an ancestor of the current mainline target (${cutBaseTargetTip.slice(0, 8)}) — the canonical checkout moved to a different lineage while this worker was unmerged. Canonical repo and worktree are untouched; nothing was squashed. This cannot be cleared by recycling or rebasing this worker. Remedy: either switch the canonical checkout back to the branch this worker was cut from, or re-dispatch the work on a fresh worker cut from the current mainline (e.g. cherry-pick these commits there). This refusal is never cached.`,
      };
    }
  }
  // Auto-clear hook: once a kill's real confirmation eventually settles — regardless of whether the outer
  // `killableCanonicalRaw` call already gave up first — lift a quarantine THIS invocation may have
  // entered. A no-op when nothing was ever entered. In-process only — see merge-quarantine.ts's own doc
  // for why a RESTORED (post-restart) quarantine can never auto-clear this way.
  //
  // `raisedToken` (round 6, Code Review #5) — COMPARE-AND-CLEAR: this invocation can raise at most one
  // quarantine (every raise site below returns immediately after), so a single mutable slot captures the
  // token `enterMergeQuarantine` returns; the auto-clear below presents that SAME token back, so it can
  // never clear a DIFFERENT op's (still-active, differently-tokened) quarantine on this repo.
  //
  // @decision 24c0bdba (round 4) — the auto-clear half of the quarantine mechanism.
  let raisedToken: string | undefined;
  const onTreeDeathSettled = (confirmed: boolean): void => {
    if (confirmed && raisedToken) clearMergeQuarantineByToken(repoPath, raisedToken);
  };

  // @decision 2eddf573 — clear any AFFIRMATIVE in-progress-merge residue (stale MERGE_HEAD/unmerged) via
  // `reset --merge`, never `--hard` — an affirmative merge signal licenses clearing only that state, never
  // unrelated unstaged work elsewhere in the tree. Two independent probes, each in its own try/catch.
  try {
    const unmerged = (await withTimeout(git.raw(["ls-files", "--unmerged"]), timeoutMs, "git ls-files --unmerged (canonical, pre-check)")).trim() !== "";
    let inProgressMerge = false;
    try {
      inProgressMerge = (await withTimeout(git.raw(["rev-parse", "-q", "--verify", "MERGE_HEAD"]), timeoutMs, "git rev-parse MERGE_HEAD (canonical)")).trim() !== "";
    } catch { /* no MERGE_HEAD ⇒ that signal is simply false */ }
    if (inProgressMerge || unmerged) {
      try {
        // @decision 24c0bdba — kill-confirmed (not a bare withTimeout race): this mutates the canonical
        // index/tree while withCanonicalIndexLock is held, so an orphaned child must never outlive release.
        await killableCanonicalRaw(repoPath, ["reset", "--merge", "HEAD"], timeoutMs, "git reset --merge (canonical, residue clear)", deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled);
      } catch (e) {
        // @decision bde5d1fe — re-checked AND already quarantined (never THIS call's own kill) — refuse,
        // never re-raise (no kill happened here to auto-clear later).
        // @decision 8d8fa497 — set `quarantined:true` on both branches below, never just the reason text.
        if (e instanceof RepoQuarantinedError) return { ok: false, reason: e.message, quarantined: true };
        // @decision 24c0bdba (round 4) — fail CLOSED + QUARANTINE on an unconfirmed tree-kill here too.
        if (treeDeathUnconfirmed(e)) {
          raisedToken = enterMergeQuarantine(repoPath, branch, unconfirmedKillReason("in-progress-merge residue clear could not be confirmed dead after a kill"), opId);
          return { ok: false, reason: `in-progress-merge residue clear's process tree could not be confirmed dead after a kill — refusing further cleanup to avoid racing it; canonical repo may need manual inspection: ${(e as Error).message}`, quarantined: true };
        }
        // Surfaced explicitly rather than falling into the outer catch below, whose "no residue to clear"
        // reasoning does not apply here: we already know there IS residue (the signal above was affirmative)
        // and failed to clear it, so silence here would let a genuinely dirty canonical repo look untouched.
        return { ok: false, reason: `failed to clear in-progress-merge residue in canonical repo (MERGE_HEAD/unmerged detected, but \`git reset --merge HEAD\` did not complete): ${(e as Error).message}` };
      }
    }
  } catch { /* ls-files failed (e.g. not a repo / no HEAD) ⇒ no residue to clear */ }

  // @decision 2eddf573 — staged-but-not-unmerged residue is a SECOND, non-concurrent trigger for the same
  // corruption (outlives the process, invisible to the clear above) — refuse loudly on ANY staged tracked
  // state, scoped to the INDEX only; a wider `reset --hard` guard handles unstaged dirt separately.
  let stagedAtEntry: string;
  try {
    stagedAtEntry = (await withTimeout(git.raw(["diff", "--cached", "--name-only"]), timeoutMs, "git diff --cached (canonical, entry check)")).trim();
  } catch (e) {
    return { ok: false, reason: `failed to inspect canonical repo staged state before merge: ${(e as Error).message}` };
  }
  if (stagedAtEntry !== "") {
    // Card 4b7ff996: this wording now lives in ONE shared function, `stagedCanonicalDirtRefusalMessage`
    // (above `detectCanonicalDirtyOverlap`), so this entry check and the new admission-time preflight that
    // hoists this same condition earlier can never say different things about the identical condition.
    return { ok: false, reason: stagedCanonicalDirtRefusalMessage(branch, stagedAtEntry) };
  }
  // Broad probe (staged AND unstaged tracked state — untracked files excluded, same rationale as always:
  // `reset --hard` never touches them, so they're not at risk). This does NOT gate the merge — only
  // `hadUnstagedDirtAtEntry` derived from it, which every `reset --hard` cleanup call below consults via
  // `resetOrSkip` before running, so a human's pre-existing unstaged edits (or a submodule gitlink) are
  // never silently discarded by a cleanup path this merge attempt triggers.
  let statusAtEntry: string;
  try {
    statusAtEntry = (await withTimeout(git.raw(["status", "--porcelain", "--untracked-files=no"]), timeoutMs, "git status (canonical, entry check)")).trim();
  } catch (e) {
    return { ok: false, reason: `failed to inspect canonical repo working-tree state before merge: ${(e as Error).message}` };
  }
  const hadUnstagedDirtAtEntry = statusAtEntry !== "";
  // @decision 06b5c47f — resetOrSkip SKIPS the reset (never a mixed `git reset HEAD`) when unstaged dirt
  // predated this merge attempt — a mixed reset only unstages the squash's diff, leaving it as silent
  // unstaged noise the NEXT merge would proceed onto instead of refusing.
  // @decision 8d8fa497 — returns `{message, quarantined}`, not a bare string: every caller below must be
  // able to tell "ordinary cleanup failure" apart from "this cleanup itself just found/raised a
  // quarantine" without string-matching `message`.
  // @decision 9f5ae011 — ALSO returns `transient`: set when this cleanup's own reset was CONFIRMED
  // killed and either couldn't safely retry or retried and failed anyway — never when quarantined, its
  // own separate, already-terminal signal.
  async function resetOrSkip(context: string): Promise<{ message: string; quarantined?: boolean; transient?: boolean } | null> {
    if (hadUnstagedDirtAtEntry) {
      return { message: `skipped automatic cleanup (${context}) because the canonical repo already had unstaged tracked changes before this merge attempt — resetting would risk discarding them; a human must resolve the canonical checkout by hand, and the next merge attempt will refuse loudly on any staged residue this left behind` };
    }
    // @decision 9f5ae011 — this cleanup failing leaves the CANONICAL repo staged-dirty, refusing every
    // later merge until a human intervenes — give it a floor independent of the caller's own (possibly
    // small) `timeoutMs`. Narrows, never eliminates, the window where this call itself starves under load.
    const resetTimeoutMs = Math.max(timeoutMs, GIT_OP_TIMEOUT_MS);
    const attemptReset = async (isRetry: boolean): Promise<{ message: string; quarantined?: boolean; transient?: boolean } | null> => {
      const attemptStartedAt = Date.now();
      try {
        // @decision 24c0bdba — kill-confirmed: this cleanup mutates the same canonical index/tree a later
        // op (or another merge, once the lock releases) will touch — never abandon it on a bare timeout.
        await killableCanonicalRaw(repoPath, ["reset", "--hard", "HEAD"], resetTimeoutMs, `git reset --hard (canonical, ${context}${isRetry ? ", retry" : ""})`, deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled);
        return null;
      } catch (e) {
        // @decision bde5d1fe — re-checked AND already quarantined (never THIS call's own kill) — refuse,
        // never re-raise.
        if (e instanceof RepoQuarantinedError) return { message: `reset --hard (${context}) refused — canonical repo is quarantined: ${e.message}`, quarantined: true };
        // @decision 24c0bdba (round 4) — this IS itself a mutating canonical call; an unconfirmed kill of
        // ITS OWN child quarantines the repo too, the same as every other mutating call on this path.
        if (treeDeathUnconfirmed(e)) {
          raisedToken = enterMergeQuarantine(repoPath, branch, unconfirmedKillReason(`reset --hard (${context}) could not be confirmed dead after a kill`), opId);
          return { message: `reset --hard (${context})'s process tree could not be confirmed dead after a kill — quarantining the repo; canonical repo may need manual inspection: ${(e as Error).message}`, quarantined: true };
        }
        // @decision 9f5ae011 (round 2) — gated on `treeDeathConfirmed` (a TYPED positive signal), never on
        // "any non-quarantine, non-unconfirmed error" — that over-broad gate also retried an UNRELATED git
        // failure, and even a genuine confirmed kill's retry fails at once against its own leaked lock.
        if (!isRetry && treeDeathConfirmed(e)) {
          // @decision 9f5ae011 (round 3) — captured FIRST, before any stat call: the instant OUR OWN kill
          // was confirmed dead, the upper bound a leaked lock's own mtime must not exceed (see
          // removeLeakedCanonicalIndexLockIfSafe's own doc, guard (b)).
          const killConfirmedAt = Date.now();
          const removal = await removeLeakedCanonicalIndexLockIfSafe(repoPath, attemptStartedAt, killConfirmedAt);
          if (removal.removed) {
            // eslint-disable-next-line no-console
            console.log(`[git] mergeBranchLocked: ${context}'s reset --hard was confirmed-killed — removed its leaked ${removal.lockPath} (${removal.reason}) — retrying once at ${resetTimeoutMs}ms: ${(e as Error).message}`);
            return attemptReset(true);
          }
          // @decision 9f5ae011 (round 3) — "no-lock" is not a failed guard: nothing to remove, and the
          // retried reset takes its own lock, so it's safe to retry anyway.
          if (removal.reasonCode === "no-lock") {
            // eslint-disable-next-line no-console
            console.log(`[git] mergeBranchLocked: ${context}'s reset --hard was confirmed-killed, but left no leaked .git/index.lock — retrying once at ${resetTimeoutMs}ms: ${(e as Error).message}`);
            return attemptReset(true);
          }
          // eslint-disable-next-line no-console
          console.log(`[git] mergeBranchLocked: ${context}'s reset --hard was confirmed-killed, but its leaked .git/index.lock was not safely removable (${removal.reason}) — giving up rather than retrying into a guaranteed-repeat failure: ${(e as Error).message}`);
          return {
            message: `reset --hard (${context}) was confirmed-killed and ${describeLockGiveUp(removal)} — canonical repo may have STAGED residue; run \`git diff --cached\` in the canonical checkout to inspect it — later merges on this repo will refuse at the staged-dirt entry check until a human cleans up: ${(e as Error).message}`,
            transient: true,
          };
        }
        if (isRetry) {
          return {
            message: `reset --hard (${context}) failed after a confirmed-killed retry — canonical repo may have STAGED residue; run \`git diff --cached\` in the canonical checkout to inspect it, and check for a leaked .git/index.lock too — later merges on this repo will refuse at the staged-dirt entry check until a human cleans up: ${(e as Error).message}`,
            transient: true,
          };
        }
        return { message: `reset --hard (${context}) failed — canonical repo may have residue: ${(e as Error).message}` };
      }
    };
    return attemptReset(false);
  }

  // @decision d69d4858 — re-verify the landed branch too: a commit may already exist by this point, so
  // this can only stop a false ok:true, never undo the landing. Gated entirely on expectedMainlineBranch.
  const verifyLandedOnMainline = async (
    sha: string,
  ): Promise<{ ok: true } | { ok: false; unverified?: boolean; branchDiverted?: boolean; observedBranch?: string | null; divertedSha?: string; reason: string }> => {
    if (expectedMainlineBranch === undefined) return { ok: true };
    const post = await readHeadShaAndBranch(git, timeoutMs, "git rev-parse HEAD + symbolic-full-name HEAD (canonical, post-commit mainline-branch verify)");
    if (!post) {
      // Code Review round 2 (card dd36012a): `sha` DID land (the commit object exists) — carried as
      // `divertedSha` too (same field the confirmed-divert branch below uses) so a caller's wording/event
      // can correctly say "a commit landed, unconfirmed where" rather than falsely implying nothing landed.
      return {
        ok: false, unverified: true, divertedSha: sha,
        // Round 3 (delta review b39e8972): dropped "most likely landed correctly" — that confident
        // claim is exactly what made the caller's old divertedSha-keyed wording self-contradictory
        // against this reason. Whether it's on mainline is UNCONFIRMED, not assumed either way.
        reason: `squash commit landed (${sha}) but canonical HEAD (and checked-out branch) could not be re-read to verify it landed on the expected mainline branch "${expectedMainlineBranch}"`,
      };
    }
    if (post.branch !== expectedMainlineBranch) {
      return {
        ok: false, branchDiverted: true, observedBranch: post.branch, divertedSha: sha,
        reason: `squash commit ${sha} landed on "${post.branch ?? "(detached)"}", not the expected mainline branch "${expectedMainlineBranch}" — the canonical checkout was diverted during this merge. The commit exists but is NOT reachable from mainline; recover it with \`git branch rescue/<id>-${sha.slice(0, 8)} ${sha}\` from the canonical repo, check out "${expectedMainlineBranch}" again, then cherry-pick it onto the real mainline branch (or ask the owner to reset this project's mainline baseline via POST /api/projects/:id/mainline-watermark/reset if "${post.branch ?? "(detached)"}" is actually a deliberate rename). This refusal is never cached.`,
      };
    }
    return { ok: true };
  };

  // Danger-window tracking (board card 5a7692a4): from HERE — right before `git merge --squash` (NOT
  // literally the attempt's first mutating git call — see merge-danger-window.ts's own doc on
  // enterMergeDangerWindow) — through every exit below (success, or a handled
  // conflict/rawError/probe-failure exit, each via its own resetOrSkip cleanup call INSIDE this same
  // try, so the window stays marked active until that cleanup has itself settled, never cleared before
  // it) is the interval a process death can leave the canonical repo with staged, uncommitted residue
  // ("trigger-3") that never auto-clears. See merge-danger-window.ts for the full doc + how
  // gracefulShutdown uses this to bound its own exit.
  enterMergeDangerWindow(repoPath, branch, opId);
  try {
    let rawError = false;
    let rawErrorMessage: string | undefined;
    let rawErrorObject: unknown;
    let squashRefusalDetail: ReturnType<typeof describeGitFailure> | undefined;
    try {
      // @decision 24c0bdba — kill-confirmed: stages into the same canonical index the commit below lands
      // from; an orphaned squash child must never survive past the lock releasing.
      await killableCanonicalRaw(repoPath, ["merge", "--squash", squashTarget], timeoutMs, "git merge --squash (canonical)", deps.gitFactory, nonInteractiveEnv(), onTreeDeathSettled);
    } catch (e) {
      rawError = true; // a conflict OR a real failure — the explicit checks below decide
      // Card 4b7ff996: captured (not just flagged) so the rawError branch below can tell git's own
      // "unstaged local changes would be overwritten" signature apart from every other real failure — the
      // message used to be discarded here entirely, leaving the caller with a generic "git merge --squash
      // failed" for a class of failure that actually has a specific, diagnosable cause and a specific,
      // different remedy (see that branch's own doc).
      rawErrorMessage = (e as Error).message;
      // Round 3 (Code Review B-1): the REAL error object, not just its message — `treeDeathUnconfirmed`
      // checks a typed marker on it first, which a `{ message }` reconstruction below would lose.
      rawErrorObject = e;
      squashRefusalDetail = e instanceof CanonicalGitRefusal ? describeGitFailure(e) : undefined;
    }
    // A canonicalGit refusal is thrown BEFORE any git process runs: the squash never started, so the canonical repo is exactly as it entered. Say so — and do NOT
    // run the reset/probes below (they are exec-capable and would be refused too, dressing a clean refusal up as "the canonical repo needs recovery").
    if (squashRefusalDetail !== undefined) return { ok: false, reason: canonicalFailureMessage(squashRefusalDetail, squashRefusalDetail.text) };
    // Conflict? Unmerged index entries are the reliable signal. Under --squash there is no MERGE_HEAD, so
    // `git reset --hard HEAD` (NOT `merge --abort`) restores the canonical repo to its pre-merge state.
    // This probe used to be bare/uncaught (card 9e77050f): a throw here rejected mergeBranchLocked with no
    // cleanup, leaving the squash staged — exactly the residue class the entry check above now exists to
    // catch on a LATER call, but there is no reason to manufacture that gap when we can just close it here.
    // The reset --hard on catch is safe for a SCOPE reason, not just a timing one: the entry check above
    // observed the whole tracked working tree (`git status`, staged + unstaged) clean before this squash
    // began, and `reset --hard`'s own blast radius is exactly that same tracked working tree — no wider. A
    // precondition only licenses the operation over the state it actually observed; because the two match
    // here, whatever is dirty now is provably ours (this squash's own output) to discard.
    let conflicted: boolean;
    try {
      conflicted = (await withTimeout(git.raw(["ls-files", "--unmerged"]), timeoutMs, "git ls-files --unmerged (canonical, post-squash)")).trim() !== "";
    } catch (e) {
      const cleanup = await resetOrSkip("post-squash-probe-failure cleanup");
      return { ok: false, reason: `failed to inspect canonical index for conflicts after squash: ${(e as Error).message}${cleanup ? ` (${cleanup.message})` : ""}`, ...(cleanup?.quarantined ? { quarantined: true } : {}), ...(cleanup?.transient ? { transient: true, residuePossible: true } : {}) };
    }
    if (conflicted) {
      // The cleanup that's supposed to leave the canonical repo UNTOUCHED can ITSELF fail (busy index lock,
      // read-only tree); swallowing it would assert a clean "conflict" while the repo is left with unmerged/
      // partial-index residue. SURFACE it via `reason` so the caller knows the canonical repo needs recovery
      // rather than trusting the (now false) "untouched" guarantee.
      const cleanup = await resetOrSkip("conflict cleanup");
      if (cleanup) return { ok: false, conflict: true, reason: cleanup.message, ...(cleanup.quarantined ? { quarantined: true } : {}), ...(cleanup.transient ? { transient: true, residuePossible: true } : {}) };
      return { ok: false, conflict: true };
    }
    // DEFENSE IN DEPTH (card e076d2a2, item 4): a `rawError` from our OWN `git merge --squash` means OUR
    // squash never definitively landed — whatever IS (or isn't) currently staged cannot be trusted as OURS.
    // Under the race the mutex above now closes, that "something staged" could be a DIFFERENT concurrent
    // op's leftover, and the old code below this point would have blindly committed it under THIS branch's
    // subject/trailer (the exact incident: a commit bearing one branch's trailer, another's content) — fail
    // loud UNCONDITIONALLY on rawError, never fall through to "well, something's staged, ship it." The mutex
    // is the primary fix (no concurrent op can leave leftover stage here anymore); this is the backstop for
    // anything outside it.
    if (rawError) {
      // @decision bde5d1fe — already quarantined at the squash re-check (never THIS attempt's own kill) —
      // refuse directly; resetOrSkip would just refuse too, so skip the redundant call.
      // @decision 8d8fa497 — set `quarantined:true` on this and the following branch too.
      if (rawErrorObject instanceof RepoQuarantinedError) {
        return { ok: false, reason: `git merge --squash refused — canonical repo is quarantined: ${rawErrorMessage}`, quarantined: true };
      }
      // @decision 24c0bdba — fail CLOSED + QUARANTINE on an unconfirmed tree-kill: resetOrSkip's own
      // reset --hard would race whatever might still be alive, never touch the repo further in that case.
      if (treeDeathUnconfirmed(rawErrorObject)) {
        raisedToken = enterMergeQuarantine(repoPath, branch, unconfirmedKillReason("git merge --squash could not be confirmed dead after a kill"), opId);
        return {
          ok: false,
          reason: `git merge --squash's process tree could not be confirmed dead after a kill — refusing further cleanup to avoid racing it; canonical repo may need manual inspection: ${rawErrorMessage}`,
          quarantined: true,
        };
      }
      const cleanup = await resetOrSkip("rawError cleanup");
      // @decision 4b7ff996 — squash-time backstop for the race window between this admission preflight and
      // this squash: classify a matching rawError as dirtyOverlap:true, never a generic failure — and always
      // include rawErrorMessage regardless of cleanup, the only place the overwritten path is named.
      const dirtyOverlap = !!rawErrorMessage && /would be overwritten by merge/i.test(rawErrorMessage);
      if (dirtyOverlap) {
        return {
          ok: false,
          dirtyOverlap: true,
          reason: `canonical repo has local content that would be overwritten by this merge (git refuses to clobber it): ${rawErrorMessage}${cleanup ? ` (${cleanup.message})` : ""}`,
          ...(cleanup?.quarantined ? { quarantined: true } : {}),
          ...(cleanup?.transient ? { transient: true, residuePossible: true } : {}),
        };
      }
      return { ok: false, reason: cleanup ? `git merge --squash failed (${cleanup.message})` : "git merge --squash failed", ...(cleanup?.quarantined ? { quarantined: true } : {}), ...(cleanup?.transient ? { transient: true, residuePossible: true } : {}) };
    }
    // No conflict, no rawError. Did --squash stage anything? (Output-based, NOT exit-code: raw's exit-code
    // handling is unreliable — see isBranchMerged.) Empty after the residue-clear above is a GENUINE empty index.
    // Also previously bare/uncaught (card 9e77050f) — same reasoning as the conflict probe above: wrap it so a
    // throw can't reject with a staged index left behind, and the reset --hard on catch is safe for the same
    // SCOPE reason (the entry check's `git status` probe covers exactly what `reset --hard` touches, so a
    // precondition observed there licenses this operation too — see that check's own comment).
    let staged: boolean;
    try {
      staged = (await withTimeout(git.raw(["diff", "--cached", "--name-only"]), timeoutMs, "git diff --cached (canonical, staged check)")).trim() !== "";
    } catch (e) {
      const cleanup = await resetOrSkip("staged-probe-failure cleanup");
      return { ok: false, reason: `failed to inspect canonical index staged diff after squash: ${(e as Error).message}${cleanup ? ` (${cleanup.message})` : ""}`, ...(cleanup?.quarantined ? { quarantined: true } : {}), ...(cleanup?.transient ? { transient: true, residuePossible: true } : {}) };
    }
    if (!staged) {
      // Clean no-op: classify so the caller can distinguish "already merged" from "no diff to merge". The
      // branch's commits are "already in main" iff a prior squash carrying its trailer is reachable from HEAD
      // AND that commit's content is verified to actually contain the branch's own changes (see
      // findLandedSquashCommit's content-reachability check — trailer presence alone is not proof).
      // @decision d69d4858 — scan the MAINLINE ref (expectedMainlineBranch), not bare HEAD, when pinned:
      // the pre-check above has already refused by this point on a real divert, so this is defense in
      // depth, not load-bearing on its own — unset (no watermark yet) falls back to "HEAD", unchanged.
      const landed = await findLandedSquashCommit(repoPath, branch, expectedMainlineRef ?? "HEAD", deps);
      // `sha` rides along on the ALREADY_MERGED case (card 1eebc46a) — `landed` IS the commit's sha,
      // already resolved by the lookup just above; surfacing it costs no extra git call, just returning
      // data this function already computed, so the caller (finalizeMerge) can persist ship-state without
      // a redundant lookup of its own.
      return { ok: true, noop: true, emptyKind: landed ? "ALREADY_MERGED" : "STAGE_EMPTY_RETRY", sha: landed ?? undefined, landedTip: resolvedBranchHead };
    }
    // @decision 24c22912 — EXPECT-ALREADY-LANDED: the preLanded producer proved this content is already on
    // main, so the squash must stage NOTHING; a non-empty stage means main no longer carries it (most
    // often a revert) — reset, land no commit, refuse. Full reasoning in that decision's own record.
    if (expectAlreadyLanded) {
      const cleanup = await resetOrSkip("landed-content-diverged cleanup");
      const reason = "this branch's previously-landed content is no longer on main (most likely reverted "
        + "by a human) — Loom will not silently re-land it; a human must decide: abandon this worker/card, "
        + `or re-cut the branch if re-landing the content is actually intended${cleanup ? ` (${cleanup.message})` : "; canonical repo restored to its pre-merge state"}`;
      return {
        ok: false, landedContentDiverged: true, reason,
        ...(cleanup?.quarantined ? { quarantined: true } : {}),
        ...(cleanup?.transient ? { transient: true, residuePossible: true } : {}),
        // @decision 24c22912 (round 2, item 1) — set `residuePossible` for EVERY unsuccessful cleanup,
        //  not just `transient`: a plain skip leaves the reverted content staged too. See that record.
        ...(cleanup && !cleanup.quarantined && !cleanup.transient ? { residuePossible: true } : {}),
      };
    }
    // Land the staged diff as ONE plain commit (repo-config identity; clean subject + deterministic trailer).
    // Card 7a1a76e9 DoD-3: the task title still wins unconditionally when a task exists (⛔ do not regress
    // the tasked path) — a taskless worker now derives a real subject from its own branch tip commit instead
    // of falling back straight to the branch name; see deriveTasklessSubject's own doc for the tip-vs-first
    // decision. The branch name stays the LAST-RESORT fallback (an empty/unreadable branch, or the derive
    // call itself failing).
    const taskSubject = taskTitle ? taskTitle.trim().split(/\r?\n/)[0]!.trim() : undefined;
    const rawSubject = taskSubject || (await deriveTasklessSubject(repoPath, branch, deps)) || branch;
    const subject = toConventionalSubject(rawSubject);
    // @decision f324e8fa — the AUTHORITATIVE entity-check enforcement point, not merely a copy of the
    // pre-gate check (a title SNAPSHOT the human REST edit route can rewrite during the gate's multi-minute
    // run) — never rely on the pre-gate check alone; reuse checkTitleHtmlEntities, never a second pattern.
    const subjectGuard = checkTitleHtmlEntities(subject, false);
    if (subjectGuard) {
      const cleanup = await resetOrSkip("title-html-entity cleanup");
      return {
        ok: false,
        // @decision 9f5ae011 (round 2) — "restored to its pre-merge state" used to be stated
        // unconditionally even when `cleanup` was truthy (skipped/quarantined/transient/failed, i.e. NOT
        // restored); the content cause (the HTML entity) stays the lead reason either way.
        reason: `squash subject contains an HTML entity ("${subjectGuard.match}") — would become a PERMANENT, ` +
          `unrewritable mainline commit subject (this has already happened once: commit fe2c1c6b). Retitle the ` +
          `card (tasks_update) to a clean subject, then re-confirm. Squash phase aborted before landing` +
          (cleanup ? `: ${cleanup.message}` : `; canonical repo restored to its pre-merge state.`),
        ...(cleanup?.quarantined ? { quarantined: true } : {}),
        ...(cleanup?.transient ? { transient: true, residuePossible: true } : {}),
      };
    }
    // The worker-commit-log body (card 8b7b81e0 DoD-3) needs the branch's OWN pre-landing commit range —
    // merge-base(HEAD, branch)..branch, the worker's real authored history — computed HERE, before the
    // squash lands. Deliberately UNRELATED to the PathSet/Base stamp below, which captures the STAGED
    // index against current HEAD instead (proven equivalent to the landed `sha^..sha` range — see that
    // block's own doc, card c862f14c, for why the two must not share a base and for that equivalence
    // proof). Best-effort: a capture failure just omits the body from this commit.
    let workerCommitLogBody: string | undefined;
    try {
      const mergeBaseForSquashMeta = (await withTimeout(git.raw(["merge-base", "HEAD", `refs/heads/${branch}`]), timeoutMs, "git merge-base (canonical, squash metadata)")).trim();
      workerCommitLogBody = await deriveWorkerCommitLogBody(repoPath, branch, mergeBaseForSquashMeta, subject, deps);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[git] mergeBranchLocked: worker-commit-log body capture failed for ${branch}: ${(e as Error).message}`);
    }
    const bodyBlock = workerCommitLogBody ? `\n\n${workerCommitLogBody}` : "";
    let message = `${subject}${bodyBlock}\n\nLoom-Worker-Branch: ${branch}\n${resolvedBranchHead ? `Loom-Landed-Tip: ${resolvedBranchHead}\n` : ""}`;
    // Card fdc991be/2267e8fa: on a host where git can't resolve an identity for this commit (a fresh
    // end-user machine, or a CI runner), the squash commit below otherwise fails with "Author identity
    // unknown" AFTER the gate has already run. Falls back via the ONE shared helper
    // (resolveGitIdentityFallbackArgs, git/bounded.ts) ONLY when git itself can't determine an identity —
    // a host whose own identity git CAN resolve commits byte-identically to before this change. Computed
    // HERE, before the pathset capture below — two read-only `git var` probes, but the load-bearing
    // adjacency rule on that capture (card c862f14c, just below) still forbids any git call between it and
    // the commit, so this must not sit between them either.
    // @decision 2267e8fa (card 7b59e981) — PER-ROLE env overrides, merged into the commit's own explicit env at the call
    // below — a pure JS object merge, never a git call, so the adjacency rule above still holds.
    // @decision 3a5c5d4a (round 3, B2; round 4, B-1) — `repoPath` IS `cwd` here (the real canonical
    // main); thread its resolved TOPLEVEL as `trustedMainRoot`, never bare `repoPath` — a subdir-bound
    // project path has no `.git` of its own, and a healthy main checkout resolves right back to it.
    let identityEnv: Record<string, string>;
    try {
      identityEnv = await resolveGitIdentityFallbackArgs(
        repoPath, timeoutMs,
        deps.identityProbeGitFactory ?? (deps.gitFactory ? unpinnedProbeFactoryFromLegacy(deps.gitFactory) : undefined),
        nonInteractiveEnv(),
        defaultTrustedMainRoot(repoPath),
      );
    } catch (e) {
      // canonicalFailureMessage keeps a classified canonical-git refusal's human guidance here too —
      // `probeGitIdentResolvable` rethrows a CanonicalGitRefusal (e.g. a pinMismatch) verbatim.
      // canonicalFailureMessage's own refusal branches already open with "refused,"/"refusing," —
      // dropping "refused:" from this prefix avoids a literal doubled "refused: refused".
      const identityProbeFailure = describeGitFailure(e);
      return { ok: false, reason: `identity-fallback probe: ${canonicalFailureMessage(identityProbeFailure, identityProbeFailure.text)}` };
    }
    // @decision c862f14c — stamps the path-set trailers from the STAGED index, never a follow-up amend
    // (caused an orphan window + doubled hooks). LOAD-BEARING ADJACENCY: no git call may land between this
    // capture and the commit below, or it breaks the tree-identity the byte-identical-digest proof rests on.
    //
    // Scoped outside the try (best-effort, same as the trailers) so it survives to the catch below too.
    let preCommitHead: string | undefined;
    // @decision 2a6a292a round 21 (card aa7677fa round 3) — the staged tree, captured in this SAME
    // pre-commit window as preCommitHead; never re-derive it later via a fresh `write-tree`/diff — a
    // later read can't prove it reflects what was actually staged when this commit was made.
    let stagedTree: string | undefined;
    // @decision f224632d — the digest THIS process actually stamped into `Loom-Worker-PathSet:`, hoisted
    // so `verifyLandedAsOwnCommit`'s own trailer check (below) can assert the landed commit's own trailer
    // carries the SAME value, never a re-derived one.
    let stampedPathSetDigest: string | undefined;
    try {
      preCommitHead = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (canonical, pathset base)")).trim();
      stampedPathSetDigest = await stagedPathSetDigest(git, timeoutMs);
      message = `${message.replace(/\s+$/, "")}\nLoom-Worker-Base: ${preCommitHead}\nLoom-Worker-PathSet: ${stampedPathSetDigest}\n`;
      stagedTree = (await withTimeout(git.raw(["write-tree"]), timeoutMs, "git write-tree (canonical, pre-commit tree capture)")).trim();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[git] mergeBranchLocked: Loom-Worker-Base/PathSet/tree capture failed for ${branch} — commit lands ` +
        `without the trailers, and this landing will be treated as UNVERIFIED for ledger/trust purposes: ${(e as Error).message}`);
    }
    // @decision 2a6a292a round 21 (card aa7677fa round 3) — never trust a bare post-commit `rev-parse
    // HEAD` as "the commit we just made": verify its parent is `preCommitHead` AND its tree is
    // `stagedTree` first (either alone is forgeable), returning the ledger base only when both hold.
    // @decision 2a6a292a round 22 (card aa7677fa round 4) — ALSO require exactly one parent.
    // @decision 2a6a292a round 23 (card aa7677fa round 5) — round 22's `rev-list --parents` honored
    // `info/grafts` (a graft-hidden second parent reads as single-parent); `cat-file -p` reads the RAW
    // object, immune to grafts/replace-refs — parsed only up to the first blank line (the header block).
    // @decision 95940402 — the actual parent+tree+single-parent check now lives in the shared, exported
    // `verifyCommitParentAndTree` (above), reused by the batch path; this closure only adds the
    // uncaptured-base short-circuit and the ledger-base return value.
    // @decision f224632d — parent+tree alone is forgeable-to-match; this closure also verifies the landed
    // commit's own Loom trailer namespace (shared `verifyLoomTrailersExactAndReadable`, card 95940402).
    // @decision f224632d (round 2) — ONLY kind "forged" disqualifies; "displaced"/"unreadable" stay
    // verified (a legitimate commit-msg hook, not a forgery) and surface `trailerAdvisory` instead.
    const verifyLandedAsOwnCommit = async (sha: string): Promise<{ landedBase: string | undefined; trailerAdvisory?: "displaced" | "unreadable" }> => {
      if (preCommitHead === undefined || stagedTree === undefined) return { landedBase: undefined };
      // @decision 95940402 — no try/catch here: verifyCommitParentAndTree already catches its own
      // git-read failures and resolves {ok:false} rather than throwing.
      const verify = await verifyCommitParentAndTree(git, timeoutMs, sha, preCommitHead, stagedTree);
      if (!verify.ok) return { landedBase: undefined };
      const expectedTrailers: Record<string, string> = { "Loom-Worker-Branch": branch };
      if (resolvedBranchHead) expectedTrailers["Loom-Landed-Tip"] = resolvedBranchHead;
      if (stampedPathSetDigest !== undefined) {
        expectedTrailers["Loom-Worker-Base"] = preCommitHead;
        expectedTrailers["Loom-Worker-PathSet"] = stampedPathSetDigest;
      }
      const trailerCheck = verifyLoomTrailersExactAndReadable(verify.body ?? "", expectedTrailers);
      if (trailerCheck.ok) return { landedBase: preCommitHead };
      if (trailerCheck.kind === "forged") return { landedBase: undefined };
      return { landedBase: preCommitHead, trailerAdvisory: trailerCheck.kind };
    };
    // @decision 2a6a292a round 23 (card aa7677fa round 5) — a bare `landedBase === undefined` collapses
    // "uncaptured" (nothing was ever checked) and "rejected" (checked — a real race) — a caller needs
    // both told apart from each other and from "verified" (the one case `landedBase` is defined).
    const classifyLandedVerify = (landedBase: string | undefined): "verified" | "rejected" | "uncaptured" =>
      (preCommitHead === undefined || stagedTree === undefined) ? "uncaptured" : (landedBase !== undefined ? "verified" : "rejected");
    // @decision 24c0bdba — kill-confirmed: a "failure" here can still mean the commit landed anyway (a
    // post-commit hook outliving the timeout) — re-verify via HEAD and report truthfully, never assume.
    try {
      await killableCanonicalRaw(repoPath, ["commit", "-m", message], timeoutMs, "git commit (canonical, squash-merge)", deps.gitFactory, { ...nonInteractiveEnv(), ...identityEnv }, onTreeDeathSettled);
    } catch (e) {
      // @decision bde5d1fe — already quarantined at the re-check; refuse directly, never re-raise. Name
      // the real staged residue the squash already left behind (Code Review of b4315b52, item 4) so a
      // human knows a `git reset --hard` is needed once cleared, or the NEXT merge refuses at entry too.
      // @decision 8d8fa497 — set `quarantined:true` on this and the following branch too.
      if (e instanceof RepoQuarantinedError) {
        return {
          ok: false,
          reason: `squash commit refused — canonical repo is quarantined: ${e.message} — canonical now ` +
            `holds ${branch}'s STAGED squash residue (the squash itself already landed in the index before ` +
            `this refusal); once the quarantine clears, run \`git reset --hard\` in the canonical repo FIRST, ` +
            `or every later solo merge attempt will itself refuse at the staged-dirty-tree entry check`,
          quarantined: true,
        };
      }
      // Code Review (card 24c0bdba, finding B1 residual): the tree-kill's OWN confirmation can itself come
      // back unconfirmed (a descendant not reaped within grace) — fail CLOSED + QUARANTINE, never touch
      // the repo further, since resetOrSkip's `reset --hard` would race whatever might still be alive.
      if (treeDeathUnconfirmed(e)) {
        raisedToken = enterMergeQuarantine(repoPath, branch, unconfirmedKillReason("squash commit could not be confirmed dead after a kill"), opId);
        return {
          ok: false,
          reason: `squash commit's git process tree could not be confirmed dead after a kill — refusing further cleanup to avoid racing it: ${(e as Error).message} — the commit may have already landed despite this failure (the real git child's own commit may have completed before or after the kill could be confirmed); canonical repo may need manual inspection, but once a human clears the quarantine, simply retrying this merge will detect any already-landed content as ALREADY_MERGED and finalize without creating a duplicate commit`,
          quarantined: true,
        };
      }
      // m1 (Code Review): a bare "HEAD moved" is not enough to trust as OUR commit — verify it is
      // EXACTLY the commit this attempt would have made before claiming ok:true; otherwise report the
      // ambiguity by name rather than silently discarding or silently trusting an unverified movement.
      // @decision 2a6a292a round 21 (card aa7677fa round 3) — parent+tree AND (card f224632d) the
      // trailer namespace, both via `verifyLandedAsOwnCommit` — never a bare re-read trailer, forgeable
      // by anyone with `.git` write access.
      if (preCommitHead !== undefined) {
        let headAfterFailure: string | undefined;
        let landedBase: string | undefined;
        let trailerAdvisory: "displaced" | "unreadable" | undefined;
        try {
          headAfterFailure = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (canonical, post-commit-failure verify)")).trim();
          if (headAfterFailure !== preCommitHead) ({ landedBase, trailerAdvisory } = await verifyLandedAsOwnCommit(headAfterFailure));
        } catch { /* unknown — fall through to the ordinary failure/cleanup path below */ }
        if (headAfterFailure !== undefined && headAfterFailure !== preCommitHead) {
          if (landedBase !== undefined) {
            // HEAD moved despite the reported failure — the commit landed (and its real git child is now
            // CONFIRMED dead, so nothing can land AFTER this point), verified as OUR commit specifically.
            // Recover it truthfully rather than reporting a false failure.
            const verified = await verifyLandedOnMainline(headAfterFailure);
            if (!verified.ok) return { ...verified, landedTip: resolvedBranchHead };
            return { ok: true, sha: headAfterFailure, subject, landedTip: resolvedBranchHead, landedBase, landedVerify: classifyLandedVerify(landedBase), ...(trailerAdvisory ? { trailerAdvisory } : {}) };
          }
          return {
            ok: false,
            reason: `squash commit failed (${(e as Error).message}), but HEAD moved to ${headAfterFailure} afterwards in a way this merge cannot verify as its own (expected parent ${preCommitHead}, tree ${stagedTree ?? "(not captured)"}) — canonical repo needs manual inspection`,
          };
        }
      }
      const cleanup = await resetOrSkip("commit-failure cleanup");
      return { ok: false, reason: cleanup ? `squash commit failed: ${(e as Error).message} (${cleanup.message})` : `squash commit failed: ${(e as Error).message}`, ...(cleanup?.quarantined ? { quarantined: true } : {}), ...(cleanup?.transient ? { transient: true, residuePossible: true } : {}) };
    }
    // Re-read HEAD after a successful commit. NOT "unconditionally reached from both branches": a failure
    // now returns straight out of the catch above, having already re-verified truthfully via its own HEAD
    // re-read (the commit call is kill-confirmed, so the git child is confirmed dead before either branch
    // is taken — `withTimeout`'s old settle-independent-of-the-child risk no longer applies here).
    //
    // This read is a plain confirm-what-landed step, guarding against THIS read itself failing, mirroring
    // {@link landBranchCommitsIndividually}'s own post-loop read (`git/batch-merge.ts`): read once, and
    // fail LOUD (`ok:false`) if that read itself fails, rather than returning a value that might no longer
    // be what HEAD actually points at.
    try {
      const sha = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (canonical, post-commit)")).trim();
      const verified = await verifyLandedOnMainline(sha);
      if (!verified.ok) return { ...verified, landedTip: resolvedBranchHead };
      // @decision 2a6a292a round 21 (card aa7677fa round 3) — a racer can move HEAD between `git commit`
      // settling and this read; verify `sha` is OUR commit before a caller treats it as a ledger/trust
      // fact — undefined here means "unverified", never a refusal.
      const { landedBase, trailerAdvisory } = await verifyLandedAsOwnCommit(sha);
      return { ok: true, sha, subject, landedTip: resolvedBranchHead, landedBase, landedVerify: classifyLandedVerify(landedBase), ...(trailerAdvisory ? { trailerAdvisory } : {}) };
    } catch (e) {
      return { ok: false, reason: `squash landed but failed to read the result: ${(e as Error).message}` };
    }

  } finally {
    // Round 4: unconditional again — the in-flight/crash-recovery window (5a7692a4) and the QUARANTINE
    // (merge-quarantine.ts) are now separate mechanisms with separate lifetimes. This window always
    // clears here; a quarantine entered above stays latched independently, via its own store, until
    // `onTreeDeathSettled` auto-clears it or a human clears it through the loopback REST route.
    exitMergeDangerWindow(repoPath);
  }
}

/** @decision 44c28799 — boot-time, READ-ONLY companion to {@link mergeBranchLocked}'s entry check: scans for
 *  dirty tracked state to SHRINK THE DETECTION WINDOW, never to close the hole itself (the merge-time refusal
 *  already does that).
 *
 *  NEVER resets, NEVER blocks boot, NEVER throws — a non-git-checkout repo is silently
 *  skipped, not surfaced as a failure. */
export async function scanCanonicalReposForMergeResidue(
  repoPaths: string[], deps: BoundedGitDeps = {},
): Promise<{ repoPath: string; status: string; staged: boolean }[]> {
  const dirty: { repoPath: string; status: string; staged: boolean }[] = [];
  for (const repoPath of new Set(repoPaths)) {
    try {
      const { git, timeoutMs } = boundedMergeGit(repoPath, deps);
      const status = (await withTimeout(git.raw(["status", "--porcelain", "--untracked-files=no"]), timeoutMs, "git status (canonical, boot residue scan)")).trim();
      if (status === "") continue;
      const stagedStatus = (await withTimeout(git.raw(["diff", "--cached", "--name-only"]), timeoutMs, "git diff --cached (canonical, boot residue scan)")).trim();
      dirty.push({ repoPath, status, staged: stagedStatus !== "" });
    } catch { /* not a repo / unreadable / no HEAD yet / timed out ⇒ nothing to report */ }
  }
  return dirty;
}
