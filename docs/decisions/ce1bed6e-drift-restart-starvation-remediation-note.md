# ce1bed6e — drift-restart starvation gets its own Platform Lead remediation note

## Narrative

A build-drift restart can be deferred — or have its one allowance already spent — with nobody told the actual remaining stability window (the `driftStabilityMs` window `9e6f984d`'s debounce tracks, latched via `545ef479`'s `DriftCheckState` machine). Without a notice, the party doing the rebuilding has no way to know that a further rebuild would replace the stability-window candidate and starve the restart indefinitely — each new rebuild resets the same window that has to sit stable before a restart ever fires.

This note reaches the SAME Platform Lead kickoff channel as the tool-drift note (`350bc307`), for the same reason: private by construction — no REST field, no MCP tool response, no description text, since the Platform Lead session type itself does not exist without `LOOM_DEV=1`. It needed zero new disclosure surface and (per the accepted-baseline provenance notes in `codescape-privacy-guard.mjs`) zero new entry there — `drift-notice.ts` and `sessions/platform-lead-prompt.ts` are already on that list, added by card `350bc307`.

Deliberately NOT a fix for the PREVENTION audience — the party actually doing the rebuilding, on a codescape-enabled project. That is a shared channel reaching ordinary sessions and would need its own `CODESCAPE_PROMPT_BLOCK_ASSET`-style review, out of scope here. This is the REMEDIATION audience only, and only reaches it when a Platform Lead actually spawns — see this note's own caller (`readCodescapeBuildDriftNote`'s call site) for that bound.

## Do not

- Do not treat this note as a fix for the party causing the drift-restart starvation (the rebuilding side) — it is remediation for the Platform Lead only, not prevention.
- Do not add a new disclosure surface for this note — it reuses the already-accepted `[loom:*]` Platform Lead kickoff channel and the already-accepted `codescape-privacy-guard.mjs` baseline entries for `drift-notice.ts` / `sessions/platform-lead-prompt.ts`.

## Source

JSDoc comment in `packages/daemon/src/codescape/drift-notice.ts`, above `BUILD_DRIFT_STATE_BASENAME`: originally lines 94-110, as of this tranche's HEAD. Relocated by card `e8798881` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
