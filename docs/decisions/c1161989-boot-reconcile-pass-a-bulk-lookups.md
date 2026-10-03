# c1161989 — bulk-precompute Pass A/A2's remaining per-session `getProject`/`getTask`/`listEventsForWorker` calls

## The problem, measured

After `dd494a9b` removed the O(N×M) `latestEventSeqForBranch` calls, boot-reconcile still showed a
reproducible ~2.2s main-thread stall, offset to land between Pass A's tail and Pass C's branch-ref sweep
(never inside the sweep itself — zero git spawns and negligible GC overlap that window). Instrumenting
`Db.prototype.{getProject,getTask,listEventsForWorker}` directly (no source edits, monkeypatched in a
harness against a sanitized copy of the real production DB) attributed 82% of a representative 2294.5ms
stall window to these three methods: `listEventsForWorker` (6049 calls, 710.4ms), `getTask` (5561 calls,
771.6ms — `getTask` itself pays a second query per call via `deferralBlockerIds`), `getProject` (6116
calls, 320.3ms). Source confirms: Pass A's loop calls all three, unconditionally, for every one of a
real fleet's ~5500 eligible worker sessions (`role==='worker' && branch && taskId`), with no `await`
between them.

## The fix

Three precomputed stand-ins, built once instead of once per session:
- `Db.listAllProjectsIncludingArchived()` → `projectMap` (shared by Pass A, Pass B, and Pass A2).
- `Db.getTaskColumnKeysByIds(ids)` → `taskColumnKeyMap` — `columnKey` only, never the full `Task` row
  (the only field either read site ever touched), chunked at 300 ids/query.
- `Db.buildWorkerEventPresenceMap()` → `eventPresenceMap` — one indexed pass over
  `orchestration_events` for `merge_request`/`merge_done`/`merge_rejected`, grouped by
  `worker_session_id`.

A fourth, unmeasured-in-the-original-attribution source of the same O(N) shape surfaced while verifying
the fix with a spy test: `columnKeyForProjectRole`, called twice per session (Pass A's `terminalKey` +
Pass A2's own), itself called `this.db.getProject(projectId)` internally — a SECOND `getProject` call
site the original per-session-method instrumentation had folded into one undifferentiated total.
`columnKeyForProjectRole` now accepts an already-resolved `Project` too (`string | Project | undefined`,
a strict widening — every existing `projectId: string` call site elsewhere in this file is untouched);
Pass A passes its own already-resolved `project`, Pass A2 passes `projectMap.get(s.projectId)`. A spy
test (`getProject` call count) measured 40 calls for 20 sessions before this fix, 0 after.

## Round 2 (Code Review 5011411a) — `projectMap` is NOT a safe one-time snapshot

The original claim below — "nothing writes a project row during a boot-reconcile run" — was WRONG: a
live external handler (outside this function's own call graph) can delete or rebind a project via
`deleteProject`/project-config writes while Pass A's own git awaits are in flight (reconcile runs
un-awaited, card `460d3178`) — the exact staleness window `taskColumnKeyMap`/`eventPresenceMap` already
guard against. A single `projectMap` built once and reused by Pass A2/B let a project deleted mid-run
still read as present by the time Pass B ran, so Pass B could GC an orphaned worktree whose project no
longer exists instead of failing safe and skipping it (Pass B's own existing philosophy for every other
"can't be sure" case — a stale repoKey, an unresolvable registry entry). Fix: Pass A2 and Pass B each
rebuild their own fresh `projectMap` (`a2ProjectMap`/`bProjectMap`) at their own start, exactly mirroring
how `taskColumnKeyMap`/`eventPresenceMap` already do for A2. `listAllProjectsIncludingArchived` is now
called once per pass (3 total), not once total — see the updated spy assertion in
`reconcile-pass-a-bulk-db-calls.mjs`. Regression test: `reconcile-pass-b-stale-project-map.mjs`.

## Intra-pass staleness — audited per read site

- **`getProject`**: Pass A's own `projectMap` is a one-time snapshot for PASS A ONLY — see the round-2
  correction above for why Pass A2 and Pass B each need their own fresh rebuild instead of reusing it.
- **`getTask` (`.columnKey`)**: Pass A's own `finalizeMerge` call writes `args.taskId`'s `columnKey`
  mid-pass. A LATER row in the SAME Pass A loop sharing that `taskId` (a re-task or recycle sibling)
  must see the fresh value — so Pass A keeps `taskColumnKeyMap` live via a one-off `getTask` re-read
  inside the existing `onMergeDoneAppended` closure, right after the write it mirrors. Pass A2 rebuilds
  its own fresh `a2TaskColumnKeyMap`, same reasoning as dd494a9b's seq maps (a live external handler can
  write during Pass A's real git awaits, card `460d3178`) — A2 never writes a task's columnKey itself,
  so no live-callback is needed there.
- **`listEventsForWorker` → `hasMergeRequest`/`mergeDoneKeys`/`hasMergeRejected`**: verified by grep that
  within this function's own call graph, `merge_request` and `merge_rejected` are NEVER appended (the
  only writers — the `worker_merge` request handler and the gate-review rejection paths — are unreachable
  from Pass A/A2/B); `merge_done` IS appended, by `finalizeMerge` (Pass A) and Pass A2's own direct
  append. `eventPresenceMap` is keyed by `worker_session_id`, 1:1 with the row being processed — unlike
  the branch-keyed seq maps, no OTHER row's read can ever be affected by one row's own `merge_done`
  append, so Pass A only needs to keep its OWN entry live (same `onMergeDoneAppended` closure). Pass A2
  rebuilds fresh (`a2EventPresenceMap`), same reasoning as its sibling maps.

