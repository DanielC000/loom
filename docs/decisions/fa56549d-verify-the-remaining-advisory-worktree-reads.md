# fa56549d — verify the remaining advisory worktree reads; surface a refusal distinctly; rule on precheckWorkerDone's polarity

Follow-up from `b4cc7114` (`docs/decisions/b4cc7114-worktree-gc-and-stranded-work-commondir-redirect.md`),
whose own "Deferred" section named three remaining advisory-read gaps on the canonical git path and left
them explicitly out of scope. This card closes all three, each ruled on by the manager before implementation
(see the card body / worker_report history for the full investigation this record compresses).

## Do not

- Do not change `worktreeHasWork`'s signature or return type to add the refusal signal — it has ~15
  existing boolean-returning callers/tests. Add a detailed SIBLING (`worktreeHasWorkDetailed`, returning
  `WorktreeWorkCheck`) and reduce `worktreeHasWork` to a thin wrapper over it instead.
- Do not set `WorktreeWorkCheck.verificationRefused` / `RetainedWorktreeEntry.verificationRefused` for an
  ordinary error/timeout or a missing/unreadable branch (a clean `resolveBranchTip` null) — ONLY for
  `e instanceof CanonicalGitRefusal`. Conflating the two defeats the entire point: a detected tampering
  attempt must never look identical to ordinary flakiness.
- Do not flip `precheckWorkerDone`'s fail-safe polarity to REFUSE on a classified refusal. Decision
  `907b9f50` is a specific, previously-reviewed ruling for this exact function with no classified/ordinary
  carve-out ("must degrade to the ALLOW result, never to a refusal"). The real data-loss protection for a
  genuinely dirty worktree under a redirected commondir is independent and already fixed: `finalizeMerge`'s
  own worktree teardown uses ONLY `readWorktreeUncommittedState` (`b4cc7114` threaded `trustedMainRoot`
  into it and it fails to `state:"unknown"` — not `"clean"` — on a classified refusal), and `gcWorktreeDir`'s
  one real caller already retains on any `state !== "clean"`. A false ALLOW here is therefore bounded to a
  worse done-report message, never a lost worktree — do not "fix" this by wedging the worker instead.
