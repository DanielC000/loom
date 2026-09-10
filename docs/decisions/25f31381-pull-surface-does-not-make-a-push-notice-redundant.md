# 25f31381 — a pull surface does not make its corresponding push notice redundant

## Narrative

Card 38d68b8d's `onPromptMismatchUnmatched` push notice was deliberately withheld pending card `0eb43216`'s content-in-durable-records ruling. Once that ruling landed, card `25f31381` re-examined whether the existing PULL surface (`getLastMismatchUnmatched`) already made the push half unnecessary — and ruled NO: a pull surface only ever helps someone who already suspects a mismatch and knows to call it; the push exists specifically to tell a sender who does not know to ask (the same asymmetry card `68459420`'s own `lastMismatchReplay` record documents for its sibling field). The pull surface stayed; the push was implemented anyway, as the genuinely distinct half it always was.

## Do not

- Do not treat an existing pull surface as making a corresponding push notice redundant — a pull surface only ever reaches a party who already suspects something is wrong; a push notice is what reaches everyone else.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`handlePromptMismatchUnmatched`'s method doc), as of `main` `59b443f3`.
