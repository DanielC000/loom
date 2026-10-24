# 3a5c5d4a — a worker-plantable `.git/commondir` must never redirect a canonical git call

Follow-up from Code Review `e9cbcb15` of `7ebb4acf`: that review flagged, as an open QUESTION (not a
confirmed bug), that `resolveGitDirsSync` (`git/repo-lock.ts`) treats a `.git` DIRECTORY as its own common
dir unconditionally, never checking whether it also carries a `commondir` file, and asked whether real git
honours `$GIT_DIR/commondir` for a main repo the same way. This card answers that empirically (yes), finds
the surface is wider than the question framed it, and closes it. Read `docs/decisions/356538ef-canonical-git-isolation.md`
first — this is the same canonical-merge-path trust boundary, a new hijack class alongside S10/S11/S12.

## Do not (round 2, Code Review)

- Do not parse the FILE-shape `gitdir:`/`commondir` pointers with a loose regex that trims surrounding
  whitespace from the captured value — a real attacker-plantable decoy directory can differ from the
  trusted one ONLY by a trailing/leading space (a real, distinct, creatable name on POSIX), and a trimming
  parser verifies the TRIMMED (legitimate-looking) path while git itself resolves the UNTRIMMED (decoy)
  one. Refuse on any such whitespace instead of guessing which bytes to discard.
- Do not trust a worktree-registry entry (`<trustedMainRoot>/.git/worktrees/<name>`) just because its
  REALPATH happens to match the gitdir pointer's own realpath — `lstat` the literal entry itself and refuse
  a symlink/junction; a worker can replace that entry with a symlink to anywhere and still pass a
  realpath-only comparison vacuously.
- Do not add the `advisory-read` opt-out to a call site without checking whether it ever feeds a MUTATING
  git call — it is for read-only probes only. `git/worktrees.ts`'s `boundedGit` helper qualifies as a
  WHOLE because its own pre-existing doc already characterizes every caller as read-mostly/worktree-scoped
  (the dedicated high-consequence-write path is the separate `boundedMergeGit`, whose two callers always
  pass the real main checkout, never a worktree); a NEW helper or caller needs its own equivalent review,
  not a blanket copy of this reasoning.
- Do not `fs.writeFileSync` a REAL `git worktree add`-created `.git` pointer file a second time in a test
  on this host — measured directly that it refuses with `EPERM`. **Round 3 correction: the cause is the
  Windows `Hidden` attribute git sets on every `.`-prefixed file it creates (confirmed via
  `Get-ItemProperty`: a real worktree's own `.git` carries `Hidden, Archive`), not any kind of write
  PROTECTION on the pointer's own content — `writeFileSync`'s `CREATE_ALWAYS`-style open fails on a hidden
  file, while `fs.unlinkSync` followed by a fresh `fs.writeFileSync` succeeds (unlinking removes the
  hidden file entirely; the new file git never marked hidden has nothing blocking it).** These pointers
  are NOT protected against rewriting in any security sense — a worker can unlink-then-rewrite one just as
  easily as a fresh file, exactly the attack this card defends against. Build a FRESH, never-git-created
  `.git` file (and, if a "real subdirectory of the trusted worktrees dir" is needed, a fresh directory
  there too) when a test needs to rewrite a pointer file's content across multiple shapes — simpler than
  unlink+rewrite and avoids ever touching a real worktree's own registration.
- Do not read `trustedMainRoot === repoPath` as proof of a worker attack — it is also the HONEST, benign
  shape of "the project's bound repo is itself a linked worktree" and of "a caller forgot to thread the
  real main root"; both get the same `CanonicalGitBoundWorktreeRefusal`, with its OWN non-alarming wording,
  never the commondir-redirect's escalate-to-the-Platform-Lead language.

## Do not

- Do not "fix" this with a `GIT_COMMON_DIR` (or `GIT_DIR`) environment override — measured directly
  (below) that it produces a SPLIT-BRAIN state, not a safe override: `--git-common-dir`/`config` correctly
  report the trusted repo, but `rev-parse HEAD`/`for-each-ref`/`show-ref`/`log` still resolve the ref
  VALUE from the planted target and then fail trying to find that object in the (correctly-scoped) object
  store ("fatal: missing object … for refs/heads/master" / "fatal: bad object HEAD"). Incoherent and
  unsafe as a mitigation.
- Do not "fix" `resolveGitDirsSync`'s DIRECTORY-branch blindness in isolation, without also adding the
  trust check this card adds at the `canonicalGit`/`killableCanonicalRaw` chokepoint. That function's
  current blindness is what keeps its existing NON-security consumers (`worktrees.ts`'s `readHeadSha`/
  `readBaseSha`/`computeDiffCacheKey` cache-key fs reads, `skills/inject.ts`, `pty/codex-doctrine.ts`)
  accidentally safe today — they never follow a planted DIRECTORY-shape commondir. Making it "agree with
  git" there alone would hand those consumers the same hijack instead of closing anything.
- Do not default a NEW `canonicalGit` caller's `trustedMainRoot` to its own `repoPath` when `repoPath` is
  a worker's own linked WORKTREE, not the main checkout — `checkCommondirTrust`'s FILE-shape check would
  then compare the worktree's commondir against ITSELF, false-refusing every such call. `canonicalGit`'s
  own `trustedMainRoot` param therefore has NO default at all (genuinely `undefined` when omitted, never
  `= repoPath`) — see that function's own doc. `killableCanonicalRaw` is different: it already carries a
  real, independently-correct canonical-repo value in `quarantineRepoPath` (set by every existing
  worktree-scoped caller, e.g. `batch-merge.ts`'s `batchWorktreePath` calls), so its `trustedMainRoot`
  safely defaults to THAT, never to its own `repoPath`.
- Do not trust a worktree's own pointer files (`.git`, `commondir`) as proof of where they lead. A worker
  already has filesystem write access to the whole shared `.git` tree, including a sibling's or its own
  worktree's PRIVATE `.git/worktrees/<name>/commondir` file — legitimate, and therefore not itself
  suspicious-looking. Verify the resolved target against a trust anchor the daemon independently already
  knows, never against what the file itself currently claims.
- Do not assume `killableCanonicalRaw`'s `trustedMainRoot` default (`= quarantineRepoPath`) is safe just
  because `quarantineRepoPath` is "already correctly threaded" at most call sites — a caller that
  deliberately leaves `quarantineRepoPath` at ITS OWN default for an unrelated reason (`attemptCodexAutoCommit`'s
  hooks-disabled exemption, card bde5d1fe) silently hands `trustedMainRoot` the same self-referential
  value. Caught only by re-running the existing test suite post-merge, not by inspection — see "Found by
  re-running the existing suite" below. Grep every `killableCanonicalRaw` call whose `repoPath` is a
  worktree for an EXPLICIT `quarantineRepoPath` OR `trustedMainRoot` before assuming either is safe.
- Do not assume the DIRECTORY-shape check alone closes the surface. `canonicalGit`/`killableCanonicalRaw`
  are also invoked with `repoPath` = a worker's own linked WORKTREE (`diffBranch`'s `boundedDiffGit`,
  reached from `workerDiff`'s uncommitted-diff branch; `batch-merge.ts`'s `batchWorktreePath` calls via
  `killableCanonicalRaw`) — a worker rewriting an EXISTING, legitimate worktree commondir pointer produces
  the identical hijack, and `resolveGitDirsSync`'s FILE-branch is not blind there (it already matches git
  faithfully) — the gap is that nothing previously verified the pointer's TARGET.

## Measured: the hijack, step by step (git 2.47.0.windows.2, Windows, scratch repos only)

Setup: repo A (the "trusted main checkout", `.git` a plain DIRECTORY, one commit) and repo B (an
unrelated decoy, different history, `loom.testkey = VALUE-FROM-B-DECOY`).

