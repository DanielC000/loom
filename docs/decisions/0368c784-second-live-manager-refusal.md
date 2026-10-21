# 0368c784 — refuse a second live-or-starting manager for one agent

## Narrative

From `318b5a21`: the web go-live guard used `processState === "live"`, so a double-click during a spawn's
`starting` window could mint a SECOND manager for the same agent. `318b5a21` fixed the client (the shared
`holdsGoLiveSlot` predicate), but `SessionService.startNew`/`startManager` had NO server-side refusal at
all — the client predicate was the only barrier. Any other caller (a second tab, a direct REST call, a
race between two requests, the Scheduler, a webhook) could still double-spawn a manager or Platform Lead
for the same agent+project.

`refuseSecondLiveManager` (`sessions/service.ts`) closes this: a synchronous check, placed beside
`refuseManagerIntoReservedHome`, called from `startManager` unconditionally and from `startNew`'s
manager-resolved branch (`if (role === "manager")`).

## The atomicity invariant — no lock needed, by construction

`startNew`, `startManager`, `startPlatformLead`, `startSetup`, and `spawnSessionAsPlatform` are all
declared as plain, non-`async` methods returning `Session` directly (never `Promise<Session>`).
TypeScript forbids an `await` anywhere inside a non-`async` function body — so the entire span from this
guard's check to `insertSession` is ONE uninterruptible synchronous turn on the event loop. Whichever
concurrent call starts executing first runs straight through check → insert → flip-to-live before any
other call to the same method gets a turn — no explicit lock/Map is structurally required.

This is not a novel property invented for this card — `recycleManager`'s own anti-double-recycle guard
already relies on the identical reasoning (its own comment: "The whole pre-spawn block runs synchronously,
so this check + the retire/spawn below are one atomic guard on the event loop"), and
`startPlatformLead`'s own singleton check (`liveOtherPlatformLead`) relies on the same property.

Verified against a REAL listening gateway + real concurrent `fetch()` calls (not sequential
`app.inject`), not just unit-level reasoning — see
`packages/daemon/test/gateway-second-live-manager-refusal.mjs`: two simultaneous
`POST /api/agents/:id/sessions {role:"manager"}` resolve to exactly one 2xx + one 409, every time.

Verified synchronous end to end for every spawn entry point that can resolve role `"manager"`:
`POST /api/agents/:id/sessions` (gateway/server.ts), the Scheduler's periodic manager spawn
(orchestration/scheduler.ts), `spawnSessionAsPlatform` (the Platform Lead's `session_spawn`, the
loom-setup mirror, and the companion `session-spawn` lever all converge here) — and the companion lever
specifically (`companion/capabilities.ts`'s `session_spawn` tool handler, wired via
`mcp/orchestration.ts`'s `spawnSession: (...) => sessions.spawnSessionAsPlatform(...)`): read in full,
confirmed to have no `await` anywhere between its own guard checks and the spawn call.

## Keyed on verified pty liveness, never raw `processState` alone

Mirrors `liveOtherPlatformLead` (`projects/live-lead-home.ts`): a phantom-live/starting row (pty already
dead, or never actually spawned) must never permanently block a legitimate start. `refuseSecondLiveManager`
requires `processState` in `("live","starting")` AND `pty.isAlive(id)` true — a row satisfying only the
first (a crash-stranded or manually-inserted row with no real process behind it) does not block.

A crash mid-spawn (between `insertSession` and the following `setProcessState("live")`, both synchronous
with nothing else able to run in between) can only leave a row genuinely stuck at `"starting"` across a
daemon restart — and `Db.recoverStaleSessions()` unconditionally flips every row still
`processState IN ('live','starting')` to `'exited'` at the next boot, before anything else runs. Within a
single boot, a `pty.spawn()` call that throws synchronously is caught by `reconcileFailedSpawn`; a `pty`
that never reports alive and never exits has no explicit timeout today — a narrow, pre-existing gap
unrelated to this guard (it would equally strand a `"live"` row), not fixed by this card.

## The recycle-predecessor exemption

`recycleManager`/`recyclePlatformLead` deliberately mint a fresh successor while the predecessor is still
live (the sanctioned brief-coexistence window — the predecessor's hard-stop is deferred). Neither method
calls `refuseSecondLiveManager` at all (recycling is a separate, pre-existing anti-double-recycle guard,
`hasSuccessor`-keyed, untouched by this card), so recycling itself is never blocked by its own
predecessor. For a THIRD party trying to start a fresh manager during that window,
`refuseSecondLiveManager` excludes any row where `db.hasSuccessor(row.id)` is true — so the predecessor is
correctly skipped and the refusal names the SUCCESSOR instead (see
`packages/daemon/test/second-live-manager-refusal.mjs`, scenario (f)).

## startSetup's own singleton: same class, deliberately left alone

`startSetup`'s singleton (`liveSetupSession`) is keyed on raw `db.liveSessions()`
(`processState === 'live'` only, via `db.liveSessions`) — the same "misses the `starting` window" shape
this card's `countLiveSessionsForAgent` widening fixes for the delete-agent guard. It is left AS-IS here:
by the same atomicity argument above, nothing can ever observe a `startSetup`-minted row sitting at
literal `"starting"` for longer than its own unobservable synchronous window, so this is a latent
shape-match, not a live bug — out of this card's scope.

## Do not

- Do not call `refuseSecondLiveManager` from a body that is `async` with an `await` between the call and
  `insertSession` — that would silently reopen the exact race this check relies on being closed by
  construction. If `startNew`/`startManager` are ever made `async`, re-derive this invariant from scratch
  before trusting the guard again.
- Do not key the guard on raw `processState` alone — a phantom-live/starting row (dead pty, or one that
  was only ever inserted directly, e.g. in a test) must never permanently lock an agent out. Always pair
  with `pty.isAlive(id)`.
- Do not widen this guard to `recycleManager`/`recyclePlatformLead`'s own successor-insert path — that
  would break the sanctioned predecessor+successor coexistence window.
- Do not assume this guard reaches `startPlatformLead`/`startSetup` — it is manager-only; both of those
  roles already have their own, differently-shaped singleton mechanisms (see above), untouched here.

## Source

`packages/daemon/src/sessions/service.ts` — `SecondLiveManagerError`, `refuseSecondLiveManager`, and its
two call sites in `startNew`/`startManager`. `packages/daemon/src/db.ts` —
`countLiveSessionsForAgent` widened to also count `'starting'` (the agent-delete guard). Tests:
`packages/daemon/test/second-live-manager-refusal.mjs`,
`packages/daemon/test/gateway-second-live-manager-refusal.mjs`,
`packages/daemon/test/scheduler-second-live-manager-refusal.mjs`, and the new case in
`packages/daemon/test/mgmt-project-agent.mjs` (section D).
