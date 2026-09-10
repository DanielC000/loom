# 652d312f — worktree-vanished detection is fs-only, priced against a git-subprocess sweep, and deliberately doesn't cover branch-deletion-alone

## Narrative

Card 652d312f is the DETECTION half of the two-pass-cascade incident `40b63f1c` fixed the CAUSE of:
`40b63f1c` stopped boot-reconcile from reaping a live recycled worker's worktree, but nothing told
anyone if a worktree or branch vanished for some OTHER reason. The originating incident's actual shape
was "present, empty, git-deregistered, branch gone" — the worker's own process still held the
directory handle, so the directory existed but was empty; a naive `existsSync` check would have missed
it entirely.

**Where detection lives, and why fs-only:** a periodic full `git worktree list` / `git branch --list`
sweep over every live worker was priced as real host cost and rejected — a polling loop calling out to
git per live worker, on a tick cadence, does not scale the way three targeted fs calls per worker do.
`detectVanishedWorktree` instead reads one ~70-byte `.git` pointer file and stats one path per check:
still fs-only, no `git` process spawned, for all three detected states (`gone`, `git_file_missing`,
`gitdir_target_missing`).

**What "vanished" does and doesn't cover:** the card named four candidate states — directory gone,
directory present but empty, present but git-deregistered, and branch deleted while the tree is
otherwise intact. The first three are covered by the three fs-derived states above. The fourth —
branch deleted alone — is explicitly OUT of scope: reliably telling "deleted" from "packed" needs
enumerating loose + packed refs, which is meaningfully more than a stat call, and it matches nothing
in the n=1 originating incident (the worktree itself was destroyed, not just the branch in isolation).

**How it surfaces, and why detect-only:** to the worker (a notice it can act on — stop and
`worker_report({status:"blocked"})`) and to the manager (check `worker_status`, then recycle or
re-dispatch — the manager decides). The card is explicit: do NOT auto-destroy or auto-recover anything.
Detection and surfacing only; recovery is a separate decision with its own blast radius.

## Do not

- Do not add a periodic `git worktree list` / `git branch --list` sweep as this watcher's detection
  mechanism — that cost was priced and rejected in favor of the fs-only three-state check.
- Do not treat a branch deleted while the worktree is otherwise intact as covered by this detector —
  it isn't, by design; that would need ref enumeration this watcher deliberately doesn't do.
- Do not have this watcher auto-recover or auto-destroy anything on detection — surface only, to both
  the worker and its manager, and let the manager decide.

## Limits

n=1 incident, one recycle chain, one host. Cost/benefit for this detector was genuinely arguable once
`40b63f1c` fixed the cause — the reason it still earned its place is that the cause fixed by `40b63f1c`
was only ONE route to a destroyed worktree, and the failure mode is silent: a worker can keep burning
turns against a tree that cannot produce a merge, with nothing telling it or its manager.

## Source

JSDoc comments in `packages/daemon/src/orchestration/worktree-vanished-watcher.ts`: the
`detectVanishedWorktree` doc's fs-only/pricing note (lines 70-76) and its "NOT covered" note
(lines 99-100), and the `WorktreeVanishedWatcher` class doc's opening paragraph (lines 107-114), all
as of this tranche's HEAD (worktree-vanished-watcher.ts, tranche 1).
