/**
 * PL Auditor finding #8 — inject a small "Where things live" context block (the project's absolute
 * `repoPath` + `vaultPath`) into a MANAGER session's startup prompt at spawn. A cold-boot orchestrator
 * otherwise can't construct its resume-doc path (the daemon knows the vault root, but never tells the
 * agent) and Globs for it — a broad Glob from the user's home hits the 20s ripgrep cap.
 *
 * The block is a PRE-block (context first, then the agent's own doctrine/kickoff) — mirrors how
 * `composeRunStartupPrompt` wraps a run's doctrine + input. PURE + exported so the hermetic test can
 * assert the composition. MANAGERS ONLY (lowest blast radius): only `startManager` calls this, so
 * every worker/run/plain/platform/auditor spawn byte-stream is unchanged.
 *
 * The block gives the two absolute ROOTS only; the resume-doc path (`<vaultRoot>/Projects/<Project>/
 * Orchestrator Log.md`) is DERIVED in the pickup/orchestrate skills, which read the vault root from
 * this block — keeps the daemon generic (no project-name coupling) and the doc convention in the skill.
 */
export function composeManagerStartupPrompt(
  startupPrompt: string | undefined,
  loc: { repoPath: string; vaultPath: string },
): string {
  const block =
    "## Where things live (this project's absolute paths)\n" +
    `- **Repo root (your cwd):** \`${loc.repoPath}\`\n` +
    `- **Vault root:** \`${loc.vaultPath}\`\n\n` +
    "Read project files by ABSOLUTE path from these roots — never Glob from your home directory " +
    "for them (a broad Glob hits the search timeout). Your resume doc, in particular, lives under the " +
    "vault root (see your pickup/orchestrate skill for the exact path).";
  const own = startupPrompt?.trim();
  return own ? `${block}\n\n${own}` : block;
}
