# ba41b402 — bound the dangling-worker candidate pool to the newest N, accepting a real coverage loss

## Narrative

Card ba41b402 defect 1: a worker STOPPED (archived) before its work was merged is otherwise invisible to `worker_list` — `archiveOnExit` archives every exited worker-role session unconditionally, and `listWorkers`/fleetView filter `archived_at IS NULL`. An empty `worker_list` is the NORMAL reading for "clean seam, nothing in flight" — which is exactly why this gap is dangerous: the bad state looks identical to the healthy one. `SessionService.getDanglingWorkers` surfaces the candidates that make it look different.

Card ba41b402: `listArchivedWorkersInProject` returns the `limit` most-recently-created archived worker-role sessions in a project that still carry a `branch` — the candidate pool for `SessionService.getDanglingWorkers`. Deliberately PROJECT-scoped, not manager-scoped like `listArchivedWorkers`: a stopped worker's `parent_session_id` may point at a recycled predecessor manager, and the caller applies its own lineage-tolerant filter on top of this broad set (mirrors `orchestration.ts`'s `archivedUnreported` category, which does the same "broad candidate query, then lineage-filter in the caller" split for the identical reason).

BOUNDED, per manager review on this card: this set only ever GROWS — every worker a project has ever archived stays in it forever, and `worker_list`/`worker_status({})` call this on every read, so an unbounded scan is a real, ever-worsening cost on the manager's most-polled tool. `LIMIT` + `ORDER BY created_at DESC` caps it to the newest N regardless of the project's total archived-worker history. TRADE-OFF, stated plainly: a genuinely-dangling branch OLDER than the newest `limit` archived workers stops being surfaced by this view. Accepted deliberately — the incident this card documents was hours old, not months — but it is a real coverage loss, not just a performance tweak.

`SessionService.getDanglingWorkers`, the caller, applies the lineage-tolerant filter this record's first Narrative paragraph promised: THE DISCRIMINATOR IS THE BOUND TASK'S `mergedSha`, NOT branch content or branch existence — measured against this project's own real history, not assumed. A branch-NAME-keyed check (grep main for the branch's `Loom-Worker-Branch:` trailer, the mechanism behind `findLandedSquashCommit`) still false-positives when a SIBLING branch shipped the same task's content under a different name (confirmed on this box: `loom/334766209ca5` and `loom/519072235f5d`'s content actually landed as `loom/049954da61c5` → squash commit `b4fa85a4`, task `0050a17e`). A content/path-set-hash equivalence check across ALL landed commits (not just same-named) ALSO false-positives when the task was resolved by a genuinely different superseding fix — not a re-dispatch of the same diff (confirmed: `loom/fe8f48e20cde`'s task `4af5aefa` landed via `loom/f5994214094c` → `31eace03`, a different diff entirely). `Task.mergedSha` doesn't care which branch or diff shipped, only whether the TASK is resolved — it resolves BOTH false-positive modes in one DB read, no git shellout for the common (tasked) case.

COST (mgr review, card ba41b402): `getDanglingWorkers` runs on EVERY `worker_list`/`worker_status({})` call — the manager's most-polled tool — so cost matters here in a way it doesn't for a one-off read. The CHEAP checks (worktree existence via `fs.existsSync`, the task's `mergedSha` via a plain DB read) run BEFORE the one EXPENSIVE check (`commitsAheadOfMain`'s git subprocess) — deliberately ordered so the subprocess only ever runs on a candidate that survived every cheaper filter, never on the full pool. The subprocess is further MEMOIZED per archived worker (`danglingAheadCache`), so a taskless candidate's git call only ever fires once per archive lifetime, not once per `worker_list` poll.

## Do not

- Do not remove the `LIMIT`/`ORDER BY created_at DESC` bound to "fix" the coverage gap — the unbounded scan is a real, ever-worsening cost on `worker_list`/`worker_status({})`'s every-read hot path.
- Do not treat the bound as free of cost — a genuinely-dangling branch older than the newest `limit` archived workers is invisible to this view; that's an accepted trade-off, not a non-issue.
- Do not key the dangling-worker discriminator on branch name or content-hash equivalence — both have MEASURED false-positive modes on this project's own history (a sibling branch shipping the same task's content under a different name; a genuinely different superseding fix). Use the bound task's `mergedSha` instead.

## Consequences

A stopped worker whose work was never merged is now surfaced to the manager instead of looking identical to a clean seam, without false-positiving on a sibling branch or a superseding fix that happened to land the same task under a different diff.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listArchivedWorkersInProject`): lines 4823-4839, as of this tranche's HEAD.

Also cited in `packages/daemon/src/sessions/service.ts`, `SessionService.getDanglingWorkers`'s own doc comment (~line 17364), as of this worktree's HEAD before this extraction (tranche 64); wrapped source lines joined into flowing paragraphs, comment markers stripped, no wording changed. That same comment also carries a taskless-worker-handling paragraph and a lineage-scoping paragraph (the latter attributed to card `93609ef3`, which has no record of its own — its reasoning lives inline at `orchestration.ts`'s `workerReadableByManager` comment, ~line 2560) left inline at that site rather than folded in here, for byte-cap headroom.
