# 53edd8d5 — a scheduled manager's custom prompt and cap-flag are both additive

## Narrative

`startManager` mirrors `startNew`, but marks the session role 'manager' (so it gets the loom-orchestration MCP + allowlist at spawn) and runs in the project repo, not a worktree (managers coordinate; workers get the worktrees).

`prompt` is an OPTIONAL per-schedule custom task description (the Scheduler passes a fired schedule's own `prompt` here) — appended via `appendScheduledPrompt` AFTER the composed manager prompt (identity/doctrine + "Where things live" block). Undefined/null (every non-scheduled caller, and every schedule with no prompt set) means byte-identical to before this parameter existed.

`opts.scheduled` is true ONLY when index.ts's Scheduler wiring calls this; every other caller (REST "start manager", the generic profile-derived dispatch) omits `opts`, so the session's `scheduledSpawn` pins false and this is byte-identical to before the flag existed. Read back by `Db.countLiveScheduledManagers` — the Scheduler's OWN manager-cap budget, separate from the standing human/Lead-spawned fleet.

Standing human/Lead-spawned managers do NOT count against this cap and can never block a cadence, however large the standing fleet grows — only OTHER scheduler-spawned managers compete for this budget.

## Do not

- Do not let `opts.scheduled` default to anything but false for a non-Scheduler caller — every caller but the Scheduler wiring must omit `opts` and get `scheduledSpawn:false`, byte-identical to before the flag existed.
- Do not fold the Scheduler's manager-cap budget (`countLiveScheduledManagers`) into the standing human/Lead-spawned fleet's cap — they are deliberately separate budgets.
- Do not assume a large standing manager fleet can starve a schedule — only scheduler-spawned managers compete for this budget; a schedule can never be blocked by however large the standing human/Lead-spawned fleet grows.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`startManager`'s doc): originally lines 2606-2621, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

The "can never block a cadence" clause above was also carried by the `maxConcurrentManagers` doc in `packages/shared/src/config.ts` (`OrchestrationConfig`), originally lines 344-362 as of the `shared/config.ts` tranche 1 HEAD, and was dropped from source there without landing in this record at the time — added by card `6377d105` (tranche 1 on `shared/config.ts`) to close that gap; no wording changed from the original clause.
