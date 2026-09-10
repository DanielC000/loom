# ca341979 — `question_resolve`'s owner text falls back to the single most-recent owner-authored turn

## Narrative

Origin finding ca341979: `ownerText` falls back from the CURRENT turn to the single most-recent owner-authored turn (`PtyHost.getRecentOwnerTurns[0]`) when the current turn isn't owner-formed — e.g. the manager spawned workers, ended its own turn, and only gets to `question_resolve` on a LATER turn triggered by something else (a worker report drain, an idle nudge). This is the same bounded, never-cleared-at-Stop ring `companion/attestation.ts`'s `isVerbatimOwnerText` already widens onto (card `2b26035c`) — `[0]` only (not a scan of the whole window), so the note always attests the owner's LATEST word, never an older one stitched in to make a match.

Both the current-turn source (`PtyHost.getActiveTurnOwnerText`) and the recent-turn source it falls back to are populated ONLY from an actual human composer submission (`pty/host.ts`'s `submit()`) — `resolveQuestionForAgent` (`mcp/questionTool.ts`) doesn't care which of the two supplied `ownerText`; either way it is server-captured, never agent-authored. This is what makes the fallback itself safe to take, not just the `[0]`-only bound on it.

`[0]`-only mirrors WHY `isVerbatimOwnerSubstringRecent` (`companion/attestation.ts`) is shaped the way it is: it checks each entry in `recentOwnerTexts` independently (any ONE entry matching is enough) rather than concatenating them into one string first — concatenating would let a match get stitched together across two different owner turns that individually don't say it. `question_resolve`'s `[0]`-only fallback applies that same principle one step further: it never even reaches for a second turn to stitch from, since only the single most-recent one is ever consulted.

## Do not

- Do not scan the whole owner-turn window for a match — always take `[0]` (the single most recent owner-authored turn), so the resolved note always attests the owner's LATEST word rather than an older one stitched in.
- Do not concatenate multiple owner turns into one string before matching — `isVerbatimOwnerSubstringRecent` checks each recent turn independently for exactly this reason, and `question_resolve`'s `[0]`-only fallback follows the same principle.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above the `question_resolve` tool registration): lines 3838-3845 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2). The `isVerbatimOwnerSubstringRecent` mirroring paragraph and the "both sources are populated from a real composer submission" paragraph above relocated from `packages/daemon/src/mcp/questionTool.ts`'s `resolveQuestionForAgent` doc (lines 459-471, pre-this-tranche numbering) by card `ecd33a9e` (tranche 2 on that file) — this record's original text cited the broader `isVerbatimOwnerText` combinator for the "[0] only" comparison; `questionTool.ts`'s own doc separately cited the more specific `isVerbatimOwnerSubstringRecent` for the "independent per-turn check, not concatenated" comparison. Both are real, distinct functions in `companion/attestation.ts` (`isVerbatimOwnerText` ORs a current-turn check with `isVerbatimOwnerSubstringRecent` over the recent-turns window) — this record now carries both comparisons rather than letting the more specific one go missing.
