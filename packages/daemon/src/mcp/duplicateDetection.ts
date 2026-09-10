import type { Task } from "@loom/shared";

/**
 * Cross-channel duplicate-card detection (board card 5b221bf2): extracts rare identifiers (a
 * session id, git branch, OS error constant, `file:line`, or code symbol) that survive independent
 * authorship of the same incident, and lets the caller (see {@link findSuspectedDuplicate}) match on
 * their intersection, rarity-weighted against the existing corpus — no prose/title similarity, no
 * embeddings.
 *
 * @decision 5b221bf2 — design rationale + the false-positive tuning history behind the STRONG/WEAK
 *   tier split below (three measured fix mechanisms, 47.5% → 22.5% FP rate on a 40-card sample).
 *
 * @decision b6eab182 — weak evidence, of ANY category in ANY combination, never qualifies a match on
 *   its own; only a shared STRONG identifier does.
 */

/** STRONG identifiers: near-impossible to share by coincidence or by discussing the same general
 *  area — a single shared one is sufficient evidence on its own. Deliberately EXCLUDES a bare
 *  numeric "error code: NNN" (shared by an entire incident FAMILY, not one duplicate pair — the
 *  NAMED constant below is specific enough to stand alone) and `file:line` (see the module doc). */
const STRONG_PATTERNS: RegExp[] = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // full UUIDs (session ids, etc.)
  /\bloom\/[0-9a-f]{6,}\b/gi, // Loom worktree branch names
];

/** Minimum length for a bare (non-punctuated) casing-shaped token to count — excludes short,
 *  common abbreviations (e.g. "DoD") that would otherwise match the PascalCase shape below and,
 *  because they appear in nearly every card, would corrupt matching before rarity even gets a say. */
const MIN_SYMBOL_LEN = 6;

/** WEAK categories: code-symbol-shaped (or `file:line`-shaped), but plausibly shared by two cards
 *  that merely discuss the same tool/subsystem rather than the same incident. NEVER sufficient alone
 *  (card b6eab182) — corroboration only, once a STRONG identifier already qualifies a match. Every
 *  segment-based pattern below requires a lowercase TAIL per segment (`[a-z0-9]+`, not `[a-z0-9]*`) —
 *  the fix for mechanism 1 above: an all-caps word can no longer parse as N single-letter Pascal
 *  segments. */
const WEAK_CATEGORIES: { name: string; pattern: RegExp }[] = [
  { name: "screaming_snake", pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g }, // ERROR_FILENAME_EXCED_RANGE
  { name: "snake_case", pattern: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g }, // worker_stop
  { name: "camel_case", pattern: /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g }, // buildSpawnArgs
  { name: "pascal_case", pattern: /\b(?:[A-Z][a-z0-9]+){2,}\b/g }, // CreateProcess
  { name: "file_line", pattern: /\b[\w./-]+\.(?:ts|tsx|js|mjs|jsx):\d+\b/g }, // service.ts:8897
];

/** ⛔ Card b6eab182 (2026-08-06): weak evidence — however many DISTINCT categories it spans — is no
 *  longer sufficient BY ITSELF to qualify a task as a suspected duplicate (see the module doc's
 *  "CARD b6eab182" section). Weak-category richness is retained only as a ranking/corroboration
 *  signal once a STRONG identifier has already qualified a task — see {@link findSuspectedDuplicate}'s
 *  tie-break. There is no longer a "minimum weak categories to qualify" constant: a bare `strong.length
 *  === 0` skip replaces it. */

function extract(text: string, patterns: RegExp[], minLen = 0): Set<string> {
  const ids = new Set<string>();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (m[0].length < minLen) continue;
      ids.add(m[0].toLowerCase().replace(/\s+/g, ""));
    }
  }
  return ids;
}

/** Per-task extraction cache: strong identifiers + weak identifiers PER CATEGORY, computed ONCE per
 *  distinct text (title+body) rather than once per tier per comparison (card 5b221bf2 Code Review
 *  finding m4 — the original shape re-extracted every existing task's full text twice). */
