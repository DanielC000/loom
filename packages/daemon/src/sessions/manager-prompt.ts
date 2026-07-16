import path from "node:path";

/**
 * PL Auditor finding #8 — inject a small "Where things live" context block (the project's absolute
 * `repoPath` + `vaultPath`, PLUS the fully-resolved resume-doc path) into a MANAGER session's startup
 * prompt at spawn. A cold-boot orchestrator otherwise can't construct its resume-doc path (the daemon
 * knows the vault root, but never tells the agent) and Globs for it — a broad Glob from the user's home
 * hits the 20s ripgrep cap.
 *
 * The block is a PRE-block (context first, then the agent's own doctrine/kickoff) — mirrors how
 * `composeRunStartupPrompt` wraps a run's doctrine + input. PURE + exported so the hermetic test can
 * assert the composition. MANAGERS ONLY (lowest blast radius): only `startManager` calls this, so
 * every worker/run/plain/platform/auditor spawn byte-stream is unchanged.
 *
 * The block emits the resume doc as a FULLY-RESOLVED absolute path, built SERVER-SIDE from the resolved
 * `vaultPath` via the SAME `path.join` the daemon uses for the vault (so a vault folder with a SPACE —
 * `Obsidian Vault`, not `Obsidian\Vault` — resolves correctly). `vaultPath` IS the project's vault
 * directory (e.g. `.../Obsidian Vault/Projects/Loom`) — NOT the vault root — so the resume doc is just
 * `vaultPath/Orchestrator Log.md`. The agent Reads it verbatim with zero derivation, instead of
 * reconstructing the path from memory and mis-spelling the vault root (the bug that drove the forbidden
 * Glob fallback).
 */
export function composeManagerStartupPrompt(
  startupPrompt: string | undefined,
  loc: { repoPath: string; vaultPath: string; name: string; referenceRepos?: string[] },
): string {
  // Same path-join the daemon uses for the vault (handles spaces correctly — no string concatenation).
  const resumeDoc = path.join(loc.vaultPath, "Orchestrator Log.md");
  const block =
    "## Where things live (this project's absolute paths)\n" +
    `- **Repo root (your cwd):** \`${loc.repoPath}\`\n` +
    `- **Project vault dir:** \`${loc.vaultPath}\`\n` +
    `- **Resume doc:** \`${resumeDoc}\`\n\n` +
    "Read project files by ABSOLUTE path from these roots — never Glob from your home directory " +
    "for them (a broad Glob hits the search timeout). Read your resume doc from the exact absolute " +
    "path above, verbatim — do not reconstruct it.";
  // Reference-repos epic Phase 3 ("Interpretation A"): additional repos this project's manager may
  // READ but never owns — no worktree/branch/gate exists for them, so they're never a cwd or a merge
  // target. Omitted entirely when the project sets none, so the additive guarantee holds.
  const refs = loc.referenceRepos?.filter((r) => r.trim());
  const refBlock = refs && refs.length > 0
    ? "\n\n**Also referenced (read-only, not your cwd):**\n" +
      refs.map((r) => `- \`${r}\``).join("\n") +
      "\n\nYou may read/inspect these repos, but never commit there — there is no worktree, branch, " +
      "or gate for a reference repo. If a task turns out to need changes IN a reference repo, that's " +
      "out of scope here; surface it instead of committing there."
    : "";
  const full = block + refBlock;
  const own = startupPrompt?.trim();
  return own ? `${full}\n\n${own}` : full;
}

/**
 * Append an OPTIONAL per-schedule custom prompt to a session's already-composed startupPrompt, as a
 * clearly-delimited trailing block — never precedes or clobbers the agent's own identity/doctrine (or,
 * for a manager, the "Where things live" pre-block above). Applies uniformly to every schedule kind
 * (manager/auditor/workspace-auditor) — callers pass whatever startupPrompt they'd otherwise spawn with.
 * `prompt` unset/blank ⇒ returns `startupPrompt` untouched, so a schedule with no custom prompt composes
 * BYTE-IDENTICAL to today. PURE + exported so the hermetic test can assert both branches.
 */
export function appendScheduledPrompt(
  startupPrompt: string | undefined,
  prompt: string | null | undefined,
): string | undefined {
  const custom = prompt?.trim();
  if (!custom) return startupPrompt;
  const base = startupPrompt?.trim();
  const block = `Scheduled task:\n${custom}`;
  return base ? `${base}\n\n---\n${block}` : block;
}
