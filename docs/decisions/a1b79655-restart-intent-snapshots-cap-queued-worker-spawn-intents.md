# a1b79655 — Restart intent snapshots each manager's cap-queued worker_spawn intents, informational only

## Narrative

Card a1b79655: snapshot each captured manager's/platform's still-live cap-queued worker_spawn intents — the ONE restart flavor with a window to act before the process (and CapQueueRegistry's in-memory Map) dies. Public projection only (mirrors listByManager's own read contract) — this is purely so resumeFleetOnBoot can TELL each one what it lost; nothing here re-queues or re-admits anything (that's the persistence the card's DoD explicitly forbids — the loss is by design). Defensive cap on ENTRY COUNT, same reasoning as PENDING_MAX_MSGS three lines up: CapQueueRegistry is bounded per-DAEMON (CAP_QUEUE_MAX=200), not per-manager, so a pathological case (all 200 queued behind one manager) would otherwise balloon the intent JSON and that manager's resume turn. The truncation is surfaced (not silent) via a "(+N more not shown)" suffix appended to the LAST kept entry's own kickoffLabel — that field is already documented DISPLAY-ONLY (see CapQueuedSpawn's doc), so this stays within its existing contract rather than inventing a new one.

## Do not

- Do not re-queue or re-admit a cap-queued worker_spawn intent from this restart snapshot — it is a public, informational projection only; the loss of an in-flight cap-queue slot across a restart is deliberate, by the card's own DoD.
- Do not silently drop overflow entries past `CAP_QUEUED_SNAPSHOT_MAX` — surface the truncation via a "(+N more not shown)" suffix on the last kept entry's `kickoffLabel` (already DISPLAY-ONLY), not a new field.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`requestDaemonRestart`): lines 4336-4346, as of commit `6faf27824c7f550d57bfdeb9e4724c7070b82315`. Relocated by card `5b8d2b0c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. "PENDING_MAX_MSGS three lines up" refers to the pending-snapshot cap documented in `docs/decisions/2ca18433-restart-pending-snapshot-excludes-durable-messages.md`, at this same site in the original source.
