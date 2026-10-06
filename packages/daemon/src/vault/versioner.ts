import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import type { SimpleGit, SimpleGitOptions } from "simple-git";
import type { Db } from "../db.js";
import { LOOM_HOME, WORKTREES_DIR } from "../paths.js";
import { validateVaultPath } from "../projects/vault-path.js";
import { withTimeout, boundedSimpleGit, localReadGitEnv, isNotAGitRepositoryError, stripRepoLocationEnv } from "../git/bounded.js";
import { assertRepoNotQuarantined } from "../git/merge-quarantine.js";
import { canonicalRepoLockKey, withCanonicalIndexLock, RepoQuarantinedError, resolveGitToplevelSync } from "../git/repo-lock.js";

/** Generic, non-personal identity used ONLY when the host has no git identity configured at all. */
const FALLBACK_GIT_IDENTITY = { name: "Loom", email: "loom@localhost" } as const;

/**
 * Default oversized-file threshold for auto-commit (card 614dfbef, origin finding 4ae8a3c9): a vault was
 * observed committing >100MB blobs (two ~2.7GB) via `loom: auto-commit`, permanently wedging the vault's
 * GitHub backup (GitHub hard-rejects any push containing a >100MB object). 95MB leaves headroom below
 * that hard limit for git's own object-format overhead. Overridable via `commitVault`'s `opts.maxFileBytes`
 * (tests use a tiny value — writing a real 95MB fixture file per test run would be slow and wasteful).
 *
 * Exported so `git/writer.ts` can size its OWN staged-file warning (finding 2 of card 237d1899) off the
 * SAME number rather than a second hardcoded copy — see that file's `commit()` for why the two paths
 * react differently (unstage-silently here vs. warn-not-refuse there) despite sharing this threshold.
 */
export const DEFAULT_MAX_VAULT_FILE_BYTES = 95 * 1024 * 1024;

export function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @decision 509716cc — never leave a new plumbing-tier git call in this module unbounded; route it
 *  through boundedVaultGit with this ceiling. An unbounded hang here previously blocked the whole
 *  daemon's post-restart fleet resume, invisibly (HTTP stays up).
 *
 *  Exported (card 347b3584 round 2) so graceful-teardown.ts can DERIVE its own shutdown-cleanup step
 *  budget from this real bound rather than copying the number. */
export const VAULT_GIT_OP_TIMEOUT_MS = 15_000;

/** @decision 816f0056 — never tighten this ceiling to match VAULT_GIT_OP_TIMEOUT_MS or git checkout's
 *  15s bound — the goal is "no infinite hang," not "fail fast"; a tight bound converts a slow-but-working
 *  flush into a guaranteed, silent commit-drop (sized off a measured ~11.6s git add -A on a 20k-file vault).
 *
 *  Exported (card 347b3584 round 2) — see VAULT_GIT_OP_TIMEOUT_MS's own doc just above for why. */
export const VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS = 5 * 60_000;

/** @decision 227d9f0b — never copy this as a raw ms literal; always derive from the imported
 *  VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS, and never lower the margin — see the decision record. */
const VAULT_LOCK_STALE_THRESHOLD_MS = VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS * 3;

/** One stale-lock detection result — see {@link detectStaleVaultLock}. */
export interface StaleVaultLockInfo {
  lockPath: string;
  ageMs: number;
  mtimeMs: number;
}

/**
 * Stat-only, locale-independent primary detector for a stale `.git/index.lock`: reads the lock file's own
 * `mtime` directly off disk, never a git error message. `root` is the resolved governing repo root (the
 * same value `commitVault`/`flushSync` already operate on).
 *
 * NOT every vault repo is a plain repo: `root` may be a linked git WORKTREE, whose `.git` is a FILE (a
 * `gitdir: <path>` pointer), not a directory — its own `index.lock` lives in the PRIVATE gitdir that
 * pointer names, never under `<root>/.git/`. Resolved via {@link resolveLeaseGitDir} (the SAME
 * gitfile-aware resolution the pause lease already uses), never a direct `path.join(root, ".git", …)`.
 * @decision 227d9f0b — see the decision record's round-2 section for why the old direct-join form
 *  silently never found a worktree vault's real lock at all.
 *
 * No git dir resolvable at all (not a repo, per {@link resolveLeaseGitDir}) → nothing to detect, `null`.
 * No lock file at all → not stale (the common case, `null`). A lock present but younger than
 * `opts.thresholdMs` → also not stale: a real, still-progressing `git add -A`/commit on a large or
 * network-backed vault legitimately holds it for up to {@link VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS}.
 *
 * @decision 227d9f0b — never message-classify the git error as the primary signal here (needs a locale
 *  pin this module's add/commit calls don't carry) — see the decision record.
 */
export function detectStaleVaultLock(
  root: string,
  opts?: { thresholdMs?: number; nowMs?: number },
): StaleVaultLockInfo | null {
  const gitDir = resolveLeaseGitDir(root);
  if (!gitDir) return null;
  const lockPath = path.join(gitDir, "index.lock");
  let stat: fs.Stats;
  try { stat = fs.statSync(lockPath); } catch { return null; }
  const threshold = opts?.thresholdMs ?? VAULT_LOCK_STALE_THRESHOLD_MS;
  const now = opts?.nowMs ?? Date.now();
  const ageMs = now - stat.mtimeMs;
  if (ageMs < threshold) return null;
  return { lockPath, ageMs, mtimeMs: stat.mtimeMs };
}

/**
 * Locale-sensitive (English-only git fatal text), measured verbatim against this host's real git:
 * "fatal: Unable to create '<path>/index.lock': File exists." Annotates a filed alert's
 * `detail.corroboratedByMessage` for a human reading it.
 *
 * @decision 227d9f0b — SECONDARY corroborator only; never gate detection on this — see the decision record.
 */
const STALE_LOCK_MESSAGE_RE = /Unable to create '[^']*index\.lock':\s*File exists\.?/i;

function staleLockMessageCorroborates(err: unknown): boolean {
  return err instanceof Error && STALE_LOCK_MESSAGE_RE.test(err.message);
}

/** Marker filename for {@link maybeAlertStaleVaultLock}'s on-disk dedupe — same `.git/`-scoped-file
 *  convention as the pause lease / push-outcome record below (chokidar-ignored, never git-tracked). */
const VAULT_LOCK_ALERT_MARKER_FILENAME = "loom-vault-lock-alert.json";

/** The marker path for an already-resolved real git dir (round 2) — mirrors {@link pauseLeasePath}; both
 *  {@link maybeAlertStaleVaultLock} and its clear-side twin below build it from the SAME resolved dir. */
function vaultLockAlertMarkerPath(gitDir: string): string {
  return path.join(gitDir, VAULT_LOCK_ALERT_MARKER_FILENAME);
}

/**
 * Detect + (at most once per distinct lock instance) file a durable, owner-visible
 * `vault_index_lock_stale` orchestration event naming the repo, the lock's age, and the exact human
 * removal command. Dedupe is keyed on the lock file's OWN mtime, persisted in a small marker file next to
 * the real git dir (round 2: {@link resolveLeaseGitDir}, not a direct `<commitPath>/.git` join — see
 * {@link detectStaleVaultLock}'s own doc) — a 5s-debounced auto-commit retry storm (or a 30-minute watcher
 * tick) against the SAME still-stuck lock only files ONE event; a genuinely NEW lock instance (a different
 * mtime) re-fires.
 *
 * The marker is written ONLY after `appendEvent` itself SUCCEEDS, and ONLY when `lockAlert.db` is set —
 * see the decision record's round-2 section for why the round-1 unconditional write could silence a
 * genuinely stuck lock forever.
 * @decision 227d9f0b — never write the marker before a successful appendEvent; a failed/absent write must
 *  leave no marker, so the next tick/commit/flush retries filing the event from scratch.
 *
 * Best-effort throughout: a marker read/write fault or a failed `appendEvent` never throws into any of
 * this function's callers (`VaultVersioner.commit()`'s swallow, `flushSync()`'s warn path, and the
 * proactive `VaultPushStatusWatcher` tick).
 *
 * `lockAlert.db` absent (every pre-existing `VaultVersioner`/`VaultPushStatusWatcher` construction) →
 * detection still runs (so a test can assert on the return value) but no event is filed and no marker is
 * written — matches this module's established "optional dep, silent no-op when absent" posture.
 *
 * @decision 227d9f0b — never add auto-removal gated on this detector — see the decision record for why
 *  no sound Windows liveness proof exists for this today.
 */
export function maybeAlertStaleVaultLock(
  commitPath: string,
  lockAlert: { db?: Pick<Db, "appendEvent">; projectId?: string },
  err?: unknown,
): StaleVaultLockInfo | null {
  let info: StaleVaultLockInfo | null;
  try { info = detectStaleVaultLock(commitPath); } catch { return null; }
  if (!info) return null;
  const gitDir = resolveLeaseGitDir(commitPath);
  if (!gitDir) return info; // detectStaleVaultLock just resolved one — defensive only, should not happen
  const markerPath = vaultLockAlertMarkerPath(gitDir);
  try {
    const prev = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { lockMtimeMs?: number };
    if (prev?.lockMtimeMs === info.mtimeMs) return info; // already alerted for this exact lock instance
  } catch { /* no marker yet, or unreadable — proceed to alert */ }
  if (lockAlert.db) {
    const command = process.platform === "win32"
      ? `Remove-Item -Force "${info.lockPath}"`
      : `rm -f "${info.lockPath}"`;
    try {
      lockAlert.db.appendEvent({
        id: randomUUID(),
        ts: new Date().toISOString(),
        managerSessionId: "",
        kind: "vault_index_lock_stale",
        detail: {
          ...(lockAlert.projectId ? { projectId: lockAlert.projectId } : {}),
          repoPath: commitPath,
          lockPath: info.lockPath,
          ageMs: info.ageMs,
          command,
          caveat: "Make sure no editor or git GUI is actually mid-operation on this repo before removing the lock.",
          ...(staleLockMessageCorroborates(err) ? { corroboratedByMessage: true } : {}),
        },
      });
      // @decision 227d9f0b — mark this lock instance "alerted" only once the durable write lands; a
      // throw here skips straight to the catch below, writing no marker, so the next call retries.
      try {
        fs.writeFileSync(markerPath, JSON.stringify({ lockMtimeMs: info.mtimeMs, notifiedAt: new Date().toISOString() }));
      } catch { /* best-effort */ }
    } catch { /* best-effort — never let a failed audit write break the caller's own flow */ }
  }
  return info;
}

/**
 * The CLEAR half of {@link maybeAlertStaleVaultLock} (card 227d9f0b round 2): once a repo's marker is
 * present AND its lock has since disappeared, files a paired `vault_index_lock_cleared` event and removes
 * the marker — mirroring the `claude_boot_dialog_stuck`/`_resolved` pairing; see the decision record's
 * round-2 section for the full "no marker"/"still stuck"/"no db" no-op cases and why removal is gated on
 * the append succeeding first. Runs ONLY from {@link VaultPushStatusWatcher.tick} — never from
 * `commit()`/`flushSync()`, which never observe a clear on their own failure path. Never throws.
 */
function maybeClearStaleVaultLockAlert(
  commitPath: string,
  lockAlert: { db?: Pick<Db, "appendEvent">; projectId?: string },
): void {
  if (!lockAlert.db) return;
  try {
    const gitDir = resolveLeaseGitDir(commitPath);
    if (!gitDir) return;
    const markerPath = vaultLockAlertMarkerPath(gitDir);
    if (!fs.existsSync(markerPath)) return; // nothing was ever alerted here — nothing to clear
    if (fs.existsSync(path.join(gitDir, "index.lock"))) return; // still stuck — not cleared yet
    lockAlert.db.appendEvent({
      id: randomUUID(),
      ts: new Date().toISOString(),
      managerSessionId: "",
      kind: "vault_index_lock_cleared",
      detail: {
        ...(lockAlert.projectId ? { projectId: lockAlert.projectId } : {}),
        repoPath: commitPath,
      },
    });
    fs.rmSync(markerPath);
  } catch { /* best-effort — never let a failed clear-check break the caller's own flow */ }
}

/**
 * `maxBuffer` for all three of `flushSync`'s `execSync` calls (card 816f0056 review round 2, finding 1).
 * Node's 1 MiB default covers combined stdout+stderr, and `git add -A` emits ONE "LF will be replaced by
 * CRLF" warning line to stderr PER FILE when `core.autocrlf=true` — the Git-for-Windows installer
 * default. Measured with the exact options this file uses: 8,000 files OK; 12,000 files → ENOBUFS +
 * SIGTERM at 1,048,645 bytes of stderr → throws → the existing `catch` → a SILENTLY DROPPED commit on an
 * ORDINARY ~10k-note Obsidian vault — precisely the large-vault data-loss failure
 * {@link VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS} exists to prevent, just via a different option on the SAME
 * calls. `git status --porcelain`'s stdout was separately measured at ~290KB on a first-ever 20k-file
 * flush (~1 MiB at ~70k files), so it needs headroom too, not only the two working-tree calls. 100MB is
 * a one-shot allocation on a rare shutdown-only path — cheap insurance, not a resource concern.
 */
const VAULT_FLUSH_MAX_BUFFER_BYTES = 100 * 1024 * 1024;

/**
 * The git method surface {@link boundedVaultGit} exposes: the plumbing methods this module's
 * OTHER bounded call sites use (`checkIsRepo`/`revparse`/`init`/`raw`) UNION the three working-tree
 * methods `commitVault` needs (`add`/`status`/`commit` — card 54b839c5). One shared Pick so
 * `commitVault` reuses the SAME bounding seam as every other call site in this file instead of a
 * second bounding mechanism.
 */
export type BoundedVaultGit = Pick<SimpleGit, "checkIsRepo" | "revparse" | "init" | "raw" | "add" | "status" | "commit">;

/**
 * Injectable seam mirroring git/worktrees.ts's `BoundedGitDeps` — lets a test simulate a hanging git
 * child with a tiny budget and assert a call returns within the window instead of hanging forever.
 * `gitFactory` defaults to a simpleGit whose `block` timeout kills a no-output (hung) child; `timeoutMs`
 * bounds both that block timeout and the {@link withTimeout} race. Real callers never pass this.
 */
export interface VaultGitDeps {
  /** `env` (added card 306dd105) is OPTIONAL and ONLY ever carries what {@link messageClassifiedProbeEnv}
   *  builds for a message-classified discovery probe: a locale pin PLUS ambient repo-location env
   *  stripped — never a `GIT_DIR`/`GIT_WORK_TREE` *pin* (see {@link boundedVaultGit}'s own doc for why
   *  those never belong here as a pin). A factory that ignores the third argument (every pre-existing
   *  test factory) behaves exactly as before. */
  gitFactory?: (repoPath: string, blockTimeoutMs: number, env?: Record<string, string | undefined>) => BoundedVaultGit;
  timeoutMs?: number;
  /**
   * Test-only, `flushSync`-specific override for its `git add -A` call, INDEPENDENT of `timeoutMs` /
   * {@link flushCommitTimeoutMs} (card 816f0056 review round 2, finding 7 — `timeoutMs` alone collapses
   * BOTH working-tree calls onto one injected value, so a test could never tell "add and commit share a
   * timeout" apart from "they're bound independently", and a bug that swapped which production constant
   * backs which call would go undetected). Lets a test set a LARGE `add` bound alongside a TINY `commit`
   * bound (or vice versa) to prove the two are genuinely separate code paths. Falls back to `timeoutMs`,
   * then {@link VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS}, when unset — real callers never pass this.
   */
  flushAddTimeoutMs?: number;
  /** Test-only, `flushSync`-specific override for its `git commit` call — see {@link flushAddTimeoutMs}.
   *  Real callers never pass this. */
  flushCommitTimeoutMs?: number;
  /** Test-only override for `flushSync`'s git-invoking function (normally `execFileSync`). See the
   *  decision comment at `flushSync`'s own call sites (card ffe98495) for why this exists and how a test
   *  uses it. Real callers never pass this. */
  flushExecFileSyncImpl?: typeof execFileSync;
}

