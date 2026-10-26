# abbda4f5 — option-shaped-ref hardening at `createWorktree`'s entry and the `log`/`rev-parse` sites

## Narrative

Phase 3 of the option-shaped-ref hardening, after `65b2b002`/`7eac6366`, from `7eac6366`'s own Code Review
(reviewer `df453f6a`). UNREACHABLE today — `createWorktree`'s `branch` is always
`loom/${taskKey(taskId)}` (12 hex, `TASK_KEY_SHAPE_RE`, never option-shaped by construction) and every
`base`/`ref` at the `log`/`rev-parse` sites is always the mainline ref or `"HEAD"`, never caller/trailer-
derived. Defense-in-depth against the bug CLASS (and, for (a), a FUTURE change in how `branch` is built).

**(a) `createWorktree`'s `worktree add <path> <branch>` call (no `-b`), run on EVERY cut.** MEASURED, two
commits on `master` plus `refs/heads/--detach` pinned to the OLDER one via `update-ref` (`git branch --
--detach` itself refuses the name): bare `worktree add <path> --detach` detaches at CURRENT HEAD —
`--detach` is consumed as the detach flag, `refs/heads/--detach` never consulted. `worktree add <path>
--end-of-options --detach` behaves DIFFERENTLY, not identically: `--end-of-options` DOES end option
parsing, so `--detach` resolves as a REVISION — since `refs/heads/--detach` exists, it resolves to THAT
ref's own (older) tip, not HEAD. It still never ATTACHES (the attach path needs a syntactically valid
branch name; `--detach` isn't one) — so the worktree still ends up detached, just at a caller-steerable
commit, never closing the vulnerability. Fixed via `unsafeBranchNameShapeReason` (`git/writer.ts`) on
`branch`, right after it's computed, before `worktreePath`/`branchExists` — one check covers every path.

**(b) `rev-parse <ref>` (`classifyAgainstLedger`).** MEASURED: `--end-of-options` ALONE (no `--verify`)
corrupts a well-formed ref's output — echoes itself back as a literal second line once not an option.
`--verify --end-of-options <ref>` is a true no-op for a well-formed ref and fails loud (exit 128) for an
option-shaped one. Fix: `["rev-parse", "--verify", "--end-of-options", ref]`.

**(b) `git log <base> ...`** (`findLandedSquashCommit`/`findIntroducingSquashCommit`/
`findAllLandedTrailerCommits`/`scanMergedCommitMap`, four identical-shape sites). MEASURED: placing
`--end-of-options` right after `"log"` (base's natural position, ahead of the real `-F`/`--grep`/
`--format`/`-n` flags that already follow it) swallows those flags as literal positionals too and breaks
the ordinary call. Fix: move `base` to the END of argv with `--end-of-options` immediately before it —
byte-identical for a well-formed base, loud failure for an option-shaped one.

## Call sites fixed (`git/worktrees.ts`, each anchored `@decision abbda4f5`)

`createWorktree`'s entry guard; `classifyAgainstLedger`'s `rev-parse`; the `log --grep` trailer scan in
`findLandedSquashCommit`/`findIntroducingSquashCommit`/`findAllLandedTrailerCommits`; `scanMergedCommitMap`'s
`log --format -n` scan.

## Test coverage (`packages/daemon/test/worktree-add-and-log-argv-injection.mjs`)

Section 0 measures each fix shape against real git directly — (0a) asserts the guarded `worktree add`
resolves `--detach` to `refs/heads/--detach`'s OWN (deliberately non-HEAD) tip, so it can't pass under the
wrong mechanism. Section A exercises the entry guard via a new `__setUnsafeBranchNameShapeReasonForTest`
seam (the real `branch` can never naturally trip it). Sections B/D/E call the `log`-site functions with
`base="--all"` against a repo holding a "rogue" commit on a non-branch ref (invisible to `master`, visible
to `--all`) — pre-fix each wrongly surfaces it as landed; post-fix each fails safe. Section F calls
`classifyAgainstLedger` via a new `classifyAgainstLedgerForTest` passthrough (no production path reaches
it independently of the now-fixed `log` call it shares `ref` with).

## Do not

- Do not add `--end-of-options` to `createWorktree`'s `worktree add` call itself — it changes WHICH
  detached commit an option-shaped `branch` lands on (resolving the name as a real ref when one exists),
  it does NOT make the call attach or refuse; `unsafeBranchNameShapeReason` validation at entry is the fix.
- Do not place `--end-of-options` right after `"rev-parse"`/`"log"` without handling what follows it —
  `rev-parse <ref>` alone needs `--verify` too (else a WELL-FORMED ref's own output is corrupted); `log
  <base> <more flags...>` needs `base` moved to the END, not its natural first position, or the later
  flags are swallowed too. Verify the actual argv shape per subcommand before reusing `7eac6366`'s recipe.
- Do not treat a passing regression test here as proving `createWorktree`'s fresh-cut (`-b branch`) path
  needed a fix — `-b`'s value is a required-argument slot, consumed literally regardless of shape (same
  already-safe class as `7eac6366`'s `--merged <value>`); the entry guard covers the `-b` and no-`-b`
  paths alike by running before either is chosen, so only the no-`-b` call was ever actually at risk.
- Do not widen this to `findIntroducingSquashCommit`'s/`findAllLandedTrailerCommits`'s OTHER git calls in
  the same functions (`merge-base`, `diff --name-only`) — those take already-resolved shas or a
  `refs/heads/`-qualified ref (see `56c10535`'s own "Do not" list for why a `refs/heads/`-prefixed token
  can never be option-shaped), not a bare `base`/`ref` positional.

## Consequences

Every call site above is now protected against an option-shaped branch/base/ref being re-entered into
git's own option parser (or, for `worktree add`, steering which commit it checks out), at zero cost to a
well-formed value — same bug-CLASS-defensive posture as `65b2b002`/`7eac6366`.

## Source

Worker dispatch under card `abbda4f5`. Every claim above was reproduced on real git 2.47.0 in throwaway
temp repos before any source edit; see `worktree-add-and-log-argv-injection.mjs` for the test coverage.
