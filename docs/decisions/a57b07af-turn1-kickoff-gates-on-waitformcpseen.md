# a57b07af — turn-1 kickoff delivery gates on `waitForMcpSeen`, closing the resume-nudge asymmetry

## Narrative

Card a57b07af: for a role that mounts loom-orchestration (manager/worker/assistant — see the shared `usesOrchestrationMcp` predicate, card 95f40ee0), the actual kickoff delivery inside `scheduleKickoffGuarantee`'s `setTimeout` now additionally awaits `waitForMcpSeen` — the SAME readiness gate the resume-continuation nudge already uses (card df5e37e7) — before writing. This closes the asymmetry the Code Review that filed this card found: turn 1 calls MCP tools almost immediately (a worker's first real action is typically `tasks_get`), so it deserves the same protection against racing the CLI's own async MCP handshake that a resume nudge already gets.

Applied only after measuring (card a57b07af DoD-1, against this exact log line's own timestamp vs. each session's first observed `/mcp-orch` hit, over the full retained `daemon-output.log` history): 494/494 real production turn-1 kickoff spawns for these roles already had `mcpSeen` true at this precise tick, by 1.19s-2.32s (mean ~1.42s) — zero counterexamples. So `waitForMcpSeen` resolves synchronously in the overwhelming common case; it only pays real, bounded (`MCP_READY_TIMEOUT_MS`, the same bound the resume nudge uses) latency during genuine handshake contention (e.g. a fleet-wide restart) — exactly the case this closes the asymmetry for. A role that never mounts loom-orchestration (platform/setup/run/auditor/workspace-auditor/shell) skips the wait entirely — it would otherwise wait out the full timeout for a signal that can never fire.

## Do not

- Do not apply `waitForMcpSeen` to a role that never mounts loom-orchestration — it would wait out the full `MCP_READY_TIMEOUT_MS` for a signal that can never fire.
- Do not skip the wait for a role that DOES mount loom-orchestration on the assumption the handshake is always instant — the 494/494 figure is the common case, not a guarantee; genuine contention (a fleet-wide restart) still needs the bounded wait.

## Source

Inline comments in `packages/daemon/src/pty/host.ts` (`scheduleKickoffGuarantee`'s own JSDoc closing paragraph, and the matching comment inside its `setTimeout` body), as of main `62688be0` (host.ts tranche 49's merge). Extracted by card `9c0c60cb` (tranche 50 on `pty/host.ts`). Condensed and reworded, not verbatim; the 494/494 and 1.19s-2.32s/mean-1.42s figures are carried verbatim as measured evidence. Cites cards `95f40ee0` (the shared `usesOrchestrationMcp` predicate — see that card's own record) and `df5e37e7` (the resume-continuation nudge's own `waitForMcpSeen` use) by name only; neither is restated here.
