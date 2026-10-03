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

Two DIFFERENT staleness concerns, with two different fixes — do not conflate them.

**Within `reconcileOrchestrationOnBoot`'s own call graph**, `merge_request` is never appended (the only
writer is `sessions/service.ts`'s `reviewWorkerMerge` — the worker_merge review step, unreachable from
Pass A/A2 or anything they call; verified exhaustively by reading every method Pass A calls, transitively,
down to `spawnWorker`/`retireWorkerSession`/`soloFinalizeTipGuard` — none append it). `merge_done` IS
appended within this call graph: `finalizeMerge` (used by Pass A) and Pass A2's own stale-alert resolver
both append it WHILE reconcile is running, and a later-processed session on the SAME branch must see an
earlier-processed session's fresh append (the exact "finalizedElsewhere" check this map replaces).
`finalizeMerge` gained an optional `onMergeDoneAppended?: (branch, repoKey, seq) => void` callback, invoked
immediately after its own `merge_done` append commits; Pass A wires it to update its OWN live
`mergeDoneSeqMap` in place. `appendEvent` now returns `number` (was `void`) so this callback — and Pass
A2's own inline update — can learn the seq without a re-read. Every OTHER `finalizeMerge` caller
(`confirmWorkerMerge`, `finishAlreadyMerged`) simply omits the callback — byte-identical behavior, since
it's optional.

**Across the WHOLE daemon**, this guarantee does NOT hold: `reconcileOrchestrationOnBoot` runs
un-awaited after `app.listen()` (card `460d3178`), so a LIVE MCP handler (an ordinary worker's own
`worker_merge` review, a solo `confirmWorkerMerge`) can append `merge_request` or `merge_done` for ANY
branch — including one Pass A has not yet reached — while Pass A's own real git awaits are in flight.
Pass A's live-callback approach does not protect Pass A2 from this, because Pass A2 starts only AFTER
Pass A's entire (potentially long, truly concurrent) loop finishes — by then, Pass A's maps (built once
at the very top, before Pass A's own git awaits even began) can be stale relative to concurrent live
appends. Pass A2 therefore REBUILDS both maps fresh, synchronously, at its own starting line — one extra
`O(M)` scan per kind — restoring the exact fresh-per-lookup semantics the old per-session
`latestEventSeqForBranch` calls had, for A2 specifically. Pass A's own maps are deliberately NOT
rebuilt — Pass A keeps the live-callback approach (cheaper, and sufficient for what Pass A itself needs:
seeing ITS OWN in-run appends, not racing live external handlers mid-loop, which is a separate,
pre-existing exposure this card does not change).

Verified by `test/latest-event-seq-map-in-run-staleness.mjs`: two session rows share one worktree/branch,
neither has a pre-existing `merge_done`; the first-processed row's real finalize appends a live
`merge_done`, and the second-processed row (pre-seeded only with its own `merge_request`) must see that
live append and take the cleanup-only path — never a second, duplicate finalize. The test also captures a
map snapshot taken before reconcile runs and shows it does NOT contain the first row's (not-yet-appended)
`merge_done` — proof that a naive one-shot-snapshot design would have missed it and produced the
duplicate-finalize bug this fix exists to avoid. A SEPARATE test covers Pass A2's OWN in-run staleness
(two A2-eligible rows sharing one branch+repoKey, neither with a pre-existing terminal event) — see that
test's own header for why it must go RED with Pass A2's inline `.set` removed.

## Do not

- Do not call `latestEventSeqForBranch` from inside a per-session loop again — route it through
  `buildLatestEventSeqMap` + a single precomputed map instead.
- Do not let `latestEventSeqForBranch` and `buildLatestEventSeqMap` normalize `repoKey` independently —
  both must call the shared `detailRepoKey` function.
- Do not treat the `merge_done` map as a safe one-time snapshot — it must be kept live via
  `onMergeDoneAppended` (finalizeMerge) and the inline update after Pass A2's own append, or a
  same-pass sibling re-finalize regresses silently.
- Do not let Pass A2 reuse Pass A's own maps — Pass A2 must rebuild both fresh at its own start, because
  a live MCP handler outside this function can append either kind during Pass A's real git awaits
  (reconcile runs un-awaited, card `460d3178`); Pass A's maps, built before those awaits, can be stale by
  the time Pass A2 runs. Do not read "never appended" anywhere in this record as holding against live
  handlers — it only describes `reconcileOrchestrationOnBoot`'s OWN call graph.
- Do not add yield points (`await`) inside Pass A/A2's loops as part of this fix — that was explicitly
  deferred by the card's own manager direction (a new race surface between reconcile and live HTTP/MCP
  handlers); propose it separately with its own race analysis if a future profile still shows a
  synchronous stretch worth addressing.
