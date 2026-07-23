import fs from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import {
  recordGitPushOutcome,
  pauseVaultAutoCommit,
  resumeVaultAutoCommit,
  DEFAULT_MAX_VAULT_FILE_BYTES,
  humanBytes,
} from "../vault/versioner.js";
import { withCanonicalIndexLock } from "./repo-lock.js";

// The WRITE side of the project git view — sibling to reader.ts (which stays read-only introspection).
// Like the vault writer (vault/writer.ts) and gateCommand, git writes are a TRUST-BOUNDARY surface:
// checkout/commit and ESPECIALLY push (outward-facing, network, irreversible) are reachable from the
// human REST path AND — as a deliberate, role-gated trust elevation (Platform Manager P3) — from the
// PLATFORM MCP, whose tools are gated strictly to role==="platform" (the human-equivalent Lead, a
// human-created-only session). NO git-write tool is exposed on the loom-tasks or orchestration
// (manager/worker) MCP servers — an ordinary agent must never checkout/commit/push. The platform tools
// REUSE this class verbatim, so its bounds/timeouts/identity guarantees hold there too. The REST
// endpoints in gateway/server.ts and the platform git tools in mcp/platform.ts call into here.

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
 *  - LC_ALL=C / LANG=C — pin git's locale so its stderr is stable ENGLISH. We MACHINE-READ git's error
 *    text ({@link isNoUpstreamError} matches "no upstream"/"no configured push destination") to decide
 *    the no-upstream `push -u` retry; on a host with a non-English git locale git emits localized text,
 *    the substring match misses, and the UI "+ Branch" first push fails confusingly. LC_ALL wins over
 *    any inherited LANG/LC_* so the detection holds regardless of the host locale.
 * We deliberately do NOT set GIT_ASKPASS/SSH_ASKPASS: simple-git's injection guard refuses to run with
 * those in a supplied env (they're an arbitrary-command vector) and disabling that guard is the wrong
 * trade for a trust-boundary surface. The residual GUI-askpass hang risk is covered by the
 * {@link withTimeout} race below — the hard backstop regardless of env: even a never-settling git
 * promise unblocks the caller within the op's budget.
 */
const NONINTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  LC_ALL: "C",
  LANG: "C",
};

