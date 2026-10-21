# 2ff893f3 — `classifyIdleWorker`'s `mid-first-turn` discriminator

## The bug

A worker's busy:false DB row with `turnSeq===0` was unconditionally read by `classifyIdleWorker`'s
fallthrough as "finished a turn and is idle but did NOT call worker_report" — but `turnSeq` only proves a
turn *started* (`hasFirstTurnStarted`), never that one *finished* (only a real Stop/StopFailure hook
increments it). A give-up path that clears `busy` without a confirming hook ever landing — `fireEnterAndVerify`'s
GIVE-UP RECOVERY branch (`setBusy(..., "give-up-recovery")`) or `giveUpWithoutWriting`'s ownership-mismatch
branch (`setBusy(..., "give-up-ownership-mismatch")`) — can desync `busy` from reality while the real engine
is still alive, mid its genuine first turn, producing real tool-call output. The fallthrough's hard-coded
"finished a turn" claim is then false, and fires repeatedly (once at the busy-edge, and again on every later
`IdleWatcher.tickIdleWorkers` pass) while the worker is actually still working.

## The fix

`classifyIdleWorker` now checks, immediately before its final `stranded` fallthrough: `(w.turnSeq ?? 0) ===
0` AND `pty.getPendingConfirmMs(workerSessionId) != null` (the current generation's Enter write is
genuinely still unconfirmed — no UserPromptSubmit or Stop/StopFailure has landed for it) AND
`pty.getLastOutputAt(workerSessionId)` is within `MID_FIRST_TURN_FRESH_OUTPUT_MS` (30s, matching
`pty/host.ts`'s own `FIRST_TURN_STALE_MS`) AND that unconfirmed generation is still younger than this
project's `stuckWorkerMinutes` (see CR ROUND 2 below — added after the first version shipped unbounded). If
all four hold, it returns `{kind: "mid-first-turn"}` instead of `{kind: "stranded"}`;
`notifyManagerOfIdleWorker` suppresses the notice for this kind the same way it already does for
`not-stranded`/`parked-gate`. Past the `stuckWorkerMinutes` bound, it instead returns
`{kind: "mid-first-turn-stale", minutesUnconfirmed}`, and `notifyManagerOfIdleWorker` sends a REAL,
honestly-worded notice for it (never "none", never the old "finished a turn" claim) that paces at the
ordinary idle cadence (`sent-other`, not the suppressed outcome).

## Why `getPendingConfirmMs`, not turnSeq-increment ordering

On a REAL Stop/StopFailure ending a worker's genuine first turn, `live.enterConfirmed` is set `true`
(`pty/host.ts` Stop/StopFailure case, before `setBusy(false, "stop-hook")` is called in the SAME
synchronous call stack) strictly BEFORE `setBusy` synchronously cascades into
`persistBusy`→`events.onBusy`→`SessionService.handleBusyEdge`→`notifyManagerOfIdleWorker`. `turnSeq`'s own
increment (`events.onTurnCompleted`) happens LATER in that same Stop-case handler, AFTER the busy falling
edge already ran. So at the exact instant `notifyManagerOfIdleWorker` classifies a worker finishing its
*genuine* first turn, `turnSeq` can still read 0 — using turnSeq alone (or any ordering relative to it) as
the "was this really unconfirmed" signal would race and falsely suppress that legitimate notice.
`getPendingConfirmMs` reads `live.enterConfirmed` directly rather than depending on that ordering: it is
`null` the instant ANY confirming hook lands for the current generation, which is already true by the time
a genuine Stop's busy-edge fires, and is NEVER true for a give-up/ownership-mismatch busy-clear (both
require `enterConfirmed` to still be false to fire at all) — so it is race-free regardless of how `turnSeq`
and the busy-edge are ordered relative to each other.

## CR ROUND 2 — the suppression was unbounded, and test (1) could never fail

A Code Review on `9725cf6d` found two Majors in the first version of this fix.

**Major 1 — unbounded suppression.** `pty.getLastOutputAt` counts every pty byte, spinner/repaint
included — its own doc comment at `pty/host.ts` states it reads ~now for ANY mid-turn engine, healthy or
not. `pty.getPendingConfirmMs` stays non-null indefinitely until a confirming hook (UserPromptSubmit or
Stop) actually lands. Neither signal ages out on its own, so a hung or looping turn that still produces
SOME output (a ticking spinner, a stuck tool call) would have been suppressed FOREVER — strictly worse
than the pre-card behavior, which at least sent an (overclaiming) notice. No other watcher catches this
either: `BusyWorkerWatcher` only watches `busy:true` rows (`busy-worker-watcher.ts`), and this worker's
`busy` is already false — that's the entire reason it reached `classifyIdleWorker` in the first place.

