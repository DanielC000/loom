import type { ProjectMemoryEntry } from "@loom/shared";
import type { Db } from "../db.js";

/**
 * Resolve INBOUND `[[wikilink]]` backlinks for a memory note — resolved fresh, at READ time, from every
 * surface that shows a note (memory_read/memory_list via mcp/memory.ts's `withLinks`, the kickoff digest
 * via project-memory-recall.ts's `annotate` callback), never stored on the note itself, so it can NEVER
 * count against that note's own stored `text` byte cap. Mirrors project-memory-request-links.ts's shape
 * deliberately. A "backlink" is a plain-substring `[[key]]` match — deliberately not Obsidian's
 * `[[key|alias]]` piping syntax, since no note observed in this project's own store has ever used it.
 *
 * @decision e4e180ad — closes the one-way-link gap where a byte-capped canonical note has no room left
 * to add a back-pointer to the notes that already link to it.
 */

/** Mirrors mcp/memory.ts's `KEY_RE` character class exactly (letters/digits/-/_, 1-64 chars) — a wikilink
 *  can only ever reference a syntactically-valid memory key, so the same charset bounds what this matches. */
const WIKILINK_RE = /\[\[([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\]\]/g;

/** Every DISTINCT memory key `text` references via `[[key]]`, in first-seen order. Exported for direct
 *  unit coverage — no DB involved, pure string parsing. */
export function extractWikilinkKeys(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const key = m[1];
    if (key && !seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  return ordered;
}

/**
 * Card e4e180ad DoD-3 — bounds the blast radius on a note many others happen to link to, for an
 * ON-DEMAND read (memory_read/memory_list) — an explicit, one-off pull an agent chose to make, not a cost
 * repeated on every kickoff. A backlink beyond this cap is NOT lost — it still exists in its source note
 * — just not listed inline; {@link annotateBacklinks} always names the true total so a reader can still
 * discover the rest via `memory_list` rather than the overflow being silent.
 */
export const MAX_BACKLINKS = 20;

/**
 * A MUCH tighter cap for the ONE path where this cost is NOT a one-off: ANY note's backlinks, as rendered
 * into the KICKOFF DIGEST (project-memory-annotations.ts's `annotateNote`, which mcp/memory.ts's
 * `computeNeverDropStatus` mirrors for its byte estimate) — every note the digest packs is SIZED against
 * the shared budget on EVERY kickoff, whether or not it ends up surviving the pack — this is not a
 * `never-drop`-specific concern, it's a "does the digest render this note at all" one. `memory_read`/
 * `memory_list` keep the full {@link MAX_BACKLINKS}, since an on-demand pull isn't paying this cost on
 * every OTHER session's kickoff too.
 *
 * @decision e4e180ad — the line is DIGEST vs ON-DEMAND, not floor-tier vs ordinary — measured, ordinary
 * pinned notes cost as much as floor-tier ones at the general cap.
 */
export const MAX_BACKLINKS_DIGEST = 5;

/** One note that wikilinks to a target key. */
export interface InboundBacklink {
  key: string;
}

/** One corpus note paired with its already-extracted wikilink keys — computed once, shared by both
 *  {@link findInboundBacklinks} and {@link findInboundBacklinksBulk} via {@link matchesFor} below. */
interface EntryWithKeys {
  entry: ProjectMemoryEntry;
  keys: string[];
}

/**
 * Card d305f1a2 — the match predicate (self-link exclusion + `keys.includes(targetKey)`) and the
 * ordering (`updatedAt` desc, `key` asc tiebreak) used to be copied separately into {@link
 * findInboundBacklinks} and {@link findInboundBacklinksBulk} — a real shared-unit-divergence risk held
 * only by test/project-memory-backlinks.mjs's §2b equivalence check, not by structure. Both now call
 * THIS function, so the two paths cannot diverge: there is exactly one implementation of "what counts as
 * a backlink and how they're ordered" for either caller to run.
 */
function matchesFor(withKeys: EntryWithKeys[], targetKey: string, cap: number): { matches: InboundBacklink[]; totalFound: number } {
  const matching = withKeys
    .filter((x) => x.entry.key !== targetKey && x.keys.includes(targetKey))
    .map((x) => x.entry)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
  return {
    matches: matching.slice(0, cap).map((m) => ({ key: m.key })),
    totalFound: matching.length,
  };
}

/**
 * Every OTHER note in the project whose text wikilinks to `targetKey`, most-recently-updated first,
 * capped at `cap` (default {@link MAX_BACKLINKS}), alongside the TRUE total found (before the cap). A
 * full-corpus scan per call — not indexed; genuinely cheap for a single on-demand call (`memory_read`,
 * one row of the kickoff digest).
 *
 * A LIST caller must never call this per row — that turns a cheap single call into an O(N²) cost run
 * SYNCHRONOUSLY on the daemon's single event loop. Use {@link findInboundBacklinksBulk} instead, which
 * amortizes the corpus fetch and the per-note regex extraction ONCE across every row.
 *
 * @decision 41c3f546 — the "dozens to low-hundreds" corpus-size premise this used to cite is stale
 * (487 notes measured).
 * @decision d305f1a2 — still O(N²) overall even with the bulk path, left unindexed anyway — bounded
 * by `memory.maxNotes` (config), not luck; re-measure before reaching for an index if that cap is raised.
 */
export function findInboundBacklinks(
  db: Db,
  projectId: string,
  targetKey: string,
  cap: number = MAX_BACKLINKS,
): { matches: InboundBacklink[]; totalFound: number } {
  const withKeys = db.listProjectMemory(projectId).map((entry) => ({ entry, keys: extractWikilinkKeys(entry.text) }));
  return matchesFor(withKeys, targetKey, cap);
}

/**
 * Bulk variant of {@link findInboundBacklinks} — resolves EVERY note's inbound backlinks in ONE pass
 * over `corpus`, instead of one full `db.listProjectMemory` fetch + one full-corpus regex scan PER note
 * (see {@link findInboundBacklinks}'s own doc comment for the O(N²) cost this replaces). The caller
 * fetches `corpus` itself (typically `db.listProjectMemory(projectId)`) and passes it once;
 * `extractWikilinkKeys` then runs exactly ONCE per note — not once per note per target — and the
 * per-target match/sort runs through the SAME {@link matchesFor} helper {@link findInboundBacklinks}
 * uses, over those already-extracted key lists, never a fresh regex scan — which is what turns the cost
 * from O(N × corpus bytes) into O(N × average links-per-note) per target (still O(N²) overall; see the
 * card d305f1a2 note on {@link findInboundBacklinks} above for why that's left as-is for now).
 *
 * Keyed by note `key`, with exactly one entry per note in `corpus`. Semantics — self-link exclusion,
 * most-recently-updated-first ordering, the `cap`/`totalFound` split — are IDENTICAL to calling
 * {@link findInboundBacklinks} once per note (now structurally so, both routing through {@link
 * matchesFor}); this function changes only HOW the corpus is fetched and scanned, never WHAT is
 * returned.
 */
export function findInboundBacklinksBulk(
  corpus: ProjectMemoryEntry[],
  cap: number = MAX_BACKLINKS,
): Map<string, { matches: InboundBacklink[]; totalFound: number }> {
  const withKeys = corpus.map((entry) => ({ entry, keys: extractWikilinkKeys(entry.text) }));
  const result = new Map<string, { matches: InboundBacklink[]; totalFound: number }>();
  for (const target of corpus) {
    result.set(target.key, matchesFor(withKeys, target.key, cap));
  }
  return result;
}

/** One backlink's annotation line — deliberately names ONLY the key (already a safe, KEY_RE-bounded
 *  slug), never the linking note's title or any of its body: "surfacing [[companion]] tells a reader
 *  something exists; it does not deliver its content" (card e4e180ad's explicit bound) — a free-form title
 *  would also need the same header-forging sanitization noteBlock's own title does, for zero benefit over
 *  just naming the key a reader can `memory_read` themselves. */
function backlinkLine(b: InboundBacklink): string {
  return `[backlink: [[${b.key}]] links here]`;
}

/** Shared by {@link annotateBacklinks} and {@link annotateBacklinksBulk} so both render an identical
 *  line shape from an already-resolved `{matches, totalFound}` result — the truncation-notice wording
 *  lives in exactly one place regardless of which resolution path produced the result. */
function linesForBacklinkResult({ matches, totalFound }: { matches: InboundBacklink[]; totalFound: number }): string[] {
  const lines = matches.map(backlinkLine);
  if (totalFound > matches.length) {
    lines.push(`[backlinks: showing ${matches.length} of ${totalFound} inbound links — see memory_list for the rest]`);
  }
  return lines;
}

/**
 * Every inbound-backlink annotation line for `targetKey`, in order, PLUS a truncation notice when the
 * project has more inbound links than `cap` shows (never silent — same "N of M" idiom
 * project-memory-recall.ts's own dropped-tier notices use). `[]` when nothing links here — a MEASURED
 * zero: this function always returns an array, so "no backlinks" and "backlinks not resolved at all" are
 * never the same shape at the call site (see mcp/memory.ts's `ProjectMemoryEntryWithLinks.backlinks`,
 * which is likewise always present, never omitted). `cap` defaults to {@link MAX_BACKLINKS} (the
 * on-demand-read cap); project-memory-annotations.ts's `annotateNote` passes the tighter {@link
 * MAX_BACKLINKS_DIGEST} unconditionally, for EVERY note the kickoff digest renders.
 */
export function annotateBacklinks(db: Db, projectId: string, targetKey: string, cap: number = MAX_BACKLINKS): string[] {
  return linesForBacklinkResult(findInboundBacklinks(db, projectId, targetKey, cap));
}

/**
 * Bulk variant of {@link annotateBacklinks}, built on {@link findInboundBacklinksBulk} — every note in
 * `corpus` gets its annotation lines resolved from ONE pass over the corpus instead of one full
 * `db.listProjectMemory` fetch + scan per note. Keyed by note `key`; every entry in `corpus` gets exactly
 * one map entry (possibly `[]`, a measured zero — never omitted). For a LIST caller (`memory_list`, the
 * human-UI REST route) — never for a single on-demand read, which stays on {@link annotateBacklinks}.
 */
export function annotateBacklinksBulk(corpus: ProjectMemoryEntry[], cap: number = MAX_BACKLINKS): Map<string, string[]> {
  const perNote = findInboundBacklinksBulk(corpus, cap);
  const lines = new Map<string, string[]>();
  for (const [key, result] of perNote) lines.set(key, linesForBacklinkResult(result));
  return lines;
}
