# 6bf0ee32 — CASE 4 (Enter never confirmed) fails loud and stops; it never silently retries forever

## Narrative

Card 6bf0ee32: `armCodexBusyStaleTimer`'s confirm-or-retry-or-fail-loud state machine's CASE 4 — genuinely stale, no confirmation, retries exhausted. Doctrine: FAIL LOUD, never silently retry forever. Logs, fires the best-effort `onCodexSubmitUnconfirmed` signal (see its own doc on `PtyHostEvents` — this is what makes the failure MANAGER-visible, not just a daemon-log line), and STOPS. `live.busy` stays true and NOTHING re-arms the timer from inside this branch, so `drainCodexPending` can never write a further message on top of this unconfirmed one (DoD-3) — CASE 2's own `!live.busy` guard, and `reconcile()`'s own `!live.busy` gate, both structurally can't fire while this holds.

This is not a dead end: if codex was merely very slow (not genuinely lost) and a real marker eventually DOES arrive, onData's own UNCONDITIONAL `armCodexBusyStaleTimer` call re-arms regardless of this exhausted state — that re-arm's own eventual fire lands in CASE 2 and resolves normally. Exhaustion pauses the ladder; it does not disable it.

## Do not

- Do not re-arm the staleness timer from inside CASE 4 itself, or let anything drain the pending queue while `live.busy` still reads true from an unconfirmed turn — the queue only resumes once a later real marker re-arms the timer independently and lands in CASE 2.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`armCodexBusyStaleTimer`'s own doc, CASE 4 of its state machine), as of this tranche's HEAD. Extracted by card `677c79cd` (tranche 17 on `pty/host.ts`).
