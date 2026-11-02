# c5b234aa — mid-turn context sampler: the incident, the design choice, and the Stop-hook race guard

## The incident

Worker `09e8c9f1` exhausted its context ("Prompt is too long") inside ONE ~47-minute turn, while Loom
kept showing it as `busy:true` at `ctxPct 70` — the reading from its PREVIOUS turn's end. `ctx_input_tokens`
is written ONLY at Stop (`pty/host.ts`'s Stop-hook handler, via `readContextStats`), so a long single turn
was entirely invisible to every context-based check until it ended — by which point it was too late. The
manager was never told; the owner caught it manually. `MidTurnContextSampler` closes this gap by
re-reading every currently-busy session's transcript on its own tick, incrementally (only newly-appended
bytes, via `IncrementalContextStatsReader` — never a full re-read) and off the event loop, writing a
fresh mid-turn reading through the SAME `ctx_input_tokens`/`ctx_turns`/`ctx_updated_at`/`model` columns
and setter family the Stop hook already uses.

## Why NOT folded into `ContextWatcher.tick()`

`ContextWatcher.tick()` is synchronous today and already carries several decision-record-guarded
behaviors (manager-recycle ratio, blind-turn advisory, emergency interrupt, turn-count fallback). Rather
than make that method async to support a per-session `await` read, `MidTurnContextSampler` is a separate,
standalone ticker (a structural sibling of `UsageSampler`): own timer, async per-session tick with an
`await` between sessions, per-session incremental-reader cache dropped on exit.

⚠️ CORRECTION (Code Review round 2, card c5b234aa): this record used to claim the separation meant
ContextWatcher's own ratio/emergency logic "benefits from the fresher value for free, with no change to
that file at all." That was false the moment the sampler shipped — see the de-dup correction in
`docs/decisions/9f279c7b-contextwatcher-emergency-recycle-interrupt-trigger-a.md`: making `ctxUpdatedAt`
advance mid-turn broke `checkEmergencyOccupancy`'s existing per-READING de-dup, which DID require a code
change in `context-watcher.ts`. The sampler being a separate class/file does not mean every existing
consumer of `ctxUpdatedAt`/`ctxInputTokens` is automatically safe against a value that can now change
far more often than once per turn — each one needs auditing on its own terms (see that same decision
record, and the Code Review round-2 audit table on card c5b234aa, for the full consumer-by-consumer
verdict).

## The Stop-hook race

The sampler reads a busy session's transcript incrementally, `await`s the async file read, then writes
the result via `Db.setContextCountersIfUnchanged`. If the turn ENDS during that await (the Stop hook
fires), the Stop handler's own unconditional `setContextCounters` call is the authoritative turn-end
value. Without a guard, the sampler's write — computed from a now-stale mid-turn snapshot — could land
AFTER the Stop hook's write and silently overwrite the correct turn-end reading with an older, wrong one.

## Do not

- Do not drop the `busy = 1` / `ctx_updated_at IS ?` guard from the UPDATE's WHERE clause — without it the
  write is unconditional again and the race above is live.
- Do not call `setContextCountersIfUnchanged` from the Stop hook, or any other unconditional write path —
  it exists ONLY for a caller that read `ctx_updated_at` before an async gap and must defer to a newer
  write that may have landed during that gap. The Stop hook has no such gap to defend against; it keeps
  calling the plain `setContextCounters`, which always wins.
- Do not compare `expectedCtxUpdatedAt` with `=` instead of `IS` — a still-unmeasured session's
  `ctx_updated_at` is `NULL`, and SQLite's `=` never matches `NULL` against `NULL`, which would make the
  very first mid-turn sample for a session always lose the race against itself.
- Do not assume a value derived from `ctxUpdatedAt` is safe to de-dup an action on per-READING just
  because an existing check already did that before this sampler shipped — the sampler makes
  `ctxUpdatedAt` advance far more often than once per turn now; any such check needs a per-TURN key
  instead. See the audit table below.
- ⛔ **Round 4: for a de-dup whose OWN fire can itself mutate `busy`/`lastActivity`/`turnSeq` (the
  emergency interrupt's Esc/settle/drain — see `docs/decisions/9f279c7b-contextwatcher-emergency-recycle-interrupt-trigger-a.md`'s
  round-4 section), do not reach for ANY per-turn key at all — three successive rounds each tried one
  (per-reading, `lastActivity`, `turnSeq`) and each reopened the same cascade from a different direction.**
  The fix that actually held: fire AT MOST ONCE PER SESSION ID, no re-arm key. `checkBlindTurn` can safely
  use `lastActivity` only because IT never triggers that cycle itself (advisory-only, no interrupt, no
  Esc) — its safety is a property of what it does, not of the field it reads; don't copy its idiom onto a
  check whose own fire mutates session state.

## Consumer audit — every `ctxUpdatedAt`/`ctxInputTokens` reader, verdict per consumer

Every call site in `packages/daemon/src` that reads `ctxUpdatedAt` or `ctxInputTokens` off a `Session`
row, as of this round (round 4). "Breaks" means the sampler bumping `ctxUpdatedAt`/`ctxInputTokens`
far more often than once per turn can make this consumer behave wrongly; "fine" means it can't, and why.

