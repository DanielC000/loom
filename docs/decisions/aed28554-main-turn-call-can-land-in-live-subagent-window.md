# aed28554 — a main-turn watched-tool call can land inside a live sub-agent window

## Narrative

The sub-agent-drift cross-check (card `e6ef5062`, `SubagentDriftTracker` in `pty/tool-attribution.ts`) brackets each watched-tool attribution result against a per-session `live` sub-agent count: a call observed while `live > 0` is CONSISTENT WITH having originated inside that live sub-agent — a real lifecycle-hook signal, not a guess. But it is NOT a proof.

MEASURED, 2026-08-25: this file's own ORDERING GUARANTEE (module header, card `cd0c7fee`) is a PER-INVOCATION guarantee only — Claude Code blocks the invoking turn until ITS OWN Task-tool call returns — and says nothing about a Task call and a sibling watched-tool call dispatched as PARALLEL tool calls from the SAME assistant message. A main-turn watched call CAN land inside a live sub-agent window: reproduced 1 of 4 attempts by dispatching a Task call and a sibling `memory_write` from one message — the sibling's PreToolUse/consume landed inside the live window on attempt 1, and after it on attempts 2-4. The relative order is a real race, observed both ways (full trace: project memory `subagent-drift-blind-false-positive-confirmed`).

So "consistent with" is the honest strength of this signal, not "known"/"proven" — a result that is NOT "confirmed-subagent" under `live > 0` (`confirmed-main`, `unknown`, or `ambiguous`) is a genuine, per-event drift OBSERVATION worth surfacing, not a certified misattribution. In the common case — no watched tool called while any sub-agent is live — the signal correctly stays silent in BOTH healthy and blind operation, because there is genuinely no data to discriminate on either way; it does not read that silence as an alarm.

**The companion leak this card also bounds:** `SubagentDriftTracker.evict()` is called from `pty/host.ts`'s pty `onExit` handler, on EVERY exit path (a deliberate stop, a crash, a clean session end). Without it, a `SubagentStart` with no matching `SubagentStop` (a killed/interrupted/crashed sub-agent, or a daemon restart mid-flight) would leave `live > 0` for that session FOREVER, so every later non-confirmed watched call on that session logs BLIND regardless of ground truth. This bounds the leak to the session's own lifetime rather than leaving it unbounded in time — a session that exits is a session no watched-tool call can ever arrive for again, so there is nothing left for a stale `live` count to mis-attribute.

## Do not

- Do not treat a `blindWhileLive` increment (or `live > 0` at consume time generally) as a certified misattribution — it is an observation, not proof; the race above shows a legitimate main-turn call CAN land inside a live window.
- Do not skip `evict()` on any session exit path — an unmatched `SubagentStart` leaves `live` stuck > 0 forever otherwise.

## Source

Relocated from `packages/daemon/src/pty/tool-attribution.ts` (`consume()`'s and `SubagentDriftTracker`'s class doc comments) by the `tool-attribution.ts, tranche 1` extraction card. `evict()`'s own doc comment (same file) states the leak-bound independently and was left inline, unanchored — it was below this tranche's flagged-block length threshold, out of scope.
