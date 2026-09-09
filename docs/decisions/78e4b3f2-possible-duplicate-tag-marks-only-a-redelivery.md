# 78e4b3f2 — possible-duplicate tagging, root-label fallback, and drain/requeue text reconstruction

⚠️ This one card id spans three distinct, independently-cited decisions (three separate `@decision 78e4b3f2` anchor sites in `pty/host.ts`). Two of them (below, §1/§2) already collided under this same filename-resolution defect BEFORE tranche 2 touched this id — `resolveRecord` in `decision-records.mjs` serves exactly ONE file per id (alphabetically first), so a second same-id file is silently unreachable. Card `de94a415`'s tranche 2 found and fixed the collision by folding a third decision (§3) in here rather than adding a fourth file.

## §1 — The possible-duplicate tag marks only a redelivery, never a first-time directive

The RECIPIENT-side half of duplicate legibility (the sender-side half, card `417cea0a`, is the `[loom:redelivery-parked]`/`[loom:redelivery-confirmed]` notices). Duplicate-over-loss (`bc0774c4`) stays exactly as it is — this does not reduce or gate a single re-delivery — it only marks one so the recipient can tell it apart from genuine new direction.

Applied to a re-delivery of a message whose FIRST write was never confirmed, via TWO distinct triggers: an in-session requeue (`requeueGiveUpOrigin` stamps `giveUpGen`) or a cross-remint (`handleGiveUpExhausted`, `sessions/service.ts`, `chainDepth > 0`, applied at message CREATION). The ORIGINAL, first-ever write of a logical message never triggers either path, so a genuine first-time directive is never marked. `rootMsgId` is `QueuedMessage.logicalId` — stable across every requeue/re-mint (card `4a0af485`) — so every re-delivery of the SAME logical message carries the SAME tag.

**Do not:** apply this tag to a genuine first-time directive — it must stay reserved for a re-delivery, or recipients would learn to discount real direction.

## §2 — `possibleDuplicateRootLabel` handles a `rootMsgId` that is not a UUID

CR follow-up, found in review: `rootMsgId` is NOT always a UUID. `worker_message`'s `resendOf` (`sessions/service.ts`, `messageWorker`) is a raw, UNVALIDATED MCP string argument (`z.string().optional()`) that flows straight through as `rootMsgId` — a non-hex/short value would produce a tag `POSSIBLE_DUPLICATE_TAG_RE` (`HEX8_RE`) can never recognize again, breaking the frame/strip pair's inverse property.

The common case — every self-minted `msgId` IS a UUID and a chain that never set `rootMsgId` via `resendOf` — short-circuits to that UUID's own `.slice(0, 8)`. NOT scoped to "this call didn't pass `resendOf`": `ctx.rootMsgId` wins priority over `ctx.resendOf`, so an earlier hop's tainted value propagates forward — this function validates the ACTUAL VALUE it receives, not which path it arrived by, so any irregular id falls back to `fnv1a32` (deterministic, always 8 lowercase hex chars) rather than breaking the regex invariant. Exported (card `35c96aa6`) so `directive_status` (`mcp/orchestration.ts`) reuses this SAME pure label computation rather than a re-derived approximation that could drift.

**Do not:** assume `rootMsgId` is always a UUID — `resendOf` is raw/unvalidated, and any irregular value must fall back to `fnv1a32`, never break the `HEX8_RE` regex invariant.

## §3 — `annotatedMessageText` is shared verbatim between drain and requeue so their reconstructions can't drift

`annotatedMessageText` computes the text ACTUALLY submitted for a drained batch — coalesces with `DRAIN_SEPARATOR`, and frames any member whose `giveUpGen` is set as a possible duplicate (§1's tag). SHARED, deliberately, between `drainPending` (the real write) and `requeueGiveUpOrigin` (must reconstruct that SAME text to seed a matching content-match signature — `giveUpGen` has not yet bumped to the new generation when `requeueGiveUpOrigin` reads it). Letting the two diverge would break the late-confirmation content-match/purge mechanism the instant a marked retry itself gives up: the engine's real echo carries the tag, but a signature from differently-reconstructed text would never match it.

`currentGen` is threaded through the SAME way for the SAME reason (card `4af5aefa`): `annotatePasteRecoveryAge` must run on whatever `drainPending` is about to actually write, and `requeueGiveUpOrigin` must reconstruct that exact annotated text. `annotateMintStamp` (card `21a281b6`) runs LAST, after paste-recovery age — mutually exclusive in practice but composed regardless so this call site stays correct if that changes.

**Do not:** let `drainPending` and `requeueGiveUpOrigin` diverge in how they compute the written text (or the `currentGen` passed) — a marked retry that itself gives up needs a signature reconstructed the SAME way, or the content-match/purge mechanism breaks.

## Source

- §1: `packages/daemon/src/pty/host.ts` (`POSSIBLE_DUPLICATE_TAG_RE`/`HEX8_RE`'s top-of-const doc). Relocated by card `a4818d7a` (tranche 1).
- §2: `packages/daemon/src/pty/host.ts` (`possibleDuplicateRootLabel`'s function doc). Relocated by card `a4818d7a` (tranche 1).
- §3: `packages/daemon/src/pty/host.ts` (`annotatedMessageText`'s function doc), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2), folded in here (rather than a third/fourth same-id file) for the reason stated at the top of this record.
