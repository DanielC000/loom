# 24c0bdba — kill-confirm every mutating canonical/batch-merge git child before releasing the lock or proceeding

## Narrative

`mergeBranchLocked` (`git/worktrees.ts`, under `withCanonicalIndexLock`) ran its `merge --squash`,
`reset --merge`/`reset --hard`, and `commit` calls under a bare `withTimeout` — which settles INDEPENDENT
of the underlying git child (`@decision 8e75ee20`). A pre-commit hook outliving the timeout let the
wrapper reject and the lock release while the real `git commit` child was still alive, waiting on its
hook. If a SECOND merge then acquired the (prematurely released) lock and staged its own diff before the
first merge's orphaned child resumed, that orphan finalized using the FIRST merge's own captured message
(subject + `Loom-Worker-Branch` trailer) but the SECOND merge's currently-staged content — a commit whose
trailer claims one branch while its tree belongs to another, permanent in mainline once it lands.

The fix routes every MUTATING call on this path through `killableCanonicalRaw` (`git/bounded.ts`): a
fresh `AbortController` per call, wrapped in `withTimeoutKillingChild`, which only settles once the real
child is CONFIRMED dead (kill-then-wait-for-exit, never kill-then-independent-timer). `createWorktree`'s
`boundedLockedRaw` and `attemptCodexAutoCommit`'s own commit call had each already hand-rolled this exact
dual-path shape independently; `killableCanonicalRaw` is the one shared helper both now delegate to,
alongside `mergeBranchLocked` and `batch-merge.ts`'s `landBranchCommitsIndividually`/`rollback`.

**Revision (Code Review, same card): a single-process kill is NOT enough — verified on Windows 11 and
Linux/WSL.** The first cut of this fix killed only git's own DIRECT child via simple-git's `abortPlugin`
(`spawned.kill("SIGINT")`), but a pre-commit hook's own descendants (`sh`, and whatever it spawns) are a
SEPARATE process tree that survives that single signal — reproduced with a lint-staged-shaped hook
(`sleep; write a file; git add it`): the parent git.exe dies on schedule, but the orphaned hook shell
keeps running and its own later `git add` still lands a DIFFERENT merge's file into a commit it had no
business touching. `killableCanonicalRaw`'s non-test-seam path now bypasses simple-git entirely for the
mutating call itself (`spawnCanonicalGitTree`, `git/bounded.ts`): it spawns git directly (`detached` on
POSIX so `child.pid` is the process GROUP id; `windowsHide` + `taskkill /T /F` on win32), and on abort
reuses `orchestration/gate-runner.ts`'s existing `killGateProcessTree` (never a second tree-killer) to
kill the WHOLE tree, not just git.exe. `canonicalRaw`'s merge-driver enumeration/blanking/verification
pipeline (356538ef) is unchanged — only WHAT executes the final git process changed, never the protection
pipeline around it. On POSIX the settle additionally waits (bounded by `killGraceMs`) for
`process.kill(-pid, 0)` to confirm the whole GROUP is gone, not just git's own direct child.

