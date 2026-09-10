# 5e30c4bd — compare the RUNNING daemon's build artifact, never `version`/`webBundle`

## Narrative

`packages/daemon/src/deploy-staleness.ts` exists because "merged" and "running" once silently diverged for ~1h50m: a daemon-`src` commit sat on mainline, unrestarted, invisible to every surface. The module derives a staleness signal by comparing the RUNNING daemon's own build artifact against mainline HEAD.

`version` and `webBundle` were considered and rejected as that signal: the incident's own after-action measurement proved BOTH stay byte-identical across a source-only deploy (see `served_status`'s doc comment) — so either would report a false CLEAN for exactly the case this module exists to catch.

## Do not

- Do not use `version`/`webBundle` as a staleness proxy — both are provably blind to a source-only deploy, the exact incident this module was built to detect.

## Source

Inline module-doc comment in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.

## Fresh derivation, synchronous by design — `composeManagerStartupPrompt`'s call site

A daemon-`src`/`shared` commit can be MERGED on mainline for a long time before the daemon PROCESS is restarted to actually run it — and nothing surfaced that gap in the ~1h50m incident above; it was discovered only because a manager happened to call `served_status` by hand. `composeManagerStartupPrompt` calls `computeDeployStaleness()` fresh on every MANAGER spawn/resume/recycle, never cached or persisted — scoped to ONLY `packages/daemon/src`/`packages/shared/src` commits so an assets/docs/vault-only merge (no restart needed) never cries wolf.

The call is SYNCHRONOUS by design, not an oversight: it runs a bounded `execFileSync` git read directly. That is NOT the `createPty`/`buildSpawnArgs` hot path `CLAUDE.md`'s event-loop discipline protects — that discipline exists for an UNBOUNDED, minutes-long `spawnSync` (venv create + pip install) on a path EVERY session spawn hits. This function only runs for a MANAGER spawn/resume/recycle, a comparatively rare event, so a bounded git call (worst case 2×`GIT_TIMEOUT_MS` fully-blocked event loop, degrading gracefully on timeout) was judged an acceptable, much simpler alternative to an async-cache-plus-prewarm layer (the `getCachedClaudeVersion` pattern) for this specific, infrequent call site.

### Do not (2)

- Do not cache/persist this staleness read across spawns — it must be fresh on every manager spawn/resume/recycle to catch a merge that landed since the last check.
- Do not widen the scope beyond `packages/daemon/src`/`packages/shared/src` commits — an assets/docs/vault-only merge never needs a restart and must not trigger the alarm.
- Do not treat this synchronous git call as the same hazard class as the spawn-hot-path event-loop discipline (`CLAUDE.md`) — it's a rare, bounded call, not a per-spawn one.

### Source (2)

Inline comment in `packages/daemon/src/sessions/manager-prompt.ts` (above the `computeDeployStaleness()` call), as of commit `bbd005c7f4ff7d8cecd6ec0ddd3bcccf04e94fa5`. Relocated by card `4c6a1edf` ("manager-prompt.ts, tranche 1"); no wording changed, `//`-prefixed lines joined into flowing paragraphs.
