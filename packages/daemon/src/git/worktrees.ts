import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { SimpleGit } from "simple-git";
import { WORKTREES_DIR } from "../paths.js";
import { nonInteractiveEnv } from "./writer.js";
import { withTimeout, withTimeoutKillingChild, boundedSimpleGit } from "./bounded.js";
import { withCanonicalIndexLock } from "./repo-lock.js";
import { enterMergeDangerWindow, exitMergeDangerWindow } from "./merge-danger-window.js";
import { isDoctrineArtifactPath, isDoctrineSkillsPath } from "../pty/claude-doctrine.js";
import { isCodexDoctrinePath } from "../pty/codex-doctrine.js";
import { checkTitleHtmlEntities, CONVENTIONAL_TYPES } from "../tasks/title-guard.js";

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
const GIT_OP_TIMEOUT_MS = 15_000;

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
  /**
   * Injectable KILLABLE directory removal for removeWorktree's backstop (defaults to
   * {@link killableRemoveDir}). Lets a test simulate either a CLEAN reject (settles fast, `removed:false,
   * killed:false` — the transient EBUSY/EPERM handle-lag case) or a genuine HANG (a promise that never
   * resolves) and prove removeWorktree still returns within `timeoutMs` either way.
   */
  removeDir?: (target: string, timeoutMs: number) => Promise<RemoveDirResult>;
}

// @decision 0f965ab7 — catch simple-git's synchronous construct throw once, centrally, via this stub
// proxy: a new caller hitting a construct-time throw routes through boundedGit/boundedMergeGit/
// boundedDiffGit (which already apply this), never its own per-caller try/catch around simpleGit(...).
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

/** Build the bounded git instance + resolve the timeout for one op, applying the seam's defaults. Never
 *  throws — see {@link gitConstructFailure}. */
function boundedGit(repoPath: string, deps: BoundedGitDeps): { git: Pick<SimpleGit, "raw">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const makeGit = deps.gitFactory ?? ((p, ms) => boundedSimpleGit(p, ms));
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
 * {@link GIT_OP_TIMEOUT_MS}), PLUS `nonInteractiveEnv()` (`GIT_TERMINAL_PROMPT=0` etc.) on the default
 * factory — matching `git/reader.ts` and `git/writer.ts`'s own convention for a git WRITE. Used only by
 * {@link mergeBranchLocked} and {@link scanCanonicalReposForMergeResidue}: the squash-merge onto the
 * canonical repo is this codebase's highest-consequence git write (board card 44c28799), so it gets the
 * same non-interactive posture as every other writer. Deliberately NOT folded into {@link boundedGit}
 * itself — that helper backs ~20 other call sites in this file (worktree creation, branch listing,
 * diffing) that are read-mostly or worktree-scoped; changing their environment behavior is out of scope
 * here and would need its own verification. `gitFactory`, when supplied (the test seam), is used as-is —
 * a test injecting a hanging fake doesn't need env scrubbing applied to it.
 */
function boundedMergeGit(repoPath: string, deps: BoundedGitDeps): { git: Pick<SimpleGit, "raw">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const makeGit = deps.gitFactory ?? ((p, ms) => boundedSimpleGit(p, ms, nonInteractiveEnv()));
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
    const head = (await withTimeout(
      git.raw(["rev-parse", "--abbrev-ref", "HEAD"]), timeoutMs, "git rev-parse --abbrev-ref HEAD (post-add benign-noise verify)",
    )).trim();
    return head === branch;
  } catch {
    return false;
  }
}

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
}

/** Build the bounded git instance + resolve the timeout for {@link diffBranch}'s ops, applying the seam's defaults. */
function boundedDiffGit(repoPath: string, deps: DiffBranchDeps): { git: Pick<SimpleGit, "raw" | "diffSummary" | "diff">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const makeGit = deps.gitFactory ?? ((p, ms) => boundedSimpleGit(p, ms));
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
    const out = await withTimeout(git.raw(["rev-parse", "--verify", `${ref}^{commit}`]), timeoutMs, "git rev-parse --verify");
    const sha = out.trim();
    return sha || null;
  } catch {
    return null;
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
): Promise<DiscardedOnRecutInfo | undefined> {
  const { git: repoGit, timeoutMs: repoTimeoutMs } = boundedGit(repoPath, deps);
  const mainSha = (await withTimeout(repoGit.raw(["rev-parse", "HEAD"]), repoTimeoutMs, "git rev-parse HEAD")).trim();
  const aheadRaw = await withTimeout(
    repoGit.raw(["rev-list", "--count", `${mainSha}..${branch}`]), repoTimeoutMs, "git rev-list --count (ahead of main)",
  );
  // FAIL SAFE: only re-cut a PROVABLY-empty branch (0 ahead). A recovery branch (>0 ahead) OR a malformed/
  // unparseable count (NaN) → leave the branch EXACTLY as-is; never let a bad count fall through to the
  // DESTRUCTIVE reset below (the `|| 0`-treats-NaN-as-0 data-loss footgun). See {@link mayRecutOntoMain}.
  if (!mayRecutOntoMain(aheadRaw)) return undefined;
  // Snapshot what's about to be destroyed BEFORE the reset — see this function's own doc above.
  const discardedOnRecut = await captureDiscardedOnRecut(worktreePath, deps);
  // Empty/stale branch → re-cut its pointer + checkout onto current main (SHA, never a branch name).
  const { git: wtGit, timeoutMs: wtTimeoutMs } = boundedGit(worktreePath, deps);
  await withTimeout(wtGit.raw(["reset", "--hard", mainSha]), wtTimeoutMs, "git reset --hard");
  return discardedOnRecut;
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
    const porcelain = await withTimeout(git.raw(["status", "--porcelain"]), timeoutMs, "git status --porcelain");
    return summarizeDirtyFiles(uncommittedWorkFiles(porcelain));
  } catch {
    return undefined; // FAIL SAFE — a status-check hiccup must never block or alter the spawn
  }
}

/**
 * Board card 13cc2300 — the {@link uncommittedWorkFiles} paths a `git reset --hard` will actually revert:
 * TRACKED entries only (status not `??`). An untracked file is untouched by `reset --hard` and survives
 * it, so it must never be reported as "discarded" — that distinction is the whole point of this filter
 * existing separately from {@link uncommittedWorkFiles} itself. Implemented as a POST-filter on that
 * function's own already-daemon-noise-filtered output (re-parsing the porcelain only for each line's
 * status char) rather than a parallel parsing loop, so the two can never drift on what counts as daemon
 * noise vs. real work — only the tracked/untracked split is new here.
 */
function discardedByResetFiles(porcelain: string): string[] {
  const tracked = new Set<string>();
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    // porcelain v1 line: 2 status chars, a space, then the path. `??` = untracked — reset --hard leaves it.
    if (line.slice(0, 2) === "??") continue;
    let p = line.slice(3);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1); // git quotes paths with special chars
    tracked.add(p);
  }
  return uncommittedWorkFiles(porcelain).filter((p) => tracked.has(p));
}

/**
 * Board card 13cc2300 — the pre-recut twin of {@link detectReusedDirtyWorktree}: same read (`git status
 * --porcelain`), same bound ({@link summarizeDirtyFiles}), same FAIL-SAFE posture (a capture hiccup reads
 * as "nothing to report", never blocking or altering the caller's reset) — but filtered through {@link
 * discardedByResetFiles} instead of {@link uncommittedWorkFiles}, so it names only what a `reset --hard`
 * actually destroys (tracked work), never an untracked leftover that will survive the reset untouched.
 * Called by {@link recutStaleReusedBranch} IMMEDIATELY BEFORE that reset — the only moment this is still
 * true to read.
 */
