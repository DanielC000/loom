# 62c4953a — detect a stale canonical `.git/index.lock` and refuse loudly; do not auto-remove

A 0-byte `.git/index.lock` was found in the canonical Loom repo, created at 07:53:44Z and never removed.
No git process was running when it was found (~4h20m later). Every landing in that window would have
failed. The next `worker_merge_confirm` was refused with a generic, buried message — "git merge --squash
failed (reset --hard (rawError cleanup) failed — canonical repo may have residue: fatal: Unable to create
'.git/index.lock': File exists" — with nothing having signalled the lock in the ~4h20m before that. A
human removed it by hand after confirming it was empty, stale, and no git process was alive.

Candidate culprits for how the lock was left behind: a canonical-repo git call during worktree add/prune/
remove, or a `killableCanonicalRaw`/`spawnCanonicalGitTree` call (`git/bounded.ts`) that was killed on
timeout or process-group-kill without git cleaning up its own lock first.

## Owner ruling

NO auto-removal of a detected `.git/index.lock` in this card. Two things instead:

1. **Detection and a loud refusal.** Before a canonical-index writer (the solo squash in
   `mergeBranchLocked`, the batch fast-forward in `fastForwardCanonicalMain`, or any other
   `withCanonicalIndexLock` caller) touches the canonical index, check for `.git/index.lock`. If present,
   refuse up front with a reason naming the path, size, and mtime age, and a best-effort liveness signal —
   never a generic squash-failure message. Tell the operator to remove the lock by hand once they've
   confirmed no git process is running. Surface the same fact to the confirming manager through the
   normal rejection path.
2. **Diagnosability.** Start/end logging (args summary, duration, exit or kill/timeout) on
   `canonicalGit`/`spawnCanonicalGitTree` (`git/bounded.ts`) for any call that was killed or timed out —
   covering both the win-job-launcher path and the taskkill fallback — so the next time a lock is left
   behind, the log names the culprit. A killed call that was an index-writing subcommand also logs a WARN
   that `index.lock` may have been left behind.

## Why detection lives in `withCanonicalIndexLock`, not duplicated per call site

`withCanonicalIndexLock` (`git/repo-lock.ts`) is already the TRUE convergence point for every canonical
writer — the solo squash path (`mergeBranch`/`mergeBranchLocked`, `git/worktrees.ts`), the batch fast-
forward (`fastForwardCanonicalMain`, `git/batch-merge.ts`), `GitWriter`'s checkout/commit/createBranch
(card `e41dbb58`), `createWorktree`'s fresh-cut path, and `vault/versioner.ts`'s `commitVault` all acquire
it before touching the canonical index — the same reason the quarantine check (`assertRepoNotQuarantined`)
already lives here rather than being re-derived at each call site. A lock check added per-file would drift
from this one the moment either file's own entry sequence changes.

## Scope (round 2 — Code Review `6ed0d5da`, B3)

The check is NOT unconditional at the chokepoint — round 1 shipped it that way and the Code Review found
it would have blocked `createWorktree` (worker/review spawns) against a held lock, including the owner's
own interactive `git commit` with its editor open, even though `worktree prune`/`branch --list`/`worktree
add` all work fine with one present (verified against real git 2.47). OWNER RULING: the check applies ONLY
to paths that actually write the canonical index. Implemented as `withCanonicalIndexLock`'s own opt-in
third param, `{checkIndexLock: true}` — default OFF, so an un-migrated caller is unaffected.

Every `withCanonicalIndexLock` caller, and its status:

| Caller | File | `checkIndexLock` | Why |
| --- | --- | --- | --- |
| `mergeBranch`/`mergeBranchLocked` (the squash) | `git/worktrees.ts` | **true** | writes the canonical index |
| `confirmWorkerMerge`'s preflight (staged/dirty/untracked overlap probes) | `sessions/service.ts` | **true** | runs INSIDE the same canonical-index acquisition the squash itself re-acquires one call later (B1 below) |
| `fastForwardCanonicalMain` (the batch ff-only) | `git/batch-merge.ts` | **true** | writes the canonical index |
| `GitWriter.checkout` | `git/writer.ts` | **true** | writes the canonical index |
| `GitWriter.createBranch` | `git/writer.ts` | **true** | `checkout -b` itself does NOT race a staged-but-uncommitted diff (verified against real git 2.47: it carries staged content forward onto the new branch unchanged) — but moving canonical HEAD while an external `git commit` is mid-flight would divert that commit onto the freshly-created branch instead of the mainline, the same divert family `checkout`/`commit` below are in |
| `GitWriter.commit` | `git/writer.ts` | **true** | writes the canonical index (`add -A` + `commit`) |
| `commitVault` (vault auto-commit), merge-eligible branch only | `vault/versioner.ts` | **true** | this IS the same canonical index a real merge/GitWriter write would hit (that is the entire reason this lock is taken at all — see this file's own `a09b81a0` doc); translated into the SAME graceful `{committed:false}` backoff a quarantine refusal already gets here, never a throw — an auto-commit tick already treats any failure as "retry next tick" |
| `createWorktree`'s fresh-cut path | `git/worktrees.ts` | **false (deliberate)** | `worktree prune`/`branch --list`/`worktree add` all work fine with a lock present; must never block a worker/review spawn |

## Why no auto-removal

Auto-removing a lock this check finds is a DIFFERENT, riskier decision than `resetOrSkip`'s own narrow
removal (`removeLeakedCanonicalIndexLockIfSafe`, `git/worktrees.ts`): that one only ever fires after THIS
process's own `killableCanonicalRaw` call was positively `treeDeathConfirmed` — it knows, with real
confidence, that the lock it is about to remove was almost certainly its own child's. A lock discovered
HERE, at lock-acquisition time, carries no such provenance — it could be a different daemon, an IDE, or an
owner's own interactive shell. Removing it on a guess risks corrupting a genuinely in-progress git
operation. The owner's ruling is to surface this to a human instead.

## Do not

- Do not add auto-removal of a lock this check discovers — that is a different, already-rejected design
  (see "Why no auto-removal" above). `resetOrSkip`'s own confirmed-kill removal
  (`removeLeakedCanonicalIndexLockIfSafe`) is unrelated and untouched by this card.
- Do not duplicate this check per call site (`git/worktrees.ts`, `git/batch-merge.ts`) — route every
  canonical-index writer through `withCanonicalIndexLock`'s own check (`checkCanonicalIndexLockNotPresent`,
  `git/repo-lock.ts`), the same convergence point the quarantine check already uses.
- Do not use the witnessed liveness check (stat → brief wait → re-stat) to DECIDE anything — it exists
  only to inform the refusal message with a best-effort signal; it is deliberately far shorter than
  `removeLeakedCanonicalIndexLockIfSafe`'s own 1.5s persistence-check delay, since a wrong guess here costs
  nothing beyond an imprecise message, never a wrongly-removed lock.
- Do not enumerate or kill host processes (by image name, PID sweep, or otherwise) to answer "is a git
  process live" — the liveness signal is derived entirely from the lock file's own mtime/size stability
  across a short wait, never from process enumeration.
- Do not treat `{ ok: true }` from `checkCanonicalIndexLockNotPresent` as proof no lock exists — it is also
  returned when the git dirs can't be resolved at all (this check cannot manufacture a refusal it can't
  support) and when the lock disappeared during the witnessed wait (nothing left to refuse by the time the
  real call would run).

