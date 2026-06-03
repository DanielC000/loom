import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillSummary } from "@loom/shared";
import { SKILLS_DIR } from "../paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_SKILLS = path.join(__dirname, "..", "..", "assets", "skills"); // dist/skills -> daemon root -> assets/skills

/**
 * CRUD over the Loom skill store (~/.loom/skills). A skill is a directory with a SKILL.md playbook;
 * the editable unit IS that SKILL.md (frontmatter `name`/`description` + body). The daemon owns the
 * filesystem; injectSkills() mirrors the store into each session at spawn, so edits apply next spawn.
 */

// Skill names are kebab slugs — also the directory name, so this guards against path traversal.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isValidSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

const skillMd = (name: string): string => path.join(SKILLS_DIR, name, "SKILL.md");

function descriptionOf(content: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = fm?.[1]?.match(/^description:\s*(.*)$/m);
  return (m?.[1] ?? "").trim();
}

function bundledNames(): Set<string> {
  try {
    return new Set(fs.readdirSync(ASSET_SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
  } catch { return new Set(); }
}

export function listSkills(): SkillSummary[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); } catch { return []; }
  const bundled = bundledNames();
  const out: SkillSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let content = "";
    try { content = fs.readFileSync(skillMd(e.name), "utf8"); } catch { continue; } // dir without SKILL.md → not a skill
    out.push({ name: e.name, description: descriptionOf(content), bundled: bundled.has(e.name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(name: string): { name: string; content: string } | null {
  if (!isValidSkillName(name)) return null;
  try { return { name, content: fs.readFileSync(skillMd(name), "utf8") }; } catch { return null; }
}

/** Create or overwrite a skill's SKILL.md. Returns false on an invalid name. */
export function writeSkill(name: string, content: string): boolean {
  if (!isValidSkillName(name)) return false;
  fs.mkdirSync(path.join(SKILLS_DIR, name), { recursive: true });
  const file = skillMd(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
  return true;
}

export function deleteSkill(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  fs.rmSync(path.join(SKILLS_DIR, name), { recursive: true, force: true });
  return true;
}

/**
 * Restore a bundled skill in the store to its shipped asset version, discarding any UI edits.
 * Closes the seed-if-absent gap: seedGlobalSkills() never overwrites, so improvements to a bundled
 * skill don't reach an existing store on reboot — this is the explicit, per-skill opt-in refresh.
 * Returns false if the skill has no bundled asset (a user-created skill can't be "reset").
 */
export function resetSkillToBundled(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  const src = path.join(ASSET_SKILLS, name);
  try { if (!fs.statSync(src).isDirectory()) return false; } catch { return false; } // not a bundled skill
  const dest = path.join(SKILLS_DIR, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

/** Starter SKILL.md for a freshly-created skill. */
export function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\nDescribe when this skill triggers and the steps to follow.\n`;
}
