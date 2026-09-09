# badba5a8 — `discovery_block_injection` is observability-only, and carries three deliberately separate facts

## Narrative

Card badba5a8: OBSERVABILITY ONLY — records whether a PRIVATE, presence-gated per-project discovery block was appended to a spawn/recycle's `startupPrompt`, filed at all FIVE real injection call sites in the daemon's own `sessions/service.ts` (a manager-role fresh spawn, an explicit/scheduled manager spawn, a worker fresh spawn, a worker recycle, a manager recycle) right after the composed prompt is built.

WHAT the block is and WHY it's gated stays documented daemon-side only — this file is `@loom/shared`, which ships in FULL to every end-user install, unlike the daemon package (see this repo's `codescape-privacy-guard.mjs`, which is exactly why this kind's own name and doc are written this generically rather than naming the feature here).

`detail` carries THREE DELIBERATELY SEPARATE facts (never collapsed into one boolean — that collapse is the exact defect this card exists to fix):
- `injected: boolean` — block-presence (every gate below passed).
- `reason: string | null` — set ONLY when `injected:false`, one of six distinct values (never collapsed) covering: no supervisor process running at all / the feature (or its daemon-wide gate) is off / the serving process isn't currently up / this repo has no resolvable id with it / the block's own asset could not be read (a packaging/deploy fault) / the asset was read but was empty (a content fault, deliberately kept DISTINCT from unreadable — two operationally different states that must never share one bucket).
- `stamped: boolean | null` — set ONLY when `injected:true`: whether an accompanying freshness stamp also rendered (`true`) or the block rendered WITHOUT one (`false` — a real, previously invisible signal, distinct from `injected:false`).

NEVER carries the block's own PROSE (this event exists specifically so nobody ever has to log it). Deliberately excluded from `EVENT_TRIGGER_EVENT_KINDS` and `GATE_HISTORY_KINDS` (a per-spawn observability fact, not a live decision trigger or a gate-history row).

## Do not

- Do not collapse `injected`/`reason`/`stamped` back into one boolean — that collapse is the exact defect this card exists to fix.
- Do not merge the "asset unreadable" and "asset read but empty" `reason` values into one — they are two operationally different states (packaging/deploy fault vs content fault) that must never share one bucket.
- Do not log the discovery block's own prose via this event — it exists specifically so nobody ever has to.

## Source

Inline comment in `packages/shared/src/types.ts` (`OrchestrationEventKind`'s `discovery_block_injection` case doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