/** @decision 54b839c5 — never re-add a `.env({ GIT_TERMINAL_PROMPT: "0" })` override here: tried and
 *  reverted — it throws on an ambient GIT_EDITOR/PAGER var, and `.env()` replaces rather than merges the
 *  whole child env, breaking config-path passthrough; moot anyway since commitVault never touches the network. */

/**
 * `os.devNull` (never a fresh `mkdtemp`'d dir): a `<devNull>/<hookname>` path can never exist, so git's
 * `find_hook()` always reports "no such hook" — structurally, not just typically. Mirrors
 * `git/worktrees.ts`'s `AUTOCOMMIT_HOOKS_PATH` (see that constant's own doc for the fuller threat-model
 * reasoning against a background process racing a fresh tmp dir); the two are independent copies rather
 * than a shared import to keep this leaf module's dependency surface unchanged.
 *
 * @decision ffe98495 — never apply `core.hooksPath`/`core.fsmonitor` to only the commit call — pin both
 *  on EVERY vault git call via `boundedVaultGit`, and never drop `--no-verify` from `commitVault`'s own
 *  commit calls as if the hooksPath override alone were sufficient.
 */
const VAULT_GIT_SAFETY_HOOKS_PATH = os.devNull;
/** @decision ffe98495 — never scope `commit.gpgsign=false`/`safe.bareRepository=explicit` to only the
 *  commit branch; they belong here, unconditionally, same as hooksPath/fsmonitor. Vault commits are
 *  automated notes snapshots — gpgsign is FORCED off, not merely left at its default. */
const VAULT_GIT_SAFETY_CONFIG: string[] = [
  `core.hooksPath=${VAULT_GIT_SAFETY_HOOKS_PATH}`,
  "core.fsmonitor=false",
  "commit.gpgsign=false",
  "safe.bareRepository=explicit",
];
const VAULT_GIT_SAFETY_UNSAFE: SimpleGitOptions["unsafe"] = { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true };
/** The `-c` argv form of {@link VAULT_GIT_SAFETY_CONFIG}, for `flushSync`'s raw `execFileSync("git", […])`
 *  spawns — it never goes through `boundedSimpleGit`, so it cannot pick up that constant's `config`
 *  option and must carry these `-c` flags itself, on every one of its own git invocations. */
const VAULT_GIT_SAFETY_ARGS: string[] = VAULT_GIT_SAFETY_CONFIG.flatMap((c) => ["-c", c]);

/** Build the bounded git instance + resolve the timeout for one vault-versioner op, applying the seam's
 *  defaults. No `.env()` override BY DEFAULT (see the doc immediately above for why — card 54b839c5); an
 *  explicit `env` is accepted (card 306dd105 round 2) ONLY for a caller that needs to pin something
 *  LOCALE-only (never `GIT_DIR`/`GIT_WORK_TREE` — see {@link messageClassifiedProbeEnv}'s own doc) on top
 *  of this plain discovery instance. Every REAL (non-test-injected) instance carries {@link
 *  VAULT_GIT_SAFETY_CONFIG} — see that constant's own doc.
 *
 * **DISCOVERY ONLY** — never repo-pinned (no `GIT_DIR`/`GIT_WORK_TREE`): a caller resolving whether
 * `repoPath` IS a repo, or discovering its governing root via upward search (`resolveVaultRepoContext`,
 * `commitVault`'s own pre-commit "externally managed" check), NEEDS git's normal cwd-based discovery to
 * work — see {@link boundedVaultGitAtConfirmedRoot} for the pinned variant used once a call site has
 * already confirmed which repo it means to act on. */
function boundedVaultGit(
  repoPath: string,
  deps: VaultGitDeps,
  env?: Record<string, string | undefined>,
): { git: BoundedVaultGit; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? VAULT_GIT_OP_TIMEOUT_MS;
  const git = deps.gitFactory
    ? deps.gitFactory(repoPath, timeoutMs, env)
    : boundedSimpleGit(repoPath, timeoutMs, env, undefined, VAULT_GIT_SAFETY_UNSAFE, VAULT_GIT_SAFETY_CONFIG);
  return { git, timeoutMs };
}

/** @decision 306dd105 — pin LC_ALL=C/LANGUAGE=C (an unpinned host locale defeats isNotAGitRepositoryError's
 *  English-only match) and STRIP (never pin) ambient repo-location env, so this unpinned discovery probe
 *  can't be silently redirected at a different repo. See the decision record's "Round 3". */
function messageClassifiedProbeEnv(): Record<string, string | undefined> {
  const env = localReadGitEnv(process.env, { LC_ALL: "C", LANGUAGE: "C" });
  stripRepoLocationEnv(env);
  return env;
}

/**
 * The REPO-PINNED sibling of {@link boundedVaultGit}: same safety config/unsafe-opt-ins, PLUS
 * `GIT_DIR`/`GIT_WORK_TREE` pinned to `confirmedRoot` via `localReadGitEnv` (which also strips the
 * transport env-var family — `GIT_ASKPASS`/`SSH_ASKPASS`/etc — so an ambiently-set one on the daemon host
 * can't make simple-git throw "unsafe" the moment this becomes an EXPLICIT env; vault commits never touch
 * a remote, so those keys can never matter here regardless).
 *
 * @decision ffe98495 — call this ONLY once `confirmedRoot` IS (or is about to become, via `git init`) the
 *  actual repo root — pinning `GIT_DIR` before that is confirmed disables git's own upward discovery and
 *  silently misbehaves; see `commitVault`'s own call site for the required ordering.
 */
function boundedVaultGitAtConfirmedRoot(
  confirmedRoot: string,
  deps: VaultGitDeps,
): { git: BoundedVaultGit; timeoutMs: number } {
  const timeoutMs = deps.timeoutMs ?? VAULT_GIT_OP_TIMEOUT_MS;
  const pinnedEnv = localReadGitEnv(process.env, {
    GIT_DIR: path.join(confirmedRoot, ".git"),
    GIT_WORK_TREE: confirmedRoot,
  });
  const makeGit = deps.gitFactory
    ?? ((p, ms) => boundedSimpleGit(p, ms, pinnedEnv, undefined, VAULT_GIT_SAFETY_UNSAFE, VAULT_GIT_SAFETY_CONFIG));
  return { git: makeGit(confirmedRoot, timeoutMs), timeoutMs };
}

/**
 * @decision 39ceb732 — these are CANDIDATES ONLY, never exclude one from the watcher directly — see
 *  {@link safeToExcludeNames}, the function that actually decides. `.gitignore` has no effect on an
 *  already-tracked path, so a name straight out of this parser is not provably safe on its own.
 * @decision 687d2a47 — never widen this to full gitignore semantics (negation/glob/nested/root-anchored) —
 *  an unrecognized pattern must be left watched, never guessed at. Never switch the `name/`-form directory
 *  check from `fs.lstatSync` to `fs.statSync` — that reopens the symlink-to-directory over-exclusion this fixed.
 */
export function gitignoredTopLevelNames(repoRoot: string): string[] {
  let raw: string;
  try { raw = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8"); }
  catch { return []; }
  const names: string[] = [];
  for (const lineRaw of raw.split(/\r?\n/)) {
    if (lineRaw === "" || /^\s/.test(lineRaw)) continue; // blank, or leading whitespace (significant to git) — leave watched
    if (lineRaw.startsWith("#") || lineRaw.startsWith("!")) continue;
    if (/[*?[\]\\]/.test(lineRaw)) continue; // glob syntax or a backslash escape we don't interpret — leave watched
    if (lineRaw.startsWith("/")) continue; // root-anchored — narrower semantics than we implement; leave watched
    const hasTrailingSlash = /\/$/.test(lineRaw);
    const stripped = lineRaw.replace(/\/$/, ""); // strip only a trailing directory-marker slash
    if (!stripped || stripped.includes("/") || /\s$/.test(stripped)) continue; // nested path or unhandled trailing whitespace — leave watched
    if (hasTrailingSlash) {
      // git's directory-only form — only a real, CURRENT directory qualifies (see doc above). lstatSync,
      // NOT statSync: a symlink-to-dir must NOT count as a directory here (git itself doesn't ignore one).
      let isDir = false;
      try { isDir = fs.lstatSync(path.join(repoRoot, stripped)).isDirectory(); } catch { /* leave watched */ }
      if (!isDir) continue;
    }
    names.push(stripped);
  }
  return names;
}

/**
 * Which of `candidates` (from {@link gitignoredTopLevelNames}) git ALREADY TRACKS — either an exact
 * tracked FILE of that name, or a tracked file somewhere under a same-named directory. ONE batched
 * `git ls-files` call covers every candidate (a single git invocation, not one per name).
 *
 * Do not add a trailing slash to the pathspec (`git ls-files -- foo/` misses a tracked FILE literally
 * named `foo`) and do not newline-split instead of using `-z` (NUL-separated) — `core.quotePath`
 * octal-quotes a non-ASCII tracked path, e.g. a tracked `Café/note.md` prints as `"Caf\303\251/note.md"`
 * (literal backslashes in the output), which a naive newline+`/`-split shreds into garbage. `-z`
 * sidesteps quoting entirely rather than needing a `-c core.quotePath=false` override. Getting either
 * wrong makes a genuinely-tracked path silently report as untracked and offered for exclusion.
 *
 * Fails SAFE: any git error treats every candidate as tracked — i.e. excludes NOTHING — rather than risk
 * dropping history for a name it couldn't verify; a bound timeout (`timeoutMs`, card 509716cc) lands in
 * the same catch, the same way.
 *
 * @decision 687d2a47 — never rely on `git -c core.ignorecase=true` as a substitute for this `:(icase,literal)`
 *  pathspec wrapper — the config knob doesn't reach pathspec matching. Never drop the lowercasing of
 *  returned first-segment names — `:(icase)` finds a case-differing tracked entry but keeps its own on-disk casing.
 */
async function gitTrackedTopLevelNames(
  git: Pick<SimpleGit, "raw">,
  candidates: string[],
  timeoutMs: number = VAULT_GIT_OP_TIMEOUT_MS,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  try {
    const pathspecs = candidates.map((c) => `:(icase,literal)${c}`);
    const out = await withTimeout(git.raw(["ls-files", "-z", "--", ...pathspecs]), timeoutMs, "git ls-files (vault safeToExcludeNames)");
    const tracked = new Set<string>();
    for (const rel of out.split("\0")) {
      if (!rel) continue;
      tracked.add((rel.split(/[\\/]/)[0] ?? rel).toLowerCase());
    }
    return tracked;
  } catch {
    return new Set(candidates.map((c) => c.toLowerCase()));
  }
}

/**
 * The names actually SAFE to exclude from the watcher for `commitPath`: its gitignored top-level
 * candidates ({@link gitignoredTopLevelNames}) MINUS any git already tracks ({@link gitTrackedTopLevelNames}
 * — a gitignored-but-tracked name must stay watched, since `commitVault`'s `git add .` would still stage
 * an edit to it and the watcher must still be able to see that edit happen). Read/computed ONCE, at
 * `start()` — like `commitPath`/`externallyManaged` elsewhere in this class, this does not react to a
 * LATER `.gitignore` edit or a file being un-tracked without a versioner restart (a daemon restart or vault
 * re-provision); accepted, consistent with the rest of this class's resolve-once-at-start design.
 *
 * `timeoutMs` (card 509716cc) bounds the underlying `git ls-files` call — see
 * {@link gitTrackedTopLevelNames}'s doc for the fail-safe behavior on timeout. Defaults to
 * {@link VAULT_GIT_OP_TIMEOUT_MS}; real callers never override it.
 */
export async function safeToExcludeNames(
  commitPath: string,
  git: Pick<SimpleGit, "raw">,
  timeoutMs: number = VAULT_GIT_OP_TIMEOUT_MS,
): Promise<string[]> {
  const candidates = gitignoredTopLevelNames(commitPath);
  if (candidates.length === 0) return [];
  const tracked = await gitTrackedTopLevelNames(git, candidates, timeoutMs);
  // .toLowerCase() here pairs with gitTrackedTopLevelNames' own lowercasing — see that function's doc
  // (card 687d2a47 finding 3) for why the comparison must be case-insensitive.
  return candidates.filter((n) => !tracked.has(n.toLowerCase()));
}

/**
 * The four hardcoded, LOAD-BEARING exclusions (`.git`/`.obsidian`/`node_modules`/`worktrees` — these are
 * what keep worker worktrees and tool state out of the watcher today; see the module doc above) UNION
 * `extraSafeNames` (see {@link safeToExcludeNames} — the caller's job to have already proven these safe;
 * this function does no safety filtering of its own). Always additive, never a replacement, so the
 * hardcoded four are unconditionally present regardless of `extraSafeNames`.
 *
 * **NOT exported.** This regex is only ever safe to test against a path RELATIVE to `commitPath` — see
 * {@link buildIgnoredMatcher}'s doc for why an ABSOLUTE-path test can match a segment in `commitPath`'s own
 * ancestor chain and kill the whole watcher. Keeping this un-exported means that invariant lives in the
 * one place that constructs a matcher from it, instead of being a convention a second future caller could
 * silently violate by testing the bare pattern against an absolute path (exactly the form Critical-2 named
 * unsafe). `buildIgnoredMatcher` is the only public surface.
 */
function buildIgnoredPattern(commitPath: string, extraSafeNames: string[] = []): RegExp {
  const names = ["\\.git", "\\.obsidian", "node_modules", "worktrees", ...extraSafeNames.map(escapeRegExp)];
  return new RegExp(`(^|[/\\\\])(${names.join("|")})([/\\\\]|$)`);
}

/**
 * The chokidar `ignored` MATCHER (a function, not a bare pattern) for a governing repo root: tests each
 * candidate path RELATIVE TO `commitPath`, never the absolute path. Card 39ceb732's Critical-2 finding:
 * an absolute-path regex can match a segment in `commitPath`'s OWN ANCESTOR chain — including the repo
 * root's own directory name — and chokidar tests the ROOT itself, so a repo at (say)
 * `.../scratch/myvault` with `scratch/` in ITS OWN `.gitignore` got a pattern that matched the root path
 * itself, and chokidar refuses to descend into an ignored root at all: `getWatched()` came back `{}` — a
 * SILENT, TOTAL watcher death, live-verified. Testing the RELATIVE path instead makes this structurally
 * impossible, not just less likely: `path.relative(commitPath, commitPath)` is always `""`, which cannot
 * match `(^|[/\\])(name)([/\\]|$)` for any non-empty name — nothing outside the repo is ever in the string
 * being tested at all. This is the ONLY exported way to get an ignore matcher — {@link buildIgnoredPattern}
 * itself is deliberately un-exported so nothing outside this module can reintroduce the absolute-path form.
 */
export function buildIgnoredMatcher(commitPath: string, extraSafeNames: string[] = []): (p: string) => boolean {
  const pattern = buildIgnoredPattern(commitPath, extraSafeNames);
  return (p: string) => pattern.test(path.relative(commitPath, p));
}

/**
 * Paths we've already warned about for a given repo root — suppresses re-warning on every debounced
 * commit tick while a stuck oversized file just sits there untouched (chokidar re-triggers `commit()` on
 * ANY change under the watched root, which restages every untracked file, including this one, every
 * time). Module-scope + add-only: a daemon restart re-warns once, which is fine; there is no need to
 * evict an entry once the file stops being oversized (it just never gets re-added to this set).
 */
const warnedOversizedFiles = new Set<string>();

/** @decision 54b839c5 — never use `git reset HEAD -- <path>` here; it fails on a repo with no HEAD yet
 *  (a brand-new repo's first commit) — `git reset -- <path>` works there. Never aggregate a per-file reset
 *  failure into one abort; swallow it per-file so one bad unstage doesn't block committing every other file. */
async function unstageOversizedFiles(
  git: Pick<SimpleGit, "raw">,
  root: string,
  files: Array<{ path: string; working_dir: string; index: string }>,
  maxFileBytes: number,
  timeoutMs: number = VAULT_GIT_OP_TIMEOUT_MS,
): Promise<string[]> {
  const skipped: string[] = [];
  for (const f of files) {
    if (f.working_dir === "D" || f.index === "D") continue; // deletion — nothing to stat, nothing to skip
    let size: number;
    try { size = fs.statSync(path.join(root, f.path)).size; } catch { continue; } // gone/unreadable — let the normal flow handle it
    if (size <= maxFileBytes) continue;
    try {
      await withTimeout(git.raw(["reset", "--", f.path]), timeoutMs, `git reset (vault unstage oversized: ${f.path})`);
      skipped.push(f.path);
      const key = `${root}::${f.path}`;
      if (!warnedOversizedFiles.has(key)) {
        warnedOversizedFiles.add(key);
        const rel = f.path.replace(/\\/g, "/");
        console.warn(
          `[vault-versioner] ${rel} is ${humanBytes(size)} (> ${humanBytes(maxFileBytes)}) — skipped from ` +
          `auto-commit. Add "${rel}" to .gitignore to silence this warning.`,
        );
      }
    } catch (err) {
      console.warn(`[vault-versioner] failed to unstage oversized file ${f.path}: ${(err as Error).message}`);
    }
  }
  return skipped;
}

/**
 * Whether the repo at `git`'s cwd has BOTH `user.name` and `user.email` resolvable (global/system/local
 * config, in git's own precedence order). `git config user.<key>` exits non-zero when unset, which
 * simple-git surfaces as a rejection — caught here and treated as "unresolved", never thrown.
 *
 * Narrowed to `Pick<SimpleGit, "raw">` (card 54b839c5) — the only method this calls — mirroring
 * `git/worktrees.ts`'s own copy of this same check, so callers passing a `BoundedVaultGit` (which does
 * not carry every `SimpleGit` method) can use it directly. `timeoutMs` bounds each `raw` call the same
 * way every other plumbing-tier call in this module is bounded; defaults to {@link VAULT_GIT_OP_TIMEOUT_MS}
 * since a `git config` read is cheap plumbing, not working-tree-scale.
 */
async function hasConfiguredGitIdentity(
  git: Pick<SimpleGit, "raw">,
  timeoutMs: number = VAULT_GIT_OP_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const name = (await withTimeout(git.raw(["config", "user.name"]), timeoutMs, "git config user.name (vault identity check)")).trim();
    const email = (await withTimeout(git.raw(["config", "user.email"]), timeoutMs, "git config user.email (vault identity check)")).trim();
    return !!name && !!email;
  } catch {
    return false;
  }
}

