# bde5d1fe — Re-check the quarantine before every killable call, kill-confirm the batch ff-only, close three smaller gaps

Follow-ups from the round-6 review of `24c0bdba` — read `24c0bdba-kill-confirm-canonical-merge-commits.md` first.

## Narrative

**Item 1 — re-check immediately before each killable call, not just once at lock acquisition.** Round 6
checks quarantine once, at lock acquisition. Two gaps: (a) a solo merge holds the lock across its whole
sequence after one check — an UNLOCKED concurrent batch can quarantine mid-sequence and it keeps
mutating; (b) batch assembly never takes the lock at all — only its own entry check (round 4) ever ran.

**Fix:** `killableCanonicalRaw` (`git/bounded.ts`) re-checks `assertRepoNotQuarantined` before every
call, throwing `RepoQuarantinedError` before spawning anything. A new `quarantineRepoPath` param (default
`repoPath`) lets a caller whose `repoPath` is an ephemeral worktree name the real canonical repo — EXCEPT
`attemptCodexAutoCommit` (`worktrees.ts`), exempt: `24c0bdba` already disables hooks there for an
unrelated reason, so there's no hook-escape vector to close. Every call site checks `e instanceof
RepoQuarantinedError` FIRST, refusing without further cleanup and without re-raising (a fresh token would
never clear — no kill happened to trigger its own auto-clear).

**⚠️ CORRECTION (Code Review of b4315b52, item 2):** `killableCanonicalRaw` is NOT the one chokepoint
every mutating call routes through — verified false. Three residuals, none kill-confirmed, none closed
here: **`GitWriter.checkout`/`createBranch`/`commit`** — a real unprotected gap; carded separately.
**`removeWorktree`'s own unlock/prune** — no check of its own, relies entirely on its caller.
**`deleteBranch`/`deleteBranches`** — DO have their own entry check (round 6; ref deletion skips the
index lock by design) but the git call itself is bare `withTimeout`; lower risk since ref writes run no
hooks.

**Item 2 — kill-confirm the fast-forward merge.** `fastForwardCanonicalMain`'s ff-only ran on a bare
`withTimeout`. **Fix:** routed through `killableCanonicalRaw` + a HEAD re-verify on ordinary failure (a
hung post-merge hook can outlive the timeout post-move).

**Item 3 — the batch worktree removal's stale snapshot.** `mergeBatchTracked`'s removal `finally` gated
`removeWorktree` on a `batchQuarantined` snapshot captured BEFORE the finalize loop — stale by removal
time. **Fix:** extracted `safeToRemoveBatchWorktree(repoPath, snapshot)`; pinned by an AST call-site
check so a revert to the bare snapshot fails a test, not just a review.

**Item 4 — the deploy build on a quarantined checkout.** `buildDaemon` installs+builds directly against
`root` — for self-hosting, the SAME repo the merge path quarantines. **Decision: refuse** —
`assertRepoNotQuarantined(root)` checked first. Separately (Code Review item 4): the solo commit refusal
now names the real STAGED squash residue left behind and the `git reset --hard` needed after clearing,
or the next solo merge refuses at entry with no visible cause.

**Item 5 (triage) — a leftover `.json.tmp-<pid>` was silently dropped at boot.** A crash between fsync
and rename leaves a durable, complete tmp file the old filter excluded outright. **Fix:**
`reenterMergeQuarantinesAtBoot` collects `.tmp-<pid>` files too: one already covered by a valid entry is
cleaned up as stale residue; otherwise parsed like a `.json` — valid content recovered + self-healed,
invalid content gets the same fail-closed treatment a corrupt `.json` gets.

**⚠️ REGRESSION FIX (Code Review item 1):** that fix itself had a bug — a failed write/rename in a LIVE
process (e.g. Windows EPERM) left its own tmp behind, and neither clear path swept it, so a stray tmp
outlived a clear and re-quarantined an already-CLEARED repo at the next boot. **Fix:**
`writeMergeQuarantineLatch`'s catch now unlinks its own tmp on failure; both clear paths sweep any
matching residue (`deleteMergeQuarantineTmpResidue`).

**Item 6 (triage) — no test drove "queued behind a holder".** The lock's doc claims its check runs "once
prior settles" for exactly this, but every test quarantined BEFORE calling its writer (empty queue).
`merge-quarantine-lock-convergence.mjs` now drives two real concurrent callers: quarantine raised while
the second sits queued behind the running first, refused once it acquires.

## Do not

- Do not assume `killableCanonicalRaw` closes every site: `GitWriter`, `removeWorktree`'s unlock/prune,
  and `deleteBranch`/`deleteBranches` are known un-kill-confirmed residuals.
- Do not fold `RepoQuarantinedError` into `treeDeathUnconfirmed`'s branch, or re-raise for it; do not run
  `rollback()`/`resetOrSkip` after a `RepoQuarantinedError` hit — nothing was mutated.
- Do not omit `quarantineRepoPath` for a worktree `repoPath` — except `attemptCodexAutoCommit`'s
  deliberate, hooks-disabled exemption.
- Do not exempt the deploy build from the fail-closed posture.
- Do not leave a solo commit refusal silent about its STAGED residue and the `git reset --hard` remedy.
- Do not let a failed write, or either clear path, leave `.json.tmp-<pid>` residue behind.
- Do not skip `safeToRemoveBatchWorktree`'s live re-check.

## Source

Card `bde5d1fe`, items 1–4; triage items 5–7 by gen 381 (item 7 = item 3's site). Code Review of
`b4315b52`: item 1 = tmp-residue-leak regression; item 2 = chokepoint correction; item 3 = codex
exemption; item 4 = solo-refusal residue text; item 5 = AST call-site pin. Tests (RED against the
pre-fix shape, GREEN restored): `merge-quarantine-recheck.mjs`, `merge-quarantine-batch.mjs` SCENARIO E,
`batch-worktree-removal-live-recheck.mjs` (+ pin), `build-gate-integrity.mjs` SCENARIO D,
`merge-quarantine-boot-hardening.mjs` TORN-WRITE + WRITE-FAILURE-RESIDUE,
`merge-quarantine-lock-convergence.mjs` QUEUED-BEHIND-A-HOLDER.
