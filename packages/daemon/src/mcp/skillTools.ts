import { z } from "zod";
import {
  listSkills,
  readSkill,
  writeSkill,
  isValidSkillName,
  isBundledSkill,
  publishSkillToBundled,
} from "../skills/store.js";

/**
 * SHARED skill-editing tool handlers for the in-app MCP skill surface — the SINGLE source of the
 * validated logic, reused VERBATIM by `loom-setup` (mcp/setup.ts — the ungated Setup Assistant E1-8)
 * AND `loom-platform` (mcp/platform.ts — the dev Platform Lead). Factoring it here (rather than forking
 * a second copy onto the Lead's surface) guarantees the confirm-first gate + the kebab-slug
 * path-traversal guard can never silently diverge between the two surfaces.
 *
 * ╔═ WRITE TARGET — the one real design point, selected per-surface via `allowBundledAsset` ═══════════╗
 * ║ The store (~/.loom/skills) is per-install; the bundled ASSET (assets/skills/<name>/SKILL.md) is the ║
 * ║ SOURCE OF TRUTH shipped to every loomctl user. The two surfaces want DIFFERENT targets:            ║
 * ║                                                                                                     ║
 * ║   loom-setup  (allowBundledAsset:FALSE) — USER STORE ONLY. A bundled/shipped name is REJECTED, so   ║
 * ║     the ungated operator can never touch the bundled/dev skill set (the human Skills UI owns those).║
 * ║     This is the load-bearing bound of the lower-privilege Setup surface — UNCHANGED here.           ║
 * ║                                                                                                     ║
 * ║   loom-platform (allowBundledAsset:TRUE) — the Lead's ACTUAL job is editing the bundled ASSET. For  ║
 * ║     a bundled name it writes the store copy, then reuses the EXISTING validated `publishSkillToBundled`║
 * ║     (store→asset) — the SAME helper the human `POST /api/skills/:name/publish` REST route calls — so ║
 * ║     store==asset afterwards (listSkills → diverged:false), exactly the end-state the Lead's          ║
 * ║     edit-asset-then-`POST /api/skills/:name/reset` workflow targets. A USER name still writes only   ║
 * ║     the store (superset: the Lead keeps everything the operator can do, and more).                   ║
 * ║                                                                                                     ║
 * ║   No guard is weakened and NO human-REST-only guard is bypassed: publishSkillToBundled is a pure fs  ║
 * ║   helper restricted to names that already exist as a bundled asset (it won't mint a new asset dir);  ║
 * ║   the REST wrapper adds only the same isValidSkillName check applied here + a 404 mapping. Reaching   ║
 * ║   the asset from the Lead is consistent with the Lead already holding the git/vault writers + the     ║
 * ║   asset→reset flow — it only widens the already-most-privileged role (no trust-boundary concern).    ║
 * ╚═════════════════════════════════════════════════════════════════════════════════════════════════════╝
 */

/** Shared input schema for skill_write (identical on both surfaces). */
export const skillWriteInputSchema = {
  name: z.string(),
  content: z.string(),
  confirm: z.boolean().optional(),
};

/**
 * skill_list handler payload — IDENTICAL on both surfaces. USER (editable) skills carry their full
 * SKILL.md `content` for in-place editing; a bundled skill's content is omitted (edit via the Skills UI
 * / the Lead's bundled-asset path). Read-only.
 */
export function skillListData(): { skills: Array<Record<string, unknown>> } {
  const skills = listSkills().map((s) => {
    const editable = !s.bundled;
    return { ...s, editable, ...(editable ? { content: readSkill(s.name)?.content ?? "" } : {}) };
  });
  return { skills };
}

/**
 * skill_write handler payload — shared confirm-first gate + kebab-slug guard. `allowBundledAsset`
 * selects the write target for a BUNDLED name (see the WRITE TARGET box above):
 *   - false (loom-setup):  reject a bundled name (USER store only).
 *   - true  (loom-platform): write the store copy then publish store→asset (the Lead's asset edit).
 * A USER name always writes the user store on both surfaces. Returns the raw data object the caller
 * wraps in its MCP `ok()` envelope.
 */
