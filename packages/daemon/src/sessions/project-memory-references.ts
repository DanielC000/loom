import type { ProjectMemoryEntry } from "@loom/shared";
import { isProjectMemoryExpired } from "@loom/shared";
import type { Db } from "../db.js";
import { extractPathTokens } from "./project-memory-path-tokens.js";

/**
 * Card a140598a — auto-detected CARD/DECISION/PATH references across memory notes, surfaced like the
 * manual `[[wikilink]]` backlink mechanism (project-memory-backlinks.ts) but on a different signal: two
 * notes that both cite the same board card, decision anchor, or file path are connected even when nobody
 * typed a `[[key]]` between them — the GAP the card's own body names. STRICT SUPERSET of the wikilink
 * mechanism, never a replacement: wikilink backlinks are untouched here, and {@link maskWikilinkSpans}
 * keeps the two signals disjoint — a hex run or path token sitting INSIDE an existing `[[key]]` is never
 * also extracted by this file (counted exactly once, by the wikilink mechanism alone).
 *
 * @decision a140598a — a bare 8-hex token must resolve to a REAL task (an ambiguous prefix counts as
 * unresolved, never guessed) before it counts as a card mention; a decision-anchor citation and a path
 * token are accepted as-is, unverified.
 *
 * Full record: docs/decisions/a140598a-reference-extraction-false-match-limiting.md
 */

/** Mirrors project-memory-backlinks.ts's own `WIKILINK_RE` character class exactly (a non-capturing
 *  span match this time — this file only ever needs to BLANK a wikilink span, never read its key). */
