import fs from "node:fs";
import path from "node:path";
import type { SessionRole } from "@loom/shared";
import { SKILLS_DIR } from "../paths.js";

const MANIFEST = ".loom-skills.json"; // records which skill names EACH session injected into a .claude/skills

/** Map a Loom-DRIVEN session role to its operating-doctrine skill name in the store. A role here MUST get
 *  its doctrine skill no matter what the profile's pinned subset says (a subset that omits "worker" must
 *  still ship the worker doctrine). run/plain/null carry no doctrine ⇒ absent here. */
const ROLE_DOCTRINE_SKILL: Partial<Record<SessionRole, string>> = {
  worker: "worker",
  manager: "orchestrate",
  platform: "platform-lead",
  auditor: "platform-audit",
  "workspace-auditor": "workspace-audit",
  setup: "setup-assistant",
};

/** Per-session injected-skill record for a shared `.claude/skills`: `{ "<sessionId>": ["worker", …] }`.
 *  Keyed by session so a concurrent session sharing the cwd never strips another's (or the repo's) skills. */
type Manifest = Record<string, string[]>;

/** Read the manifest map. A legacy ARRAY (the pre-subset single-session format) is adopted AS the current
 *  session's record so it reconciles + retires cleanly on this run. Any other shape ⇒ empty map.
 *  A MISSING file is the normal first-run case (silent empty map); a present-but-CORRUPT manifest (a torn
 *  write, bad JSON) is SURFACED — it means we lost the record of what other sessions injected, so we log it
 *  rather than swallow it — then recover to an empty map (safe: every existing dir then reads as the repo's
 *  own and is left untouched; we only add our own `want`). */
function readManifest(manifestPath: string, sessionId: string): Manifest {
  let text: string;
  try { text = fs.readFileSync(manifestPath, "utf8"); }
  catch { return {}; } // no manifest yet — normal first run, not an error worth surfacing
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (e) { console.log(`[skills] ignoring corrupt manifest at ${manifestPath}: ${(e as Error).message}`); return {}; }
  if (Array.isArray(raw)) return { [sessionId]: raw as string[] }; // legacy global array → this session owns it now
  if (raw && typeof raw === "object") return raw as Manifest;
  return {};
}

/**
 * Atomically deliver one store skill dir into the session's .claude/skills, mirroring the tmp+rename
 * pattern store.ts uses for SKILL.md — but for a DIRECTORY: copy into a sibling tmp dir first, then swap
 * it into place. Two correctness wins over a bare cpSync into `dest`:
 *  - ATOMIC: `dest` is only ever the FULLY-copied tmp renamed in. A copy interrupted partway never leaves a
 *    half-written skill at `dest`, and the existing `dest` (the session's live doctrine) is removed ONLY
 *    after the new copy is ready — so a failed copy leaves the old skill intact instead of nuking it.
 *  - RETRIED + SURFACED: transient FS errors (AV/lock/EBUSY on Windows) get a few attempts; a persistent
 *    failure is logged and reported back (false) so the caller can surface it — never silently swallowed,
 *    which would let a session run WITHOUT its pinned doctrine skill.
 * Returns true iff the skill is now in place.
 */
