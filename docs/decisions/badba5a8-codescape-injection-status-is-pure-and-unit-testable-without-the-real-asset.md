# badba5a8 — codescape injection status composition is pure, so all 8 outcomes are unit-testable without the real shared asset

⚠️ Spans two decisions sharing this card id but unrelated in topic: this record (§1, `sessions/service.ts`)
and `discovery_block_injection`'s three-facts event shape (§2, `shared/src/types.ts`). `resolveRecord`
serves one file per id; folded here rather than left as a second unreachable `badba5a8-*.md` (`6de8956e`).

## §1 — Narrative

Pure composition of a `SessionService.resolveCodescapeGraphContext` result plus an asset-read result (see `readCodescapePromptBlockAsset` in `paths.ts`) — plus (card `bed49000`) an optional dispatched task title — into one `CodescapeInjectionStatus`. Exported and kept free of `this`/`fs`/any I/O specifically so it is directly unit-testable with literal `info`/`asset`/`taskTitle` fixtures covering all eight outcomes (2 injected × stamped/unstamped, plus the 6 reasons — the four graph gates, the two asset outcomes, and `task-class-excluded`) — without ever needing to make the real, shared, tracked `CODESCAPE_PROMPT_BLOCK_ASSET` file unreadable or empty, which would race every other codescape test in this repo's gate.

`resolveCodescapeInjectionStatus` (the class method) is thin wiring over this: resolves the graph context, conditionally reads the real asset (only on graph-context success — `undefined` on a graph-gate failure), and hands both plus its own `taskTitle` param straight here. The text composition (`${base} Graph last indexed: ${lastIngestedAt}.` when stamped, else `base`, else `null`) is byte-identical to the pre-refactor inline computation this function replaces — proven, not merely asserted (card's Ruling 2). `taskTitle` is checked LAST, after both infra gates pass — an `undefined` title (manager/taskless callers) always reads as "keep" via `isCodescapeExcludedTaskClass`, byte-identical to pre-`bed49000` behavior.

`resolveCodescapeInjectionStatus` is also the single source of truth for BOTH the rendered block text AND the three facts worth recording — `resolveCodescapeBlockText` is a THIN DELEGATOR over it (never a second/third parallel gate mirror that could drift; `codescapeHttpMcpServer`'s class doc warns about that risk for the first such mirror). Never throws: a missing/unreadable asset degrades to no block. This is why `composeManagerStartupPrompt`/`composeWorkerStartupPrompt` know NOTHING about codescape — they just append an opaque pre-rendered block (see `docs/decisions/f3ce53f1-codescape-prose-lives-only-in-a-dev-only-asset-file.md` for why the text is file-read, not a string literal).

### Do not

- Do not give this composition function `this`/`fs`/I/O access — its value is direct unit-testability via literal fixtures, without touching the real, shared, tracked asset file (which would race every other codescape test in the gate).
- Do not change the stamped/unstamped text composition without re-proving byte-identical equivalence to the pre-refactor inline computation (Ruling 2).
- Do not check `taskTitle` before the infra gates — checked last so an `undefined` title reads as "keep", matching pre-`bed49000` behavior.
- Do not create a second/third parallel gate mirror — `resolveCodescapeBlockText` must stay a thin delegator over `resolveCodescapeInjectionStatus`, thin wiring over the exported pure composition function.

### Source

Three inline comments in `sessions/service.ts`: the composition function's top-of-function doc (lines 1697-1715, tranche 6, relocated by card `5dcc1e98`), and the `resolveCodescapeInjectionStatus`/`resolveCodescapeBlockText` class-method docs (tranche 7, relocated by card `9f4f8e5a`). All three sites anchor to this one record.

## §2 — `discovery_block_injection` is observability-only, and carries three deliberately separate facts

### Narrative

OBSERVABILITY ONLY — records whether a PRIVATE, presence-gated per-project discovery block was appended to a spawn/recycle's `startupPrompt`, filed at all FIVE real injection call sites in `sessions/service.ts` (manager fresh spawn, explicit/scheduled manager spawn, worker fresh spawn, worker recycle, manager recycle).

WHAT the block is and WHY it's gated stays documented daemon-side only — this file is `@loom/shared`, shipped in FULL to every end-user install unlike the daemon package (see `codescape-privacy-guard.mjs` for why this kind's own name/doc are written this generically).

`detail` carries THREE DELIBERATELY SEPARATE facts (never collapsed into one boolean — the exact defect this card fixes): `injected: boolean` (block-presence); `reason: string | null` (set ONLY when `injected:false`, one of six distinct values: no supervisor process running / the feature or its daemon-wide gate is off / the serving process isn't up / this repo has no resolvable id / the asset could not be read — packaging/deploy fault / the asset was read but empty — content fault, kept DISTINCT); `stamped: boolean | null` (set ONLY when `injected:true`: whether a freshness stamp also rendered).

NEVER carries the block's own PROSE (this event exists so nobody ever has to log it). Deliberately excluded from `EVENT_TRIGGER_EVENT_KINDS` and `GATE_HISTORY_KINDS` (a per-spawn observability fact, not a live decision trigger or gate-history row).

### Do not

- Do not collapse `injected`/`reason`/`stamped` back into one boolean — the exact defect this card fixes.
- Do not merge the "asset unreadable" and "asset read but empty" `reason` values into one — two operationally different states (packaging/deploy vs content fault).
- Do not log the discovery block's own prose via this event — it exists specifically so nobody ever has to.

### Source

Inline comment in `packages/shared/src/types.ts` (`OrchestrationEventKind`'s `discovery_block_injection` case doc). Relocated by card `35d90c4e` (tranche 1). Folded into this pre-existing record by card `6de8956e`.