/**
 * SYNCHRONOUS mirror of {@link hasConfiguredGitIdentity}, for `flushSync`'s `execSync` path (card
 * 816f0056 review round 2, finding 2): `flushSync` never had an identity fallback at all, so on a host
 * with no global/system/local git identity configured, EVERY shutdown flush failed silently, forever —
 * measured: `fatal: empty ident name (for <>) not allowed` — while the async `commit()`/`commitVault`
 * path succeeded via its own fallback. This file's own doc on `commitVault` (below) already anticipates
 * exactly this kind of host ("may have no global/system git identity at all"), so the gap was not
 * hypothetical. Same "unset → false" semantics as the async version: `git config user.<key>` exits
 * non-zero when unset, which `execSync` throws for — caught here and treated as unresolved.
 */
function hasConfiguredGitIdentitySync(opts: { cwd: string; stdio: "pipe"; timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number }): boolean {
  try {
    const name = execSync("git config user.name", opts).toString().trim();
    const email = execSync("git config user.email", opts).toString().trim();
    return !!name && !!email;
  } catch {
    return false;
  }
}

/**
 * Card a09b81a0: a legacy project row whose `vaultPath` is a SUBDIR of its own (or another registered
 * project's) code repo resolves, via `resolveVaultRepoContext`'s upward walk, to that code repo's ROOT —
 * so the auto-committer was staging and committing arbitrary code files, on the code repo's own branch,
 * outside `withCanonicalIndexLock` (able to race `mergeBranchLocked`/batch assembly on the shared index).
 * `cb6ba196`/`8d49c36c` only refuse NEW creates/updates into that shape; an untouched legacy row keeps it.
 *
 * One entry per project this daemon knows about — the SAME flattening `index.ts` already does for merge-
 * quarantine re-arm (`project.repoPath` + every `project.repos[].path`), plus `vaultOnly`/`vaultPath` so
 * the exemption below can be decided without a second lookup.
 */
export interface CodeRepoGuardEntry {
  id: string;
  repoPath: string;
  repos: { path: string }[];
  vaultOnly: boolean;
  vaultPath: string;
}

/**
 * Registered ONCE at boot (`index.ts`, from the live `Db`) via {@link setCodeRepoGuardProvider} — a
 * PROVIDER, not a cached snapshot, so a runtime `repoPath` rebind or a freshly created project is visible
 * to the very NEXT `commitVault`/`flushSync` call, with no daemon restart needed. `snapshot()` is called
 * fresh on every check (cheap: a couple of SQLite SELECTs) — never memoized here.
 */
export interface CodeRepoGuard {
  snapshot: () => CodeRepoGuardEntry[];
  /** File the durable audit event for a refusal — the caller supplies only the detail payload; this
   *  callback owns the real `db.appendEvent({..., kind:"vault_autocommit_refused_code_repo", ...})` call
   *  (versioner.ts has no `Db` import of its own outside `startVaultVersioners`'s parameter type). */
  recordEvent: (detail: Record<string, unknown>) => void;
}

let codeRepoGuard: CodeRepoGuard | undefined;

/**
 * Wire (or, passing `undefined`, unwire — real callers never do) the code-repo collision guard.
 * **FAIL-OPEN when unset**: a unit test that calls `commitVault`/`flushSync` directly, with no boot-wired
 * `Db`, has nothing to check a collision against and must not refuse just because nothing was wired —
 * see {@link checkCodeRepoCollision}. Production boot ALWAYS wires one (see
 * `vault-commit-code-repo-guard.mjs`'s own boot-wiring assertion) — a forgotten wiring is caught there,
 * never silently masked by this fail-open.
 */
export function setCodeRepoGuardProvider(provider: CodeRepoGuard | undefined): void {
  codeRepoGuard = provider;
}

/** The result of a collision hit — which OTHER registered project/path this `commitPath` collides with. */
export interface CodeRepoCollision {
  collidesWithProjectId: string;
  collidesWithRepoPath: string;
}

/**
 * Whether `candidateKey` (an already-canonicalized {@link canonicalRepoLockKey} result) names the SAME
 * directory as, or a path-segment-aware DESCENDANT of, `rootKey` (also already-canonicalized). Plain
 * `startsWith` would wrongly match a sibling whose name happens to extend the root's (`mono2` vs `mono`);
 * this requires a full path-segment boundary between them.
 *
 * @decision a09b81a0 — pure path comparison, deliberately never a per-candidate git-toplevel probe; see
 *  the decision record's round-2 section for why.
 */
function isCanonicallyAtOrUnder(candidateKey: string, rootKey: string): boolean {
  if (candidateKey === rootKey) return true;
  const rootWithSep = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep;
  return candidateKey.startsWith(rootWithSep);
}

/**
 * @decision a09b81a0 — round 3, owner ruling on request `8d6fea89` (option A): a repo that is itself some
 * project's vault root is exempt from the collision refusal below, EVEN IF it is also registered as some
 * OTHER project's own `repoPath`.
 *
 * ⚠️ **KNOWN HOLE, NOT YET FIXED — a THIRD party can grant this exemption for a code repo it has nothing
 * to do with.** Given `P = {repoPath: C, vaultPath: C/docs}` (the ORIGINAL bug shape) and an UNRELATED
 * `Q = {repoPath: D, vaultPath: C/q-notes}` (Q's own code lives at `D`, entirely outside `C`), `Q` vouches
 * for `C` — its own code is not at risk there — and `commitVault(C)` then auto-commits `C`'s real source.
 * Verified directly with real git: `committed:true`, `C`'s commit count increments. The predicate below
 * CANNOT tell this apart from Parallax's shape; geometry alone is not a sufficient discriminator for "is
 * this really just notes." Two further degenerate variants of the SAME hole, also verified: a voucher
 * entry with `repoPath: ""` vouches for ANY `key` unconditionally (its `ownCandidates` list is empty after
 * `.filter(Boolean)`, so `.some(...)` is vacuously `false`); a voucher whose `repoPath` is an ANCESTOR of
 * `key` (rather than at-or-under it) also vouches, since `isCanonicallyAtOrUnder` only checks one
 * direction. **The owner is choosing the real discriminator — an explicit per-project flag or a platform
 * list of recognized vault roots — do not extend or "harden" this geometric predicate in the meantime.**
 * See `vault-commit-code-repo-guard.mjs`'s dedicated tests (14)/(14b)/(14c) for this hole — now green
 * tripwires pinning today's known-wrong behavior (request `f7cc5951` pending, tracked by card `7c1d6dbf`),
 * not deliberately-red assertions.
 *
 * Is `key` (an already-canonicalized {@link canonicalRepoLockKey} result for an already-RESOLVED governing
 * repo root) a NOTES repo — "some project's vault root" — rather than a code repo? The shared Obsidian
 * vault is the motivating case: Parallax/Shahnameh/Federalist/Menu Visualizer all bind `repoPath` to it,
 * while ~20 unrelated code projects' `vaultPath` lives under it as a subfolder.
 *
 * **The predicate:** `key` is a recognized vault root iff some registered entry's `vaultPath` is
 * canonically at-or-under `key` AND that SAME entry's own code candidates (`repoPath` + every `repos[]`
 * entry) are NOT themselves at-or-under `key`. The second half excludes SELF-vouching only — it does NOT
 * close the third-party hole above, which is a DIFFERENT entry vouching for a key it has no stake in.
 *
 * **What self-exclusion DOES close.** `vaultPath` nested inside `repoPath` is EXACTLY the shape of the
 * original bug — geometrically indistinguishable, from a single entry's own two fields, from Parallax's
 * shape. Excluding an entry from vouching for a `key` its OWN code is also at risk under is what keeps
 * that SAME entry from exempting itself, and what keeps the monorepo-subdir shape (round 2, Finding 1:
 * `repoPath=mono/pkg`, `vaultPath=mono/notes`, siblings under `mono`) from self-exempting — that project's
 * OWN `repoPath` is at-or-under `mono`, so it can never vouch for `mono` either, and the collision below
 * still fires. It is a genuinely useful, correct narrowing — it just is not, on its own, sufficient; the
 * third-party hole above is a SEPARATE gap self-exclusion was never meant to address.
 *
 * Cheap and git-free, like {@link isCanonicallyAtOrUnder} itself — pure path comparison over the SAME
 * snapshot `checkCodeRepoCollision` already holds, never a per-candidate git-toplevel probe.
 */
function isRecognizedVaultRoot(key: string, entries: CodeRepoGuardEntry[]): boolean {
  for (const entry of entries) {
    if (!entry.vaultPath) continue;
    const vaultKey = canonicalRepoLockKey(entry.vaultPath);
    if (!isCanonicallyAtOrUnder(vaultKey, key)) continue; // this entry's vault isn't even located at/under `key`
    const ownCandidates = [entry.repoPath, ...entry.repos.map((r) => r.path)].filter(Boolean);
    const ownCodeAtRisk = ownCandidates.some((c) => isCanonicallyAtOrUnder(canonicalRepoLockKey(c), key));
    if (ownCodeAtRisk) continue; // this project's OWN code (if any) is ALSO under `key` — can't vouch for it
    return true; // a genuinely separate project's real vault lives at/under `key` — safe to treat as notes
  }
  return false;
}

/**
 * Whether `commitPath` (an ALREADY-RESOLVED governing repo root — the point every real caller below checks
 * this at) canonically collides with some registered project's own code repo (`repoPath` or a `repos[]`
 * entry) — i.e. staging/committing here would commit THAT project's code, not vault content. Matches a
 * candidate that is canonically AT-OR-UNDER `commitPath`, not just an exact match — see
 * {@link isCanonicallyAtOrUnder}.
 *
 * EXEMPTS a recognized vault root (round 3) UNCONDITIONALLY, before the per-candidate loop below ever
 * runs — see {@link isRecognizedVaultRoot}.
 *
 * ALSO EXEMPTS a TRUE vault-only project, decided PER CANDIDATE: only when the matched candidate IS that
 * entry's own `repoPath`, re-verified against `entry.vaultPath` rather than trusting the flag alone. This
 * is a SEPARATE, narrower exemption from the vault-root one above (exact `repoPath === vaultPath` pairing,
 * e.g. the `5af9020b` legacy-aliased-code shape) and stays in place unchanged.
 *
 * @decision a09b81a0 — see the decision record's round-2 section for the monorepo-subdir repro the
 *  at-or-under rule closes and why the vaultOnly exemption moved from per-entry to per-candidate, and its
 *  round-3 section for the vault-root exemption and the anti-gaming argument behind it.
 *
 * FAIL-OPEN (returns `null`) when no provider is registered — see {@link setCodeRepoGuardProvider}.
 */
function checkCodeRepoCollision(commitPath: string): CodeRepoCollision | null {
  if (!codeRepoGuard) return null;
  const key = canonicalRepoLockKey(commitPath);
  const entries = codeRepoGuard.snapshot();
  if (isRecognizedVaultRoot(key, entries)) return null;
  for (const entry of entries) {
    const candidates = [entry.repoPath, ...entry.repos.map((r) => r.path)];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const candidateKey = canonicalRepoLockKey(candidate);
      if (!isCanonicallyAtOrUnder(candidateKey, key)) continue;
      const isOwnRepoPath = candidate === entry.repoPath;
      if (isOwnRepoPath && entry.vaultOnly && canonicalRepoLockKey(entry.repoPath) === canonicalRepoLockKey(entry.vaultPath)) continue;
      return { collidesWithProjectId: entry.id, collidesWithRepoPath: candidate };
    }
  }
  return null;
}

