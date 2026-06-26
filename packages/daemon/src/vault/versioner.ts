import path from "node:path";
import { execSync } from "node:child_process";
import chokidar, { type FSWatcher } from "chokidar";
import { simpleGit, type SimpleGit } from "simple-git";
import type { Db } from "../db.js";

/**
 * Stage-all + commit a vault folder, honoring the same externally-managed backoff as the
 * auto-committer: if the vault sits inside a git repo whose root is ABOVE the vault folder
 * (e.g. a vault-wide Obsidian Git repo), we do NOT init or commit, to avoid double-committing.
 * Initializes a repo at the vault folder itself if there is none. Returns true if a commit was
 * made, false if skipped (externally managed, or nothing staged to commit).
 *
 * This is THE single vault commit path — shared by the auto-committer (below) and human UI
 * writes (vault/writer.ts) so the history stays consistent and there is no second git mechanism.
 */
export async function commitVault(vaultPath: string, message: string): Promise<boolean> {
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
  await git.commit(message);
  return true;
}

/**
 * Auto-commits a project's vault folder so doc rewrites are never truly lost (§7).
 * Debounces writes and commits at idle. Backs off if the folder is an externally-managed
 * git repo whose root is ABOVE the vault folder (e.g. a vault-wide Obsidian Git repo) — in
 * that case we do not initialize or commit, to avoid double-committing.
 */
export class VaultVersioner {
  private git: SimpleGit;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private externallyManaged = false;

  constructor(private vaultPath: string, private debounceMs = 5000) {
    this.git = simpleGit(vaultPath);
  }

  async start(): Promise<void> {
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (isRepo) {
      const root = (await this.git.revparse(["--show-toplevel"]).catch(() => "")).trim();
      // If the repo root is not the vault folder itself, treat it as externally managed.
      this.externallyManaged = !!root && root.replace(/\\/g, "/") !== this.vaultPath.replace(/\\/g, "/");
    } else {
      await this.git.init();
    }
    this.watcher = chokidar.watch(this.vaultPath, {
      ignoreInitial: true,
      ignored: /(^|[/\\])(\.git|\.obsidian)([/\\]|$)/,
    });
    this.watcher.on("all", () => this.schedule());
  }

  private schedule(): void {
    if (this.externallyManaged) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.commit(), this.debounceMs);
  }

  private async commit(): Promise<void> {
    // Route through the shared commit path so UI writes and auto-commits stay consistent.
    try { await commitVault(this.vaultPath, `loom: auto-commit ${new Date().toISOString()}`); }
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
   * commits any pending on-disk changes with `execSync` so the commit lands BEFORE the process exits.
   * Honors the cached `externallyManaged` backoff (skip — a vault-wide Obsidian-Git repo owns its own
   * history) and is a no-op when nothing is staged. Best-effort: never throws. Returns true iff it
   * committed. Mirrors the shared `commitVault` semantics, but synchronous by necessity.
   */
  flushSync(): boolean {
    if (this.externallyManaged) return false;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try {
      const opts = { cwd: this.vaultPath, stdio: "pipe" as const };
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

/**
 * Boot wiring for the vault auto-committer: start ONE `VaultVersioner` per UNIQUE live project vault.
 * Factored out of index.ts so the boot wiring is itself testable (the gap this fixes existed precisely
 * because the class was unit-tested in isolation while NEVER wired). index.ts calls this at boot; the
 * test calls it against a temp project + temp vault.
 *
 * - DEDUPE by resolved vaultPath: the daemon serves many projects that commonly SHARE one Obsidian vault
 *   root — starting N watchers on the same folder means redundant commits + chokidar churn, so one watcher
 *   per unique path.
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
    const key = path.resolve(vaultPath).replace(/\\/g, "/");
    if (seen.has(key)) continue; // already watching this vault root
    seen.add(key);
    const versioner = new VaultVersioner(vaultPath, opts?.debounceMs);
    await versioner.start();
    started.push(versioner);
  }
  return started;
}
