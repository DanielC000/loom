# 78e4b3f2 — `possibleDuplicateRootLabel` handles a `rootMsgId` that is not a UUID

## Narrative

CR follow-up (card 78e4b3f2, found in review): `rootMsgId` is NOT always a UUID. `worker_message`'s `resendOf` (`sessions/service.ts`, `messageWorker`) is a raw, UNVALIDATED MCP string argument (`mcp/orchestration.ts`'s `z.string().optional()`) that a caller can set to anything and that then flows straight through as `rootMsgId` — a non-hex or short value would produce a tag `POSSIBLE_DUPLICATE_TAG_RE` can never recognize again, breaking the frame/strip pair's inverse property (a later re-tag would double-prefix instead of correctly no-op-ing, and `stripPossibleDuplicateFrame` would never remove it).

The common case — every self-minted `msgId` IS a UUID, and a chain whose `rootMsgId` was never set via `resendOf` at ANY point in its OWN history resolves to that UUID's own `.slice(0, 8)` — short-circuits there so the tag stays the SAME 8 chars the `[loom:redelivery-parked]` notice's own `root ${rootMsgId.slice(0, 8)}` wording already shows a human. NOT scoped to "this call didn't pass `resendOf`": `ctx.rootMsgId` wins priority over `ctx.resendOf` (`service.ts`'s `enqueueDurableMessage`), so a later re-mint that itself never sets `resendOf` still carries an earlier hop's tainted value forward via `ctx.rootMsgId` — this function validates the ACTUAL VALUE it receives, not which path it arrived by, so any irregular id (a direct `resendOf`, or one inherited from an earlier hop) falls back to `fnv1a32` (already used elsewhere in this file for exactly this "always 8 lowercase hex chars, deterministic" shape) — still correlatable (same input ⇒ same label) but never breaks the regex invariant, regardless of how the irregularity entered the chain.

Exported (card 35c96aa6): the worker-facing `directive_status` MCP tool (`mcp/orchestration.ts`) needs this SAME label computation to match a root a worker supplies against the internal rootMsgId values in its own durable event history. Reusing this function (a pure function of its own input) guarantees that ONE step — computing a label from a candidate rootMsgId — is byte-identical to what produced the tag a worker sees, rather than a re-derived approximation that could silently drift from it; it says nothing about whether the tool's SURROUNDING logic correctly identifies the right rootMsgId to feed in.

## Do not

- Do not assume `rootMsgId` is always a UUID — `resendOf` is a raw, unvalidated MCP string argument, and any irregular value must fall back to `fnv1a32`, never break the `HEX8_RE` regex invariant.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`possibleDuplicateRootLabel`'s function doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
