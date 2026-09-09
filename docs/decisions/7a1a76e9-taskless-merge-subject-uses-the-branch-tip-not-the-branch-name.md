# 7a1a76e9 — A taskless merge's fallback subject is the branch TIP commit's, never the branch name

## Narrative

`deriveTasklessSubject` is the taskless-merge counterpart to `mergeBranchLocked`'s subject derivation. A taskless worker (`worker_spawn`'s ad-hoc no-card path) has no `taskTitle` to fall back to, so the subject used to fall back to the branch NAME itself — `chore: loom/<branch>`, the one string guaranteed NOT findable on main after a squash (the successor-check convention is `git log --grep "<subject>"`, and a squash discards the branch ref). This derives a real subject from the branch's OWN history instead: `git log -1 --format=%s <branch>` — the branch's TIP (most recent) commit's subject line.

DECISION (there is no obviously-right answer for a multi-commit branch, made explicitly and documented): TIP, not the first commit. A worker's tip commit is the one it most recently chose to write — closer to "what actually shipped" than an early commit a later one may have superseded — and it's also what a human skimming `git log <branch>` sees first. `-1` also needs no walk, so this is a single cheap ref read either way.

FAILS SAFE to `undefined` (never throws) on any git error/timeout/empty-branch — every caller falls back to the branch name on `undefined`, exactly as before this card.

## Do not

- Do not fall back to the branch name as a taskless-merge subject — it is guaranteed unfindable on main after a squash, defeating the successor-check convention.
- Do not derive the fallback subject from the branch's FIRST commit — the tip was chosen deliberately as closer to "what actually shipped."

## Consequences

A taskless worker's squash-merge commit carries a real, findable subject instead of the one string that could never be found by the successor-check convention afterward.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `deriveTasklessSubject`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
