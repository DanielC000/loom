# 2db23c4d — `notify_lead` relays an assistant session to its OWN live manager as a non-authoritative claim

## Narrative

Three levers exist for an owner-facing non-manager session to reach into orchestration, each solving
a narrower case than the last:

- The Companion's own `session_message`/`session_steer` (companion/capabilities.ts `SESSION_STEER`)
  solved "the owner asks its Companion to control/message some session" — an owner-granted act-mode
  scope plus Primitive-A turn-attestation, because that lever ACTS on the owner's behalf with real
  authority over another session.
- `messagePeerManager` solved the manager↔manager cross-project case — a caller-chosen target, gated
  server-side on an owner-declared project link.
- `notifyLead` is the missing, narrower one: an **assistant**-role session (the Companion, or any
  ideation/thought-partner rig sharing that role) with **no grant and no target choice**, reaching
  **only its own project's live manager**.

**Caller gate:** `requireAssistant` — defense in depth on top of `notify_lead` being registered ONLY
on the `role==="assistant"` MCP branch (mcp/orchestration.ts).

**No target param at all** — always the caller's own project, derived server-side from its session
id. Narrower than `peer_message`, which at least validates an owner-declared link before naming a
cross-project target.

**Target manager resolved FRESH on every call** (`role==="manager" && processState==="live"` within
the caller's own project) — survives a manager recycle for free: recycle retires the predecessor's
row and inserts the successor as the project's new live row (see `recycleAsManager`'s re-parent
logic), so this query always finds whoever is live now, with no lineage-chain walk needed.

**Rate-limited per calling assistant session** (`checkNotifyLeadRateLimit`, its own dedicated bucket
in peer-message-guard.ts — never shared with `peer_message`'s bucket): role "assistant" is the most
injection-exposed surface in Loom (chat-facing), so a compromised/confused session can't turn this
into a spam vector against its own manager.

**Framed as a subordinate CLAIM, never as attested owner/human words** (owner ruling, this card):
`[loom:from-assistant · <name> · sessionId:...]`. Even when the assistant is relaying something the
owner actually told it, the manager receives it as "the assistant relayed: X" — to weigh and verify,
never as an owner-authored turn.

**Why no Primitive-A gate is needed here:** unlike the Companion's operator-mode
`session_message`/`session_steer` (which ACT with real authority over another session, so they
require verified owner text), this lever only ever produces a non-authoritative relay the recipient
manager must independently judge — mirrors `workerReport`, which has no such gate either.

**No-live-manager fallback:** mirrors `messagePeerManager`'s own-board fallback — boards a durable
card on the SAME project's board rather than silently dropping or erroring for a legitimately
offline/recycling manager.

**Audit:** a single `assistant_relay_message` event, regardless of which delivery path was taken.

## Source

`packages/daemon/src/sessions/service.ts` — `notifyLead` (extraction tranche 32).
