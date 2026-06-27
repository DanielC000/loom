import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diff3Merge } from "node-diff3";
import type { SkillSummary } from "@loom/shared";
import { SKILLS_DIR, SKILL_BASE_DIR } from "../paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/skills -> daemon root -> assets/skills. Overridable via LOOM_ASSET_SKILLS so hermetic tests can
// point the bundled-asset side at a temp dir (publish writes here — never the real repo asset in a test).
const ASSET_SKILLS = process.env.LOOM_ASSET_SKILLS || path.join(__dirname, "..", "..", "assets", "skills");

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

/**
 * True when `name` is a Loom-bundled/shipped skill (a dir in the asset set) — i.e. NOT a user-created
 * skill. LOAD-BEARING for the ungated `loom-setup` surface: `skill_write` there is bounded STRICTLY to
 * the USER skill store, so it rejects any bundled name (it must never touch the bundled/dev skill set —
 * the human Skills UI owns reset/publish of those). Computed live from ASSET_SKILLS so it reflects
 * exactly the skills shipped to this install (dev sees platform-* too; end users do not).
 */
export function isBundledSkill(name: string): boolean {
  return bundledNames().has(name);
}

const assetMd = (name: string): string => path.join(ASSET_SKILLS, name, "SKILL.md");
// The `base` snapshot lives as a flat <name>.md OUTSIDE SKILLS_DIR (see paths.ts › SKILL_BASE_DIR) so
// inject.ts (which mirrors the skill DIR) never copies it and listSkills/seed never treat it as a skill.
const baseFile = (name: string): string => path.join(SKILL_BASE_DIR, `${name}.md`);

