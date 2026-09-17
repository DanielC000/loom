# 7a624213 — harness self-scheduling tools are a Loom-invisible hazard, disallowed per Loom-driven role

## Narrative

The harness's own self-scheduling / remote-trigger tools (`ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`) are a different hazard class than the human-prompt tools (`AskUserQuestion`/`ExitPlanMode`/`EnterPlanMode`) or the native task-tracking tools: none of these block a turn waiting on a human. Instead they let a Loom-driven session arm autonomous behavior — a future tick, a recurring cron job, a claude.ai routine — that Loom itself cannot see or cancel, colliding with Loom's own queued delivery at an idle boundary.

This is from a real incident: a taskless QA worker's `ScheduleWakeup` tick fired the harness's full autonomous-`/loop` mandate — "commit and push", "fix CI" — into a session whose actual instructions come from its manager, at the exact moment a manager `worker_message` was queued to drain. Loom's own sanctioned wake primitive is `wake_me` (an MCP tool, unaffected by this native-tool disallow — Loom can see it and auto-cancels it once the awaited event lands); a Loom-driven session should never need any of `ScheduleWakeup`/`CronCreate`/`CronDelete`/`CronList`/`RemoteTrigger` instead.

`CronList` is read-only standalone, but it only ever lists jobs `CronCreate` made IN THIS SESSION; once `CronCreate` is denied it lists nothing but dead weight advertising a scheduler surface Loom cannot see into, so it closes with the rest of the trio rather than leaving one member reachable. `RemoteTrigger` is the most powerful of the five: it can create/run a claude.ai routine that keeps firing independently of this session, entirely outside Loom, even after this session ends.

## Role scope

Role scope is a THIRD, independent switch in `disallowedToolsForRole`, not folded into the human-prompt switch: worker/setup/auditor/workspace-auditor/assistant/manager get it — every Loom-driven role whose stdin is never a live human, PLUS manager, since a manager's own idle loop runs entirely on `idle_report`/`wake_me`, never a harness tick, and a stray `ScheduleWakeup` tick is just as invisible to Loom and just as able to collide with queued worker reports at a manager's idle boundary.

Deliberately NOT `run` (an ephemeral, owner-triggered Agent Run — unlike every other role here it never idles waiting on anything, so there is no idle boundary for a tick to collide with, and `run` is carved out of THIS switch even though it IS in the human-prompt one), NOT `platform` (the human-driven Platform Lead — an owner-interactive session, not Loom-driven), NOT `operator` (human-spawned-only; untouched by either existing switch, a deliberate consistency call, not an oversight), and NOT plain/role-less (an owner-interactive terminal, where `/loop` is a legitimate owner feature).

## Codex parity

Nothing to deny here, and no lever to deny it with even if there were. `ScheduleWakeup`/`CronCreate`/`CronDelete`/`CronList`/`RemoteTrigger` are Claude-Code-harness-native tool names — codex's own CLI tool surface (shell/apply_patch-style) exposes no equivalent under any name, so there is no codex-side tool to deny in the first place. Separately, and independently, `createCodexPty` has NO `--disallowedTools`/`--allowedTools`-equivalent lever at all — see that method's own doc comment ("codex has NO analogous per-tool lever at all — verified: opts.permission/disallowedTools never appear anywhere in this method or spawnCodexProcess"), the SAME structural gap card `0770d916` already named for a different capability (codescape). This disallow list is deliberately absent from `createCodexPty`'s argv construction: not a silent gap, a structural fact.

## Do not

- Do not add `run`/`platform`/`operator`/a plain session to the `HARNESS_SCHEDULING_TOOLS` role switch — none of them carry the idle-boundary collision hazard the switch exists to close (see Role scope above).
- Do not assume codex needs, or can receive, an equivalent disallow — codex has no matching native tool, and `createCodexPty` has no per-tool lever to add one with regardless.
- Do not fold `HARNESS_SCHEDULING_TOOLS` into the human-prompt-tools switch — they are a different hazard (arming invisible autonomous behavior vs. blocking a turn on a human) with a deliberately different role scope (manager is included here, excluded there).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the JSDoc above `HARNESS_SCHEDULING_TOOLS`), as of this tranche's HEAD. Extracted by card `672310f5` (docs(pty): extract the harness-scheduling-tools comment into a decision record); wording condensed from the original wrapped comment into flowing paragraphs, `*` comment markers stripped, no clause dropped.
