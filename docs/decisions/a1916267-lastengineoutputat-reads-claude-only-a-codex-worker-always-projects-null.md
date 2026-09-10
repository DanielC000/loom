# a1916267 — `lastEngineOutputAt` reads CLAUDE ONLY; a codex worker always projects `null`

## Narrative

Card a1916267: `pty.getLastOutputAt` reads `this.live` only, never `findAnyLive` — so a non-claude (e.g. codex) worker row always projects `lastEngineOutputAt: null`, the SAME codex-null convention `composerDirtyLen` already has (see card `dcd8659c`). This was NOT always true: it used to read every harness's live state, and on codex that meant the field kept advancing on pure TUI repaint with no turn running — a signal that read as "busy and emitting" on a session that would never act again, which is worse than an absent signal (a manager trusting it as liveness had nothing to warn it otherwise).

## Do not

- Do not widen `pty.getLastOutputAt` back to read every harness's live state — on codex that resurrects a false "busy and emitting" reading driven by pure TUI repaint, worse than the current absent (`null`) signal.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder, `lastEngineOutputAt`): lines 2620-2626, as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2). See `PtyHost.getLastOutputAt`'s own doc (`pty/host.ts`) for the harness-level reasoning.
