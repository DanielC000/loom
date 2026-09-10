# 8e75ee20 — `withTimeoutKillingChild`: release a lock only once the child is CONFIRMED dead

## Narrative

Card `8e75ee20`: `withTimeout` alone is not sufficient for a caller that holds a lock over shared on-disk state (e.g. `git/repo-lock.ts`'s `withCanonicalIndexLock`) — it rejects on a bare, independent timer and abandons the wrapped promise `p`, so the lock releases while the git child `p` is backed by may still be running and still mutating that shared state, reopening exactly the race the lock exists to close.

`withTimeoutKillingChild` closes it. On expiry it calls `controller.abort()` — this requires `p`'s git instance to have been constructed with that same controller's `signal` passed to `boundedSimpleGit`'s `abortSignal` param, so the abort reaches simple-git's `abortPlugin` and issues a REAL kill (`spawned.kill("SIGINT")` — forceful/TerminateProcess-equivalent on Windows, since Windows has no real signals). Rather than settling independently after issuing the kill, the function keeps awaiting `p` itself: `p` (a `git.raw()` call) only resolves/rejects once simple-git's completion-detection plugin observes the child's REAL `close`/`exit` event (verified at source, `completion-detection.plugin.ts` — this runs unconditionally, kill or no kill) — so a caller that awaits this function's result really is only released once the child is confirmed dead, not merely signaled.

**THE LOAD-BEARING PROPERTY, stated precisely because it's easy to "simplify" away:** killing the child is NOT BY ITSELF enough to make releasing the lock safe — a kill signal doesn't guarantee the child is dead the instant it's sent, only that it will die soon. A version of this function that killed the child and then resolved/rejected independently on its own timer — the same shape as `withTimeout` — would reintroduce the exact race this exists to close, just with a much smaller window.

`killGraceMs` (default: `ms`, i.e. a doubled worst-case ceiling) is the explicit, bounded fallback for the residual case where even the kill fails to make `p` settle — a test double that ignores `abort` (this file's own callers keep using bare `withTimeout` against those, since there's no real child to kill or wait for), or, in production, a pathological child that doesn't die on signal. Past that grace window this gives up and rejects anyway, accepting the same abandon-the-child risk `withTimeout` always has — bounding the CONSEQUENCE of a kill that doesn't work, not pretending it can't happen. This "gave up without confirmation" rejection is PATH 2; see the `963f69ab` record for the discriminator that tells it apart from a confirmed-dead PATH-1 rejection.

`boundedSimpleGit`'s own `abortSignal` param exists only to wire this up: passed through as simple-git's `abort` construction option, it's what makes `controller.abort()` reach a real child. Omitted (the default) for every other caller, byte-for-byte.

The caller-side application of this decision — `createWorktree`'s three lock-scoped calls inside `withCanonicalIndexLock`, and why a test's `gitFactory` fake keeps using the plain `withTimeout` race instead — is in the `2fcd5eae` record, not repeated here.

## Do not

- Do not "simplify" `withTimeoutKillingChild` into a bare kill-then-settle race (killing the child, then resolving/rejecting on its own independent timer) — that reintroduces the exact lock race this function exists to close, just with a smaller window.
- Do not release a lock over shared on-disk state on a bare `withTimeout` race — use `withTimeoutKillingChild` so the lock is only released once the child is confirmed dead.

## Source

Inline comment in `packages/daemon/src/git/bounded.ts`, `withTimeout`'s own doc comment (~lines 24-29) and `withTimeoutKillingChild`'s doc comment (~lines 42-74, 213-217), as of commit `754f0f70`. Relocated by card `8b19e004`; wrapped source lines joined into flowing paragraphs, `*` comment markers stripped, no wording changed. See also the `2fcd5eae` record (caller-side application in `git/worktrees.ts`) and the `963f69ab` record (the PATH-1/PATH-2 discriminator this function's two settlement paths require).
