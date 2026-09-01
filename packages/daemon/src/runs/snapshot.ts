import fs from "node:fs";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import { RUNS_DIR } from "../paths.js";
import { withTimeout, boundedSimpleGit, scrubGitEnv } from "../git/bounded.js";
import { killableRemoveDir, type RemoveDirResult } from "../git/worktrees.js";

/**
 * Per-git-op ceiling for this file's read-tree/checkout-index plumbing (card 091de765) — a SEPARATE
 * constant from GIT_OP_TIMEOUT_MS/GIT_LOCAL_TIMEOUT_MS/VAULT_GIT_OP_TIMEOUT_MS/git/reader.ts's
 * GIT_READER_TIMEOUT_MS, even though all resolve to the same 15s today (see git/bounded.ts's own doc for
 * why the call classes deliberately don't share one constant). Local plumbing, no network — same 15s
 * local-read budget as the rest.
 */
const RUN_SNAPSHOT_TIMEOUT_MS = 15_000;

/**
 * Injectable seam mirroring git/worktrees.ts's `BoundedGitDeps` / git/reader.ts's `ReaderGitDeps` — lets
 * a test simulate a hanging git child with a tiny budget and assert createRunSnapshot still returns
 * within the window instead of hanging forever. Real callers never pass this.
 */
export interface RunSnapshotGitDeps {
  gitFactory?: (repoPath: string, blockTimeoutMs: number, env: Record<string, string>) => Pick<SimpleGit, "raw">;
  timeoutMs?: number;
}

/**
 * Agent Runs R2 — the disposable, read-only cwd for an ephemeral `run` session.
 *
 * ╔═ WHY A SNAPSHOT (the run-cwd isolation decision, owner-approved 2026-06-05) ════════════════════════╗
 * ║ A run must read the project's code but produce NO commit and NEVER dirty the LIVE checkout — yet it ║
 * ║ boots with the SAME gate-free posture as every other session (CLAUDE.md's spawn-mode table), so     ║
 * ║ Write/Edit are auto-approved. cwd=the real repoPath would let a run silently write into the live    ║
 * ║ working tree. So each run gets its OWN throwaway copy of the project's COMMITTED HEAD, extracted     ║
 * ║ with no `.git` — hence NO branch and NO git-worktree admin record (sidesteps the worktree-GC bug    ║
 * ║ class entirely; there is nothing for `git worktree prune` to chase). Any writes the run makes land   ║
 * ║ in this disposable copy and are discarded on teardown. Committed-HEAD (not the working tree) is the ║
 * ║ deliberate, deterministic input semantics: an endpoint agent's answer must be reproducible, not     ║
 * ║ dependent on whatever happens to be dirty in the live tree at call time.                            ║
 * ╚═════════════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Extraction is pure git plumbing (no `tar` dependency, cross-platform): populate a THROWAWAY index from
 * HEAD (`read-tree`, via a per-run GIT_INDEX_FILE so the live repo's index/working tree are untouched),
 * then `checkout-index -a` with an absolute `--prefix` into the snapshot dir. Tracked files only ⇒ no
 * `.git`. future: a run that needs untracked/gitignored DATA files would be a separate "run data mount"
 * extension — out of scope for R2.
 */

/** Absolute path to a run session's disposable snapshot cwd (`runs/<sessionId>/`). */
export function runSnapshotDir(sessionId: string): string {
  return path.join(RUNS_DIR, sessionId);
}

/** The throwaway index file used to extract HEAD without touching the live repo's index. */
function runIndexFile(sessionId: string): string {
  return path.join(RUNS_DIR, `.index-${sessionId}`);
}

/**
 * Extract the project repo's COMMITTED HEAD into a fresh `runs/<sessionId>/` dir and return that path,
 * to be used as the run session's cwd. No `.git`, no branch, no worktree registration. Throws if HEAD
 * can't be read (e.g. an empty repo) — the caller fails the run rather than spawning into a bad cwd.
 */
