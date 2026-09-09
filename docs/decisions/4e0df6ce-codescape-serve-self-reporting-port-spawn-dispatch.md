# 4e0df6ce — self-reporting `--port 0` spawn path for `serve`, dispatch and outcomes

## Narrative

Card 4e0df6ce introduces the self-reporting spawn path: `serve` is spawned with `--port 0` and picks its own ephemeral port, reporting it back on stdout (see `parsePortReportLine`). Nobody but the child itself ever binds this port, so the original bind-read-close-rebind TOCTOU (a separate process later rebinding the same freed number) cannot occur on this path.

`spawnServe`'s dispatch (private method) has two cases:
- `this.port` already known (an ordinary restart-on-death: the previously-live child released it on exit, and nothing in between — us or anyone else — separately bound and closed it): respawn with that SAME explicit port via `spawnServeExplicit`, unchanged by this card. This path does not reproduce the bind-close-rebind pattern; it is NOT window-free though — the port sits unbound between the dying child's exit and the new child's bind (at least `restartBackoffMs`'s own delay, longer than `pickLoopbackPort`'s own window). This is a KNOWN, ACCEPTED exposure, not a bug: its consequence is a DETECTED failure (serve fails to bind, the health probe fails, a restart fires), never silent corruption — no observed instance has ever occurred; do not describe this as something that has happened.
- `this.port` is `null` (the FIRST spawn of this instance's life, or a fresh attempt after a `stop()`/give-up nulled it — the one site the original TOCTOU actually lived at, see `pickLoopbackPort`'s own doc): use the self-reporting path when the installed binary is known- or maybe-capable (`portReportCapable` true/null), falling back to the legacy pick-then-spawn path only once a `--port 0` rejection has confirmed it isn't (blocker 1: an older codescape hard-exits on `--port 0` rather than falling back itself).

`spawnServeSelfReporting`: `this.child`/`spawnCount`/`spawnedAt`/`consecutiveHealthFailures` are set immediately on a successful spawn, exactly like the explicit-port path — `getPid()`/`getSpawnCount()` stay synchronously accurate; only `port`/`alive` (and therefore `getPort()`) wait on the report. `this.port` stays `null` — so `getPort()`/`request()` correctly refuse ("codescape not running") rather than ever targeting port 0 — until the report line arrives and REASSIGNS it, satisfying the card's mandatory latent-instance fix (`this.port` reassigned from the reported line before any `request()` can fire). Three outcomes before a report ever arrives:
- the report line parses: confirm `portReportCapable`, set `this.port`, hand off to the SAME `wireDeathHandling` an explicit-port spawn uses.
- the child exits/errors first: a CLEAN (no signal) non-zero exit, on a still-UNKNOWN capability, is the old-binary `--port 0` rejection shape (blocker 1) — confirms `portReportCapable = false` so the NEXT attempt uses the legacy path. Anything else (a signal, or a capability already confirmed) is an ordinary death, never a capability verdict.
- neither arrives within `portReportTimeoutMs`: abandon this attempt (kill the child) without concluding anything about capability, and let the normal backoff schedule retry.

All three end in `scheduleRestart` — never a permanently-stuck attempt.

## Do not

- Do not treat the port's unbound window during an explicit-port restart as an observed bug — it is a known, accepted exposure whose failure mode is always DETECTED (a bind failure or health-probe failure triggers a restart), never silent corruption.
- Do not use the legacy pick-then-spawn path except after a confirmed `--port 0` rejection (`portReportCapable === false`) — the self-reporting path is the default for an unknown or known-capable binary.

## Source

JSDoc method comments in `packages/daemon/src/codescape/supervisor.ts`, above `spawnServe` (originally lines 1049-1076), `spawnServeSelfReporting` (originally lines 1151-1175), and the introductory paragraph of `DEFAULT_PORT_REPORT_TIMEOUT_MS`'s own doc (originally part of lines 93-133), all as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
