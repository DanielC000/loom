# 2ec60d9c — `CODEX_ENGINE_ID_RETRY_MS` retry spacing, corrected against a real codex spawn

## Narrative

Card 2ec60d9c (DoD-1): retry spacing for `captureCodexEngineSessionId`'s engine-session-identity discovery in `packages/daemon/src/pty/host.ts`. Env-overridable (`LOOM_CODEX_ENGINE_ID_RETRY_MS`) so a hermetic test can shrink it, mirroring `CODEX_BUSY_STALE_MS`'s own `LOOM_CODEX_BUSY_STALE_MS` convention.

Corrected against a REAL codex spawn (this card's own DoD-4 real-spawn test) — a first design that fired ONE retry ~2s after the ready marker was WRONG about WHEN codex actually creates the rollout file: it is NOT created at process boot. A real run observed the file's on-disk mtime landing ~13 seconds AFTER the ready marker first rendered — the file is created lazily, around when the FIRST real turn is actually submitted/begins processing, not at bare boot. A fixed one-shot ~2s-later retry can therefore MISS every real session whose first turn takes longer than that to actually start (a busy host, a slow model response, or — the specific case the real-spawn test hit — this host's OWN personal `~/.codex/config.toml` carrying extra plugin/marketplace MCP servers whose "Starting MCP servers (N/4)" episode can itself take several seconds before the first turn even begins).

See `CODEX_ENGINE_ID_MAX_ATTEMPTS` (same file) for the retry COUNT this spacing multiplies against.

## Do not

- Do not revert to a single fixed-delay retry for engine-session-id discovery — a real-spawn test showed a one-shot ~2s-later check misses sessions whose first turn is slow to start.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`CODEX_ENGINE_ID_RETRY_MS`'s top-of-const doc): lines 56-71, as of this tranche's HEAD. Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
