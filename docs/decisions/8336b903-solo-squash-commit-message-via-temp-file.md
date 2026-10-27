# 8336b903 — the solo squash commit's message rides `-F` via a temp file, never unbounded `-m`

## Background

Found by `697be64a`'s own Code Review (reviewer `4f3774b0`, 2026-10-27), named but deliberately not fixed
there: `mergeBranchLocked`'s solo squash commit (`git/worktrees.ts`) still passed its message via
`-m message`, the same Windows `CreateProcess` argv ceiling (~32766 chars, `ENAMETOOLONG`) `75199847`
removed from the batch-landing path and `697be64a` removed from `GitWriter.commit()`.

Unlike those two callers, the squash's message BODY is already bounded (`WORKER_COMMIT_LOG_MAX_ENTRIES`/
`WORKER_COMMIT_LOG_MAX_CHARS` — 20 entries / 2000 chars — plus a few hundred bytes of fixed trailers), but
its SUBJECT is the board card's `title` verbatim, and `title` carries no length bound anywhere:
`tasks_create`'s `inputSchema` (`mcp/server.ts`) declares `title: z.string()` with no `.max()`, and no
length check exists in `createProjectTaskChecked`/`updateProjectTask`/`checkTitleHtmlEntities`/
`checkTitleConventionalType` (`tasks/title-guard.ts`) either. A pathologically long title can still make
the squash commit exceed the Windows argv ceiling, reproducing `ENAMETOOLONG` after the whole merge gate
has already run.

## Investigation first — the measured board, and why a title-length cap (lever a) was ruled out

