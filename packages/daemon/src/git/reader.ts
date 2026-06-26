import fs from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";
import { originHost, commitIdentityHostWarning } from "./writer.js";

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

/** Read-only git introspection for the project repo view (§ no commit/checkout/push in phase 1). */
export class GitReader {
  private git: SimpleGit;
  constructor(repoPath: string) {
    this.git = simpleGit(repoPath);
  }

  async log(limit = 50) {
    const l = await this.git.log({ maxCount: limit });
    return l.all.map((c) => ({ hash: c.hash, date: c.date, message: c.message, author: c.author_name }));
  }

  async branches() {
    const b = await this.git.branchLocal();
    return { current: b.current, all: b.all };
  }

  async show(ref: string): Promise<string> {
    return this.git.show([ref]);
  }
}
