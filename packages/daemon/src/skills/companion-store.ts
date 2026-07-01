import fs from "node:fs";
import path from "node:path";
import { companionSkillsDir } from "../paths.js";
import { atomicWriteFile, descriptionOf, isValidSkillName } from "./store.js";

/**
 * The Loom Companion's SELF-AUTHORED skill store (epic Phase 2) — a store discipline PARALLEL to the
 * global one (skills/store.ts), but PARAMETERIZED to a per-companion base dir and DELIBERATELY isolated:
 *   - writes NEVER touch SKILLS_DIR (the global store) — they land under companionSkillsDir(sessionId);
 *   - nothing here is injected into any session's <cwd>/.claude/skills — loading is ON-DEMAND over MCP
 *     (list compact + read full), so a companion co-located with a manager can never leak skills to it.
 * It reuses the global store's name validation (isValidSkillName / NAME_RE), atomic write (atomicWriteFile),
 * and frontmatter description parse (descriptionOf) — it does NOT fork them. Every write is CONFINED under
 * the companion base by resolving the target and asserting it stays inside (belt-and-suspenders beyond
 * NAME_RE's already-strict slug, which forbids `.`, `/`, `\`, `..` and absolute names).
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

/**
 * Redundancy (curation) threshold — a NEW-name skill whose content overlaps an EXISTING skill's content at
 * or above this Jaccard token-overlap is REJECTED (the companion is told to refine the existing one instead).
 * Chosen with margin: genuinely distinct skills overlap only on shared frontmatter/stopword tokens (well
 * below 0.7 even for short skills), while a reworded near-duplicate lands high (~0.8+). Deterministic +
 * hermetically testable (pure set math over the SKILL.md text).
 */
export const NEAR_DUP_THRESHOLD = 0.7;

/**
 * Minimum combined (UNION) distinctive-token count before the near-dup guard is allowed to fire. Below this
 * the two skills' token sets are dominated by shared boilerplate — the SKILL.md frontmatter labels
 * (`name`/`description`), the `#` header, and common stopwords — so Jaccard measures template overlap, not
 * meaning, and can FALSELY reject two genuinely-distinct SHORT skills. When the union is under this, a
 * NEW-name skill is always accepted (short skills are never auto-rejected). 12 is ~2× the ~5–6 boilerplate
 * tokens a minimal SKILL.md carries, so the guard engages only once there's real distinctive material to
 * judge. Deterministic (pure set size).
 */
export const MIN_DEDUP_UNION_TOKENS = 12;

/**
 * Resolve `<base>/<name>` and CONFINE it strictly inside the companion base dir. Returns null on an invalid
 * name OR any path escape (defense in depth: NAME_RE already rejects separators/`..`/absolute, and this
 * re-checks the resolved target equals the normalized join and stays under `base + sep`).
 */
function resolveSkillDir(sessionId: string, name: string): string | null {
  if (!isValidSkillName(name)) return null;
  const base = path.resolve(companionSkillsDir(sessionId));
  const dir = path.resolve(base, name);
  if (dir !== path.join(base, name) || !dir.startsWith(base + path.sep)) return null;
  return dir;
}

const skillMdPath = (dir: string): string => path.join(dir, "SKILL.md");

/** Tokenize to a normalized set of `[a-z0-9]+` runs (lowercased) — the unit the redundancy Jaccard runs over. */
function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/** |A∩B| — shared token count. */
function intersectionSize(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter;
}

/** |A∪B| — combined distinctive-token count (the redundancy guard's minimum-material gate reads this). */
function unionSize(a: Set<string>, b: Set<string>): number {
  return a.size + b.size - intersectionSize(a, b);
}

/** Jaccard overlap of two token sets: |A∩B| / |A∪B| (two empty sets → 1; one empty → 0). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const union = unionSize(a, b);
  return union === 0 ? 0 : intersectionSize(a, b) / union;
}

/** Read every companion skill as { name, content } (skips dirs without a readable SKILL.md). */
function readAll(sessionId: string): Array<{ name: string; content: string }> {
  const base = companionSkillsDir(sessionId);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out: Array<{ name: string; content: string }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isValidSkillName(e.name)) continue;
    let content: string;
    try { content = fs.readFileSync(skillMdPath(path.join(base, e.name)), "utf8"); } catch { continue; }
    out.push({ name: e.name, content });
  }
  return out;
}

/** Compact list `[{ name, description }]` (name-sorted) — the on-demand DISCOVERY surface (skill_list). */
export function listCompanionSkills(sessionId: string): CompanionSkillEntry[] {
  return readAll(sessionId)
    .map((s) => ({ name: s.name, description: descriptionOf(s.content) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Full SKILL.md text (the on-demand FULL load — skill_read). Null if the name is invalid or absent. */
export function readCompanionSkill(sessionId: string, name: string): string | null {
  const dir = resolveSkillDir(sessionId, name);
  if (!dir) return null;
  try { return fs.readFileSync(skillMdPath(dir), "utf8"); } catch { return null; }
}

/**
 * Author a NEW skill or REFINE one in place. Authoring an EXISTING name overwrites it (the intended refine
 * path — no append, the companion supplies the full rewritten content). Authoring a NEW name that is a
 * near-duplicate (content Jaccard ≥ NEAR_DUP_THRESHOLD) of an existing skill is REJECTED, steering the
 * companion to refine that skill instead. Every write is atomic (tmp+rename) and CONFINED under the base.
 */
export function authorCompanionSkill(sessionId: string, name: string, content: string): CompanionAuthorResult {
  const dir = resolveSkillDir(sessionId, name);
  if (!dir) {
    return { ok: false, error: `invalid skill name "${name}" — use a kebab slug (a–z, 0–9, hyphen; no path segments)` };
  }
  const existing = readAll(sessionId);
  const isRefine = existing.some((s) => s.name === name);
  // Redundancy guard applies ONLY to a fresh name — refine-in-place (same name) is always allowed.
  if (!isRefine) {
    const tokens = tokenize(content);
    for (const s of existing) {
      const other = tokenize(s.content);
      // Not enough distinctive material to judge (union dominated by shared boilerplate) → never auto-reject
      // a short skill. See MIN_DEDUP_UNION_TOKENS.
      if (unionSize(tokens, other) < MIN_DEDUP_UNION_TOKENS) continue;
      const sim = jaccard(tokens, other);
      if (sim >= NEAR_DUP_THRESHOLD) {
        return {
          ok: false,
          error:
            `"${name}" is ${Math.round(sim * 100)}% similar to your existing skill "${s.name}" — refine ` +
            `"${s.name}" in place (author under that exact name) instead of creating a near-duplicate.`,
        };
      }
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFile(skillMdPath(dir), content);
  return { ok: true, skills: listCompanionSkills(sessionId) };
}

/** Remove a companion skill (curation/dedup). Returns the updated compact list, or an error if absent/invalid. */
export function removeCompanionSkill(sessionId: string, name: string): CompanionRemoveResult {
  const dir = resolveSkillDir(sessionId, name);
  if (!dir) return { ok: false, error: `invalid skill name "${name}"` };
  if (!fs.existsSync(dir)) return { ok: false, error: `no skill "${name}"` };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, skills: listCompanionSkills(sessionId) };
}
