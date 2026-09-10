# sha:5a9ad7fd — the conversation-preserving respawn's two consequences on `CompanionController`

## Narrative

Commit `5a9ad7fd` added `CompanionController.upgrade()` — the CONVERSATION-PRESERVING respawn (Companion Capability & Permission-Lever Framework §6), a human/REST-triggered upgrade (`POST /api/companion/:sessionId/upgrade`, never auto-fired from a grant write) that delegates to the injected `upgradeCompanionSession` (`SessionService.upgradeCompanionCapabilities`). It is SERIALIZED on the same reconcile chain as start/update/stop/onSessionExit, so it can never interleave with a concurrent teardown/start of the SAME session's gateway. This introduced two consequences elsewhere in `packages/daemon/src/companion/controller.ts`.

## Consequence 1: the stale-exit guard in `onSessionExit`

`upgrade()`'s own `pty.stop()` triggers `index.ts`'s `onExit` → `onSessionExit` for the SAME session. By the time `onSessionExit`'s enqueued op actually runs — strictly AFTER anything already ahead of it on `this.chain`, which now includes a live-upgrade's own stop→resume — the session may have ALREADY come back alive (a live-upgrade respawn, a fast manual restart, a self-heal resume racing a slow exit-event queue). Tearing down a companion that's alive again would silently kill its gateway/heartbeat/reminders/chat_reply gate for a process this stale exit event no longer describes — and since the exited pty's own gateway/heartbeat/reminders dispatch every turn by `(pty, sessionId)` rather than holding any reference to the specific OS process, none of them actually needed rebuilding across a same-session-id respawn; the ONLY bug was tearing them down and never bringing them back.

The fix: `onSessionExit` checks `this.deps.pty.isAlive(sessionId)` first and no-ops if it's already alive again, only tearing down (and re-arming same-home siblings, see [[134368ac-same-home-heartbeat-rearm-on-exit]]) when it's genuinely dead. This check is scoped to `onSessionExit` alone — `teardownOne`'s OTHER caller (`applyDesired`'s STOP branch, a genuine disable/delete) must NOT gate on aliveness: the pty typically stays running there and the wiring must still come down regardless.

## Consequence 2: `this.chain` is GLOBAL, not per-session (KNOWN TRADE-OFF, CR-confirmed acceptable)

`upgrade()` is serialized on the SAME chain as every other session's reconcile ops, not a per-session chain. A slow upgrade (worst case ~13s: up to `UPGRADE_BUSY_WAIT_MS` [~3s, see [[d88163b7-hold-drain-surface-and-bounded-busy-wait]]] plus ~10s if the pty then won't die) briefly blocks every OTHER live companion's reconcile behind it too, not just this session's. This was reviewed and accepted as-is (CR-confirmed) rather than building a per-session chain, since a REST-triggered upgrade is rare and bounded, not a hot path.

## Do not

- Do not re-read `isAlive()`-independent state to decide whether to tear down in `onSessionExit` — the stale-exit guard must gate on `isAlive()` at the time the enqueued op actually runs, not at enqueue time.
- Do not apply the stale-exit aliveness gate to `applyDesired`'s STOP branch — a genuine disable/delete must tear down regardless of whether the pty is still alive.
- Do not build a per-session chain to "fix" the global-chain blocking trade-off without a fresh review — it was deliberately accepted as-is.

## Source

`packages/daemon/src/companion/controller.ts`: `onSessionExit`'s inline `STALE-EXIT GUARD (CR fix)` comment (untouched — 12 lines, below this program's 15-line threshold) and `upgrade()`'s `KNOWN TRADE-OFF` doc paragraph (was part of lines 145-166, tranche 1, card `488cedea`). No wording changed beyond joining wrapped source lines and stripping `*` comment markers.