**A tree-kill can itself go unconfirmed** (a descendant not reaped within grace). `treeDeathUnconfirmed`
(`git/bounded.ts`) names this case; every caller that would otherwise run a further mutating cleanup
(`resetOrSkip`'s `reset --hard`, or a batch `rollback()`) checks it FIRST and, when true, fails CLOSED —
reports the failure loudly and touches the repo/worktree no further, rather than racing whatever might
still be alive. `mergeBranchLocked`'s post-commit-failure HEAD re-read is ALSO tightened (Code Review m1):
a bare "HEAD moved" is not proof it is OUR commit — it now additionally requires the moved HEAD's parent
to be the captured pre-commit HEAD and the commit's own trailer to name this branch, via the existing
`parseLoomTrailerBlock` reader, before claiming `ok:true`; anything less is reported as an unverifiable
HEAD movement by name, never silently trusted or silently discarded.

## Round 3 (Code Review 7f08579d): the fail-closed path could never actually fire, plus QUARANTINE

A second Code Review pass on round 2 found TWO blockers, both reproduced and both now fixed.

**B-1 [Critical]: `treeDeathUnconfirmed` never matched what a caller actually received.**
`withTimeoutKillingChild`'s own `giveUpTimer` (`git/bounded.ts`) — the "killed, but did not die within
Nms — giving up" rejection, fired when the wrapper gives up waiting for the child's own settlement —
carried NO signal `treeDeathUnconfirmed`'s old string match recognised. Because that timer's deadline is
measured from the CALL's own start while `spawnCanonicalGitTree`'s own confirmation only starts counting
after the child's `close` fires (strictly later), give-up structurally wins the race whenever confirmation
is genuinely slow — meaning the ONLY message a caller ever actually saw, on a real unconfirmed kill, was
the give-up message, which the fail-closed check could never match. Every caller ran its "safe" cleanup
(`reset --hard`, a batch rollback) anyway, on the exact orphan the check exists to protect against.

**Fix:** giving up IS itself an unconfirmed-death outcome, not a distinct third thing. A TYPED, non-
enumerable marker (`markUnconfirmedKill`, `git/bounded.ts`) — never a message-text change, so the exact
wording `test/bounded-git-kill-on-timeout.mjs` already pins is untouched — is now attached to BOTH the
give-up rejection and the POSIX "process tree not fully confirmed dead" rejection, and propagated through
`withTimeoutKillingChild`'s own error-wrapping. `treeDeathUnconfirmed` checks this marker FIRST, falling
back to the (now-corrected) message regexes only as a defense-in-depth net for an error this file's own
tagging somehow missed.

**B-2 [Critical, Win11]: even a CONFIRMED kill of the DIRECT child isn't a confirmed kill of the whole
tree, and a genuinely UNCONFIRMED kill left the repo otherwise unprotected.** A double-forked hook tail
(`( (sleep N; ...) & ); sleep M` — the OUTER subshell backgrounds an INNER one and returns immediately)
breaks the parent-child chain `taskkill /T` (win32) walks to find descendants: by the time the tree-kill
runs, the intermediate subshell that spawned the escaped one has already exited, so the escaped
descendant is unreachable by PID-tree walk, keeps the stdio pipe open, and can still `git add` a file
into a LATER merge's real commit. Measured: git.exe exits ~300ms after the kill, but the escaped
descendant's own eventual exit (and the `close` event it was gating) can lag by tens of seconds. Even
where round 2's tree-kill DID reach everything (the common case), a bare `treeDeathUnconfirmed` catch
only ever skipped THAT ONE cleanup call — the repo was otherwise left fully open to the very next merge,
which could still race whatever, in principle, remained alive.

**Fix: QUARANTINE.** On ANY unconfirmed kill (either B-1's give-up path or a genuine unconfirmed tree
death), the repo is quarantined. Round 3's first cut raised this quarantine by reusing the EXISTING
merge-danger-window/latch mechanism (`enterMergeDangerWindow`/`merge-danger-window.ts`) directly — the
entry `mergeBranchLocked` (or `landBranchCommitsIndividually`, keyed on the BATCH WORKTREE path) already
wrote right before its own mutating region was simply never cleared on this exit. **Round 4 (below)
replaced this with a dedicated, canonical-repo-keyed, restart-durable module** (`git/merge-quarantine.ts`)
after Code Review found the round-3 shape itself had two more bypasses — see that section for the current
mechanism; the round-3 shape is kept here only as narrative history of how the fix evolved.

**m-b** (round 3): `spawnCanonicalGitTree`'s win32 branch now AWAITS `killGateProcessTree`'s own promise
(captured, never `void`'d) before treating the child's `close` as confirmation — `taskkill /T /F`
completing is part of what "confirmed" means there, not merely having been issued.

**m-a** (round 3): `landBranchCommitsIndividually`'s Loom-Worker-Base/PathSet amend (`batch-merge.ts`) now
fails CLOSED + quarantines on its OWN unconfirmed tree-kill, checked BEFORE the HEAD-based recovery read
(which assumes the child is done mutating) — never warn-and-continue with an unverified sha, and never let
the next candidate's cherry-pick race an amend that might still be alive.

**m-c** (round 3, accepted as-is): the stricter nonzero-exit rejection from round 2 stands.
`spawnCanonicalGitTree`'s failure message now concatenates stderr AND stdout (was stderr-only) — a git
`cherry-pick` conflict's own `CONFLICT (content): ...` line is typically on stdout while `error: could not
apply ...` is on stderr, so a stderr-only message could omit the more useful half.

`batch-merge.ts` has no named lock around its per-branch landing loop, but the identical self-race exists
without one: `landBranchCommitsIndividually`'s own header doc argues "no concurrent writer of its own
during assembly" to justify a plain `reset --hard` elsewhere — that argument is about EXTERNAL
concurrency and does not defend against a SELF-race, where the SAME sequential function (its own
`rollback()`, or the next candidate branch in its loop) touches the identical on-disk worktree again
immediately after a bare-`withTimeout`-rejected `cherry-pick`/`commit`/`commit --amend`, while the
orphaned child may still hold the ability to land a stale write. Kill-confirmation closes it the same way,
at every mutating call site in that function (`cherry-pick --no-commit`, the manual `commit`, the
`Loom-Worker-Base`/`PathSet` `commit --amend`, and `rollback()`'s own `cherry-pick --abort` +
`reset --hard`).

A "failure" from a kill-confirmed `commit` call can still mean the commit actually landed: a
`post-commit` hook runs AFTER the ref has already moved, and its own exit status is ignored by git — a
hang there can outlive the timeout with the real work already done. `mergeBranchLocked` now re-reads HEAD
against the pre-commit value captured for the path-set trailers and, if it moved, reports `ok:true` with
the real sha instead of a false `ok:false` — mirroring `attemptCodexAutoCommit`'s own post-commit
recovery (Code Review "B1 residual").

**Hooks stay enabled on this path, deliberately** — `356538ef` (owner request `b0fb1e26`, 2026-09-26, 4
days before this card) already decided, explicitly, that the canonical merge path trusts the shared
`.git`'s hooks/config, specifically so real projects' own commit hooks (husky, commitlint, git-lfs) keep
firing on Loom's own squash/batch landings; blanking them here would reverse that decision, not just be
neutral. The tree-kill closes the actual defect (an orphaned process corrupting a LATER merge) for any
hook whose process tree can be confirmed dead within grace — which SIGKILL/`taskkill /T /F` make true for
essentially every real hook — so there is no correctness reason to disable them; the narrow residual that
remains (`treeDeathUnconfirmed`) fails CLOSED rather than silently corrupting anything, so it does not
reopen the case for disabling hooks either. Only `attemptCodexAutoCommit` disables hooks
(`core.hooksPath=os.devNull` + `--no-verify`), and for an unrelated reason: it protects the DAEMON from a
worker-planted hook escalating during a commit the daemon makes into the WORKER's OWN worktree on the
worker's behalf (a codex-sandbox workaround), not the canonical-repo trust boundary this card is about.

## Round 4 (Code Review b2ebf41f): the round-3 quarantine itself had two more bypasses

Round 3's quarantine passed the solo-path negative control (a repo quarantined by an unconfirmed kill
correctly refused a later solo `mergeBranch`), but Code Review found it was NOT mergeable: two further
bypasses, both reproduced.

**BLOCKER 1 [Critical]: `merge_batch` bypassed the quarantine entirely.** Two separate holes, demonstrated
together: (1) the quarantine was keyed on whatever `repoPath` the caller passed — for the batch path that
was the EPHEMERAL batch worktree, never the canonical repo, even though a batch worktree is a linked
worktree of the SAME repo sharing the SAME hooks directory and object database, so an orphan escaped from
a batch candidate's hook can reach state the canonical repo itself depends on. (2) Even a CORRECTLY-keyed
canonical-repo quarantine was never actually CHECKED by most of the batch path's own canonical-mutating
calls: `fastForwardCanonicalMain` (`batch-merge.ts`) had no check of its own and would fast-forward
canonical HEAD regardless; and a candidate that died with an unconfirmed kill mid-assembly was merely
"dropped" — `assembleBatchBranches`'s loop moved on to the next candidate, and `runBatchedMerge` still
went on to gate and fast-forward with whatever HAD landed cleanly. For a multi-commit candidate that died
at commit `i > 0`, commits `0..i-1` (already landed as their own real commits earlier in the SAME
candidate's own landing loop) would ride onto canonical main with the batch's own gate never having tested
the state the dying commit left the worktree in.

**Fix:**
1. **The quarantine is now ALWAYS keyed to the CANONICAL repo** (`git/merge-quarantine.ts`, new module —
   see below), even when raised from inside a batch worktree; every batch-path call site that raises one
   resolves and passes the canonical `repoPath` explicitly, never the worktree path.
2. **The refusal now sits at every canonical-mutating CONVERGENCE POINT**, each calling the ONE shared
   `assertRepoNotQuarantined(repoPath)` helper: `mergeBranchLocked`'s own entry (already there, re-keyed),
   `runBatchedMerge`'s entry (before assembly even starts), `fastForwardCanonicalMain`'s own entry
   (independent defense-in-depth — the gate between assembly and this call can run many minutes, long
   enough for an unrelated op to quarantine the repo in the meantime), `createWorktree`'s entry (`worktree
   add` mutates the canonical repo's shared `.git/worktrees/` state too), and `finalizeMerge`'s entry
   (`sessions/service.ts`, protecting its own full bookkeeping flow — sibling-session retirement, task
   state — not just the git calls). Beneath `finalizeMerge`, the check is ALSO planted at the DEEPER,
   proven shared chokepoints those git calls actually route through — `gcWorktreeDir` (the ONE worktree-
   removal chokepoint `@decision dea6728e` already established after a guard planted only in
   `finalizeMerge` once left three OTHER callers, the wedge-retry sweep and both boot-reconcile Pass B
   sites, force-removing with no check at all) and `deleteBranch`/`deleteBranches`
   (`git/worktrees.ts`, deliberately separate functions per `@decision 09f268a5` — each needs its own
   check, since neither calls through the other for its own primary path) — so a caller that reaches
   worktree removal or branch deletion WITHOUT going through `finalizeMerge` at all is covered too.
3. **`LandResult`/`BatchAssembleResult`/`RunBatchedMergeResult` all carry a TYPED `quarantined?: boolean`
   flag** — never inferred by parsing `reason` text. `assembleBatchBranches`'s loop STOPS outright (never
   drops-and-continues) the instant a candidate's own landing returns `quarantined:true`;
   `runBatchedMerge` then aborts the WHOLE batch on that flag — no gate, no fast-forward, no per-candidate
   fallback confirm (`sessions/service.ts`'s `mergeBatchTracked` checks the same flag before ever calling
   `runFallback`) — and the batch worktree is left ON DISK for a human (the caller's own worktree-removal
   `finally` now checks a `batchQuarantined` local before calling `removeWorktree`).
4. **The quarantine is now checked BEFORE gate admission**, not just before the eventual squash/land: both
   `confirmWorkerMerge` (a new backstop, ahead of `gateSemaphore.runExclusive`) and the batch path (covered
   structurally by `runBatchedMerge`'s own entry check, which runs strictly before `assembleBatchBranches`
   and therefore before the `runGate` callback it later invokes) — so a quarantined repo never burns a
   shared, minutes-long gate slot on a foregone conclusion.

**BLOCKER 2 [Critical]: a plain daemon restart silently LIFTED the quarantine, and `daemon_restart` is
agent-callable.** Round 3's quarantine lived entirely in the in-flight/crash-recovery tracker's in-memory
`Map`, wiped by any restart; its durable latch file was CONSUME-ON-READ at boot (read once, logged, then
deleted) — the exact opposite of re-arming. Since an agent can call `daemon_restart` itself, this was a
TRIVIAL, agent-reachable bypass of the entire quarantine mechanism, not merely an operational gap.

**Fix:**
1. **A dedicated module, `git/merge-quarantine.ts`**, DELIBERATELY SEPARATE from
   `merge-danger-window.ts`'s in-flight tracker (different lifetimes, different consumers — see that
   module's own header doc): its own in-memory `Map`, its own durable per-repo latch file
   (`<LOOM_HOME>/merge-quarantines/`), and its own boot-time re-entry (`reenterMergeQuarantinesAtBoot`,
   called from `index.ts` alongside the existing crash-latch read) that RE-ARMS every durable quarantine
   found — never logs-and-discards it the way the crash-recovery latch does.
2. **A RESTORED (post-restart) quarantine can ONLY be cleared by a human**, through a NEW loopback-only,
   bearer-secret-guarded REST route — `POST /internal/merge-quarantine/clear` (`gateway/server.ts`, same
   trust posture as `/internal/shutdown`/`/internal/update`) — never an MCP tool. The in-process
   auto-clear (`onTreeDeathSettled(confirmed === true)`) still works exactly as before, but ONLY within
   the SAME process lifetime that raised the quarantine: the listener that would fire it is gone forever
   once that process exits, restart or not, so it structurally cannot fire for a re-entered quarantine.
3. **Refusal text no longer says "restart the daemon to lift it"** (false, and actively misleading after
   this fix — a restart now RE-ARMS it) — every refusal names the human REST route instead. The boot-time
   log for a re-entered quarantine is its own, distinct message (`index.ts`) — NEVER routed through
   `describeMergeDangerLatchAtBoot`, which must never say "no action needed" for a quarantine (that
   function only ever describes the UNRELATED crash-recovery latch, and always will, since the two latches
   now live in genuinely separate stores).
4. **Quarantine state stays structurally separate from in-flight state**: `merge-quarantine.ts` shares
   NOTHING with `merge-danger-window.ts`'s `activeDangerWindows` map, so a quarantine can never make
   `gracefulShutdown`'s bounded wait (`waitForMergeDangerWindowsToClear`) block any longer, and the
   existing emergency-manager-recycle guard (`redirectManagerForEmergencyRecycle`, `sessions/service.ts`
   ~7922, `@decision 9f279c7b`) — which checks the IN-FLIGHT tracker, not quarantine — is untouched and
   continues to work exactly as before.

**Tests:** `packages/daemon/test/merge-quarantine-batch.mjs` (new) drives the SAME two shapes the
reviewer's own repro used, directly against `runBatchedMerge`/`fastForwardCanonicalMain`
(`git/batch-merge.ts`) — not a full daemon/HTTP harness, matching how the bypass was itself originally
demonstrated: scenario A (already-quarantined canonical repo ⇒ refuses before assembly, with a clearing
negative control), scenario B (a candidate's own commit dies with a real unconfirmed kill mid-batch,
reusing round 3's own double-forked-hook repro applied to a multi-commit candidate ⇒ the whole batch
aborts, no gate, canonical HEAD untouched, worktree retained), and scenario C (a quarantine latch found at
boot re-arms the refusal; only the human clear — `clearMergeQuarantine`, the same call the REST route
makes — lifts it, verified across three successive re-entries). `merge-commit-kill-confirm.mjs`'s own
scenario 5 (solo path) was re-verified unchanged against the new module — same observable behavior,
relocated mechanism.

## Round 6 (Code Review, round-5 review of `89ea939d`): BLOCKER 1 (a real bypass) + BLOCKER 2 (fail-open corrupt latch)

**BLOCKER 1 [Critical, reproduced]: `GitWriter.checkout`/`createBranch`/`commit` ignored the quarantine
entirely** — a `commit` and a `createBranch` both SUCCEEDED against a quarantined repo, reachable via the
operator MCP `git_*` tools and the Platform Lead tools. **Fix:** the check moved to the TRUE convergence
point, `withCanonicalIndexLock` (`git/repo-lock.ts`) — checked AFTER the lock is acquired (never at
enqueue time, so a quarantine raised while a caller sat queued is still caught), throwing a new
`RepoQuarantinedError`. Every canonical-index writer already goes through this lock, so it needed no
per-caller duplication: `GitWriter`'s three methods (each now wraps the WHOLE
`withCanonicalIndexLock(...)` call in try/catch, not just the callback passed to it — the throw happens
BEFORE that callback runs, so a nested try/catch would never see it), `mergeBranch` (its own copy inside
`mergeBranchLocked` is now unreachable dead code and was DELETED), and `fastForwardCanonicalMain`'s
`--ff-only` (previously took NO lock at all — now the forfeit-check read and the ff-only run inside the
SAME lock, closing that gap too). Op-entry checks are KEPT only where they buy a real early refusal before
gate admission (`confirmWorkerMerge`, `runBatchedMerge`'s own entry) or where the path structurally cannot
take the lock (`deleteBranch`/`deleteBranches` — ref deletion never touches the index; `gcWorktreeDir` —
directory removal, not an index write; `finalizeMerge` — protects non-git bookkeeping too;
`createWorktree`'s own top check — the REUSE path never takes the lock). **Writer coverage table:**
`GitWriter.checkout/createBranch/commit` → lock; `mergeBranch` → lock (own copy deleted); `createWorktree`
fresh-cut → lock (+ own top check for the no-lock reuse path); `fastForwardCanonicalMain` → lock (own
bare check deleted); `deleteBranch`/`deleteBranches`/`gcWorktreeDir`/`finalizeMerge`/`confirmWorkerMerge`/
`runBatchedMerge` entry → each keeps its own check (cannot take the lock, or buys early refusal).
**NC1** (no test had ever hit `fastForwardCanonicalMain`'s own check — A/B/C above all raise their
quarantine before or during assembly, never mid-gate): `merge-quarantine-batch.mjs` SCENARIO D raises the
quarantine FROM INSIDE the gate callback itself (assembly already clean, gate already admitted) and
asserts the ff refuses with `quarantined:true` and HEAD untouched; verified RED with the lock check
neutralized (canonical HEAD advanced despite the quarantine) and GREEN restored.
`test/merge-quarantine-lock-convergence.mjs` (new) proves the BLOCKER-1 bypass directly: quarantine a real
repo, call each writer, assert refusal AND that nothing it would otherwise do actually happened (no
checkout, no branch, no commit, no ff, no worktree) — verified RED (bug reproduces) with the lock check
neutralized, GREEN restored.

**BLOCKER 2 [Critical]: a corrupt/unparsable durable latch failed OPEN at boot** — a 0-byte latch re-armed
NOTHING, silently reopening the round-4 "restart lifts the quarantine" bypass. **Fix:**
`reenterMergeQuarantinesAtBoot` now takes `registeredRepoPaths` (the SAME canonical-repo list index.ts
already builds for the residue scan): an unparsable latch whose FILENAME HASH matches a registered repo
quarantines THAT repo (with a reason naming the corruption); one matching NO registered repo, or a
`readdirSync`/`mkdirSync` failure, quarantines EVERY registered repo, fail-closed, with a loud
`console.error`. The durable write (`writeMergeQuarantineLatch`) now fsyncs the tmp file before the
rename, returns `false` on failure (never throws), and logs loudly; `enterMergeQuarantine` itself now also
logs loudly when the durable write failed, naming the restart-loses-it risk explicitly. **NC2** (round-5's
own scenario C never actually exercised a FRESH process — it reused the SAME in-process map
`enterMergeQuarantine` had already populated): `test/merge-quarantine-boot-hardening.mjs` (new) spawns a
GENUINELY SEPARATE node process (fresh heap, same `LOOM_HOME`) that calls ONLY
`reenterMergeQuarantinesAtBoot` and reports what it found from the durable file alone — verified this
finds the repo and reports the real reason. The same file also drives BLOCKER-2a (matched-hash corrupt
latch → that repo quarantined) and BLOCKER-2b (unmatched corrupt latch → every registered repo
quarantined, with a negative control that a clean sweep finds nothing once the corrupt file is removed) —
both verified RED against the pre-round-6 `reenterMergeQuarantinesAtBoot` (its bare `catch { skip }` is a
no-op: neither scenario's repo would ever become active).

**Item #8:** `reenterMergeQuarantinesAtBoot` now runs BEFORE `buildServer`/`startGatewayListeners` in
`index.ts` (moved up from after the port bind) — the old position left a real window where the gateway was
already accepting REST/MCP requests before a restart-surviving quarantine was re-armed to refuse them.
`test/merge-quarantine-boot-hardening.mjs`'s item-8 scenario is a real AST-shape check (mirroring
`boot-listen-not-blocked.mjs`'s own technique) asserting the call precedes the port bind in source order;
verified RED against the pre-round-6 ordering, GREEN restored.

**Item #5 (compare-and-clear):** the in-process auto-clear (`onTreeDeathSettled(true)` in
`mergeBranchLocked`/`landBranchCommitsIndividually`) now presents the SAME token `enterMergeQuarantine`
minted at the raise, via `clearMergeQuarantineByToken(repoPath, token)` — a mismatch (a DIFFERENT op's
quarantine is now active, e.g. refreshed by a later raise) is a silent no-op. `enterMergeQuarantine` now
returns the fresh token; each function raises at most one quarantine per invocation (every raise site
returns immediately), so a single per-invocation `let raisedToken` slot suffices. The human REST route and
tests still use the UNCONDITIONAL `clearMergeQuarantine` (no token needed — a human resolving this by hand
doesn't hold the raising op's token).

**Item #10 (finalizeMerge callers):** no caller moves the task or emits `merge_done` on a quarantined
`{}` return — both are DONE INSIDE `finalizeMerge` itself, strictly after its quarantine check, so a
quarantined return structurally cannot reach either. All three callers (solo Green, `finishAlreadyMerged`
— used by solo ALREADY_MERGED, the batch per-branch finish, and crash-recovery, boot-reconcile Pass A) DO
already fire `onBranchRetained`, which durably HOLDS the branch (`merge_branch_retained`/
`batch_merge_branch_retained`) and surfaces a warning — but that hook's message used to read as a generic
"could not verify the branch tip... unreadable" for a quarantine cause too, indistinguishable from an
ordinary moved-tip retain. Fixed: `onBranchRetained`'s signature gained an optional third `reason`
parameter, set to `"quarantined"` ONLY by `finalizeMerge`'s quarantine branch; `describeSoloRetained`/
`describeBranchRetained` both special-case it with accurate text naming the quarantine and the REST clear
route.

## Round 7 (Code Review of `f7ddc8e1`): M1 (token-overwrite fail-open) + M2 (orphan-latch trap), both reproduced

**M1 [Major, reproduced at the primitive level]: the map held ONE token per repo — a second raise
OVERWROTE the first raise's own token.** A LATER raiser's own confirmed-dead auto-clear then lifted the
WHOLE repo while an EARLIER raiser's own orphan was still genuinely unconfirmed. Repro (verbatim):
`ta=enter(A); tb=enter(B); clearByToken(ta)` correctly no-ops; `clearByToken(tb)` WRONGLY lifted the
quarantine even though `ta`'s own threat was never resolved — starkest in REVERSE order
(`clearByToken(tb)` FIRST wrongly lifts it immediately, before `ta` is ever addressed). Reachable in
practice because `merge_batch`'s own assembly runs UNLOCKED and only checks quarantine at its own entry
(never inside `withCanonicalIndexLock`), so it can raise its own quarantine on a repo whose solo-merge
quarantine is already live. **Fix:** `MergeQuarantineEntry.tokens: string[]` — a SET, not a scalar.
`enterMergeQuarantine` APPENDS a fresh token to an already-active entry (keeping the ORIGINAL
branch/reason/opId/enteredAt, describing the longest-outstanding raise) instead of overwriting it.
`clearMergeQuarantineByToken` removes ONLY its own token from the set and persists the reduced set; the
repo is lifted — via the SAME unconditional `clearMergeQuarantine` the human route uses — only once the set
is EMPTY. Test: `test/merge-quarantine-token-set.mjs` (new) drives the exact primitive repro plus a reverse-
order variant, a bogus-token no-op, and clear-idempotence — verified RED against `f7ddc8e1` (the reverse-
order and token-set assertions fail exactly as M1 predicts) and GREEN after the fix.

**M2 [Major, reproduced]: a corrupt latch matching NO registered repo was a FAIL-CLOSED TRAP WITH NO
WORKING ESCAPE.** Round 6's fix quarantined every registered repo when an unmatched corrupt latch was
found, but nothing ever deleted the orphan file itself — a human clearing every wrongly-quarantined repo
did NOT stop the NEXT boot from finding the SAME orphan file and re-quarantining everything all over
again, forever. The round-6 log even said "a human must clear each one", which did not actually work.
**Fix:** each fail-closed entry `reenterMergeQuarantinesAtBoot` raises for an unmatched-corrupt latch now
records that latch's FILENAME in `MergeQuarantineEntry.orphanLatchFiles`; `clearMergeQuarantine` (the
human/unconditional route) deletes an orphan file named there once NO OTHER still-active entry references
it (a repo cleared while a sibling repo's entry still references the same orphan does NOT delete it yet —
only the LAST repo referencing it does). Test: `test/merge-quarantine-boot-hardening.mjs`'s SCENARIO
BLOCKER-2b now drives the EXACT repro the review specified — boot with an unmatched corrupt latch ⇒ all
uncovered registered repos quarantined; human-clear each (the test itself NEVER touches the orphan file by
hand — round 6's own test did, which is precisely how this trap stayed hidden) ⇒ reboot (a fresh
`reenterMergeQuarantinesAtBoot` call) ⇒ nothing re-quarantined, because the clear route itself deleted the
orphan once nothing referenced it. Verified RED against `f7ddc8e1` (the orphan file survives every clear;
the reboot re-quarantines both repos) and GREEN after the fix.

**M2 RESIDUAL [reproduced, found by the lead's own review of `cf7b66da`]: the first round-7 cut of M2 still
had a hole.** PASS 2 `continue`d past (fully skipped) any registered repo that already had its own valid
entry from PASS 1 — so if EVERY registered repo already carried its own valid latch when an unmatched
orphan was found, NONE of them ever recorded the orphan's filename, no human clear could ever reach it, and
the next boot re-quarantined everything all over again: the EXACT SAME trap M2 exists to close, reachable
through a different door. **Fix:** a registered repo with its OWN valid entry from PASS 1 now keeps that
data (branch/reason/opId/enteredAt/tokens) UNCHANGED but has the orphan's filename(s) MERGED into its OWN
`orphanLatchFiles` (deduplicated) and is re-persisted — every registered repo ends up referencing the
orphan one way or another (a fresh fail-closed entry if it had none, or its real entry augmented if it did),
so clearing all of them is what finally lets the orphan be deleted. Test: SCENARIO BLOCKER-2c (new, in the
same file) — two repos each carrying their OWN real, unrelated quarantine BEFORE an orphan latch is found;
verified RED against `cf7b66da` (the repos' entries never referenced the orphan; clearing both left it on
disk; a reboot re-quarantined both all over again) and GREEN after this fix.

**Cheap minors folded into the same round:**
- `reenterMergeQuarantinesAtBoot`'s unmatched-corrupt branch used to `return` EARLY, silently skipping every
  LATER file in the directory (which could include a repo's own genuine, valid latch) and unconditionally
  overwriting already-collected valid entries with an `"(unknown…)"` placeholder. Fixed: the function now
  processes EVERY file in one pass (PASS 1) before deciding anything; PASS 2 (the orphan-caused fail-closed
  sweep) never overwrites a registered repo's genuine data — see the M2 RESIDUAL entry just above for what
  it does instead (merge the orphan reference in, rather than skip the repo outright).
- `quarantineAllRegisteredFailClosed` and the matched-corrupt branch used to ignore
  `writeMergeQuarantineLatch`'s `false` return entirely — both now log the same "will NOT survive a
  restart" consequence `enterMergeQuarantine` already logs for an ordinary raise.
- `test/merge-quarantine-boot-hardening.mjs`'s item-8 scenario now ALSO asserts re-entry precedes
  `buildServer(` specifically (not just the later `startGatewayListeners`/`app.listen(` port-bind it
  already checked), and that the call passes a real, non-empty repo-list argument (an AST check that a
  regression to `reenterMergeQuarantinesAtBoot()` or `reenterMergeQuarantinesAtBoot([])` would still compile
  and pass every other check while silently defeating BLOCKER 2's whole fix).

## Residuals (accepted)

- **A hook tail that BOTH detaches from its process tree AND holds the stdio pipe open indefinitely
  gives no `close` signal on Windows at all.** Closing that structurally needs a Job Object (native
  dependency, out of scope here) — the quarantine still fires (via `withTimeoutKillingChild`'s own
  give-up path, now correctly tagged) and PROTECTS the repo, but it never auto-clears for this specific
  shape; only a human, after verifying the repo by hand, can clear it — through the REST route (round 4),
  never by restarting the daemon (a restart now RE-ARMS the same quarantine instead of lifting it). Filed
  as a follow-up card for a Job Object (board card `1718416d`) — still open, accepted as-is.
- **POSIX `setsid` escapes.** `spawnCanonicalGitTree`'s POSIX kill signals the process GROUP
  (`process.kill(-pid, SIGKILL)`) — a descendant that calls `setsid` (or is otherwise detached into its
  own session) leaves that group and is not reached. Same consequence as the Windows case above: the
  quarantine still fires (the missing confirmation IS what triggers it) and never silently corrupts
  anything; it just may not auto-clear without a human.
- **CLOSED, round 4 (was open in round 3): "a quarantine does not survive a daemon restart."** This is no
  longer a real gap — see "Round 4" above. A quarantine now survives any number of restarts, including one
  an agent itself triggers via `daemon_restart`, and is lifted only by the human REST route or a genuine
  in-process auto-clear.

## Do not

- Do not release `withCanonicalIndexLock`, or proceed to a rollback / the next candidate branch in
  `batch-merge.ts`'s per-branch loop, while a mutating git child from a PRIOR call may still be alive —
  route every mutating canonical/batch-merge git call through `killableCanonicalRaw` (`git/bounded.ts`),
  never a bare `withTimeout`.
- Do not kill only git's own DIRECT child on this path (simple-git's `abortPlugin`, a bare
  `spawned.kill("SIGINT")`) — a hook's own descendants are a SEPARATE process tree that survives it
  (verified on Windows 11 and Linux/WSL: a lint-staged-shaped hook's own later `git add` still lands).
  Use `killableCanonicalRaw`'s tree-kill path (`spawnCanonicalGitTree` + `killGateProcessTree`), which
  kills the WHOLE tree, not just the one process.
- Do not run a further mutating cleanup (`resetOrSkip`'s `reset --hard`, a batch `rollback()`) when
  `treeDeathUnconfirmed(e)` is true — that would race whatever of the tree might still be alive. Fail
  CLOSED: report the failure loudly, QUARANTINE the CANONICAL repo (`enterMergeQuarantine`,
  `git/merge-quarantine.ts` — round 4; never the batch worktree path), and touch nothing else.
- Do not classify `treeDeathUnconfirmed` by matching a message string alone (round 3, B-1) — a
  `withTimeoutKillingChild` give-up rejection carries a DIFFERENT message than a confirmed-tree-death
  rejection, and the give-up path is the one a caller actually receives whenever confirmation is genuinely
  slow. Tag BOTH with the shared typed marker (`markUnconfirmedKill`) at the point each is constructed;
  `treeDeathUnconfirmed` checks that marker first.
- Do not clear a repo's quarantine anywhere but `onTreeDeathSettled`'s own in-process auto-clear or the
  human REST route (`POST /internal/merge-quarantine/clear`) — it must stay latched, refusing every later
  merge/batch attempt on that SAME CANONICAL repo, across any number of daemon restarts (round 4: a
  restart RE-ARMS it, via `reenterMergeQuarantinesAtBoot`, never lifts it).
- Do not key a quarantine (or check for one) on a BATCH WORKTREE path (round 4, BLOCKER 1) — always
  resolve and pass the CANONICAL `repoPath` first; a batch worktree shares the canonical repo's hooks
  directory and object database, so keying on the ephemeral worktree path leaves the canonical repo (and
  every other solo/batch attempt against it) completely unprotected.
- Do not let `assembleBatchBranches`'s loop drop-and-continue past a candidate whose own landing returned
  `quarantined:true` (round 4, BLOCKER 1) — stop assembly outright; do not let `runBatchedMerge` gate or
  fast-forward on a `quarantined:true` result, and do not let its caller (`mergeBatchTracked`,
  `sessions/service.ts`) route a quarantined outcome through the per-candidate fallback confirm or remove
  the batch worktree — leave it on disk for a human.
- Do not add a new canonical-mutating call WITHOUT routing it through `withCanonicalIndexLock`
  (round 6: the TRUE convergence point, not a per-site copy) — that lock now checks quarantine itself,
  AFTER acquiring it, throwing `RepoQuarantinedError`. Add a hand-rolled `assertRepoNotQuarantined` copy at
  a new entry ONLY when that path structurally cannot take the lock (a ref-only write like
  `deleteBranch`/`deleteBranches`, a directory-removal path like `gcWorktreeDir`, or a caller with non-git
  bookkeeping to protect like `finalizeMerge`) — and say why in a comment when you do.
- Do not warn-and-continue, or report `ok:true` with an unverified sha, on an unconfirmed tree-kill from
  the batch amend step (round 3, m-a) — it must fail closed and quarantine exactly like every other
  mutating call on this path, checked BEFORE any HEAD-based "did it land anyway" recovery read (that
  recovery assumes the child is done mutating, which is never true while unconfirmed).
- Do not `void` `killGateProcessTree`'s own promise on the win32 abort path (round 3, m-b) — capture and
  AWAIT it before treating the child's `close` as confirmation; `taskkill /T /F` actually completing is
  part of what "confirmed" means there.
- Do not "fix" a slow hook on the canonical/batch merge path with `--no-verify` or `-c core.hooksPath=`
  without a NEW, explicit owner decision — `356538ef` already, deliberately, trusts the shared `.git`'s
  hooks/config on this exact path, and the tree-kill closes the corruption this card is about for any
  hook whose tree can be confirmed dead, which is the overwhelming majority.
- Do not skip the post-commit-failure HEAD re-read on `mergeBranchLocked`'s squash commit, and do not
  trust a bare "HEAD moved" as proof it is OUR commit — verify the moved HEAD's parent is the captured
  pre-commit HEAD AND its trailer names this branch (`parseLoomTrailerBlock`) before claiming `ok:true`;
  a `post-commit` hook's own hang can outlive the timeout AFTER the ref has already moved, so a reported
  "failure" must be verified against HEAD before it is trusted as one.
- Do not add a second, hand-rolled kill-wired dual-path (test-seam-`withTimeout`-else-`AbortController`,
  or a second tree-killer) anywhere on this path — `killableCanonicalRaw` (reusing
  `orchestration/gate-runner.ts`'s `killGateProcessTree`) is the one shared helper; extend it rather than
  reimplementing its shape again.
- Do not invent a second quarantine mechanism, and do not conflate it with `merge-danger-window.ts`'s
  in-flight/crash-recovery tracker (round 4) — `git/merge-quarantine.ts` is the one shared store; the two
  are DELIBERATELY separate (different lifetimes, different consumers — see that module's own header
  doc), so a quarantine never makes `gracefulShutdown`'s wait longer and never refuses the emergency
  manager recycle, and the in-flight tracker never gains restart-durability it was never designed for.
- Do not expose a quarantine-clearing capability as an MCP tool, or gate it by loopback-IP alone (round 4)
  — same trust-boundary posture as the git/vault writers and `gateCommand`: loopback-only PLUS the
  bearer-secret guard (`isGuardedInternalWrite`, `gateway/server.ts`), matching `/internal/shutdown`/
  `/internal/update`.
- Do not put a try/catch around `withCanonicalIndexLock(...)`'s CALLBACK when that call can now throw
  `RepoQuarantinedError` (round 6) — the throw fires BEFORE the callback ever runs, so a nested try/catch
  never sees it; wrap the WHOLE `withCanonicalIndexLock(...)` call instead (see `GitWriter`'s three
  methods for the pattern).
- Do not call `clearMergeQuarantine` (the unconditional clear) from an in-process auto-clear
  (`onTreeDeathSettled`) — round 6, item #5: use `clearMergeQuarantineByToken(repoPath, token)` with the
  EXACT token `enterMergeQuarantine` returned to that same raise, so one op's confirmed-dead settlement can
  never clear a DIFFERENT, still-active (differently-tokened) quarantine on the same repo. Reserve the
  unconditional clear for the human REST route only.
- Do not let a corrupt/unparsable durable latch at boot silently re-arm nothing (round 6, BLOCKER 2 — the
  bug this exact wording used to describe) — `reenterMergeQuarantinesAtBoot` must fail CLOSED: an
  unparsable latch whose filename hash matches a registered repo quarantines that repo; one matching none
  (or a readdir/mkdir failure) quarantines EVERY registered repo it was given.
- Do not move `reenterMergeQuarantinesAtBoot`'s call site back to after `startGatewayListeners`/
  `buildServer` in `index.ts` (round 6, item #8) — it must run before the gateway can accept ANY request,
  or a restart-surviving quarantine leaves a real window where an agent can call `worker_merge_confirm`/
  `merge_batch` before it is re-armed.
- Do not go back to a single scalar `token` on `MergeQuarantineEntry` (round 7, M1) — a repo can be
  quarantined by MORE THAN ONE outstanding raise at once (batch assembly runs unlocked and only checks
  quarantine at its own entry, so it can race a live solo quarantine); `tokens: string[]` is a SET, and
  `clearMergeQuarantineByToken` must remove only its own token, lifting the repo ONLY once the set is empty.
- Do not have `enterMergeQuarantine` overwrite an already-active entry's branch/reason/opId/enteredAt on a
  second raise (round 7, M1) — APPEND the new token to the existing entry instead, keeping the ORIGINAL
  raise's identity (the longest-outstanding, still-unresolved one).
- Do not `return` early out of `reenterMergeQuarantinesAtBoot`'s per-file loop on the FIRST unmatched-corrupt
  latch (round 7, cheap-minor) — process every file in the directory first; a later file's own genuine valid
  latch must never be skipped or clobbered by an unrelated orphan's fail-closed sweep.
- Do not let an unmatched-corrupt (orphan) latch's fail-closed quarantine survive a human clearing every
  repo it wrongly quarantined (round 7, M2 — the trap this exact wording used to describe) — every such
  fail-closed entry must record the orphan's FILENAME in `orphanLatchFiles`, and `clearMergeQuarantine` must
  delete that file once no OTHER active entry still references it; a human-clear route that never deletes
  the orphan makes every subsequent boot re-quarantine everything again, forever.
- Do not let a registered repo's ALREADY-VALID entry go unreferenced by an orphan found alongside it (round
  7, M2 RESIDUAL) — `continue`ing past (fully skipping) a repo that already has its own valid latch was
  ITSELF a fail-open of the exact same M2 trap: if every registered repo already had its own valid latch,
  NOTHING would ever reference the orphan, and no clear could ever delete it. MERGE the orphan's filename(s)
  into that repo's OWN `orphanLatchFiles` (keeping its real branch/reason/opId/enteredAt/tokens unchanged)
  and re-persist it — never skip it outright.
- Do not ignore `writeMergeQuarantineLatch`'s `false` return anywhere it's called (round 7, cheap-minor) — a
  failed durable write must always be logged loudly with the "will NOT survive a restart" consequence,
  matching what `enterMergeQuarantine` already does for an ordinary raise.

## Source

Card `24c0bdba`, from Full review lane 1 (`2785fbc2`) finding B1: `worktrees.ts` ~6027-6032 committing
under a bare `withTimeout` inside `withCanonicalIndexLock`, reproduced end to end through the real
`mergeBranch` and against raw git. Fixed alongside the same class in `git/batch-merge.ts`'s
`landBranchCommitsIndividually`. A Code Review pass on the first cut found the single-process kill
insufficient (verified on Windows 11 and Linux/WSL) and two narrower issues (m1: an under-verified
post-commit-failure HEAD re-read; m2: the batch amend's own post-failure re-read missing) — all fixed in
the same revision. A THIRD pass (reviewer `7f08579d`) found the resulting fail-closed path could never
actually fire (B-1) and, even when it did, left the repo otherwise unprotected against a hook tail that
escapes the tree-kill entirely (B-2, Windows) — fixed via the typed unconfirmed-kill marker and a
quarantine mechanism (round 3). A FOURTH pass (reviewer `b2ebf41f`) found that round-3 quarantine itself
was not mergeable: `merge_batch` bypassed it entirely (wrong key, and most canonical-mutating batch call
sites never checked it at all), and a plain daemon restart — agent-triggerable via `daemon_restart` —
silently lifted it instead of re-arming it. Round 4 fixed both: a dedicated, canonical-repo-keyed,
restart-durable module (`git/merge-quarantine.ts`), checked at every canonical-mutating convergence point,
clearable only by an in-process auto-clear or a new human-only loopback REST route. Test:
`packages/daemon/test/merge-commit-kill-confirm.mjs` (scenarios 1-2 the original race + false-negative;
scenarios 3-4 the round-2 Code Review's own tree-kill repros; scenario 5 the round-3 Code Review's own
double-forked escape repro, driving the unconfirmed/quarantine/auto-clear path end to end — re-verified
unchanged against the round-4 module) and `packages/daemon/test/merge-quarantine-batch.mjs` (new, round 4:
the canonical-keyed batch-abort and restart-durability scenarios the round-4 Code Review's own repro used).
A FIFTH pass found the round-4 quarantine still not mergeable: BLOCKER 1 (`GitWriter` bypassed it
entirely, reproduced) and BLOCKER 2 (a corrupt latch failed open at boot), plus NC1/NC2 (no test actually
exercised `fastForwardCanonicalMain`'s own check or a genuinely fresh boot re-entry) and three follow-ups
(#5 compare-and-clear, #8 boot ordering, #10 finalizeMerge caller audit) — round 6 (this section) fixed
all of them: the quarantine check moved to `withCanonicalIndexLock` itself; `reenterMergeQuarantinesAtBoot`
fails closed on a corrupt latch and runs before the gateway can accept a request; the auto-clear is
token-scoped; `onBranchRetained` carries an accurate quarantine reason. Tests:
`packages/daemon/test/merge-quarantine-lock-convergence.mjs` (new — BLOCKER 1, six writers, each verified
RED against the neutralized lock check and GREEN restored) and
`packages/daemon/test/merge-quarantine-boot-hardening.mjs` (new — NC2's real child-process re-entry,
BLOCKER 2a/2b's fail-closed corrupt-latch handling, and item #8's AST boot-order check, all verified RED
against the pre-round-6 code and GREEN restored), plus SCENARIO D added to
`packages/daemon/test/merge-quarantine-batch.mjs` (NC1, verified RED/GREEN the same way).
A SIXTH pass (`b609e97d`) found round 6's own token/M2 mechanisms each had a real, reproduced defect: M1
(a scalar token silently fails open under a second, unrelated raise) and M2 (an orphan latch's fail-closed
quarantine has no working escape). Round 7 (this section) fixed both, plus three cheap-minors in the same
area (the early-return clobber, the ignored write-failure return, and item-8's own re-check). Tests:
`packages/daemon/test/merge-quarantine-token-set.mjs` (new — the exact M1 primitive repro plus a reverse-
order variant, verified RED against `f7ddc8e1` and GREEN after) and
`packages/daemon/test/merge-quarantine-boot-hardening.mjs`'s SCENARIO BLOCKER-2b, rewritten to drive the
real boot→clear→reboot repro without touching the orphan file by hand (verified RED against `f7ddc8e1`
and GREEN after). The lead's own review of that fix (commit `cf7b66da`) found ONE residual hole in M2:
a registered repo that ALREADY had its own valid latch was skipped outright when an orphan was found
alongside it, so if every registered repo already had a valid latch, nothing ever referenced the orphan and
it could never be deleted. Fixed by MERGING the orphan's filename into that repo's own entry (keeping its
real data) instead of skipping it. Test: SCENARIO BLOCKER-2c (new, same file) — verified RED against
`cf7b66da` and GREEN after this residual fix.
