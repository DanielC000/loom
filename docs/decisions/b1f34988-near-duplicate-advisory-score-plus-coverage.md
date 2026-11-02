# b1f34988 — the near-duplicate advisory pairs a bm25 threshold with a coverage-fraction gate

## Narrative

Card b1f34988 implements a write-time advisory on `memory_write`: when a brand-new key's note's
title+text closely resembles an EXISTING note, the write still succeeds but the response carries a
`nearDuplicateStatus` field naming the likely-duplicate key — mirroring the advise-never-block shape of
the sibling `neverDropStatus`/`restTierStatus`/`evictionStatus` signals (`mcp/memory.ts`). No LLM, no
embeddings — purely the project's existing FTS5 index (`project_memory_fts`), zero metered tokens.

The spec (the card body, following the design note's "zero-cost near-duplicate warning" proposal)
described a single BM25 threshold on the top FTS5 hit. That was measured against this project's own
real memory corpus before shipping — exported via `memory_list`/`memory_read` into a scratch-dir fixture
(759 notes, 2026-11-02), never the real DB directly — using two populations:

- **8 known near-duplicate pairs**: this project's own `key` / `key-evidence` split convention (a short
  standing-rule note plus a long evidence/specimen note on the SAME topic, deliberately split but
  textually overlapping). Resolved by shared-key-prefix matching against the real corpus, verified by
  hand against each note's own "specimens split to `[[...]]`" cross-reference text (a blind `-evidence`
  suffix strip only found 2 of 9 exact-base-key matches; the other 7 needed prefix matching since their
  base key isn't a literal substring of the evidence key).
- **60 pseudo-randomly sampled unrelated pairs** (deterministic LCG, seed 42), excluding any pair that
  is itself one of the 8 known-duplicate pairs or a trivial key-prefix relation.

**Finding: raw `bm25()` magnitude alone performs close to chance on this corpus.** At every tested
single-value threshold, the near-duplicate catch rate and the unrelated false-positive rate tracked each
other almost 1:1 (e.g. threshold -30: 38% catch / 35% FP; threshold -40: 13% catch / 13% FP). This
project's memory corpus is unusually dense, homogeneous, cross-referencing "lessons learned" prose — the
whole corpus shares heavy vocabulary (`gate`, `worker`, `manager`, `evidence`, `measured`, `verify`,
`control`, card ids, …) regardless of topic, so FTS5's additive multi-term OR-query sum accumulates a
strongly negative score against almost any sufficiently long note, duplicate or not. Normalizing by the
query's own token count did not help either (the same near-total overlap persisted).

**Fix: add a second, independent gate — a coverage fraction.** For the single TOP bm25 hit, compute what
fraction of the new note's own query tokens are textually present (case-insensitive substring) in that
hit's title+text. Requiring `score <= threshold AND coverage >= threshold` measurably improved precision
at an equivalent catch rate: e.g. `score <= -20 AND coverage >= 0.75` caught 2/8 (25%) known pairs at only
2/60 (3.3%) false positives — the raw-score-only threshold needed to reach that same ~25% catch rate
(-30) carried a 35% false-positive rate instead. `score <= -20 AND coverage >= 0.70` caught 3/8 (37.5%)
at 6/60 (10%) FP — the chosen looser option, still well above the raw-score-only curve at any comparable
catch rate.

**Chosen thresholds:** `NEAR_DUPLICATE_BM25_THRESHOLD = -20`, `NEAR_DUPLICATE_COVERAGE_THRESHOLD = 0.70`
(`project-memory-dedup.ts`). Deliberately conservative — advisory noise on every ordinary write would
erode trust in the signal faster than a missed duplicate costs; the measured ~37.5% catch / ~10% FP
tradeoff was picked over looser cuts that pushed FP past ~15-20%. Three short, generic single-sentence
notes ("fixed a typo in the readme", "bumped a dependency version", "ran the test suite, all green")
were also checked and never cleared -20 (scores -6.8 to -9.6), confirming the short-note non-false-fire
requirement.

**Accepted limitation, stated plainly rather than overclaiming:** this project's own corpus is an
adversarial case for lexical similarity (unusually dense shared vocabulary across unrelated topics), so
the measured ~37.5% catch rate is a LOWER bound specific to this corpus, not a general guarantee. A more
topically heterogeneous corpus should see a cleaner score/coverage separation and a higher effective
catch rate at the same false-positive budget — this was not separately measured (no second real corpus
was available to test against) and should not be assumed without its own measurement.

## Do not

- Do not use the raw `bm25()` top-hit score alone as the near-duplicate signal — on this project's own
  corpus it performs close to chance (catch rate ≈ false-positive rate at every threshold tested).
- Do not re-derive the thresholds from a smaller or synthetic sample without re-measuring against a real
  exported corpus — they were picked from an explicit precision/recall sweep, not a guess.
- Do not assume the measured ~37.5%/~10% catch/FP tradeoff generalizes to every project's corpus — it was
  measured on one unusually dense, homogeneous corpus; a different corpus's own real numbers should be
  re-measured, not assumed, before retuning.
- Do not duplicate the threshold constants or the score+coverage decision logic inline anywhere else —
  `project-memory-dedup.ts` exports both so the scheduled duplicate-report follow-up (card `446d97f0`)
  reuses the exact same signal rather than re-deriving its own.

## Source

`packages/daemon/src/db.ts`'s `findNearDuplicateProjectMemory` (query + coverage), and
`packages/daemon/src/sessions/project-memory-dedup.ts` (thresholds + classification), as introduced by
card `b1f34988`. Measurement scripts were throwaway (built against an exported corpus fixture, never
committed) — this record preserves the measured numbers since the scripts themselves were not kept.