function readFileOrNull(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

/** Atomic write of `name`'s base snapshot (tmp+rename), creating SKILL_BASE_DIR if needed. */
function writeBase(name: string, content: string): void {
  fs.mkdirSync(SKILL_BASE_DIR, { recursive: true });
  const file = baseFile(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// LOAD-BEARING: store SKILL.md is written CRLF on Windows; the asset may be CRLF or LF. Normalize both
// (CRLF/CR -> LF, strip trailing per-line whitespace, strip trailing newlines) BEFORE comparing, else a
// clean skill reads permanently "out of sync" purely on line-ending difference.
function normalizeForCompare(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n")
    .replace(/\n+$/, "");
}

/**
 * Precise customization state for a BUNDLED skill, derived from the THREE versions (all line-ending /
 * whitespace tolerant via normalizeForCompare):
 *   mine    = the store SKILL.md (what sessions inject/use) — passed in as `storeContent`
 *   base    = the shipped content as of the user's last sync (<LOOM_HOME>/skill-base/<name>.md)
 *   shipped = the current bundled asset (Loom's latest)
 * Replaces the old ambiguous `diverged` (which conflated the two below):
 *  - customized      = mine != base  (the user edited their copy)
 *  - updateAvailable = base != shipped (Loom shipped a newer version since the last sync)
 * A MISSING base file is treated as == shipped — matching the seed-if-absent backfill (seedBaseSnapshots):
 * a pristine skill reads neither flag; a legacy-customized skill reads customized-only until a new asset
 * ships. Unreadable asset (not bundled) → both false.
 */
function customizationState(name: string, storeContent: string): { customized: boolean; updateAvailable: boolean } {
  const shipped = readFileOrNull(assetMd(name));
  if (shipped == null) return { customized: false, updateAvailable: false };
  const base = readFileOrNull(baseFile(name)) ?? shipped;
  const nMine = normalizeForCompare(storeContent);
  const nBase = normalizeForCompare(base);
  const nShipped = normalizeForCompare(shipped);
  return { customized: nMine !== nBase, updateAvailable: nBase !== nShipped };
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
    const isBundled = bundled.has(e.name);
    out.push({
      name: e.name,
      description: descriptionOf(content),
      bundled: isBundled,
      ...(isBundled ? customizationState(e.name, content) : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Backfill the `base` snapshot for every bundled skill that has none — one-time, seed-if-absent (called
 * from seedGlobalSkills() at boot). base := the CURRENT shipped asset. Consequences (the SAFE direction):
 *  - pristine (mine == shipped): base == mine == shipped → neither customized nor update.
 *  - legacy-customized (mine != shipped, edited before base existed): base == shipped → customized, no
 *    update — until a NEW asset ships ahead of this base.
 * base only ADVANCES later on adopt / reset / publish (explicit syncs); an existing base staying behind a
 * freshly-shipped asset is exactly the "update available" signal. Returns the names backfilled.
 */
export function seedBaseSnapshots(): string[] {
  const seeded: string[] = [];
  for (const name of bundledNames()) {
    if (fs.existsSync(baseFile(name))) continue; // already snapshotted — never clobber (seed-if-absent)
    const shipped = readFileOrNull(assetMd(name));
    if (shipped == null) continue;
    writeBase(name, shipped);
    seeded.push(name);
  }
  return seeded;
}

/**
 * Boot-only auto-fast-forward of PRISTINE bundled skills (called from seedGlobalSkills() AFTER
 * seedBaseSnapshots() — base must be backfilled first so the equality below is meaningful). For each
 * bundled skill that has a store copy, advance `mine` to the shipped asset ONLY when it is LOSSLESS:
 *   customized:false  — normalizeForCompare(mine) === normalizeForCompare(base): the user has made NO
 *                       semantic edit, so taking shipped discards nothing (this IS the clean fast-forward
 *                       of mergeSkillContent line 168 and the `customized` flag of customizationState).
 *   updateAvailable:true — normalizeForCompare(base) !== normalizeForCompare(shipped): Loom shipped a
 *                       newer doctrine since the last sync; nothing to do otherwise.
 * When both hold, adopt shipped VERBATIM (adoptSkillUpdate advances base := shipped, clearing
 * updateAvailable). This makes self-host doctrine changes go live on restart like code does, WITHOUT
 * weakening the by-design protection of user edits: any customized:true skill is left for manual adopt
 * exactly as today — it is NEVER auto-advanced. The equality is the SAME merge-engine normalizeForCompare
 * used everywhere (customizationState / mergeSkillContent), never a new heuristic.
 * Best-effort + boot-safe: each skill is wrapped in try/catch and this NEVER throws (mirrors
 * seedBaseSnapshots' tolerance). Returns the names advanced.
 */
export function autoFastForwardPristineSkills(): string[] {
  const advanced: string[] = [];
  for (const name of bundledNames()) {
    try {
      const v = threeVersions(name);
      if (!v) continue; // not bundled / no store copy
      const customized = normalizeForCompare(v.mine) !== normalizeForCompare(v.base);
      const updateAvailable = normalizeForCompare(v.base) !== normalizeForCompare(v.shipped);
      if (customized || !updateAvailable) continue; // protect user edits; skip when nothing to advance
      if (adoptSkillUpdate(name, v.shipped)) advanced.push(name); // clean FF == take shipped verbatim
    } catch { /* best-effort per skill — a bad skill must never break boot */ }
  }
  return advanced;
}

// --- 3-way adopt-update merge ----------------------------------------------------------------------
export interface SkillConflictHunk { mine: string; base: string; shipped: string; }
export interface SkillMergeResult { clean: boolean; merged: string; conflicts?: SkillConflictHunk[]; }

const toLf = (s: string): string => s.replace(/\r\n?/g, "\n");

/**
 * 3-way merge of a skill's SKILL.md — apply the shipped delta onto the user's edits using `base` as the
 * common ancestor. Line-based diff3 over LF-normalized lines (a=mine, o=base, b=shipped).
 *  - clean:true  → shipped's changes don't touch the user's edited lines (incl. the mine==base clean
 *    fast-forward where the WHOLE shipped update applies): `merged` is the ready-to-write content.
 *  - clean:false → genuine overlap: `conflicts` lists each conflicting hunk (mine/base/shipped text) for
 *    a per-hunk resolver, and `merged` is a whole-file fallback carrying git-style conflict markers
 *    (<<<<<<< mine / ||||||| base / ======= / >>>>>>> shipped) for a side-by-side editor.
 * `excludeFalseConflicts` collapses identical mine/shipped edits so they never read as conflicts.
 */
export function mergeSkillContent(base: string, mine: string, shipped: string): SkillMergeResult {
  // Clean fast-forward FIRST — when the user has made no SEMANTIC edit (mine == base under the SAME
  // normalizer customizationState uses: CRLF/CR, trailing per-line whitespace, and trailing newlines all
  // ignored), there is nothing to preserve, so adopt must take `shipped` VERBATIM. Routing this case
  // through diff3 is not merely redundant, it's WRONG: diff3 below normalizes only with `toLf`, so a
  // PHANTOM difference customizationState already discounts (a lone CRLF, a trailing space, a missing final
  // newline) reads to diff3 as a user edit and can DROP or CONFLICT shipped's additions — advancing base to
  // shipped while leaving `mine` stale (the adopt-staleness bug: a "not customized" skill that adopt left
  // missing shipped lines). Comparing with normalizeForCompare here keeps "no user edit" meaning the same
  // thing in the state model and the merge.
  if (normalizeForCompare(mine) === normalizeForCompare(base)) return { clean: true, merged: shipped };
  const regions = diff3Merge(toLf(mine).split("\n"), toLf(base).split("\n"), toLf(shipped).split("\n"), { excludeFalseConflicts: true });
  const out: string[] = [];
  const conflicts: SkillConflictHunk[] = [];
  for (const r of regions) {
    if (r.ok) { out.push(...r.ok); continue; }
    if (!r.conflict) continue;
    const c = r.conflict;
    conflicts.push({ mine: c.a.join("\n"), base: c.o.join("\n"), shipped: c.b.join("\n") });
    out.push("<<<<<<< mine", ...c.a, "||||||| base", ...c.o, "=======", ...c.b, ">>>>>>> shipped");
  }
  const merged = out.join("\n");
  return conflicts.length ? { clean: false, merged, conflicts } : { clean: true, merged };
}

/** Read base (snapshot), mine (store), shipped (asset) for a bundled skill; null if not bundled / no store copy. */
function threeVersions(name: string): { base: string; mine: string; shipped: string } | null {
  const shipped = readFileOrNull(assetMd(name));
  if (shipped == null) return null; // not a bundled skill
  const mine = readFileOrNull(skillMd(name));
  if (mine == null) return null;    // no store copy
  const base = readFileOrNull(baseFile(name)) ?? shipped; // missing base → treat as shipped (== seed outcome)
  return { base, mine, shipped };
}

/** True iff a shipped update is available (base != shipped) for a bundled skill — the adopt/preview guard. */
export function skillUpdateAvailable(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  const v = threeVersions(name);
  if (!v) return false;
  return normalizeForCompare(v.base) !== normalizeForCompare(v.shipped);
}

/** Preview the adopt-update merge for a bundled skill. null if not a bundled skill with a store copy. */
export function previewSkillMerge(name: string): SkillMergeResult | null {
  if (!isValidSkillName(name)) return null;
  const v = threeVersions(name);
  if (!v) return null;
  return mergeSkillContent(v.base, v.mine, v.shipped);
}

/** base + shipped for the "what shipped changed" (base→shipped) diff. null if not a bundled skill. */
export function skillUpdateDiff(name: string): { base: string; shipped: string } | null {
  if (!isValidSkillName(name)) return null;
  const v = threeVersions(name);
  if (!v) return null;
  return { base: v.base, shipped: v.shipped };
}

/**
 * Adopt the shipped update NON-DESTRUCTIVELY: write `mine` = resolvedContent (the clean merged content,
 * or the user-resolved content for a conflicted merge) and ADVANCE base := current shipped. Never auto-
 * applied — the REST layer calls this only on explicit user action and only when updateAvailable.
 * Returns the new skill, or null if not a bundled skill / invalid name / write failed.
 */
export function adoptSkillUpdate(name: string, resolvedContent: string): { name: string; content: string } | null {
  if (!isValidSkillName(name)) return null;
  const v = threeVersions(name);
  if (!v) return null;
  if (!writeSkill(name, resolvedContent)) return null;
  writeBase(name, v.shipped); // base = shipped: the update is now adopted (clears updateAvailable)
  return readSkill(name);
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
  // mine = base = shipped: a full discard also re-syncs the base snapshot, clearing any update-available.
  const shipped = readFileOrNull(assetMd(name));
  if (shipped != null) writeBase(name, shipped);
  return true;
}

/**
 * Inverse of resetSkillToBundled: write the STORE's SKILL.md back into the repo's bundled asset so a
 * UI edit becomes committable (the human commits — this never commits). RESTRICTED to names that
 * already exist as a bundled asset; it won't mint a new asset dir for a user-created skill.
 * Returns false if the skill has no bundled asset or no store SKILL.md.
 * HUMAN-only (REST) — like the vault/git writers, NO agent MCP tool exposes this.
 */
export function publishSkillToBundled(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  const destDir = path.join(ASSET_SKILLS, name);
  try { if (!fs.statSync(destDir).isDirectory()) return false; } catch { return false; } // not a bundled skill
  let content: string;
  try { content = fs.readFileSync(skillMd(name), "utf8"); } catch { return false; } // no store SKILL.md to publish
  const dest = path.join(destDir, "SKILL.md");
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, dest);
  // The published edit IS the new shipped baseline: advance base to it so the skill reads PRISTINE
  // (mine == base == shipped) right after publish, instead of a stale "update available" against the
  // pre-publish base. Mirrors reset's base re-sync. (Dev/self-host flow; gated to isLoomDev at the REST.)
  writeBase(name, content);
  return true;
}

/** Starter SKILL.md for a freshly-created skill. */
export function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\nDescribe when this skill triggers and the steps to follow.\n`;
}
