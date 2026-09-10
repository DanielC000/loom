# 98b3725c — a platform (Lead) session gets the SAME idle-watchdog coverage a manager gets

## Narrative

Card 98b3725c extended the "Asleep-at-the-Wheel" idle-watchdog coverage (`orchestration/idle-watcher.ts`)
— previously manager-only — to platform (Lead) sessions too, on the identical tick and cadence a manager
gets (a structural twin of `ContextWatcher`: each tick walks every LIVE manager OR platform session).

This matters beyond the watchdog itself: it removed the old unconditional special-case in
`resumeFleetOnBoot`'s stranded-board-work classification (card 61cc91c6) that always treated a
platform/Lead session's backlog as stranded, on the theory that nothing else was watching it. Since a
Lead's idle policy (`watching`/`snoozed`/`suppressed`) is now actively re-surfaced by the same
idle-watcher cadence a manager's is, a Lead's board backlog is classified by the identical
"is anything else going to re-surface this" rule as any manager's — no more carve-out.

## Do not

- Do not treat a platform/Lead session as exempt from idle-watchdog coverage — it receives the same
  per-tick coverage a manager does.
- Do not special-case a Lead's board backlog as unconditionally "stranded" in restart-resume
  classification — its idle policy is watched exactly like a manager's, so the same
  watching/snoozed-vs-suppressed rule applies.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`: line 4393, as of
this tranche's HEAD (tranche 11). Cross-referenced (read-only) against `orchestration/idle-watcher.ts`
(lines 116, 207), `db.ts` (line 5325), `mcp/platform.ts` (line 1782), and `service.ts` line 12191, which
document/implement the same coverage extension.
