# 5e30c4bd — compare the RUNNING daemon's build artifact, never `version`/`webBundle`

## Narrative

`packages/daemon/src/deploy-staleness.ts` exists because "merged" and "running" once silently diverged for ~1h50m: a daemon-`src` commit sat on mainline, unrestarted, invisible to every surface. The module derives a staleness signal by comparing the RUNNING daemon's own build artifact against mainline HEAD.

`version` and `webBundle` were considered and rejected as that signal: the incident's own after-action measurement proved BOTH stay byte-identical across a source-only deploy (see `served_status`'s doc comment) — so either would report a false CLEAN for exactly the case this module exists to catch.

## Do not

- Do not use `version`/`webBundle` as a staleness proxy — both are provably blind to a source-only deploy, the exact incident this module was built to detect.

## Source

Inline module-doc comment in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
