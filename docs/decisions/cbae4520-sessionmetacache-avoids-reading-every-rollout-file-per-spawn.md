# cbae4520 — `sessionMetaCache`: a code-review perf fix for the per-spawn corpus-wide rollout scan

## Narrative

`readSessionMeta`'s per-file result is cached, keyed by absolute file path, mirroring `resolvedPathCache`'s own bounded LRU-by-reinsertion cache (same size cap). A rollout file's FIRST line never changes after creation (codex writes `session_meta` first), so once read it can be trusted indefinitely; the `mtimeMs`+`size` stamp is a defensive staleness check only — it should never actually fire for a real rollout file, since nothing this project does ever rewrites one.

Card `cbae4520` code review [1]: without this cache, `snapshotExistingConversationIdsForSpawn`'s whole-corpus scan `readFileSync`s EVERY matching-cwd-candidate rollout file on EVERY fresh (non-resume) codex spawn — measured 74.2ms on a real 242-file/13.76MB `~/.codex/sessions` tree, entirely synchronous on the codex spawn hot path (`spawn()` → `spawnCodexProcess()`), the exact shape `CLAUDE.md`'s Python-venv invariant bans ("the spawn HOT PATH does NO blocking work"). With the cache warm, the SAME scan measures ~5.7ms (stat-only after the first pass). The cache is bounded (size-capped, same shape as `resolvedPathCache`) so a host with an ever-growing sessions tree can't grow it without limit either — the reviewer's own addition, beyond what the review measured.

`excludeSessionIds` — the exclusion-set mechanism this cache makes cheap enough to run on the spawn hot path — is card `cbae4520`'s own mechanism for closing the recycle race's sequential-reuse shape (`MTIME_SKEW_TOLERANCE_MS`, card `49d43ef9` — `docs/decisions/49d43ef9-mtime-skew-tolerance-measured-and-bounded-not-closed.md`) BY CONSTRUCTION rather than by mtime tolerance; it is documented in full at its own site, `findConversationIdForSpawn`/`snapshotExistingConversationIdsForSpawn` (`packages/daemon/src/pty/codex-transcript.ts`), left inline there rather than duplicated here. See card `184fd82e` (`docs/adr/184fd82e-defer-serializing-fresh-codex-spawns-per-cwd.md`) for the narrower, still-open concurrent-same-cwd shape it does not close.

## Do not

- Do not remove `sessionMetaCache` (or widen it unbounded) — without it, a corpus-wide scan re-reads every candidate rollout file's content on every fresh codex spawn, synchronously on the spawn hot path (measured 74.2ms vs ~5.7ms cached on a 242-file corpus).

## Source

Inline comment in `packages/daemon/src/pty/codex-transcript.ts` (`sessionMetaCache`'s top-of-cache doc), as of this tranche's HEAD. Relocated by card `b038b5a8` (tranche 1 on `pty/codex-transcript.ts`); source lines joined into flowing paragraphs and `*` comment markers stripped, with no change to the facts, numbers, or the argument's structure. The `excludeSessionIds` cross-reference paragraph above is new context this record adds, not relocated text — that mechanism's own narrative stays inline at its own site (`findConversationIdForSpawn`/`snapshotExistingConversationIdsForSpawn`), not duplicated here.
