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
already confirmed this is a genuine drop, not a late confirmation via `hasFirstTurnStarted`/
`transcriptNonEmpty`), so there is nothing live to read a notice typed into its own composer, and reusing
the same delivery mechanism that just failed for the kickoff buys nothing.

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
  practical effect is "always", but the field is what a reader should check, not the role).

## Source

`packages/daemon/src/sessions/service.ts` (`handleKickoffGiveUpExhausted`'s manager carve-out,
`handleManagerKickoffDropped`, `notifyLeadOfParentlessManagerIssue`/`notifyLeadOfStuckManager`/
`notifyLeadOfDroppedManagerKickoff`), `packages/shared/src/types.ts` (`manager_kickoff_dropped` kind +
`ORCHESTRATION_EVENT_KIND_MEMBERSHIP`), `packages/shared/src/config.ts`
(`BROWSER_NOTIFICATION_KINDS`), `packages/daemon/src/db.ts` (`DURABLE_AUDIT_EVENT_KINDS`),
`packages/daemon/src/companion/attention-push.ts` (`classify()`), `packages/web/src/lib/attention.ts`
(`BROWSER_NOTIFICATION_LABELS` + the render item). Test:
`packages/daemon/test/manager-kickoff-giveup-dropped.mjs`.
