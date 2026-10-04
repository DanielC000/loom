# f1366911 — a boot-safe graceful-shutdown stub is registered before any boot await, then upgraded in place to the full teardown

Card `f1366911`. `packages/daemon/src/index.ts` used to register signal handlers (`SIGINT`/`SIGTERM`/
`SIGHUP`) and assign the `gracefulShutdown` closure only at the very end of `main()` — after several
awaited boot steps (companion `startInitial`, `startVaultVersioners`, `logVaultPushStatus`) that run well
after the HTTP server already started listening (`startGatewayListeners`). Consequences, both now fixed:

- `POST /internal/shutdown`'s handler (`gateway/server.ts`) returned `202` unconditionally, even though
  `requestShutdown` (`() => gracefulShutdown?.(...)`) was a silent no-op while `gracefulShutdown` was
  still `null` — a false "stopping" response while the daemon kept booting untouched.
- A raw `SIGINT`/`SIGTERM`/`SIGHUP` delivered in that same window hit Node's default signal behavior
  (immediate termination, no handler installed yet) — no shutdown marker written either way.
- Either path left `last-shutdown.json` absent, so the NEXT boot's `readAndClearShutdownMarker()` found
  nothing and misclassified what was actually a deliberate stop as a crash.

The fix: `packages/daemon/src/boot-shutdown-stub.ts`'s `makeBootShutdownStub` factory is registered as
`gracefulShutdown`'s INITIAL value immediately after `installCrashHandlers()`, with the
`SIGINT`/`SIGTERM`/`SIGHUP` handlers registered at that same point (not at the end of `main()`). The
`gracefulShutdown` binding is later REASSIGNED (not re-declared) to the existing full teardown function
once every subsystem it closes over is actually constructed — the same point in boot as before this
change. The signal-handler registration loop runs exactly once now, early, instead of once late.

## Do not

- Do not reference a scheduler/watcher/companion/vault/codescape handle (or any other subsystem the full
  teardown tears down) from inside `makeBootShutdownStub`'s returned function — those may not exist yet
  at the point this stub can fire. The stub's job is strictly: classify, write the shutdown marker,
  best-effort close the DB if one is already open, log, `exit(0)`.
- Do not re-add a SECOND `process.on(sig, ...)` registration loop later in `main()` — the handlers are
  now installed exactly once, early; a second loop double-registers every signal and double-runs
  teardown on a real signal.
- Do not make the stub depend on `gracefulShutdown` having been reassigned to the full teardown — it must
  work correctly as the sole handler for the entire boot sequence, including before `db`/`sessions`/
  `companionController`/the watchers exist.
- Do not route `SessionService.requestDaemonRestart`'s `process.exit(75)` path through this stub or
  through `gracefulShutdown` at all — that path already runs its own shared cleanup
  (`sessions.setShutdownCleanup(flushVaultsAndStopCodescape)`, wired independently in `index.ts`) and is
  unaffected by this change; keep it that way.
