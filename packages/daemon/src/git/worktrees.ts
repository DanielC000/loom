import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { simpleGit, type SimpleGit } from "simple-git";
import { WORKTREES_DIR } from "../paths.js";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
}

/**
 * Per-git-op ceiling for the BOOT-RECONCILE git ops (removeWorktree / findLandedSquashCommit / deleteBranch).
 * Generous for a real op (sub-second normally), but BOUNDED so a wedged child can't hang the caller.
 * This is the fix for the boot-outage: a git op on a busy/locked dir (e.g. a directory handle stuck by
 * an unrelated process) HANGS INDEFINITELY — it doesn't throw — and a try/catch only catches throws.
 * boot-reconcile runs these ops during daemon BOOT (Pass A: findLandedSquashCommit → finalizeMerge's
 * removeWorktree + deleteBranch; Pass B: removeWorktree), so one hung op blocked the whole daemon from
 * booting, for hours, on 2026-06-03. Every op in the reconcile path is now bounded by this.
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
   * Injectable filesystem remove for removeWorktree's backstop (defaults to the bounded recursive
   * `fs.promises.rm`). Lets a test simulate a stuck Windows directory handle — an `fs.rm` that NEVER
   * resolves (handle held by a separate process) — and prove the call still returns within `timeoutMs`.
   */
  rm?: (target: string) => Promise<void>;
}

/** Build the bounded git instance + resolve the timeout for one op, applying the seam's defaults. */
function boundedGit(repoPath: string, deps: BoundedGitDeps): { git: Pick<SimpleGit, "raw">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const makeGit = deps.gitFactory ?? ((p, ms) => simpleGit(p, { timeout: { block: ms } }));
  return { git: makeGit(repoPath, timeoutMs), timeoutMs };
}

/**
 * Reject `p` after `ms` if it hasn't settled, so a git step is bounded even if the underlying promise
 * NEVER settles. In production the simpleGit `block` timeout (set on the instance) also kills the hung
 * child so it doesn't leak — this race is the belt-and-suspenders guarantee that the FUNCTION returns
 * within the window regardless. The timer is cleared on the winning path; if it fires first the timer
 * is already done, so nothing lingers on the event loop.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms (hung child?)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Filesystem- and ref-safe key for a task: 12 hex chars of sha256(taskId). Keyed off the FULL id,
 * not `taskId.slice(0,8)` — two human-readable task ids sharing the first 8 chars used to collide
 * onto the same branch/worktree (H1.3). Deterministic, so the SAME task always resolves to the same
 * worktree (re-spawn after a rejected merge, and recycle which carries the stored path forward).
 */
