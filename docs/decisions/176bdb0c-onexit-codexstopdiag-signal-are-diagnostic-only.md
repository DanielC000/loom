# 176bdb0c — `onExit`'s `codexStopDiag`/`signal` are diagnostic-only; `intended` stays the load-bearing discriminator

## Narrative

`PtyHostEvents.onExit`: the pty exited. `intended` distinguishes a DELIBERATE Loom termination (any `pty.stop()` — graceful/idle/user-stop/recycle/merge-stop/run-teardown, which sets `live.stopping`) from an UNEXPECTED process death (the process died without a `stop()` — a crash / clean self-exit). It is the load-bearing discriminator the crash-recovery watchdog keys off (recorded at `onExit` time; a whole-daemon restart/crash never reaches here, so those are excluded for free). See `PtyHost.stop` / `Live.stopping`.

Card 176bdb0c: `signal`/`codexStopDiag` are DIAGNOSTIC-ONLY additions, both OPTIONAL and both currently populated ONLY by the codex spawn path — claude's own call site (and the pre-existing `{ intended }`-only test/production call sites) are untouched and remain valid callers. Neither field changes what counts as a successful/intended stop; `code`'s own discard-by-every-consumer behavior (`index.ts`'s `onExit` implementer, historically named `_code`) is UNCHANGED for every harness — this only adds visibility, never a new success/failure branch.

`signal` is node-pty's own `onExit`-event field (`{exitCode, signal?}`) passed through verbatim — on this project's Windows/conpty target it is ALWAYS `undefined` (confirmed by reading `node-pty`'s own `windowsTerminal.ts`: `this.emit('exit', this._agent.exitCode)` passes only ONE argument, so the `(exitCode, signal) => ...` listener in `terminal.ts` never receives a second one on this platform) — do not expect it to discriminate anything here; it is carried through only because it is free and may be useful on a POSIX host.

`codexStopDiag` records what `stopCodex`'s own graceful sequence actually did: whether its SECOND `\x03` was sent at all (a fast-enough exit from the FIRST alone means it never was), and, if sent, how long it had been outstanding when the process actually died — see `CodexLive.secondSigintWrittenAt`'s own doc for why this is the field the earlier measurement campaign on that card identified as most valuable.

`engineSessionIdCaptureEndReason` (card ece98bd8) is a LATER, independent addition to the same diagnostic bag — it says nothing about the stop sequence; see `CodexLive.engineSessionIdCaptureEndReason`'s own doc for what it records.

## Do not

- Do not treat `signal` as a discriminating field on this project's Windows/conpty target — `node-pty`'s own windows terminal only ever passes `exitCode` to the `exit` event, so `signal` is always `undefined` here (measured by reading `windowsTerminal.ts`); it's carried through only because it's free and may help on a POSIX host.
- Do not let `signal`/`codexStopDiag` change what counts as a successful/intended stop — `intended` stays the load-bearing discriminator; these fields only add visibility.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onExit` field doc on `PtyHostEvents`), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.
