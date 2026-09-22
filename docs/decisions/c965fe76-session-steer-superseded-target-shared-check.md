# c965fe76 — a live-but-superseded session-control target is resolved via a REQUIRED per-tool policy

## Narrative

Found by a Code Reviewer (`1e53fe14`) while reviewing card `fb5e39c3`'s branch: the companion
`session-steer` ACT lever's four tools (`session_message`, `session_steer`, `session_stop`,
`session_resume`) all resolve their target through `resolveControlTarget`
(`companion/capabilities.ts`), the lever's own documented "one enforcement point" — but a recycling
predecessor stays `processState:"live"` until `settleRecycleHandoff` resolves asynchronously, seconds
later, so a caller-addressed `sessionId` can itself already be a live-but-superseded predecessor with a
live successor. Before this card, that state was invisible to three of the four tools, and
`session_steer` in particular would flush the predecessor's queued direction, enqueue a new instruction
into it, and interrupt a pty that is about to be hard-killed — worse than a message that simply fails to
land, since it destroys queued work and races a kill.

`resolveControlTarget` now takes a REQUIRED second parameter, `onSuperseded: SupersededPolicy`
(`"disclose" | "handled-downstream" | "benign"`), instead of a first cut that computed the predicate
centrally but left enforcement OPT-IN via an optional output field. The opt-in shape failed DoD-1's own
"a fifth tool must inherit it for free": a fifth tool's handler, written in the idiomatic three-line shape
every existing handler uses, would silently compile while ignoring an unread optional field and proceed
against a superseded target — exactly the `session_steer` bug this card removes. A required parameter
forces the choice at the call site; a fifth tool cannot compile without naming its policy.

Per-tool policy, and why:

- `session_message` / `session_steer` → `"disclose"` — decline to act, return `{disclosed, replacedBy}`
  instead of silently touching (or, for `session_steer`, flushing-and-interrupting) a session about to be
  hard-killed. Chosen over silently redirecting to the successor because that would change who receives an
  instruction the caller explicitly addressed, which is its own surprise; disclosure leaves the decision
  where the knowledge is. `session_steer`'s choice between disclose and a hard refusal (mirroring
  `session_resume`) was the card's open design question — disclosure was picked for symmetry with
  `session_message` and because both are "send an instruction" actions (unlike `session_resume`, which is
  fundamentally about a specific session identity and has nothing sensible to do with a superseded one).
- `session_resume` → `"handled-downstream"` — **but NOT because `SessionService.resume`'s `hasSuccessor`
  check (card `5a56bb0a` et al., `service.ts:3075`) is the real gate for this tool.** An earlier version of
  this record claimed exactly that, and it is FALSE in this window: `resume()`'s own already-live
  short-circuit (`service.ts:3054`) fires 21 lines BEFORE the `hasSuccessor` refusal, and it DOES trigger
  here — the live-but-superseded predecessor's pty is alive by definition, that is what the window IS — so
  `:3075` is unreachable and `resume()` returns the predecessor's `Session` row as a plain SUCCESS
  (Code Reviewer `d2440f9e`, measured with a probe; confirmed at source independently). The `:3075` refusal
  is real and correct, but only for a LATER state than this policy is about: an already-EXITED recycled
  predecessor (`processState !== "live"`), which never reaches this branch at all since `onSuperseded` is
  only consulted while `target.processState === "live"`. The HONEST reason `"handled-downstream"` is still
  the right policy: resuming an already-live session, superseded or not, is a structural no-op for this
  tool — there is nothing to spawn and nothing for this lever to intercept or disclose, so the
  short-circuit's plain pass-through is correct as is; there is no second gate to defer to, only an absence
  of anything to gate.
- `session_stop` → `"benign"` — but NOT because stopping a live-but-superseded predecessor is "harmless
  either way". For a MANAGER/PLATFORM predecessor, `recoverFleetAfterFailedRecycleSuccessor` (`service.ts`)
  checks `pty.isAlive(oldId)` FIRST when its successor dies before settling — stopping the predecessor in
  this exact window can turn a recoverable failure into an unresolved one (`recycle_fleet_unresolved`)
  instead of a fleet handoff back to the predecessor, rather than being consequence-free. The policy is
  still right: the handoff already anticipates "a human stopped the predecessor" as a real case it must
  survive, and an owner-authored companion stop is the same act — this is an accepted trade-off (the
  recovery fallback pays for it), not a no-op.

## Composing with `fb5e39c3`, not colliding with it

