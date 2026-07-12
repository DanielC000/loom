import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { simpleGit, type SimpleGit } from "simple-git";
import { WORKTREES_DIR } from "../paths.js";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  /** The repo's HEAD sha at the moment of this call — the worktree branch's FORK POINT off main, not the
   *  worktree's own branch. Codescape's baseRef needs this (a worktree's own branch as its own base is
   *  always a 0-diff no-op); see the CR fix at sessions/service.ts's fireCodescapeRegister call site. */
  mainSha: string;
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
   * Injectable KILLABLE directory removal for removeWorktree's backstop (defaults to
   * {@link killableRemoveDir}). Lets a test simulate either a CLEAN reject (settles fast, `removed:false,
   * killed:false` — the transient EBUSY/EPERM handle-lag case) or a genuine HANG (a promise that never
   * resolves) and prove removeWorktree still returns within `timeoutMs` either way.
   */
  removeDir?: (target: string, timeoutMs: number) => Promise<RemoveDirResult>;
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
  try {
    const res = await run(worktreePath, timeoutMs, manager);
    installOk = res.ok;
    if (!res.ok) logProvisionFailure("install", manager, worktreePath, res.reason ?? "unknown reason");
  } catch (e) {
    // A provisioner should never throw, but belt-and-suspenders: a throw here must NOT abort createWorktree.
    logProvisionFailure("install", manager, worktreePath, (e as Error).message);
  }

  if (!installOk || !isWorkspaceMonorepo(worktreePath, manager)) return;
  if (deps.runBuild === false) return; // build-free rig (e.g. a noCommit review role) — install only, skip the monorepo build

  const buildTimeoutMs = deps.buildTimeoutMs ?? PROVISION_BUILD_TIMEOUT_MS;
  const buildRunner = deps.build ?? ((wt: string, ms: number, mgr: PackageManager) => runBoundedInstall(WORKSPACE_BUILD_COMMANDS[mgr], wt, ms));
  try {
    const res = await buildRunner(worktreePath, buildTimeoutMs, manager);
    if (!res.ok) logProvisionFailure("build", manager, worktreePath, res.reason ?? "unknown reason");
  } catch (e) {
    // A builder should never throw, but belt-and-suspenders: a throw here must NOT abort createWorktree.
    logProvisionFailure("build", manager, worktreePath, (e as Error).message);
  }
}

/**
 * CLASSIFIED, LOUD failure log for one provisioning phase (install or the monorepo build step) — the fix
 * for the old silent `console.warn`, which gave no signal that a worktree shipped un-build-ready. Names
 * the exact phase + detected package manager + worktree path, the worker-facing consequence, and the
 * underlying reason — which for a real command failure already carries a captured stdout+stderr TAIL
 * (see {@link appendTail}/{@link formatTail}), mirroring the markitdown provisioning-status pattern: a
 * specific classified reason plus enough context to diagnose without re-running the command by hand.
 * `console.error` (not `.warn`) so it isn't lost among the daemon's routine warnings. Still purely a log
 * — this never throws or blocks {@link provisionWorktreeDeps}/createWorktree.
 */
