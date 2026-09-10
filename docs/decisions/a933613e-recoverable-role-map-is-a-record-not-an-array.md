# a933613e — RECOVERABLE_ROLE_MAP is a Record<SessionRole, boolean>, not a bare array

## Narrative

Card a933613e: `RECOVERABLE_ROLE_MAP` in `crash-recovery-watcher.ts` is expressed as a
`Record<SessionRole, boolean>`, not a bare `SessionRole[]` array, so that a FUTURE `SessionRole`
addition to `SESSION_ROLES` (`shared/src/types.ts`) fails to COMPILE here until this map picks a
disposition for it — `RECOVERABLE_ROLES` (the array the watcher actually iterates) is DERIVED from
the map, never hand-edited.

This is exactly what `operator` needed and didn't have: it was added to `SESSION_ROLES` a month
after this list was first authored, the old array type (`SessionRole[]`) permitted the now-stale
subset with zero diagnostics, and the comment above it read as exhaustive without ever being
re-verified — `operator` silently fell outside crash-recovery coverage for that whole month, with
nothing forcing anyone to notice.

## Do not

- Do not revert `RECOVERABLE_ROLE_MAP` to a bare `SessionRole[]` array — that reopens exactly the
  silent-omission gap that let `operator` go unrecovered for a month.
- Do not hand-edit `RECOVERABLE_ROLES` — it must stay DERIVED from `RECOVERABLE_ROLE_MAP`, or the
  compile-time exhaustiveness check this guard exists for is defeated.

## Source

JSDoc comment in `packages/daemon/src/orchestration/crash-recovery-watcher.ts`, above
`RECOVERABLE_ROLE_MAP`: lines 10-32, as of this tranche's HEAD (crash-recovery-watcher.ts,
tranche 1).
