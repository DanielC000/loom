# c5415a04 — `fleet_resume_failed` is filed on EVERY path where any entry failed, not just the requester-ok-and-unparked one

## Narrative

Card `09e9ba29` guarded each `resumeFleetOnBoot` entry individually so one throw can't strand the fleet,
but left the aggregate `fleet_resume_failed` event — the human-facing owner of a fleet-resume failure in
every configuration (card `9e4205f5`) — wired to fire from exactly ONE branch: the restart requester's
own `resumeOne` succeeding AND it not being parked. Three other requester outcomes reached the SAME
per-entry `failed`/`failedDetail` state (populated by the main per-entry loop above, independent of the
requester) but never filed the aggregate at all:

- The requester's own `resumeOne` call returns `{ok:false}` (an ordinary, non-throwing failure) — handled
  by a bare `else { failed.push(reqId); }` with no `failedDetail` entry and no aggregate check.
- The requester is parked (`isParked(reqId)` true) — the entire `fleetOk`/aggregate block lived INSIDE
  the non-parked `else` branch, so a parked requester skipped it unconditionally.
- The requester is a retired recycle successor (`isRetired(reqId)`) — same story, a third branch with no
  aggregate check at all.
- The requester's own per-entry processing throws — caught by the existing `recordEntryCrash` guard,
  which files the per-entry `fleet_resume_entry_failed` event but has no notion of the fleet-wide
  aggregate.

In a no-Lead install (the shipped, non-`LOOM_DEV` default), the per-entry event is the ONLY record in
three of these four cases — nothing classifies it for a human (see the DoD-2 section below) and nothing
pushes it anywhere.

## The fix

The aggregate-filing + Lead-notification side effects were factored into one idempotent closure,
`fileFleetResumeFailedAggregate`, called twice:

1. Inside the guarded `try`, immediately after the requester's own ok/fail/retired outcome is known —
   before any of the throw-prone text-composition code that follows in the success+unparked branch.
2. Once more, unconditionally, AFTER the whole try/catch — the fallback that covers the one case the
   first call can never reach: `resumeOne(reqId)` itself throwing before its outcome is even known, which
   jumps straight to `recordEntryCrash` without ever executing call (1).

Idempotency is an explicit local `aggregateFiled` boolean, not a re-derivation from `failed.length` —
`failed.length` only grows between the two calls (never shrinks), so a length-based check cannot tell
"nothing new happened" apart from "this is genuinely the first time we've seen a failure", and a flag is
the only way to guarantee EXACTLY one `fleet_resume_failed` event per boot even though the closure may be
invoked from both inside and outside the try.

The closure is internally defensive (its own try/catch around both the `appendEvent` call and the Lead
lookup/nudge, console.warn on failure) for the same reason every other best-effort write in this function
is: call site (2) runs OUTSIDE the enclosing try/catch, so an unguarded throw there would escape
`resumeFleetOnBoot` entirely — the exact defect `09e9ba29` exists to prevent, just one call further out.

"The requester is gone" (the card's own phrasing) is the `isRetired(reqId)` branch — a retired recycle
successor still gets the SAME aggregate check as every other outcome, so another entry's genuine failure
is never left unowned just because the requester itself happened to be a stale recycle successor.

**Round 2 correction (Minor-4):** the premise above was false. `retiredRecycleSuccessorIds` is declared
`private` in TypeScript, but that is a compile-time-only check — at runtime it is an ordinary property on
the class instance, so a plain `.mjs` test can set it directly (`sessions.retiredRecycleSuccessorIds.add(id)`)
without driving the real recycle-settle machinery at all. `recycle-settle-lost-to-restart.mjs`'s own
scenario (J) already demonstrates a seam exists (by exercising the real path), but the direct-set seam is
simpler and is what `restart-fleet.mjs`'s (9iii) now uses: requester IS a retired recycle successor, a
DIFFERENT entry fails, and the aggregate is asserted to fire exactly once.

## DoD-2: `fleet_resume_entry_failed` → companion "worker-crashed"

Mapped, but gated on a new explicit `detail.resumeFailed: boolean` (set at both `recordEntryCrash` call
sites: `!resumeOk`) — NEVER inferred by matching `detail.reason`'s free text, which this same card also
renamed (`"...could not be composed"` → `"...could not be delivered"`, see Do-not below) and which could
keep changing wording independently of what the classification actually needs to discriminate. `classify()`
(attention-push.ts) returns `"worker-crashed"` only when `resumeFailed === true` — the resumed-but-nudge-
not-delivered case is a live, healthy session (its manager gets a targeted `worker_message` prompt
instead) and must never alert as crashed.

`fleet_resume_entry_failed` was also added to `EVENT_TRIGGER_EVENT_KINDS` (shared/src/types.ts) — that
list's own doc comment states it is "the union of classify()'s signal sources", so adding a case to
`classify()` without also widening this list would leave that invariant false.

**Round 2 (Minor-3):** an `EventTrigger` matches on `kind` alone, never on `detail` — unlike
`classify()`'s explicit `detail.resumeFailed` gate, there is no equivalent filter on the event-trigger
path. A trigger configured for `fleet_resume_entry_failed` fires on EVERY entry of that kind, including
the resumed-but-nudge-not-delivered (`resumeFailed:false`) case `classify()` deliberately does not alert
on. Documented on the kind's own doc comment in `types.ts`; no code change — a human who wants trigger
parity with `classify()`'s filter would need to build it themselves (e.g. scope the trigger to a project
and treat any fire as advisory), since the trigger primitive itself has no per-kind detail predicate.