**The fix:** bound the suppression by age, with parity to `BusyWorkerWatcher`'s own staleness leash —
`orchestration.stuckWorkerMinutes`, resolved the SAME way (`resolveConfig(project.config)`, never
hard-coded). `classifyIdleWorker` now only suppresses while `pendingConfirmMs < stuckWorkerMinutes *
60_000`; past that, it returns the new `mid-first-turn-stale` kind, which fires a real notice:

> `[loom:worker-idle] worker <id> (task <taskId>) has been in its first turn for ~<N>min with its
> kickoff/turn still unconfirmed by the engine — it is producing output but Loom cannot see turn progress
> (a busy desync: no UserPromptSubmit/Stop hook has landed for this generation). Check its transcript for
> a named artifact before acting: worker_transcript <id>. worker_flush <id> may help disambiguate a
> stranded composer.`

This never claims "finished a turn" (turnSeq is still 0), states the observed minutes-unconfirmed figure
rather than asserting a cause, and points at `worker_transcript`/`worker_flush` rather than
`worker_report`/`worker_merge` (there is no turn to review — see 8f36be30's own "report observed fields,
never assert a cause" precedent elsewhere in this same classifier). It returns `sent-other`, not the
suppressed outcome, so `tickIdleWorkers` paces it exactly like any other sent notice — re-firing at the
ordinary `idleWorkerMinutes` cadence, never going silent again. The bound is checked ONLY when output is
ALSO fresh — a stale-output specimen (test (B)) is unaffected by this bound entirely; it already fell
through to `stranded` before round 2 and still does.

The taskless sibling path (`notifyManagerOfIdleWorker`'s `!w.taskId` branch, `buildNeverCompletedTurnMsg`,
card 6651bf24) has the SAME turnSeq-0 busy-desync shape but was already honestly worded before this card —
no change needed there, just a pointer comment at the new tasked branch.

**Major 2 — test (1) could never fail.** The original test (1) never called `submit()`; it only delivered
the `UserPromptSubmit`/`Stop` HOOKS directly via `deliverHook`. `pty.getPendingConfirmMs` depends on
`live.currentGenFirstWrittenAt`, which is stamped ONLY inside `fireEnterAndVerify`'s attempt-1 write
(`pty/host.ts` ~12349) — reachable only through a REAL `submit()` call, never through a bare hook delivery.
So `getPendingConfirmMs` was ALWAYS null in that test, regardless of this fix's correctness. The Code
Reviewer proved this by deleting both `live.enterConfirmed = true` sites from the compiled `dist` output
and observing all six of test (1)'s checks still pass.

**The fix:** test (1) now drives a REAL `submit()` (via `host.enqueueStdin`, with
`LOOM_SUBMIT_ENTER_DELAY_MS`/`LOOM_PTY_WRITE_CHUNK_DELAY_MS` zeroed so the real chunked-write pipeline
settles fast), polls (`waitUntil`, an OBSERVABLE-condition wait, never a blind sleep) for
`getPendingConfirmMs` to actually go non-null, then deliberately SKIPS delivering `UserPromptSubmit`
(simulating "the kickoff Enter landed but the confirming hook got lost" — `sha:c433346f`'s own documented
case: a Stop is itself proof the outstanding submit's Enter registered, even when UserPromptSubmit never
arrived) before delivering `Stop` directly. Because `hasFirstTurnStarted` is set ONLY by a real
`UserPromptSubmit` and would otherwise stay `false` forever here, the test ALSO writes a real on-disk
transcript (`writeLiveTranscript`) for the worker before `Stop` — mirroring the real incident's own shape
("turnSeq=0... while its transcript shows continuous tool calls") — so `classifyIdleWorker`'s EARLIER
`!hasFirstTurnStarted && !everReported && emptyTranscript` broken-spawn gate doesn't intercept it before
ever reaching the mid-first-turn/stranded decision this test exists to exercise.

**Negative control (manual, not automated in the test file):** moving the Stop case's
`live.enterConfirmed = true;` (`pty/host.ts` ~10158) to AFTER `setBusy(false, "stop-hook")` (~10198),
rebuilding, and re-running test (1) makes it go RED (the moved-too-late `enterConfirmed` means
`getPendingConfirmMs` is still non-null at the moment of classification, so it wrongly suppresses the
genuine first-turn-end notice) — confirmed, then the source was restored byte-identical and rebuilt clean.
This is what proves test (1) can actually fail; see the card's own verification log for the exact run.

## CR ROUND 3 — three Minors, fixed in the same card

**M1 — `flushComposer` would have silently reset the bound's clock.** A re-review found that
`notifyManagerOfIdleWorker`'s `mid-first-turn-stale` notice recommends `worker_flush`, but
`flushComposer` re-enters `fireEnterAndVerify(sessionId, 1, gen, live)` — and `attempt===1` there
unconditionally overwrites `Live.currentGenFirstWrittenAt`, which `getPendingConfirmMs` (what the bound
originally read) is built on. So following the notice's own suggested remedy would have silently restarted
the bound for another full `stuckWorkerMinutes`. Fixed by adding a SEPARATE field, `Live.generationStartedAt`
— stamped exactly once, inside `submit()` itself (never inside `fireEnterAndVerify`, so no retry OR
`flushComposer` re-entry ever touches it) — and a matching getter, `getUnconfirmedGenerationAgeMs`.
`classifyIdleWorker`'s bound check now reads ONLY this getter; `getPendingConfirmMs` is untouched and its
existing consumer (the latency-logging reader in `deliverHook`'s Stop-case path) keeps its exact prior
behavior — it only ever runs once a confirming hook has already landed, so a flush-driven reset there was
never actually a problem for that specific reader.

**M2 — wording.** The notice now says "its current turn's Enter has been unconfirmed by the engine for
~Nmin" rather than "has been in its first turn for ~N min" — stating what is actually measured
(`getUnconfirmedGenerationAgeMs`), not an inference about the turn's own duration.

**M3 — `stuckWorkerMinutes:0`.** Decided: 0 means NO suppression at all (fail toward notifying), the
same direction as `BusyWorkerWatcher`'s own `=== 0` disable — but here that means disabling the SUPPRESS
side, not the whole mechanism: with the bound effectively at 0ms, `unconfirmedAgeMs < 0` is never true
(an age is never negative), so the row always falls through to the honest `mid-first-turn-stale` notice,
with no separate special-cased branch needed. The reported minutes figure is floored at 1
(`Math.max(1, Math.round(...))`) so it can never read the misleading "~0min".

**N1 — `isWorkerGenuinelyStranded` keeps excluding `mid-first-turn`/`mid-first-turn-stale`.** Deliberate,
following the same precedent as `parked-gate-stale`/`parked-merge`: each of those kinds already has its
own real, delivered notice via `notifyManagerOfIdleWorker`, so counting it as "stranded" too would
double-surface the same worker to the manager through two independent paths.

## The outcome is a DISTINCT value, never collapsed into "none"

`notifyManagerOfIdleWorker` returns a dedicated `"suppressed-mid-first-turn"` outcome for this kind,
never the same `"none"` every other suppressed kind (`not-evaluable`/`not-stranded`/`parked-gate`)
returns. `IdleWatcher.tickIdleWorkers` skips its `db.recordIdleNudge` pacing stamp ONLY on that exact
value — every pre-existing `"none"` kind keeps its old, unconditional stamp. This was deliberately
**narrowed**, not left as a blanket "any suppressed outcome skips the stamp": a `not-stranded` row can
mean a worker is rate-limited for up to a week (weekly cap) with its task still in the active column
(`tickIdleWorkers`'s own pre-filter does not exclude a rate-limited row); without the stamp, that
worker would be re-classified on every 60s tick for the ENTIRE rate-limit duration instead of once per
`idleWorkerMinutes`, a real, unmeasured read-load increase with no corresponding benefit for that kind
(a rate-limited worker is daemon-verified parked; it needs no faster re-check). `parked-gate` carries the
same shape for however long a real gate run takes. Neither kind benefits from the faster re-check this
card's OWN kind specifically needs (see below) — only `mid-first-turn` does, so only it gets it.

## The delay tradeoff — the precise worst case

`db.setBusy` (called by EVERY busy transition, including the false give-up busy-edge this card targets)
unconditionally bumps `last_activity` to "now". So at the instant a false busy-edge fires (t0),
`last_activity` becomes t0 — independent of whether the notice fires or is suppressed, and independent of
`db.recordIdleNudge`, which the busy-edge path never calls at all (only `tickIdleWorkers` calls it).
`tickIdleWorkers`'s own pacing gate (`idleForMin = (now - max(lastActivity, lastIdleNudgeAt)) / 60000 <
idleWorkerMinutes → skip`) is therefore governed by `last_activity = t0` here, NOT by whether this card's
stamp-skip fires — the stamp-skip's effect only begins AFTER that gate first clears. Precisely:

- **If output is already stale at t0 itself**, the discriminator never engages at all — the notice fires
  immediately at the busy-edge, zero added delay (this is exactly test (1)'s genuine-first-turn-end case).
- **If output is fresh at t0 and the worker then dies before `idleWorkerMinutes` (default 45min) has
  elapsed since t0**, nothing re-evaluates it before that point (no OTHER busy edge will fire for a truly
  dead worker, and `tickIdleWorkers` itself skips it via the `idleForMin` gate above) — the notice fires at
  `t0 + idleWorkerMinutes`. This is NOT a cost this card introduces: it is the SAME baseline cadence any
  idle, unreported worker already waits for via `tickIdleWorkers`, with or without this card.
- **If output is still fresh at that first `t0 + idleWorkerMinutes` check** (the worker was genuinely still
  working then) **and only dies some time after it**, THIS is where the stamp-skip matters: because it was
  never stamped, `last_activity` stays pinned at t0 and the gate stays permanently cleared from that point
  on, so EVERY subsequent `tick()` (default every 60s, `IdleWatcherDeps.intervalMs`) re-evaluates it. Once
  output crosses the 30s staleness threshold, the very next tick fires the notice — so the worst-case ADDED
  delay once the worker actually goes stale, in this specific case, is bounded by the tick interval
  (default 60s), not `idleWorkerMinutes`.

In short: `idleWorkerMinutes` bounds the FIRST evaluation opportunity (an existing baseline, unaffected by
this card); the tick interval bounds every evaluation AFTER that first one, specifically because this
card's narrow stamp-skip keeps re-checking instead of waiting another full `idleWorkerMinutes`.

## Scope

Deliberately limited to `turnSeq===0`. The same give-up/busy-desync mechanism can in principle also
mis-stamp a `turnSeq>0` row (busy desyncing mid a LATER turn while the engine keeps working) — that is a
real, separate residual, carded independently; this fix does not widen to cover it.

## Do not

- Do not use `turnSeq`-increment ordering (or anything derived from comparing it against the busy-edge
  timing) as the "was this really unconfirmed" signal — it races against a genuine first-turn Stop, which
  increments turnSeq strictly AFTER its own busy falling edge already ran.
- Do not let this suppression mark the worker as notified/deduped (no `db.recordIdleNudge` call on this
  path) — a later tick must re-classify from scratch once output goes stale, or a genuine stall would never
  surface.
- Do not widen this discriminator to `turnSeq>0` rows — that is a separate, already-carded residual.
- Do not lower `MID_FIRST_TURN_FRESH_OUTPUT_MS` casually — see its own doc comment for the worst-case delay
  this trades against.
- Do not widen `tickIdleWorkers`'s stamp-skip to every `"none"`-returning outcome — a `not-stranded`
  (rate-limited, up to a week) or `parked-gate` row would then re-classify on every 60s tick for the whole
  duration of that state instead of once per `idleWorkerMinutes`, with no corresponding benefit. Keep the
  skip keyed to the exact `"suppressed-mid-first-turn"` value, never a plain `"none"` check.
- Do not collapse `"suppressed-mid-first-turn"` back into `"none"` on `IdleWorkerNotifyOutcome` — that is
  the only thing that lets `tickIdleWorkers` tell this kind apart from every pre-existing suppressed kind.
- Do not suppress `mid-first-turn` on fresh-output/unconfirmed alone, with no age bound — `getLastOutputAt`
  counts spinner/repaint bytes and never ages out on its own; a hung or looping turn would be suppressed
  forever (CR round 2 Major 1). Bound it on `stuckWorkerMinutes`, never remove the bound.
- Do not word the `mid-first-turn-stale` notice as a completion (it must never say "finished a turn" —
  turnSeq is still 0) or route it through the suppressed outcome — it must be a real, paced `sent-other`.
- Do not test this classifier's mid-first-turn path by delivering `UserPromptSubmit`/`Stop` hooks directly
  without a real `submit()` call — `getPendingConfirmMs` depends on `currentGenFirstWrittenAt`, stamped
  only inside `fireEnterAndVerify`, never by a bare hook delivery (CR round 2 Major 2 — the exact way test
  (1) could never fail before this was caught).
- Do not bound `mid-first-turn` on `getPendingConfirmMs` — `flushComposer`'s own re-entry into
  `fireEnterAndVerify` (attempt:1) overwrites the field it's built on, silently restarting the bound on
  every `worker_flush` (CR round 3 M1). Use `getUnconfirmedGenerationAgeMs` instead.
- Do not stamp `Live.generationStartedAt` anywhere but inside `submit()` itself — stamping it from
  `fireEnterAndVerify` (a retry OR a `flushComposer` re-entry) would reproduce the exact bug this field
  exists to avoid.
- Do not special-case `stuckWorkerMinutes===0` as "keep suppressing forever" — it means the opposite, no
  suppression at all (CR round 3 M3); the existing `unconfirmedAgeMs < stuckWorkerMs` comparison already
  gets this right with `stuckWorkerMs=0` and needs no separate branch.
- Do not report a minutes-unconfirmed figure without flooring it at 1 — an unfloored `Math.round` can
  read "~0min", which contradicts the notice's own claim that the generation is meaningfully stuck.
