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

/**
 * Default per-git-op ceiling for every {@link boundedGit}/{@link boundedMergeGit} call in this file that
 * doesn't override it (removeWorktree / findLandedSquashCommit / deleteBranch / mergeBranchLocked /
 * scanCanonicalReposForMergeResidue / …) — generous for a real op (sub-second normally, and this project's
 * own local-git-write default in `git/writer.ts`'s `GIT_LOCAL_TIMEOUT_MS` agrees: same 15s, for the same
 * "local plumbing op, not a network push" reasoning), but BOUNDED so a wedged child can't hang the caller.
 * This is the fix for the boot-outage: a git op on a busy/locked dir (e.g. a directory handle stuck by
 * an unrelated process) HANGS INDEFINITELY — it doesn't throw — and a try/catch only catches throws.
 * Originally introduced for boot-reconcile (Pass A: findLandedSquashCommit → finalizeMerge's
 * removeWorktree + deleteBranch; Pass B: removeWorktree), which ran these ops during daemon BOOT, so one
 * hung op blocked the whole daemon from booting, for hours, on 2026-06-03 — since generalized to every
 * bounded op in this file (board card 44c28799 added `mergeBranchLocked`'s own ~10 `git.raw` calls: the
 * squash-merge is local plumbing exactly like the rest, not a slow/legitimately-long-running gate, so the
 * same 15s ceiling that's generous for a real merge is still tight enough to fail a wedged commit hook
 * fast instead of wedging the per-repo merge mutex permanently).
 */
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

/**
 * `simpleGit(repoPath, ...)` throws `GitConstructError` SYNCHRONOUSLY when `repoPath` doesn't exist or
 * isn't a directory (verified directly against the installed simple-git, with an existing-dir control
 * that constructs fine — board card 0f965ab7). Every caller of {@link boundedGit}/{@link boundedMergeGit}/
 * {@link boundedDiffGit} in this file documents its own fail-safe contract on error/timeout ("FAIL SAFE",
 * "FAILS CLOSED", "best-effort, logged not fatal", …) by wrapping the git CALLS it makes in its own
 * try/catch — but a synchronous throw from CONSTRUCTING the git handle escapes every one of those (they
 * only guard the calls made INSIDE them), rejecting the function outright instead of honouring its
 * documented contract. Two of ~nine affected callers (`worktreeHasWork`, `findLandedSquashCommit`) were
 * each individually patched to wrap their own construct call — the exact "an invariant the next caller can
 * forget" shape that let the other seven regress. Rather than add seven more per-caller wraps, this catches
 * the construct throw ONCE, here: `git` degrades to a stub whose every method returns the SAME rejected
 * promise the construct threw, so a caller's existing `await withTimeout(git.<method>(...), ...)` inside
 * its own try/catch sees this as an ordinary async git failure — indistinguishable from a timeout or a real
 * git error — and no caller needs to change. `listCheckedOutBranches` is UNCHANGED by this: it has no
 * try/catch of its own around its git call, so the (now-async, previously-sync) rejection still propagates
 * out of it uncaught, exactly as its doc says it must.
 *
 * ⚠️ **`then`/`catch`/`finally` (and any symbol-keyed property) must resolve to `undefined`, NOT a
 * rejecting function** — a `get` trap that answers EVERY property makes this stub a THENABLE (any code
 * that `await`s the `{git}` handle itself, returns it from an `async` function, or passes it to
 * `Promise.resolve()` calls `.then(resolve, reject)`). A trapped `then` here would be
 * `() => Promise.reject(rejection)` — called with `(resolve, reject)` but IGNORING both and returning its
 * own fresh (uncaptured) rejected promise instead of invoking either — so the awaiting promise would NEVER
 * SETTLE: the exact unsettling-promise hazard {@link withTimeout}'s own doc warns about, reintroduced
 * inside the fail-safe primitive meant to prevent it. No caller today awaits the handle itself (every one
 * destructures `{git}` and calls a method on it), so this was latent, not reachable — but the whole reason
 * this is fixed centrally rather than per-caller is the caller that doesn't exist yet. No real git method
 * is ever named `then`/`catch`/`finally` or symbol-keyed, so excluding them costs nothing.
 */
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
  /**
   * Whether the monorepo BUILD phase may run at all for this worktree (default true — every existing
   * caller stays byte-identical). A build-free rig — a `noCommit`/read-only role such as Code Reviewer
   * or Docs & Vault — never runs a build gate, so paying for a full top-level `pnpm build` at worktree
   * creation is pure spawn-latency with zero benefit. INSTALL still runs unconditionally when `false`
   * (a no-commit rig still needs `node_modules` to run/read the repo) — only the build phase is gated.
   * Threaded from the spawn caller (`sessions/service.ts`) off the session's resolved `noCommit` flag.
   * Named `runBuild`, not `build`, to avoid colliding with the injectable {@link ProvisionDeps.build}
   * function seam above.
   */
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

/**
 * Run a BOUNDED, NON-INTERACTIVE `pnpm install --frozen-lockfile --prefer-offline` in `worktreePath`,
 * killing the child if it exceeds `timeoutMs`. ASYNC (child_process.spawn, NOT spawnSync) on purpose:
 * createWorktree is awaited on the worker-spawn hot path, and a synchronous spawnSync would freeze the
 * single-threaded daemon event loop (every session/WS/PTY) for the whole install — unacceptable. This
 * resolves a result object and NEVER rejects, so the caller's degrade-on-failure stays simple.
 *
 * The command is a HARDCODED constant (never agent input) ⇒ no gateCommand-style trust-boundary concern;
 * `shell:true` only lets the OS resolve `pnpm` (pnpm.cmd on Windows) from PATH, mirroring the gate runner.
 * `CI=1` keeps pnpm non-interactive (no update-notifier / prompts that could hang the child). Even if a
 * killed child orphans a lingering pnpm on the rare timeout path, it is merely finishing the install we
 * wanted; the function has already RETURNED within the bound, which is the load-bearing guarantee.
 *
 * stdout+stderr are PIPED (not ignored) and captured into a bounded {@link OUTPUT_TAIL_MAX_CHARS} tail
 * so a failure's `reason` carries the actual tool output, not just an exit code — {@link
 * provisionWorktreeDeps} logs it loudly instead of the old silent degrade.
 */
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

/**
 * Run ONE bounded, non-interactive install `command` in `worktreePath`, killing the child past
 * `timeoutMs`. Shared by {@link npmInstall} and {@link yarnInstall}; structurally identical to
 * {@link pnpmInstall} (which keeps its OWN copy so the pnpm path stays byte-identical). ASYNC spawn
 * (NOT spawnSync) so the single-threaded daemon event loop never freezes mid-install; resolves a result
 * object and NEVER rejects, so the caller's degrade-on-failure stays simple. `command` is ALWAYS a
 * HARDCODED constant selected by lockfile marker — NEVER agent input — so `shell:true` (which only lets
 * the OS resolve npm/yarn[.cmd] from PATH, mirroring pnpmInstall + the gate runner) carries no
 * gateCommand-style trust-boundary concern. `CI=1` keeps the tool non-interactive (no prompts/notifiers
 * that could hang the child).
 *
 * Also used for the monorepo BUILD step ({@link WORKSPACE_BUILD_COMMANDS}) — same bounded, best-effort,
 * output-capturing shape applies to a build command as much as an install. stdout+stderr are PIPED (not
 * ignored) and captured into a bounded {@link OUTPUT_TAIL_MAX_CHARS} tail so a failure's `reason` carries
 * the actual tool output, not just an exit code.
 */
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

/**
 * Make a freshly-created worktree BUILD-READY: populate node_modules at creation (so the spawned worker
 * doesn't pay a full install before it can build), and — when the worktree root is a JS WORKSPACE
 * MONOREPO ({@link isWorkspaceMonorepo}) — additionally run a top-level build so sibling packages' `dist`
 * output exists too (e.g. this repo's own `shared` must build before `daemon`/`web` can import it). A
 * worker whose install/build would fail/time out is caught HERE (bounded) instead of wedging the worker
 * mid-task. (node_modules is gitignored, so `git worktree add` checks out the tree WITHOUT it.)
 *
 * SAFE-BY-CONSTRUCTION removal: every supported install (pnpm/npm/yarn) gives the worktree its OWN
 * independent node_modules WITHIN the worktree — pnpm hardlinks into the shared content-addressable store
 * plus an internal `.pnpm` virtual store; npm/yarn write a self-contained `./node_modules`. None is a
 * junction/symlink into the main checkout, so removeWorktree's recursive removal only ever deletes the
 * worktree's own tree and can NEVER recurse into the main checkout's node_modules (the skill-store-nuke /
 * junction-follow class of bug — see removeWorktree). The companion test proves this. NEVER
 * share/symlink/junction node_modules across worktrees — native modules + concurrent install-state across
 * parallel workers would break, and it reintroduces the landmine. This is load-bearing.
 *
 * BEST-EFFORT + BOUNDED, in TWO independently-bounded phases:
 *   1. INSTALL — acts only when a recognized JS lockfile marks the worktree root ({@link
 *      detectPackageManager} — pnpm-lock.yaml / package-lock.json / yarn.lock, in that deterministic
 *      precedence; a non-JS repo, incl. the bare temp repos in tests, is skipped silently).
 *   2. BUILD — only attempted after a SUCCESSFUL install (a build over incomplete/missing deps is
 *      pointless), only when {@link isWorkspaceMonorepo} detects a workspace root (a single-package
 *      repo skips this phase entirely), AND only when {@link ProvisionDeps.runBuild} isn't explicitly
 *      `false` (a build-free/noCommit rig gets install only — see {@link ProvisionDeps.runBuild}).
 *      Runs on its OWN budget ({@link PROVISION_BUILD_TIMEOUT_MS}), independent of the install's.
 * Either phase's failure/timeout is CLASSIFIED and logged LOUDLY (see {@link logProvisionFailure} — the
 * specific reason plus a captured output tail, not a silent `console.warn`) and then SWALLOWED — the
 * worker simply falls back to installing/building itself. This function MUST NEVER throw past
 * createWorktree or wedge the spawn path.
 */
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

/**
 * Card `82b4d9ac`: START/OK/FAILED are a matched triple per phase (install, build) — the fix for the
 * old failure-only logging, which left duration and concurrency of provisioning structurally
 * unobservable (no start timestamp, no success emission at all). `console.log`/`.error` only — NOT an
 * `orchestration_event` row: {@link createWorktree}'s one call site (`sessions/service.ts` `spawnWorker`)
 * runs BEFORE a worker session row exists, so there is no `manager_session_id`/`worker_session_id`/
 * `task_id` yet to key such a row on, and inventing a parallel event shape just to carry a worktree path
 * is exactly what the card's DoD says not to do. `worktreePath` already encodes the project id as a path
 * segment ({@link WORKTREES_DIR}`/<projectId>/<taskKey>`), so it alone makes a window attributable to a
 * project without a separate field. Each line embeds explicit ISO wall-clock timestamps (not just a
 * duration) so two provisioning windows can be read DIRECTLY off the log for overlap — no proxy, no
 * inference from unrelated completion events. Purely diagnostic: `Date.now()`/`console.log` are cheap,
 * synchronous, non-blocking calls already used throughout this file (see {@link logProvisionFailure}'s
 * prior `console.error`-only form) — this adds no I/O and changes no provisioning behavior/timeout/
 * precedence.
 */
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

/**
 * For a REUSED branch (either reuse path of {@link createWorktree}), re-cut an EMPTY/STALE branch onto
 * the canonical main BEFORE handing the worktree to the worker — the fix for the stale-base bug
 * (2026-06-04): a task whose worktree/branch survives from a PRIOR attempt was re-attached at its OLD
 * base commit, so a "fresh" re-spawn silently inherited a stale tree (wrong toolchain/gate, phantom
 * pre-existing failures, a big merge-conflict reconcile).
 *
 *   - ZERO commits ahead of canonical HEAD (empty/stale branch at an old base) → `reset --hard` the
 *     worktree onto main's CURRENT sha: branch pointer AND checkout both move forward to current main.
 *   - >0 commits ahead (RECOVERY case — the branch carries real unmerged work, e.g. a cherry-picked
 *     recovery commit) → leave it EXACTLY as-is. The recovery flow RELIES on branch reuse; a branch
 *     with unmerged work is NEVER reset/re-cut. This is the load-bearing invariant.
 *
 * "Commits ahead" = `git rev-list --count <mainSha>..<branch>` (0 ⇒ safe to re-cut): commits reachable
 * from the branch but not from current main, which for an empty stale branch (tip is an ancestor of
 * main) is 0, and for a recovery branch is its real prior commit(s). The 0-check is delegated to the
 * FAIL-SAFE {@link mayRecutOntoMain} so a malformed count can never fall through to the reset. We reset
 * to a SHA, never a branch name — a worktree can't check out a branch that's checked out elsewhere
 * (canonical main lives in repoPath).
 *
 * BOUNDED (card c801d688) via {@link boundedGit}/{@link withTimeout}: every read here throws straight
 * through (no local try/catch), so a timeout is indistinguishable from any other git failure — it
 * propagates to the caller and the function returns WITHOUT ever reaching the `reset --hard` below.
 * That is the fail-safe this timeout must land on: "could not determine" (throw, no reset), never
 * "provably empty" (a timeout can NEVER synthesize a 0-ahead result that reaches {@link
 * mayRecutOntoMain}). A hung child now surfaces as a failed (visible, recoverable) spawn instead of a
 * wedged one — see the card for why that distinction matters on this hot path.
 *
 * Board card 13cc2300: for the 0-ahead path, captures whatever the worktree carries as TRACKED work
 * IMMEDIATELY BEFORE the destructive `reset --hard` below — the only moment it's still there to read —
 * and returns it as {@link DiscardedOnRecutInfo} so a caller can report what the reset just destroyed.
 * Delegates to {@link captureDiscardedOnRecut}, which shares its bound/truncation caps and FAIL-SAFE
 * posture with {@link detectReusedDirtyWorktree} (a capture hiccup reads as "nothing to report", never
 * blocking or altering the reset) but filters to TRACKED paths ONLY ({@link discardedByResetFiles}) — an
 * UNTRACKED leftover survives `reset --hard` untouched, so it is never "discarded" by one; it is still
 * reported, separately, by `createWorktree`'s own post-recut {@link detectReusedDirtyWorktree} read.
 * `undefined` covers BOTH "the branch was never recut" (>0 ahead, the early return below) and "it was
 * recut but no TRACKED path was dirty" (an untracked-only leftover, or a genuinely clean reuse) — a
 * caller cannot distinguish those two from this return value alone, and does not need to: either way
 * there is nothing destroyed to report.
 */
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

/**
 * Card 5150fdc2 part 1 — for a REUSED/reattached branch (either reuse path of {@link createWorktree},
 * called AFTER {@link recutStaleReusedBranch} has already had its say): is this branch's history missing
 * commits current main HEAD carries? A 0-ahead branch was already re-cut onto `mainSha` above, so this
 * only ever fires for a RECOVERY branch (>0 commits ahead of ITS OWN old base, correctly left untouched by
 * the recut's fail-safe) whose base has since fallen behind — the systematic case a mockups-first branch
 * hits: `recutStaleReusedBranch` never advances it (correctly — see {@link mayRecutOntoMain}), so a build
 * that started at the old fork point silently stays rooted there across every re-spawn.
 *
 * Uses {@link countCommitsBehind} for the "how many" signal (fail-safe to `undefined`/not-stale on any
 * error, and already BOUNDED itself); only when that's genuinely > 0 do we pay for `merge-base` + a
 * `diff --name-only` to name the fork point and what changed since — also BOUNDED (card c801d688) via
 * {@link boundedGit}/{@link withTimeout}. Any error past the count read (including a timeout) also reads
 * as "not stale" — this is purely ADVISORY and must never block or alter a spawn.
 */
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
 * first (see {@link recutStaleReusedBranch}) so a fresh re-spawn doesn't inherit a stale base; a branch
 * carrying unmerged work (recovery) is left untouched. The fresh `-b` path already cuts off current
 * HEAD, so it needs no re-cut.
 *
 * ⚠️ THAT RE-CUT IS DESTRUCTIVE, AND THIS IS DELIBERATE, NOT A BUG (board card 13cc2300): for the
 * worktree-dir-present reuse path, a 0-ahead branch's `reset --hard` discards any tracked edits still in
 * that worktree (e.g. a worker hard-stopped mid-edit, before its first commit) — untracked leftovers
 * survive, tracked ones do not. This trade is intentionally kept, not something this function (or its
 * caller) is meant to opt out of on its own judgement. What this function DOES do about it: {@link
 * recutStaleReusedBranch} snapshots whatever it's about to discard immediately before the reset and
 * returns it as {@link WorktreeInfo.discardedOnRecut}, so the loss is at least reportable even though the
 * files themselves are gone — see that field's own doc for how it differs from {@link
 * WorktreeInfo.reusedDirtyWorktree} (survived vs. destroyed).
 *
 * `repoKey` (multi-repo epic 49136451 phase 2) adds a REPO AXIS to the worktree dir for a NON-primary
 * repo: `WORKTREES_DIR/projectId/<repoKey>/<taskKey>` instead of `WORKTREES_DIR/projectId/<taskKey>`, so
 * a task re-targeted across repos (or two different tasks on two different registry repos) can never
 * collide on the same dir. Omitted, `undefined`, or `"primary"` keeps the ORIGINAL 2-segment path —
 * BYTE-IDENTICAL to every call before this param existed, which is load-bearing: an existing live
 * worktree/branch must survive a daemon upgrade mid-flight. The branch name (`loom/<key>`) itself gets
 * NO axis — branches are a per-repo namespace, so the same key can never collide across two distinct
 * repos; only the shared filesystem path needs disambiguating.
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
  // Card 2fcd5eae: `prune` -> `branch --list` -> `add` is a multi-step read-modify-write against the
  // SHARED `.git/worktrees/` admin state — serialize ONLY this sequence per canonical repo path, via the
  // SAME lock `mergeBranch`/`GitWriter` already use (`withCanonicalIndexLock`, repo-lock.ts). Verified
  // no re-entrancy: createWorktree's one call site (sessions/service.ts spawnWorker) is never reached
  // while this lock is already held — `mergeBranch` (the lock's other acquirer) always fully returns
  // (releasing the lock) before its caller goes anywhere near a spawn, and the cap-queue drain that can
  // follow a merge's finalize is fire-and-forget, never nested inside the lock's callback. Deliberately
  // does NOT wrap `provisionWorktreeDeps` below (a package-manager install, potentially minutes) — that
  // would serialize every worker spawn on the daemon behind each other's install.
  //
  // Card 8e75ee20: unlike every OTHER bounded call in this file, these three calls run INSIDE the lock
  // above — releasing it on a bare `withTimeout` race (which settles independent of the child) would let
  // the NEXT queued caller start while THIS call's `git worktree add` may still be alive and still
  // mutating `.git/worktrees/`, reopening the exact race the lock exists to close (see
  // [[simple-git-block-timeout-is-idle-not-elapsed]] for why the instance's own `block` idle-timeout does
  // not already prevent this for a slow-but-talking child). So: the REAL git path (no injected
  // `gitDeps.gitFactory`) uses {@link withTimeoutKillingChild}, which kills the child on expiry and only
  // settles once that child is confirmed dead. A test's `gitFactory` fake can't be killed (it ignores the
  // abort signal entirely — there's no real child behind it), so that path keeps the plain {@link
  // withTimeout} race, unchanged from before.
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
      // Card 1a858805: a killed `worktree add` (withTimeoutKillingChild above, card 8e75ee20) can leave
      // `.git/worktrees/<name>/locked` (content `initializing`) behind — git's own in-progress marker,
      // normally cleared on success, now orphaned because the child died mid-checkout. `git worktree
      // prune` SKIPS locked records BY DESIGN (so a concurrent prune can't delete an in-progress add) —
      // the leading prune above can never clear it (git refuses: "cannot remove a locked working tree,
      // lock reason: initializing"). Neither could `removeWorktree()` at the time this paragraph was
      // written; card adf03de8 (AFTER this one) has since upgraded IT to the same `-f -f` override this
      // catch uses, so `removeWorktree()` now also clears an intact locked record on its own — see the
      // card fdfe8a56 paragraph below, which relies on that.
      //
      // `git worktree remove -f -f` is git's own documented override for exactly this lock reason — the
      // error text names it verbatim. Recover it here, best-effort, via the SAME lock-scoped
      // `boundedLockedRaw` the three calls above use (still inside withCanonicalIndexLock's callback, so
      // this doesn't reopen the race the lock exists to close).
      //
      // BOUNDED, not absolute: `worktreePath` is confirmed non-existent by the `fs.existsSync(worktreePath)`
      // reuse-return check above (OUTSIDE this lock) before control ever reaches this lock block — so in
      // practice this only ever targets a fresh directory Loom itself is trying to create, never an
      // existing worktree a human deliberately locked. That check and this `add` are NOT atomic with
      // each other (the existsSync read is outside the lock the add runs inside), so this is a narrow
      // TOCTOU window, not a proof — accepted because `worktreePath` is deterministic PER TASK
      // (`taskKey(taskId)`, see below) and this daemon never runs two live spawns for the same task
      // concurrently: `sessions/service.ts` `spawnWorker` refuses a second live worker on a `taskId`
      // already held by one (`Db.liveSessionIdForTask`, checked before any worktree/pty side effect), AND
      // closes that check's own TOCTOU gap with a true, proven-atomic in-memory mutex
      // (`inFlightSpawnTaskIds` — its own doc comment there has the atomicity proof: the daemon is a
      // single process, and the claim's test-and-set has no `await` between them, so no other spawn call
      // can interleave). So nothing else can be concurrently creating (or deliberately locking) THIS exact
      // path while this call runs — making the realistic exposure nil, not because the window itself is
      // closed.
      //
      // Two failure shapes reach this catch, both handled the same best-effort way:
      //  - the add failed WITHOUT ever creating worktreePath (e.g. "already used by worktree at
      //    <other path>") — the remove below is then a harmless no-op against a path that was never
      //    registered; it must never be able to touch whatever OTHER path such an error names.
      //  - the add left a genuine locked ghost — the remove below clears it.
      // Either way, a failure to clean must NEVER throw past createWorktree — swallow it and rethrow the
      // ORIGINAL add error unchanged, so a cleanup failure can never mask or replace the real one.
      //
      // Card fdfe8a56: `boundedLockedRaw`'s production path (`withTimeoutKillingChild`) only guarantees
      // the child is confirmed dead on its PATH-1 settlement (the "(git child killed)" rejection). Its
      // `giveUpTimer` fallback (PATH 2, "...giving up (hung git child?)") rejects on a bare timer with NO
      // such confirmation — see card 963f69ab for the discriminator regex. On a PATH-2 `addErr` the add's
      // child may STILL BE ALIVE, so running this destructive `remove -f -f` there would race a possibly-
      // still-writing child: clear the dir, then have the still-live add re-create part of it with no
      // admin record — a shape Code Review flagged as newly reachable BY THIS CLEANUP (not pre-existing),
      // probability unquantified. SKIP the cleanup on PATH 2 rather than risk that race.
      //
      // THE TRADE, RE-PRICED against the ACTUAL residue mechanics (a follow-up review of this exact
      // paragraph, still card fdfe8a56): an earlier draft here claimed `worktreePath` is "per-spawn
      // unique, never reused" — FALSE. `worktreePath` is `path.join(WORKTREES_DIR, projectId, [repoKey,]
      // taskKey(taskId))`, a pure deterministic function of `taskId` (see `taskKey` above) — a
      // respawn/retry/recycle on the SAME task lands on the IDENTICAL path, straight into the
      // `fs.existsSync(worktreePath)` reuse branch above (its own doc: "a hard-stopped or rejected-merge
      // attempt on the same task"). So the residue absolutely CAN be reused into. What actually happens
      // then was traced empirically (real git, not a mock — not just read), for both shapes:
      //   - SKIP leaves the admin record INTACT whenever the child dies without our cleanup racing it — a
      //     locked-but-otherwise-valid worktree. A later respawn's reuse path works completely normally
      //     against it: createWorktree succeeds, and a genuinely-missing/leftover file surfaces via the
      //     existing `reusedDirtyWorktree` reporting rather than anything throwing — `locked` only ever
      //     blocks `worktree remove`/`prune`, never ordinary git ops run inside the worktree (verified:
      //     `reset --hard`/`status` both succeed against a still-locked worktree). It's not a permanent
      //     leak either: `removeWorktree()` (this file) clears an intact locked residue on its own, no
      //     manual step, confirmed by direct call — see the paragraph above.
      //   - NOT skipping risks the OTHER shape: our own `remove -f -f` racing the still-alive add, wiping
      //     the admin record while the child keeps writing, leaving `worktreePath` populated but with NO
      //     `.git` link at all. Confirmed by direct call: a later respawn's reuse branch then throws
      //     "fatal: not a git repository" — LOUD, not silent (the canonical repo's own HEAD stays
      //     untouched in this test; nothing escaped upward into an unrelated repo) — but createWorktree has
      //     no fallback to detect and recover from THIS shape, so that task's respawns stay broken until a
      //     human deletes the stray directory by hand.
      // So SKIP trades a residue that self-heals through `removeWorktree()`'s ordinary lifecycle for one
      // that — only if the race actually manifests — needs a human to notice and clear it. And skipping is
      // what makes that second, worse shape structurally UNREACHABLE via our own code: it can only occur
      // through OUR destructive call racing the child; leaving the child alone never produces it. PATH 2
      // has never been observed firing in this fixture (0/45, 0/65 local trials — an upper bound on those
      // approaches, not a rate, not proof it's unreachable), so this trade is still made on the mechanism
      // argument, now priced against the TRUE reuse-path behavior rather than an assumed one.
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

