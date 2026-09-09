# 1eebc46a — lazy ship-state backfill on `GET /api/tasks/:id`, not the board LIST route

## Narrative

Card `1eebc46a`: a card merged BEFORE `mergedSha` started being persisted at merge-confirm time has no cached ship-state yet. This route fills it in on first open — ONE single-task git lookup (`resolveMergedInfo`), never the per-poll-scale cost the board LIST route avoids by design (measured ~40s at ~1200 cards; this route is a single row). BEST-EFFORT: `resolveMergedInfo` already fails safe to null internally, but this write-through cache-fill must never 500 the drawer — any failure here just falls through and returns the row unchanged.

Two Code Review fixes over the original implementation:
- Uses `setTaskMergedInfoNoTouch` (NOT `updateTask`) so this pure GET-triggered cache-fill never bumps `updatedAt` — the done lane sorts `byRecentlyDone`, so a plain `updateTask()` call here would jump an old done card to the top of its lane the first time anyone opened its drawer.
- Stamps the repoKey `resolveMergedInfo` ACTUALLY scanned (`resolved.repoKey`), not `t.repoKey` — a stale/since-retargeted `task.repoKey` can disagree with where the sha was actually found (e.g. a stale key degrades to primary; stamping `t.repoKey` there would render "<key> — no longer registered" for a sha that's really on primary).

Also re-runs (mergedSha present but `mergedVerification` still null — card `52e978ad`) for a card whose `mergedSha` was stamped by a write path that didn't itself know its verification mode (`finishAlreadyMerged` / boot-reconcile's landed-sha paths — see `finalizeMerge`'s own doc) — so the board eventually shows the verification tier for EVERY merged card, not just the ones that went through the fresh-squash happy path or a pre-existing legacy backfill.

## Do not

- Do not use `updateTask` for this cache-fill — it bumps `updatedAt` and jumps an old done card to the top of the done lane. Use `setTaskMergedInfoNoTouch`.
- Do not stamp `t.repoKey` on the backfilled row — stamp `resolved.repoKey`, the key `resolveMergedInfo` actually scanned.
- Do not let a `resolveMergedInfo` failure here 500 the drawer — it must fall through and return the row unchanged.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`GET /api/tasks/:id`, lines 3817-3837 as of commit `a9b55042`). Relocated by card `c57868e5`; wording condensed, no substantive detail dropped.
