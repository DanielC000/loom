# 49136451 — `repoKey` adds a repo axis to the worktree dir only for a non-primary repo

## Narrative

`repoKey` (multi-repo epic `49136451` phase 2) adds a REPO AXIS to the worktree dir for a NON-primary repo: `WORKTREES_DIR/projectId/<repoKey>/<taskKey>` instead of `WORKTREES_DIR/projectId/<taskKey>`, so a task re-targeted across repos (or two different tasks on two different registry repos) can never collide on the same dir. Omitted, `undefined`, or `"primary"` keeps the ORIGINAL 2-segment path — byte-identical to every call before this param existed, which is load-bearing: an existing live worktree/branch must survive a daemon upgrade mid-flight. The branch name (`loom/<key>`) itself gets NO axis — branches are a per-repo namespace, so the same key can never collide across two distinct repos; only the shared filesystem path needs disambiguating.

## Do not

- Do not add a repo axis to the branch name — branches already live in a per-repo namespace and never collide across repos; only the shared filesystem path under `WORKTREES_DIR` needs it.
- Do not change the 2-segment path shape for `repoKey` omitted/`undefined`/`"primary"` — an existing live worktree/branch from before this param existed must resolve to the identical path across a daemon upgrade.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `createWorktree`'s own doc comment (~line 936, the `repoKey` paragraph), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.

## `worker_spawn` resolves the target repo before cutting a worktree; a stale repoKey THROWS, never degrades

`worker_spawn` resolves which repo a worktree is cut from (`resolveRepo`) before creating it: a taskless
spawn has no `repoKey` to carry (always primary); a tasked spawn resolves off the task's CURRENT
`repoKey`. This is a WRITE/spawn path (unlike the ship-state/advisory reads elsewhere in this codebase),
so a stale `repoKey` (a registry entry removed after the task was written) is left to THROW here rather
than silently degrade to primary — better to fail the spawn loudly than cut a worktree in the wrong repo.
The resolved `{key, path}` is stamped onto the session (`Session.repoKey`) and used for every later op on
THIS worktree (gate/merge/finalize/boot-reconcile) instead of re-resolving from the task each time.

A review spawn (`reviewForkFrom` set) cuts its worktree from the SAME repo the reviewed branch lives in —
never always-primary — so the review target's own resolved repo wins over the normal taskId-or-primary
resolution.

### Do not (2)

- Do not silently degrade to the primary repo when a task's `repoKey` no longer resolves in the registry
  — throw. `worker_spawn` is a write path; cutting a worktree in the wrong repo is worse than a loud
  failure.
- Do not resolve a review spawn's target repo the normal taskId-or-primary way — it must cut from the
  SAME repo as the reviewed branch, regardless of what the task's own `repoKey` would otherwise resolve to.

### Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts` (`worker_spawn`'s repo resolution): lines
6068-6079, as of commits `c835de50ce30c2786258c46117a36e5ae9c71b77` (`feat(orchestration): multi-repo
phase 2 — thread per-task repo through worktree/gate/merge/ship-state`) and
`a882e727c950a45be348e199d61a3e27e17b2d4a` (`fix(orchestration): fork review worktrees from the reviewed
branch tip`). Relocated by card `61632c05` (tranche 15); no wording changed, wrapped source lines joined
into a flowing paragraph and the `//` comment markers stripped.
