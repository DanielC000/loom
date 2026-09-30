# 0da5a3f7 — `loom update` must never reach `npm i -g` while its target daemon is still live

## The bug

`writePidFile` (`bin/loom.mjs`) used to be called ONLY from `startDetached`. A bare `loom` / `loom start`
(foreground) — and, since `loom service` registers `loom start --no-open`, an OS-service-managed daemon
too — never had a PID record at all.

`stop()` returns 0 ("no PID file") the instant `readPidFile()` comes back null, *without ever attempting
the graceful `POST /internal/shutdown` hook*. `update()`'s step (2) treated that false "already stopped"
as license to run `npm i -g` under a still-live process: on POSIX the package gets swapped under running
code; on Windows npm can fail outright on loaded native modules. The web UI's "Update & restart" button
(`packages/daemon/src/index.ts`) hits this same path by spawning `loom update` as a subprocess, so the
failure was reachable without the user ever running a command themselves — visible only in
`self-update.log`.

## The fix

Two independent layers, deliberately:

1. **`startForeground` now records its own pid** (`writeForegroundPidRecord`, same shape
   `startDetached` already used), removed again on clean exit
   (`removeForegroundPidRecordIfOwnedBySelf`, wired via `process.once("exit", …)`). This alone fixes
   `loom stop` against a foreground/OS-service daemon for free — `stop()`'s own ladder is untouched, it
   just now has a `rec` to work with.
2. **`update()`'s own stop step no longer trusts `stop()` blindly.** A USABLE pid record — one whose
   recorded pid is actually alive (`rec && isAlive(rec.pid)`) — still goes through `stop()`'s full ladder
   unchanged: it already does its own port-based identity confirmation before touching anything, and can
   hard-kill a genuinely wedged daemon as a last resort. Anything else (no record at all, or a stale one)
   skips straight to `stopViaLoopbackOnly`: there is no pid to signal, so this path deliberately never
   falls back to SIGTERM/SIGKILL/`taskkill` — only the graceful loopback hook, then a bounded wait for the
   port to actually go down. A wait that never sees the port go down REFUSES the update outright.

Layer 2 exists as defense-in-depth independent of layer 1: a daemon started by an OLDER `loom` binary
(predating layer 1) can still be answering on the port with no usable pid record at the moment a freshly
updated CLI runs `loom update` against it, and step (2) must handle that case too, not just the
already-fixed-going-forward one.

## The macOS launchd corollary

The OS-service-managed case (`loom start --no-open` registered via `loom service install`) surfaced a
THIRD gap, mac-only (`bin/service.mjs`): the launchd LaunchAgent plist set `<key>KeepAlive</key><true/>`
— unconditional — while the systemd unit and Task Scheduler XML both already used a failure-only
keep-alive (`Restart=on-failure` / `RestartOnFailure`). Before layer 1+2 above, `stop()` never actually
got a mac OS-service daemon down at all, so this was latent. Once `update()` can genuinely stop one, an
unconditional `KeepAlive` means launchd races its own auto-respawn against `update()`'s
stop → npm install → restart sequence: launchd sees the graceful stop as a plain exit (clean, not a
crash) and may relaunch the daemon from the OLD files while `npm i -g` is still mid-swap. Fixed by
changing `KeepAlive` to the `SuccessfulExit:false` qualifier form, matching the other two platforms'
crash-only semantics.

## Do not

- Do not let `update()` fall through to `npm i -g` on anything short of a CONFIRMED-down port — a
  refusal (with a clear message) is the only acceptable outcome short of that, never a guess.
- Do not add a pid-based kill to the no-usable-record path (`stopViaLoopbackOnly`). There is no pid to
  verify identity against there; a signal-based fallback in that branch is exactly the "blind kill of a
  possibly-unrelated process" hazard `stop()`'s own pid-identity ladder (task `a242c747`) was built to
  avoid.
- Do not remove the `rec && isAlive(rec.pid)` gate and call `stop()` unconditionally instead — that
  reintroduces this exact bug, since `stop()` still returns 0 without acting whenever `rec` is absent or
  stale.
- Do not revert the mac launchd plist's `KeepAlive` back to unconditional `<true/>` — see the corollary
  above for the race it reopens.
