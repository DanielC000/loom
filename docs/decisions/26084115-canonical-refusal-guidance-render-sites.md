# 26084115 — render every merge-path `CanonicalGitRefusal` through `canonicalFailureMessage`, never a bare `describeGitFailure(e).text`/`.message`

Several merge-path catch sites rendered a canonical-git refusal via `describeGitFailure(e).text` (capped
at 400 chars) or a bare `(e as Error).message`/`String(e)` instead of `canonicalFailureMessage`. A
`pinMismatch` refusal's human guidance (verify on disk; the re-pin route; escalate to the Platform Lead)
and a `commondirRedirect` refusal's escalation wording were silently cut off on a realistically long (Loom
worktree-shaped) path, or simply never present at all for a `redirect`/`boundRepoIsWorktree` kind — those
raw reasons (`git/bounded.ts` ~1660-1745) don't carry the guidance sentence; only `pinMismatch`'s raw
reason does, and only up to the 400-char cap.

Card `26084115` fixed the `describeGitFailure(` consumers that render a refusal's whole `.text`: three
identity-fallback-probe catches (`landBranchCommitsIndividually` in `git/batch-merge.ts`;
`mergeMainIntoWorktree`/`mergeBranchLocked` in `git/worktrees.ts`) and the batch rollback render where
`resetError` is itself a `CanonicalGitRefusal`.

Follow-up card `a3a632fa` (reviewer `661bba66`) found a SECOND render pattern of the same defect — raw
`${(e as Error).message}` on six pre-mutation setup-read catches in `landBranchCommitsIndividually`
(resolving the branch tip, reading the batch worktree's HEAD, computing the merge-base, enumerating the
commit/merge-commit ranges) and the analogous `mergeMainIntoWorktree` mainline-tip read in
`git/worktrees.ts` — and two wording defects: a literal doubled "refused: refused" at all three
identity-probe catches once routed through `canonicalFailureMessage` (whose own refusal branches already
open with "refused,"/"refusing,"), and a rollback-clause ambiguity where a bare "nothing changed" didn't
say it referred to the `reset --hard` specifically.

## Do not

- Do not render a merge-path catch's error as `describeGitFailure(e).text`, `(e as Error).message`, or
  `String(e)` without first checking whether `e` can be a `CanonicalGitRefusal` — route through
  `canonicalFailureMessage(describeGitFailure(e), fallbackText)` instead, so a refusal's human guidance
  (escalation wording, the re-pin route, "do not retry") survives.
- Do not prefix `canonicalFailureMessage`'s own output with a literal "<label> refused: " — every one of
  its refusal branches already opens with "refused,"/"refusing," (the one exception, `boundRepoIsWorktree`
  and `unpinned`, still opens with "refused,"), so a naive prefix produces a literal doubled
  "refused: refused". Drop the word "refused" from the prefix (e.g. "<label>: ${canonicalFailureMessage(...)}"),
  or branch on `d.refusal` to choose a non-doubling wording when the prefix itself needs "refused:" for the
  non-refusal fallback case (see the rollback clause's own composition in `batch-merge.ts`).
- Do not treat the per-commit cherry-pick loop's own later raw-message catches (after the identity probe,
  once mutation has already started — e.g. the staged-diff/original-message/write-tree/post-commit
  verify probes in `landBranchCommitsIndividually`, or the analogous post-mutation probes inside
  `mergeMainIntoWorktree`'s kill-timeout recovery path and `mergeBranchLocked`'s own reset/squash
  machinery) as already covered by card `26084115`/`a3a632fa` — they are a structurally larger, separately
  judged class (most already correctly gate on `describeGitFailure(e).refusal` before falling through to
  a raw render, or are deliberately narrow `treeDeathUnconfirmed`/`RepoQuarantinedError` branches that can
  never carry a `CanonicalGitRefusal` in the first place) and were deliberately left out of both cards'
  scope — re-derive the sweep yourself (by reading each catch, never a filename/pattern grep) before
  assuming either card already closed them.

## RED/GREEN proof

`packages/daemon/test/canonical-refusal-guidance-on-every-surface.mjs` proves the fix end to end through
real production call sites against real git repos/worktrees. Negative-control (card `616e5ec2`'s own
tool — never `git show HEAD:`, which re-derives a moving target against this file's own non-tracked
state):

```
pnpm --filter @loom/daemon negative-control \
  --file packages/daemon/src/git/batch-merge.ts --file packages/daemon/src/git/worktrees.ts \
  --test packages/daemon/test/canonical-refusal-guidance-on-every-surface.mjs \
  --ref a4adc243
```

`a4adc243` is card `26084115`'s own commit base (`Loom-Worker-Base` on its landed squash, `e8fa2133`) —
the committed tip immediately BEFORE that fix landed, so diffing against it exercises the pre-fix
behavior. A prior version of this instruction said "default --ref HEAD" — false even at the time it was
written (the fix was already a committed change by then, not an uncommitted edit on top of HEAD); pin the
explicit sha above instead of trusting `--ref`'s default.
