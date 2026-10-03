import fs from "node:fs";
import path from "node:path";
import { assertRepoNotQuarantined } from "./merge-quarantine.js";

// @decision e076d2a2 — every writer touching a canonical repo's index (a merge, or GitWriter's
// commit/checkout/createBranch, widened by e41dbb58) must hold this per-repo lock, or the
// squash+commit race it closes can land one op's staged content under another op's message.
const canonicalIndexLocks = new Map<string, Promise<unknown>>();

/**
 * Thrown by {@link withCanonicalIndexLock} when the canonical repo is found QUARANTINED at the moment the
 * lock is acquired. This is now the ONE place every canonical-index writer is refused —
 * `GitWriter.checkout`/`createBranch`/`commit`, `mergeBranch`, `createWorktree`'s fresh-cut path, and
 * `fastForwardCanonicalMain`'s ff-only — rather than each re-deriving its own copy of
 * {@link assertRepoNotQuarantined}. A caller that needs its own structured refusal shape (`GitWriteResult`,
 * a `{ok:false,...}` merge result, `FastForwardResult`) must catch this AROUND THE WHOLE
 * `withCanonicalIndexLock(...)` call, never nested inside the `fn` it passes in — this check runs BEFORE
 * `fn` is ever invoked, so a try/catch inside `fn` never sees it.
 *
 * @decision 24c0bdba (round 6, Code Review BLOCKER 1)
 */
export class RepoQuarantinedError extends Error {}

/**
 * Realpath the NEAREST EXISTING ancestor (inclusive) of `bp`, then reattach whatever trailing segments
 * don't exist yet — so the result is the SAME value `bp` would realpath to once it exists, independent of
 * whether `bp` ITSELF happens to exist at the moment this is called (an unmounted drive, a cloud-synced
 * folder not yet materialized: the ENCLOSING directory structure is typically still there even when the
 * leaf isn't). Falls back to `bp`'s own `path.resolve` only when NOTHING along the chain up to the
 * filesystem root resolves at all (a wholly disconnected drive/share) — a last-resort literal, not a
 * verified anchor.
 */
