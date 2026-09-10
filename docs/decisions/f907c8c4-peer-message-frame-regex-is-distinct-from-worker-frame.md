# f907c8c4 — the peer-message frame regex must stay distinct from the worker-directed frame

## Narrative

`PEER_MESSAGE_FRAME_RE` matches `messagePeerManager`'s own peer-frame tag — the richer cross-project variant (`[loom:from-manager · <name> · projectId:<id> · sessionId:<id>]`) — and ONLY that variant. The tag itself is derived from `FROM_MANAGER_TAG` (the same reason `FROM_MANAGER_HEADER_RE` derives it, not a second hand-typed literal — a future change to the tag must not silently strand this pattern behind it). What's deliberately distinct from `FROM_MANAGER_HEADER_RE` is the shape after the tag, not the tag: the plain worker-directed frame closes the bracket right after the tag/`:suffix` with no ` · ` fields, so a worker_message/redirect frame never matches this pattern and a peer frame never matches that one. Used by `carryPendingToSuccessor` to label a carried peer message with a successor-inheritance notice — scoped to cross-project peer_message frames only, never a worker/session/platform-directed carry.

`[^\]]*` stops at the FIRST `]`, so a peer project literally named with a `]` in it (e.g. "Loom [dev]") produces a frame this pattern won't match, and the inheritance label is silently skipped for that one delivery. Deliberately left as-is: under-labelling fails CLOSED (a successor loses some context, no worse than before this fix), whereas widening the pattern to swallow an embedded `]` risks the opposite, more dangerous direction — over-matching into an ordinary worker-directed frame and spuriously labelling it, exactly what the discriminating negative control in `peer-message-recycle-inheritance.mjs` exists to catch.

## Do not

- Do not "fix" the `[^\]]*` stop-at-first-`]` behavior without re-checking that `peer-message-recycle-inheritance.mjs`'s discriminating negative control still holds — under-labelling fails closed; over-matching into a worker-directed frame does not.
- Do not hand-type the `[loom:from-manager...]` tag literal a second time — derive it from `FROM_MANAGER_TAG`, the same source `FROM_MANAGER_HEADER_RE` uses, so a future tag change can't silently strand this pattern.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`PEER_MESSAGE_FRAME_RE`'s doc, just above `FROM_MANAGER_HEADER_RE`): originally lines 1729-1748, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## `carryPendingToSuccessor`'s inheritance label — the incident and the byte-identical guarantee

Card f907c8c4 DoD-1: the recycle re-mint loop (`carryPendingToSuccessor`, `sessions/service.ts`) prepends an inheritance label to any re-minted record whose text matches `PEER_MESSAGE_FRAME_RE`, before re-minting it onto the successor. The measured incident this fixes: a cross-project `peer_message` queued for a predecessor (busy/not-ready) that only drains here, landing on a fresh successor with no context for the thread — e.g. a farewell delivered to a manager that never saw the exchange it closes. Scoped to peer frames ONLY, never a worker/session/platform-directed carry, and additive-and-tolerant to the receiving project's manager: the underlying `[loom:from-manager · …]` frame this record's own design constraint protects is left byte-identical — the label is a separate paragraph ahead of it, not a rewrite of it.

## Do not (2)

- Do not prepend the inheritance label to a non-peer-frame carry (worker/session/platform-directed) — it's scoped to `PEER_MESSAGE_FRAME_RE` matches only.
- Do not rewrite or wrap the underlying peer-frame text when labelling it — prepend a separate paragraph and leave the frame byte-identical, per this record's own design constraint above.

## Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts` (`carryPendingToSuccessor`'s method doc), as of main `753e55a754afc0638516f9079ee6c24219d80db8`. Extracted by card `fa831c1c` (tranche 25).
