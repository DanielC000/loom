import { columnKeyForRole, isProjectMemoryExpired, resolveConfig } from "@loom/shared";
import type { Task } from "@loom/shared";
import type { Db } from "../db.js";
import { createProjectTask } from "../mcp/tasks.js";
import { MAX_TEXT_BYTES } from "../mcp/memory.js";
import { areCrossLinked, isNearDuplicateCandidate, isOversizePair } from "./project-memory-dedup.js";

/** Card 938dfcb8 — how many candidate pairs the sweep's actionability filters omitted, by reason. */
export interface OmittedPairCounts { oversize: number; linked: number }

/**
 * The Db-touching pairing pass + the one board card's lifecycle for the periodic, zero-LLM duplicate-
 * report sweep; the watcher calling `sweepProjectMemoryDuplicates` on a schedule lives in
 * `orchestration/memory-dedup-watcher.ts`.
 *
 * @decision 446d97f0
 */

/** Chunk budget (ms) — see the decision record above (card 446d97f0) for the measured cost that sized this. */
const CHUNK_BUDGET_MS = 30;

export interface DuplicateCandidatePair {
  /** Sorted lexicographically — keyA < keyB — so a pair has exactly one canonical identity regardless of
   *  which note's own top-FTS5-hit direction discovered it. */
  keyA: string;
  keyB: string;
  score: number;
  coverage: number;
  aVersion: number;
  bVersion: number;
  /** A simple, explainable heuristic (never a hard rule) — see {@link suggestKeepKey}'s own doc. */
  suggestedKeepKey: string;
}

/** Canonical, order-independent identity for a pair of note keys. */
export function canonicalPairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function sortPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Deterministic "which of these two would you keep" heuristic for the report body — explicitly a
 * SUGGESTION, never applied automatically (this sweep never merges/deletes/rewrites a note). Prefers a
 * pinned note over an unpinned one (a human/lead already marked it important); next, the one retrieved
 * more often (a live signal of actual use); finally the older note (by `createdAt`) as a last, stable
 * tie-break so the suggestion doesn't flip between identical sweeps.
 */
function suggestKeepKey(
  a: { key: string; pinned: boolean; retrievalCount: number; createdAt: string },
  b: { key: string; pinned: boolean; retrievalCount: number; createdAt: string },
): string {
  if (a.pinned !== b.pinned) return a.pinned ? a.key : b.key;
  if (a.retrievalCount !== b.retrievalCount) return a.retrievalCount > b.retrievalCount ? a.key : b.key;
  return a.createdAt <= b.createdAt ? a.key : b.key;
}

/**
 * The O(N) full-corpus pairing pass for one project, chunked off the event loop (see this file's own doc
 * comment for the measured cost + chunking contract). Reuses `db.findNearDuplicateProjectMemory` (the
 * SAME query the write-time advisory uses, `excludeKey` self-excluded) and `isNearDuplicateCandidate` (the
 * SAME score+coverage gate, b1f34988) — never a re-derived threshold comparison.
 *
 * A pair can be discovered from EITHER note's own top-hit query (A's top hit is B, or B's top hit is A, or
 * both) — deduped to its one canonical identity, keeping whichever direction was found FIRST (iteration
 * order over `db.listProjectMemory`'s own result); this is a representative reading, not necessarily the
 * single most extreme score between the two directions.
 *
 * `stopped:true` means `isStopped` returned true before the sweep finished — the caller must treat the
 * returned (necessarily partial) `pairs` as incomplete and must not file/update a report card from it.
 *
 * `expiresAt` (card 57a91801) gates REPORTING only, never the signal — see the decision record above
 * (card 446d97f0) for the full rationale.
 */
