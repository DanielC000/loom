import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { simpleGit, type SimpleGit } from "simple-git";
import { WORKTREES_DIR } from "../paths.js";
import { nonInteractiveEnv } from "./writer.js";

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

/** Build the bounded git instance + resolve the timeout for one op, applying the seam's defaults. */
function boundedGit(repoPath: string, deps: BoundedGitDeps): { git: Pick<SimpleGit, "raw">; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const makeGit = deps.gitFactory ?? ((p, ms) => simpleGit(p, { timeout: { block: ms } }));
  return { git: makeGit(repoPath, timeoutMs), timeoutMs };
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
  const makeGit = deps.gitFactory ?? ((p, ms) => simpleGit(p, { timeout: { block: ms } }).env(nonInteractiveEnv()));
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

/** Cap on {@link ReusedDirtyWorktreeInfo.statusSummary} — enough for a manager (or an injected worker
 *  kickoff note) to see real leftover changes without growing the spawn result/prompt unboundedly. */
const REUSED_DIRTY_SUMMARY_MAX_LINES = 30;
const REUSED_DIRTY_SUMMARY_MAX_CHARS = 2000;

/**
 * Read-only check (board card 2250836c) for the `fs.existsSync(worktreePath)` REUSE branch of {@link
 * createWorktree}: does this retained worktree still carry real leftover uncommitted work? Called AFTER
 * {@link recutStaleReusedBranch} has already run, so it reports whatever is genuinely still dirty once the
 * existing reuse lifecycle has had its say — this function itself never writes to the tree, only reads
 * `git status --porcelain` and reuses {@link uncommittedWorkFiles}'s daemon-noise filter (so injected
 * `.claude/` churn never false-positives a clean reuse as dirty).
 *
 * FAILS SAFE: any git error/timeout is read as "not dirty" (`undefined`) rather than blocking the spawn —
 * the worst case is a missed flag, never a spawn failure. Plain (unbounded) `simpleGit` call to match this
 * function's existing style (`recutStaleReusedBranch` above is equally unbounded on the same hot path).
 */
async function detectReusedDirtyWorktree(worktreePath: string): Promise<ReusedDirtyWorktreeInfo | undefined> {
  try {
    const porcelain = await simpleGit(worktreePath).raw(["status", "--porcelain"]);
    const files = uncommittedWorkFiles(porcelain);
    if (files.length === 0) return undefined;
    let truncated = files.length > REUSED_DIRTY_SUMMARY_MAX_LINES;
    let statusSummary = files.slice(0, REUSED_DIRTY_SUMMARY_MAX_LINES).join("\n");
    if (statusSummary.length > REUSED_DIRTY_SUMMARY_MAX_CHARS) {
      statusSummary = statusSummary.slice(0, REUSED_DIRTY_SUMMARY_MAX_CHARS);
      truncated = true;
    }
    return { statusSummary, fileCount: files.length, truncated };
  } catch {
    return undefined; // FAIL SAFE — a status-check hiccup must never block or alter the spawn
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
 * error); only when that's genuinely > 0 do we pay for `merge-base` + a bounded `diff --name-only` to name
 * the fork point and what changed since. Any error past the count read also reads as "not stale" — this is
 * purely ADVISORY and must never block or alter a spawn.
 */
async function detectStaleBase(repoPath: string, branch: string, mainSha: string): Promise<StaleBaseInfo | undefined> {
  const behindBy = await countCommitsBehind(repoPath, branch, mainSha);
  if (!behindBy || behindBy <= 0) return undefined;
  try {
    const git = simpleGit(repoPath);
    const baseSha = (await git.raw(["merge-base", branch, mainSha])).trim();
    const filesRaw = await git.raw(["diff", "--name-only", baseSha, mainSha]);
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
 *  path of {@link createWorktree} (card 5150fdc2, parts 1+3). */
async function resolveStaleBase(
  repoPath: string, worktreePath: string, branch: string, mainSha: string,
): Promise<StaleBaseInfo | undefined> {
  const info = await detectStaleBase(repoPath, branch, mainSha);
  if (!info) return undefined;
  return autoForwardStaleBase(repoPath, worktreePath, info);
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
): Promise<WorktreeInfo> {
  const key = taskKey(taskId);
  const branch = `loom/${key}`;
  const worktreePath = repoKey && repoKey !== "primary"
    ? path.join(WORKTREES_DIR, projectId, repoKey, key)
    : path.join(WORKTREES_DIR, projectId, key);
  // The repo's CURRENT HEAD — the fork point this worktree's branch is (or was) cut off, captured up
  // front so it's correct for every path below (fresh cut, reuse, and reattach all fork off THIS sha).
  const mainSha = (await simpleGit(repoPath).raw(["rev-parse", "HEAD"])).trim();
  if (fs.existsSync(worktreePath)) {
    // Retained worktree → reuse (already provisioned). Re-cut an empty/stale branch onto current main
    // first; a recovery branch (unmerged work) is left exactly as-is.
    await recutStaleReusedBranch(repoPath, worktreePath, branch);
    // Board card 2250836c: surface (never clean) any real leftover uncommitted work on this reused
    // worktree — read-only, runs after the recut above so it reports the ACTUAL post-recut state.
    const reusedDirtyWorktree = await detectReusedDirtyWorktree(worktreePath);
    // Card 5150fdc2 parts 1+3: a recovery (>0-ahead) branch whose base has since fallen behind main is
    // detected and, when possible, auto-forwarded — see resolveStaleBase. Runs AFTER the dirty-leftover
    // read above so that read reflects the PRE-merge state (the leftover uncommitted work a manager/
    // worker should see is whatever was there before Loom does anything else to the tree).
    const staleBase = await resolveStaleBase(repoPath, worktreePath, branch, mainSha);
    return {
      worktreePath, branch, mainSha,
      ...(reusedDirtyWorktree ? { reusedDirtyWorktree } : {}),
      ...(staleBase ? { staleBase } : {}),
    };
  }

  const git = simpleGit(repoPath);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await git.raw(["worktree", "prune"]); // drop any stale admin record for a since-deleted dir
  const branchExists = (await git.raw(["branch", "--list", branch])).trim() !== "";
  await git.raw(branchExists
    ? ["worktree", "add", worktreePath, branch]        // branch survived a worktree removal → re-attach
    : ["worktree", "add", worktreePath, "-b", branch]); // fresh task → new branch
  let staleBase: StaleBaseInfo | undefined;
  if (branchExists) {
    // Re-attached an existing branch at its old tip → same re-cut: empty/stale → current main; a
    // recovery branch (unmerged work) → untouched.
    await recutStaleReusedBranch(repoPath, worktreePath, branch);
    // Card 5150fdc2 parts 1+3 — same detect+auto-forward as the dir-exists reuse path above, BEFORE
    // provisionWorktreeDeps below so a package.json/lockfile change the forward brings in is what
    // actually gets installed.
    staleBase = await resolveStaleBase(repoPath, worktreePath, branch, mainSha);
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
 * - Any git failure (missing range, non-repo, etc.) returns an empty map — the caller degrades to "no
 *   status available", not an error.
 */
async function diffNameStatus(git: SimpleGit, range: string): Promise<Map<string, DiffstatFile["status"]>> {
  const map = new Map<string, DiffstatFile["status"]>();
  const SINGLE_PATH_STATUS = new Set(["A", "M", "D", "T", "U", "X", "B"]);
  try {
    const raw = await git.raw(["diff", "--name-status", range]);
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
): Promise<{ filesChanged: number; insertions: number; deletions: number; files: DiffstatFile[]; allFiles: DiffstatFile[]; patch: string; hint?: string }> {
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

  // OPTIONAL status enrichment (includeStatus): a second, best-effort `git diff --name-status` call,
  // merged onto allFiles by path. Off by default — every existing caller pays no extra git call and
  // stays byte-identical; only reviewWorkerMerge's deny-glob check opts in.
  if (opts.includeStatus) {
    const statusByPath = await diffNameStatus(git, range);
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
      ? (files.length > 0 ? await git.diff([range, "--", ...files.map((f) => f.file)]) : "")
      : await git.diff([range])
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
 * Deterministic digest (sha256) over the SORTED set of paths changed between `base` and `ref` — `git diff
 * --name-only`, `--no-renames` so a rename is counted as its two raw paths rather than resolved through
 * git's own rename-detection heuristic (keeps the digest independent of that heuristic ever changing),
 * newline-joined after sorting so traversal order never matters.
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
  const args = ["diff", "--name-only", "--no-renames", `${base}..${ref}`];
  const raw = timeoutMs === undefined
    ? await git.raw(args)
    : await withTimeout(git.raw(args), timeoutMs, "git diff --name-only (path-set fingerprint)");
  const paths = raw.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  return createHash("sha256").update(paths.join("\n")).digest("hex");
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
    // boundedGit's simpleGit(repoPath, ...) constructor throws SYNCHRONOUSLY for a nonexistent repoPath
    // (GitConstructError) — this must be INSIDE the try, not before it (mirrors scanMergedCommitMap's fix),
    // or a vault-only/moved-repo project's repoPath breaks the fail-safe-null contract instead of resolving
    // to null.
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
          "predates the Loom-Worker-PathSet trailer — trusting Loom-Worker-Branch presence alone (card f621f185)");
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

// ── Diff cache for the polled orchestration-view endpoint (`GET /api/sessions/:id/diff`) ──────────
//
// Overview polls this once per rendered worker card every ~4s regardless of whether anything changed,
// and workerDiff() always shells out to git (350-415ms/poll in the 2026-07-16 perf profile). This wraps
// workerDiff with a cache keyed on a CHEAP, git-subprocess-free freshness proof, so a repeat poll on an
// unchanged worker skips git entirely.
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

interface DiffCacheEntry {
  key: string;
  result: WorkerDiff | null;
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
 * recomputes) — never wrong, just no speedup for a pathologically large tree.
 */
async function fingerprintWorktree(worktreePath: string): Promise<string | null> {
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

/** Compute the cache freshness key for one workerDiff() call, or null if it can't be cheaply proven. */
async function computeDiffCacheKey(
  repoPath: string, branch: string, worktreePath: string | null,
): Promise<string | null> {
  const headSha = (await readHeadSha(repoPath)) ?? "-";
  if (worktreePath && fs.existsSync(worktreePath)) {
    const contentFp = await fingerprintWorktree(worktreePath);
    if (contentFp === null) return null;
    return `wt:${headSha}:${contentFp}`;
  }
  const branchSha = await readRefSha(path.join(repoPath, ".git"), `refs/heads/${branch}`);
  if (branchSha) return `branch:${branchSha}`;
  // Branch merged+deleted (or unknown): stage 3 searches history from HEAD, so HEAD alone is the key.
  return `merged:${headSha}`;
}

/**
 * Cached wrapper around {@link workerDiff} for the polled orchestration-view diff endpoint. `deps.compute`
 * is an injectable seam (defaults to the real {@link workerDiff}) so a test can count git-subprocess-
 * triggering calls without mocking `simple-git`/`child_process`.
 */
export async function getWorkerDiffCached(
  repoPath: string,
  opts: { branch: string; worktreePath: string | null },
  deps: { compute?: typeof workerDiff } = {},
): Promise<WorkerDiff | null> {
  const compute = deps.compute ?? workerDiff;
  const key = await computeDiffCacheKey(repoPath, opts.branch, opts.worktreePath);
  if (key !== null) {
    const cached = diffCache.get(opts.branch);
    if (cached && cached.key === key) {
      diffCache.delete(opts.branch); // move to the Map's end (most-recently-used)
      diffCache.set(opts.branch, cached);
      return cached.result;
    }
  }
  const result = await compute(repoPath, { branch: opts.branch, worktreePath: opts.worktreePath });
  if (key !== null) {
    diffCache.delete(opts.branch);
    diffCache.set(opts.branch, { key, result });
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

/** A task's landed squash-merge commit on main, as surfaced by {@link getTaskMergedInfo}. */
export interface MergedCommitInfo {
  /** Short (7-char) sha of the squash-merge commit. */
  sha: string;
  /** Strict ISO-8601 author date of that commit (git's `%aI`). */
  date: string;
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
    console.info(`[git] scanMergedCommitMap: ${preFixCount} landed branch(es) in ${repoPath} predate the ` +
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
): Promise<string | null> {
  try {
    // Bounded via the SAME git+timeoutMs as the merge-base call below (mirrors findLandedSquashCommit's
    // OWN `branch --list` check exactly) — NOT the shared branchExists() helper, whose bare `simpleGit()`
    // has no block-timeout and no withTimeout race.
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
    } else if (hit.pathSetDigest) {
      // Branch gone (card f621f185): verify against the persisted path-set trailer.
      if (!(await verifyPersistedPathSet(git, timeoutMs, hit.sha, hit.pathSetDigest))) return null;
    }
    // else: pre-fix history (no path-set trailer) — degrades to the trailer-presence-only answer.
    // Deliberately NOT logged here for either caller: scanMergedCommitMap already logs the pre-fix count
    // once per actual scan (cache-gated, rebuilt only on a HEAD move) — see its own comment.
    return hit.sha;
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
  const sha = await resolveMergedCommitMapHit(repoPath, branch, entry, deps);
  return { hit: true, sha };
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
  // IDENTICAL re-task-guard + content/path-set check) — behaviour-identical to the version this replaces.
  const sha = await resolveMergedCommitMapHit(repoPath, branch, hit, deps);
  if (!sha) return null;
  return { sha: sha.slice(0, 7), date: hit.date };
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

// ── Per-repo merge mutex (board card e076d2a2 — CRITICAL silent data loss) ─────────────────────────
//
// `mergeBranch` stages + commits directly against the CANONICAL repo's shared git index at `repoPath`, a
// process-wide, un-namespaced resource. Two concurrent `mergeBranch` calls for the SAME repo (reachable
// once `orchestration.maxConcurrentGates` >= 2) race on that ONE index: one op's own `git merge --squash`
// can fail (e.g. `.git/index.lock` contention with the OTHER op's concurrent squash) while the other op's
// now-staged-but-uncommitted diff is still sitting in the index; the residue-clear at the top of
// `mergeBranch` never fires for this (it only resets on an AFFIRMATIVE `ls-files --unmerged`/`MERGE_HEAD`
// signal, neither of which a normal concurrent `--squash` sets), so the failing op's own `staged` check
// reads TRUE off the OTHER op's leftover stage and blindly commits it under ITS OWN subject/trailer —
// reproduced against real, unmodified git + this exact code (see test/merge-repo-mutex.mjs): a commit
// bearing branch A's subject+trailer but containing ONLY branch B's diff, on the FIRST concurrent attempt,
// no artificial delays needed. This mutex makes `mergeBranch`'s whole
// residue-clear→squash→conflict-check→commit sequence atomic PER REPO, closing that race at the source.
//
// In-process, keyed by the repo's CANONICALIZED path — mirrors `projects/repos.ts`'s own aliasing guard:
// two spellings of the same physical directory (different casing/separators, or a registry entry vs.
// `repoPath` itself) must serialize together, not slip past each other. Cross-repo calls are NEVER
// blocked — the incident's own scope finding stands: the index is per-repo, so unrelated repos merging
// concurrently is safe and untouched by this lock. No eviction needed: entries are bounded by the number
// of distinct repos a daemon touches (small, unlike the branch-keyed diff cache), never by task/branch
// volume, so leaving settled entries in the map is not a leak.
const repoMergeLocks = new Map<string, Promise<unknown>>();

function canonicalRepoLockKey(repoPath: string): string {
  let real: string;
  try {
    real = fs.realpathSync.native(repoPath);
  } catch {
    real = path.resolve(repoPath); // repo may not exist yet on disk in a test/edge case — best effort
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * Serialize `fn` against every other in-flight caller for the SAME canonical repo path — FIFO via promise
 * chaining. `prior.then(fn, fn)` runs `fn` once `prior` SETTLES regardless of whether it resolved or
 * rejected, so one caller's failure never poisons or skips the next caller's turn; the chained promise
 * (its outcome ignored via `.catch`) is what the NEXT caller awaits, so callers queue strictly in arrival
 * order.
 *
 * **No timeout HERE, deliberately** (board card 44c28799 — this corrects an EARLIER version of this
 * comment that claimed `mergeBranch`'s own git calls "are already bounded elsewhere"; they were not, and
 * that gap is what made this exact function wedge the whole per-repo queue permanently on a hung git
 * child). The real fix is that {@link mergeBranchLocked} now bounds every one of its own `git.raw` calls
 * (`boundedMergeGit` + `withTimeout`, matching `git/reader.ts`/`git/writer.ts`), so the `fn` passed in here
 * is now GUARANTEED to settle within a bounded time on its own — a wedged holder fails its own op instead
 * of the whole queue, which is exactly the property this lock needs.
 *
 * A SEPARATE timeout at THIS level was considered and rejected: racing `fn()`'s completion here would let
 * the NEXT queued caller start (`prior` resolving) while the ABANDONED `fn()` call may still be actually
 * running against the shared canonical index in the background (a `withTimeout` race stops the CALLER
 * from waiting; it does not stop the underlying git child unless its own block-timeout independently
 * kills it) — reintroducing the exact concurrent-index race this mutex exists to close (see the class doc
 * above). Bounding the work itself (what `mergeBranchLocked` now does) closes the hang without that risk;
 * bounding the WAIT for it here would reopen it.
 */
async function withRepoMergeLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = canonicalRepoLockKey(repoPath);
  const prior = repoMergeLocks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  repoMergeLocks.set(key, run.catch(() => { /* only used to sequence the NEXT caller; outcome irrelevant here */ }));
  return run;
}

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
  return { ok: true, merged: true };
}

export async function mergeBranch(
  repoPath: string, branch: string, taskTitle?: string, deps: BoundedGitDeps = {},
): Promise<{ ok: boolean; conflict?: boolean; sha?: string; subject?: string; noop?: boolean; reason?: string; emptyKind?: MergeEmptyKind }> {
  // MUTEX (card e076d2a2): the whole residue-clear→squash→conflict-check→commit sequence below reads and
  // writes the CANONICAL repo's shared git index — serialize it per canonical repo path so a concurrent
  // merge for a DIFFERENT branch of the SAME repo can never interleave with this one. See the lock's own
  // doc above for the exact corruption this closes.
  return withRepoMergeLock(repoPath, () => mergeBranchLocked(repoPath, branch, taskTitle, deps));
}

async function mergeBranchLocked(
  repoPath: string, branch: string, taskTitle?: string, deps: BoundedGitDeps = {},
): Promise<{ ok: boolean; conflict?: boolean; sha?: string; subject?: string; noop?: boolean; reason?: string; emptyKind?: MergeEmptyKind }> {
  // BOUNDED + NON-INTERACTIVE (board card 44c28799): this is the repo's highest-consequence git write
  // (see boundedMergeGit's own doc), so it gets the same block-timeout + withTimeout race as every other
  // bounded op in this file, plus nonInteractiveEnv() to match git/reader.ts + git/writer.ts. Before this
  // fix, `git = simpleGit(repoPath)` here had NEITHER — a hung git child (e.g. a wedged commit hook) never
  // settled, which (post-e076d2a2) wedged the per-repo merge mutex PERMANENTLY, not just this one op.
  const { git, timeoutMs } = boundedMergeGit(repoPath, deps);
  // Re-derive from a CLEAN index: clear any AFFIRMATIVE in-progress-merge residue (a stale MERGE_HEAD or
  // unmerged entries from an aborted op) BEFORE the squash, so a leftover state can't make the first
  // --squash stage nothing (the idempotency bug). Gated on a positive signal so a clean canonical repo is
  // never touched. The two probes are INDEPENDENT: `ls-files --unmerged` exits 0 on a clean repo (never
  // throws), so it runs FIRST and unconditionally; the `rev-parse --verify MERGE_HEAD` check (which exits
  // non-zero → throws when there is no in-progress merge) is isolated in its OWN try/catch so its throw
  // can't skip the unmerged probe — unmerged residue WITHOUT a MERGE_HEAD is now auto-recovered up front too.
  try {
    const unmerged = (await withTimeout(git.raw(["ls-files", "--unmerged"]), timeoutMs, "git ls-files --unmerged (canonical, pre-check)")).trim() !== "";
    let inProgressMerge = false;
    try {
      inProgressMerge = (await withTimeout(git.raw(["rev-parse", "-q", "--verify", "MERGE_HEAD"]), timeoutMs, "git rev-parse MERGE_HEAD (canonical)")).trim() !== "";
    } catch { /* no MERGE_HEAD ⇒ that signal is simply false */ }
    if (inProgressMerge || unmerged) await withTimeout(git.raw(["reset", "--hard", "HEAD"]), timeoutMs, "git reset --hard (canonical, residue clear)");
  } catch { /* ls-files failed (e.g. not a repo / no HEAD) ⇒ no residue to clear */ }

  // ── Staged-but-not-unmerged residue (card 9e77050f — a SECOND, non-concurrent trigger for the same
  // corruption `withRepoMergeLock` closes for concurrency: the mutex is in-process, this residue outlives
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
    // The text below is the ONLY part of this refusal a caller (a manager, mid-fleet, who has never read
    // card 9e77050f/06b5c47f) actually sees — so it has to make the required action unmistakable on its
    // own, not rely on this comment. It must say, explicitly: this is not the branch's fault (retrying
    // does nothing); a HUMAN has to act on the canonical checkout, their call how; and the refusal itself
    // is deliberate, not a bug — auto-clearing was rejected precisely because it could destroy real work.
    return {
      ok: false,
      reason: `MERGE REFUSED — the canonical repo has STAGED, uncommitted changes that predate this merge and are unrelated to branch '${branch}'. This is NOT a problem with '${branch}' or its code: retrying this merge (or any other) against this repo will refuse again identically until a HUMAN resolves the canonical checkout by hand — inspect \`git status\`/\`git diff --cached\` there, then commit, unstage, or discard whatever is staged (your call which). This refusal is DELIBERATE, not a bug: the staged state may be a daemon-restart-interrupted squash (a \`--squash\` commits the INDEX, which is exactly what can corrupt a merge), or it may be someone's real staged work, and Loom cannot tell the two apart from git state alone — auto-clearing it (e.g. \`git reset --hard\`) risks silently destroying that work, so it refuses instead. (Unstaged tracked changes elsewhere in the checkout — ordinary WIP, or a submodule whose checked-out commit differs from its recorded pointer — do NOT block a merge; only staged content does.) Once the canonical repo's index is clean, merges resume normally with no further action needed. Staged state:\n${stagedAtEntry}`,
    };
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

  let rawError = false;
  try {
    await withTimeout(git.raw(["merge", "--squash", branch]), timeoutMs, "git merge --squash (canonical)");
  } catch {
    rawError = true; // a conflict OR a real failure — the explicit checks below decide
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
    return { ok: true, noop: true, emptyKind: landed ? "ALREADY_MERGED" : "STAGE_EMPTY_RETRY" };
  }
  // Land the staged diff as ONE plain commit (repo-config identity; clean subject + deterministic trailer).
  const rawSubject = (taskTitle && taskTitle.trim().split(/\r?\n/)[0]!.trim()) || branch;
  const subject = toConventionalSubject(rawSubject);
  // Stamp a second trailer (card f621f185): the branch's own touched-path-set digest, computed HERE from
  // the branch ref directly (HEAD hasn't moved yet — `--squash` never advances it) so it reflects what the
  // branch itself actually changed, independent of whatever ended up staged. This is what lets a LATER
  // determination verify a landed commit purely from its own ancestry (sha^..sha) once the branch ref is
  // gone — see changedPathSetDigest's doc for why a full content hash doesn't work here and a path-set does.
  // Best-effort: a capture failure just omits the trailer (falls back to the pre-fix degraded behavior for
  // THIS commit) rather than blocking a real, already-successful merge.
  let pathSetTrailer = "";
  try {
    const mergeBaseForPathSet = (await withTimeout(git.raw(["merge-base", "HEAD", branch]), timeoutMs, "git merge-base (canonical, path-set fingerprint)")).trim();
    const digest = await changedPathSetDigest(git, mergeBaseForPathSet, branch, timeoutMs);
    pathSetTrailer = `\nLoom-Worker-PathSet: ${digest}`;
  } catch { /* best-effort; the commit still lands, just without this trailer */ }
  const message = `${subject}\n\nLoom-Worker-Branch: ${branch}${pathSetTrailer}\n`;
  try {
    await withTimeout(git.raw(["commit", "-m", message]), timeoutMs, "git commit (canonical, squash-merge)");
  } catch (e) {
    const cleanupIssue = await resetOrSkip("commit-failure cleanup");
    return { ok: false, reason: cleanupIssue ? `squash commit failed: ${(e as Error).message} (${cleanupIssue})` : `squash commit failed: ${(e as Error).message}` };
  }
  const sha = (await withTimeout(git.raw(["rev-parse", "HEAD"]), timeoutMs, "git rev-parse HEAD (canonical, post-commit)")).trim();
  return { ok: true, sha, subject };
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
