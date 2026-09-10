# sha:8d49d2dd — Run-cwd isolation via a disposable HEAD snapshot, not the live checkout

## Narrative

A `run` session must read the project's code but produce NO commit and NEVER dirty the LIVE checkout — yet it boots with the SAME gate-free posture as every other session (`CLAUDE.md`'s spawn-mode table), so Write/Edit are auto-approved. `cwd=`the real `repoPath` would let a run silently write into the live working tree.

So each run gets its OWN throwaway copy of the project's COMMITTED HEAD, extracted with no `.git` — hence NO branch and NO git-worktree admin record (sidesteps the worktree-GC bug class entirely; there is nothing for `git worktree prune` to chase). Any writes the run makes land in this disposable copy and are discarded on teardown. Committed-HEAD (not the working tree) is the deliberate, deterministic input semantics: an endpoint agent's answer must be reproducible, not dependent on whatever happens to be dirty in the live tree at call time.

This is the owner-approved Option A from Agent Runs R2 (owner-approved 2026-06-05).

### Extraction mechanism

Extraction is pure git plumbing (no `tar` dependency, cross-platform): populate a THROWAWAY index from HEAD (`read-tree`, via a per-run `GIT_INDEX_FILE` so the live repo's index/working tree are untouched), then `checkout-index -a` with an absolute `--prefix` into the snapshot dir. Tracked files only ⇒ no `.git`.

future: a run that needs untracked/gitignored DATA files would be a separate "run data mount" extension — out of scope for R2.

## Do not

- Do not set a run session's cwd to the live `repoPath` — it would let the run silently write into the live working tree, defeating the whole point of the snapshot.

## Consequences

A run reads a reproducible, disposable copy of committed HEAD; the live checkout is never touched, and the snapshot leaves no git-worktree admin record for `git worktree prune` to have to reconcile.

## Source (sha-keyed — no board card)

Inline comment in `packages/daemon/src/runs/snapshot.ts`, `createRunSnapshot`'s own file-header doc comment (lines 27–47), as of commit `8d49d2dd693199a55e92cfbc0947be056d8eea36` ("feat(daemon): Agent Runs R2 — AgentRun primitive + submit_result (ephemeral run kind)", 2026-06-06). No board card cites this block anywhere in the file or its `git blame` history; keyed by verified commit sha per `CLAUDE.md`'s `@decision sha:<id>` grammar. Wrapped/boxed source lines joined into flowing prose, comment markers stripped, no wording changed.
