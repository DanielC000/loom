# 5c2f8108 — a Platform Lead's own dropped kickoff gets the same treatment, plus a "cleared" counterpart for both

## Narrative

From Code Review `5f95e7a1` (review of `ab3c965d`): that card gave a MANAGER's exhausted turn-1 kickoff
a durable `manager_kickoff_dropped` event + owner alert + Platform-Lead escalation, but deliberately
scoped itself to `role === "manager"` only (see `ab3c965d`'s own "Do not" — "the Platform Lead's own
equivalent gap is a separate, not-yet-built card (`5c2f8108`)"). A Platform Lead (role `"platform"`) has
no Lead above it either — it IS the top of the parentless-session chain — so its own dropped kickoff
still fell into `handleKickoffGiveUpExhausted`'s generic console-only bail, the exact silent gap
`ab3c965d` closed for managers.

The same review's second finding: the web attention item for a dropped kickoff (`latestManagerKickoffDropped`
in `lib/attention.ts`) had no "cleared" counterpart at all — it relied entirely on the filing session
eventually exiting (`allEvents` scoped to live managers only) to stop surfacing, so it stayed visible for
the life of a still-live session even after a late confirmation (or a manual recovery) proved the kickoff
had actually landed.

**Round 2 (Code Review `ba4d1e14`, NOT MERGEABLE) found round 1's own resolve half wrong on two fronts.** BLOCKING: the new `kickoffDroppedEventsQuery` (added to `useAttention` for the web surface above) was never added to that function's `loaded`/`resolved` query gates (@decision `611e76ba`/`3157a563`) — missing from `loaded` let `pruneDismissed` wipe a user's `mkd:` dismiss on an ordinary page reload (it ran before this query had a chance to resolve); missing from `resolved` let the new-item detector re-fire a browser notification/toast for a still-active alert on every load. DECISION: round 1 resolved the alert on `sessionId`'s own first COMPLETED turn (any source) — an IdleWatcher nudge, a boot continuation note, ordinary chat with the Lead, or even a StopFailure can all complete a turn with the dropped kickoff's own brief never having landed, so "turn-1 completed" was never actually proof of *this* drop's delivery. See "The fix" below for what round 2 replaced it with.

## The fix

**Widened `handleKickoffGiveUpExhausted`'s manager carve-out to `role === "manager" || role === "platform"`.**
Every step is shared verbatim between the two roles — the `lateConfirmation()` suppression,
`withinKickoffConfirmWindow`'s defer-and-recheck via the same `armKickoffConfirmRecheck` mechanism
(decision `8882e2ca`'s "one timer mechanism" rule) — except the terminal action:
`handleManagerKickoffDropped` now takes an explicit `role: "manager" | "platform"` parameter and gates
the Platform-Lead escalation (`notifyLeadOfDroppedManagerKickoff`) on `role === "manager"` only. For
`role === "platform"`, `leadNotified` is always `false` and no board task is ever filed — there is no
higher Lead session to escalate a Lead's own drop to (the one case `notifyLeadOfParentlessManagerIssue`
exists to reach, and the one case it cannot reach *itself* through). The durable
`manager_kickoff_dropped` event and the owner-attention alert (gated on `parentNudged === false`, which
neither role ever sets to anything else) still fire unconditionally for both roles — never either/or, the
same discipline `ab3c965d` established.

**Added the RESOLVE half: `manager_kickoff_dropped_resolved`.** A new `SessionService.handleKickoffDroppedResolved(sessionId, confirmedRootMsgId)` appends the resolve event when BOTH hold: the latest `manager_kickoff_dropped`/`manager_kickoff_dropped_resolved` row for that session's `workerSessionId` is an unpaired drop, AND that drop's own recorded `detail.rootMsgId` exactly matches `confirmedRootMsgId` — a mismatch, or no unpaired drop at all, is a silent no-op. The method is idempotent (a repeat matching call once already resolved appends nothing).

**Round 2 replaced round 1's trigger (`onTurnCompleted`'s bare first-completed-turn signal, removed — see "Do not" below) with a proven delivery signal: `SessionService.handleGiveUpConfirmed(sessionId, logicalId, latencyMs)`** — the SAME method `PtyHostEvents.onGiveUpConfirmed` already calls on every late content-match confirmation, for every role, independent of this card. `logicalId` is reused as `rootMsgId` across every re-mint of a kickoff chain (decision `7772176d`), so an exact match against the dropped kickoff's own recorded `rootMsgId` is proof that THIS kickoff's content specifically landed, not some unrelated later turn. `handleKickoffDroppedResolved` is called unconditionally at the TOP of `handleGiveUpConfirmed`, BEFORE its own `session_message_gave_up`("parked") lookup — the manager/platform kickoff-drop branch (`handleManagerKickoffDropped`) never records a "parked" row (only the generic worker park branch does, per decision `00bd3b4a`), so gating the call on that lookup's own result would make a dropped kickoff's late confirmation unreachable here.

