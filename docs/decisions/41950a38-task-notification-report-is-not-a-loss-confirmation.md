# 41950a38 — an engine task-notification mismatch is not evidence of loss, only an enrichment

## Narrative

Card 41950a38 — specimen: Platform Lead session, gen=1, a `daemon_restart` resume boundary (2026-09-02T10:12:43Z), `reportedLen=519 intendedLen=30646 divergesAtChar=0`. Traced past this file entirely, to the engine's own transcript: `reported` was NOT truncated/spliced Loom content at all — it was byte-for-byte Claude Code's OWN engine-generated `<task-notification>...</task-notification>` block (a background-task-status notice the CLI itself synthesizes on resume, reporting a stale shell command from the prior process with no completion record — entirely independent of anything Loom wrote to the pty for this generation). The transcript's own `queue-operation` records show Loom's actual gen=1 write was queued by the CLI's own internal input queue at this same moment and delivered as a later turn moments after — nothing was lost in that one specimen.

Deliberately NOT a suppression, unlike `detectAnsiEscapeStripDeficit`/`detectPossibleDuplicateWrapperDeficit` (both prove RECONCILIATION — stripping the recognized wrapper leaves the remainder byte-identical to `intended`): there is no byte-level relationship between a task-notification and `intended` to reconcile against, and this daemon has no visibility into the CLI's own internal turn/queue state (see this file's own "never assert a CLI-internal CAUSE" doctrine at the `[loom:prompt-mismatch]` notice site) — so this cannot CONFIRM the intended text arrived, only that `reported` itself is not evidence it didn't. Structural, not heuristic: the whole (trimmed) `reported` string is bounded by the CLI's own fixed wrapper tags, a shape Loom itself never writes (Loom's own frames are all `[loom:...]`-tagged). This only ever ENRICHES the notice's wording (mirroring `unmatchedRecognized`'s own cautious, non-suppressing posture) — the "possible LOSS" alarm still fires unchanged.

## Do not

- n=1 (one specimen) — classifies THIS byte-pattern only. See memory `the-qualifier-dies-in-the-summary-label`.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`isEngineTaskNotificationReport`'s function doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`) — the n=1 scope caveat stayed inline per `CLAUDE.md`'s class-A rule, compressed in place. No wording changed in the narrative moved here; wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
