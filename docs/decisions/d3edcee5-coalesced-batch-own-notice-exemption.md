# d3edcee5 — a coalesced batch's own-notice exemption is derived from `origin`, never from `lastPrompt`'s joined text

## The residual (card 87d2dc95's loop-breaker, re-opened)

`intendedIsOwnMismatchNotice` used to be a prefix test (`stripPossibleDuplicateFrame(live.lastPrompt)`)
against the WHOLE joined text of a drained batch. `requeueGiveUpOrigin` unshifts a kept give-up entry onto
the FRONT of `live.pending`; `drainPending`'s route-keyed branch (taken by every non-`"agent"`-kind head,
including the `[loom:prompt-mismatch]` notice itself) has no exclusion for a `giveUpGen`-tagged entry
(unlike the same-sender `"agent"` branch — see `8af2b9bd`). So a different, non-notice `"warning"`-kind
message that gave up and got requeued can — once its hold expires — become `drainPending`'s HEAD and
coalesce forward with an already-queued mismatch notice (same empty route, same kind, same proactive). The
joined `live.lastPrompt` then has the non-notice member FIRST, the prefix test misses the notice entirely,
the generation is not exempted, and a FRESH notice gets minted about the batch's own mismatch — the
self-sustaining loop 87d2dc95 was supposed to close.

Hermetically reproduced (fake-pty seam, no real claude): `enqueueStdin`'s own "push-then-drain" (decision
`b5ab3aa4`) is sufficient by itself — enqueue+give-up a plain warning, wait past its hold, then enqueue the
notice; the SAME `enqueueStdin` call that queues the notice also triggers the coalescing drain. Verified
both directions: a batch with the notice buried behind another warning does NOT self-exempt (mints a fresh
notice); a notice draining alone DOES self-exempt (unchanged).

## The rule (Option A′, approved over the two candidates the card first floated)

A generation is exempted ("is one of Loom's own prompt-mismatch-family notices") iff, over that
generation's own `submit()` `origin` array:

1. `origin` is non-empty, AND
2. every member's own `kind` is `"warning"` (no `"agent"`-kind member rides along), AND
3. at least one member's own `stripPossibleDuplicateFrame(m.text)` starts with one of the three tags
   (`PROMPT_MISMATCH_NOTICE_TAG` / `PROMPT_MISMATCH_UNRESOLVED_NOTICE_TAG` / `PROMPT_MISMATCH_UNMATCHED_NOTICE_TAG`).

Stamped once, in `submit()`, onto `Live.lastSubmitExemptAsOwnNotice` — alongside `live.lastPrompt = text` —
computed from that SAME call's own `origin`, never re-derived later from the joined string. The
UserPromptSubmit mismatch site reads this field instead of re-deriving `intendedIsOwnMismatchNotice` from a
prefix test on `live.lastPrompt`.

