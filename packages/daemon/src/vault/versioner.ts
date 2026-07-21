import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import chokidar, { type FSWatcher } from "chokidar";
import { simpleGit, type SimpleGit } from "simple-git";
import type { Db } from "../db.js";
import { LOOM_HOME } from "../paths.js";

/** Generic, non-personal identity used ONLY when the host has no git identity configured at all. */
const FALLBACK_GIT_IDENTITY = { name: "Loom", email: "loom@localhost" } as const;

/**
 * Default oversized-file threshold for auto-commit (card 614dfbef, origin finding 4ae8a3c9): a vault was
 * observed committing >100MB blobs (two ~2.7GB) via `loom: auto-commit`, permanently wedging the vault's
 * GitHub backup (GitHub hard-rejects any push containing a >100MB object). 95MB leaves headroom below
 * that hard limit for git's own object-format overhead. Overridable via `commitVault`'s `opts.maxFileBytes`
 * (tests use a tiny value — writing a real 95MB fixture file per test run would be slow and wasteful).
 */
const DEFAULT_MAX_VAULT_FILE_BYTES = 95 * 1024 * 1024;

function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * Paths we've already warned about for a given repo root — suppresses re-warning on every debounced
 * commit tick while a stuck oversized file just sits there untouched (chokidar re-triggers `commit()` on
 * ANY change under the watched root, which restages every untracked file, including this one, every
 * time). Module-scope + add-only: a daemon restart re-warns once, which is fine; there is no need to
 * evict an entry once the file stops being oversized (it just never gets re-added to this set).
 */
const warnedOversizedFiles = new Set<string>();

/**
 * Unstage any staged file whose on-disk size exceeds `maxFileBytes` (deletions are skipped — nothing to
 * stat, and a deletion can never re-introduce a giant blob), console.warn a `.gitignore` suggestion once
 * per path, and return the list of paths actually unstaged (possibly empty). `git reset -- <path>` is
 * used rather than `git reset HEAD -- <path>` so this also works on a brand-new repo's very first commit
 * (verified: `reset -- <path>` unstages cleanly even with no HEAD yet; `reset HEAD -- <path>` would fail
 * there). Swallows a reset failure per-file (leaves that one file staged) rather than aborting the whole
 * commit — refusing to commit ANYTHING because one file couldn't be unstaged would be a worse outcome
 * than the rare case of a stray oversized commit slipping through, and the failure itself is still logged.
 */