/**
 * The child env for a git write: the inherited env (git needs PATH/HOME/etc.) MINUS the editor/pager/
 * diff vars, PLUS {@link NONINTERACTIVE_ENV}. simple-git ships a `blockUnsafeOperationsPlugin` (via
 * `@simple-git/argv-parser`'s `vulnerabilityCheck`) that throws if ANY of a fixed list of env vars is
 * present in the supplied env, unless the matching `unsafe.allow*` flag is explicitly set — each entry
 * below is one of those categories, decided on the SAME two-part test the original `GIT_EDITOR`/
 * `GIT_SEQUENCE_EDITOR` strip used: (1) could a real host/session ambiently carry it, and (2) would any
 * op in this file (log/branches/show/checkout/commit/push — all captured stdio, never a real TTY) ever
 * legitimately need it.
 *
 * STRIPPED (both tests say yes — a leftover value could only cause an unwanted 500, never a needed
 * effect, so removing it is pure upside):
 *  - GIT_EDITOR / GIT_SEQUENCE_EDITOR — original strip: no op here ever opens an editor (commit uses
 *    `-m`, no interactive rebase).
 *  - EDITOR — the bare (non-`GIT_`) form is its OWN separate vulnerability category and a VERY common
 *    ambient shell export (`export EDITOR=vim`); missed by the original strip, which only covered the
 *    `GIT_`-prefixed pair.
 *  - GIT_PAGER / PAGER — THE bug this comment block exists to fix: card 42544916 proved every git
 *    read/write 500s once either is set. This repo's OWN worker/session spawn recipe sets both as an
 *    anti-pager backstop (see root CLAUDE.md), so every Loom session was silently poisoned; a real user
 *    with either set in their shell profile hits the identical 500. None of these ops ever page (piped
 *    stdio, not a TTY) — stripping changes nothing about the data returned.
 *  - GIT_EXTERNAL_DIFF — same family as PAGER: `show()` runs a diff-producing `git show`, and if a
 *    custom external diff were allowed through it would replace git's parseable diff text with an
 *    arbitrary tool's own output, breaking the caller's expected format. Stripping is correctness, not
 *    just safety, for that path (currently unwired to any REST route, but part of this shared env's
 *    contract regardless).
 *
 * DELIBERATELY LEFT BLOCKED (simple-git's guard staying active is the intended behavior, not a gap):
 *  - GIT_ASKPASS / SSH_ASKPASS — pre-existing decision (see {@link NONINTERACTIVE_ENV}'s comment):
 *    genuinely reachable ambiently (e.g. VS Code's integrated terminal sets `GIT_ASKPASS` for its own
 *    Git extension), but bypassing the guard is an arbitrary-command vector during a real auth prompt —
 *    the wrong trade for this trust-boundary surface. Left as-is; this comment doesn't reopen it.
 *  - GIT_SSH / GIT_SSH_COMMAND — same trust class as ASKPASS: plausibly ambient (devs pin a custom
 *    identity file via `GIT_SSH_COMMAND`), but it names an arbitrary program git will exec in place of
 *    `ssh` for the real network transport `push()` uses — bypassing it is the same class of risk as
 *    bypassing ASKPASS, so it stays blocked rather than silently honored.
 *  - GIT_PROXY_COMMAND — same reasoning: a corporate proxy setup could plausibly export this, but it
 *    too names an arbitrary program git execs for the connection; left blocked rather than trusted.
 *
 * CHECKED, NOT REALISTICALLY REACHABLE (left unhandled — not because bypassing would be unsafe, but
 * because no ordinary shell profile or IDE integration plausibly exports these, unlike EDITOR/PAGER):
 *  - GIT_CONFIG / GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM / GIT_CONFIG_COUNT — git's env-based config
 *    injection mechanism; a script-authored convention, not an ambient shell export.
 *  - GIT_EXEC_PATH — only meaningful when pointing git at a nonstandard build of its own subcommands.
 *  - GIT_TEMPLATE_DIR — only affects `git init`, which no op in this file invokes.
 *  - PREFIX — an install-prefix convention (e.g. Termux), not a general dev-shell export.
 * If any of these turn out to be reachable in practice, they hit the exact same 500 this file already
 * proved GIT_PAGER causes — treat a report of one as confirmation to move it into the STRIPPED list
 * above, not a reason to relitigate the categories left blocked deliberately.
 */
export function nonInteractiveEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.GIT_EDITOR;
  delete env.GIT_SEQUENCE_EDITOR;
  delete env.EDITOR;
  delete env.GIT_PAGER;
  delete env.PAGER;
  delete env.GIT_EXTERNAL_DIFF;
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

/** First line of a git/simple-git error — the human-readable reason (dirty tree, no upstream, etc.).
 *  Exported so the READ side (gateway/server.ts's git/log, git/branches, and the reference/registered
 *  repo log routes) can surface the same clean, cause-naming message on a genuine failure instead of
 *  fastify's generic default-error-handler body — one helper, so the two sides can't drift apart. */