interface ExtractedTask {
  id: string;
  title: string;
  strong: Set<string>;
  weakByCategory: Map<string, Set<string>>;
}

function extractTask(t: Pick<Task, "id" | "title" | "body">): ExtractedTask {
  const text = `${t.title}\n${t.body ?? ""}`;
  const weakByCategory = new Map<string, Set<string>>();
  for (const { name, pattern } of WEAK_CATEGORIES) weakByCategory.set(name, extract(text, [pattern], MIN_SYMBOL_LEN));
  return { id: t.id, title: t.title, strong: extract(text, STRONG_PATTERNS), weakByCategory };
}

/** Extracts every rare-identifier CANDIDATE (strong + every weak category, pooled) from free text
 *  (a task's title+body) — the union a caller would want for a quick "does this text carry any
 *  identifiers at all" check. Pure — no DB, no corpus knowledge. See {@link findSuspectedDuplicate}
 *  for how candidates, tiered into strong/weak-by-category, actually become matching evidence. */
export function extractIdentifiers(text: string): Set<string> {
  const ids = extract(text, STRONG_PATTERNS);
  for (const { pattern } of WEAK_CATEGORIES) for (const id of extract(text, [pattern], MIN_SYMBOL_LEN)) ids.add(id);
  return ids;
}

export interface DuplicateMatch {
  taskId: string;
  title: string;
  /** The rare identifiers this task shares with the candidate — surfaced in the refusal so the
   *  caller can see WHY it was flagged, not just that it was. Always includes at least one STRONG
   *  identifier (card b6eab182 — see the module doc's "CARD b6eab182" section: weak evidence alone
   *  can no longer produce a match, so this field can no longer be weak-only either); any WEAK tokens
   *  present are corroborating context, not the reason for the flag. Bounded — see the caller. */
  sharedIdentifiers: string[];
}

/**
 * Finds the existing task (if any) that shares "rare" identifiers with `candidateText` — the
 * detector behind card 5b221bf2's refuse-unless-acknowledged `tasks_create` check.
 *
 * A task qualifies as a suspected duplicate ONLY when it shares with the candidate at least one rare
 * STRONG identifier (a session id / task id — both full UUIDs — or a Loom branch name). Rare WEAK
 * identifiers (a named error constant, a code symbol, a `file:line` ref), however many DISTINCT
 * categories they span, are corroboration ONLY once a strong hit already qualifies — never sufficient
 * alone (card b6eab182 — see the module doc's "CARD b6eab182" section for why: 5 real spurious
 * create-blocks measured in live usage, on top of the false-positive history below).
 *
 * `rarityThreshold`: an identifier only counts as evidence for a task T if it appears — INCLUDING T
 * itself — in at most this many of the tasks in `existingTasks` (i.e. it is itself a rare,
 * incident-specific value rather than ordinary shared vocabulary). Corpus-relative and computed
 * fresh each call, not a hardcoded exclude list: a term common enough to appear in many cards (a
 * tool name, a field name) is filtered out by frequency alone, however identifier-shaped it looks.
 *
 * @decision 5b221bf2 — a known, deliberately unfixed false-positive class: a design/meta document
 *   quoting past incidents' identifiers as worked examples can flag as a duplicate of one of them.
 *
 * @decision 0ef0270b — HISTORICAL, closed by `b6eab182`: a second false-positive class where two
 *   unrelated cards shared a coincidental code landmark or naming convention.
 *
 * Returns the single BEST-qualifying match — ranked by strong-hit count first, then weak-category
 * count, then total weak token count as a final tie-break — or null if none clears the bar. Never
 * mutates, never reads a DB directly — the caller supplies the candidate corpus (typically
 * `db.listTasks(projectId)`, which — unlike `tasks_list` — already includes done cards; two of the
 * founding specimens for this detector are in `done`).
 */
