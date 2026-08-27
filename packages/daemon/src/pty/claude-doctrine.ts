import chokidar, { type FSWatcher } from "chokidar";
import os from "node:os";
import path from "node:path";

/**
 * HarnessAdapter seam (card 2b099e48, Phase 0): the claude adapter's ownership of the SMALLER
 * claude-specific literals that don't warrant their own file — the doctrine-injection target dir
 * (`.claude/skills`), the git-status noise filter's matching paths, the OAuth credentials file
 * location, the transcript-liveness watch directory, and the one vendor-process built-in slash command
 * (`/clear`) Loom injects as a side-channel primitive. Each of these previously lived as an inline
 * literal inside a generic file (`skills/inject.ts`, `git/worktrees.ts`, `orchestration/usage-status.ts`,
 * `sessions/liveness.ts`, `companion/chat-gateway.ts`) — moved here so those files stay grep-clean of
 * `.claude`/`claude` literals and so the (today: two, independently-hardcoded) doctrine-artifact path
 * lists in `git/worktrees.ts` and `skills/inject.ts` share ONE source of truth instead of two lists that
 * could silently drift apart.
 */

/** The directory name Claude Code discovers project-local doctrine (skills, settings) under. */
export const CLAUDE_DOCTRINE_DIR = ".claude";

/** The default CLI binary name, absent a `LOOM_CLAUDE_BIN` override — resolved via
 *  `pty/resolve-bin.ts#resolveExecutable`. Shared so callers outside `pty/` (e.g.
 *  `orchestration/usage-status.ts`'s `claude --version` probe) don't each hardcode the literal. */
export const CLAUDE_BINARY_NAME = "claude";

/** Where Loom mirrors its managed skills for a session — Claude's project-local skill discovery dir. */
export function claudeSkillsDir(cwd: string): string {
  return path.join(cwd, CLAUDE_DOCTRINE_DIR, "skills");
}

/**
 * Whether `p` (a git-status-relative path, forward-slash form) is claude-doctrine noise that a worker's
 * own product never counts as — the injected skills subtree at ANY status, or an untracked path under
 * `.claude/` (skill injection + Claude Code's own `.claude/settings.local.json` permission-persistence
 * writes). Mirrors exactly what `git/worktrees.ts`'s `uncommittedWorkFiles`/`worktreeStatusHasWork` and
 * `skills/inject.ts`'s `hideFromGit` each independently need to recognize as claude-doctrine artifacts.
 */
export function isDoctrineSkillsPath(p: string): boolean {
  return p.startsWith(`${CLAUDE_DOCTRINE_DIR}/skills/`);
}

/** Whether `p` sits anywhere under the doctrine dir at all (broader than {@link isDoctrineSkillsPath}). */
export function isDoctrineArtifactPath(p: string): boolean {
  return p.startsWith(`${CLAUDE_DOCTRINE_DIR}/`);
}

/** Git-exclude entries for one injected skill name, plus Claude's own permission-persistence file —
 *  exactly what `skills/inject.ts`'s `hideFromGit` appends to `info/exclude` per session. */
export function doctrineGitExcludeEntries(skillNames: string[]): string[] {
  return [...skillNames.map((n) => `/${CLAUDE_DOCTRINE_DIR}/skills/${n}`), `/${CLAUDE_DOCTRINE_DIR}/settings.local.json`];
}

/** Windows-first: %USERPROFILE%\.claude\.credentials.json (the Claude Code OAuth token file). macOS
 *  keeps the token in the Keychain instead — unavailable there (known limitation; Loom is Windows-first). */
export function claudeCredentialsPath(): string {
  return path.join(os.homedir(), CLAUDE_DOCTRINE_DIR, ".credentials.json");
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), CLAUDE_DOCTRINE_DIR, "projects");

/**
 * Watch `~/.claude/projects` for a transcript disappearing (debounced), invoking `onRemoved` so the
 * caller can re-sweep its own dead-session bookkeeping. Moved out of `sessions/liveness.ts` (which keeps
 * the harness-agnostic `sweepDeadSessions` DB logic and now just calls this) — this function owns only
 * the WATCH mechanism, not what happens when it fires. Errors are swallowed (logged, never rethrown): a
 * watched project dir can vanish mid-stat on Windows (EPERM/ENOENT/EBUSY) for something as ordinary as a
 * short-lived temp run cwd's transcript being cleaned up, and an unhandled chokidar 'error' event crashes
 * the whole daemon (it did, 2026-06-16) — the watcher must keep running and let the next debounced sweep
 * self-heal.
 */
export function watchClaudeLiveness(onRemoved: () => void): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onRemoved, 1500);
  };
  return chokidar
    .watch(CLAUDE_PROJECTS_DIR, { ignoreInitial: true, depth: 2 })
    .on("unlink", (f) => { if (f.endsWith(".jsonl")) schedule(); })
    .on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      console.warn(`[liveness] claude-projects watcher error (ignored, watcher continues): ${e?.code ?? ""} ${e?.message ?? String(err)}`);
    });
}

/**
 * Claude Code's own built-in slash commands, injected by Loom as side-channel turn primitives (never
 * something a human typed) — currently just the companion's "/new"/"/reset" context-reset half
 * (`companion/chat-gateway.ts`'s `resetConversation`). `kind` is Loom's own vocabulary, not the vendor's;
 * this is the ONE seam a second harness without an equivalent in-band reset command would return null
 * from, so the caller degrades to skipping that half (see the `HarnessCapabilities.builtinReset` flag).
 */
export function vendorProcessSlashCommand(kind: "reset"): string | null {
  if (kind === "reset") return "/clear";
  return null;
}