| Consumer | Verdict | Why |
|---|---|---|
| `orchestration/context-watcher.ts`'s `checkEmergencyOccupancy` (the emergency interrupt, Trigger A) | **BREAKS under any per-turn key** (fixed in round 4) | Three per-turn re-arm keys (per-reading, `lastActivity`, `turnSeq`) each broke in turn — see `docs/decisions/9f279c7b-*.md`'s round-4 section. Round 4 removes the re-arm key entirely: fires at most once per session id. |
| `orchestration/context-watcher.ts`'s ordinary ratio-nudge path (`tick()`, ~line 148-163) | Fine | Reads `m.ctxInputTokens` as a plain VALUE (occupancy ratio) — a fresher value from the sampler is the intended improvement, not a hazard. Its own de-dup/cadence is `state.lastContextNudgeAt` (a persisted timestamp with its own interval check), never `ctxUpdatedAt`/`lastActivity`. |
| `orchestration/context-watcher.ts`'s `checkBlindTurn` (the blind-turn advisory, Trigger B) | Fine | De-dups on `already.ts > m.lastActivity` — `lastActivity` only, never `ctxUpdatedAt`. Advisory-only: it never fires an interrupt, never triggers a `setBusy` cycle, so nothing it does can perturb its own de-dup key. Safe BECAUSE of what it does, not because `lastActivity` is inherently safe (see the round-4 Do-not above). |
| `orchestration/idle-watcher.ts:433-434` (manager idle-nudge "recycle pending" skip) | Fine | Reads `m.ctxInputTokens` as a plain VALUE (occupancy ratio) to decide whether to skip an idle-nudge. No timestamp/de-dup logic involved; a fresher reading only makes this check more accurate. |
| `sessions/service.ts` `workerReport` (~line 15062-15097: `ctxInputTokens`/`ctxPct` on the report + the `ctx:` annotation) | Fine | Reads the CURRENT value fresh at report time by design (the card's own DoD item: "A `worker_report`'s `ctx:` annotation is read fresh at report time") — no de-dup, no staleness comparison; "fresher" is exactly what this consumer wants. |
| `sessions/service.ts` run-teardown (~line 9634-9636: `session.ctxInputTokens`/`ctxTurns` cumulative-usage fallback) | Fine | A one-shot VALUE snapshot taken once at teardown, never compared against a prior reading or a timestamp. Falls back to this only when the richer cumulative-usage read is unavailable. |
| `mcp/orchestration.ts`'s `ctxMidTurnFields` (`fleetView`/`worker_status`/`my_context` display field `ctxMidTurn`) | Fine, with disclosed imprecision | Compares `ctxUpdatedAt >= lastActivity` for DISPLAY only (no action, no de-dup gating a side effect). Already carries its own round-2 `⚠️ APPROXIMATE, not exact` disclaimer (`lastActivity` is also bumped by unrelated writes — `setLastError`, `setProcessState`, etc. — so a `false` here is a useful signal, never an exact one). The sampler's churn doesn't change this consumer's correctness; it was already accepted as approximate before the sampler shipped. |
| `db.ts`/`gateway/server.ts`/`index.ts` (schema columns, REST projections, boot wiring) | Fine (not a behavioral consumer) | Plumbing only — plain reads/writes with no comparison or de-dup logic of their own. |

**Net: the emergency interrupt (`checkEmergencyOccupancy`) was the only consumer that actually broke** —
every other site either reads the value plainly (where "fresher" is the intended improvement, not a
hazard) or already keys its own de-dup on something the sampler never touches (`lastActivity` for
`checkBlindTurn`, `last_context_nudge_at` for the ratio nudge).

## Round 4 (minor): the negative-cache rotation hole in `IncrementalContextStatsReader`

`missCache` (`sessions/context.ts`) remembers that a session's transcript could not be found at all, to
avoid re-paying `resolveTranscriptFile`'s directory scan on every tick. It used to store only `missedAt`,
keyed by `sessionId` — but the rotation-clear at the top of `read()` only fires when a `cache` entry
already exists for that session (i.e. a transcript was found at least once before). A session whose
transcript is NEVER found keeps no `cache` entry at all, so an engine-session-id rotation (card 8a5bd0d0)
on such a session left the stale miss in place: the TTL window kept suppressing a fresh scan under the
NEW engine session id, even though that id's transcript could live somewhere the scan would have found.
Fixed by storing `{engineSessionId, missedAt}` and treating a miss recorded under a DIFFERENT
engineSessionId as no cache hit at all — the TTL only ever suppresses a re-scan for the SAME engine
session id that actually missed.

## Interaction with context-exhaustion detection (card 66ff7321)

Card 66ff7321 (separate, own rework) may make a context-exhausted session fire a `StopFailure` ⇒
`onTurnCompleted` — i.e. the exhaustion itself could bump `turnSeq`. That has NO bearing on this card's
round-4 fix: `checkEmergencyOccupancy` no longer re-arms on any per-turn signal at all, so a `turnSeq`
bump from an exhaustion-triggered `StopFailure` can't re-arm anything either. What 66ff7321 DOES still
need to own, independently, is skipping the emergency check entirely for a session that is ALREADY
context-exhausted (there's nothing left to interrupt it out of) — that skip is 66ff7321's own
responsibility, not a condition this method gained.
