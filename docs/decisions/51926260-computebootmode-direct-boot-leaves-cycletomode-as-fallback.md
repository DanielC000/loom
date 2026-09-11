# 51926260 — computeBootMode's direct-boot optimization leaves cycleToMode as a fallback, not a replacement

## Narrative

Card `51926260`'s `computeBootMode` (`packages/daemon/src/pty/host.ts`, at the actual spawn chokepoint) now boots a session directly AT its target permission mode whenever that target is directly expressible as a `--permission-mode` flag value. On that common path, `cycleToMode`'s very first footer read already equals the target, so it presses nothing.

`cycleToMode` itself is NOT retired by this optimization — it remains the fallback for every path that still needs a real climb: a target that isn't directly expressible via the boot flag, a runtime `worker_set_mode` override issued after boot, and `logLandedMode`'s auto-heal.

## Do not

- Do not assume `computeBootMode`'s direct-boot optimization eliminates the need for `cycleToMode` — it is still exercised whenever the target isn't directly expressible at boot, by a runtime `worker_set_mode` override, and by `logLandedMode`'s auto-heal.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`cycleToMode`'s own method doc), as of main `03e54be9`. Condensed and reworded, not verbatim.
