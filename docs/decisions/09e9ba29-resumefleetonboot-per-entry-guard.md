# 09e9ba29 — `resumeFleetOnBoot` guards each entry individually, the per-entry sibling of `manager_crash_resume_failed`

## Narrative

Card 09e9ba29: `resumeFleetOnBoot` (the `daemon_restart` boot-resume path, sessions/service.ts) iterates
its captured fleet in a single `for (const e of entries)` loop with no per-entry try/catch. The call site
(`index.ts`, ~line 1512) is:

```ts
if (restartIntent) {
  clearRestartIntent();
  const { resumed, skippedParked, failed, retiredSkipped } = sessions.resumeFleetOnBoot(restartIntent);
  ...
}
```

`clearRestartIntent()` has already run by the time `resumeFleetOnBoot` is called — the on-disk intent
file is gone. If ANY entry's per-entry processing throws (the `resumeOne` call itself when a caller
supplies a throwing implementation, bypassing the `{ok,reason}` contract the default wraps around
`this.resume()`; or anything AFTER a successful resume — SYNCHRONOUSLY composing a nudge's text, a
`this.db.getSession` call, `classifyWorktreeIntegrity`, `computeWakeImpact`), the exception escapes the
`for` loop uncaught, escapes `resumeFleetOnBoot` itself, and propagates to the boot call site with the
intent already cleared — every LATER entry in `entries` never gets its own resume attempt, and the whole
fleet it represents is stranded. This is the exact sibling of the defect `0c90ebe4` fixed on the
crash-recovery path (there, an unguarded `appendEvent` call inside `recoverCrashOrphanedWorkers`'s
`byManager` loop could abort every later manager's resume) — generalized here to the WHOLE per-entry
body, not one call, because the inner throw sources in `resumeFleetOnBoot` are only suspected, never
pinned to one call site.

The fix wraps each entry's full processing (inside the main loop, and the dedicated final block that
handles the restart requester `reqId` last) in its own try/catch. A caught throw:

1. Logs the full exception message via `console.warn` — host-local only, never forwarded further.
2. Counts the entry as failed (`failed`/`failedDetail`), so the EXISTING `fleet_resume_failed` aggregate
   (filed under the requester at the end of the function) and its Lead-notification path pick it up for
   free, exactly as if `resumeOne` had gracefully returned `{ok:false}`.
