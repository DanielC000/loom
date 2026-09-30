# bde5d1fe — Re-check the quarantine before every killable call, kill-confirm the batch ff-only, close three smaller gaps

Follow-ups from the round-6 review of `24c0bdba` — read
`docs/decisions/24c0bdba-kill-confirm-canonical-merge-commits.md` first.

## Narrative

**Item 1 — re-check immediately before each killable call, not just once at lock acquisition.** Round 6
checks quarantine once, at `withCanonicalIndexLock` acquisition. Two gaps survived: (a) a solo merge
(`mergeBranchLocked`) holds the lock across its whole sequence after passing its own check once — an
UNLOCKED concurrent op (a batch assembly) can quarantine the repo mid-sequence and the solo merge keeps
mutating past it; (b) batch assembly (`landBranchCommitsIndividually`) never takes the lock at all — only
its own entry check (round 4) ever ran, once, before its whole per-branch cherry-pick/commit loop.

**Fix:** `killableCanonicalRaw` (`git/bounded.ts`) — the one shared chokepoint every mutating call already
routes through — now re-checks `assertRepoNotQuarantined` immediately before every call, throwing
`RepoQuarantinedError` before spawning anything. A new `quarantineRepoPath` param (default `repoPath`)
lets a caller whose `repoPath` is an ephemeral worktree (batch land passes `batchWorktreePath`) name the
real canonical repo. Every call site now checks `e instanceof RepoQuarantinedError` FIRST (before
`treeDeathUnconfirmed`), refusing WITHOUT further cleanup and WITHOUT re-raising — a fresh token here
would never clear, since no kill happened this call to trigger its own auto-clear.

**Item 2 — kill-confirm the fast-forward merge itself.** `fastForwardCanonicalMain`'s `git merge --ff-only`
ran on a bare `withTimeout` + simple-git's single-process kill: no tree-kill, no quarantine raise on an
unconfirmed kill. **Fix:** routed through the SAME `killableCanonicalRaw`, same
`treeDeathUnconfirmed`→`enterMergeQuarantine` handling, plus a HEAD re-verify on an ordinary failure (a
hung `post-merge` hook can outlive the timeout after the ref moved).

**Item 3 — the batch worktree removal's stale snapshot.** `mergeBatchTracked`'s removal `finally` gated
`removeWorktree` on a `batchQuarantined` boolean captured BEFORE the per-branch finalize loop — stale by
removal time. `removeWorktree`'s other caller (`gcWorktreeDir`) already re-checks fresh. **Fix:**
extracted `safeToRemoveBatchWorktree(repoPath, snapshot)` = `!snapshot && assertRepoNotQuarantined(repoPath).ok`.

**Item 4 — the deploy build on a quarantined checkout.** `daemon_restart`'s rebuild runs install+build
directly against `root` — for self-hosting, the SAME repo the merge path quarantines; an orphan may still
be rewriting files there. **Decision: refuse.** `buildDaemon` now checks `assertRepoNotQuarantined(root)`
first.

**Item 5 (triage) — a leftover `.json.tmp-<pid>` was silently dropped at boot.**
`writeMergeQuarantineLatch` fsyncs before it renames — a crash there leaves a durable, complete tmp file
the old filter excluded outright. **Fix:** `reenterMergeQuarantinesAtBoot` collects `.tmp-<pid>` files
separately: one already covered by a valid entry is cleaned up as stale residue; otherwise it's parsed
like a `.json` — valid content is recovered and self-healed into its final name, invalid content gets the
same fail-closed treatment a corrupt `.json` gets.

**Item 6 (triage) — no test drove the "queued behind a holder" case.** The lock's own doc claims its
check runs "once `prior` SETTLES ... never before enqueueing" for exactly this, but every existing test
quarantined BEFORE calling its writer (empty queue). `merge-quarantine-lock-convergence.mjs` now drives
two real concurrent callers: quarantine raised while the second sits queued behind the running first,
refused once it acquires.

## Do not

- Do not add a canonical-mutating call via a bare `withTimeout` — route through `killableCanonicalRaw`.
- Do not fold `RepoQuarantinedError` into `treeDeathUnconfirmed`'s branch, and never re-raise for it.
- Do not run `rollback()`/`resetOrSkip` after a `RepoQuarantinedError` hit — nothing was mutated.
- Do not pass an ephemeral worktree as `repoPath` without ALSO passing the real repo as `quarantineRepoPath`.
- Do not exempt the deploy build from the fail-closed posture — refuse before spending the cycle.
- Do not let boot re-entry drop a `.json.tmp-<pid>` leftover — its content is durable; recover it.
- Do not skip `safeToRemoveBatchWorktree`'s live re-check — the captured snapshot is stale by removal time.

## Source

Card `bde5d1fe`, items 1–4; triage items 5–7 added by gen 381 (item 7 = same site as item 3, reconfirmed).
Tests (each RED against the pre-fix shape, GREEN restored): `merge-quarantine-recheck.mjs` (new, item 1),
`merge-quarantine-batch.mjs` SCENARIO E (item 2), `batch-worktree-removal-live-recheck.mjs` (new, item 3),
`build-gate-integrity.mjs` SCENARIO D (item 4), `merge-quarantine-boot-hardening.mjs` SCENARIO TORN-WRITE
(item 5), `merge-quarantine-lock-convergence.mjs` QUEUED-BEHIND-A-HOLDER (item 6).