/**
 * @decision a09b81a0 — round 3: when `commitPath` is merge-eligible (below), the auto-committer's own
 * add+commit sequence must take `withCanonicalIndexLock` for it, keyed EXACTLY like a real merge would —
 * see {@link commitVault}'s own call site for the lock.
 *
 * Whether `commitPath` (an already-RESOLVED governing root) canonically EQUALS some registered project's
 * own `repoPath` or a `repos[]` entry — i.e. a real `mergeBranchLocked`/batch merge or a `GitWriter`
 * commit/checkout/createBranch for THAT project could also target this exact physical repo. EXACT match
 * only, deliberately never at-or-under: every real canonical-index lock is keyed via `canonicalRepoLockKey`
 * (`git/repo-lock.ts`) on that same `repoPath` value (see `git/worktrees.ts`'s `mergeBranch`, `git/writer.ts`'s
 * `GitWriter`), never a derived ancestor.
 *
 * @decision 7673d096 — `canonicalRepoLockKey` now keys on the resolved git TOPLEVEL, which closes what used
 * to be a known subdir-bound-project gap in this exact-match check. See that decision record's own
 * "Consequence for a09b81a0's isCommitPathMergeEligible" section for the full explanation.
 *
 * Independent of {@link checkCodeRepoCollision}'s own collision/exemption verdict — a repo can be BOTH a
 * recognized vault root (exempt from refusal) AND merge-eligible (needs the lock) at once, which is
 * exactly the shared-vault shape this whole round exists for.
 *
 * FAIL-OPEN (returns `false`, no lock) when no provider is registered, mirroring
 * {@link checkCodeRepoCollision}'s own fail-open.
 */
function isCommitPathMergeEligible(commitPath: string): boolean {
  if (!codeRepoGuard) return false;
  const key = canonicalRepoLockKey(commitPath);
  for (const entry of codeRepoGuard.snapshot()) {
    const candidates = [entry.repoPath, ...entry.repos.map((r) => r.path)];
    for (const candidate of candidates) {
      if (candidate && canonicalRepoLockKey(candidate) === key) return true;
    }
  }
  return false;
}

/** One warn + one durable event per (subjectPath, commitPath) per PROCESS — never one per debounce tick
 *  (the tick, and the UI-write path via `commitVault`, can both re-hit the SAME collision repeatedly for
 *  as long as it remains unfixed). `subjectPath` is whatever identity the caller has for "which vault" —
 *  the project's raw configured `vaultPath` at `startVaultVersioners`, or `commitVault`/`flushSync`'s own
 *  (already-resolved) `commitPath` when no distinct raw path is available to them. */
const warnedCodeRepoCollisions = new Set<string>();

function refuseCodeRepoCollision(
  subjectPath: string,
  commitPath: string,
  collision: CodeRepoCollision,
  source: "boot" | "commit_vault" | "flush_sync",
  projectId?: string,
): void {
  const dedupeKey = `${subjectPath.replace(/\\/g, "/")}::${canonicalRepoLockKey(commitPath)}`;
  if (warnedCodeRepoCollisions.has(dedupeKey)) return;
  warnedCodeRepoCollisions.add(dedupeKey);
  console.warn(
    `[vault-versioner] ${subjectPath} resolves to ${commitPath}, which IS registered project ` +
    `${collision.collidesWithProjectId}'s own code repo (${collision.collidesWithRepoPath}) — refusing to ` +
    `auto-commit arbitrary code files into it (card a09b81a0).`,
  );
  try {
    codeRepoGuard?.recordEvent({
      ...(projectId ? { projectId } : {}),
      vaultPath: subjectPath,
      commitPath,
      collidesWithProjectId: collision.collidesWithProjectId,
      collidesWithRepoPath: collision.collidesWithRepoPath,
      source,
    });
  } catch { /* best-effort — an audit-event fault must never block the refusal itself */ }
}

/** `commitVault`'s own result (replaces a bare `boolean` — card a09b81a0): `blockedReason` is present
 *  (and `committed:false`) ONLY for the code-repo-collision refusal above, distinct from every OTHER
 *  silent backoff this function already had (quarantined / externally-managed / nothing-staged /
 *  operational-dir / oversized-only) — those stay `committed:false` with no reason, unchanged. Exists so
 *  `vault/writer.ts`'s UI-write callers can surface THIS specific refusal to their own caller instead of
 *  swallowing it indistinguishably from an ordinary no-op backoff. */
export interface CommitVaultResult {
  committed: boolean;
  blockedReason?: "code-repo-collision" | "paused";
}

/**
 * Stage-all + commit a vault folder, honoring the same externally-managed backoff as the
 * auto-committer: if the vault sits inside a git repo whose root is ABOVE the vault folder
 * (e.g. a vault-wide Obsidian Git repo), we do NOT init or commit, to avoid double-committing.
 * Initializes a repo at the vault folder itself if there is none. Returns true if a commit was
 * made, false if skipped (externally managed, or nothing staged to commit).
 *
 * This is THE single vault commit path — shared by the auto-committer (below) and human UI
 * writes (vault/writer.ts) so the history stays consistent and there is no second git mechanism.
 *
 * **Identity fallback:** unlike `git/writer.ts` (which commits with NO identity override, by
 * deliberate convention — the Loom repo itself always has one configured), this path runs
 * unattended on an arbitrary end-user's machine, which may have no global/system git identity at
 * all. When the repo has one configured, we commit exactly as before — their identity, un-overridden.
 * Only when EITHER `user.name` or `user.email` is unresolved do we fall back to a generic, non-personal
 * `Loom <loom@localhost>` identity for that single commit, via `-c user.name=`/`-c user.email=` passed
 * as ARGS on the commit invocation, never as an env-var override — see the `GIT_TERMINAL_PROMPT` doc
 * above `boundedVaultGit` for why an `.env()` override is unsafe here.
 *
 * **Oversized-file guard** (card 614dfbef): before committing, any staged file above `opts.maxFileBytes`
 * (default `DEFAULT_MAX_VAULT_FILE_BYTES`, ~95MB) is unstaged and warned about instead of committed — see
 * {@link unstageOversizedFiles}. Applies to every caller of this shared path, so a giant file is unstaged
 * before it can enter vault history through either route. This is an AUTOMATIC, unattended path (no human
 * in the loop), which is why it silently unstages rather than warning — contrast `git/writer.ts`'s
 * `GitWriter.commit`, a DELIBERATE human/agent act, which instead WARNS on the same threshold without
 * unstaging (see that method's own doc for the reasoning).
 *
 * @decision 54b839c5 — never collapse this onto one shared ceiling: plumbing calls get
 *  VAULT_GIT_OP_TIMEOUT_MS (15s), working-tree calls (add/commit, the actual hang vector) get
 *  VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS (5min) — one tight ceiling would fail a genuinely-working flush.
 *
 * @decision 68cc29db — never init/stage/commit an operational (LOOM_HOME-rooted) vault dir here — keep
 *  THIS guard AND the pre-disk guards in vault/writer.ts's three write functions, never just one.
 *
 * **Hook/fsmonitor/gpgsign neutralisation + repo pinning** (see {@link VAULT_GIT_SAFETY_CONFIG}'s own
 * doc): every git call this function makes past the initial discovery step carries `-c
 * core.hooksPath=<devNull>`, `-c core.fsmonitor=false`, `-c commit.gpgsign=false`, `-c
 * safe.bareRepository=explicit`, AND `GIT_DIR`/`GIT_WORK_TREE` pinned to the confirmed root (see
 * {@link boundedVaultGitAtConfirmedRoot}) — the commit call itself also passes `--no-verify`. A hostile
 * `vault_write` can no longer plant a `.git/hooks/pre-commit`, a `core.fsmonitor` script, or a
 * `gpg.program` signing hook for this function's next commit to execute, and every mutating call is
 * pinned to exactly the repo this function itself confirmed, never one discoverable by cwd tricks.
 */
export async function commitVault(
  vaultPath: string,
  message: string,
  opts?: { maxFileBytes?: number; deps?: VaultGitDeps },
): Promise<CommitVaultResult> {
  // @decision 68cc29db — refuse unconditionally rather than init/stage/commit an operational dir.
  if (isOperationalVaultDir(vaultPath)) {
    console.warn(`[vault-versioner] refusing to git-init/commit operational vault dir: ${vaultPath}`);
    return { committed: false };
  }
  const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_VAULT_FILE_BYTES;
  const deps = opts?.deps ?? {};
  // Two tiers, two bounded instances (same seam, different ceiling) — see this function's own doc for
  // why one shared ceiling is wrong here. A test-injected `deps.timeoutMs` collapses both tiers onto the
  // SAME small value (both `??` fallbacks below are skipped), which is exactly what a hang test wants —
  // real callers never set `deps`, so production always gets the real 15s/5min split.
  const cheapTimeoutMs = deps.timeoutMs ?? VAULT_GIT_OP_TIMEOUT_MS;
  const workTreeTimeoutMs = deps.timeoutMs ?? VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS;
  // DISCOVERY ONLY, deliberately UNPINNED: whether `vaultPath` is a repo, or a subfolder of a larger one,
  // can only be answered by git's own normal upward search. Everything AFTER this step operates on a
  // CONFIRMED root (`vaultPath` itself, in both surviving branches below) and switches to the pinned
  // instance.
  //
  // @decision ffe98495 — never pin GIT_DIR for this discovery step; a genuine subfolder-of-a-bigger-repo
  //  would report "not a repo" and this function would wrongly `git init` a NESTED repo inside it.
  // @decision 306dd105 (round 2) — this probe's catch branch is MESSAGE-CLASSIFIED (isNotAGitRepositoryError
  //  below), so it needs the LOCALE pin, not just the plain discovery instance — see messageClassifiedProbeEnv.
  const { git } = boundedVaultGit(vaultPath, { ...deps, timeoutMs: cheapTimeoutMs }, messageClassifiedProbeEnv());

  // @decision 306dd105 — fail CLOSED here: only an affirmative isNotAGitRepositoryError may count as
  // "not a repo"; any other discovery error skips this commit instead of defaulting to isRepo=false. See
  // the decision record for why the old blanket `.catch(() => false)` was wrong.
  let isRepo: boolean;
  try {
    isRepo = await withTimeout(git.checkIsRepo(), cheapTimeoutMs, "git check-is-repo (vault commit)");
  } catch (e) {
    if (!isNotAGitRepositoryError(e)) {
      console.warn(
        `[vault-versioner] ${vaultPath} commitVault: discovery check-is-repo failed (not a clean "not a ` +
        `git repository" result) — skipping this commit rather than risk initialising a nested repo: ${(e as Error)?.message ?? e}`,
      );
      return { committed: false };
    }
    isRepo = false;
  }
  if (isRepo) {
    const root = (await withTimeout(git.revparse(["--show-toplevel"]), cheapTimeoutMs, "git rev-parse --show-toplevel (vault commit)").catch(() => "")).trim();
    const externallyManaged = !!root && root.replace(/\\/g, "/") !== vaultPath.replace(/\\/g, "/");
    if (externallyManaged) {
      // @decision a09b81a0 — an UNRESOLVED subfolder vaultPath (vault/writer.ts's own call shape) lands
      // here; check the REAL root for a collision before treating this as a harmless backoff.
      const rootCollision = checkCodeRepoCollision(root);
      if (rootCollision) {
        refuseCodeRepoCollision(vaultPath, root, rootCollision, "commit_vault");
        return { committed: false, blockedReason: "code-repo-collision" };
      }
      return { committed: false };
    }
    // else: root === vaultPath — vaultPath IS the confirmed repo root.
  }
  // else: no repo discoverable anywhere up the chain — vaultPath itself will BECOME the repo root below.

  // @decision a09b81a0 — never cache this check; consult the live provider on every call so a runtime
  // repoPath rebind or a freshly created project is seen without a daemon restart.
  const collision = checkCodeRepoCollision(vaultPath);
  if (collision) {
    refuseCodeRepoCollision(vaultPath, vaultPath, collision, "commit_vault");
    return { committed: false, blockedReason: "code-repo-collision" };
  }

  // @decision 8d49c36c — key this check on the CONFIRMED governing root (vaultPath, at this point), never
  // a raw/possibly-nested caller argument; re-check again immediately before the commit call below; never
  // route this through killableCanonicalRaw (drops this module's own VAULT_GIT_SAFETY_CONFIG hook guard).
  const quarantineCheck = assertRepoNotQuarantined(vaultPath);
  if (!quarantineCheck.ok) {
    console.warn(`[vault-versioner] ${vaultPath} skipping commitVault — ${quarantineCheck.reason}`);
    return { committed: false };
  }

  // Every remaining call operates on a CONFIRMED root (vaultPath) — pin GIT_DIR/GIT_WORK_TREE to it.
  const { git: pinnedGit } = boundedVaultGitAtConfirmedRoot(vaultPath, { ...deps, timeoutMs: cheapTimeoutMs });
  const { git: workGit } = boundedVaultGitAtConfirmedRoot(vaultPath, { ...deps, timeoutMs: workTreeTimeoutMs });

  if (!isRepo) {
    // @decision 306dd105 — belt-and-suspenders: before `git init`, also probe the ENCLOSING dir from
    // OUTSIDE `vaultPath` and refuse init when it's itself inside a repo. See the decision record.
    // @decision 306dd105 (round 2) — this probe is ALSO message-classified (isNotAGitRepositoryError
    //  below); same locale pin as the discovery probe above, independently, not inherited from it.
    const parentDir = path.dirname(vaultPath);
    const { git: outsideGit } = boundedVaultGit(parentDir, { ...deps, timeoutMs: cheapTimeoutMs }, messageClassifiedProbeEnv());
    let enclosingRoot = "";
    try {
      enclosingRoot = (await withTimeout(
        outsideGit.revparse(["--show-toplevel"]),
        cheapTimeoutMs,
        "git rev-parse --show-toplevel (vault commit, outside-vault probe)",
      )).trim();
    } catch (e) {
      if (!isNotAGitRepositoryError(e)) {
        console.warn(
          `[vault-versioner] ${vaultPath} commitVault: outside-vault enclosing-repo probe failed (not a ` +
          `clean "not a git repository" result) — skipping this commit rather than risk initialising a ` +
          `nested repo: ${(e as Error)?.message ?? e}`,
        );
        return { committed: false };
      }
      // genuine "not a git repository" from OUTSIDE the vault dir too — safe to git init below.
    }
    if (enclosingRoot) {
      console.warn(
        `[vault-versioner] ${vaultPath} commitVault: refusing to git init — the enclosing directory ` +
        `${parentDir} is itself inside a git repository (${enclosingRoot}); skipping this commit rather ` +
        `than nest a repo inside it.`,
      );
      return { committed: false };
    }
    await withTimeout(pinnedGit.init(), cheapTimeoutMs, "git init (vault commit)");
  }

  // Tracks the call in flight so the warn below names WHICH op hit its bound (mirrors flushSync's own
  // `currentOp` tracking) — this is the section covering the actual named hang vector (add/status/commit).
  let currentOp: { label: string; timeoutMs: number } | undefined;
  const runCommitSequence = async (): Promise<CommitVaultResult> => {
    try {
      // @decision 8d49c36c — visibility only, never a refusal and never built further than a log line: this
      // module's own `git add .` can sweep pre-staged residue into an unattended commit exactly like
      // GitWriter.commit's `add -A` does, but nothing human reviews this path to warn structurally at.
      if (isRepo) {
        currentOp = { label: "git status (pre-add residue check)", timeoutMs: cheapTimeoutMs };
        const preAddStatus = await withTimeout(pinnedGit.status(), cheapTimeoutMs, currentOp.label);
        const preExistingResidue = preAddStatus.files
          .filter((f) => f.index !== " " && f.index !== "?")
          .map((f) => f.path);
        if (preExistingResidue.length > 0) {
          console.warn(
            `[vault-versioner] ${vaultPath} commitVault: ${preExistingResidue.length} file(s) were already ` +
            `staged before this auto-commit's own "git add ." ran and will be swept into it: ` +
            `${preExistingResidue.join(", ")} — possibly an escaped descendant's residue from an earlier ` +
            `quarantine (see git-writer.ts's commit() for the human-facing equivalent of this check).`,
          );
        }
      }
      // @decision a09b81a0 — round 4: the authoritative pause-lease check, placed HERE (inside
      // runCommitSequence, immediately before the mutating "git add .") rather than before the lock is
      // taken. See that decision record's "Round 4: the pause-lease check's placement" section.
      if (isVaultAutoCommitPaused(vaultPath)) {
        console.warn(`[vault-versioner] ${vaultPath} skipping commitVault — an advisory pause lease is held (card 614dfbef).`);
        return { committed: false, blockedReason: "paused" };
      }
      currentOp = { label: "git add .", timeoutMs: workTreeTimeoutMs };
      await withTimeout(workGit.add("."), workTreeTimeoutMs, currentOp.label);
      currentOp = { label: "git status", timeoutMs: cheapTimeoutMs };
      const status = await withTimeout(pinnedGit.status(), cheapTimeoutMs, currentOp.label);
      if (status.files.length === 0) return { committed: false };
      const skipped = await unstageOversizedFiles(pinnedGit, vaultPath, status.files, maxFileBytes, cheapTimeoutMs);
      // NOTE: an unstaged file does NOT disappear from `git status` (it just reverts to untracked/modified),
      // so re-querying status here would still see it and wrongly think there's something left to commit.
      // Comparing counts against the ORIGINAL staged set is the correct "anything real left?" check.
      if (skipped.length >= status.files.length) return { committed: false }; // everything staged was oversized — nothing left to commit
      currentOp = { label: "git commit", timeoutMs: workTreeTimeoutMs };
      // @decision ffe98495 — `--no-verify` on EVERY commit here, identity-fallback branch or not; belt-
      // and-suspenders on top of boundedVaultGit's hooksPath override (see that constant's own doc).
      const identityConfigured = await hasConfiguredGitIdentity(pinnedGit, cheapTimeoutMs);
      // @decision 8d49c36c — re-check right before the real commit call, AFTER hasConfiguredGitIdentity (its
      // own `git config` subprocesses can take ~15s and would otherwise widen the window this check closes).
      const recheck = assertRepoNotQuarantined(vaultPath);
      if (!recheck.ok) {
        console.warn(`[vault-versioner] ${vaultPath} skipping commitVault (quarantined mid-call, after add) — ${recheck.reason}`);
        return { committed: false };
      }
      if (identityConfigured) {
        await withTimeout(workGit.raw(["commit", "--no-verify", "-m", message]), workTreeTimeoutMs, currentOp.label);
      } else {
        await withTimeout(workGit.raw([
          "-c", `user.name=${FALLBACK_GIT_IDENTITY.name}`,
          "-c", `user.email=${FALLBACK_GIT_IDENTITY.email}`,
          "commit", "--no-verify", "-m", message,
        ]), workTreeTimeoutMs, currentOp.label);
      }
      return { committed: true };
    } catch (err) {
      // Closing the observability gap named above: before this fix a hung commit wedged the caller
      // forever with nothing in the logs; now it's bounded AND visible. Still rethrows — see this
      // function's own doc for why a bound expiry here stays a rejection rather than a swallowed `false`.
      console.warn(
        `[vault-versioner] ${vaultPath} commitVault's "${currentOp?.label}" call FAILED (bound ${currentOp?.timeoutMs}ms) — ` +
        `a real user edit may sit uncommitted until the next auto-commit tick: ${(err as Error)?.message ?? err}`,
      );
      throw err;
    }
  };
  // @decision a09b81a0 — round 3: take the SAME canonical index lock a real merge/GitWriter write for this
  // repo would, whenever merge-eligible (isCommitPathMergeEligible — see that function's own doc for a
  // known gap this does NOT close: a project bound to a no-.git subfolder of this root).
  //
  // `vaultPath` here is the CONFIRMED governing root (see above). `withCanonicalIndexLock` re-checks
  // quarantine itself (AFTER acquiring the lock, which the pre-check above cannot see) — translate that
  // into commitVault's own established graceful quarantine-backoff shape rather than letting a new throw
  // type escape this function.
  if (isCommitPathMergeEligible(vaultPath)) {
    try {
      return await withCanonicalIndexLock(vaultPath, runCommitSequence);
    } catch (err) {
      if (err instanceof RepoQuarantinedError) {
        console.warn(`[vault-versioner] ${vaultPath} skipping commitVault — ${err.message}`);
        return { committed: false };
      }
      throw err;
    }
  }
  return runCommitSequence();
}