export function findSuspectedDuplicate(
  existingTasks: Pick<Task, "id" | "title" | "body">[],
  candidateText: string,
  rarityThreshold = 3,
): DuplicateMatch | null {
  const candidateStrong = extract(candidateText, STRONG_PATTERNS);
  const candidateWeakByCategory = new Map(WEAK_CATEGORIES.map(({ name, pattern }) => [name, extract(candidateText, [pattern], MIN_SYMBOL_LEN)]));
  const candidateHasAny = candidateStrong.size > 0 || [...candidateWeakByCategory.values()].some((s) => s.size > 0);
  if (!candidateHasAny) return null;

  const extracted = existingTasks.map(extractTask);

  // identifier -> ids of tasks (in `extracted`, INCLUDING a task's own self-match) carrying it —
  // rarity is measured against this same set, so "at most N" is INCLUSIVE of the matched task itself.
  const strongCarriers = new Map<string, string[]>();
  for (const t of extracted) {
    for (const id of t.strong) {
      if (!candidateStrong.has(id)) continue;
      const list = strongCarriers.get(id);
      if (list) list.push(t.id); else strongCarriers.set(id, [t.id]);
    }
  }
  const weakCarriers = new Map<string, string[]>(); // key: `${category}:${id}`
  for (const t of extracted) {
    for (const [category, ids] of t.weakByCategory) {
      const candidateIds = candidateWeakByCategory.get(category)!;
      for (const id of ids) {
        if (!candidateIds.has(id)) continue;
        const key = `${category}:${id}`;
        const list = weakCarriers.get(key);
        if (list) list.push(t.id); else weakCarriers.set(key, [t.id]);
      }
    }
  }

  interface Tally { strong: string[]; weakByCategory: Map<string, string[]> }
  const byTask = new Map<string, Tally>();
  const entryFor = (taskId: string) => {
    let e = byTask.get(taskId);
    if (!e) { e = { strong: [], weakByCategory: new Map() }; byTask.set(taskId, e); }
    return e;
  };
  for (const [id, taskIds] of strongCarriers) {
    if (taskIds.length > rarityThreshold) continue; // too common across the corpus to be evidence
    for (const taskId of taskIds) entryFor(taskId).strong.push(id);
  }
  for (const [key, taskIds] of weakCarriers) {
    if (taskIds.length > rarityThreshold) continue;
    const [category, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    for (const taskId of taskIds) {
      const e = entryFor(taskId);
      const list = e.weakByCategory.get(category);
      if (list) list.push(id); else e.weakByCategory.set(category, [id]);
    }
  }

  let best: { taskId: string; strong: string[]; weakCategoryCount: number; weakTokens: string[] } | null = null;
  for (const [taskId, { strong, weakByCategory }] of byTask) {
    // Card b6eab182: weak evidence alone never qualifies, regardless of how many DISTINCT categories
    // it spans — see the module doc's "CARD b6eab182" section. Weak evidence below is corroboration
    // (the tie-break) on top of an already-qualifying strong hit, never the qualifying evidence itself.
    if (strong.length === 0) continue;
    const weakCategoryCount = weakByCategory.size;
    const weakTokens = [...weakByCategory.values()].flat();
    const better = !best
      || strong.length > best.strong.length
      || (strong.length === best.strong.length && weakCategoryCount > best.weakCategoryCount)
      || (strong.length === best.strong.length && weakCategoryCount === best.weakCategoryCount && weakTokens.length > best.weakTokens.length);
    if (better) best = { taskId, strong, weakCategoryCount, weakTokens };
  }
  if (!best) return null;
  const task = extracted.find((t) => t.id === best!.taskId);
  const MAX_REPORTED = 8;
  const allShared = [...best.strong, ...best.weakTokens];
  const sharedIdentifiers = allShared.length > MAX_REPORTED
    ? [...allShared.slice(0, MAX_REPORTED), `and ${allShared.length - MAX_REPORTED} more`]
    : allShared;
  return {
    taskId: best.taskId,
    title: task?.title ?? "",
    sharedIdentifiers,
  };
}
