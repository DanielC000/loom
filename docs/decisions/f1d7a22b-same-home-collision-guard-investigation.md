# f1d7a22b — two companions resolving to the same home duplicate a proactive message

## The investigation

The per-row home resolution in `resolveAllEnabledConfigs` (`packages/daemon/src/companion/store.ts`, see `e849a487`) is correct in isolation — each config reads its OWN session's app_meta home. But nothing stopped two DIFFERENT enabled companion sessions from each resolving their home to the SAME destination route. `CompanionHeartbeatWatcher` is armed one-per-session with no cross-session scoping (`controller.ts`), so both sessions would fire independently and the owner would get the same proactive message twice.

## The fix

`suppressDuplicateHomeHeartbeats` (`packages/daemon/src/companion/store.ts`) groups every armed config by its resolved home destination and, within any group of two or more, keeps exactly one heartbeat armed. It mirrors the token-fingerprint collision guard's shape (group by a fingerprint, keep exactly one) but is narrower in scope: only the HEARTBEAT is suppressed on the losing session(s), by zeroing `heartbeatIntervalMinutes` — the config's gateway, reminders, and chat replies all stay fully armed. Competition is restricted to LIVE, non-archived sessions (`isLiveSession`): a companion's `companion_config` row survives its session's pty death with `enabled` untouched, so without the liveness filter a dead-but-still-enabled session could WIN the group outright, **or win an unmeasured tie** as the "older" row (the tie-break is by `createdAt`, which a dead session still carries) — and silence a live sibling's heartbeat, the exact orphan-silence this guard exists to prevent. The winner is picked by `mostActive` (most real activity, ties broken by the oldest session).

## Do not

- Do not drop the liveness filter (`isLiveSession`) from the same-home grouping — an unfiltered dead session can outrank and silence a live sibling.
- Do not widen the suppression beyond `heartbeatIntervalMinutes` — the guard is deliberately scoped to the heartbeat only; see `f1d7a22b`'s companion investigation, this record.

## Source

`packages/daemon/src/companion/store.ts`'s `suppressDuplicateHomeHeartbeats` doc comment (was lines 136-153, minus the RESIDUAL LATENCY paragraph — see `134368ac` for that), as of tranche 1 on this file (card `e874a8ba`). No wording changed beyond joining wrapped source lines into flowing paragraphs, stripping `*` comment markers, and dropping the tie-break detail already documented separately at `mostActive`'s own doc comment in the same file (untouched, out of this tranche's scope).
