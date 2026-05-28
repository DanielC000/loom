import fs from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";

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
