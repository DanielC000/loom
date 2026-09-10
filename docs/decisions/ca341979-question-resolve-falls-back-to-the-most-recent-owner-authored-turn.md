# ca341979 — `question_resolve`'s owner text falls back to the single most-recent owner-authored turn

## Narrative

Origin finding ca341979: `ownerText` falls back from the CURRENT turn to the single most-recent owner-authored turn (`PtyHost.getRecentOwnerTurns[0]`) when the current turn isn't owner-formed — e.g. the manager spawned workers, ended its own turn, and only gets to `question_resolve` on a LATER turn triggered by something else (a worker report drain, an idle nudge). This is the same bounded, never-cleared-at-Stop ring `companion/attestation.ts`'s `isVerbatimOwnerText` already widens onto (card `2b26035c`) — `[0]` only (not a scan of the whole window), so the note always attests the owner's LATEST word, never an older one stitched in to make a match.

## Do not

- Do not scan the whole owner-turn window for a match — always take `[0]` (the single most recent owner-authored turn), so the resolved note always attests the owner's LATEST word rather than an older one stitched in.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above the `question_resolve` tool registration): lines 3838-3845 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
