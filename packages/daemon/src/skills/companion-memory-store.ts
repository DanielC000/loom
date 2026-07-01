import { companionMemoryDir } from "../paths.js";
import { descriptionOf } from "./store.js";
import { PerCompanionStore, NEAR_DUP_THRESHOLD, MIN_DEDUP_UNION_TOKENS } from "./per-companion-store.js";

/**
 * The Loom Companion's SELF-AUTHORED memory store — the sibling of `companion-store.ts` (skills), same
 * isolation discipline over the SAME generic `per-companion-store.ts` core, but for `MEMORY.md` entries
 * under `companionMemoryDir(sessionId)`. Storage layer ONLY (this card): no MCP tools, no recall, no REST
 * wire this up yet — those land on later sub-cards.
 */

export interface CompanionMemoryEntry {
  name: string;
  description: string;
  pinned: boolean;
}

export type CompanionMemoryAuthorResult =
  | { ok: true; memories: CompanionMemoryEntry[] }
  | { ok: false; error: string };

export type CompanionMemoryRemoveResult =
  | { ok: true; memories: CompanionMemoryEntry[] }
  | { ok: false; error: string };

export { NEAR_DUP_THRESHOLD, MIN_DEDUP_UNION_TOKENS };

/** Parse `pinned:` out of a MEMORY.md frontmatter block (false if absent or not literally "true"). */
function pinnedOf(content: string): boolean {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = fm?.[1]?.match(/^pinned:\s*(.*)$/m);
  return (m?.[1] ?? "").trim().toLowerCase() === "true";
}

const store = new PerCompanionStore<CompanionMemoryEntry>({
  baseDir: companionMemoryDir,
  fileName: "MEMORY.md",
  kind: "memory",
  summarize: (name, content) => ({ name, description: descriptionOf(content), pinned: pinnedOf(content) }),
});

/** Compact list `[{ name, description, pinned }]` (name-sorted) — the on-demand DISCOVERY surface. */
export function listCompanionMemories(sessionId: string): CompanionMemoryEntry[] {
  return store.list(sessionId);
}

/** Full MEMORY.md text (the on-demand FULL load). Null if the name is invalid or absent. */
export function readCompanionMemory(sessionId: string, name: string): string | null {
  return store.read(sessionId, name);
}

/**
 * Author a NEW memory entry or REFINE one in place. Authoring an EXISTING name overwrites it (no append,
 * the companion supplies the full rewritten content). Authoring a NEW name that is a near-duplicate
 * (content Jaccard ≥ NEAR_DUP_THRESHOLD) of an existing entry is REJECTED, steering the companion to refine
 * that entry instead. Every write is atomic (tmp+rename) and CONFINED under the base.
 */
export function authorCompanionMemory(sessionId: string, name: string, content: string): CompanionMemoryAuthorResult {
  const r = store.author(sessionId, name, content);
  return r.ok ? { ok: true, memories: r.entries } : r;
}

/** Remove a companion memory entry (curation/dedup). Returns the updated compact list, or an error if absent/invalid. */
export function removeCompanionMemory(sessionId: string, name: string): CompanionMemoryRemoveResult {
  const r = store.remove(sessionId, name);
  return r.ok ? { ok: true, memories: r.entries } : r;
}
