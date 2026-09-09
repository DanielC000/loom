# 02baa3a5 — Carry `logicalId`/`mintedAtWallClock` through the companion-upgrade requeue paths; `mintedAtGen` only when no resume boundary is crossed

## Narrative

And (card 02baa3a5): carry msg.logicalId, msg.mintedAtGen, AND msg.mintedAtWallClock — ALL THREE, mintedAtGen included. This path never reaches `resume()` below (the throw two lines down fires first), so these entries go back onto the SAME, still-alive pty: no boundary is crossed, `submitGeneration` never resets, and mintedAtGen is still valid age evidence here (unlike the post-resume() loop below, which deliberately omits it — see that call's own comment for why).

Card 02baa3a5: also carry msg.logicalId and msg.mintedAtWallClock, but deliberately OMIT msg.mintedAtGen — `resume()` above just produced a brand-new Live, whose submitGeneration restarts at 0, so the predecessor's generation count compared against it would be a unit error, not evidence (the same boundary carryPendingToSuccessor / card 1c47454b treats identically — see QueuedMessage.mintedAtGen's own doc, pty/host.ts).

## Do not

- Do not carry `msg.mintedAtGen` across a `resume()` boundary — a fresh `Live`'s `submitGeneration` restarts at 0, so the predecessor's generation count would be a unit error, not evidence; omit it there but still carry `logicalId`/`mintedAtWallClock`.
- Do carry all three (`logicalId`, `mintedAtGen`, `mintedAtWallClock`) when requeuing back onto the SAME still-alive pty (no resume boundary crossed) — `mintedAtGen` is still valid age evidence there.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`upgradeCompanionCapabilities`): lines 4137-4142 (abort path) and 4177-4181 (post-resume path), as of commit `7a20d971f1c5d3d098b36030b5cc5feebd8be930`. Relocated by card `6065685c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. Cross-references card `1c47454b` (`packages/daemon/src/pty/host.ts`, `QueuedMessage.mintedAtGen`'s own doc) for the same resume-boundary reasoning; no new record minted for it here.
