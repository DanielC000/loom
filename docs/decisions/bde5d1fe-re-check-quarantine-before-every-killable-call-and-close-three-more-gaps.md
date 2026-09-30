# bde5d1fe — Re-check quarantine per killable call, kill-confirm the batch ff-only, close smaller gaps

Follow-ups from round 6 of `24c0bdba` — read that record first.

## Narrative

**Item 1 — re-check before each killable call, not once at lock acquisition.** Round 6 checked once, at
lock acquisition. Gaps: (a) a solo merge holds the lock across its whole sequence after one check — an
unlocked concurrent batch can quarantine mid-sequence; (b) batch assembly never took the lock at all.

**Fix:** `killableCanonicalRaw` re-checks `assertRepoNotQuarantined` before every call, throwing before
spawning anything. A new `quarantineRepoPath` param (default `repoPath`) lets a worktree-path caller name
the real canonical repo — except `attemptCodexAutoCommit` (hooks already disabled there). Every call site
checks `e instanceof RepoQuarantinedError` first, refusing without cleanup or re-raising (a fresh token
never clears — no kill happened to trigger auto-clear).

**⚠️ CORRECTION:** not the one chokepoint every mutating call routes through. Residuals, none
kill-confirmed: `GitWriter.checkout`/`createBranch`/`commit` (real gap, carded separately),
`removeWorktree`'s unlock/prune (relies on its caller), `deleteBranch`/`deleteBranches` (own entry check,
bare `withTimeout`; lower risk, no hooks run).

**Item 2 — kill-confirm the fast-forward merge.** ff-only ran on a bare `withTimeout`. **Fix:** routed
through `killableCanonicalRaw` + a HEAD re-verify on failure.

**Item 3 — the batch worktree removal's stale snapshot.** `removeWorktree`'s other call site gated on a
snapshot captured before the finalize loop — stale by removal time. **Fix:** extracted
`safeToRemoveBatchWorktree(repoPath, snapshot)`; pinned by an AST call-site check (a real CallExpression,
never `getText()`+regex, which a comment could spoof).

**Item 4 — the deploy build on a quarantined checkout.** `buildDaemon` builds directly against `root`,
the same repo the merge path quarantines. **Decision: refuse**, checked first. Separately, the solo
commit refusal now names the real STAGED squash residue and the `git reset --hard` remedy.

**Item 5 (triage) — a leftover `.json.tmp-<pid>` was silently dropped at boot.** A crash between fsync and
rename leaves a durable, complete tmp file the old filter excluded outright. **Fix:**
`reenterMergeQuarantinesAtBoot` collects `.tmp-<pid>` files too: already-covered ones are stale residue,
cleaned up; otherwise parsed like a `.json`, recovered + self-healed, or fail-closed if corrupt (same as
a corrupt `.json`).

**THE RECURRING BUG CLASS (rounds 1 and 3, same file, four separate sites):** a sweep/unlink of tmp
residue may run ONLY AFTER a durable write of the state that supersedes it has succeeded — never before,
never unconditionally. Every violation silently LIFTED a real quarantine at the next restart, reopening
`24c0bdba`'s bypass:
- Neither clear path originally swept `.json.tmp-<pid>` residue — a stray tmp outlived a clear and
  re-quarantined an already-cleared repo at the next boot. **Fixed (kept):** both sweep via
  `deleteMergeQuarantineTmpResidue`.
- Round 1's own fix for that was ALSO wrong: it unlinked the tmp in the write's catch on ANY failure.
  Once fsync succeeds, that tmp is the only durable record of an active quarantine; deleting it on a
  failed rename (Windows EPERM) lifted a real one instead of re-arming it (`b4315b52` re-arms, `9831522c`
  didn't). **Fix:** dropped that unlink — a failed write LEAVES its tmp; PASS 1b recovers it.
- Round 3 found the SAME class twice more: `clearMergeQuarantineByToken` swept BEFORE its rewrite (if the
  final was already absent and the rewrite then failed too, nothing durable survived); PASS 1b's self-heal
  unlinked the recovered tmp even when its re-persist failed. **Fix:** both now gate the sweep/unlink on
  the write/promote actually returning `true` first.

**Item 6 (triage) — no test drove "queued behind a holder".** The lock's doc claims it checks "once prior
settles" for this, but every test quarantined before calling its writer (empty queue).
`merge-quarantine-lock-convergence.mjs` now drives two real concurrent callers.

## Do not

- Do not assume `killableCanonicalRaw` closes every site: `GitWriter`, `removeWorktree`, and
  `deleteBranch`/`deleteBranches` are known un-kill-confirmed residuals.
- Do not fold `RepoQuarantinedError` into `treeDeathUnconfirmed`'s branch, or re-raise for it; do not run
  `rollback()`/`resetOrSkip` after it — nothing was mutated.
- Do not omit `quarantineRepoPath` for a worktree `repoPath` — except `attemptCodexAutoCommit`'s exemption.
- Do not exempt the deploy build from fail-closed, or leave a solo refusal silent about its STAGED
  residue and the `git reset --hard` remedy.
- Do not pin a call site with `getText()`/regex — walk for a real CallExpression instead.
- Do not let boot re-entry drop a `.json.tmp-<pid>` leftover — recover it, its content is durable.
- **THE PRECISE RULE: a sweep/unlink of tmp residue may run only AFTER a durable write of the state that
  supersedes it has succeeded — never before, never unconditionally. Four sites broke this once each; only
  the full clear path sweeps unconditionally (a human confirmed resolution).**

## Source

Card `bde5d1fe`, items 1–4; triage 5–7 by gen 381 (item 7 = item 3's site). Round 1 fixed the clear-path
sweep gap, the chokepoint correction, the codex exemption, the solo-refusal text, the AST pin — but its
own fix regressed the write path (reverted round 2). Round 3 found the same bug twice more, fixed by
gating both on success. Tests (RED against the wrong shape, GREEN restored): `merge-quarantine-recheck.mjs`,
`merge-quarantine-batch.mjs`, `batch-worktree-removal-live-recheck.mjs`, `build-gate-integrity.mjs`,
`merge-quarantine-boot-hardening.mjs`, `merge-quarantine-lock-convergence.mjs`.