export function skillWriteData(
  { name, content, confirm }: { name: string; content: string; confirm?: boolean },
  opts: { allowBundledAsset: boolean },
): Record<string, unknown> {
  // CONFIRM-FIRST gate (load-bearing): refuse unless the agent attests it confirmed with the user. The
  // real enforcement is the surface's doctrine (show + confirm before calling); this tool-level
  // attestation makes the requirement legible and fails closed if the agent skips it.
  if (confirm !== true) {
    return { error: "skill_write requires confirm:true — first show the user the skill name + full content and get their explicit confirmation, then retry with confirm:true." };
  }
  if (!isValidSkillName(name)) {
    return { error: "invalid skill name (kebab-case: a-z, 0-9, -, ≤64 chars)" };
  }
  if (isBundledSkill(name)) {
    if (!opts.allowBundledAsset) {
      // loom-setup BOUND (load-bearing): USER skills ONLY — a bundled name can never create a divergent
      // store copy of, or otherwise touch, the bundled/dev skill set.
      return { error: `"${name}" is a bundled Loom skill — skill_write is bounded to USER skills and cannot modify the bundled/dev skill set. Edit a bundled skill via the Skills UI.` };
    }
    // loom-platform: edit the SOURCE-OF-TRUTH bundled ASSET. Write the store copy first, then publish it
    // to the shipped asset via the existing validated human-REST publish path (store→asset). store==asset
    // afterwards (diverged:false) — the asset→reset end-state the Lead's workflow targets.
    if (!writeSkill(name, content)) return { error: "invalid skill name" };
    if (!publishSkillToBundled(name)) return { error: `failed to publish "${name}" to its bundled asset` };
    return { ok: true, name, bundled: true, target: "asset", skill: listSkills().find((s) => s.name === name) ?? null };
  }
  // USER skill (both surfaces): write the user store only.
  if (!writeSkill(name, content)) return { error: "invalid skill name" };
  return { ok: true, name, bundled: false, skill: listSkills().find((s) => s.name === name) ?? null };
}

/** Shared input schema for skill_edit — mirrors the Edit tool's oldString/newString contract. */
export const skillEditInputSchema = {
  name: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
  confirm: z.boolean().optional(),
};

/** Count non-overlapping occurrences of a literal `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * skill_edit handler payload — the surgical, patch-based alternative to skill_write: exact-string
 * replace (oldString -> newString) against the skill's CURRENT SKILL.md, mirroring the Edit tool's
 * contract (oldString must match EXACTLY incl. whitespace and be UNIQUE, unless replaceAll:true).
 * Deliberately does NOT duplicate any write logic: it reads the current content via readSkill(),
 * computes the new full content in memory, then hands off to skillWriteData() for the ACTUAL write —
 * so skill_edit and skill_write always share ONE persistence path (same confirm-first gate, same
 * kebab-slug guard, same WRITE TARGET selection via `opts.allowBundledAsset`) and can never diverge.
 */
export function skillEditData(
  { name, oldString, newString, replaceAll, confirm }: { name: string; oldString: string; newString: string; replaceAll?: boolean; confirm?: boolean },
  opts: { allowBundledAsset: boolean },
): Record<string, unknown> {
  if (!oldString) {
    return { error: "oldString must be a non-empty string" };
  }
  if (oldString === newString) {
    return { error: "oldString and newString must differ" };
  }
  if (!isValidSkillName(name)) {
    return { error: "invalid skill name (kebab-case: a-z, 0-9, -, ≤64 chars)" };
  }
  const current = readSkill(name);
  if (!current) {
    return { error: `skill "${name}" not found — use skill_write to create a new skill` };
  }
  const count = countOccurrences(current.content, oldString);
  if (count === 0) {
    return { error: `oldString not found in "${name}"'s SKILL.md` };
  }
  if (count > 1 && !replaceAll) {
    return { error: `oldString is not unique in "${name}"'s SKILL.md — ${count} matches; add surrounding context to make it unique, or pass replaceAll:true to replace every occurrence` };
  }
  const newContent = replaceAll ? current.content.split(oldString).join(newString) : current.content.replace(oldString, newString);
  return skillWriteData({ name, content: newContent, confirm }, opts);
}
