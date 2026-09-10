# 066d317c — only record a delivered deploy SHA against a session that ACTUALLY saw the reason text

## Narrative

Card 066d317c fixed a false-suppression bug in the completion-escalation SHA-dedup mechanism (card
`5907b71e` part 2). `recordDeployShasDelivered` feeds a dedup window keyed by sessionId → the deploy
SHA(s) a `[loom:daemon-restarted]` wake delivered to that session, so a later "X COMPLETE + DEPLOYED"
`platform_escalate` naming the SAME SHA is recognized as a duplicate turn and its live nudge suppressed.

Before this card, `recordDeployShasDelivered` was called unconditionally in `resumeFleetOnBoot`'s
manager/platform branch — regardless of whether that session's own enqueued wake text actually NAMED the
restart reason (and therefore the SHA). A silent bystander resume (see `b5664b5b`) enqueues literally
nothing, and a minimal/no-op branch may enqueue a note with no SHA in it at all — yet the SHA was still
recorded as "delivered" to that session. The result: a later, genuine completion escalation naming that
same SHA was wrongly suppressed against a session that, in truth, was never told.

Fix: only record the SHA(s) against a session when its actual enqueued text names the restart reason.
The requester's own nudge always names it (full, unconditional). A manager/platform's nudge names it
ONLY in the affected/full-re-orient branch — never in the silent bystander or minimal-note branch — and,
within that branch, only for a recipient in the SAME project as the requester (card `11b847e1`) unless
the recipient is the Platform Lead (exempt from that project-isolation scoping). The dedup-recording call
was moved to follow the exact same condition as what text actually gets shown.

## Do not

- Do not call `recordDeployShasDelivered` unconditionally for a manager/platform branch — it must follow
  the SAME condition that gates whether the SHA-naming reason text was actually enqueued to that session,
  or a later genuine completion escalation for that SHA gets wrongly suppressed against a session that
  was never actually told.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`: lines 4408-4417,
as of this tranche's HEAD (tranche 11). Cross-referenced (read-only) against `service.ts` lines 4595-4598,
4744-4754, 9648-9663, 10575, and `docs/investigations/8126f1a0-weaker-pass-first-firing` (a separate
investigation whose evidence data happens to cite this same card's fix, commit `bbe1970b`, as a
specimen — that investigation is keyed on a DIFFERENT id, 8126f1a0, and is not a record for this one).
