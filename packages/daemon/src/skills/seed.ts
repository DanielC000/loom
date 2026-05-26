import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/skills -> dist -> daemon root -> assets/skills
const ASSET_SKILLS = path.join(__dirname, "..", "..", "assets", "skills");
const GLOBAL_SKILLS = path.join(os.homedir(), ".claude", "skills");

/**
 * Ship Loom's global, project-agnostic skills into the user/global skill dir so Claude's
 * own resolver picks them up (Loom delegates skill loading to the CLI — §8). Currently:
 * doc-hygiene. Overwrites Loom-managed skill dirs to keep them current; leaves other
 * user skills untouched.
 */
export function seedGlobalSkills(): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(ASSET_SKILLS, { withFileTypes: true }); } catch { return []; }
  const seeded: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    fs.cpSync(path.join(ASSET_SKILLS, e.name), path.join(GLOBAL_SKILLS, e.name), { recursive: true });
    seeded.push(e.name);
  }
  return seeded;
}
