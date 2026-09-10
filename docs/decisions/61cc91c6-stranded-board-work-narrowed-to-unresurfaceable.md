# 61cc91c6 — a restart's "stranded board work" nudge trigger narrowed to work NOTHING ELSE will ever re-surface

## Narrative

Card 61cc91c6 narrowed what counts as "stranded board work" for the purpose of forcing the full
re-orient nudge on a `daemon_restart` resume. Before this card, ANY non-terminal / non-held / non-deferred
board card on a manager's board forced the full nudge — which fired on virtually every restart, since
ordinary backlog is the common case, not the exception. This was measured as the dominant source of the
whole "wasted full turn on a boot-resume nudge" problem this family of cards addresses (see
`b5664b5b`, `066d317c`).

The fix: raw backlog no longer counts by itself when the manager/platform's own idle policy is
`watching` or `snoozed` — that ordinary backlog is ALREADY independently re-surfaced by the
idle-watcher's own cadence (`orchestration/idle-watcher.ts`) regardless of whether a restart happened at
all, so re-forcing the full nudge here was pure duplication of coverage that already exists. Only board
work that NOTHING ELSE will ever re-surface — a manager or platform/Lead whose idle policy is
`suppressed`-via-escalation — still forces the full nudge, since skipping it there would strand the
queue with no other mechanism ever checking it again.

This also removed the old unconditional carve-out that treated a platform/Lead session's backlog as
always-stranded: since card 98b3725c gave a Lead the SAME idle-watchdog tick coverage a manager gets, a
Lead's board backlog is now classified by this identical rule, not a special case.

## Do not

- Do not force the full boot-resume re-orient nudge off raw board backlog alone — check the
  manager/platform's OWN idle policy (`watching`/`snoozed` vs `suppressed`) first; only backlog that
  nothing else will ever re-surface should force the nudge.
- Do not carve platform/Lead sessions out of this classification — since `98b3725c`, a Lead's backlog is
  covered by the same idle-watchdog cadence a manager's is, so it uses the identical rule.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`: lines 4388-4396,
as of this tranche's HEAD (tranche 11). Cross-referenced (read-only) against `orchestration/restart.ts`
(lines 257-274) and `orchestration/wake-impact.ts` (lines 7, 120-121), which implement/document the same
narrowing.
