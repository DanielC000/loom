# 9bf0db97 — a linked worktree gets NO codex-doctrine git-exclude; consumers filter it instead

## Round 1 (superseded)

`pty/codex-doctrine.ts`'s `hideCodexDoctrineFromGit` used to unconditionally append `/AGENTS.md` to
`resolveGitDirsSync(cwd).commonDir`'s `info/exclude`. For a LINKED worktree (every real codex worker:
CLAUDE.md), `commonDir` is the repo's SHARED `.git` directory — the same one every other worktree of the
repo resolves to, including the main checkout. `info/exclude` has no per-worktree copy in git; it is read
from `commonDir` for every linked worktree. Confirmed directly (git 2.47, Windows): writing `/AGENTS.md`
into the shared `info/exclude` from inside one worker's worktree made `git status` silently stop showing
an untracked `AGENTS.md` in a SIBLING worktree too — including the main checkout, where a human might
later add their own real, project-owned root `AGENTS.md` and have it silently never show up under
`git status`/`git add -A`.

Round 1's fix pointed `core.excludesFile` at a file inside the worktree's own PRIVATE gitdir, via a
per-worktree `config.worktree` — which only takes effect once `extensions.worktreeConfig = true` is set
in the SHARED `.git/config`, written by the spawn path itself.

## Round 1 was wrong — Code Review (CHANGES, 1 Critical + 1 Major, both reproduced on git 2.47)

**Critical:** appending `extensions.worktreeConfig = true` to the SHARED config is not the narrow,
observable-effect-free change round 1 assumed. It is repo-wide and persistent, fired on the very first
codex spawn, and breaks two real canonical shapes:

- A submodule-shaped canonical (`toplevel` resolves to `.git/modules/<s>`): every OTHER linked worktree of
  that repo starts listing gitdir-internal paths as untracked in `git status`.
- A bare canonical repo: git starts refusing worktree-affecting commands with "this operation must be run
  in a work tree".

Neither failure is scoped to the worktree that triggered the write — once set, it changes behavior for
every worktree of the repo, including ones no codex worker ever touches.

**Major:** a per-worktree `core.excludesFile` does not ADD to the worker's own global excludes
(`core.excludesFile` set in the user's own gitconfig, or `$XDG_CONFIG_HOME/git/ignore`) — it REPLACES
them, because git only ever reads ONE `core.excludesFile`, last-one-wins. `attemptCodexAutoCommit`
(`git/worktrees.ts`, `~attemptCodexAutoCommit`) stages every untracked file it finds via `status
--porcelain -z --untracked-files=all` and auto-commits + squash-merges them. With the worker's global
excludes silently defeated, a file the human normally relies on `.gitignore`/global-excludes to keep out
of commits (a stray `.env`, a `*.secret`) could get swept into that auto-commit and land on main.

## Round 2 (current) — filter at the consumer, write nothing

The reviewer verified a THIRD option doesn't exist either: a per-worktree `info/exclude` written under
the worktree's own PRIVATE gitdir (not `core.excludesFile`, not the shared `commonDir`) is simply not
honoured by git — git only ever reads `info/exclude` from `commonDir`. There is no git-level mechanism
that scopes an exclude pattern to one linked worktree without either leaking (shared `info/exclude`) or
replacing the user's own excludes (`core.excludesFile`).

So `hideCodexDoctrineFromGit` now writes **nothing** for a linked worktree (`privateDir !== commonDir`):
it returns immediately, leaving the worker's own global excludes completely untouched, and leaving a raw
`git status`/`git status --porcelain` in that worktree free to report the injected `AGENTS.md` as an
ordinary untracked file — exactly as if Loom had never touched exclusion at all.

Hiding it from the daemon's OWN view of "real work" is instead the job of the existing
`isCodexDoctrinePath` predicate, applied explicitly at every daemon code path that reads untracked files
out of a worker's worktree and decides what counts as the worker's product:

- `git/worktrees.ts#filteredWorkEntries` (feeds `uncommittedWorkFiles`, `worktreeStatusHasWork`,
  `computeWorktreeGateStamp`'s `dirtyHash`) — the shared "what counts as real work" foundation.
- `git/worktrees.ts#attemptCodexAutoCommit`'s own candidate filter, BEFORE anything is staged — so the
  injected `AGENTS.md` is never a candidate for the auto-commit this record's own Major finding is about.

A sweep of every other `git status`/`ls-files --others`/`-uall` consumer in the daemon (card `9bf0db97`
round 2, item 3) found no other site that reads untracked files out of a codex WORKER's own worktree:
`git/batch-merge.ts`'s dirty/conflict probes use `--untracked-files=no` or inspect merge conflicts (never
untracked files); `git/worktrees.ts`'s canonical-overlap preflights (`detectCanonicalDirtyOverlap`,
`detectCanonicalUntrackedOverlap`) read the CANONICAL repo, never a worker's worktree; `sessions/
service.ts#classifyRetainedWorktree` already goes through the shared `worktreeStatusHasWork`; and
`git/writer.ts` / `vault/versioner.ts` operate on the canonical/vault repo via the human-only write
surface, never a codex worker's worktree (`AGENTS.md` is only ever injected into a worker's own cwd). No
new filter site was needed.

