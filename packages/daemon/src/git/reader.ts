import fs from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";
import { originHost, commitIdentityHostWarning, nonInteractiveEnv } from "./writer.js";

/**
 * Guardrail for AI-driven project creation (Pillar C): is `repoPath` an existing directory that is
 * a git repo? False (never throws) on a missing path, a file, a non-repo dir, or any git error —
 * so project_create can reject before binding a project to a bad repo.
 */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    if (!repoPath || !fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) return false;
    return await simpleGit(repoPath).checkIsRepo();
  } catch {
    return false;
  }
}

/** The result of asserting a commit identity at project bind (see {@link checkCommitIdentity}). */
export interface CommitIdentityResult {
  /** Both user.name AND user.email resolve (from any scope: local/global/system) — a commit won't fail. */
  resolvable: boolean;
  name: string | null;
  email: string | null;
  /** NON-blocking advisory: identity missing/partial, OR present but inappropriate for the origin host. */
  warning?: string;
}

/**
 * Assert a RESOLVABLE commit identity for a CODE repo being bound, so a later worker/merge commit
 * doesn't fail ("Please tell me who you are") or land with a host-inappropriate identity. Reads the
 * repo's effective `user.name`/`user.email` (any scope, via simple-git's getConfig — honours the
 * local→global→system hierarchy) and, when an `origin` remote exists, applies the SAME
 * GitHub-vs-self-hosted/Forgejo host rule the push-time warning uses ({@link commitIdentityHostWarning})
 * — find-and-reuse, no second host-classification scheme.
 *
 * BEST-EFFORT + NEVER throws — binding never fails on this. A non-repo / git error yields
 * `resolvable:false` with a warning, never an exception; a missing identity is surfaced as a warning
 * (NOT a hard reject) mirroring the writer's non-blocking identity posture, so a repo with no configured
 * identity still binds while the gap is made visible up front instead of at the first worker merge.
 */
export async function checkCommitIdentity(repoPath: string): Promise<CommitIdentityResult> {
  try {
    const git = simpleGit(repoPath);
    const name = (await git.getConfig("user.name")).value?.trim() || null;
    const email = (await git.getConfig("user.email")).value?.trim() || null;
    let host: string | null = null;
    try {
      host = originHost((await git.raw(["remote", "get-url", "origin"])).trim());
    } catch { /* no origin remote — the host rule simply doesn't apply (resolvability still checked) */ }
    if (!name || !email) {
      return {
        resolvable: false, name, email,
        warning: "no commit identity is configured for this repository (git user.name / user.email) — commits here will fail until one is set.",
      };
    }
    const warning = commitIdentityHostWarning(host, email);
    return warning ? { resolvable: true, name, email, warning } : { resolvable: true, name, email };
  } catch {
    return { resolvable: false, name: null, email: null, warning: "could not resolve a commit identity for this repository (not a git repo, or git is unavailable)." };
  }
}

/**
 * `git log` on a commitless repo (e.g. straight out of `git init`, or a freshly-provisioned
 * `project_init` home) fails with a recognizable message — NOT a generic git error. Matched by
 * message content (simple-git's `GitError` carries no distinct subclass for this case), narrowly, so a
 * genuine git failure (corrupt repo, permissions, missing binary) still throws and surfaces as an error
 * instead of being silently swallowed into an empty log. This is a FALLBACK behind the structural
 * `git rev-parse --quiet --verify HEAD` check in {@link GitReader.log} below — kept as defence in depth
 * (a git version/behavior we haven't foreseen), not the primary signal, because message text is
 * locale-dependent (see the LC_ALL/LANG pin on {@link GitReader}'s git instance, which keeps this
 * fallback reachable at all on a non-English host — without the pin this match silently misses there).
 */
function isCommitlessRepoLogError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /does not have any commits yet/i.test(message) || /ambiguous argument ['"]?HEAD['"]?/i.test(message);
}

/** Read-only git introspection for the project repo view (§ no commit/checkout/push in phase 1). */
export class GitReader {
  private git: SimpleGit;
  constructor(repoPath: string) {
    // Pin git's locale the SAME way writer.ts's NONINTERACTIVE_ENV does (see its comment at
    // writer.ts:45-49): we machine-read git's stderr below (the commitless-repo fallback match), and on
    // a non-English host an unpinned locale makes that substring match silently miss — the exact 500
    // this class exists to prevent, just reintroduced by locale. LC_ALL=C/LANG=C is a shared convention
    // across every git invocation in this file that reads stderr, not a one-off copy here.
    this.git = simpleGit(repoPath).env(nonInteractiveEnv());
  }

  async log(limit = 50) {
    // Structural, locale-independent primary check: HEAD resolves to a commit once (and only once)
    // the repo has one. `--quiet` suppresses stderr on failure, so there's no text to parse — this
    // holds regardless of the host's git locale, unlike the message-match fallback below.
    let headResolves = true;
    try {
      await this.git.revparse(["--quiet", "--verify", "HEAD"]);
    } catch {
      headResolves = false;
    }
    if (!headResolves) {
      // HEAD doesn't resolve. Confirm this is still a genuine, valid repo (not e.g. a since-moved or
      // deleted path) before treating it as commitless — a repo that isn't a repo at all must still
      // surface as an error, never be silently treated as an empty log.
      const stillARepo = await this.git.checkIsRepo().catch(() => false);
      if (stillARepo) return [];
    }
    try {
      const l = await this.git.log({ maxCount: limit });
      return l.all.map((c) => ({ hash: c.hash, date: c.date, message: c.message, author: c.author_name }));
    } catch (err) {
      // A commitless repo is a valid, expected state (e.g. project_init's brand-new `git init` — zero
      // commits by construction) — not an error. Return an empty log so the UI renders an honest
      // "no commits yet" empty state instead of a 500. (Reached only if the structural check above
      // somehow missed it — e.g. HEAD resolved but `log` still failed this specific way.)
      if (isCommitlessRepoLogError(err)) return [];
      throw err;
    }
  }

  async branches() {
    const b = await this.git.branchLocal();
    return { current: b.current, all: b.all };
  }

  async show(ref: string): Promise<string> {
    return this.git.show([ref]);
  }
}