## Round 2 (Code Review `6ed0d5da`) — additional "Do not"s

- Do not let `CanonicalIndexLockPresentError` escape uncaught from ANY `{checkIndexLock: true}` call site
  — an uncaught throw classifies as `"unknown"`. **Correction (card 7f86c02f, which added `"unknown"` to
  `NEVER_CACHED_OUTCOMES`): the original reasoning here — "gets cached/replayed by the until-superseded
  verdict cache, silently blocking a re-confirm even after the lock is removed" — no longer holds; a
  re-confirm now genuinely re-attempts instead of replaying a stale `"unknown"`.** The underlying
  requirement is unchanged for a different reason: an uncaught throw still loses the specific, typed
  `indexLockPresent: true` shape (the exact path/reason text this error carries) in favor of the generic
  `"unknown"` wording — a worse diagnostic, not a caching hazard. Every opted-in call site must still
  catch it and return its own typed `indexLockPresent: true` shape (B1: `confirmWorkerMerge`'s preflight,
  `sessions/service.ts`, caught only `RepoQuarantinedError` before this round).
- Do not add a NEW canonical-index-touching call site (a `withCanonicalIndexLock` caller, or any future
  one) without deciding its `checkIndexLock` value AND adding its row to the Scope table above — an
  undecided caller silently inherits the default (`false`, no check), which is wrong for one that actually
  writes the canonical index.
