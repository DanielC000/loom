# c33f94b2 — boot-reconcile's `mergesFailed` wording splits an honestly-retriable count from a permanently-wedged one

## Narrative

The boot-time orchestration-reconcile summary line used to report `mergesFailed` as a bare "N failed
(retry next boot)" for EVERY failure shape, including a `repoKey` that can structurally never resolve
(e.g. a registry entry removed after the task was written). "Retry next boot" is false comfort for that
class: three such records were observed retrying at every boot for 26+ days, never once clearing, because
nothing about the condition changes between boots. The wording is now split the same way
`worktreesStillWedged`/`worktreesNeedsHuman` already split out of `worktreesPruned` on this same line: an
honestly-retriable count (`mergesFailed - mergeReconcileWedged`) plus, only when non-zero, a
permanently-wedged count with a pointer to `reconcileOrchestrationOnBoot`'s own dedicated per-entry warn —
which names each worker/branch/project/wedged-since/attempts, more detail than this one condensed summary
line can carry.

## Do not

- Do not report a structurally-unresolvable `repoKey` failure as "retry next boot" — it never clears on
  its own, and the phrase misleads a reader into expecting it will.
- Do not fold the permanently-wedged count back into the bare `mergesFailed` total — keep it a separate,
  named phrase (only shown when non-zero) so the two failure classes stay distinguishable at a glance.

## Consequences

A boot whose reconcile pass hits a permanently-wedged `repoKey` now says so explicitly instead of
implying every failure will clear with time, and points at the dedicated per-entry warn for the detail a
human actually needs to resolve it.

## Source

Inline comment in `packages/daemon/src/index.ts`, inside the boot-time orchestration-reconcile summary
line's construction, as of this worktree's HEAD before this extraction. Wrapped source lines joined into
a flowing paragraph, `//` comment markers stripped, no wording changed.