/**
 * Resolve a project's `vaultPath` to the git context that GOVERNS its history. Three real layouts:
 *  - **No repo** → we own it: `commitPath` is the vault folder itself (we git-init + commit there).
 *  - **Plain git repo** (vault IS the repo root, OR a SUBFOLDER of a larger plain repo) → no real
 *    external auto-committer, so we keep per-edit history ourselves: `commitPath` is the DETECTED
 *    repo ROOT and we commit there. Keying to the root (not the subfolder) is what lets N project
 *    vaults that are sibling subfolders of ONE repo collapse to a single root watcher.
 *  - **Obsidian-Git-managed repo** → a real external auto-committer already owns history, so we
 *    BACK OFF (`externallyManaged: true`) to avoid double-committing.
 *
 * @decision 509716cc — never detect Obsidian-Git management by "subfolder ≠ root" — that backs off for
 *  every subfolder of any plain repo, not just an Obsidian-Git-managed one. The `.obsidian/plugins/
 *  obsidian-git` marker is deterministic and cheap (one fs.existsSync); use that instead.
 */
async function resolveVaultRepoContext(
  vaultPath: string,
  deps: VaultGitDeps = {},
): Promise<{ commitPath: string; externallyManaged: boolean }> {
  const { git, timeoutMs } = boundedVaultGit(vaultPath, deps);
  const isRepo = await withTimeout(git.checkIsRepo(), timeoutMs, "git check-is-repo (vault resolve)").catch(() => false);
  if (!isRepo) return { commitPath: vaultPath, externallyManaged: false }; // no repo → we git-init it
  const root = (await withTimeout(git.revparse(["--show-toplevel"]), timeoutMs, "git rev-parse --show-toplevel (vault resolve)").catch(() => "")).trim();
  if (!root) return { commitPath: vaultPath, externallyManaged: false };
  const commitPath = path.resolve(root);
  // Obsidian-Git-managed → a real external auto-committer owns history; back off (no double-commit).
  const obsidianGitMarker = path.join(commitPath, ".obsidian", "plugins", "obsidian-git");
  return { commitPath, externallyManaged: fs.existsSync(obsidianGitMarker) };
}

export type VaultGitTargetResult =
  | { ok: true; repoPath: string }
  | { ok: false; reason: "no-vault" | "no-repo" | "externally-managed" | "operational-dir" };

/**
 * Resolve a project's vault to the git repo a WRITE lever (the companion `git-push` capability) may
 * commit/push to — reusing `resolveVaultRepoContext` (the SAME resolution the auto-committer itself
 * uses, so a companion push can never disagree with what Loom already considers "the vault's repo": a
 * vault may be a subfolder of a larger repo, and sibling project vaults can share ONE governing root —
 * see `startVaultVersioners`'s own dedupe-by-root doc). Read-only — never mutates, never `git init`s.
 *
 * Unlike `resolveVaultRepoContext` (whose caller git-inits a bare vault folder itself), this checks
 * whether the resolved `commitPath` is ACTUALLY a repo yet and REFUSES (`"no-repo"`) if not — a
 * companion-facing write lever must never silently create a new git repository on the host on the
 * owner's behalf; that host-write is out of scope for "commit to an EXISTING repo." Also refuses
 * (`"externally-managed"`) when the resolved repo is Obsidian-Git-managed — a real external
 * auto-committer already owns that history, mirroring `VaultVersioner`'s own backoff.
 *
 * @decision f9360c84 — also refuses (`"operational-dir"`) on `vaultPath` OR its resolved governing root
 * (reused `isOperationalVaultDir`) — checked on the raw path first, before any git call, matching
 * `startVaultVersioners`'s own dual check.
 */
export async function resolveVaultGitTarget(vaultPath: string, deps: VaultGitDeps = {}): Promise<VaultGitTargetResult> {
  const trimmed = vaultPath?.trim();
  if (!trimmed) return { ok: false, reason: "no-vault" };
  if (isOperationalVaultDir(trimmed)) return { ok: false, reason: "operational-dir" };
  const ctx = await resolveVaultRepoContext(trimmed, deps);
  if (isOperationalVaultDir(ctx.commitPath)) return { ok: false, reason: "operational-dir" };
  if (ctx.externallyManaged) return { ok: false, reason: "externally-managed" };
  const { git, timeoutMs } = boundedVaultGit(ctx.commitPath, deps);
  const isRepo = await withTimeout(git.checkIsRepo(), timeoutMs, "git check-is-repo (vault git target)").catch(() => false);
  if (!isRepo) return { ok: false, reason: "no-repo" };
  return { ok: true, repoPath: ctx.commitPath };
}

/** Default advisory pause duration (10 min) — enough for a typical git-surgery sequence (untrack files,
 *  rewrite `.gitignore`, verify) without leaving a forgotten lease active indefinitely. */
const DEFAULT_VAULT_PAUSE_MS = 10 * 60_000;
/** Hard ceiling on any requested pause — the lease is meant to be SHORT-LIVED (card 614dfbef); clamping a
 *  mistaken huge duration keeps a caller from silencing auto-commit for good. */
const MAX_VAULT_PAUSE_MS = 30 * 60_000;

const PAUSE_LEASE_FILENAME = "loom-vault-pause.json";

/**
 * Resolve the REAL git dir for `commitPath` — `.git` itself when it's a plain directory (the ordinary
 * case), or the private gitdir a linked WORKTREE's `.git` FILE points at (`gitdir: <path>`). Returns
 * `null` when `commitPath` isn't a git repo at all (no `.git` of either shape): there is no lease to
 * write or read, so the caller must skip it rather than create a nested `.git` directory that would
 * make a non-repo path look like a repo to `isGitRepo`-style checks and worktree cleanup (card 40dd6b62).
 * Never creates anything — pure resolution. DELIBERATELY NOT `git/repo-lock.ts`'s `resolveGitDirsSync`
 * (card 25389c3c): a pause lease is scoped to THIS checkout's own `privateDir`, never indirected through a
 * linked worktree's `commonDir` — the lease must not leak across worktrees sharing one common git dir.
 *
 * Resolves `commitPath` to its git TOPLEVEL first (`resolveGitToplevelSync`, shared with
 * `canonicalRepoLockKey`), rather than statting `<commitPath>/.git` directly: a GitWriter op's own
 * `pauseVaultAutoCommit(this.repoPath)` passes the project's BOUND path, which for a subdir-bound project
 * (no `.git` of its own) used to resolve to nothing here — the pause silently no-opped — while
 * `VaultVersioner`'s own tick checks the lease at the resolved TOPLEVEL root. Walking up first means both
 * sides land on the SAME `.git`.
 *
 * KNOWN, ACCEPTED TRADEOFF: `commitPath` need not itself be inside any repo at all — if it happens to sit
 * nested under some UNRELATED ancestor directory that IS a git repo (a dotfiles-managed home directory, an
 * accidental `git init` somewhere up the tree), this now resolves to THAT ancestor's `.git` instead of
 * `null`, and a pause lease can land in a repo that has nothing to do with this vault. Not guarded against:
 * distinguishing "the intended enclosing repo" from "a coincidental unrelated ancestor" isn't resolvable
 * from filesystem structure alone, and the failure mode is a harmless stray lease FILE in that repo's own
 * `.git` — never a corruption of its history. The case this function exists for — a subdir genuinely
 * inside the SAME physical repo as its vault's toplevel — is unaffected.
 *
 * @decision 7673d096 — never stat `<commitPath>/.git` directly here again; always resolve the toplevel
 * first, or this function silently no-ops for a subdir-bound repoPath.
 *
 * **Exported (card 227d9f0b round 2)** so {@link detectStaleVaultLock}/{@link maybeAlertStaleVaultLock}
 * reuse this SAME gitfile-aware resolution for the stale-lock path + its dedupe marker, rather than a
 * second, worktree-blind `path.join(commitPath, ".git", …)` — see those functions' own docs.
 */
export function resolveLeaseGitDir(commitPath: string): string | null {
  const toplevel = resolveGitToplevelSync(commitPath);
  const gitPath = path.join(toplevel, ".git");
  let stat: fs.Stats;
  try { stat = fs.statSync(gitPath); } catch { return null; } // no .git at all — not a repo, nothing to pause
  if (stat.isDirectory()) return gitPath;
  // Linked worktree: .git is a FILE containing `gitdir: <path>` — resolve to that real private gitdir
  // rather than mkdirSync-ing over the file itself (which would throw).
  let pointer: string;
  try { pointer = fs.readFileSync(gitPath, "utf8"); } catch { return null; }
  const m = pointer.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m || !m[1]) return null; // not the worktree .git file shape we expect
  const privateDir = path.resolve(toplevel, m[1]);
  return fs.existsSync(privateDir) ? privateDir : null;
}

/** Lease path for an already-resolved real git dir — inside `.git/` (or a linked worktree's private
 *  gitdir), so (a) chokidar's own ignore pattern (`(^|[/\\])\.git([/\\]|$)`, see `start()` below) means
 *  writing/removing it never itself triggers a spurious auto-commit cycle, and (b) it is never
 *  git-tracked (can't land in vault history). Takes the resolved git dir, never `commitPath` directly —
 *  see {@link resolveLeaseGitDir}. */
function pauseLeasePath(gitDir: string): string {
  return path.join(gitDir, PAUSE_LEASE_FILENAME);
}

/** Opaque per-op handle returned by {@link pauseVaultAutoCommit} — pass it back to
 *  {@link resumeVaultAutoCommit} so a resume only ever clears the lease IT holds. */
export type VaultPauseToken = string;

/** @decision 614dfbef — never treat this as a real lock — it only stops VaultVersioner's own commit tick;
 *  nothing else is blocked from touching the repo. Never let a caller request an unbounded pause; clamp
 *  to MAX_VAULT_PAUSE_MS so a mistaken huge duration can't silence auto-commit for good.
 * @decision 237d1899 — never resolve a resume by bare presence of the lease file — always check the
 *  token, or op A's `finally` can clear a lease a different, still-running op B re-paused concurrently. */
export function pauseVaultAutoCommit(commitPath: string, durationMs = DEFAULT_VAULT_PAUSE_MS): VaultPauseToken {
  const clamped = Math.max(0, Math.min(durationMs, MAX_VAULT_PAUSE_MS));
  const token = randomUUID();
  try {
    const gitDir = resolveLeaseGitDir(commitPath);
    // No git dir at all → nothing to pause; never create one just to hold the lease (card 40dd6b62).
    if (gitDir) fs.writeFileSync(pauseLeasePath(gitDir), JSON.stringify({ until: Date.now() + clamped, token }));
  } catch { /* best-effort — never throws into the caller's git-surgery flow */ }
  return token;
}

