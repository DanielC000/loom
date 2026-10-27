# 75199847 — batch commit messages ride a temp file (`-F`), never argv (`-m`); an empty predicted non-tip message gets a named pre-commit drop

## Background

From 458028ae's own Code Review (session `e8f1f410`): two pre-existing shapes in
`landBranchCommitsIndividually` (`git/batch-merge.ts`), each measured and each failing SAFE (the candidate
is dropped, never `headMoved`) but with a poor or confusing reason.

1. Both real commit calls — the plain `git commit` and the `Loom-Worker-Base`/`Loom-Worker-PathSet`
   `--amend` — passed the worker's own message via `-m <string>` argv. On Windows, `child_process.spawn`
   (what `killableCanonicalRaw`/simple-git use under the hood) still assembles one flat `CreateProcess`
   command line regardless of the argv-array call shape — **measured**: a 40,000-char `-m` value spawned via
   `spawnSync` with an argv array (no shell) throws `ENAMETOOLONG` before git ever runs. The candidate then
   fell through to the generic commit-failed catch (`` `${branch}: commit failed while landing commit
   ${sha}: ${e.message}` ``), which is accurate but gives no hint that the real cause is message SIZE, not a
   git-level rejection.
2. A NON-TIP commit (`isLast === false`, so `expectedPlainTrailers: {}`) whose message collapses to nothing
   after cleanup is predicted **ok** by the pre-existing 458028ae check: `verifyLoomTrailersExactAndReadable`
   with `{}` expected has nothing to check, so it reports `{ok:true}` **even for an empty predicted
   message** — there's no reserved-namespace line to get wrong when none is expected. Real git then refuses
   with `"Aborting commit due to empty commit message."` (no `--allow-empty-message` flag is ever passed),
   landing in the SAME generic commit-failed catch as (1) — reachable because the cherry-pick's own
   empty-STAGE probe (card `2eb78eb2`) is orthogonal to this: a commit can carry real staged file changes
   with an empty MESSAGE.

## The fix

### Shape 1 — `-F <tempfile>`, never `-m`

Both commit calls (the plain commit and the `--amend`) now write their message to a fresh,
`fs.promises.mkdtemp`'d directory under `os.tmpdir()` — never the canonical repo's working tree or the
ephemeral batch worktree, both worker-writable trees a commit-message file has no business sitting in — and
pass `-F <path>` instead of `-m <string>`. The message never rides the child's command line at all, so it
can never hit the Windows argv ceiling (`writeBatchCommitMessageFile`/`cleanupBatchCommitMessageFile`,
`git/batch-merge.ts`).

