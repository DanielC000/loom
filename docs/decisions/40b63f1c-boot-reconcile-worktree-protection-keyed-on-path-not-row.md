# 40b63f1c — boot-reconcile worktree protection keys on PATH, never session ROW

## Narrative

Source: a Codescape manager escalation, offered as an explicitly unverified hypothesis ("I have not
read Loom's source for this and am not asserting it"). Confirmed against source + daemon log: a
two-pass cascade, settled by the timeline below. Landed as commit `163877b5`
(full sha `163877b580b15c9f7420f6b5cd8efe150df938b7`).

### Log timeline (epoch-ms, `daemon-output.log`)

```
1787559506522  [pty] spawn 90c3d6a9 … resume=b0e8d86a               <- live successor RESUMED
1787559529018  [worktree] could not remove dir …7db9fa729639
                          (left on disk for a later GC)              <- Pass B reaps it, +22.5s
1787559548341  [reconcile] branch-ref sweep: 5 merged, 2 SKIPPED
                          (checked out elsewhere), 3 deleted: …
                          loom/7db9fa729639                          <- Pass C kills branch, +19s
1787559551768  [boot] reconcile: pruned 3 orphaned worktree(s)
```

The worker was resumed FIRST and already running when its worktree was destroyed 22 seconds later —
not a race against resume; resume had completed.

### Finding 1 — the removal partially failed BECAUSE the worker was alive, logged as routine

`[worktree] could not remove dir … (left on disk for a later GC)` is why the directory still existed
but was empty: deregistered, contents deleted, but handle-locked by the live worker's own process
(its cwd). The strongest possible liveness signal — the OS refusing a delete because something's
still using it — arrived DURING the destruction and was logged as a routine GC retry. A failed
worktree-dir removal is evidence something holds it, not fs flakiness to retry later.

### Finding 2 — Pass C's own log line carries its own positive control

"5 merged branch(es) found, 2 skipped (checked out elsewhere), 3 deleted: … loom/7db9fa729639" — the
checked-out-elsewhere gate fired CORRECTLY for the two intact, non-recycled live workers in the same
sweep, and failed only for the recycled one, because Pass B had deregistered its worktree 19 seconds
earlier. Same gate, same sweep, opposite outcomes — the discriminator is solely whether Pass B got
there first. Not a broken gate; a gate reading state an earlier pass just destroyed.

### Mechanism — two passes, each correct alone, composing into a hole

**Pass B** (`sessions/service.ts`) keys liveness protection on the ITERATED SESSION ROW
(`protectedSessionIds.has(s.id)`), never the worktree path. A recycle chain aliases ONE
`worktreePath` across TWO rows; the dangling predecessor still carries that path, isn't protected,
and is exited/dead — so it passes every filter and reaches the prune, and the live successor's
protection is never consulted. Order can't save it: the protected `continue` fires BEFORE
`handledWorktrees.add(worktreePath)`, so a protected session never claims its worktree.

`worktreeHasWork` (no commits ahead of main AND clean tree, the 2026-06-05 P0 data-loss guard) missed
this because it's a CONTENT test standing in for a LIVENESS test — blind exactly where liveness
matters most: a worker alive but hasn't written anything into its worktree yet. That's every worker
early in its task, and permanently true for a no-commit-by-design card (deliverable in the vault).

**Pass C** then deletes the branch, defeated by Pass B: its own live-worker safety gate reads git's
own `git worktree list` truth and names the exact case it believes it protects — "a just-cut worker
with zero commits yet." That's this worker exactly, but Pass C runs after Pass B, so its gate reads
state Pass B already destroyed.

### The false assurance

`sessions/service.ts`'s restart notice carried a hardcoded string literal, "your worktrees are
intact" — unconditional, computed from a separately-derived resume-facts list, never an actual check.
It could never be false regardless of disk state. The manager was told 3 workers resumed and their
worktrees were intact while one had its worktree emptied and branch deleted by that same boot, seconds
later.

## Do not

- Do not key any worktree-protection filter on a session ROW id — key on the worktree PATH (Mechanism
  above); and claim the worktree (`handledWorktrees.add(worktreePath)`) BEFORE a protected `continue`,
  not after, so "decide once per path" actually holds.
- Do not let a CONTENT test (`worktreeHasWork`) stand in for a LIVENESS test anywhere worktree
  destruction is gated.
- Do not treat a failed worktree-directory removal as fs flakiness to retry — it's a liveness signal;
  abort the reap for that path and surface it.
- Do not assert worktree integrity in a restart notice unless actually checked.

## Limits

n=1 incident, one recycled worker, one host. Fleet-wide exposure — how many recycle chains carry a
dangling predecessor row with a live `worktreePath` — was not audited. A follow-up narrowed one open
question: the same boot logged "pruned 3 orphaned worktree(s)" against only one identified instance;
the reporting manager confirmed exactly ONE recycled worker at that boot, so only one session could
exhibit the flaw — the other two were candidate-identified, not certain, as finished 0-commit rigs
whose removal would've been correct. No data was lost, and the bounding was luck (0 commits by
design, deliverable in the vault), not a safeguard — an ordinary code card with uncommitted work would
have been destroyed silently, with a notice telling the manager it was safe.

## Source

Cited (causal-fix reference only) in `worktree-vanished-watcher.ts`'s `WorktreeVanishedWatcher` class
doc, lines 107-119, tranche 1 HEAD. Full narrative above is from card `40b63f1c`'s own body — no
source comment carried it before this tranche.
