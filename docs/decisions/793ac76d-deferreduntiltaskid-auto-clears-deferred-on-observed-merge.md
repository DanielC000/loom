# 793ac76d — `deferredUntilTaskId`: "deferred until THIS task merges," auto-clearing `deferred`

## Narrative

Card 793ac76d added `Task.deferredUntilTaskId` — an OPTIONAL companion to `deferred` expressing "deferred until THIS task merges." When set, the daemon re-derives `deferred` on every `tasks_get`/`tasks_list` read by checking the named task's git-derived `merged` state (the SAME live check `TaskWithMerged.merged` already performs, never a new cached flag) and clears `deferred` to `false` — persisted back via a normal `db.updateTask`, so `Task.deferred` itself stays the single source of truth downstream (e.g. the idle watchdog, which reads `deferred` directly and has no knowledge of this field).

`null`/absent (the default) is the byte-identical today's-behavior case: a deferral with no named blocker is NEVER auto-cleared — this is load-bearing for an owner-gated or external-upstream deferral, which must stay manually managed.

Validated at SET time (`updateProjectTask`, mcp/tasks.ts): must resolve to a real task on THIS board (full id or unambiguous prefix, normalized to the full id since the read-time check does an exact-id lookup) and a self-reference is rejected. A blocker that's since been deleted (dangling reference) degrades to "stays deferred" at read time — never throws, never silently drops the card. Meaningless while `deferred` is false.

Cleared to `null` in the SAME write-through that auto-clears `deferred` — see docs/decisions/cf62c1ef-clearing-deferreduntiltaskid-on-autoclear-prevents-silent-re-defer.md for why that clear is deliberate, not incidental (the stale-blocker-reference footgun it prevents). An explicit `tasks_update(deferred:false)` — a MANUAL clear, not an auto-clear — does NOT touch this field.

See docs/decisions/022659ac-deferreduntiltaskid-multiple-blockers-and-are-across-all.md for the multi-blocker (array) widening of this field.

## Do not

- Do not treat `null`/absent `deferredUntilTaskId` as auto-clearing — a deferral with no named blocker is NEVER auto-cleared, which is load-bearing for an owner-gated or external-upstream deferral.
- Do not read a dangling blocker reference (the named task was deleted) as an error — it degrades to "stays deferred" at read time.

## Source

JSDoc comment in `packages/shared/src/types.ts` (`Task.deferredUntilTaskId`'s own doc). Extracted by card 555f817f (tranche 3 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
