# e6ef5062 — the sub-agent-drift cross-check must correlate against a live count, not stops/confirmedSubagent

## Narrative

`SubagentDriftTracker` (`pty/tool-attribution.ts`) exists to tell whether attribution enforcement (card `8d158088`) might be silently blind — i.e. whether `agent_id` is failing to arrive on sub-agent calls that genuinely are sub-agent calls. The ORIGINAL design (shipped with card `8d158088`) compared a bare `stops > 0` against `confirmedSubagent === 0` and did NOT discriminate: a session running sub-agents that simply never call a watched tool logs EXACTLY that signature in perfectly healthy operation (`agent_id` arriving normally, just never observed because no watched-tool call happened during a live sub-agent's turn) — the SAME reading a genuinely blind session produces.

The fix wires BOTH `SubagentStart` and `SubagentStop` (dispatched in `pty/host.ts`'s `deliverHook`) into a per-session `live` count — incremented on start, decremented (floored at 0) on stop — and correlates it against every watched-tool attribution result at CONSUME time (`recordAttribution`, called from `PtyHost.consumeToolAttribution` with EVERY result, not just "confirmed-subagent"). It counts `blindWhileLive` whenever the result is NOT "confirmed-subagent" (`confirmed-main`/`unknown`/`ambiguous`) while `live > 0` at that moment. `stops` and `confirmedSubagent` are retained as supporting context on the same log line, not as the tell itself.

**Why this discriminates where the original didn't:** the common case — a session running sub-agents that never call a watched tool — now produces `blindWhileLive === 0` in BOTH healthy and blind operation (there is genuinely no data to discriminate on either way), instead of the original design's false alarm (`stops > 0, confirmedSubagent === 0` in that SAME common healthy case). And when a watched tool IS called during a live sub-agent's turn, `blindWhileLive` increments if and only if `agent_id` failed to arrive on that specific call — healthy and blind operation now provably diverge in the tracker's own output for the identical event, not just "does it ever fire".

**Who reads this, and when:** the Loom lead/manager greps `[subagent-drift]` in the daemon log WHEN diagnosing whether enforcement (card `8d158088`) might be silently blind — e.g. after a Claude Code upgrade, or on a report that a sub-agent's `worker_report`/`memory_write` went through unattributed more than expected. NOT a periodic check nobody will run — mirrors `mcp/inbound-log.ts`'s own "who reads this" precedent for the `[mcp]` line. A non-zero `blindWhileLive` is logged distinctly (its own line, on the event that produced it) so it doesn't wait to be noticed in an aggregate.

`consume()` (`ToolAttributionTracker`) is cross-checked by this same live count at every call — see card `aed28554` for the measured boundary this cross-check does NOT close (a main-turn call landing inside a live sub-agent window).

Advisory only, same posture as the rest of `tool-attribution.ts`: nothing here refuses or blocks anything.

## Do not

- Do not read a bare `stops > 0` / `confirmedSubagent === 0` comparison as a blindness signal — it does not discriminate healthy operation (sub-agents that never call a watched tool) from a genuinely blind session; both produce the identical signature.
- Do not treat `live > 0` at consume time as proof of sub-agent origin — see card `aed28554` for the measured race that breaks it.

## Source

Relocated from `packages/daemon/src/pty/tool-attribution.ts` (`consume()` and `SubagentDriftTracker`'s doc comments) by the `tool-attribution.ts, tranche 1` extraction card.
