# af436c99 — Recognize `git worktree add`'s own benign progress text as success, not failure

## Narrative

Card `af436c99`: `git worktree add`'s own SUCCESS output is entirely informational progress text — `Preparing worktree (new branch '…')` / `Preparing worktree (checking out '…')` / `HEAD is now at <sha> <subject>` — split across stdout and stderr. simple-git's default error detection flags a task as failed whenever the reported exitCode is truthy AND stderr carries ANY content at all (`error-detection.plugin.ts`'s `isTaskError`), with NO regard for what that content actually says — so an `add` that finishes genuinely fine, but whose completion-detection plugin reports a stale/misread non-zero exitCode (`completion-detection.plugin.ts` seeds `exitCode = -1`, itself truthy, until the child's `close`/`exit` events land — a known race under host contention), still throws a `GitError` whose entire message is that benign progress text. A real batch gate hit exactly this: `merge-deny-glob.mjs`'s own assertions all passed, then the process died on a `GitError` reading only `HEAD is now at 366e155 init\nPreparing worktree (new branch '…')`.

The fix recognizes ONLY that narrow shape — EVERY line of the error matches git's own known worktree-add progress format — and treats it as success once the resulting worktree is independently confirmed present and on the right branch (`worktreeAddLanded`). This deliberately does NOT swallow a genuine failure: a real `fatal:`/`error:` line, or either of `withTimeoutKillingChild`'s own wrapper suffixes ("git child killed" / "giving up … hung git child?"), never matches the benign pattern, so a killed/timed-out child and an "already used by worktree" failure fall straight through to the existing recovery + rethrow, unchanged (see `worktree-locked-residue-cleanup.mjs`, which pins exactly that).

## Do not

- Do not widen the benign-noise pattern beyond git's own known worktree-add progress lines — a genuine `fatal:`/`error:` line or a `withTimeoutKillingChild` wrapper suffix must never match it.
- Do not trust the benign-noise pattern match alone — always independently confirm the worktree actually landed (`worktreeAddLanded`) before treating the error as a false positive.

## Consequences

A spurious `GitError` from simple-git's exitCode-race false positive no longer fails a `worktree add` that actually succeeded; a real failure (locked path, hung child, genuine git error) is unaffected and still propagates.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, inside `createWorktree`'s `worktree add` catch block (~line 1079), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
