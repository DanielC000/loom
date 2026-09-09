# ebd755ab — latch the exhausted-drift diagnostic per distinct (installed, running) pair

## Narrative

Card ebd755ab (Gap 1): `lastExhaustedDriftAnnounced` holds the `(installedBuild, runningBuild)` pair — joined as a single string key — for which the exhausted-restart diagnostic (the `installedBuild === lastDriftRestartInstalledBuild` branch in `checkBuildDrift`) was already announced, or `null` if none.

This is distinct from `lastDriftRestartInstalledBuild` (which gates the RESTART decision, one per installed build): this field gates the DIAGNOSTIC decision, latched per distinct pair so a permanently-broken deploy (drift persists forever because its one restart is already spent) logs the "still unresolved" line ONCE, not on every ~30s probe tick forever. Before this field existed, that path returned completely silently, making an unresolvable drift byte-identical in the log to a healthy no-drift steady state — the same discriminator-discipline reasoning as `lastInstalledBuildFailureReason`.

Reset to `null` (and the reset is ANNOUNCED as a recovery — the `installedBuild === runningBuild` branch) the moment the running side catches up to the installed build again; also reset (silently, matching every other drift-tracking field) on `stop`/`start` — a fresh supervisor lifetime starts with no diagnostic memory.

## Do not

- Do not let the exhausted-drift diagnostic fire on every probe tick — it must latch per distinct `(installedBuild, runningBuild)` pair and log only on a genuine change, or an unresolvable drift becomes indistinguishable from a healthy steady state in the log.

## Source

JSDoc field comment in `packages/daemon/src/codescape/supervisor.ts`, above `lastExhaustedDriftAnnounced`: originally lines 683-697, as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