**Byte-identity matrix, measured directly against real git (2.47.0.windows.2), landed `%B` read via `git
log -1 --format=%B` unless noted** — `-m` vs `-F --cleanup=whitespace`, identical in every case: an
ordinary message, a CRLF body, a trailer-block body, a `#`-prefixed subject (both the repo's own default
cleanup AND an ambient `commit.cleanup=strip` — the `--cleanup=whitespace` flag correctly overrides the
config either way, same load-bearing pin 458028ae already established), a non-ASCII body (`Ünïcödé — ✓` plus
an emoji), a body with trailing whitespace per line, and a 20,000-char body (the largest size `-m` can still
run at, to keep the `-m`-vs-`-F` comparison meaningful). `fs.promises.writeFile(file, message, "utf8")`
writes exact UTF-8 bytes — no BOM is ever prepended, no newline translation is ever applied (that mangling
is a text-mode/editor behavior, not something Node's `fs` does on any platform) — confirmed by the matrix
above landing byte-for-byte identical to the in-memory string either way.

**The 40,000-char case** (well over the Windows ceiling) could only be run via `-F` — `-m` reproduces the
same `ENAMETOOLONG` documented above. Read via `git cat-file -p <sha>` (never `git log --format=%B` — see
"Do not" below), the landed message is byte-identical to the source, confirming `-F` removes the ceiling
entirely rather than merely raising it. **This RED control is Windows-only** (Code Review round 2): the
`ENAMETOOLONG` this reproduces is the Windows `CreateProcess` argv ceiling specifically — Linux's own
per-argument limit (`MAX_ARG_STRLEN`, ~128KiB) sits well above the 40,000-char message this test uses, so
the SAME scenario would not reproduce the pre-fix failure on a Linux CI runner; it still exercises the
fixed `-F` code path there (and still proves byte-identity), just without a RED precondition on that OS.

**`i18n.commitEncoding` does not matter for either path.** Measured with `-c i18n.commitEncoding=ISO-8859-1`
and a non-ASCII message: both `-m` and `-F` produce the identical `encoding ISO-8859-1` commit header and
identical message bytes. Git tags the object with that header as metadata; it never transcodes the message
bytes either way, so there is nothing for the `-F` switch to disturb here.

A write failure (the `mkdtemp` or the `writeFile`) for the **plain** commit drops the candidate with a
named reason — the same remedy every other pre-commit drop in this function already uses
(`rollback()` + `fail()`, no `headMoved`). A write failure for the **amend** is instead treated exactly like
the amend command itself failing (soft-degrade: `pathSetStamped = false`, warned, never a candidate drop) —
the tip commit above already landed and stays valid without the best-effort `Loom-Worker-Base`/
`Loom-Worker-PathSet` follow-up stamp; dropping the whole candidate over a failure to write a FOLLOW-UP
trailer would be a strictly worse outcome than the pre-existing "amend itself failed" case this already
tolerates.

Cleanup of each temp dir is **fired without being awaited** (`cleanupBatchCommitMessageFile`) — a failure is
logged, never thrown or retried. This runs once per commit inside a hot per-branch landing loop, so cleanup
must never block it even in the ORDINARY case. **Corrected (Code Review round 2, S3):** an earlier draft of
this record motivated the non-blocking design by claiming a transiently-locked file (e.g. a real-time
antivirus scan on Windows) "hangs" — that is WRONG. A locked file normally fails FAST with `EBUSY`/`EPERM`
rather than hanging; this is not primarily a hang-avoidance mechanism, it simply never blocks on removal,
full stop. **Accepted residual:** an `rm` call that genuinely never settles (not merely a fast-failing
lock) has no bound on how long it stays outstanding once fired-and-forgotten, so under sustained fire a
batch could in principle accumulate multiple still-pending `rm` promises. This is bounded in practice,
not eliminated: each one targets a single small directory+file created for exactly ONE commit, never
accumulating without limit the way a leaked worktree removal could (the actual P0 class
`docs/decisions/bd9fc808-killable-child-process-removal-replaces-threadpool-rm.md` describes). This is the
small, self-created, single-file scratch-dir case `capabilities/github-binary.ts`'s own
`fs.rmSync(dir, {force:true})` precedent already covers — read that record before reusing this
fire-and-forget pattern for anything bigger than a single small file.

**Round 2 also closed two smaller gaps, both in `writeBatchCommitMessageFile` itself:**
- **S1 (leak on write failure):** if `mkdtemp` succeeded but the subsequent `writeFile` threw, the orphaned
  directory was never cleaned up. Fixed: a write failure now calls `cleanupBatchCommitMessageFile` on the
  just-created dir before re-throwing, so the existing write-failure handling at each call site (drop for
  the plain commit, soft-degrade for the amend — see below) still runs unchanged, with no leak either way.
- **S2 (relative `TEMP`/`TMP`/`TMPDIR` breaks every batch commit):** `os.tmpdir()` returns whatever those
  env vars hold VERBATIM. If one is set to a RELATIVE path, `fs.promises.mkdtemp` resolved it against THIS
  PROCESS's (the daemon's) own cwd — but the git CHILD reading `-F <path>` is spawned with the batch
  worktree as its cwd, and resolves that same relative path against a DIFFERENT directory. Measured: `git
  commit -F <relative-path-that-resolved-elsewhere>` fails with `fatal: could not read log file` — the two
  processes silently disagree on what the path means, so EVERY batch commit breaks, not just one dropped
  candidate. Fixed by resolving `os.tmpdir()` to an absolute path (`path.resolve(os.tmpdir())`) before ever
  joining a prefix to it.

