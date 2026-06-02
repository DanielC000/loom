import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "../paths.js";

const MANIFEST = ".loom-skills.json"; // records which skill names Loom injected into a given .claude/skills

/**
 * Deliver Loom's managed skills to a session by mirroring ~/.loom/skills/<name> into
 * <cwd>/.claude/skills/<name>. Claude discovers these as PROJECT-LOCAL skills (bare names), and they
 * SHADOW the user's personal ~/.claude/skills (validated spike) — so Loom owns its skill names
 * without touching the user's personal set or CLAUDE_CONFIG_DIR.
 *
 * Safety:
 *  - Manages ONLY the skill names Loom ships; NEVER clobbers a repo's own pre-existing project-local
 *    skill of the same name (a collision is skipped + left to the repo).
 *  - Removes stale entries it previously injected (skill deleted from the store), via a manifest.
 *  - Symlink (junction on Windows — unprivileged for dirs) with a recursive-copy fallback (Jinn's trick).
 *  - Hides the injected skills from git via .git/info/exclude (local only; never edits a tracked .gitignore).
 */
export function injectSkills(cwd: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return; } // no store yet
  const targetDir = path.join(cwd, ".claude", "skills");
  fs.mkdirSync(targetDir, { recursive: true });

  const manifestPath = path.join(targetDir, MANIFEST);
  let prev: string[] = [];
  try { prev = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { /* first run */ }

  // Remove entries WE previously injected whose source skill is gone (don't touch the repo's own).
  for (const stale of prev) {
    if (!names.includes(stale)) { try { fs.rmSync(path.join(targetDir, stale), { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  const placed: string[] = [];
  for (const name of names) {
    const dest = path.join(targetDir, name);
    const exists = fs.existsSync(dest);
    if (exists && !prev.includes(name)) continue; // a repo's OWN skill of this name — never clobber it
    if (exists) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ } }
    const src = path.join(SKILLS_DIR, name);
    try {
      fs.symlinkSync(src, dest, "junction"); // dir junction: no admin needed on Windows
      placed.push(name);
    } catch {
      try { fs.cpSync(src, dest, { recursive: true }); placed.push(name); } catch { /* skill won't be discoverable */ }
    }
  }

  try { fs.writeFileSync(manifestPath, JSON.stringify(placed)); } catch { /* ignore */ }
  hideFromGit(cwd, [...placed, MANIFEST]);
}

/** Append local git-ignore patterns for the injected skill dirs + manifest (only for a real .git dir). */
function hideFromGit(cwd: string, entries: string[]): void {
  const gitDir = path.join(cwd, ".git");
  try { if (!fs.statSync(gitDir).isDirectory()) return; } catch { return; } // no .git, or a worktree (.git is a file)
  const infoDir = path.join(gitDir, "info");
  try { fs.mkdirSync(infoDir, { recursive: true }); } catch { /* ignore */ }
  const excludePath = path.join(infoDir, "exclude");
  let cur = ""; try { cur = fs.readFileSync(excludePath, "utf8"); } catch { /* none */ }
  const want = entries.map((e) => `/.claude/skills/${e}`);
  const missing = want.filter((p) => !cur.split(/\r?\n/).includes(p));
  if (missing.length === 0) return;
  const prefix = cur === "" || cur.endsWith("\n") ? "" : "\n";
  try { fs.appendFileSync(excludePath, `${prefix}# loom-managed skills (injected per session; do not commit)\n${missing.join("\n")}\n`); } catch { /* ignore */ }
}
