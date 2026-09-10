# f8d53712 — `worker_status`'s single-worker body stopped spreading the raw session row

## Narrative

Card f8d53712: `worker_status`'s single-worker body used to spread `...w` — the RAW session row straight from `db.getSession()` — into its tool response. That's an OPT-OUT projection: any column added to the `sessions` table in future reaches the calling agent automatically, with no code change and no review step (contrast `fleetView`, which already names every field it returns explicitly and never spreads a raw row — this closes the one place that didn't). `pendingMerge` is deliberately omitted from the named-field projection: `toSession` never sets it (it's projected in from the in-memory `PendingOpRegistry` elsewhere), and the `worker_status` handler always overrides it with the live-computed value regardless of what `...w` would have carried.

## Do not

- Do not spread a raw `Session` row (`...w`) into a tool response — name every returned field explicitly, the same discipline `fleetView` already follows, so a future `Session` column addition can't reach an agent without a deliberate review step.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above `SESSION_ROW_FIELDS`): lines 2778-2786 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
