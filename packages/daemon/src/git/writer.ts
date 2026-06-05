import { simpleGit, type SimpleGit } from "simple-git";

// The WRITE side of the project git view — sibling to reader.ts (which stays read-only introspection).
// HUMAN/REST surface ONLY. Like the vault writer (vault/writer.ts) and gateCommand, git writes are a
// TRUST-BOUNDARY surface: checkout/commit and ESPECIALLY push (outward-facing, network, irreversible)
// must be reachable only from the human REST path. NO git-write tool is exposed on ANY MCP server
// (loom-tasks / orchestration / platform) — an agent must never be able to checkout/commit/push. The
// REST endpoints in gateway/server.ts that call into here carry the same trust-boundary comment.

/**
 * Per-op ceiling. Every git write runs BOUNDED + NON-INTERACTIVE: this repo has been bitten twice by
 * an unbounded git op HANGING (not throwing) and wedging the daemon (the 2026-06-03 boot-reconcile
 * outage). A push that needs credentials, or a child stuck on a locked ref, must fail within this
 * window — never hang. Mirrors GIT_OP_TIMEOUT_MS in git/worktrees.ts (push gets a longer budget than
 * a local op because a reachable remote can be legitimately slow, but it is still bounded).
 *
 * These are the DEFAULTS / test seams; the live values are `platform.timeouts.gitLocalMs`/`gitPushMs`,
 * threaded in via the {@link GitWriter} constructor opts (the gateway passes the resolved numbers at
 * boot — BOOT-BOUND). A misconfigured (sub-second) value is FLOORED to {@link GIT_TIMEOUT_FLOOR_MS} so
 * a bad config can never make every git write fail-fast.
 */
const GIT_LOCAL_TIMEOUT_MS = 15_000;
const GIT_PUSH_TIMEOUT_MS = 45_000;
/** Hard floor (1s) for any threaded git-write timeout — never let a misconfig fail-fast every op. */
const GIT_TIMEOUT_FLOOR_MS = 1_000;

/**
 * Env that forces git to FAIL FAST instead of blocking on any interactive prompt:
 *  - GIT_TERMINAL_PROMPT=0 — git never prompts on the terminal (the classic hang: a push to an
 *    auth-required remote sits forever waiting for a username/password on stdin we don't have).
 *  - GCM_INTERACTIVE=never — Git Credential Manager (the common Windows prompt source) never opens a
 *    dialog; it fails closed.
 * We deliberately do NOT set GIT_ASKPASS/SSH_ASKPASS: simple-git's injection guard refuses to run with
 * those in a supplied env (they're an arbitrary-command vector) and disabling that guard is the wrong
 * trade for a trust-boundary surface. The residual GUI-askpass hang risk is covered by the
 * {@link withTimeout} race below — the hard backstop regardless of env: even a never-settling git
 * promise unblocks the caller within the op's budget.
 */
const NONINTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
};

/**
 * The child env for a git write: the inherited env (git needs PATH/HOME/etc.) MINUS the editor vars,
 * PLUS {@link NONINTERACTIVE_ENV}. The editor vars are stripped for two reasons: (1) simple-git refuses
 * to run when `GIT_EDITOR` is present in a supplied env (its "unsafe editor" guard), and (2) every op
 * here is non-interactive by construction (commit uses `-m`, checkout never edits), so no editor should
 * ever be invoked — a leftover `GIT_EDITOR` could only cause a hang/prompt we explicitly forbid.
 */
function nonInteractiveEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.GIT_EDITOR;
  delete env.GIT_SEQUENCE_EDITOR;
  return { ...env, ...NONINTERACTIVE_ENV };
}

/** Reject `p` after `ms` if it hasn't settled — the hard guarantee the call returns even if git hangs. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms (hung git child?)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** A structured outcome the UI can render — never a thrown 500 for an EXPECTED git failure. */
export type GitWriteResult<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string };

/** First line of a git/simple-git error — the human-readable reason (dirty tree, no upstream, etc.). */
function gitError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  return msg.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "git operation failed";
}

/**
 * Does this push failure mean "this branch has no tracking ref to push to" (vs. a remote/auth/reject
 * failure)? A branch freshly created via the UI "+ Branch" button has no upstream, so a plain `git push`
 * fails with `The current branch <x> has no upstream branch.` (or, on a repo with no remote at all,
 * `No configured push destination.`). Those are the ONLY conditions we retry with set-upstream — any
 * other failure (unreachable remote, auth required, rejected non-fast-forward) is surfaced unchanged.
 */
function isNoUpstreamError(e: unknown): boolean {
  const msg = ((e as Error)?.message ?? String(e)).toLowerCase();
  return msg.includes("no upstream") || msg.includes("no configured push destination");
}

/**
 * Bounded, non-interactive git WRITE operations for the project repo. Each method returns a structured
 * {@link GitWriteResult} (never throws for an expected git failure) and is wrapped in {@link withTimeout}
 * so a wedged child can't hang the daemon.
 *
 * Commit identity (project convention): plain commit using whatever the repo is configured with — NO
 * `-c user.email/user.name` overrides, NO Co-Authored-By trailer, no personal identity injected. The UI
 * supplies only a commit message.
 */