function logProvisionFailure(stage: "install" | "build", manager: PackageManager, worktreePath: string, reason: string): void {
  const consequence = stage === "install"
    ? "the worker will install its own dependencies before it can build"
    : "the worker will build sibling workspace packages (e.g. a monorepo's shared package) itself before its gate can pass";
  // eslint-disable-next-line no-console
  console.error(`[worktree:provision:FAILED] ${manager} ${stage} for ${worktreePath} did not complete — ${consequence}.\nReason: ${reason}`);
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
 * (canonical main lives in repoPath). Plain `git.raw` to match createWorktree's existing (unbounded)
 * style; on the spawn hot path these are sub-second ref ops.
 */
async function recutStaleReusedBranch(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  const git = simpleGit(repoPath);
  const mainSha = (await git.raw(["rev-parse", "HEAD"])).trim();
  const aheadRaw = await git.raw(["rev-list", "--count", `${mainSha}..${branch}`]);
  // FAIL SAFE: only re-cut a PROVABLY-empty branch (0 ahead). A recovery branch (>0 ahead) OR a malformed/
  // unparseable count (NaN) → leave the branch EXACTLY as-is; never let a bad count fall through to the
  // DESTRUCTIVE reset below (the `|| 0`-treats-NaN-as-0 data-loss footgun). See {@link mayRecutOntoMain}.
  if (!mayRecutOntoMain(aheadRaw)) return;
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
  // The repo's CURRENT HEAD — the fork point this worktree's branch is (or was) cut off, captured up
  // front so it's correct for every path below (fresh cut, reuse, and reattach all fork off THIS sha).
  const mainSha = (await simpleGit(repoPath).raw(["rev-parse", "HEAD"])).trim();
  if (fs.existsSync(worktreePath)) {
    // Retained worktree → reuse (already provisioned). Re-cut an empty/stale branch onto current main
    // first; a recovery branch (unmerged work) is left exactly as-is.
    await recutStaleReusedBranch(repoPath, worktreePath, branch);
    return { worktreePath, branch, mainSha };
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
  return { worktreePath, branch, mainSha };
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
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  deps: BoundedGitDeps = {},
): Promise<{ removed: boolean; wedged: boolean }> {
  const { git, timeoutMs } = boundedGit(repoPath, deps);
  try {
    await withTimeout(git.raw(["worktree", "remove", worktreePath, "--force"]), timeoutMs, "git worktree remove");
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
    if (status === "??" && p.startsWith(".claude/")) continue;
    if (p.startsWith(".claude/skills/")) continue;
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
 *   - otherwise (clean + ahead, the normal path) → all-false ⇒ the done proceeds unchanged.
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
  const makeGit = deps.gitFactory ?? ((p, ms) => simpleGit(p, { timeout: { block: ms } }));

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
      if (Number.isFinite(ahead) && ahead === 0) return { uncommitted: false, files: [], zeroAhead: true };
    } catch {
      return { uncommitted: false, files: [], zeroAhead: false }; // FAIL SAFE
    }
  }

  return { uncommitted: false, files: [], zeroAhead: false };
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
/** One row of a diffstat — a changed file with its insertion/deletion counts (0/0 for binary). */
export interface DiffstatFile {
  file: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

/**
 * Translate a glob (supporting `**`, `*`, `?`) to an anchored RegExp matched against a POSIX,
 * repo-relative path. `**` (optionally `/`-bounded) crosses directories and may match zero segments;
 * `*`/`?` stay within a single segment. No `{a,b}` brace expansion — keep the surface small and
 * predictable. (Deliberately a small local copy rather than importing `mcp/repo-read.ts`'s equivalent —
 * this git-layer module shouldn't reach up into the mcp layer for a 15-line helper.)
 */
function pathGlobToRegExp(glob: string): RegExp {
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

export async function diffBranch(
  repoPath: string, branch: string, base = "HEAD",
  opts: { includePatch?: boolean; files?: string[]; pathGlob?: string } = {},
): Promise<{ filesChanged: number; insertions: number; deletions: number; files: DiffstatFile[]; patch: string }> {
  // The full unified `patch` is UNBOUNDED — on a large change it overflows an MCP display limit, blinding a
  // manager exactly when the diff is biggest/riskiest. So the patch is OPT-IN: callers that only need a
  // bounded summary pass includePatch:false and skip the expensive `git diff` entirely. Defaults to true so
  // existing callers (the orchestration view's workerDiff) stay byte-identical. The `files` diffstat — built
  // from the summary git already computes — is always returned and is the bounded review surface.
  const includePatch = opts.includePatch ?? true;
  const git = simpleGit(repoPath);
  const range = `${base}...${branch}`; // 3-dot: changes on `branch` since the merge-base with `base`
  const summary = await git.diffSummary([range]);
  const allFiles: DiffstatFile[] = summary.files.map((f) => ({
    file: f.file,
    insertions: "insertions" in f ? f.insertions : 0, // binary files carry before/after, not ins/del
    deletions: "deletions" in f ? f.deletions : 0,
    binary: f.binary,
  }));

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
      ? (files.length > 0 ? await git.diff([range, "--", ...files.map((f) => f.file)]) : "")
      : await git.diff([range])
    : "";

  return { filesChanged, insertions, deletions, files, patch };
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
 */
export type MergeEmptyKind = "ALREADY_MERGED" | "STAGE_EMPTY_RETRY";

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
export async function mergeMainIntoWorktree(
  repoPath: string, worktreePath: string, deps: BoundedGitDeps = {},
): Promise<{ ok: boolean; conflict?: boolean; reason?: string; merged?: boolean }> {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const makeGit = deps.gitFactory ?? ((p, ms) => simpleGit(p, { timeout: { block: ms } }));
  const repoGit = makeGit(repoPath, timeoutMs);
  const wtGit = makeGit(worktreePath, timeoutMs);

  let mainSha: string;
  try {
    mainSha = (await withTimeout(repoGit.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (main)")).trim();
  } catch (e) {
    return { ok: false, reason: `failed to resolve main tip: ${(e as Error).message}` };
  }

  // Already caught up? (worktree HEAD already has mainSha as an ancestor — the common case for a
  // freshly-cut branch.) A merge-base probe failure isn't fatal — fall through and let the merge attempt
  // below settle it either way.
  try {
    const mergeBase = (await withTimeout(wtGit.raw(["merge-base", "HEAD", mainSha]), timeoutMs, "git merge-base (worktree)")).trim();
    if (mergeBase === mainSha) return { ok: true, merged: false };
  } catch { /* fall through to attempt the merge */ }

  let mergeThrew = false;
  try {
    await withTimeout(wtGit.raw(["merge", "--no-edit", mainSha]), timeoutMs, "git merge main into worktree");
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
  return { ok: true, merged: true };
}

export async function mergeBranch(
  repoPath: string, branch: string, taskTitle?: string,
): Promise<{ ok: boolean; conflict?: boolean; sha?: string; noop?: boolean; reason?: string; emptyKind?: MergeEmptyKind }> {
  const git = simpleGit(repoPath);
  // Re-derive from a CLEAN index: clear any AFFIRMATIVE in-progress-merge residue (a stale MERGE_HEAD or
  // unmerged entries from an aborted op) BEFORE the squash, so a leftover state can't make the first
  // --squash stage nothing (the idempotency bug). Gated on a positive signal so a clean canonical repo is
  // never touched. The two probes are INDEPENDENT: `ls-files --unmerged` exits 0 on a clean repo (never
  // throws), so it runs FIRST and unconditionally; the `rev-parse --verify MERGE_HEAD` check (which exits
  // non-zero → throws when there is no in-progress merge) is isolated in its OWN try/catch so its throw
  // can't skip the unmerged probe — unmerged residue WITHOUT a MERGE_HEAD is now auto-recovered up front too.
  try {
    const unmerged = (await git.raw(["ls-files", "--unmerged"])).trim() !== "";
    let inProgressMerge = false;
    try {
      inProgressMerge = (await git.raw(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).trim() !== "";
    } catch { /* no MERGE_HEAD ⇒ that signal is simply false */ }
    if (inProgressMerge || unmerged) await git.raw(["reset", "--hard", "HEAD"]);
  } catch { /* ls-files failed (e.g. not a repo / no HEAD) ⇒ no residue to clear */ }

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
    // The cleanup that's supposed to leave the canonical repo UNTOUCHED can ITSELF fail (busy index lock,
    // read-only tree); swallowing it would assert a clean "conflict" while the repo is left with unmerged/
    // partial-index residue. SURFACE it via `reason` so the caller knows the canonical repo needs recovery
    // rather than trusting the (now false) "untouched" guarantee.
    try {
      await git.raw(["reset", "--hard", "HEAD"]);
    } catch (e) {
      return { ok: false, conflict: true, reason: `conflict cleanup (reset --hard HEAD) failed — canonical repo may have unmerged residue: ${(e as Error).message}` };
    }
    return { ok: false, conflict: true };
  }
  // No conflict. Did --squash stage anything? (Output-based, NOT exit-code: raw's exit-code handling is
  // unreliable — see isBranchMerged.) Empty after the residue-clear above is a GENUINE empty index.
  const staged = (await git.raw(["diff", "--cached", "--name-only"])).trim() !== "";
  if (!staged) {
    // A rawError with nothing staged AFTER the clean retry is a real merge failure → fail closed.
    if (rawError) {
      try { await git.raw(["reset", "--hard", "HEAD"]); } catch { /* nothing to reset */ }
      return { ok: false, reason: "git merge --squash failed (nothing staged)" };
    }
    // Clean no-op: classify so the caller can distinguish "already merged" from "no diff to merge". The
    // branch's commits are "already in main" iff a prior squash carrying its trailer is reachable from HEAD.
    const landed = await findLandedSquashCommit(repoPath, branch);
    return { ok: true, noop: true, emptyKind: landed ? "ALREADY_MERGED" : "STAGE_EMPTY_RETRY" };
  }
  // Land the staged diff as ONE plain commit (repo-config identity; clean subject + deterministic trailer).
  const rawSubject = (taskTitle && taskTitle.trim().split(/\r?\n/)[0]!.trim()) || branch;
  const subject = toConventionalSubject(rawSubject);
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
