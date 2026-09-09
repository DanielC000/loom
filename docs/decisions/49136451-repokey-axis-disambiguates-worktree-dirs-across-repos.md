# 49136451 — `repoKey` adds a repo axis to the worktree dir only for a non-primary repo

## Narrative

`repoKey` (multi-repo epic `49136451` phase 2) adds a REPO AXIS to the worktree dir for a NON-primary repo: `WORKTREES_DIR/projectId/<repoKey>/<taskKey>` instead of `WORKTREES_DIR/projectId/<taskKey>`, so a task re-targeted across repos (or two different tasks on two different registry repos) can never collide on the same dir. Omitted, `undefined`, or `"primary"` keeps the ORIGINAL 2-segment path — byte-identical to every call before this param existed, which is load-bearing: an existing live worktree/branch must survive a daemon upgrade mid-flight. The branch name (`loom/<key>`) itself gets NO axis — branches are a per-repo namespace, so the same key can never collide across two distinct repos; only the shared filesystem path needs disambiguating.

## Do not

- Do not add a repo axis to the branch name — branches already live in a per-repo namespace and never collide across repos; only the shared filesystem path under `WORKTREES_DIR` needs it.
- Do not change the 2-segment path shape for `repoKey` omitted/`undefined`/`"primary"` — an existing live worktree/branch from before this param existed must resolve to the identical path across a daemon upgrade.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `createWorktree`'s own doc comment (~line 936, the `repoKey` paragraph), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