| op | baseline (no plant) | planted ABSOLUTE commondir A→B | planted RELATIVE commondir A→B |
|---|---|---|---|
| `rev-parse --git-common-dir` | `A/.git` | `B/.git` | `B/.git` |
| `rev-parse HEAD` | A's real sha | B's sha | B's sha |
| `log -1` | A's commit | B's commit | B's commit |
| `config --get loom.testkey` | (A's value) | `VALUE-FROM-B-DECOY` | `VALUE-FROM-B-DECOY` |
| `for-each-ref` | A's ref | B's ref | B's ref |
| `--git-path objects`/`refs`/`config` | A's paths | all three → B's paths | (same mechanism) |

Reproduced identically through `canonicalGit`'s own real flags (`-c core.useReplaceRefs=false`) plus the
`GIT_GRAFT_FILE`/`GIT_SHALLOW_FILE` fresh-sentinel neutralization card `7ebb4acf` adds — both are
orthogonal mechanisms with zero effect on this — and through a real Node `spawnSync` reproducing
`bounded.ts`'s exact argv/env shape, not just bare git.

**Write-laundering, not just read confusion.** A naive write against a decoy whose objects don't match the
victim's checked-out blobs fails outright ("invalid object … Error building trees" — the index's existing
blob ids can't resolve against the decoy's store). But against a BELIEVABLE decoy (a straight `git clone`
of the victim — so it holds every blob the victim has — plus one attacker commit on top): a normal-looking
`git add && git commit` SUCCEEDS, the new commit's parent is silently the ATTACKER's forged commit (not the
victim's real HEAD), the write lands ONLY in the decoy's own refs/objects, and the victim's REAL on-disk
`refs/heads/master` — read directly off disk, bypassing git entirely — is confirmed UNTOUCHED. The daemon
would see a "successful" merge/commit while the real repo never moved.

**Scope is wider than the reviewer's question:** `canonicalGit`/`killableCanonicalRaw` are not only invoked
against the main checkout's DIRECTORY-shaped `.git` — `workerDiff`'s own uncommitted-diff branch
(`worktrees.ts`) calls `boundedDiffGit(worktreePath, …)`, a worker's own linked worktree, and
`batch-merge.ts` routes several `killableCanonicalRaw` calls through `batchWorktreePath` (an ephemeral
worktree). Rewriting an EXISTING, legitimate linked worktree's own `.git/worktrees/<name>/commondir`
pointer (a file a worker already has write access to — same shared `.git` tree the threat model in
`356538ef` already treats as worker-writable) produces the identical hijack there too — this is NOT the
DIRECTORY-shape blindness `resolveGitDirsSync` has; that function already follows a FILE-shaped `.git`'s
commondir correctly, matching git. The gap is that nothing previously verified the pointer resolves to the
TRUSTED main, not an attacker-chosen target.

**A considered fix that failed, measured not assumed:** overriding `GIT_COMMON_DIR` to the real main's
`.git` while the planted commondir FILE still points elsewhere produces an incoherent split state —
`--git-common-dir`/`config` report correctly, but `rev-parse HEAD`/`for-each-ref`/`show-ref`/`log` still
resolve the ref VALUE from the planted target, then fail resolving that object against the now-correctly-
scoped object store. Not a safe mitigation; do not propose it again without a fresh measurement.

**Negative result, closing a related sub-question:** `.git/objects/info/alternates` is additive-only, as
suspected — pointing a repo's alternates at a foreign objects dir widens what's readable/reachable
(`cat-file -t`/`log` on an otherwise-unknown sha now succeeds) but an EXISTING commit's own recorded
`parent` field is byte-identical before and after. Alternates cannot rewrite history, only broaden
visibility; it is not a parent-forgery vector the way a commondir/grafts/shallow redirect is.

## The fix

`checkCommondirTrust` (`git/bounded.ts`), wired into `canonicalRaw` — the ONE function shared by
`canonicalGit`'s own `raw` closure AND `killableCanonicalRaw` (via `spawnCanonicalGitTree`) — run FIRST,
before even the existing merge-driver enumeration. Two cases, fs-only, re-checked on every call (same
TOCTOU posture as the merge-driver check it sits beside):

1. **DIRECTORY `.git`:** refuse (a distinct `CanonicalGitCommondirRefusal`) if it ALSO carries its own
   `commondir` file — verified a real main checkout's own top-level `.git` directory never legitimately
   has one; only a linked worktree's private `.git/worktrees/<name>/` subdirectory does. Needs no trusted
   root at all.
2. **FILE `.git` (linked worktree):** when the caller supplies a `trustedMainRoot`, refuse unless BOTH (a)
   the gitdir pointer resolves under `<trustedMainRoot>/.git/worktrees/`, and (b) the resolved commondir
   equals `<trustedMainRoot>/.git` exactly (realpath/case-normalized via `repo-lock.ts`'s
   `findExistingAncestorRealpath`, the same idiom `canonicalRepoLockKey` already uses). (a) alone is not
   redundant with (b): a forged private dir elsewhere, carrying a byte-correct commondir pointing at the
   real trusted main, would otherwise pass (b) while still letting an attacker control HEAD's own meaning
   for that worktree's git calls. When `trustedMainRoot` is omitted, only case 1 applies — see the "Do
   not" list for which existing call sites this leaves as a named residual rather than silently assumed
   covered, and `docs/decisions/356538ef`'s own Tests section for the exact list.

A refusal renders DISTINCTLY from the generic "refused, nothing changed" (`canonicalFailureMessage`,
`git/bounded.ts`) — it names the mechanism and says this needs human escalation (the Platform Lead
inspecting the shared `.git`), surfaced through `worker_merge_confirm`'s/`merge_batch`'s own `reason` text
rather than reading as a routine, retry-shaped failure.

## Found by re-running the existing suite post-merge, not by inspection

Two real regressions surfaced ONLY by re-running `git-askpass-explicit-env.mjs` and
`spawn-recut-stale-branch.mjs` after landing — neither was caught by the original investigation's own
call-site sweep, because both go through `killableCanonicalRaw` directly (not `canonicalGit`/`boundedGit`)
with NO explicit `quarantineRepoPath`, so `trustedMainRoot`'s default (`= quarantineRepoPath`) silently
inherited `quarantineRepoPath`'s OWN default (`= repoPath`, i.e. the worktree itself) — the exact
self-referential case this card's own "Do not" list warns against, reached through a path the original
sweep didn't check (quarantine-exempt callers, not worktree-scoped `canonicalGit`-direct reads).

1. **`recutStaleReusedBranch`'s own `git reset --hard` mutation** (`worktrees.ts`) — its `repoPath` param
   (the real main, already available) was never threaded as `trustedMainRoot`. Fixed by passing it
   explicitly as the 10th positional arg, leaving `quarantineRepoPath` at its own pre-existing default.
2. **`attemptCodexAutoCommit`'s own commit call** — DELIBERATELY leaves `quarantineRepoPath` at its
   default (card bde5d1fe's own exemption: hooks are already disabled, so there's no hook-escape vector
   `quarantineRepoPath` scoping was ever protecting against) — an UNRELATED rationale that this card's
   `trustedMainRoot` default accidentally inherited anyway. Fixed by adding `trustedMainRoot` to
   `BoundedGitDeps` and threading it from the one real caller (`sessions/service.ts`'s `workerReport`,
   which already resolves the real repo as `precheckRepoPath` just above) through to BOTH
   `attemptCodexAutoCommit`'s own `canonicalGit`-direct read factory and its `killableCanonicalRaw` commit
   call; the test (`git-askpass-explicit-env.mjs` scenario B) updated to pass it too, since it calls the
   function directly with a synthetic repo/worktree pair the production caller doesn't supply here.

Swept every remaining `killableCanonicalRaw` call site across `worktrees.ts`/`batch-merge.ts`/
`writer.ts`/`vault/versioner.ts` after finding these two — every other one either already passes the real
canonical repo explicitly as `quarantineRepoPath` (batch-merge.ts's candidate-landing calls, `mergeBranch`'s
own union-merge calls), or has `repoPath` already equal to the real main itself (`GitWriter`, the vault's
own merge-eligible commit, `createWorktree`'s own prune/add, `mergeBranchLocked`'s own squash/commit/reset).

## Tests

- `test/canonical-git-commondir-refusal.mjs` — real scratch repos, both refusal shapes plus the
  "gitdir outside trusted worktrees" sub-case, both ALLOWED controls (a real `git worktree add` worktree,
  an unplanted main), through both `canonicalGit` and `killableCanonicalRaw`; a counting `spawnImpl` proves
  nothing spawns on a refusal, not just that the call rejects. RED/GREEN + clean-tree proven via
  `pnpm --filter @loom/daemon negative-control`.
- `test/canonical-git-helper-guard.mjs` — extended (source-text only) to assert `canonicalRaw`'s own body
  calls `checkCommondirTrust(` and that both `canonicalGit` and `killableCanonicalRaw` route through it.

## Round 2 (Code Review) — B1, S1, S2, S3, N1, N2

A first Code Review (not re-stated here — see the review transcript / `worker_merge`'s own review history
for the exact findings) returned NOT-MERGEABLE on round 1's `checkCommondirTrust`. Four findings, each
closed:

**B1 (CRITICAL — parse divergence).** Round 1's FILE-shape parse used a loose regex
(`/^gitdir:\s*(.+?)\s*$/m`) that measurably diverged from git's own `read_gitfile_gently`/
`get_common_dir_noenv` on whitespace shapes (4/4 tested: Windows returned `ok:true` while real git
resolved a DIFFERENT path). Fixed with a STRICT grammar in `checkCommondirTrust` (`git/bounded.ts`): the
pointer must start at byte 0 with the literal `"gitdir: "`; strip only ONE trailing line-ending (`\r\n`,
`\r`, or `\n` — never more); refuse on any leading/trailing whitespace, embedded `\r`/`\n`, empty value, or
relative path remaining in the captured value; realpath the RAW string directly (`fs.realpathSync.native`
— never `path.resolve()`'d against `repoPath` first, since a relative value is already refused); require
the realpathed gitdir to sit EXACTLY one path segment under the trusted main's own realpathed
`.git/worktrees/`; and separately `lstat` that literal worktree-registry entry to refuse a symlink/junction
(closes a vacuous-match bypass: an entry a worker replaced with a symlink whose realpath happens to equal
the gitdir's own realpath, without the entry itself being a real `git worktree add`-created directory).
`commondir` inside the verified gitdir must be the EXACT literal `"../.."` (git's own `worktree add` writes
nothing else) after the same one-trailing-line-ending strip — never `.trim()`'d or walked loosely — and
must itself realpath-resolve to the trusted main's own `.git`. Every step fails CLOSED on anything it
cannot positively verify (a missing/unresolvable path, a failed `lstat`), never falling through to
`{ok:true}` once the strict `"gitdir: "` prefix has matched.

Measured, closing the review's own open question: a real `git worktree add` worktree's pointer files (on
this Windows host, git 2.47) use FORWARD slashes in an absolute drive-letter path (`gitdir: C:/Users/...`)
and a bare `\n` line ending — never `\r\n` — in BOTH the top-level `.git` file and the private `commondir`
file. The strict parser accepts this real shape (it is well-formed: byte-0 prefix, no interior/trailing
whitespace, absolute, single line) and still separately tolerates a CRLF-terminated pointer as an
independent, correct case (git's own grammar strips the line-ending, never the value's own whitespace).

**S1 (bound repo is itself a linked worktree).** `trustedMainRoot === repoPath` (both resolving to the
SAME real path) for a FILE-shaped `.git` is structurally indistinguishable, from this check's own inputs
alone, between two causes: the project's bound repo genuinely IS a linked worktree (unsupported on this
path — card `ec4afbe9` tracks deriving the real main checkout once, at project-bind time), or a caller
simply forgot to thread the real main root. Both get the SAME honest refusal now — a new, distinct
`CanonicalGitBoundWorktreeRefusal` (subclass of `CanonicalGitRefusal`, sibling of
`CanonicalGitCommondirRefusal`) — checked BEFORE the "no trustedMainRoot at all" branch, and
unconditionally (never bypassed by `opts.commondirCheck`). `describeGitFailure`/`canonicalFailureMessage`
grew a parallel `boundRepoIsWorktree` field/branch with its OWN wording ("the canonical git path does not
support verifying… this needs a human to re-bind the project") — deliberately NEVER the commondir-redirect
branch's attack/escalation language ("A worker-plantable .git/commondir pointed this call away…"), which
would misdescribe this case (there is no planted pointer to go find).

**S2 (silent permissive default; no wiring tests).** Round 1's FILE-shape branch returned `{ok:true}`
unconditionally whenever `trustedMainRoot` was omitted — meaning every call site that never threaded it
(which, by inspection, was most of `git/worktrees.ts`'s ~45 `boundedGit`-backed callers, plus a handful of
other direct `canonicalGit` callers) got NO verification at all, silently, by omission — not a reviewed
exemption. Fixed in two parts:

1. **The default flipped to fail-closed.** `checkCommondirTrust` now refuses a FILE-shaped `.git` with no
   `trustedMainRoot` UNLESS the caller explicitly opts out via a new third parameter,
   `opts: CheckCommondirTrustOpts = { commondirCheck: "advisory-read" }` — threaded through
   `canonicalRaw`/`canonicalGit`/`killableCanonicalRaw`'s own (now widened) signatures. The opt-out bypasses
   ONLY this one branch; the DIRECTORY-shape check and the S1 `CanonicalGitBoundWorktreeRefusal` case both
   still run unconditionally regardless of it.
2. **Round 2 claimed "every site this flip would newly fail closed was found by rebuilding and
   re-running the existing suite" — ROUND 3 CORRECTION: that claim was FALSE, proven false by the very
   regressions round 3 had to fix.** Rebuilding and re-running the suite found ALL of `git/worktrees.ts`'s
   shared `boundedGit` helper's callers (its own pre-existing doc already characterized its WHOLE caller
   set as "read-mostly or worktree-scoped" — see `boundedMergeGit`'s doc for the contrasted
   high-consequence-write path, whose own two callers always pass the real main checkout, never a
   worktree, so the FILE-shape branch never triggers there) plus four FURTHER sites with their own local
   `makeGit` not routed through that helper (`readWorktreeUncommittedState`, `precheckWorkerDone`'s and
   `worktreeHasWork`'s worktree-side dirty-status reads, `detectStrandedWork`'s `wt` probe) plus
   `mergeMainIntoWorktree`'s own `wtGit`/`commitTreeGit`. **It did NOT find `resolveGitIdentityFallbackArgs`'s
   own default probe construction** (git/bounded.ts — a helper ONE LEVEL BELOW `boundedGit`, constructing
   its own internal `canonicalGit` instance that the round-2 sweep's "grep for `canonicalGit(p, ms)` call
   sites in worktrees.ts" method structurally could not see, since this one lives in `bounded.ts` and is
   invoked indirectly through a parameter default), nor two TEST FIXTURES with the identical bare-pass-
   through shape (`canonical-git-isolation.mjs`'s `failingReset`, `merge-confirm-verdict-cache-union-merge-
   transient.mjs`'s `proxyFailSecondMergeCall`) — all three surfaced only when a QA verifier ran the full
   named test battery on a genuinely clean, freshly-built main and found three real, reproducible failures
   round 2 had WRONGLY classified as pre-existing (see the round-3 negative-control correction below for
   exactly how that misclassification happened). **The honest claim: a suite re-run finds every site the
   suite's OWN coverage reaches; it cannot prove it reached everything, and here it provably didn't.**
   `resolveGitIdentityFallbackArgs` is now fixed at its OWN source (round 3, B2 — a real `trustedMainRoot`
   threaded from every caller, never the advisory-read opt-out, since an identity decision made against an
   unverified repo is worth getting right, not just making non-throwing) rather than by re-sweeping for
   more hidden `boundedGit`-shaped callers; the two fixtures are fixed the same way, threading the real
   `trustedMainRoot` their own test setup already has in scope. Every one of the eleven `boundedGit`-class
   call sites above is commented at its own location with a one-line why, per the review's own instruction
   — see `git/worktrees.ts`'s `BOUNDED_GIT_ADVISORY_READ` constant and each of its use sites; it is now
   applied PER-CALLER, keyed on whether `deps.trustedMainRoot` is supplied, not a blanket default — see the
   round-3 section below for the `computeEmitCompareGate` exception that needed the real path instead.

   `batch-merge.ts`'s own `boundedGit`/`boundedMergeGit` were NOT touched — unlike `worktrees.ts`'s
   same-named helpers, these already thread `deps.trustedMainRoot` explicitly at every call site that needs
   it (`{ ...deps, trustedMainRoot: repoPath }`), and `fastForwardCanonicalMain`'s own `boundedGit(repoPath,
   deps)` call operates directly on the real canonical main (DIRECTORY-shaped `.git`), never a worktree.

   `git/mainline-watch.ts`'s five direct `canonicalGit(repoPath, timeoutMs)` calls (no `trustedMainRoot`)
   were also left untouched, deliberately: they read the PROJECT's own bound repo (not a worker worktree),
   and every one of their callers already has a documented, unconditional FAIL-OPEN contract on any git
   error ("Do not turn this alert into a refusal… any failure logs `[mainline-watch] check skipped
   (fail-open)`" — `docs/decisions/4fa36502-*.md`). A bound repo that genuinely IS a linked worktree (S1's
   rare case) now surfaces as a `CanonicalGitBoundWorktreeRefusal` there too, absorbed by that pre-existing
   fail-open handling exactly like any other git failure — this is the review's own stated S1 trade-off
   (fail closed on this check, fail open on the mainline-watch feature it feeds), not a new gap.

**S3 (record the residual set).** Done here, and in `docs/decisions/356538ef-canonical-git-isolation.md`'s
own §Residual, which this card's bullet there now supersedes with the round-2 list above (never both lists
independently — the `356538ef` bullet now points back at this section rather than re-enumerating it).

**N1.** `356538ef`'s existing TOCTOU residual bullet already covers this card generically ("the window spans
the driver enumeration and the post-check spawns" applies identically to the commondir check, which also
re-checks on every call rather than caching) — no separate bullet needed; noted here per the review's own
ask rather than duplicating prose.

**N2 (negative control).** `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/bounded.ts --test packages/daemon/test/canonical-git-commondir-refusal.mjs`
— RED phase (bounded.ts reverted to the pre-round-2 commit, `worktrees.ts` left at its round-2 state):
the BUILD itself fails (`tsc` — `worktrees.ts` references `CheckCommondirTrustOpts` and the
`boundRepoIsWorktree` field, neither of which exist on the reverted `bounded.ts`), and the test run against
whatever stale `dist/` was left also shows genuine logic failures: the new (6a)-(6e) strict-whitespace/
multi-line/relative/empty assertions FAIL (the round-1 loose regex silently permits every one of them), and
case (9) CRASHES with `TypeError: Right-hand side of 'instanceof' is not an object` (`CanonicalGitBoundWorktreeRefusal`
is `undefined` on the reverted build) — itself valid, informative RED evidence, not a test bug. GREEN
(restored) passes all 43 checks (1 `SKIP` on win32 for the POSIX-only case). Tree restored byte-identical
for `bounded.ts` (confirmed by the script itself, not re-derived by hand).

## Round 3 (Code Review + QA) — correcting round 2's own "pre-existing" claim, then a SECOND Code Review

**3a. Round 2's own report wrongly called three failures "pre-existing."** A QA verifier ran the same
three tests on clean main with a fresh build, both env states: all three PASSED, 6/6 — directly
contradicting the round-2 claim. The round-2 negative-control run that produced that claim reverted
`bounded.ts` to round-1 HEAD, but **left `worktrees.ts` at its round-2 state** — so the RED phase's build
failed outright (a type mismatch between the two files), the test ran against a stale `dist/` left over
from an EARLIER successful build (round 2's own current, fixed code), and "RED passed" was really "ran
the fix against itself and called it the baseline." A negative control that reverts only ONE of two
interdependent files produces a build failure, not a clean revert — the resulting "RED" is uninformative,
and reading an uninformative RED as "proof of pre-existing" is exactly the failure mode
`a-control-inherits-the-equivalence-you-assumed-building-it` (project memory) warns about one level up.

The real root cause, found by running each test fresh (build first, env unset, one lane) and tracing the
exact failing assertion to a diff line: `resolveGitIdentityFallbackArgs` (`git/bounded.ts`) is the ONE
shared identity-fallback-probe helper used by every commit-creating path. Its DEFAULT `makeProbeGit`
parameter was a bare `canonicalGit` reference called with only 3 args, leaving `trustedMainRoot`
undefined — on a worktree `cwd` (every production call site), the probe's own `git var` read started
being REFUSED post-round-2, and `probeGitIdentResolvable`'s catch (by design) treated the non-identity-
shaped refusal as "resolvable," silently skipping fallback-identity injection — the real commit that
followed then failed with git's own "unable to auto-detect email address" on a host with no identity.
Two test fixtures (`canonical-git-isolation.mjs`'s `failingReset`, `merge-confirm-verdict-cache-union-
merge-transient.mjs`'s `proxyFailSecondMergeCall`) had the IDENTICAL bare-`canonicalGit(p, ms)`-pass-
through shape, independently. A first pass at all three fixes used the `"advisory-read"` opt-out — see
**3b** below for why a SECOND Code Review ruled that the wrong fix for this specific case.

**3b. A SECOND Code Review of 3a's own fix (commit `c0e33c8c`) came back NOT-MERGEABLE.** Its rulings,
each closed:

- **B2 (the identity-probe fix was the WRONG MECHANISM).** `"advisory-read"` is for call sites where a
  forged commondir costs nothing beyond a misleading READ. An identity-fallback decision is a judgment
  call made on behalf of a REAL commit that follows — worth protecting properly, not waving through.
  **Re-fixed:** `resolveGitIdentityFallbackArgs` gained a real `trustedMainRoot` parameter; when no
  `makeProbeGit` override is supplied (every production call site), the function now builds its own
  default probe THREADING it through properly, rather than applying the opt-out. Every production caller
  (`batch-merge.ts`'s cherry-pick-commit identity probe, `worktrees.ts`'s `attemptCodexAutoCommit`/
  `mergeMainIntoWorktree`'s owed-landing branch/`mergeBranchLocked`'s squash commit) now threads the real
  trusted root it already has in scope (`repoPath`/`deps.trustedMainRoot`), each wrapped in its own
  try/catch returning a FAIL-SAFE or FAIL-CLOSED result matching that function's own existing error
  posture (none of these six call sites previously had a surrounding try/catch for this specific await,
  so a bare re-throw would have propagated uncaught — closed at each site, not left to a distant handler).
  `vault/versioner.ts`'s own identity probe (`identityProbeVaultGit`) was confirmed UNAFFECTED: it
  constructs via `boundedSimpleGit` directly, never `canonicalGit`, so it never reaches
  `checkCommondirTrust` at all. ALSO: `probeGitIdentResolvable` itself now RE-THROWS a
  `CanonicalGitRefusal` rather than reading it as "resolvable" — so even a hypothetical future caller that
  forgets to thread a root fails CLOSED (the whole fallback decision aborts), never silently guesses.
- **B3 (the three fixtures needed REAL threading, not the opt-out either).** Re-fixed the same way:
  `canonical-git-isolation.mjs`'s `failingReset` became a factory-of-a-factory closing over each
  `rbWorld` call's own `repo`; `merge-confirm-verdict-cache-union-merge-transient.mjs`'s
  `proxyFailSecondMergeCall` closes directly over the already-in-scope `repo`. Both restore each
  fixture's documented intent (pass through normally; fail only on the injected call) via the SAME real
  verification path a production caller uses, not a bypass of it.
- **B1 (four MORE measured gaps in checkCommondirTrust itself, all closed):**
  - **P2** — a real directory at `<trusted>/.git/worktrees/evil` with no `commondir` file fell through to
    `{ok:true}` once proven under the trusted worktrees dir. Closed: a missing/unreadable `commondir` at
    that point now REFUSES — the round-2 "submodule/`--separate-git-dir` shape" fallback reasoning for
    that `{ok:true}` was already unreachable by that point (neither shape resolves under the trusted
    worktrees dir; the dirname check upstream would already have refused it), so the fallback was
    covering a case that could only be a worker-planted bare registry entry, never a legitimate one.
  - **P1/P7** — a worker could replace their OWN worktree's `.git` FILE with a DIRECTORY (a copy, or a
    junction to a decoy) and the round-2 code's directory branch, built for the MAIN checkout, would
    trust it. Closed: `.git` is now `lstat`'d FIRST — a symlink/junction refuses outright regardless of
    shape — and a DIRECTORY `.git` is only accepted when `trustedMainRoot` is given and `repoPath`
    actually IS it; otherwise refused.
  - **P4** — a MISSING `.git` fell through to `{ok:true}`, after which git's own repo discovery could walk
    UP to a planted parent `.git`. Closed two ways: a missing `.git` now refuses outright, AND
    `prepareCanonicalEnv` (every canonical call's env prep) now pins `GIT_CEILING_DIRECTORIES` to
    `repoPath`'s own parent (appended to any ambient value, OS-native list separator), bounding git's own
    discovery walk even for a call that somehow reaches git despite the first fix (e.g. a TOCTOU window
    between this check and the real spawn). **Round 4 correction (B-1): "refuses outright" was too broad
    — a project legitimately BOUND to a SUBDIRECTORY of its own repo (card 7673d096 names a live one) has
    no `.git` at `repoPath` by design, and this refused it unconditionally, breaking createWorktree AND
    mergeBranch for every such project. Fixed by {@link resolveTrustedToplevel} (`git/bounded.ts`): when
    `trustedMainRoot` is supplied, re-derive the toplevel by walking up from `repoPath` (never trust the
    caller's claim) and accept only an exact match; the ceiling pin is widened the same way, to
    `dirname(toplevel)` rather than `dirname(repoPath)`, when `repoPath` itself has no `.git`. See the
    round-4 section below for the fix's own residual and its B-2 sibling finding.**
  - **Named residual (not fixed, by design):** a WHOLESALE replacement of the trusted MAIN's own `.git`
    directory — deleted and recreated with doctored content, same DIRECTORY shape, no internal
    `commondir` — is invisible to this check. A redirect-style pointer check cannot catch a swap of the
    thing it would otherwise point AT; closing this needs a persisted identity pin (a stored first-commit
    sha, or similar) for the main checkout itself, a genuinely separate feature.
- **S1 (the strict parser over-refused a REAL, current git shape).** Round 2 refused every relative
  `gitdir` value outright — but git >= 2.48 can write a RELATIVE pointer (`worktree.useRelativePaths` /
  `--relative-paths`), a false refusal on real git output, not an attack. Fixed: a relative value now
  resolves against the `.git` FILE's OWN containing directory (matching git's `read_gitfile_gently`
  exactly), THEN goes through the same realpath/one-segment/lstat verification as an absolute value.
  Also pinned `-c worktree.useRelativePaths=false` on `createWorktree`'s own `worktree add` call (a
  defense-in-depth belt, since Loom's own worktrees should stay on the absolute-pointer shape it already
  measured and trusts, independent of whatever this check now also tolerates). **P6, also folded into S1:**
  the gitdir/commondir strip now removes ALL trailing CR/LF (a run of any mix/count), not just one
  line-ending sequence — a real, untouched `git worktree add` pointer file with one EXTRA trailing blank
  line still resolves correctly through real git, and round 2's single-line-ending strip wrongly refused
  it (left one `\n` embedded in the parsed value, tripping the embedded-CR/LF refusal).
- **S2 (win32 drive-less rooted pointer).** A gitdir value like `/proj/...` (absolute by POSIX convention,
  no drive letter) resolves against DIFFERENT drives depending on who's asking — Node against this
  process's own current drive, a spawned git child against its own. Fixed: on win32, an originally-
  absolute value with no drive letter or UNC root now refuses outright rather than guessing. (A relative
  value never hits this — it's anchored to `gitPath`'s own real, drive-qualified directory first.)
- **S3 (the blanket `boundedGit` opt-out was wrong AS STATED — it is now per-caller).** `boundedGit` now
  applies the `"advisory-read"` opt-out ONLY when a caller does NOT supply `deps.trustedMainRoot`; a
  caller that does gets the real verification instead. One caller needed exactly that: `computeEmitCompareGate`
  (`git/worktrees.ts`) decides whether the batch merge gate gets REDUCED (skips the runtime test suite)
  based on a diff read against the worktree — a forged commondir there could make Loom believe a
  malicious/broken diff is comment-only and wrongly reduce the gate. Its three callers (`sessions/
  service.ts`, the solo pre-wait/admission-time pair and the batch path) now thread the real
  `repoPath`/`finalRepoPath` as `trustedMainRoot`. The batch call site's edit is deliberately minimal — a
  concurrent in-flight card (`043d83d2`, worker `e3142df9`) is changing that same line's `"HEAD"` argument
  to a pinned sha; only the `trustedMainRoot` field was added. **Named, not fixed:** that same batch call
  site's underlying hazard — the batch worktree's own `HEAD` is worker-writable between gate admission and
  this read, independent of commondir — belongs to card `043d83d2`, not this one. **Also named as a
  residual:** `git/mainline-watch.ts`'s direct `canonicalGit` reads (no `trustedMainRoot`, unaffected by
  this card's opt-out mechanism either way) sit behind an UNCONDITIONAL fail-open contract on any git
  error (`docs/decisions/4fa36502-*.md`) — a planted commondir on the project's own bound repo would
  surface as a refusal there, silently absorbed as "check skipped (fail-open)," same as any other git
  failure that feature already tolerates. Not a new gap this card introduces; a pre-existing property of
  that feature's own design, now simply reachable through one more error shape.
- **S4 (the S1 honest-wording message could itself be exploited).** A worker could swap the trusted
  main's own DIRECTORY `.git` for a FILE specifically to turn what should be a loud commondir-redirect
  alarm into the S1 case's quieter, non-alarming "bound repo is a linked worktree" message. Fixed: that
  message now explicitly adds "If you did not intentionally bind this project to a worktree, treat this
  as a possible redirect and escalate to the Platform Lead to inspect the project's shared .git."
- **N1 (the EPERM finding's own cause was wrong).** Round 2 attributed a real `fs.writeFileSync` `EPERM`
  on a real worktree's `.git` pointer file to "an environment-specific write protection," framed as if
  the pointer resisted rewriting. **Corrected:** the cause is the Windows `Hidden` attribute git sets on
  every `.`-prefixed file it creates (confirmed via `Get-ItemProperty`) — `writeFileSync`'s
  `CREATE_ALWAYS`-style open fails on a hidden file; `fs.unlinkSync` then a fresh `writeFileSync` succeeds.
  These pointers are NOT protected in any security sense; a worker can unlink-then-rewrite one as easily
  as a fresh file.
- **N2 (two false claims in this record, both corrected in place above):** "every check below fails
  CLOSED… never falling through to `{ok:true}` on an unexpected shape" (round 2's own doc comment) was an
  overclaim — round 2 itself still fell through on the two shapes B1/P2 and B1/P4 just closed. "Every site
  this flip would newly fail closed was found by rebuilding and re-running the existing suite" (this
  record's own S2 section) was also false — that sweep is what MISSED `resolveGitIdentityFallbackArgs`'s
  own default construction and the two test fixtures, found only when the SECOND Code Review and a QA
  verifier looked past what the suite happened to already cover. Polarity-checked tests added for: the
  worktree-cwd identity probe on a fresh HOME (both the propagate-the-refusal case with no `trustedMainRoot`,
  and the correctly-threaded apply-the-fallback case); a DIRECTORY `.git` in a worktree with
  `trustedMainRoot` set (refuse); a `.git` junction (refuse, both shapes); a registry entry with no
  `commondir` (refuse); a missing `.git` (refuse); a relative pointer, both to the trusted dir (allow) and
  elsewhere (refuse); a drive-less pointer on win32 (refuse). See `test/canonical-git-commondir-refusal.mjs`.

**Verification run for 3a alone (committed at `40ca5749`, BEFORE the second Code Review below existed):**
`pnpm build`; the three originally-reported failures re-run fresh (rebuild, `env -u LOOM_HOME -u LOOM_PORT
-u LOOM_DEV -u LOOM_SUPERVISED`, one lane) — all PASS; plus `canonical-git-commondir-refusal.mjs` and
`canonical-git-helper-guard.mjs` re-run clean; `pnpm --filter @loom/daemon guards` — all 30 pass. **This
run predates 3b entirely and says nothing about it** — do not read it as covering the B1/B2/B3/S1-S4 fixes
above.

**3b/3c VERIFIED after the test hold lifted (commit `25986e91`, this round's own battery run).** The
named 110-file battery (canonical-git-*/merge-confirm-*/batch-merge*/git-askpass-explicit-env/spawn-
recut-stale-branch/mainline-watch*/the 5 same-shape files, one lane, fresh temp `LOOM_HOME` per file)
ran 107/110 green on the first pass. Two were REAL regressions this round fixed (not pre-existing):
`attemptCodexAutoCommit`'s own default `makeGit`/identity-probe construction requires a real
`trustedMainRoot` since round 2, and several fixtures (inside and outside the named battery) called it
bare, matching no real production caller; and `detectShallowCanonicalRepo`'s subdir-bound-repo fallback
(SF2/SF4 below) was broken by P4/the ceiling pin firing unconditionally — fixed by extending the
advisory-read opt-out to both. The third (`merge-confirm-slow-gate-pending.mjs`) was a battery-runner
env mismatch, not a real failure — re-run against a one-off isolated daemon, green. `pnpm --filter
@loom/daemon guards` — all 30 pass. The negative control (reverting `checkCommondirTrust`'s BODY only)
is recorded below with its exact, reproducible procedure (SF-2) — see that section for what went RED.

**3c. The five flagged files were each individually read and judged — not re-swept by grep alone.** Three
genuinely had the B3 bug shape (a bare `canonicalGit(p, ms)` reached with `p` = a real FILE-shaped
worktree `.git`, no `trustedMainRoot`); two did not (every bare call they make is reached with `p` = the
real trusted main itself, a DIRECTORY-shaped `.git` — which this card's fix never newly refuses when
`trustedMainRoot` is simply omitted, only when it's supplied and mismatched). **Fixed, same pattern as
3b's B3 (thread the real trusted main already in scope):**
- `branch-identity-ambiguity.mjs`'s `gitFactoryWithSymbolicRefFailure` — both `detectStrandedWork` and
  `attemptCodexAutoCommit` invoke it with `p` = the worktree; now takes a `trustedMainRoot` param,
  threaded from each of its four call sites (`repo2`/`repo`).
- `union-merge-transient-classification.mjs`'s `proxyAlwaysFailFfOnly` (two independent definitions,
  items (ii) and (iii)) — `mergeMainIntoWorktree`'s own `wtGit`/`killableCanonicalRaw` construction
  invokes it with `p` = the worktree; now threads `repo`.
- `worktree-gone-landing-unconfirmed.mjs`'s `unionMergeGitFactory` (scenarios (H) and (R) only — (O)'s own
  definition renames the worktree away and throws before ever constructing a real handle, so it never hits
  this shape) — the worktree genuinely still exists at the moment of construction in both; now threads
  `repo`.

**Checked, NOT fixed (no bug found — every bare call is reached with `p` = the real trusted main, never a
worktree):**
- `branch-identity-ambiguity-2.mjs`'s `spyFactory` (Section 8) — `computeEmitCompareGate`'s first
  argument is `repo` itself in this fixture (diffing via the main checkout's shared object database),
  never a worktree path.
- `worktree-add-container-race.mjs`'s `addGitFactory`/`removeGitFactory` — `createWorktree`'s own
  pre-add git ops and `removeWorktree`'s `unlock`/`prune` (via `killableCanonicalRaw(repoPath, ...)`) both
  run against the main repo, never the worktree being added/removed.
- `worktree-gone-landing-unconfirmed.mjs`'s `makeFaultedMatchFactory` — feeds
  `findLandedSquashCommit(repoPath, ...)`, always the main repo.
- `worktree-gone-landing-unconfirmed.mjs`'s `throwingFactory` (scenario (N)) — throws unconditionally
  before ever reaching the bare `canonicalGit(p, ms)` delegate when `p` is the worktree; that line is only
  ever reached with `p` = the main repo.

## Do not (round 3)

- Do not revert only ONE of two interdependent files in a negative control when both changed together —
  a resulting build failure is not a clean RED; it is uninformative, and must not be read as "pre-existing."
- Do not assume a shared, lower-level helper's call sites are all accounted for just because its own
  CALLERS were swept — `resolveGitIdentityFallbackArgs`'s OWN default probe construction was missed
  precisely because the sweep looked at `boundedGit`/direct `canonicalGit` callers, not at helpers that
  construct their OWN internal probe instance one level further down.
- Do not trust a test fixture's own `canonicalGit(p, ms)` construction to be a neutral pass-through just
  because it predates this card — any fixture built BEFORE the fail-closed default must be re-checked
  against it, the same as production code.
- Do not judge a fixture's `canonicalGit(p, ms)` call by its SHAPE alone (round 3c) — trace what `p` is
  actually bound to at the call site that reaches it. The identical-looking bare call is safe when `p`
  resolves to the real main (DIRECTORY-shaped `.git`, which this card's fail-closed default never refuses
  on an omitted `trustedMainRoot` — only on one supplied and mismatched) and broken when `p` resolves to a
  worktree (FILE-shaped). Two fixtures in the same file can carry this exact line and differ in exactly
  this one way — grep finds the line; only reading the call site finds which case it is.
- Do not reach for the `"advisory-read"` opt-out for an identity-fallback decision, or for any site
  whose output steers a REAL mutating call's own parameters (not just whether it runs) — reserve it for
  sites where a forged commondir costs nothing beyond a misleading READ; thread the real `trustedMainRoot`
  everywhere else, even when that means wrapping a previously try/catch-less `await` in one.
- Do not read a blanket per-HELPER opt-out (e.g. "every `boundedGit` caller") as permanent — key it on
  whether the SPECIFIC caller supplies its own `trustedMainRoot`, so a future caller that needs the real
  path (like `computeEmitCompareGate`) can get it without a second helper or a bypass of the first.
- Do not assume a Windows `EPERM` on a git-authored pointer file means the file resists tampering — it is
  the `Hidden` attribute colliding with `CREATE_ALWAYS`-style writes, not a protection; unlink-then-write
  (exactly what a worker would do) defeats it trivially.

## Round 4 (third Code Review — two Critical findings, both measured and fixed)

Found at `25986e91` by re-running the round-2/3 probe scripts plus two new ones under WSL. Fixed at
`33002582`.

**B-1 (Critical regression: every SUBDIR-BOUND project refused on spawn AND merge).** Loom supports
binding a project to a subdirectory of a repo (card `7673d096` names a live one). MEASURED:
`createWorktree(R/proj)` threw `".git" does not exist`, and `mergeBranch(R/proj)` refused the same way —
at the merge-base `ec0feb27` both work. Root cause: every site threading the BOUND repoPath as
`trustedMainRoot` (directly, or via a default that defaulted it to the bare `quarantineRepoPath`) made
the FILE-shape check look for `<subdir>/.git/worktrees`, which never exists for a subdir-bound project —
and, independently, P4's own "missing `.git` refuses" fired unconditionally on the subdir itself.

Fixed with the exact mechanism the reviewer specified:
1. `resolveTrustedToplevel(startPath)` (`git/bounded.ts`) — an fs-only helper that walks up from
   `startPath` (itself included) to the FIRST ancestor carrying a `.git`, requires it to be a plain
   DIRECTORY (never a FILE/symlink/junction) with NO `commondir` file, and returns its realpath, or a
   refusal naming why.
2. `checkCommondirTrust`'s P4 branch: when `trustedMainRoot` is supplied and `repoPath` has no `.git` of
   its own, re-derive the toplevel via step 1 (never trust the caller's claim) and accept ONLY an exact
   match against the supplied `trustedMainRoot`. `prepareCanonicalEnv`'s `GIT_CEILING_DIRECTORIES` pin is
   widened the same way — `dirname(toplevel)` instead of `dirname(repoPath)` — when `repoPath` itself has
   no `.git`, or the toplevel (which can sit exactly at `repoPath`'s own parent) would be hidden by the
   very ceiling meant to bound the walk.
3. `defaultTrustedMainRoot(p)` (`git/bounded.ts`) — resolves `p`'s own toplevel, falling back to `p` on
   failure (preserving the pre-existing refusal for a genuinely-not-a-repo path). `killableCanonicalRaw`'s
   own `trustedMainRoot` DEFAULT PARAMETER (previously `= quarantineRepoPath`, the single chokepoint
   behind most worktree-scoped mutating calls) now reads `= defaultTrustedMainRoot(quarantineRepoPath)`,
   fixing every caller that relies on the default in one place. Every EXPLICIT `trustedMainRoot: repoPath`
   site across `git/worktrees.ts`, `git/batch-merge.ts`, and `sessions/service.ts` (`boundedMergeGit`'s
   and `boundedDiffGit`'s own default factories, `resolveGitIdentityFallbackArgs` callers,
   `computeEmitCompareGate` callers, `attemptCodexAutoCommit`'s caller) was swept and re-pointed at
   `defaultTrustedMainRoot(repoPath)`.
4. **Named residual, NOT fixed here:** a worker-planted INTERMEDIATE `.git` directory between the bound
   subdir and the real toplevel is the first one `resolveTrustedToplevel` finds — for both the
   re-derivation above AND whatever the caller used to produce `trustedMainRoot` in the first place.
   Closing that needs a toplevel pinned ONCE at project-bind time (card `ec4afbe9`'s own mechanism), not
   a per-call fs walk; also recorded on that card's own body via `tasks_update appendBody`.
5. TEST: `canonical-git-commondir-refusal.mjs` (17) is a REAL, end-to-end `createWorktree` →
   commit → `mergeBranch` against a genuinely subdir-bound project path (never the repo root) — confirmed
   RED at `25986e91` by the reviewer's own `probe-subdir.mjs`/`probe-subdir2.mjs` (cited above), GREEN
   after. (12a)/(12b) were re-labelled to state they test the NON-BOUND (worktree-shaped, no ancestor
   `.git` at all) case; (12c)/(12d) are the new subdir-bound positive control (allowed on a match, refused
   on a mismatched `trustedMainRoot`).

**B-2 (Critical, new POSIX bypass in the round-3 relative-pointer branch).**
`path.resolve(dirname(gitPath), raw)` collapses a `..` segment TEXTUALLY before realpath ever runs, while
a POSIX kernel resolves `J/..` PHYSICALLY through whatever `J` actually is. MEASURED under WSL (real
`node`/`git`, not a simulation): `gitdir: J/../T`, with `J` a symlink to `E/sub` and `T` a symlink to a
legitimate worktree-registry entry, made the OLD lexical-resolve code compare `D/T` (legitimate, via the
non-physical path) while real git opened `E/T` (a planted decoy whose `commondir` points at an unrelated
repo) — `git log` on the decoy printed `"decoy"`, proving the bypass was real, not theoretical.

Fixed two ways, per the reviewer's spec: (1) `hasDisallowedDotSegment` refuses ANY `.`/`..` path segment
in the gitdir pointer's raw value OTHER than a leading run of `..` segments (the shape a real
`--relative-paths` pointer takes) — checked BEFORE any resolution. (2) the resolution itself no longer
calls `path.resolve()` at all for a relative value — it concatenates the raw string
(`${dirname(gitPath)}${sep}${raw}`) and lets `fs.realpathSync.native` do the ONE real, physical
resolution, so a symlink component (if it somehow reached this far despite (1)) resolves the same way a
real git child would. Windows has no equivalent hazard — a junction makes real git itself fail closed
(`fatal: not a git repository`), confirmed directly; the gate structurally cannot see a POSIX-only class
like this (card `4e762baf`'s own blind spot), which is why a POSIX-only test (SKIP on win32,
`canonical-git-commondir-refusal.mjs` (18)) is what actually exercises it — verified both ways under WSL.

**SF-1 (stale docs corrected, this round):** `CheckCommondirTrustOpts`' own doc now states advisory-read
ALSO skips P4 and the ceiling pin (not just the FILE-shape/no-trustedMainRoot case round 2 introduced
it for), and names its real call-site set (every `boundedGit`-backed no-trustedMainRoot caller, plus
`detectShallowCanonicalRepo`) rather than only the one site a prior pass singled out. The P4 narrative
above (this section) and the "3b/3c UNVERIFIED" line earlier in this record are both corrected to state
what was actually measured, not a stale prediction.

**SF-2 (exact, reproducible negative-control procedure).** The prior round's negative control was
described narratively only, and the reviewer could not reproduce it (a `--ref c0e33c8c` run failed `tsc`
and showed 10 FAILs, not 6, with no record of the exact commands run). This round's procedure, recorded
verbatim so it is mechanically reproducible, not just described:

```
git diff 25986e91 33002582 -- packages/daemon/src/git/bounded.ts packages/daemon/src/git/worktrees.ts \
  packages/daemon/src/git/batch-merge.ts packages/daemon/src/sessions/service.ts > /tmp/round4-src.patch
git apply -R /tmp/round4-src.patch   # reverts ONLY the 4 source files; the NEW test file (committed at
                                      # 33002582) stays as-is, so it runs against the OLD source
pnpm --filter @loom/daemon build     # tsc stays green — round 4 never removed an export
node packages/daemon/test/canonical-git-commondir-refusal.mjs
```

**Actual RED output (reverted source, current test file):**
- `FAIL  (12c) ALLOWS a genuinely subdir-bound project path when trustedMainRoot matches the walked-up toplevel`
- Section (17) does not print its own PASS/FAIL line at all — it CRASHES the process outright with an
  uncaught `CanonicalGitCommondirRefusal`: `"…17-bound-root\proj\.git" does not exist — refusing rather
  than letting git discover a DIFFERENT .git…"`, thrown from `canonicalRaw` → `killableCanonicalRaw` →
  `boundedLockedRaw` inside `createWorktree` — the EXACT shape of the original B-1 bug report.
- Every OTHER check (1-16, 12a/12b/12d, 13-16, wording) stays green — the revert is scoped to exactly
  the B-1/B-2 behavior, nothing else moved.

Restore: `git apply /tmp/round4-src.patch` (not `git checkout` — that would also discard the committed
test-file content if run against the wrong ref), rebuild, re-run — `git status --short` reports clean
(byte-identical to `33002582`) and the test file reports `0` `FAIL` lines.

**N-1 (named residual, no fix needed):** a FILE-shaped `.git` pointing at a SIBLING's own legitimate
worktree-registry entry passes `checkCommondirTrust` — nothing checks that `<entry>/gitdir` points BACK
at `repoPath/.git`. Not widened: that entry's own `HEAD`/working tree is worker-writable anyway (it is
just another worktree of the same project), so redirecting to it costs nothing a worker couldn't already
do by committing to that sibling worktree directly.

**Merge note:** card `043d83d2` (landing in parallel) changes the same `sessions/service.ts` batch
`computeEmitCompareGate` call's `"HEAD"` literal argument to a pinned sha — a DIFFERENT field on the same
call than this card's own `trustedMainRoot` change. Whichever lands second resolves the textual conflict
by keeping BOTH changes.

## Do not (round 4)

- Do not thread a bound project's bare `repoPath` as `trustedMainRoot` anywhere, even via a "obviously
  safe" default parameter — `killableCanonicalRaw`'s own `= quarantineRepoPath` default was exactly this,
  undetected until a real subdir-bound project hit it. Always resolve through `defaultTrustedMainRoot`/
  `resolveTrustedToplevel`.
- Do not `path.resolve()` a gitdir pointer's relative value before realpath — realpath the RAW
  concatenation instead, and refuse any `.`/`..` segment outside a leading `..` run as a SEPARATE,
  earlier check; relying on realpath's own correctness alone is not the posture this card takes anywhere
  else (see `hasDisallowedDotSegment`'s own doc for why both layers exist).
- Do not assume a Windows-only measurement closes a POSIX-only hazard class — a junction failing safe on
  Windows says nothing about a real symlink on POSIX; verify under WSL/ubuntu CI directly, as this round
  did, rather than inferring from the Windows result.
- Do not treat `resolveTrustedToplevel`'s result as a PINNED fact across calls — it is a fresh, per-call
  fs walk with no persisted identity, and is exactly as vulnerable to a planted intermediate `.git` as the
  caller's own pre-existing trust decision was; do not let a future card quietly treat it as equivalent to
  `ec4afbe9`'s own pinned-at-bind-time mechanism before that mechanism actually exists.
- Do not restate the live advisory-read call-site set inline anywhere new — grep
  `commondirCheck: *"advisory-read"` / `BOUNDED_GIT_ADVISORY_READ`, per `CheckCommondirTrustOpts`' own
  doc; a restated list is exactly how SF-1's staleness happened the first time.

## Round 5 (fourth Code Review's B-1/B-2 proven vacuous; a durable pin replaces the per-call walk)

**Why round 4's mechanism had to be deleted, not patched again.** The fourth Code Review's own probe
scripts showed round 4's fix was not merely incomplete (the already-fixed B-1 subdir regression) but
*structurally unable to check anything*: `defaultTrustedMainRoot(p)` and `checkCommondirTrust`'s own P4
re-derivation both called the SAME `resolveTrustedToplevel(p)` on the SAME input, so the "does the walk
match `trustedMainRoot`" comparison could never fail — for ANY `repoPath`, subdir-bound or not. The
reviewer's own "DECOY-PARENT" case proved this directly: an arbitrary, never-configured subdirectory
sitting inside a real repo passed `checkCommondirTrust` exactly as readily as a genuinely subdir-bound
project did, because both walks started from the identical (and, in a real attack, identically
attacker-controlled) starting path. S-1 (`resolveTrustedToplevel` realpaths `startPath` before walking,
so a bound subdir swapped for a symlink to a decoy repo passes) is the SAME defect wearing a different
hat: the walk's own starting point can be swapped, and comparing a walk to a second walk of that same
swapped point can never catch the swap. Ruling (lead gen 440): *a per-call fs walk cannot be a trust
source*; the subdir-vs-root fact must come from DURABLE data, recorded where a worker can't steer it, and
read inside the shared chokepoint rather than remembered per caller.

**The fix: a durable `CommondirTrustPin` per (project, repoKey)**, recorded at project BIND/REBIND time
(`Db.insertProject`/`Db.updateProject`, reusing `updateProject`'s existing `resetMainlineBaselinesForRepoChange`
per-repoKey diff loop rather than adding a second one) or, for a binding that predates this feature, a
one-time idempotent boot BACKFILL (`Db.backfillCommondirTrustPins`, called from `index.ts` right after
`new Db()`, before anything that could issue a canonical git call). No new table or column — the pin
rides the existing `app_meta` key/value store (`commondir-trust-pin:<literalRepoPathKey(repoPath)>`),
exactly like the mainline watermark/branch-trust facts already do, so there is no migration to reason
about. The LOOKUP KEY is a **pure string** transform of the literal configured `repoPath`
(`literalRepoPathKey`, `git/repo-lock.ts` — `path.resolve` + trailing-separator strip + win32
lowercasing, with **no filesystem call of any kind**) — never a walk-derived key like
`canonicalRepoLockKey`. This is the one property that makes the whole design sound: a worker who swaps
`repoPath` (or an ancestor) for a symlink cannot change WHICH pin row a lookup finds, because the key
never touched the filesystem to begin with; only the separate, explicit live-verify step below can be
affected by the swap, and that step only ever REFUSES on a mismatch, never accepts a different pin
vacuously. A small per-(project, repoKey) index (`commondir-trust-pin-index:<projectId>:<repoKey>` →
the literal path) lets a rebind/delete retire the right pin row without a full-table scan;
`Db.deleteProject` walks this project's own index rather than a `LIKE '<prefix>${id}:%'` sweep (the pin
itself can't be swept that way, since it's keyed by path, not projectId).

**Resolution lives in the shared chokepoint, not per caller.** `git/bounded.ts` exposes
`registerCommondirTrustPinLookup(fn)` — a module-level settable slot (the production-use counterpart of
the existing test-only `setWinJobLauncherOverrideForTest` pattern), wired to `db.getCommondirTrustPin` by
`index.ts` at boot. This is deliberate: a direct `Db` import INTO `git/bounded.ts` would cycle
(`db.ts` → `git/worktrees.ts`/`git/mainline-watch.ts` → `git/bounded.ts` → `db.ts`), and this breaks it
without constraining `Db`'s own layering. An unregistered resolver (a test that never calls it) means "no
pin ever found" everywhere — fails CLOSED for a subdir-bound repo, a pure no-op for every ordinary repo
whose `.git` sits directly at `repoPath` (the overwhelming majority of calls, completely unaffected).

**`checkCommondirTrust` consults the pin UNCONDITIONALLY, before any shape dispatch — manager amendment 1
on this round's design, closing a bypass the pin-only-on-missing-`.git` design (as first proposed) left
open.** Without this, a worker could plant a `.git` directly AT an already-pinned subdir path (or at an
INTERMEDIATE ancestor between the pinned subdir and its real toplevel): `repoPath` would then "have its
own `.git`" from the shape-dispatch's point of view, skip the missing-`.git` branch entirely, and fall
into the pre-existing DIRECTORY-shape logic — which, with no caller-supplied `trustedMainRoot` to disagree
with (every affected caller passes none), would have accepted it. The fix: at the very top of
`checkCommondirTrust`, look up the pin for `repoPath`; if one exists, the live toplevel
(`resolveTrustedToplevel(repoPath)`, re-purposed from "trust source" to "verification against an
independent anchor") MUST equal it exactly, or the call refuses (`kind:"redirect"`) — this single gate
runs regardless of whether `.git` is missing, a directory, or a file, and regardless of whatever
`trustedMainRoot` the caller passed (which plays NO role once a pin exists). Only when NO pin exists at
all does execution fall through to the pre-existing shape-dispatch logic, unconditional-pin-exists aside,
byte-for-byte as before — including `opts.commondirCheck:"advisory-read"`'s existing permissive branches,
which are reached ONLY in that no-pin case now (a mismatch against an EXISTING pin always refuses, even
under advisory-read — there is something to verify against now, so the "nothing to compare" rationale for
that opt-out no longer applies).

Test cases (manager-specified): a `.git` planted directly AT an already-pinned subdir refuses; a `.git`
planted at an intermediate ancestor between a pinned subdir and its real toplevel refuses (both close the
"intermediate planted `.git`" residual round 4 named — see the next paragraph for the scope of that
closure). `defaultTrustedMainRoot(p)` gets the parallel treatment for its OWN purpose (supplying a
comparison anchor to the pre-existing FILE-shape/worktree logic for a subdir-bound `quarantineRepoPath`):
when `p` has no own `.git`, it now consults the SAME pin+live-verify helper
(`liveToplevelMatchesPin`) instead of a bare walk, falling back to `p` unchanged on no-pin-or-mismatch
(the same "ends in a downstream refusal" contract it always had).

**Scope of the "intermediate planted `.git`" residual's closure (manager amendment 2) — and S-1's symlink
form belongs in the SAME paragraph, not a separate one.** With the unconditional pin-first gate above, the
residual round 4 named ("a worker-planted INTERMEDIATE `.git` directory... is the first one
`resolveTrustedToplevel` finds, for both the re-derivation above AND whatever the caller used to produce
`trustedMainRoot`") is CLOSED for any (project, repoKey) that has ALREADY been pinned — a plant anywhere
along the walk, at the bound path itself or any ancestor short of the real toplevel, now produces a live
toplevel that disagrees with the durable pin and refuses, rather than being silently absorbed into
whatever `trustedMainRoot` a caller happened to compute the same way. S-1's symlink-swap ("a bound subdir
swapped for a symlink to a decoy repo") is the SAME closure, not a different one: the pin is recorded
BEFORE a swap can exist, so a later swap is caught by the identical live-vs-pin mismatch, for the identical
reason an intermediate plant is. **The only window this does NOT close is trust-on-first-use, strictly
BEFORE a repo's first pin exists** — the moment of the original project bind, or (for a binding that
predates this feature) the one-time boot backfill. At that moment, the walk establishing the pin has
nothing durable to verify itself against either, so a repo already compromised at that exact instant
(before any worker could legitimately exist for a fresh bind; at ANY prior point for a backfilled one)
pins the compromised state as if it were trustworthy. This is why `backfillCommondirTrustPins` files its
own durable `commondir_trust_pinned` event and is documented, here and in card `ec4afbe9`'s own triage
note, as recording trust-on-first-use — never a pre-attack-verified baseline.

**S-3 correction (fifth Code Review): the TOFU window is WIDER than "the moment of the original bind" as
first written above — state it exactly, not generously.**

- A **fresh bind** (`Db.insertProject`) genuinely is TOFU only at THAT instant, before any worker can
  exist for the new project — the strong case. A **REBIND** (`Db.updateProject`) is NOT the same strength:
  checkRepoRebind's own guard only blocks while a LIVE WORKTREE SESSION of *that* project exists — it says
  nothing about the target path's own history, and workers are **not filesystem-sandboxed**. A rebind to a
  path some OTHER project's worker has write access to (or had, at any point before now) pins whatever
  that path currently looks like, with no check that it is clean — the rebind TOFU window is "since
  whenever this path last had no untrusted writer," not "since this project's own workers started."
- The boot backfill is **not one-time** in the sense that phrase usually implies. It is idempotent (skips
  anything already pinned), but it RE-RUNS, and re-pins, on **every** boot — any (project, repoKey) that
  is STILL missing a pin (a walk failure at bind time that was never retried, a pin row lost some other
  way) gets a FRESH trust-on-first-use moment at THAT boot, however many months after the feature shipped.
  "One-time" describes each individual pin's own TOFU moment, never the backfill PASS as a whole, which
  has no end.
- `pinCommondirTrust` (the one write path both bind and rebind call) **OVERWRITES** whatever pin already
  sits at that literal key — it never reads the existing value first and compares. A rebind to a path that
  already carried an (unrelated, possibly stale or compromised) pin from some earlier context replaces it
  silently with whatever the walk finds NOW; nothing here ever asks "does this agree with what was here
  before."

None of this is a bug this round introduces by omission — it is the honest shape of "pin what a trusted
walk found, once, where nothing durable existed yet to compare against." Two follow-ups the manager is
filing separately (no ids assigned at the time of this writing — do not invent any): (1) a HUMAN-initiated
re-pin route (so a suspected-stale pin can be deliberately re-established, verified, rather than only ever
silently overwritten by the next ordinary bind/rebind) with its own distinct mismatch wording, separate
from an ordinary bind/rebind's silent overwrite; (2) per-project pin OWNERSHIP, so a rebind's overwrite (and
a cross-project path collision) can be reasoned about and refused rather than silently accepted.

**`identity` field: considered, dropped (manager amendment 3).** An earlier draft of `CommondirTrustPin`
proposed storing both `toplevel` (the realpath found at pin time) and a separate `identity` field (a
`canonicalRepoLockKey`-style case-folded form of the same path) "because the codebase already has an
identity concept, reuse it." On review: `identity` as proposed was never independently VERIFIED anywhere
— only `toplevel` is ever compared against the live walk — so storing it would have been exactly the
"unchecked field that reads as a verified fact to the next reader" trap. Dropped entirely rather than
wired up: `CommondirTrustPin` carries `{toplevel, pinnedAt, source, projectId, repoKey}`, nothing else.

**Event-kind set (manager amendment 4).** `commondir_trust_pinned` is a new `OrchestrationEventKind`
(`packages/shared/src/types.ts`), deliberately audit-only — same bucket as `codex_auto_commit` — and
deliberately excluded from `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/`ORCH_ACTIVITY_KINDS`/
`REPORT_RESOLVED_EVENT_KINDS`. Checked (not merely added) against every place that pins or renders the
FULL kind set: `ORCHESTRATION_EVENT_KIND_MEMBERSHIP`'s `Record<OrchestrationEventKind, true>` (compiler-
enforced — the build itself fails if a union member is missing here, which is how this was caught before
any test ran), `ALL_ORCHESTRATION_EVENT_KINDS` (derived from that map, so automatically correct — no test
exists that pins an exhaustive count or list of it), and the web UI's own `OrchestrationEventKind`
consumers (`packages/web/src/lib/api.ts`, `pages/Settings.tsx`) — neither has an exhaustive switch needing
a new case.

## Do not (round 5)

- Do not re-derive `trustedMainRoot` by walking the filesystem anywhere this card touches, even "just to
  compare against the pin" — a walk compared to another walk of the same input (round 4's own mechanism)
  can never fail; the pin is the trust source, the walk is only ever verification against it.
- Do not key the commondir-trust-pin lookup by anything derived from a filesystem walk
  (`canonicalRepoLockKey` or similar) — the lookup key must be a PURE STRING transform of the literal
  configured path (`literalRepoPathKey`), or a worker who swaps the path changes which pin row is found,
  reopening the exact vacuity round 5 exists to close.
- Do not let `opts.commondirCheck:"advisory-read"` bypass a MISMATCH against an existing pin — it may
  only ever restore the old "nothing to verify against" permissiveness for the no-pin case; a real,
  detected mismatch against a durable pin refuses unconditionally, read-only call site or not.
- Do not store an `identity` (or similarly-named) field on `CommondirTrustPin` unless it is also
  independently verified somewhere — an unchecked field reads as a verified fact to the next reader (see
  the dropped-`identity` paragraph above).
- Do not reach for `Db.insertProject`/`updateProject`'s own `p.repos`/`before.repos` without the `?? []`
  fallback the pre-existing SQL-param code already used — a hand-built `Project` literal omitting
  `repos` (a long-standing, common test idiom in this repo) is otherwise a crash, not a type error, since
  these are plain `.mjs` test files with no compile-time check.
- Do not file `commondir_trust_pinned` per (project, repoKey) backfilled — ONE summary event per boot
  pass that actually backfilled anything, naming every pin in its `detail`, mirrors how this residual is
  meant to be reviewed (a single "this boot trusted N pre-existing bindings on first use" fact), not N
  near-identical rows.
- Do not read a backfilled pin's `source:"boot-backfill"` as equivalent in strength to `"bind"`/`"rebind"`
  — only the latter two are established before any worker could have touched the repo under Loom's own
  control; a backfilled pin is trust-on-first-use, by design, forever (its `source` never gets upgraded
  later).
- Do not read a `"rebind"`-sourced pin as equivalent in strength to a `"bind"` one either (S-3) — a
  rebind's own TOFU moment is bounded only by `checkRepoRebind`'s live-worktree-SESSION check on the
  rebinding project, never by the target path's history under some OTHER project's worker, which is NOT
  filesystem-sandboxed away from it.
- Do not describe `backfillCommondirTrustPins` as "one-time" without qualifying WHICH thing is one-time
  (S-3) — the PASS re-runs every boot; only an individual (project, repoKey) pin's own TOFU moment is a
  single instant, and that instant can be any boot, not just the first one after this feature shipped.
- Do not read `pinCommondirTrust`'s write as a verify-then-write (S-3) — it is an unconditional overwrite
  of whatever pin already existed at that literal key; a rebind onto a path carrying an unrelated prior
  pin replaces it with no comparison at all.
