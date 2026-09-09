# 06b5c47f — `resetOrSkip`: skip the cleanup entirely rather than risk a quieter, more ambiguous reset

## Narrative

Every `reset --hard HEAD` in `mergeBranchLocked` past the entry check (see [[2eddf573-squash-merge-is-idempotent-and-refuses-on-ambiguous-dirty-state]]) discards BOTH staged and unstaged tracked state — a wider blast radius than the staged-only entry check proved safe. `resetOrSkip` is the guard scoped to that wider radius: when unstaged dirt predated this merge attempt, it SKIPS the reset (leaving whatever's on disk untouched) instead of risking a human's pre-existing unstaged edits, and reports why. What it leaves behind on skip is provably safe to leave: the entry check already proved the index was clean, and git itself refuses to let `--squash` silently overwrite unstaged local modifications (it errors instead), so anything staged from this point on is this squash's OWN output — which the staged entry check will refuse on loudly next time, not silently absorb.

## Rejected alternative: a mixed reset

A MIXED reset (`git reset HEAD`, no `--hard`) looks like a strictly better move — it clears the staged residue without touching the working tree, reading as "auto-recover AND protect the human's edits" instead of "skip and make a human clean up." It is not. `--squash` applies its diff to the WORKING TREE as well as the index (a real merge, just uncommitted) — a mixed reset only unstages that diff, it does not undo it. The squash's output would keep sitting in the canonical working tree as unstaged noise, indistinguishable from ordinary WIP. That state is QUIETER than what this function ships, not safer: `diff --cached` would come back empty, so the NEXT merge attempt would proceed (not refuse) and `--squash` a new branch on top of a tree that already silently carries a previous branch's abandoned changes — trading a loud, correct refusal for a silent, ambiguous working tree. Silent-and-ambiguous around this exact function is what cost a reviewed P1 (see this file's own file-level corruption-history doc for that incident). This function does not reintroduce that shape to buy a nicer-looking auto-recovery.

One real consequence of skipping instead: a genuine squash CONFLICT that lands on top of pre-existing unstaged dirt leaves the canonical repo needing HUMAN cleanup (conflict markers + the unstaged dirt, both left in place) rather than auto-resolving — the same `9e77050f` stance (refuse loudly, a human resolves), now correctly SCOPED to cases that are actually dangerous instead of firing on ordinary WIP. Deliberate, not a regression.

## Danger-window tracking (card `5a7692a4`)

From right before `git merge --squash` through every exit (success, or a handled conflict/rawError/probe-failure exit, each via its own `resetOrSkip` cleanup call INSIDE the same try, so the window stays marked active until that cleanup has itself settled) is the interval a process death can leave the canonical repo with staged, uncommitted residue that never auto-clears. See `merge-danger-window.ts` for the full doc and how `gracefulShutdown` uses this to bound its own exit.

## Do not

- Do not use a mixed reset (`git reset HEAD`, no `--hard`) as a "nicer" auto-recovery for staged residue over pre-existing unstaged dirt — it leaves the squash's output sitting as silent unstaged noise, letting the NEXT merge proceed onto a tree that secretly carries an abandoned branch's changes.
- Do not close the danger window before the cleanup call inside the same try has itself settled — a process death mid-cleanup must still be covered by the window.

## Consequences

A genuine squash conflict on top of pre-existing unstaged dirt now correctly requires human cleanup instead of either auto-resolving destructively or silently leaving ambiguous residue for the next merge attempt to trip on.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `resetOrSkip`'s own doc comment and the danger-window-tracking comment immediately preceding `enterMergeDangerWindow`, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