/**
 * Delete MANY branches in as few git invocations as possible — measured for card 09f268a5's 275-branch
 * backlog at ~14x faster than N sequential {@link deleteBranch} calls (14.1s → 0.99s on this host), because
 * each `deleteBranch` call is a separate Windows subprocess spawn and spawn cost dominates at this N. A
 * SEPARATE function from `deleteBranch`, which is left byte-identical — it has other callers (finalizeMerge)
 * this card must not perturb.
 *
 * One batched `git branch -D <n1> <n2> ...` per {@link DELETE_BRANCHES_CHUNK_SIZE}-sized chunk. Git deletes
 * every branch it CAN in one invocation and exits non-zero if ANY of them failed (checked out elsewhere
 * since the caller's own `listCheckedOutBranches` read, concurrently removed, a locked ref, …) — so a
 * naive "the whole chunk succeeded or none of it did" read would (a) undercount `deleted` for branches
 * that in fact WERE removed, and (b) abandon ~199 good deletions over one bad ref. On a chunk failure this
 * falls back to per-branch {@link deleteBranch} calls for THAT CHUNK ONLY (idempotent — a branch the failed
 * batch already removed is a harmless no-op there), verifying each via {@link branchExistsInRepo} so the
 * returned `deleted` list — and therefore a caller's reclaimed-count — reflects what ACTUALLY happened,
 * never an assumption. The slow per-branch path only ever runs on the rare failure; the common case keeps
 * the full batched speedup.
 */
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

/**
 * Find nested git repositories inside a worker worktree (card b6d41db1) — a subdirectory carrying its
 * OWN `.git` (dir or file), distinct from the worktree's own root git linkage. Every worker worktree
 * ALWAYS has expected ephemeral untracked content (`node_modules`, `dist`, `.turbo`, …) — that's WHY
 * removeWorktree force-removes it — but a nested `.git` marks something else: a cloned repo, which can
 * hold real unrecoverable work (unpushed branches). This is the precise signal that distinguishes that
 * valuable class from ordinary build/dep noise.
 *
 * ASYNC + BOUNDED: walks with `fs.promises.readdir` (never a synchronous recursive walk that could block
 * the event loop) and stops after {@link NESTED_REPO_SCAN_MAX_ENTRIES} visited entries — signalling
 * `truncated:true` when it does, so a caller can distinguish "confirmed clean" from "gave up partway"
 * (CR finding, card b6d41db1 follow-up: a cap that silently returns a partial `repos` list lets a wide
 * enough build-output sibling exhaust the budget before the walk ever reaches a real nested repo,
 * re-opening the exact data-loss hole this scan exists to close). Never descends into the known
 * build/dep noise dirs in {@link NESTED_REPO_SCAN_SKIP_DIRS} (bulk of most trees, never a legitimate
 * nested-repo location) or into a repo it just found (no need to look inside a clone for further
 * clones). Fails OPEN on a read error for any one directory (permissions, a race with concurrent
 * cleanup) — a scan glitch on ONE subdirectory must never itself block a legitimate merge; it simply
 * skips what it couldn't read (distinct from hitting the entry cap, which DOES signal `truncated`).
 */
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

