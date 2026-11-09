import type { NearDuplicateCandidate } from "../db.js";
import { extractWikilinkKeys } from "./project-memory-backlinks.js";

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

/**
 * Card 938dfcb8 — the PERIODIC sweep's actionability filters. A pair that clears
 * {@link isNearDuplicateCandidate} is only worth a review card when merging it is actually possible, and
 * measured reviews (cards 91096dd8, fed07a54, 9f5b6661) found almost none were: the corpus is written at
 * the per-note byte cap and most flagged pairs already cross-link on purpose. These are SWEEP-only; the
 * write-time advisory deliberately does not use them. Both are pure so the caller supplies the cap
 * (`mcp/memory.ts`'s MAX_TEXT_BYTES — imported there, not here, to avoid a value-import cycle).
 *
 * @decision 938dfcb8
 */
export function isOversizePair(textA: string, textB: string, capBytes: number): boolean {
  return Buffer.byteLength(textA, "utf8") + Buffer.byteLength(textB, "utf8") > capBytes;
}

/** True iff either note's text `[[wikilink]]`s the other's key (one direction is enough). */
export function areCrossLinked(
  a: { key: string; text: string },
  b: { key: string; text: string },
): boolean {
  return extractWikilinkKeys(a.text).includes(b.key) || extractWikilinkKeys(b.text).includes(a.key);
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
