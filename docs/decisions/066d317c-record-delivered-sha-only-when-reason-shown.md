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
same SHA was wrongly suppressed against a session that, in truth, was never told — the sender read
`boarded` and stood down believing the report was durably filed, with no way to tell that apart from a
genuinely offline Lead.

Fix: only record the SHA(s) against a session when its actual enqueued text names the restart reason.
The requester's own nudge always names it (full, unconditional). A manager/platform's nudge names it
ONLY in the affected/full-re-orient branch — never in the silent bystander or minimal-note branch — and,
within that branch, only for a recipient in the SAME project as the requester (card `11b847e1`) unless
the recipient is the Platform Lead (exempt from that project-isolation scoping). The dedup-recording call
was moved to follow the exact same condition as what text actually gets shown.

## Also under this card: `deliveryStatus` distinctness, and DoD-3 (log the matched token)

The same card also fixed a second, related bug in the completion-escalation suppression path
(`platformEscalate`): a suppressed live nudge used to still return `deliveryStatus: "boarded"` —
indistinguishable from "no live Lead at all". A sender reading `boarded` can't tell "nobody is watching"
from "someone IS watching, we just chose not to interrupt them" — that conflation, combined with the
record-unconditionally bug above, let a sender stand down believing a report was merely durably filed
when a live Lead had in fact been skipped. Fix: a suppressed nudge returns the distinct
`deliveryStatus: "suppressed-duplicate"`, never `boarded`.

**DoD-3:** when a completion escalation IS suppressed, log the MATCHED SHA TOKEN(S), not just the fact
that a suppression happened — both the dedup window and `extractCommitShas`'s free 7-40 hex match mean a
genuine commit SHA can collide with an unrelated hex-looking token (e.g. a Loom card id) named in either
the deploy reason or the escalation's own title/detail. Without the token logged, a wrongly-suppressed
escalation is unrecoverable after the fact — there'd be no way to tell which token collided.

## Do not

- Do not call `recordDeployShasDelivered` unconditionally for a manager/platform branch — it must follow
  the SAME condition that gates whether the SHA-naming reason text was actually enqueued to that session,
  or a later genuine completion escalation for that SHA gets wrongly suppressed against a session that
  was never actually told.
- Do not return `deliveryStatus: "boarded"` for a suppressed-duplicate live nudge — it must be the
  distinct `"suppressed-duplicate"`, or a sender can't tell "nobody watching" from "someone watching, we
  chose not to interrupt".
- Do not suppress a completion escalation without logging the matched SHA token(s) — an un-logged
  suppression is unrecoverable after the fact if the match turns out to be a wrongly-collided token.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`: lines 4408-4417,
as of this tranche's HEAD (tranche 11). Cross-referenced (read-only) against `service.ts` lines 4595-4598,
4744-4754, 9648-9663, 10575, and `docs/investigations/8126f1a0-weaker-pass-first-firing` (a separate
investigation whose evidence data happens to cite this same card's fix, commit `bbe1970b`, as a
specimen — that investigation is keyed on a DIFFERENT id, 8126f1a0, and is not a record for this one).
Also anchored at a second, restating site inside the same function's `isNoOpManagerWake` branch: lines
4682-4690, as of tranche 12's HEAD (see `service.ts` line 4625 as of this tranche's HEAD for its
current location). And a third, restating site inside the affected/full-re-orient branch itself: line
4631, as of this tranche's HEAD (tranche 13). The `deliveryStatus` distinctness and DoD-3 sections are
from `platformEscalate`'s completion-suppression branch in the same file, commit `c295064f39` ("fix
(daemon): a suppressed escalation returns deliveryStatus 'boarded' — indistinguishable from 'no live
Lead', so the sender stands down; and the SHA is recorded delivered even when nothing was sent"), as of
this tranche's HEAD (tranche 30 on `sessions/service.ts`).
