# 7dc0cca5 — `run_gate`'s own start instant must be captured before any await, at the first statement

## Narrative

`runWorkerGate` stamps `fnEntryInstant` as the very first statement, before `checkGateTimeoutBreaker` or anything else below it that can `await` and yield (card 7dc0cca5). SEMANTIC: `opStartedAt`/`fnEntryInstant` means the instant this call to `run_gate` WAS ISSUED, not whenever the function got around to stamping it after incidental prefix work — a `wake_me` scheduled any time at-or-after the call was issued genuinely "was scheduled while parked on this op" and belongs in `autoCancelSettleWakes`'s (card `9d521792`, finding `23d8864a`) `createdAt >= opStartedAt` reap. Capturing it before ANY await makes that true by construction, not by luck.

## Mechanism: the race this closes is a real cross-request one, not merely "the caller didn't await"

`run_gate` (this file, served at `/mcp-orch/:sessionId`) and `wake_me` (`mcp/server.ts`, served at the SEPARATE `/mcp/:sessionId` task-MCP route) are two independent MCP router instances behind two independent Fastify routes, with NO shared per-session lock. A worker whose turn emits both as parallel tool calls (Claude routinely batches calls it judges independent) can have `wake_me`'s `db.insertWake` land on the SAME event loop WHILE this function's own prefix is still running, at any await point below — `checkGateTimeoutBreaker`, a no-op normally but a REAL bounded git subprocess call (up to `gitOpMs`/15s) once the branch trips the `GATE_TIMEOUT_BREAKER_THRESHOLD`=3 circuit, so the window is normally ~2ms but can reach SECONDS under load.

Not an edge case the wider window happens to tolerate — it IS the auto-cancel-fallback-wakes feature's (card `9d521792`) OWN PRIMARY USE CASE: "kick off the gate, and set a fallback wake in case it never comes back" is that feature's whole reason to exist, and one batched turn is the single most natural way to say it. Under the OLD late stamp, that expression could land the wake's `createdAt` BEFORE `opStartedAt`, silently excluding it from the reap — reproducing the original stale-fallback-wake bug (finding `23d8864a`) the feature exists to close, for precisely the pattern it was built to cover.

The PREVIOUS fallback (`new Date()` captured after `preAttachPeek`, after that same await) raced this: under host CPU contention the resume could land in the NEXT millisecond, making `opStartedAt` read LATER than a wake created earlier in wall time. EVIDENCE: an instrumented repro measured the wake's `createdAt`/`opStartedAt` 1ms apart with no fail-safe branch hit — see card `7dc0cca5`'s own `worker_report` history for the full trace and the deterministic 10/10-fail / 10/10-pass injection test.

Fixing this at the SOURCE (capture earlier), not by loosening the comparison: a slack/fudge factor on `>=` would only lower the failure rate, not remove the race — the exact anti-pattern card `9d521792` already rejected once for the settle-time-peek version of this bug, rejected again here for a second, independent instance.

RESIDUAL (accepted, not a bug): once the breaker HAS tripped and the window runs to seconds, an UNRELATED wake the same worker created for something else in that window is also reaped — enlarging an EXISTING class rather than creating a new one; the settle nudge wakes the worker anyway, so the worst case is a redundant wake lost, never a stranded worker.

## Second site: the fallback op-start stamp reuses `fnEntryInstant` too

A sibling stamp, `opStartedAt = attachedToInFlight ? preAttachPeek!.startedAt : fnEntryInstant`, sits a few lines below. An already-running entry's OWN `startedAt` always wins — this call merely attaches/re-observes, never started that op. Only the FALLBACK branch (no running entry — about to mint a fresh one) changed: it reuses `fnEntryInstant` instead of a fresh `new Date()` read here, for the identical reason the first site exists.

WHY THE TERNARY STAYS, NOT `preAttachPeek?.startedAt ?? fnEntryInstant` (Code Review): a RETAINED peek is CURRENTLY unreachable-by-consumption here — `attach()`'s own retained-hit check reads the SAME retained map `preAttachPeek` just read, short-circuiting before creating a fresh entry or invoking the settle closure that reads `opStartedAt` — so whichever value it takes in the retained case is dead today. NOT relied on to justify `??`, because that "unreachable" conclusion rests on a TIMING assumption: `peek()` and `attach()` each evaluate `Date.now() < retainedHit.expiresAt` with their OWN read, moments apart. If a retained entry's expiry falls between those reads, `peek()` sees it retained while `attach()` sees it expired and mints a FRESH op — and the settle closure then consumes a stale PREVIOUS op's `startedAt`, over-cancelling wakes since. The window is microsecond-wide, but this card exists because a comparably narrow one (a single await's microtask-resume gap) turned out real under host load — a form resting on nothing beats one merely correct by today's control flow.

## Do not

- Do not stamp `run_gate`'s own start instant after any `await` — capture it as the literal first statement, so a batched `wake_me` can never race ahead of it.
- Do not "fix" this race with a slack/fudge factor on `createdAt >= opStartedAt` — that only lowers the failure rate; card `9d521792` already rejected this anti-pattern once for the settle-time-peek version of the bug.
- Do not simplify `attachedToInFlight ? preAttachPeek!.startedAt : fnEntryInstant` into `preAttachPeek?.startedAt ?? fnEntryInstant` — the "retained case is unreachable" justification rests on a timing assumption a retained entry's expiry can fall between (see "Second site" above).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`runWorkerGate`'s function-entry capture block, and the immediately-following op-start-capture block): as of this tranche's HEAD (tranche 61).
