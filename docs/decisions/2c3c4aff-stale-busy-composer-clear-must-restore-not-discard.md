# 2c3c4aff — a stale-busy composer clear must RESTORE the abandoned text, not just discard it

## Narrative

Card `b64b3726` Half 2 (see that card's own record) added `healIfStuck`'s backspace burst to clear a
stranded, unconfirmed injection off the composer when a session is caught stale-busy. That fix completed
the CLEAR but not the RESTORE: the burst un-typed the stranded text, but the text itself — still held in
`live.giveUpOrigin`, set by the original `submit()` and never consumed, because this out-of-band path never
reached `requeueGiveUpOrigin` — was silently discarded, with no signal.

This out-of-band path is exactly a give-up that never reached `fireEnterAndVerify`'s own GIVE-UP RECOVERY
branch (e.g. wrongly suppressed) — `live.giveUpOrigin` still holds the original `QueuedMessage`(s) this
stranded text came from (nothing could have overwritten it: `submit()` is the sole writer, and it never ran
again while `busy` stayed stuck true). The fix restores it via the SAME identity-preserving mechanism card
`441499ee` hardened the normal give-up path with, instead of silently discarding the cleared text —
`requeueGiveUpOrigin`, called with the generation THIS stranded submit ran under, captured BEFORE
`submitGeneration`'s own out-of-band bump. That bump itself is load-bearing: an out-of-band busy clear (no
Stop hook involved) bumps `submitGeneration` so a still-pending `sendEnterAndVerify` chain for whatever turn
this was recognizes it's stale and bails, instead of retry-Enter'ing or give-up→`setBusy(false)`'ing into
whatever submits next.

## Do not

- Do not clear a stranded composer injection without also restoring its origin onto `live.pending` — a
  clear-only fix silently discards real queued content with no signal (this card's own regression).
- Do not capture the generation for `requeueGiveUpOrigin` AFTER `submitGeneration`'s out-of-band bump — it
  must be the generation the stranded submit actually ran under, captured before the bump.

## Source

Inline JSDoc + inline body comments in `packages/daemon/src/pty/host.ts` (`healIfStuck`'s doc comment and
method body, the Card 2c3c4aff paragraphs). Extracted tranche 28. See `b64b3726`'s own record for Half 2,
the fix this card completes.
