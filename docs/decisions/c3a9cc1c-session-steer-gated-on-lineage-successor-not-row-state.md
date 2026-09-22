# c3a9cc1c — `session_steer` declines on ANY live recycle successor, never just the row's `processState`

## Narrative

Found by a Code Reviewer (`d2440f9e`) during the pre-merge review of `c965fe76` (`resolveControlTarget`'s
shared per-tool `onSuperseded` policy), and independently re-verified at source before filing. `c965fe76`'s
`"disclose"` policy only intercepts a superseded target while `target.processState === "live"` — correct
for `recycleManager` (whose predecessor row is never touched until `settleRecycleHandoff` closes it,
seconds later) but wrong for two other cases:

1. **`recyclePlatformLead`'s own atomic handoff** (`sessions/service.ts`) calls
   `db.setProcessState(old.id, "exited")` SYNCHRONOUSLY, BEFORE `insertRecycleSuccessor` ever runs — the
   row reads `"exited"` while the real pty is still alive and interruptible (not stopped until
   `settleRecycleHandoff` resolves). `onSuperseded === "disclose"`'s row-state gate never fires here, so
   `session_steer` fell through to `ctx.sessions.redirectSession`, which flushed the predecessor's queued
   direction, enqueued a new instruction into it, and interrupted a pty about to be hard-killed — the exact
   defect `c965fe76` exists to remove, just reached through a second, un-gated door.
2. **The general case**: any session whose row already reads fully `"exited"` (long past the handoff
   window) but still has a live successor somewhere in its recycle lineage. Addressing it directly with
   `session_steer` hit the same fall-through: `deliverRedirect` enqueues the new instruction as a durable
   `session_message_queued` record onto the dead session's own id — never delivered (nothing is listening),
   and never reaching the live successor that actually owns the work. `session_message`'s own downstream
   method (`deliverSessionMessage`, `@decision 5519559c`) already handles this NOT-live case by
   auto-routing forward to `liveLineageSuccessor(db, sessionId)`; `session_steer`'s downstream
   (`deliverRedirect`) has no successor-awareness at all.

## Fix site chosen: a steer-side predicate, not `recyclePlatformLead`'s ordering

DoD-5 named two candidate fixes and left the choice open: (a) key the steer-side predicate on whether a
live successor exists, regardless of row state, or (b) change `recyclePlatformLead`'s
`setProcessState(old,"exited")`-before-`insertRecycleSuccessor` ordering so it stops lying about
predecessor state (mirroring `recycleManager`, which never touches the predecessor's row at all in this
window).

**(a) was chosen.** `recyclePlatformLead`'s ordering is itself a DELIBERATE, documented invariant
(`@decision sha:1d974864`): retiring the predecessor before inserting + flipping the successor live is a
synchronous, no-`await` sequence specifically so "no concurrent watcher tick can interleave to observe BOTH
rows of this lineage live at once (the crash-recovery/superseded checks key off this)" — its own doc names
this as load-bearing for per-lineage atomicity now that multiple Platform Leads can coexist. Reordering it
to match `recycleManager` would reopen that exact double-live window for every Platform Lead recycle, for
the sake of fixing a bug that (b) doesn't even require touching it — a steer-side fix that never looks at
`old`'s own row state closes both windows without touching `recyclePlatformLead` at all, and needs no new
proof that `@decision 08c81809`'s settle-in-flight marker still works, since nothing about the settle
machinery changes.

## The fix

`resolveControlTarget` gains a second, `session_steer`-only policy, `"disclose-any-live-successor"`,
alongside message's unchanged `"disclose"`:

- `session_message` keeps `"disclose"` — untouched, still row-state-gated. Its NOT-live case is (and
  remains) handled entirely downstream, in `SessionService.deliverSessionMessage`'s own
  `liveLineageSuccessor` branch (`@decision 5519559c`) — `resolveControlTarget` must never intercept that
  case for message, or it would silently defeat the auto-route-forward that decision deliberately built.
- `session_steer` switches to `"disclose-any-live-successor"`: `target.processState === "live"` still uses
  the one-hop `db.getSuccessor(target.id)` (the ONLY correct check in that window — both predecessor and
  successor can read `"live"` simultaneously during `recycleManager`'s handoff, so a lineage walk starting
  at a live target would short-circuit on the target itself and never see past it); any other row state
  uses `liveLineageSuccessor(db, target.id)`, which walks the `recycledFrom` chain forward to the live end —
  the SAME helper `deliverSessionMessage`'s NOT-live branch already uses, reused here for a different
  purpose (decline, not route).

## DoD-3: decline, never route forward

`session_steer` at a NOT-live target with a live successor DISCLOSES (`{dropped:true, replacedBy}`) and
declines to act — it does NOT auto-route the redirect to the successor the way `session_message` does.
`@decision c965fe76` already settled this for the live-row case ("do not silently redirect
`session_message`/`session_steer` to the successor on a superseded target... a silent reroute changes who
receives an instruction the caller explicitly addressed") and the same reasoning applies more strongly
here: `session_steer` is an INTERRUPT action, not a passive message drop — silently flushing and
interrupting a session the caller never named (the successor) is a bigger surprise than silently queuing a
message there would be. Symmetry with the tool's own existing live-superseded behavior, and with
`@decision c965fe76`'s stated rule, both point the same way.

## Do not

- Do not gate `session_steer`'s superseded check on `target.processState === "live"` — that is the exact
  defect this card fixes; it misses both `recyclePlatformLead`'s exited-during-settle window and any
  already-fully-exited target with a live successor.
- Do not widen `session_message`'s `"disclose"` policy to also run the lineage walk — its NOT-live routing
  is `deliverSessionMessage`'s job (`@decision 5519559c`); doing it in `resolveControlTarget` too would run
  it TWICE with different outcomes (decline vs. route) and the decline would win, silently defeating
  message's auto-route-forward.
- Do not call `liveLineageSuccessor(db, target.id)` while `target.processState === "live"` — it returns
  `target` itself as soon as it observes a live row, so it can never see past a target that is itself still
  live (the `recycleManager` live-row handoff window, where both predecessor and successor read `"live"`
  at once). Use `db.getSuccessor(target.id)` for that window instead.
- Do not reorder `recyclePlatformLead`'s `setProcessState(old.id,"exited")`-before-`insertRecycleSuccessor`
  sequence to "fix this at the source" — that ordering is a deliberate per-lineage atomicity guarantee
  (`@decision sha:1d974864`) that other code (crash-recovery/superseded checks) depends on; this card's fix
  does not require touching it.
- Do not let `session_steer` auto-route to the successor on a NOT-live-with-successor target — decline
  (disclose + `replacedBy`), mirroring the existing live-superseded behavior; see the DoD-3 section above.

## Source

`packages/daemon/src/companion/capabilities.ts` (`resolveControlTarget`'s `SupersededPolicy` type, the new
`"disclose-any-live-successor"` branch, and `session_steer`'s call site), as of this card's branch. Board
card `c3a9cc1c`, filed by lead `gen 363` off Code Reviewer `d2440f9e`'s finding during the pre-merge review
of card `c965fe76`.