**Web surface (`lib/attention.ts`/`lib/fleet.ts`): moved off the per-manager fan-out onto a dedicated
cross-session, kind-filtered query**, mirroring `bootStuckEventsQuery`'s own shape (decision `43084723`).
The OLD `latestManagerKickoffDropped` map was built from `allEvents`, itself scoped to the `managers`
array (`role === "manager" && processState === "live"`) — a Platform Lead session is never a member of
that fan-out at all, so its own dropped-kickoff event could never have reached this surface no matter how
`manager_kickoff_dropped`'s own gating was widened. The new `activeKickoffDroppedAlerts` helper
(`lib/fleet.ts`, unit-tested in `packages/web/test/fleet.mjs`) is a direct structural twin of
`activeBootStuckAlerts` — latest-event-wins per session id, a resolved pairing clears it, a no-longer-live
session is dropped. `companion/attention-push.ts`'s `alertLine()`/the web render loop both now read
`detail.role` to phrase the line correctly ("manager's" vs "Platform Lead's") instead of hardcoding
"manager's".

**Round 2: `kickoffDroppedEventsQuery.data !== undefined` added to `loaded`, `!kickoffDroppedEventsQuery.isPending` added to `resolved`** (both in `useAttention`, `lib/attention.ts`) — see decisions `611e76ba`/`3157a563` for why these two gates exist and must stay separate expressions. A new source-scan guard, `packages/web/test/attention-query-gates.mjs`, asserts every `useQuery` bound inside `useAttention` is named in both gate expressions, so a future query added to the function and never wired into one or both gates fails the build instead of silently reproducing this exact defect.

## Round 3 (final pass before merge)

Three stale comments still described round 1's bare-completed-turn resolve trigger as current behavior
(`packages/shared/src/types.ts`, `packages/web/src/lib/attention.ts`, `packages/web/src/lib/fleet.ts`,
plus one test assertion message in `packages/web/test/fleet.mjs`) — fixed in place to describe round 2's
real trigger (`handleGiveUpConfirmed`'s content-match of the drop's own `rootMsgId`).

**`attention-query-gates.mjs`'s per-name scan had three blind spots**, found in re-review: a generic type
argument (`useQuery<T>(`), a line-wrapped declaration (`const x =\n  useQuery(`), and a destructured
binding (`const { data, isPending } = useQuery(`) could all slip past the scan's original
`const (\w+) = useQuery\(` regex, silently missing exactly the kind of query this card's own round 2 fix
was about. Widened to a regex that matches all three declaration shapes plus a second regex/alias
resolver for the destructured case, and switched both gate-membership checks from a bare `.includes()` to
a word-boundary regex test (`hasToken`) so a token can't false-positive as a substring of an unrelated,
longer identifier. Proved against the REAL file (not a synthetic fixture): temporarily changed `sessions`
to `useQuery<unknown>(` and dropped it from both `loaded`/`resolved`, confirmed the guard went RED naming
exactly `sessions`, then reverted.

**A manual recovery, or a daemon restart between the drop and a late confirmation, does NOT auto-clear
this alert — by design.** `manager_kickoff_dropped_resolved` only fires from `handleGiveUpConfirmed`'s own
content-match of the ORIGINAL drop's `rootMsgId` — re-sending the brief as a brand-new message mints a
new `rootMsgId` with no record of the old drop to pair against, and a daemon restart doesn't retroactively
confirm anything either. The web attention item text and the Platform-Lead board task body now both say
so explicitly, so the owner/Lead dismiss the alert manually after a manual recovery rather than waiting
for it to clear on its own.

## Round 4 — pointer only

The restart-survival gap this record's own Narrative names ("the Platform Lead has no Lead above it
either") turned out to apply to the DEFERRAL window too, not just the drop itself: a Lead's kickoff still
within `withinKickoffConfirmWindow` at exhaustion wrote nothing durable before a restart, same as a
manager's. Fixed on card `ab3c965d`'s own record (its "Round 4" section) — covers both roles identically,
since `handleKickoffGiveUpExhausted`'s `pending` branch and `escalateDeferredManagerKickoffAtBoot` are
shared code, keyed on `w.role` only at the points that differ (Lead-escalation skipped for `"platform"`).
Not restated here — read it there.

## Round 5 — pointer only

