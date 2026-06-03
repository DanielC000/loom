import chokidar, { type FSWatcher } from "chokidar";
import { simpleGit, type SimpleGit } from "simple-git";

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
}
