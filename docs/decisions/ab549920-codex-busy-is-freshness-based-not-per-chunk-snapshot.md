# ab549920 — codex busy detection is FRESHNESS-based, never recomputed from one output chunk

## Narrative

Code Review C2/M3 fix: how long codex's busy STATUS-LINE marker (`isCodexBusy`, refreshed roughly once per second while genuinely busy — its own text carries a live seconds counter) may go UNSEEN before a session is declared idle (`CODEX_BUSY_STALE_MS`, `packages/daemon/src/pty/host.ts`).

The prior design recomputed busy from EVERY output chunk (either the latest chunk alone, or the accumulated `screenScan`) and treated the marker's mere ABSENCE from that one snapshot as "done" — which is unsound in BOTH directions: a stale accumulated match can linger for a long time past real completion (M3), while a single ordinary mid-turn chunk that simply doesn't happen to carry the marker (streamed tool output between status refreshes, or the marker split across a chunk boundary) would wrongly read as an immediate falling edge (C2 — a real `submitCodex` race: a chunk landing in the ~300ms text->\r gap, before codex has rendered the marker for THIS turn at all, would flip busy back to false and let a second message land in a composer still holding the first).

Instead, busy is FRESHNESS-based: seeing the marker (re)arms a bounded per-session timer (`armCodexBusyStaleTimer`); only once `CODEX_BUSY_STALE_MS` passes with NO fresh sighting is the session declared genuinely idle. The value is comfortably larger than the ~1s observed refresh cadence (so an ordinary gap between refreshes, or one fragmented/missed chunk, is never mistaken for completion) while still bounded (so a real completion is detected promptly, not left latched forever). Env-overridable (`LOOM_CODEX_BUSY_STALE_MS`) so a hermetic test can shrink it instead of sleeping for multiple real seconds (mirrors `GRACEFUL_STOP_KILL_MS`'s own `LOOM_GRACEFUL_KILL_MS` convention).

## Do not

- Do not recompute codex busy from a single output chunk or snapshot again — it is unsound in both directions (a stale accumulated match lingers past real completion; an ordinary chunk missing the marker reads as a false falling edge).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`CODEX_BUSY_STALE_MS`'s top-of-const doc): lines 72-89, as of this tranche's HEAD (commit `1d2e8e78`). No card id anywhere in the block, the file, or `git blame`'s introducing commit — sourced via the `sha:` grammar. Whole block introduced by commit `ab549920bcc73719aa7466698dee0b4da6078144` ("feat(pty): add a Codex CLI worker adapter for one pilot project"). Relocated by card `60cd72ad` (tranche 5 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