function findExistingAncestorRealpath(bp: string): string {
  const resolvedInput = path.resolve(bp);
  const tail: string[] = [];
  let probe = resolvedInput;
  for (;;) {
    try {
      const realAncestor = fs.realpathSync.native(probe);
      return tail.length > 0 ? path.join(realAncestor, ...tail) : realAncestor;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return resolvedInput; // walked to the fs root; nothing resolves at all
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Resolve the git TOPLEVEL for `bp` — walk UP from the nearest existing ancestor's realpath (see
 * {@link findExistingAncestorRealpath}) looking for the nearest ancestor (inclusive) that contains a
 * `.git` entry, a directory for an ordinary repo or a FILE for a linked worktree/submodule (its mere
 * presence marks the enclosing directory as a git root; what the pointer inside it says doesn't matter
 * here — see {@link canonicalRepoLockKey}'s own doc for why).
 *
 * Returns the existence-independent realpath, UNCHANGED, when no `.git` is found anywhere up to the
 * filesystem root — `bp` isn't inside a git repo at all (a vault-only project's bound path, a not-yet-
 * `git init`'d directory, a test fixture) — the same case {@link canonicalRepoLockKey} already fell back
 * to before this existed.
 *
 * @decision 7673d096 — SYNCHRONOUS, no subprocess: never thread GIT_DIR/GIT_CEILING_DIRECTORIES/
 * safe.directory through here, and never add a cache without re-reading the record first.
 *
 * Full record: docs/decisions/7673d096-sync-toplevel-walk-for-the-canonical-lock-key.md
 */
export function resolveGitToplevelSync(bp: string): string {
  const real = findExistingAncestorRealpath(bp);
  let dir = real;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir; // a directory (ordinary repo) or a FILE (worktree/submodule pointer)
    const parent = path.dirname(dir);
    if (parent === dir) return real; // reached the filesystem root — not inside any repo; fall back to the input
    dir = parent;
  }
}

/**
 * True iff `bp` ITSELF currently resolves via realpath — used ONLY to gate a boot-time quarantine-latch
 * MIGRATION decision (merge-quarantine.ts): never trust a freshly-computed key enough to migrate/destroy a
 * durable latch when the registered path itself can't currently be verified (an unmounted drive, a
 * not-yet-synced cloud folder) — even though {@link resolveGitToplevelSync} may still compute a STABLE key
 * for it via the nearest-existing-ancestor walk above.
 *
 * @decision 7673d096 — never swap this for an ancestor-existence check — the reviewed bug is specifically
 * about `bp` itself being momentarily absent while an ancestor (and `C:\`/`/` itself) still resolves, which
 * would make an ancestor-existence check pass in virtually every real case and protect nothing.
 */
export function isRepoPathCurrentlyResolvable(bp: string): boolean {
  try { fs.realpathSync.native(bp); return true; } catch { return false; }
}

/** Canonicalize a repo path for lock-keying — two spellings of the same physical directory, OR two
 *  different paths inside the SAME physical repo (e.g. a project bound to a subdirectory with no `.git`
 *  of its own), must map to the SAME key. See {@link resolveGitToplevelSync} for the toplevel walk this
 *  delegates to and the full rationale. */
export function canonicalRepoLockKey(repoPath: string): string {
  const toplevel = resolveGitToplevelSync(repoPath);
  return process.platform === "win32" ? toplevel.toLowerCase() : toplevel;
}

/**
 * Resolve the two git-dir roles `repoPath`'s `.git` entry actually implies, fs-only sync, no `git` spawn —
 * the SYNC TWIN of `git/worktrees.ts`'s `resolveGitDirs` (that one stays async: it sits on the merged-map/
 * worker-diff cache hot path, where this repo's event-loop discipline bans blocking I/O — see
 * `CLAUDE.md`'s python-venv section). `privateDir` is where THIS checkout's own per-checkout files live
 * (`HEAD`, `index`, `logs/HEAD`); `commonDir` is where SHARED refs live (`refs/**`, `packed-refs`).
 *
 * `.git` a DIRECTORY: both roles are that same directory. `.git` a FILE (`gitdir: <path>`): that target is
 * `privateDir`; if it has its own `commondir` file (a linked worktree), `commonDir` resolves from it;
 * otherwise (a submodule or `--separate-git-dir` repo) `commonDir` is `privateDir` itself.
 *
 * Both functions must stay byte-identical in behavior — `test/gitdirs-sync-async-parity.mjs` runs the same
 * fixture matrix through both and asserts identical results; a future edit to either must update the
 * other, or that test goes red.
 *
 * @decision 472f14d1 — do not change the missing-`commondir` fallback to `null`: a submodule/
 * `--separate-git-dir` repo has no `commondir` file by design, and `null` would make resolution
 * permanently fail instead of correctly resolving in `privateDir`.
 */
export function resolveGitDirsSync(repoPath: string): { privateDir: string; commonDir: string } | null {
  const gitPath = path.join(repoPath, ".git");
  let stat: fs.Stats;
  try { stat = fs.statSync(gitPath); } catch { return null; }
  if (stat.isDirectory()) return { privateDir: gitPath, commonDir: gitPath };
  let pointer: string;
  try { pointer = fs.readFileSync(gitPath, "utf8"); } catch { return null; }
  const m = pointer.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m || !m[1]) return null; // not the `gitdir: <path>` shape every real .git FILE has
  const privateDir = path.resolve(repoPath, m[1]);
  try { fs.statSync(path.join(privateDir, "HEAD")); } catch { return null; } // bad pointer target
  try {
    const commondirRaw = fs.readFileSync(path.join(privateDir, "commondir"), "utf8").trim();
    return { privateDir, commonDir: path.resolve(privateDir, commondirRaw) };
  } catch {
    return { privateDir, commonDir: privateDir }; // submodule / --separate-git-dir: no indirection
  }
}

/**
 * Resolve the git MAIN WORKING TREE root for `bp` — the directory holding a real `.git` DIRECTORY, never
 * a linked worktree's own root. This is DELIBERATELY DIFFERENT from {@link resolveGitToplevelSync}'s
 * TOPLEVEL: for an ordinary repo the two agree, but for a LINKED WORKTREE the toplevel is the worktree's
 * own root (its `.git` is a FILE), while this returns the MAIN checkout the worktree's `.git` file points
 * back at — the same canonical root the installed `claude` CLI itself keys its per-project `.claude.json`
 * entry on (`canonicalRootByRoot`/`yIe()` in its own bundle — see
 * docs/decisions/37310431-loom-home-write-deny.md § "FIXED (card e789ef3b)"). Returns `null` when `bp` is
 * not inside a git repo at all (a vault-only project, a not-yet-`git init`'d directory, a test fixture) —
 * the caller decides that non-git fallback (the CLI's own `ci()` does `?? cwd`), rather than this function
 * silently returning a realpath-normalized stand-in for it.
 *
 * Walk: start at `resolveGitToplevelSync(bp)` (same existence-tolerant ancestor walk, inclusive, up to the
 * nearest `.git` entry). If that `.git` is a real DIRECTORY, the toplevel itself IS the main checkout. If
 * it is a FILE (a linked worktree or submodule pointer, `gitdir: <path>`), follow it to its own private
 * dir and that dir's `commondir` file (mirrors `git rev-parse --git-common-dir`, the same resolution
 * {@link resolveGitDirsSync} performs for a different purpose — NOT reused here: this function's return
 * value is a CHECKOUT ROOT directory with its own basename-is-`.git`/nested-`.git` disambiguation below,
 * not a readable-files dir, and it falls back to the toplevel rather than the private dir on a missing
 * `commondir` — see card 25389c3c, which audited this against resolveGitDirsSync and declined to merge it)
 * to the shared common `.git` path. If that common path's basename IS `.git`, return ITS PARENT (the
 * ordinary `<repo>/.git/worktrees/<name>` layout). Otherwise — a bare repo or a `--separate-git-dir` repo,
 * whose git directory can be named anything — return the common path ITSELF, UNLESS `<commonDir>/.git`
 * itself exists, in which case return the WORKTREE's own toplevel instead (the common-dir indirection
 * landed on an ordinary working-tree root, not a true independent git dir). This mirrors the installed
 * `claude` CLI's own equivalent branch (`he(c)!==".git" ? (Ne(_(c,".git"),c) ? e : Nn(c)) : dirname(c)` in
 * its decompiled bundle — card `17237fba` fixed the basename branch after finding it unconditionally
 * returned the parent instead; card `6f52c3f5` (Code Review `24e5a263`) added the `<commonDir>/.git`
 * guard, whose triggering layout could not be reproduced via plain `git` commands — see
 * `test/repo-lock-subdir-toplevel.mjs`'s own fixture comment for the manually-crafted `commondir` pointer
 * used to exercise it); see docs/decisions/37310431-loom-home-write-deny.md § "ROUND 2 FIX" for the
 * citation. The CLI's own walk additionally verifies the private worktree dir sits directly under
 * `<commondir>/worktrees` and that its own `gitdir` file points back to this exact `.git` file before
 * trusting the indirection at all — this function does not replicate that structural cross-check; a
 * layout that fails it is not specially detected here, unlike in the CLI. Any failure following the
 * indirection (malformed pointer, missing/unreadable `commondir` — e.g. a submodule, which has no
 * `commondir` file at all) falls back to the toplevel itself rather than throwing; a caller on the spawn
 * hot path (`claudeCliProjectKey` in `pty/claude-config.ts`) must still fall back further, to its own
 * plain non-git key, on any error escaping this function entirely.
 *
 * SYNCHRONOUS, no subprocess — same posture as {@link resolveGitToplevelSync}: never thread
 * GIT_DIR/GIT_CEILING_DIRECTORIES/safe.directory through here, and never add a cache without re-reading
 * that record first.
 *
 * @decision 7673d096 — the same constraints above apply to this function too, not just
 * resolveGitToplevelSync.
 */
export function resolveGitMainCheckoutRootSync(bp: string): string | null {
  const toplevel = resolveGitToplevelSync(bp);
  const gitPath = path.join(toplevel, ".git");
  let stat: fs.Stats;
  try { stat = fs.statSync(gitPath); } catch { return null; } // no `.git` anywhere up to the fs root
  if (stat.isDirectory()) return toplevel; // ordinary repo (or bare .git dir) — toplevel IS the main checkout
  let pointer: string;
  try { pointer = fs.readFileSync(gitPath, "utf8"); } catch { return toplevel; }
  const m = pointer.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m || !m[1]) return toplevel; // not the worktree `.git` file shape we expect
  const privateDir = path.resolve(toplevel, m[1]);
  let commondirRaw: string;
  try { commondirRaw = fs.readFileSync(path.join(privateDir, "commondir"), "utf8").trim(); }
  catch { return toplevel; } // e.g. a submodule pointer — no commondir file; fall back to its own toplevel
  const commonDir = path.resolve(privateDir, commondirRaw);
  if (path.basename(commonDir) === ".git") return path.dirname(commonDir);
  // Not a `.git`-named common dir (bare repo / `--separate-git-dir`, normally returned as-is below) —
  // UNLESS `commonDir` itself turns out to contain its OWN nested `.git` entry, meaning the indirection
  // actually landed on an ordinary working-tree root rather than a true independent git dir. Mirrors the
  // CLI's own extra guard on this branch (`he(c)!==".git" ? (Ne(_(c,".git"),c) ? e : Nn(c)) : ...` in its
  // decompiled bundle — card `6f52c3f5`, Code Review `24e5a263` of `17237fba`): in that layout it returns
  // the WORKTREE's own toplevel, not the (mis-resolved) common dir.
  if (fs.existsSync(path.join(commonDir, ".git"))) return toplevel;
  return commonDir;
}