/**
 * End an advisory pause early (the surgery finished before the lease would have expired anyway).
 *
 * **Resume-only-if-mine (card 237d1899):** when `token` is passed, the lease is removed ONLY if it still
 * carries that exact token — so op A's `finally` can never delete a lease op B re-paused (with a NEW
 * token) while A was still running; B's protection survives until B itself resumes (or the lease's own
 * TTL expires). `token` is OPTIONAL for back-compat with a caller that never re-paused mid-op (there's
 * only ever one lease to clear) and with direct test setup; every real GitWriter op always passes the
 * token `pauseVaultAutoCommit` gave it. A missing/unreadable/mismatched lease is a harmless no-op either
 * way — best-effort: never throws.
 */
export function resumeVaultAutoCommit(commitPath: string, token?: VaultPauseToken): void {
  try {
    const gitDir = resolveLeaseGitDir(commitPath);
    if (!gitDir) return; // no git dir — nothing was ever paused here
    const p = pauseLeasePath(gitDir);
    if (token !== undefined) {
      const current = JSON.parse(fs.readFileSync(p, "utf8")) as { token?: string };
      if (current?.token !== token) return; // a newer op's lease — not mine to remove
    }
    fs.rmSync(p);
  } catch { /* no lease, unreadable, or already gone — fine */ }
}

/** Whether an unexpired pause lease exists for `commitPath`. A missing, unreadable, malformed, or expired
 *  lease all read as "not paused" — fail-open toward committing rather than getting silently stuck paused
 *  forever on a corrupt lease file. */
function isVaultAutoCommitPaused(commitPath: string): boolean {
  try {
    const gitDir = resolveLeaseGitDir(commitPath);
    if (!gitDir) return false;
    const raw = JSON.parse(fs.readFileSync(pauseLeasePath(gitDir), "utf8"));
    return typeof raw?.until === "number" && Date.now() < raw.until;
  } catch { return false; }
}

/**
 * Auto-commits a project's vault so doc rewrites are never truly lost (§7). Debounces writes and commits
 * at idle. Resolves the vault to its GOVERNING repo root (see `resolveVaultRepoContext`) and watches +
 * commits THERE — so a vault that is a subfolder of a plain repo gets per-edit history at the repo root,
 * while a vault folder that is its own repo root (or has no repo) is watched/committed in place. Backs
 * off ONLY for an Obsidian-Git-managed repo (a real external auto-committer owns its history).
 *
 * @decision f48ee77d — never add a push call anywhere in this versioner — pushing is a HUMAN-only trust
 *  boundary in Loom (git/writer.ts's GitWriter.push()), and this runs unattended off any filesystem event.
 *  Surface an unpushed backlog via checkVaultPushStatus/VaultPushStatusWatcher, never by pushing automatically.
 */
/** Above this many watched entries, `start()` logs a one-time visibility warning (card 39ceb732 Lever 4) —
 *  see {@link VaultVersioner.warnIfLarge}. Not a cap: nothing is skipped or throttled at this size. */
const LARGE_VAULT_WATCH_WARN_THRESHOLD = 20_000;

/**
 * Default bound for {@link VaultVersioner.whenReady} (card 86b41129). Chokidar's initial scan is a
 * readdir walk, not a git op, so this doesn't need to be in {@link VAULT_GIT_OP_TIMEOUT_MS}'s league —
 * but a vault at or above {@link LARGE_VAULT_WATCH_WARN_THRESHOLD} entries still does real, uncapped I/O
 * per entry, so this leaves real headroom above a small/typical vault's sub-second scan. Test-only
 * override via the constructor (same shape as `watchWarnThreshold`/`gitDeps`) — real callers never pass one.
 */
const WHEN_READY_TIMEOUT_MS = 60_000;

export class VaultVersioner {
  private git: BoundedVaultGit;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private externallyManaged = false;
  /** The folder we actually watch + commit — the governing repo ROOT, resolved in `start()`. */
  private commitPath: string;
  /** Resolves once chokidar's initial scan completes ("ready") — see {@link whenReady}. Never rejects
   *  (see `start()`'s "error" listener doc) — a pre-ready error is tracked separately via
   *  {@link preReadyError} so a rejected-and-unobserved promise can never trigger an unhandled rejection
   *  in production, where nothing calls {@link whenReady}. */
  private readyPromise?: Promise<void>;
  /** Set true the instant chokidar's real "ready" fires — lets {@link preReadyError} distinguish "this
   *  error happened before we were ready" from "this happened after, and doesn't matter to whenReady()". */
  private ready = false;
  /** The most recent watcher "error" seen BEFORE `ready` flipped true, if any — see {@link whenReady}. */
  private preReadyError?: Error;
  /** The matcher passed to chokidar as `ignored` — retained so {@link hasUnexcludedTopLevelEntry} can
   *  reuse it (never a second, possibly-divergent copy of the exclusion logic). */
  private matcher?: (p: string) => boolean;

  constructor(
    private vaultPath: string,
    private debounceMs = 5000,
    /** Test-only override for {@link LARGE_VAULT_WATCH_WARN_THRESHOLD} — real callers never pass this
     *  (same override-for-testability shape as `commitVault`'s `opts.maxFileBytes`; a real threshold this
     *  large would need a slow, wasteful real fixture to exercise the warning path at all). */
    private watchWarnThreshold = LARGE_VAULT_WATCH_WARN_THRESHOLD,
    /** Test-only bounded-git injection seam (card 509716cc) — real callers never pass this; see
     *  {@link VaultGitDeps}. */
    private gitDeps: VaultGitDeps = {},
    /** Test-only override for {@link WHEN_READY_TIMEOUT_MS} (card 86b41129) — real callers never pass
     *  this; lets a test force {@link whenReady}'s bound down to milliseconds instead of waiting out a
     *  real 60s timeout to prove the timeout path names its failure. */
    private whenReadyTimeoutMs = WHEN_READY_TIMEOUT_MS,
    /** Card 227d9f0b — optional: lets `commit()`/`flushSync()` file a durable, owner-visible
     *  `vault_index_lock_stale` event when they detect a stale `.git/index.lock` (see
     *  `maybeAlertStaleVaultLock`). Appended at the tail so every pre-existing positional test
     *  construction stays byte-identical; absent in all of them, so the alert path is a silent no-op
     *  there — never required for correctness. */
    private lockAlert?: { db?: Pick<Db, "appendEvent">; projectId?: string },
  ) {
    this.commitPath = vaultPath;
    this.git = boundedVaultGit(vaultPath, gitDeps).git;
  }

  /** The resolved governing repo root this instance watches + commits (valid after `start()`). */
  get commitRoot(): string {
    return this.commitPath;
  }

  /** The project id this instance's lock-alert events are stamped with, if any (card 227d9f0b) — read
   *  by `startVaultVersioners`' own caller to wire `VaultPushStatusWatcher`'s proactive check per path. */
  get projectId(): string | undefined {
    return this.lockAlert?.projectId;
  }

  async start(): Promise<void> {
    const ctx = await resolveVaultRepoContext(this.vaultPath, this.gitDeps);
    this.commitPath = ctx.commitPath;
    this.externallyManaged = ctx.externallyManaged;
    const { git, timeoutMs } = boundedVaultGit(this.commitPath, this.gitDeps);
    this.git = git;
    if (!this.externallyManaged) {
      // git-init a bare vault folder that has no repo (resolveVaultRepoContext leaves commitPath as the
      // vault folder in that case). A real repo (own root / plain-repo root) already exists — no-op.
      // Bounded (card 509716cc): this is the boot-awaited path (startVaultVersioners → index.ts, ahead
      // of sessions.resumeFleetOnBoot) — a hung checkIsRepo degrades to "not a repo" (same as the
      // pre-existing .catch(() => false)) rather than wedging the whole daemon's post-restart fleet
      // resume.
      const isRepo = await withTimeout(this.git.checkIsRepo(), timeoutMs, "git check-is-repo (vault start)").catch(() => false);
      if (!isRepo) await withTimeout(this.git.init(), timeoutMs, "git init (vault start)");
    }
    const safeNames = await safeToExcludeNames(this.commitPath, this.git, timeoutMs);
    this.matcher = buildIgnoredMatcher(this.commitPath, safeNames);
    this.watcher = chokidar.watch(this.commitPath, {
      ignoreInitial: true,
      ignored: this.matcher,
      // sessions/liveness.ts:36-43 records a chokidar EPERM taking the whole daemon down on 2026-06-16 —
      // its fix was "never rethrow, swallow and continue"; ignorePermissionErrors:true goes one step
      // earlier and stops chokidar from even EMITTING "error" for the common EPERM/EACCES transient-race
      // class in the first place (e.g. a short-lived temp dir vanishing mid-stat), rather than relying
      // solely on the "error" listener below to catch it after the fact. Also makes chokidar's own
      // _hasReadPermissions() return true unconditionally (chokidar 4.0.3 index.js:674-676), so the
      // watcher now ATTEMPTS entries it previously skipped on permission grounds — a small INCREASE in
      // watched-entry count, the opposite direction from this file's exclusion logic; verified this can
      // only ever push the count UP, never down, so it cannot mask the zero-entries tripwire below.
      ignorePermissionErrors: true,
    });
    // Resolves ONLY on "ready" — deliberately does NOT reject on "error". Matching liveness.ts's
    // established doctrine: a chokidar error is swallow-and-log, never rethrown. An earlier version of
    // this rejected readyPromise on ANY pre-ready error, which is unsafe in exactly the way that doctrine
    // exists to prevent — a single transient, often-recoverable error (chokidar frequently still reaches
    // "ready" afterward) would otherwise turn into an unhandled-rejection risk for any caller (a test, or
    // a future consumer) that awaits whenReady() without its own try/catch.
    this.readyPromise = new Promise((resolve) => { this.watcher!.once("ready", () => { this.ready = true; resolve(); }); });
    this.watcher.on("all", () => this.schedule());
    this.watcher.on("ready", () => this.warnIfLarge());
    this.watcher.on("error", (err) => {
      const e = err as Error;
      if (!this.ready) this.preReadyError = e;
      console.warn(`[vault-versioner] ${this.commitPath} watcher error (ignored, watcher continues): ${e?.message ?? err}`);
    });
  }

