# bd9fc808 — Run directory removal in a killable child process, not the libuv threadpool

## Narrative

`killableRemoveDir` is the fix for bd9fc808's leak. The prior backstop (`fs.promises.rm`) runs on the libuv THREADPOOL; a wedged directory handle makes that call hang past any timeout imposed from JS (`withTimeout` only stops US waiting — the detached call keeps occupying a threadpool slot FOREVER, and there is no API to cancel an in-flight threadpool task). With only 4 threads by default, a handful of wedged dirs starves fs/dns/crypto process-wide — the incident this task exists to fix.

This instead runs the removal in a SEPARATE OS PROCESS. A wedged handle blocks only that child, never a daemon thread, and on timeout it is FORCE-KILLED (`killRemoveChild`) — an OS-level TerminateProcess/SIGKILL that works regardless of what the child is blocked on, unlike a threadpool task with no kill primitive at all. A killed child releases everything it held, and every NORMAL path (found already-gone / removed / clean failure / killed) RESOLVES (never settles false-negative) within `timeoutMs` — the function is not designed to reject. A synchronous throw from an injected `spawnChild` seam would still propagate as a rejection via the Promise executor; the real default spawn never throws synchronously, and callers already wrap this in a `.catch` for exactly that belt-and-suspenders reason.

## Do not

- Do not go back to `fs.promises.rm` (or any other libuv-threadpool-backed removal) as the timeout backstop here — a wedged handle would leak a threadpool slot forever, with no way to cancel it, and starve fs/dns/crypto process-wide.
- Do not loop a retry directly on a KILLED (wedged) removal in-process — that reintroduces the same class of leak this fix closes; a genuinely wedged removal belongs on a slower, longer-lived retry policy (see the caller, `SessionService`), never a fast in-process loop.

## Consequences

A wedged directory handle now blocks only a disposable child process, force-killed on timeout, instead of permanently occupying one of the daemon's 4 threadpool threads — closing the process-wide starvation this task's incident produced.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `killableRemoveDir`'s own doc comment (~line 1426), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