async function captureDiscardedOnRecut(worktreePath: string, deps: BoundedGitDeps = {}): Promise<DiscardedOnRecutInfo | undefined> {
  try {
    const { git, timeoutMs } = boundedGit(worktreePath, deps);
    const porcelain = await withTimeout(git.raw(["status", "--porcelain"]), timeoutMs, "git status --porcelain");
    return summarizeDirtyFiles(discardedByResetFiles(porcelain));
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
    const baseSha = (await withTimeout(git.raw(["merge-base", branch, mainSha]), timeoutMs, "git merge-base")).trim();
    const filesRaw = await withTimeout(git.raw(["diff", "--name-only", baseSha, mainSha]), timeoutMs, "git diff --name-only");
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
  const key = taskKey(taskId);
  const branch = `loom/${key}`;
  const worktreePath = repoKey && repoKey !== "primary"
    ? path.join(WORKTREES_DIR, projectId, repoKey, key)
    : path.join(WORKTREES_DIR, projectId, key);
  // The repo's CURRENT HEAD — the fork point this worktree's branch is (or was) cut off, captured up
  // front so it's correct for every path below (fresh cut, reuse, and reattach all fork off THIS sha).
  // BOUNDED (card c801d688): a hung rev-parse now throws within the bound instead of stalling the spawn
  // forever — this call has no local catch, so the throw propagates to createWorktree's own caller
  // exactly as an unbounded failure already did, just with a ceiling on how long that takes.
  const { git: headGit, timeoutMs: headTimeoutMs } = boundedGit(repoPath, gitDeps);
  const mainSha = (await withTimeout(headGit.raw(["rev-parse", "HEAD"]), headTimeoutMs, "git rev-parse HEAD")).trim();
  if (fs.existsSync(worktreePath)) {
    // Retained worktree → reuse (already provisioned). Re-cut an empty/stale branch onto current main
    // first; a recovery branch (unmerged work) is left exactly as-is. Board card 13cc2300: for a 0-ahead
    // branch this is exactly the DESTRUCTIVE step — recutStaleReusedBranch snapshots what it's about to
    // discard BEFORE the reset (the only moment it's still there), so it can still be reported below even
    // though detectReusedDirtyWorktree's own post-recut read (next) will find it already gone.
    const discardedOnRecut = await recutStaleReusedBranch(repoPath, worktreePath, branch, gitDeps);
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
    if (forwarded) await provisionWorktreeDeps(worktreePath, deps);
    return {
      worktreePath, branch, mainSha,
      ...(discardedOnRecut ? { discardedOnRecut } : {}),
      ...(reusedDirtyWorktree ? { reusedDirtyWorktree } : {}),
      ...(staleBase ? { staleBase } : {}),
    };
  }

  // BOUNDED (card c801d688) — same rationale as the rev-parse above: no local catch, so a timeout
  // propagates exactly like any other git failure already did, just bounded instead of unbounded.
  const timeoutMs = gitDeps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  // @decision 2fcd5eae — serialize prune -> branch --list -> add per canonical repo under
  // withCanonicalIndexLock; never wrap provisionWorktreeDeps in it (an install can take minutes and would
  // serialize every spawn behind it). Release the lock only once the child is confirmed dead — never on a
  // bare withTimeout race.
  const boundedLockedRaw = (args: string[], label: string): Promise<string> => {
    if (gitDeps.gitFactory) return withTimeout(gitDeps.gitFactory(repoPath, timeoutMs).raw(args), timeoutMs, label);
    const controller = new AbortController();
    return withTimeoutKillingChild(boundedSimpleGit(repoPath, timeoutMs, undefined, controller.signal).raw(args), timeoutMs, label, controller);
  };
  const branchExists = await withCanonicalIndexLock(repoPath, async () => {
    await boundedLockedRaw(["worktree", "prune"], "git worktree prune"); // drop any stale admin record for a since-deleted dir
    const exists = (await boundedLockedRaw(["branch", "--list", branch], "git branch --list")).trim() !== "";
    try {
      await boundedLockedRaw(exists
        ? ["worktree", "add", worktreePath, branch]              // branch survived a worktree removal → re-attach
        : forkFrom
          ? ["worktree", "add", worktreePath, "-b", branch, forkFrom] // review spawn → fresh branch off the reviewed tip
          : ["worktree", "add", worktreePath, "-b", branch],          // fresh task → new branch off current HEAD
        "git worktree add");
    } catch (addErr) {
      // @decision af436c99 — recognize git worktree add's own benign progress text (mistaken for failure by a
      // simple-git exitCode race) as success, only once independently confirmed landed via worktreeAddLanded;
      // never widen the pattern to swallow a real fatal:/error: line or a killed-child suffix.
      if (isBenignWorktreeAddNoise((addErr as Error).message ?? "")
        && (await worktreeAddLanded(worktreePath, branch, gitDeps))) {
        return exists;
      }
      // @decision 1a858805 — best-effort recovery of a locked .git/worktrees/ admin record left by a killed
      // `worktree add`, via `git worktree remove -f -f` inside this SAME canonical lock (never outside it —
      // that would reopen the race the lock exists to close); relies on worktreePath being deterministic per
      // task, not an arbitrary path.
      //
      // @decision fdfe8a56 — SKIP that recovery when the add's child isn't confirmed dead (PATH-2 "giving up
      // (hung git child?)"): racing a possibly-still-alive child can wipe worktreePath's admin record while it
      // keeps writing, leaving no .git link — worse than a self-healing locked residue.
      //
      // ⛔ A cleanup failure here must NEVER throw past createWorktree or mask the ORIGINAL add error —
      // swallow it and rethrow addErr unchanged either way.
      const isPath2GiveUp = /giving up \(hung git child\?\)/.test((addErr as Error).message ?? "");
      if (!isPath2GiveUp) {
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
  if (branchExists) {
    // Re-attached an existing branch at its old tip → same re-cut: empty/stale → current main; a
    // recovery branch (unmerged work) → untouched. This worktree dir did NOT exist a moment ago (the
    // `fs.existsSync` check above was false) — `git worktree add` just cut a FRESH checkout of the
    // branch's own committed tip, so there is structurally nothing dirty for the recut below to discard;
    // its `discardedOnRecut` return is intentionally not surfaced on this path (see {@link
    // WorktreeInfo.reusedDirtyWorktree}'s own doc: "a reattached-branch-only worktree (always a clean
    // fresh checkout)" — the same reasoning applies here).
    await recutStaleReusedBranch(repoPath, worktreePath, branch, gitDeps);
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
  return staleBase ? { worktreePath, branch, mainSha, staleBase } : { worktreePath, branch, mainSha };
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
export async function deleteBranch(repoPath: string, branch: string, deps: BoundedGitDeps = {}): Promise<void> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    await withTimeout(git.raw(["branch", "-D", branch]), timeoutMs, "git branch -D");
  } catch (e) {
    const msg = (e as Error).message;
    // `branch '…' not found` is the DESIRED idempotent end state (the branch is already gone — e.g. a
    // re-run after a prior delete, or a never-created branch) — treat as success, no warn. Keep warning
    // on genuine failures (busy ref lock, timeout, etc.).
    if (/not found/i.test(msg)) return;
    // eslint-disable-next-line no-console
    console.warn(`[worktree] could not delete merged branch ${branch}: ${msg}`);
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
    const out = await withTimeout(git.raw(["branch", "--list", branch]), timeoutMs, "git branch --list");
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
  const deleted: string[] = [];
  for (let i = 0; i < branches.length; i += DELETE_BRANCHES_CHUNK_SIZE) {
    const chunk = branches.slice(i, i + DELETE_BRANCHES_CHUNK_SIZE);
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    try {
      await withTimeout(git.raw(["branch", "-D", ...chunk]), timeoutMs, "git branch -D (batch)");
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

/** `await`able delay — used only for the short bounded clean-reject retry in {@link removeWorktree}. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Attempts for a CLEAN (settled, non-hang) removal reject — a transient EBUSY/EPERM handle-lag right
 *  after a worker exits, which SETTLES quickly and is worth a couple of short retries. A genuinely
 *  wedged (killed) removal is NEVER looped — see {@link removeWorktree}. */
const REMOVE_DIR_CLEAN_RETRY_ATTEMPTS = 3;
const REMOVE_DIR_CLEAN_RETRY_DELAY_MS = 500;

/**
 * Remove a worker's worktree and prune the admin record. Branch deletion (after merge) is
 * #16's concern, not here.
 *
 * @decision c6a6f405 — deliberately UNLOCKED (not an oversight): do not wrap this in withCanonicalIndexLock
 * reflexively — the lock is NOT re-entrant, and a caller that already holds it would deadlock. Judged safe
 * because git's own locked/initializing marker makes a concurrent prune skip an in-flight add.
 *
 * @decision 79b8d8a9 — bounded, best-effort git removal (`-f -f`, closing a Windows handle-release race and a
 * locked-admin-record ghost) backed by the killable filesystem removal, which already deletes dirty/untracked
 * content unconditionally; a KILLED (wedged) attempt is never retried here — only a clean reject gets short
 * in-session retries.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  deps: BoundedGitDeps = {},
): Promise<{ removed: boolean; wedged: boolean }> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    await withTimeout(git.raw(["worktree", "remove", worktreePath, "-f", "-f"]), timeoutMs, "git worktree remove");
  } catch {
    // A hang (timeout-kill), a busy handle, or git already de-registering the worktree without
    // deleting the dir — all fall through to the filesystem backstop.
  }
  const removeDir = deps.removeDir ?? ((p, ms) => killableRemoveDir(p, ms));
  let removed = true;
  let wedged = false;
  for (let attempt = 1; attempt <= REMOVE_DIR_CLEAN_RETRY_ATTEMPTS; attempt++) {
    // Only skip a RETRY (attempt > 1) if the dir vanished between attempts (e.g. removed some other way) —
    // the first attempt always calls removeDir unconditionally, mirroring the pre-existing force-remove
    // semantics (a target that's already gone is simply a no-op removal, not specially short-circuited).
    if (attempt > 1 && !fs.existsSync(worktreePath)) { removed = true; wedged = false; break; }
    const result = await withTimeout(removeDir(worktreePath, timeoutMs), timeoutMs, "removeDir worktree")
      .catch((): RemoveDirResult => ({ removed: false, killed: true })); // an injected/broken seam that itself never settles ⇒ fail SAFE as WEDGED (never loop a hang)
    removed = result.removed;
    if (removed) { wedged = false; break; }
    if (result.killed) { wedged = true; break; } // genuinely wedged — hand to the caller's slow-retry policy, NEVER loop a hang HERE
    if (attempt < REMOVE_DIR_CLEAN_RETRY_ATTEMPTS) await delay(REMOVE_DIR_CLEAN_RETRY_DELAY_MS); // clean reject → short bounded retry
  }
  if (!removed) {
    // eslint-disable-next-line no-console
    console.warn(`[worktree] could not remove dir ${worktreePath} (${wedged ? "genuinely wedged — caller retries it slowly" : "left on disk for a later GC"})`);
  }
  try {
    await withTimeout(git.raw(["worktree", "prune"]), timeoutMs, "git worktree prune");
  } catch {
    // A hung/failed prune must NOT throw past removeWorktree (which would re-introduce the boot hang
    // via finalizeMerge / Pass B). A stale admin record is harmless — createWorktree prunes on reuse.
  }
  return { removed, wedged };
}

/** @decision 9cb0287a — test-only: ZERO production call sites since boot-reconcile Pass A switched to
 *  positive squash-trailer proof (findLandedSquashCommit) instead. Don't remove it as "dead code" until
 *  card 0f965ab7's pending review of the fail-safe siblings that still reference it resolves. */
export async function isBranchMerged(repoPath: string, branch: string, base = "HEAD", deps: BoundedGitDeps = {}): Promise<boolean> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    return (await withTimeout(git.raw(["branch", "--merged", base, "--list", branch]), timeoutMs, "git branch --merged")).trim() !== "";
  } catch {
    return false;
  }
}

// @decision 09f268a5 — resolve mainline via refs/remotes/origin/HEAD, never HEAD itself (which can be
// parked on an arbitrary branch here); FAILS CLOSED to null with NO guessed "main" fallback — a repo with
// no resolvable origin/HEAD (a plain `git init`, no remote) is a known gap, not a bug to "fix" with a guess.
export async function resolveMainlineBranch(repoPath: string, deps: BoundedGitDeps = {}): Promise<string | null> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    const out = await withTimeout(
      git.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
      timeoutMs,
      "git symbolic-ref origin/HEAD",
    );
    const ref = out.trim(); // e.g. "origin/main"
    const branch = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    return branch || null;
  } catch (e) {
    // Card f96b9d7c: this catch used to be silent, so a repo with a genuinely NO resolvable origin/HEAD
    // (the expected, permanent case) was indistinguishable from a TRANSIENT read failure (a timeout under
    // boot-time load, a git error) — both just produced `null` with zero log output. Log the real cause
    // here; the caller still treats both as "skip this repo, fail closed" (unchanged behavior), but the
    // reason is now visible instead of silently swallowed.
    // eslint-disable-next-line no-console
    console.warn(`[git] resolveMainlineBranch failed for ${repoPath}: ${(e as Error).message}`);
    return null;
  }
}

/** @decision f96b9d7c — every local `loom/*` branch merged into `mainlineBranch` (which MUST come from {@link
 *  resolveMainlineBranch}, never a literal/`HEAD`); fails safe to `{branches:[]}` on error, with a `failed`
 *  discriminator + logged cause — never restore the old silent catch that made this indistinguishable from a
 *  genuine zero. */
export async function listMergedLoomBranches(repoPath: string, mainlineBranch: string, deps: BoundedGitDeps = {}): Promise<{ branches: string[]; failed: boolean }> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    const out = await withTimeout(
      git.raw(["branch", "--list", "loom/*", "--merged", mainlineBranch, "--format=%(refname:short)"]),
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
    const raw = await withTimeout(git.raw(["rev-list", "--count", `${branch}..${base}`]), timeoutMs, "git rev-list --count (behind base)");
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Does `git status --porcelain` represent REAL worker work, or only daemon-injected `.claude/` noise
 *  (skill injection, Claude's own `settings.local.json` writes)? ⛔ Two noise classes are dropped — any
 *  untracked `.claude/` path, and the injected `.claude/skills/` subtree at ANY status — everything else
 *  (incl. a tracked non-skills `.claude/` file) counts as work; without this a merged worktree reads dirty
 *  and blocks its own cleanup. Exported so the guard is unit-testable in isolation. */
export function worktreeStatusHasWork(porcelain: string): boolean {
  return uncommittedWorkFiles(porcelain).length > 0;
}

/**
 * The filtered, noise-excluded `git status --porcelain` LINES (not just paths) — the shared foundation
 * both {@link uncommittedWorkFiles} and {@link computeWorktreeGateStamp}'s `dirtyHash` build on, so every
 * consumer of "what counts as real work" agrees. Two daemon-noise classes are dropped: an UNTRACKED (`??`)
 * path under `.claude/` (skill injection + Claude's own `.claude/settings.local.json` permission writes),
 * AND the daemon-injected `.claude/skills/` subtree at ANY status (a re-copy over a tracked colliding skill
 * name surfaces as a tracked modification, not `??`). Everything else — tracked modifications elsewhere
 * (incl. a tracked non-skills file under `.claude/`), staged/unstaged changes, untracked paths OUTSIDE
 * `.claude/` — is the worker's product and kept. Card 887e10b8 Item 1: codex's injected AGENTS.md is the
 * SAME kind of doctrine noise, untracked-only (a repo's own real, already-TRACKED AGENTS.md would show a
 * different status and is never touched by injectCodexDoctrine in the first place).
 */
function filteredWorkLines(porcelain: string): string[] {
  const lines: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    // porcelain v1 line: 2 status chars, a space, then the path. `??` = untracked.
    const status = line.slice(0, 2);
    let p = line.slice(3);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1); // git quotes paths with special chars
    if (status === "??" && isDoctrineArtifactPath(p)) continue;
    if (isDoctrineSkillsPath(p)) continue;
    if (status === "??" && isCodexDoctrinePath(p)) continue;
    lines.push(line);
  }
  return lines;
}

/**
 * De-quote a porcelain v1 line's path (status + space prefix stripped, `"`-wrapped special-char paths
 * unwrapped). A RENAME/COPY line's path field is `old -> new` (git quotes each half independently, e.g.
 * `"old file.txt" -> "new file.txt"`) — this returns the NEW path (the one that matters going forward: a
 * later content edit to the renamed file is diffed/reported against `new`, not the stale `old`, and
 * naming `old -> new` as one "file" in an uncommittedWorkFiles refusal was never a real committable path
 * anyway).
 */
function porcelainLinePath(line: string): string {
  let p = line.slice(3);
  const arrow = p.indexOf(" -> ");
  if (arrow !== -1) p = p.slice(arrow + 4); // rename/copy: take the NEW path
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p;
}

/**
 * The REAL-work paths in a `git status --porcelain` output — the list form of {@link worktreeStatusHasWork}
 * (which is now just `length > 0`), built on the same {@link filteredWorkLines} filter so the two (and
 * {@link computeWorktreeGateStamp}'s `dirtyHash`) can't drift apart. Exported so the worker_report(done)
 * pre-check can NAME the uncommitted files in its refusal. Paths are de-quoted (git quotes paths with
 * special chars).
 */
export function uncommittedWorkFiles(porcelain: string): string[] {
  return filteredWorkLines(porcelain).map(porcelainLinePath);
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
  const makeGit = deps.gitFactory ?? ((p, ms) => boundedSimpleGit(p, ms));

  // (1) Dirty working tree? Read porcelain status IN the worktree (its own index + working tree),
  //     ignoring daemon-injected untracked `.claude/` noise (see uncommittedWorkFiles).
  try {
    const wt = makeGit(worktreePath, timeoutMs);
    const porcelain = await withTimeout(wt.raw(["status", "--porcelain"]), timeoutMs, "git status --porcelain");
    const files = uncommittedWorkFiles(porcelain);
    if (files.length > 0) return { uncommitted: true, files, zeroAhead: false };
  } catch {
    return { uncommitted: false, files: [], zeroAhead: false }; // FAIL SAFE: never block a legitimate done
  }

  // (2) Clean working tree. Is the assigned branch 0 commits ahead of base? → WARN-only signal.
  if (branch) {
    try {
      const ahead = parseInt(
        (await withTimeout(git.raw(["rev-list", "--count", `${base}..${branch}`]), timeoutMs, "git rev-list --count")).trim(),
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

/** @decision 9cb0287a — SAFE-TO-DISCARD guard for boot-reconcile Pass B (the 2026-06-05 P0 data-loss fix);
 *  "work" = dirty tree OR branch ahead of base; FAILS SAFE to TRUE (assume work) — a wedged/locked check must
 *  never be why a live worktree is deleted. Don't re-apply this to Pass A; its squash-trailer proof is the
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
  const makeGit = deps.gitFactory ?? ((p, ms) => boundedSimpleGit(p, ms));

  // (1) Dirty working tree? Read porcelain status IN the worktree (its own index + working tree),
  //     ignoring daemon-injected untracked `.claude/` noise (see worktreeStatusHasWork).
  try {
    const wt = makeGit(worktreePath, timeoutMs);
    const porcelain = await withTimeout(wt.raw(["status", "--porcelain"]), timeoutMs, "git status --porcelain");
    if (worktreeStatusHasWork(porcelain)) return true;
  } catch {
    return true; // bounded failure → fail SAFE (assume work, keep the dir)
  }

  // (2) Branch ahead of the canonical base? Any commit reachable from the branch but not from `base`.
  if (branch) {
    try {
      const ahead = parseInt(
        (await withTimeout(git.raw(["rev-list", "--count", `${base}..${branch}`]), timeoutMs, "git rev-list --count")).trim(),
        10,
      );
      if (!Number.isFinite(ahead) || ahead > 0) return true; // NaN (parse/ref error) or >0 → fail SAFE / has work
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
}

/** MERGE-GATE BACKSTOP (2026-06-10): catches a worker whose commits are STRANDED on a self-created
 *  branch instead of its assigned `loom/<key>` (incident: worker `712fd5aa`, commit `1309552` silently
 *  lost via an empty squash merge). FAILS SAFE to `{stranded:false}` on any error — never blocks a merge. */
export async function detectStrandedWork(
  repoPath: string,
  worktreePath: string,
  assignedBranch: string,
  deps: BoundedGitDeps = {},
): Promise<StrandedWork> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  const makeGit = deps.gitFactory ?? ((p, ms) => boundedSimpleGit(p, ms));
  try {
    const mainSha = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD")).trim();

    // (1) Work on the ASSIGNED branch? Any commit reachable from it but not from canonical main ⇒ the
    //     normal path — not stranded, regardless of what the worktree is checked out on.
    const assignedAhead = parseInt(
      (await withTimeout(git.raw(["rev-list", "--count", `${mainSha}..${assignedBranch}`]), timeoutMs, "git rev-list --count assigned")).trim(),
      10,
    );
    if (Number.isFinite(assignedAhead) && assignedAhead > 0) return { stranded: false };

    // (2) Assigned branch is empty (0 ahead). Inspect the WORKTREE's actual checked-out branch.
    const wt = makeGit(worktreePath, timeoutMs);
    const wtBranch = (await withTimeout(wt.raw(["rev-parse", "--abbrev-ref", "HEAD"]), timeoutMs, "git rev-parse --abbrev-ref HEAD")).trim();
    if (!wtBranch || wtBranch === assignedBranch) return { stranded: false }; // same branch ⇒ no divergence

    const wtAhead = parseInt(
      (await withTimeout(wt.raw(["rev-list", "--count", `${mainSha}..HEAD`]), timeoutMs, "git rev-list --count worktree")).trim(),
      10,
    );
    if (!Number.isFinite(wtAhead) || wtAhead <= 0) return { stranded: false }; // nothing committed anywhere ⇒ nothing to strand

    const commit = (await withTimeout(wt.raw(["rev-parse", "--short", "HEAD"]), timeoutMs, "git rev-parse --short HEAD")).trim();
    return { stranded: true, branch: wtBranch, commit, ahead: wtAhead };
  } catch {
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
 *  unstaged TRACKED changes on a path the branch touches, asked cheaply before the ~8-17min gate. Never widen
 *  to "any unstaged status on the path set" (false-refuses already-landed/deleted/gitlink paths); fails safe
 *  on error. */
export async function detectCanonicalDirtyOverlap(
  repoPath: string,
  branch: string,
  deps: BoundedGitDeps = {},
): Promise<CanonicalDirtyOverlap> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
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

    const mergeBase = (await withTimeout(git.raw(["merge-base", "HEAD", branch]), timeoutMs, "git merge-base (canonical, dirty-overlap preflight)")).trim();
    const changed = await changedPathsBetween(git, mergeBase, branch, timeoutMs);
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
    const stillDiffersFromHead = new Set(await changedPathsBetween(git, "HEAD", branch, timeoutMs));
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
 *  git 2.47) — never apply the tracked case's identical-content narrowing here; use an existence check
 *  against the branch tip instead. */
export async function detectCanonicalUntrackedOverlap(
  repoPath: string,
  branch: string,
  deps: BoundedGitDeps = {},
): Promise<CanonicalUntrackedOverlap> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
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

    const mergeBase = (await withTimeout(git.raw(["merge-base", "HEAD", branch]), timeoutMs, "git merge-base (canonical, untracked-overlap preflight)")).trim();
    const changed = await changedPathsBetween(git, mergeBase, branch, timeoutMs);
    const candidates = changed.filter((p) => untracked.has(p));
    if (candidates.length === 0) return { overlap: false };

    // Narrowing: drop any candidate the branch's tip no longer carries — see this function's own doc for
    // the direct repro proving the squash writes nothing there (a genuine no-op, never a refusal).
    const overlapping: string[] = [];
    for (const p of candidates) {
      try {
        await withTimeout(
          git.raw(["cat-file", "-e", `${branch}:${p}`]), timeoutMs, "git cat-file -e branch:path (canonical, untracked-overlap existence check)",
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
 *  merge sha every confirm once main advances, permanently defeating the breaker) — walks first-parent,
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
  /** sha256 over the {@link filteredWorkLines}-filtered `git status --porcelain` lines + a `git diff HEAD`
   *  scoped to those SAME survivor paths, when `dirty` — content-level for TRACKED changes (staged or
   *  unstaged). `null` when clean or unreadable. Card dc281db8: BOTH inputs are filtered through the same
   *  daemon-noise exclusion `dirty` itself uses (`uncommittedWorkFiles`) — an EARLIER version hashed the
   *  raw, unfiltered porcelain + full `diff HEAD`, so pure `.claude/` noise on an already-dirty tree could
   *  flip this hash even though `dirty` correctly stayed governed by the filtered view; that mismatch is
   *  what this comment now documents as fixed. KNOWN GAP: editing the CONTENT of an already-untracked new
   *  file IN PLACE (no `git add`, no commit) changes neither input, so that exact edit is invisible to this
   *  hash — accepted here because the reported incidents (card 50c1e0d0) were edits to an EXISTING tracked
   *  file, not a brand-new untracked one.
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
    const porcelain = await withTimeout(git.raw(["status", "--porcelain"]), timeoutMs, "gate-stamp status --porcelain");
    const workLines = filteredWorkLines(porcelain);
    if (workLines.length === 0) return { head, dirty: false, dirtyHash: null };
    // Card dc281db8: hash the FILTERED lines/paths — the same daemon-noise exclusion `dirty` uses — not the
    // raw porcelain, and scope the diff to those same survivor paths, so noise-only churn (e.g. a re-copied
    // `.claude/skills/` file) that `uncommittedWorkFiles` correctly ignores can never flip this hash either.
    const files = workLines.map(porcelainLinePath);
    // Best-effort: a `diff HEAD` failure still yields a (slightly weaker, porcelain-only) comparable hash
    // rather than aborting the whole stamp — the outer try/catch is reserved for a genuinely unreadable
    // worktree (rev-parse/status themselves failing).
    const diff = await withTimeout(git.raw(["diff", "HEAD", "--", ...files]), timeoutMs, "gate-stamp diff HEAD").catch(() => "");
    const dirtyHash = createHash("sha256").update(workLines.join("\n")).update(diff).digest("hex");
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
}

/** @decision 91d847db — a bare leading `*` with no `/` anywhere (e.g. `*service.ts`) is auto-prefixed with
 *  `**​/` before translation — as written `*` stays within one path segment and would silently match 0
 *  files for a nested path, indistinguishable from "no changes"; never widen this to a pattern already
 *  containing `/` or `**`. */
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
 * Best-effort `git diff --name-status <range>` → `Map<path, status>`, used ONLY by `diffBranch`'s
 * `includeStatus` opt (card d5d3bdc9). Deliberately narrow and fail-safe: `reviewWorkerMerge` must
 * NEVER throw on a weird diff, so any parse miss silently drops that line's status rather than guessing.
 *
 * - A rename/copy line (`R100\told\tnew` / `C100\told\tnew`) carries TWO paths on one row — attributing
 *   status to either would be a guess (is the new path "added"? is the old path "deleted"?), so these
 *   lines are skipped entirely; both paths end up with no status, same as an untracked file.
 * - A path containing a tab, or any row that doesn't parse as `<letter><digits?>\t<path>`, is skipped.
 * - Any git failure (missing range, non-repo, etc.) OR a `timeoutMs` timeout (a hung `git diff` child)
 *   returns an empty map — the caller degrades to "no status available", not an error or a hang.
 */
async function diffNameStatus(git: Pick<SimpleGit, "raw">, range: string, timeoutMs: number): Promise<Map<string, DiffstatFile["status"]>> {
  const map = new Map<string, DiffstatFile["status"]>();
  const SINGLE_PATH_STATUS = new Set(["A", "M", "D", "T", "U", "X", "B"]);
  try {
    const raw = await withTimeout(git.raw(["diff", "--name-status", range]), timeoutMs, "git diff --name-status (diffBranch)");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const tab = line.indexOf("\t");
      if (tab < 1) continue; // no tab, or an empty status column — can't parse
      const code = line.slice(0, tab);
      const letter = code[0];
      if (!letter || !SINGLE_PATH_STATUS.has(letter)) continue; // R/C (rename/copy) or unrecognized — skip
      const rest = line.slice(tab + 1);
      if (rest.includes("\t")) continue; // a second tab means more than one path on this row — skip
      const file = rest.trim();
      if (!file) continue;
      map.set(file, letter as DiffstatFile["status"]);
    }
  } catch {
    // fail-safe: a name-status failure never blocks or alters the diffstat/review — just no status.
  }
  return map;
}

export async function diffBranch(
  repoPath: string, branch: string, base = "HEAD",
  opts: { includePatch?: boolean; files?: string[]; pathGlob?: string; includeStatus?: boolean } = {},
  deps: DiffBranchDeps = {},
): Promise<{ filesChanged: number; insertions: number; deletions: number; files: DiffstatFile[]; allFiles: DiffstatFile[]; patch: string; hint?: string }> {
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
  const range = `${base}...${branch}`; // 3-dot: changes on `branch` since the merge-base with `base`
  const summary = await withTimeout(git.diffSummary([range]), timeoutMs, "git diff --stat (diffBranch summary)");
  const allFiles: DiffstatFile[] = summary.files.map((f) => ({
    file: f.file,
    insertions: "insertions" in f ? f.insertions : 0, // binary files carry before/after, not ins/del
    deletions: "deletions" in f ? f.deletions : 0,
    binary: f.binary,
  }));

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

  // OPTIONAL scope-down filter (files/pathGlob): narrows the diffstat + patch to matching file(s) so a
  // manager can pull one file's hunk at a time instead of the whole patch. ADDITIVE — with neither param
  // set, `filtering` is false and every field below is computed exactly as before (byte-identical).
  const needles = (opts.files ?? []).map((f) => f.replace(/\\/g, "/")).filter((f) => f.length > 0);
  const globRe = opts.pathGlob ? pathGlobToRegExp(opts.pathGlob) : undefined;
  const filtering = needles.length > 0 || globRe !== undefined;
  const files = filtering
    ? allFiles.filter((f) => needles.some((n) => f.file.includes(n)) || (globRe?.test(f.file) ?? false))
    : allFiles;

  const filesChanged = filtering ? files.length : summary.files.length;
  const insertions = filtering ? files.reduce((s, f) => s + f.insertions, 0) : summary.insertions;
  const deletions = filtering ? files.reduce((s, f) => s + f.deletions, 0) : summary.deletions;

  const patch = includePatch
    ? filtering
      ? (files.length > 0 ? await withTimeout(git.diff([range, "--", ...files.map((f) => f.file)]), timeoutMs, "git diff (diffBranch patch, filtered)") : "")
      : await withTimeout(git.diff([range]), timeoutMs, "git diff (diffBranch patch)")
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
  return { filesChanged, insertions, deletions, files, allFiles, patch, ...(hint ? { hint } : {}) };
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
 *  be the WHOLE line. Never drop `excludeAfter`'s `-premise\b` guard — this file's own `RETRACTED-PREMISE:`
 *  template would otherwise false-positive on itself. */
function lineStartMarker(phrase: string, excludeAfter?: string): RegExp {
  const guard = excludeAfter ? `(?!${excludeAfter})` : "";
  return new RegExp(`^${LEADING_DECORATION}${phrase}${guard}`, "imu");
}

/** @decision cf60a32a — deliberate markers a human writes to declare a card's premise dead, each as its OWN
 *  line, never merely mentioned in prose (a bare substring match had 2 confirmed false positives: `e7bcb0df`,
 *  `66d91a11`). Never add a bare "RETRACTION" noun marker — it fires at least as often on a checklist label
 *  whose verdict is the OPPOSITE of a retraction. */
const RETRACTION_MARKER_RES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "retracted", re: lineStartMarker("retracted", "-premise\\b") },
  { label: "premise retracted", re: lineStartMarker("premise\\s+(?:partly\\s+|fully\\s+)?retracted") },
  { label: "won't-do", re: lineAnchoredMarker("won'?t-do") },
  { label: "not a bug", re: lineAnchoredMarker("not a bug") },
];

/** @decision cf60a32a — retraction-vs-title merge-review warning: an un-retitled `fix(…)` whose body
 *  carries a standalone retraction marker stamps a fix for a bug that never existed into mainline history.
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
    return (await withTimeout(git.raw(["branch", "--list", branch]), timeoutMs, "git branch --list (workerDiff branchExists)")).trim() !== "";
  } catch {
    return false;
  }
}

/** @decision e076d2a2 — content-reachability check: does `sha`'s tree ACTUALLY contain `branch`'s own
 *  changes, not merely carry its trailer text (a squash+commit race can bear one branch's trailer while its
 *  content belongs to another)? FAILS CLOSED to `false` on any ambiguity — a false `true` here is the exact
 *  silent-data-loss bug this check exists to close. */
async function branchContentLandedInCommit(
  repoPath: string, branch: string, sha: string, mergeBase: string, deps: BoundedGitDeps,
): Promise<boolean> {
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    const changedFiles = (await withTimeout(
      git.raw(["diff", "--name-only", `${mergeBase}..${branch}`]), timeoutMs, "git diff --name-only (content check)",
    )).trim();
    if (!changedFiles) return true; // branch has no changes of its own relative to its fork point — vacuously landed
    const files = changedFiles.split("\n").filter(Boolean);
    const diffOutput = (await withTimeout(
      git.raw(["diff", "--name-only", sha, branch, "--", ...files]), timeoutMs, "git diff --name-only (content check, candidate vs branch)",
    )).trim();
    return diffOutput === ""; // no output ⇒ zero difference on any of the branch's own paths ⇒ content matches
  } catch {
    return false;
  }
}

/** The `Loom-Worker-PathSet:` trailer {@link mergeBranchLocked} stamps — see {@link changedPathSetDigest}. */
const LOOM_WORKER_PATHSET_TRAILER = /^Loom-Worker-PathSet:\s*(\S+)/m;

/** @decision d62dad73 — the `Loom-Worker-Base:` trailer stamps the LANDED base (`sha^`, or a batch's
 *  `batchHeadBefore`), never `merge-base(HEAD, branch)` — that's the branch's pre-landing fork point, which
 *  diverges once main has advanced past it (the rename-following case), degrading a genuinely landed commit to
 *  unverified. */
const LOOM_WORKER_BASE_TRAILER = /^Loom-Worker-Base:\s*(\S+)/m;

/** @decision 1d3f500e — returns the LAST regex match in `body`, never the first: the real trailer sits at the
 *  message's END, and a worker-authored body passed through verbatim could otherwise pre-empt it with a quoted
 *  example line at column 0 (e.g. a commit to batch-merge.ts itself). `re` needs the `m` flag + exactly one
 *  capture group. */
function lastTrailerMatch(body: string, re: RegExp): RegExpMatchArray | null {
  const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let last: RegExpMatchArray | null = null;
  for (const m of body.matchAll(globalRe)) last = m;
  return last;
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
 *  isInertMergeDiff} both build on (extracted after the two drifted into byte-identical flag copies). Never
 *  drop `--no-renames` — proven on git 2.47 it lets a renamed source file relocated into an allowlisted
 *  prefix misclassify as inert. */
async function changedPathsBetween(
  git: Pick<SimpleGit, "raw">, base: string, ref: string, timeoutMs?: number,
): Promise<string[]> {
  const args = [...NAME_ONLY_DIFF_FLAGS, `${base}..${ref}`];
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
 *  edit). Never compute from the branch's pre-landing diff (`mergeBase..branch`) — digest the LANDED range
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
 *  `assets/skills/**` is deliberately EXCLUDED (real tests read it as a comparison oracle); LOOM-ONLY, so
 *  {@link isInertMergeDiff} re-verifies PER-REPO via {@link repoTreeReferencesInertPrefix}. */
const INERT_MERGE_PATH_PREFIXES = ["docs/"];

/** @decision 82662e98 — root-level EXACT-match inert files (a `startsWith` prefix can't express a filename
 *  with no directory component), measured zero real test reads. `CLAUDE.md` is DELIBERATELY, PERMANENTLY
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
 *  this). FAILS CLOSED to `false` on every uncertain case: a git error, zero paths, an unrecognized path, or a
 *  per-repo re-scan that can't confirm absence. */
export async function isInertMergeDiff(
  repoPath: string, baseSha: string, ref: string, deps: BoundedGitDeps = {},
): Promise<boolean> {
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
 *  as a genuine project read. NOT a perfect discriminator: 3 named fail-OPEN pattern-coverage gaps
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
    const child = spawn("git", ["ls-tree", "-r", "--name-only", treeish], {
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
 *  via a direct `git grep` spawn (never simple-git's `.raw()`) so the real exit code is observable: ONLY a
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
    const child = spawn("git", ["grep", "-I", "-l", "-E", pattern, treeish, "--", ...JS_TS_SOURCE_EXTENSIONS.map((ext) => `*.${ext}`)], {
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

/** @decision 13965c93 — per-skill info for what a diff touched under skill assets, split into THREE
 *  distinct facts (store vs. a live session vs. an agent actually opening it) — never collapse them back
 *  into one warning line, that was the exact miscommunication this split fixed. Fails closed to `[]`. */
export interface ChangedSkillInfo {
  name: string;
  /** `true` iff this diff touched `<name>/SKILL.md` itself (the ambiently-read file). */
  skillMdChanged: boolean;
  /** `true` iff every touched path under `<name>/` sits under `references/` — i.e. `SKILL.md` was NOT
   *  touched, so nothing about this diff is ambient; an agent only sees it if it happens to open that
   *  specific reference file. */
  referencesOnly: boolean;
}

export async function changedSkillNames(
  repoPath: string, base: string, ref: string, deps: BoundedGitDeps = {},
): Promise<ChangedSkillInfo[]> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  let paths: string[];
  try {
    paths = await changedPathsBetween(git, base, ref, timeoutMs);
  } catch {
    return [];
  }
  const bySkill = new Map<string, string[]>();
  for (const p of paths) {
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
 *  regression test FOR `emitCompareSoundnessOk` (below) — the SOUNDNESS PRECONDITION this function's own
 *  doc comment above describes — and that precondition is re-checked LIVE, fail-closed, on every reduced-
 *  path call regardless of this guard. Its own correctness can therefore only be broken by editing
 *  `worktrees.ts`, which is itself a behavioural `.ts` edit. Investigated + confirmed at card a1734000; do
 *  not re-add it here without re-deriving the argument against the criterion above, and do not read its
 *  absence as an oversight.
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
  // of the WHOLE test/ corpus. PROVABLY BLIND to CLAUDE.md's own real-read indirection shape (an anchor on an
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
 *  ⚠️ THE BUILD-MIRROR INDIRECTION — name it, don't fall into it: `spawn-command-line-preflight.mjs` and
 *  `kickoff-real-spawn.mjs` read `.claude/skills/worker/SKILL.md`, which `scripts/sync-claude-skills.mjs`
 *  regenerates from `assets/skills/**` on every `pnpm build` — a THIRD route that looks like it should
 *  qualify (an asset edit DOES eventually reach `.claude/skills/**`) but doesn't, because that mirror is
 *  build-time, not diff-time: an assets-only diff with no rebuild in between leaves `.claude/skills/**` still
 *  showing the OLD content, so neither of those two tests is actually sensitive to the changed diff at
 *  classification time. NOT a hole today only because `skills-seed-asset-override-default.mjs` (already
 *  certified, reads the real asset directly) goes red on the same edit FIRST — a future test using
 *  `.claude/skills/**` as its ONLY oracle, with no certified direct-reader alongside it, WOULD be a genuine
 *  miss this criterion cannot see. Do not add either file here to "cover" that gap; the fix, if this ever
 *  stops being covered by a sibling, is a new criterion clause for the build-mirror route itself.
 *
 *  @decision 3fbd95e0 — DERIVED BY HAND, ONCE (DoD-3), never by a glob — same posture {@link
 *  STATIC_GUARD_REPO_PATHS} documents: a naive `grep -rl "assets/skills" packages/daemon/test/` both
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
  "packages/daemon/test/codescape-prompt-block.mjs",
  "packages/daemon/test/decision-records.mjs",
  "packages/daemon/test/dev-server.mjs",
  "packages/daemon/test/ensure-obsidian.mjs",
  "packages/daemon/test/manager-context-block.mjs",
  "packages/daemon/test/merge-orphaned-to-main.mjs",
  "packages/daemon/test/platform-dev-flag.mjs",
  "packages/daemon/test/platform-home.mjs",
  "packages/daemon/test/redirect-discoverability.mjs",
  "packages/daemon/test/serve-static.mjs",
  "packages/daemon/test/serve-static-parity-guard.mjs",
  "packages/daemon/test/skills-codescape-reconcile.mjs",
  "packages/daemon/test/skills-conditional.mjs",
  "packages/daemon/test/skills-seed-asset-override-default.mjs",
  "packages/daemon/test/skills-store-durability.mjs",
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
 *  them needs the harness wrapper's fresh env the way an arbitrary changed test file might (@decision dd4349ff).
 *
 *  WHY THIS LIST EXISTS: `computeEmitCompareGate` proves a changed `.ts` file's COMPILED BEHAVIOR unchanged
 *  by transpiling with `removeComments:true` forced (@decision 2154b6ad) and, when identical, skips the
 *  ~668-test runtime suite. That proof is sound for ordinary runtime behavior — but a HANDFUL of runtime
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
 *        breaks this exact regex. `loopback-secret.mjs` (D) is therefore a KNOWN, PRE-EXISTING fail-open
 *        vector for an inline-comment diff specifically (not a whitespace-only one) — tracked on a separate
 *        follow-up card, NOT fixed by this one; do not cite this entry as proof the check is immune.
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
 *        `const enum` declaration, but `emitCompareSoundnessOk` (this same file, called fail-closed inside
 *        `computeEmitCompareGate` whenever `changedTsFiles.length > 0`) runs the IDENTICAL walk+regex
 *        against the worktree's OWN current tree before ever returning `eligible:true`. A comment-only diff
 *        that introduced `const-enum`-shaped text anywhere under `src/**` would already flip THAT live
 *        check to `notReducible`, forcing the full gate — so this test's own correctness can only be broken
 *        by editing `worktrees.ts` itself, which is already excluded on the SAME "that's a behavioural `.ts`
 *        edit" ground {@link STATIC_GUARD_REPO_PATHS}'s own doc gives for this exact file, one list over.
 *        Its (B) positive-control section is separately immune under shape (4) (a presence-only check on a
 *        real declaration name). Added by card `fab07aba`.
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
  "packages/daemon/test/update-endpoint.mjs",
  "packages/daemon/test/shutdown-snapshot.mjs",
  "packages/daemon/test/periodic-snapshot.mjs",
  "packages/daemon/test/git-log-locale-pin.mjs",
  "packages/daemon/test/graceful-shutdown-epipe-resilience.mjs",
  "packages/daemon/test/project-memory.mjs",
  "packages/daemon/test/session-archive.mjs",
  // card fab07aba — real packages/daemon/src/**/*.ts readers, same trigger as the dist/** readers above.
  "packages/daemon/test/companion-lead-mode.mjs",
  "packages/daemon/test/decisions-for-tool.mjs",
  "packages/daemon/test/emit-compare-branch-capture-order-guard.mjs",
  "packages/daemon/test/gate-intent-no-firing-coupling.mjs",
  "packages/daemon/test/give-up-exhausted-durable.mjs",
  "packages/daemon/test/inert-skip-branch-capture-order-guard.mjs",
  "packages/daemon/test/log-message-content-gate.mjs",
  "packages/daemon/test/operator-surface.mjs",
  "packages/daemon/test/orchestration-mcp-role-guard.mjs",
  "packages/daemon/test/pty-codex-agnostic-methods.mjs",
  "packages/daemon/test/redelivery-parked-notice-suppression.mjs",
  "packages/daemon/test/redirect-discoverability.mjs",
  "packages/daemon/test/setup-project-init-rest.mjs",
  "packages/daemon/test/setup-templates-rest.mjs",
  "packages/daemon/test/shell-terminal.mjs",
  "packages/daemon/test/skill-edit.mjs",
];

/** @decision f862f9c5 — never fold this list into {@link CHANGED_TS_TEXT_SCANNER_REPO_PATHS} or its
 *  `changedTsPaths` trigger: this list's trigger is the SEPARATE `changedScriptFiles.length > 0` (a changed
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
   *  in a full suite pass it would have passed anyway — the guarantee this field now actually delivers. */
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
   *  `false` (card 4def0708). FIRST-TERMINAL-WINS over changed paths in git's emitted order, never "any
   *  out-of-scope path wins". */
  notApplicable: boolean;
  /** Card fd0d34da: set IFF `notApplicable:true` — see {@link EmitCompareNotApplicableKind}'s own doc for
   *  the full per-value discipline. `undefined` whenever `notApplicable` is `false` (both on `eligible:true`
   *  and on a `notReducible` `eligible:false`) — never a fabricated category for a real, informative
   *  reducibility verdict. */
  notApplicableKind?: EmitCompareNotApplicableKind;
}

/** @decision 2154b6ad — skips the ~668-test RUNTIME SUITE only (never the whole gate): proven via isolated
 *  transpile-comparison per changed file — never a hand-rolled scanner (desyncs on template literals), never
 *  "comments-only" (a real comment can flip a static guard). Re-checks its soundness precondition LIVE; fails
 *  closed on every uncertain case.
 *  @decision 44968963 — ANY `fixtures/`/`census/` touch fails the WHOLE diff closed. Never build a textual
 *  fixture-consumer resolver to preserve reduced-gate speed here — it can only ever observe it hasn't missed
 *  a consumer, never prove it, and a wrong skip is a bad merge while a wrong full-run only costs minutes.
 *  @decision fe848bfc — takes `worktreePath` only, never a separate `repoPath` — the old two-path signature
 *  produced card d422e279's bug (a batch worktree's "HEAD" diffed against canonical's own checkout). Never
 *  justify reintroducing a second path with "a worktree shares its parent's object database" — that's false
 *  for refs (HEAD is per-worktree). */
export async function computeEmitCompareGate(
  worktreePath: string, baseSha: string, ref: string, deps: BoundedGitDeps = {},
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
  const { git, timeoutMs } = boundedGit(worktreePath, deps);

  let entries: string[];
  try {
    // `--no-renames` and `-c core.quotePath=false` carry the SAME load-bearing reasons {@link
    // changedPathsBetween}'s own doc gives (this call needs `--name-status`, which that shared helper
    // doesn't produce, so it's a separate invocation rather than a third copy of that helper's flag list) —
    // most concretely now that a changed path is tested against {@link isInertMergePath}'s `startsWith`
    // allowlist here too (card b97f643d): a renamed-into-`docs/` source file or an unquoted non-ASCII
    // `docs/` filename would otherwise misclassify exactly as `isInertMergeDiff` warns against.
    const raw = (await withTimeout(
      git.raw(["-c", "core.quotePath=false", "diff", "--name-status", "--no-renames", `${baseSha}..${ref}`]),
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
  for (const line of entries) {
    const tab = line.indexOf("\t");
    // Card 4def0708: an unparseable line is the same mechanism-failure shape as the git error above — omit.
    if (tab < 0) return notApplicableHere(`unparseable diff line: ${line}`, "unparseable-diff");
    const status = line[0];
    const p = line.slice(tab + 1);
    // @decision b97f643d — skip a path already certified inert by isInertMergePath, REUSING that exact
    // predicate — never hand-copy a second one. Does NOT by itself guarantee an all-inert diff never reaches
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
      // list, and never re-check loom:not-a-test:/loom:gate-exempt: markers here (banner-only annotations,
      // carry no information for this decision).
      // @decision 44968963 — any such path then fails the WHOLE diff closed; never treat the forced full gate
      // on a fixture-plus-unrelated-test-file diff as a regression to fix — it's the accepted cost of closing
      // a real, measured cross-consumer exposure (this repo's own fixtures have 6 and 3 consumers
      // respectively).
      const relToTestDir = p.slice(EMIT_COMPARE_TEST_PREFIX.length);
      const dirSegments = relToTestDir.split("/").slice(0, -1);
      if (dirSegments.length > 0) {
        if (excludedDirNames === undefined) excludedDirNames = await loadExcludedTestDirNames(worktreePath);
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
      if (!/^[A-Za-z0-9_.\-/]+$/.test(p)) return notReducible(`test file path contains a character outside the shell-safe allowlist: ${p}`);
      if (status === "A" || status === "M") {
        // Card 17cd1f30: classify against the harness's own NOT_HERMETIC set BEFORE pushing into
        // changedTestFiles — a NOT_HERMETIC file is a real, maintained test (not a fixture/helper, both of
        // which already returned above), it just can't run through `test:daemon --only=` (needs a
        // manually-started daemon, a real `claude`, or mutates shared build output). Same bare-name shape
        // buildReducedGateCommand's own `--only=` list construction uses (repo-relative path minus the
        // test/ prefix and .mjs suffix), so a top-level file's name here is exactly what `NOT_HERMETIC`
        // keys on; a nested file's name (containing a `/`) can never match a NOT_HERMETIC entry, which is
        // correct — NOT_HERMETIC only ever names test/'s top-level files.
        if (notHermeticNames === undefined) notHermeticNames = await loadNotHermeticNames(worktreePath);
        if (notHermeticNames === null) return notApplicableHere(`could not load NOT_HERMETIC from this diff's own scripts/test-daemon.mjs to classify ${p}`, "harness-config-unavailable");
        const harnessName = p.slice(EMIT_COMPARE_TEST_PREFIX.length, -".mjs".length);
        if (notHermeticNames.has(harnessName)) {
          notHermeticExcluded.push(p);
        } else {
          changedTestFiles.push(p);
        }
      }
      // status "D" (deleted): nothing left to run directly; the guards below still cover its blast radius.
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
      const lsTreeOut = (await withTimeout(
        git.raw(["ls-tree", "-d", "--name-only", ref, "--",
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

  if (changedTsFiles.length > 0) {
    // TS-ONLY precondition (emitDecoratorMetadata / const enum) — N/A to changedScriptFiles below, which
    // is why this check is gated on changedTsFiles specifically rather than the combined condition on the
    // shared `typescript` import just below. See EMIT_COMPARE_SCRIPTS_PREFIX's own doc for why: a plain
    // `.mjs` script is never compiled by THIS repo's tsconfig chain at all (it's not part of the `dist/`
    // build `emitCompareSoundnessOk` reasons about), so neither mechanism can apply to it.
    if (!(await emitCompareSoundnessOk(worktreePath))) {
      return notReducible("soundness precondition (emitDecoratorMetadata / const enum) not verified");
    }
  }
  if (changedTsFiles.length > 0 || changedScriptFiles.length > 0) {
    let tsModule: TypeScriptModule;
    try {
      const imported = (await import("typescript")) as unknown as { default?: TypeScriptModule } & TypeScriptModule;
      tsModule = imported.default ?? imported;
    } catch {
      return notApplicableHere("typescript module not resolvable (expected on a shipped end-user install)", "typescript-unresolvable");
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
      const outBefore = transpileIgnoringCommentsAndWhitespace(before, p, tsModule, tsModule.ScriptTarget.ES2022).outputText;
      const outAfter = transpileIgnoringCommentsAndWhitespace(after, p, tsModule, tsModule.ScriptTarget.ES2022).outputText;
      if (outBefore !== outAfter) return notReducible(`${p} is not transpile-identical — a real code change`);
    }
    // Card 82662e98: `.mjs` scripts, at `ESNext` (NOT ES2022, unlike the .ts loop above — see
    // EMIT_COMPARE_SCRIPTS_PREFIX's own doc). `ESNext` is the only target that structurally cannot
    // downlevel any syntax the compiler recognizes at all (there is no ceiling below "newest known"), so
    // this comparison is a faithful comment/whitespace-stripped REPRINT of what Node actually executes —
    // never a lossy transform that could map two genuinely different scripts onto the same output. Spiked
    // directly (2026-09-04): at `target: ES2022` (the .ts loop's choice), a `using` declaration explodes
    // into ~30 lines of disposal-helper machinery that has nothing to do with what an untranspiled `.mjs`
    // actually runs; at `ESNext` the same input reprints unchanged.
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
      const outBefore = transpileIgnoringCommentsAndWhitespace(before, p, tsModule, tsModule.ScriptTarget.ESNext).outputText;
      const outAfter = transpileIgnoringCommentsAndWhitespace(after, p, tsModule, tsModule.ScriptTarget.ESNext).outputText;
      if (outBefore !== outAfter) return notReducible(`${p} is not transpile-identical — a real code change`);
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

/** @decision 815b4b30 — loads the REAL `EXCLUDED_DIR_NAMES` Set, dynamically imported from the diff's OWN
 *  `worktreePath` checkout (never this daemon's own installed copy, and never a hand-copied list). Fails closed
 *  to `null` on any error — never resolve ambiguity to an empty-but-truthy Set; a caller getting `null` MUST
 *  fail the whole diff closed. */
async function loadExcludedTestDirNames(worktreePath: string): Promise<Set<string> | null> {
  try {
    const scriptPath = path.join(worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs");
    // Windows: dynamic import() needs a file:// URL, never a bare drive-letter path
    // (ERR_UNSUPPORTED_ESM_URL_SCHEME) — same caveat test/census/lib.mjs's own import already documents.
    const mod = (await import(pathToFileURL(scriptPath).href)) as { EXCLUDED_DIR_NAMES?: unknown };
    return mod.EXCLUDED_DIR_NAMES instanceof Set ? (mod.EXCLUDED_DIR_NAMES as Set<string>) : null;
  } catch {
    return null;
  }
}

/**
 * Card 17cd1f30 — the same reuse shape as {@link loadExcludedTestDirNames} immediately above, applied to
 * the harness's OTHER driftable name set: `NOT_HERMETIC` (scripts/test-daemon.mjs). Loaded from THIS
 * diff's OWN worktree copy of the script, dynamically imported (never a hand-copied second list — the
 * precise pattern card 815b4b30 established and forbids re-diverging from), so a future edit to that set
 * is seen immediately by the reduced gate, not after a daemon restart. Same fail-closed contract: `null`
 * on any load/parse error or a non-`Set` export — a caller that gets `null` MUST fail the whole diff
 * closed, same as the `EXCLUDED_DIR_NAMES` case.
 */
async function loadNotHermeticNames(worktreePath: string): Promise<Set<string> | null> {
  try {
    const scriptPath = path.join(worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs");
    const mod = (await import(pathToFileURL(scriptPath).href)) as { NOT_HERMETIC?: unknown };
    return mod.NOT_HERMETIC instanceof Set ? (mod.NOT_HERMETIC as Set<string>) : null;
  } catch {
    return null;
  }
}

/** Narrow structural type for the `typescript` package's default export — only the surface this file
 *  actually uses, so this stays correct without depending on `typescript`'s own (large) public types. */
interface TypeScriptModule {
  transpileModule(input: string, opts: unknown): { outputText: string };
  ScriptTarget: Record<string, unknown>;
  ModuleKind: Record<string, unknown>;
}

/** Single-file, syntax-only transpile with `removeComments:true` forced — see {@link computeEmitCompareGate}'s
 *  own doc for why this (not a hand-rolled scanner, not the real `dist/` build) is the right tool.
 *  `target` is caller-supplied (card 82662e98) rather than hardcoded — the `.ts` call site passes
 *  `ES2022` to match `tsconfig.base.json`'s real target, so the emitted SYNTAX shape (e.g. downleveling)
 *  is representative of what `dist/` actually ships; the `.mjs`-script call site passes `ESNext` instead,
 *  because a script is never compiled at all — see {@link EMIT_COMPARE_SCRIPTS_PREFIX}'s own doc for why
 *  `ES2022` would be UNSOUND there (it can downlevel syntax the original file never runs through).
 *  `module` stays fixed at `NodeNext` for both — every other option is irrelevant here since
 *  `transpileModule` never type-checks. */
function transpileIgnoringCommentsAndWhitespace(text: string, fileName: string, tsModule: TypeScriptModule, target: unknown): { outputText: string } {
  return tsModule.transpileModule(text, {
    compilerOptions: {
      target,
      module: tsModule.ModuleKind.NodeNext,
      removeComments: true,
      sourceMap: false,
      declaration: false,
    },
    fileName,
  });
}

/** @decision 2154b6ad — live re-check of the soundness precondition (emitDecoratorMetadata / const enum),
 *  reading BOTH files in the daemon's real tsconfig `extends` chain — never check only the base config, that
 *  would miss a daemon-specific compiler option added to the package's own tsconfig.json. Fails closed to
 *  `false` on any read/parse error. */
async function emitCompareSoundnessOk(worktreePath: string): Promise<boolean> {
  for (const tsconfigRelPath of ["tsconfig.base.json", path.join("packages", "daemon", "tsconfig.json")]) {
    try {
      const raw = fs.readFileSync(path.join(worktreePath, tsconfigRelPath), "utf8");
      const opts = (JSON.parse(raw) as { compilerOptions?: Record<string, unknown> }).compilerOptions;
      if (opts?.emitDecoratorMetadata === true) return false;
    } catch {
      return false;
    }
  }
  const srcDir = path.join(worktreePath, "packages", "daemon", "src");
  // Requires the actual DECLARATION shape (`const enum <Identifier> {`), not just the two words adjacent —
  // deliberately tighter than a bare `\bconst\s+enum\b`. Two real false positives on the LOOSER pattern
  // were found by running this exact check against this exact repo before shipping it: (1) a variable
  // merely NAMED `const enumerate = ...` (pty/host.ts's own process-enumeration helper — kept as this
  // check's positive control below, the pattern must NOT match that line), and (2) THIS FILE'S OWN doc
  // comments ABOVE, which explain the `const enum` mechanism in prose ("`const enum` (its members are
  // INLINED..." etc.) — a bare word-adjacency regex tripped on its own documentation and would have made
  // this mechanism permanently fail-closed the moment it shipped, discovered only by actually running the
  // check rather than eyeballing the pattern. Requiring `<Identifier> {` immediately after excludes both:
  // prose describing the concept doesn't happen to place an identifier and an open brace right after the
  // words "const enum" (and if a future comment ever DID include a worked-example declaration in that
  // exact shape, the worst case is the same safe direction — an unnecessary fail-closed, never a missed
  // real one).
  const CONST_ENUM = /\bconst\s+enum\s+[A-Za-z_$][\w$]*\s*\{/;
  try {
    for (const file of walkTsFiles(srcDir)) {
      if (CONST_ENUM.test(fs.readFileSync(file, "utf8"))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** @decision dd4349ff — a changed test file runs THROUGH THE HARNESS (`test:daemon --only=`), never as
 *  bare `node <path>` — a bare invocation left a hermetic-env-needing file unable to even start (exit 99,
 *  0s, no assertion run). `changedTestFiles` must already exclude `NOT_HERMETIC` names; never re-filter here.
 *  @decision abaaf16e — `changedTsPaths` folds {@link CHANGED_TS_TEXT_SCANNER_REPO_PATHS} into `steps` instead
 *  (bare `node <path>`, the {@link STATIC_GUARD_REPO_PATHS} shape), never into `testPaths`/`--only=` — every
 *  member is independently verified to set up its own hermetic env, so it needs none of what the harness
 *  wrapper exists to provide. See that list's own doc for the full membership + trigger reasoning.
 *  Card abaaf16e (Code Review MINOR): the fields are a REQUIRED single object, not positional
 *  arguments with defaults — a default let a caller silently drop an argument (Code Review's own probe:
 *  mutating the two admission-reclassification/batch call sites to omit the 3rd argument tripped ZERO
 *  tests) and the SAME latent shape already existed on `changedAssetPaths` before this card, so both are
 *  fixed together rather than fixing only the newly-added one. `Pick<EmitCompareGateResult, …>` (not a
 *  hand-typed object shape) so the two can never drift out of sync — a field renamed on
 *  `EmitCompareGateResult` fails this call SITE, not silently.
 *  @decision f862f9c5 — `changedScriptFiles` folds {@link CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS} in on ITS
 *  OWN condition, independent of `changedTsPaths` — never gate it on the `.ts` trigger, or on the combined
 *  `identicalFileCount` (which counts both populations together for an unrelated diagnostic reason; see that
 *  field's own doc). A diff can set either trigger, both, or neither. */
export function buildReducedGateCommand(
  input: Pick<EmitCompareGateResult, "changedTestFiles" | "changedAssetPaths" | "changedTsPaths" | "changedScriptFiles">,
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
    steps.push(`pnpm --filter @loom/daemon test:daemon --only=${names.join(",")}`);
  }
  return steps.join(" && ");
}

/** @decision 756a2cd8 — verifies a squash commit's persisted path-set trailer purely from its OWN ancestry
 *  (survives branch deletion + `git gc`). A `true` proves only the SAME FILE SET, never the same CONTENT —
 *  never read it as content-verified; two branches sharing an identical path set are NOT distinguishable by
 *  this check alone. */
async function verifyPersistedPathSet(
  git: Pick<SimpleGit, "raw">, timeoutMs: number, sha: string, expectedDigest: string, baseOverride?: string,
): Promise<boolean> {
  try {
    const parent = baseOverride ?? (await withTimeout(
      git.raw(["rev-parse", `${sha}^`]), timeoutMs, "git rev-parse (path-set verify parent)",
    )).trim();
    const actual = await changedPathSetDigest(git, parent, sha, timeoutMs);
    return actual === expectedDigest;
  } catch {
    return false;
  }
}

/** @decision 6ee48e4d — locates the squash-merge commit via the deterministic `Loom-Worker-Branch:` trailer.
 *  RE-TASK GUARD confirms the trailer commit is NOT an ancestor of the branch tip when the branch still exists
 *  (a re-cut DESCENDS from it; a genuine orphan diverges) — never `--is-ancestor` (misreads); use merge-base
 *  equality. FAILS SAFE to `null`. */
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
    const out = await withTimeout(
      git.raw(["log", base, "-F", `--grep=Loom-Worker-Branch: ${branch}`, "--format=%H%x1f%B", "--max-count=1"]),
      timeoutMs, "git log --grep trailer",
    );
    const sepIdx = out.indexOf("\x1f");
    const sha = (sepIdx === -1 ? out : out.slice(0, sepIdx)).trim();
    if (!sha) return null;
    const body = sepIdx === -1 ? "" : out.slice(sepIdx + 1);
    const branchPresent = (await withTimeout(
      git.raw(["branch", "--list", branch]), timeoutMs, "git branch --list",
    )).trim() !== "";
    if (branchPresent) {
      // Re-task guard: if the trailer commit is an ANCESTOR of the branch tip, the branch was re-cut onto
      // it (a re-spawned task carrying NEW live work) — NOT an orphaned squash-merge of the current branch.
      const mergeBase = (await withTimeout(
        git.raw(["merge-base", sha, branch]), timeoutMs, "git merge-base",
      )).trim();
      if (mergeBase === sha) return null;
      // Content-reachability: a trailer match is not proof (see branchContentLandedInCommit's doc).
      if (!(await branchContentLandedInCommit(repoPath, branch, sha, mergeBase, deps))) return null;
    } else {
      // Branch gone (card f621f185): verify against the persisted path-set trailer if this commit has one.
      const pathSetMatch = lastTrailerMatch(body, LOOM_WORKER_PATHSET_TRAILER);
      if (pathSetMatch) {
        // Phase 2 (card d62dad73) + card 756a2cd8: prefer the commit's own Loom-Worker-Base trailer as the
        // verification base when present (every solo squash and batched landing now stamps one); undefined
        // here falls back to sha^ for a commit that predates either fix, or whose best-effort trailer
        // capture failed — see verifyPersistedPathSet's doc.
        const baseMatch = lastTrailerMatch(body, LOOM_WORKER_BASE_TRAILER);
        if (!(await verifyPersistedPathSet(git, timeoutMs, sha, pathSetMatch[1]!, baseMatch?.[1]))) return null;
      } else if (onPreFixTrailerNotice) {
        onPreFixTrailerNotice(branch, sha);
      } else {
        // eslint-disable-next-line no-console
        console.info(`[git] findLandedSquashCommit: ${branch} is gone and its landed commit ${sha.slice(0, 7)} ` +
          "carries no Loom-Worker-PathSet trailer — trusting Loom-Worker-Branch presence alone (card f621f185)");
      }
    }
    return sha;
  } catch {
    return null; // fail safe: unknown signal → NOT landed → caller KEEPS the worktree
  }
}

/** @decision c6a6f405 — the orchestration-view diff for a worker, robust across its WHOLE lifecycle (live
 *  worktree / committed branch / merged+deleted branch) — fixes the "/orchestration diffs are all empty" bug.
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
      const base = (await withTimeout(git.raw(["merge-base", "HEAD", branch]), timeoutMs, "git merge-base (workerDiff uncommitted)")).trim();
      const { git: wt } = boundedDiffGit(worktreePath, deps);
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
// walks the tree; the TTL fast path only bounds how OFTEN the walk runs. Measured ~2x, not an
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

/** The canonical repo's current HEAD sha, resolved via fs only (handles both symbolic and detached HEAD). */
async function readHeadSha(repoPath: string): Promise<string | null> {
  try {
    const gitDir = path.join(repoPath, ".git");
    const head = (await fs.promises.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    if (head.startsWith("ref:")) return readRefSha(gitDir, head.slice(4).trim());
    return head || null; // detached HEAD: a raw sha
  } catch {
    return null;
  }
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
  const branchSha = await readRefSha(path.join(repoPath, ".git"), `refs/heads/${branch}`);
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
const LOOM_WORKER_BRANCH_TRAILER = /^Loom-Worker-Branch:\s*(\S+)/m;

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
}

/**
 * {@link scanMergedCommitMap}'s result, PLUS whether the scan was truncated by {@link
 * MERGED_LOOKUP_SCAN_LIMIT} — card 6ee48e4d. `truncated: false` means the scan saw FEWER commits than
 * the limit, i.e. it read `base`'s ENTIRE history: a `map` miss is then AUTHORITATIVE (the branch has no
 * `Loom-Worker-Branch` trailer anywhere reachable from `base`), not merely "not found in this window".
 * `truncated: true` covers both a genuine limit-hit AND any scan failure/timeout (the existing fail-safe
 * empty map) — a caller that wants to treat a miss as authoritative must check this flag first; treating
 * every miss as authoritative without it would silently narrow full-history detection.
 */
export interface MergedCommitScan {
  map: Map<string, MergedMapEntry>;
  truncated: boolean;
}

/** @decision 6ee48e4d — one bounded `git log` pass building a `branch -> {sha, date, pathSetDigest, baseSha}`
 *  map, plus whether the scan was TRUNCATED — count EVERY record seen, never only trailer-matching ones, or a
 *  truncated scan can falsely report "complete". FAILS SAFE to an empty map with `truncated:true`. */
async function scanMergedCommitMap(
  repoPath: string, base = "HEAD", deps: BoundedGitDeps = {},
): Promise<MergedCommitScan> {
  const map = new Map<string, MergedMapEntry>();
  let recordCount = 0;
  try {
    // boundedGit's simpleGit(repoPath, ...) constructor throws SYNCHRONOUSLY for a nonexistent baseDir
    // (GitConstructError) — this must be INSIDE the try, not before it, or a vault-only/moved-repo
    // project's repoPath breaks the fail-safe contract instead of resolving to an empty map.
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    const format = `%H${MERGED_MAP_FIELD_SEP}%aI${MERGED_MAP_FIELD_SEP}%B${MERGED_MAP_RECORD_SEP}`;
    const out = await withTimeout(
      git.raw(["log", base, `--format=${format}`, "-n", String(MERGED_LOOKUP_SCAN_LIMIT)]),
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
      const trailer = lastTrailerMatch(body, LOOM_WORKER_BRANCH_TRAILER);
      if (!sha || !trailer) continue;
      const branch = trailer[1]!;
      const pathSetTrailer = lastTrailerMatch(body, LOOM_WORKER_PATHSET_TRAILER);
      const baseTrailer = lastTrailerMatch(body, LOOM_WORKER_BASE_TRAILER);
      if (!map.has(branch)) {
        map.set(branch, { // first hit = most recent (reverse-chron)
          sha, date,
          pathSetDigest: pathSetTrailer ? pathSetTrailer[1]! : null,
          baseSha: baseTrailer ? baseTrailer[1]! : null,
        });
      }
    }
  } catch {
    return { map, truncated: true }; // fail safe: empty map + inconclusive -> every lookup misses AND must fall back
  }
  // @decision 6ee48e4d — log the no-PathSet-trailer count ONCE PER SCAN, never per lookup —
  // getTaskMergedInfo runs per task on every polled board read, so per-lookup logging would flood the daemon
  // log.
  let noPathSetTrailerCount = 0;
  for (const entry of map.values()) if (entry.pathSetDigest === null) noPathSetTrailerCount++;
  if (noPathSetTrailerCount > 0) {
    // eslint-disable-next-line no-console
    console.info(`[git] scanMergedCommitMap: ${noPathSetTrailerCount} landed branch(es) in ${repoPath} carry no ` +
      "Loom-Worker-PathSet trailer (pre-f621f185 legacy history, or a best-effort Base/PathSet stamp that " +
      "failed to land — logged at the stamp site when it happens) — trusting Loom-Worker-Branch presence " +
      "alone for those once their branch is gone, until re-merged");
  }
  return { map, truncated: recordCount >= MERGED_LOOKUP_SCAN_LIMIT };
}

/** Keyed per REPO (not per branch/task like {@link diffCache}), so its entry count is bounded by the
 *  number of distinct repos Loom touches, never by board/task size. */
const MERGED_MAP_CACHE_MAX_ENTRIES = 100;

interface MergedMapCacheEntry {
  headSha: string;
  map: Map<string, MergedMapEntry>;
  truncated: boolean;
}

const mergedMapCache = new Map<string, MergedMapCacheEntry>();

/**
 * In-flight scan promises, keyed by repoPath — CR follow-up (card 9983eed6): a cold cache invalidates on
 * EVERY HEAD move, i.e. every merge, which is exactly when a manager/companion board read fans out across
 * many tasks (`listProjectTasks`'s `Promise.all` over a project's tasks, or `list_all_tasks` over many
 * projects, or a companion + a manager reading concurrently). Without this map, ALL of those callers would
 * pass the `mergedMapCache` miss check before any of them finishes scanning (`readHeadSha`'s fs read
 * resolves far faster than the `git log -n 5000` subprocess), each spawning its OWN full scan — N
 * concurrent git-log-5000 processes on one repo instead of one. Registering the promise HERE,
 * SYNCHRONOUSLY, before any await (see {@link getOrStartMergedMapScan}), closes that race: every caller
 * that arrives while a scan is in flight joins the SAME promise instead of starting a new one.
 */
const mergedMapInFlight = new Map<string, Promise<MergedMapCacheEntry>>();

/**
 * Synchronous check-and-register: returns the ALREADY in-flight promise for `repoPath` if one exists,
 * else starts exactly one and registers it before returning — so two calls issued back-to-back (as
 * `Array.prototype.map`/`Promise.all` do) can never both see "no scan in flight" and each start their own.
 * Not `async` itself — the async work lives in the IIFE, whose synchronous prefix (up to its first
 * `await`) still runs before this function returns, but the `mergedMapInFlight.set` below happens with NO
 * await in between the `.get` check and the `.set`, which is what makes the dedup race-free.
 */
function getOrStartMergedMapScan(repoPath: string, deps: BoundedGitDeps): Promise<MergedMapCacheEntry> {
  const existing = mergedMapInFlight.get(repoPath);
  if (existing) return existing;
  const scan = (async (): Promise<MergedMapCacheEntry> => {
    try {
      const headSha = (await readHeadSha(repoPath)) ?? "-";
      const cached = mergedMapCache.get(repoPath);
      if (cached && cached.headSha === headSha) {
        mergedMapCache.delete(repoPath);
        mergedMapCache.set(repoPath, cached); // move to the Map's end (most-recently-used)
        return cached;
      }
      const { map, truncated } = await scanMergedCommitMap(repoPath, "HEAD", deps);
      const entry: MergedMapCacheEntry = { headSha, map, truncated };
      mergedMapCache.delete(repoPath);
      mergedMapCache.set(repoPath, entry);
      while (mergedMapCache.size > MERGED_MAP_CACHE_MAX_ENTRIES) {
        const oldest = mergedMapCache.keys().next().value;
        if (oldest === undefined) break;
        mergedMapCache.delete(oldest);
      }
      return entry;
    } finally {
      // Always clear, even on an (unexpected — scanMergedCommitMap itself never throws) failure, so a
      // one-off error can't permanently wedge every future read of this repo behind a dead in-flight slot.
      mergedMapInFlight.delete(repoPath);
    }
  })();
  mergedMapInFlight.set(repoPath, scan);
  return scan;
}

/**
 * Cached wrapper around {@link scanMergedCommitMap}: reuses the map (and its `truncated` flag — see
 * {@link MergedCommitScan}) across repeat reads of the same repo state, keyed on the canonical repo's
 * current HEAD sha (fs-only, no subprocess — the SAME freshness-key idiom as {@link getWorkerDiffCached}'s
 * `diffCache`). A merge landing on main advances HEAD, which invalidates the cache on the VERY NEXT read
 * — a just-merged task resolves as soon as HEAD moves, never stale. Concurrent callers on a cold/stale
 * entry are deduped onto ONE scan by {@link getOrStartMergedMapScan} — see its comment for why that dedup
 * has to be synchronous.
 */
export async function getMergedCommitMapCached(
  repoPath: string, deps: BoundedGitDeps = {},
): Promise<MergedCommitScan> {
  const entry = await getOrStartMergedMapScan(repoPath, deps);
  return { map: entry.map, truncated: entry.truncated };
}

/** {@link resolveMergedCommitMapHit}'s resolved answer: the verified sha PLUS which mode verified it —
 *  see {@link MergedVerificationMode}. */
interface ResolvedMergedHit {
  sha: string;
  verification: MergedVerificationMode;
}

/**
 * Shared verification body for a {@link scanMergedCommitMap} entry, factored out of {@link
 * getTaskMergedInfo} so {@link findLandedSquashCommitViaMap} (boot-reconcile Pass A's batch path, card
 * 6ee48e4d) can apply the IDENTICAL re-task-ancestry-guard + content/path-set check a map hit needs,
 * rather than a second hand-copied verification with its own chance to drift from this one. Same
 * fail-safe contract as every verification in this file: any error, or the checks genuinely disagreeing,
 * returns null (NOT landed) — never resolve ambiguity to `hit.sha`.
 */
async function resolveMergedCommitMapHit(
  repoPath: string, branch: string, hit: MergedMapEntry, deps: BoundedGitDeps,
): Promise<ResolvedMergedHit | null> {
  try {
    // Bounded via the SAME git+timeoutMs as the merge-base call below (mirrors findLandedSquashCommit's
    // OWN `branch --list` check exactly) — NOT the shared (workerDiff-private) branchExists() helper,
    // which as of card c6a6f405 is also bounded but would construct its own separate bounded git client
    // for the same repo; reusing this one instance avoids that redundant construction.
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    const branchPresent = (await withTimeout(
      git.raw(["branch", "--list", branch]), timeoutMs, "git branch --list",
    )).trim() !== "";
    if (branchPresent) {
      const mergeBase = (await withTimeout(
        git.raw(["merge-base", hit.sha, branch]), timeoutMs, "git merge-base",
      )).trim();
      if (mergeBase === hit.sha) return null; // re-cut onto its own prior squash: live again, not landed
      if (!(await branchContentLandedInCommit(repoPath, branch, hit.sha, mergeBase, deps))) return null;
      return { sha: hit.sha, verification: "content" };
    } else if (hit.pathSetDigest) {
      // Branch gone (card f621f185): verify against the persisted path-set trailer. `hit.baseSha`
      // (card d62dad73 phase 2 + card 756a2cd8) prefers the commit's own Loom-Worker-Base trailer when
      // present (every batched and solo landing now stamps one); undefined/null falls back to sha^ for a
      // commit that predates either fix, exactly as before.
      if (!(await verifyPersistedPathSet(git, timeoutMs, hit.sha, hit.pathSetDigest, hit.baseSha ?? undefined))) return null;
      return { sha: hit.sha, verification: "pathset" };
    }
    // else: pre-fix history (no path-set trailer) — degrades to the trailer-presence-only answer.
    // Deliberately NOT logged here for either caller: scanMergedCommitMap already logs the pre-fix count
    // once per actual scan (cache-gated, rebuilt only on a HEAD move) — see its own comment.
    return { sha: hit.sha, verification: "trailer-only" };
  } catch {
    return null; // fail safe
  }
}

/** @decision 6ee48e4d — batch-primitive sibling of {@link findLandedSquashCommit}: looks `branch` up against
 *  the shared cached map instead of paying its own `--grep` walk. Never treat `{hit:false}` as authoritative
 *  without checking `scanComplete` first — a `false` (truncated/errored scan) MUST fall back to {@link
 *  findLandedSquashCommit} directly. */
export async function findLandedSquashCommitViaMap(
  repoPath: string, branch: string, deps: BoundedGitDeps = {},
): Promise<{ hit: true; sha: string | null } | { hit: false; scanComplete: boolean }> {
  const { map, truncated } = await getMergedCommitMapCached(repoPath, deps);
  const entry = map.get(branch);
  if (!entry) return { hit: false, scanComplete: !truncated };
  const resolved = await resolveMergedCommitMapHit(repoPath, branch, entry, deps);
  return { hit: true, sha: resolved?.sha ?? null };
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
    const result = await findLandedSquashCommitViaMap(repoPath, branch, deps);
    return {
      branch,
      taskTitle: taskMap.get(branch)?.taskTitle ?? null,
      merged: result.hit && result.sha !== null,
    };
  }));
}

/** @decision 52e978ad — is `taskId` merged? Keyed by the `Loom-Worker-Branch:` trailer, NEVER by title text
 *  — a title can be edited/coerced after merge, the trailer never drifts. `null` covers several causes (never
 *  merged, outside scan window, re-task in progress, git error) — NEVER read as authoritative "never
 *  merged". */
export async function getTaskMergedInfo(
  repoPath: string, taskId: string, deps: BoundedGitDeps = {},
): Promise<MergedCommitInfo | null> {
  const branch = `loom/${taskKey(taskId)}`;
  const { map } = await getMergedCommitMapCached(repoPath, deps);
  const hit = map.get(branch);
  if (!hit) return null;
  // Verification delegated to {@link resolveMergedCommitMapHit} (card 6ee48e4d factored this out of a
  // hand-inlined copy here so boot-reconcile Pass A's {@link findLandedSquashCommitViaMap} shares the
  // IDENTICAL re-task-guard + content/path-set check) — behaviour-identical to the version this replaces,
  // now ALSO reporting which of the two verification means (or the pre-fix degrade) answered it (card
  // 52e978ad) — see {@link MergedVerificationMode}.
  const resolved = await resolveMergedCommitMapHit(repoPath, branch, hit, deps);
  if (!resolved) return null;
  return { sha: resolved.sha.slice(0, 7), date: hit.date, verification: resolved.verification };
}

/** TEST-ONLY: clear the merged-commit map cache (settled + in-flight) between hermetic test cases reusing the same temp repos. */
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
    const raw = await withTimeout(git.raw(["log", "-1", "--format=%s", branch]), timeoutMs, "git log -1 --format=%s (taskless subject)");
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
    const raw = await withTimeout(
      git.raw(["log", "--no-merges", "--reverse", "--format=%s", `${mergeBase}..${branch}`]),
      timeoutMs, "git log (canonical, worker commit-log body)",
    );
    subjects = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return undefined; // best-effort: the squash still lands with a title-only body, exactly as before this card
  }
  if (subjects.length === 0) return undefined;
  if (subjects.length === 1 && subjects[0]!.toLowerCase() === subject.trim().toLowerCase()) return undefined;

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
  if (lines.length === 0) return undefined; // every entry was too long to fit even one — degrade to title-only
  if (omitted > 0) lines.push(`- …(${omitted} more commit${omitted === 1 ? "" : "s"})`);
  return `Worker commits:\n${lines.join("\n")}`;
}

/** @decision 591906ae — recovers a batched branch's non-tip commit subjects, which `ownTipSubject` alone
 *  misses (`merge_batch` lands every commit verbatim, never a squash) — never rely on `ownTipSubject` alone
 *  for a batched branch. Reuses the SAME truncation caps as {@link deriveWorkerCommitLogBody}, never a second
 *  pair. */
export async function deriveOwnNonTipCommitSubjects(
  repoPath: string, branch: string, base = "HEAD", deps: BoundedGitDeps = {},
): Promise<{ subjects: string[]; truncated: boolean } | undefined> {
  let all: string[];
  try {
    const { git, timeoutMs } = boundedGit(repoPath, deps);
    const mergeBase = (await withTimeout(
      git.raw(["merge-base", base, branch]), timeoutMs, "git merge-base (own non-tip commit subjects)",
    )).trim();
    const raw = await withTimeout(
      git.raw(["log", "--no-merges", "--reverse", "--format=%s", `${mergeBase}..${branch}`]),
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
 *  `"STAGE_EMPTY_RETRY"` via `emptyKind`. Never `reset --hard` on dirty tracked state at entry — refuse
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
/** Generic, non-personal identity used ONLY when the host has no git identity configured at all —
 *  same rationale + mechanism as vault/versioner.ts's own fallback (duplicated, not shared: each
 *  commit-creating path in this codebase decides its own identity policy — git/writer.ts deliberately
 *  commits with NO override, versioner.ts falls back for its unattended vault auto-committer). This
 *  merge ALSO runs unattended (the card-5150fdc2 stale-base auto-forward), so it needs the same
 *  fallback: a CI runner or a fresh end-user host may have no configured git identity, which would
 *  otherwise make `git merge --no-edit` (a real merge commit) fail on the commit step. */
const FALLBACK_GIT_IDENTITY = { name: "Loom", email: "loom@localhost" } as const;

/** Whether `git`'s cwd has BOTH `user.name` and `user.email` resolvable (any scope). Mirrors
 *  versioner.ts's `hasConfiguredGitIdentity` verbatim (narrowed to `raw` — the only method the
 *  `gitFactory` seam of {@link BoundedGitDeps} guarantees). */
async function hasConfiguredGitIdentity(git: Pick<SimpleGit, "raw">): Promise<boolean> {
  try {
    const name = (await git.raw(["config", "user.name"])).trim();
    const email = (await git.raw(["config", "user.email"])).trim();
    return !!name && !!email;
  } catch {
    return false;
  }
}

// Card eda70da6 (CR follow-up): `mainSha` is REQUIRED on every `ok:true` variant, by type, not just by
// convention — a future early-success return that forgot it would otherwise typecheck clean while silently
// making confirmWorkerMerge's `gateBaseMainHead` capture (and therefore mergeBranch's requireCanonicalHead
// re-check) vanish, fail-OPEN. The `ok:false` variant carries no such guarantee (nothing was unioned) and
// keeps its existing optional fields.
export async function mergeMainIntoWorktree(
  repoPath: string, worktreePath: string, deps: BoundedGitDeps = {},
): Promise<{ ok: true; merged: boolean; mainSha: string } | { ok: false; conflict?: boolean; reason?: string }> {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const makeGit = deps.gitFactory ?? ((p, ms) => boundedSimpleGit(p, ms));
  const repoGit = makeGit(repoPath, timeoutMs);
  const wtGit = makeGit(worktreePath, timeoutMs);

  let mainSha: string;
  try {
    mainSha = (await withTimeout(repoGit.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (main)")).trim();
  } catch (e) {
    return { ok: false, reason: `failed to resolve main tip: ${(e as Error).message}` };
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
  try {
    const mergeBase = (await withTimeout(wtGit.raw(["merge-base", "HEAD", mainSha]), timeoutMs, "git merge-base (worktree)")).trim();
    if (mergeBase === mainSha) return { ok: true, merged: false, mainSha };
  } catch { /* fall through to attempt the merge */ }

  // `git merge --no-edit` creates a real commit — on a host with no configured git identity (e.g. a CI
  // runner) that commit step fails even though the merge itself is clean. Scoped `-c` args (never
  // `.env()` — simple-git's `blockUnsafeOperationsPlugin` rejects an explicit `GIT_CONFIG_GLOBAL`/
  // `SYSTEM` override) fall back to a generic identity ONLY when none is resolvable; a host with its own
  // identity configured is unaffected.
  const identityArgs = (await hasConfiguredGitIdentity(wtGit))
    ? []
    : ["-c", `user.name=${FALLBACK_GIT_IDENTITY.name}`, "-c", `user.email=${FALLBACK_GIT_IDENTITY.email}`];

  let mergeThrew = false;
  try {
    await withTimeout(wtGit.raw([...identityArgs, "merge", "--no-edit", mainSha]), timeoutMs, "git merge main into worktree");
  } catch {
    mergeThrew = true; // a conflict OR a real failure — the explicit checks below decide which
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
      await withTimeout(wtGit.raw(["merge", "--abort"]), timeoutMs, "git merge --abort (worktree)");
    } catch (e) {
      return { ok: false, conflict: true, reason: `conflict cleanup (merge --abort) failed — worktree may have unmerged residue: ${(e as Error).message}` };
    }
    return { ok: false, conflict: true };
  }
  if (mergeThrew) {
    // Symmetric with the conflict cleanup above: `merge --abort` also resets the working tree, and
    // additionally clears a stale MERGE_HEAD if the errored merge happened to leave one (a plain
    // `reset --hard HEAD` would not) — `git merge --abort` is a no-op error when there's nothing to
    // abort, so its failure here is swallowed exactly like the conflict path's own best-effort intent.
    try { await withTimeout(wtGit.raw(["merge", "--abort"]), timeoutMs, "git merge --abort (worktree)"); } catch { /* best-effort cleanup */ }
    return { ok: false, reason: "git merge main into worktree failed" };
  }
  return { ok: true, merged: true, mainSha };
}

export async function mergeBranch(
  repoPath: string, branch: string, taskTitle?: string, deps: BoundedGitDeps = {}, requireCanonicalHead?: string,
  gateBaseBranchHead?: string, opId?: string,
): Promise<{ ok: boolean; conflict?: boolean; sha?: string; subject?: string; noop?: boolean; reason?: string; emptyKind?: MergeEmptyKind; gateBaseInvalidated?: boolean; dirtyOverlap?: boolean }> {
  // MUTEX (card e076d2a2, widened to GitWriter by e41dbb58): the whole residue-clear→squash→conflict-check
  // →commit sequence below reads and writes the CANONICAL repo's shared git index — serialize it per
  // canonical repo path so a concurrent merge for a DIFFERENT branch of the SAME repo, or a concurrent
  // GitWriter.commit/checkout/createBranch against the same repo, can never interleave with this one. See
  // the lock's own doc (git/repo-lock.ts) for the exact corruption this closes.
  return withCanonicalIndexLock(repoPath, () => mergeBranchLocked(repoPath, branch, taskTitle, deps, requireCanonicalHead, gateBaseBranchHead, opId));
}

// `opId` (board card 5a7692a4): purely for attribution on the in-memory danger-window tracker (see
// merge-danger-window.ts) — a caller with no op identity handy (a test, or any future caller) just gets an
// unattributed window entry (repo/branch only), never a functional difference in what this function does.
async function mergeBranchLocked(
  repoPath: string, branch: string, taskTitle?: string, deps: BoundedGitDeps = {}, requireCanonicalHead?: string,
  gateBaseBranchHead?: string, opId?: string,
): Promise<{ ok: boolean; conflict?: boolean; sha?: string; subject?: string; noop?: boolean; reason?: string; emptyKind?: MergeEmptyKind; gateBaseInvalidated?: boolean; dirtyOverlap?: boolean }> {
  // BOUNDED + NON-INTERACTIVE (board card 44c28799): this is the repo's highest-consequence git write
  // (see boundedMergeGit's own doc), so it gets the same block-timeout + withTimeout race as every other
  // bounded op in this file, plus nonInteractiveEnv() to match git/reader.ts + git/writer.ts. Before this
  // fix, `git = simpleGit(repoPath)` here had NEITHER — a hung git child (e.g. a wedged commit hook) never
  // settled, which (post-e076d2a2) wedged the per-repo merge mutex PERMANENTLY, not just this one op.
  const { git, timeoutMs } = boundedMergeGit(repoPath, deps);
  // @decision eda70da6 — re-verify HERE, first after the lock (zero side effects on mismatch,
  // gateBaseInvalidated:true) — never hold the lock across the gate run or re-run the gate once locked. The
  // preLanded path needs its OWN gateBaseBranchHead discriminator or routine main-movement turns an idempotent
  // re-confirm into a spurious refusal.
  // @decision 7efc2bff — the squash target is resolved to a frozen sha HERE, never the branch NAME —
  // `git merge --squash <name>` re-resolves at squash time and could silently pick up a late commit that
  // landed after the gate-base check. A failed resolve falls back to the branch name, never a hard failure.
  let resolvedBranchHead: string | undefined;
  try {
    resolvedBranchHead = (await withTimeout(
      git.raw(["rev-parse", "--verify", `${branch}^{commit}`]), timeoutMs, "git rev-parse branch (resolve squash target)",
    )).trim();
  } catch { /* fall through: squashTarget below stays the branch name, unchanged from before this fix */ }
  const squashTarget = resolvedBranchHead ?? branch;
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
        await withTimeout(git.raw(["reset", "--merge", "HEAD"]), timeoutMs, "git reset --merge (canonical, residue clear)");
      } catch (e) {
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
  async function resetOrSkip(context: string): Promise<string | null> {
    if (hadUnstagedDirtAtEntry) {
      return `skipped automatic cleanup (${context}) because the canonical repo already had unstaged tracked changes before this merge attempt — resetting would risk discarding them; a human must resolve the canonical checkout by hand, and the next merge attempt will refuse loudly on any staged residue this left behind`;
    }
    try {
      await withTimeout(git.raw(["reset", "--hard", "HEAD"]), timeoutMs, `git reset --hard (canonical, ${context})`);
      return null;
    } catch (e) {
      return `reset --hard (${context}) failed — canonical repo may have residue: ${(e as Error).message}`;
    }
  }

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
    try {
      await withTimeout(git.raw(["merge", "--squash", squashTarget]), timeoutMs, "git merge --squash (canonical)");
    } catch (e) {
      rawError = true; // a conflict OR a real failure — the explicit checks below decide
      // Card 4b7ff996: captured (not just flagged) so the rawError branch below can tell git's own
      // "unstaged local changes would be overwritten" signature apart from every other real failure — the
      // message used to be discarded here entirely, leaving the caller with a generic "git merge --squash
      // failed" for a class of failure that actually has a specific, diagnosable cause and a specific,
      // different remedy (see that branch's own doc).
      rawErrorMessage = (e as Error).message;
    }
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
      const cleanupIssue = await resetOrSkip("post-squash-probe-failure cleanup");
      return { ok: false, reason: `failed to inspect canonical index for conflicts after squash: ${(e as Error).message}${cleanupIssue ? ` (${cleanupIssue})` : ""}` };
    }
    if (conflicted) {
      // The cleanup that's supposed to leave the canonical repo UNTOUCHED can ITSELF fail (busy index lock,
      // read-only tree); swallowing it would assert a clean "conflict" while the repo is left with unmerged/
      // partial-index residue. SURFACE it via `reason` so the caller knows the canonical repo needs recovery
      // rather than trusting the (now false) "untouched" guarantee.
      const cleanupIssue = await resetOrSkip("conflict cleanup");
      if (cleanupIssue) return { ok: false, conflict: true, reason: cleanupIssue };
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
      const cleanupIssue = await resetOrSkip("rawError cleanup");
      // @decision 4b7ff996 — squash-time backstop for the race window between the admission-time preflight
      // and this squash: classify a matching rawError as dirtyOverlap:true, never a generic failure — and
      // always include rawErrorMessage regardless of cleanupIssue, the only place the overwritten path is
      // named.
      const dirtyOverlap = !!rawErrorMessage && /would be overwritten by merge/i.test(rawErrorMessage);
      if (dirtyOverlap) {
        return {
          ok: false,
          dirtyOverlap: true,
          reason: `canonical repo has local content that would be overwritten by this merge (git refuses to clobber it): ${rawErrorMessage}${cleanupIssue ? ` (${cleanupIssue})` : ""}`,
        };
      }
      return { ok: false, reason: cleanupIssue ? `git merge --squash failed (${cleanupIssue})` : "git merge --squash failed" };
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
      const cleanupIssue = await resetOrSkip("staged-probe-failure cleanup");
      return { ok: false, reason: `failed to inspect canonical index staged diff after squash: ${(e as Error).message}${cleanupIssue ? ` (${cleanupIssue})` : ""}` };
    }
    if (!staged) {
      // Clean no-op: classify so the caller can distinguish "already merged" from "no diff to merge". The
      // branch's commits are "already in main" iff a prior squash carrying its trailer is reachable from HEAD
      // AND that commit's content is verified to actually contain the branch's own changes (see
      // findLandedSquashCommit's content-reachability check — trailer presence alone is not proof).
      const landed = await findLandedSquashCommit(repoPath, branch, "HEAD", deps);
      // `sha` rides along on the ALREADY_MERGED case (card 1eebc46a) — `landed` IS the commit's sha,
      // already resolved by the lookup just above; surfacing it costs no extra git call, just returning
      // data this function already computed, so the caller (finalizeMerge) can persist ship-state without
      // a redundant lookup of its own.
      return { ok: true, noop: true, emptyKind: landed ? "ALREADY_MERGED" : "STAGE_EMPTY_RETRY", sha: landed ?? undefined };
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
      const cleanupIssue = await resetOrSkip("title-html-entity cleanup");
      return {
        ok: false,
        reason: `squash subject contains an HTML entity ("${subjectGuard.match}") — would become a PERMANENT, ` +
          `unrewritable mainline commit subject (this has already happened once: commit fe2c1c6b). Retitle the ` +
          `card (tasks_update) to a clean subject, then re-confirm. Squash phase aborted before landing; ` +
          `canonical repo restored to its pre-merge state.${cleanupIssue ? ` (${cleanupIssue})` : ""}`,
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
      const mergeBaseForSquashMeta = (await withTimeout(git.raw(["merge-base", "HEAD", branch]), timeoutMs, "git merge-base (canonical, squash metadata)")).trim();
      workerCommitLogBody = await deriveWorkerCommitLogBody(repoPath, branch, mergeBaseForSquashMeta, subject, deps);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[git] mergeBranchLocked: worker-commit-log body capture failed for ${branch}: ${(e as Error).message}`);
    }
    const bodyBlock = workerCommitLogBody ? `\n\n${workerCommitLogBody}` : "";
    let message = `${subject}${bodyBlock}\n\nLoom-Worker-Branch: ${branch}\n`;
    // @decision c862f14c — stamps the path-set trailers from the STAGED index, never a follow-up amend
    // (caused an orphan window + doubled hooks). LOAD-BEARING ADJACENCY: no git call may land between this
    // capture and the commit below, or it breaks the tree-identity the byte-identical-digest proof rests on.
    try {
      const base = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (canonical, pathset base)")).trim();
      const digest = await stagedPathSetDigest(git, timeoutMs);
      message = `${message.replace(/\s+$/, "")}\nLoom-Worker-Base: ${base}\nLoom-Worker-PathSet: ${digest}\n`;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[git] mergeBranchLocked: Loom-Worker-Base/PathSet capture failed for ${branch} — commit lands ` +
        `without either trailer: ${(e as Error).message}`);
    }
    try {
      await withTimeout(git.raw(["commit", "-m", message]), timeoutMs, "git commit (canonical, squash-merge)");
    } catch (e) {
      const cleanupIssue = await resetOrSkip("commit-failure cleanup");
      return { ok: false, reason: cleanupIssue ? `squash commit failed: ${(e as Error).message} (${cleanupIssue})` : `squash commit failed: ${(e as Error).message}` };
    }
    // Re-read HEAD UNCONDITIONALLY rather than trusting a value captured before this call (mirrors the
    // reasoning that used to guard the old follow-up amend, card 756a2cd8's Code Review follow-up):
    // `withTimeout` (git/bounded.ts) settles independent of the git child it wraps — on expiry it rejects
    // and walks away while the child is left alone, still mutating — so this commit could land ON DISK
    // while its own `withTimeout` call times out and control falls through to the catch below. Mirrors
    // {@link landBranchCommitsIndividually}'s own post-loop read (`git/batch-merge.ts`): read once,
    // unconditionally, and fail LOUD (`ok:false`) if that read itself fails, rather than returning a value
    // that might no longer be what HEAD actually points at.
    try {
      const sha = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (canonical, post-commit)")).trim();
      return { ok: true, sha, subject };
    } catch (e) {
      return { ok: false, reason: `squash landed but failed to read the result: ${(e as Error).message}` };
    }

  } finally {
    exitMergeDangerWindow(repoPath);
  }
}

/** @decision 44c28799 — boot-time, READ-ONLY companion to {@link mergeBranchLocked}'s entry check: scans for
 *  dirty tracked state to SHRINK THE DETECTION WINDOW, never to close the hole itself (the merge-time refusal
 *  already does that). NEVER resets, NEVER blocks boot, NEVER throws — a non-git-checkout repo is silently
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
