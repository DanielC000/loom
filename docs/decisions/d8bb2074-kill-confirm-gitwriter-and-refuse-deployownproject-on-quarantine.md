# d8bb2074 — Kill-confirm GitWriter, refuse `deployOwnProject` on a quarantined canonical repo

Follow-ups from the Code Review of `bde5d1fe` (reviewer `7a7fa321`) — read `24c0bdba` and `bde5d1fe`
first; this card closes the two residuals those records explicitly named as open ("real gap, carded
separately" / "deploy build ... refuse" for `deployOwnProject` specifically, `buildDaemon` already having
its own).

## Narrative

**1 — `GitWriter.checkout`/`createBranch`/`commit` were un-kill-confirmed.** They ran their mutating git
calls (`checkout`, `checkout -b`, `add -A`, `commit`) under a bare `withTimeout` (`git/bounded.ts`) while
holding `withCanonicalIndexLock` — the SAME class of gap `24c0bdba` closed for `mergeBranchLocked` and
`bde5d1fe` closed for `fastForwardCanonicalMain`: a timed-out child's real process tree could outlive the
lock releasing, with no tree-kill, no confirmed-dead settlement, no quarantine raised on an unconfirmed
kill, and no per-call quarantine re-check between the `add` and the `commit` (an unlocked batch assembly
elsewhere can quarantine the repo in that exact window).

**Fix:** every mutating call in all three methods now routes through `killableCanonicalRaw`
(`git/bounded.ts`) — the SAME shared helper `mergeBranchLocked`/`fastForwardCanonicalMain` already use,
never a second copy. Each catch checks `treeDeathUnconfirmed(e)` and, when true, raises the quarantine via
`enterMergeQuarantine` (repo-keyed, never the branch/worktree — `GitWriter` never operates on a worktree
anyway) before rethrowing; each also wires an `onTreeDeathSettled` hook that auto-clears via
`clearMergeQuarantineByToken` once the real kill eventually confirms, exactly mirroring the merge path's
own shape. `commit()` no longer trusts simple-git's own parsed `CommitResult.commit` hash — it always
reads the hash back via `git rev-parse HEAD` after a successful `killableCanonicalRaw` commit call,
matching `mergeBranchLocked`'s own post-commit HEAD-read posture.

`GitWriter`'s own injectable test seam (`GitWriterDeps.gitFactory`) is adapted (`killableGitFactory()`) to
`killableCanonicalRaw`'s own narrower `(repoPath, blockTimeoutMs) => Pick<SimpleGit, "raw">` shape and
forwarded only when a TEST actually injected one — `undefined` on every real/production call, so
production always takes `killableCanonicalRaw`'s REAL tree-kill path (`spawnCanonicalGitTree` +
`killGateProcessTree`), never a fake `.raw()` with nothing real to kill. Read-only calls inside the same
lock (`git.status()`, `git.branchLocal()`, `git.revparse(["HEAD"])`) are UNCHANGED — still bare
`withTimeout` via the existing `this.git()` — because a hung READ can't leave staged/committed residue for
a later caller to race; only a mutating call needed kill-confirmation.

