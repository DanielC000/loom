import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { RUNS_DIR } from "../paths.js";

/**
 * Agent Runs R2 — the disposable, read-only cwd for an ephemeral `run` session.
 *
 * ╔═ WHY A SNAPSHOT (the run-cwd isolation decision, owner-approved 2026-06-05) ════════════════════════╗
 * ║ A run must read the project's code but produce NO commit and NEVER dirty the LIVE checkout — yet it ║
 * ║ boots with the SAME gate-free `acceptEdits` recipe as every other session (CLAUDE.md spawn law), so ║
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
export async function createRunSnapshot(repoPath: string, sessionId: string): Promise<string> {
  const dir = runSnapshotDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = runIndexFile(sessionId);
  // A complete env (simple-git's .env REPLACES the child env, so we must carry PATH/SystemRoot/etc.) with
  // GIT_INDEX_FILE pointed at the throwaway index, so read-tree/checkout-index never touch the live repo's
  // real index or working tree. Drop GIT_EDITOR/GIT_SEQUENCE_EDITOR — simple-git refuses a custom env that
  // carries them (its allowUnsafeEditor guard), and these plumbing commands never open an editor anyway.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "GIT_EDITOR" || k === "GIT_SEQUENCE_EDITOR") continue;
    env[k] = v;
  }
  env.GIT_INDEX_FILE = indexFile;
  const git = simpleGit(repoPath).env(env);
  try {
    await git.raw(["read-tree", "HEAD"]); // load HEAD's tree into the throwaway index
    // checkout-index needs an absolute prefix ending in a separator; forward slashes are accepted by
    // git on every platform, so normalize Windows backslashes to avoid a malformed prefix.
    const prefix = `${dir.replace(/\\/g, "/")}/`;
    await git.raw(["checkout-index", "-a", "-f", `--prefix=${prefix}`]);
  } finally {
    try { fs.rmSync(indexFile, { force: true }); } catch { /* best-effort — throwaway index */ }
  }
  return dir;
}

/**
 * Best-effort, Windows-safe teardown of a run's snapshot dir. Called AFTER the pty is fully gone (so no
 * file handle in the snapshot is still held), and tolerant of the OS releasing a directory handle a beat
 * late (`fs.rm` maxRetries — the same EBUSY/EPERM lag removeWorktree handles). NEVER throws: a failed
 * cleanup must not wedge teardown or leave the run non-terminal — the run row is already marked terminal
 * before this runs; a lingering dir is swept on the next boot. Logs if it ultimately lingers.
 */
export async function removeRunSnapshot(sessionId: string): Promise<void> {
  const dir = runSnapshotDir(sessionId);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 200 });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[run] could not remove snapshot dir ${dir} (left on disk for the next boot sweep): ${(e as Error).message}`);
  }
  try { fs.rmSync(runIndexFile(sessionId), { force: true }); } catch { /* best-effort */ }
}

/**
 * Boot sweep: remove EVERY run-snapshot dir (and stray throwaway index). Runs never resume, so any dir
 * under RUNS_DIR at boot is orphaned by a crash/restart that interrupted a run (those runs are marked
 * failed alongside this). Best-effort + never throws — a stuck handle leaves a dir for the next sweep.
 */
export function sweepAllRunSnapshots(): void {
  let entries: string[];
  try { entries = fs.readdirSync(RUNS_DIR); } catch { return; } // RUNS_DIR absent → nothing to sweep
  for (const name of entries) {
    try { fs.rmSync(path.join(RUNS_DIR, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best-effort; next boot retries */ }
  }
}
