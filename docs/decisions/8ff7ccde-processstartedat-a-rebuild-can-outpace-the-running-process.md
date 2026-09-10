# 8ff7ccde — `distBuiltAt` is an on-disk clock, not "what this process is running"; `processStartedAt` fixes that

## Narrative

`distBuiltAt` is an ON-DISK ARTIFACT clock: the newest mtime under the dist directories, right now, at call time. It is NOT "when this running process was built" — a rebuild that lands without a restart advances `distBuiltAt` while the process keeps executing whatever it loaded at its own start (Node reads a module's file once, at import time, and never re-reads it off disk again).

Measured live: a process that started at `04:14:01Z` was still reporting `distBuiltAt` of `10:05:14Z` — a build that landed nearly six hours AFTER the process began, that the process could not possibly be executing — and every gate-kind DB row this process wrote in between (1880 of them) was missing a field a merge at `07:30:24Z` unconditionally adds, proving the process really was still running pre-merge code the whole time.

`processStartedAt` fixes this: it is the moment this process's own currently-loaded code was read from disk. `runningCodeBuiltAt` is `min(distBuiltAt, processStartedAt)` — the earlier of the two is always a safe upper bound on what the process could actually be executing: if the dist is newer than the process, the process cannot have loaded that newer code no matter what its mtime says, so the process's own start time is the honest clock; if the process is newer than the dist (the normal case), the dist clock is already correct on its own. `stale`/`commitsBehind` are computed against THIS clock, so staleness can no longer be understated by a rebuild that outpaced a restart. `distAheadOfProcess` (`distBuiltAt` after `processStartedAt`) makes that exact divergence visible as its own field, rather than folding it silently into a corrected number — legible even in the (rare) case `commitsBehind` itself still reads 0.

This does NOT apply to the web signal (`webStale`/`webCommitsBehind`/`webDistBuiltAt`) — the daemon serves `packages/web/dist` live from disk on every request, so there is no "loaded at process start" gap for web assets to fall into.

## Do not

- Do not compute `stale`/`commitsBehind` against the raw `distBuiltAt` clock — use `runningCodeBuiltAt`, or a rebuild-without-restart silently understates staleness.
- Do not fold `distAheadOfProcess` silently into `commitsBehind` — keep it a separate, visible field.

## Source

Inline module-doc comment in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
