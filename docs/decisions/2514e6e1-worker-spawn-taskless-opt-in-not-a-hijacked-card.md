# 2514e6e1 — `worker_spawn` with no `taskId` opts INTO a taskless worker, instead of hard-requiring one

## Narrative

Card 2514e6e1 (companion card 72ee0bcf): before this fix, `worker_spawn` hard-required a `taskId` — so an
ad-hoc/spike (a no-commit research spawn with nothing to land) had to hijack an unrelated,
content-bearing board card just to satisfy the requirement: falsifying its board state and forcing a
verbatim body-restore afterward to undo the damage.

TASKLESS SPAWN: an EMPTY/omitted `taskId` is no longer rejected — it opts INTO a taskless worker instead
(an ad-hoc spike/no-commit-review spawn with no board card to falsify or hijack). `taskId` stays `null`
for the rest of the method in that case, which every downstream taskId-gated step (terminal/held/
live-holder guards, the board move, the event's `taskId`) already treats as "no task" — this is the ONLY
branch point; nothing downstream needs its own taskless special-case beyond the existing `if (taskId)`
guards.

## Taskless spawns claim a FRESH per-call id, never `taskId`, in the in-flight spawn-claim set

A taskless spawn (`taskId` null) has no real task to claim mutual exclusion over — and shouldn't:
distinct taskless spawns (two spikes, or a CR reviewing branch A while another reviews branch B) must be
free to run CONCURRENTLY, each in its own worktree, never serialized against each other the way two
spawns racing for the SAME task must be. So a taskless spawn claims a FRESH per-call id
(`claimKey = taskId ?? randomUUID()`) instead of `taskId` — `.has()` on a fresh `randomUUID()` is always
false (never falsely rejects), while `.add()`/`.size` still reserve it for the concurrency-cap admit, so
an in-flight taskless spawn still counts against the cap exactly like a tasked one. A real taskId's claim
key is just `taskId` itself — byte-identical to the pre-taskless-spawn behavior for every tasked call.

## Do not

- Do not force a taskless ad-hoc/spike worker to hijack an unrelated board card just to satisfy a
  hard-required `taskId` — an empty/omitted `taskId` is a legitimate, first-class spawn shape.
- Do not add a new taskless special-case downstream of the `taskId` derivation — every existing
  `if (taskId)` guard already treats `null` correctly; a second special-case is redundant and can drift.
- Do not claim `taskId` itself for a taskless spawn's mutual-exclusion key — two unrelated taskless
  spawns must run concurrently, never serialize against each other.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`worker_spawn`'s taskId derivation): lines
5885-5891, as of commit `970f0867d0c479a11a31199e6b9ebcea4404a6fa` (`feat(orchestration): worker_spawn
hard-requires a taskId, so an ad-hoc/spike (no-commit research) worker must hijack an unrelated
content-bearing card — falsifying its board state and forcing a verbatim body-restore`, the pre-fix
commit whose subject describes the bug this card fixes). Relocated by card `61632c05` (tranche 15); no
wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers
stripped.

## Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts` (`worker_spawn`'s atomic spawn-claim block,
the taskless-claim-key tail): lines 6044-6052, same commit `970f0867d0c479a11a31199e6b9ebcea4404a6fa`.
Relocated by card `61632c05` (tranche 15).

## A taskless spawn keys its worktree/branch off `claimKey`, never `taskId`

WORKTREE KEY: a tasked spawn keys its (deterministic, reused-on-re-spawn) worktree/branch off `taskId`
exactly as before. A taskless spawn has no stable id to key off, and must NEVER reuse another spawn's
worktree — so it keys off `claimKey` (this call's own fresh `randomUUID()`), guaranteeing its own
ISOLATED worktree/branch that can never collide with a task's worktree or with another taskless spawn's.
This is also how a read-only reviewer (see the noCommit/build-phase decision, card `503cd822`) avoids
ever sharing the author's worktree.

### Do not (3)

- Do not key a taskless spawn's worktree/branch off `taskId` — it has none. Key off `claimKey` instead,
  or two taskless spawns (or a taskless spawn and a real task) can collide on the same worktree.

## Source (3)

Inline comment in `packages/daemon/src/sessions/service.ts` (`worker_spawn`'s worktree-key derivation):
lines 6063-6067, same commit `970f0867d0c479a11a31199e6b9ebcea4404a6fa`. Relocated by card `61632c05`
(tranche 15).
