# f907c8c4 — the peer-message frame regex must stay distinct from the worker-directed frame

## Narrative

`PEER_MESSAGE_FRAME_RE` matches `messagePeerManager`'s own peer-frame tag — the richer cross-project variant (`[loom:from-manager · <name> · projectId:<id> · sessionId:<id>]`) — and ONLY that variant. The tag itself is derived from `FROM_MANAGER_TAG` (the same reason `FROM_MANAGER_HEADER_RE` derives it, not a second hand-typed literal — a future change to the tag must not silently strand this pattern behind it). What's deliberately distinct from `FROM_MANAGER_HEADER_RE` is the shape after the tag, not the tag: the plain worker-directed frame closes the bracket right after the tag/`:suffix` with no ` · ` fields, so a worker_message/redirect frame never matches this pattern and a peer frame never matches that one. Used by `carryPendingToSuccessor` to label a carried peer message with a successor-inheritance notice — scoped to cross-project peer_message frames only, never a worker/session/platform-directed carry.

`[^\]]*` stops at the FIRST `]`, so a peer project literally named with a `]` in it (e.g. "Loom [dev]") produces a frame this pattern won't match, and the inheritance label is silently skipped for that one delivery. Deliberately left as-is: under-labelling fails CLOSED (a successor loses some context, no worse than before this fix), whereas widening the pattern to swallow an embedded `]` risks the opposite, more dangerous direction — over-matching into an ordinary worker-directed frame and spuriously labelling it, exactly what the discriminating negative control in `peer-message-recycle-inheritance.mjs` exists to catch.

## Do not

- Do not "fix" the `[^\]]*` stop-at-first-`]` behavior without re-checking that `peer-message-recycle-inheritance.mjs`'s discriminating negative control still holds — under-labelling fails closed; over-matching into a worker-directed frame does not.
- Do not hand-type the `[loom:from-manager...]` tag literal a second time — derive it from `FROM_MANAGER_TAG`, the same source `FROM_MANAGER_HEADER_RE` uses, so a future tag change can't silently strand this pattern.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`PEER_MESSAGE_FRAME_RE`'s doc, just above `FROM_MANAGER_HEADER_RE`): originally lines 1729-1748, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
