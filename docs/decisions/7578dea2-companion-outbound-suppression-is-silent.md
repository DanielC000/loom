# 7578dea2 — outbound suppression to a flagged non-private dm binding is SILENT, not a re-bind notice

## Context

Card b4f124d8 closed the READ side of a dm-scope-binding hole: an inbound the channel does not confirm as
private is refused authorization. But that left the WRITE side open — a dm binding that in fact names a
group/supergroup chat (minted before db49891d's write-side fix, or hand-bound by a human) still RECEIVED
every outbound push the companion sent to that route: `chat_reply`, heartbeat/reminder/attention-push
replies (all three resolve through `deliverReply` — there is no separate producer code path for them),
`deliverMedia`, and the in-app→other-channel mirror (`sendToChannel`, `controller.ts`'s
`mirrorWebInputToOtherChannels`). Every member of that chat would see the owner's words and the agent's
replies.

## Decision

`ChatGateway.mayDeliverTo(channel, chatId)` gates all four outbound producers above against the SAME
live routing-map lookup `warnUnconfirmedDirectInbound` already flags (`SessionBinding.flaggedNonPrivate`,
persisted via `CompanionBinding.flaggedNonPrivate` / `db.flagCompanionBindingNonPrivate`). A flagged route
is suppressed SILENTLY: no notice — not even a generic "please re-bind" — is sent to the chat itself.

This mirrors the established inbound-side precedent one code path over: an unauthorized dm inbound already
gets NO ack, only a disclosure-safe SERVER-side log (`warnUnconfirmedDirectInbound`'s `console.warn`).
Sending outbound text to a flagged route — even an anodyne re-bind hint — would itself be a NEW disclosure:
it confirms to a possibly-hijacked or accidentally-bound chat that a Loom companion exists on this route
and is currently reachable, information that chat was never authorized to have. The owner-facing surfacing
is the binding list (REST `GET /api/companion/bindings` + the web Manage UI reading `flaggedNonPrivate`)
and the server log, never the chat itself.

## Do not

- Do not send ANY outbound text (including a "re-bind" notice) to a route once
  `SessionBinding.flaggedNonPrivate` is true — that is itself a disclosure to an unauthorized audience.
- Do not let a new outbound producer skip `mayDeliverTo` — every producer that can reach an adapter's
  `send`/`sendVoice`/`sendMedia` for a session's bound route must check it first.
- Do not gate on a SEPARATE flag/lookup from the one `warnUnconfirmedDirectInbound` sets — the inbound
  detector and the outbound gate must read the exact same `flaggedNonPrivate` state, or they can silently
  diverge (a route the log already flagged that still delivers, or vice versa).
