# 6651bf24 — the never-completed-first-turn idle notice rewords the false completion claim, doesn't silence the nudge

## Narrative

Card 6651bf24 SPECIMEN 2: a taskless worker whose first turn genuinely started (SessionStart fired, a real UserPromptSubmit hook confirmed it — `hasFirstTurnStarted:true`) but has not yet completed one (`turnSeq` — incremented only at the genuine Stop-hook chokepoint, `host.ts`'s `onTurnCompleted` — is still 0, the same `neverCompletedTurn` field `worker_status`/`mcp/orchestration.ts` already expose). `hasFirstTurnStarted` answers "did anything begin", never "did it finish" — for a claude session it flips true on the first `UserPromptSubmit` hook, i.e. turn start; for a codex session (card 361a5520 — codex has no start-confirming hook at all) it flips true on the first confirmed completion instead (`armCodexBusyStaleTimer`'s CASE 2, `host.ts`) — either way, a live, actively-producing, `busy:true` session mid its first turn is `turnSeq:0` by construction. The taskless branch used to fall through past this state straight into the plain "finished a turn and is idle" wording — false for this case (measured: Specimen 2, a healthy Code Reviewer ~90s into its first turn, got that exact false claim plus a `worker_stop` recommendation — see the card).

Reworded, not silenced (card 6651bf24 DoD-4: "fix the claim it makes", not "silence the nudge generally") — a genuinely wedged first turn is real signal worth surfacing; the fix is to stop asserting a completion that never happened, not to go quiet. The `busy:false` reading this fires on is a single point-in-time snapshot that can already be stale by the time it's read (delivery can lag behind classification — same class of staleness `parked-gate-stale`'s own wording hedges for the tasked path) — an actively-working first turn can dip `busy:false` and recover before the manager ever reads this, which is exactly why the message leads with a live re-check rather than an escalation.

## Do not

- Do not word the never-completed-first-turn notice as a completion claim — it isn't one, and doing so previously drove a false `worker_stop` recommendation against a healthy, actively-working session.
- Do not skip the live re-check step (`worker_status`) before escalating to `worker_transcript`/`worker_message`/`worker_stop` — the triggering `busy:false` reading can already be stale by the time it's read.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`buildNeverCompletedTurnMsg`'s top-of-function doc): lines 1255-1276, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
