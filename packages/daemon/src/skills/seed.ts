import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_DIR } from "../paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/skills -> dist -> daemon root -> assets/skills
const ASSET_SKILLS = path.join(__dirname, "..", "..", "assets", "skills");

/**
 * Seed Loom's bundled, project-agnostic skills into the Loom-OWNED skill store (~/.loom/skills) —
 * NOT ~/.claude/skills. This keeps Loom's skills separate from the user's personal set; each session
 * gets them injected as PROJECT-LOCAL skills (see skills/inject.ts), where they shadow same-named
 * personal skills (validated spike).
 *
 * Seeds each bundled skill ONLY IF ABSENT, so a user's UI edits to a skill survive reboots (the old
 * behavior force-copied every boot, which would clobber edits). A future "reset to bundled" can
 * force-refresh a single skill on demand.
 */
export function seedGlobalSkills(): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(ASSET_SKILLS, { withFileTypes: true }); } catch { return []; }
  const seeded: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dest = path.join(SKILLS_DIR, e.name);
    if (fs.existsSync(dest)) continue; // preserve user edits
    fs.cpSync(path.join(ASSET_SKILLS, e.name), dest, { recursive: true });
    seeded.push(e.name);
  }
  return seeded;
}
