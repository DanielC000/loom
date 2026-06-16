import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "../paths.js";

const MANIFEST = ".loom-skills.json"; // records which skill names EACH session injected into a .claude/skills

/** Per-session injected-skill record for a shared `.claude/skills`: `{ "<sessionId>": ["worker", …] }`.
 *  Keyed by session so a concurrent session sharing the cwd never strips another's (or the repo's) skills. */
type Manifest = Record<string, string[]>;

/** Read the manifest map. A legacy ARRAY (the pre-subset single-session format) is adopted AS the current
 *  session's record so it reconciles + retires cleanly on this run. Any other shape ⇒ empty map. */
function readManifest(manifestPath: string, sessionId: string): Manifest {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return {}; }
  if (Array.isArray(raw)) return { [sessionId]: raw as string[] }; // legacy global array → this session owns it now
  if (raw && typeof raw === "object") return raw as Manifest;
  return {};
}

/**
 * Deliver Loom's managed skills to a session by mirroring ~/.loom/skills/<name> into
 * <cwd>/.claude/skills/<name>. Claude discovers these as PROJECT-LOCAL skills (bare names), and they
 * SHADOW the user's personal ~/.claude/skills (validated spike) — so Loom owns its skill names
 * without touching the user's personal set or CLAUDE_CONFIG_DIR.
 *
 * `subset` (profile-pinned, per session): when a non-empty list, deliver ONLY those skills; null/empty ⇒
 * ALL store skills (today's behavior — the regression-guarded default). A subset name not in the store is
 * dropped (a stale profile can't ask for a missing skill).
 *
 * Shared-cwd safety (the load-bearing invariant): managers/platform/plain sessions SHARE project.repoPath
 * as cwd, so two sessions with DIFFERENT subsets write the SAME `.claude/skills`. The manifest is therefore
 * keyed PER SESSION, and this function only ever PRUNES a skill THIS session previously injected — and even
 * then only if no OTHER session's record still claims it. So injecting session B's subset can never strip
 * session A's skills (or vice-versa); the shared dir holds the UNION of all live sessions' subsets. (A
 * separate-cwd session — every worker, in its own worktree — gets its subset delivered EXACTLY, no union.)
 *
 * Safety (unchanged):
 *  - Manages ONLY skill names Loom ships; NEVER clobbers a repo's own pre-existing project-local skill of
 *    the same name. "Repo's own" = a pre-existing dir NO session's manifest claims (mine or another's).
 *  - Each session gets an INDEPENDENT recursive COPY of the skill (NOT a junction/symlink). A junction
 *    is fatal on Windows: worktree removal (git/worktrees.ts removeWorktree's recursive-rm backstop)
 *    follows the junction and deletes the STORE's SKILL.md contents, nuking ~/.loom/skills for every
 *    later session. A copy is deleted with the worktree without ever reaching the store.
 *  - Hides the injected skills from git via .git/info/exclude (local only; never edits a tracked .gitignore).
 */
export function injectSkills(cwd: string, sessionId: string, subset?: string[] | null): void {
  let storeNames: string[];
  try {
    storeNames = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return; } // no store yet
  const targetDir = path.join(cwd, ".claude", "skills");
  fs.mkdirSync(targetDir, { recursive: true });

  // What THIS session should have present: a non-empty subset ∩ the store, else ALL store skills.
  const want = subset && subset.length ? storeNames.filter((n) => subset.includes(n)) : storeNames;

  const manifestPath = path.join(targetDir, MANIFEST);
  const manifest = readManifest(manifestPath, sessionId);
  const myPrev = manifest[sessionId] ?? [];
  // Union of every OTHER session's injected skills sharing this cwd — these must NEVER be stripped here
  // and are NOT the repo's own (the landmine-2 invariant: concurrent sessions share project.repoPath).
  const otherClaimed = new Set<string>();
  for (const [sid, ns] of Object.entries(manifest)) if (sid !== sessionId) for (const n of ns) otherClaimed.add(n);

  const placed: string[] = [];
  for (const name of want) {
    const dest = path.join(targetDir, name);
    const exists = fs.existsSync(dest);
    // A pre-existing dir that NO loom session claims (not mine, not another session's) is the repo's OWN
    // project-local skill — never clobber it. A dir another session injected IS loom's: re-copying the
    // same store content is idempotent and harmless.
    if (exists && !myPrev.includes(name) && !otherClaimed.has(name)) continue;
    if (exists) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ } }
    const src = path.join(SKILLS_DIR, name);
    // COPY, never junction: a junction here lets worktree removal's recursive rm follow it into the
    // store and delete the store's SKILL.md (see header). An independent copy is self-contained.
    try { fs.cpSync(src, dest, { recursive: true }); placed.push(name); } catch { /* skill won't be discoverable */ }
  }

  // Prune ONLY skills I previously injected that I no longer want — and only when no OTHER session still
  // claims them. This is what makes a subset change / store deletion safe under a shared cwd: removing my
  // stale skills can never strip a concurrent session's (nor the repo's own, which is in no manifest).
  for (const stale of myPrev) {
    if (want.includes(stale)) continue;        // still want it (placed this run, or a repo collision left alone)
    if (otherClaimed.has(stale)) continue;     // a concurrent session still needs it — keep
    try { fs.rmSync(path.join(targetDir, stale), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  manifest[sessionId] = placed; // record ONLY what I actually injected (never the repo's own / collisions)
  try { fs.writeFileSync(manifestPath, JSON.stringify(manifest)); } catch { /* ignore */ }
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
