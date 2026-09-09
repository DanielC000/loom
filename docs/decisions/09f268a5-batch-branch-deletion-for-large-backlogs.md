# 09f268a5 — Batch `git branch -D` for large deletion backlogs, falling back per-branch only on failure

## Narrative

`deleteBranches` deletes MANY branches in as few git invocations as possible — measured for card `09f268a5`'s 275-branch backlog at ~14x faster than N sequential `deleteBranch` calls (14.1s → 0.99s on this host), because each `deleteBranch` call is a separate Windows subprocess spawn and spawn cost dominates at this N. It is a SEPARATE function from `deleteBranch`, which is left byte-identical — `deleteBranch` has other callers (`finalizeMerge`) this card must not perturb.

The implementation runs one batched `git branch -D <n1> <n2> ...` per `DELETE_BRANCHES_CHUNK_SIZE`-sized chunk. Git deletes every branch it CAN in one invocation and exits non-zero if ANY of them failed (checked out elsewhere since the caller's own `listCheckedOutBranches` read, concurrently removed, a locked ref, …) — so a naive "the whole chunk succeeded or none of it did" read would undercount `deleted` for branches that in fact WERE removed, and would abandon ~199 good deletions over one bad ref. On a chunk failure this falls back to per-branch `deleteBranch` calls for THAT CHUNK ONLY (idempotent — a branch the failed batch already removed is a harmless no-op there), verifying each via `branchExistsInRepo` so the returned `deleted` list — and therefore a caller's reclaimed-count — reflects what ACTUALLY happened, never an assumption. The slow per-branch path only ever runs on the rare failure; the common case keeps the full batched speedup.

`resolveMainlineBranch` exists as part of the same card: `HEAD` is NOT reliably mainline in this repo (the human-only `git_checkout` writer can switch the primary checkout onto an arbitrary existing branch, and the owner uses it), so any bulk `--merged` sweep that anchors on `HEAD` instead of a resolved mainline can silently delete branches merged into a temporarily-checked-out non-mainline branch instead — an unrecoverable-by-the-user data loss on exactly the destructive op this card exists to make safe. It reads the LOCAL `refs/remotes/origin/HEAD` symbolic ref (set at clone time / by `git remote set-head`) — a pure local ref read, never a network call — and FAILS CLOSED to `null` (no guessed fallback) when the ref is absent or the read errors/times out; every caller must treat `null` as "cannot determine mainline, skip this repo." This is a KNOWN GAP, not a bug: `refs/remotes/origin/HEAD` is written by `git clone`/`git remote set-head`, never by plain `git init` — and Loom's own `project_init` creates brand-new projects with `git init`, no remote — so such a repo always resolves `null` and its `loom/*` branches never get automatically reclaimed. That is the correct, deliberate trade-off (an inert sweep beats a wrong one), but it must stay visible to whoever's debugging "why didn't my branches get cleaned up," not fail silently.

## Do not

- Do not abandon a whole chunk's deletions because one branch in it failed — verify each branch in the failed chunk individually (`branchExistsInRepo`) rather than assuming none were removed.
- Do not perturb `deleteBranch` itself when optimizing bulk deletion — `finalizeMerge` depends on its existing single-branch behavior; `deleteBranches` is a deliberately separate function.
- Do not anchor a `--merged` branch-reclamation sweep on `HEAD` — resolve mainline via `resolveMainlineBranch` first; `HEAD` can be parked on an arbitrary non-mainline branch in this repo.
- Do not "fix" `resolveMainlineBranch`'s `null` case by falling back to a guessed `"main"` — that reintroduces the exact anchor hazard this function exists to close, and a caller must instead skip the repo (and log that it did) when mainline can't be determined.

## Consequences

Bulk branch reclamation is ~14x faster on this host's measured 275-branch backlog, at the cost of a more careful (verify-per-branch) fallback path on the rare chunk failure, instead of a simpler but wrong all-or-nothing read of the batch result.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `deleteBranches`'s own doc comment (~line 1280), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