- Do not route `classifyRetainedWorktree`'s read through anything but the shared `canonicalGit(...,
  defaultTrustedMainRoot(repoPath))` construction (matching `worktreeHasWork`/`precheckWorkerDone`) — a
  second, bespoke trust check is how these sites drift from each other.
- Do not widen `mergeMainIntoWorktree`'s fix beyond its shared `makeGit` factory (plus the one-off
  `commitTreeGit`) on the theory that the post-mutation verify reads need separate treatment — they don't;
  see "Item 2" below for why the existing catch-alls at every one of those sites are already correct.
  ⚠️ **PARTIALLY SUPERSEDED (round 2, SF1) — "already correct" was true for SAFETY/polarity (no catch's
  fail direction needed to change) but FALSE for WORDING at one site: the `ls-files --unmerged` conflict
  check runs on the SUCCESS path too, not just failures, so its old bare "failed to inspect worktree merge
  state" text could misdescribe an ACTUALLY-LANDED merge as a failure. See "Round 2" below.**

## Round 2 (Code Review, verdict SHIP, pre-merge fixes)

- **SF1 (the per-site table's `ls-files --unmerged` row was wrong).** That read is reached on EVERY
  plain-merge attempt, success included (anything that isn't the `isConfirmedKillTimeout`-and-
  `verifyUnionLanded` early return falls through to it) — not only a non-timeout failure path, as the
  table originally said. The reviewer's own repro (injecting a `CanonicalGitRefusal` on this read right
  after a REAL, successful union-forward) confirmed: pre-fix, a landed merge was reported
  `{ok:false, reason:"failed to inspect worktree merge state: ..."}` — safe (the caller rejects
  `union_merge_failed` and a re-confirm is idempotent via the merge-base early-return) but misleading.
  Fixed: the catch now says the union MAY ALREADY HAVE LANDED (mirrors `readMergeHead`'s own sibling
  wording), and routes a SPECIFIC classified kind (commondir redirect / pin mismatch / bound-worktree /
  unpinned) through `canonicalFailureMessage` for its real escalation guidance — but a BARE/ordinary
  refusal (the reviewer's own repro shape) gets the landing-aware fallback DIRECTLY, never
  `canonicalFailureMessage`'s generic "refused, nothing changed" default, which would be false here.
- **SF2 (`precheckWorkerDone` lost the zeroAhead/aheadCount signal on a refusal).** Round 1 returned EARLY
  from check (1)'s catch, skipping check (2) entirely — but check (2) reads `repoPath` (the main repo),
  never the worktree, so it is UNAFFECTED by a worktree-commondir redirect. Returning early threw away a
  perfectly-readable signal, including the no-commit role's auto-retire (which depends on `zeroAhead`).
  Fixed: check (1)'s catch no longer returns — it falls through to check (2). `DoneReportPrecheck` gained
  an optional `verificationRefused?: boolean` (set when check (1) was refused), threaded onto every return
  path including check (2)'s, and the caller (`service.ts`'s `workerReport`) appends a short note to its
  existing zeroAhead-warn-only `warning` string when set — named cheaply, no new branch.
- **NIT1 (thread one resolved `trustedMainRoot` into both reads and mutations).** `mergeMainIntoWorktree`'s
  reads used `deps.trustedMainRoot ?? defaultTrustedMainRoot(repoPath)` while its `killableCanonicalRaw`
  mutating calls left `trustedMainRoot` at its own default (`defaultTrustedMainRoot(quarantineRepoPath)`,
  ignoring `deps.trustedMainRoot` entirely) — identical today only because no real caller ever sets
  `deps.trustedMainRoot`. Fixed: resolved ONCE (`resolvedTrustedMainRoot`) and threaded into the shared
  `makeGit`, the one-off `commitTreeGit`, and all 5 `killableCanonicalRaw` call sites in this function.
- **NIT2 (the word "commondir" was used for ANY classified refusal, not just a real redirect).**
  `verificationRefused`'s accompanying warnings (`WorktreeWorkCheck`/`RetainedWorktreeEntry`/Pass B's log/
  `precheckWorkerDone`'s log) all said "commondir" unconditionally. Fixed: a new shared
  `classifiedRefusalKindText(e)` (exported from `git/worktrees.ts`) distinguishes an actual
  `CanonicalGitCommondirRefusal` ("a redirected commondir") from any OTHER classified kind ("a classified
  git refusal") — `verificationRefused` itself still stays `true` for ANY classified refusal (fails safe
  unconditionally), only the accompanying TEXT is now honest. `WorktreeWorkCheck` and
  `RetainedWorktreeEntry` both gained an optional `refusalDetail?: string` naming WHICH probe refused
  (worktree dirty-tree vs main-repo ahead-count) plus the kind, via this helper.
- **NIT3 (scenario 7 asserted only `ok===false`).** Added an assertion that `result.reason` actually names
  the CLASSIFIED redirect (`/redirect/i`), not merely a generic/unrelated failure — distinguishes the real
  merge attempt's own trust-check refusal from any other reason that could also produce `ok:false`.

New test: scenario (9) in `worktree-commondir-redirect-gc.mjs`, adapted from the reviewer's own repro
script — injects the SAME fault (a `CanonicalGitRefusal` on `ls-files --unmerged`) after a REAL successful
union-forward, asserts the honest "may have already landed" wording, then re-confirms with no injection
and asserts `ok:true, merged:false`, HEAD byte-unchanged by the retry (idempotent). Scenario (6)'s
assertions were split per SF2 (ALLOW and zeroAhead/aheadCount asserted independently, so a RED on one
doesn't hide behind a passing AND). Scenario (7) gained the NIT3 reason assertion. All new/changed
assertions RED-proven against the round-1 committed state via `negative-control --ref HEAD` (default), not
just reasoned about — see the corresponding `worker_report` for exact output.

## Item 1 — the retained-worktrees surface hid a refusal

`worktreeHasWork` returned a bare boolean, so boot-reconcile Pass B's own log line unconditionally said
"holds unmerged/uncommitted work" even when the true cause was a classified commondir-trust refusal, not
real work. Separately, `classifyRetainedWorktree` (the lazy, read-time re-derivation `getRetainedWorktrees`
uses) read the worktree through `this.boundedGit` — `sessions/service.ts`'s own private helper, a plain
`boundedSimpleGit` construction with NO commondir check at all, unlike `git/worktrees.ts`'s exported
`boundedGit`. A believable decoy (same construction the `b4cc7114` investigation already measured against
`worktreeHasWork`'s dirty-tree probe) could therefore make `classifyRetainedWorktree`'s own dirty-tree read
agree "clean", and — if the worktree's real retained reason was dirty-tree rather than unmerged-commits —
both of its probes would then agree "no longer holds work", silently dropping it from `getRetainedWorktrees`.
Not data loss (Pass B's own GC decision, the one thing that actually deletes anything, is untouched and
still keeps the worktree every boot) — but invisible to the one human-facing surface that reports it.

**Fix:**
1. `worktreeHasWorkDetailed` (new, `git/worktrees.ts`) returns `{hasWork, verificationRefused?}`;
   `worktreeHasWork` is now a thin wrapper (`(await worktreeHasWorkDetailed(...)).hasWork`) — byte-identical
   contract for every existing caller. `verificationRefused` is set only on the two existing catches that can
   now see a classified refusal (the worktree-scoped dirty-tree probe, and the repo-level ahead-count probe)
   when `e instanceof CanonicalGitRefusal`.
2. Pass B (`sessions/service.ts`'s `reconcileOrchestrationOnBoot`) switches to `worktreeHasWorkDetailed` and
   branches its `console.warn` wording on `verificationRefused` — still KEEPS the worktree either way (no GC
   policy change), only the log text differs.
3. `classifyRetainedWorktree`'s dirty-tree read now constructs via `canonicalGit(worktreePath, timeoutMs,
   undefined, undefined, undefined, defaultTrustedMainRoot(repoPath))` instead of `this.boundedGit` — its
   existing catch-all already failed safe to `dirty = true` on ANY error, so a classified refusal now
   correctly keeps the worktree on the surface (never silently dropped), and additionally sets a new
   `verificationRefused: true` on its return when `e instanceof CanonicalGitRefusal`.
4. `RetainedWorktreeEntry` gains an optional `verificationRefused?: boolean` field (omitted, not `false`,
   when not refused), threaded through by `getRetainedWorktrees`. The ONLY surface returning this type is
   `GET /api/worktrees/retained` (`gateway/server.ts`) — human/REST-only, never an MCP tool.

**Response-surface check (per the manager's explicit ask):** ran the four CLAUDE.md-named response-key-set
guards (`worker-status-projection-guard.mjs`, `entity-row-fields-guard.mjs`,
`agent-session-full-field-guard.mjs`, `platform-config-redaction-drift.mjs`) — none references
`RetainedWorktreeEntry`, `getRetainedWorktrees`, or `/api/worktrees/retained` at all; they cover unrelated
surfaces. Grepped the whole test corpus for `RetainedWorktree|worktrees/retained` — four files reference it
(`concurrency.mjs`, `porcelain-lossless-parse.mjs`, `worktree-retained-backlog.mjs`,
`worktree-review-base-reclaim.mjs`); none pins an exhaustive key set (`Object.keys` or similar) — they only
assert specific `reason`/`commitsAhead` values. **None pins it.** Adding the new optional field is therefore
additive with zero existing-test blast radius; `worktree-commondir-redirect-gc.mjs` gained new scenarios
asserting the field directly (see "Tests" below).

## Item 2 — `mergeMainIntoWorktree`'s advisory reads, widened scope

The card named two sites (the merge-base early-return, the owed-landing `commit-tree` write). Investigation
found these are not independent: BOTH are fed by the SAME shared `makeGit` factory that also constructs
`wtGit`, which is reused for every other worktree-scoped read in the function — the owed-landing branch's
own `tip`/`tipTree`/`mainIsAncestor` pre-checks, and every post-mutation verify read (`verifyOwedLanded`,
`verifyOwedCleanAt`, `verifyUnionLanded`, `verifyWorktreeCleanAt`, `readMergeHead`, the HEAD^2 check, the
`ls-files --unmerged` conflict check). A single edit — dropping `BOUNDED_GIT_ADVISORY_READ` from `makeGit`
and threading `deps.trustedMainRoot ?? defaultTrustedMainRoot(repoPath)` instead — covers all of them, plus
the separate one-off `commitTreeGit` construction got the same treatment.

**Per-site table — every site now verified, and what a refusal there DOES:**

| Site (line, current) | Phase | Catch behavior on a NEW classified refusal | Retry? | Could a LANDED merge be reported failed/re-attempted? |
|---|---|---|---|---|
| `wtGit.raw(["merge-base",...])`, merge-base early-return (~9523) | PRE-mutation | Caught by the blanket `catch { /* fall through */ }` — falls through to attempt the REAL merge via `killableCanonicalRaw` (already `trustedMainRoot`-protected) | N/A (the "retry" here is the real merge attempt itself) | No — nothing has landed yet at this point; falling through either lands a real (idempotent, "already up to date") merge or refuses cleanly if the SAME redirect also defeats `killableCanonicalRaw`'s own check |
| `wtRaw` — `tip`/`tipTree`/`mainIsAncestor` (owed-landing pre-checks, ~9570-9577) | PRE-mutation (owedBase path) | Caught by the owed-landing outer `catch`, classified via `describeGitFailure`/`canonicalFailureMessage` → `{ok:false, reason, transient?}` | No | No — nothing has landed; this is a clean, earlier refusal (previously this read would have silently succeeded against the decoy and planted a wrong `commit-tree` object, caught only later at the `--ff-only`) |
| `commitTreeGit.raw(["commit-tree",...])` (~9596) | PRE-mutation (owedBase path) | Same outer catch as above → `{ok:false, reason, transient?}` | No | No — `commit-tree` only ever writes a dangling object; nothing lands until the later, already-protected `--ff-only` |
| `verifyOwedLanded` (~9612) | POST-mutation, confirmed-kill-timeout only | `catch { return false; }` → "not confirmed landed" | Possibly (gated on `attempt===1` + `verifyOwedCleanAt`) | No — a retry here re-runs `merge --ff-only <commit>`, which is a no-op ("already up to date") if the merge genuinely already landed; this is PRE-EXISTING retry-safety, unchanged by this fix |
| `verifyOwedCleanAt` (~9617-9618) | POST-mutation, confirmed-kill-timeout only | `catch { return false; }` → "not verified clean" → retry SKIPPED, falls to the non-retry refusal | No (this IS the retry gate) | No — skipping the retry on an unverifiable state is the conservative direction; it reports a refusal, never a false pass |
| `verifyUnionLanded` (~9679) | POST-mutation, confirmed-kill-timeout only (plain-merge path) | `catch { return false; }` → falls through to the conflict/`mergeThrew` handling below | N/A | No — same reasoning as `verifyOwedLanded` |
| `verifyWorktreeCleanAt` (~9685,9689-9690) | POST-mutation, confirmed-kill-timeout only (plain-merge path) | `catch { return false; }` → retry SKIPPED | No (retry gate) | No |
| `readMergeHead` (~9734) | POST-mutation, already-landed cleanup | `catch (e) { return {state:"unreadable", error} }` — ALREADY fail-closed for ANY error (not just a classified refusal): the caller returns `{ok:false, reason:"...MERGE_HEAD could not be read..."}` rather than a silent `ok:true` | No | No — this path is reached only AFTER `verifyUnionLanded`/`verifyOwedLanded` already confirmed the merge landed; refusing to confirm cleanup never un-lands it, it just reports the ambiguity honestly |
| HEAD^2 check (~9751) | POST-mutation, already-landed cleanup | `catch { /* leave MERGE_HEAD in place */ }` — the subsequent re-read of `readMergeHead` still fires and decides the outcome | No | No |
| `ls-files --unmerged` conflict check (~9793) | **POST-mutation, EVERY plain-merge attempt — success INCLUDED** (reached whenever the `isConfirmedKillTimeout`+`verifyUnionLanded` early return doesn't fire; round 1 wrongly scoped this to "non-timeout failure" only) | **(round 2, SF1)** `catch (e) { ... }` now words the fallback as "the union of main may have already landed" (mirrors `readMergeHead`'s sibling wording) and routes a SPECIFIC classified kind through `canonicalFailureMessage`; a bare/ordinary refusal gets the landing-aware text directly | No | **YES, possible** (this is exactly what SF1 found): a refusal here CAN follow an ACTUALLY-LANDED merge, reported as `ok:false` — safe (the caller rejects cleanly and a re-confirm is idempotent via the merge-base early-return, proven in test scenario 9) but, pre-round-2, misleadingly worded as a bare "failed" |

**Round 1 claimed none of these catches needed to change — true for every site's SAFETY/polarity (none
needed its fail direction flipped), false for one site's WORDING: the `ls-files --unmerged` catch, fixed in
round 2 (SF1) — see the table row above and "Round 2" below.** The two PRE-mutation sites (the early-return
and the owed-landing pre-checks) are where the actual SECURITY behavior visibly changes: pre-fix, an
unverified read against a redirected worktree could silently trust a wrong answer (the actual bug — "a
wrongly skipped union-forward", per the card); post-fix, that same redirect is detected and refused before
it can mislead the function, at the cost of refusing to proceed at all for an ACTUALLY-tampered worktree
(never a legitimate one — see "Windows safety" below).

**Windows commondir-normalization safety.** `checkCommondirTrust` (`git/bounded.ts`) already case-folds via
`findExistingAncestorRealpath`/`fs.realpathSync.native` on win32, refuses a drive-less rooted gitdir pointer
rather than guess which drive a spawned child would resolve it against, and resolves a relative gitdir
pointer (git ≥2.48's `--relative-paths`) against the `.git` file's own directory per git's real
`read_gitfile_gently` semantics — the SAME construction `killableCanonicalRaw`'s own two mutating merge
calls (`--no-edit`, `--ff-only`) already use, unconditionally, on every real worker merge on Windows today.
This fix applies that SAME, already-production-proven mechanism to more READ sites in the same function —
not a new, unproven check. Verified directly with a real `git worktree add` worktree (no redirect) that a
normal union-forward (main has a new commit the worktree hasn't merged) still succeeds unchanged under the
newly-threaded verification — see "Tests" below.

## Item 3 — `precheckWorkerDone`'s refusal direction: KEEP ALLOW

Ruling (manager-approved): thread `trustedMainRoot` through the dirty-tree check (same `makeGit` edit shape
as items 1/2) but do NOT change the fail-safe polarity — both an ordinary error/timeout AND a classified
`CanonicalGitRefusal` still degrade to the existing ALLOW result (`{uncommitted:false, files:[],
zeroAhead:false}`). Two additions to the ruling:
1. A classified refusal is never SILENT: the catch now emits a distinct `console.warn` naming the worktree
   and that commondir verification was refused, before returning the same ALLOW result.
2. **The residual, named plainly:** `precheckWorkerDone` ALLOWs a `done` report even when the worktree's own
   commondir could not be verified — the worker's `done` can proceed without the "you have uncommitted
   files" warning it would otherwise get. The backstop for an ACTUALLY dirty worktree under this exact
   condition is `readWorktreeUncommittedState` (via `SessionService.gcWorktreeDir`'s `retainIfUncommitted`
   branch, used by `finalizeMerge`'s worktree teardown) — already fixed by `b4cc7114` to thread
   `trustedMainRoot` and fail to `state:"unknown"` (never `"clean"`) on the same classified refusal, which
   `gcWorktreeDir` already retains on. A worktree whose real dirt `precheckWorkerDone` missed is therefore
   never destroyed with that dirt silently lost — it surfaces later, at teardown, via that independent,
   already-verified path.

⚠️ **Round 2 (SF1) correction:** round 1 made check (1)'s catch RETURN on a refusal, which (Code Review
finding) also skipped check (2) — the zeroAhead/aheadCount ahead-count probe, which reads the MAIN repo
and is therefore unaffected by a worktree-commondir redirect. Fixed to fall through instead; see "Round 2"
below for the full fix and `DoneReportPrecheck`'s new `verificationRefused` field.

## Tests

- `packages/daemon/test/worktree-commondir-redirect-gc.mjs` — extended with: (5) `worktreeHasWorkDetailed`
  on the SAME redirected fixture scenario (1) already builds, asserting `verificationRefused:true` on the
  dirty-tree path. (6) `precheckWorkerDone` against a redirected worktree — asserts the result still ALLOWs
  (`uncommitted:false`) while a captured `console.warn` call names the worktree and "commondir". (7)
  `mergeMainIntoWorktree`'s merge-base early-return against a redirected worktree whose decoy reports a
  WRONG merge-base answer (the real worktree needs a merge; the decoy's branch sits at mainSha) — proves the
  pre-fix silent-skip bug is closed (the function no longer returns `{ok:true, merged:false}` without
  actually verifying). (8) `mergeMainIntoWorktree`, a REAL, non-redirected `git worktree add` worktree with a
  genuine pending union (main has a commit the worktree lacks) — succeeds unchanged (`ok:true, merged:true`,
  worktree HEAD now an ancestor of main) under the newly-threaded verification — the manager's explicitly
  requested regression/safety control.
- `getRetainedWorktrees`/`classifyRetainedWorktree` coverage lives in
  `packages/daemon/test/worktree-retained-backlog.mjs` (has the `SessionService` fixture scaffolding this
  needs) — extended with a redirected-decoy scenario proving the entry survives (never silently dropped)
  and carries `verificationRefused:true`.
- RED/GREEN proven via `pnpm --filter @loom/daemon negative-control` against the pre-fix state for each new
  assertion (see the corresponding `worker_report` for the exact command/output).
- `canonical-git-helper-guard.mjs`, `canonical-git-isolation.mjs`, `bare-ref-positional-argv-guard.mjs` run
  directly (not in `STATIC_GUARD_REPO_PATHS`, per CLAUDE.md's canonical-git-path bullet).
