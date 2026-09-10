# 5a7692a4 — `gracefulShutdown` becomes merge-danger-aware, and why the tracker is two persistence layers

## Narrative

`gracefulShutdown` (index.ts) used to call `process.exit(0)` unconditionally, with zero awareness of an in-flight canonical merge squash — a signal (SIGINT/SIGTERM/SIGHUP) or an owner-initiated `loom stop` landing mid-squash was a real, measured ~92s-margin near-miss. `merge-danger-window.ts` closes that gap: it lets `gracefulShutdown` ask "is anything in a merge danger window right now" and delay its own exit by a short, bounded grace (`waitForMergeDangerWindowsToClear`) before exiting regardless. It is never a hard refusal of the owner's stop — only a bounded delay, capped at `MERGE_DANGER_SHUTDOWN_GRACE_MS`, that always resolves and always exits.

The tracked interval — "the danger window" — is the narrow span inside `mergeBranchLocked` (git/worktrees.ts) during which a canonical repo's git index holds THIS op's own staged-but-not-yet-committed squash diff, from just before `git merge --squash` through the final `git commit` (or, on a conflict/rawError/probe-failure exit, through that same exit's own cleanup `git reset --hard`). A process death inside this span leaves the canonical repo with uncommitted staged content that the entry check card `9e77050f`/`06b5c47f` then refuses the next merge on (see [[2eddf573-squash-merge-is-idempotent-and-refuses-on-ambiguous-dirty-state]]) — the "trigger-3" hazard — and it never auto-clears without a human. `enterMergeDangerWindow` is called right before that `git merge --squash`; a rejection that returns with zero side effects before that call (e.g. `gateBaseInvalidated`, caught before any write) never marks the repo as being in the danger window at all.

## Two persistence layers, deliberately different, for two different questions

- The in-memory `Map` (`activeDangerWindows`) is live-process state, answering only what the CURRENTLY-RUNNING process needs for its own bounded wait above.
- `enterMergeDangerWindow`/`exitMergeDangerWindow` ALSO durably write/clear a per-repo latch file via `merge-danger-latch.ts`, for the boot-time EVENT question a hard death (SIGKILL, power loss, a crash that never runs any handler) leaves unanswered: "did THIS process die inside a merge squash." See `merge-danger-latch.ts`'s own doc for why `scanCanonicalReposForMergeResidue`'s unconditional STATE probe (git/worktrees.ts, "is the tree dirty right now") answers a related but genuinely different question and cannot substitute for this.

Both writes happen inside the SAME function on each side (`enterMergeDangerWindow` sets the Map entry and calls `writeMergeDangerLatch`; `exitMergeDangerWindow` clears both the same way) — one call, two persistence layers, so the two can never drift out of sync with each other.

## Do not

- Do not treat the in-memory tracker as sufficient on its own — it is wiped by a hard death, which is exactly the case the durable latch exists for.
- Do not turn the bounded wait into a hard refusal of the owner's stop — it must always resolve within its grace ceiling and always exit afterward.

## Consequences

A signal or an owner-initiated stop landing mid-squash now waits a short, bounded grace for the merge to settle before exiting, instead of exiting unconditionally into the ~92s-margin near-miss window; a hard death still leaves an attributable record via the durable latch for the next boot to report.

## Why the boot-time residue scan can't substitute for the latch, and why one file per repo

`scanCanonicalReposForMergeResidue` (git/worktrees.ts) answers a STATE question at every boot — "is the canonical tree dirty right now" — unconditionally, regardless of how the prior process died. The latch answers a different, EVENT question the scan structurally cannot: "did THIS process die inside a merge squash." That distinction earns two things a bare dirty-tree scan can't give a boot-time report on its own: (1) it lets the report NAME the specific repo/branch/op instead of an unattributed dirty tree, indistinguishable from ordinary human WIP; and (2) it lets the report say something at all when the tree came back CLEAN — a mid-window death that happens to leave no residue is invisible to a state probe (`status === ""` ⇒ nothing to print) but is still exactly the event a human deserves to hear about ("we exited inside a merge window; tree looks clean").

The latch itself is one JSON file per canonical repo path, keyed by a hash of `canonicalRepoLockKey`, under LOOM_HOME alongside the other daemon-stop classifiers (`last-shutdown.json`, `crash.log`, `restart-intent.json`) — one file per repo because a daemon can have several repos each independently mid-squash at once (the per-repo mutex only serializes within one repo).

## Source

Inline comments in `packages/daemon/src/git/merge-danger-window.ts`: the module-level doc comment and `enterMergeDangerWindow`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.

The "Why the boot-time residue scan can't substitute" section above is sourced from `packages/daemon/src/git/merge-danger-latch.ts`'s own module-level doc comment, as of this worktree's HEAD before this extraction (`git/merge-danger-latch.ts, tranche 1`) — same treatment: wrapped lines joined, `*` markers stripped, no wording changed.
