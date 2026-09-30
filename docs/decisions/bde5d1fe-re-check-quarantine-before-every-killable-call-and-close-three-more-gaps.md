# bde5d1fe — Re-check quarantine per killable call, kill-confirm the batch ff-only, close smaller gaps

Follow-ups from the round-6 review of `24c0bdba` — read that record first.

## Narrative

**Item 1 — re-check immediately before each killable call, not just once at lock acquisition.** Round 6
checks quarantine once, at lock acquisition. Two gaps: (a) a solo merge holds the lock across its whole
sequence after one check — an UNLOCKED concurrent batch can quarantine mid-sequence; (b) batch assembly
never takes the lock at all — only its own entry check (round 4) ever ran.

**Fix:** `killableCanonicalRaw` re-checks `assertRepoNotQuarantined` before every call, throwing before
spawning anything. A new `quarantineRepoPath` param (default `repoPath`) lets a worktree-path caller name
the real canonical repo — EXCEPT `attemptCodexAutoCommit` (hooks already disabled there). Every call site
checks `e instanceof RepoQuarantinedError` FIRST, refusing without cleanup and without re-raising (a fresh
token would never clear — no kill happened to trigger its own auto-clear).

**⚠️ CORRECTION (Code Review, item 2):** `killableCanonicalRaw` is NOT the one chokepoint every mutating
call routes through — verified false. Residuals, none kill-confirmed: **`GitWriter.checkout`/
`createBranch`/`commit`** — a real unprotected gap; carded separately. **`removeWorktree`'s own
unlock/prune** — relies entirely on its caller's own check. **`deleteBranch`/`deleteBranches`** — have
their own entry check (ref deletion skips the lock by design) but the git call is bare `withTimeout`;
lower risk, ref writes run no hooks.

**Item 2 — kill-confirm the fast-forward merge.** ff-only ran on a bare `withTimeout`. **Fix:** routed
through `killableCanonicalRaw` + a HEAD re-verify on ordinary failure.

**Item 3 — the batch worktree removal's stale snapshot.** `removeWorktree`'s OTHER call site gated on a
snapshot captured BEFORE the finalize loop — stale by removal time. **Fix:** extracted
`safeToRemoveBatchWorktree(repoPath, snapshot)`; pinned by an AST call-site check (a real CallExpression
to the helper — never `getText()`+regex, which a comment could spoof).

**Item 4 — the deploy build on a quarantined checkout.** `buildDaemon` installs+builds directly against
`root` — the SAME repo the merge path quarantines. **Decision: refuse** —
`assertRepoNotQuarantined(root)` first. Separately: the solo commit refusal now names the real STAGED
squash residue left behind and the `git reset --hard` needed after clearing.

**Item 5 (triage) — a leftover `.json.tmp-<pid>` was silently dropped at boot.** A crash between fsync
and rename leaves a durable, complete tmp file the old filter excluded outright. **Fix:**
`reenterMergeQuarantinesAtBoot` collects `.tmp-<pid>` files too: one already covered is stale residue,
cleaned up; otherwise parsed like a `.json` — valid content recovered + self-healed, invalid content gets
the same fail-closed treatment a corrupt `.json` gets.

**⚠️ Round 1 found the SAME bug at CLEAR time too:** neither clear path swept `.json.tmp-<pid>` residue,
so a stray tmp outlived a clear and re-quarantined an already-cleared repo at the next boot. **Fix
(kept):** both clear paths sweep matching residue via `deleteMergeQuarantineTmpResidue`.

**⚠️⚠️ Round 1's OTHER fix was WRONG — reverted in round 2.** It ALSO unlinked the tmp in the write's own
catch, on ANY failure — backwards: once fsync succeeds, that tmp IS the only durable record of an ACTIVE
quarantine, and deleting it on a failed rename (Windows EPERM) silently LIFTS a real one at the next
restart instead of re-arming it, reopening `24c0bdba`'s bypass (`b4315b52` re-arms, `9831522c` didn't).
**Fix:** dropped that unlink — a failed write LEAVES its tmp; PASS 1b recovers it.

**Item 6 (triage) — no test drove "queued behind a holder".** The lock's doc claims its check runs "once
prior settles" for exactly this, but every test quarantined BEFORE calling its writer (empty queue).
`merge-quarantine-lock-convergence.mjs` now drives two real concurrent callers.

## Do not

- Do not assume `killableCanonicalRaw` closes every site: `GitWriter`, `removeWorktree`, and
  `deleteBranch`/`deleteBranches` are known un-kill-confirmed residuals.
- Do not fold `RepoQuarantinedError` into `treeDeathUnconfirmed`'s branch, or re-raise for it; do not run
  `rollback()`/`resetOrSkip` after it — nothing was mutated.
- Do not omit `quarantineRepoPath` for a worktree `repoPath` — except `attemptCodexAutoCommit`'s exemption.
- Do not exempt the deploy build from the fail-closed posture, or leave a solo commit refusal silent
  about its STAGED residue and the `git reset --hard` remedy.
- Do not pin a call site with `getText()`/regex — walk for a real CallExpression instead.
- Do not let boot re-entry drop a `.json.tmp-<pid>` leftover — recover it, its content is durable.
- **Do not unlink a failed write's own tmp in the write's catch — round 1 did this (fixing a clear-path
  leak that didn't need it) and it LIFTED a real quarantine at the next restart, reopening `24c0bdba`'s
  bypass. Only the clear paths (`deleteMergeQuarantineTmpResidue`) sweep it.**

## Source

Card `bde5d1fe`, items 1–4; triage 5–7 by gen 381 (item 7 = item 3's site). Round 1 of Code Review
`b4315b52` fixed the clear-path sweep gap (kept), the chokepoint correction, the codex exemption, the
solo-refusal text, the AST pin — but its OWN fix regressed the write path (reverted in round 2:
`b4315b52` re-arms at boot, `9831522c` doesn't); round 2 also hardened the pin against spoofing. Tests
(RED against the wrong shape, GREEN restored): `merge-quarantine-recheck.mjs`, `merge-quarantine-batch.mjs`,
`batch-worktree-removal-live-recheck.mjs`, `build-gate-integrity.mjs`, `merge-quarantine-boot-hardening.mjs`,
`merge-quarantine-lock-convergence.mjs`.
