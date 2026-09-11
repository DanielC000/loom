# 0fa5beef — give-ups are CONTENTION-DRIVEN BURSTS; a bigger `SUBMIT_VERIFY_TIMEOUT_MS` chases the wrong thing

## Narrative

REJECTED ALTERNATIVE: do not "simplify" `sendEnterAndVerify`'s give-up handling back into a bigger `SUBMIT_VERIFY_TIMEOUT_MS`. Give-ups are CONTENTION-DRIVEN BURSTS, not uniformly-distributed slow hooks — measured: the median gap between consecutive give-ups is 12 log lines, versus ~39 expected under a uniform distribution; 34% land within 10 lines of each other; and local `[submit]`+`[hook]` log density around a give-up is 54.3, versus a 43.7 baseline. Give-ups cluster where the daemon is already busy.

A larger constant is therefore LOAD-SENSITIVE: it just relocates the threshold to wherever fleet contention happens to peak next — the same anti-pattern this project has hit and reverted repeatedly. This is the THIRD instance of it: cards `595aad10` and `fea23514` are the first two reverts, already documented against the sibling `GIVE_UP_CONFIRM_SETTLE_POLL_MS`/`GIVE_UP_CONFIRM_SETTLE_MAX_POLLS` window in card `441499ee`'s own record and its "Do not" section; `0fa5beef` is the same anti-pattern recurring against `SUBMIT_VERIFY_TIMEOUT_MS` instead.

Keying on `lastOutputAt` instead (card `71de1f9c`) is LOAD-TOLERANT — it asks "did the engine actually do something" rather than "did enough wall-clock time pass," so it stays correct regardless of how bad the contention gets.

## Do not

- Do not widen `SUBMIT_VERIFY_TIMEOUT_MS` (or any sibling give-up-related bound) to chase observed slow confirmations — give-ups cluster under contention, so a wider bound just relocates the threshold to wherever fleet contention next peaks, rather than fixing anything. This is the third documented instance of the same anti-pattern being proposed and reverted (cards `595aad10`, `fea23514`, `0fa5beef`); see card `441499ee`'s record for the first two.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the "REJECTED ALTERNATIVE" paragraph inside the `else` branch of `fireEnterAndVerify`'s give-up handling), commit `71f20fa9` ("fix(pty): no give-up stays terminal unconfirmed; worker_flush reports recovery"). Condensed, not verbatim. Not shared with `packages/daemon/src/sessions/service.ts`. Extracted by tranche 37 (card `b9951bbc`).
