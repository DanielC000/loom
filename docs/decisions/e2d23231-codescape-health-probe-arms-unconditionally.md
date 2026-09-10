# e2d23231 — the codescape health probe must arm unconditionally, not gated on a project count

## Narrative

`startHealthMonitor` (the periodic `GET /graph/health` liveness probe) is armed UNCONDITIONALLY whenever `start()` spawns `serve` — including with ZERO codescape-enabled projects, since `spawnServe()` itself always runs regardless of `repoPaths.length`. This used to be gated on a `hasEnabledProjects` flag latched from `repoPaths.length` at boot, which meant a daemon that booted with no codescape-enabled projects never armed the probe AT ALL for that boot's entire lifetime — and since v1 has no runtime project registration (a project whose `codescape.enabled` flips on after boot still needs a daemon restart to ever be ingested — see `docs/decisions/194d343d-codescape-cwd-contract-pin-codescape-home-in-spawn-env.md` and the config-PATCH log line in `gateway/server.ts`), there was no in-process event that could ever re-arm it. The result: `serve` ran fully unwatched — exactly the wedge blind spot this probe exists to close.

`probeHealth` itself gates on `alive`, so the timer is a harmless no-op tick whenever serve isn't currently believed up (never started, mid-restart-backoff, or given up for good) — THAT check, not a project count, is what keeps an idle timer cheap.

## Do not

- Do not gate `startHealthMonitor`'s arming on a project count (`hasEnabledProjects`/`repoPaths.length`) — arm it unconditionally whenever `serve` is spawned, or a zero-project boot never re-arms the wedge-detection probe for its entire lifetime.

## Source

JSDoc method comment above `startHealthMonitor` in `packages/daemon/src/codescape/supervisor.ts`: originally lines 1233-1248, as of this tranche's HEAD. Introduced by commit `e2d23231` (no board card cited anywhere in the block, the file, or the introducing commit message — sha-keyed per the extraction program's rule; verify with `git cat-file -t e2d23231`). Relocated by card `0b5f7673` (tranche 2); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
