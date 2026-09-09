# bed91595 — a real `pending_gate_ops` tombstone for deploy removes the in-process reclassification workaround

## Narrative

Card 8052977a shipped an in-process, best-effort WORKAROUND (`noteDeployOpId`/`recentDeployOpIds`/`resolveDeployOpId`) for `deploy`'s missing durable record — that card's own DoD-2 named the real fix ("a durable `pending_gate_ops` tombstone for deploy") as its costlier option-b and explicitly left it open. Card bed91595 ships that option-b (`SessionService.deployOwnProject` now writes a real `pending_gate_ops` row, mint-then-settle, for every deploy it runs — see that method's own comment) and REMOVES this workaround entirely: a `deploy` opId now resolves through `sessions.gateStatus`'s ordinary tombstone fallback, exactly like a merge/worker gate op, so it never reaches the `never_existed` branch for a real id in the first place — there is nothing left for an in-process reclassification to catch. This also closes BOTH gaps the removed workaround's doc used to name as acknowledged limits: the tombstone is written to disk before `deploy` returns (survives a restart the in-process cache couldn't), and `pending_gate_ops` is a permanent table (never evicted by count, unlike the removed 500-entry Set).

## Do not

- Do not reintroduce an in-process opId cache/reclassification for `deploy` — the durable `pending_gate_ops` tombstone already covers restart-survival and unbounded retention; a cache on top would just be a second, weaker copy of the same fact.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts`, above `registerGateStatus`. Relocated by card 210cd10c (tranche 1 on `mcp/orchestration.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