function copySkillAtomic(src: string, dest: string): boolean {
  const tmp = `${dest}.loom-tmp`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Clear a stale tmp DIR from a prior crash so we never MERGE old store content into the fresh copy.
      // A stale tmp FILE is anomalous (we only ever create tmp dirs) — leave it so cpSync surfaces the type
      // mismatch rather than us blindly deleting an unexpected file at our temp path.
      try { if (fs.statSync(tmp).isDirectory()) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* no stale tmp */ }
      fs.cpSync(src, tmp, { recursive: true });           // build the new copy off to the side
      fs.rmSync(dest, { recursive: true, force: true });  // retire the old copy ONLY now the new one is ready
      fs.renameSync(tmp, dest);                            // atomic swap into place
      return true;
    } catch (e) { lastErr = e; }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`[skills] failed to inject '${path.basename(dest)}' after 3 attempts: ${(lastErr as Error)?.message}`);
  return false;
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
 * `role` (the session's resolved role): its operating-doctrine skill (worker→"worker", manager→
 * "orchestrate", …) is FORCE-INCLUDED regardless of the subset — a profile whose subset omits its own
 * role doctrine would otherwise ship a doctrine-less session. Only added if the doctrine skill is in the
 * store (a missing one is still dropped, like any subset name). null/run/plain ⇒ no doctrine skill.
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
export function injectSkills(cwd: string, sessionId: string, subset?: string[] | null, role?: SessionRole | null): void {
  let storeNames: string[];
  try {
    storeNames = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return; } // no store yet
  const targetDir = path.join(cwd, ".claude", "skills");
  fs.mkdirSync(targetDir, { recursive: true });

  // What THIS session should have present: a non-empty subset ∩ the store, else ALL store skills.
  const want = subset && subset.length ? storeNames.filter((n) => subset.includes(n)) : storeNames;
  // FORCE-INCLUDE the role's operating-doctrine skill regardless of the subset (a profile whose subset
  // omits "worker"/"orchestrate"/… must still ship its role doctrine). Only when present in the store and
  // not already wanted; a no-subset session already has every store skill, so this only bites under a subset.
  const roleSkill = role ? ROLE_DOCTRINE_SKILL[role] : undefined;
  if (roleSkill && storeNames.includes(roleSkill) && !want.includes(roleSkill)) want.push(roleSkill);

  const manifestPath = path.join(targetDir, MANIFEST);
  const manifest = readManifest(manifestPath, sessionId);
  const myPrev = manifest[sessionId] ?? [];
  // Union of every OTHER session's injected skills sharing this cwd — these must NEVER be stripped here
  // and are NOT the repo's own (the landmine-2 invariant: concurrent sessions share project.repoPath).
  const otherClaimed = new Set<string>();
  for (const [sid, ns] of Object.entries(manifest)) if (sid !== sessionId) for (const n of ns) otherClaimed.add(n);

  const placed: string[] = [];
  const failed: string[] = [];
  for (const name of want) {
    const dest = path.join(targetDir, name);
    const exists = fs.existsSync(dest);
    // A pre-existing dir that NO loom session claims (not mine, not another session's) is the repo's OWN
    // project-local skill — never clobber it. A dir another session injected IS loom's: re-copying the
    // same store content is idempotent and harmless.
    if (exists && !myPrev.includes(name) && !otherClaimed.has(name)) continue;
    const src = path.join(SKILLS_DIR, name);
    // COPY (atomic tmp+swap), never junction: a junction here lets worktree removal's recursive rm follow
    // it into the store and delete the store's SKILL.md (see header). An independent copy is self-contained.
    // A copy that ultimately fails is recorded (`failed`) and surfaced below — NOT silently skipped, which
    // would let the session run WITHOUT its pinned doctrine skill.
    if (copySkillAtomic(src, dest)) placed.push(name);
    else failed.push(name);
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
  // Atomic manifest write (tmp+rename, like store.ts): a torn write here corrupts the shared per-session
  // record — readManifest then has to discard it, losing every concurrent session's claims. Writing to a
  // tmp and renaming means a reader sees either the old whole map or the new whole map, never a half file.
  const manifestTmp = `${manifestPath}.tmp`;
  try {
    fs.writeFileSync(manifestTmp, JSON.stringify(manifest));
    fs.renameSync(manifestTmp, manifestPath);
  } catch (e) {
    console.log(`[skills] failed to write manifest ${manifestPath}: ${(e as Error).message}`);
    try { fs.rmSync(manifestTmp, { force: true }); } catch { /* best effort */ }
  }
  hideFromGit(cwd, [...placed, MANIFEST]);

  // Surface any copy that never landed (after persisting the manifest + git-hide for what DID land, so the
  // partial success is recorded and recoverable). The caller treats this as non-fatal but it's now VISIBLE
  // in the daemon log instead of a silent missing-skill.
  if (failed.length) throw new Error(`injectSkills: failed to deliver ${failed.length} skill(s) to ${targetDir}: ${failed.join(", ")}`);
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