export class GitWriter {
  private repoPath: string;
  private readonly localMs: number;
  private readonly pushMs: number;
  /**
   * `opts` (the gateway passes the resolved `platform.timeouts.gitLocalMs`/`gitPushMs`) override the
   * module-const defaults; absent → the consts (today's behavior, e.g. the 1-arg test constructor).
   * Each is FLOORED to GIT_TIMEOUT_FLOOR_MS so a sub-second misconfig can't make every git write fail-fast.
   */
  constructor(repoPath: string, opts?: { gitLocalMs?: number; gitPushMs?: number }) {
    this.repoPath = repoPath;
    this.localMs = Math.max(GIT_TIMEOUT_FLOOR_MS, opts?.gitLocalMs ?? GIT_LOCAL_TIMEOUT_MS);
    this.pushMs = Math.max(GIT_TIMEOUT_FLOOR_MS, opts?.gitPushMs ?? GIT_PUSH_TIMEOUT_MS);
  }

  /** A simpleGit bound to this repo with a kill-the-hung-child block timeout + the non-interactive env. */
  private git(blockMs: number): SimpleGit {
    return simpleGit(this.repoPath, { timeout: { block: blockMs } }).env(nonInteractiveEnv());
  }

  /** Switch to an EXISTING local branch. Fails (structured) on an unknown branch or a dirty tree that
   *  would be overwritten — git's own message is surfaced for the UI. */
  async checkout(branch: string): Promise<GitWriteResult<{ branch: string }>> {
    if (!branch?.trim()) return { ok: false, error: "branch name required" };
    try {
      const git = this.git(this.localMs);
      await withTimeout(git.checkout(branch.trim()), this.localMs, "git checkout");
      const current = (await git.branchLocal()).current;
      return { ok: true, branch: current };
    } catch (e) {
      return { ok: false, error: gitError(e) };
    }
  }

  /** Create a NEW local branch off the current HEAD and switch to it (`checkout -b`). Fails (structured)
   *  if the branch already exists or the name is invalid. Does NOT touch any remote. */
  async createBranch(name: string): Promise<GitWriteResult<{ branch: string }>> {
    if (!name?.trim()) return { ok: false, error: "branch name required" };
    try {
      const git = this.git(this.localMs);
      await withTimeout(git.checkoutLocalBranch(name.trim()), this.localMs, "git checkout -b");
      return { ok: true, branch: name.trim() };
    } catch (e) {
      return { ok: false, error: gitError(e) };
    }
  }

  /** Stage ALL changes (`add -A`) and commit with the UI-supplied message. Returns the new commit hash.
   *  A clean tree is an EXPECTED no-op failure ("nothing to commit") — surfaced, not thrown. Identity is
   *  the repo's configured user (no overrides, no trailer). */
  async commit(message: string): Promise<GitWriteResult<{ hash: string }>> {
    if (!message?.trim()) return { ok: false, error: "commit message required" };
    try {
      const git = this.git(this.localMs);
      // Nothing staged AND nothing to stage → don't even attempt the commit (git would exit 1).
      const status = await withTimeout(git.status(), this.localMs, "git status");
      if (status.isClean()) return { ok: false, error: "nothing to commit (working tree clean)" };
      await withTimeout(git.raw(["add", "-A"]), this.localMs, "git add -A");
      const res = await withTimeout(git.commit(message.trim()), this.localMs, "git commit");
      const hash = res.commit || (await git.revparse(["HEAD"])).trim();
      return { ok: true, hash };
    } catch (e) {
      return { ok: false, error: gitError(e) };
    }
  }

  /**
   * Push the current branch to its remote. A plain `git push` is tried first (respecting whatever
   * tracking remote the branch already has). If that fails ONLY because the branch has no upstream —
   * the case for a branch just made with the UI "+ Branch" button — we publish it with
   * `git push -u origin <branch>`, setting tracking to origin/<branch>. Any OTHER push failure
   * (unreachable remote, auth required, rejected) is surfaced unchanged — we never retry past a real
   * remote error. Non-interactive + bounded throughout: a push to an unreachable/auth-required remote
   * FAILS FAST (GIT_TERMINAL_PROMPT=0 + the timeout) rather than hanging the daemon — the set-upstream
   * retry runs under the same guards.
   */
  async push(): Promise<GitWriteResult<{ branch: string }>> {
    try {
      const git = this.git(this.pushMs);
      const branch = (await git.branchLocal()).current;
      try {
        await withTimeout(git.raw(["push"]), this.pushMs, "git push");
      } catch (e) {
        if (!isNoUpstreamError(e)) throw e;
        await withTimeout(
          git.raw(["push", "-u", "origin", branch]),
          this.pushMs,
          "git push -u origin",
        );
      }
      return { ok: true, branch };
    } catch (e) {
      return { ok: false, error: gitError(e) };
    }
  }
}
