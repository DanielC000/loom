import type { NearDuplicateCandidate } from "../db.js";

/**
 * Card b1f34988 — the near-duplicate advisory's signal + thresholds, exported as ONE shared helper so a
 * future consumer (the scheduled duplicate-report follow-up, card 446d97f0) reuses the EXACT same
 * classification `memory_write`'s own write-time advisory uses, rather than re-deriving its own.
 *
 * @decision b1f34988 — never use {@link NearDuplicateCandidate.score} alone; require it paired with
 * {@link NearDuplicateCandidate.coverage} — score-only was measured near chance-level on this project's
 * own corpus. See the decision record for the full sweep.
 */
export const NEAR_DUPLICATE_BM25_THRESHOLD = -20;

/** @decision b1f34988 — the companion gate to {@link NEAR_DUPLICATE_BM25_THRESHOLD}; see that constant's
 *  own doc comment and the decision record for why both are required together. */
export const NEAR_DUPLICATE_COVERAGE_THRESHOLD = 0.70;

/** True iff `candidate` clears BOTH thresholds — the single classification point every caller (the
 *  write-time advisory, and any future consumer) must route through, so the two thresholds above can
 *  never be applied inconsistently (e.g. one caller checking score alone). `undefined` (no candidate —
 *  {@link NearDuplicateCandidate} not found at all, see `db.ts`'s `findNearDuplicateProjectMemory`)
 *  is never a duplicate. */
export function isNearDuplicateCandidate(
  candidate: NearDuplicateCandidate | undefined,
): candidate is NearDuplicateCandidate {
  return (
    !!candidate &&
    candidate.score <= NEAR_DUPLICATE_BM25_THRESHOLD &&
    candidate.coverage >= NEAR_DUPLICATE_COVERAGE_THRESHOLD
  );
}

/** The write-time advisory's informational signal — never a rejection, mirrors the sibling
 *  `neverDropStatus`/`restTierStatus`/`evictionStatus` shapes in `mcp/memory.ts`. */
export interface NearDuplicateSignal {
  message: string;
  key: string;
  score: number;
  coverage: number;
}

/** `undefined` when `candidate` doesn't clear {@link isNearDuplicateCandidate}'s gate. */
export function computeNearDuplicateSignal(
  candidate: NearDuplicateCandidate | undefined,
): NearDuplicateSignal | undefined {
  if (!isNearDuplicateCandidate(candidate)) return undefined;
  return {
    key: candidate.key,
    score: candidate.score,
    coverage: candidate.coverage,
    message: `similar to existing note "${candidate.key}" (bm25 ${candidate.score.toFixed(1)}, ` +
      `${Math.round(candidate.coverage * 100)}% token overlap) — consider updating that key instead of ` +
      "creating a new one.",
  };
}
