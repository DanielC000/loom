# b5ab3aa4 — `enqueueStdin`'s immediate-submit branch requires an EMPTY `live.pending`, and pushes-then-drains otherwise

## Narrative

`enqueueStdin`'s idle-submit gate (`idleEligible` in `pty/host.ts`) proves only that the SESSION itself is eligible for a turn right now (ready, not busy/stopping/rate-limited/drain-held/etc.) — it says nothing about whether `live.pending` already holds an older entry.

Before this fix, the gate was the sole condition for the immediate-submit branch: a brand-new arrival that found the gate open was handed straight to `submit()` by itself, even when older entries already sat in `live.pending`. This was reachable because several of the gate's own checks can flip from blocking to open DURING THE SAME `enqueueStdin` call that is about to use them — `healIfStuck`'s stale-busy clear (+ its own `requeueGiveUpOrigin` push onto `live.pending`), a give-up requeue, or `isHumanSubmitHeld`'s self-expiry (no confirming hook ever arrived) all run earlier in the same call. The brand-new arrival would then jump straight to the front, ahead of whatever the SAME call (or an earlier one) had just made eligible — breaking the FIFO delivery guarantee documented at the `queued:true` return ("WILL be delivered at the next turn boundary"). Nothing was lost — the stranded older entry still drained on the next `reconcile()` tick or `Stop` hook — but it drained strictly out of order, behind a message that arrived after it.

The fix adds `&& live.pending.length === 0` to the immediate-submit gate. When pending is already non-empty, the new entry is pushed through the existing held-path logic (same-sender reorder unchanged) and, if the session is otherwise `idleEligible`, `drainPending` is called synchronously right there — reusing its existing oldest-first/coalescing logic instead of a special case that bypasses it. This costs no added latency (same tick) and restores FIFO order. The entry may or may not itself be part of the leading run `drainPending` drains (a different route/kind can still leave it queued, correctly, for a later drain) — the caller's returned `position` is re-derived from the entry's actual post-drain index in `live.pending`, not the stale pre-drain insert index.

Reproduced hermetically first (`packages/daemon/test/pty-new-arrival-order-after-expired-human-hold.mjs`, the expired-human-submit-hold variant), proven RED against the pre-fix code and GREEN after.

## Do not

- Do not treat `idleEligible` (session-level eligibility) as sufficient on its own to submit a new arrival immediately — always also check whether `live.pending` is empty, or an older eligible entry gets skipped.
- Do not special-case "submit this one new entry alone" when pending is non-empty — push it and call `drainPending` so the SAME oldest-first/coalescing logic the Stop-hook/reconcile paths use also governs this case. Two divergent drain implementations is exactly how this bug was introduced.
- Do not keep reporting `position: insertAt + 1` once a synchronous drain can run between the push and the return — `insertAt` is stale the moment `drainPending` removes entries ahead of it. Re-derive the position from the entry's actual current index.
- Do not delete the inline give-up-origin synthesis in the TRUE immediate-submit branch (pending-empty case, card 441499ee) — it is still the only path where a message is submitted before ever being pushed to `live.pending`, so a give-up has nothing else to restore from. The push-then-drain path does not need its own copy: `drainPending`'s own `drained` array already serves as the give-up origin for anything it submits.

## Source

`packages/daemon/src/pty/host.ts`, `PtyHost.enqueueStdin` (`idleEligible` gate + the push-then-drain block immediately after the held-path push), and `PtyHost.drainPending`. Fixed by card `b5ab3aa4`, discovered by a sub-agent during the PTY host review (`b14d3441` m6).