- Do not add `quarantined`/`indexLockPresent` handling to only ONE of the two `classifyOutcome` lambdas
  (the solo path's or the batch path's, `sessions/service.ts`) — they are separate functions over separate
  result types (B2: the batch lambda had NO arm for either, so both fell to `"rejected"`, which IS
  replayed from the until-superseded cache — the `quarantined` gap predates this card but is fixed here,
  same lines).
- Do not reuse `PURE_READ_SUBCOMMANDS` (the merge-driver-execution set) to decide whether a killed call
  gets the index-writing WARN in `logCanonicalGitAbnormalOutcome` (`git/bounded.ts`) — it answers a
  DIFFERENT question and wrongly treats `status` as safe, even though git opportunistically takes
  `.git/index.lock` for it (no `GIT_OPTIONAL_LOCKS=0` anywhere in this codebase). Use the dedicated
  `NEVER_INDEX_TOUCHING_SUBCOMMANDS` set instead (also excludes `diff`/`ls-files` for the same reason).
- Do not have `canonicalGit`'s own raw-wrapper catch (`git/bounded.ts`) claim a call "timed out" purely
  because elapsed time crossed the configured idle `block` bound — that path has no abort-kill machinery,
  so elapsed time alone cannot distinguish a real timeout from an ordinary slow failure of the same
  duration. Label it as the weaker, honest claim the signal actually supports ("slow failure (elapsed X ms
  >= idle bound Y ms)").

## Round 3 (Code Review of round 2, reviewer `e243a80b`, card `e7a88047`) — additional "Do not"s

- Do not read `GitWriter.createBranch`'s `checkIndexLock:true` as meaning `checkout -b` itself conflicts
  with a staged diff — verified against real git 2.47 it does NOT (staged content carries forward onto
  the new branch unchanged). The true reason is the Scope table row above: moving canonical HEAD while an
  external `git commit` is mid-flight would divert that commit onto the freshly-created branch instead of
  the mainline.
- Do not let a merge-eligible vault's `CanonicalIndexLockPresentError` refusal (`commitVault`,
  `vault/versioner.ts`) skip `maybeAlertStaleVaultLock` just because it's translated to a graceful
  `{committed:false}` rather than thrown — call the alert from INSIDE `commitVault`'s own catch, not only
  from the outer catch in `VaultVersioner.commit()`/`flushSync()` (which never sees this error, since it
  never escapes `commitVault`). `maybeAlertStaleVaultLock` already has its own staleness threshold and
  per-lock-instance dedupe, so calling it on every debounced retry is safe; only the plain
  `console.warn` alongside it needs its own rate limit.
- Do not check the batch path's index lock ONLY at the post-gate ff-only stage
  (`fastForwardCanonicalMain`) — add the SAME cheap pre-gate check `mergeBatchTracked` (`sessions/
  service.ts`) already does for the corrupt-watermark case, strictly before the batch worktree is cut, so
  an already-present lock never burns a whole worktree cut + gate run. This changes `gateCalls` on call #1
  of `batch-merge-index-lock-not-cached.mjs` from 1 to 0 — the gate no longer runs at all when the lock is
  already present before assembly starts; updated deliberately, not a regression.
