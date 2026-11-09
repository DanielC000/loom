# 938dfcb8 — the periodic dedup sweep omits oversize and already-cross-linked pairs

## Narrative

The periodic likely-duplicate sweep (card 446d97f0) filed review cards that came back empty: 91096dd8 (109 of 110 pairs over the per-note byte cap combined), fed07a54 (0 of 19 mergeable), 9f5b6661 (0 of 8 sampled, out of 97). The corpus is written at the cap and most flagged pairs are related-but-distinct notes that already `[[wikilink]]` each other, so merging one means deleting knowledge.

Two pure predicates in `sessions/project-memory-dedup.ts`, applied in `findDuplicateReportCandidates` after `isNearDuplicateCandidate`, drop such a pair from the card body AND the JSON marker:

- `isOversizePair`: combined `text` UTF-8 bytes over `MAX_TEXT_BYTES` (`mcp/memory.ts`, the write validator's cap).
- `areCrossLinked`: either note's text `[[wikilink]]`s the other's key (`extractWikilinkKeys`).

Omitted pairs are counted (oversize wins when both apply), recorded in `app_meta` under `memory-dedup-omitted:<projectId>`, and summarised on one line in the card body.

Thresholds and cadence were left alone on purpose: in the recorded cards the strongest pairs (score up to -96, coverage up to 96%) were the unmergeable ones, so raising either would drop real candidates first (consistent with b1f34988).

The b1f34988 "known duplicates" are deliberate `key` / `key-evidence` splits, which these filters drop by design. The invariant to preserve is therefore: a pair that FITS the cap and is NOT cross-linked is never dropped.

## Do not

- Do not auto-merge, delete or rewrite a note from the sweep.
- Do not drop a pair that fits the cap and is not cross-linked.
- Do not re-derive the cap or the wikilink grammar: use `MAX_TEXT_BYTES` and `extractWikilinkKeys`.
- Do not apply these filters to the write-time advisory; they are sweep-only.
- Do not leave omitted pairs out of the counts; a silent drop is unreviewable.