export async function createRunSnapshot(repoPath: string, sessionId: string, deps: RunSnapshotGitDeps = {}): Promise<string> {
  const dir = runSnapshotDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = runIndexFile(sessionId);
  // A complete env (simple-git's .env REPLACES the child env, so we must carry PATH/SystemRoot/etc.) with
  // GIT_INDEX_FILE pointed at the throwaway index, so read-tree/checkout-index never touch the live repo's
  // real index or working tree. scrubGitEnv (card f7a80d76) drops the full editor/pager/diff strip set —
  // simple-git refuses a custom env carrying any of them (its allowUnsafe* guards), and these plumbing
  // commands never open an editor/pager/diff tool anyway; boundedSimpleGit separately allows the
  // GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM family through rather than stripping it (see its own doc) — this
  // used to strip only GIT_EDITOR/GIT_SEQUENCE_EDITOR, 2 of the real 18-key refusal list, so any other
  // ambiently-set key (PAGER chief among them — this repo's own session spawn recipe sets it) made every
  // `run` session fail to spawn.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(scrubGitEnv(process.env))) {
    if (v === undefined) continue;
    env[k] = v;
  }
  env.GIT_INDEX_FILE = indexFile;
  const timeoutMs = deps.timeoutMs ?? RUN_SNAPSHOT_TIMEOUT_MS;
  const makeGit = deps.gitFactory ?? ((p, ms, e) => boundedSimpleGit(p, ms, e));
  const git = makeGit(repoPath, timeoutMs, env);
  try {
    await withTimeout(git.raw(["read-tree", "HEAD"]), timeoutMs, "git read-tree HEAD"); // load HEAD's tree into the throwaway index
    // checkout-index needs an absolute prefix ending in a separator; forward slashes are accepted by
    // git on every platform, so normalize Windows backslashes to avoid a malformed prefix.
    const prefix = `${dir.replace(/\\/g, "/")}/`;
    await withTimeout(git.raw(["checkout-index", "-a", "-f", `--prefix=${prefix}`]), timeoutMs, "git checkout-index");
  } finally {
    try { fs.rmSync(indexFile, { force: true }); } catch { /* best-effort — throwaway index */ }
  }
  return dir;
}

/**
 * Injectable seam for {@link removeRunSnapshot}/{@link sweepAllRunSnapshots}, mirroring `BoundedGitDeps`'s
 * `removeDir` in git/worktrees.ts — lets a test simulate a wedged (never-settling) removal and assert the
 * outer {@link withTimeout} bound still resolves instead of hanging forever. Real callers never pass this.
 */
export interface RunSnapshotRemoveDeps {
  removeDir?: (target: string, timeoutMs: number) => Promise<RemoveDirResult>;
  timeoutMs?: number;
}

/**
 * Best-effort, Windows-safe teardown of a run's snapshot dir. Called AFTER the pty is fully gone (so no
 * file handle in the snapshot is still held). NEVER throws: a failed cleanup must not wedge teardown or
 * leave the run non-terminal — the run row is already marked terminal before this runs; a lingering dir
 * is swept on the next boot.
 *
 * card 26c661cd (bd9fc808-shaped fix): the prior implementation retried a hung `fs.promises.rm` up to 40×
 * — a genuinely WEDGED directory handle never lets that promise settle at all, so the retries never even
 * start; the call just occupies a libuv threadpool slot (default pool size 4) FOREVER, invisibly, since
 * this is fire-and-forget (`void removeRunSnapshot(...)` at sessions/service.ts) and the `catch` below was
 * therefore unreachable in exactly the case that mattered. This now adopts `removeWorktree`'s proven,
 * already-tested shape (git/worktrees.ts:1281): {@link killableRemoveDir} runs the removal in a SEPARATE OS
 * process (a wedged handle blocks only that child, never a daemon thread) and force-kills it on timeout;
 * the outer {@link withTimeout} additionally fails SAFE to `killed:true` if the (real or injected) `removeDir`
 * seam itself never settles, so a hang is NEVER retried in a loop here — a genuinely wedged dir is simply
 * left on disk for the next boot sweep, and (since killableRemoveDir always resolves) the warning below is
 * now reachable even in the wedged case, closing the "unreportable by construction" gap.
 */
