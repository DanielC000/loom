# 80d54122 — `recentTimeoutStreak` is unconditional, cross-project; only `taskId`/`branch`/`workerLabel` stay own-project

## Narrative

Card 80d54122 (RESOLVED — was previously own-project-only): this used to live INSIDE the `callerProjectId` conditional below, alongside `taskId`/`branch`/`workerLabel`, so a cross-project entry omitted it too. Read at source (`gateQueueForManager`'s own history — see that function's doc) that placement was never a deliberate call that the STREAK ITSELF needed redacting: it landed there because computing it needs the raw branch string (`gateTimeoutStreakCount(e.branch)`), which at the time was only ever read inside that same block (to populate the ALSO-redacted `entry.branch`). No comment anywhere ever argued the integer itself discloses anything — contrast `taskId`/`branch`/`workerLabel`, each with an explicit stated reason (task/branch identity, a trust boundary `project_links` doesn't grant). A bare non-negative integer with no title, no identifier, and nothing about what the peer is doing carries none of that, while the hazard it exists to catch (an orphaned gate process still consuming the shared host) is cross-project BY NATURE — so it is now computed the same way as `idleMs`/`extended`/`repoContended` above: unconditionally, from the raw (never-exposed) `branch`, identically for an own- and a foreign-project entry. `taskId`/`branch`/`workerLabel` themselves are UNCHANGED — still own-project only; only this one bare integer moved.

## Do not

- Do not re-gate `recentTimeoutStreak` behind the own-project conditional again — its co-location with `taskId`/`branch`/`workerLabel` there was an implementation accident (it needed the raw `branch` string only THEY were reading at the time), never a deliberate redaction call; a bare non-negative integer discloses nothing `taskId`/`branch`/`workerLabel` do, and the hazard it catches is cross-project by nature.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`GateQueueEntry.recentTimeoutStreak`): lines 184-196, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
