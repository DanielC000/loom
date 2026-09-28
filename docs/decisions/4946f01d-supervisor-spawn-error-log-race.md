# 4946f01d — supervisor's own truncating log open can still wipe the spawn-error diagnostic

## Narrative

Card 4946f01d's original fix made the `child.on('error', ...)` handler in `dev-server.mjs`'s
`SUPERVISOR_CODE` write its spawn-error diagnostic via `fs.appendFileSync` instead of `out.write()`
(`out` being the supervisor's own `fs.createWriteStream(payload.logPath, ...)`), because `out.write()`'s
buffered flush is asynchronous and can lose the write to a following `process.exit()`. That fix is
correct and unrelated to what follows.

First-specimen CI failure (card 049a5b41, 0.30.0 release cut, ubuntu run 36467496584 attempt 2) showed
the diagnostic missing anyway, on a build where `appendFileSync` was already in place. Root cause is a
*different* race on the *same* `out` stream: `fs.createWriteStream(payload.logPath, { flags: 'w' })`
issues an async, libuv-threadpool-backed `open()` (the actual `O_TRUNC` truncate happens on a separate OS
thread, independent of the main JS thread's ordering). That open was **redundant** — `start()` in this
same file already truncates the log file synchronously (`fs.writeFileSync(logPath, "", "utf8")`) before
ever spawning the supervisor — but it was not harmless: if the threadpool worker's truncating open
executes *after* the `'error'` handler's synchronous `appendFileSync` diagnostic write, it wipes that
write out from under it, even though `appendFileSync` itself completed durably before `process.exit(1)`
ran. `appendFileSync`'s synchronicity guarantees ordering on the main thread; it says nothing about a
second, independent open on the same file racing in from a worker thread.

Confirmed by direct reproduction: extracted the real, currently-committed `SUPERVISOR_CODE` (same
extraction the test uses) and ran it standalone against an unspawnable command, reading the log only
after the child process had fully exited (ruling out a premature test read). Natural/unforced rate: 0/300
losses (100 trials on Windows, 200 on real Linux via WSL2 Ubuntu 22.04) — consistent with this being a
genuine, rare, host-contention-dependent race, not something a quiet dev box reproduces on its own.
Forced (scheduling 64 async, non-blocking `crypto.pbkdf2` calls immediately before `out`'s
`createWriteStream`, to saturate the threadpool and delay its open while leaving `spawn()`'s own error
path — which doesn't depend on the threadpool — unaffected): 15/15 losses on both Windows and Linux, log
landing at exactly 0 bytes each time (a full truncation, matching the CI failure's signature). Fix
validated the same way: changing only the supervisor's own stream flags from `{flags:'w'}` to
`{flags:'a'}` (append) — safe, since the launcher already truncated the file synchronously before the
supervisor ever runs — eliminated the race: 0/15 losses on both platforms under the identical forcing
pressure that caused 15/15 losses against the unpatched helper.

## Do not

- Do not reintroduce a truncating (`'w'`) open anywhere inside `SUPERVISOR_CODE` for `payload.logPath`.
  The log is already truncated synchronously by `start()` before the supervisor is ever spawned; any
  *further* truncating open inside the supervisor is redundant and races the `'error'` handler's
  diagnostic write via a separate OS thread.
- Do not treat `fs.appendFileSync` completing before `process.exit()` as sufficient proof that content is
  durable on disk. It proves ordering only for writes that go through that same call — it says nothing
  about an independent async open (or write) on the same file from another code path (here, the
  supervisor's own log stream) landing afterward and clobbering it.
- Do not "fix" a rare CI-only flake here by loosening or widening a timeout/retry — this is a genuine
  ordering bug between two writers of the same file, not a slow host needing more time.

## Source

Inline comments in `packages/daemon/assets/skills/orchestrate/scripts/dev-server.mjs`'s `SUPERVISOR_CODE`
(the `createWriteStream`/`child.on('error')` lines) and `start()`'s own pre-truncate
(`fs.writeFileSync(logPath, "", "utf8")`).
