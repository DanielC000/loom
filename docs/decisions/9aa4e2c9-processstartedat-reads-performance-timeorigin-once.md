# 9aa4e2c9 — `processStartedAt` is read once from `performance.timeOrigin`, not derived from wall-clock minus uptime

## Narrative

Unlike every other clock in `deploy-staleness.ts`, `processStartedAt` is read ONCE from `performance.timeOrigin` (a value the runtime fixes at process start and never changes), NOT recomputed per call under the module's own "never cache" discipline (see `f26339d7`'s record for that discipline's normal shape). That discipline is right for a clock that genuinely changes between calls (a dist mtime, mainline HEAD); a process's own start time does not, and the earlier approach — `Date.now() - process.uptime() * 1000`, subtracting a wall clock from a monotonic one — drifted by a few ms between calls in the SAME boot, which broke the property callers actually rely on: that two reads of the same boot agree.

## Do not

- Do not derive `processStartedAt` as `Date.now() - process.uptime() * 1000` — that formula mixes a wall clock with a monotonic one and drifts between calls in the same boot.
- Do not recompute `processStartedAt` per call the way every other clock in this module is recomputed — it is a deliberate, named exception, read once from `performance.timeOrigin`.

## Source

Inline module-doc comment in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