3. Files a NEW durable event, `fleet_resume_entry_failed`, per entry — never batched, mirroring
   `manager_crash_resume_failed`'s own per-entity (not per-boot) filing established by `0c90ebe4`. Filed
   under the failed entry's own MANAGER when it's a worker (`managerSessionId` = `parentSessionId`,
   `workerSessionId` = the worker's own id), or under its own id for every other role (manager, platform,
   auditor, workspace-auditor, setup, assistant, plain, run) — there is no cross-project aggregation
   concern here the way there is for `fleet_resume_failed` (card `5a9a963b`'s isolation reasoning doesn't
   apply: this event never carries another project's identity).
4. When the failed entry is a worker (has a `parentSessionId`), surfaces the failure to its PARENT
   MANAGER via the existing durable-nudge path (`enqueueDurableNudge`) — the manager would otherwise have
   no way to learn that one specific worker's resume processing crashed, distinct from a normal "worker
   resumed, here's its continuation nudge" line.

`detail.reason` is **never** the raw thrown message. `0c90ebe4`'s own sibling event
(`manager_crash_resume_failed`) and `fleet_resume_failed` both sanitize their `reason` against
`RESUME_KNOWN_SAFE_REASONS` — a fail-closed allowlist of `resume()`'s own 7 static throw messages,
because anything `resume()` re-throws from `pty.spawn()` can carry a host path or a session uuid (card
`ee05750e`). That allowlist is scoped to `resume()`'s own throw sites; this catch can fire from ANY code
in an entry's branch (a DB read, a worktree classifier, nudge-text composition), so there is no allowlist
to check an arbitrary caught error against. `detail.reason` is therefore always the SAME generic
`RESUME_UNKNOWN_REASON_FALLBACK` stand-in `normalizeResumeOneResult` already uses for an unrecognized
resume-failure reason — fail closed, never attempt a case-by-case classification.

## Do not

- Do not let a throw from inside one `resumeFleetOnBoot` entry's processing propagate out of the
  function — wrap each entry's FULL processing (not just one call inside it) in try/catch, in the shared
  `SessionService` method itself, not only at the `index.ts` call site.
- Do not batch `fleet_resume_entry_failed` into one aggregate event per boot — file it once per failed
  entry, mirroring `manager_crash_resume_failed`'s own per-entity filing (`0c90ebe4`).
- Do not put the raw caught error message into `fleet_resume_entry_failed`'s `detail.reason`, or into any
  nudge text sent to another session — it can carry a host path or a session uuid; use the generic
  `RESUME_UNKNOWN_REASON_FALLBACK` stand-in and log the full message via `console.warn` only.
- Do not skip surfacing a failed worker entry to its parent manager — reuse the existing
  `enqueueDurableNudge` path, the same one every other continuation nudge in this function already uses.
- Do not assume only the main per-entry loop needs this guard — the final block that resumes the restart
  requester (`reqId`) last is just as capable of throwing, and a throw there would crash the whole boot
  even though the rest of the fleet already got its nudges; it gets the same try/catch treatment.

## Round 2 (Code Review `7fdafcc0` of `f44134fa`)

Round 1 shipped the guard but got three things wrong, all reproduced by the reviewer against the built
`dist`:

1. **A resumed entry could be double-counted as both `resumed` and `failed`.** `resumeOne` catches its
   own throws, so in production nearly every throw this guard catches happens AFTER a successful resume
   — yet `recordEntryCrash` unconditionally pushed to `failed`. `recordEntryCrash` now takes a third
   `resumeOk` param (true only when the caller already pushed the entry to `resumed` before the throw);
   when true, the entry is NOT pushed to `failed`/`failedDetail`, and `fleet_resume_entry_failed`'s
   `detail.reason` is the true `"resumed, but its continuation nudge could not be composed"` instead of
   `RESUME_UNKNOWN_REASON_FALLBACK`. This is what keeps `fleet_resume_failed`, the companion
   worker-crashed alert it feeds, the Lead notice, and the requester "fleet was resumed too" text from
   all calling a live session failed.
2. **`recordEntryCrash`'s parent nudge ignored the park.** It now skips the direct-to-parent nudge when
   `isParked(e.parentSessionId)` — see the new "Do not" below; the `fleet_resume_entry_failed` event filed
   just before it is what the parked parent finds on its next due wake.
3. **`recordDeployShasDelivered` could record a SHA as delivered before the nudge naming it was actually
   enqueued** — in both the non-requester manager/platform branch and the requester's own final block, it
   ran several throwable statements BEFORE the `enqueueDurableNudge` call. A throw in between violated
   `066d317c` (a SHA recorded as delivered must correspond to a nudge the recipient actually saw). Moved
   in both places to run immediately AFTER its corresponding `enqueueDurableNudge` call.

### Scope correction — "nudge composition" (DoD item 5)

The narrative above originally said the guard covers throws from "nudge composition" without qualifying
which half of nudge delivery that means. It covers SYNCHRONOUS throws only — building a nudge's text (a
template literal, a lookup the text interpolates) happens synchronously inside the per-entry try block,
so a throw there IS caught here. Actually DISPATCHING that nudge to an orchestration-role recipient
(`usesOrchestrationMcp`) is asynchronous: `enqueueDurableNudge` defers it inside
`this.pty.waitForMcpSeen(id).then(dispatch).catch(...)`, which already has its OWN `.catch` (a
`console.warn`, independent of this guard) — by the time that promise settles, `resumeFleetOnBoot` has
long since returned, so this per-entry try/catch structurally cannot and does not cover it.

This guard also does NOT cover a dead DB, by design: `recordEntryCrash` itself calls
`captureFailureDetail`, whose `this.db.getSession(e.sessionId)` is unguarded, AND (card `c5415a04`) its
own parent-nudge condition, `isParked(e.parentSessionId)`, which likewise calls `this.db.getSession`
bare — a second, independent unguarded call inside the SAME catch handler, not merely the same call
repeated. A throw from either escapes `recordEntryCrash` uncaught — it has no try of its own; it IS the
catch handler — and from there escapes `resumeFleetOnBoot` entirely. Not re-guarded: a genuinely dead DB
is unrecoverable regardless of how many try/catch layers wrap it, so an extra layer here would just
relocate where the escape happens, not
prevent it.

## Do not (2)

- Do not push an entry into `recordEntryCrash` without having already decided whether `resumeOne`
  succeeded for it — pass the real `resumeOk`, or a live, already-resumed entry gets double-counted as
  both resumed and failed.
- Do not call `recordEntryCrash`'s parent nudge for a PARKED parent (`isParked(e.parentSessionId)`) —
  skip it, mirroring `recoverCrashOrphanedWorkers`'s identical skip (`55d40cfd`); the durable
  `fleet_resume_entry_failed` event already carries the failure for it.
- Do not call `recordDeployShasDelivered` before the `enqueueDurableNudge` call it corresponds to, in
  either the non-requester manager/platform branch or the requester's own final block — call it
  immediately after, per `066d317c`.
- Do not read this guard's "nudge composition" coverage as reaching nudge DELIVERY (the async
  `waitForMcpSeen().then(dispatch)` path, already covered by `enqueueDurableNudge`'s own `.catch`) or a
  dead DB (`captureFailureDetail`'s unguarded `getSession` inside `recordEntryCrash` itself) — see the
  scope correction above.

## Source

New kind added by card `09e9ba29`, doc comment in `packages/shared/src/types.ts`, immediately below
`parked_manager_workers_unresumed`. The per-entry try/catch + the new filing/nudge logic:
`packages/daemon/src/sessions/service.ts`, `resumeFleetOnBoot`.
