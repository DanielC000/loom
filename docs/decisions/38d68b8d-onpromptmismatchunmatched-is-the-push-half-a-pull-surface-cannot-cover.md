# 38d68b8d — `onPromptMismatchUnmatched` is the PUSH half a pull-only surface structurally cannot cover

## Narrative

Card 38d68b8d — DoD-2 of card `59757189`'s UNMATCHABLE-mismatch population (the structural twin of `onPromptMismatchUnresolved`, fired on the opposite `isUnmatchableMismatch` branch — none of the recognized/confirmed shapes claimed this mismatch). A pull surface (`getLastMismatchUnmatched`, card `59757189` DoD-1/3, shipped) already lets a session that KNOWS to ask retrieve this text; this event is the PUSH half that was deliberately left for a later card once the content-in-durable-records ruling (card `0eb43216`) landed — a recipient can never self-diagnose (card `68459420`, `lastMismatchReplay`'s own record — same reasoning applies here), and a pull surface only ever helps someone who already suspects a mismatch.

Fires once per genuinely-sent notice (gated behind the SAME `isExactRepeatNotice` check the recipient's own `[loom:prompt-mismatch]` notice already goes through — no separate dedup invented). `intendedText` is the FULL captured text (`Live.lastMismatchUnmatched.intendedText` — see card `59757189`'s own record for why it's captured at detection time, not a later lookup), passed RAW and UNCONDITIONALLY — same posture as `onPromptMismatchUnresolved`'s `messageExcerpt`: `PtyHost` stays DB-agnostic (no DB, no manager/sender lookup), and the implementer (`SessionService.handlePromptMismatchUnmatched`, via `index.ts`) decides who the sender is and applies the `LOOM_LOG_MESSAGE_CONTENT` gate at the one place this content can become durable/queryable — not here.

## Do not

- Do not treat the `getLastMismatchUnmatched` pull surface as sufficient on its own — it only ever helps a party who already suspects a mismatch; `onPromptMismatchUnmatched` is the push half that reaches everyone else.
- Do not apply the `LOOM_LOG_MESSAGE_CONTENT` gate inside `PtyHost` for this event's `intendedText` — it stays DB-agnostic; the gate applies only at the implementer (`SessionService.handlePromptMismatchUnmatched`).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onPromptMismatchUnmatched` field doc on `PtyHostEvents`), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.
