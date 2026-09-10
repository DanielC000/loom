# 503a30a0 — Codescape supervisor gate: host-CLI presence, not a hand-set env toggle

## Narrative

Codescape supervision lives in the same `LOOM_DEV`-gated layer as the Platform Lead builtins and NEVER runs for a regular `loomctl` user, flag or not (`isLoomDev()` remains a hard prerequisite — see the guard left inline at the source). Within dev, the gate for whether the Codescape fleet-daemon supervisor starts at boot is HOST-CLI PRESENCE, not a hand-set env toggle: `hostToolBinExists(codescapeBinCandidate(dbPath))` — the same DB-path → `LOOM_CODESCAPE_BIN` → bare-PATH-name precedence the spawn resolvers already use (see `codescapeBinCandidate`/`resolveCodescapeBin`). Codescape is a PRIVATE internal tool: a vanilla end-user's host never has a `codescape` binary anywhere on PATH, so this resolves false for every ordinary install with ZERO configuration and no discoverable toggle — it activates automatically, with no hand-set env var, on the ONE class of host that actually has the CLI installed (the owner's own dev machine). This retires the old `LOOM_CODESCAPE_ENABLED=1` hardcoded env-only gate entirely (the exact class of knob card `f487df9d`'s sweep retired elsewhere) — there is no env-based "master switch" left to hand-set.

`dbPath` is the optional DB-persisted `integrations.codescape.path` override (card `8dc5ebb9`), threaded in by a caller that has one (e.g. `pty/host.ts`'s per-spawn `getIntegrationPaths` seam); omitted by a caller with no DB context (`paths.ts` itself has none), which still resolves correctly via the env/bare-PATH layers alone.

## Do not

- Do not reintroduce an env-based "master switch" for Codescape supervision — the gate is deliberately host-CLI presence, so an ordinary end-user's host resolves false with zero configuration and no discoverable toggle.
- Do not skip threading `dbPath` from a caller that has DB context (e.g. a per-spawn integration-paths seam) — omitting it degrades to env/bare-PATH resolution only, which is correct but loses the DB-persisted override.

## Source

Inline comment in `packages/daemon/src/paths.ts` (`isCodescapeSupervisorEnabled`'s doc): originally lines 392-409, as of this tranche's HEAD (paths.ts tranche 1). The `isLoomDev()` hard-prerequisite guard and the read-at-call-time note stay inline at the source (class-A, compressed) — this record carries the fuller "why host-CLI presence, not an env toggle" rationale.
