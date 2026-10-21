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

## No `hasSuccessor` exemption — a halted recycle makes it unsafe

An earlier version of this guard excluded any row where `db.hasSuccessor(row.id)` was true, reasoning
that the predecessor is always the one to skip during `recycleManager`'s sanctioned brief-coexistence
window. Code Review (`8e84a403`) found this unsafe: when a recycle HALTS (the successor dies before
reaching ready), `recycleManager`'s halt branch (`@decision f1969787`, service.ts) reclaims the fleet
onto the never-stopped predecessor, which stays the legitimate live owner — but `hasSuccessor(predecessor)`
stays true PERMANENTLY (the successor's row is never unlinked in this path, unlike the pre-spawn-throw
path, which does null `recycledFrom`). `resume()` already learned this exact lesson (`@decision
386e4eb5`: never a bare `hasSuccessor` check) before this guard repeated the mistake.

The fix is to drop the exemption entirely, not to patch it: a LIVE successor already blocks a fresh start
on its own (it is alive, role `"manager"`, found by the same scan), so excluding the predecessor only
ever changed WHICH id the error named, never whether the start was refused. With the exemption gone:
- **Ordinary coexistence** (predecessor and successor both alive): a fresh start is refused, naming
  WHICHEVER of the two the scan finds first — never asserted as specifically the successor any more (see
  `packages/daemon/test/second-live-manager-refusal.mjs`, scenario (f)).
- **Halted recycle** (predecessor alive, successor dead, `recycle_ownership_transfer_failed` filed,
  `hasSuccessor(predecessor)` permanently true): a fresh start is STILL refused — correctly, this time —
  naming the predecessor, since the successor fails the `pty.isAlive` check and the predecessor is no
  longer excluded (scenario (f2), same test file). Confirmed RED against the prior commit (`9febe1f5`,
  which still had the exemption): reverting to it reproduces exactly this one failure and no other.

Recycling ITSELF is unaffected either way — `recycleManager`/`recyclePlatformLead` never call
`refuseSecondLiveManager` at all (their own anti-double-recycle guard is the separate, pre-existing
`hasSuccessor`-keyed check on the RECYCLE path, untouched by this card).

If a future case genuinely needs to skip a predecessor while its successor is alive but not yet visible
to this scan, key that on `isSupersededByRecycle` (or an equivalent explicit "a healthy handoff is in
progress" signal), never on bare `hasSuccessor` — and say why in this record when it's added.

## startSetup's own singleton: same class, deliberately left alone

`startSetup`'s singleton (`liveSetupSession`) is keyed on raw `db.liveSessions()`
(`processState === 'live'` only, via `db.liveSessions`) — the same "misses the `starting` window" shape
this card's `countLiveSessionsForAgent` widening fixes for the delete-agent guard. It is left AS-IS here:
by the same atomicity argument above, nothing can ever observe a `startSetup`-minted row sitting at
literal `"starting"` for longer than its own unobservable synchronous window, so this is a latent
shape-match, not a live bug — out of this card's scope.

## Known out-of-scope residuals — carded separately, not fixed here

This guard covers `startNew`/`startManager` only. Two other paths can mint/reattach a second live
manager for one agent and are deliberately NOT touched by this card:

- **`resume()` of an exited, NON-recycled manager while another manager is already live.** `resume()`
  has a `role==="setup"` sibling check (verified `pty.isAlive`) and a `role==="manager"` barred-home
  check, but no analogous "is another manager for this agent already live" check. Any automatic resume
  path reaches this gap — including the automatic event-trigger wake path
  (`orchestration/event-triggers.ts`, around its `fire`/wake branch) and a due `wake_me` firing on an
  exited manager row — not just the human `/resume` REST route.
- **`forkSession` of an idle (non-busy) live manager.** A fork carries `role: src.role` forward
  unchanged, so forking a live-but-idle manager session mints a brand-new `role:"manager"` row for the
  SAME agent, with no check against an existing live manager (only setup/platform singleton + the
  barred-home check exist on this path).

## Known consequence: webhook/poll spawn-mode deliveries

Before this card, a spawn-mode webhook/poll delivery to an agent that already had a live manager would
silently mint a SECOND manager (the bug this card fixes). After this card, that delivery is refused —
with a different downstream effect per caller, both already-existing behavior this card did not change:

- **Webhook** (`webhooks/ingress.ts`): any throw from the spawn call undoes the delivery's dedupe row
  (`@decision 72c58b1c`) — so a refused spawn-mode delivery is effectively DROPPED (not durably recorded
  as delivered); it only fires again if the webhook source itself redelivers the same event.
- **Poll** (`orchestration/poll.ts`): the cursor/`next_poll_at` for a "new item" is only committed on a
  SUCCESSFUL delivery — so a refused spawn-mode item is RETRIED on a later due poll (exponential backoff
  via `consecutiveFailures`, never disabled), rather than minting a duplicate manager.

Neither is a new behavior change beyond "a duplicate manager no longer gets minted" — both callers
already had this exact retry/drop shape for any OTHER throw (a transient DB error, a bad config); this
card just adds one more reason a throw can happen.

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
- Do not reintroduce a bare `!db.hasSuccessor(s.id)` exclusion in this scan — that is exactly the defect
  Code Review `8e84a403` removed (a halted recycle's predecessor permanently fails that check while still
  being the real live owner). Key a future predecessor-skip on `isSupersededByRecycle`, never on
  `hasSuccessor` alone, and justify it in this record.

## Source

`packages/daemon/src/sessions/service.ts` — `SecondLiveManagerError`, `refuseSecondLiveManager`, and its
two call sites in `startNew`/`startManager`. `packages/daemon/src/db.ts` —
`countLiveSessionsForAgent` widened to also count `'starting'` (the agent-delete guard). Tests:
`packages/daemon/test/second-live-manager-refusal.mjs`,
`packages/daemon/test/gateway-second-live-manager-refusal.mjs`,
`packages/daemon/test/scheduler-second-live-manager-refusal.mjs`, and the new case in
`packages/daemon/test/mgmt-project-agent.mjs` (section D).
