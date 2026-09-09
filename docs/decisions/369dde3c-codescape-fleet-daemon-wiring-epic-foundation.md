# 369dde3c — Codescape fleet-daemon wiring epic, foundation (card C1)

## Narrative

Card C1 (card `369dde3c`, updated by card `503a30a0`) is the FOUNDATION step of the Codescape fleet-daemon wiring epic. Under `isCodescapeSupervisorEnabled()` — `isLoomDev()` plus a codescape CLI actually detected on the host (see `paths.ts`; codescape is a private internal tool, so this is a non-discoverable, config/host-driven gate, not a hand-set env toggle) — Loom starts and supervises ONE `codescape serve` process per host on a loopback port, bootstrapped by `codescape ingest <repoPath>` for each target project BEFORE serve starts. v1: projects load from `.codescape/projects/index.json` at serve BOOT — a project ingested after serve started isn't picked up until a restart.

The class deliberately mirrors patterns already established elsewhere in the daemon rather than inventing new ones: async best-effort subprocess discipline (spawn not spawnSync, bounded, ~4KB output tail, never throws) from `python/venv.ts`'s `runAsync`/`ensurePythonPackageAsync`; absolute/PATH binary resolution plus the node-invocation special case for a JS entrypoint from `pty/resolve-bin.ts`'s `resolveExecutable`; and the "broken stays visibly down, never crash-loops" restart ethos from `scripts/daemon-supervisor.mjs` (that OUTER daemon-process supervisor only restarts on an explicit sentinel; this INNER supervisor restarts on any death but gives up — and stays down — after a bounded number of attempts). The boot singleton (gated, logs state) mirrors `index.ts`'s own Scheduler.

C1 is pure daemon plumbing: C2/C3 (later cards in the same epic) wire the per-session MCP entry and the lifecycle hooks that call these methods.

## Do not

- Do not register any method on this class as an agent MCP tool — every method here is Loom-internal only.

## Source

JSDoc class comment in `packages/daemon/src/codescape/supervisor.ts`, above `CodescapeSupervisor`: originally lines 12-45, as of this tranche's HEAD (minus the CWD-contract paragraph, split into `docs/decisions/194d343d-codescape-cwd-contract-pin-codescape-home-in-spawn-env.md`). Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