function taskKey(taskId: string): string {
  return createHash("sha256").update(taskId).digest("hex").slice(0, 12);
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
 */
function pnpmInstall(worktreePath: string, timeoutMs: number): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const child = spawn("pnpm install --frozen-lockfile --prefer-offline", {
      cwd: worktreePath,
      shell: true,
      stdio: "ignore",
      env: { ...process.env, CI: "1" },
    });
    let settled = false;
    const done = (r: { ok: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done({ ok: false, reason: `pnpm install exceeded ${timeoutMs}ms (killed)` });
    }, timeoutMs);
    child.on("error", (e) => done({ ok: false, reason: e.message }));
    child.on("exit", (code) => done(code === 0 ? { ok: true } : { ok: false, reason: `pnpm install exited ${code ?? "null"}` }));
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
 */
function runBoundedInstall(command: string, worktreePath: string, timeoutMs: number): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: worktreePath,
      shell: true,
      stdio: "ignore",
      env: { ...process.env, CI: "1" },
    });
    let settled = false;
    const done = (r: { ok: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done({ ok: false, reason: `${command} exceeded ${timeoutMs}ms (killed)` });
    }, timeoutMs);
    child.on("error", (e) => done({ ok: false, reason: e.message }));
    child.on("exit", (code) => done(code === 0 ? { ok: true } : { ok: false, reason: `${command} exited ${code ?? "null"}` }));
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
 * Make a freshly-created worktree BUILD-READY by populating node_modules at creation, so the spawned
 * worker doesn't pay a full `pnpm install` before it can build — and a worker whose install would
 * fail/time out is caught HERE (bounded) instead of wedging the worker mid-task. (node_modules is
 * gitignored, so `git worktree add` checks out the tree WITHOUT it.)
 *
 * SAFE-BY-CONSTRUCTION removal: every supported install (pnpm/npm/yarn) gives the worktree its OWN
 * independent node_modules WITHIN the worktree — pnpm hardlinks into the shared content-addressable store
 * plus an internal `.pnpm` virtual store; npm/yarn write a self-contained `./node_modules`. None is a
 * junction/symlink into the main checkout, so removeWorktree's recursive `fs.rm` only ever deletes the
 * worktree's own tree and can NEVER recurse into the main checkout's node_modules (the skill-store-nuke /
 * junction-follow class of bug — see removeWorktree). The companion test proves this. NEVER
 * share/symlink/junction node_modules across worktrees — native modules + concurrent install-state across
 * parallel workers would break, and it reintroduces the landmine. This is load-bearing.
 *
 * BEST-EFFORT + BOUNDED: acts only when a recognized JS lockfile marks the worktree root
 * ({@link detectPackageManager} — pnpm-lock.yaml / package-lock.json / yarn.lock, in that deterministic
 * precedence; a non-JS repo, incl. the bare temp repos in tests, is skipped silently). Any failure/timeout
 * is logged and SWALLOWED — the worker simply falls back to installing itself, exactly as before this
 * change. It MUST NEVER throw past createWorktree or wedge the spawn path.
 */
