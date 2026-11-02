import type { ProjectMemoryEntry, Task } from "@loom/shared";
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

/**
 * Card a140598a round 2 (performance — see the decision record's "Round 2" section) — a ONE-TIME
 * O(tasks) pass building `prefix(8) -> how many tasks share it`, so resolving N bare-hex candidates
 * against a project's task list costs O(N) total (one `Map.get` per candidate) once this map has been
 * built, instead of O(N × tasks) (one linear `resolveIdPrefix` scan per candidate). Exactly equivalent
 * to `resolveIdPrefix`'s own semantics for an 8-char ref: a card-id candidate is always exactly 8 hex
 * chars ({@link BARE_CARD_ID_RE}'s own match width) and a task id is a 36-char UUID, so
 * `id.startsWith(ref)` for an 8-char `ref` is identical to `id.slice(0,8) === ref` — there is no
 * shorter-than-8 or exact-full-id case to special-case here the way the general-purpose
 * `resolveIdPrefix` must. Build this ONCE per digest composition (see {@link buildMentionsIndex}),
 * never once per candidate or once per note.
 */
export function buildCardIdPrefixCounts(tasks: Pick<Task, "id">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const prefix = t.id.slice(0, 8).toLowerCase();
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return counts;
}

/** Filters `candidateIds` down to the ones that resolve to EXACTLY ONE real task, via an O(1) lookup
 *  into a prebuilt {@link buildCardIdPrefixCounts} map — a count of 1 is "found", 0 is "none", and 2+ is
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
 * Pure extraction, hot-path-safe: `prefixCounts` (see {@link buildCardIdPrefixCounts}) is built ONCE
 * per digest composition and handed to every note's extraction call here, instead of resolving each
 * candidate against the task list afresh per note. Use {@link extractNoteReferences} instead only for a
 * single ad hoc call where you merely have a raw task array (e.g. a unit test) — never in a loop over
 * many notes.
 */
export function extractNoteReferencesUsingPrefixCounts(text: string, prefixCounts: Map<string, number>): NoteReferences {
  return {
    cardIds: resolveRealCardIds(extractCardIdCandidates(text), prefixCounts),
    decisionIds: extractDecisionAnchorIds(text),
    paths: extractPathTokens(maskWikilinkSpans(text)).filter(isPlausiblePathToken),
  };
}

/**
 * Convenience wrapper over {@link extractNoteReferencesUsingPrefixCounts} for a single ad hoc call
 * (tests, or a genuinely one-off lookup) — builds its own {@link buildCardIdPrefixCounts} map from
 * `tasks` on every call. NEVER call this once per note in a loop over many notes — build the prefix map
 * (or call {@link findConnectedMentionsBulk}/{@link buildMentionsIndex}) ONCE instead; see the decision
 * record's "Round 2" section for the exact per-note blowup this guards against.
 */
