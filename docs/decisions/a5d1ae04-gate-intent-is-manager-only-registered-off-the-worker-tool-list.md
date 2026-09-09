# a5d1ae04 — `gate_intent_declare`/`withdraw` are manager-only, kept off the worker's pinned tool list

## Narrative

Card a5d1ae04 — the structured replacement for a hand-written peer-channel "I'm about to fire a merge gate" letter, whose measured delivery latency routinely exceeded the coordination window it existed to protect. MANAGER-ONLY: registered only from the manager branch of `buildServer`, never from the worker branch — a worker's own gate-firing action is `run_gate` (its own DoD self-check), which has no "I intend to" phase worth declaring, and adding either tool to the worker surface would mean touching that role's tightly pinned depth-1 tool list (see the comment at this file's worker-branch `registerGateQueue` call site) for no actual use case. `gate_queue`'s own `declarations` array (registered on BOTH surfaces, unchanged) is how a WORKER — or a peer manager — reads what a manager declared; only the manager that owns the declaration can create or remove it.

## Do not

- Do not register `gate_intent_declare`/`gate_intent_withdraw` on the worker surface — a worker has no "I intend to fire" phase (its only gate action is `run_gate`), and adding either tool would widen the deliberately-pinned worker depth-1 tool list for no use case.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts`, above `registerGateIntent`. Relocated by card 210cd10c (tranche 1 on `mcp/orchestration.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
