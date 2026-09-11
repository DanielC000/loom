# 24cc40f9 — Capture main's HEAD once; thread the same sha through the behind-main proof and the gate-base capture

## Narrative

`confirmWorkerMerge`'s reuse-a-green-self-check check (card [[e50600d2-keep-run-gate-for-workers-and-lean-on-reuse]])
needs to prove `freshBehindMain === 0` (main's current HEAD is already an ancestor of the branch) AND
thread that same main tip through as `gateBaseMainHead`, the sha `mergeBranchLocked` later re-verifies
against inside its lock. Resolving main's HEAD twice for these two purposes — once to prove
`freshBehindMain`, once to capture `gateBaseMainHead` — would be two independent git spawns roughly
30-150ms apart, and canonical main is a process-wide shared resource: a sibling merge landing via
GitWriter's REST commit/checkout path (which does not serialize on `withCanonicalIndexLock`) could move
HEAD between the two reads, so each could observe a different tip.

The fix: resolve main's HEAD a single time (`freshHead`) and thread that SAME sha into
`countCommitsBehind` as its explicit `base` argument, so the behind-main proof and the captured gate-base
sha are pinned to one commit by construction, not two independent reads that could each observe a
different tip.

A HEAD that fails to resolve (`freshHead === undefined`) means there is nothing to prove
`freshBehindMain` against and nothing to hand `mergeBranchLocked` as a re-check base — this fails CLOSED
by not reusing at all, rather than passing `undefined` through (which would be read downstream as "no
re-check requested," silently skipping the very protection this exists for).

## Do not

- Do not resolve main's HEAD twice (once for `freshBehindMain`, once for `gateBaseMainHead`) — two
  independent reads can observe two different tips if a sibling merge lands in between.
- Do not pass an unresolved `freshHead` through as `gateBaseMainHead` — an `undefined` there is read as
  "no re-check requested" downstream, silently disabling the protection.

## Source

Two sites in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`, as of the tranche-44
worktree's HEAD before this extraction (current line numbers, main moves): the CAPTURE-ONCE comment at
`freshHead`'s own resolution (~12083), and the same rationale referenced more briefly inside the reuse
condition-3 proof (~12044). Wrapped source lines joined into a flowing paragraph, `//` markers stripped,
no wording changed.