**Residuals named, not closed (documented instead, per this card's own "or document why exempt" option):**
- `deleteBranch`/`deleteBranches` (`git/worktrees.ts`) — single, hook-free ref writes (`update-ref -d` /
  `branch -D`) with no shared index to leave staged residue in; the existing entry `assertRepoNotQuarantined`
  check (round 6's writer coverage table) is the whole story for this path.
- `removeWorktree`'s `worktree unlock`/`worktree prune` (`git/worktrees.ts`) — admin-metadata-only, no
  hooks; this function relies on its CALLER's own entry check (`gcWorktreeDir`), per `c6a6f405`'s own
  "stays unlocked by design" ruling (not re-litigated here).

**2 — `deployOwnProject` ran the human-configured `deployCommand` against a quarantined canonical repo.**
`buildDaemon` (`orchestration/restart.ts`) already refuses for exactly this reason (`bde5d1fe` item 4), but
`deployOwnProject` (`sessions/service.ts`) is a SEPARATE function (a project's own deploy command, not the
daemon's own rebuild) and had no equivalent check. **Fix:** the same `assertRepoNotQuarantined` refusal,
checked BEFORE gate admission (mirroring `confirmWorkerMerge`'s own pre-admission backstop, `24c0bdba`
round 4 item 4) — a quarantined repo's deploy is refused regardless, and checking this early means it
never burns a shared, minutes-long gate slot on a foregone conclusion, and never runs a host command
against a tree an unconfirmed kill may still be rewriting.

**3 — Two nitpicks from the same review, both cosmetic/message-only, no behavior change:**
- `fastForwardCanonicalMain`'s (`git/batch-merge.ts`) unconfirmed-kill reason text named no sha at all.
  Fixed to name the already-known `targetSha` (no HEAD re-read — an unconfirmed kill means "touch nothing
  else," including a read) so a human reading the quarantine reason knows canonical main MAY already be
  there, not just stalled.
- `createWorktree`'s (`git/worktrees.ts`) add-failure cleanup used to attempt `worktree remove -f -f` even
  when the ORIGINAL `add` failure was itself a `RepoQuarantinedError` — meaning `add` never spawned
  anything (the per-call re-check refused it first), so the cleanup attempt was guaranteed to ALSO be
  refused the same way, logging a spurious "cleanup also failed" warning for a refusal working exactly as
  intended. Fixed: `addErr instanceof RepoQuarantinedError` now skips the cleanup attempt outright and
  rethrows `addErr` unchanged.

## Round 2 (Code Review of `a8dbb159`, reviewer `0bf48d68`): HEALTHY, four minors

**The user-visible behavior change, stated explicitly (requested by the review):** before this card, a
`GitWriter.commit()` whose pre-commit hook outran `gitLocalMs` (default 15s) reported `ok:false` to the
caller, but the REAL git child usually kept running in the background and usually still landed the commit
once the hook finished — a timeout that looked like a failure but often silently "worked out". After this
card, that SAME commit is genuinely TREE-KILLED at `gitLocalMs` — the commit is ABORTED, not silently
landed late. On Windows, an MSYS-shelled hook descendant (`sh`, not a native win32 binary) is frequently
NOT confirmable-dead by `taskkill /T /F` even when actually killed (card `b966962b`, verified empirically —
see that memory/record for the mechanism) — so a GitWriter commit against a project whose hooks spawn an
MSYS shell commonly QUARANTINES that project's canonical repo until the escaped tail eventually exits on
its own (or a human clears it via `POST /internal/merge-quarantine/clear`), rather than merely failing once.
This is a real, user-facing behavior change for any project whose commit hooks are slow or MSYS-shaped —
not a regression in the sense of "newly broken", since the OLD behavior (silently racing an orphan against
future ops) was the actual bug 24c0bdba/bde5d1fe/this card close, but a human operating such a project will
now see commits GENUINELY fail (and occasionally a quarantine) where they didn't notice a problem before.

**Decision: `commit()` keeps the SAME shared `gitLocalMs` bound as `checkout()`/`createBranch()` — no new,
commit-specific timeout field.** `gitLocalMs` is already the one human-tunable lever for every LOCAL
git-write op GitWriter performs (not `push`, which has its own `gitPushMs`), is already allowed up to
120 000ms (2 minutes) via `platform.timeouts.gitLocalMs`, and is already threaded identically to every
`GitWriter` caller (REST, Platform Lead, loom-operator, the companion git-push lever). A project whose
hooks commonly run close to or past 15s should raise that EXISTING lever rather than relying on the old
silent-success race — introducing a SEPARATE, larger implicit default specifically for `commit()` would (a)
surprise an operator who set `gitLocalMs=15000` believing it bounds every local git-write op, including
commit; and (b) require widening `GitWriterDeps`/the `{gitLocalMs,gitPushMs}` shape across all four call
sites (`gateway/server.ts`, `mcp/platform.ts`, `mcp/operator.ts`, `mcp/orchestration.ts`) plus
`packages/shared/src/config.ts`'s validator — disproportionate structural change for "pick a different
number" when the existing lever already reaches the same outcome with no new surface.

**Item 2 — the test's own header overclaimed.** `git-writer-kill-confirm.mjs` section [3] (checkout/
createBranch/a repeated commit against an ALREADY-quarantined repo) is refused by
`withCanonicalIndexLock`'s PRE-EXISTING entry check (round 6 of `24c0bdba`), not by this card's new
per-call re-check inside `killableCanonicalRaw` — the entry check already refuses before the callback (and
therefore before `killableCanonicalRaw`) ever runs. **Fix:** corrected the header comment, and added section
[0] — a fast, test-seam-only (no real git process) case that genuinely exercises the new mechanism: a
quarantine raised by a SIBLING op between `commit()`'s own `add -A` and `commit` calls, inside a SINGLE
invocation, strictly after `withCanonicalIndexLock`'s entry check already passed cleanly. Verified the new
assertion is non-vacuous (checked for BOTH the pre-fix `git.commit()` method shape and the new
`git.raw(["commit",...])` shape — asserting only the new shape passes vacuously on pre-fix code, which
never reaches it at all).

**Item 3 — `deployOwnProject` re-checks quarantine only BEFORE gate admission, missing the queue window.**
A quarantine raised while the op sat queued behind another gate (the daemon-global cap defaults to 1) was
invisible until the deploy command had already run. **Fix:** a second `assertRepoNotQuarantined` check now
runs INSIDE the admitted `gateSemaphore.runExclusive` callback, immediately before `runGateSeq` — mirroring
`fastForwardCanonicalMain`'s own independent re-check (`24c0bdba` round 4 item 2: "the gate between
assembly and this call can run many minutes"). A caught admission-time quarantine returns a synthetic
`GateSequentialResult` (`passed:false`, captured via a closure variable so the final return can distinguish
it from a genuine command failure) — the pending-gate-op tombstone and `deploy` audit event still fire (the
tombstone was already minted before admission), unlike the pre-admission check's early return. Test:
`deploy-own-project.mjs` section (g) — a holder deploy occupies the one gate slot, a second deploy queues
genuinely behind it (polled via `snapshotGates()`), the quarantine is raised while queued, the holder
releases, and the queued deploy is asserted refused at admission with no host exec.

**Item 4 — two wording nitpicks, no behavior change.** `assertRepoNotQuarantined`'s refusal text
(`merge-quarantine.ts`) said "an earlier MERGE's git process tree" — now op-neutral ("an earlier
OPERATION's"), since every canonical-mutating entry point can raise this quarantine, not just a merge
(checkout/createBranch/commit/deploy-admission/batch assembly/fast-forward all can). `GitWriter.commit()`'s
own doc comment claimed `git commit -- <paths>` while the argv carried no `--` — fixed by adding `--` to the
argv (paths are already validated against a leading `-`, so this is defense-in-depth, matching `add`'s own
pathspec separator, not a correctness fix) rather than rewriting the doc to admit the gap.

## Do not

- Do not add a second, hand-rolled kill-wired dual-path to `GitWriter` — route every mutating call through
  `killableCanonicalRaw` (`git/bounded.ts`), the one shared helper `mergeBranchLocked`/
  `fastForwardCanonicalMain` already use.
- Do not forward `GitWriter`'s own test-seam `gitFactory` unconditionally into `killableCanonicalRaw` — use
  `killableGitFactory()`'s adapter, which returns `undefined` on every real/production call so production
  always takes the REAL tree-kill path, never a test fake's `.raw()`.
- Do not trust simple-git's own parsed `CommitResult.commit` hash after routing `commit` through
  `killableCanonicalRaw` — always re-read `git rev-parse HEAD` afterward, the same posture
  `mergeBranchLocked` already uses.
- Do not kill-confirm `GitWriter`'s own READ calls (`status`/`branchLocal`/`revparse`) inside the lock — a
  hung read can't leave mutating residue for a later caller to race; only a mutating call needs this.
- Do not silently drop `deleteBranch`/`deleteBranches`/`removeWorktree`'s exemption from kill-confirmation
  without a comment naming why (ref-only, hook-free, no shared index / relies on the caller's own entry
  check) — the next reader should find the reasoning at the site, not have to re-derive it.
- Do not let `deployOwnProject` run the human-configured `deployCommand` against a quarantined canonical
  repo, and do not check this AFTER gate admission — check before, mirroring `confirmWorkerMerge`'s own
  pre-admission backstop, so a quarantined repo never burns a shared gate slot on a foregone conclusion.
- Do not attempt `createWorktree`'s add-failure cleanup (`worktree remove -f -f`) when the original `add`
  failure is itself a `RepoQuarantinedError` — nothing was mutated to clean up, and the cleanup call would
  be refused the identical way, producing a spurious "cleanup also failed" warning.
- Do not introduce a commit-specific timeout field distinct from `gitLocalMs` (round 2) — raise the
  EXISTING `platform.timeouts.gitLocalMs` lever (already allowed up to 120 000ms) for a project whose hooks
  need more headroom; a second implicit default would silently widen what `gitLocalMs` means without the
  operator's knowledge, for a disproportionate structural cost (widening the shape across 4 call sites +
  the shared config validator).
- Do not claim a test exercises the NEW per-call re-check just because it asserts a refusal against an
  ALREADY-quarantined repo (round 2, item 2) — that's `withCanonicalIndexLock`'s pre-existing entry check
  (round 6 of `24c0bdba`). The per-call re-check only fires for a quarantine raised MID-SEQUENCE, inside a
  single invocation, after the entry check already passed — see `git-writer-kill-confirm.mjs` section [0].
- Do not assert a "never invoked" claim against only the NEW call shape (`git.raw(["commit",...])`) when a
  fake also exposes the OLD shape (`git.commit()`) — pre-fix code reaches the old shape and never the new
  one, so checking only the new shape passes vacuously on pre-fix code (round 2, item 2's own near-miss).
- Do not check `deployOwnProject`'s quarantine only BEFORE gate admission (round 2, item 3) — a quarantine
  raised while the op sits queued behind another gate (cap defaults to 1) is invisible until the deploy
  command has already run; re-check INSIDE the admitted `runExclusive` callback too, immediately before
  `runGateSeq`, mirroring `fastForwardCanonicalMain`'s own independent re-check.
- Do not word `assertRepoNotQuarantined`'s refusal (`merge-quarantine.ts`) as if only a merge can raise a
  quarantine (round 2, item 4) — every canonical-mutating entry point can (checkout/createBranch/commit/
  deploy-admission/batch assembly/fast-forward); keep it op-neutral ("an earlier operation's").

## Source

Card `d8bb2074`, from the Code Review of `bde5d1fe` (reviewer `7a7fa321`), itself a follow-up from round 6
of `24c0bdba`. Round 1 tests: `packages/daemon/test/git-writer-kill-confirm.mjs` (new — a real
double-forked pre-commit hook escape against `GitWriter.commit()`, verified RED against the pre-fix
`git/writer.ts` and GREEN after: the repo quarantines on the unconfirmed kill, `commit()`/`checkout()`/
`createBranch()` all refuse on the live quarantine, and it auto-clears once the escaped descendant's own
eventual exit lets confirmation arrive), `packages/daemon/test/deploy-own-project.mjs` section (f) (new —
verified RED against the pre-fix `sessions/service.ts` and GREEN after), plus the existing `git-writer.mjs`,
`git-writer-branchlocal-hang-bound.mjs`, `merge-writer-index-lock.mjs`, `canonical-git-helper-guard.mjs`,
`canonical-git-isolation.mjs`, `merge-commit-kill-confirm.mjs`, `merge-quarantine-batch.mjs`,
`merge-quarantine-boot-hardening.mjs`, `merge-quarantine-lock-convergence.mjs`,
`merge-quarantine-recheck.mjs`, `merge-quarantine-token-set.mjs`, and every `batch-merge*.mjs` file, all
re-verified GREEN unchanged. Round 2 (Code Review of `a8dbb159`, reviewer `0bf48d68`): HEALTHY, no blocker
— four minors, all fixed in this round. Tests: `git-writer-kill-confirm.mjs` section [0] (new — the
mid-sequence per-call re-check, verified RED against the pre-fix `git/writer.ts` and GREEN after, including
the vacuous-pass near-miss caught and fixed in the SAME pass) and `deploy-own-project.mjs` section (g) (new
— the admitted-time re-check, verified RED against the pre-fix `sessions/service.ts` and GREEN after).