export async function findDuplicateReportCandidates(
  db: Db,
  projectId: string,
  isStopped: () => boolean,
  now: Date = new Date(),
): Promise<{ pairs: DuplicateCandidatePair[]; stopped: boolean; omitted: OmittedPairCounts; omittedPairs: Array<{ a: string; b: string; reason: "oversize" | "linked" }> }> {
  const notes = db.listProjectMemory(projectId);
  const byKey = new Map(notes.map((n) => [n.key, n]));
  const pairs = new Map<string, DuplicateCandidatePair>();
  const omittedByPair = new Map<string, "oversize" | "linked">();
  const summarize = () => {
    const omittedPairs = [...omittedByPair].map(([k, reason]) => {
      const [a = "", b = ""] = k.split("::");
      return { a, b, reason };
    });
    return {
      omitted: {
        oversize: omittedPairs.filter((p) => p.reason === "oversize").length,
        linked: omittedPairs.filter((p) => p.reason === "linked").length,
      },
      omittedPairs,
    };
  };
  const nowMs = now.getTime();
  let chunkStart = performance.now();
  for (const note of notes) {
    if (isStopped()) return { pairs: [...pairs.values()], stopped: true, ...summarize() };
    const candidate = db.findNearDuplicateProjectMemory(projectId, note.title, note.text, note.key);
    if (isNearDuplicateCandidate(candidate)) {
      const other = byKey.get(candidate.key);
      if (other && !isProjectMemoryExpired(note, nowMs) && !isProjectMemoryExpired(other, nowMs)) {
        const pairKey = canonicalPairKey(note.key, candidate.key);
        // @decision 938dfcb8 — oversize/cross-linked pairs are unmergeable noise; count, never report.
        // Oversize wins when both apply, so each omitted pair is counted exactly once.
        const omitReason = isOversizePair(note.text, other.text, MAX_TEXT_BYTES) ? "oversize"
          : areCrossLinked(note, other) ? "linked" : undefined;
        if (omitReason) {
          omittedByPair.set(pairKey, omitReason);
        } else if (!pairs.has(pairKey)) {
          const [keyA, keyB] = sortPair(note.key, candidate.key);
          pairs.set(pairKey, {
            keyA, keyB, score: candidate.score, coverage: candidate.coverage,
            aVersion: keyA === note.key ? note.version : other.version,
            bVersion: keyB === note.key ? note.version : other.version,
            suggestedKeepKey: suggestKeepKey(note, other),
          });
        }
      }
    }
    if (performance.now() - chunkStart >= CHUNK_BUDGET_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      chunkStart = performance.now();
    }
  }
  return { pairs: [...pairs.values()], stopped: false, ...summarize() };
}

export const REPORT_CARD_TITLE = "chore(memory): review likely-duplicate memory notes";
const PAIR_JSON_MARKER = "memory-dedup-pairs";
const TOP_N_SHOWN = 20;

interface ReportedPair { a: string; b: string; aVersion: number; bVersion: number }

/** Parse the `<!-- memory-dedup-pairs: {...} -->` marker a prior sweep embedded in a card's body, keyed
 *  by {@link canonicalPairKey}. Malformed/hand-edited JSON degrades to "no prior review data" rather than
 *  throwing — this body is human-editable, and a parse failure must never crash the watcher. */
function parseReviewedPairs(body: string): Map<string, ReportedPair> {
  const out = new Map<string, ReportedPair>();
  const match = body.match(/<!--\s*memory-dedup-pairs:\s*([\s\S]*?)\s*-->/);
  if (!match || match[1] === undefined) return out;
  try {
    const parsed = JSON.parse(match[1]) as { pairs?: ReportedPair[] };
    for (const p of parsed.pairs ?? []) {
      if (typeof p.a === "string" && typeof p.b === "string") out.set(canonicalPairKey(p.a, p.b), p);
    }
  } catch { /* hand-edited or malformed — treat as no prior review data, never throw */ }
  return out;
}

/**
 * Format the report card's body: a human-readable, score-sorted (strongest first) list capped at
 * {@link TOP_N_SHOWN} with a "+N more" tail, the signal's own measured precision caveat (so a reader
 * treats every entry as a CANDIDATE, never a confirmed duplicate — card 446d97f0's own DoD), and a
 * machine-parseable `<!-- memory-dedup-pairs: ... -->` marker carrying every pair's identity + the two
 * notes' `version` at the time THIS body was written — what a LATER sweep compares against to decide
 * whether a pair reviewed via this card (moved to a terminal column) is still reviewed, or has resurfaced
 * because one of the two notes changed since.
 */