### Shape 2 — an empty predicted message is a named, explicit pre-commit drop

`predictGitCleanupWhitespace(finalMessage)` is now checked for `=== ""` **before**
`verifyLoomTrailersExactAndReadable` ever runs. An empty result drops the candidate with a reason that
names the real cause (`` `...would be empty after git's own commit cleanup (predicted) — git would abort
this commit outright...` ``) — distinct from both the 458028ae `forged`/`displaced`/`unreadable` wording and
the generic commit-failed fallback (which, confusingly, also contains the word "empty" — git's own refusal
text is `"Aborting commit due to empty commit message"` — see "Do not" below for why a bare `/empty/i`
test cannot tell these apart).

This check runs regardless of `isLast`. For the **tip** (`isLast === true`), `finalMessage` always carries
the appended `Loom-Worker-Branch: <branch>` paragraph, which can never cleanup-collapse to nothing — so
`predictedMessage === ""` is unreachable there in practice; the check is written generically rather than
gated on `!isLast` because there is no case where gating it would change behavior, and an un-gated check is
simpler to read than one with a dead branch.

## Round 2 (Code Review) — existing test MOCKS keyed on commit-message argv went silently dead

**B1 (BLOCKING):** three pre-existing tests recognized WHICH candidate a batch `commit`/`commit --amend`
call was landing by pattern-matching the worker's own message text somewhere in `args` — the exact same
desync class `test/_git-argv.mjs`'s own header already documents for a DIFFERENT argv position (card
`7557fac7`'s `-c`-pair shift). Switching the message from `-m <text>` to `-F <tempfile>` moved it OFF argv
entirely, so these stubs silently stopped matching: the test kept running and reporting a result, just not
testing what it claimed to —
- `merge-batch-all-dropped-gate-status.mjs` (section 3's `rollbackUnverifiedGitFactory`) — 8 assertions
  failed once the simulated failure it depends on stopped firing.
- `batch-merge-rollback-abort.mjs` ((A)'s `throwingResetGitFactory` and (C)'s `makeProbeThrowsGitFactory`) —
  2 failures plus a `TypeError` reading `assembled.dropped[0].reason` off an empty array (nothing was
  dropped once the injected failure stopped firing).
- `batch-merge-robustness-redundancy.mjs` ((11b)'s `forcedRejectGitFactory`) — this one did NOT fail; its
  own assertions happened to still read as true by COINCIDENCE (the real empty-stage probe this scenario
  exists to exercise caught the redundant commit before the now-dead mock would ever have fired), making
  the scenario **vacuous** rather than red. Proved by disabling the production empty-stage-probe check
  entirely and re-running: pre-fix this scenario's own discriminating assertions went RED (3 failures,
  exactly as designed); post-`-F`, with the mock silently dead, the SAME disabled-probe run stayed GREEN —
  the scenario could no longer tell the probe apart from a probe that had been deleted.

**Fix:** `test/_git-argv.mjs` gained `commitMessageArgvText(args)` — resolves the message text regardless of
whether it rode `-m <text>` (the literal next argv element) or `-F <path>` (read synchronously from disk).
All three files' stubs now call this instead of scanning `args` directly, keeping each one's original
message-keyed intent byte-for-byte. Verified live: both previously-failing files now pass in full, and
(11b) goes back to its original 3-failure RED under the same disabled-probe control (then restored, probe
re-confirmed green).

**Broad sweep (not just the reviewer's own pattern):** grepped the whole `packages/daemon/test/` corpus for
`"-m"`/`args.some`/`args.find`/`args.join`/`args.includes(<variable>)`/direct `-m` index extraction — every
other hit was either an unrelated domain (branch-name matching for delete calls, `--grep=` log searches,
cat-file validation calls, build/service/capability argv, console-output capture wrappers) or a literal
`-m` passed to a REAL (non-stubbed) git call, never a stub keyed on BATCH commit message CONTENT. No further
affected site was found beyond the three above.

## Do not

- Do not pass a commit message via `-m` on either batch commit call — `-F <tempfile>` only. See the
  byte-identity matrix above before assuming any divergence between the two forms for THIS caller; re-run it
  (or a subset) before trusting a future change to this code against a new git version.
- Do not read a landed message via `git log --format=%B` when comparing it byte-for-byte against a known
  source string — that pretty-print format appends its OWN extra trailing newline for display, which is not
  part of the stored object (measured: a message ending in exactly one `\n` reads back from `%B` as TWO).
  Use `git cat-file -p <sha>` and slice off the header (up to the first blank-line separator) instead, or
  tolerate exactly one extra trailing newline if you must use `%B`.
- Do not use a bare `/empty/i` (or similar single-word) regex to prove the NEW named drop fired, in a test
  or anywhere else — git's own generic refusal text ("Aborting commit due to **empty** commit message")
  contains that word too, so such a test passes vacuously even against the OLD, pre-fix generic
  commit-failed fallback (measured directly: this exact mistake gave a false PASS before this card's own
  negative control caught it). Match a phrase unique to the new message instead.
- Do not treat a write failure for the amend's temp file the same way as the plain commit's — the plain
  commit's write failure drops the candidate (nothing has landed yet); the amend's write failure soft-degrades
  (the tip commit already landed and is valid without the Base/PathSet trailers), matching how an actual
  amend command failure was ALREADY handled before this card. Changing one without the other changes landing
  semantics that were deliberately preserved.
- Do not await `cleanupBatchCommitMessageFile`'s removal, and do not add a retry loop to it — see
  `docs/decisions/bd9fc808-killable-child-process-removal-replaces-threadpool-rm.md` for why a retry loop
  over a possibly-hung removal is itself a known P0 class of bug (a different code path, same hazard shape).
  This cleanup is deliberately fire-and-forget, logged on failure, never more.
- Do not assume `os.tmpdir()` needs a new dependency-injection seam to fault-inject a write failure in a
  test — it already reads `TEMP`/`TMP` (Windows) / `TMPDIR` (POSIX) live, on every call, with no caching;
  overriding those env vars to a non-existent path for the duration of one call is a real, already-existing
  seam. Restore them in a `finally` immediately after the call — they are process-global, so a test that
  pairs a "good" candidate with the induced failure in the SAME batch call breaks the good candidate's own
  write too; isolate the faulted candidate into its own single-candidate batch call instead.
- Do not join an unresolved `os.tmpdir()` to a prefix for ANY temp dir this code creates — always
  `path.resolve(os.tmpdir())` first. A relative `TEMP`/`TMP`/`TMPDIR` breaks every batch commit, not just
  one candidate (S2 above); there is no partial-failure mode to fall back on here.
- Do not write a NEW test stub that matches a batch commit's message by scanning `args` directly
  (`args.some(x => x.includes(...))`, `.startsWith(...)`, or similar) — call `commitMessageArgvText(args)`
  (`test/_git-argv.mjs`) instead, which resolves the message regardless of `-m`/`-F`. Grep that file's own
  name before adding a new one, per its header doc.
- Do not claim a locked file "hangs" as the reason `cleanupBatchCommitMessageFile` is fire-and-forget — it
  normally fails FAST (`EBUSY`/`EPERM`). The real justification is simpler: cleanup must never block the
  hot per-commit loop, full stop, regardless of how the removal fails.

## Follow-up

Card `697be64a` extended this card's `-F`-via-tempfile mechanism to `GitWriter.commit()` (the human REST /
Platform Lead / operator git-commit path), which had the same unbounded-`-m` defect. See
`docs/decisions/697be64a-gitwriter-commit-via-temp-file.md` for that card's own record — including the
helper rename/move (`writeBatchCommitMessageFile`/`cleanupBatchCommitMessageFile` → exported
`writeCommitMessageFile`/`cleanupCommitMessageFile` in `writer.ts`, with a new `prefix` param) and a named,
unfixed finding about `mergeBranchLocked`'s solo-squash path.
