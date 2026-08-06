import type { Task } from "@loom/shared";

/**
 * Cross-channel duplicate-card detection (board card 5b221bf2). The founding case: two managers
 * independently file a card for the SAME incident, each in their own words, via two different
 * channels (an escalation-triage landing vs. a hand-filed `tasks_create`) — title/prose similarity
 * plausibly misses exactly this pair, since independent authorship diverges in wording. What
 * SURVIVES independent authorship is the identifiers both authors cite: a session id, a git
 * branch, an OS error constant, a `file:line`, a code symbol. This module extracts those
 * candidates and lets the caller (see {@link findSuspectedDuplicate}) match on their intersection,
 * rarity-weighted against the existing corpus — no prose/title similarity, no embeddings.
 *
 * MEASURED against the real 1683-card board (Code Review, round 2): the first cut of this module
 * had a 47.5% false-positive rate on a 40-card recency sample. Three independent mechanisms drove
 * it, each fixed below and re-measured:
 *   1. The PascalCase regex accepted a bare capital letter as a valid zero-lowercase segment, so an
 *      ALL-CAPS shouted word ("MEASURED", "HYPOTHESIS" — Loom cards use heavy caps emphasis) parsed
 *      as N single-letter "segments" and matched. Fixed by requiring `[A-Z][a-z0-9]+` (one-or-more
 *      lowercase tail), not `[A-Z][a-z0-9]*`, everywhere a segment is asserted.
 *   2. A single shared code-symbol-shaped token is too easily explained by "these two cards discuss
 *      the same subsystem" (two temp-dir cleanup cards both saying `tmpRoots`; two gate-diagnostic
 *      cards both saying `gateDetail`) rather than "these two cards are the same incident." Fixed (at
 *      the time) by requiring evidence to span at least 2 DISTINCT weak categories, not merely 2 raw
 *      tokens — the founding p2 pair cleared this via ONE SCREAMING_SNAKE_CASE constant + ONE
 *      PascalCase symbol (two categories), while "two camelCase symbols from one subsystem" no longer
 *      did (one category, however many tokens). ⛔ SUPERSEDED by card b6eab182 below — weak evidence,
 *      however many categories, is no longer sufficient on its own at all.
 *   3. `file:line` was in the single-hit-sufficient STRONG tier on the claim that it was "as rare as
 *      a UUID." Measured false: two audit/sweep cards that each cite a wholesale list of sites can
 *      share a dozen `file:line` refs while being genuinely distinct findings, and two unrelated
 *      fixes can coincidentally cite the exact same one. `file:line` is now its OWN weak category —
 *      it can corroborate other evidence but, like any single weak category, is never sufficient
 *      alone regardless of how many refs are shared (a category is present/absent, not counted).
 * These three bring the same 40-card sample to a 22.5% FP rate with BOTH founding pairs flagging at
 * rank 1 in BOTH directions and the negative control clear — see {@link findSuspectedDuplicate}'s doc
 * for the one remaining, DELIBERATELY UNFIXED false-positive class (a design/meta card quoting past
 * incidents as worked examples) and why three further attempts at fixing it were each rejected on
 * measurement rather than shipped.
 *
 * ⭐⭐ CARD b6eab182 (2026-08-06) — WEAK evidence, of ANY category in ANY combination, no longer
 * qualifies a task as a suspected duplicate BY ITSELF. This supersedes the `MIN_WEAK_CATEGORIES`-based
 * weak-only matching described above and in {@link findSuspectedDuplicate}'s own doc. Reason: unlike the
 * synthetic sampled-draw measurements above (2.5%–15% per-draw, n=200 pooled), this is **5 REAL spurious
 * create-BLOCKS measured in live usage** — the 5th matched on nothing but a bare camelCase-shaped field
 * name (`workerlabel`) plus a `file:line` landmark (`sessions/service.ts:3341`), i.e. exactly the
 * MIN_WEAK_CATEGORIES=2 bar clearing on two bare code identifiers. Per the founding asymmetry (a spurious
 * dedup CONFLICT is loud and self-correcting — the caller sees it and re-files; a spurious create-BLOCK is
 * silent in the OTHER direction — the finding still exists, but the path of least resistance is to give up
 * filing it), the tuning now favors false NEGATIVES: a block requires at least one STRONG identifier (a
 * session id / task id — both are full UUIDs — or a Loom branch name) shared with an existing card. Weak
 * (code-symbol / file:line / naming-convention) evidence is retained ONLY as ranking/corroboration context
 * on top of a strong hit (folded into `sharedIdentifiers` for legibility) — it can no longer trigger a
 * block on its own, however many distinct categories it spans.
 * ⇒ This CLOSES the module's own SECOND disclosed false-positive class below (a weak-only coincidental
 * code-landmark/convention collision) outright — that class can no longer fire, because weak-only matches
 * no longer exist. The FIRST disclosed class (a meta/design document quoting another incident's identifiers
 * VERBATIM) is UNCHANGED by this — it's about STRONG evidence and stays open.
 * ⚠️ ACCEPTED COST, not an oversight: this module's own founding `abcf0eba`/`bc91e86c` positive-control pair
 * (the Windows-argv-limit duplicate) carries NO strong identifier at all — it was originally caught purely
 * via `ERROR_FILENAME_EXCED_RANGE` + `CreateProcess` + `startupPrompt` (three weak categories, zero strong).
 * Under this redesign it is **no longer auto-flagged** — a genuine duplicate whose only shared evidence is a
 * code symbol/error constant/file:line now has to be caught by a human/agent reading the board, or filed
 * with `supersedes`/`relatedTo` by hand. That is the accepted trade of the stated asymmetry, not a bug —
 * see the regression test in task-dedupe.mjs for the explicit, documented "this pair no longer matches"
 * assertion rather than a silently-dropped check.
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
 * ⚠️ KNOWN, DISCLOSED LIMITATION (Code Review round 2) — deliberately NOT "fixed" here: a design/spec
 * document that discusses several past incidents BY ID as worked examples (e.g. this very card,
 * `5b221bf2`, quoting the identifiers of all six of its own founding specimens) can itself get flagged
 * as a duplicate of one of them, since it genuinely does share their rare identifiers verbatim. THREE
 * citation-based exclusions were tried and each rejected on measurement, not by inspection:
 *   - Exclude any existing task the candidate cites by id → fixes this case, but ALSO excludes
 *     `dde0ce24` from matching `47340c82` (retitled "DUPLICATE of dde0ce24" post-resolution, so its
 *     own text cites the very sibling it should match) — trades the meta-document FP for a founding
 *     positive-control FALSE NEGATIVE.
 *   - Same, but excused when the cited task cites the candidate BACK (a "mutual" carve-out) → fixes
 *     BOTH of the above, but then breaks `bc91e86c` → `abcf0eba`: that pair's citation is one-way
 *     (`bc91e86c` cites `abcf0eba`; `abcf0eba` never mentions `bc91e86c`), so "resolved pairs cite each
 *     other mutually" is not a reliable property of this board's history.
 *   - Only treat a candidate as a "meta document" once it cites 2+ (or 3+) distinct task ids → still
 *     breaks a founding direction: `dde0ce24` alone carries 4 "Related:" citations (an ordinary amount
 *     for a well-cross-referenced card here), so it trips the same threshold as the genuine 6-citation
 *     meta-document and loses its own match to `47340c82`.
 * Every variant traded this one narrow, self-referential false positive for a different regression on
 * a founding pair — this board's citation conventions (multi-item "Related:" footers on ordinary
 * cards, one-way "DUPLICATE of X" retitles) don't reliably distinguish "citing as a worked example"
 * from "citing your own confirmed duplicate." Per the review's own instruction, this is reported
 * rather than tuned around: a design/meta card that quotes another incident's identifiers as an
 * illustrative case study will occasionally self-refuse — loudly, naming the wrong-but-related
 * counterpart, and correctable in one call via `allowDuplicate`/`relatedTo`. That is the intended
 * escape hatch for exactly this shape of edge case, not a silent failure.
 *
 * ⚠️ SECOND DISCLOSED LIMITATION (card 0ef0270b, measured against the real ~1687-card board) — HISTORICAL,
 * CLOSED by card b6eab182. The "meta-document citing another incident's OWN identifiers" class above was
 * NOT the whole set of residual false positives: a second, distinct class existed where two cards about
 * SUBSTANTIVELY UNRELATED work shared a code LANDMARK (a `file.ts:line` each cited for its own unrelated
 * reason) or an established, codebase-wide CONVENTION name (a shared pattern/field name used correctly by
 * two unrelated features) — neither card citing the other's id, a coincidental-landmark collision rather
 * than a citation. Two real specimen pairs illustrated it: `166e3536` (a Platform Lead singleton bug)
 * flagged against `f3917f96` (an unrelated graphify A/B spike) on a shared symbol + shared `service.ts:490`;
 * `fae919b3` (a PresetForm `meta.inlineError` bug) flagged against `378d250b` (an unrelated companion-
 * create-flow code review) on shared `inlineError`/`MutationCache` vocabulary. Two rounds of measurement
 * (0ef0270b: 8.5% raw-flag rate, 5×40-card draws, n=200 pooled; card abdaecda's re-measure: 10.0%, same
 * methodology) each found this deliberately NOT tuned around — reported as an intended `allowDuplicate`/
 * `relatedTo`-correctable edge case rather than narrowed, because a false negative was judged worse than a
 * false positive at the time. **Card b6eab182 revisited that judgment call**: those measurements were
 * synthetic sampled draws (n=200, 2.5%–15% per-draw range); 5 REAL spurious create-blocks in live usage —
 * this exact class, e.g. matching on a bare `workerlabel` field name + `sessions/service.ts:3341` — is a
 * different order of evidence. Requiring a STRONG identifier for every match (see above) makes this whole
 * class of match STRUCTURALLY IMPOSSIBLE now, not merely de-prioritized — there is no longer a "weak-only
 * match" shape for a coincidental landmark/convention to produce.
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