Per the card's own "INVESTIGATE FIRST" instruction, before any code changed: the current MAX title length
measured across all 4,607 board cards on this project (open + done, as of 2026-10-27) is 264 characters —
no live pressure on the ceiling today. Every title writer funnels into exactly two families: the two
agent-facing, GUARDED functions (`createProjectTaskChecked`/`updateProjectTask`, reached only by
`tasks_create`/`tasks_update` and the Platform Lead's `project_task_create`), and a large set of UNGUARDED
direct `db.insertTask`/`updateTask` callers (companion `board_create`, the human REST task routes, setup
seeding, and roughly a dozen internal boarding call sites in `sessions/service.ts`) — this bypass is
INTENTIONAL, per `docs/decisions/5b221bf2-createprojecttaskchecked-is-the-only-legitimate-agent-facing-create-path.md`:
every automated boarding path needs a delivery guarantee a refusal would break.

**Ruling (manager-approved): lever (b) — move the squash to `-F` — only.** A title-length cap (lever a),
if scoped only to the two agent-facing guard functions (the natural place, mirroring the existing
`checkTitleHtmlEntities`/`checkTitleConventionalType` guards), would NOT close the hazard class: every
unguarded writer above stays free to produce an unbounded title. Extending a cap down into `db.ts`'s
`insertTask`/`updateTask` (the one truly universal chokepoint) would need a non-rejecting TRUNCATE design,
since `docs/decisions/e7dabf95-control-chars-at-task-and-agent-write-boundaries.md` already ruled out a
REJECT posture there for the same structural reason (void return, ~20+ non-error-checking callers) for the
control-char guard — a materially bigger, separate design than this card's scope. `-F` closes the class
for every title regardless of which writer produced it, with no architecture change, so it was implemented
alone; a title-length cap was NOT carded as a follow-up (264 measured chars shows no real pressure).

## The fix — reuse, not re-derivation

`mergeBranchLocked`'s squash commit call now writes `message` to a temp file via the shared
`writeCommitMessageFile(message, "loom-squash-commit-")` (`git/writer.ts`, the same helper `75199847`
and `697be64a` already established) and passes `-F <path>` instead of `-m <message>`. Cleanup
(`cleanupCommitMessageFile`) runs in a `finally` wrapping BOTH the commit-attempt try/catch and the
post-commit HEAD-verification try/catch — so it fires on every exit from that point on: a successful
commit, every caught commit-failure branch (quarantine, unconfirmed kill, HEAD-moved recovery, ordinary
commit failure), and an uncaught `killableCanonicalRaw` timeout/kill.

### Ordering: the write happens AFTER `git merge --squash` has already staged the canonical index

`message`'s final value depends on `preCommitHead`/`stagedPathSetDigest`, captured just before the commit
call under a LOAD-BEARING ADJACENCY rule (card `c862f14c`: no git call may land between that capture and
the commit). By the time `message` is final, `git merge --squash` (at this function's entry) has already
staged the canonical index — so unlike `GitWriter.commit()` (whose caller-supplied message is final before
any canonical mutation), a write failure here is a POST-STAGE refusal. It is handled exactly like every
other post-stage refusal in this function: `const cleanup = await resetOrSkip("commit-message-write-failure
cleanup")`, returning `{ok:false, reason, ...quarantined/transient}` — never a silent fallback to `-m`. The
write itself is a filesystem operation (`fs.promises.mkdtemp`/`writeFile`), not a git call, so inserting it
here does not violate the adjacency rule above.

### The "always exactly one trailing LF" invariant — structurally different from `GitWriter.commit()`'s fix

`697be64a` found a `commit.cleanup=verbatim` trap: `-m`'s argv value is ALWAYS line-completed by git itself
(a missing trailing newline appended) regardless of cleanup mode; a bare `-F <file>` has no such step, so
under `verbatim` a file lacking a trailing newline lands without one. `GitWriter.commit()` fixed this by
force-appending `` `${cleanedMessage.trim()}\n` `` to its temp-file write.

`mergeBranchLocked`'s `message` needs no equivalent force-append: it is built purely by template-literal
concatenation (never `.trim()`-ed), and in EVERY construction branch — whether or not the pathset capture
succeeds — ends with exactly one trailing `\n` by construction (confirmed by reading every assignment to
`message` in the function). `test/merge-squash-commit-tempfile.mjs` section (2) pins this empirically on
the real `mergeBranch` path under both `commit.cleanup=verbatim` and `=strip`, rather than relying on
static reasoning alone. Section (3) is a labeled control proving WHY this matters: a squash-shaped message
with its trailing LF manually stripped (a shape `mergeBranch` cannot itself produce, per (2)) DOES diverge
between `-m` and `-F` under `verbatim` — the same divergence class `697be64a` measured for
`GitWriter.commit()` before its fix — documenting the hazard this invariant protects against, not a defect
in current behavior.

### Consumers that re-read the landed message are unaffected

`findLandedSquashCommit` (and the merged-commit-map scan) and `readLandedTipTrailer` read via
`git log --format=%B` (pretty-print — display-only, adds its own extra trailing newline on top of the
stored object, per `75199847`'s "Do not"); `verifyCommitParentAndTree`/`verifyLandedAsOwnCommit` (inline in
`mergeBranchLocked`) read via `git cat-file -p` instead. Both read the COMMIT OBJECT's stored bytes, never
the argv shape used to create it — so as long as the landed object is byte-identical between `-m` and `-F`
(proven by the matrix in `test/merge-squash-commit-tempfile.mjs` section (3), scoped to this caller's own
squash-shaped message), none of these consumers needed any code change. Section (5) of that test
independently confirms `verifyLandedAsOwnCommit`'s own parent+tree+trailer check (`landedVerify:
"verified"`, no `trailerAdvisory`) and `parseLoomTrailerBlock` both still pass cleanly on a `-F`-landed
commit, re-reading the trailers from outside the function rather than only trusting its self-report.

### Mock/argv sweep

Swept the 119 `.mjs` test files exercising `mergeBranchLocked`/`worker_merge_confirm` for a stub
pattern-matching the solo squash's own `-m` message CONTENT (the `75199847` B1 lesson). Found none. The two
solo-relevant interceptors (`merge-quarantine-recheck.mjs` scenarios 3 and 4) match on subcommand SHAPE
(`args.includes("commit") && !args.includes("--amend")`, and `args[0]==="merge" && args[1]==="--squash"`),
never on message content or a hardcoded argv index — both unaffected by the `-m`-to-`-F` swap.
`test/_git-argv.mjs`'s `commitMessageArgvText(args)` already resolves a message regardless of `-m`/`-F` for
any future stub that needs to match by content.

## RED/GREEN proof

`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/worktrees.ts --test
packages/daemon/test/merge-squash-commit-tempfile.mjs` — snapshots the current (fixed) `worktrees.ts`,
temporarily replaces it with the pre-fix `HEAD` version (still carrying `-m`), confirms the test goes RED,
restores the fix, and confirms GREEN. See the test's own run log for the exact failure shape pre-fix
(section (1) fails with `ENAMETOOLONG` or an equivalent spawn failure on Windows).

## Do not

- Do not re-derive a second `-F`-via-tempfile helper for the solo squash path — reuse
  `writeCommitMessageFile`/`cleanupCommitMessageFile` (`git/writer.ts`), passing `"loom-squash-commit-"`
  as the prefix.
- Do not add an explicit `${message.trim()}\n`-style force-append to the squash's temp-file write — unlike
  `GitWriter.commit()`'s caller-supplied message, `message` here is never `.trim()`-ed and already ends in
  exactly one trailing LF in every construction branch; forcing it again is redundant, and if a future
  refactor of the message-building code ever breaks that invariant, `test/merge-squash-commit-tempfile.mjs`
  section (2) will catch it — fix the invariant there, don't paper over it with a second force-append.
- Do not move the commit-message write to BEFORE `git merge --squash` — `message`'s final value depends on
  the post-squash pathset capture (`preCommitHead`/`stagedPathSetDigest`), itself bound by a load-bearing
  adjacency rule (card `c862f14c`) that forbids any git call between that capture and the commit. A write
  failure here is therefore a POST-STAGE refusal by construction and must go through `resetOrSkip`, never a
  bare early return.
- Do not add a title-length cap (lever a) to `createProjectTaskChecked`/`updateProjectTask` as a substitute
  for this fix, or assume it closes the same class — it does not; see the "Investigation first" section
  above for the full reasoning. A future title-length cap (if ever carded) is independent hygiene, not a
  replacement for `-F`.
- Do not read `git log --format=%B` when comparing a landed squash message byte-for-byte against a known
  source string — use `git cat-file -p <sha>` instead (same "Do not" as `75199847`/`697be64a`).
- Do not write a new stub matching the solo squash's commit-message argv by scanning `args` directly for
  the message text — call `commitMessageArgvText(args)` (`test/_git-argv.mjs`), which resolves the message
  regardless of `-m`/`-F`.

Related records: `docs/decisions/75199847-batch-commit-message-via-temp-file-and-named-empty-drop.md`,
`docs/decisions/697be64a-gitwriter-commit-via-temp-file.md`.
