# badba5a8 — codescape injection status composition is pure, so all 8 outcomes are unit-testable without the real shared asset

## Narrative

Card badba5a8: pure composition of a `SessionService.resolveCodescapeGraphContext` result plus an asset-read result (see `readCodescapePromptBlockAsset` in `paths.ts`) — plus (card bed49000) an optional dispatched task title — into one `CodescapeInjectionStatus`. Exported and kept free of `this`/`fs`/any I/O specifically so it is directly unit-testable with literal `info`/`asset`/`taskTitle` fixtures covering all eight outcomes (2 injected × stamped/unstamped, plus the 6 reasons — the four graph gates, the two asset outcomes, and `task-class-excluded`) — without ever needing to make the real, shared, tracked `CODESCAPE_PROMPT_BLOCK_ASSET` file unreadable or empty, which would race every other codescape test in this repo's gate if attempted via the real file.

`resolveCodescapeInjectionStatus` (the class method) is thin wiring over this: it resolves the graph context, conditionally reads the real asset (only when the graph context succeeded — `asset` is `undefined` on a graph-gate failure, since nothing ever needs to read the asset in that branch), and hands both plus its own `taskTitle` param straight here. The text composition (`${base} Graph last indexed: ${lastIngestedAt}.` when stamped, else `base`, else `null`) is byte-identical to the pre-refactor inline computation this function replaces — see the card's Ruling 2 on why that equivalence had to be proven, not merely asserted. `taskTitle` is checked last, after both infra gates pass — a manager/taskless caller that never has a title to check passes `undefined`, which `isCodescapeExcludedTaskClass` always reads as "keep" (byte-identical to pre-bed49000 behavior for every non-worker-dispatch call site).

## Do not

- Do not give this composition function `this`/`fs`/I/O access — its whole value is being directly unit-testable via literal fixtures without touching the real, shared, tracked asset file (which would race every other codescape test in the gate).
- Do not change the stamped/unstamped text composition without re-proving byte-identical equivalence to the pre-refactor inline computation — it was proven, not merely asserted, per the card's Ruling 2.
- Do not check `taskTitle` before the infra gates — it must be checked last so an `undefined` title (manager/taskless callers) reads as "keep", matching pre-bed49000 behavior.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the codescape injection-status composition function's top-of-function doc): lines 1697-1715, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
