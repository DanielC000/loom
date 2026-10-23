# ab3c965d — a MANAGER's dropped kickoff gets its own durable record + Platform-Lead/owner-attention notification, never a re-mint

## Narrative

Card ab3c965d: when a MANAGER session's turn-1 kickoff exhausted its give-up requeue budget,
`handleKickoffGiveUpExhausted` (`sessions/service.ts`) used to bail out through the same early-return
guard as every other excluded case (`!w || (w.role !== "worker" && w.role !== null) || !w.parentSessionId`)
with only a `console.error` — no durable event, no notification anywhere. A worker's kickoff, by
contrast, already got bounded re-mint + park + a sender notice (card 7772176d).

Investigated at source (not assumed): the documented reason managers are excluded (decision `a8f8a8f2`,
"Do not" #1) is specifically about the NOTIFY step lacking a natural recipient for a top-level session
("there is no single natural recipient; leave it to the generic idle-watchdog + console.error") — not a
finding that the RE-MINT mechanism itself would duplicate for a manager. The two concerns (re-mint
eligibility, notify eligibility) were simply bundled into one guard for implementation simplicity.
`requeueGiveUpOrigin` (`pty/host.ts`), the generic, role-agnostic FIRST-tier remint, already fires once
for a manager's kickoff before `handleKickoffGiveUpExhausted` is ever reached — so a manager's kickoff
already gets one safety-net attempt; what was missing is purely the second-tier (SessionService) record
+ notify on the eventual drop.

This card deliberately does NOT extend re-mint to managers — only the record/notify gap, which is what
the card's own DoD requires. Extending re-mint would need its own proof that the duplicate-protection
chain (composerOwnerLineage, logicalId reuse) behaves identically for a manager-role PTY, which was not
established here.

The fix mirrors `handleClaudeBootDialogStuck`'s own parentless-manager resolution (card `e2a3c613`)
exactly, rather than inventing a new mechanism: a durable `manager_kickoff_dropped` event
(`parentNudged:false`, always, since a manager never has a parent) plus a best-effort Platform-Lead
escalation via a newly-generalized `notifyLeadOfParentlessManagerIssue` helper (extracted from the
single-purpose `notifyLeadOfStuckManager`) — never either/or. `companion/attention-push.ts`'s `classify()`
gates `manager_kickoff_dropped` into the owner-attention surfaces on the same `parentNudged === false`
condition `claude_boot_dialog_stuck` already uses.

Deliberately no self-nudge into the dropped session itself: its first turn never started (the caller
confirms this is a genuine drop, not a late confirmation, via `hasFirstTurnStarted`/`transcriptNonEmpty`
— see round 2 below), so there is nothing live to read a notice typed into its own composer, and reusing
the same delivery mechanism that just failed for the kickoff buys nothing.

## Round 2 (Code Review 5f95e7a1, BLOCKING)

Round 1 shipped the manager carve-out (`w?.role === "manager"`) in `handleKickoffGiveUpExhausted` BEFORE
the generic path's own late-confirmation guard (`hasFirstTurnStarted(sessionId) || transcriptNonEmpty`,
a few lines lower) — so the Narrative's own claim above ("the caller already confirmed this is a genuine
drop") was false as shipped: a manager whose kickoff actually landed but confirmed late still took the
manager branch unconditionally and got the full drop treatment (durable event, owner-attention push, web
KICKOFF DROPPED alert, Platform board task, a Lead nudge telling it to recover its brief and resend) — a
duplicated-work hazard. Project memory `5748425f-kickoff-remint-two-mechanisms`'s specimen `a38a6b47` is
exactly this shape: the requeue landed 7.5s before the final give-up fired.

