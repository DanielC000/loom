import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile, descriptionOf, isValidSkillName } from "./store.js";

/**
 * Generic per-companion CRUD store — the reusable machinery behind BOTH `companion-store.ts` (self-authored
 * skills) and `companion-memory-store.ts` (self-authored memory entries). Each is a namespaced set of
 * `<base(sessionId)>/<name>/<fileName>` text files, isolated per companion session, confined against path
 * escape, atomically written, and guarded against a near-duplicate NEW name via a content Jaccard threshold.
 * A concrete store parameterizes `baseDir` (the per-session base dir resolver), `fileName` (e.g. `SKILL.md`),
 * `kind` (the noun used in error text, e.g. "skill"), and an optional `summarize` to shape the compact list
 * entry beyond `{ name, description }` (memory adds `pinned`).
 */

export interface PerCompanionEntry {
  name: string;
  description: string;
}

export type PerCompanionAuthorResult<T> =
  | { ok: true; entries: T[] }
  | { ok: false; error: string };

export type PerCompanionRemoveResult<T> =
  | { ok: true; entries: T[] }
  | { ok: false; error: string };

/**
 * Redundancy (curation) threshold — a NEW-name entry whose content overlaps an EXISTING entry's content at
 * or above this Jaccard token-overlap is REJECTED (the caller is told to refine the existing one instead).
 * Chosen with margin: genuinely distinct entries overlap only on shared frontmatter/stopword tokens (well
 * below 0.7 even for short entries), while a reworded near-duplicate lands high (~0.8+). Deterministic +
 * hermetically testable (pure set math over the file text).
 */
export const NEAR_DUP_THRESHOLD = 0.7;

/**
 * Minimum combined (UNION) distinctive-token count before the near-dup guard is allowed to fire. Below this
 * the two entries' token sets are dominated by shared boilerplate — frontmatter labels, a `#` header, and
 * common stopwords — so Jaccard measures template overlap, not meaning, and can FALSELY reject two
 * genuinely-distinct SHORT entries. When the union is under this, a NEW-name entry is always accepted (short
 * entries are never auto-rejected). 12 is ~2× the ~5–6 boilerplate tokens a minimal file carries, so the
 * guard engages only once there's real distinctive material to judge. Deterministic (pure set size).
 */
export const MIN_DEDUP_UNION_TOKENS = 12;

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

export interface PerCompanionStoreOptions<T> {
  /** Resolves the per-session base dir, e.g. `companionSkillsDir` / `companionMemoryDir`. */
  baseDir: (sessionId: string) => string;
  /** The entry's file name within its `<base>/<name>/` dir, e.g. `SKILL.md`. */
  fileName: string;
  /** The noun used in error text, e.g. "skill" / "memory". */
  kind: string;
  /** Shapes the compact list/author/remove entry from a name + its file content. Defaults to `{ name, description }`. */
  summarize?: (name: string, content: string) => T;
}

export class PerCompanionStore<T extends { name: string } = PerCompanionEntry> {
  private readonly summarize: (name: string, content: string) => T;

  constructor(private readonly opts: PerCompanionStoreOptions<T>) {
    this.summarize = opts.summarize ?? ((name, content) => ({ name, description: descriptionOf(content) }) as unknown as T);
  }

  /**
   * Resolve `<base>/<name>` and CONFINE it strictly inside the companion base dir. Returns null on an
   * invalid name OR any path escape (defense in depth: NAME_RE already rejects separators/`..`/absolute,
   * and this re-checks the resolved target equals the normalized join and stays under `base + sep`).
   */
  private resolveDir(sessionId: string, name: string): string | null {
    if (!isValidSkillName(name)) return null;
    const base = path.resolve(this.opts.baseDir(sessionId));
    const dir = path.resolve(base, name);
    if (dir !== path.join(base, name) || !dir.startsWith(base + path.sep)) return null;
    return dir;
  }

  private entryPath(dir: string): string {
    return path.join(dir, this.opts.fileName);
  }

  /** Read every entry as { name, content } (skips dirs without a readable entry file). */
  private readAll(sessionId: string): Array<{ name: string; content: string }> {
    const base = this.opts.baseDir(sessionId);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
    const out: Array<{ name: string; content: string }> = [];
    for (const e of entries) {
      if (!e.isDirectory() || !isValidSkillName(e.name)) continue;
      let content: string;
      try { content = fs.readFileSync(this.entryPath(path.join(base, e.name)), "utf8"); } catch { continue; }
      out.push({ name: e.name, content });
    }
    return out;
  }

  /** Compact list (name-sorted) — the on-demand DISCOVERY surface. */
  list(sessionId: string): T[] {
    return this.readAll(sessionId)
      .map((s) => this.summarize(s.name, s.content))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Full file text (the on-demand FULL load). Null if the name is invalid or absent. */
  read(sessionId: string, name: string): string | null {
    const dir = this.resolveDir(sessionId, name);
    if (!dir) return null;
    try { return fs.readFileSync(this.entryPath(dir), "utf8"); } catch { return null; }
  }

  /**
   * Author a NEW entry or REFINE one in place. Authoring an EXISTING name overwrites it (the intended refine
   * path — no append, the caller supplies the full rewritten content). Authoring a NEW name that is a
   * near-duplicate (content Jaccard ≥ NEAR_DUP_THRESHOLD) of an existing entry is REJECTED, steering the
   * caller to refine that entry instead. Every write is atomic (tmp+rename) and CONFINED under the base.
   */
  author(sessionId: string, name: string, content: string): PerCompanionAuthorResult<T> {
    const dir = this.resolveDir(sessionId, name);
    if (!dir) {
      return { ok: false, error: `invalid ${this.opts.kind} name "${name}" — use a kebab slug (a–z, 0–9, hyphen; no path segments)` };
    }
    const existing = this.readAll(sessionId);
    const isRefine = existing.some((s) => s.name === name);
    // Redundancy guard applies ONLY to a fresh name — refine-in-place (same name) is always allowed.
    if (!isRefine) {
      const tokens = tokenize(content);
      for (const s of existing) {
        const other = tokenize(s.content);
        // Not enough distinctive material to judge (union dominated by shared boilerplate) → never
        // auto-reject a short entry. See MIN_DEDUP_UNION_TOKENS.
        if (unionSize(tokens, other) < MIN_DEDUP_UNION_TOKENS) continue;
        const sim = jaccard(tokens, other);
        if (sim >= NEAR_DUP_THRESHOLD) {
          return {
            ok: false,
            error:
              `"${name}" is ${Math.round(sim * 100)}% similar to your existing ${this.opts.kind} "${s.name}" — refine ` +
              `"${s.name}" in place (author under that exact name) instead of creating a near-duplicate.`,
          };
        }
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteFile(this.entryPath(dir), content);
    return { ok: true, entries: this.list(sessionId) };
  }

  /** Remove an entry (curation/dedup). Returns the updated compact list, or an error if absent/invalid. */
  remove(sessionId: string, name: string): PerCompanionRemoveResult<T> {
    const dir = this.resolveDir(sessionId, name);
    if (!dir) return { ok: false, error: `invalid ${this.opts.kind} name "${name}"` };
    if (!fs.existsSync(dir)) return { ok: false, error: `no ${this.opts.kind} "${name}"` };
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, entries: this.list(sessionId) };
  }
}
