# 8e0d09e8 — `resolveTailAtDelivery` freezes a message's body but lets a small live tail ride along, with a named carry hole and a caller-responsibility rule

## Narrative

`resolveTailAtDelivery` (QueuedMessage field) is an OPTIONAL caller-supplied closure. **PURITY CONTRACT:
MUST be pure / side-effect-free** — a plain read, never a mutation, counter bump, or log write (see
`docs/decisions/ea77f71d-withdeliverytail-memoizes-once-for-byte-identity-and-cost.md` for the memoization
that enforces at-most-one real call ever, per entry, including for an entry later found never to have been
delivered at all). Its return value (or `""`/`undefined` for "nothing to add") is appended to `m.text`
before any other annotation. It exists so a message whose BODY must stay frozen at enqueue time (e.g.
`platform_escalate`'s notice — the title is a dedupe signature and must never be re-minted, see
`SessionService.platformEscalate`'s own doc) can still carry a small amount of LIVE state read as late as
possible — the escalated card's current column, in that caller's case — without mutating the frozen part.
A throwing resolver is swallowed and contributes nothing (the base text still delivers unchanged) — a live
lookup failing must never drop or delay the message it's attached to; that swallowed failure is ALSO
memoized (never retried on a later touch of the same entry).

## THE CARRY HOLE (named, not just accepted as "safe degrade" — Code Reviewer Minor)

Not threaded through `carryPendingToSuccessor` or `getPersistablePendingSnapshot` (a function cannot cross
a recycle/restart's serialization boundary) — an entry that crosses either boundary simply LOSES this
closure and delivers with its frozen text alone, silently and with no visible marker, exactly like a
resolver that returns `undefined`/throws. This is the SAME successor-Lead cold-boot persona this card named
as most at risk (a daemon restart or `worker_recycle` mid-flight), so the live-tail feature is silently
absent precisely where staleness matters most. `SessionService.platformEscalate`'s own resolver now returns
a visible ` · column: unknown` marker when its OWN lookup finds the task gone — but that only disambiguates
"the resolver RAN and found nothing" from silence. A resolver that never ran at all (this carry hole), or
that itself threw, still produces the exact same silent no-tail output, indistinguishable from each other.

## CALLER RESPONSIBILITY (Code Reviewer Major ①)

The text this resolver contributes is NOT re-read on every future delivery of the same content —
`submit()` stores the fully-assembled text (tail already resolved) verbatim into `live.lastPrompt`, and
`resumeAfterRateLimit` replays THAT STRING unchanged, however much later a usage-cap park happens to clear
(potentially hours). A resolver whose return value conveys freshness (a live status, a count, anything
time-sensitive) MUST embed its OWN read-time stamp in the string it returns — never rely on the surrounding
frame's own vintage marker (if it has one) to cover the tail too; the two can legitimately diverge once a
rate-limit replay is in play.

## Do not

- Do not give `resolveTailAtDelivery` any side effect — it must stay pure; a mutation, counter bump, or log
  write inside it breaks the memoization contract this field's callers depend on.
- Do not assume a carried/recycled/restarted `QueuedMessage` still carries its `resolveTailAtDelivery`
  closure — it cannot cross that serialization boundary, and the loss is silent (indistinguishable from a
  resolver that ran and returned nothing).
- Do not write a freshness-conveying resolver without embedding its own read-time stamp in the returned
  string — a rate-limit replay can deliver the frozen text hours after it was assembled.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `resolveTailAtDelivery` field doc on
`QueuedMessage`, its CARRY HOLE and CALLER RESPONSIBILITY sub-sections), as of commit
`8df12ef535e124c47abb9cd454031b601217b6ec` (`feat(sessions): stamp escalation notices with filing and
column-read times`) and commit `8f08264959e3cda423b7a0c9c2df69acdc775b74` (`refactor(pty): memoize the
delivery tail at drain so annotatedMessageText is pure again`). Relocated by card `3f45b7d8` (tranche 6 on
`pty/host.ts`).
