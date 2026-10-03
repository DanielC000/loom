# dd494a9b — precompute latestEventSeqForBranch instead of calling it per session

## The problem, measured

`reconcileOrchestrationOnBoot`'s Pass A and Pass A2 each called `Db.latestEventSeqForBranch` twice per
candidate session (4 call sites total) to answer "is this branch's landing already finalized elsewhere /
already resolved". `latestEventSeqForBranch` runs an unindexed `json_extract(detail_json,'$.branch')`
scan over every `orchestration_events` row of the given `kind` — no index covers that predicate
(`idx_orch_events_kind` only covers `(kind, worker_session_id)`). Called once per session across a
7200-session fleet (5544 worker rows), this O(N sessions × M events-of-that-kind) pattern measured as
96% of a ~7.3-minute boot-reconcile stall (`--cpu-prof` against a sanitized copy of the real production
DB — see the card for the full profile). The whole run showed as one unbroken synchronous stretch: a
single event-loop-lag tick of ~426 seconds out of 199 samples.

## The fix

`Db.buildLatestEventSeqMap(kind)` does ONE pass over `orchestration_events` for a given kind and returns
a `Map<string, number>` (key: `latestEventSeqMapKey(branch, repoKey)`) — every (branch, repoKey) pair's
latest seq, computed once instead of N times. `reconcileOrchestrationOnBoot` builds one map per kind at
the top of the function and replaces all 4 `latestEventSeqForBranch` call sites with O(1) map lookups.

## Parity, by construction

Both functions share `detailRepoKey(detailJson)` — the ONE place a row's `repoKey` is read and defaulted
(`?? null`) — so they can never drift on repoKey normalization (e.g. whether a literal `"primary"`
repoKey is treated as equal to `null`; it is NOT, in either function, since this is a raw `===`
comparison, not `resolveRepoByKey`'s own primary-coalescing). Branch extraction uses the IDENTICAL SQL
expression (`json_extract(detail_json,'$.branch')`) in both — `latestEventSeqForBranch`'s own WHERE
clause, and the map builder's SELECT projection — so there is no second, JS-side branch-extraction
mechanism that could disagree with SQLite's own. The map builder reads rows in ascending `seq` order and
overwrites on every match, so the last write for a key is its max seq — the same answer
`latestEventSeqForBranch`'s `ORDER BY seq DESC` + first-match-wins produces. Verified by
`test/latest-event-seq-map-parity.mjs` against a fixture with mixed repoKeys (`null`/`"primary"`/`"other"`)
and a re-tasked reused branch — every (branch, kind, repoKey) the map yields matches
`latestEventSeqForBranch`'s own answer, and a deliberately-naive repoKey-blind map variant is shown to
disagree (proving the test has teeth).

## In-run staleness

`merge_request` is never appended during a boot-reconcile run (only a worker's own live merge-request
flow files it — the only writer is `sessions/service.ts`'s worker_merge handler, unreachable from
`reconcileOrchestrationOnBoot`) — so the `merge_request` map is a safe one-time snapshot for the whole
run. `merge_done` is NOT: `finalizeMerge` (used by Pass A) and Pass A2's own stale-alert resolver both
append `merge_done` WHILE reconcile is running, and a later-processed session on the SAME branch must see
an earlier-processed session's fresh append (the exact "finalizedElsewhere" check this map replaces).
`finalizeMerge` gained an optional `onMergeDoneAppended?: (branch, repoKey, seq) => void` callback, invoked
immediately after its own `merge_done` append commits; Pass A wires it to update the live `mergeDoneSeqMap`
in place. Pass A2's own direct `merge_done` append does the same update inline, right after `appendEvent`
returns its assigned seq (`appendEvent` now returns `number`, not `void`). Every OTHER `finalizeMerge`
caller (`confirmWorkerMerge`, `finishAlreadyMerged`) simply omits the callback — byte-identical behavior,
since it's optional. Verified by `test/latest-event-seq-map-in-run-staleness.mjs`: two session rows share
one worktree/branch, neither has a pre-existing `merge_done`; the first-processed row's real finalize
appends a live `merge_done`, and the second-processed row (pre-seeded only with its own `merge_request`)
must see that live append and take the cleanup-only path — never a second, duplicate finalize. The test
also captures a map snapshot taken before reconcile runs and shows it does NOT contain the first row's
(not-yet-appended) `merge_done` — proof that a naive one-shot-snapshot design would have missed it and
produced the duplicate-finalize bug this fix exists to avoid.

## Do not

- Do not call `latestEventSeqForBranch` from inside a per-session loop again — route it through
  `buildLatestEventSeqMap` + a single precomputed map instead.
- Do not let `latestEventSeqForBranch` and `buildLatestEventSeqMap` normalize `repoKey` independently —
  both must call the shared `detailRepoKey` function.
- Do not treat the `merge_done` map as a safe one-time snapshot — it must be kept live via
  `onMergeDoneAppended` (finalizeMerge) and the inline update after Pass A2's own append, or a
  same-pass sibling re-finalize regresses silently.
- Do not add yield points (`await`) inside Pass A/A2's loops as part of this fix — that was explicitly
  deferred by the card's own manager direction (a new race surface between reconcile and live HTTP/MCP
  handlers); propose it separately with its own race analysis if a future profile still shows a
  synchronous stretch worth addressing.