A Code Review of Round 4 (full narrative on `ab3c965d`'s own record, its "Round 5" section; also card
`3d72900f`'s own "Round 5" section, which documents the busy-capture correction this review's own first
fix attempt needed) found the boot-consumer wiring missed `recoverCrashOrphanedWorkers` entirely — the
path a Platform Lead's own end-user install
actually boots through on an ordinary crash/service restart, since the Lead is never resumed via a
self-host `daemon_restart`'s `RestartIntent` on a fresh/first-run install. That gap, and every other
round-5 fix (the vacuous-proof fix, the dead try/catch fix, the reverted `isLiveAndPreBoot` removal), is
shared code with the manager path and applies to the Lead identically — not restated here.

## Do not

- Do not call `handleManagerKickoffDropped` without passing the caller's own, already-verified role — the
  method has no way to re-derive it, and a wrong role silently either escalates a Lead's drop to a
  (nonexistent) higher Lead, or skips a manager's real escalation.
- Do not extend `handleKickoffDroppedResolved` to key off `claude_boot_dialog_resolved`'s own "first hook
  observed" signal — a dropped-kickoff alert is about turn-1 never *starting*, and a hook can fire (e.g. a
  non-SessionStart PreToolUse) without a turn ever completing.
- **Round 2, superseding round 1's bullet of the same shape:** do not resolve `manager_kickoff_dropped` on
  a bare completed-turn signal (round 1's `onTurnCompleted`/`wasFirstTurn` wiring, removed) — an
  IdleWatcher nudge, a boot continuation note, ordinary chat with the Lead, or a StopFailure can all
  complete a turn without the dropped kickoff's own brief ever landing. Resolve ONLY via
  `handleGiveUpConfirmed`'s proven content-match confirmation of that kickoff's own `rootMsgId`.
- Do not make `handleKickoffDroppedResolved`'s `confirmedRootMsgId` parameter optional, or call it without
  one — a caller with no rootMsgId to match has no basis to resolve this specific alert, and an optional
  param invites a future caller to skip the check the way round 1 did.
- Do not re-add a per-manager/per-role fan-out for `manager_kickoff_dropped`/`_resolved` in
  `lib/attention.ts` — decision `43084723`'s rule applies here too: a Platform Lead is never a member of
  the `role === "manager"` `managers` array, so any fan-out keyed off it can never reach that role's own
  event. Fetch both kinds with ONE cross-session, kind-filtered query instead.
- Do not hardcode "manager's" (or any other role-specific wording) in `alertLine()`'s or the web render
  loop's `manager_kickoff_dropped` text — read `detail.role` and phrase accordingly, the same discipline
  `claude_boot_dialog_stuck`'s own `roleLabel` already uses.
- Do not add a kind to `DURABLE_AUDIT_EVENT_KINDS` (as this card did, for `manager_kickoff_dropped_resolved`)
  without also updating decision `9f7f2b50`'s own classification list — see that record's own "Do not".
- Do not add a new `useQuery` to `useAttention` (`lib/attention.ts`) without adding it to BOTH `loaded`
  and `resolved` in the same change — run `packages/web/test/attention-query-gates.mjs` to catch it
  before the merge gate does.
- Do not build a mechanism that auto-clears `manager_kickoff_dropped` on a manual recovery (a human
  resending the brief, or a daemon restart) — there is no reliable signal to key it on: a resend mints a
  new `rootMsgId` with nothing to pair against the old drop, and a restart confirms nothing on its own.
  The alert and Lead-task text say so explicitly; keep that wording in sync if the resolve mechanism ever
  changes.

## Source

`packages/daemon/src/sessions/service.ts` (`handleKickoffGiveUpExhausted`'s widened manager/platform
carve-out, `handleManagerKickoffDropped`'s `role` parameter, `handleKickoffDroppedResolved`'s
`confirmedRootMsgId` match, `handleGiveUpConfirmed`'s call to it), `packages/daemon/src/index.ts`
(`onGiveUpConfirmed`'s doc), `packages/shared/src/types.ts` (`manager_kickoff_dropped_resolved` kind +
`ORCHESTRATION_EVENT_KIND_MEMBERSHIP`), `packages/daemon/src/db.ts` (`DURABLE_AUDIT_EVENT_KINDS`),
`packages/daemon/src/companion/attention-push.ts` (`classify()`'s new `manager_kickoff_dropped_resolved`
case, `alertLine()`'s role-aware wording), `packages/web/src/lib/fleet.ts` (`activeKickoffDroppedAlerts`),
`packages/web/src/lib/attention.ts` (`kickoffDroppedEventsQuery` + its `loaded`/`resolved` wiring + render
loop). Tests: `packages/daemon/test/manager-kickoff-giveup-dropped.mjs` (scenarios (L)-(T)),
`packages/daemon/test/companion-attention-push.mjs`, `packages/web/test/fleet.mjs`,
`packages/web/test/attention-query-gates.mjs`.
