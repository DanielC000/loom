# b7158b99 — a recognized replay does NOT establish a loss, and never did reliably

## Narrative

Card `b7158b99` — CORRECTION to `Live.lastMismatchReplay`: this field does NOT establish a loss, and never did reliably. A replay at a given generation is compatible with the composer still holding that generation's own intended text, which a LATER generation's own submission can fuse back in whole (see `lastMismatchFusion`, which would then name this generation in its own `spanGens`); whether that happens is unknowable until that later generation, if any, actually occurs (see `detectComposerAccumulation`'s own coverage-limit doc).

Read a replay as "detected, possibly recoverable by a later fusion", never as "an established loss" — the session-facing `[loom:prompt-mismatch]` notice's own wording carries the same correction.

### The measured specimen this correction is based on

A manager's own session, gen=8/9/10: `reported` at gen=9 was a verbatim replay of gen=8 (exactly what the `replayedEntry !== undefined` branch detects), but gen=9's own 5313-char intended text was never actually gone — it was still sitting in the composer, uncleared, and gen=10's own submission fused it back in whole (`detectComposerAccumulation` CONFIRMED spanGens=[8,9,10], sum `1083+5313+579=6975` matching the engine's own reported length and hash exactly). The `confirmedFusion` branch fires its own "ESTABLISHED — nothing was lost" notice for gen=10 when that happens — so by the time gen=9's OWN notice fires, whether its content will be recovered by a later fusion is not a knowable fact yet; it is a FUTURE EVENT that has not happened. This is not merely unmeasured — `detectComposerAccumulation`'s own doc states the coverage limit structurally: recovery is detectable ONLY at the NEXT write on this session, and is "structurally invisible" if no next write ever comes.

The honest framing at THIS point in time is "cannot yet be established either way" — never "possible" (undersells a real, measured recurring shape) and never "ESTABLISHED loss" (overclaims a fact the code cannot know yet). The prescribed action changes to match: do NOT tell the reader to get a re-send now — a re-send composed on top of a later fusion recovery would hand the recipient the same content twice. Tell them to wait one generation and re-check (a fusion notice, or `lastMismatchFusion` naming this generation in its own `spanGens`, means it was recovered) before asking anyone to re-send.

The genuinely-unmatched (no known prior entry) branch is UNCHANGED by this reasoning — it already used the cautious "possible LOSS" framing pre-existing this card, correctly: an unmatched mismatch has no known prior entry to ever be fused back from, so there is no pending-recovery half to name for it.

## Do not

- Do not word a replay-detection notice or field doc as an established loss — a later generation can still fuse the content back in whole, which is unknowable at detection time.
- Do not tell a recipient to re-send immediately on a recognized-replay notice — wait one generation and re-check for a fusion recovery first, or the recipient may receive the same content twice.
- Do not apply this "cannot yet be established" softening to the genuinely-unmatched branch — an unmatched mismatch has no known prior entry to ever be fused back from, so its "possible LOSS" framing stays correct as-is.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.lastMismatchReplay` field doc, correction clause), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `//` markers.