export function extractNoteReferences(text: string, tasks: Pick<Task, "id">[]): NoteReferences {
  return extractNoteReferencesUsingPrefixCounts(text, buildCardIdPrefixCounts(tasks));
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
 * own shape. Still O(N²) overall once every note's mentions are cross-checked against every other's (see
 * {@link findConnectedMentionsBulk}), left unindexed on purpose, same as card d305f1a2's own backlinks
 * precedent: bounded by `memory.maxNotes`, not luck — re-measure before reaching for a real index if that
 * cap is ever raised meaningfully.
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

/** The digest-render cap — deliberately small, mirroring
 *  {@link import("./project-memory-backlinks.js").MAX_BACKLINKS_DIGEST}'s own "every digest-rendered note
 *  pays this sizing cost on every kickoff" reasoning. There is no separate larger on-demand cap the way
 *  backlinks has one for memory_read/memory_list (card e4e180ad's `MAX_BACKLINKS`): this feature has no
 *  on-demand surface of its own yet — see the card's own "stay in recall/backlink code" scope note — so a
 *  single cap, sized for the digest, is the only one that exists today. */
export const MAX_MENTIONS_DIGEST = 5;

/**
 * Bulk variant — resolves EVERY note's connected mentions in ONE pass over `corpus`, instead of one full
 * extraction pass per note per target. `tasks` is the project's own task list (for the card-id resolve
 * filter); both parameters are plain arrays, so this stays hermetically testable with fixture data, no
 * live `Db` required. Keyed by note `key`, with exactly one entry per note in `corpus`.
 */
export function findConnectedMentionsBulk(
  corpus: Pick<ProjectMemoryEntry, "key" | "text">[],
  tasks: Pick<Task, "id">[],
  cap: number = MAX_MENTIONS_DIGEST,
): Map<string, { matches: NoteMention[]; totalFound: number }> {
  const prefixCounts = buildCardIdPrefixCounts(tasks);
  const withRefs: EntryWithRefs[] = corpus.map((entry) => ({
    key: entry.key,
    refs: extractNoteReferencesUsingPrefixCounts(entry.text, prefixCounts),
  }));
  const index = buildReferenceIndex(withRefs);
  const result = new Map<string, { matches: NoteMention[]; totalFound: number }>();
  for (const { key, refs } of withRefs) {
    result.set(key, connectedMentionsFor(key, refs, index, cap));
  }
  return result;
}

/**
 * Card a140598a round 2 — the ONE impure entry point real callers use: builds the corpus+task-derived
 * mentions map EXACTLY ONCE per digest composition / write-time status computation (never once per
 * note — see {@link annotateMentionsPrecomputed}).
 *
 * @decision a140598a — use `db.listTaskIds`, never `db.listTasks`, here: this module only ever reads
 * `id.slice(0,8)`, so the general read's per-row `toTask` conversion + its separate deferral-edges join
 * are pure waste it should never pay.
 *
 * @decision 57a91801 — excludes an expired note from the mentions corpus entirely (neither a mentioner
 * nor a mentioned note), matching card 57a91801's own exclusion of expired notes from every other
 * kickoff-rendering tier. See the decision record's "Round 4" section for why.
 *
 * Full record: docs/decisions/a140598a-reference-extraction-false-match-limiting.md ("Round 2"-"Round 4")
 */
export function buildMentionsIndex(
  db: Db,
  projectId: string,
  cap: number = MAX_MENTIONS_DIGEST,
): Map<string, { matches: NoteMention[]; totalFound: number }> {
  const corpus = db.listProjectMemory(projectId).filter((m) => !isProjectMemoryExpired(m));
  const tasks = db.listTaskIds(projectId).map((id): Pick<Task, "id"> => ({ id }));
  return findConnectedMentionsBulk(corpus, tasks, cap);
}

function mentionLabel(m: NoteMention): string {
  return `${m.kind} ${m.id}`;
}

/** Shared by {@link annotateMentionsPrecomputed} so the line shape lives in exactly one place. `[]`
 *  when nothing is connected — a MEASURED zero, same discipline as backlinks' own
 *  `linesForBacklinkResult`. */
function linesForMentionsResult({ matches, totalFound }: { matches: NoteMention[]; totalFound: number }): string[] {
  if (matches.length === 0) return [];
  const lines = [`[mentions: ${matches.map(mentionLabel).join(", ")}]`];
  if (totalFound > matches.length) {
    lines.push(`[mentions: showing ${matches.length} of ${totalFound} cross-referenced entities]`);
  }
  return lines;
}

/**
 * Every "connected mention" annotation line for `targetKey` — an O(1) lookup into `precomputed` (built
 * ONCE per composition, see {@link buildMentionsIndex}), never a fresh corpus/task scan per note. Same
 * bracketed-line style `[backlink: ...]` already renders in. Called from
 * project-memory-annotations.ts's `annotateNote`, the one place every digest-rendered note (and the
 * never-drop floor-tier byte estimate, mcp/memory.ts's `computeNeverDropStatus`/`computeRestTierSignal`)
 * gets its annotations from. `precomputed` is optional only so a caller with no map at all (e.g. a
 * hermetic test exercising request-links/backlinks alone) can omit it rather than pass an empty Map;
 * every real caller builds one via {@link buildMentionsIndex} first.
 */
export function annotateMentionsPrecomputed(
  precomputed: Map<string, { matches: NoteMention[]; totalFound: number }> | undefined,
  targetKey: string,
): string[] {
  if (!precomputed) return [];
  const result = precomputed.get(targetKey);
  if (!result) return [];
  return linesForMentionsResult(result);
}
