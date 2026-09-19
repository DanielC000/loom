# f2f0fafa — `session_stop`/`session_reap`/`session_message` accept a session id-prefix, resolved at the router

## Narrative

`session_stop`/`session_reap`/`session_message` (all `packages/daemon/src/mcp/platform.ts`, the Lead
surface) each routed a caller's `sessionId` straight into a `SessionService` method
(`stopSession`/`reapSessionStrays`/`deliverSessionMessage`) that did an exact-id-only `db.getSession`
lookup and threw the generic `"session not found"` for a valid-but-prefixed id — a false-existence claim
when the real condition was "this tool requires the full id." `session_transcript`, in the same file,
already accepted a full id OR an unambiguous 8-char id-prefix via `db.findSessionsByIdPrefix` +
`transcript-read.ts`'s `AMBIGUOUS_ID_ERROR`; the other three never adopted that resolver.

**Decision (DoD-1): accept prefixes on all three**, not just reject with an honest message. Consistent
with the sibling `session_transcript` in the same file, and none of the three op semantics argue against
it: `session_stop` is documented resumable/orphan-free (not permanently destructive), `session_reap` is
already scoped to the target session's own worktree (narrow blast radius), and `session_message` merely
delivers text (worst case: a message lands on the wrong session, not lost data).

**Where resolution happens (DoD-2): at the router, in a shared `resolveSessionByIdOrPrefix` helper local
to `platform.ts`, not inside `SessionService`.** Resolution mirrors `session_transcript`'s exactly (exact
hit wins, else `db.findSessionsByIdPrefix`, covers archived rows too) — the SAME resolver, satisfying "do
not hand-roll a second scheme." The three `SessionService` methods stay exact-match-only and
byte-identical: `stopSession`/`deliverSessionMessage` are also reused UNCHANGED by the companion's
session-steer lever (`companion/capabilities.ts`), which does its own separate, still-exact-only
resolution (`resolveControlTarget`) before ever calling them — resolving in the shared service instead of
the router would have been invisible to that caller and out of this card's declared scope
(`mcp/platform.ts` + tests) besides.

**Ambiguous-prefix error text (DoD-3): names the candidate ids for these three, unlike
`session_transcript`'s plain `AMBIGUOUS_ID_ERROR`.** Deliberate, not inherited: a caller here is about to
STOP/REAP/MESSAGE a session, where knowing which candidates matched is worth more than it is for a read,
mirroring `getByIdPrefix`'s richer ambiguous-id error elsewhere in the codebase. The shared
`AMBIGUOUS_ID_ERROR` constant (exported from `transcript-read.ts`, also consumed by the Auditor's
`transcript_read` and the companion's own `transcript_read`) was deliberately left untouched — widening
it to name candidates everywhere would ripple into those two unrelated, out-of-scope read surfaces for a
decision this card never asked about. The too-short case (`sessionId.length < MIN_ID_PREFIX_LEN`, no
candidate list to name) still returns the shared `AMBIGUOUS_ID_ERROR` text, identical to
`session_transcript`.

## Do not

- Do not resolve the id-prefix inside `SessionService.stopSession`/`reapSessionStrays`/
  `deliverSessionMessage` — resolve at the `mcp/platform.ts` router (or any future caller's own router)
  and pass the resolved FULL id down, so the companion's `session-steer` lever (which calls these same
  methods after its own separate exact-only resolution) is unaffected.
- Do not reach for `id-prefix.ts`'s `getByIdPrefix` for a session id — session ids resolve via
  `db.findSessionsByIdPrefix` + the `AMBIGUOUS_ID_ERROR` convention (`transcript-read.ts`), entirely
  separate machinery from `getByIdPrefix` (which resolves project/agent ids). See sibling decision
  `e6a756ea`'s own record for why these two resolvers must not be merged.
- Do not widen the shared, exported `AMBIGUOUS_ID_ERROR` constant to name candidate ids without a fresh
  look at its other two callers (`transcript-read.ts`'s own `transcript_read`, and the companion's
  `transcript_read` in `companion/capabilities.ts`) — this card's richer ambiguous message is local to
  `session_stop`/`session_reap`/`session_message` only, built inline, not baked into the shared constant.

## Source

`packages/daemon/src/mcp/platform.ts`, `resolveSessionByIdOrPrefix` (helper immediately preceding the
`session_stop` tool registration) and its three call sites (`session_stop`, `session_reap`,
`session_message`).
