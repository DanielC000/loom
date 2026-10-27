# 697be64a — `GitWriter.commit()` passes its message via a temp file (`-F`), never unbounded `-m`

## Background

Found by card `75199847`'s own Code Review (reviewer `4f3774b0`, 2026-10-27), out of that card's scope.
`GitWriter.commit()` (`git/writer.ts` — the human REST / Platform Lead / operator `git_commit` path) had
the SAME unbounded-`-m` defect that card already fixed for the batch-landing path
(`docs/decisions/75199847-batch-commit-message-via-temp-file-and-named-empty-drop.md`): it passed its
caller-supplied message via `-m cleanedMessage.trim()` with no length bound — the same Windows
`CreateProcess` argv ceiling (~32766 chars, ENAMETOOLONG), reachable from the human REST git-commit route,
the Platform Lead's `git_commit` tool, and the operator (codex-parity) `git_commit` tool — all three are
thin passthroughs to this one method.

## The fix — reuse, not re-derivation

`writeBatchCommitMessageFile`/`cleanupBatchCommitMessageFile` moved OUT of `batch-merge.ts` into
`writer.ts`, renamed `writeCommitMessageFile`/`cleanupCommitMessageFile` and exported, with one new
parameter: `prefix` — each caller keeps its own `mkdtemp` prefix (`"loom-batch-commit-"` for the batch
path, unchanged; `"loom-git-commit-"` for `GitWriter.commit()`) so a test that captures temp dirs by
prefix (`batch-merge-empty-tip-cleanup-drop.mjs`'s F4/F5) keeps matching after the extraction with zero
changes of its own. `batch-merge.ts` now imports both from `./writer.js` (it already imported
`nonInteractiveEnv`/`localNonInteractiveEnv`/`stripClaudeSessionTrailer` from there) instead of defining
local copies. Mechanics (mkdtemp under `path.resolve(os.tmpdir())`, exact UTF-8 write, post-mkdtemp
write-failure cleanup, fire-and-forget non-blocking removal) are byte-identical to the original —
verified by re-running `batch-merge-empty-tip-cleanup-drop.mjs` (57/57),
`batch-merge-robustness-redundancy.mjs` (39/39), `batch-merge-rollback-abort.mjs` (38/38), and
`merge-batch-all-dropped-gate-status.mjs` (26/26) — all pass unchanged after the move.

In `GitWriter.commit()`, the message is written to the temp file BEFORE `refuseIfOperationalHome()` and
before acquiring `withCanonicalIndexLock` — a write failure is a NAMED refusal (`"failed to write commit
message to a temp file: ..."`), never a fallback to `-m`, and costs nothing since no repo mutation has
happened yet. Cleanup is unconditional (`finally`), covering the success path, every `git add`/`git
commit` failure path, and the `homeRefusal` early-return.

## Cleanup mode: confirmed default, not `--cleanup=whitespace` — AND a required trailing-LF fix (Code Review)

Unlike the batch path (which pins `--cleanup=whitespace` explicitly), `GitWriter.commit()` passes NO
`--cleanup` flag at all. Per git's own documentation, the "default" cleanup mode resolves to `whitespace`
whenever a message rides `-m`/`-F` (i.e. not interactively edited) — the SAME mode the batch path pins
explicitly.

**Code Review (reproduced): the byte-identity claim as first written was WRONG in one case.** The temp
file was originally written as bare `cleanedMessage.trim()`, with no trailing newline forced on. `-m`'s
own argv value is ALWAYS line-completed by git itself (a missing trailing newline is appended)
REGARDLESS of cleanup mode — that line-completion happens while git reads the `-m` value into its
buffer, before cleanup ever runs. A bare `-F <file>` has no such step: under `commit.cleanup=whitespace`/
`strip`/`default`, the generic end-of-message handling papers over the difference, but under an AMBIENT
`commit.cleanup=verbatim` (repo, global, or system config) NOTHING is normalized, so a file lacking a
trailing newline landed WITHOUT one while `-m` always would have had one. The reviewer's own matrix: 13 of
143 cases differed, all under `verbatim` and nothing else. **Fix:** write `` `${cleanedMessage.trim()}\n`
`` — always exactly one trailing LF — to the temp file (`writer.ts`'s `commit()`). The reviewer measured
0/143 differences with that fix in place.

**Scope of the "byte-identical" claim, stated precisely:** `-m` and `-F` land byte-identical bodies
ONLY WITH this trailing-LF fix in place, under BOTH `commit.cleanup=verbatim` and `commit.cleanup=strip`
(the two modes `test/git-writer.mjs` section 12b exercises directly, each pinned explicitly in a
HERMETIC repo — HOME/USERPROFILE isolated to a scratch dir, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL`
pointed at a non-existent file, so no real ambient user/global/system config can leak in). 12b routes the
`-F` side through the REAL `GitWriter.commit()`, not a bare git call, and compares it against a `-m`
baseline given the SAME pre-processed bytes GitWriter itself writes (`` `${msg.trim()}\n` `` — matching
`cleanedMessage.trim()` + the fix, since none of the matrix messages carry a Claude-Session trailer) —
comparing against the UN-trimmed source message would wrongly fault the real fix for a difference
`.trim()` itself introduces identically on both sides. WITHOUT the fix, 12b's own RED proof below shows
the claim does NOT hold under `verbatim`. 12a separately proves a >32K-char message (well past the
Windows argv ceiling) lands byte-identical through the real `GitWriter.commit()` call via `-F`, read back
via `git cat-file -p` (never `git log --format=%B`, which appends its own extra trailing newline on
display — see `docs/decisions/75199847-*.md`'s own "Do not").

## RED/GREEN proof (corrected — the original narrative conflated three independent behaviors)

Each of the following is its OWN isolated, Edit-only revert — build, run `test/git-writer.mjs`, confirm
the predicted failures (and ONLY those), then restore and rebuild. **The original version of this record
incorrectly implied a single revert producing 7 failures across 12a/12c/12d together; that is wrong — a
revert of only the argv line reds 12a alone, and 12c/12d each need their OWN dedicated revert, since their
behavior does not depend on which flag carries the message.**

- **The trailing-LF fix** (revert `` `${cleanedMessage.trim()}\n`\ ``→ bare `cleanedMessage.trim()`):
  reds exactly the 5 `(12b verbatim/...)` byte-identity checks (CRLF body, non-ASCII body, a
  `#`-prefixed subject, a trailer block, no trailing newline) — every `(12b strip/...)` case, and every
  other section (12a/12c/12d/12e), stays green. Confirms this fix is both necessary and precisely scoped
  to the `verbatim` cleanup mode.
- **The `-F` argv swap** (revert the git-commit-call line back to `-m cleanedMessage.trim()`, leaving the
  temp-file write/cleanup machinery in place): reds EXACTLY 2 checks — both `(12a)` checks (the >32K
  message now hits ENAMETOOLONG, or — off Windows — lands but the body no longer round-trips the way the
  rest of the suite expects it to have via `-F`). `(12c)`/`(12d)`/`(12e)` stay green, since their own
  behavior (the write-failure refusal, and cleanup on two different return paths) is independent of which
  flag the git-commit call ultimately uses. **This RED is WINDOWS-ONLY** — Linux's own per-argument limit
  (`MAX_ARG_STRLEN`, ~128KiB) sits well above this 40,000-char message, so a pre-fix `-m` call would not
  reproduce `ENAMETOOLONG` there; the revert still produces a real failure off Windows too (the landed
  body no longer necessarily matches byte-for-byte, since `-m`'s own argv value takes a different path
  than the file `-F` would have read), just not via that specific OS error.
- **The write-failure refusal's naming** (revert the catch's returned error from `` `failed to write
  commit message to a temp file: ...` `` to a generic `gitError(e)`): reds EXACTLY 1 check — `(12c)`'s
  "a temp-file write failure is a NAMED refusal naming 'temp file'" — every other `(12c)` check (the
  write failure still fires, still returns `ok:false`, still never falls back to `-m`, and the
  write-failure-internal temp-dir cleanup — unrelated, pre-existing shared helper behavior — still runs)
  stays green, isolating exactly the NAMING guarantee this card adds.
- **The success-path cleanup** (revert by removing the `commit()` method's own `` `finally {
  cleanupCommitMessageFile(messageFile.dir); }` `` entirely): reds EXACTLY 1 check — `(12d)`'s "the
  commit-message temp dir is cleaned up after an ORDINARY successful commit too". `(12e)` (cleanup on the
  `refuseIfOperationalHome()` early return) stays green under this SAME revert, confirming it is backed
  by its OWN, separate, inline cleanup call — not the `finally` block this revert removes.

Each revert was restored and the build re-run to confirm the full suite returns to green (138/138) before
moving to the next.

## Mock/argv sweep (this card's own B1-style check)

Grepped `packages/daemon/test/` for any stub `gitFactory`/spawn mock keyed on `GitWriter.commit`'s own
commit-message argv content. Every `"-m"` occurrence found in a `GitWriter`/`git_commit`/REST-commit-route
test file is a REAL, unmocked `git commit -m ...` call used for FIXTURE SETUP (seeding a throwaway repo
before exercising the writer), never a stub pattern-matching this method's own call — `test/git-writer.mjs`
exercises `GitWriter.commit()` end-to-end against real git throughout and asserts on the landed content via
`git log`/`git cat-file`, not on argv shape. No site needed re-keying through `commitMessageArgvText`
(`test/_git-argv.mjs`) for this path.

## Named finding (card's own DoD item 6) — the solo squash is NOT fully safe from the same ceiling

The card asked to verify, not fix, whether the solo squash-merge commit (`mergeBranchLocked`,
`git/worktrees.ts`, the `killableCanonicalRaw(repoPath, ["commit", "-m", message], ...)` call) is bounded
below the Windows argv ceiling by `WORKER_COMMIT_LOG_MAX_ENTRIES`/`WORKER_COMMIT_LOG_MAX_CHARS` (20 entries
/ 2000 chars). That bound covers the commit BODY (`deriveWorkerCommitLogBody`'s bullet list) and the fixed
trailer lines (`Loom-Worker-Branch`/`Loom-Landed-Tip`/`Loom-Worker-Base`/`Loom-Worker-PathSet`, together a
few hundred characters) — comfortably under the ceiling on its own.

It does NOT cover the commit SUBJECT, which is the board card's `title` verbatim. `title` has no length
bound anywhere in the schema: `tasks_create`'s `inputSchema` (`mcp/server.ts`) declares `title: z.string()`
with no `.max()`, and no length check exists in `createProjectTaskChecked`/`checkTitleHtmlEntities`/
`checkTitleConventionalType` either (grepped `mcp/tasks.ts`/`db.ts` for a title-length guard — none found).
So a pathologically long task title (tens of thousands of characters — nothing in the write path refuses
one) would still make `mergeBranchLocked`'s squash commit exceed the Windows argv ceiling and reproduce the
same ENAMETOOLONG this card fixed for the batch and `GitWriter.commit()` paths — reported per the card's
own instruction, not fixed here (out of scope; `worktrees.ts`'s squash path is a separate, much larger
function with its own trust/verification machinery around the commit call, not a drop-in `-F` swap).

## Cleanup (Code Review item 3) and an added cleanup-path test (item 4)

A stale comment at `writer.ts`'s `commit()` still said `git commit -m <message> -- <paths>` after the
`-F` swap; corrected to name `-F <messageFile>`.

`test/git-writer.mjs` section 12e (Code Review item 4) additionally proves the commit-message temp dir is
cleaned up on the `refuseIfOperationalHome()` EARLY RETURN, not just the ordinary success (12d) and
write-failure (12c) paths. It forces that refusal via its own, LOOM_HOME-INDEPENDENT branch — an injected
`gitFactory` returning an empty git-resolved toplevel (`resolveOperationalHomeToplevelRefusal`'s
`!toplevel` arm, decision `f9360c84` round 2) — rather than needing to touch the real ambient `LOOM_HOME`
at all (the dedicated `git-writer-operational-home-guard.mjs` already proves the refusal mechanism itself
end-to-end against a real isolated `LOOM_HOME`; this test only proves this card's own cleanup fires on
that path).

## Do not

- Do not re-derive a second `-F`-via-tempfile helper for a new commit-message caller — reuse
  `writeCommitMessageFile`/`cleanupCommitMessageFile` (`git/writer.ts`), passing your own `prefix`.
- Do not write `cleanedMessage.trim()` bare to the `-F` temp file — always append exactly one trailing
  `\n` (`` `${cleanedMessage.trim()}\n` ``). Dropping it reopens the `commit.cleanup=verbatim` divergence
  this record's "Cleanup mode" section measured (13/143 cases) and reproduces cleanly via
  `test/git-writer.mjs` section 12b's own `verbatim` cases (see the RED/GREEN proof above).
- Do not assume `mergeBranchLocked`'s solo-squash commit (`git/worktrees.ts`) is safe from the Windows argv
  ceiling because its BODY is bounded by `WORKER_COMMIT_LOG_MAX_*` — its SUBJECT (the task title) is not
  length-bounded anywhere, so the squash path remains exposed until a follow-up card addresses it.
- Do not add an explicit `--cleanup=whitespace` to `GitWriter.commit()`'s git-commit call without re-running
  the byte-identity matrix (`test/git-writer.mjs` section 12b) first — the current byte-identity proof
  relies on git's own implicit default, not an explicit pin; adding one is harmless IF it still resolves to
  `whitespace`, but that must be re-verified, not assumed.
- Do not write a second commit-message-via-temp-file helper for the solo squash path either, if a future
  card closes the finding above — reuse the same `writeCommitMessageFile`/`cleanupCommitMessageFile`.
- Do not compare a `-m` baseline against the un-trimmed source message in a future extension of the 12b
  matrix — compare against `` `${msg.trim()}\n` ``, the exact bytes `GitWriter.commit()` itself writes;
  the mismatch this produces under `verbatim` (see "Cleanup mode" above) is an artifact of `.trim()`
  itself, not of the `-m`-vs-`-F` question the matrix exists to answer.

Full record (the original batch-landing fix this one extends): `docs/decisions/75199847-batch-commit-message-via-temp-file-and-named-empty-drop.md`.