const WIKILINK_SPAN_RE = /\[\[[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\]\]/g;

/** Blank every `[[key]]` span to same-length whitespace — never shrink the string (shrinking would shift
 *  every later match's offset for no benefit; nothing downstream here needs offsets, but keeping lengths
 *  stable keeps this function trivially safe to reuse if that ever changes). */
function maskWikilinkSpans(text: string): string {
  return text.replace(WIKILINK_SPAN_RE, (m) => " ".repeat(m.length));
}

/** `@decision <id>` / `@decision sha:<8hex>` — the SAME citation grammar `decisions_for`/
 *  comment-anchor-lint already recognize (CLAUDE.md's "Comment taxonomy — the source-vs-record split").
 *  Hex digits are case-insensitive (a hand-typed anchor occasionally capitalizes them); the literal
 *  `sha:`/`@decision` tokens are not — no real anchor in this repo's own source varies their case. */
const DECISION_ANCHOR_RE = /@decision\s+(sha:[0-9a-fA-F]{8}|[0-9a-fA-F]{8})\b/g;

/** Blank every `@decision <id>` anchor span the SAME way {@link maskWikilinkSpans} blanks a wikilink —
 *  so the id inside it is never ALSO picked up as a separate bare card-id mention by
 *  {@link extractCardIdCandidates} (the file-level "no double-counting" guarantee, applied a second time
 *  for this pairing — decision-anchor vs. bare-card, not just wikilink vs. bare-card). */
function maskDecisionAnchors(text: string): string {
  return text.replace(DECISION_ANCHOR_RE, (m) => " ".repeat(m.length));
}

/** Every DISTINCT `@decision <id>` citation in `text`, in first-seen order, lowercased (`sha:` form kept
 *  prefixed, e.g. `sha:c70a5e0e`) — pure parsing, no DB/task resolution (see the file-level decision
 *  comment for why decision anchors skip the real-card filter that bare card ids go through). */
export function extractDecisionAnchorIds(text: string): string[] {
  const masked = maskWikilinkSpans(text);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of masked.matchAll(DECISION_ANCHOR_RE)) {
    const raw = m[1];
    if (!raw) continue;
    const id = raw.startsWith("sha:") ? `sha:${raw.slice(4).toLowerCase()}` : raw.toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/** Bare 8-hex CANDIDATE tokens — not yet filtered against real tasks (see {@link resolveRealCardIds}).
 *  Masks out both a wikilink span AND a `@decision` anchor span first, so a hex id living inside either
 *  is never ALSO extracted here. `\b` boundaries are enough on their own to reject matching only part of
 *  a longer hex run (a 40-char commit sha, a full UUID's own later segments) — hex digits are `\w`
 *  characters, so `\b[0-9a-fA-F]{8}\b` only fires at the edges of a contiguous alphanumeric run, never
 *  mid-run. */
const BARE_CARD_ID_RE = /\b[0-9a-fA-F]{8}\b/g;

export function extractCardIdCandidates(text: string): string[] {
  const masked = maskDecisionAnchors(maskWikilinkSpans(text));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of masked.matchAll(BARE_CARD_ID_RE)) {
    const id = m[0].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/** Filters `candidateIds` down to the ones that resolve to EXACTLY ONE real task, via an O(1) lookup
 *  into a `prefix(8) -> how many tasks share it` map (see `Db.countTaskIdPrefixes`, which builds one for
 *  just the candidates in hand rather than reading the board) — a count of 1 is "found", 0 is "none", and 2+ is
 *  "ambiguous" (dropped, never guessed), the same three outcomes `resolveIdPrefix` distinguishes. This
 *  is the false-match limiter the card's own DoD calls for: a candidate that is really a commit sha or
 *  other incidental hex never survives unless it happens to also be a genuine task id-prefix on THIS
 *  project. */
function resolveRealCardIds(candidateIds: string[], prefixCounts: Map<string, number>): string[] {
  return candidateIds.filter((id) => prefixCounts.get(id) === 1);
}

/**
 * Card a140598a round 2 — `extractPathTokens` is reused UNMODIFIED (its own `triggerGlob` caller keeps
 * its existing, more permissive behavior; see the decision record) because it matches a bare numeric
 * ratio like "3/3" appearing in ordinary prose ("proven 3/3") as a syntactically valid 2-segment
 * "path" — no letter anywhere, so it can never be a real repo path. Filtering HERE, at this module's
 * own call site, keeps that fix scoped to the mentions feature alone: a token must contain at least one
 * letter, AND either look like a real filename (a dot-extension suffix) or have at least one segment
 * that's more than a single stray character with a letter in it (rejecting a degenerate "a/b" the same
 * way as "3/3", while still accepting an extension-less path like "docs/decisions").
 */
const PATH_EXTENSION_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

function isPlausiblePathToken(token: string): boolean {
  if (!/[A-Za-z]/.test(token)) return false;
  if (PATH_EXTENSION_RE.test(token)) return true;
  return token.split("/").some((seg) => seg.length >= 2 && /[A-Za-z]/.test(seg));
}

/** One note's extracted, de-duplicated reference set. `cardIds` are already filtered to real tasks (see
 *  {@link resolveRealCardIds}); `decisionIds`/`paths` are accepted as-is (see the file-level decision
 *  comment for why). */
export interface NoteReferences {
  cardIds: string[];
  decisionIds: string[];
  paths: string[];
}

/**
 * Pure extraction: `prefixCounts` (`prefix(8) -> task count`, see `Db.countTaskIdPrefixes`) is built
 * ONCE and handed to every note's extraction call here, instead of resolving each candidate against
 * the task list afresh per note.
 */
export function extractNoteReferencesUsingPrefixCounts(text: string, prefixCounts: Map<string, number>): NoteReferences {
  return {
    cardIds: resolveRealCardIds(extractCardIdCandidates(text), prefixCounts),
    decisionIds: extractDecisionAnchorIds(text),
    paths: extractPathTokens(maskWikilinkSpans(text)).filter(isPlausiblePathToken),
  };
}

type ReferenceKind = "card" | "decision" | "path";

/** One entity this note mentions that at least one OTHER note in the corpus ALSO mentions. */
export interface NoteMention {
  kind: ReferenceKind;
  id: string;
}

function referenceMapKey(kind: ReferenceKind, id: string): string {
  return `${kind}:${id}`;
}

interface EntryWithRefs {
  key: string;
  refs: NoteReferences;
}

/**
 * Card a140598a — corpus-bounded reverse index: entity (`kind:id`) -> set of note KEYS that mention it.
 * Built in ONE pass over the corpus — every note's references extracted exactly once, never once per
 * note per target — mirroring {@link import("./project-memory-backlinks.js").findInboundBacklinksBulk}'s
 * own shape. {@link findConnectedMentions} builds it once per single-note read, so the cost is one pass
 * over the corpus, bounded by `memory.maxNotes` — re-measure if that cap is ever raised meaningfully.
 */
function buildReferenceIndex(withRefs: EntryWithRefs[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (kind: ReferenceKind, id: string, key: string) => {
    const mapKey = referenceMapKey(kind, id);
    let set = index.get(mapKey);
    if (!set) {
      set = new Set();
      index.set(mapKey, set);
    }
    set.add(key);
  };
  for (const { key, refs } of withRefs) {
    for (const id of refs.cardIds) add("card", id, key);
    for (const id of refs.decisionIds) add("decision", id, key);
    for (const id of refs.paths) add("path", id, key);
  }
  return index;
}

/** For ONE note's own `refs`, which of them are CONNECTED — shared by at least one OTHER note in the
 *  corpus (the index's set for that entity has more than this note's own key in it). Capped at `cap`,
 *  alongside the TRUE total found before the cap — the identical "matches + totalFound" shape
 *  {@link import("./project-memory-backlinks.js").findInboundBacklinks} already uses for backlinks. An
 *  entity this note mentions that NOTHING else mentions is simply not "connected" — it's already fully
 *  visible by reading the note's own text, so excluding it here is not a loss, it's the whole point: this
 *  annotation exists to surface a cross-note CONNECTION, not to echo the note's own citations back at it. */
function connectedMentionsFor(
  selfKey: string,
  refs: NoteReferences,
  index: Map<string, Set<string>>,
  cap: number,
): { matches: NoteMention[]; totalFound: number } {
  const candidates: NoteMention[] = [
    ...refs.cardIds.map((id): NoteMention => ({ kind: "card", id })),
    ...refs.decisionIds.map((id): NoteMention => ({ kind: "decision", id })),
    ...refs.paths.map((id): NoteMention => ({ kind: "path", id })),
  ];
  const connected = candidates.filter((c) => {
    const notes = index.get(referenceMapKey(c.kind, c.id));
    // `notes` always contains `selfKey` for any id in `refs` (the index was built FROM these same refs) —
    // size > 1 is therefore exactly "at least one OTHER note shares this entity", never inflated by
    // counting this note against itself.
    return (notes?.size ?? 0) > 1;
  });
  return { matches: connected.slice(0, cap), totalFound: connected.length };
}

/** The cap on the structured `mentions` list `memory_read` returns for one note. */
export const MAX_MENTIONS = 10;

/** Bound on how many bare-hex candidates from ONE note are resolved against the board — each costs one
 *  indexed range probe, so this keeps a hex-heavy note (a pasted log) from turning a read into a scan. */
const MAX_CARD_CANDIDATES = 64;

/**
 * The entities `target` mentions that at least one OTHER live note in the project also mentions —
 * single-note, on-demand (`memory_read`). `totalFound` is the true count before the `cap`.
 *
 * Cost shape: one corpus fetch (the same one backlinks already makes) plus ONE indexed range probe per
 * bare-hex candidate in the TARGET's own text (`Db.countTaskIdPrefixes`) — never a board read. Resolving
 * only the target's candidates is sufficient: a card is "shared" only if another note cites the same hex
 * token, and that token is in the target's candidate set by definition.
 *
 * @decision 57a91801 — an expired note is neither a mentioner nor a mentioned note, so an expired
 * target reports nothing and an expired sharer never connects a live note.
 *
 * Full record: docs/decisions/a140598a-reference-extraction-false-match-limiting.md
 */
export function findConnectedMentions(
  db: Db,
  projectId: string,
  target: Pick<ProjectMemoryEntry, "key" | "text" | "expiresAt">,
  cap: number = MAX_MENTIONS,
): { matches: NoteMention[]; totalFound: number } {
  if (isProjectMemoryExpired(target)) return { matches: [], totalFound: 0 };
  const candidates = extractCardIdCandidates(target.text).slice(0, MAX_CARD_CANDIDATES);
  const prefixCounts = db.countTaskIdPrefixes(projectId, candidates);
  const others = db.listProjectMemory(projectId).filter((m) => m.key !== target.key && !isProjectMemoryExpired(m));
  const targetRefs = extractNoteReferencesUsingPrefixCounts(target.text, prefixCounts);
  const withRefs: EntryWithRefs[] = [
    { key: target.key, refs: targetRefs },
    ...others.map((m) => ({ key: m.key, refs: extractNoteReferencesUsingPrefixCounts(m.text, prefixCounts) })),
  ];
  return connectedMentionsFor(target.key, targetRefs, buildReferenceIndex(withRefs), cap);
}