/**
 * Serialize `fn` against every other in-flight caller for the SAME canonical repo path — FIFO via promise
 * chaining. `prior.then(fn, fn)` runs `fn` once `prior` SETTLES regardless of whether it resolved or
 * rejected, so one caller's failure never poisons or skips the next caller's turn; the chained promise
 * (its outcome ignored via `.catch`) is what the NEXT caller awaits, so callers queue strictly in arrival
 * order.
 *
 * @decision 44c28799 — no timeout HERE, deliberately: every wrapped caller bounds its OWN git calls, so
 * a wedged holder fails only its own op, never the whole queue.
 *
 * **⚠️ NOT RE-ENTRANT.** A holder that itself (directly or transitively) calls back into
 * `withCanonicalIndexLock` for the SAME canonical repo path deadlocks permanently — and because callers
 * queue via promise chaining, that hang wedges every LATER caller for that repo too, not just the
 * re-entrant one.
 *
 * @decision e41dbb58 — verified nothing reachable from inside a held lock imports or constructs a
 * `GitWriter` (the one change that would reintroduce the deadlock above); `test/merge-writer-index-lock.mjs`
 * guards it statically.
 *
 * QUARANTINE CHECK, run once `prior` SETTLES (i.e. AFTER this caller has actually acquired the lock), never
 * before enqueueing: a repo can be quarantined by an unrelated op while this caller sat queued behind
 * `prior`, and checking only at enqueue time would miss that. Throws {@link RepoQuarantinedError} rather
 * than returning a sentinel — `T` is caller-defined, so there is no one refusal shape this generic helper
 * could return on every caller's behalf.
 */
export async function withCanonicalIndexLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = canonicalRepoLockKey(repoPath);
  const prior = canonicalIndexLocks.get(key) ?? Promise.resolve();
  const guarded = (): Promise<T> => {
    const q = assertRepoNotQuarantined(repoPath);
    if (!q.ok) return Promise.reject(new RepoQuarantinedError(q.reason));
    return fn();
  };
  const run = prior.then(guarded, guarded);
  canonicalIndexLocks.set(key, run.catch(() => { /* only used to sequence the NEXT caller; outcome irrelevant here */ }));
  return run;
}
