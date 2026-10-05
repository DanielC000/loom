# 17339316 — the Enter-verify submit chain binds to `Live` by identity, not by re-fetch

`sendEnterAndVerify`/`awaitReassertSettle`/`awaitGiveUpConfirmSettle`/`fireEnterAndVerify` each used to
re-derive their own `live` via `this.live.get(sessionId)` inside every timer callback, keying staleness
only on `live.submitGeneration !== gen`. `Live.submitGeneration` restarts at 0 on every fresh `Live`
(a worker_recycle/resume/fork respawn overwrites `this.live`'s entry for the same `sessionId` with a
brand-new object), so an orphaned chain from the OLD generation could re-fetch the NEW generation's
`Live` and find its own stale `gen` coincidentally matching the new session's first submit (`++0 === 1`,
the same value the old chain's own first submit produced) — causing an extra Enter write, a wrong retry
count, or an early `setBusy(false)`/`requeueGiveUpOrigin` against the wrong (new) session.

This is the same class of bug card 096231e8 already fixed for the mode-cycle machinery
(`runCycleToMode`/`dismissMcpPrompt`/`logLandedMode`) and `escalateGracefulStop`/`armCodexBusyStaleTimer`
already avoid structurally (by closing over `live` directly rather than ever re-fetching it). The TOP-of-
`spawn()` comments documenting the `readyFallbackTimer`/`dialogStuckTimer`/`pendingMismatchUnresolvedTimers`
overwrite race describe the exact same race window for those three timers, closed there via "clear the
outgoing timer before overwrite" instead.

## The fix

Every link in the Enter-verify chain now takes the originating `boundLive: Live` object as an explicit
parameter — captured once by `submit()`/`flushComposer` at the top of the chain — and its first line is
`if (this.live.get(sessionId) !== boundLive) return;`, mirroring `dismissMcpPrompt`'s own identity guard.
This is checked BEFORE the existing `alive`/`enterConfirmed`/`submitGeneration !== gen` checks, which
still catch ordinary same-generation staleness (a later submit on the SAME `Live` bumping
`submitGeneration`) — the identity check only catches the respawn case, where a generation-number
comparison alone cannot tell the two `Live` objects apart.

## Do not

- Do not revert any of `sendEnterAndVerify`/`awaitReassertSettle`/`awaitGiveUpConfirmSettle`/
  `fireEnterAndVerify` back to re-fetching `live` via `this.live.get(sessionId)` inside the callback body —
  that is the exact regression this card fixes. Bind to the `boundLive` parameter threaded through from
  the call site that started the chain.
- Do not drop the `live.submitGeneration !== gen` checks in favor of the identity check alone — they catch
  a DIFFERENT staleness (same `Live`, later generation), which the identity check does not cover.
- Do not thread a freshly re-fetched `live` (e.g. `writeNewTurn`'s own liveness re-checks inside `submit()`)
  into these functions instead of the chain's originating `live` — `writeNewTurn`'s own re-fetches are a
  separate, pre-existing, out-of-scope issue (not fixed by this card) guarding only its own paste-bracket
  writes, not the Enter-verify chain's generation binding.