Fixed by hoisting the SAME discriminator (`lateConfirmation = hasFirstTurnStarted(sessionId) ||
transcriptNonEmpty`) above both branches, computed once and consulted by both: the manager branch now
checks it before calling `handleManagerKickoffDropped` (suppressing with a log line, mirroring the
worker path's own suppression wording, when true) and the worker path is otherwise byte-identical to
round 1. `handleManagerKickoffDropped`'s own doc now states this as a precondition the CALLER enforces,
not something the method can verify on its own.

## Do not

- Do not re-mint a manager's kickoff inside `handleKickoffGiveUpExhausted` without first proving the
  duplicate-protection chain (composerOwnerLineage, logicalId reuse via `requeueGiveUpOrigin`) behaves
  identically for a manager-role PTY — this card deliberately left that unestablished and scoped itself to
  the record/notify gap only.
- Do not add a second near-duplicate of `notifyLeadOfParentlessManagerIssue` for a future parentless-
  manager episode kind — add a `dedupEventKind`-parameterized thin caller instead, the same way
  `notifyLeadOfStuckManager`/`notifyLeadOfDroppedManagerKickoff` both now are.
- Do not enqueue a nudge into the dropped manager session itself — its first turn never started, so
  nothing is live to read it (same self-nudge hazard `01160ae3` already guards against for a stuck boot
  dialog, for a different underlying reason here: there is no live turn to interrupt, only an idle one to
  write into for no benefit).
- Do not gate `manager_kickoff_dropped` into the owner-attention surfaces (`companion/attention-push.ts`'s
  `classify()`, `web/src/lib/attention.ts`) unconditionally — gate on `detail.parentNudged === false`,
  mirroring `claude_boot_dialog_stuck`'s own gate exactly (a manager always sets this `false`, so the
  practical effect is "always", but the field is what a reader should check, not the role). Enforced at
  TWO distinct sites, round 2: `companion/attention-push.ts`'s `classify()` switch (already correct, round
  1) and `web/src/lib/attention.ts`'s `latestManagerKickoffDropped` map build (round 1 built the map from
  every matching event unconditionally, with no `parentNudged` check at all — round 2 added it).
- Do not let a role-scoped carve-out (the manager branch in `handleKickoffGiveUpExhausted`) skip a
  generic-path safety check just because it returns earlier in the function — round 1's manager branch ran
  BEFORE the late-confirmation guard the generic/worker path uses a few lines later, so the two silently
  diverged on a precondition the Narrative claimed was shared. Compute a shared discriminator once, above
  every branch that needs it, when two branches must agree on the same check.
- Do not describe this feature's scope as "manager/platform-lead" in a comment — only `role === "manager"`
  is carved out here (and in `handleClaudeBootDialogStuck`'s own Lead-notify call). The Platform Lead's own
  equivalent gap is a separate, not-yet-built card (`5c2f8108`).

## Source

`packages/daemon/src/sessions/service.ts` (`handleKickoffGiveUpExhausted`'s manager carve-out +
hoisted `lateConfirmation`, `handleManagerKickoffDropped`, `notifyLeadOfParentlessManagerIssue`/
`notifyLeadOfStuckManager`/`notifyLeadOfDroppedManagerKickoff`), `packages/shared/src/types.ts`
(`manager_kickoff_dropped` kind + `ORCHESTRATION_EVENT_KIND_MEMBERSHIP`), `packages/shared/src/config.ts`
(`BROWSER_NOTIFICATION_KINDS`), `packages/daemon/src/db.ts` (`DURABLE_AUDIT_EVENT_KINDS`),
`packages/daemon/src/companion/attention-push.ts` (`classify()`'s switch case + `alertLine()`'s own
`manager_kickoff_dropped` case, round 2), `packages/web/src/lib/attention.ts` (`BROWSER_NOTIFICATION_LABELS`,
the `latestManagerKickoffDropped` map's `parentNudged` filter (round 2), and the render item). Tests:
`packages/daemon/test/manager-kickoff-giveup-dropped.mjs`,
`packages/daemon/test/kickoff-giveup-exhausted.mjs`, `packages/daemon/test/companion-attention-push.mjs`.
