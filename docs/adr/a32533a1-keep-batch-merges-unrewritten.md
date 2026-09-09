# a32533a1 — A batched merge lands each branch's own commit subjects verbatim; only a solo merge uses the card title

## Status

accepted

## Context

For a **solo** `worker_merge_confirm`, the per-task squash merge uses the card title verbatim as the
commit subject (a safety-net, `toConventionalSubject`, coerces only the *type* if the title slips —
never the scope, since the helper can't know it). `merge_batch` lands several candidate branches at once.
Naively reusing the solo rule there would mean every batched commit subject gets silently rewritten to
its own card's title, discarding whatever the worker actually authored on the branch.

## Decision

`merge_batch` (`git/batch-merge.ts`) never rewrites or coerces anything — it lands each candidate
branch's own commit subjects **verbatim**; `toConventionalSubject` never runs on that path, so the card
title never becomes the commit subject there. `worker_merge`'s review step surfaces `ownTipSubject` /
`ownTipSubjectConventional` (the branch's uncoerced tip subject, and whether it's already conventional) so
a manager can title-check what a batch would actually commit before routing a worker into one instead of
a solo confirm.

## Do not

- Do not assume a card title becomes the commit subject for a `merge_batch` landing — it does only for a
  solo `worker_merge_confirm`.
- Do not run `toConventionalSubject`, or any subject coercion, on the `merge_batch` path.
- Do not route a worker with a non-conventional tip subject into a batch without first checking
  `ownTipSubjectConventional`.

## Consequences

- Easier: a worker's own authored commit message survives a batched landing unmangled.
- Harder: a worker's commit subject must already be conventional + correctly scoped *on the branch
  itself* before going into a batch — there is no merge-time safety net for that path, unlike the solo
  path's `toConventionalSubject` coercion.
- A manager choosing solo-vs-batch for a given worker now has a real signal (`ownTipSubjectConventional`)
  to decide with, rather than discovering the mismatch on main after the fact.

## Evidence

- READ-IN-SOURCE: `CLAUDE.md`'s "Conventions" section (current `main`, read via this worktree's checkout)
  states this distinction verbatim, citing card `a32533a1`.
- READ-IN-SOURCE: `packages/daemon/src/git/batch-merge.ts` (read directly, not edited, in this worktree,
  2026-09-09) still states the related owner directive (card `6801c0a1`) to land each branch's own commits
  individually rather than collapsing a batch into one commit per branch — consistent with, though
  distinct from, this record's own subject-verbatim decision.
- `ownTipSubject`/`ownTipSubjectConventional` and `toConventionalSubject` live in
  `packages/daemon/src/sessions/service.ts`, `packages/daemon/src/mcp/orchestration.ts`, and
  `packages/daemon/src/git/worktrees.ts` — all three held by concurrent workers (cards `bed49000`,
  `40f4cae9`, `8ea85329`) for the duration of the `92cfc09e` task, so that worker reported no inline
  source anchor as a remainder.
- OBSERVED (card `f42c545f`, 2026-09-09): the batch-landing worktree fence had since cleared, and
  `packages/daemon/src/git/batch-merge.ts` (the per-commit cherry-pick loop, where every commit lands
  with `--no-commit` and its message passes through unmodified) was unheld. A `// @decision a32533a1`
  anchor was added there.
