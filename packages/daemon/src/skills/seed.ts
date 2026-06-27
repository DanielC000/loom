import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_DIR } from "../paths.js";
import { seedBaseSnapshots, autoFastForwardPristineSkills } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/skills -> dist -> daemon root -> assets/skills
const ASSET_SKILLS = path.join(__dirname, "..", "..", "assets", "skills");

/**
 * Seed Loom's bundled, project-agnostic skills into the Loom-OWNED skill store (~/.loom/skills) —
 * NOT ~/.claude/skills. This keeps Loom's skills separate from the user's personal set; each session
 * gets them injected as PROJECT-LOCAL skills (see skills/inject.ts), where they shadow same-named
 * personal skills (validated spike).
 *
 * Seeds each bundled skill ONLY IF its SKILL.md is absent, so a user's UI edits to a skill survive
 * reboots (the old behavior force-copied every boot, which would clobber edits). A future "reset to
 * bundled" can force-refresh a single skill on demand.
 *
 * Self-heal: the gate is the skill's SKILL.md, not the dir. If a skill's dir exists but is EMPTY
 * (the historical junction bug let worktree removal delete the store's SKILL.md contents, leaving
 * a hollow dir that a dir-keyed "if absent" check would never refill), this (re)copies the bundled
 * asset so the store repopulates on the next boot. A present SKILL.md means a genuine skill (possibly
 * UI-edited) and is left untouched.
 */
export function seedGlobalSkills(): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(ASSET_SKILLS, { withFileTypes: true }); } catch { return []; }
  const seeded: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dest = path.join(SKILLS_DIR, e.name);
    if (fs.existsSync(path.join(dest, "SKILL.md"))) continue; // genuine skill (incl. UI edits) — preserve
    fs.cpSync(path.join(ASSET_SKILLS, e.name), dest, { recursive: true }); // missing or hollow dir → (re)seed
    seeded.push(e.name);
  }
  // Backfill the per-bundled-skill `base` snapshot (seed-if-absent) so listSkills can derive precise
  // customized / updateAvailable state and the adopt-update 3-way merge has a common ancestor. Lives
  // OUTSIDE SKILLS_DIR (never injected); store.ts owns the asset-path resolution (LOOM_ASSET_SKILLS-aware).
  seedBaseSnapshots();
  // AFTER the base backfill (base must exist for the equality to mean anything): auto-fast-forward only
  // bundled skills that are customized:false (mine == base) and have a shipped update — lossless, since
  // there are no user edits to preserve. This deploys self-host doctrine changes on restart like code.
  // customized:true skills are NEVER auto-advanced — they wait for manual adopt exactly as today.
  autoFastForwardPristineSkills();
  return seeded;
}
