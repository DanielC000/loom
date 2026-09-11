# 29b3c396 — the output discriminator is a heuristic, not proof: re-check before treating it as terminal

## Narrative

The OUTPUT discriminator (`lastOutputAt > enterWrittenAt`, card `71de1f9c`) used to `return` immediately on a positive read, committing FOREVER to "a turn is running" with no later re-check. A LIVE specimen showed that commitment can be wrong in a way that never self-corrects: `sendEnterAndVerify`'s own give-up path can suppress its own recovery when it reads output after the final Enter write — but that read can be fooled, either by the method's OWN paste-reassert write provoking a deterministic engine echo, or by a viewer's `repaint()` doing the same (first-hand confirmed instance and full mechanics: card `b64b3726`'s record, "Half 2"). Either vector satisfies this discriminator even when no turn ever starts.

Once fooled, the false suppression does not self-heal the way it looks like it should: `busySince` only re-arms on a GENUINE confirming hook (`setBusy(sessionId, true, "user-prompt-submit-hook")`), so a session stuck here never becomes stale enough for `healIfStuck`'s own OUTPUT-keyed backstop either — every `worker_flush` retry re-triggers the identical echo, indefinitely refreshing `lastOutputAt` out from under it. The two mechanisms that would otherwise catch this (the discriminator itself, and `healIfStuck`'s staleness check) both key off the same signal the false echo keeps refreshing, so neither one is a safety net for the other here.

The fix: route BOTH discriminators — the output-seen branch above, and the pre-existing no-output branch — through the SAME bounded hook-based re-check (`awaitGiveUpConfirmSettle`, card `441499ee`) before treating EITHER as terminal. The free, decisive signal it waits on is `enterConfirmed`, the local proxy for "a turnSeq-advancing hook fired for this generation." A session that never once confirms now always reaches GIVE-UP RECOVERY, regardless of which heuristic suppressed it first — closing the "stuck forever on a false echo" window without touching the output discriminator's own logic (that discriminator is a heuristic, not proof — card `3ce3fa39` — and stays exactly as imprecise as before; this fix only bounds how long a wrong answer from it can stand uncontested).

## Do not

- Do not let the output discriminator `return` on a positive read without a later re-check — a self-provoked echo (this method's own reassert-paste write, or a viewer's `repaint()`) can satisfy it even when no turn ever starts, and nothing else will ever flip `enterConfirmed` back on its own.
- Do not rely on `healIfStuck`'s staleness backstop to catch this case — a repeatedly-retried `worker_flush` keeps refreshing `lastOutputAt`, so the session never goes stale enough to trip it.

## Other sites sharing this id, not covered by this record

`29b3c396` is also cited at `markGiveUpDirty`'s own doc (the shared five-line dirty-mark de-duplication this fix introduced — left inline, not anchored, by tranche 36: below the lint's length threshold), at `flushComposer`'s `recovered` CR follow-up (capturing `wasBusy` before the call writes anything, so a `recovered:true` requires a genuine transition), and at the `awaitFlushConfirmSettle` callback (`confirmed:false` no longer means "still hopelessly stuck," now that the give-up ladder it re-enters falls through to GIVE-UP RECOVERY on its own bounded window). None of these add a new PRIMARY narrative beyond what's captured here; a future tranche may still need to anchor them at their own sites.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `else` branch of `fireEnterAndVerify`'s give-up handling), commit `71f20fa9` ("fix(pty): no give-up stays terminal unconfirmed; worker_flush reports recovery"). Condensed, not verbatim — in particular, the self-provoked-echo cross-reference is rewritten to cite card `b64b3726`'s record directly rather than the stale "see healIfStuck's doc" pointer the source comment carries. Not shared with `packages/daemon/src/sessions/service.ts`. Extracted by tranche 37 (card `b9951bbc`).
