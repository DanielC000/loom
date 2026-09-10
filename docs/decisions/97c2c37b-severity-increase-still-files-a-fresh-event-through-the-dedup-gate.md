# 97c2c37b — a severity increase still files a fresh event through the still-open dedup gate

## Narrative

`platformEscalate`'s server-side dedupe exists so a manager re-escalating the SAME still-open issue
every retry/idle-watchdog cycle doesn't flood the Companion's attention-push alert
(`companion/attention-push.ts`) with zero new owner-facing value — each re-file is otherwise a fresh
`orchestration_event`, and attention-push's watermark treats every one of those as genuinely new and
re-pushes "escalated to platform" regardless of whether a Lead is even live to act on it. It mirrors
`auditFileFinding`'s own title-normalized dedupe, but scoped to "still open" rather than "ever filed" —
an escalation, unlike an audit finding, can legitimately recur after resolution.

The dedupe scope was originally `pending`-only (never picked up, still sitting in the Platform board's
landing lane). It was widened to also cover `in_progress` (a Lead has moved it off the landing lane but
not yet resolved it), because the `pending`-only gate stopped deduping the instant a Lead so much as
moved the card off the landing lane — a manager re-escalating the SAME still-open issue on a
retry/idle-watchdog cycle kept re-firing a fresh "escalated to platform" alert for something already
being worked, the observed re-delivery symptom this widening fixes.

That widening introduced the bug this card fixes: a title-only gate now swallowed EVERY re-escalation
of a still-open (`pending` or `in_progress`) title regardless of severity — including one whose severity
genuinely worsened (e.g. medium → critical). No fresh `orchestration_event` meant no fresh
attention-push alert, even though attention-push's own client-side title+severity signature
(`escalationSignature`) exists precisely to catch a severity change — it never got the chance, because
the server-side gate swallowed the event before attention-push ever saw it.

Fix: a same-or-lower severity re-file still dedupes (the original guard's intent, preserved). A HIGHER
severity than the still-open task's last-filed severity is treated as new information — the SAME task is
reused (no duplicate card is minted) but a FRESH `orchestration_event` is filed, so attention-push's own
signature check gets the chance this gate previously denied it.

## Do not

- Do not widen or narrow the dedup scope (`pending` vs `in_progress`) without re-checking this severity
  carve-out — the scope widening is exactly what exposed the bug the carve-out fixes.
- Do not drop the severity-rank comparison in favor of a bare title-only match again — that is precisely
  the regression this fixes.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`platformEscalate`'s SERVER-SIDE DEDUPE /
SEVERITY ESCALATION block, as of this tranche's HEAD).