  /**
   * Resolves once the watcher's initial filesystem scan completes (chokidar's own "ready" event). A no-op
   * (resolves immediately) if `start()` hasn't been called. Exposed for callers/tests that need to anchor
   * on this OBSERVABLE event rather than a fixed wait.
   *
   * @decision 86b41129 — never make this rejection depend on the shared `readyPromise` (it never rejects
   *  — swallow-and-log, per `sessions/liveness.ts`); own a bounded timeout and NAME why a pre-ready
   *  failure happened, rather than leaving it indistinguishable from "still scanning".
   *
   *   1. A watcher error already seen before `ready` fired (checked at call time) rejects immediately,
   *      naming that error.
   *   2. A watcher error that arrives WHILE this call is waiting rejects immediately, same message shape —
   *      by construction this means a rejection is NEVER anonymous: any pre-ready error is always caught
   *      by (1) or (2) before {@link whenReadyTimeoutMs} could ever elapse with one outstanding.
   *   3. Neither `ready` nor an error ever arrives (e.g. `ignorePermissionErrors:true` fully swallows the
   *      failure with no "error" event at all, or the scan is simply still running) — this rejects once
   *      {@link whenReadyTimeoutMs} elapses, naming the bound that was exceeded. Either way this is a real
   *      `Error` a caller can inspect, never `undefined`/an anonymous test-harness timeout.
   */
  async whenReady(): Promise<void> {
    if (!this.readyPromise || this.ready) return;
    if (this.preReadyError) {
      throw new Error(`vault watcher for ${this.commitPath} failed before becoming ready: ${this.preReadyError.message}`);
    }
    const readyPromise = this.readyPromise;
    const watcher = this.watcher;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        watcher?.off("error", onError);
      };
      const onError = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`vault watcher for ${this.commitPath} failed before becoming ready: ${(err as Error)?.message ?? err}`));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`vault watcher for ${this.commitPath} did not become ready within ${this.whenReadyTimeoutMs}ms`));
      }, this.whenReadyTimeoutMs);
      watcher?.once("error", onError);
      readyPromise.then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      });
    });
  }

  /**
   * Total tracked entries (files + dirs) the live watcher holds an OS handle for — the SAME method card
   * a0c62330 used to measure this (`watcher.getWatched()`, summed): confirmed there to be ~1:1 with both
   * `process.getActiveResourcesInfo()`'s `FSEventWrap` count and the OS handle count. `undefined` before
   * `start()` resolves (or once `stop()` has closed the watcher) — never a stale/wrong number.
   */
  get watchedEntryCount(): number | undefined {
    if (!this.watcher) return undefined;
    return Object.values(this.watcher.getWatched()).reduce((sum, names) => sum + names.length, 0);
  }

  /** Test/diagnostic-only: the raw chokidar `getWatched()` snapshot (dir path → tracked child basenames),
   *  for a caller that needs to assert precisely WHICH entries are (or are not) tracked, not just the
   *  aggregate count. `undefined` before `start()`/after `stop()`. */
  get watchedSnapshot(): Record<string, string[]> | undefined {
    return this.watcher?.getWatched();
  }

  /**
   * @decision 39ceb732 — this is Lever 4: never change what gets watched or committed to control the
   *  handle cost, only log once when the initial scan completes if the entry count is unusually large —
   *  making the uncapped-handle cost visible instead of silent.
   * @decision 687d2a47 — never treat this zero-entry warning's silence as proof the watcher is healthy —
   *  an OVER-BROAD matcher (excludes every top-level name) silences it too, because {@link
   *  hasUnexcludedTopLevelEntry} reuses that same matcher; it is not a backstop against that failure class.
   */
  private warnIfLarge(): void {
    try {
      const count = this.watchedEntryCount;
      if (count === 0) {
        if (this.hasUnexcludedTopLevelEntry()) {
          console.warn(
            `[vault-versioner] ${this.commitPath} is watching ZERO entries despite having real, ` +
            `non-excluded top-level content — this is almost certainly a dead watcher, not an empty vault. ` +
            `Auto-commit for this vault is effectively disabled until this is investigated.`,
          );
        }
      } else if (count !== undefined && count > this.watchWarnThreshold) {
        console.warn(
          `[vault-versioner] ${this.commitPath} is watching ${count} entries (> ${this.watchWarnThreshold}) — ` +
          `chokidar opens one OS file handle per entry with no cap, so this is a real, uncapped memory/handle ` +
          `cost that scales with vault size. A subfolder this repo's own .gitignore already excludes is also ` +
          `excluded from being watched automatically — see this file's gitignoredTopLevelNames/` +
          `safeToExcludeNames for exactly what qualifies (git-TRACKED content under a gitignored name is ` +
          `deliberately still watched, so this never silently stops version history for real content).`,
        );
      }
    } catch { /* best-effort — never let a diagnostic log break watcher startup */ }
  }

  /** Whether `commitPath`'s own top-level directory listing has at least one entry `this.matcher` does NOT
   *  exclude — used only to discriminate "legitimately empty vault" from "dead watcher" in {@link
   *  warnIfLarge}'s zero-entry branch. An unreadable directory (edge case, shouldn't happen once `start()`
   *  has already succeeded) reads as "nothing to warn about" — fail toward silence, not a spurious alarm. */
  private hasUnexcludedTopLevelEntry(): boolean {
    if (!this.matcher) return false;
    try {
      return fs.readdirSync(this.commitPath).some((name) => !this.matcher!(path.join(this.commitPath, name)));
    } catch {
      return false;
    }
  }

  private schedule(): void {
    if (this.externallyManaged) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.commit(), this.debounceMs);
  }

  private async commit(): Promise<void> {
    // An agent doing sanctioned git surgery holds an advisory pause lease — sit this tick out rather than
    // race its staged changes (card 614dfbef). The debounce timer already fired; we simply skip the
    // commit itself. A future filesystem event (or the next `schedule()`) will retry once the lease lifts.
    if (isVaultAutoCommitPaused(this.commitPath)) return;
    // Route through the shared commit path (at the resolved repo root) so UI writes and auto-commits
    // stay consistent. commitVault re-confirms root === commitPath, so it commits (not backs off) here.
    try { await commitVault(this.commitPath, `loom: auto-commit ${new Date().toISOString()}`); }
    catch (err) {
      // Card 227d9f0b — a stale .git/index.lock surfaces as an ordinary commitVault throw here; detect
      // + (at most once per lock instance) file the owner-visible alert before swallowing it as before.
      maybeAlertStaleVaultLock(this.commitPath, this.lockAlert ?? {}, err);
    }
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    // Clear the reference (not just close()) so watchedEntryCount/watchedSnapshot's documented
    // "undefined after stop()" is actually true — chokidar's close() doesn't null out getWatched()'s
    // result, it empties it, so leaving `this.watcher` set would make those getters silently return
    // 0/{} instead, indistinguishable from "watching zero entries" rather than "not watching at all".
    this.watcher = undefined;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * SYNCHRONOUS final flush for graceful shutdown. `gracefulShutdown` (index.ts) is synchronous and
   * ends in `process.exit(0)` immediately, so the async, debounced `commit()` above would NOT complete
   * before exit — an edit made inside the 5s debounce window would be silently dropped. This stages and
   * commits any pending on-disk changes (at the resolved repo root `commitPath`) with `execSync` so the
   * commit lands BEFORE the process exits. Honors the cached `externallyManaged` backoff (skip — an
   * Obsidian-Git-managed repo owns its own history) and is a no-op when nothing is staged. Best-effort:
   * never throws. Returns true iff it committed. Mirrors the shared `commitVault` semantics, but
   * synchronous by necessity. Also honors the advisory pause lease (card 614dfbef) — a shutdown mid
   * sanctioned git surgery must not force a commit the lease was meant to prevent.
   *
   * @decision 816f0056 — never assert whether a timed-out `git commit`'s object lands — it's a genuine
   *  race; this only bounds how long flushSync waits, never what git does afterward. Never interpolate
   *  FALLBACK_GIT_IDENTITY into a shell-string execSync call — use execFileSync with real args instead.
   */
  flushSync(): boolean {
    if (this.externallyManaged) return false;
    if (isVaultAutoCommitPaused(this.commitPath)) return false;
    // @decision a09b81a0 — re-check live on every flush (never cache): a project rebound onto this
    // commitPath AFTER start() must still be caught at shutdown, not just at boot.
    const collision = checkCodeRepoCollision(this.commitPath);
    if (collision) {
      refuseCodeRepoCollision(this.commitPath, this.commitPath, collision, "flush_sync");
      return false;
    }
    // @decision 8d49c36c — `this.commitPath` is already the resolved governing root (set in `start()`);
    // one check suffices here (unlike commitVault's add/commit split) since this is one synchronous burst.
    const quarantineCheck = assertRepoNotQuarantined(this.commitPath);
    if (!quarantineCheck.ok) {
      console.warn(`[vault-versioner] ${this.commitPath} skipping shutdown flush — ${quarantineCheck.reason}`);
      return false;
    }
    // @decision a09b81a0 — round 3: deliberately NOT wrapped in withCanonicalIndexLock, unlike commitVault's
    // own add+commit sequence — see below for why.
    //
    // That lock is async; this method is synchronous by necessity (shutdown, execSync — see this method's
    // own doc) and cannot await it without reopening the exact process-exits-before-the-async-commit-
    // finishes gap flushSync exists to close. A merge landing on the SAME repo in the narrow shutdown
    // window this runs in is a known, accepted residual risk — same judgment as d671f1b8's own documented
    // lock-contention trade-off for this method.
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    // Tracks the call currently in flight so the `catch` below can name WHICH op timed out and at what
    // bound (card 816f0056 review round 2, finding 5) — `execSync`'s own timeout error just names the
    // shell (`spawnSync ... cmd.exe ETIMEDOUT`), not the git command or the ceiling that fired.
    let currentOp: { label: string; timeoutMs: number } | undefined;
    try {
      // @decision ffe98495 — pin GIT_DIR/GIT_WORK_TREE here too: `this.commitPath` is already the
      // CONFIRMED governing root (resolved once, at `start()`), so — unlike `commitVault`'s own discovery
      // step — there is no "might still be a subfolder" case left to preserve upward search for.
      const env = localReadGitEnv(process.env, {
        GIT_TERMINAL_PROMPT: "0",
        GIT_DIR: path.join(this.commitPath, ".git"), GIT_WORK_TREE: this.commitPath,
      });
      // Built via localReadGitEnv (the same helper boundedVaultGitAtConfirmedRoot uses for its own
      // pinned env), not a raw {...process.env} spread, so this path strips the same ambient
      // transport-env family instead of carrying an independent copy (card 306dd105 NITPICK-2).
      const cheapTimeoutMs = this.gitDeps.timeoutMs ?? VAULT_GIT_OP_TIMEOUT_MS;
      // flushAddTimeoutMs/flushCommitTimeoutMs (test-only, see VaultGitDeps) each fall back to the shared
      // `timeoutMs` override, then to the real production default — see VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS.
      const addTimeoutMs = this.gitDeps.flushAddTimeoutMs ?? this.gitDeps.timeoutMs ?? VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS;
      const commitTimeoutMs = this.gitDeps.flushCommitTimeoutMs ?? this.gitDeps.timeoutMs ?? VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS;
      const cheapOpts = { cwd: this.commitPath, stdio: "pipe" as const, timeout: cheapTimeoutMs, env, maxBuffer: VAULT_FLUSH_MAX_BUFFER_BYTES };
      const addOpts = { cwd: this.commitPath, stdio: "pipe" as const, timeout: addTimeoutMs, env, maxBuffer: VAULT_FLUSH_MAX_BUFFER_BYTES };
      const commitOpts = { cwd: this.commitPath, stdio: "pipe" as const, timeout: commitTimeoutMs, env, maxBuffer: VAULT_FLUSH_MAX_BUFFER_BYTES };
      // Test-only override (see VaultGitDeps.flushExecFileSyncImpl's own doc) — real callers never set
      // this, so production always calls the real execFileSync.
      const runGit = this.gitDeps.flushExecFileSyncImpl ?? execFileSync;

      // @decision ffe98495 — never move `add`/`status` back to shell-string `execSync`: `VAULT_GIT_SAFETY_ARGS`
      //  interpolates a real path into these calls, so they need the same execFileSync argument-safety
      //  `commit`'s own doc below already claims for itself.
      currentOp = { label: "git add -A", timeoutMs: addTimeoutMs };
      runGit("git", [...VAULT_GIT_SAFETY_ARGS, "add", "-A"], addOpts);
      currentOp = { label: "git status --porcelain", timeoutMs: cheapTimeoutMs };
      const staged = runGit("git", [...VAULT_GIT_SAFETY_ARGS, "status", "--porcelain"], cheapOpts).toString().trim();
      if (!staged) return false; // nothing to commit — no-op
      const message = `loom: auto-commit ${new Date().toISOString()} (shutdown flush)`;
      currentOp = { label: "git commit", timeoutMs: commitTimeoutMs };
      // execFileSync, not execSync (card 816f0056 review round 3): the identity-fallback branch
      // interpolates FALLBACK_GIT_IDENTITY into the command — safe TODAY only because that constant
      // happens to contain no spaces/shell metacharacters. A future edit to it (e.g. "Loom Daemon") would
      // silently break the shell-string form (`-c user.name=Loom Daemon` splits at the space, git sees a
      // stray `Daemon` argument, the commit fails) and land in the catch below as a SILENTLY DROPPED
      // shutdown commit — the exact failure class this card exists to close, reopened one constant edit
      // away. execFileSync passes each argument as a real array element, with no shell parsing at all, so
      // this is genuinely argument-safe rather than safe-by-coincidence — real ARGS, matching what this
      // doc's "Identity fallback" paragraph below claims.
      // @decision ffe98495 — `--no-verify` PLUS the hooksPath/fsmonitor overrides on every branch here.
      if (hasConfiguredGitIdentitySync(cheapOpts)) {
        runGit("git", [...VAULT_GIT_SAFETY_ARGS, "commit", "--no-verify", "-m", message], commitOpts);
      } else {
        runGit(
          "git",
          [...VAULT_GIT_SAFETY_ARGS, "-c", `user.name=${FALLBACK_GIT_IDENTITY.name}`, "-c", `user.email=${FALLBACK_GIT_IDENTITY.email}`, "commit", "--no-verify", "-m", message],
          commitOpts,
        );
      }
      return true;
    } catch (err) {
      // best-effort — a missing identity / no-repo / plain git error, OR a bound timeout (execSync
      // throws on timeout expiry, see the doc above) — must never block exit. Card 816f0056 follow-up:
      // this used to be silent, indistinguishable from the benign early-return no-ops above (paused /
      // externally-managed / nothing staged) — but a bound timeout on the WORKING-TREE-SCALE calls can
      // now drop a real, still-in-progress commit here, which is the one cause that represents actual
      // user data not reaching git. One warn line, no restructuring, still never throws.
      const timeoutHit = (err as NodeJS.ErrnoException)?.code === "ETIMEDOUT" && currentOp;
      const detail = timeoutHit
        ? `the "${currentOp!.label}" call exceeded its ~${currentOp!.timeoutMs}ms bound (hung git child? — see this method's own doc for exactly what survives the kill and what doesn't)`
        : ((err as Error)?.message ?? String(err));
      console.warn(`[vault-versioner] ${this.commitPath} shutdown flush FAILED — a pending commit may have been dropped: ${detail}`);
      // Card 227d9f0b — the orphan this timeout abandoned may be exactly what's holding the lock; detect
      // + (at most once per lock instance) file the owner-visible alert.
      maybeAlertStaleVaultLock(this.commitPath, this.lockAlert ?? {}, err);
      return false;
    }
  }
}

const PUSH_OUTCOME_FILENAME = "loom-push-outcome.json";

/** Outcome-record path for a repo root — inside `.git/`, same storage convention as the pause lease
 *  above (chokidar-ignored, never git-tracked). Generic over ANY repo `GitWriter` writes to, not just a
 *  vault's governing root — see `recordGitPushOutcome`'s doc for why. */
function pushOutcomePath(repoPath: string): string {
  return path.join(repoPath, ".git", PUSH_OUTCOME_FILENAME);
}

/**
 * Durably record the outcome of an ACTUAL push attempt against `repoPath` (card 614dfbef, origin finding
 * 4ae8a3c9 — "today only an agent doing forensics finds out the remote is rejecting"). The versioner
 * itself never pushes (see the `VaultVersioner` doc above), so this is called from the ONE real
 * chokepoint that does: `GitWriter.push()` (git/writer.ts), reached from the human REST git-write
 * surface, the Platform MCP, and the companion `git-push` capability alike — a single added call there
 * covers every pusher. `repoPath` may be a vault's governing root OR an ordinary project code repo
 * (`GitWriter` doesn't know which); recording is harmless either way — only `checkVaultPushStatus` below
 * ever reads it back, and only for repo roots it already watches. Survives a daemon restart (a plain file
 * under `.git/`). Always overwrites with the LATEST outcome only (no history) so a subsequent successful
 * push cleanly clears a prior failure. Best-effort: never throws into the pusher's own flow.
 */
export function recordGitPushOutcome(repoPath: string, outcome: { ok: true } | { ok: false; error: string }): void {
  try {
    const rec = outcome.ok
      ? { ok: true, at: new Date().toISOString() }
      : { ok: false, at: new Date().toISOString(), error: outcome.error };
    const p = pushOutcomePath(repoPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(rec));
  } catch { /* best-effort — never throws into the pusher's own flow */ }
}

/** The most recently recorded push outcome for `repoPath`, iff it was a FAILURE. `null` when the last
 *  recorded outcome was a success, or nothing was ever recorded (fresh install, or every push against this
 *  repo happened outside `GitWriter` — e.g. a manual `git push` at the shell). */
function getGitPushFailure(repoPath: string): { at: string; error: string } | null {
  try {
    const rec = JSON.parse(fs.readFileSync(pushOutcomePath(repoPath), "utf8"));
    if (rec && rec.ok === false && typeof rec.error === "string" && typeof rec.at === "string") {
      return { at: rec.at, error: rec.error };
    }
    return null;
  } catch { return null; }
}

/** One vault's governing repo sitting some number of commits ahead of its configured upstream. */
export interface VaultPushStatus {
  /** The resolved governing repo root (same value as `VaultVersioner.commitRoot`). */
  commitPath: string;
  /** The upstream ref this was measured against, e.g. `origin/main`. */
  upstream: string;
  /** Commits reachable from HEAD but not from `upstream` — i.e. commits the vault has never pushed. */
  ahead: number;
  /** The most recent recorded push FAILURE for this repo (via `GitWriter.push()` → `recordGitPushOutcome`),
   *  present iff the last recorded outcome was a rejection rather than a success. Lets a reader tell
   *  "N ahead, never tried" apart from "N ahead because the remote is actively rejecting". */
  lastFailure?: { at: string; error: string };
}

/**
 * Read-only: how far a vault's governing repo sits ahead of its configured upstream — task f48ee77d's
 * visibility fix (auto-commit is commit-only by design; see the `VaultVersioner` doc above). Returns
 * `null`, cleanly and silently, for a vault repo with NO upstream configured for its current branch —
 * the common case for a fresh local-only vault with no remote at all — so callers can skip it with zero
 * noise instead of reporting a meaningless "ahead of nothing".
 *
 * `@{u}` (`rev-parse --abbrev-ref --symbolic-full-name @{u}`) is git's own answer to "does this branch
 * track a remote, and which one" — it fails fast (non-zero exit) when there is none, which is exactly
 * the skip signal we want. The count itself is the same read-only `rev-list --count <upstream>..HEAD`
 * shape already used (and unit-tested) for worktree branches in `git/worktrees.ts`
 * (`mayRecutOntoMain` / the ahead-checks around lines 434-437, 911-918) — never a fetch, never a write,
 * never a push.
 *
 * @decision 509716cc — this call is UNCONDITIONALLY awaited at boot (index.ts, ~27 lines before
 *  `sessions.resumeFleetOnBoot`) — never let it hang; a timeout must land in the same catch every other
 *  git error here does, returning `null`, never block boot.
 */
