import type { ProjectMemoryEntry } from "@loom/shared";
import type { Db } from "../db.js";

/**
 * Resolve INBOUND `[[wikilink]]` backlinks for a memory note — the fix for card e4e180ad's one-way-link
 * gap: when an overflow note is split off a capped canonical note (the store's own too-long rejection in
 * mcp/memory.ts recommends exactly this remedy), the overflow links FORWARD to the canonical note, but the
 * canonical note — being at its cap, which is precisely why the split happened — has no room left to add
 * the back-pointer. A reader who lands on the canonical note is then never led to the overflow.
 *
 * Mirrors project-memory-request-links.ts's shape deliberately: resolved fresh, at READ time, from every
 * surface that shows a note (memory_read/memory_list via mcp/memory.ts's `withLinks`, the kickoff digest
 * via project-memory-recall.ts's `annotate` callback) — never stored on the note itself, so it can NEVER
 * count against that note's own stored `text` byte cap (MAX_TEXT_BYTES / MAX_NEVER_DROP_TEXT_BYTES).
 *
 * A "backlink" here is any OTHER note in the same project whose `text` contains a literal `[[key]]`
 * wikilink referencing this note's key — a plain-substring scan, deliberately not Obsidian's `[[key|alias]]`
 * piping syntax: every memory note observed in this project's own store links with bare `[[key]]` (the
 * store's own too-long-rejection message in mcp/memory.ts recommends exactly that form), so a plain
 * key-token regex is sufficient and this doesn't invent syntax the store has never actually used.
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
 * the shared budget on EVERY kickoff, whether or not it ends up surviving the pack (an ordinary pinned
 * note that later gets dropped for budget still paid this sizing cost first) — this is not a `never-drop`-
 * specific concern, it's a "does the digest render this note at all" one.
 *
 * Measured live against this project's real corpus (2026-08-28, 400 notes / 31 pinned): at the general
 * `MAX_BACKLINKS=20`, the project's 8 real floor-tier (`pinned && never-drop`) notes would add ≈10,370
 * bytes / ≈2,593 estimated tokens COMBINED — but the 23 ORDINARY pinned notes add a comparable ≈10,594
 * bytes / ≈2,649 estimated tokens too (all pinned combined: ≈20,964 bytes / ≈5,241 est tokens), on a
 * project whose digest is ALREADY reported dropping 21 pinned notes for budget. An earlier version of this
 * cap applied only to the floor tier; that predicate was an unexamined default (it happened to be the tier
 * this card's evidence led with), not a reasoned boundary — the actual line is DIGEST vs ON-DEMAND, and
 * every digest-rendered note sits on the same side of it regardless of tier. At `cap=5` the SAME 31 pinned
 * notes add only ≈8,586 bytes / ≈2,147 est tokens combined — roughly a 59% reduction. The goal here is only
 * "tell the reader an overflow companion exists" (card e4e180ad's own bound — never the content), which a
 * handful of names satisfies as well as twenty. `memory_read`/`memory_list` keep the full {@link
 * MAX_BACKLINKS}, since an agent pulling one note on demand isn't paying this cost on every OTHER
 * session's kickoff too.
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
 * full-corpus scan per call — not indexed. **Card 41c3f546 reconciliation:** the "dozens to
 * low-hundreds of short notes" premise this used to cite was already false by the time {@link
 * MAX_BACKLINKS_DIGEST}'s own neighbouring comment recorded a real corpus at 400 notes (2026-08-28) —
 * the two comments contradicted each other. (project-memory-recall.ts, cited by the old wording as
 * sharing this premise, does NOT actually carry it as of this reconciliation — re-checked directly,
 * not assumed.) Measured directly against this project's own live corpus (2026-09-03: 487 notes, ~1.5MB
 * of text): ONE call here is genuinely cheap (~10-15ms, dominated by the SQL fetch/row-map, not the
 * regex scan) — a single on-demand call (`memory_read`, one row of the kickoff digest) is fine exactly
 * as this function is written, index or no index. The cost this comment used to gloss over is calling
 * this ONCE PER ROW of a listing: that turns a ~15ms query into an O(N²) ~4.2s wall-clock cost on this
 * corpus, run SYNCHRONOUSLY on the daemon's single event loop. A LIST caller must never call this per
 * row — use {@link findInboundBacklinksBulk}, which amortizes the corpus fetch and the per-note regex
 * extraction ONCE across every row instead of paying for either N times.
 *
 * **Card d305f1a2 — still O(N²), by measurement, deliberately:** re-measured live against this
 * project's own real corpus (2026-09-04: 502 notes, ~1.5MB) — `findInboundBacklinksBulk` (below) over
 * the WHOLE corpus runs in ~22ms; a uniform-key-length synthetic scaling series (1x/2x/4x/8x that same
 * corpus) put the empirical growth exponent at ~1.75-1.90, consistent with the O(N²) shape this comment
 * already predicted. Left unindexed anyway: this project's OWN `memory.maxNotes` config caps the
 * UNPINNED population at 500 (owner decision #2, `evictProjectMemoryOverCap`) — live-checked the same
 * day, 494 of 502 notes are unpinned and sitting right at that cap, with only 8 pinned (pinned notes are
 * exempt from eviction and are the only unbounded growth path). Even at the platform-wide hard ceiling
 * (`MEMORY_CONFIG_MAX.maxNotes` = 1000, i.e. ~2x today's corpus) the SAME scaling series measured only
 * ~31ms. An inverted index would remove the asymptotic risk entirely, but the risk is currently bounded
 * by config, not by luck — re-measure before reaching for it if `maxNotes` is ever raised meaningfully
 * past its current default, or if the pinned population grows into the hundreds.
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