/**
 * KILLABLE directory removal — the fix for bd9fc808's leak. The prior backstop (`fs.promises.rm`) runs
 * on the libuv THREADPOOL; a wedged directory handle makes that call hang past any timeout we impose
 * from JS (`withTimeout` only stops US waiting — the detached call keeps occupying a threadpool slot
 * FOREVER, and there is no API to cancel an in-flight threadpool task). With only 4 threads by default,
 * a handful of wedged dirs starves fs/dns/crypto process-wide (the incident this task exists to fix).
 *
 * This instead runs the removal in a SEPARATE OS PROCESS. A wedged handle blocks only that child, never
 * a daemon thread, and on timeout we FORCE-KILL it (`killRemoveChild`) — an OS-level TerminateProcess/
 * SIGKILL that works regardless of what the child is blocked on, unlike a threadpool task with no kill
 * primitive at all. A killed child releases everything it held, and every NORMAL path (found already-gone
 * / removed / clean failure / killed) RESOLVES (never settles false-negative) within `timeoutMs` — the
 * function is not designed to reject. (A synchronous throw from an injected `spawnChild` seam would still
 * propagate as a rejection via the Promise executor; the real default spawn never throws synchronously,
 * and callers already wrap this in a `.catch` for exactly that belt-and-suspenders reason.)
 */
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
 * UNLOCKED BY DESIGN, not an oversight (board card c6a6f405 item 2 — filed as a reviewer QUESTION, not
 * a data-loss finding, and left that way here). `git worktree remove -f -f` + the trailing `prune`
 * below mutate the SAME shared `.git/worktrees/` admin state {@link createWorktree} takes {@link
 * withCanonicalIndexLock} for (card 2fcd5eae's "prune → branch --list → add is a multi-step
 * read-modify-write" rationale) — but this function does NOT take that lock, and runs concurrently with
 * spawns (`finalizeMerge`, boot-reconcile Pass B, the wedge sweep). Judged safe today because git's own
 * `locked`/`initializing` admin marker makes a concurrent `prune` SKIP an in-flight `add` BY DESIGN —
 * the realistic overlap this function can actually race against.
 * ⚠️ THE LOCK IS NOT RE-ENTRANT: this function's one caller (`SessionService`'s worktree-GC path,
 * sessions/service.ts) never holds it, and `finalizeMerge` only calls this function AFTER `mergeBranch`
 * has fully released the lock — but a FUTURE caller invoking this from inside an already-held
 * `withCanonicalIndexLock` block would DEADLOCK. Before wrapping this call in the lock reflexively,
 * confirm no caller holds it first, or give this function (and its callers) a re-entrancy story.
 *
 * Windows handle-release race: when a worker is hard-stopped just before its worktree is removed
 * (the merge path — confirmWorkerMerge), node-pty's exit event fires when the process SIGNALS
 * exit, but the OS releases the worktree's directory handle a beat later. `git worktree remove`
 * then fails ("failed to delete '…': Permission denied") and is NOT idempotent — it can drop the
 * worktree's admin record while leaving the dir on disk, so retrying the same command fails with
 * "is not a working tree". So: attempt the clean git removal once (best-effort), then back it up
 * with the killable filesystem removal below, then prune any stale admin record. When nothing holds
 * the dir (merge-gate's no-pty rows) the git removal succeeds and the backstop is a no-op.
 *
 * BOUNDED (priority reliability fix): a busy/locked worktree dir makes `git worktree remove` HANG
 * INDEFINITELY rather than throw, and boot-reconcile's Pass B calls this DURING daemon boot — so one
 * stuck removal blocked the whole daemon from booting for hours (2026-06-03). Both git ops now run on
 * a simpleGit configured with a `block` timeout (kills a no-output hung child) AND through a
 * {@link withTimeout} race, so the worst case is a BOUNDED failure within ~{@link GIT_OP_TIMEOUT_MS}
 * — the dir is left on disk for a later GC (boot-reconcile Pass B), NEVER an infinite hang. The
 * git instance/timeout is injectable via {@link BoundedGitDeps} so a test can prove the bound.
 *
 * THE FILESYSTEM BACKSTOP is now KILLABLE ({@link killableRemoveDir}) instead of the un-killable
 * threadpool `fs.promises.rm` that leaked libuv threadpool threads on a wedged dir (bd9fc808, reverted
 * 2026-07-03 after it stuck the daemon — see the docstring on {@link killableRemoveDir}). Each attempt
 * is additionally wrapped in {@link withTimeout} so an INJECTED test seam that never resolves is still
 * bounded (the real `killableRemoveDir` always resolves on its own); that outer bound fails SAFE by
 * treating a never-settling seam as WEDGED (`killed:true`), never as a clean reject — a hang must never
 * be looped, injected or real. Two distinct failure shapes:
 *   - a CLEAN reject (settled, `killed:false`) — a transient EBUSY/EPERM handle-lag — gets up to
 *     {@link REMOVE_DIR_CLEAN_RETRY_ATTEMPTS} short, bounded retries (it SETTLES, so it never risks
 *     hanging a thread; this is the ONLY case worth retrying in-session).
 *   - a KILLED timeout (`killed:true`) — genuinely wedged — is NEVER retried HERE, in this one call (a
 *     fast in-process loop on a hang would be exactly the bd9fc808 defect again). The caller
 *     (SessionService) instead tracks it and retries it on a SLOW cadence (once per boot + a
 *     low-frequency background sweep, tens of minutes apart) — most wedges are eventually resolvable (a
 *     held handle releases, a junction-choked `fs.rm` case a plain `rmdir` clears), so it is NOT
 *     abandoned; only a long give-up bound stops the retries.
 * Returns `{removed, wedged}` so the caller can decide how to track/retry it, without re-deriving the
 * same `fs.existsSync` check itself.
 *
 * Card 79b8d8a9: uses `-f -f` (not a single `--force`), git's own documented override for a LOCKED
 * admin record (e.g. the `.git/worktrees/<name>/locked` residue a killed `worktree add` can leave —
 * card 1a858805). Against a locked record, single `--force` refuses outright ("cannot remove a locked
 * working tree"); the filesystem backstop below still deletes the directory anyway, but the trailing
 * `prune` SKIPS locked records BY DESIGN, so the admin record survived forever and the next `worktree
 * add` at that path failed with "is a missing but locked worktree" — a real, verified bug this closes.
 *
 * This is judged SAFE, not merely convenient, because the second `-f` adds NO destructive capability
 * beyond what this function's own filesystem backstop already exercises today: (1) git's SINGLE
 * `--force` already deletes tracked-dirty and untracked files on an ordinary (non-locked) worktree —
 * verified against real git — so `-f -f` changes nothing for that, the overwhelmingly common, case
 * (the second force bit only ever gates the LOCKED/corrupted-HEAD check, per git's own semantics); and
 * (2) even when the git removal fails for ANY reason (locked or not), the filesystem backstop below
 * runs UNCONDITIONALLY and deletes the directory's contents regardless of dirty/uncommitted state — so
 * a locked-and-dirty worktree ALREADY loses its uncommitted files today, via the backstop, before this
 * change. `-f -f` therefore does not create a new way to lose work; it only makes git's own admin
 * bookkeeping match what the backstop already does to the filesystem, closing the ghost-record gap.
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

/**
 * Is `branch` already fully merged into `base` (default: the repo's current HEAD — the canonical
 * branch confirmWorkerMerge's `git merge` lands onto)? ⚠️ Card 9cb0287a (2026-08-29): boot-reconcile
 * Pass A no longer calls this — under squash it now requires POSITIVE proof of a landed squash via the
 * `Loom-Worker-Branch` trailer instead (see {@link worktreeHasWork}'s own doc for the full history). This
 * function currently has ZERO production call sites (test-only); kept for now pending card 0f965ab7's
 * review of the fail-safe siblings that reference it. Detected via `git branch --merged <base> --list
 * <branch>` membership — exit-0 with a
 * non-empty line only when the branch both exists AND is fully reachable from `base`. (We deliberately
 * do NOT use `merge-base --is-ancestor`: simple-git's raw doesn't reject on its exit-1 "not-ancestor"
 * signal, so a try/catch around it reads every branch as merged.) Returns false when the branch ref
 * is gone (a completed merge deletes it), which keeps the reconcile idempotent.
 *
 * BOUNDED: runs through the block-timeout + {@link withTimeout} guard, same as every other reconcile op;
 * a timeout-throw is caught and read as "not merged" (false) — the SAFE default a caller can rely on
 * without itself acting on a bad signal.
 */
export async function isBranchMerged(repoPath: string, branch: string, base = "HEAD", deps: BoundedGitDeps = {}): Promise<boolean> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    return (await withTimeout(git.raw(["branch", "--merged", base, "--list", branch]), timeoutMs, "git branch --merged")).trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Resolve the repo's MAINLINE branch name — independent of `HEAD`. `HEAD` is NOT reliably mainline in
 * this repo: the human-only `git_checkout` writer (`git/writer.ts`) can switch the PRIMARY checkout onto
 * an arbitrary existing branch, and the owner uses it. Any caller that needs "is this branch merged into
 * mainline" (not "merged into whatever's currently checked out") must anchor on this, not `HEAD` — see
 * card 09f268a5, where a `--merged HEAD` sweep would have silently deleted branches merged into a
 * temporarily-checked-out non-mainline branch instead — an unrecoverable-by-the-user data loss on exactly
 * the destructive op this exists to make safe.
 *
 * Reads the LOCAL `refs/remotes/origin/HEAD` symbolic ref (set at clone time / by `git remote set-head`)
 * — a pure local ref read, never a network call (unlike `git remote show origin`, which can contact the
 * remote and hang). FAILS CLOSED to `null` (no guessed fallback — never assume "main") when the ref is
 * absent or the read errors/times out; every caller MUST treat `null` as "cannot determine mainline, skip
 * this repo" rather than falling back to `HEAD`.
 *
 * KNOWN GAP, not a bug: `refs/remotes/origin/HEAD` is written by `git clone` (or `git remote set-head`),
 * NEVER by plain `git init` — and Loom's own `project_init` (see `CLAUDE.md`) creates brand-new projects
 * with `git init`, no remote. Such a repo always resolves `null` here, so a caller like card 09f268a5's
 * branch-ref sweep skips it FOREVER — a local-only project's `loom/*` branches simply never get
 * automatically reclaimed. That's the correct, deliberate trade-off (an inert sweep beats a wrong one),
 * but it must stay VISIBLE to whoever's debugging "why didn't my branches get cleaned up" — a caller
 * skipping on `null` must log it distinguishably from "swept, nothing to do", not skip silently. DO NOT
 * "fix" this by falling back to a guessed `"main"` when the ref is missing — that reintroduces the exact
 * anchor hazard this function exists to close (see card 09f268a5's regression scenario F: a repo whose
 * primary checkout is parked on a non-`main` branch would then have `--merged` computed against the WRONG
 * target and silently destroy real, un-merged-into-mainline work).
 */
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

/**
 * Every local `loom/*` branch that's an ancestor of `mainlineBranch` — `git branch --list 'loom/*'
 * --merged <mainlineBranch>`, the native ancestor check (the same primitive {@link isBranchMerged} uses
 * per-branch, here as one bulk pass). `mainlineBranch` MUST come from {@link resolveMainlineBranch}, never
 * a literal or `HEAD` — see its doc. FAILS SAFE to an empty `branches` array on any error/timeout: a sweep
 * that can't compute "which branches are safe" must delete nothing, not guess.
 *
 * Card f96b9d7c: the caught error is now LOGGED (repoPath + message) before failing safe, and the return
 * carries a `failed` discriminator — so a caller can tell "the read genuinely found 0 merged branches"
 * (`failed:false, branches:[]`) apart from "the read errored/timed out, so we don't actually know"
 * (`failed:true, branches:[]`). Both fail safe to an empty branches array (nothing is ever deleted on
 * uncertainty), but they used to be the SAME observable event with no log at all — indistinguishable from
 * a healthy zero-to-reclaim repo. `failed` does not change the safety contract; it only restores
 * visibility into which of the two silent-before cases actually happened.
 */
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

/**
 * Does `git status --porcelain` output represent REAL worker work, or only daemon-injected noise?
 * Loom mirrors its managed skills/settings into every worktree's `.claude/` (injectSkills); hideFromGit
 * resolves a linked worktree's `.git` file back to the shared main repo's common dir (resolveGitCommonDir
 * in skills/inject.ts) and writes there, so those untracked files ARE hidden via the SHARED
 * `.git/info/exclude` — but only for entries actually written into it (skill dirs, the manifest, and
 * `.claude/settings.local.json`); anything not yet in that shared exclude still surfaces as `?? .claude/…`.
 * That is NEVER the worker's product — the product is src/, package files,
 * tests, anything OUTSIDE the injected `.claude/` churn — so two daemon-noise classes are dropped:
 * (a) ANY UNTRACKED `.claude/` path (skill injection + Claude's own `.claude/settings.local.json`
 * permission writes), and (b) the daemon-injected `.claude/skills/` subtree at ANY status (a re-copy
 * over a repo that tracks a colliding skill name shows as a TRACKED modification, not `??`). Everything
 * else counts as work: tracked modifications elsewhere (incl. a tracked non-skills file under `.claude/`),
 * staged/unstaged changes, and untracked paths OUTSIDE `.claude/`. Without this discriminator the
 * injected noise would make a genuinely-merged worktree read dirty and block its legitimate cleanup
 * (the merge-recovery regression). Exported so the guard's behavior is unit-testable in isolation.
 */
export function worktreeStatusHasWork(porcelain: string): boolean {
  return uncommittedWorkFiles(porcelain).length > 0;
}

/**
 * The REAL-work paths in a `git status --porcelain` output — the list form of {@link worktreeStatusHasWork}
 * (which is now just `length > 0`), so the two share one filter and can't drift. Two daemon-noise classes
 * are dropped: an UNTRACKED (`??`) path under `.claude/` (skill injection + Claude's own `.claude/
 * settings.local.json` permission writes), AND the daemon-injected `.claude/skills/` subtree at ANY status
 * (a re-copy over a tracked colliding skill name surfaces as a tracked modification, not `??`). Everything
 * else — tracked modifications elsewhere (incl. a tracked non-skills file under `.claude/`), staged/unstaged
 * changes, untracked paths OUTSIDE `.claude/` — is the worker's product and kept. Exported so the
 * worker_report(done) pre-check can NAME the uncommitted files in its refusal. Paths are de-quoted (git
 * quotes paths with special chars).
 */
export function uncommittedWorkFiles(porcelain: string): string[] {
  const files: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    // porcelain v1 line: 2 status chars, a space, then the path. `??` = untracked.
    const status = line.slice(0, 2);
    let p = line.slice(3);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1); // git quotes paths with special chars
    // Daemon/Claude-injected `.claude/` churn that is NEVER the worker's committable product:
    //  (a) ANY UNTRACKED `.claude/` entry — the skills injection AND Claude Code's own per-session writes
    //      (e.g. `.claude/settings.local.json` from acceptEdits permission persistence). Kept broad so that
    //      churn keeps being swallowed; narrowing this prefix would surface it as phantom "work".
    //  (b) the daemon-injected SKILLS subtree at ANY status. injectSkills re-copies `~/.loom/skills/<name>`
    //      into `.claude/skills/<name>` on every spawn; in a repo that TRACKS a colliding skill name the
    //      re-copy surfaces as a TRACKED modification (` M …`/`A  …`), not `??`, so the untracked-only rule
    //      (a) misses it and boot-reconcile Pass B reads a genuinely-clean worktree as "has work". This drop
    //      closes that leak. (Loom never commits `.claude/skills/`; it is injected per-session + git-excluded.)
    if (status === "??" && isDoctrineArtifactPath(p)) continue;
    if (isDoctrineSkillsPath(p)) continue;
    files.push(p);
  }
  return files;
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
 * worker_report(done) PRE-CHECK (board card 907b9f50): catch a worker that forgot to commit AT THE SOURCE,
 * before its task is moved to review. The merge gate only ever sees COMMITTED work on the assigned branch,
 * so a "done" with uncommitted work (or 0 commits) sails to review and bounces back a round-trip later —
 * this surfaces it immediately, to the worker that can still fix it.
 *
 *   - DIRTY working tree (real uncommitted/untracked changes, `.claude/` noise ignored) → {uncommitted:true,
 *     files} ⇒ the caller REFUSES the done and keeps the task in_progress so the worker commits + re-reports.
 *   - CLEAN but the assigned `branch` is 0 commits ahead of `base` → {zeroAhead:true} ⇒ the caller WARNS only
 *     (a genuine no-op task can legitimately report done — never a hard refusal).
 *   - otherwise (clean + ahead, the normal path) → all-false, `aheadCount` set to the verified count ⇒
 *     the done proceeds unchanged (the caller separately refuses a `report.noChanges:true` claim against
 *     this verified-positive `aheadCount` — see board card 6b605d15 — but that check lives in the caller,
 *     not here: this function only ever reports the git-verified facts).
 *
 * FAILS SAFE: every git op is bounded by the same block-timeout + {@link withTimeout} guard as the other
 * helpers, and ANY error/timeout/parse-failure degrades to {uncommitted:false, zeroAhead:false} (ALLOW) —
 * a flaky git call must NEVER wedge a worker on a legitimate done (mirrors {@link detectStrandedWork}). This
 * is INDEPENDENT of — and composes with — the divergent-branch stranded backstop at the merge gate. The git
 * seam is injectable ({@link BoundedGitDeps}) so a test can prove the detection AND the fail-safe bound.
 */
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

/**
 * SAFE-TO-DISCARD guard for boot-reconcile Pass B (P0 data-loss fix, 2026-06-05). Does this worktree
 * still hold work we'd LOSE by deleting it? "Work" = EITHER the working tree is DIRTY (real
 * uncommitted/untracked changes — see {@link worktreeStatusHasWork}, which ignores daemon-injected
 * `.claude/` noise) OR the branch is AHEAD OF `base` (commits not yet reachable from the canonical
 * HEAD — `git rev-list --count base..branch` > 0).
 *
 * THE BUG IT GUARDS: a `daemon_restart` marks EVERY prior-run session `exited` at boot, so an unrelated
 * manager's LIVE worker is misdetected at boot and its worktree deleted mid-task, pre-commit (confirmed
 * data loss, 2026-06-05). Originally TWO vectors were gated by this single guard: Pass B GC'ing any
 * exited+unprotected worktree (the branch-AHEAD case), and Pass A treating a 0-commit branch as a merged
 * orphan (its tip == HEAD). ⚠️ Card 9cb0287a (2026-08-29): the Pass A vector is STALE — under squash
 * (see {@link findLandedSquashCommit}), Pass A no longer calls this function at all; it now requires
 * POSITIVE proof of a landed squash via the deterministic `Loom-Worker-Branch` trailer before ever
 * finalizing, and deliberately does NOT re-apply this guard (see `reconcileOrchestrationOnBoot`'s own
 * comment on that call). A worker Pass A can't positively confirm landed simply falls through untouched
 * to Pass B, where THIS guard is the sole remaining line of defense — verified (card 9cb0287a) to be the
 * function's ONLY call site (`git grep -n "worktreeHasWork(" -- packages/daemon/src`).
 *
 * FAILS SAFE: every op is bounded by the same block-timeout + {@link withTimeout} guard as the other
 * reconcile ops, so the check itself can never wedge boot; on ANY timeout/error/parse-failure we return
 * TRUE (assume work) so a wedged or locked check can never CAUSE a delete. Worst case we keep a
 * discardable dir for the next pass — never the reverse. The git seam is injectable ({@link BoundedGitDeps})
 * so a test can prove both the work-detection and the fail-safe bound.
 */
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

/**
 * MERGE-GATE BACKSTOP (2026-06-10): catch a worker whose commits are STRANDED on a self-created branch
 * instead of its assigned `loom/<key>`. The bug it guards: when a worker commits to a branch it cut
 * itself, the assigned branch stays 0 commits ahead of canonical main, so reviewWorkerMerge reads an
 * empty diff and confirmWorkerMerge does an empty squash merge (nothing staged) — the real work is
 * silently lost (incident: worker `712fd5aa`, commit `1309552` stranded).
 *
 * Logic: mainSha = canonical repo HEAD. If `rev-list --count mainSha..assignedBranch` > 0 the work is on
 * the assigned branch (the normal path) → NOT stranded. Otherwise read the WORKTREE's actually-checked-out
 * branch (`rev-parse --abbrev-ref HEAD`) and its `rev-list --count mainSha..HEAD`; if that count > 0 AND
 * the worktree branch != the assigned branch, the worker's commits live on a divergent branch → STRANDED,
 * returning the worktree branch, its short tip SHA, and the ahead-count for the warning/refusal.
 *
 * FAILS SAFE: every op is bounded by the same block-timeout + {@link withTimeout} guard as the other
 * helpers, and ANY error/timeout/parse-failure returns `{stranded:false}`. Only an AFFIRMATIVE stranded
 * signal ever warns or refuses — a check failure must NEVER block a legitimate merge. The git seam is
 * injectable ({@link BoundedGitDeps}) so a test can prove both the detection and the fail-safe bound.
 */
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

/**
 * ADMISSION-TIME PREFLIGHT (card 4b7ff996): catches, BEFORE the build/DoD gate ever runs (an ~8-17min cost
 * observed live on this repo), a branch whose squash can structurally never land — because the CANONICAL
 * repo already has unstaged tracked changes on a path the branch itself touches. `git merge --squash`
 * refuses to overwrite unstaged local modifications (it errors instead of silently clobbering them) —
 * {@link mergeBranchLocked} hits exactly this as a `rawError` deep inside the squash (see its own
 * `dirtyOverlap` signature-detection there), but only AFTER a full gate run has already paid for the
 * worktree build/test cost. This is the SAME question asked cheaply, up front.
 *
 * ⚠️ CR CORRECTION (card 4b7ff996, first-round review): "any unstaged status on a path in
 * `merge-base..branch`" is BROADER than what `git merge --squash` actually refuses on
 * (`ERROR_NOT_UPTODATE_FILE`, raised only for a path the squash must ACTUALLY WRITE whose worktree
 * content differs from the index) — the first draft's naive path-set intersection produced THREE confirmed
 * false refusals against real git 2.47, each now excluded by one of the three narrowing steps below:
 *
 * (i) ALREADY-LANDED CONTENT (the worst — this card's own `46ebf16e` out-of-band-resolution shape: main
 *     independently already carries the branch's exact content, canonical is separately re-dirtied on the
 *     SAME path). `git merge --squash` doesn't touch a path at all when applying the branch's diff would
 *     be a no-op against CURRENT `HEAD` (verified empirically: "Squash commit — not updating HEAD /
 *     Automatic merge went well", 0 staged) — so it never hits the unstaged file underneath. Excluded by
 *     dropping any candidate whose content is IDENTICAL between the CURRENT canonical `HEAD` and the
 *     branch tip (`changedPathsBetween(git, "HEAD", branch, …)` — deliberately `HEAD`, not `mergeBase`:
 *     `mergeBase..branch` only proves the branch changed the path RELATIVE TO ITS OWN FORK POINT, which
 *     says nothing about whether `HEAD` has since independently converged on identical content).
 * (ii) UNSTAGED DELETE (` D`). A deleted-but-unstaged path is NOT what `--squash` refuses on: git restores
 *      it from the index and stages the branch's own change cleanly — reproduced against real git.
 *      Excluded by restricting the dirty-candidate set to worktree status `Y === "M"` (a real content
 *      MODIFICATION) — the only `Y` value `ERROR_NOT_UPTODATE_FILE` actually fires for.
 * (iii) SUBMODULE GITLINK (` M`, mode `160000`). card `06b5c47f` already established that a submodule's
 *       checked-out commit sitting ahead of its recorded pointer is a NORMAL steady state, not residue —
 *       "could block a legitimately-configured repo's merges PERMANENTLY" (that doc, ~5030-5034) — and
 *       this preflight would have REINTRODUCED exactly that regression for the narrower "branch also bumps
 *       the pointer" case. `git merge --squash` does not error on it (proven both standalone and, now,
 *       specifically for the overlap case by this file's own test). Excluded via a `git ls-files --stage`
 *       mode check (`160000` = gitlink).
 *
 * These three checks run ONLY over the small overlap-candidate set (dirty ∩ branch-changed), never over
 * the whole repo, so the extra git calls stay cheap regardless of repo size.
 *
 * Only UNSTAGED overlap is checked here — a STAGED-dirty canonical repo is checked by a SEPARATE sibling,
 * {@link detectCanonicalStagedDirt} (also called from the SAME admission preflight, card 4b7ff996 CR
 * follow-up — see that function's own doc for why it needed its own admission-time hoist too).
 *
 * FAILS SAFE like {@link detectStrandedWork}: any git error/timeout returns `{overlap:false,
 * probeFailed:true}` — a flaky probe must never itself block a legitimate merge; the branch simply
 * proceeds to the real gate/squash, which still catches (and explains) the genuine case if it's still
 * there by then. The `probeFailed` flag + the log line in the catch exist so a PERMANENTLY broken probe
 * (e.g. a git binary issue on this host) is at least observable, rather than silently indistinguishable
 * from "genuinely never has an overlap" forever.
 */
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

/**
 * The worktree's latest commit that the WORKER itself authored — the gate-timeout circuit breaker's
 * (card 3564fd1e) "did a real fix land" signal, INVARIANT to `mergeMainIntoWorktree`'s union-merge.
 *
 * THE BUG THIS CLOSES: `confirmWorkerMerge` runs the union-merge (a real `git merge --no-edit mainSha`,
 * FIRST-parent = the worktree's prior HEAD, second-parent = main's tip) BEFORE the breaker check/record —
 * so whenever main has advanced since the branch was cut, plain {@link getWorktreeHeadSha} returns the
 * NEW merge commit's sha every single confirm attempt, indistinguishable from the worker having pushed a
 * genuine fix. The breaker's clear-on-HEAD-advance was defeated: it cleared the streak on every confirm
 * and could never trip on the merge path — exactly the "hanging test while main keeps moving" case it
 * exists to catch.
 *
 * `git rev-list --first-parent --no-merges HEAD --max-count=1` walks the FIRST-parent chain from HEAD
 * (which — because `mergeMainIntoWorktree` always merges main INTO the worktree, never the reverse — is
 * always the worker's OWN branch history, not main's) and skips any merge commit in that chain, returning
 * the latest commit the worker actually authored. A union-merge only ever ADDS a merge commit on top; it
 * can't change this value. A genuine worker commit (fixing the hang) DOES change it. On the run_gate path
 * (no union-merge, so HEAD is never a merge commit to begin with) this returns the exact same sha
 * {@link getWorktreeHeadSha} would — fully backward-compatible there.
 *
 * Fail-safe like its sibling: any error/timeout (including a HEAD with no non-merge ancestor, e.g. an
 * all-merge-commits worktree, which `rev-list` simply returns empty for) returns `null` — the breaker
 * caller treats that as "can't tell, don't reset."
 */
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
  /** sha256 over `git status --porcelain` + `git diff HEAD` when `dirty` — content-level for TRACKED
   *  changes (staged or unstaged). `null` when clean or unreadable. KNOWN GAP: editing the CONTENT of an
   *  already-untracked new file IN PLACE (no `git add`, no commit) changes neither input, so that exact
   *  edit is invisible to this hash — accepted here because the reported incidents (card 50c1e0d0) were
   *  edits to an EXISTING tracked file, not a brand-new untracked one.
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
    if (!worktreeStatusHasWork(porcelain)) return { head, dirty: false, dirtyHash: null };
    // Best-effort: a `diff HEAD` failure still yields a (slightly weaker, porcelain-only) comparable hash
    // rather than aborting the whole stamp — the outer try/catch is reserved for a genuinely unreadable
    // worktree (rev-parse/status themselves failing).
    const diff = await withTimeout(git.raw(["diff", "HEAD"]), timeoutMs, "gate-stamp diff HEAD").catch(() => "");
    const dirtyHash = createHash("sha256").update(porcelain).update(diff).digest("hex");
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

/**
 * Translate a glob (supporting `**`, `*`, `?`) to an anchored RegExp matched against a POSIX,
 * repo-relative path. `**` (optionally `/`-bounded) crosses directories and may match zero segments;
 * `*`/`?` stay within a single segment. No `{a,b}` brace expansion — keep the surface small and
 * predictable. (Deliberately a small local copy rather than importing `mcp/repo-read.ts`'s equivalent —
 * this git-layer module shouldn't reach up into the mcp layer for a 15-line helper.)
 *
 * A BARE leading `*` with no `/` anywhere in the pattern (e.g. `*service.ts`) is auto-prefixed with a
 * `**` + `/` (zero-or-more-dirs) segment before translation: as written, `*` stays within one path
 * segment, so `*service.ts` only ever matches a ROOT-level file and silently misses
 * `packages/daemon/src/sessions/service.ts` — the "matched 0 files, indistinguishable from no changes"
 * trap (task 91d847db). A caller writing a bare filename glob almost always means "match this file
 * anywhere", so that's the least-surprising behavior. Patterns that already scope a directory (contain
 * `/`) or already cross boundaries (start with `**`) are left untouched — only the fully-bare,
 * single-segment case is rewritten.
 */
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
 * Deliberate markers a human writes to declare a card's premise dead — each must appear as its OWN
 * line in the body (see {@link lineAnchoredMarker}), NOT merely be mentioned anywhere in prose. This was
 * originally a bare `\bretracted\b` substring match over the whole body; two live false positives (card
 * `e7bcb0df`'s "the retracted count-floor idea", a discarded design option, and card `66d91a11`'s "...and
 * retracted before I'd checked", a person retracting a belief) proved that "retraction" is an open
 * vocabulary no keyword list converges on. Line-anchoring converts it to a closed one: a human declaring
 * a card's premise dead writes a dedicated line (e.g. a `RETRACTED` heading), they don't rely on the word
 * merely appearing somewhere in the body. Kept narrow on purpose (card cf60a32a, narrowed `637558ca`): a
 * heuristic here is only acceptable because it keys on a deliberate declaration a human chose to write,
 * never on inferred intent.
 */
const RETRACTION_MARKER_RES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "retracted", re: lineAnchoredMarker("retracted") },
  { label: "won't-do", re: lineAnchoredMarker("won'?t-do") },
  { label: "not a bug", re: lineAnchoredMarker("not a bug") },
];

/**
 * The retraction-vs-title merge-review warning's matching primitive (card cf60a32a — the mechanical half
 * of `0fa32321`; doctrine half merged as `514da7cf`). A card's BODY can be retracted after its TITLE was
 * already written (and already valid Conventional form, so `toConventionalSubject`/`coerced` — card
 * `b88704bb` — is a no-op passthrough and stays blind to this case entirely). Card title = squash-commit
 * subject on this project, so an un-retitled `fix(…)` merging over a retracted premise stamps a fix for a
 * bug that never existed into permanent mainline history.
 *
 * KNOWN BLIND SPOT (card `a29ee2a6`, measured 2026-08-29 against the live `loom.db`, read-only, positive-
 * controlled against the origin incident `c7bf65aa`): this reads the card's CURRENT title+body only — a
 * retraction stated solely in a session transcript, never written into the card, is invisible here. The
 * one confirmed real specimen of that exact shape (`c7bf65aa` itself) never actually merged, so it caused
 * no harm. But transcript-only silence turned out to be the RARE case, not the common one: of 314 tasks
 * (all projects on this daemon) whose title or body mentions "retract", 87 had a title currently starting
 * `fix(`; of THOSE, only 9 (~10%) matched this exact regex and 78 (~90%) did not. Manually reading ~20 of
 * those 78 found the large majority ARE genuine premise-retraction narratives written into the body — just
 * phrased as free-form prose or a decorated heading ("PREMISE RETRACTED", "RETRACTED BY THE AUTHOR/
 * MANAGER", an emoji-prefixed heading, or "retraction" rather than "retracted") that this deliberately
 * narrow regex does not match. Of that same ~20-specimen sample, every one that had actually merged either
 * matched this regex anyway or had its title corrected before merge by human discipline (the
 * retitle-before-merge doctrine, `0fa32321`/`514da7cf`) — no false `fix(...)` subject was observed to have
 * landed on mainline history in that sample, despite the regex missing most of it. Widening this function
 * to read transcripts is NOT supported by that measurement; loosening the regex to catch more of the
 * body's own existing free-form phrasing is the more promising, still-unexplored lever.
 *
 * Returns the matched marker label when the TITLE still starts with the literal `fix(` (lowercase, this
 * project's Conventional Commits type casing) AND the BODY carries one of {@link RETRACTION_MARKER_RES}
 * as its OWN standalone line — else `null`. PURE (no I/O), so trivially unit-tested; mirrors
 * {@link matchAddedDenyGlobs}'s shape.
 */
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

/**
 * Content-reachability check (board card e076d2a2, item 2): does `sha`'s tree ACTUALLY contain `branch`'s
 * own changes, not merely carry its trailer text? Under the squash+commit race the per-repo mutex above
 * now closes, a commit can bear one branch's `Loom-Worker-Branch` trailer while its content belongs to a
 * DIFFERENT branch entirely (reproduced against real git — see test/merge-content-reachability.mjs) — a
 * `--grep` trailer match alone is a CLAIM, not proof. This verifies the claim: diff the branch's OWN
 * changed files (relative to its merge-base with `sha`) between `sha`'s tree and the branch tip's tree —
 * zero difference over EXACTLY that path set proves `sha` carries the branch's content verbatim.
 *
 * FAILS CLOSED, deliberately the OPPOSITE default from `findLandedSquashCommit`'s own fail-safe: any git
 * ERROR, or the two trees genuinely differing on the branch's own paths, returns `false` — NOT VERIFIED —
 * so the caller falls through to attempting a real merge instead of trusting an unproven "landed" claim. A
 * false `false` just costs a redundant (safe, idempotent) merge attempt; a false `true` is the exact
 * silent-data-loss bug this card exists to close, so ambiguity must never resolve to `true`.
 *
 * OUTPUT-based, NOT exit-code based (mirrors `mergeBranch`'s own `staged`/`conflicted` checks — see
 * {@link isBranchMerged}'s doc): simple-git's `raw()` does NOT reliably reject on a command whose nonzero
 * exit is a normal BOOLEAN signal rather than a real failure (`--is-ancestor`, `diff --quiet`) — a first
 * version of this check used `git diff --quiet`'s exit code and silently always resolved `true`, the exact
 * false-positive this function exists to prevent. `git diff --name-only` has no such ambiguity: any output
 * at all means a real difference.
 */
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

/**
 * The raw changed-path list between `base` and `ref` — the single git-diff invocation {@link
 * changedPathSetDigest} and {@link isInertMergeDiff} BOTH build on (Code Review, card db9b0130: extracted
 * after the two calls were found to have drifted into byte-identical copies of the same `git diff` args —
 * two copies of a load-bearing flag is precisely the mechanism that makes losing one dangerous, see
 * `--no-renames` below).
 *
 * `--no-renames` is LOAD-BEARING for BOTH callers, for two DIFFERENT reasons — neither is optional:
 * - {@link changedPathSetDigest}: counts a rename as its two raw (deleted, added) paths rather than
 *   resolving it through git's own rename-detection heuristic, so the digest stays independent of that
 *   heuristic ever changing (its own similarity threshold, algorithm, etc.).
 * - {@link isInertMergeDiff}: PROVEN on git 2.47.0 (Code Review) — with git's default rename detection
 *   left ON, `git diff --name-only` after `git mv src/x.ts docs/x.ts` prints ONLY `docs/x.ts`; the deleted
 *   `src/x.ts` vanishes from the list entirely. Without `--no-renames`, a branch that RELOCATES a real
 *   source file into an allowlisted prefix would misclassify as an inert docs-only diff and the gate would
 *   be skipped while that source file silently leaves main un-gated — see `merge-gate-inert-diff.mjs`
 *   scenario (F), which pins this: it renames a source file committed on the BASE into `docs/` and
 *   asserts the diff still full-gates, so dropping `--no-renames` turns that arm RED.
 *
 * `-c core.quotePath=false` disables git's default C-style octal-escaping of non-ASCII path bytes (Code
 * Review, PROVEN: with the default `core.quotePath=true`, a path like `docs/café-findings.md` is emitted
 * quoted/escaped, e.g. `"docs/caf\303\251-findings.md"`). Without this, {@link isInertMergeDiff}'s own
 * `startsWith` allowlist check would silently miss a non-ASCII docs filename — FAILS CLOSED (safe: it just
 * forces an unnecessary full gate), but with no visible signal as to why, so disabling the quoting removes
 * the gap rather than merely tolerating it.
 *
 * Each raw line has only its trailing `\r` stripped (never a generic `.trim()`, which could in principle
 * widen an allowlist prefix match against a hypothetical directory literally named with leading/trailing
 * whitespace, e.g. `" docs"` — reasoned, not observed, but zero-cost to close): git's own `--name-only`
 * output uses `\n` line endings even on Windows, so this only ever strips a stray CR, never real path
 * content.
 *
 * A THIRD caller depends on the same two flags for the same reasons, without being built on this shared
 * helper: {@link computeEmitCompareGate} issues its own `git diff --name-status` invocation (it needs
 * per-path STATUS, which `--name-only` doesn't carry) with `--no-renames` and `-c core.quotePath=false` set
 * identically, and inline-only — a non-ASCII `docs/café-findings.md` must still match {@link
 * isInertMergePath}'s `startsWith("docs/")` check there too (card b97f643d added the second real
 * `startsWith` allowlist consumer of a diff this file produces). Not duplicated here as a THIRD copy of the
 * flag list to keep in sync — see that call site's own comment for why `--name-status` couldn't reuse this
 * function directly.
 */
async function changedPathsBetween(
  git: Pick<SimpleGit, "raw">, base: string, ref: string, timeoutMs?: number,
): Promise<string[]> {
  const args = ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", `${base}..${ref}`];
  const raw = timeoutMs === undefined
    ? await git.raw(args)
    : await withTimeout(git.raw(args), timeoutMs, "git diff --name-only (changed paths)");
  return raw.split("\n").map((s) => s.replace(/\r$/, "")).filter(Boolean);
}

/**
 * Deterministic digest (sha256) over the SORTED set of paths changed between `base` and `ref` —
 * newline-joined after sorting so traversal order never matters. See {@link changedPathsBetween} for the
 * shared git invocation (incl. why `--no-renames` matters for this specific caller).
 *
 * WHY A PATH SET AND NOT A CONTENT HASH (card f621f185 — the deleted-branch residual of e076d2a2's
 * content-reachability check): the obvious next move — hash the branch's changed (path, blob-sha) pairs
 * and verify it later from `sha^..sha` alone (no branch ref needed, so it'd survive both branch deletion
 * AND `git gc`) — was PROTOTYPED and FALSIFIED against real git before landing here. It breaks on an
 * entirely HONEST merge: if main advances (after the branch was cut) with a non-conflicting edit to a file
 * the branch ALSO touches, the pre-image blob at that path differs between `mergeBase..branch` (recorded
 * at merge time) and `sha^..sha` (recomputed later, where `sha^` is main's ADVANCED tip, not the branch's
 * original fork point) — and the post-image blob is a 3-way-merged blend of both sides' edits, matching
 * neither side's own post-image either. Both compares disagree on a commit that landed PERFECTLY correctly,
 * which would fail closed (safe) but silently flip an honestly-merged task's board `merged` field to
 * null/unverified going forward — worse than the gap it closes on exactly the busiest, most-contended
 * files. Reproduced and confirmed dead in that exact shape before this function was written.
 *
 * The touched PATH SET does not have this failure mode: a non-conflicting edit to a shared file does not
 * change WHICH paths the squash's own diff touches on either side of the compare (the file was already
 * going to appear in both diffs regardless of whose edit is in it), so it stays stable under concurrent
 * main movement. The tradeoff this accepts (an explicit, narrower residual than the content-hash idea):
 * two DIFFERENT branches that happen to touch the exact same set of paths would not be told apart by this
 * check alone. That is deliberately judged acceptable — the incident this card responds to (`fb1dbb2`)
 * had completely disjoint path sets (`db.ts`/`gateway/server.ts` landed under a trailer claiming a `pty`
 * change), which a path-set digest catches cleanly, and Loom's own "one logical change per task" doctrine
 * makes two unrelated tasks sharing an identical touched-path set an unlikely coincidence rather than the
 * common case a content hash would otherwise need to guard against.
 *
 * A second, narrower false-negative (fails closed, so safe, just worth naming so a future reader doesn't
 * mistake it for a bug): if main independently lands the IDENTICAL change to a path the branch also
 * touches (not just a non-conflicting edit to the SAME file, but the exact same resulting content at that
 * path), that path drops OUT of the squash's own `sha^..sha` diff entirely — a no-op — while it remains in
 * the digest recorded at merge time from `mergeBase..branch`. The two path sets then genuinely differ, an
 * honest merge mismatches, and the caller falls through to null/a redundant merge attempt. Rare (main and
 * the branch would have to land the exact same bytes independently), never unsafe.
 */
async function changedPathSetDigest(
  git: Pick<SimpleGit, "raw">, base: string, ref: string, timeoutMs?: number,
): Promise<string> {
  const paths = (await changedPathsBetween(git, base, ref, timeoutMs)).sort();
  return createHash("sha256").update(paths.join("\n")).digest("hex");
}

/**
 * Path prefixes PROVEN to hold nothing compiled, tested, or read at runtime by the LOOM daemon test suite
 * SPECIFICALLY — card db9b0130. Verified 2026-08-05: `grep -rnE "(readFileSync|existsSync|readdirSync|
 * createReadStream)\([^)]*docs" packages/daemon/test/*.mjs` ⇒ zero hits (the identical pattern against
 * `assets` ⇒ non-zero, so the zero is a real absence, not a broken pattern — see the card for the full
 * positive control), and the one `docs/` path a test file's own comment cites (`test-daemon-gate-
 * timing.mjs`) is a provenance citation, never a real read. Deliberately narrow and NOT extension-based:
 * `assets/**` is markdown too, and IS heavily tested (10 test files reference it) — an extension check
 * would wrongly classify a `SKILL.md` change as inert. ⛔ Do not widen this list without re-running that
 * same grep against the new prefix first — the whole point is that every entry here is a MEASURED
 * absence, not an assumption.
 *
 * ⭐ Card 9fcc29bb — WHY `assets/skills/**` IS DELIBERATELY EXCLUDED, NAMED: markdown under `assets/**` is
 * product behaviour, not incidental content, and it IS asserted on by name — `redirect-discoverability.mjs`
 * and `skills-seed-asset-override-default.mjs` both read real checked-in `assets/skills/<name>/SKILL.md` files
 * as their comparison oracle. `packages/daemon/test/merge-gate-inert-diff.mjs` scenario (B) is the guard
 * that ENFORCES this stays excluded — it commits a branch whose entire diff is one `SKILL.md` under
 * `assets/skills/**` and asserts the gate command still genuinely RAN (a call counter, not a trusted
 * return value). Extending this list to cover `assets/**` would require deliberately breaking that named
 * safety case; see this list's own doc above, not a fresh investigation, before ever proposing it again.
 * (The asymmetry is a deliberate trade, not an oversight: a merged `assets/skills/**` change isn't live
 * until a daemon restart anyway, and only auto-advances there for a `customized:false` skill — a faster
 * gate wouldn't make it ship any faster.)
 *
 * ⚠️ A future MULTI-SEGMENT entry (e.g. `"site/docs/"`) needs its OWN
 * re-measurement, not just a re-run of the same grep: {@link repoTreeReferencesInertPrefix}'s scan
 * requires `site/docs` to appear CONTIGUOUS on one line, which `path.join(__dirname, "site", "docs")` —
 * an entirely ordinary way to write that path — never produces, a silent false negative for exactly the
 * shape this list plausibly grows into (Code Review, card 1c0d4aa4).
 *
 * ⚠️ THAT MEASUREMENT IS LOOM-ONLY, BUT {@link isInertMergeDiff} RUNS FOR EVERY PROJECT THIS DAEMON
 * SERVES (card 1c0d4aa4, Code Review finding on `b97f643d`) — a consumer project whose own tests DO read
 * a top-level `docs/` must not have its gate silently skipped just because Loom's don't. This is why
 * `isInertMergeDiff` does not trust this list alone: it re-verifies PER-REPO, at gate time, via
 * {@link repoTreeReferencesInertPrefix} — this list stays a cheap first-pass allowlist (a path outside it
 * still fails closed immediately, no scan needed).
 *
 * 🔴 CORRECTION (card 0910531e, Code Review finding on `1c0d4aa4`): this doc used to claim the per-repo
 * scan ALONE "is the thing that actually makes a `true` result safe to trust for a project other than
 * Loom." That was false — {@link repoTreeReferencesInertPrefix}'s read-call/anchor vocabulary
 * (`readFileSync`, `__dirname`, `import.meta.url`, …) is JS/TS-only lexically, so it can NEVER match in a
 * Python/Go/Rust/Ruby repo; `git grep` there always returns its "no match" exit code, which the scan used
 * to treat as a CONFIRMED absence — a 100% false-negative for every non-JS/TS project, reproduced with a
 * paired-language control (identical dependency, differing only in language) in that card. The scan is now
 * safe to trust for a project other than Loom ONLY because it first proves it can even apply to this
 * repo's language — see {@link repoTreeHasJsTsSourceFile} — before ever treating a "no match" as meaning
 * anything.
 */
const INERT_MERGE_PATH_PREFIXES = ["docs/"];

/**
 * Whether a single path falls under an {@link INERT_MERGE_PATH_PREFIXES} prefix — the ONE predicate both
 * {@link isInertMergeDiff} (below) and {@link computeEmitCompareGate}'s classification loop (further down
 * this file) test against, so the boundary semantics `merge-gate-inert-diff.mjs` scenario (G) pins
 * (`docs-internal/`, `docsfoo.md` must NOT match) can never drift between the two call sites — card
 * b97f643d, Code Review: reusing the LIST alone still left the `startsWith` PREDICATE written twice, which
 * is the identical divergence risk one level down from a second hand-copied list.
 */
function isInertMergePath(p: string): boolean {
  return INERT_MERGE_PATH_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Whether every path changed between `baseSha` and `ref` falls under an {@link
 * INERT_MERGE_PATH_PREFIXES} prefix — a provable property of the changed file SET, not a prediction about
 * test coverage (card db9b0130; this is a strict, safe subset of the deferred "scope the gate to the
 * diff" idea, `1055f5e3`, which infers coverage and is NOT what this does). A `true` result means a merge
 * gate for this diff cannot change any test outcome, so running one is pure wasted lane time; `false`
 * means "not proven inert" and the caller must run the gate exactly as before this existed. See {@link
 * changedPathsBetween} for the shared git invocation this is built on, INCLUDING why `--no-renames` is
 * load-bearing here specifically (a rename that relocates a real source file into an allowlisted prefix
 * would otherwise misclassify as inert) — carried there, not duplicated here, so it can't silently drift
 * out of sync between this function and {@link changedPathSetDigest}'s own copy again.
 *
 * FAILS CLOSED on every uncertain case, deliberately — a false `false` costs one ordinary gate run (safe,
 * the status quo); a false `true` would land an un-gated change that could have broken tests:
 * - A git error or timeout (can't read the diff at all) ⇒ `false`.
 * - Zero changed paths ⇒ `false` — nothing to prove inert from; let the ordinary no-op-merge handling
 *   (STAGE_EMPTY/ALREADY_MERGED) deal with a genuinely empty diff rather than special-casing it here.
 * - Any single changed path outside the allowlist ⇒ `false`. A brand-new/unknown top-level directory is
 *   not on the allowlist by construction, so it fails closed too — satisfying "an unrecognized path gates"
 *   without a separate check for it.
 * - Every changed path IS on the allowlist, but this repo's own corpus (per {@link
 *   repoTreeReferencesInertPrefix}) references the matched prefix, or that scan itself couldn't confirm
 *   otherwise (a spawn error, a non-"no-match" exit, a timeout) ⇒ `false` (card 1c0d4aa4 — see
 *   {@link INERT_MERGE_PATH_PREFIXES}'s own doc for why this re-check exists).
 */
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
  return true;
}

/** `git grep`'s own exit code for "searched the tree, found nothing" — the ONLY outcome {@link
 *  repoTreeReferencesInertPrefix} treats as a confirmed, real absence. Any other exit code (a bad
 *  revision, a corrupt object, git erroring) means the absence was never actually proven. */
const GIT_GREP_NO_MATCH_EXIT_CODE = 1;

/**
 * The SAME read-call NAMES {@link INERT_MERGE_PATH_PREFIXES}'s own measurement (card db9b0130) used to
 * prove Loom's corpus never reads `docs/` — reused here (card 1c0d4aa4) to make that same measurement
 * PER-REPO instead of Loom-only, PLUS one refinement db9b0130's own manual measurement needed a HUMAN to
 * apply and a mechanical scan cannot skip: that measurement's own 2026-08-27 re-verification (see this
 * card's provenance) found "exactly 2 hits, both `path.join(<tempRepo>, "docs", …)`" and judged them NOT
 * real reads BY HAND — both are `merge-gate-inert-diff.mjs` assertions against a THROWAWAY git repo the
 * test itself constructs at run time (`H.repo`, `wt2.worktreePath`, …), unrelated to this project's own
 * checked-out tree and structurally incapable of being affected by ANY diff under evaluation. A bare
 * "does the token 'docs' appear near a read-call anywhere" scan cannot tell that apart from a genuine
 * project-relative read and — measured directly — DOES regress Loom's own skip on exactly these 2 lines
 * (`inert-prefix-repo-scan.mjs` scenario (4) pins this as a live regression check, not a hypothetical).
 *
 * The fix: require the SAME call to ALSO reference a well-known REAL-SOURCE-TREE anchor (`__dirname`,
 * `__filename`, `process.cwd()`, `import.meta.url`, `import.meta.dirname`) somewhere in its argument
 * list — a fixture path built from a test-local variable (`H.repo`, `worktreePath`, an `os.tmpdir()`-
 * derived root) never carries one of these literally, while a test genuinely reading ITS OWN project's
 * `docs/` overwhelmingly does. Re-verified against the real Loom repo (`inert-prefix-repo-scan.mjs`
 * scenario (4), run AFTER committing — see that file's own header for why "before" doesn't prove
 * anything): with this anchor requirement, `docs` returns to a confirmed absence and `assets` (genuinely,
 * anchor-referenced, project-relative) still returns found.
 *
 * ANCHOR MAY APPEAR ON EITHER SIDE OF THE TOKEN (Code Review, card 1c0d4aa4) — `readFileSync(new
 * URL("../docs/x.md", import.meta.url))` puts the token FIRST, the ESM-idiomatic form for "a file next to
 * this module." An anchor-then-token-only match would silently miss it; {@link
 * repoTreeReferencesInertPrefix} matches `anchor…token` OR `token…anchor` for exactly this reason.
 *
 * NOT A PERFECT DISCRIMINATOR — THREE NAMED GAPS, NOT HIDDEN ONES (Code Review, card 1c0d4aa4, measured:
 * 11 realistic read shapes, 4 matched, 7 missed, ALL in the safe-to-fail-closed-on direction):
 * 1. INDIRECTION: a real read anchored through a locally-defined constant (`const ROOT =
 *    path.resolve(__dirname, "..")`, used on a LATER line) is invisible to this single-line, single-call
 *    scan.
 * 2. NESTED PARENS IN THE ANCHOR ITSELF: `readFileSync(path.join(path.dirname(fileURLToPath(import.meta
 *    .url)), "docs", "x.md"))` — THE standard `__dirname` replacement in ESM — closes THREE parens
 *    between the anchor and the token; `[^)]*` cannot cross a real `)`, so the second half of the bridge
 *    never reaches "docs". Genuinely out of reach for a line-based single-call regex — a real parser
 *    would be needed, and this file's own `computeEmitCompareGate` doc (see its "A HAND-ROLLED SCANNER
 *    LOOP IS NOT A SAFE SUBSTITUTE" warning, above) is exactly why one isn't attempted here.
 * 3. MULTI-LINE CALLS: `git grep` matches per-line by default; a prettier-wrapped call whose anchor and
 *    token land on different lines is invisible to this scan regardless of pattern.
 * Accepted deliberately, not silently: the alternative (no anchor requirement at all) is a CONFIRMED,
 * demonstrated false positive against Loom's own corpus, which the DoD requires not regressing; this
 * mechanism NARROWS the pre-card gap (100% false-negative for every non-Loom project) without claiming
 * to CLOSE it. See `computeEmitCompareGate`'s own doc (this file, "WHY NOT... resolve a changed fixture's
 * consumers") for the same reasoning applied to a sibling mechanism: a resolver that can miss a case is
 * still preferred here to no check at all, because the asymmetry is the same — a missed reference costs
 * one wrongly-skipped gate (bad), but that is what this whole mechanism already risked pre-card for EVERY
 * non-Loom project.
 *
 * ⚠️ A FOURTH gap, NOT one of these three, WAS hidden until card 0910531e: all three above are missed
 * SHAPES within a JS/TS repo — occasional, and only ever costing one wrongly-skipped gate on an unusual
 * call shape. The fourth was a whole-LANGUAGE class: this scan's read-call names and anchor tokens are
 * ALL JS/TS vocabulary, so in a Python/Go/Rust/Ruby repo NEITHER half could ever match — making a "no
 * match" a 100%, not occasional, false confirmed-absence for every non-JS/TS project this daemon serves.
 * {@link repoTreeHasJsTsSourceFile} closes exactly that gap (by refusing to trust ANY "no match" result
 * from a repo the scan's vocabulary could never have matched in the first place) without touching these
 * three, which remain the accepted residual risk described above.
 */
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
 */
const JS_TS_SOURCE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?)$/i;

/**
 * Whether `treeish` in `repoPath` has ANY tracked path ending in a {@link JS_TS_SOURCE_EXTENSION_PATTERN}
 * extension — i.e. whether {@link repoTreeReferencesInertPrefix}'s JS/TS-only read-call/anchor scan could
 * EVER match anything in this repo's tracked tree, independent of the `docs/`-specific token it searches
 * for. Card 0910531e (Code Review, finding on `1c0d4aa4`): the scan's own vocabulary (`readFileSync`,
 * `__dirname`, `import.meta.url`, …) is JS/TS-only lexically and can never appear in a Python/Go/Rust/Ruby
 * file — so in a repo with ZERO files at these extensions, `git grep`'s "no match" exit code is not
 * evidence of an absence, it is a TAUTOLOGY: the pattern was never capable of matching this repo's
 * corpus regardless of what that corpus actually reads. Reproduced with a paired-language control
 * (identical dependency, differing only in language: a Python project with a real `docs/`-reading test
 * still returned "no match" pre-fix) — see that card for the repro.
 *
 * This is a DIFFERENT question from "does this repo reference `docs/`" (what {@link
 * repoTreeReferencesInertPrefix}'s own grep answers) and is checked FIRST, before that grep's result is
 * ever trusted: `false` here means the grep result — whatever it is — carries no information, and the
 * caller must fail closed exactly as it already does for a git error or timeout. `true` here does not
 * assert the repo has NO other languages too (a mixed-language repo is common); it only asserts the scan
 * has SOMETHING to apply to, restoring it to the same trust level it already has for Loom itself and every
 * other JS/TS project.
 *
 * Lists the WHOLE tracked tree via `git ls-tree` (no content read, cheap) rather than scoping to the
 * `docs/`-adjacent paths specifically — deliberately: a project's JS/TS source is typically nowhere near
 * `docs/` (e.g. `src/`), so a scope restricted to the token's own directory would defeat the very thing
 * this checks. FAILS CLOSED on any git error/timeout (`applicable:false` ⇒ caller cannot trust an
 * absence), the identical asymmetry {@link repoTreeReferencesInertPrefix} already applies one level up —
 * `degradedReason` is set ONLY on that indeterminate path (a spawn error, a bad treeish, a timeout), never
 * on a genuine confirmed-empty result, so the caller can log an ACCURATE diagnostic instead of always
 * claiming "no JS/TS file found" even when the real cause was e.g. an unresolvable `treeish` (mirrors
 * {@link repoTreeReferencesInertPrefix}'s own `warnDegraded` distinguishing a confirmed no-match from
 * every other outcome).
 */
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

/**
 * Whether ANY file tracked at `treeish` in `repoPath` contains a call reading a path under `bareToken`
 * (e.g. `"docs"` for the `docs/` prefix) — i.e. whether THIS repo's own corpus, at the commit the diff is
 * based on, actually reads paths under that prefix, the same question card db9b0130's doc comment answers
 * for Loom by hand. Card 1c0d4aa4 (Code Review finding on `b97f643d`, "arguably the sharpest thing this
 * review surfaced"): {@link isInertMergeDiff} is applied to EVERY project this daemon serves, but
 * `INERT_MERGE_PATH_PREFIXES` was only ever measured against Loom's own corpus — a consumer project whose
 * OWN tests read a top-level `docs/` must not have its gate silently skipped just because Loom's don't.
 *
 * Uses `git grep` directly via `child_process.spawn` (not the `simple-git` `.raw()` wrapper the rest of
 * this file uses) SPECIFICALLY so the real process exit code is observable: `git grep`'s "no match" exit
 * code ({@link GIT_GREP_NO_MATCH_EXIT_CODE}) is the ONLY outcome this treats as a confirmed absence —
 * every other outcome (a spawn error, a non-1 nonzero exit, e.g. a bad `treeish`, or a timeout) resolves
 * `true` ("references it"), which forces {@link isInertMergeDiff} to run the full gate rather than trust
 * an unproven scan. This is the SAME fail-closed asymmetry {@link isInertMergeDiff} already applies to a
 * git error: a false `true` costs one ordinary gate run (safe); a false `false` would silently skip a
 * gate a project's own tests actually depend on.
 *
 * Scoped to `treeish` (the diff's own `baseSha`), never the repo's current working tree — deterministic
 * regardless of what happens to be checked out in `repoPath` at call time. NOTE: on a BLOBLESS PARTIAL
 * CLONE, `git grep <treeish>` is not unconditionally local — it fetches any missing blob content from the
 * promisor remote on demand (reproduced: a missing blob without network access fails the fetch, exit
 * 128, which is NOT {@link GIT_GREP_NO_MATCH_EXIT_CODE} and so still fails closed). Bounded by `timeoutMs`
 * like every other op in this file; never a wedge, just a new (small) network dependency this specific
 * call introduces that the rest of this file's bounded git reads don't have.
 *
 * ANY OUTCOME OTHER THAN A CONFIRMED MATCH (0) OR CONFIRMED NO-MATCH (1) IS LOGGED, not just fail-closed
 * silently — Code Review, card 1c0d4aa4: fail-closed alone made every degraded outcome (a missing `git`
 * on PATH, a `baseSha` that stops resolving, a partial-clone fetch failure) indistinguishable from an
 * ordinary gate run, with zero operator signal that the mechanism had silently stopped skipping ANYTHING,
 * forever, for that repo. `console.warn` (not `.error` — this isn't a request failure, the caller degrades
 * safely) with the captured stderr tail ({@link appendTail}/{@link formatTail}, same bounded ring the
 * provisioning helpers above use) so a persistently-broken scan is at least visible in the daemon's logs.
 *
 * POSITIVE-CONTROLLED by `inert-prefix-repo-scan.mjs`: that test proves this exact pattern fires against
 * a fixture repo built to trip it (a committed file whose body contains a real
 * `readFileSync(...docs...)`-shaped call) before trusting a zero result from it anywhere, and
 * `merge-gate-inert-diff.mjs` scenario (K) proves the end-to-end wiring: a repo whose own test file reads
 * `docs/` still forces the full gate on an otherwise docs/-only diff. ⚠️ Both fixtures deliberately build
 * their trigger text via string concatenation rather than a literal template — this file's OWN scan
 * would otherwise match the fixture-construction CODE in these very test files the moment they're
 * committed to THIS repo (Code Review, card 1c0d4aa4 — the Critical: a literal fixture body is
 * indistinguishable, byte-for-byte, from a real project read, and `isInertMergeDiff` scans this repo's
 * OWN tracked tree, its own tests included). See those files' own comments before changing either fixture.
 *
 * Exported (like {@link appendTail}/{@link formatTail}) for direct unit coverage independent of the full
 * {@link isInertMergeDiff}/`confirmWorkerMerge` call chain.
 *
 * 🔴 CARD 0910531e ADDITION: before trusting a `git grep` "no match" as a confirmed absence at all, this
 * now requires {@link repoTreeHasJsTsSourceFile} to have confirmed the scan's own JS/TS vocabulary could
 * even apply to this repo's tracked tree — see that function's doc for why a bare "no match" is otherwise
 * a tautology for a non-JS/TS project, never evidence.
 */
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
    const child = spawn("git", ["grep", "-I", "-l", "-E", pattern, treeish], {
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

/**
 * Skill NAMES touched by the diff between `base` and `ref` under {@link SKILL_ASSET_PREFIX} — card
 * 64a30c79: `skills/inject.ts` delivers a session's skills from the STORE (`<LOOM_HOME>/skills/<name>/
 * SKILL.md`), never from `assets/` directly, so a merge that lands an `assets/skills/<name>/**` change is
 * NOT live for any agent at merge time — only at the next daemon restart (a pristine/customized:false
 * skill) or an explicit adopt (a customized skill, which a restart never advances). This function only
 * DETECTS which skill(s) a diff touched; it asserts nothing about customization state (the caller reads
 * that from the live skill store) and changes no skill-loading behavior itself.
 *
 * Deduplicated + sorted; empty for a diff that never touches this prefix. Fails closed to `[]` on any git
 * error/timeout, same posture as {@link isInertMergeDiff} — a missed detection costs one missing (never a
 * wrong) warning line.
 */
export async function changedSkillNames(
  repoPath: string, base: string, ref: string, deps: BoundedGitDeps = {},
): Promise<string[]> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  let paths: string[];
  try {
    paths = await changedPathsBetween(git, base, ref, timeoutMs);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const p of paths) {
    if (!p.startsWith(SKILL_ASSET_PREFIX)) continue;
    const name = p.slice(SKILL_ASSET_PREFIX.length).split("/")[0];
    if (name) names.add(name);
  }
  return [...names].sort();
}

/** Compiled-source and non-compiled-test path scopes {@link computeEmitCompareGate} classifies changed
 *  paths into — see that function's own doc for why only these two, and why everything else fails closed. */
const EMIT_COMPARE_SRC_PREFIX = "packages/daemon/src/";
const EMIT_COMPARE_TEST_PREFIX = "packages/daemon/test/";

/** The static source-TEXT guards (Code Review, `docs/investigations/c4ccae66-.../findings.md`) — these
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
 *  ⚠️ Card 6bb60fd0 — THE GLOB IS WRONG IN A SECOND, MORE DANGEROUS DIRECTION TOO: it would also DROP
 *  `fixed-wait-witness-guard.mjs` from this list. That guard is diff-scoped (it greps the real `git diff`,
 *  not the test corpus) and so contains ZERO `readdirSync` occurrences — a `readdirSync` filter cannot
 *  find it BY CONSTRUCTION. Dropping it would recreate exactly the defect card a18c39ba shipped to fix:
 *  the guard silently inert on precisely the diff class it polices.
 *
 *  ⭐ THE SET RELATIONSHIP, ONCE: the `readdirSync` family and this list overlap in FOUR members and
 *  NEITHER CONTAINS THE OTHER — the family adds `emit-compare-soundness-guard.mjs` (deliberately excluded
 *  here, per the criterion above) and this list adds `fixed-wait-witness-guard.mjs` (deliberately included
 *  despite not matching the family's own `readdirSync` discriminator). A reader who assumes one is a
 *  subset of the other will reason wrongly in BOTH directions. Use `pnpm --filter @loom/daemon guards`
 *  (card 245a3708, below) to run exactly this list — never re-derive it from `readdirSync` or any other
 *  implementation detail that was never the membership criterion.
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
];

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
  /** Count of changed compiled `.ts` files proven transpile-identical — diagnostic only, surfaced by the
   *  caller so a skip is never silent (card 2154b6ad DoD-5). */
  identicalFileCount: number;
  reason?: string;
  /** Card 2db8a3dd (introduced this field), CORRECTED by card 4def0708 (the operational-failure sites
   *  below were originally documented — wrongly — as informative `false`; that was the exact bug 4def0708
   *  fixed). Produced by one of two explicitly-named constructors in {@link computeEmitCompareGate}, never
   *  a defaulted boolean param — see that function's own `notReducible`/`notApplicableHere` doc.
   *  `false` (via `notReducible`) on `eligible:true` (trivially — a proven-eligible diff was, by
   *  definition, evaluated against a repo this predicate applies to) and on every `eligible:false` reason
   *  that is a REAL, REPRODUCIBLE verdict about THIS diff's own content on a repo the predicate DOES cover
   *  (a non-modify status on a compiled file, an excluded-dir/underscore/shell-unsafe test path, "no
   *  eligible changed path left to prove inert", an unverified soundness precondition, or a transpile
   *  mismatch) — those are real, informative "ran, not reduced" verdicts.
   *  `true` (via `notApplicableHere`) on every reason that is NOT a verdict about reducibility: the
   *  catch-all "path outside emit-compare scope" (every changed path fails
   *  `EMIT_COMPARE_SRC_PREFIX`/`EMIT_COMPARE_TEST_PREFIX`, exactly what a repo whose sources don't live
   *  under `packages/daemon/src|test/` hits on its FIRST changed path, always), a failed load of
   *  `scripts/test-daemon.mjs`'s `EXCLUDED_DIR_NAMES`/`NOT_HERMETIC` from this diff's own worktree (that
   *  script doesn't exist outside Loom's own layout), an unresolvable `typescript` module (this whole
   *  mechanism's own dev-dependency, absent on a shipped end-user install), AND — corrected by card
   *  4def0708 — any OPERATIONAL/mechanism failure (a git error reading the diff/base/branch content, an
   *  empty diff, an unparseable diff line): a git error proves nothing about reducibility either way, so
   *  it must never be stamped as a decided "not reduced". ⭐ THE SIGNAL COMES FROM THE PREDICATE, NOT
   *  RE-DERIVED BY A CALLER: a caller must never re-sniff repo layout itself to guess this —
   *  `computeEmitCompareGate` already knows exactly which reason it returned, and this field is that
   *  knowledge surfaced, once, at the source. The caller's job is only to treat `notApplicable:true` the
   *  same way it already treats "the predicate never ran at all" (never report a fabricated `false` for
   *  it) — see {@link EMIT_COMPARE_SRC_PREFIX}'s own doc / `sessions/service.ts`'s
   *  `emitCompareNotApplicable`. */
  notApplicable: boolean;
}

/**
 * Whether a merge gate's ~668-test `test:daemon` runtime suite can be SKIPPED for this diff — card
 * 2154b6ad (owner-requested: two comment-only branches burned a full ~15min gate each). Distinct from
 * {@link isInertMergeDiff} above, which proves a diff can skip the gate ENTIRELY: this proves only that the
 * diff's COMPILED BEHAVIOR is unchanged, so `pnpm build` (real typecheck) and the static source-text guards
 * below still run UNCONDITIONALLY — only the runtime test suite itself is ever skipped, and only for
 * `packages/daemon/src/**\/*.ts` and a changed `test/*.mjs` file (handled separately below); a path already
 * certified inert by {@link INERT_MERGE_PATH_PREFIXES} is SKIPPED from classification entirely rather than
 * gating (card b97f643d — see that skip's own doc, just above the classification loop below, for why this
 * is sound: {@link isInertMergeDiff} must prove nothing anywhere in the gate reads the path at all, while
 * this function needs only the weaker "no still-running check reads it" — build, every static guard, and
 * any changed test file all still run — so the stronger certification implies the weaker one); every OTHER
 * path fails this diff closed to the full gate.
 *
 * WHY NOT "skip when the diff is comments-only" (Code Review, card 2154b6ad §2): five of the six static
 * guards under `packages/daemon/test/` grep raw FILE CONTENT — e.g. `clock-path-regression-guard.mjs`'s
 * `/Date\.now\(\)/` scan. A comment-only edit CAN flip one of them: a real owner branch (`6d53b02b`)
 * introduced the literal string `Date.now()` inside an explanatory comment in a `test/*.mjs` file. So
 * "comments only" alone is unsafe as a gate-SKIP predicate — this function never uses it as one. It only
 * ever widens what may be skipped (the runtime suite); the guards below always run regardless of what this
 * function decides about any `test/*.mjs` path, which is exactly what makes that counterexample
 * STRUCTURALLY impossible to mis-skip here, not merely avoided by care.
 *
 * WHY NOT "byte-identical full compiled emit" (the design originally proposed for this card, falsified by
 * measurement before being built, not after): `packages/daemon/tsconfig.json` never sets `removeComments`,
 * and TypeScript's default is `false` — comments are emitted VERBATIM into `dist/**\/*.js` (verified:
 * `grep -n "PROVEN on git 2.47.0" packages/daemon/dist/git/worktrees.js` — a real JSDoc sentence found
 * sitting in compiled output). A comment-only diff therefore produces a NON-identical full-program emit
 * under this repo's real compiler settings — that check would never have fired for the exact branches that
 * prompted this card. Not a dangerous mechanism, a dead one. Fixed here by transpiling each CHANGED file
 * ALONE with `removeComments:true` set EXPLICITLY for this throwaway comparison only (never for the real
 * `dist/` build, which must keep its comments for anyone reading compiled output) — see
 * {@link transpileIgnoringCommentsAndWhitespace}.
 *
 * ⚠️ A HAND-ROLLED SCANNER LOOP IS NOT A SAFE SUBSTITUTE FOR `ts.transpileModule` — left as a warning, not
 * quietly avoided: an earlier draft of this comparison drove `ts.createScanner` directly in a `while` loop
 * (a plausible-looking "real tokenizer, not a regex"). It DESYNCED on a template literal containing `${...}`
 * interpolation elsewhere in the same file — the scanner needs `reScanTemplateToken`/`reScanSlashToken`
 * calls at the right points to track what the real parser would see, and a bare `scan()` loop never makes
 * them. Observed failure, reproduced against this file's own `changedPathsBetween` doc comment: a large
 * multi-line JSDoc block got silently swallowed into the middle of an unrelated template-literal token, so
 * an edit INSIDE that comment flipped the verdict by accident, not because of the comment. `transpileModule`
 * uses the real parser and does not have this failure mode — reach for it, never a hand-rolled scan loop,
 * for anything claiming to compare "real tokens." (This is the card's own regex-comment-stripper trap
 * wearing a more respectable disguise — same defect, one level up.)
 *
 * SOUNDNESS PRECONDITION (Code Review, card 2154b6ad): comparing each changed file's transpile output IN
 * ISOLATION is only sound if no OTHER (unchanged) file's compiled behavior can depend on a changed file's
 * TYPE-only content. Two known TS mechanisms could break that — `emitDecoratorMetadata` (reflects a
 * decorated member's TYPE into runtime metadata another file could read) and `const enum` (its members are
 * INLINED at every use site program-wide, so a value edit in the enum's own file silently changes every
 * OTHER file that references it). Neither exists in this repo today, but {@link emitCompareSoundnessOk}
 * RE-CHECKS BOTH LIVE on every call rather than trusting this comment — a future tsconfig edit or a newly
 * added `const enum` would otherwise silently reverse this precondition with no other signal (see also
 * `packages/daemon/test/emit-compare-soundness-guard.mjs`, the committed regression test for the same
 * precondition).
 *
 * NOT A BUG, WORTH NAMING SO IT ISN'T "FIXED" LATER: a TYPE-ONLY edit (e.g. widening a parameter's type,
 * with no runtime-observable change) also transpiles identically and is therefore also proven eligible for
 * the skip. That is CORRECT, not a gap — types are erased before this comparison ever runs, so a type-only
 * change cannot change what the ~668 runtime tests observe, and `pnpm build` (which still runs
 * unconditionally) is exactly what re-typechecks it.
 *
 * FAILS CLOSED on every uncertain case, same asymmetry as {@link isInertMergeDiff}: a git error, an
 * unresolvable `typescript` module (e.g. a shipped end-user install with no devDependencies — this whole
 * mechanism is Loom-repo-specific and simply never engages there), any changed path outside the two scoped
 * prefixes, any non-`M` status (added/deleted/renamed) on a compiled file, or a failed soundness
 * precondition all return `eligible:false`. A false `false` costs one ordinary gate run; a false `true`
 * would land unverified behavior on main — the same asymmetry that decided every judgement call here.
 *
 * ANY EXCLUDED-DIR (`fixtures/`, `census/`) TOUCH FAILS THIS DIFF CLOSED — card 44968963, the decision
 * between two candidates. `815b4b30` (above) stopped a `fixtures/`/`census/` path from being pushed into
 * {@link EmitCompareGateResult.changedTestFiles} and run AS a test — correct, since the full suite's own
 * discovery walk never descends there either. But that fix left a gap: a diff changing a shared fixture
 * PLUS one of its consumer test files still reached `eligible:true` (the consumer alone proves eligibility),
 * running only that one consumer while the fixture's OTHER consumers — outside the diff, unrun by either
 * gate — could equally have broken. Measured on this repo (card 44968963 DoD-1): `fake-codescape-cli.mjs`
 * has 6 consumers, `echo-env.mjs` has 3 — this is a real, reachable exposure, not a hypothetical one.
 *
 * The candidate that would have PRESERVED speed here — resolve a changed fixture's consumers and fold them
 * into `changedTestFiles` — was rejected. Every real consumer in this repo names its fixture the same way:
 * `path.join(__dirname, "fixtures", "<literal-basename>.mjs")` — a computed path, not an `import`, so a
 * resolver can only ever be a TEXTUAL heuristic (grep the fixture's basename across `test/**`), never a
 * structural one. That heuristic happens to find all of today's consumers, but "happened to find them all"
 * is exactly the standard this card's own DoD-3 rules out (a guessed resolver that misses a consumer is
 * WORSE than always running the full gate, because a clean `eligible:true` LOOKS precise while silently
 * proving nothing for the consumer it missed) — and nothing stops a future test file from referencing a
 * fixture through a shared constant, a computed/interpolated name, or an indirection this repo doesn't use
 * today, none of which a basename grep would ever see. There is no way to PROVE such a resolver cannot miss
 * a consumer, only ways to observe that it hasn't yet — so it fails the same asymmetry as everything else in
 * this file: a wrong skip is a bad merge, a wrong full-run is minutes. Unconditionally failing closed the
 * moment ANY excluded-dir path changes needs no resolver to trust, so it cannot have this failure mode.
 *
 * COST, NAMED: this also forces the full gate for the previously-reduced case where a fixture change ships
 * alongside a real test file change that has nothing to do with the fixture (`test/emit-compare-gate-scope.mjs`
 * case (J) — see that test's own updated expectation). That diff shape is not provably safe to reduce
 * without exactly the resolver this decision rejects, so the regression is accepted, not overlooked.
 */
export async function computeEmitCompareGate(
  repoPath: string, worktreePath: string, baseSha: string, ref: string, deps: BoundedGitDeps = {},
): Promise<EmitCompareGateResult> {
  // Card 4def0708: replaces the old single `notEligible(reason, notApplicable = false)` — a DEFAULTED
  // boolean param let a forgotten call site silently stamp the INFORMATIVE value (12 of 16 original call
  // sites never opted in to `notApplicable:true`, three of them plainly wrong: a git error, an empty diff,
  // and an unparseable line, none of which are verdicts about reducibility). Two explicitly-named
  // constructors mean a call site can no longer express the wrong one BY OMISSION — every return below
  // picks one on purpose. See {@link EmitCompareGateResult.notApplicable}'s own doc.
  const notReducible = (reason: string): EmitCompareGateResult => ({ eligible: false, changedTestFiles: [], notHermeticExcluded: [], inertPathsSkipped: [], identicalFileCount: 0, reason, notApplicable: false });
  const notApplicableHere = (reason: string): EmitCompareGateResult => ({ eligible: false, changedTestFiles: [], notHermeticExcluded: [], inertPathsSkipped: [], identicalFileCount: 0, reason, notApplicable: true });
  const { git, timeoutMs } = boundedGit(repoPath, deps);

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
    return notApplicableHere("git error reading the diff");
  }
  if (entries.length === 0) return notApplicableHere("empty diff — nothing to prove inert from");

  const changedTsFiles: string[] = [];
  const changedTestFiles: string[] = [];
  // Card 17cd1f30: paths classified as NOT_HERMETIC (see EmitCompareGateResult.notHermeticExcluded's own
  // doc) — filtered OUT of changedTestFiles rather than blocking eligibility.
  const notHermeticExcluded: string[] = [];
  // Card 8ee4f11e: paths short-circuited by the `isInertMergePath(p)` skip just below — see
  // EmitCompareGateResult.inertPathsSkipped's own doc for why this must be surfaced, not just dropped.
  const inertPathsSkipped: string[] = [];
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
    if (tab < 0) return notApplicableHere(`unparseable diff line: ${line}`);
    const status = line[0];
    const p = line.slice(tab + 1);
    // Card b97f643d: a path already certified inert by {@link isInertMergePath} (e.g. `docs/**`) is
    // SKIPPED here, before it can hit the `notEligible` catch-all below — REUSING that exact predicate
    // (list AND matching logic), never a second hand-copied one (this file's own recurring shared-unit-
    // divergence warning). Without this, a diff that is otherwise reducible (comment-only .ts, or a
    // changed test file) but ALSO touches one provably-inert docs/ path fell to the FULL gate — strictly
    // MORE expensive than either the docs/ path alone (which already skips the gate entirely via
    // `isInertMergeDiff`, itself built on this same predicate) or the reducible part alone. This is purely
    // NARROWING: it can only ever remove a path from consideration that would otherwise have forced
    // `eligible:false`, never admit a path that isn't ALSO already provably inert by the same predicate the
    // full-skip path trusts.
    //
    // DOES NOT, BY ITSELF, GUARANTEE AN ALL-INERT DIFF NEVER REACHES THIS FUNCTION — this function has TWO
    // callers in sessions/service.ts, and they are NOT guarded the same way. The PRIMARY classification
    // site (`~:12856`) is gated `!inertSkip`, with `inertSkip` freshly re-derived from `isInertMergeDiff`
    // immediately above — so an all-inert diff structurally cannot reach this function through that site.
    // The ADMISSION-TIME RECLASSIFICATION site (`~:13064`) is gated only on a PRIOR classification having
    // been eligible and never re-consults `isInertMergeDiff` — so a diff that shrinks to all-inert paths
    // between pre-wait classification and admission CAN reach this function that way. For THAT path, it is
    // the pre-existing empty-set guard below (`no eligible changed path left to prove inert`) — not this
    // skip — that fails the result closed; this skip only ensures the reason is that guard rather than the
    // `path outside emit-compare scope` catch-all further down. Traced at card b97f643d; judged acceptable
    // as-is (narrow window, fails toward the safe full-gate outcome either way) rather than widened to
    // re-consult `isInertMergeDiff` a second time.
    if (isInertMergePath(p)) { inertPathsSkipped.push(p); continue; }
    if (p.startsWith(EMIT_COMPARE_SRC_PREFIX) && p.endsWith(".ts")) {
      if (status !== "M") return notReducible(`non-modify status "${status}" on compiled file ${p}`);
      changedTsFiles.push(p);
      continue;
    }
    if (p.startsWith(EMIT_COMPARE_TEST_PREFIX) && p.endsWith(".mjs")) {
      // Card 815b4b30: a path sitting inside an EXCLUDED_DIR_NAMES subtree (`fixtures/`, `census/`) is,
      // by construction, not a test at all — scripts/test-daemon.mjs's own discovery walk never descends
      // into either directory, so the full suite never runs it either. Checked FIRST, before the
      // underscore/shell-safety checks below: those two checks exist only to protect what
      // `buildReducedGateCommand` is about to interpolate into a shell-executed `&&` chain, and an
      // excluded-dir path is never going to reach that chain at all, so subjecting it to those checks
      // could only ever produce a spurious notEligible for a file this function is about to skip anyway.
      // REUSE, not reimplementation (Code Review, card 815b4b30): two independent notions of "is this a
      // test" is exactly the shared-unit divergence that produced this bug (a fixture/census path was
      // treated as a real test here while test-daemon.mjs's own walk already excluded it) — so this loads
      // the REAL `EXCLUDED_DIR_NAMES` Set by dynamically importing THIS DIFF'S OWN worktree copy of
      // scripts/test-daemon.mjs (see `loadExcludedTestDirNames`), never a hand-copied second list that
      // could silently drift from it. `loom:not-a-test:`/`loom:gate-exempt:` markers are NOT re-checked
      // here: both only ever change how `findExcludedDirTestShapedFiles` ANNOTATES a file already inside
      // an excluded dir for the full-suite banner — neither marker makes the full suite actually RUN that
      // file, so there is nothing for a marker to change about whether this reduced gate runs it either.
      //
      // Card 44968963: a fixture/census file's OTHER consumers can sit anywhere else in `test/**`, entirely
      // outside this diff, and this function has no sound way to enumerate them (see this function's own
      // doc for why a consumer-resolver was rejected) — so ANY changed path landing here fails the WHOLE
      // diff closed to the full gate immediately, rather than being silently dropped from consideration
      // the way it was before this card. This is strictly narrower than before: it can only ever turn a
      // past `eligible:true` into `eligible:false`, never the reverse.
      const relToTestDir = p.slice(EMIT_COMPARE_TEST_PREFIX.length);
      const dirSegments = relToTestDir.split("/").slice(0, -1);
      if (dirSegments.length > 0) {
        if (excludedDirNames === undefined) excludedDirNames = await loadExcludedTestDirNames(worktreePath);
        if (excludedDirNames === null) return notApplicableHere(`could not load EXCLUDED_DIR_NAMES from this diff's own scripts/test-daemon.mjs to classify ${p}`);
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
        if (notHermeticNames === null) return notApplicableHere(`could not load NOT_HERMETIC from this diff's own scripts/test-daemon.mjs to classify ${p}`);
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
    // Card 2db8a3dd: THE primary structural case — a repo whose sources don't live under
    // `packages/daemon/src|test/` (i.e. every project that isn't Loom's own daemon package) fails HERE, on
    // the first changed path, every time, before any other classification below is even consulted. Also
    // reachable on a Loom-shaped diff that touches a path this predicate simply doesn't cover (e.g.
    // `packages/web/**`) — equally `notApplicable`, for the identical reason: the predicate never had this
    // path in its domain, so "not reduced" would overclaim there too.
    return notApplicableHere(`path outside emit-compare scope: ${p}`);
  }

  if (changedTsFiles.length === 0 && changedTestFiles.length === 0 && notHermeticExcluded.length === 0) {
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
    if (!(await emitCompareSoundnessOk(worktreePath))) {
      return notReducible("soundness precondition (emitDecoratorMetadata / const enum) not verified");
    }
    let tsModule: TypeScriptModule;
    try {
      const imported = (await import("typescript")) as unknown as { default?: TypeScriptModule } & TypeScriptModule;
      tsModule = imported.default ?? imported;
    } catch {
      return notApplicableHere("typescript module not resolvable (expected on a shipped end-user install)");
    }
    for (const p of changedTsFiles) {
      let before: string;
      let after: string;
      try {
        before = await withTimeout(git.raw(["show", `${baseSha}:${p}`]), timeoutMs, "git show (emit-compare before)");
      } catch {
        // Card 4def0708: a failed git read is the same mechanism-failure shape as the diff-read error above.
        return notApplicableHere(`could not read base content for ${p}`);
      }
      try {
        after = await withTimeout(git.raw(["show", `${ref}:${p}`]), timeoutMs, "git show (emit-compare after)");
      } catch {
        return notApplicableHere(`could not read branch content for ${p}`);
      }
      const outBefore = transpileIgnoringCommentsAndWhitespace(before, p, tsModule).outputText;
      const outAfter = transpileIgnoringCommentsAndWhitespace(after, p, tsModule).outputText;
      if (outBefore !== outAfter) return notReducible(`${p} is not transpile-identical — a real code change`);
    }
  }

  return { eligible: true, changedTestFiles, notHermeticExcluded, inertPathsSkipped, identicalFileCount: changedTsFiles.length, notApplicable: false };
}

/**
 * Loads the REAL `EXCLUDED_DIR_NAMES` Set from `scripts/test-daemon.mjs` — dynamically imported from
 * `worktreePath` itself (the diff's OWN checked-out copy of that script), not from this daemon process's
 * own installed copy: `emitCompareSoundnessOk` above already reads its two tsconfig files live from
 * `worktreePath` for the identical reason (a future edit to the script must be seen immediately, not
 * after a daemon restart), and `test/census/lib.mjs` already imports this same module the same way (for
 * its `NOT_HERMETIC` export) — `test-daemon.mjs` is deliberately import-safe (see its own `isMain` guard
 * doc: "an out-of-band harness ... needs to import this file's ... export without ALSO triggering a full
 * ... run as a side effect of that import"), so this is genuine reuse, not a new coupling.
 *
 * FAILS CLOSED to `null` on any error — an unreadable/unparseable script, a missing `scripts/` directory
 * (never shipped in the packaged `loomctl` npm install; see `scripts/build-npm-package.mjs`'s `files`
 * list — this whole emit-compare mechanism is Loom-repo-specific already and simply never engages on a
 * shipped install's own project, same posture as the `typescript`-unresolvable case below), or an export
 * that isn't actually a `Set`. Never resolve ambiguity to an empty-but-truthy Set — a caller that got
 * `null` here MUST fail the whole diff closed, exactly like the `typescript`-unresolvable case just
 * below in {@link computeEmitCompareGate}.
 */
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
 *  own doc for why this (not a hand-rolled scanner, not the real `dist/` build) is the right tool. Matches
 *  `tsconfig.base.json`'s real `target`/`module` so the emitted SYNTAX shape (e.g. downleveling) is
 *  representative; every other option is irrelevant here since `transpileModule` never type-checks. */
function transpileIgnoringCommentsAndWhitespace(text: string, fileName: string, tsModule: TypeScriptModule): { outputText: string } {
  return tsModule.transpileModule(text, {
    compilerOptions: {
      target: tsModule.ScriptTarget.ES2022,
      module: tsModule.ModuleKind.NodeNext,
      removeComments: true,
      sourceMap: false,
      declaration: false,
    },
    fileName,
  });
}

/** Live re-check of {@link computeEmitCompareGate}'s soundness precondition — see that function's own doc
 *  for what these two TS mechanisms would break if either were present. Reads directly off `worktreePath`
 *  (the exact tree about to be gated): a plain, deterministic filesystem walk, not git — there is no
 *  "before" state to reconcile here since both properties are PROGRAM-WIDE, not diff-scoped, so the only
 *  question is whether they hold in the tree being tested right now. Any read/parse error fails closed
 *  (returns `false` — precondition NOT proven), same asymmetry as everywhere else in this file.
 *
 * Code Review (card 2154b6ad): `packages/daemon/tsconfig.json` `extends` `tsconfig.base.json` and carries
 * its OWN `compilerOptions` block (`outDir`/`rootDir`/`types` today) — the more natural place someone adds
 * a daemon-specific compiler option going forward. An earlier version of this function read ONLY the base
 * config, so `emitDecoratorMetadata:true` added to the PACKAGE file instead would have been invisible to
 * this check: `transpileIgnoringCommentsAndWhitespace` never sets that flag, so a type-only edit to a
 * decorated member would transpile identically while the REAL `pnpm build` emit's metadata silently
 * changed — `eligible:true` on a genuine behavior change, exactly the failure this precondition exists to
 * catch. Both files in the daemon's actual `extends` chain are checked below, each independently. If a
 * third config layer is ever added to that chain, this must widen to cover it too. */
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

/** Builds the `&&`-chained reduced gate command for a diff {@link computeEmitCompareGate} proved eligible
 *  — `pnpm build` (unconditional, real typecheck+emit) + the static guards (unconditional, source-text
 *  scanners, run as bare `node <path>` — with NO env scrub, so they inherit this process's own ambient
 *  `LOOM_HOME`/`LOOM_PORT`, same as `scripts/run-static-guards.mjs`'s own bare spawns; card 49c50b80
 *  corrects a prior version of this comment that claimed these guards "never touch `LOOM_HOME`/a port" —
 *  false: `test/_guard.mjs`'s `exit` hook reads `LOOM_HOME` in every one of them. Safety against that now
 *  lives IN `_guard.mjs` itself — see `isTestCreatedHome` there — not in how these are invoked) + — only
 *  when a test file actually changed — ONE `pnpm --filter @loom/daemon test:daemon --only=<names>` step
 *  naming every changed file, so each runs THROUGH THE HARNESS (its own fresh temp `LOOM_HOME` +
 *  non-4317 `LOOM_PORT`, per `scripts/test-daemon.mjs`'s own header contract) instead of as a bare
 *  `node <path>` with neither.
 *
 *  Card dd4349ff: the prior bare invocation left any changed file that needed that env unable to even
 *  START (`test/_guard.mjs`'s `requireHermeticEnv` refuses at exit 99, 0s, no assertion ever run) —
 *  rejecting a release-critical merge for a defect in the INVOCATION, not the code under test.
 *
 *  Each `--only=` name is the harness's own bare test-daemon name for a changed file — its repo-relative
 *  path minus the `packages/daemon/test/` prefix and `.mjs` suffix, the exact shape
 *  `discoverHermeticTests` (scripts/test-daemon.mjs) keys `NOT_HERMETIC`/`TEST_TIMEOUT_OVERRIDES` on and
 *  returns as `hermetic`. `resolveSelection`'s own `--only=` validation REFUSES a name outside that
 *  discovered set rather than silently selecting nothing — so a path this function is handed that the
 *  harness doesn't actually discover as hermetic (excluded-dir, an underscore helper, a `looksLikeTest`
 *  violation) fails this reduced gate LOUDLY instead of quietly running zero tests. Never runs the
 *  ~668-test suite UNFILTERED — that omission is the entire saving this mechanism exists for; `--only=`
 *  is what lets a changed file's OWN behavior be exercised (not merely proven absent from `src/`) without
 *  paying for the rest of the suite.
 *
 *  Card 17cd1f30: `changedTestFiles` here is expected to ALREADY exclude any `NOT_HERMETIC` name —
 *  {@link computeEmitCompareGate} does that filtering (see its `notHermeticExcluded` field) before this
 *  function ever sees the list, exactly so a `NOT_HERMETIC` name can never reach `--only=` and trip
 *  `resolveSelection`'s refusal above (the merge op `5113c720` specimen: 4 `NOT_HERMETIC` names landed in
 *  `--only=` unfiltered and the gate failed identically on every re-fire). This function does not
 *  re-filter — it trusts its caller, same as it always has for excluded-dir/underscore/shell-safety, which
 *  are also enforced by the caller before a path ever reaches `changedTestFiles`. The caller is
 *  responsible for declaring any excluded name by name in the merge result (`emitCompareWarning` in
 *  sessions/service.ts) — a silent drop would gate a branch while quietly verifying nothing for those
 *  files. */
export function buildReducedGateCommand(changedTestFiles: string[]): string {
  const steps = ["pnpm build", ...STATIC_GUARD_REPO_PATHS.map((p) => `node ${p}`)];
  if (changedTestFiles.length > 0) {
    const names = changedTestFiles.map((p) => p.slice(EMIT_COMPARE_TEST_PREFIX.length, -".mjs".length));
    steps.push(`pnpm --filter @loom/daemon test:daemon --only=${names.join(",")}`);
  }
  return steps.join(" && ");
}

/**
 * Verifies a squash commit's persisted `Loom-Worker-PathSet` claim purely from the commit's OWN ancestry —
 * `sha` and its parent `sha^`, both permanently reachable from HEAD once landed, so unlike a branch-tip
 * check this needs no branch ref and survives `git gc` indefinitely (empirically confirmed: a genuine
 * match still holds after `git branch -D` + `git reflog expire --expire=now --all` + `git gc --prune=now`;
 * see test/merge-pathset-deleted-branch.mjs). FAILS CLOSED, same asymmetry as {@link
 * branchContentLandedInCommit}: any git error, or the digests genuinely disagreeing, returns `false` —
 * NOT VERIFIED — never resolve ambiguity to `true`. A false `false` costs one redundant, idempotent merge
 * attempt; a false `true` is the exact silent-data-loss bug this whole check exists to close.
 *
 * ⚠️ WHAT A `true` HERE ACTUALLY PROVES, AND WHAT IT DOESN'T: only that the landed commit touched the SAME
 * SET OF FILES the trailer declares — NOT that it carries the same CONTENT (see {@link
 * changedPathSetDigest}'s doc for why a content check doesn't survive a concurrent main advance, which is
 * why this is a path-set and not a content hash). Two DIFFERENT branches whose diffs happen to touch the
 * exact same path set produce IDENTICAL digests, and a content swap between them would pass this check.
 * That is not a hypothetical on this repo specifically: cards cluster hard on a handful of hot files (e.g.
 * `pty/host.ts`), so two concurrently-worked branches confined to the same one or two hot files are a
 * realistic, not exotic, way to hit this. Accepted deliberately (see the doc above) because it strictly
 * dominates the pre-f621f185 answer (trailer presence alone, no path check at all) and never introduces a
 * false positive it wouldn't already have produced — but a caller must not read a `true` here as "content
 * verified" the way {@link branchContentLandedInCommit}'s `true` (the branch-PRESENT path) actually is.
 */
async function verifyPersistedPathSet(
  git: Pick<SimpleGit, "raw">, timeoutMs: number, sha: string, expectedDigest: string,
): Promise<boolean> {
  try {
    const parent = (await withTimeout(
      git.raw(["rev-parse", `${sha}^`]), timeoutMs, "git rev-parse (path-set verify parent)",
    )).trim();
    const actual = await changedPathSetDigest(git, parent, sha, timeoutMs);
    return actual === expectedDigest;
  } catch {
    return false;
  }
}

/**
 * Find the SQUASH-merge commit for `branch` reachable from `base` (default HEAD), identified by the
 * deterministic `Loom-Worker-Branch: <branch>` trailer {@link mergeBranch} writes. Returns the commit SHA,
 * or null if no such commit is in `base`'s history. This REPLACES the `Merge branch '<branch>'` grep
 * (workerDiff stage 3) and `isBranchMerged` (boot-reconcile Pass A) under squash, where the worker branch
 * is NOT in main's ancestry and there is NO merge commit to detect.
 *
 * RE-TASK GUARD (data-loss safety): the trailer lives in main's history FOREVER, so a branch RE-CUT onto a
 * prior squash (the SAME task re-spawned — createWorktree reuses `loom/<key>`) carries a HISTORICAL trailer
 * while holding NEW live work. To avoid treating such a live worker as a landed orphan (which would delete
 * its worktree), when the branch ref STILL EXISTS we confirm the trailer commit is NOT an ancestor of the
 * branch tip: a genuine orphaned squash-merge of the CURRENT branch DIVERGES from it (merge-base ≠ the
 * squash), whereas a re-cut branch DESCENDS FROM the prior squash (merge-base == the squash). Ancestry is
 * tested via merge-base equality — raw resolves it cleanly; we avoid `--is-ancestor`, whose exit-1 raw
 * misreads (see {@link isBranchMerged}). Branch gone ⇒ the trailer commit IS the landed diff (workerDiff
 * stage 3), returned directly, subject to the path-set verification below.
 *
 * VERIFIED in BOTH cases, by TWO DIFFERENT MEANS with two different strengths (card e076d2a2 for the
 * branch-present mode; card f621f185 for the branch-gone mode — read both docs, they prove different
 * things). While `branchPresent`, verified via {@link branchContentLandedInCommit} — an actual CONTENT
 * check (byte-for-byte, not just which files) — exactly as before, UNCHANGED, no regression to that path.
 * Once the branch is GONE, verified instead via the persisted `Loom-Worker-PathSet` trailer (see {@link
 * verifyPersistedPathSet}) — self-contained in the commit itself, so unlike a branch-tip-based check it
 * needs no branch ref and survives `git gc` indefinitely, but it ONLY proves the landed commit touched the
 * same set of FILES the trailer declares, not the same content — see verifyPersistedPathSet's own doc for
 * exactly what that does and doesn't rule out. A commit that predates this fix carries no such trailer; for
 * THOSE only, this degrades to the pre-f621f185 trailer-presence-only answer (logged, never silent) since a
 * trailer can't be retroactively added to already-landed history.
 *
 * FAILS SAFE in both branches, same asymmetry throughout this file: ANY error/timeout, or the verification
 * genuinely disagreeing, returns null (treated as NOT-landed) — never resolve ambiguity to a landed claim.
 * A false null just costs Pass A keeping the worktree / a caller retrying an idempotent merge; a false
 * landed sha is the exact silent-data-loss bug both cards exist to close. Injectable via {@link
 * BoundedGitDeps}.
 *
 * `onPreFixTrailerNotice`, when supplied, REPLACES the branch-gone-pre-pathset `console.info` below with a
 * callback instead — for a caller that invokes this in a loop (boot-reconcile Pass A's fallback path,
 * card 6ee48e4d) and wants to aggregate that notice ONCE PER PASS (mirroring how {@link
 * scanMergedCommitMap} already logs its own pre-fix-history count once per scan, not once per row)
 * instead of flooding the log per call. Omitted (the default, every other call site), this logs exactly
 * as before — no behavior change for a single decision-path caller.
 */
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
      const pathSetMatch = body.match(LOOM_WORKER_PATHSET_TRAILER);
      if (pathSetMatch) {
        if (!(await verifyPersistedPathSet(git, timeoutMs, sha, pathSetMatch[1]!))) return null;
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

/**
 * The orchestration-view diff for a worker — "what has this worker changed?" — robust across the
 * worker's WHOLE lifecycle. {@link diffBranch} alone only sees COMMITTED branch refs in the canonical
 * repo, so it reads EMPTY for a live worker mid-task (its work is uncommitted, in the worktree) and
 * ERRORS for a merged+deleted branch (`HEAD...<gone>` → "ambiguous argument") — that was the
 * "/orchestration diffs are all empty" bug. This resolves it in three lifecycle stages:
 *
 *  1. WORKTREE present (live or retained) → diff IN the worktree from the branch's spawn point
 *     (merge-base with the canonical HEAD) to the WORKING TREE, so committed AND uncommitted
 *     in-progress edits both show — the live-supervision case the view exists for. (`uncommitted`.)
 *  2. branch ref present, worktree gone   → the committed 3-dot branch diff ({@link diffBranch}).
 *  3. branch merged + deleted             → reconstruct the landed diff from the SQUASH commit, located
 *     by the deterministic `Loom-Worker-Branch:` trailer ({@link findLandedSquashCommit}; under squash
 *     there is no merge commit to grep for), diffed against its single parent. So a merged worker shows
 *     what it contributed instead of a 500. (`merged`.)
 *
 * Returns null only when there is genuinely nothing to show (no branch + no worktree, or a merged
 * branch whose merge commit can't be located) — the caller renders that as an honest "no diff".
 *
 * BOUNDED (card c6a6f405): every git call below now goes through the same {@link boundedDiffGit} +
 * {@link withTimeout} convention {@link diffBranch} already uses — a busy/locked repo now fails within
 * the file's normal ~{@link GIT_OP_TIMEOUT_MS} bound instead of hanging indefinitely. This still runs
 * on-demand per HTTP request (never at boot), so even before this fix a wedged child only ever blocked
 * that one request, never daemon boot — but "only one request" is not the same as "fine to hang
 * forever," which is why this now gets the same bound as every sibling git op in this file. Each stage
 * is still guarded so a failure falls through to the next rather than throwing the whole call.
 */
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

// ── Diff cache for the polled orchestration-view endpoint (`GET /api/sessions/:id/diff`) ──────────
//
// workerDiff() always shells out to git (350-415ms/poll in the 2026-07-16 perf profile). This wraps
// workerDiff with a cache keyed on a CHEAP, git-subprocess-free freshness proof, so a repeat poll on an
// unchanged worker skips git entirely. ACTUAL client cadence (web/src, verified by grep — don't restate
// a rounder number from memory, it drifts): `reviewQueue.tsx` polls every 8000ms, but only for the
// review-queue cards (a worker awaiting merge); `Overview.tsx`'s `WorkerDiffPanel` and `ReviewPanel.tsx`
// set NO `refetchInterval` at all, and the app's `QueryClient` has no default one either — react-query's
// own default `staleTime: 0` means those refetch on every component MOUNT instead, so the actual hot path
// is likely BURST mount traffic (re-expanding/re-rendering worker cards), not a steady interval. This
// cache — and its TTL fast path below — help both shapes: a steady 8s poll less dramatically (see the
// measured ~2x below), a mount-driven burst far more (a burst of near-simultaneous requests inside the
// TTL costs one walk total instead of one per request).
//
// KEY DESIGN (correctness over hit-rate — a false HIT serves a stale diff, worse than the perf cost it
// saves):
//  - The canonical repo's HEAD sha, read via fs (not `git rev-parse`) — covers stage 2/3 (committed-only
//    and merged-and-reconstructed diffs), whose result only changes if HEAD moves or the branch/worktree
//    lifecycle transitions.
//  - When a live worktree exists (stage 1 — the case that ALSO reflects UNCOMMITTED work), HEAD sha alone
//    is NOT enough: a worker can edit a tracked file without staging or committing, which never touches
//    any git ref or the index, only the file's own mtime. So stage 1 additionally fingerprints the
//    worktree's actual file contents (path + mtime + size + mode) via a bounded, git-free recursive walk.
//    `.git` (never diff-relevant) and `node_modules` (Loom-provisioned per worktree, never git-tracked —
//    see CLAUDE.md "Worktree dep-provisioning") are skipped as a pure perf optimization; every other path
//    is walked, so any tracked-file edit, add, delete, rename, or mode change is caught.
//  - The walk is capped (DIFF_FINGERPRINT_MAX_ENTRIES) — past the cap we can't CHEAPLY prove the worktree
//    is unchanged, so the key resolves to null and the caller always recomputes: a false MISS, which only
//    costs perf, never correctness.
//
// TTL fast path (card 31552de1 — the walk itself was the real cost, not the git subprocess it replaces):
// the walk IS the cache key, so it used to run BEFORE the cache was ever consulted — every poll paid the
// full recursive stat walk (~94ms / ~1742 stats on a real pnpm-monorepo worktree), even a cache HIT. That
// runs IN-DAEMON (event loop + libuv threadpool), unlike the git subprocess it replaces (a separate
// process) — at N live workers, that's continuous fs-syscall churn on the daemon itself, whether it's
// driven by a steady poll or a burst of near-simultaneous mount refetches (see the client-cadence note
// above). `DIFF_FINGERPRINT_TTL_MS` bounds how often the walk actually runs: once a live worktree's
// content fingerprint has been walked, a repeat poll within the TTL trusts that fingerprint WITHOUT
// re-walking — it only re-reads the CANONICAL repo's HEAD (one or two small file reads — `.git/HEAD` then
// `refs/heads/<branch>`, falling through to scan `packed-refs` when refs are packed — never a walk). That
// re-read only ever catches the CANONICAL repo's own checked-out branch moving (e.g. another worker's PR
// landing on main, which shifts the merge-base this diff is computed from) — it is caught immediately,
// TTL or not.
//
// It does NOT, and does not need to, catch the worker's OWN commits as a separate case: `fingerprintWorktree`
// walks the WORKING TREE, not `.git`, so a commit that writes no working-tree bytes (e.g. committing
// content the walk already fingerprinted) is invisible to the walk too, at ANY TTL — correctly, because
// workerDiff's own stage-1 diffs merge-base(canonical HEAD, branch) -> WORKING TREE, so a commit of
// already-fingerprinted content changes nothing about the diff it would serve either. What the TTL actually
// bounds is working-tree WRITES — the only thing that can change the stage-1 diff — whether or not those
// writes are ever committed. A write inside the TTL window (staged, committed, or neither) is served stale
// until the walk runs again; bounded staleness, acceptable for a DISPLAY read (the merge gate does its own
// diff via `reviewWorkerMerge`, never through this cache). The TTL clock is anchored to the last REAL walk,
// not the last served poll, so a fast-path hit never pushes the deadline out — continuous polling still
// forces a re-walk at least once per TTL window instead of deferring it forever.
//
// Bounded via simple LRU eviction (DIFF_CACHE_MAX_ENTRIES) keyed by branch — branches come and go with
// workers over the daemon's whole lifetime, so an unbounded map would leak.
//
// MEASURED, NOT ASSUMED (2026-07-17, throwaway script against this repo's own worktree — a real
// pnpm-monorepo tree, real node_modules — not a synthetic fixture): the HIT path is NOT free, it still
// walks the tree. 1566 files walked (excl `.git`/`node_modules`). HIT (fingerprintWorktree alone) ~94ms
// avg across 8 warm runs (83-145ms range over two independent passes). MISS (the git subprocess trio
// this replaces: merge-base + diff --stat + diff) ~235-253ms avg locally, vs 350-415ms/poll on the live
// 2026-07-16 profile (a different/larger host — git's fixed spawn overhead plausibly dominates more
// there, so the live win is likely larger in absolute ms, not smaller). Net: a real, repeatable ~2x
// reduction, not an order-of-magnitude one. Threadpool contention (libuv's default pool is only 4
// threads) was checked too: production deliberately runs `UV_THREADPOOL_SIZE=16` (see `bin/loom.mjs` /
// `daemon-supervisor.mjs`, task dea6728e) for exactly this class of fs-heavy work; under that config,
// N=4/8/16 concurrent fingerprintWorktree() calls (simulating several worker cards polling the same
// ~4s tick) ran FASTER per-call than sequential, no contention degradation observed. Caveat: that test
// repeated ONE worktree (favorable OS file-cache sharing) rather than N distinct ones, so fleet-scale
// contention isn't fully ruled out — if it ever shows up in a future profile, the fix degrades gracefully
// (still async, bounded, correct — just less speedup), it doesn't turn wrong.
//
// DECLINED ALTERNATIVE (don't build unless a future profile actually shows the walk itself is hot): a
// cheaper key that fingerprints only git-TRACKED paths (a cached `git ls-files` result, invalidated when
// the worktree's own index file's mtime moves) instead of walking the whole non-`.git`/non-`node_modules`
// tree — on this same measurement, that's ~1566 files down to roughly the ~800 actually tracked, so
// another ~2x on the HIT path alone. Declined 2026-07-17: not worth the added complexity and a NEW
// invalidation-correctness risk against an already-real 2x — notably, index mtime does NOT move on an
// UNSTAGED edit to an already-tracked file, so the ls-files cache would need its own separate
// invalidation proof, layering exactly the kind of hazard this card exists to eliminate.

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

/**
 * Which verification mode produced a {@link MergedCommitInfo} answer (card 52e978ad). Same field, same
 * shape, but the three values are NOT the same guarantee — a caller must not treat them interchangeably:
 *  - `"content"` — the branch ref was still LIVE; verified by an actual byte-for-byte diff of the
 *    branch's own changed paths between the candidate commit and the branch tip ({@link
 *    branchContentLandedInCommit}). The strongest guarantee this file produces.
 *  - `"pathset"` — the branch was already gone; verified from the landed commit's OWN ancestry against
 *    its persisted `Loom-Worker-PathSet` trailer ({@link verifyPersistedPathSet}). Survives `git gc`
 *    indefinitely, but only proves the SAME SET OF FILES landed, not the same CONTENT — see that
 *    function's own doc for exactly what it does and doesn't rule out. Weaker than `"content"`; do not
 *    render it with the same confidence.
 *  - `"trailer-only"` — the branch was gone AND the commit predates the `Loom-Worker-PathSet` trailer
 *    (pre-f621f185 history). The answer rests on `Loom-Worker-Branch:` trailer PRESENCE alone — no
 *    content or path check at all. The weakest of the three; render this qualified, not as a second
 *    confident tick.
 */
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
 * carries one (card f621f185), else `null` for pre-fix history. Exported (card 6ee48e4d) only because
 * it's structurally part of {@link MergedCommitScan}, itself exported for {@link getMergedCommitMapCached}
 * — {@link getTaskMergedInfo}'s own public return stays the plain {@link MergedCommitInfo} shape.
 */
export interface MergedMapEntry extends MergedCommitInfo {
  pathSetDigest: string | null;
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

/**
 * One bounded `git log` pass over `base`'s history (default HEAD), extracting every commit's
 * `Loom-Worker-Branch: <branch>` trailer (plus its `Loom-Worker-PathSet` trailer, if present) into a
 * `branch -> {sha, date, pathSetDigest}` map — the batch-friendly sibling of {@link
 * findLandedSquashCommit}'s single-branch `--grep`. Building ONE map per repo (cached by {@link
 * getMergedCommitMapCached}) and looking a task's branch up in it is an O(1) map read per task instead of
 * one git subprocess per task, which is what bounds a `list_all_tasks` page's cost regardless of how many
 * cards it returns. First occurrence per branch wins (log is reverse-chronological, so that's the MOST
 * RECENT landing — matches findLandedSquashCommit's `--max-count=1` semantics).
 *
 * ALSO reports whether the scan was truncated (see {@link MergedCommitScan}) — the discriminator boot-
 * reconcile Pass A needs to tell "this branch never landed" (a complete scan, genuine miss) apart from
 * "this branch might have landed outside the window" (a truncated scan, inconclusive miss): two states
 * that used to share one signature (an empty `Map.get` result), the same collapse this card already fixed
 * once for map-hit-vs-miss itself. Truncation is detected from data the scan already computed — no new git
 * call: `git log -n LIMIT` returns AT MOST `LIMIT` commits, so seeing EXACTLY `LIMIT` non-blank records
 * means more history may exist beyond what was read; seeing fewer means `base`'s full history fit inside
 * the window. Counts EVERY commit record the scan saw, not just trailer matches — the vast majority of
 * commits carry no trailer at all, so counting only hits would never reach the limit and would falsely
 * report "complete" on a genuinely truncated scan.
 *
 * FAILS SAFE: any error/timeout returns an EMPTY map with `truncated: true` (every lookup then misses AND
 * is marked inconclusive -> a caller applying the authoritative-miss optimization must fall back, exactly
 * as if the scan had genuinely hit the limit) — never throws.
 */
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
      const trailer = body.match(LOOM_WORKER_BRANCH_TRAILER);
      if (!sha || !trailer) continue;
      const branch = trailer[1]!;
      const pathSetTrailer = body.match(LOOM_WORKER_PATHSET_TRAILER);
      if (!map.has(branch)) map.set(branch, { sha, date, pathSetDigest: pathSetTrailer ? pathSetTrailer[1]! : null }); // first hit = most recent (reverse-chron)
    }
  } catch {
    return { map, truncated: true }; // fail safe: empty map + inconclusive -> every lookup misses AND must fall back
  }
  // Log the pre-fix-history count ONCE PER SCAN, not per lookup: getTaskMergedInfo runs per TASK on every
  // polled board read (up to 100 rows/page), and essentially every card merged before this fix lacks the
  // trailer — a per-lookup log line would flood the daemon log on a path polled continuously by the web UI
  // (worsens board-8dd1dd1c-class log-retention pressure). This scan is already cache-gated (rebuilt only
  // on a HEAD move, not per poll), so logging here reports "how many landed branches in this repo predate
  // Loom-Worker-PathSet" at the natural once-per-actual-scan cadence instead — still never silent, just not
  // per row. findLandedSquashCommit's OWN log (a decision path — merge/reconcile, not a polled read) is
  // unaffected and stays per-call.
  let preFixCount = 0;
  for (const entry of map.values()) if (entry.pathSetDigest === null) preFixCount++;
  if (preFixCount > 0) {
    // eslint-disable-next-line no-console
    console.info(`[git] scanMergedCommitMap: ${preFixCount} landed branch(es) in ${repoPath} carry no ` +
      "Loom-Worker-PathSet trailer — trusting Loom-Worker-Branch presence alone for those once their branch " +
      "is gone, until re-merged (card f621f185)");
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
      // Branch gone (card f621f185): verify against the persisted path-set trailer.
      if (!(await verifyPersistedPathSet(git, timeoutMs, hit.sha, hit.pathSetDigest))) return null;
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

/**
 * Batch-primitive sibling of {@link findLandedSquashCommit} for a caller that wants to look `branch` up
 * against the shared {@link getMergedCommitMapCached} map (ONE bounded `git log` pass per repo, cached
 * and reused across every branch checked against it) instead of paying its own single-branch `--grep`
 * walk. Exists for boot-reconcile Pass A (card 6ee48e4d), which used to call findLandedSquashCommit once
 * PER historical worker session — up to thousands of sequential git subprocess spawns per boot.
 *
 * Returns `{ hit: true, sha }` when `branch` HAS an entry in the map — `sha` is the verified landed
 * commit (via {@link resolveMergedCommitMapHit}, the SAME re-task-guard + content/path-set check
 * findLandedSquashCommit itself applies), or `null` if that entry fails verification (mirrors
 * findLandedSquashCommit's own fail-safe null exactly, just reached via a shared map lookup instead of a
 * fresh grep — NOT a weaker answer).
 *
 * Returns `{ hit: false, scanComplete }` when `branch` has NO entry in the map — and `scanComplete` is
 * the discriminator a caller NEEDS before treating that miss as "not landed" (card 6ee48e4d): a plain
 * miss used to conflate two different states behind one signature — "genuinely never landed" vs "landed
 * outside the {@link MERGED_LOOKUP_SCAN_LIMIT} scan window" — which meant every miss had to be treated as
 * the weaker, inconclusive case. `scanComplete: true` (the scan read `base`'s ENTIRE history — see {@link
 * MergedCommitScan}) makes the miss AUTHORITATIVE: no fallback needed, `branch` provably has no
 * `Loom-Worker-Branch` trailer anywhere reachable from `base`. `scanComplete: false` (the scan was
 * truncated by the limit, OR errored/timed out — same fail-safe direction) means the miss is genuinely
 * inconclusive; a caller that needs the FULL-HISTORY guarantee (the ONLY guarantee findLandedSquashCommit
 * itself makes) MUST fall back to calling findLandedSquashCommit directly in that case — silently treating
 * every miss as authoritative would narrow detection to the scan window and let an old-enough landed
 * worker's worktree/branch linger forever undetected. See boot-reconcile Pass A for the canonical caller
 * shape (branch on `scanComplete`, not on `hit` alone).
 */
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

/**
 * Is `taskId` merged + shipped on `repoPath`'s main line? Resolves the task's DETERMINISTIC branch
 * (`loom/<taskKey(taskId)>`) and looks it up in the cached {@link getMergedCommitMapCached} map — keyed
 * by the same `Loom-Worker-Branch:` trailer {@link findLandedSquashCommit} greps for, rather than by
 * TITLE TEXT: a card's title can be edited after merge, or coerced through `toConventionalSubject`
 * (`git/worktrees.ts` › mergeBranch), while the trailer never drifts. Applies the SAME re-task ancestry
 * guard as findLandedSquashCommit for the rare case the branch ref still exists (a re-spawned task
 * carrying NEW live work over a prior landed squash) — that guard's extra git calls are only paid for
 * an actual map hit, not for every task.
 *
 * Returns `null` when no landed trailer is found FOR ANY REASON: genuinely never merged, landed outside
 * the {@link MERGED_LOOKUP_SCAN_LIMIT} scan window, a re-task in progress, or any git error/timeout
 * (fail-safe). Treat `null` as "not proven merged (within this window)", NEVER as an authoritative
 * "never merged" — that distinction matters because this exists specifically to replace stale-handoff
 * claims with ground truth, and a false-confident null would just move the same failure elsewhere.
 *
 * The returned {@link MergedCommitInfo}'s `verification` field (card 52e978ad) names WHICH of the means
 * below actually answered — a caller that only reads `sha`/`date` can no longer tell a byte-verified
 * "content" landing apart from a weaker "pathset" or "trailer-only" one; a caller that cares about the
 * strength of the guarantee must read it.
 *
 * VERIFIED regardless of whether the branch ref is still live, but by TWO DIFFERENT MEANS of two different
 * strengths — same split as {@link findLandedSquashCommit} (card e076d2a2 for the live-branch mode, card
 * f621f185 for the branch-gone mode): `scanMergedCommitMap` keys on the trailer alone (NOT the subject — a
 * prior read of this incident's `merged:{sha}` false positive as a "subject match" doesn't hold up against
 * this code), so it is exposed to the identical claim-vs-proof gap either way. While `branchPresent`,
 * verified via {@link branchContentLandedInCommit} — an actual CONTENT check. Once the branch is gone,
 * verified via the persisted `Loom-Worker-PathSet` trailer ({@link verifyPersistedPathSet}) carried on the
 * map entry — self-contained in the landed commit itself, so it needs no live ref and survives `git gc`,
 * but (see that function's own doc) it only proves the same FILES landed, not the same CONTENT — two
 * different branches confined to the same file(s) (real on this repo: cards cluster on hot files like
 * `pty/host.ts`) would share a digest. Strictly still better than the pre-f621f185 answer (no path check at
 * all) and never a false positive it wouldn't already have produced, but a `null`-avoiding `true` here is
 * weaker evidence in the branch-gone mode than in the branch-present mode — don't read the two the same
 * way. A commit that predates this
 * fix carries no such trailer; for those only, this degrades to the pre-f621f185 trailer-presence-only
 * answer, since a trailer can't be retroactively added to already-landed history. That degradation is
 * logged, but NOT here — this runs per TASK on every polled board read, so {@link scanMergedCommitMap}
 * logs the pre-fix count once per actual map scan instead (see its own comment for why).
 */
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

/** The Conventional Commits types Loom recognizes (the allowed type list, documented once in CLAUDE.md). */
const CONVENTIONAL_TYPES = [
  "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert",
] as const;

/** Already-conventional subject: `type` (optional `(scope)`) (optional `!`) `: ` + a non-empty description. */
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

/**
 * The taskless-merge counterpart to {@link mergeBranchLocked}'s subject derivation (card 7a1a76e9 DoD-3):
 * a taskless worker (`worker_spawn`'s ad-hoc no-card path) has no `taskTitle` to fall back to, so the
 * subject used to fall back to the branch NAME itself — `chore: loom/<branch>`, the one string guaranteed
 * NOT findable on main after a squash (the successor-check convention is `git log --grep "<subject>"`,
 * and a squash discards the branch ref). This derives a real subject from the branch's OWN history
 * instead: `git log -1 --format=%s <branch>` — the branch's TIP (most recent) commit's subject line.
 *
 * DECISION (the card requires this be made explicitly and documented — there is no obviously-right answer
 * for a multi-commit branch): TIP, not the first commit. A worker's tip commit is the one it most
 * recently chose to write — closer to "what actually shipped" than an early commit an later one may have
 * superseded — and it's also what a human skimming `git log <branch>` sees first. `-1` also needs no walk,
 * so this is a single cheap ref read either way.
 *
 * FAILS SAFE to `undefined` (never throws) on any git error/timeout/empty-branch — mirrors {@link
 * countCommitsBehind}'s own advisory-only discipline; every caller falls back to the branch name on
 * `undefined`, exactly as before this card.
 */
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

/**
 * Card 8b7b81e0 DoD-3: a squash commit's SUBJECT is always the card title (never the worker's own commit
 * messages — that convention is load-bearing, see {@link mergeBranchLocked}'s own doc), but until this
 * card the worker's own per-commit messages were discarded entirely at the squash boundary. The incident
 * that exposed this: a card titled for ONE file, a worker whose OWN commit correctly said it touched FIVE
 * — and the squash kept the narrower title and threw the accurate message away, unrecoverable by `git log
 * --grep` forever after (pathspec-only, which nobody reaches for).
 *
 * This recovers that information into the squash commit's BODY (a real git commit body — the paragraph
 * between the subject and the `Loom-Worker-Branch:`/`Loom-Worker-PathSet:` trailers — not a new trailer;
 * trailers are for single-token machine-readable facts, not prose), so it survives on main by construction
 * instead of by a human remembering to write it in the card title. Returns `undefined` (caller omits the
 * body entirely, byte-identical to pre-8b7b81e0 behavior) when there is nothing worth adding:
 *  - no non-merge commits found on the branch (any git error/timeout also degrades here — best-effort,
 *    like {@link changedPathSetDigest}'s own capture, never blocks the commit), or
 *  - EXACTLY one commit whose subject already matches the squash `subject` (case/whitespace-insensitive)
 *    — the overwhelmingly common single-clean-commit case, where a body would be pure duplication.
 *
 * `--no-merges` excludes the real merge commit {@link mergeMainIntoWorktree} leaves on the branch when it
 * unions canonical main's tip in before the gate runs — that commit is main's own history replayed onto
 * the branch, never the worker's own work, and including it would misattribute main's commit messages to
 * this worker.
 *
 * BOUNDED two ways, deliberately: `WORKER_COMMIT_LOG_MAX_ENTRIES` (a branch with dozens of WIP commits
 * doesn't get a dozens-of-bullets body) and `WORKER_COMMIT_LOG_MAX_CHARS` (one very long commit message
 * doesn't blow the body past what a `git log --oneline`-skimming human tolerates) — either cap truncates
 * with a trailing count of what was omitted, so truncation is visible, never silent.
 */
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

/**
 * Merge a worker's branch into the repo's current branch as a SINGLE SQUASH COMMIT — `git merge --squash`
 * stages the combined diff WITHOUT committing, then a plain `git commit` lands it as ONE commit, so each
 * task = one clean commit on main (not a real-commit + a noise merge-commit). Returns the new squash
 * commit's SHA plus the exact `subject` it was committed with (post-{@link toConventionalSubject}) — so a
 * caller can echo what actually landed without a separate `git log`. FAIL-CLOSED.
 *
 * The commit message is a clean subject (the task `title`, falling back to the branch name) plus a
 * deterministic `Loom-Worker-Branch: <branch>` trailer — the SAME marker {@link workerDiff} stage 3 and
 * boot-reconcile Pass A key on ({@link findLandedSquashCommit}) to reconstruct / finalize a squashed merge
 * whose branch is NOT in main's ancestry (squash leaves no merge commit, so `git branch --merged` and a
 * `Merge branch` grep both go blind). Identity is a PLAIN `git commit` — repo-config identity, NO
 * `-c user.*` overrides and NO Co-Authored-By trailer (matches the project convention; the canonical repo
 * is expected to have a git identity configured).
 *
 * CONFLICT handling differs from `--no-ff`: `git merge --squash` leaves NO MERGE_HEAD, so `git merge
 * --abort` won't work. simple-git's `raw(["merge", …])` ALSO does NOT reliably reject on a conflict, so we
 * detect one EXPLICITLY via unmerged index entries and clean up with `git reset --hard HEAD`, leaving the
 * canonical repo UNTOUCHED — and if that cleanup reset ITSELF fails, we SURFACE it in `reason` rather than
 * asserting a clean conflict over a swallowed error (the repo may be left with unmerged residue).
 *
 * IDEMPOTENT (board card 2eddf573). The staged set is RE-DERIVED here, at merge time, from a clean index —
 * never trusted from a snapshot taken at the preceding review. A stale in-progress-merge residue (a
 * leftover `MERGE_HEAD` / partial index from an aborted op) makes the FIRST `git merge --squash` abort
 * ("You have not concluded your merge") and stage NOTHING, so the old code returned "nothing staged" on a
 * perfectly valid +N-commit branch and only a byte-identical RETRY (after its own reset --hard) merged.
 * We now CLEAR any affirmative residue up front, so the first call stages the real diff. And when the
 * index is GENUINELY empty after a clean (non-error) squash, the result DISTINGUISHES why via `emptyKind`:
 *   - `ALREADY_MERGED`   — the branch's work already landed in main (a prior squash carrying the
 *                          deterministic `Loom-Worker-Branch` trailer is reachable from HEAD).
 *   - `STAGE_EMPTY_RETRY` — no such landing: there is simply no diff to merge (an empty change).
 * so the caller can tell "already done" from "real no-op". A real squash failure still fails closed.
 *
 * REFUSES on ANY dirty tracked state (staged or unstaged) in the canonical repo AT ENTRY — even after the
 * MERGE_HEAD/unmerged clear above has run (card 9e77050f). That clear only sees an AFFIRMATIVE in-progress
 * real-merge signal; a `--squash` that staged a diff and then died before its commit step (the daemon
 * restarting mid-merge is the likeliest cause) sets neither MERGE_HEAD nor an unmerged entry, so it survives
 * that clear invisibly — and disjoint-path content from an unrelated LATER squash can land on top of it,
 * silently, under the LATER branch's own subject/trailer. Whatever is dirty at entry is indistinguishable
 * from a human's own uncommitted work in this same checkout (this repo self-hosts from it, unlike a worker's
 * isolated worktree) — `reset --hard` cannot tell the two apart, and guessing wrong destroys real work. So
 * this refuses loudly instead: `ok:false`, same as every other ambiguous case here — a false NOT-merged, safe
 * and idempotently retryable, never a silent absorption of someone else's content.
 */
export type MergeEmptyKind = "ALREADY_MERGED" | "STAGE_EMPTY_RETRY";

// ── Canonical-repo index mutex ───────────────────────────────────────────────────────────────────────
//
// `mergeBranchLocked` below stages + commits directly against the CANONICAL repo's shared git index — a
// process-wide, un-namespaced resource that `GitWriter.commit`/`checkout`/`createBranch` (git/writer.ts)
// can ALSO write to (the human-only REST git surface and the LOOM_DEV-gated Platform Lead tools). Both are admitted
// through the SAME `withCanonicalIndexLock` (git/repo-lock.ts — see that module for the full incident
// history, the "no timeout here" reasoning, and the non-reentrancy trace for this exact function).

/**
 * Merge canonical main's CURRENT tip (`repoPath`'s HEAD) INTO the worker's worktree, IN the worktree —
 * a REAL (non-squash) merge, run BEFORE the build/DoD gate and the squash-merge below (card c0aeb5b2).
 *
 * THE HOLE THIS CLOSES: the gate used to run against the worktree's PRE-merge state — the branch as it
 * was cut, with no knowledge of anything that landed on main afterward — so it validated a union that was
 * never actually tested. A branch cut before a main-side change that the branch's code now conflicts
 * with (textually) or is incompatible with (semantically, e.g. main removed a symbol the branch now
 * depends on) could sail through a green gate and land a broken union. Merging main's tip into the
 * worktree FIRST means the gate (run by the caller immediately afterward, in the same worktree) sees the
 * actual post-merge union, and a hard textual conflict is caught right here, fail-closed.
 *
 * Deliberately a MERGE, not a rebase or squash: the resulting worktree tip has `mainSha` as a direct
 * ancestor, so `merge-base(repoPath HEAD, branch)` — the base {@link mergeBranch}'s own `--squash` diffs
 * against — becomes `mainSha` itself. The squash below therefore still lands ONLY the branch's own net
 * changes; main's content is common ancestor, not re-applied.
 *
 * FAIL-CLOSED, mirroring `mergeBranch`'s own conflict handling: a real merge sets `MERGE_HEAD` (unlike
 * `--squash`), so a conflict is cleaned up with `git merge --abort` (equivalent to `mergeBranch`'s
 * `reset --hard HEAD`, but the more idiomatic call for a non-squash merge) — leaving the worktree exactly
 * as it was before this call. Any other failure (unresolvable main tip, a merge command error with no
 * conflict, a failed inspection of the merge state) also returns `ok:false` rather than assuming success —
 * this function is itself a gate, not a best-effort probe like {@link detectStrandedWork}, so an
 * inconclusive result must block, not wave through.
 *
 * A worktree that already contains `mainSha` (the common case for a freshly-cut, not-yet-drifted branch)
 * short-circuits to a no-op success (`merged:false`) without spawning a merge child at all.
 */
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
  // GATE-BASE RE-VERIFICATION (card e50600d2, generalized by card eda70da6): the squash below re-derives
  // its result FRESH against whatever canonical HEAD is at the moment it runs (`git merge --squash
  // <branch>` computes branch's diff against merge-base(HEAD, branch) and applies it to CURRENT HEAD) —
  // it does NOT reuse the worktree's own already-unioned tree. So the squash is only provably the SAME
  // thing the gate validated if canonical main hasn't moved between "the sha the gate's tree was actually
  // built from" and this lock. `requireCanonicalHead`, when the caller passed one, IS that sha — either
  // the main tip {@link mergeMainIntoWorktree} unioned into the worktree BEFORE the gate ran (the ordinary
  // real-gate path, eda70da6), or the main tip a REUSED green self-check was proven to already contain
  // (e50600d2). Main is a process-wide shared resource, and another writer (a sibling merge, or — outside
  // this in-process mutex's reach — a human REST commit) can land any time between that sha being fixed
  // and this lock being granted — including the whole of an unbounded SEMAPHORE QUEUE WAIT for the
  // real-gate path, not just the gate's own run time. Do NOT "fix" this by holding the lock across the
  // gate run (would serialize every merge on the repo behind each ~8-14min gate) or by re-running the gate
  // once the lock is held (doubles gate cost and reopens the same window one level down) — this in-lock
  // re-read is the intended shape. Re-read HERE, the FIRST thing after acquiring the lock and BEFORE
  // touching anything (no residue-clear, no squash), so an invalidated premise is caught with ZERO side
  // effects: canonical repo AND worktree stay completely untouched, and the caller gets a distinct
  // `gateBaseInvalidated:true` it can surface as a benign race rather than a real merge failure. Absent
  // whenever no gate ran at all (no gateCommand configured), in which case this check is skipped entirely
  // — byte-identical to before either fix existed.
  //
  // ⚠️ THE ALREADY-LANDED CASE (card b0ab78d6, closing a gap this doc used to describe as open): when the
  // branch's squash has ALREADY landed on main, confirmWorkerMerge SKIPS the union-merge entirely
  // (`preLanded`, in the caller) — that skip predates this fix and exists to protect ALREADY_MERGED
  // re-confirm classification, not to opt out of gating, so a REAL gate still runs (`gateRan:true`). This
  // used to leave `requireCanonicalHead` unset for the whole duration of that gate, making this re-check
  // vacuous for that path — NOT hypothetical: the concrete danger is a branch gaining a genuinely NEW
  // commit WHILE that gate is in flight (a redirected/still-active worker keeps committing before being
  // told to stand down — the worker's pty is not stopped until AFTER confirmWorkerMerge returns), which
  // the eventual squash then stages and lands, un-verified against whatever main did in the same window.
  // `confirmWorkerMerge` now threads a `requireCanonicalHead` through this path too, so this re-check DOES
  // run here: it proves canonical main hasn't moved since the gate started, exactly like the ordinary union
  // path above. What it does NOT prove, on this path specifically: the gate here validated the branch's own
  // tree in isolation, never unioned with main (that union is exactly what's skipped, to protect
  // classification), so a genuinely new commit's *integration* with main's current content is unverified
  // either way — this re-check closes the "main moved" race, not the narrower "never union-tested" gap,
  // which stays open by design (closing it would mean union-merging here, which is exactly what corrupts
  // ALREADY_MERGED classification). See `confirmWorkerMerge`'s own `gateBaseMainHead` doc for the full
  // three-producer picture (union / reuse / preLanded).
  //
  // ⚠️ REGRESSION FOUND AND CLOSED BEFORE MERGE (same card, second CR follow-up): enforcing
  // `requireCanonicalHead` UNCONDITIONALLY on the preLanded path over-refuses. The COMMON case on this path
  // is the opposite of the danger above — a pure re-confirm with genuinely NOTHING new to squash (a
  // stale/racing confirm, see the early-idempotency doc further up) — and that case is IDEMPOTENT by
  // design: main moving elsewhere during its gate is routine on an active fleet and harmless to it, since
  // nothing from this branch is landing either way. Refusing every time main so much as twitches during an
  // 8-14min gate turned that routine idempotent success into a routine refusal (empirically reproduced:
  // same scenario, `{merged:true, emptyKind:"ALREADY_MERGED"}` before this fix, `{merged:false,
  // gateBaseInvalidated:true}` after it, main's movement the only variable) — strictly worse than the gap
  // this card exists to close, on the path's MORE common case.
  //
  // `gateBaseBranchHead`, when supplied, is the fix: it's the branch's OWN tip sha, captured by the
  // preLanded producer at the exact same moment as `requireCanonicalHead` (see confirmWorkerMerge's own
  // doc). Re-read fresh HERE, inside the lock — if the branch's CURRENT tip still matches it, the
  // `requireCanonicalHead` enforcement below is SKIPPED entirely; only a branch that has itself moved since
  // capture falls through to it. This is the correct discriminator, not merely a convenient one: the
  // hazard above requires NEW content on the branch — main moving alone is harmless when the branch is
  // provably unchanged. And it IS provable, not assumed: `preLanded` already established (via
  // `branchContentLandedInCommit`) that this branch's content matched what's already landed AT the capture
  // moment; a commit sha is content-addressed, so an UNCHANGED tip proves that match still holds now,
  // regardless of anything main did meanwhile. Given that, the eventual squash below can only land as a
  // true no-op (safe — proceeds to the ALREADY_MERGED classification ~200 lines down, unaffected by this
  // skip) or hit a genuine line-level conflict on the branch's own already-landed paths (already handled
  // separately below, fails loud, zero side effects) — never silently land unverified new content. An
  // alternative considered and rejected: deferring the ENTIRE `requireCanonicalHead` check until the
  // squash's staged set is known (only refuse when there's actually something to protect) — correct in
  // spirit, but it would move this check out of its "first thing after the lock, zero side effects"
  // position, a property this doc has leaned on since e50600d2/eda70da6 and true for EVERY caller, not just
  // this one. Reading the branch's tip is cheaper and preserves that position untouched.
  //
  // FAIL-CLOSED: `gateBaseBranchHead` is `undefined` for the union and reuse producers (see
  // confirmWorkerMerge's single call site) — this whole pre-check is skipped for them and
  // `requireCanonicalHead` enforces exactly as it always has, byte-identical. On the preLanded producer, a
  // failed fresh read of the branch's tip (a git error/timeout) is treated as "no stability proof
  // available", NOT as "assume unchanged" — it falls through to the ordinary enforcement below, same as a
  // branch that provably moved.
  // SQUASH-TARGET RESOLUTION (card 7efc2bff item 1, TOCTOU closed): resolve the branch tip to an exact sha
  // HERE, unconditionally, and squash THAT SHA below — never the branch NAME. `git merge --squash <branch>`
  // re-resolves the ref at squash time, ~175 lines and several intervening git subprocess spawns after this
  // point; the worker's own pty can still be alive on this path (see the preLanded doc above) and land a new
  // commit on `branch` in that gap, which a name-based squash would then silently include even though it was
  // never checked against `gateBaseBranchHead`/`requireCanonicalHead` above. Squashing the frozen sha instead
  // means a branch that moves in that window simply doesn't contribute its new commit to THIS squash — the
  // object squashed is provably the same object this function validates just below. A failed resolve (a git
  // error/timeout) falls back to squashing by branch name, matching this function's behavior before this fix.
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
  // ── residue clear ── (card c6a6f405 item 3: this block's own `git reset --merge HEAD` below is a real
  // mutating git call that runs BEFORE `enterMergeDangerWindow` — see that function's own doc in
  // merge-danger-window.ts for why it's deliberately left outside the danger window/latch instead of
  // moving the window's entry earlier to cover it.)
  // Re-derive from a CLEAN index: clear any AFFIRMATIVE in-progress-merge residue (a stale MERGE_HEAD or
  // unmerged entries from an aborted op) BEFORE the squash, so a leftover state can't make the first
  // --squash stage nothing (the idempotency bug). Gated on a positive signal so a clean canonical repo is
  // never touched. The two probes are INDEPENDENT: `ls-files --unmerged` exits 0 on a clean repo (never
  // throws), so it runs FIRST and unconditionally; the `rev-parse --verify MERGE_HEAD` check (which exits
  // non-zero → throws when there is no in-progress merge) is isolated in its OWN try/catch so its throw
  // can't skip the unmerged probe — unmerged residue WITHOUT a MERGE_HEAD is now auto-recovered up front too.
  //
  // The clear itself uses `--merge`, not `--hard` (card c78cbf5f, fast-follow to 9e77050f/06b5c47f): a
  // precondition only licenses the operation over the state it actually observed, and the affirmative
  // MERGE_HEAD/unmerged signal here licenses clearing THAT merge state, not discarding unrelated unstaged
  // work elsewhere in the same tree — the gap this block used to have, sitting upstream of the dirty-tree
  // refusal below (which only protects the squash itself, not this earlier clear). `git reset --merge
  // <commit>` is the mechanism `git merge --abort` itself uses, generalized to run whether or not MERGE_HEAD
  // is actually set (`merge --abort` requires it; `--squash` never sets it, so the bare-unmerged-without-
  // MERGE_HEAD case this block also handles needs the same clear too, and plain `merge --abort` can't do
  // that). Verified empirically (not just from docs): since this always resets to the CURRENT HEAD — never
  // a different commit — every unmerged/conflicted path is unconditionally resettable (that IS what aborting
  // a merge means), while a file with only an unstaged edit outside the conflict is never part of the
  // HEAD→HEAD delta and so is left untouched, where `--hard` would have discarded it regardless. (Staged
  // content to such a file is NOT protected by `--merge` either — same as `--hard` — but that is unchanged
  // from before this fix and outside this card's scope, which is specifically the unstaged case.)
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

  // ── Staged-but-not-unmerged residue (card 9e77050f — a SECOND, non-concurrent trigger for the same
  // corruption `withCanonicalIndexLock` closes for concurrency: the mutex is in-process, this residue outlives
  // the process). A `--squash` that stages a diff and then never reaches its commit step (the daemon dying
  // between them — a `daemon_restart`, a supervisor kill, a crash) leaves the canonical index dirty WITHOUT
  // setting MERGE_HEAD and WITHOUT any unmerged entry — the one state the clear above cannot see, because by
  // the time we get here it has already handled every AFFIRMATIVE in-progress-merge signal there is.
  //
  // Whatever is STAGED at this point is therefore either (a) that dead squash's own leftover stage, or (b) a
  // human's own staged work-in-progress in THIS SAME canonical checkout (this repo self-hosts from it —
  // there is no worktree isolation here the way there is for a worker). Git state alone cannot distinguish
  // (a) from (b) — so on ANY staged tracked state we REFUSE LOUDLY instead of guessing. This is a false
  // NOT-merged, not a false landed: `ok:false` is what every other defensive path in this function already
  // returns on ambiguity, and it's a safe, idempotent retry once a human resolves the canonical checkout by
  // hand — never a silent absorption of someone else's content under our own subject/trailer.
  //
  // ⚠️ This precondition is deliberately SCOPED TO THE INDEX (card 06b5c47f, correcting an earlier draft of
  // this fix that refused on ANY dirty tracked state — staged OR unstaged). Only staged content can actually
  // produce the corruption this guard exists to prevent: `--squash` commits the INDEX, so unstaged
  // working-tree edits are never committed by it and can never end up under this branch's subject/trailer.
  // The earlier broad check refused 4-for-4 on real canonical repos whose only dirt was UNSTAGED (ordinary
  // WIP, or a submodule gitlink whose checked-out commit sits ahead of its recorded pointer — a normal
  // steady state for a repo with submodules, not residue, and NOT something a human can necessarily clear),
  // which could block a legitimately-configured repo's merges PERMANENTLY. So the MERGE refusal below keys
  // on the index alone (`diff --cached`).
  //
  // That narrowing does NOT license every `reset --hard` further down in this function — those have a
  // WIDER blast radius (staged AND unstaged tracked state), so they get their OWN separate guard,
  // `hadUnstagedDirtAtEntry` (computed right after this check, from the same broad `git status --porcelain`
  // the old single check used), which skips the reset instead of running it whenever unstaged dirt predates
  // this merge attempt. A precondition only licenses the operation over the state it actually observed — an
  // index-only probe licenses index-only conclusions, not "the working tree is safe to reset". See
  // `resetOrSkip`'s own doc below for how that guard stays scoped to what `reset --hard` actually touches.
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
  // Every `reset --hard HEAD` below this point in this function discards BOTH staged and unstaged tracked
  // state — a wider blast radius than the staged-only entry check above proved safe. `resetOrSkip` is the
  // guard scoped to that wider radius: when unstaged dirt predated this merge attempt, it SKIPS the reset
  // (leaving whatever's on disk untouched) instead of risking a human's pre-existing unstaged edits, and
  // reports why. What it leaves behind on skip is provably safe to leave: since the entry check above
  // already proved the index was clean, and git itself refuses to let `--squash` silently overwrite
  // unstaged local modifications (it errors instead), anything staged from this point on is this squash's
  // OWN output — which the STAGED entry check above will refuse on loudly, not silently absorb, the next
  // time a merge is attempted against this repo.
  //
  // ⚠️ REJECTED ALTERNATIVE (card 06b5c47f): a MIXED reset (`git reset HEAD`, no `--hard`) looks like a
  // strictly better move here — it clears the staged residue without touching the working tree, so it
  // reads as "auto-recover AND protect the human's edits" instead of "skip and make a human clean up".
  // It is not. `--squash` applies its diff to the WORKING TREE as well as the index (this is a real merge,
  // just uncommitted) — a mixed reset only unstages that diff, it does not undo it. The squash's output
  // would keep sitting in the canonical working tree as unstaged noise, indistinguishable from ordinary
  // WIP. That state is QUIETER than what this function ships, not safer: `diff --cached` would come back
  // empty, so the NEXT merge attempt would proceed (not refuse) and `--squash` a new branch on top of a
  // tree that already silently carries a previous branch's abandoned changes — trading a loud, correct
  // refusal for a silent, ambiguous working tree. Silent-and-ambiguous around this exact function is what
  // cost a reviewed p1 (see the file-level corruption-history doc above); this function does not
  // reintroduce that shape to buy a nicer-looking auto-recovery.
  //
  // One real consequence of skipping instead: a genuine squash CONFLICT that lands on top of pre-existing
  // unstaged dirt leaves the canonical repo needing HUMAN cleanup (conflict markers + the unstaged dirt,
  // both left in place) rather than auto-resolving. That is the same `9e77050f` stance — refuse loudly,
  // a human resolves — now correctly SCOPED to cases that are actually dangerous instead of firing on
  // ordinary WIP. It is deliberate, not a regression.
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
      // DIRTY-OVERLAP SIGNATURE (card 4b7ff996): git's own error for "the canonical repo has unstaged
      // local modifications to a path this squash would overwrite" is distinct and diagnostic — surface
      // it as its own `dirtyOverlap:true` reason rather than the generic message below, because the
      // correct remedy here is NOT a rebase (this branch's base is not the problem; no rebase of it
      // touches the canonical repo's own working tree) — see confirmWorkerMerge's own use of this field
      // for the caller-facing wording. {@link detectCanonicalDirtyOverlap} is the PRIMARY, cheap defense
      // against this class (it refuses at admission, before the gate ever runs); this is a defense-in-
      // depth backstop for the race window between that preflight and this squash — the gate itself can
      // run for minutes in between, during which the canonical repo can newly go dirty on an overlapping
      // path.
      // Card 4b7ff996 CR follow-up: this ONE regex matches BOTH of git's "would be overwritten by merge"
      // wordings — "Your local changes to the following files..." (an unstaged TRACKED modification, the
      // case detectCanonicalDirtyOverlap's admission-time preflight actually detects) AND "The following
      // untracked working tree files..." (an UNTRACKED collision — deliberately NOT detected at admission
      // yet; card notes it as a follow-up, since `--untracked-files=no` there is load-bearing against a
      // different false-refusal, see that function's own doc). Both land here as the SAME `dirtyOverlap`
      // classification, so the wording below is worded generically enough to be true for either — "local
      // content" / "commit/discard OR move/remove", not "unstaged changes" / "commit or discard" alone,
      // which would be actively WRONG for the untracked case (an untracked file cannot be "unstaged").
      const dirtyOverlap = !!rawErrorMessage && /would be overwritten by merge/i.test(rawErrorMessage);
      if (dirtyOverlap) {
        // `rawErrorMessage` is ALWAYS included — it's git's own diagnostic and the ONLY place the
        // specific overwritten path(s) get named — even when `cleanupIssue` is also set (the ordinary
        // case here: `resetOrSkip` skips its reset whenever unstaged dirt PREDATED this merge attempt,
        // which is exactly what triggered this branch in the first place, so `cleanupIssue` is populated
        // on nearly every real hit). An earlier draft of this fix used `cleanupIssue`'s presence to
        // choose between the two messages and silently DROPPED `rawErrorMessage` — and with it the
        // path name — whenever cleanup was skipped; caught by this file's own mutation-tested backstop.
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
    // Stamp a second trailer (card f621f185): the branch's own touched-path-set digest, computed HERE from
    // the branch ref directly (HEAD hasn't moved yet — `--squash` never advances it) so it reflects what the
    // branch itself actually changed, independent of whatever ended up staged. This is what lets a LATER
    // determination verify a landed commit purely from its own ancestry (sha^..sha) once the branch ref is
    // gone — see changedPathSetDigest's doc for why a full content hash doesn't work here and a path-set does.
    // Best-effort: a capture failure just omits the trailer (falls back to the pre-fix degraded behavior for
    // THIS commit) rather than blocking a real, already-successful merge.
    // Both the path-set trailer and the worker-commit-log body (card 8b7b81e0 DoD-3, below) need the SAME
    // merge-base(HEAD, branch) — computed ONCE here so a transient failure of this single call degrades
    // both together rather than paying for (and separately failing) two near-identical git calls.
    let pathSetTrailer = "";
    let workerCommitLogBody: string | undefined;
    try {
      const mergeBaseForSquashMeta = (await withTimeout(git.raw(["merge-base", "HEAD", branch]), timeoutMs, "git merge-base (canonical, squash metadata)")).trim();
      const digest = await changedPathSetDigest(git, mergeBaseForSquashMeta, branch, timeoutMs);
      pathSetTrailer = `\nLoom-Worker-PathSet: ${digest}`;
      workerCommitLogBody = await deriveWorkerCommitLogBody(repoPath, branch, mergeBaseForSquashMeta, subject, deps);
    } catch (e) {
      // Best-effort; the commit still lands, just without this trailer/body — but the PathSet omission IS a
      // real degradation of a brand-new, live commit (not a legacy artifact), so it must be logged here, at
      // the moment it happens — findLandedSquashCommit/scanMergedCommitMap only ever see the trailer's
      // ABSENCE later and can't tell a capture failure apart from genuinely predating the trailer (card
      // 9f776570). The commit-log body has no such downstream reader to mislead, so its own loss here rides
      // along silently under the same log line rather than needing one of its own.
      // eslint-disable-next-line no-console
      console.warn(`[git] mergeBranchLocked: Loom-Worker-PathSet capture failed for ${branch} — commit lands ` +
        `without the trailer: ${(e as Error).message}`);
    }
    const bodyBlock = workerCommitLogBody ? `\n\n${workerCommitLogBody}` : "";
    const message = `${subject}${bodyBlock}\n\nLoom-Worker-Branch: ${branch}${pathSetTrailer}\n`;
    try {
      await withTimeout(git.raw(["commit", "-m", message]), timeoutMs, "git commit (canonical, squash-merge)");
    } catch (e) {
      const cleanupIssue = await resetOrSkip("commit-failure cleanup");
      return { ok: false, reason: cleanupIssue ? `squash commit failed: ${(e as Error).message} (${cleanupIssue})` : `squash commit failed: ${(e as Error).message}` };
    }
    const sha = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (canonical, post-commit)")).trim();
    return { ok: true, sha, subject };

  } finally {
    exitMergeDangerWindow(repoPath);
  }
}

/**
 * Boot-time companion to the entry check in {@link mergeBranchLocked} (card 9e77050f, narrowed by card
 * 06b5c47f): READ-ONLY, scans each given canonical repo path for dirty tracked state — staged and/or
 * unstaged; untracked files excluded, same rationale as the merge-time check — nothing here is at risk
 * from a `reset --hard` no one is going to run). Reports BOTH kinds, but the caller is expected to word
 * them differently (see `staged` on each result): only STAGED content is the residue class the merge-time
 * check actually refuses on — unstaged-only dirt (ordinary WIP, or a submodule gitlink whose checked-out
 * commit sits ahead of its recorded pointer, a normal steady state for a repo with submodules) will NOT
 * block the next merge attempt. This does NOT close a hole by itself — the merge-time refusal already
 * makes the corruption impossible on its own, since a staged-residue-bearing repo now fails its NEXT merge
 * attempt closed instead of silently absorbing it. This exists only to shrink the detection window:
 * without it, residue left by a daemon dying mid-merge sits unnoticed until someone happens to attempt a
 * merge against that repo; with it, a boot-time scan surfaces it the moment the daemon comes back up.
 * NEVER resets, NEVER blocks boot, NEVER throws — same reasoning as the merge-time check for why it only
 * reports: this can't tell a dead squash's leftover stage apart from a human's own work-in-progress in
 * that checkout either, so touching it here would be exactly as unsafe as touching it at merge time. A
 * repo that isn't a real git checkout (e.g. a vault-only project's `repoPath`, or a deleted/unreadable
 * directory) is silently skipped, not surfaced as a failure — this is a best-effort courtesy scan, not a
 * boot gate.
 *
 * BOUNDED + NON-INTERACTIVE (board card 44c28799, same pass as {@link mergeBranchLocked}): this ran an
 * unbounded `simpleGit(repoPath)` with no block-timeout — a repo on a busy/locked disk (the same class of
 * hang that once wedged daemon boot for hours, see {@link GIT_OP_TIMEOUT_MS}'s doc) would hang this loop's
 * `await` forever, one repo blocking the scan of every repo after it. Fire-and-forget from the caller
 * (index.ts never awaits this before serving traffic) so the boot-blocking risk was always low, but the
 * fix is the same one-line convention as everywhere else in this file — no reason to leave a second
 * unbounded instance behind while fixing the first.
 */
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
