# ece98bd8 — the engine-session-id capture chain's end reason latches exactly once, from whichever of two sites resolves first

## Narrative

Card ece98bd8: before this fix, a `captureCodexEngineSessionId` chain that ended WITHOUT ever finding an id was silent — indistinguishable from a pty death mid-window or a ready marker that never rendered at all. `CodexLive.engineSessionIdCaptureEndReason` now records WHY the chain ended, so this is no longer ambiguous.

The field is `null` while capture is still pending, or once it succeeds — it is a FAILURE-diagnostic field only, never populated on the ordinary success path. It latches exactly once, from whichever of two sites first determines the chain is over:

- `"exhausted"` — `captureCodexEngineSessionId`'s own last scheduled attempt ran, the pty was still alive, and the rollout file still hadn't turned up after all `CODEX_ENGINE_ID_MAX_ATTEMPTS` tries. Set THERE, immediately (DoD-3) — the pty may keep running long afterward, so this can't wait for `pty.onExit`.
- `"died-mid-capture"` — the pty exited after at least one attempt had already fired (`engineSessionIdCaptureAttempted`) but before any attempt found an id or the ladder exhausted.
- `"capture-not-attempted"` — the pty exited before the ready marker ever rendered, so `engineSessionIdCaptureAttempted` never latched and the retry chain never started at all.

The `died-mid-capture`/`capture-not-attempted` split is resolved at `pty.onExit` itself — the genuinely surprising, still-alive `"exhausted"` case is already latched by `captureCodexEngineSessionId` itself, so `onExit` leaves it untouched and never overwrites an already-successful capture (`live.engineSessionId` set) or an already-latched reason. Resolving the other two at `onExit` rather than waiting for the in-flight `setTimeout` to fire again against a now-dead pty matters: that stale tick would only learn, up to `CODEX_ENGINE_ID_RETRY_MS` later, exactly what `pty.onExit` already knows at the instant of death. Read via `codexStopDiag` (`PtyHostEvents.onExit`) and the exit console line.

## Do not

- Do not let `pty.onExit` overwrite an already-latched `"exhausted"` reason or a successful capture (`live.engineSessionId` set) — it only fills in the two outcomes it alone can determine.
- Do not defer the `"exhausted"` outcome to `pty.onExit` — record it the instant the last scheduled attempt confirms it, since the pty may keep running long afterward.

## Source

Inline comments in `packages/daemon/src/pty/host.ts`: the `CodexLive.engineSessionIdCaptureEndReason` field doc, the `pty.onExit` handler inside `spawnCodexProcess`, the `captureCodexEngineSessionId` method's own doc, and its DoD-3 comment at the exhausted-attempt site — all as of this tranche's HEAD. Extracted by card `677c79cd` (tranche 17 on `pty/host.ts`).