export async function provisionWorktreeDeps(worktreePath: string, deps: ProvisionDeps = {}): Promise<void> {
  const manager = detectPackageManager(worktreePath);
  if (!manager) return; // no recognized JS lockfile → nothing to provision
  const timeoutMs = deps.timeoutMs ?? PROVISION_TIMEOUT_MS;
  const run = deps.provision ?? INSTALLERS[manager];
  try {
    const res = await run(worktreePath, timeoutMs, manager);
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[worktree] dep provisioning (${manager}) for ${worktreePath} did not complete (${res.reason}); the worker will install on its own.`);
    }
  } catch (e) {
    // A provisioner should never throw, but belt-and-suspenders: a throw here must NOT abort createWorktree.
    // eslint-disable-next-line no-console
    console.warn(`[worktree] dep provisioning (${manager}) for ${worktreePath} threw (${(e as Error).message}); the worker will install on its own.`);
  }
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
 * main) is 0, and for a recovery branch is its real prior commit(s). We reset to a SHA, never a branch
 * name — a worktree can't check out a branch that's checked out elsewhere (canonical main lives in
 * repoPath). Plain `git.raw` to match createWorktree's existing (unbounded) style; on the spawn hot
 * path these are sub-second ref ops.
 */
async function recutStaleReusedBranch(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  const git = simpleGit(repoPath);
  const mainSha = (await git.raw(["rev-parse", "HEAD"])).trim();
  const ahead = parseInt((await git.raw(["rev-list", "--count", `${mainSha}..${branch}`])).trim(), 10) || 0;
  if (ahead > 0) return; // RECOVERY: real unmerged work → leave the branch EXACTLY as-is (load-bearing).
  // Empty/stale branch → re-cut its pointer + checkout onto current main (SHA, never a branch name).
  await simpleGit(worktreePath).raw(["reset", "--hard", mainSha]);
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
 */
export async function createWorktree(
  repoPath: string, projectId: string, taskId: string, deps: ProvisionDeps = {},
): Promise<WorktreeInfo> {
  const key = taskKey(taskId);
  const branch = `loom/${key}`;
  const worktreePath = path.join(WORKTREES_DIR, projectId, key);
  if (fs.existsSync(worktreePath)) {
    // Retained worktree → reuse (already provisioned). Re-cut an empty/stale branch onto current main
    // first; a recovery branch (unmerged work) is left exactly as-is.
    await recutStaleReusedBranch(repoPath, worktreePath, branch);
    return { worktreePath, branch };
  }

  const git = simpleGit(repoPath);
  fs.mkdirSync(path.join(WORKTREES_DIR, projectId), { recursive: true });
  await git.raw(["worktree", "prune"]); // drop any stale admin record for a since-deleted dir
  const branchExists = (await git.raw(["branch", "--list", branch])).trim() !== "";
  await git.raw(branchExists
    ? ["worktree", "add", worktreePath, branch]        // branch survived a worktree removal → re-attach
    : ["worktree", "add", worktreePath, "-b", branch]); // fresh task → new branch
  if (branchExists) {
    // Re-attached an existing branch at its old tip → same re-cut: empty/stale → current main; a
    // recovery branch (unmerged work) → untouched.
    await recutStaleReusedBranch(repoPath, worktreePath, branch);
  }

  // Populate node_modules so the worker is build-ready without paying a full `pnpm install` first.
  // Best-effort + bounded; on failure the worker just installs on its own (see provisionWorktreeDeps).
  await provisionWorktreeDeps(worktreePath, deps);
  return { worktreePath, branch };
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
    // eslint-disable-next-line no-console
    console.warn(`[worktree] could not delete merged branch ${branch}: ${(e as Error).message}`);
  }
}

/**
 * Remove a worker's worktree and prune the admin record. Branch deletion (after merge) is
 * #16's concern, not here.
 *
 * Windows handle-release race: when a worker is hard-stopped just before its worktree is removed
 * (the merge path — confirmWorkerMerge), node-pty's exit event fires when the process SIGNALS
 * exit, but the OS releases the worktree's directory handle a beat later. `git worktree remove`
 * then fails ("failed to delete '…': Permission denied") and is NOT idempotent — it can drop the
 * worktree's admin record while leaving the dir on disk, so retrying the same command fails with
 * "is not a working tree". So: attempt the clean git removal once (best-effort), then back it up
 * with a filesystem delete that retries the EBUSY/EPERM lag (fs.rm maxRetries — built for exactly
 * this), then prune any stale admin record. When nothing holds the dir (merge-gate's no-pty rows)
 * the git removal succeeds and the backstop is a no-op.
 *
 * BOUNDED (priority reliability fix): a busy/locked worktree dir makes `git worktree remove` HANG
 * INDEFINITELY rather than throw, and boot-reconcile's Pass B calls this DURING daemon boot — so one
 * stuck removal blocked the whole daemon from booting for hours (2026-06-03). Both git ops now run on
 * a simpleGit configured with a `block` timeout (kills a no-output hung child) AND through a
 * {@link withTimeout} race, so the worst case is a BOUNDED failure within ~{@link GIT_OP_TIMEOUT_MS}
 * — the dir is left on disk for a later GC (boot-reconcile Pass B), NEVER an infinite hang. The
 * git instance/timeout is injectable via {@link BoundedGitDeps} so a test can prove the bound.
 *
 * The FILESYSTEM backstop is bounded too: boot-reconcile Pass B (reconcileOrchestrationOnBoot in
 * index.ts) runs this DURING boot, BEFORE app.listen(), so an unbounded hang here wedges the WHOLE
 * daemon — exactly the 2026-06-04 outage, where the recursive `fs.rm` on a worktree dir with a stuck
 * Windows directory handle (held by a SEPARATE process — the documented inert orphans) blocked on the
 * libuv threadpool and never returned, so boot never reached `listen` (port 4317 unbound ~5-6 min).
 * The 2026-06-03 fix bounded only the git ops; this fs `rm` slipped through. It now runs through the
 * same {@link withTimeout} race: on timeout we SWALLOW and leave the dir on disk for a later GC rather
 * than block the caller. THREADPOOL CAVEAT: withTimeout only stops US waiting — the detached `fs.rm`
 * keeps occupying one libuv threadpool slot until/unless the handle releases. Acceptable vs. a wedged
 * daemon: the realistic count is the 1-2 inert orphans, not a slot leak that starves the pool. The fs
 * remove is injectable via {@link BoundedGitDeps.rm} so a test can prove the bound on a never-releasing handle.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  deps: BoundedGitDeps = {},
): Promise<void> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    await withTimeout(git.raw(["worktree", "remove", worktreePath, "--force"]), timeoutMs, "git worktree remove");
  } catch {
    // A hang (timeout-kill), a busy handle, or git already de-registering the worktree without
    // deleting the dir — all fall through to the filesystem backstop.
  }
  const rm = deps.rm ?? ((p) => fs.promises.rm(p, { recursive: true, force: true, maxRetries: 40, retryDelay: 200 }));
  try {
    await withTimeout(rm(worktreePath), timeoutMs, "fs.rm worktree");
  } catch (e) {
    // A stuck directory handle (held by a separate process) makes the recursive remove block on the
    // libuv threadpool forever — it never throws on its own. Bounded by withTimeout above: SWALLOW and
    // leave the dir on disk for a later GC rather than wedge boot. See the threadpool caveat in the docstring.
    // eslint-disable-next-line no-console
    console.warn(`[worktree] could not remove dir ${worktreePath} (left on disk for a later GC): ${(e as Error).message}`);
  }
  try {
    await withTimeout(git.raw(["worktree", "prune"]), timeoutMs, "git worktree prune");
  } catch {
    // A hung/failed prune must NOT throw past removeWorktree (which would re-introduce the boot hang
    // via finalizeMerge / Pass B). A stale admin record is harmless — createWorktree prunes on reuse.
  }
}

/**
 * Is `branch` already fully merged into `base` (default: the repo's current HEAD — the canonical
 * branch confirmWorkerMerge's `git merge` lands onto)? Used by the boot-time reconcile to finish a
 * merge whose bookkeeping (worktree/branch/task) never completed (e.g. the daemon died right after
 * the commit). Detected via `git branch --merged <base> --list <branch>` membership — exit-0 with a
 * non-empty line only when the branch both exists AND is fully reachable from `base`. (We deliberately
 * do NOT use `merge-base --is-ancestor`: simple-git's raw doesn't reject on its exit-1 "not-ancestor"
 * signal, so a try/catch around it reads every branch as merged.) Returns false when the branch ref
 * is gone (a completed merge deletes it), which keeps the reconcile idempotent.
 *
 * BOUNDED: this is the FIRST op boot-reconcile Pass A runs per session, so a hang here wedges boot
 * before any removal even starts. The op now runs through the block-timeout + {@link withTimeout}
 * guard; a timeout-throw is caught and read as "not merged" (false) — the SAFE default, since Pass A
 * then skips the session rather than acting on a bad signal. The next boot retries it.
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
 * Does `git status --porcelain` output represent REAL worker work, or only daemon-injected noise?
 * Loom mirrors its managed skills/settings into every worktree's `.claude/` (injectSkills); in a
 * worktree those untracked files are hidden only via the SHARED main `.git/info/exclude` (hideFromGit
 * no-ops in a worktree, where `.git` is a file), so a skill name not yet in that shared exclude
 * surfaces as `?? .claude/…`. That is NEVER the worker's product — the product is src/, package files,
 * tests, anything OUTSIDE `.claude/` — so an UNTRACKED path under `.claude/` is ignored. Everything
 * else counts as work: tracked modifications ANYWHERE (incl. a tracked file under `.claude/`),
 * staged/unstaged changes, and untracked paths OUTSIDE `.claude/`. Without this discriminator the
 * injected noise would make a genuinely-merged worktree read dirty and block its legitimate cleanup
 * (the merge-recovery regression). Exported so the guard's behavior is unit-testable in isolation.
 */
export function worktreeStatusHasWork(porcelain: string): boolean {
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    // porcelain v1 line: 2 status chars, a space, then the path. `??` = untracked.
    if (line.slice(0, 2) === "??") {
      let p = line.slice(3);
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1); // git quotes paths with special chars
      if (p.startsWith(".claude/")) continue; // daemon-injected untracked noise → not the worker's product
    }
    return true; // any tracked change, or any untracked path outside `.claude/`, is real work
  }
  return false;
}

/**
 * SAFE-TO-DISCARD guard for BOTH boot-reconcile passes (P0 data-loss fix, 2026-06-05). Does this
 * worktree still hold work we'd LOSE by deleting it? "Work" = EITHER the working tree is DIRTY
 * (real uncommitted/untracked changes — see {@link worktreeStatusHasWork}, which ignores daemon-injected
 * `.claude/` noise) OR the branch is AHEAD OF `base` (commits not yet reachable from the canonical
 * HEAD — `git rev-list --count base..branch` > 0).
 *
 * THE BUG IT GUARDS: a `daemon_restart` marks EVERY prior-run session `exited` at boot, so an unrelated
 * manager's LIVE worker is misdetected at boot and its worktree deleted mid-task, pre-commit (confirmed
 * data loss, 2026-06-05). TWO vectors, both gated by this:
 *   - Pass B GC'd any exited+unprotected worktree (the branch-AHEAD case).
 *   - Pass A treats a 0-commit branch as a merged orphan (its tip == HEAD), so a live worker with
 *     UNCOMMITTED work and a not-yet-advanced branch was finalizeMerge'd — worktree removed AND task
 *     marked done AND branch deleted. A genuine orphaned merge is clean AND 0-ahead → this returns
 *     false → it finalizes normally (no merge-recovery regression).
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
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  const makeGit = deps.gitFactory ?? ((p, ms) => simpleGit(p, { timeout: { block: ms } }));

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
  const makeGit = deps.gitFactory ?? ((p, ms) => simpleGit(p, { timeout: { block: ms } }));
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

/** A branch's changes since it diverged from base — the manager's pre-merge diff review (#16). */
export async function diffBranch(
  repoPath: string, branch: string, base = "HEAD",
): Promise<{ filesChanged: number; insertions: number; deletions: number; patch: string }> {
  const git = simpleGit(repoPath);
  const range = `${base}...${branch}`; // 3-dot: changes on `branch` since the merge-base with `base`
  const summary = await git.diffSummary([range]);
  const patch = await git.diff([range]);
  return { filesChanged: summary.files.length, insertions: summary.insertions, deletions: summary.deletions, patch };
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

/** Does `branch` still exist as a ref in `repoPath`? (A completed merge deletes it.) */
async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    return (await simpleGit(repoPath).raw(["branch", "--list", branch])).trim() !== "";
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
 * stage 3), returned directly.
 *
 * FAILS SAFE: every op is bounded by the same block-timeout + {@link withTimeout} guard as the other
 * reconcile ops; ANY error/timeout returns null (treated as NOT-landed) — the SAFE default, since Pass A
 * then KEEPS the worktree rather than finalizing on a bad signal. Injectable via {@link BoundedGitDeps}.
 */
export async function findLandedSquashCommit(
  repoPath: string, branch: string, base = "HEAD", deps: BoundedGitDeps = {},
): Promise<string | null> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    const sha = (await withTimeout(
      git.raw(["log", base, "-F", `--grep=Loom-Worker-Branch: ${branch}`, "--format=%H", "--max-count=1"]),
      timeoutMs, "git log --grep trailer",
    )).trim();
    if (!sha) return null;
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
 * NOT bounded like the boot-reconcile ops: this runs on-demand per HTTP request, so a wedged git
 * child hangs only that one request, never daemon boot. Each stage is guarded so a failure falls
 * through to the next rather than throwing the whole call.
 */
export async function workerDiff(
  repoPath: string,
  opts: { branch: string | null; worktreePath: string | null },
): Promise<WorkerDiff | null> {
  const { branch, worktreePath } = opts;

  // 1. Live/retained worktree → include uncommitted work (diff from spawn point to the working tree).
  if (branch && worktreePath && fs.existsSync(worktreePath)) {
    try {
      const base = (await simpleGit(repoPath).raw(["merge-base", "HEAD", branch])).trim();
      const wt = simpleGit(worktreePath);
      const summary = await wt.diffSummary([base]); // <base> with one arg = base..WORKING-TREE
      const patch = await wt.diff([base]);
      return {
        filesChanged: summary.files.length, insertions: summary.insertions,
        deletions: summary.deletions, patch, uncommitted: true,
      };
    } catch { /* worktree gone/wedged mid-read → fall through to the committed-branch paths */ }
  }

  // 2. Branch still on the canonical repo (committed, not yet merged) → committed 3-dot diff.
  if (branch && await branchExists(repoPath, branch)) {
    try { return await diffBranch(repoPath, branch); } catch { /* fall through */ }
  }

  // 3. Branch merged + deleted → reconstruct the landed diff from the SQUASH commit, found by the
  //    deterministic Loom-Worker-Branch trailer (under squash there is no merge commit to grep for).
  if (branch) {
    try {
      const sha = await findLandedSquashCommit(repoPath, branch);
      if (sha) {
        const git = simpleGit(repoPath);
        const range = `${sha}^..${sha}`; // the squash commit's own changes (single parent)
        const summary = await git.diffSummary([range]);
        const patch = await git.diff([range]);
        return {
          filesChanged: summary.files.length, insertions: summary.insertions,
          deletions: summary.deletions, patch, merged: true,
        };
      }
    } catch { /* squash commit unfindable → null below */ }
  }

  return null;
}

/**
 * Merge a worker's branch into the repo's current branch as a SINGLE SQUASH COMMIT — `git merge --squash`
 * stages the combined diff WITHOUT committing, then a plain `git commit` lands it as ONE commit, so each
 * task = one clean commit on main (not a real-commit + a noise merge-commit). Returns the new squash
 * commit's SHA. FAIL-CLOSED.
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
 * canonical repo UNTOUCHED. "Nothing staged after --squash" (the branch is already in main) is a clean
 * NO-OP, not a crash.
 */
export async function mergeBranch(
  repoPath: string, branch: string, taskTitle?: string,
): Promise<{ ok: boolean; conflict?: boolean; sha?: string; noop?: boolean; reason?: string }> {
  const git = simpleGit(repoPath);
  let rawError = false;
  try {
    await git.raw(["merge", "--squash", branch]);
  } catch {
    rawError = true; // a conflict OR a real failure — the explicit checks below decide
  }
  // Conflict? Unmerged index entries are the reliable signal. Under --squash there is no MERGE_HEAD, so
  // `git reset --hard HEAD` (NOT `merge --abort`) restores the canonical repo to its pre-merge state.
  const conflicted = (await git.raw(["ls-files", "--unmerged"])).trim() !== "";
  if (conflicted) {
    try { await git.raw(["reset", "--hard", "HEAD"]); } catch { /* nothing to reset */ }
    return { ok: false, conflict: true };
  }
  // No conflict. Did --squash stage anything? (Output-based, NOT exit-code: raw's exit-code handling is
  // unreliable — see isBranchMerged.) Empty ⇒ the branch is already in main (clean no-op), or the merge
  // errored for another reason (fail-closed: reset + refuse).
  const staged = (await git.raw(["diff", "--cached", "--name-only"])).trim() !== "";
  if (!staged) {
    if (rawError) {
      try { await git.raw(["reset", "--hard", "HEAD"]); } catch { /* nothing to reset */ }
      return { ok: false, reason: "git merge --squash failed (nothing staged)" };
    }
    return { ok: true, noop: true }; // branch already in main → nothing to commit
  }
  // Land the staged diff as ONE plain commit (repo-config identity; clean subject + deterministic trailer).
  const subject = (taskTitle && taskTitle.trim().split(/\r?\n/)[0]!.trim()) || branch;
  const message = `${subject}\n\nLoom-Worker-Branch: ${branch}\n`;
  try {
    await git.raw(["commit", "-m", message]);
  } catch (e) {
    try { await git.raw(["reset", "--hard", "HEAD"]); } catch { /* leave nothing partial */ }
    return { ok: false, reason: `squash commit failed: ${(e as Error).message}` };
  }
  const sha = (await git.raw(["rev-parse", "HEAD"])).trim();
  return { ok: true, sha };
}
