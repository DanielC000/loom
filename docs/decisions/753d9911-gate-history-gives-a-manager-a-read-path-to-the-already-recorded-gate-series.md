# 753d9911 — `gate_history` gives a manager a read path to the already-recorded, settled-gate-run series

## Narrative

Card 753d9911: `listGateEvents` (`db.ts`) already reads the complete, paginated, JOIN-enriched settled-gate-run series — INCLUDING rejected runs, whose `durationMs`/`gateCap`/`concurrentGates` are stamped unconditionally, before any pass/fail branching — but until now it was wired to exactly one consumer, the human-only web Gates page (`gateway/server.ts` `/api/gates/history`). A manager had no read path to it at all and, on card `99fb882e`, spent weeks treating a fully-recorded series as unrecoverable. This is that read path: a THIN wrapper, no new query — same `db.listGateEvents` the web endpoint calls, reused verbatim.

CROSS-PROJECT SCOPING (the load-bearing risk this card called out): unlike the web endpoint, which takes an optional `projectId` and defaults to the WHOLE PLATFORM, this tool takes NO projectId argument at all — the project is resolved SERVER-SIDE from the caller's OWN session (`db.getSession(managerSessionId)?.projectId`), the same pattern `registerGateQueue` uses, so there is no argument shape through which a caller could ask for a different project's rows. This is STRICTER than `gate_queue`'s own redaction (which still returns a foreign project's row with `taskId`/`branch`/`workerLabel` omitted): `gate_history` never returns a foreign-project row at all, so it cannot widen anything `gate_queue` already exposes.

## Do not

- Do not add a `projectId` argument to `gate_history` — the project is resolved server-side from the caller's own session; an argument shape that could name a different project would reopen exactly the cross-project read this design closes.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above the `gate_history` tool registration): lines 4154-4168 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