Rejected: "exempt only when EVERY member is a notice" (the card's other candidate) — the reachable defect
is BY CONSTRUCTION a batch mixing a non-notice warning with the notice, so "every member is a notice" would
almost never hold in exactly the case that needs exempting; it does not close the loop.

Rejected (plain "ANY member is a notice", ignoring kind): under the opt-in, default-off
`coalesceAgentMessages=true` legacy setting, `drainPending`'s route-keyed branch ignores `kind` entirely, so
a batch could mix a notice with real `"agent"`-kind content (a manager redirect, a worker report, a human
composer turn). Exempting on "any member is a notice" alone would silence mismatch detection for that real
content too — a lost or garbled human/agent message must never be silenced by a notice riding along in the
same coalesced turn. The `kind`-uniformity conjunct (2) closes this: under the DEFAULT drain rules kinds
never mix within one drain, so the reachable defect (`["warning", notice]`) is still fully exempted; the
opt-in-coalesced mixed-kind case is not.

## Rate-limit replay (Code Review 94c25a95, Minor — fixed)

The single-member-is-byte-identical claim above is accurate for every `submit()` call that actually
carries an `origin`. It was NOT accurate for `resumeAfterRateLimit`'s "rate-limit-replay" path, on two
counts:

1. **Null-origin replay.** `requeueGiveUpOrigin` nulls `live.giveUpOrigin` the instant a give-up fires. If
   a notice's own turn gave up and was requeued, then the session is separately rate-limited before
   anything re-drains it, `resumeAfterRateLimit`'s `replayOrigin = live.giveUpOrigin` reads `null` — the
   replay `submit()` call then runs with `origin: undefined`, where the OLD prefix test would still have
   recognized the notice. Fixed by never resetting `lastSubmitExemptAsOwnNotice`/`lastPromptKind` when
   `origin` is `undefined` (see `submit()`'s own doc) — this replay always re-submits the EXACT text those
   fields were already stamped for, so leaving them untouched is correct, not merely convenient.
2. **Hard-coded replay kind.** The `blocked` (stopping/drainHeld) branch re-enqueued `live.lastPrompt`
   with a LITERAL `kind: "agent"`, regardless of the original turn's real kind — so a replayed notice (or
   any other `"warning"`-kind turn) could never be exempt once drained, and was mislabeled for every OTHER
   kind-sensitive drain decision too (same-sender agent coalescing, the pending agent-count metric). Fixed
   by a new sticky field, `Live.lastPromptKind` — set in `submit()` from `origin[0]`'s own kind whenever
   `origin` is present (mirrors the existing `lastPromptRoute`/`lastPromptProactive`/`lastPromptOwnerText`/
   `lastPromptSenderId` convention: survives a give-up, since `requeueGiveUpOrigin` never touches it) — and
   read by the `blocked` branch instead of a literal.

Regression-covered: `pty-prompt-mismatch-rate-limit-replay-notice.mjs` (RED before this fix).

## Order independence (manager ruling, ACCEPTED)

`[X, notice]` is now exempt for ANY `"warning"`-kind `X`, including a durable system nudge (an idle
watchdog, a restart note, a memory-recall injection) — not only the give-up-requeued-warning shape that
motivated this card. A real splice that corrupts or drops `X` in such a coalesced batch therefore no longer
produces a `[loom:prompt-mismatch]` notice about it. This is accepted as inherent in closing the loop
(87d2dc95's whole point is that the exemption cannot depend on WHICH position the notice occupies in the
batch), and a durable message's own delivery is not solely dependent on this detector anyway — it keeps its
own redrive/give-up/confirmation machinery (`giveUpLineages`/`giveUpConfirmQueue`/content-match purge)
independent of whether a prompt-mismatch notice also happens to fire for its batch.

## Do not

- Do not derive the own-notice exemption from a prefix test on `live.lastPrompt` (or any other joined/
  concatenated text) — it cannot see past the first `DRAIN_SEPARATOR`-joined member. Derive it from
  `submit()`'s own `origin` array, per member, at stamp time.
- Do not drop the kind-uniformity conjunct — "any member is a notice" alone over-exempts a mixed
  `coalesceAgentMessages=true` batch carrying real agent/human content.
- Do not fall back to "exempt" when a `submit()` call site passes no `origin` (`origin` is `undefined` or
  empty) — the safe default is NOT exempt; an absent origin means the per-member kinds/tags can't be
  checked at all.
- Do not forget: a single-member `origin` whose one member is itself the notice must stay byte-identical to
  the pre-`d3edcee5` behavior (this is the `87d2dc95` common case, now expressed as a 1-element instance of
  the same rule, not a separate code path) — EXCEPT the rate-limit-replay paths named above, which needed
  their own, separate fix (sticky `lastPromptKind` + leave-untouched-when-origin-absent).
- Do not hard-code a `kind` on a replay/re-enqueue of `live.lastPrompt` — read `live.lastPromptKind`.
- Do not read the order-independence acceptance above as a gap to close later — it is a deliberate,
  ruled-on tradeoff inherent in the fix, not a residual bug.