export async function removeRunSnapshot(sessionId: string, deps: RunSnapshotRemoveDeps = {}): Promise<void> {
  const dir = runSnapshotDir(sessionId);
  const timeoutMs = deps.timeoutMs ?? RUN_SNAPSHOT_TIMEOUT_MS;
  const removeDir = deps.removeDir ?? ((p, ms) => killableRemoveDir(p, ms));
  const result = await withTimeout(removeDir(dir, timeoutMs), timeoutMs, "removeDir run snapshot")
    .catch((): RemoveDirResult => ({ removed: false, killed: true })); // an injected/broken seam that itself never settles ⇒ fail SAFE as WEDGED (never loop a hang)
  if (!result.removed) {
    // eslint-disable-next-line no-console
    console.warn(`[run] could not remove snapshot dir ${dir} (${result.killed ? "genuinely wedged — killed the removal child" : "clean failure"}; left on disk for the next boot sweep)`);
  }
  try { fs.rmSync(runIndexFile(sessionId), { force: true }); } catch { /* best-effort */ }
}

/**
 * Boot sweep: remove EVERY run-snapshot dir (and stray throwaway index). Runs never resume, so any dir
 * under RUNS_DIR at boot is orphaned by a crash/restart that interrupted a run (those runs are marked
 * failed alongside this). Best-effort + never throws — a stuck handle leaves a dir for the next sweep.
 *
 * card 26c661cd: the prior implementation was `fs.rmSync(..., { maxRetries: 10, retryDelay: 100 })` —
 * SYNCHRONOUS on the main thread, so a single wedged dir at boot blocked the ENTIRE daemon (every request,
 * every session) for up to its full retry budget before anything could be served. This is now async and
 * uses the same {@link killableRemoveDir}-backed bound as {@link removeRunSnapshot} (a separate OS process
 * per removal, force-killed on timeout), and — deliberately — the caller (`reconcileRunsOnBoot`) fires this
 * WITHOUT awaiting it: boot must never block on a stubborn dir, so a wedge here is simply skipped-and-
 * deferred to the next boot sweep rather than serialized in front of `app.listen()`. The failure this buys:
 * a run snapshot dir can still be mid-removal in the background for up to `timeoutMs` after boot reports
 * ready; this is safe because `runSnapshotDir` is keyed by session id, which is never reused, so a fresh
 * run can never collide with an orphaned dir still being cleaned up.
 */
export async function sweepAllRunSnapshots(deps: RunSnapshotRemoveDeps = {}): Promise<void> {
  let entries: string[];
  try { entries = fs.readdirSync(RUNS_DIR); } catch { return; } // RUNS_DIR absent → nothing to sweep
  const timeoutMs = deps.timeoutMs ?? RUN_SNAPSHOT_TIMEOUT_MS;
  const removeDir = deps.removeDir ?? ((p, ms) => killableRemoveDir(p, ms));
  await Promise.all(entries.map(async (name) => {
    const target = path.join(RUNS_DIR, name);
    const result = await withTimeout(removeDir(target, timeoutMs), timeoutMs, "removeDir run snapshot sweep")
      .catch((): RemoveDirResult => ({ removed: false, killed: true })); // fail SAFE as WEDGED, never loop a hang
    if (!result.removed) {
      // eslint-disable-next-line no-console
      console.warn(`[run] boot sweep could not remove ${target} (${result.killed ? "genuinely wedged" : "clean failure"}; left for the next boot sweep)`);
    }
  }));
}
