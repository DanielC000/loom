# 9edfc663 — catch the initial/every-tick throw in `WakeService.start()` and `Scheduler.start()`'s interval

`WakeService.start()` fired its first tick as a bare `void this.tick(now);` with no `.catch` — the
interval armed right after it already wrapped every later tick in `.catch(() => { ... })`, but the
initial call did not. Any synchronous throw inside `tick()` (e.g. a `db.listDueWakes` failure) became
an unhandled promise rejection; the daemon installs a process-level `unhandledRejection` handler
(`crashlog.ts`) that writes a crashlog and calls `process.exit(1)` — so a bad first tick could take the
whole daemon down at boot.

A sweep of every sibling watcher/scheduler/poller/dispatcher `start()` in `packages/daemon/src/
orchestration/` for the same shape found one more real instance: `Scheduler.start()`'s **interval**
(`this.timer = setInterval(() => { void this.tick(); }, ...)`) had no `.catch` at all — not just on the
first tick, but on every tick forever, since `Scheduler.tick()` is `async` and nothing above the
per-schedule-item try/catch blocks guards a throw from the top of `tick()` itself (e.g.
`db.listDueSchedules`). Every other watcher in that directory either has a synchronous `tick()` (a
`try { this.tick(); } catch {}` around the interval is sufficient there) or already wraps an async
`tick()`/`pollOnce()` in `.catch` on both the initial AND interval calls (`event-triggers.ts`,
`poll.ts`), or has a `tick()`/`pollOnce()` that is itself provably exception-free end-to-end
(`db-backup.ts`, `usage-status.ts`, `vault/versioner.ts`'s two tickers) — see the card's own
`worker_report` for the full per-file list and why each one was or wasn't touched.

## Do not

- Do not fire an async watcher/scheduler tick via a bare `void this.tick()` (or `void
  this.<method>()`) anywhere on a `start()`/interval path without a trailing `.catch` — a `try/catch`
  wrapped around the CALL (not an `await`) never catches an async function's own internal throw; the
  throw is already converted to a promise rejection before `try/catch` ever sees it.
- Do not assume "the interval already guards this" covers the initial kick too — they are two separate
  call sites and both must be guarded independently, as this card's own bug demonstrated.
- Do not add this swallow-and-log pattern without also logging — a silently swallowed first-tick
  failure is the most likely one to represent a real boot-time wiring/config problem, so wake.ts's and
  scheduler.ts's catches now `console.error` rather than silently discarding, unlike every sibling
  watcher's silent catch (that convention stays unchanged elsewhere; this is a deliberate, narrow,
  consistent deviation in only these two files for a specific operational reason).
