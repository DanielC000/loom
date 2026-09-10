# bb134d3e — `gate_history` being manager-only is deliberate, decided twice, not incidental

## Narrative

Card bb134d3e — decided twice. `1baac6da` introduced `gate_history` scoped to managers by name (subject line: "expose gate history to managers"). Later, `b0c7fd19` widened the WORKER surface for gate visibility and chose a self-scoped `gate_status` (resolve an opId the caller already holds) rather than this project-wide, enumerable history — someone stood at this exact fork a second time and took the other branch on purpose. Discriminator: a worker RESOLVES an opId it already holds (`run_gate` returns it) via `gate_status`; ENUMERATING settled ops across sessions is a manager concern under depth-1, which is exactly what `gate_history` is.

Both times this boundary has bitten in practice (cards `be260976`, `19456eb6`), the proximate cause was a manager writing a worker DoD around a tool the worker doesn't have — check the worker's pinned tested surface (`orchestration.ts:2346`) before drafting a DoD step that needs `gate_history`.

## Do not

- Do not add `gate_history` to the worker tool surface — a worker resolves an opId it already holds via the self-scoped `gate_status`; enumerating settled ops across sessions is a manager-only concern under depth-1, decided this way twice already.
- Do not draft a worker DoD step around `gate_history` without checking the worker's pinned tested tool surface first — this exact mistake has bitten in practice twice.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above the `gate_history` tool registration): lines 4170-4180 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
