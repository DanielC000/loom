# 44c28799 — Bound every git op in git/worktrees.ts to a 15s ceiling (GIT_OP_TIMEOUT_MS)

## Narrative

`GIT_OP_TIMEOUT_MS` (15,000ms) is the default per-git-op ceiling for every `boundedGit`/`boundedMergeGit` call in this file that doesn't override it (`removeWorktree` / `findLandedSquashCommit` / `deleteBranch` / `mergeBranchLocked` / `scanCanonicalReposForMergeResidue` / …). It is generous for a real op — sub-second normally, and this project's own local-git-write default in `git/writer.ts`'s `GIT_LOCAL_TIMEOUT_MS` agrees (same 15s, for the same "local plumbing op, not a network push" reasoning) — but bounded so a wedged child can't hang the caller.

This is the fix for the boot-outage: a git op on a busy/locked dir (e.g. a directory handle stuck by an unrelated process) hangs indefinitely — it doesn't throw — and a try/catch only catches throws. Originally introduced for boot-reconcile (Pass A: `findLandedSquashCommit` → `finalizeMerge`'s `removeWorktree` + `deleteBranch`; Pass B: `removeWorktree`), which ran these ops during daemon BOOT, so one hung op blocked the whole daemon from booting, for hours, on 2026-06-03 — since generalized to every bounded op in this file. Card `44c28799` added `mergeBranchLocked`'s own ~10 `git.raw` calls to the same bound: the squash-merge is local plumbing exactly like the rest, not a slow/legitimately-long-running gate, so the same 15s ceiling that's generous for a real merge is still tight enough to fail a wedged commit hook fast instead of wedging the per-repo merge mutex permanently.

## Do not

- Do not leave a new git op in this file unbounded — route it through `boundedGit`/`boundedMergeGit` (or thread a `BoundedGitDeps`) so a wedged child can't hang the caller.
- Do not lower the ceiling casually — 15s is deliberately generous for a real (sub-second) op and matches `git/writer.ts`'s own local-write timeout; it's sized to fail a genuinely wedged op fast, not to rush a slow-but-legitimate one.

## `scanCanonicalReposForMergeResidue` — the boot-time, read-only companion scan

Boot-time companion to `mergeBranchLocked`'s entry check: READ-ONLY, scans each given canonical repo path for dirty tracked state (staged and/or unstaged; untracked excluded, same rationale as the merge-time check). Reports BOTH kinds, worded differently — only STAGED content is the residue class the merge-time check actually refuses on (see [[06b5c47f-resetorskip-skips-rather-than-mixed-resets-on-pre-existing-unstaged-dirt]]); unstaged-only dirt (ordinary WIP, or a submodule gitlink ahead of its recorded pointer) will NOT block the next merge attempt. This does NOT close a hole by itself — the merge-time refusal already makes the corruption impossible on its own, since a staged-residue-bearing repo now fails its NEXT merge attempt closed instead of silently absorbing it. It exists only to SHRINK THE DETECTION WINDOW: without it, residue left by a daemon dying mid-merge sits unnoticed until someone happens to attempt a merge against that repo; with it, a boot-time scan surfaces it the moment the daemon comes back up.

NEVER resets, NEVER blocks boot, NEVER throws — same reasoning as the merge-time check: this can't tell a dead squash's leftover stage apart from a human's own work-in-progress either, so touching it here would be exactly as unsafe as touching it at merge time. A repo that isn't a real git checkout (a vault-only project's `repoPath`, or a deleted/unreadable directory) is silently skipped, not surfaced as a failure — a best-effort courtesy scan, not a boot gate.

BOUNDED + NON-INTERACTIVE, same pass as `mergeBranchLocked`: this ran an unbounded `simpleGit(repoPath)` with no block-timeout — a repo on a busy/locked disk would hang this loop's `await` forever, one repo blocking the scan of every repo after it. Fire-and-forget from the caller (`index.ts` never awaits this before serving traffic) kept the boot-blocking risk low even before this fix, but there was no reason to leave a second unbounded instance behind while fixing the first.

## Do not

- Do not have this scan reset or otherwise mutate anything — it can't distinguish a dead squash's leftover stage from real human WIP any better than the merge-time check can.
- Do not surface a non-git-checkout repo as a scan failure — silently skip it; this is a best-effort courtesy scan, not a boot gate.
- Do not leave this scan's `simpleGit` construction unbounded just because it's fire-and-forget — one busy/locked repo would still block every repo scanned after it.

## Consequences

A hung git op (a locked/busy directory, a wedged commit hook) now fails within ~15s instead of hanging the daemon indefinitely — critical during boot-reconcile, which runs before any worker session exists to notice a stall. A try/catch alone was never sufficient here — a hang doesn't throw — so every caller must go through the bounded wrapper rather than relying on its own error handling.

## No timeout inside `withCanonicalIndexLock` (`repo-lock.ts`, same card)

Deliberate: every caller is required to bound its own git calls (`boundedMergeGit`+`withTimeout` for merges; `GitWriter`'s own `withTimeout`+block-timeout `simpleGit` for writes), so `fn` always settles on its own — a wedged holder fails only its own op. A separate lock-level timeout was considered and rejected: it would let the next caller start while an abandoned `fn` might still run against the shared index, reopening the race this mutex closes.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `GIT_OP_TIMEOUT_MS`'s own doc comment (~line 97), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed. The `withCanonicalIndexLock` section is from `git/repo-lock.ts`'s own doc comment, as of this worktree's HEAD (card `4301fa9c`).
