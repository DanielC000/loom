# a8ddd6d2 — decision_resolve confirm token is never returned to the companion

## Narrative

`decision_resolve` (Framework §4's `decisions-relay` ACT half, card `a8ddd6d2`) is the highest-risk lever in the companion capability catalog: resolving a decision can approve owner-gated / irreversible work. A CR hardening pass (post-review fix) changed how its Primitive C confirm round-trip delivers the confirmation prompt.

The confirm prompt is delivered DIRECTLY to the owner's chat via `ctx.outbound.deliverToOwner` — the same outbound rail `chat_reply` uses, resolved from the active turn's own origin, never a lever-guessed destination — and the tool NEVER returns `promptText`/the confirm token to the companion (a bare `{status:'proposed'}`).

The companion is the exact untrusted component Primitive C exists to defend against. If the token were handed back for the companion to "relay" to the owner itself, a hijacked companion could propose a DIFFERENT action than the one it tells the owner about, receive the REAL token, and render its OWN false-labeled message — the owner would still be typing a token that really matches, but for an action they never actually chose.

Delivering server-side and withholding the token from the tool's return value makes that structurally impossible: the companion cannot construct a valid confirm message it never received. Primitive B alone is a substring check (insufficient against negation/context-stripping, e.g. "approve" is a substring of "do NOT approve") — Primitive C, delivered this way, is the actual defense: the owner sees the EXACT daemon-authored action description, and only their own reply (which the daemon re-derives server-side via Primitive A) can commit it.

## Do not

- Do not return `promptText` or the confirm token to the companion from `decision_resolve`'s propose call, in any form — that reopens the hijacked-companion relay attack this hardening closed.
- Do not rely on Primitive B (a verbatim owner substring check) as a standalone defense — it does not distinguish "approve" from "do NOT approve."

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`decisions-relay`'s top-of-block doc, the "CR HARDENING (post-review fix)" paragraph): lines 595-607, as of this tranche's HEAD. Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