export function gitError(e: unknown): string {
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

/** A GitHub noreply commit identity — correct for github.com repos, unroutable anywhere else. */
const GITHUB_NOREPLY_SUFFIX = "@users.noreply.github.com";

/**
 * Extract the bare host from an `origin` URL across the forms git emits — scheme URLs
 * (`https://github.com/o/r.git`, `ssh://git@host:22/o/r`) and the scp-like shorthand
 * (`git@github.com:o/r.git`). Returns the lowercased host, or null if it can't be parsed (→ no warning).
 * Exported so the bind-time identity assert (git/reader.ts) reuses the SAME host parser.
 */
export function originHost(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  // scp-like shorthand: [user@]host:path  (no scheme, a colon before the first slash)
  const scp = /^(?:[^@/]+@)?([^:/]+):/.exec(u);
  if (scp?.[1] && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return scp[1].toLowerCase();
  // scheme://[user@]host[:port]/path
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^:/]+)/i.exec(u);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** github.com or any subdomain of it (gist.github.com, …) — vs. any self-hosted forge. */
function isGithubHost(host: string): boolean {
  return host === "github.com" || host.endsWith(".github.com");
}

/**
 * The PURE GitHub-vs-self-hosted (Forgejo/Gitea/GitLab) host rule, single-sourced so the push-time
 * {@link GitWriter.identityWarning} and the bind-time identity assert ({@link checkCommitIdentity}) can
 * never diverge. Given an origin `host` (or null when there's no remote / it didn't parse) and a commit
 * `email` (or null), returns a non-blocking advisory when the identity is wrong for the host:
 *  - self-hosted origin carrying a `@users.noreply.github.com` identity → unroutable there; OR
 *  - GitHub origin carrying a real (non-noreply) address → a leakable email is being published.
 * Otherwise (no host, no email, or an appropriate pairing) returns undefined — never a throw.
 */
export function commitIdentityHostWarning(host: string | null, email: string | null): string | undefined {
  if (!host || !email) return undefined;
  const e = email.trim().toLowerCase();
  if (!e) return undefined;
  const github = isGithubHost(host);
  const noreply = e.endsWith(GITHUB_NOREPLY_SUFFIX);
  if (!github && noreply) {
    return `Commit identity ${e} is a GitHub noreply address, but origin (${host}) is self-hosted — this email is unroutable there. Consider a real identity for this remote.`;
  }
  if (github && !noreply) {
    return `Commit identity ${e} is a real address being published to GitHub (${host}) — consider a @users.noreply.github.com identity to avoid leaking it.`;
  }
  return undefined;
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

  /**
   * Hold the vault auto-committer's advisory pause lease (card 614dfbef) for the duration of one
   * git-surgery op on `this.repoPath`, so a checkout/commit/push issued through THIS writer can never
   * race a `VaultVersioner` background auto-commit mid-sequence — the exact race the origin finding
   * (4ae8a3c9) hit by hand. Harmless when `repoPath` isn't a watched vault root: the lease is just an
   * unused file under its own `.git/` that nothing reads. Always resumes in `finally`, so a lease is
   * never left held past this call even if `fn` throws (its own timeout ceiling is a self-healing
   * backstop regardless).
   *
   * **Per-op token (card 237d1899):** the lease is a single shared file, not ref-counted, and every
   * surface that writes (REST, Platform, companion git-push) constructs its own `new GitWriter(repoPath)`
   * with no cross-surface mutex — so two ops on the same repo CAN overlap. Without a token, op A's
   * `finally` would unconditionally `rm` the lease file, un-protecting op B mid-flight even though B is
   * still running. Threading THIS call's own token through to `resumeVaultAutoCommit` makes the resume
   * "mine-only": if B re-paused (writing a new token) before A's `finally` runs, A's resume no-ops and
   * B's lease survives until B resumes it (or the TTL expires). Low-severity even before this fix — see
   * the card body — but now closed rather than merely self-healing.
   */
  private async withVaultPauseLease<T>(fn: () => Promise<T>): Promise<T> {
    const pauseToken = pauseVaultAutoCommit(this.repoPath);
    try {
      return await fn();
    } finally {
      resumeVaultAutoCommit(this.repoPath, pauseToken);
    }
  }

  /**
   * Switch to an EXISTING local branch. Fails (structured) on an unknown branch or a dirty tree that
   * would be overwritten — git's own message is surfaced for the UI.
   *
   * **Admitted through {@link withCanonicalIndexLock} (card e41dbb58):** a checkout mutates the SAME
   * canonical working tree/index `mergeBranchLocked` (git/worktrees.ts) squash-merges against — without
   * this, a checkout interleaved mid-merge could switch branches out from under an in-progress squash, or
   * itself get silently clobbered by one. See that lock's own doc for the full corruption history and why
   * this is safe from deadlock (this method never runs while a merge already holds the lock, because
   * nothing on the merge path calls into `GitWriter`).
   */
  async checkout(branch: string): Promise<GitWriteResult<{ branch: string }>> {
    if (!branch?.trim()) return { ok: false, error: "branch name required" };
    return this.withVaultPauseLease(() =>
      withCanonicalIndexLock(this.repoPath, async () => {
        try {
          const git = this.git(this.localMs);
          await withTimeout(git.checkout(branch.trim()), this.localMs, "git checkout");
          const current = (await git.branchLocal()).current;
          return { ok: true, branch: current };
        } catch (e) {
          return { ok: false, error: gitError(e) };
        }
      }),
    );
  }

  /**
   * Create a NEW local branch off the current HEAD and switch to it (`checkout -b`). Fails (structured)
   * if the branch already exists or the name is invalid. Does NOT touch any remote.
   *
   * **Admitted through {@link withCanonicalIndexLock} (card e41dbb58):** `checkout -b` moves canonical
   * HEAD to a brand-new branch ref pointing at the SAME commit — git raises no conflict even with a
   * staged-but-uncommitted diff sitting in the index (verified directly: `git checkout -b` carries staged
   * content forward onto the new branch unchanged). If this landed mid-merge — after `mergeBranchLocked`
   * (git/worktrees.ts) has staged its squash but before its own `git commit` runs — the squash would
   * commit onto the FRESHLY-CREATED branch instead of the mainline: the mainline branch silently never
   * receives the work, while `mergeBranchLocked` still reads `git rev-parse HEAD` and reports
   * `{ok:true, sha, subject}` — a false success pointing at a sha that isn't even reachable from the
   * branch it thinks it merged onto. Same corruption family as `commit()`/`checkout()` above.
   */
  async createBranch(name: string): Promise<GitWriteResult<{ branch: string }>> {
    if (!name?.trim()) return { ok: false, error: "branch name required" };
    return this.withVaultPauseLease(() =>
      withCanonicalIndexLock(this.repoPath, async () => {
        try {
          const git = this.git(this.localMs);
          await withTimeout(git.checkoutLocalBranch(name.trim()), this.localMs, "git checkout -b");
          return { ok: true, branch: name.trim() };
        } catch (e) {
          return { ok: false, error: gitError(e) };
        }
      }),
    );
  }

  /**
   * Stage ALL changes (`add -A`) and commit with the UI-supplied message. Returns the new commit hash.
   * A clean tree is an EXPECTED no-op failure ("nothing to commit") — surfaced, not thrown. Identity is
   * the repo's configured user (no overrides, no trailer).
   *
   * **Oversized-staged-file WARNING, not a refusal (card 237d1899, decision on finding 2 of 614dfbef's
   * CR):** `vault/versioner.ts`'s `commitVault` silently unstages a staged file above
   * {@link DEFAULT_MAX_VAULT_FILE_BYTES} (~95MB) before committing — correct THERE because that path is
   * fully automatic/unattended (no human in the loop, so overriding silently is the safe default). This
   * method is instead a DELIBERATE act by a human or agent on the project's code repo — silently
   * unstaging (or refusing outright) would override an intent that may be entirely legitimate (a large
   * asset the repo genuinely wants tracked). So this path commits the file as asked, but surfaces a
   * non-blocking `warning` on the result when a staged file exceeds the SAME shared threshold — enough
   * signal that a human/agent isn't blindsided by a push later wedging on a remote's object-size limit
   * (e.g. GitHub's 100MB hard cap), without taking the choice out of their hands. Detection is
   * best-effort (a stat failure just skips that file) and never blocks the commit itself.
   *
   * `opts.maxFileBytes` overrides the shared default — a TEST seam only (mirrors `commitVault`'s own
   * `opts.maxFileBytes`: writing a real ~95MB fixture per test run would be slow and wasteful). Every
   * real caller omits it and gets {@link DEFAULT_MAX_VAULT_FILE_BYTES}.
   *
   * **Admitted through {@link withCanonicalIndexLock} (card e41dbb58):** `git add -A` + `git commit`
   * stage and commit whatever is CURRENTLY in the canonical repo's shared index/working tree — the SAME
   * resource `mergeBranchLocked` (git/worktrees.ts) squash-merges against. Before this, a commit()
   * interleaved with an in-progress merge could land the merge's own staged squash under THIS message
   * with no `Loom-Worker-Branch` trailer (see `test/merge-writer-index-lock.mjs` for the reproduction).
   * The lock makes this call queue behind an in-flight merge (or vice versa) instead of racing it.
   */
  async commit(
    message: string,
    opts?: { maxFileBytes?: number },
  ): Promise<GitWriteResult<{ hash: string; warning?: string }>> {
    if (!message?.trim()) return { ok: false, error: "commit message required" };
    const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_VAULT_FILE_BYTES;
    return this.withVaultPauseLease(() =>
      withCanonicalIndexLock(this.repoPath, async () => {
        try {
          const git = this.git(this.localMs);
          // Nothing staged AND nothing to stage → don't even attempt the commit (git would exit 1).
          const status = await withTimeout(git.status(), this.localMs, "git status");
          if (status.isClean()) return { ok: false, error: "nothing to commit (working tree clean)" };
          await withTimeout(git.raw(["add", "-A"]), this.localMs, "git add -A");
          const staged = await withTimeout(git.status(), this.localMs, "git status (post-add)");
          const warning = this.oversizedStagedWarning(staged.files, maxFileBytes);
          const res = await withTimeout(git.commit(message.trim()), this.localMs, "git commit");
          const hash = res.commit || (await git.revparse(["HEAD"])).trim();
          return warning ? { ok: true, hash, warning } : { ok: true, hash };
        } catch (e) {
          return { ok: false, error: gitError(e) };
        }
      }),
    );
  }

  /** A human-readable warning naming any staged (non-deletion) file over `maxFileBytes`, or `undefined`
   *  if none — see {@link commit}'s doc for why this path warns instead of unstaging. */
  private oversizedStagedWarning(
    files: Array<{ path: string; working_dir: string; index: string }>,
    maxFileBytes: number,
  ): string | undefined {
    const oversized: string[] = [];
    for (const f of files) {
      if (f.working_dir === "D" || f.index === "D") continue; // deletion — nothing to stat
      let size: number;
      try { size = fs.statSync(path.join(this.repoPath, f.path)).size; } catch { continue; }
      if (size > maxFileBytes) oversized.push(`${f.path} (${humanBytes(size)})`);
    }
    if (!oversized.length) return undefined;
    return `Staged file(s) exceed ${humanBytes(maxFileBytes)}: ${oversized.join(", ")} — ` +
      `this may be rejected by a remote with an object-size limit (e.g. GitHub's 100MB hard cap).`;
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
   *
   * On success we ALSO surface a non-blocking {@link identityWarning} (commit-identity vs. remote-host
   * mismatch) so the human who just published sees if their email is wrong for this remote. It never
   * blocks the push and a detection failure is silently swallowed — see {@link identityWarning}.
   *
   * **Durably records the outcome** (card 614dfbef, origin finding 4ae8a3c9) via
   * `vault/versioner.ts`'s `recordGitPushOutcome` — the ONE chokepoint every real pusher (this class,
   * reached from the REST git-write surface, the Platform MCP, and the companion `git-push` capability)
   * routes through, so a rejecting remote (e.g. GitHub's >100MB blob hard-limit) is durably known instead
   * of only discoverable by an agent doing forensics after the fact. A vault's periodic push-status log
   * (`logVaultPushStatus`/`VaultPushStatusWatcher`) surfaces a recorded failure the next time it ticks.
   */
  async push(): Promise<GitWriteResult<{ branch: string; warning?: string }>> {
    return this.withVaultPauseLease(async () => {
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
        recordGitPushOutcome(this.repoPath, { ok: true });
        const warning = await this.identityWarning(git);
        return warning ? { ok: true, branch, warning } : { ok: true, branch };
      } catch (e) {
        const error = gitError(e);
        recordGitPushOutcome(this.repoPath, { ok: false, error });
        return { ok: false, error };
      }
    });
  }

  /**
   * Heuristic, NO hardcoded owner email: compare the remote HOST (`git remote get-url origin`) against
   * the email on HEAD (the identity actually being published) and warn on a mismatch —
   *  - self-hosted origin (non-GitHub) carrying a `@users.noreply.github.com` identity → the email is
   *    unroutable on that forge; OR
   *  - GitHub origin carrying a real (non-noreply) address → a leakable email is being published.
   * FAIL-SAFE BY CONSTRUCTION: any detection error (no origin, no commits, parse miss) returns
   * `undefined` — never a throw, never blocks the push. Bounded by the local-op timeout like every read here.
   */
  private async identityWarning(git: SimpleGit): Promise<string | undefined> {
    try {
      const originUrl = (await withTimeout(git.raw(["remote", "get-url", "origin"]), this.localMs, "git remote get-url")).trim();
      const host = originHost(originUrl);
      if (!host) return undefined;
      const email = (await withTimeout(git.raw(["log", "-1", "--pretty=%ae"]), this.localMs, "git log identity")).trim().toLowerCase();
      if (!email) return undefined;
      return commitIdentityHostWarning(host, email);
    } catch {
      return undefined; // detection must NEVER block or fail the push
    }
  }

  /**
   * Read-only preview of what a `push()` call would publish — the current branch, how many local
   * commits sit ahead of its upstream tracking ref (null if unresolvable, e.g. no upstream configured
   * yet — a first push), and the SUBJECT (first line only) of the most recent commit. Built for a
   * confirm-prompt's BOUNDED disclosure (the companion `git-push` lever): a vault repo can sit hundreds
   * of commits ahead of its remote, so a caller shows "N ahead, latest: …", never a full log dump.
   * NEVER throws — returns `null` on any read failure (no repo, no commits, git error), mirroring
   * `identityWarning`'s own fail-safe posture; a caller degrades to a generic confirm text rather than
   * blocking on preview detail. Read-only + bounded like `vault/versioner.ts`'s `checkVaultPushStatus`
   * (the analogous helper for a project's vault repo) — this is the project CODE repo's own version.
   */
  async pendingPushSummary(): Promise<{ branch: string; ahead: number | null; latestSubject: string | null } | null> {
    try {
      const git = this.git(this.localMs);
      const branch = (await withTimeout(git.branchLocal(), this.localMs, "git branch")).current;
      if (!branch) return null;
      let ahead: number | null = null;
      try {
        const upstream = (await withTimeout(
          git.raw(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]), this.localMs, "git rev-parse @{u}",
        )).trim();
        if (upstream) {
          const count = parseInt(
            (await withTimeout(git.raw(["rev-list", "--count", `${upstream}..HEAD`]), this.localMs, "git rev-list --count")).trim(), 10,
          );
          if (Number.isFinite(count)) ahead = count;
        }
      } catch { /* no upstream configured yet (a first push) — ahead stays null, still a valid summary */ }
      let latestSubject: string | null = null;
      try {
        latestSubject = (await withTimeout(git.raw(["log", "-1", "--pretty=%s"]), this.localMs, "git log subject")).trim() || null;
      } catch { /* no commits yet */ }
      return { branch, ahead, latestSubject };
    } catch {
      return null;
    }
  }
}
