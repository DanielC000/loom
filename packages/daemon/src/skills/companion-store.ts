import { companionSkillsDir } from "../paths.js";
import { PerCompanionStore, NEAR_DUP_THRESHOLD, MIN_DEDUP_UNION_TOKENS, type PerCompanionEntry } from "./per-companion-store.js";

/**
 * The Loom Companion's SELF-AUTHORED skill store (epic Phase 2) — a store discipline PARALLEL to the
 * global one (skills/store.ts), but PARAMETERIZED to a per-companion base dir and DELIBERATELY isolated:
 *   - writes NEVER touch SKILLS_DIR (the global store) — they land under companionSkillsDir(sessionId);
 *   - nothing here is injected into any session's <cwd>/.claude/skills — loading is ON-DEMAND over MCP
 *     (list compact + read full), so a companion co-located with a manager can never leak skills to it.
 * A thin caller over the generic `per-companion-store.ts` core (path confinement, atomic write, list/read/
 * write/remove, the Jaccard dup-guard) — parameterized to `SKILL.md` files under `companionSkillsDir`. The
 * memory-entry store (`companion-memory-store.ts`) is the sibling caller over the SAME core.
 */

export interface CompanionSkillEntry {
  name: string;
  description: string;
}

export type CompanionAuthorResult =
  | { ok: true; skills: CompanionSkillEntry[] }
  | { ok: false; error: string };

export type CompanionRemoveResult =
  | { ok: true; skills: CompanionSkillEntry[] }
  | { ok: false; error: string };

export { NEAR_DUP_THRESHOLD, MIN_DEDUP_UNION_TOKENS };

const store = new PerCompanionStore<PerCompanionEntry>({
  baseDir: companionSkillsDir,
  fileName: "SKILL.md",
  kind: "skill",
});

/** Compact list `[{ name, description }]` (name-sorted) — the on-demand DISCOVERY surface (skill_list). */
export function listCompanionSkills(sessionId: string): CompanionSkillEntry[] {
  return store.list(sessionId);
}

/** Full SKILL.md text (the on-demand FULL load — skill_read). Null if the name is invalid or absent. */
export function readCompanionSkill(sessionId: string, name: string): string | null {
  return store.read(sessionId, name);
}

/**
 * Author a NEW skill or REFINE one in place. Authoring an EXISTING name overwrites it (the intended refine
 * path — no append, the companion supplies the full rewritten content). Authoring a NEW name that is a
 * near-duplicate (content Jaccard ≥ NEAR_DUP_THRESHOLD) of an existing skill is REJECTED, steering the
 * companion to refine that skill instead. Every write is atomic (tmp+rename) and CONFINED under the base.
 */
export function authorCompanionSkill(sessionId: string, name: string, content: string): CompanionAuthorResult {
  const r = store.author(sessionId, name, content);
  return r.ok ? { ok: true, skills: r.entries } : r;
}

/** Remove a companion skill (curation/dedup). Returns the updated compact list, or an error if absent/invalid. */
export function removeCompanionSkill(sessionId: string, name: string): CompanionRemoveResult {
  const r = store.remove(sessionId, name);
  return r.ok ? { ok: true, skills: r.entries } : r;
}
