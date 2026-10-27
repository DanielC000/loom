# 40424783 — freeze the `midSentenceAnchors` regression pin to the base-sha tree, not the live repo

RED ON MAIN, found by the dist-importer advisory after the ungated landing `2958d0c5` (card `4e987303`).
`node packages/daemon/test/comment-anchor-lint.mjs` exited `rc=1` on the check `card 0c474dda (b): every
OTHER non-test midSentenceAnchors site is unmoved (nothing else was touched)`.

## What actually happened

`2958d0c5` added two ordinary trailing same-line comment anchors to
`packages/daemon/src/git/merge-quarantine.ts` (lines 8876 and 9205, both `@decision 4e987303`,
e.g. `armed = bootWriteResult1; // @decision 4e987303 — thread the ADOPTED entry forward`). That is
*exactly* the shape card `0c474dda`'s own fix (`isMidSentenceAnchorLine`'s `/(?:\/\/|\/\*\*?)\s*$/`
exclusion) was written to stop flagging — a trailing comment opens its own comment and is never
mid-sentence, no matter what code precedes the `//` on the same line. So the CURRENT linter correctly
does not flag either site. The PRE-`0c474dda` linter (pinned at sha `a332cbcf`, loaded via
`loadCommentAnchorLintAt` and run against the *live* repo) has no such exclusion and still flags both as
mid-sentence. The regression-pin test asserted the non-test `midSentenceAnchors` diff between the two
linter versions is EXACTLY the 7 known false-positive sites from card `298a1390`'s own investigation —
these 2 new sites widened that diff to 9, and the equality check failed.

This is not a bug in `2958d0c5`'s comments and not a bug in the current linter — both are working
exactly as designed. The test's own premise was fragile: it diffs the two linter versions against the
*live* tree, which keeps growing new instances of the newly-excluded shape as ordinary code lands (a
trailing `// @decision <id> — ...` comment is a completely normal, encouraged style). Every such future
commit widens the apparent diff and reds this pin again, for no real regression.

Confirmed by computing the exact before/after key sets (`midSentenceAnchors`, non-test paths) both ways:
against the live tree, the diff was `KNOWN_REMOVED_SITES (7) ∪ {merge-quarantine.ts:8876, :9205}`, with
zero other sites moved in either direction.

## The fix

`materializeTreeAt(repoRoot, sha)` (in the test file, next to `loadCommentAnchorLintAt`) now extracts the
FULL repo tree as it existed at the base sha (`git archive <sha>` piped into `tar -x`, both via
`execFileSync`, no shell pipe) into a fresh temp dir. The `midSentenceAnchors`-specific non-test
comparison (the "7 known sites removed", "nothing else moved", db.ts/host.ts-specific, and
PresetPrompts-still-reported checks) now runs BOTH the pre-fix and current linter against that SAME
frozen tree, instead of the live one. Freezing the corpus means no future commit — however many more
legitimate trailing-comment anchors it adds anywhere in the repo — can touch this comparison again: the
tree it scans never changes.

Verified empirically (see this card's own worker session) that re-deriving the comparison against the
frozen `a332cbcf` tree reproduces exactly the 7 known sites with zero extra sites in either direction —
i.e. the frozen comparison is not weaker than the live one, just stable against drift.

## Do not

- Do not widen this fix to the OTHER checks in the same test block (`UNCHANGED_CHECKS`'s byte-identical
  loop, or the "gains test/tests/e2e items" loop). Measured directly: freezing `embeddedAnchors`'s
  non-test comparison to the `a332cbcf` tree is NOT byte-identical (unlike on the live tree) — an
  unrelated intervening commit between `a332cbcf` and `HEAD` fixed a real embeddedAnchors false-positive
  that the frozen tree still carries. Freezing those checks would resurrect an already-fixed discrepancy
  instead of curing one; only `midSentenceAnchors`'s own non-test comparison was mis-designed this way.
- Do not read a future red on this same check as automatically "just another legitimate trailing-comment
  anchor" — the frozen tree can no longer drift from new commits, so a red here again means a real
  regression (the fix's own exclusion logic changed, or `a332cbcf`'s pinned sha became unreachable in a
  shallow clone — already handled by `loadCommentAnchorLintAt`'s own skip path).
- Do not replace `materializeTreeAt`'s `git archive | tar -x` with a per-file `git show` loop — measured
  materializing the whole tree (~4300 tracked paths at this sha) via archive+tar takes ~4s total; a
  per-file `git show` subprocess spawn for each of the ~2500 source-extension files would cost far more
  wall-clock for the same result.