## Semantics preserved exactly

`alreadyFinalized` reads `(eventPresenceMap.get(s.id)?.mergeDoneKeys.size ?? 0) > 0` — "any `merge_done`
ever", matching the old `workerEvents.some(e => e.kind === "merge_done")` bit for bit. `mergeDoneKeys`
carries `${taskId}|${branch}` (via `workerEventPresenceKey`) rather than collapsing to a boolean, so a
future task+branch-scoped "already finalized" check (card `e34d475c`, landing separately on the same
loop) can read the same keys without a second pass over `orchestration_events` — this card does NOT
implement that narrower check itself.

## Do not

- Do not read `getProject`/`getTask`/`listEventsForWorker` per-session in Pass A/A2 again — route through
  `projectMap`/`taskColumnKeyMap`/`eventPresenceMap` (or their Pass-A2/Pass-B fresh twins) instead.
- Do not reuse Pass A's own `projectMap`/`taskColumnKeyMap`/`eventPresenceMap` for Pass A2 or Pass B —
  each must rebuild its own fresh copy at its own start (round 2: `projectMap` is NOT exempt from this —
  see the round-2 correction above), for the same live-external-handler reason dd494a9b's seq maps
  already do.
- Do not collapse `mergeDoneKeys` to a bare boolean — a future task+branch-scoped check needs the keys.
- Do not let `getProject`'s replacement filter archived/reserved projects — `listAllProjectsIncludingArchived`
  is deliberately unfiltered, matching `getProject(id)`'s own behavior; `listProjects()`/`listAllProjects()`
  would silently drop a session whose project was later archived or is reserved.
- Do not call `columnKeyForProjectRole(s.projectId, ...)` (the `string` overload) inside a per-session
  loop again — pass the already-resolved `Project` instead, or the per-call `getProject` this overload
  exists to let a caller skip comes right back.
- Do not default `onMergeDoneAppended`'s fallback `eventPresenceMap` entry to `hasMergeRequest: true` —
  a missing entry IS the snapshot's own answer that no `merge_request` was ever observed for that
  session; the fallback must read `false` (round 2, Code Review finding 3).
