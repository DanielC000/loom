# 085d9422 — `suppressMootParkNotice`: three staleness checks before a `[loom:redelivery-parked]` notice

## Narrative

Card 085d9422: a MOOT `[loom:redelivery-parked]` notice costs far more than its own ~1.1KB — the owner
measured FOUR duplicate/moot notices in one 40-minute window, each forcing a full manager verification
turn (`worker_status` + `worker_transcript` + reasoning, ~2-5K tokens) to learn what this check can rule
out for free — suppressing one is worth roughly 10x shortening it. Called at the PARK site, BEFORE the
notice is built, so a suppressed case costs nothing beyond this query.

This card's OWN leading hypothesis for the duplication — the notice's own re-mint recursion — was
investigated (`give-up-exhausted-durable.mjs` scenario (7)) and found already safe: the sentinel
`"system"` sender never resolves to a live session, so a notice that itself gives up terminates with zero
follow-on dispatch. That hypothesis does NOT hold. The real causes, measured instead:

1. **Duplicate park for the same root** — established by this card's own reproduction:
   `enqueueDurableMessage`'s auto-join (`hasAmbiguousMatch`, card 4a0af485) lets a SECOND, independent
   dispatch of matching content join an existing chain's `rootMsgId` — but the join only shares the
   LABEL; each dispatch still runs its OWN independent `chainDepth` counter and can reach PARK entirely
   on its own. Two independently-parking chains sharing one `rootMsgId` produce two BYTE-IDENTICAL
   notices (neither carrying a possible-duplicate tag — each is a fresh, self-rooted send to the sender,
   not a re-mint of the other) — the "two byte-identical pairs" this card's measured evidence describes.
   Once any chain has already parked this root, a second parking of the SAME root tells the sender
   nothing new.
2. **Superseded by a newer directive** — mirrors `staleDirectiveProjection`'s own "latest wins" rule
   (`mcp/orchestration.ts`): if `sender` has since dispatched another `message_worker`/`redirect_worker`
   to this SAME `recipientId` after the one that produced this `rootMsgId`, that newer directive is now
   the one `worker_list`/`worker_status` tracks — `parkedDirective` for the OLD root is no longer
   reachable from there either, so a notice about it describes a directive the sender has already moved
   past.
3. **Already confirmed-after-park** — a late confirming hook (`handleGiveUpConfirmed`) can resolve this
   exact `rootMsgId` to `confirmed-after-park` in a narrow race before this PARK branch's own notice goes
   out; that path already sends its own `[loom:redelivery-confirmed]` retraction, so a
   `[loom:redelivery-parked]` notice for a chain already known to have landed would just contradict it
   moments later.

Deliberately does NOT check "does the recipient's transcript already contain the message" (the card's
third candidate): no cross-session transcript-CONTENT read exists at this layer for the general sender
(see `canCheckRecipient`'s own honesty split in the caller), and check (3) above already covers "already
landed" via the durable confirmed-after-park signal for the one case that's checkable without one. Also
deliberately does NOT add a settle-delay before evaluating these checks (floated, since a late-arriving
confirmation can beat a notice sent immediately) — that would delay reporting a message that is
GENUINELY lost, which the card's own DoD calls the load-bearing half; check (3) plus
`handleGiveUpConfirmed`'s existing retraction already cover the "landed a little late" case without
adding latency to the "actually lost" case.

Never suppresses a genuinely first, unresolved, un-superseded park — a message that is actually lost
still gets reported, at the same latency as before this card.

## Do not

- Do not add a settle-delay before evaluating these three checks — that trades latency on the "actually
  lost" case (the load-bearing one) to shave a little on the "landed a little late" case, which check (3)
  plus `handleGiveUpConfirmed`'s retraction already cover.
- Do not add a transcript-content check as a fourth condition — no cross-session transcript-CONTENT read
  exists at this layer for the general sender; `canCheckRecipient`'s narrow worker_list/worker_status
  path is the only real read, and it's a separate, caller-side concern from this method.
- Do not treat this method as suppressing every "parked" notice — a genuinely first, unresolved,
  un-superseded park is never suppressed.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`suppressMootParkNotice`'s function doc):
lines 7137-7182, as of main `fb53a9f6c9b1b7404c8f622aaa3ee25babad9d41`. Relocated by card `0d854939`
(tranche 19); no wording changed, wrapped source lines joined into a flowing paragraph and the `*`
comment markers stripped.

## Related

- `docs/decisions/ccb407eb-carry-givenupexhausted-through-upgrade-requeue.md` — the give-up
  terminal-branch policy (`handleGiveUpExhausted`) this method's PARK site calls into.

## Notice-text relocation (DoD-3), same card, second site

Card 085d9422 also shortened the notice: the 4a0af485 confirmation hedge and the 417cea0a
resend-auto-join caveats made up ~730 of its ~1,150 chars, identical every time. Relocated, not
deleted, to `worker_list`'s `parkedDirective` doc and `worker_message`'s own description — a
reader who has already seen those docs (every turn) loses nothing; one who hasn't gets a pointer
instead of the inline prose. CR follow-up: the `parkedDirective` pointer belongs ONLY in
`canCheckRecipient` — an earlier draft put it in the unconditional prefix, contradicting the
negative branch's "no read exists" text for a peer sender (417cea0a: recipient may not be a
worker).

## Source (2)

`sessions/service.ts`'s `handleGiveUpExhausted` notice block, main `c461821e`. Relocated by card
`1341fcde` (tranche 20).
