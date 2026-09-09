# 194d343d — `ingest`/`serve` must both pin `CODESCAPE_HOME=homeDir` in their spawn env

## Narrative

`ingest` and `serve` no longer resolve their `.codescape` state dir purely from `process.cwd()` — as of Codescape's own `e23c2cb`, a missing `.git` in cwd makes them WALK UP looking for one, which can silently re-anchor the store outside `homeDir`. This bit Loom directly: our cwd, `<LOOM_HOME>/codescape`, has no `.git`, so the walk climbed to `<LOOM_HOME>` and anchored the store there instead. The fix pins the store explicitly via `CODESCAPE_HOME=<homeDir>` in the spawn env on BOTH `ingest` and `serve` (their resolver checks the env var FIRST, ahead of any cwd walk) — that is the load-bearing guarantee going forward. Running both spawns from the same `homeDir` as `cwd` is kept as belt-and-braces, but is NOT sufficient on its own: cwd alignment cannot prevent an upstream resolution change from walking past it.

## Do not

- Do not rely on `cwd` alignment alone to keep `ingest` and `serve` pointed at the same state dir — always also pass `CODESCAPE_HOME=<homeDir>` (default `CODESCAPE_HOME_DIR`, `<LOOM_HOME>/codescape`) in the spawn env of every ingest AND serve spawn, or serve will never see what ingest wrote.

## Source

JSDoc class comment in `packages/daemon/src/codescape/supervisor.ts` (the "★ CWD CONTRACT" paragraph above `CodescapeSupervisor`): originally lines 21-31, as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
