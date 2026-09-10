# c2f8695a — `worker_flush` is a fourth give-up-confirmation candidate, and the daemon cannot correlate it in time

## Narrative

A fourth candidate the `[loom:redelivery-confirmed]` notice's original candidate list omitted entirely: `worker_flush` (`PtyHost.flushComposer`, wired via `flushWorkerComposer`, `sessions/service.ts`). It is a MANAGER MCP TOOL CALL, not a human at a terminal — `flushComposer`'s own doc frames it as "the daemon-driven analogue of what a human does at the raw terminal," which is exactly why a manager who just called it doesn't recognise its own action in a clause worded for a human pressing Enter, and gets steered toward filing an `f91c8634` specimen against its own correct remedy. It reuses the SAME `fireEnterAndVerify` verify-and-retry ladder `submit()`'s own give-up redelivery uses, so its Enter press produces the identical content-match signal this notice is built on — structurally indistinguishable from Loom's own automatic retry by that signal alone, same as the sender's-own-later-action candidate in `7f47991e`.

DoD-2 (does the daemon correlate rather than list?): NO, and not for lack of trying. Checked whether `flushWorkerComposer`'s own durable `flush_worker_composer` event (`sessions/service.ts`) could be looked up here and used to NAME the cause instead of listing it. It cannot, structurally: that event is appended only AFTER `pty.flushComposer`'s promise resolves, which itself waits on `awaitFlushConfirmSettle` polling `live.enterConfirmed` — and `live.enterConfirmed` is set true, and `purgeConfirmedGiveUpRequeue` (which fires `onGiveUpConfirmed` → `handleGiveUpConfirmed`, synchronously, in the SAME hook-handling call) runs, BEFORE that poll ever observes the flip (`deliverHook`'s `UserPromptSubmit` case sets `live.enterConfirmed = true` several lines before calling `purgeConfirmedGiveUpRequeue`, in the same function). So by the time `handleGiveUpConfirmed` runs and sends the notice, a causally-responsible flush's own audit event does not exist in the DB yet — there is nothing to query. An accurate menu beats a confident wrong attribution; do not add a lookup here that would always return empty and read as "checked, ruled out" when it never actually ran early enough to see the event that would prove it.

## Do not

- Do not add a lookup from `handleGiveUpConfirmed` to `flush_worker_composer` events to try to name the cause — that event is appended too late (after `pty.flushComposer` resolves) to exist yet at the point this notice fires; a lookup here would always return empty and read as "checked, ruled out" when it never ran early enough to see the event that would prove it.
- Do not treat `worker_flush` as excluded from this notice's ambiguity — it reuses the same verify-and-retry ladder `submit()`'s give-up redelivery uses, producing the identical content-match signal.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`handleGiveUpConfirmed`'s method doc), as of main `a3f78400`. Extracted by card `3376af3e` (tranche 24).
