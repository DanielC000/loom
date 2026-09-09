# 4cacc6f9 — Human-only gates-active payload leaves fallbackOfBatchOpId unredacted by project

## Narrative

Card 4cacc6f9: the SECOND consumer of GateSnapshotEntry.fallbackOfBatchOpId (card 19256231 plumbed it as far as `gate_queue`, the agent-facing read, and stopped there by its own DoD). Without it here, a HUMAN watching this page while a batch falls back sees up to K merge rows appear with no attribution at all — a fallback run is shaped EXACTLY like an ordinary solo merge (real taskId/branch/workerLabel), so nothing else on the row says where it came from.

⛔ DELIBERATELY NOT gated on the caller's project, unlike `gateQueueForManager`'s field of the same name (card 80d54122). That redaction exists because `gate_queue` is an AGENT MCP surface bounded by the owner's `project_links` trust boundary — see this method's own header and `gateQueueForManager`'s. THIS payload is the human-only loopback `/api/gates/active`, which is unscoped by design and already emits `taskId`/`branch`/`workerLabel` for every project above; an opId discloses strictly less than the branch name sitting next to it, so scoping it here would withhold nothing while breaking the one thing it exists to do — tie sibling rows from one batch together in a cross-project view.

## Do not

- Do not redact/scope `fallbackOfBatchOpId` by caller project on the human-only `/api/gates/active` payload (`snapshotGates`) the way `gateQueueForManager` redacts its own agent-facing field of the same name (card 80d54122) — that redaction exists for the agent-MCP `project_links` trust boundary, which does not apply to this unscoped human loopback surface.
- Do not withhold `fallbackOfBatchOpId` here on the theory that it discloses something sensitive — it discloses strictly less than the branch name already emitted on the same row, and withholding it would only break cross-project batch attribution.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`snapshotGates`): lines 4591-4604, as of commit `6faf27824c7f550d57bfdeb9e4724c7070b82315`. Relocated by card `5b8d2b0c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