## Minor-1 ruling (lead, round 2, reversible)

A genuine crash-path resume failure files BOTH the per-entry `fleet_resume_entry_failed` event (via
`recordEntryCrash`) AND, once discovered, the aggregate `fleet_resume_failed` — two `classify()`
"worker-crashed" signals for the same underlying failure. ACCEPTED as-is: it is the rare throw path (not
the ordinary `{ok:false}` failure path), lead mode's own de-duplication already strips repeated
"worker-crashed" alerts, and the per-entry event reaches only a companion granted on the failing
session's own project while the aggregate reaches the Lead — different recipients, so the duplication is
not even always visible to the same reader. No code change. Reversible if a future incident shows this
double-signal is actually confusing in practice.

## Requester self-nudge on a resumed-but-crashed final block (item d)

The restart requester has no `parentSessionId` by construction, so `recordEntryCrash`'s own parent-nudge
branch is always a no-op for it — a requester that resumed OK and then crashed composing its own "code is
live" text was left live with NOTHING injected at all (no nudge, not even the per-entry crash notice,
since that's a durable DB record, not a turn). The catch block now sends it a minimal, best-effort
self-nudge through the SAME `enqueueDurableNudge` path every other notice in this function uses — guarded
by a local `reqNudgeSent` flag so it can never double-fire if the crash happened AFTER the real nudge
already went out (e.g. inside `recordDeployShasDelivered`), and wrapped in its own try/catch so a
genuinely dead DB at this point fails silently rather than escaping `resumeFleetOnBoot`.

**Round 2 (Minor-2):** the `reqNudgeSent` gate alone was not sufficient — two further edge cases.
First, the fallback's full gate is `reqResumeOk && !reqNudgeSent && reqParkCheckedFalse`: the new
`reqParkCheckedFalse` flag is set ONLY right after `isParked(reqId)` has actually returned `false`. If
`isParked` itself throws, `reqNudgeSent` is still `false` but the requester might genuinely BE parked —
sending the fallback nudge in that case would push a turn into a parked cap the park exists to prevent,
so the fallback must not fire until the park check has genuinely resolved to "not parked". Second, for an
immediate-dispatch requester (`usesOrchestrationMcp(role)` false — e.g. `platform`), `enqueueDurableNudge`
can persist the durable row via `pty.enqueueStdin`/the `session_message_queued` fallback and THEN throw on
its own dispatch; setting `reqNudgeSent` only after a clean return left it `false` on that throw, so the
catch block would send a second, contradictory "composing your confirmation failed" nudge on top of a
message that was already queued. `reqNudgeSent = true` is now set BEFORE the `enqueueDurableNudge` call,
not after — the persist-then-throw case now counts as sent.

**Round 2 (Minor-6):** when the Lead IS the requester and its own block crashes AFTER resuming, the
fallback self-nudge now appends `cachedLeadOwnFailureDetail` when set — the Lead's own identified
fleet-resume-failure detail, already computed by the earlier `fileFleetResumeFailedAggregate()` call, is
no longer silently lost just because composing the real "code is live" text crashed afterward.

## Do not

- Do not recompute `fleetOk`/`leadNotified`/`leadOwnFailureDetail` independently inside the
  success+unparked branch — read them from the SAME `fileFleetResumeFailedAggregate()` call made right
  after the requester's own outcome is known; a second, separate computation can drift from what was
  actually filed.
- Do not derive `aggregateFiled` from `failed.length === 0` (or any other re-derivable condition) — use
  the explicit flag. `failed.length` only grows across the two call sites; it cannot distinguish "already
  filed" from "nothing has failed yet but might by the second call".
- Do not call `fileFleetResumeFailedAggregate()`'s DB/nudge side effects without their own internal
  try/catch — the second call site runs outside the function's main try/catch entirely.
- Do not gate `classify()`'s `fleet_resume_entry_failed` mapping on matching `detail.reason`'s text — use
  `detail.resumeFailed`. And do not expect an `EventTrigger` on this kind to respect that same filter — a
  trigger matches on `kind` alone (Round 2 Minor-3).
- Do not send the requester's fallback self-nudge (item d) unconditionally on any catch — gate it on
  `reqResumeOk && !reqNudgeSent && reqParkCheckedFalse` (Round 2 widened this from `reqResumeOk &&
  !reqNudgeSent` alone), or a crash AFTER the real nudge already went out double-nudges the requester
  with a contradictory message, and a thrown `isParked` check can falsely fire the fallback on a
  genuinely-parked requester.
- Do not set `reqNudgeSent = true` only AFTER `enqueueDurableNudge` returns (Round 2 Minor-2) — an
  immediate-dispatch (non-orchestration-MCP) requester can persist the durable row and then throw on its
  own dispatch; set the flag BEFORE the call so that persist-then-throw case still counts as sent.
- Do not set `reqParkCheckedFalse` anywhere except immediately after `isParked(reqId)` has actually
  returned `false` — setting it eagerly (e.g. alongside `reqNudgeSent`, or before the call) defeats its
  whole purpose, which is to prove the park check genuinely resolved rather than merely "didn't throw yet".

## Source

`packages/daemon/src/sessions/service.ts` — `resumeFleetOnBoot`'s final (requester) block and
`recordEntryCrash`. `packages/daemon/src/companion/attention-push.ts` — `classify()`/`alertLine()`.
`packages/shared/src/types.ts` — `fleet_resume_entry_failed`'s doc comment, `EVENT_TRIGGER_EVENT_KINDS`.
