# 9f279c7b — ContextWatcher's emergency-recycle interrupt reuses `deliverRedirect`, narrows the queue-flush, and gates on merge-danger

## Narrative

Card 9f279c7b, Trigger A (see `ContextWatcher`'s own class doc for the full two-trigger design): the
daemon-internal emergency-recycle interrupt that fires when a manager's context is dangerously close to
its limit. Routed through the SAME `deliverRedirect` core `redirectWorker`/`redirectSessionAsCompanion`
use (durable enqueue, Esc-interrupt ONLY when held) — deliberately NOT a second interrupt implementation;
two interrupt paths that could disagree is exactly the failure
`docs/decisions/f05e5a06-daemon-restart-awaits-merge-danger-window-since-exit-emits-no-signal.md` is
about. Three things this wrapper does differently from its two siblings:

- `supersedeQueue: false` — the ONE caller of `deliverRedirect` that skips the flush step. Its siblings'
  targets are a WORKER or a companion-scoped session whose queue holds the CALLER's own prior direction —
  content a fresh redirect legitimately replaces. A MANAGER's queue instead holds INBOUND content from
  OTHER parties (a worker's `worker_report`, a `peer_message`, a platform `session_message`) that an
  unrelated emergency-recycle interrupt has no business discarding — purging the queue wholesale would
  silently drop work the successor genuinely needs. The redirect still lands (appended, not prepended) and
  the Esc-interrupt still fires on the held path; it just never touches whatever else was already queued.
- MERGE-DANGER GUARD: refuses (`fired:false, reason:"merge-danger-window"`) while the target's OWN
  project repo sits inside an active merge-danger window — the SAME `listActiveMergeDangerWindows`
  instrument `daemon_restart`'s own shutdown wait reads, filtered to just this ONE repo rather than
  daemon-wide (an unrelated project's in-flight squash has nothing to do with this manager). An Esc
  mid-squash can leave a canonical repo with staged, uncommitted residue that the NEXT merge refuses on
  until a human resolves it by hand — never worth risking for a nudge. Deliberately does NOT wait/poll
  here (unlike the bounded wait a full daemon shutdown uses): `ContextWatcher.tick()` re-runs every
  `contextWatchMs` regardless, and a real window is typically ~1.5s of local git calls, so a refusal here
  just means the very next tick tries again — logged plainly each time so a window that somehow never
  clears stays visible in the daemon log instead of being silently retried forever.
- BESPOKE TAG: frames the message under its own dedicated tag, not `frameFromManager`'s
  `[loom:from-manager]` shape — the target here IS the manager, there is no "from-manager" sender to
  name. The recycle-time successor-carry purge matches on this exact tag (and the ordinary recycle
  nudge's own prefix) to drop a still-queued copy narrowly, never a wholesale queue wipe.

Throws ONLY if the target session is unknown (mirrors `redirectSessionAsCompanion`).

## Do not

- Do not flush/supersede a manager's own pending queue when firing this interrupt — it holds inbound
  content from OTHER parties, not the caller's own prior direction; only the worker/companion redirect
  paths flush.
- Do not fire this interrupt while the target repo sits inside an active merge-danger window — an Esc
  mid-squash can leave staged, uncommitted residue the next merge refuses on until a human resolves it.
- Do not poll/wait for a merge-danger window to clear here — `ContextWatcher.tick()` already re-runs on
  its own interval, so a refusal just means the next tick retries; a bounded wait belongs to the
  full-shutdown path, not this one.
- Do not de-dup this interrupt's "already fired" check on `lastActivity`, `turnSeq`, or any other
  per-turn key — round 4 (see the round-4 section below) removed the re-arm key entirely. The interrupt
  fires AT MOST ONCE PER SESSION ID, full stop; a recycle (fresh session id) is the only re-arm.

## ContextWatcher's own trigger conditions and de-dup (`checkEmergencyOccupancy`)

The ordinary ratio logic only ever QUEUES a nudge (busy-gated, landing at the manager's next turn
boundary) — which never arrives for a manager stuck in one long turn. The SECOND, harder
`emergencyRecycleAtContextRatio` floor (validated ≥ the ordinary ratio at resolve time, `config.ts`)
bypasses the queue entirely and fires this interrupt instead.

@decision c5b234aa — **Round 4 (current): fires AT MOST ONCE PER SESSION ID, full stop — no re-arm key
at all.** `checkEmergencyOccupancy` checks only whether ANY `context_emergency_interrupt` event already
exists for this session id; if so, it never fires again for that id. A recycle mints a fresh session id,
which re-arms naturally. A refusal (no hook wired, session died, or the merge-danger window above) does
NOT record an event, so the very next tick's retry starts from the same untried state.

**Why no re-arm key survives:** three successive rounds each tried a different per-TURN re-arm key, and
each one reopened the same cascade from a different direction — the fire this interrupt causes is not
inert (it Esc-interrupts a live turn and its settle/drain mechanics touch `busy`/`lastActivity` without
ever completing a real turn), so any signal meant to distinguish "a genuinely new turn" from "the
wind-down this fire itself produced" kept finding a path back to false-positive re-arm:
- Round 1: per-`ctxInputTokens`-READING — broke the instant `MidTurnContextSampler` started bumping
  `ctxUpdatedAt` on every tick while busy; the reading-keyed check could never again find itself
  satisfied, so the interrupt re-fired on nearly every tick, including during its own wind-down turn.
- Round 2: switched to `lastActivity` — broken by the fire's OWN delivery mechanics:
  `interruptForRedirect`'s Esc → settle → `setBusy(false)`/`drainPending`/`setBusy(true)` stamps
  `last_activity` on both edges, pushing it past the fire's own `ts` on the very next tick even though no
  genuinely new turn started.
- Round 3: switched to `turnSeq` (a genuine completed-turn counter, bumped only by a real
  Stop/`onTurnCompleted`) — broken by either a real Stop landing inside the ~1.5s redirect-settle window,
  or a multi-turn wind-down whose first turn completes normally: either way `turnSeq` advances without a
  genuinely fresh emergency-worthy turn having started, re-arming the interrupt mid-wind-down.

Per the standing lesson that three review rounds each finding a NEW way the SAME heuristic breaks means
the fix is to shrink the heuristic's surface, not patch it a fourth time: round 4 removes the re-arm key
entirely rather than hunting for a fourth signal. The repeated-reminder job this would otherwise do is
already covered by the ordinary ratio nudge (cadence-limited, queued, never Esc), the `context_escalated`
escalation, and the blind-turn advisory — none of which need the emergency interrupt to repeat.

Trigger B (`checkBlindTurn`) deliberately does NOT escalate into this interrupt: it has no occupancy
number to justify cancelling a turn, and a real gen-235 specimen (a manager blind for a long window
doing perfectly ordinary, safe orchestration) is exactly the case an unconditional interrupt on
blind-turn-alone would wrongly cancel.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above the ContextWatcher emergency-recycle
interrupt method: lines 6754-6791, as of main `055e96ce`. Relocated by card `c7ca6c08` (tranche 16); no
wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers
stripped. Second site: JSDoc comments in `packages/daemon/src/orchestration/context-watcher.ts` (the
class doc's EMERGENCY INTERRUPT section and `checkEmergencyOccupancy`'s own method doc): lines 116-131
and 237-259, as of this tranche's HEAD (tranche 1 on `context-watcher.ts`).