The NON-worktree case (`privateDir === commonDir`: a plain repo, or the submodule-shaped canonical repo
`codex-doctrine-injection.mjs`'s own fixture covers) is unchanged from round 1/the original behavior:
`appendToSharedExclude` still writes `/AGENTS.md` into the shared `info/exclude` there — there is only one
worktree, so nothing can leak across siblings, and this is the `isCodexDoctrinePath` filters' own
fallback the other way: a bare non-worktree repo has no `AGENTS.md`-producing worker-worktree consumer to
rely on them anyway (the fallback exclude is the only hiding mechanism in that shape).

## Round 3 — remove the artifact itself when a non-codex session reuses the cwd

Filtering at consumers (round 2) keeps the DAEMON's own view clean, but a RETAINED worktree is reused per
taskId (`createWorktree`'s reuse path, `git/worktrees.ts` ~906; a recut's `git reset --hard` leaves an
untracked file exactly as it was), and a recycle can separately re-resolve a session's harness
codex→claude (`codexIncompatibilities`) without ever calling `createWorktree` again. Either way, the raw
untracked `AGENTS.md` is still sitting there for whatever NON-Loom tooling the next session uses —
including a worker's own manual `git add -A`, which `isCodexDoctrinePath` cannot filter.

`codex-doctrine.ts#removeStaleCodexDoctrineArtifact` unlinks it, fire-and-forget, from the ONE non-codex
branch of `PtyHost.spawn()` — the single chokepoint every fresh/resume/fork/recycle spawn for every
non-codex harness passes through, so it covers both triggers above without needing to know which applies.
Predicate: content starts with `CODEX_DOCTRINE_BEGIN` (never a real/foreign `AGENTS.md`) AND an async,
bounded `git ls-files` confirms it's untracked (any git error fails closed — never delete) AND no OTHER
live codex session shares this cwd (re-checked immediately before the unlink, not only at call entry, to
narrow the window against a codex session starting up concurrently). The live-session check is injected by
the caller (`PtyHost.hasLiveCodexSessionAtCwd`) — this module has no access to `PtyHost`'s live maps — and
normalizes paths the same way `git/worktrees.ts#normForCompare` already does (resolved/realpath, case-
folded on win32 only), not a new scheme.

## Do not

- Do not revert to writing the codex-doctrine exclude pattern into `commonDir`'s shared `info/exclude` for
  a LINKED worktree — that is round 1's original leak.
- Do not reintroduce a per-worktree `core.excludesFile` (or `extensions.worktreeConfig`) for a linked
  worktree — that is round 1's REPLACEMENT fix, and it's the one this record's Critical + Major findings
  killed: it breaks submodule/bare-canonical `git status` repo-wide, and it silently defeats the worker's
  own global excludes for auto-commit staging.
- Do not try a per-worktree `info/exclude` under the PRIVATE gitdir either — verified: git does not honour
  it; only `commonDir`'s copy is ever read.
- Do not add a NEW untracked-file consumer (a new git-status/ls-files-based check on a worker worktree)
  without also filtering it through `isCodexDoctrinePath` — there is no exclude-based safety net to fall
  back on for a linked worktree any more.
- Do not shell out to the `git` binary to manage the EXCLUDE mechanism above — the pty spawn path must not
  do blocking subprocess work; that mechanism is plain, best-effort `fs` only. (Round 3's
  `removeStaleCodexDoctrineArtifact` is a DIFFERENT mechanism and may use a bounded, ASYNC `git ls-files`
  — never synchronous/blocking — fired fire-and-forget off the hot path; see that round's own section.)
- Do not delete the artifact without the live-codex-session guard, and do not check that guard only once at
  call entry — round 3's whole point is a worktree a human/claude session can share with a still-running
  codex worker (e.g. a canonical root); the re-check right before unlink is load-bearing, not redundant.
- Do not delete a TRACKED `AGENTS.md`, or one that doesn't start with `CODEX_DOCTRINE_BEGIN` — identical
  "never clobber/remove the real thing" posture as `injectCodexDoctrine`.
