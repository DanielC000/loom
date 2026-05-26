import { simpleGit, type SimpleGit } from "simple-git";

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