`fb5e39c3` (landed as `aafea7d2`, merged while this card's branch was still forward-merging) added an
equivalent check ONE LAYER DOWN, inside `SessionService.deliverSessionMessage`'s own `"live"` branch —
reached by BOTH the Platform Lead's `messageSessionAsPlatform` and the companion's own
`messageSessionAsCompanion`. Since `resolveControlTarget` runs BEFORE `ctx.sessions.messageSession` for
every companion call, and `messageSessionAsCompanion` has exactly one production caller (that same
companion `session_message` handler), `resolveControlTarget`'s `"disclose"` branch now intercepts first
on the companion path — `deliverSessionMessage`'s own `fb5e39c3` check never reaches its `session_message`
branch there. The two checks are NOT redundant: `deliverSessionMessage`'s check is still the ONLY gate on
the Platform Lead's path, which does not route through `resolveControlTarget` at all.

Composing correctly meant preserving `fb5e39c3`'s audit side effect, not just its return shape:
`resolveControlTarget`'s companion-layer disclosure path (`recordSupersededEvent` in
`companion/capabilities.ts`) appends the SAME `kind:"session_message"` / `detail:{replacedBy}` event
`deliverSessionMessage`'s own `fb5e39c3` branch would have appended for `session_message` specifically —
so the audit trail is identical regardless of which layer actually catches the supersession, for that one
tool. `session_steer` does NOT mirror the same kind, even though a genuinely-DELIVERED companion steer
already files `kind:"redirect_worker"` (`deliverRedirect`): `redirect_worker` is a member of
`REPORT_RESOLVED_EVENT_KINDS` (`orchestration/report-resolution.ts`) — a query that finds ANY
`redirect_worker` event after a worker/manager's last report treats that report as resolved, regardless of
the event's own `detail`. Filing `redirect_worker` for a DROPPED steer (nothing delivered) would falsely
mark a target's still-open report as resolved — a real correctness bug the manager's own suggested reuse
of `redirect_worker` did not account for, caught by checking `REPORT_RESOLVED_EVENT_KINDS`'s consumer
(`deriveAwaitingReview`) at source rather than adopting the suggestion as given. Fixed with a dedicated
`"session_steer_dropped"` `OrchestrationEventKind` (`@loom/shared` `types.ts`), deliberately excluded from
`EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/`ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` —
same posture as the existing `codex_auto_commit` precedent for "an audit-only marker, never a lifecycle
signal any of those four should track."

Verified NOT at risk: `fb5e39c3`'s own test
(`test/session-message-live-successor-disclosure.mjs`) drives `SessionService.messageSessionAsPlatform`/
`messageSessionAsCompanion` DIRECTLY, never through the companion MCP tool — it never touches
`resolveControlTarget` and is unaffected by this card's interception.

## Cross-tool discriminator

`session_message`'s and `session_steer`'s success shapes never carry a `replacedBy` field; their
superseded-decline shapes always do. `"replacedBy" in result` is therefore a uniform way to detect the
decline case across both tools without branching on `deliveryStatus`/`dropped` separately — stated in both
tool descriptions rather than unifying the two (differently-shaped) success responses themselves.

## Do not

- Do not make `onSuperseded` optional on `resolveControlTarget` — it must be a REQUIRED parameter so a
  fifth tool cannot compile without naming its policy.
- Do not add a new refusal branch to `session_resume`'s handler for this, and do not claim its existing
  behavior is a "refusal" in this window — `SessionService.resume`'s `hasSuccessor` check is UNREACHABLE
  while the predecessor is still `live` (its own earlier short-circuit fires first); `resume()` returns the
  predecessor row as a plain success there. `"handled-downstream"` is still the right policy, for the
  honest reason above (a structural no-op, not a deferred gate) — do not re-install the false "deeper
  refusal" justification a Code Review round caught here.
- Do not describe `session_stop`'s `"benign"` policy as harmless/consequence-free — it is an accepted
  trade-off against the recovery fallback (see the per-tool policy section above), not a no-op.
- Do not silently redirect `session_message`/`session_steer` to the successor on a superseded target —
  disclose the successor id and decline to act; a silent reroute changes who receives an instruction the
  caller explicitly addressed.
- Do not let `session_steer` flush the predecessor's queue or interrupt its pty when the target is
  superseded — that is the exact defect this card fixes.
- Do not drop the companion-layer `recordSupersededEvent` audit call as "redundant" with `fb5e39c3`'s own
  `deliverSessionMessage` check — on the companion path, `resolveControlTarget` intercepts FIRST, so
  `deliverSessionMessage`'s own audit branch never fires there; removing this would silently lose the
  audit trail for every companion-originated disclosure.
- Do not file a dropped `session_steer`'s audit event under `kind:"redirect_worker"` — it is a member of
  `REPORT_RESOLVED_EVENT_KINDS`, so doing so would falsely mark the target's still-open report as
  resolved even though nothing was delivered. Use `"session_steer_dropped"`.

## Source

Inline comments in `packages/daemon/src/companion/capabilities.ts` (`resolveControlTarget`'s own doc and
`recordSupersededEvent`'s doc), as of this card's branch. Board card `c965fe76`, filed by lead `gen 362`
off Code Reviewer `1e53fe14`'s finding on card `fb5e39c3`'s branch. Required-parameter redesign requested
by the manager after reviewing the first (optional-field) cut.