async function unstageOversizedFiles(
  git: SimpleGit,
  root: string,
  files: Array<{ path: string; working_dir: string; index: string }>,
  maxFileBytes: number,
): Promise<string[]> {
  const skipped: string[] = [];
  for (const f of files) {
    if (f.working_dir === "D" || f.index === "D") continue; // deletion — nothing to stat, nothing to skip
    let size: number;
    try { size = fs.statSync(path.join(root, f.path)).size; } catch { continue; } // gone/unreadable — let the normal flow handle it
    if (size <= maxFileBytes) continue;
    try {
      await git.raw(["reset", "--", f.path]);
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
 */
async function hasConfiguredGitIdentity(git: SimpleGit): Promise<boolean> {
  try {
    const name = (await git.raw(["config", "user.name"])).trim();
    const email = (await git.raw(["config", "user.email"])).trim();
    return !!name && !!email;
  } catch {
    return false;
  }
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
 * all. When the repo has one configured (global, system, or local), we commit exactly as before —
 * their identity, un-overridden. Only when EITHER `user.name` or `user.email` is unresolved do we
 * fall back to a generic, non-personal `Loom <loom@localhost>` identity for that single commit, via
 * `-c user.name=`/`-c user.email=` passed as ARGS on the commit invocation (never as an env-var
 * override): simple-git's `blockUnsafeOperationsPlugin` rejects an explicit `.env()` call that
 * carries `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` (a real config-injection vector it guards
 * against) — a call we'd otherwise make by spreading `process.env` to preserve PATH/HOME for the
 * child process. Scoped `-c` args sidestep that entirely (git itself only applies them to this one
 * invocation) and `user.name`/`user.email` are not among simple-git's blocklisted config keys.
 *
 * **Oversized-file guard** (card 614dfbef): before committing, any staged file above `opts.maxFileBytes`
 * (default `DEFAULT_MAX_VAULT_FILE_BYTES`, ~95MB) is unstaged and warned about instead of committed — see
 * {@link unstageOversizedFiles}. Applies to every caller of this shared path (the auto-committer below AND
 * `vault/writer.ts`'s UI writes), so a giant file can never enter vault history through either route.
 */
export async function commitVault(
  vaultPath: string,
  message: string,
  opts?: { maxFileBytes?: number },
): Promise<boolean> {
  const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_VAULT_FILE_BYTES;
  const git = simpleGit(vaultPath);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (isRepo) {
    const root = (await git.revparse(["--show-toplevel"]).catch(() => "")).trim();
    const externallyManaged = !!root && root.replace(/\\/g, "/") !== vaultPath.replace(/\\/g, "/");
    if (externallyManaged) return false;
  } else {
    await git.init();
  }
  await git.add(".");
  const status = await git.status();
  if (status.files.length === 0) return false;
  const skipped = await unstageOversizedFiles(git, vaultPath, status.files, maxFileBytes);
  // NOTE: an unstaged file does NOT disappear from `git status` (it just reverts to untracked/modified),
  // so re-querying status here would still see it and wrongly think there's something left to commit.
  // Comparing counts against the ORIGINAL staged set is the correct "anything real left?" check.
  if (skipped.length >= status.files.length) return false; // everything staged was oversized — nothing left to commit
  if (await hasConfiguredGitIdentity(git)) {
    await git.commit(message);
  } else {
    await git.raw([
      "-c", `user.name=${FALLBACK_GIT_IDENTITY.name}`,
      "-c", `user.email=${FALLBACK_GIT_IDENTITY.email}`,
      "commit", "-m", message,
    ]);
  }
  return true;
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
 * We detect the Obsidian-Git case DISTINCTLY — by the presence of the `.obsidian/plugins/obsidian-git`
 * marker directory under the repo root — NOT by "subfolder ≠ root" (the old, wrong proxy that backed
 * off for EVERY subfolder, including subfolders of plain repos). The marker is deterministic (it exists
 * iff the Obsidian Git plugin — the thing that creates the external committer — is installed for that
 * vault) and is one cheap `fs.existsSync`; preferred over a commit-message heuristic, which is fragile
 * (depends on the user's message template, reads empty on a fresh repo, false +/-).
 */
async function resolveVaultRepoContext(
  vaultPath: string,
): Promise<{ commitPath: string; externallyManaged: boolean }> {
  const git = simpleGit(vaultPath);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) return { commitPath: vaultPath, externallyManaged: false }; // no repo → we git-init it
  const root = (await git.revparse(["--show-toplevel"]).catch(() => "")).trim();
  if (!root) return { commitPath: vaultPath, externallyManaged: false };
  const commitPath = path.resolve(root);
  // Obsidian-Git-managed → a real external auto-committer owns history; back off (no double-commit).
  const obsidianGitMarker = path.join(commitPath, ".obsidian", "plugins", "obsidian-git");
  return { commitPath, externallyManaged: fs.existsSync(obsidianGitMarker) };
}

export type VaultGitTargetResult =
  | { ok: true; repoPath: string }
  | { ok: false; reason: "no-vault" | "no-repo" | "externally-managed" };

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
 */
export async function resolveVaultGitTarget(vaultPath: string): Promise<VaultGitTargetResult> {
  const trimmed = vaultPath?.trim();
  if (!trimmed) return { ok: false, reason: "no-vault" };
  const ctx = await resolveVaultRepoContext(trimmed);
  if (ctx.externallyManaged) return { ok: false, reason: "externally-managed" };
  const isRepo = await simpleGit(ctx.commitPath).checkIsRepo().catch(() => false);
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

/** Lease path for a governing repo root — inside `.git/`, so (a) chokidar's own ignore pattern
 *  (`(^|[/\\])\.git([/\\]|$)`, see `start()` below) means writing/removing it never itself triggers a
 *  spurious auto-commit cycle, and (b) it is never git-tracked (can't land in vault history). */
function pauseLeasePath(commitPath: string): string {
  return path.join(commitPath, ".git", PAUSE_LEASE_FILENAME);
}

/**
 * Advisory pause (card 614dfbef, origin finding 4ae8a3c9): create a short-lived lease telling this repo
 * root's `VaultVersioner` to skip its commits — for an agent doing SANCTIONED git surgery on a vault repo
 * (untracking files, rewriting `.gitignore`, mid-sequence state) that would otherwise race the background
 * auto-committer. Purely advisory: a plain file the versioner checks before it commits, not an OS-level
 * lock — nothing else is blocked from touching the repo. `durationMs` is clamped to
 * `[0, MAX_VAULT_PAUSE_MS]`. Best-effort: never throws (a failed write just means "not paused").
 */
export function pauseVaultAutoCommit(commitPath: string, durationMs = DEFAULT_VAULT_PAUSE_MS): void {
  const clamped = Math.max(0, Math.min(durationMs, MAX_VAULT_PAUSE_MS));
  try {
    const p = pauseLeasePath(commitPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ until: Date.now() + clamped }));
  } catch { /* best-effort — never throws into the caller's git-surgery flow */ }
}

/** End an advisory pause early (the surgery finished before the lease would have expired anyway). A
 *  no-op if no lease exists. Best-effort: never throws. */
export function resumeVaultAutoCommit(commitPath: string): void {
  try { fs.rmSync(pauseLeasePath(commitPath)); } catch { /* no lease to remove — fine */ }
}

/** Whether an unexpired pause lease exists for `commitPath`. A missing, unreadable, malformed, or expired
 *  lease all read as "not paused" — fail-open toward committing rather than getting silently stuck paused
 *  forever on a corrupt lease file. */
function isVaultAutoCommitPaused(commitPath: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(pauseLeasePath(commitPath), "utf8"));
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
 * **Commit-only by design — this never pushes, and that is intentional, not a gap.** (Investigated under
 * task f48ee77d: a vault observed 172 `loom: auto-commit` commits ahead of `origin/main`.) Pushing a repo
 * is a HUMAN-only trust-boundary action in Loom (see `git/writer.ts` `GitWriter.push()` + the human-only
 * git-write REST surface) — this versioner runs unattended in the daemon, triggered by any filesystem
 * event (including an ordinary agent's doc rewrite), so it must never perform outbound network git
 * operations itself; doing so would silently widen that boundary. For a vault whose governing repo DOES
 * have a configured upstream, the resulting backlog is made VISIBLE instead of silent via
 * {@link checkVaultPushStatus} / {@link VaultPushStatusWatcher} below (read-only `rev-list --count`, no
 * writes) — push stays a manual action the human takes through the existing git-write surface.
 */
export class VaultVersioner {
  private git: SimpleGit;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private externallyManaged = false;
  /** The folder we actually watch + commit — the governing repo ROOT, resolved in `start()`. */
  private commitPath: string;

  constructor(private vaultPath: string, private debounceMs = 5000) {
    this.commitPath = vaultPath;
    this.git = simpleGit(vaultPath);
  }

  /** The resolved governing repo root this instance watches + commits (valid after `start()`). */
  get commitRoot(): string {
    return this.commitPath;
  }

  async start(): Promise<void> {
    const ctx = await resolveVaultRepoContext(this.vaultPath);
    this.commitPath = ctx.commitPath;
    this.externallyManaged = ctx.externallyManaged;
    this.git = simpleGit(this.commitPath);
    if (!this.externallyManaged) {
      // git-init a bare vault folder that has no repo (resolveVaultRepoContext leaves commitPath as the
      // vault folder in that case). A real repo (own root / plain-repo root) already exists — no-op.
      const isRepo = await this.git.checkIsRepo().catch(() => false);
      if (!isRepo) await this.git.init();
    }
    this.watcher = chokidar.watch(this.commitPath, {
      ignoreInitial: true,
      ignored: /(^|[/\\])(\.git|\.obsidian|node_modules|worktrees)([/\\]|$)/,
    });
    this.watcher.on("all", () => this.schedule());
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
    catch { /* best-effort */ }
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
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
   */
  flushSync(): boolean {
    if (this.externallyManaged) return false;
    if (isVaultAutoCommitPaused(this.commitPath)) return false;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try {
      const opts = { cwd: this.commitPath, stdio: "pipe" as const };
      execSync("git add -A", opts);
      const staged = execSync("git status --porcelain", opts).toString().trim();
      if (!staged) return false; // nothing to commit — no-op
      execSync(`git commit -m "loom: auto-commit ${new Date().toISOString()} (shutdown flush)"`, opts);
      return true;
    } catch {
      return false; // best-effort — a missing identity / no-repo / git error must never block exit
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
 */
export async function checkVaultPushStatus(commitPath: string): Promise<VaultPushStatus | null> {
  try {
    // simpleGit() itself throws synchronously for a non-existent baseDir — construct it INSIDE the try
    // so a stale/bogus commitPath degrades to "nothing to report", same as any other git error here.
    const git = simpleGit(commitPath);
    const upstream = (await git.raw(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim();
    if (!upstream) return null;
    const ahead = parseInt((await git.raw(["rev-list", "--count", `${upstream}..HEAD`])).trim(), 10);
    if (!Number.isFinite(ahead)) return null; // malformed count — fail safe to "nothing to report"
    const lastFailure = getGitPushFailure(commitPath);
    return lastFailure ? { commitPath, upstream, ahead, lastFailure } : { commitPath, upstream, ahead };
  } catch {
    return null; // no upstream configured (fatal: no upstream for branch) — or any other git error
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
}

const DEFAULT_VAULT_PUSH_CHECK_INTERVAL_MS = 30 * 60_000; // 30 minutes — a backlog nudge, not a hot loop

/**
 * Periodic "N vault commits un-pushed" ticker — twin of `DbBackupWatcher` (index.ts), same start/stop
 * shape and best-effort posture. Read-only + additive: every tick only runs `logVaultPushStatus` (git
 * status reads), never a write, never a push.
 */
export class VaultPushStatusWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private deps: VaultPushStatusWatcherDeps) {}

  /** Run one check (best-effort; never throws). Exposed so a test can drive it directly. */
  async tick(): Promise<VaultPushStatus[]> {
    try { return await logVaultPushStatus(this.deps.getCommitPaths()); }
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

/**
 * An OPERATIONAL/daemon-home directory is NOT a docs vault — it is Loom's own state dir (`LOOM_HOME`:
 * `loom.db` + its -wal/-shm, `backups/`, `worktrees/` with node_modules, `logs/`, `tmp/`). The reserved
 * "Loom Platform" home points its `vaultPath` AT this dir, so `startVaultVersioners` must NEVER watch it:
 * a `git add -A` there would stage the LIVE SQLite DB (churn / bloat / commit-mid-write corruption) and
 * chokidar walking `worktrees/`+node_modules thrashes. We detect it by CONTENT (a `loom.db` file or a
 * `worktrees/` dir present — env-independent, the robust PRIMARY signal) with `LOOM_HOME`-equality as
 * belt-and-suspenders. Checked against BOTH the raw vault dir and its resolved governing repo root.
 */
function isOperationalVaultDir(dir: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  if (norm(dir) === norm(LOOM_HOME)) return true; // belt-and-suspenders: equals the daemon home
  if (fs.existsSync(path.join(dir, "loom.db"))) return true; // the live daemon DB lives here
  if (fs.existsSync(path.join(dir, "worktrees"))) return true; // worker worktrees (node_modules churn)
  return false;
}

/**
 * Boot wiring for the vault auto-committer: start ONE `VaultVersioner` per UNIQUE live project vault.
 * Factored out of index.ts so the boot wiring is itself testable (the gap this fixes existed precisely
 * because the class was unit-tested in isolation while NEVER wired). index.ts calls this at boot; the
 * test calls it against a temp project + temp vault.
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
      const key = ctx.commitPath.replace(/\\/g, "/");
      if (seen.has(key)) continue; // already watching this repo root
      seen.add(key);
      if (ctx.externallyManaged) continue; // Obsidian-Git owns this history — no loom watcher/commit
      const versioner = new VaultVersioner(vaultPath, opts?.debounceMs);
      await versioner.start();
      started.push(versioner);
    } catch (err) {
      console.warn(`[vault-versioner] project ${project.id} vault (${vaultPath}) failed to start (${(err as Error).message}); skipping — other projects' versioners still start.`);
    }
  }
  return started;
}
