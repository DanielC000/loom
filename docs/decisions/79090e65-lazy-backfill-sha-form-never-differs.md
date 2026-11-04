# 79090e65 — the lazy backfill's sha-match guard never actually sees a form mismatch

Card `79090e65` worried that `GET /api/tasks/:id`'s lazy ship-state backfill
(`gateway/server.ts`, decisions `1eebc46a`/`5933734e`) compares `fresh.mergedSha ===
resolved.merged.sha` between two values that might carry DIFFERENT sha forms —
`tasks_get`/`tasks_list` display `merged.sha` in SHORT form, while a solo landing
was suspected to store the FULL form. If true, the equality would never hold for
those cards and the backfill would be silently dead (safe direction: no wrong
write, but no verification backfill either).

## Investigated, not assumed

Every real writer of `Task.mergedSha` funnels through exactly ONE chokepoint:
`finalizeMerge`'s `shipPatch` (`packages/daemon/src/sessions/service.ts`, ~line
28238) does `mergedSha: args.mergedSha.slice(0, 7)`, with its own comment stating
it's "shortened to 7 chars to match the MCP `merged.sha` convention
(mcp/tasks.ts)". This one method is shared by:
- the solo squash-confirm Green path (`service.ts` ~22434),
- batch landing via `finishAlreadyMerged` (`service.ts` ~22949, fed from
  `mergeBatchTracked` at ~24285),
- boot-reconcile Pass A (`service.ts` ~29181, whose own comment names all three
  callers explicitly: "solo confirm, batch via finishAlreadyMerged,
  boot-reconcile Pass A").

`resolveMergedInfo` (`mcp/tasks.ts`) always returns a SHORT sha too —
`getTaskMergedInfo` (`packages/daemon/src/git/worktrees.ts` ~9535 and ~9490)
slices to 7 chars on BOTH its trailer-scan return and its ledger-fallback return.

`mergedSha`/`mergedRepoKey`/`mergedDate` also never held a pre-`1eebc46a` legacy
value in a different form — the columns didn't exist before that card
(`task-merged-fields-migration.mjs` proves every pre-existing row migrates to
null, not to some inherited full-form value).

So both sides of the comparison are always 7-char slices of the same full sha in
every real code path. The feature is not dead; no normalization fix is needed.

## Do not

- Do not assume a full-vs-short sha mismatch is reachable from any real Loom
  writer — it isn't, as of this investigation; re-verify at the same three call
  sites (`finalizeMerge`'s `shipPatch`, and `getTaskMergedInfo`'s two return
  points) before reviving this concern, rather than re-deriving it from scratch.
- Do not add sha-prefix normalization to the backfill's comparison "defensively"
  — it would weaken a guard that is currently exact-match-only for a case that
  cannot occur, and a prefix-based match is a strictly weaker safety property.
- Do not read `task-merged-lazy-backfill.mjs` scenario (7) (a stored FULL-form
  `mergedSha` against the real scan's SHORT-form resolve) as describing a
  reachable production shape — it's a deliberately synthetic probe of the
  comparison's safe failure direction, not a regression repro.

Test: `packages/daemon/test/task-merged-lazy-backfill.mjs` scenario (7) — proven
capable of failing via a mutant that disables the sha-match guard (went RED on
this scenario and the pre-existing (6c), reverted and reconfirmed GREEN).
