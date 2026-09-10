# 170daebd — a notice carries an honest "+N other escalations open" count, since its own title can't

## Narrative

An escalation notice's title is frozen at filing time and can only ever describe ITSELF —
`escalationSignature` (companion/attention-push.ts) relies on the title staying exactly as filed, so it
can never be re-minted to mention anything else (see `066d317c`/`platformEscalate`'s own doc on why).
That means a recipient reading one notice in isolation has no way to tell "just this one escalation is
open" from "several are open, and this is only one of them."

The observed failure mode this card fixes: a LATE notice — one that sits queued long enough that its
underlying issue is already resolved by the time it's actually delivered — reads as a pure, harmless
replay, while a DIFFERENT, genuinely still-open escalation sits completely unmentioned alongside it. An
earlier notice's already-queued text can't be rewritten retroactively to say so.

Fix: every notice computes, AS OF ITS OWN FILING (never at delivery), an honest count of how many OTHER
escalations against the same Platform home are still open (`columnEscalationStatus(...) !== "resolved"`,
excluding the escalation's own task). Whichever notice is filed later — while an earlier one is still
outstanding — carries a `(+N other escalation(s) currently open)` suffix. This is purely a COUNT, never a
suppression: the late/replay arrival of an earlier notice is still legitimate and lands completely
unchanged; nothing is held back or rewritten because of this count.

## Do not

- Do not try to rewrite an earlier, already-queued notice's text to reflect newer state — it's frozen at
  filing (the dedupe signature depends on that). Add information to the LATER notice instead.
- Do not compute the "other escalations open" count at delivery time — it must be captured AS OF FILING,
  matching the notice's own frozen vintage, not the live state at whatever moment it happens to drain.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`platformEscalate`'s live-nudge branch, the
`otherOpenTaskIds`/`otherSuffix` computation), as of this tranche's HEAD (tranche 30).
