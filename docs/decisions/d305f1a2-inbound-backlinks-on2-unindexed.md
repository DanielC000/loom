# d305f1a2 — inbound-backlink matching stays O(N²), left unindexed (bounded by `memory.maxNotes`)

## Narrative

`findInboundBacklinksBulk` resolves every note's inbound backlinks in one pass over a fetched corpus, replacing the naive shape where a LIST caller called `findInboundBacklinks` once per row (card `41c3f546`: N+1 fetches, N full-corpus regex scans). Even with that fix, the bulk path is still O(N²) overall — one pass over the corpus, but a per-target match/sort against every other note's already-extracted keys.

Re-measured live against this project's own real corpus (2026-09-04: 502 notes, ~1.5MB of text): `findInboundBacklinksBulk` over the whole corpus runs in ~22ms; a uniform-key-length synthetic scaling series (1x/2x/4x/8x that same corpus) put the empirical growth exponent at ~1.75-1.90, consistent with the predicted O(N²) shape.

This project's own `memory.maxNotes` config caps the UNPINNED population at 500 (owner decision #2, `evictProjectMemoryOverCap`) — live-checked the same day, 494 of 502 notes were unpinned and sitting right at that cap, with only 8 pinned (pinned notes are exempt from eviction and are the only unbounded growth path). Even at the platform-wide hard ceiling (`MEMORY_CONFIG_MAX.maxNotes` = 1000, ~2x that corpus) the same scaling series measured only ~31ms.

An inverted index would remove the asymptotic risk entirely, but the risk is currently bounded by config, not by luck.

## Do not

- Do not add an inverted index pre-emptively — re-measure first; at both the current and platform-ceiling corpus sizes the O(N²) cost stays under ~31ms.
- Do not treat "left unindexed" as an oversight — it's a config-bounded, measured decision. Re-measure before reaching for an index if `maxNotes` is ever raised meaningfully past its current default, or the pinned population grows into the hundreds (the only unbounded growth path).

## Source

JSDoc comment above `findInboundBacklinks` in `packages/daemon/src/sessions/project-memory-backlinks.ts`, lines 123-134 as of commit `dcbd50bc` (the "Card d305f1a2" paragraph specifically). Extracted by card `6c7d80e1` (tranche 1 on this file). Also cited (recap only, no new content) at the same file's `matchesFor` doc comment (~lines 87-94, the unified match-predicate refactor) and `findInboundBacklinksBulk` doc comment (~lines 146-162).
