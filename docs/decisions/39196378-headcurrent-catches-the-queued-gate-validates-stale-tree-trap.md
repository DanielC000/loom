# 39196378 — `headCurrent`/`headWarning` catch the queued-gate-validates-a-stale-tree trap

## Narrative

`headCurrent`/`headWarning` (card 39196378 — the queued-gate-validates-a-stale-tree trap, a confirmed live incident on a peer daemon) make a SETTLED result state plainly whether `validatedHead` is STILL the branch HEAD, computed once at settle time via `SessionService.describeGateHeadCurrency` — see its doc for the benign-vs-concerning wording split. `headCurrent:true` means nothing moved; `false` always comes with a `headWarning` explaining which of the two shapes it is. Set on every `ran:true` outcome, same as `validatedHead` — EXCEPT the circuit-breaker short-circuit path (no gate actually ran, no stamp taken, so neither field is set, same as `validatedHead`/`durationMs` there).

## Mechanism (verified against source, not restated from the card)

The concrete scenario this exists for: a cap-1 gate queue routinely runs 30+ minutes — easily long enough for the SAME worker to keep committing in the meantime, well before its own gate run is even admitted past the semaphore.

`runWorkerGate` computes `startStamp` before calling `GateSemaphore.runExclusive`, which `await`s `acquire()` — the queue — before ever invoking its `fn` (`gate-semaphore.ts`'s `runExclusive`: `await this.acquire(...); ...; return await fn(...)`). Once admitted, `fn` calls `runGateSequential` -> `runGateStep`, which spawns the gate command directly against the worktree path (`gate-runner.ts` has no checkout/stash/snapshot) — i.e. against whatever is physically on disk at that later moment. A commit landing during the QUEUE WAIT (before admission) is fully present in what the gate actually builds and tests; only the fire-time label fails to say so. A commit landing WHILE the gate is already spawned and running is different and riskier — the running process may read a torn mix of old and new files.

`SessionService.describeGateHeadCurrency` takes THREE stamps, not two, for exactly this reason: `startStamp` (fire, before the queue), `admitStamp` (right before the child process is spawned), and `settleStamp` (after the run settles). Comparing start-to-admit vs admit-to-settle is what separates "the label is stale but the tested tree matches current HEAD" from "the worktree moved WHILE the gate was literally executing" — a cruder start-vs-settle-only comparison could not tell those apart and would warn identically for both, the "cries wolf on the benign case" failure mode the card warned against.

Four outcomes, worded differently so a genuine warning doesn't get trained out by a benign one: CURRENT (no stamp moved — no warning); RELABELED, benign (the worktree moved between `startStamp` and `admitStamp` — during the queue wait — but not between `admitStamp` and `settleStamp`: the gate's own execution window saw one stable tree, and `validatedHead` merely understates what got covered); RACY, concerning (the worktree moved between `admitStamp` and `settleStamp` — something changed while the gate command was actually running, so this run's coverage of the current tree is genuinely unverified, not just mislabeled); UNKNOWN (any stamp's head is unreadable — a git error/timeout — fails toward "not current", mirroring `gateStampsDiffer`'s own fail-safe direction: an unreadable comparison never gets to assert "unchanged").

Deliberately not a fix to snapshot semantics: this reports on reality, it does not change what gets tested — re-snapshotting at admission would silently change what a queued gate validates and invalidate the `attachedToInFlight`/`staleAgainstWorktree` contract elsewhere in the file. The `admitStamp` read is read-only diagnostics, exactly like `startStamp`/`settleStamp` — it never feeds back into what `runGateSequential` executes against.

## Do not

- Do not skip stating `headCurrent`/`headWarning` on a settled result — this closes a confirmed live incident (a queued gate validating an already-stale tree) on a peer daemon; a `false` value must always come with a `headWarning` explaining which of the two shapes it is.
- Do not collapse the RELABELED and RACY outcomes into one warning shape — a cruder start-vs-settle-only comparison (an earlier version of this fix) could not tell them apart and warned identically for both, defeating the point of the distinction.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`WorkerGateResult.headCurrent`/`headWarning`): lines 664-695, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

The Mechanism section above is from a second site citing the same card: the JSDoc directly above `SessionService.describeGateHeadCurrency` (tranche 41, service.ts, ~lines 11388-11435 as of commit `c3751783`) — genuinely new nuance (the code-traced mechanism proof, the three-stamp rationale, the four-way outcome split) not previously captured by this record; anchored there, not duplicated as a second file, per the one-record-per-id rule.