export async function checkVaultPushStatus(commitPath: string, deps: VaultGitDeps = {}): Promise<VaultPushStatus | null> {
  try {
    // simpleGit() itself throws synchronously for a non-existent baseDir — construct it INSIDE the try
    // so a stale/bogus commitPath degrades to "nothing to report", same as any other git error here.
    const { git, timeoutMs } = boundedVaultGit(commitPath, deps);
    const upstream = (await withTimeout(git.raw(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]), timeoutMs, "git rev-parse @{u} (vault push status)")).trim();
    if (!upstream) return null;
    const ahead = parseInt((await withTimeout(git.raw(["rev-list", "--count", `${upstream}..HEAD`]), timeoutMs, "git rev-list --count (vault push status)")).trim(), 10);
    if (!Number.isFinite(ahead)) return null; // malformed count — fail safe to "nothing to report"
    const lastFailure = getGitPushFailure(commitPath);
    return lastFailure ? { commitPath, upstream, ahead, lastFailure } : { commitPath, upstream, ahead };
  } catch {
    return null; // no upstream configured (fatal: no upstream for branch), a timeout, or any other git error
  }
}

/**
 * Check every given vault repo root and log ONE line per vault that has unpushed commits OR a recorded
 * push failure — the actual "N commits un-pushed" / "push is being rejected" visibility surface. A vault
 * with no upstream, or with an upstream, nothing ahead, and no recorded failure, is silent (no noise).
 * Returns the flagged statuses so a caller (boot log, the watcher below, or a test) can assert on them
 * without scraping console output.
 */
export async function logVaultPushStatus(commitPaths: string[]): Promise<VaultPushStatus[]> {
  const statuses = await Promise.all(commitPaths.map((p) => checkVaultPushStatus(p)));
  const unpushed = statuses.filter((s): s is VaultPushStatus => s !== null && (s.ahead > 0 || !!s.lastFailure));
  for (const s of unpushed) {
    if (s.lastFailure) {
      console.log(
        `[vault-push] ${s.commitPath} push REJECTED at ${s.lastFailure.at} (${s.lastFailure.error}) — ` +
        `${s.ahead} commit(s) still unpushed against ${s.upstream}. Fix the remote issue and push manually.`,
      );
    } else {
      console.log(
        `[vault-push] ${s.commitPath} is ${s.ahead} commit(s) ahead of ${s.upstream} ` +
        `(auto-commit is local-only by design — push manually when ready)`,
      );
    }
  }
  return unpushed;
}

/** The slice a periodic ticker needs (injectable so a test drives `tick()` directly, no real timers). */
export interface VaultPushStatusWatcherDeps {
  /** Read the CURRENT set of watched vault repo roots at tick time (not captured once at construction). */
  getCommitPaths: () => string[];
  /** Tick cadence override in ms (tests use a short interval; the daemon uses the default). */
  intervalMs?: number;
  /** Card 227d9f0b — optional: when present, each tick ALSO runs a stat-only (no git exec) stale
   *  `.git/index.lock` check (see `detectStaleVaultLock`/`maybeAlertStaleVaultLock`) against every commit
   *  path, so an idle vault with no pending edit still surfaces a stuck lock. Absent by default — every
   *  pre-existing construction (bare `getCommitPaths`) stays byte-identical and this side of `tick()` is
   *  a no-op. */
  db?: Pick<Db, "appendEvent">;
  /** Optional per-path project-id lookup for the stale-lock alert's `detail.projectId` stamp — absent or
   *  returning `undefined` for a path just omits the stamp (see `maybeAlertStaleVaultLock`'s own doc). */
  projectIdForPath?: (commitPath: string) => string | undefined;
}

const DEFAULT_VAULT_PUSH_CHECK_INTERVAL_MS = 30 * 60_000; // 30 minutes — a backlog nudge, not a hot loop

/**
 * Periodic "N vault commits un-pushed" ticker — twin of `DbBackupWatcher` (index.ts), same start/stop
 * shape and best-effort posture. Read-only w.r.t. git (every tick's push-status half only runs
 * `logVaultPushStatus` — git status reads, never a write, never a push); when `deps.db` is set, the SAME
 * tick also runs `maybeAlertStaleVaultLock`'s stat-only check per commit path, which CAN write a small
 * on-disk dedupe marker and a durable orchestration event (card 227d9f0b) — never a git call either way.
 */
export class VaultPushStatusWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: VaultPushStatusWatcherDeps) {}

  /** Run one check (best-effort; never throws). Exposed so a test can drive it directly. */
  async tick(): Promise<VaultPushStatus[]> {
    const commitPaths = this.deps.getCommitPaths();
    if (this.deps.db) {
      // Card 227d9f0b — stat-only (no git exec); per-path, so one bad path can't suppress the rest.
      for (const p of commitPaths) {
        const lockAlert = { db: this.deps.db, projectId: this.deps.projectIdForPath?.(p) };
        try { maybeAlertStaleVaultLock(p, lockAlert); }
        catch { /* best-effort — a bad path must never kill the tick */ }
        // Round 2: pair the alert above with its CLEAR half — a lock alerted on an earlier tick that has
        // since disappeared files vault_index_lock_cleared and drops the marker.
        try { maybeClearStaleVaultLockAlert(p, lockAlert); }
        catch { /* best-effort — a bad path must never kill the tick */ }
      }
    }
    try { return await logVaultPushStatus(commitPaths); }
    catch { return []; } // best-effort — a bad tick must never kill the ticker or the daemon
  }

  start(): void {
    if (this.timer) return;
    const ms = this.deps.intervalMs ?? DEFAULT_VAULT_PUSH_CHECK_INTERVAL_MS;
    this.timer = setInterval(() => { void this.tick(); }, ms);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

/** Resolve `p` through the filesystem via the OS's NATIVE realpath (`fs.realpathSync.native`) when it
 *  exists, so an ancestor check below can't be fooled by a junction/symlink alias OR an 8.3 short-name
 *  alias (the native call normalizes those; Node's own JS-level `fs.realpathSync` does not — round 2 of
 *  card f9360c84); falls back to a lexical `path.resolve` when `p` doesn't exist yet. */
function realpathNativeOrResolve(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function normLoomPath(p: string): string {
  const r = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/**
 * The pure PATH-RELATION half of {@link isOperationalVaultDir}: is `dir` EQUAL to `LOOM_HOME`, or an
 * ANCESTOR of `LOOM_HOME`/`WORKTREES_DIR` (e.g. the user's home dir itself as a vaultPath or repoPath)?
 * Resolved via `fs.realpathSync.native` so a junction/symlink/8.3-short-name alias can't defeat it.
 *
 * Exported so `git/writer.ts`'s `GitWriter` can refuse a write whose RAW `repoPath`, or whose
 * git-resolved TOPLEVEL, is LOOM_HOME-or-an-ancestor — BEFORE any mutating git call — without pulling in
 * this file's own CONTENT sniff (a top-level `loom.db`/`worktrees/` dir), which would wrongly refuse an
 * ordinary code repo that happens to have its own top-level `worktrees/` folder. Content sniffing stays
 * ONLY in {@link isOperationalVaultDir} (the vault auto-committer's own, broader check), below.
 *
 * @decision f9360c84 (round 2) — ONE source of truth for the path-relation check: both this vault-side
 *  predicate and GitWriter's guard call this SAME function; never re-derive a second ancestor comparison
 *  at either call site.
 */
export function isLoomHomeOrAncestor(dir: string): boolean {
  if (normLoomPath(dir) === normLoomPath(LOOM_HOME)) return true;
  const realDir = normLoomPath(realpathNativeOrResolve(dir));
  for (const home of [LOOM_HOME, WORKTREES_DIR]) {
    const realHome = normLoomPath(realpathNativeOrResolve(home));
    // `dir` is operational if it IS LOOM_HOME/WORKTREES_DIR (realpath form) OR an ANCESTOR of one —
    // i.e. realHome === realDir or realHome sits strictly inside realDir.
    if (realHome === realDir || realHome.startsWith(`${realDir}/`)) return true;
  }
  return false;
}

/**
 * An OPERATIONAL/daemon-home directory is NOT a docs vault — it is Loom's own state dir (`LOOM_HOME`:
 * `loom.db` + its -wal/-shm, `backups/`, `worktrees/` with node_modules, `logs/`, `tmp/`). The reserved
 * "Loom Platform" home points its `vaultPath` AT this dir, so `startVaultVersioners` must NEVER watch it:
 * a `git add -A` there would stage the LIVE SQLite DB (churn / bloat / commit-mid-write corruption) and
 * chokidar walking `worktrees/`+node_modules thrashes. We detect it by CONTENT (a `loom.db` file or a
 * `worktrees/` dir present — env-independent, the robust PRIMARY signal) PLUS the shared path-relation
 * check ({@link isLoomHomeOrAncestor}, equality-or-ancestor against `LOOM_HOME`/`WORKTREES_DIR`).
 *
 * @decision 68cc29db — `dir` being an ANCESTOR of `LOOM_HOME`/`WORKTREES_DIR` (e.g. the user's home dir
 *  itself as `vaultPath`) is ALSO operational — `git add .` there would sweep loom.db/secrets/worktrees
 *  in too.
 */
export function isOperationalVaultDir(dir: string): boolean {
  if (isLoomHomeOrAncestor(dir)) return true; // path-relation half — shared with GitWriter's guard
  if (fs.existsSync(path.join(dir, "loom.db"))) return true; // the live daemon DB lives here
  if (fs.existsSync(path.join(dir, "worktrees"))) return true; // worker worktrees (node_modules churn)
  return false;
}

/**
 * Shared error text for a git write refused because its target resolves to Loom's own operational/
 * daemon-home dir. This used to be checked by a per-caller wrapper (`refuseOperationalRepoPath`) at each
 * of the Platform Lead's and the human REST git-write call sites, against the RAW `repoPath` only — never
 * the toplevel `GitWriter` actually writes to, so a non-git descendant of `LOOM_HOME` slipped through
 * while git itself walked up and wrote into `LOOM_HOME/.git`. The refusal now lives INSIDE `GitWriter`
 * itself (the ONE chokepoint every git-write surface goes through), checking both the raw path and the
 * git-resolved toplevel before any mutating call; exported so that guard (and a test) share one literal.
 *
 * @decision f9360c84 (round 2) — see git/writer.ts's own guard for the real mechanism.
 */
export const OPERATIONAL_HOME_GIT_WRITE_ERROR =
  "refusing this git write: the repo path resolves to Loom's own operational home directory — nothing was written";

/**
 * Boot wiring for the vault auto-committer: start ONE `VaultVersioner` per UNIQUE live project vault.
 * @decision sha:de33d76e — never treat this class's own unit tests as proof it is live — VaultVersioner
 *  was fully unit-tested while never wired into the daemon's boot sequence, so vault doc edits accrued NO
 *  git history, silently. Keep boot wiring in its own testable function, not an untested tail of index.ts.
 *
 * - DEDUPE by GOVERNING REPO ROOT (resolved via `resolveVaultRepoContext`), not the raw vaultPath: the
 *   owner's real layout is ONE git repo at the vault root with each project's vaultPath a SUBFOLDER, so N
 *   sibling project-subfolders of the SAME repo must collapse to ONE root watcher (committing the whole
 *   repo once), not one redundant watcher per subfolder. Two projects sharing one exact vaultPath dedupe
 *   the same way (same resolved root).
 * - SKIP an Obsidian-Git-managed repo: a real external auto-committer already owns its history, so we
 *   start NO watcher for it (and thus never commit) — the structural backoff for that layout.
 * - SKIP projects with no vaultPath (an unset string) and archived ones. `listAllProjects()` already
 *   excludes archived (and includes reserved homes, whose vaults agents do edit) — the archivedAt guard
 *   is belt-and-suspenders.
 *
 * Returns the started versioners so the caller can `flushSync()`/`stop()` them on shutdown.
 */
export async function startVaultVersioners(db: Db, opts?: { debounceMs?: number }): Promise<VaultVersioner[]> {
  const started: VaultVersioner[] = [];
  const seen = new Set<string>();
  for (const project of db.listAllProjects()) {
    if (project.archivedAt) continue;
    const vaultPath = project.vaultPath?.trim();
    if (!vaultPath) continue;
    // A non-absolute vaultPath (card 78dc99e3) can only be a LEGACY row that predates the write-time
    // guard (`validateVaultPath`, card 96c4b245 — every create/rebind path has rejected a relative value
    // since 2026-07-22). It resolves against whatever the daemon PROCESS's cwd happens to be — unstable
    // across restart mechanisms (tsx watch vs. the supervisor vs. the packaged CLI) — so letting it fall
    // through to `resolveVaultRepoContext`/`git init` produces an opaque, cwd-dependent failure (or worse,
    // a silent write into the wrong place via `resolveInVault`'s `path.resolve`, which happily treats a
    // missing root as "not yet scaffolded" rather than "misconfigured"). Name the real cause loudly here,
    // once, instead of leaving it to surface as an unexplained "failed to start" below.
    const check = validateVaultPath(vaultPath);
    if (!check.ok) {
      console.warn(`[vault-versioner] project ${project.id} (${project.name}) vaultPath is not absolute: "${vaultPath}" — it will never reliably resolve (depends on the daemon process's own cwd) and is skipped here; rebind it via PATCH /api/projects/:id or the web UI.`);
      continue;
    }
    // Per-project isolation: resolve+construct+start() can THROW on a bad/inaccessible vaultPath
    // (simpleGit construction or start()'s git calls). Guard each project so ONE bad vaultPath is
    // logged + skipped and the rest still start — best-effort, mirroring the boot-watcher /
    // worktree-provision posture (the boot caller wraps the WHOLE call, so an unguarded throw here
    // would poison every subsequent project).
    try {
      // Resolve to the governing repo root FIRST so the dedupe key + the back-off decision both key off
      // the root, collapsing sibling project-subfolders of one repo to a single watcher.
      const ctx = await resolveVaultRepoContext(vaultPath);
      // SKIP operational/daemon-home vaults (a reserved/.loom-rooted home is NOT a docs vault) — checked
      // against both the raw vault dir and the resolved governing repo root. BEFORE constructing/starting.
      if (isOperationalVaultDir(vaultPath) || isOperationalVaultDir(ctx.commitPath)) {
        console.warn(`[vault-versioner] project ${project.id} vault (${vaultPath}) is an operational/daemon-home dir (loom.db/worktrees/LOOM_HOME) — skipping; not a docs vault.`);
        continue;
      }
      // @decision a09b81a0 — never let the sibling-dedupe `seen` set below short-circuit this check; run
      // it per-project so two projects colliding on the SAME commitPath are each warned independently.
      const collision = checkCodeRepoCollision(ctx.commitPath);
      if (collision) {
        refuseCodeRepoCollision(vaultPath, ctx.commitPath, collision, "boot", project.id);
        continue;
      }
      const key = ctx.commitPath.replace(/\\/g, "/");
      if (seen.has(key)) continue; // already watching this repo root
      seen.add(key);
      if (ctx.externallyManaged) continue; // Obsidian-Git owns this history — no loom watcher/commit
      // Card 227d9f0b — threads db + the owning project's id through so a stale-lock alert this instance
      // files (commit()/flushSync()) carries detail.projectId; appended positionally at the tail, see
      // the constructor's own doc for why the three intermediate args stay explicit `undefined`.
      const versioner = new VaultVersioner(vaultPath, opts?.debounceMs, undefined, undefined, undefined, { db, projectId: project.id });
      await versioner.start();
      started.push(versioner);
    } catch (err) {
      console.warn(`[vault-versioner] project ${project.id} vault (${vaultPath}) failed to start (${(err as Error).message}); skipping — other projects' versioners still start.`);
    }
  }
  return started;
}
