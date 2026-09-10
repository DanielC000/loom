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

## ContextWatcher's own trigger conditions and de-dup (`checkEmergencyOccupancy`)

The ordinary ratio logic only ever QUEUES a nudge (busy-gated, landing at the manager's next turn
boundary) — which never arrives for a manager stuck in one long turn. The SECOND, harder
`emergencyRecycleAtContextRatio` floor (validated ≥ the ordinary ratio at resolve time, `config.ts`)
bypasses the queue entirely and fires this interrupt instead.

Fires AT MOST once per still-current `ctxInputTokens` reading, re-arming at the manager's NEXT Stop (a
genuinely fresh reading, possibly still over the floor — correctly re-fires) or on recycle (a brand-new
session id) — mirrors `checkBlindTurn`'s own
episode-boundary pattern, one field over (`ctxUpdatedAt` here vs. `lastActivity` there). A refusal (no
hook wired, session died, or the merge-danger window above) does NOT advance this de-dup state — only
a FIRED interrupt does — so the very next tick's retry (see the MERGE-DANGER GUARD bullet above) starts
from the same untried state, never a false success.

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