function formatReportBody(pairs: readonly DuplicateCandidatePair[], omitted: OmittedPairCounts): string {
  const sorted = [...pairs].sort((x, y) => x.score - y.score); // most negative (strongest match) first
  const shown = sorted.slice(0, TOP_N_SHOWN);
  const list = shown.length === 0
    ? "No candidate duplicate pairs are currently outstanding — a later sweep updates this body if that changes."
    : shown.map((p, i) =>
      `${i + 1}. \`${p.keyA}\` ↔ \`${p.keyB}\` — score ${p.score.toFixed(1)}, ${Math.round(p.coverage * 100)}% ` +
      `coverage. Suggested merge target: \`${p.suggestedKeepKey}\` (keep this one, fold the other's content ` +
      "in, then `memory_forget` the dropped key).",
    ).join("\n") + (sorted.length > TOP_N_SHOWN ? `\n\n+${sorted.length - TOP_N_SHOWN} more candidate pair(s) not shown.` : "");
  const json = JSON.stringify({
    pairs: sorted.map((p) => ({ a: p.keyA, b: p.keyB, aVersion: p.aVersion, bVersion: p.bVersion })),
  });
  return (
    "This project's memory corpus is periodically swept for likely near-duplicate note pairs, reusing the " +
    "SAME FTS5 signal and thresholds as the write-time near-duplicate advisory (card b1f34988): a " +
    "conservative BM25 top-hit score paired with a token-coverage fraction. On this project's own measured " +
    "corpus, that signal caught roughly 3 of 8 (~37.5%) known duplicate pairs at roughly 6 of 60 (~10%) " +
    "false positives on small samples (docs/decisions/b1f34988-near-duplicate-advisory-score-plus-coverage.md) " +
    "— treat every entry below as a CANDIDATE to review, never a confirmed duplicate. This sweep NEVER " +
    "auto-merges, deletes, or rewrites a note.\n\n" +
    `${list}\n\n` +
    `${omitted.oversize} oversize / ${omitted.linked} already-linked pairs omitted (merging an oversize pair ` +
    "would exceed the per-note byte cap; linked notes are deliberately split).\n\n" +
    "Move this card to a terminal column once reviewed — a listed pair will not resurface on a later sweep " +
    "unless either note's content changes afterward.\n\n" +
    `<!-- ${PAIR_JSON_MARKER}: ${json} -->`
  );
}

const REPORT_CARD_META_PREFIX = "memory-dedup-report-card:";
const LAST_SWEEP_META_PREFIX = "memory-dedup-last-sweep:";

export function reportCardMetaKey(projectId: string): string {
  return `${REPORT_CARD_META_PREFIX}${projectId}`;
}

/** `app_meta` key holding the last completed sweep's {@link OmittedPairCounts} as JSON (card 938dfcb8). */
export function omittedCountsMetaKey(projectId: string): string {
  return `memory-dedup-omitted:${projectId}`;
}

export function lastSweepMetaKey(projectId: string): string {
  return `${LAST_SWEEP_META_PREFIX}${projectId}`;
}

/**
 * Run one full sweep for `projectId`: compute candidates (chunked, see {@link findDuplicateReportCandidates}),
 * exclude pairs already reviewed via the tracked card's own lifecycle (a pair listed on a card that was
 * then moved to a terminal column stays excluded until either note's `version` advances), and file/update
 * ONE board card — found robustly via a stored id in `app_meta` (never a fuzzy title match), never one
 * card per run (card 446d97f0's own DoD). A sweep that was cut short by `isStopped` (daemon shutdown)
 * writes NOTHING — no partial report, no `lastSweep` stamp — so the NEXT boot's tick re-runs it cleanly
 * from scratch rather than publishing a report built from an incomplete scan.
 */
export async function sweepProjectMemoryDuplicates(
  db: Db,
  projectId: string,
  isStopped: () => boolean,
  now: Date = new Date(),
): Promise<void> {
  const { pairs, stopped, omitted } = await findDuplicateReportCandidates(db, projectId, isStopped, now);
  if (stopped) return;
  db.setMeta(omittedCountsMetaKey(projectId), JSON.stringify(omitted));

  const project = db.getProject(projectId);
  if (!project) return;

  const cardIdKey = reportCardMetaKey(projectId);
  const existingCardId = db.getMeta(cardIdKey);
  const existingCard: Task | undefined = existingCardId ? db.getTask(existingCardId) : undefined;

  const cols = resolveConfig(project.config).kanbanColumns;
  const terminalKey = columnKeyForRole(cols, "terminal");
  const cardIsTerminal = existingCard !== undefined && existingCard.columnKey === terminalKey;

  const toReport = !cardIsTerminal
    ? pairs // no card yet, or the tracked card is still open — never exclude anything (DoD: "a listed pair
             // will not resurface... unless"; an OPEN card hasn't resolved anything yet to exclude from)
    : pairs.filter((p) => {
        const prior = parseReviewedPairs(existingCard!.body).get(canonicalPairKey(p.keyA, p.keyB));
        return !prior || prior.aVersion !== p.aVersion || prior.bVersion !== p.bVersion;
      });

  const body = formatReportBody(toReport, omitted);
  if (existingCard && !cardIsTerminal) {
    db.updateTask(existingCard.id, { body });
  } else if (toReport.length > 0) {
    // Either no card has ever been filed, or the tracked one is closed and there's new/un-reviewed content
    // to report — file a fresh one and re-point the stored marker. The old closed card is left untouched
    // as history (never deleted, never reopened).
    const created = createProjectTask(db, projectId, { title: REPORT_CARD_TITLE, body });
    if (!("error" in created)) db.setMeta(cardIdKey, created.id);
  }
  // else: tracked card is terminal and nothing new/un-reviewed — do nothing, leave the closed card as-is.

  db.setMeta(lastSweepMetaKey(projectId), now.toISOString());
}