- Do not let an early (pre-worktree-cut) `indexLockPresent` refusal settle through `onSettle` with a bare
  tombstone row — add its own `verdict` synthesis arm (mirrors `watermarkUnreadable`'s), gated so it never
  fires for the POST-gate `indexLockPresent` shape (that one always has `batchGateVerdict` already set
  from the real gate run that preceded it).

## Round 4 (Code Review of round 3, `1260fb58`) — NOT SHIP, one blocker

**BLOCKER — `summarizeGitArgsForLog` (`git/bounded.ts`) failed open on an unrecognized global option.**
Round 3's own subcommand detection was a hand-rolled loop that only knew `-c`. A real call shaped
`["-C", "/repo", "commit", "-m", "<secret>"]` (or with `--git-dir`/`--config-env` in place of `-C` — all
three are real git global options that take their value as a SEPARATE arg, the exact same shape as `-c
<cfg>`) made that loop read the VALUE (`"/repo"`) as the subcommand, missing `commit` entirely — `isCommit`
read `false`, and the message landed in the log UNREDACTED. Nothing was leaking in production at the time
(no canonical call in this codebase actually uses those prefixes before `commit`), but a redaction that
fails open on input it doesn't recognise is not an acceptable shape for a function whose whole job is
redaction.

Fixed two ways, together:
1. **Reuse, never re-derive, subcommand detection.** `git/bounded.ts` already has `gitSubcommand()` (and
   its `GLOBAL_OPTS_WITH_VALUE` set — `-c`, `-C`, `--git-dir`, `--work-tree`, `--namespace`,
   `--config-env`, `--attr-source`), used elsewhere in the same file for exactly this question. Do not add
   a second, narrower parse of the same question — two independent parses of "what is the subcommand" can
   only ever drift apart, which is exactly how round 3 regressed.
2. **Deny by default, not allow by default.** Round 3 scrubbed ONLY the `commit` subcommand — any OTHER
   subcommand this function didn't yet special-case passed straight through unredacted, the same fail-open
   shape one level up. `NO_MESSAGE_FLAG_SUBCOMMANDS` (`git/bounded.ts`) now names the few subcommands VERIFIED
   to have no message/file/author-bearing flag at all (`log`, `grep` — both real call sites in this
   codebase, e.g. `git log -F --grep=Loom-Worker-Branch: ...` in `git/worktrees.ts`, where `-F` is
   `--grep`'s "fixed strings" mode, never a value of its own) — every subcommand NOT in that set, including
   one this function has never seen before, gets every flag below redacted.

Also closed, same round: `--author`'s value is now redacted too (`batch-merge.ts`'s squash-amend commit
logs a worker's own author identity via `["commit", "--author", "<name> <email>", ...]` — a daemon-global
log shared across every tenant on the host); and an abbreviated long option git itself accepts (`--mess=`,
`--fil=`, …) is redacted via a cheap letter-prefix check against `"message"`/`"file"`.

## Round 5 (Code Review of round 4, `bc965645`) — NOT SHIP, again on the same function

**Three straight rounds of flag-parser gaps.** Round 3 scrubbed only exact `-m`/`-F`/`--message`/`--file`
tokens on `commit`. Round 4 widened that to attached/clustered short forms, `--author`, and abbreviated
long options — and STILL leaked: the greedy attached/clustered regex turned `commit -mConfirm` into
`-mConfirm <redacted>` (logging the message in clear AND swallowing the next arg; `-amPassForm` leaked the
same way), a separate-value abbreviation like `--mess X`/`--fil secretfile` was never covered at all (only
the `=`-joined form was), and an `--author` abbreviation like `--auth=X`/`--autho X` leaked outright — made
worse by round 4's own "Do not extend abbreviation matching to `--author`" ruling, which forbade the fix
for that exact leak. Hand-rolling git's option grammar one flag shape at a time is not a tractable way to
keep a redaction function closed — there is always another attached/clustered/abbreviated/separate-value
shape no one has thought of yet.

**THE FIX stops parsing flags entirely and fails closed at the SUBCOMMAND level.** `summarizeGitArgsForLog`
(`git/bounded.ts`) now: (1) resolves the subcommand via the shared `gitSubcommand()`/`gitGlobalArgs()` (as
round 4 already established); (2) if that subcommand is in `SAFE_FULL_ARGS_SUBCOMMANDS` — an ALLOWLIST of
subcommands VERIFIED (against git's own documentation) to have no value-bearing message/identity/trailer/
reason/config-value flag at all (round 6 below removed `worktree` from this list — see why) — logs every
arg after it IN FULL; (3) otherwise collapses the ENTIRE
tail to `<subcommand> <N args redacted>`, with zero per-flag inspection; an unrecognized subcommand gets
the same collapse. A global `-c key=value` prefix redacts only the value half (`-c user.name=<redacted>`)
— the key is a config path name, not a secret; `-C <path>`/`--git-dir <path>`/etc. are logged unchanged,
as before. `NO_MESSAGE_FLAG_SUBCOMMANDS`, `EXACT_VALUE_FLAGS`, the attached/clustered short-form regex, and
the abbreviated-long-option check are all DELETED — there is no flag-level logic left to have a gap in.

## Do not (round 5)

- Do not add a subcommand to `SAFE_FULL_ARGS_SUBCOMMANDS` without first verifying (git's own documentation,
  not assumption) that it has no value-bearing message, identity, trailer, reason, or config-value flag —
  this set is an ALLOWLIST; an unverified addition is exactly how a real secret ends up logged in full on a
  subcommand this set wrongly trusts.
- Do not reintroduce flag-level parsing to decide what to redact, for ANY reason — three straight rounds
  each closed one leaked shape and missed another; the fix is failing closed at the subcommand level, not
  a better flag parser.
- Do not extend abbreviation matching to `--author` — this round deleted abbreviation matching entirely,
  so there is nothing left to extend; round 4's identical-sounding "Do not" is superseded, not satisfied,
  by this deletion.

## Round 6 (Code Review of round 5, `b0e10423`) — SHIP, with two small fixes requested before landing

1. **`worktree`'s "no value-bearing flag" claim was false.** `git worktree lock --reason <string>` and
   `git worktree add --lock --reason <string>` both take free text. Removed from
   `SAFE_FULL_ARGS_SUBCOMMANDS` — a `worktree` call now collapses to `worktree <N args redacted>` like
   every other non-allowlisted subcommand.
2. **The `-c` prefix-redaction loop re-scanned an already-sliced prefix ARRAY by CONTENT.** It matched
   `a === "-c"` against each element of the `prefix` slice `gitGlobalArgs()` had already produced — but a
   `-C`/`--git-dir`/etc. VALUE that happened to equal the literal string `"-c"` is indistinguishable, by
   content alone, from a real `-c` flag. `["-C", "-c", "-c", "user.password=LEAK", "status"]` mis-paired
   the REAL second `-c`'s value with the FAKE one, leaking it unredacted. Fixed by introducing ONE shared
   walker, `walkGitGlobalPrefix()`, that walks the ORIGINAL `args` ONCE, by POSITION, using the same
   `GLOBAL_OPTS_WITH_VALUE` set every value-taking global option is paired by — `gitSubcommand()`/
   `gitGlobalArgs()` now both route through it too, so there is only ever one answer to "where does the
   global-option prefix end."
3. `log`/`rev-list`'s `--author=`/`--grep=` and `grep`'s own pattern argument are deliberately allowed in
   full on those two allowlisted subcommands — they are SEARCH FILTERS (read-only query parameters that
   select existing history), never SETTERS (a value that gets written somewhere), so there is nothing for
   them to leak that the repository's own history doesn't already contain in plain sight.

## Do not (round 6)

- Do not re-scan an already-sliced prefix array by CONTENT to decide what to redact — walk the ORIGINAL
  args by POSITION, through `walkGitGlobalPrefix()`, the one shared walker. A content-based re-scan cannot
  tell a real flag token from another option's VALUE that happens to look like one.
- Do not let `gitSubcommand()`/`gitGlobalArgs()` diverge from `summarizeGitArgsForLog()`'s own notion of
  where the global prefix ends — all three must share `walkGitGlobalPrefix()`, never three independent
  copies of the same walk.
- Do not add `worktree` back to `SAFE_FULL_ARGS_SUBCOMMANDS` without accounting for `lock --reason`/`add
  --lock --reason` specifically — those are the flags that made the original claim false.
