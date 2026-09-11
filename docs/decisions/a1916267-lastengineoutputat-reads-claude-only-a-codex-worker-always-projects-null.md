# a1916267 — `lastEngineOutputAt` reads CLAUDE ONLY; a codex worker always projects `null`

## Narrative

Card a1916267: `pty.getLastOutputAt` reads `this.live` only, never `findAnyLive` — so a non-claude (e.g. codex) worker row always projects `lastEngineOutputAt: null`, the SAME codex-null convention `composerDirtyLen` already has (see card `dcd8659c`). This was NOT always true: it used to read every harness's live state, and on codex that meant the field kept advancing on pure TUI repaint with no turn running — a signal that read as "busy and emitting" on a session that would never act again, which is worse than an absent signal (a manager trusting it as liveness had nothing to warn it otherwise).

## Do not

- Do not widen `pty.getLastOutputAt` back to read every harness's live state — on codex that resurrects a false "busy and emitting" reading driven by pure TUI repaint, worse than the current absent (`null`) signal.

## `getLastOutputAt`'s own site (`pty/host.ts`) — why `CodexLive` has no such field at all

`CodexLive` carries no `lastOutputAt` field at all (unlike `Live`), not merely an unread one, because codex's TUI repaints continuously with no turn running, so a per-chunk output timestamp cannot discriminate "working" from "idle and finished" on that harness — the field would have nothing honest to mean there. `getLastOutputAt` deliberately reads `this.live` (claude only), mirroring `getComposerDirtyLen`'s own claude-only convention, for the same reason. `undefined` here also covers the ordinary "not live in this process at all" case — the same ambiguity `getComposerDirtyLen` already accepts, since no reader decision turns on telling the two apart.

## The measurement behind the second reason, and the Phase-2 deferral ruling

The full "second, independent reason" narrative (`pty/host.ts`'s hook-triggered capture chokepoint, and codex having no hook relay at all) stays inline at the call site, verbatim — see `pty/codex-adapter.ts`'s own "## Addendum, card a1916267" doc comment. What moved here is the measurement and the ruling behind it: MEASURED, grepped `codex-host.ts` for `setContextCounters`/`ctxInputTokens`/`ctxTurns` — zero hits. A real Phase-2 fix for codex context telemetry needs BOTH pieces: a confirmed `token_count`/footer-percentage field shape (this file's existing note) AND a non-hook capture chokepoint for this harness (e.g. keyed off the same screen-scan markers `armCodexBusyStaleTimer` already polls, or a periodic read) — neither exists today, and this is the explicit ruling that gap is DEFERRED, not silently unhandled: card `a1916267` found the symptom (null DB columns on a live codex worker row) but did not resolve either piece, both being real, separately-scoped engineering work beyond a diagnostics bugfix.

### Source (this section only)

Inline comment in `packages/daemon/src/pty/codex-adapter.ts` (the module-level doc comment, "## Addendum, card a1916267"), as of this tranche's HEAD. Extracted by this card's tranche 1 on `pty/codex-adapter.ts`; no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder, `lastEngineOutputAt`): lines 2620-2626, as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2). See `PtyHost.getLastOutputAt`'s own doc (`pty/host.ts`) for the harness-level reasoning.
