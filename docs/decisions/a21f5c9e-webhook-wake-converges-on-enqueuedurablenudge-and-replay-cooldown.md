# a21f5c9e — webhook wake mode converges onto `enqueueDurableNudge`; replay amplification is bounded by a pre-fire cooldown, not a cap

Two follow-ups from the Code Review of `72c58b1c` (reviewer `1c76bbca`), both non-blocking.

## Part 1 — the two-path asymmetry

Before this card, `fireWebhookTarget`'s wake branch (`webhooks/ingress.ts`) called raw `pty.enqueueStdin`
directly, with no MCP-seen gate — while `EventTriggerService.fire` (card `90b9e904`) had already moved onto
`SessionService.enqueueDurableNudge`, which for a `usesOrchestrationMcp` role (manager/worker/assistant)
defers the real dispatch behind `pty.waitForMcpSeen(id)` so a nudge can't lose the race to a fresh MCP
client handshake.

**The obstacle to converging**: `enqueueDurableNudge` returns `void`, and its MCP-gated branch swallowed a
`waitForMcpSeen` rejection into a `console.warn` with nothing surfaced to the caller. Webhook ingress's
`.catch()` depends on a signal distinguishing "this fire had no effect, undo the dedupe row" from
"durably handled, leave it alone" (card `72c58b1c`'s own standing rule). Converging naively would have lost
that signal entirely.

**The fix**: `enqueueDurableNudge` gained one additive, optional `opts.onOutcome` callback (see its own
decision comment, `sessions/service.ts`), firing exactly once with:
- `{dispatched:false, error}` — when the enqueue itself never landed: `pty.enqueueStdin` threw, OR
  `enqueueDurableMessage`'s post-effect durability write failed for a "dropped" delivery that had no other
  effect (a genuine total loss — see Round 3 below; `waitForMcpSeen` itself NEVER rejects, see Round 2
  item 2's correction).
- `{dispatched:true, result}` — every case where something real survives the attempt: an immediate
  "handed-off" delivery, a "queued" delivery sitting in the recipient's pty FIFO (even if its OWN
  durability write then fails — Round 2/3's double-fire-edge fix), or a "dropped" delivery whose
  durability write SUCCEEDED. **This is the load-bearing reframing**: `enqueueDurableMessage`
  unconditionally persists a `session_message_queued` durable record whenever `!result.delivered`
  (`sessions/service.ts`'s `enqueueDurableMessage`, the `if (!r.delivered)` branch) — regardless of
  `deliveryState` — and that record is redriven automatically the next time the recipient resumes
  (`resume()` calls `redriveUndeliveredMessagesForRecipient` unconditionally). So once that write has
  actually succeeded, the delivery is NOT lost; it either landed immediately or will land on the
  recipient's next resume (tagged as a possible duplicate).

`fireWebhookTarget`'s wake branch now calls `deps.sessions.enqueueDurableNudge` (looking up the target's
role via `deps.db.getSession`), wraps the call in a `Promise` settled by `onOutcome`, and rejects (⇒ the
route's `.catch()` undoes the dedupe row) ONLY on `dispatched:false`.

**Owner-approved, disclosed behavior change**: before this card, a wake target that was dead (and `resume()`
didn't revive it) undid its dedupe row immediately, so an identical redelivery of the same event could fire
again right away. After this card, that same scenario instead relies on the durable queue's own
redrive-on-resume — the delivery is never lost, but it no longer re-fires on request; it waits for the
session's next resume. This is the SAME contract `EventTriggerService`'s wake mode already has. Approved by
the owner's manager (see the card's own `worker_report` trail) as "nothing is lost, and it's the same
contract event triggers already have."

**`resume()` throwing** (the target session is permanently unresumable — archived/dead/recycled/missing,
`sessions/service.ts`'s `resume()` early guards) is UNCHANGED: it happens before any dispatch and still
propagates to the route's `.catch()`, undoing the dedupe row exactly as before this card.

**Bare-test-stub fallback (HISTORICAL — deleted by Round 2 item 4):** at this card's initial landing,
`fireWebhookTarget` feature-detected `deps.sessions.enqueueDurableNudge` and fell back to the pre-card raw
`pty.enqueueStdin` branch when it was absent, mirroring `EventTriggerService.fire`'s own fallback for the
identical dependency — needed only because `webhook-ingress.mjs`'s pre-existing hermetic scenarios
constructed a bare `{startNew, resume}` sessions stub with no `enqueueDurableNudge`. Round 2 deleted this
fallback entirely: `enqueueDurableNudge` is now a REQUIRED dependency on `WebhookIngressDeps.sessions`, and
every test stub that reaches the wake branch supplies a real one. See Round 2 item 4 below for why (the
fallback's own tests had drifted to assert the OPPOSITE of the real contract) and
`webhook-enqueue-durable-nudge-wiring.mjs` for the standing production-wiring proof.

## Part 2 — undo-replay amplification

Before this card, ANY fire failure undid the dedupe row unconditionally, with no per-(endpoint, deliveryId)
bound — only the pre-existing per-endpoint spawn-rate cap (`DEFAULT_SPAWN_RATE_PER_MIN`, 10/min) limited how
often it could happen. For a target that fails EVERY fire (a timestampless scheme like GitHub, whose dedupe
row is its only replay defense), one captured delivery replayed rapidly would undo-and-refire up to 10
times a minute, indefinitely, for as long as the target stayed broken: 10 dedupe-row write/delete cycles a
minute, and for spawn mode, 10 freshly-minted (and immediately exited) session rows a minute.

**Option rejected: cap N undo attempts per (endpoint, deliveryId), then stop undoing.** Once the cap trips,
the row is left permanently deduped for the rest of the retention window — so a LEGITIMATE later
redelivery of the exact same event (a provider's own automatic retry, or a human's manual Redeliver after
fixing the target) would be silently deduped and dropped for good. This reintroduces `72c58b1c`'s exact
bug — a failed fire permanently swallowing a delivery — just delayed by N attempts instead of 1. Rejected
for that reason.

**A first implementation draft of the chosen cooldown was ALSO wrong, for the identical reason, and is worth
recording so it isn't reinvented.** The first draft gated the UNDO step itself: on a fire failure, only
delete the dedupe row if no prior undo for that `(endpoint, deliveryId)` had happened within the cooldown;
otherwise leave the row in place. That is indistinguishable from a successful fire's row once left in
place — nothing ever re-examines it, so a genuinely-fixed target's later redelivery would be silently
deduped and dropped **for the rest of the full retention window**, not just the 60-second cooldown. Same
bug as the rejected cap, just reached via a different mechanism.

**Fix actually shipped: a pre-fire replay-cooldown GATE, not an undo gate.** `replayCooldownLimiter`
(`REPLAY_COOLDOWN_MS`, 60 seconds; reuses `SlidingWindowCounter` from `gateway/remote-rate-limit.ts`, the
SAME class the spawn-rate cap already uses, with `allow(key, 1, nowMs)` = "at most one allowed hit per
window") is checked in the route handler, keyed `${endpoint.id}:${deliveryId}`, in the SAME place and SAME
shape as the existing spawn-rate check — **BEFORE `recordWebhookDelivery` runs, before any fire is even
attempted.** A replay blocked by this gate records NO dedupe row and attempts NO fire at all (ACK
`{duplicate:true}`, mirroring the rate-limiter's existing "never record a dropped delivery" rule). The
fire's own `.catch()` is UNCHANGED from `72c58b1c` — it ALWAYS unconditionally undoes the dedupe row on
failure, exactly as before this card. The gate bounds how often a fresh ATTEMPT (and therefore a fresh
undo) can happen for one `(endpoint, deliveryId)`; it never decides whether an attempt that DID happen gets
undone.

Walking the state machine proves this is actually bounded correctly, and more strongly than it first
sounds: the gate keys on elapsed time since the LAST attempt, independent of whether that attempt
succeeded, failed, or was undone — so EVERY replay at the same instant after the first is blocked, not just
every other one. Replay 1 (t=0) attempts, fails, is undone (row absent). Replay 2 (same instant) finds the
dedupe row already absent (so the dedupe check alone would let it through) — but the replay-cooldown gate
still blocks it, because its OWN window hasn't elapsed since replay 1's attempt; no row is recorded, no fire
happens. Replay 3, 4, … at the same instant are blocked identically. Only once real time advances past
`replayCooldownMs` does a replay pass the gate again — attempts, fails, is undone — and the cycle repeats,
bounded to at most one fire attempt per cooldown window, indefinitely, never getting permanently stuck
either on or off. (Verified directly: `webhook-enqueue-durable-nudge.mjs`'s Part 2 scenario.)

This bounds BOTH halves of the amplification at once — dedupe-row churn AND spawn-mode's exited-session-row
accumulation — to at most one fire attempt per 60s per deliveryId, instead of up to the full 10/min
rate-limit budget indefinitely.

**What a legitimately-retrying sender experiences**: negligible impact. A provider's own automatic retry
backoff and a human's manual Redeliver click are, in every real case, spaced well beyond 60 seconds; once
the target is actually fixed, the very next redelivery past the cooldown is attempted and succeeds normally
(and permanently dedupes afterward, as always). Only a rapid replay of the identical captured delivery
within the same 60-second window, while the target is still broken, gets harmlessly bounced instead of
re-attempted.

## Round 2 (Code Review 298c2df6 of commit 23a254da, verdict CHANGES)

1. **A cooldown-blocked replay is NEVER `duplicate:true`** — `recordWebhookDelivery` never ran for it (only
   a prior failed-and-undone delivery reaches this gate at all), so the pre-Round-2 `200 {duplicate:true}`
   response was false every single time it fired: a human's manual Redeliver inside the 60s window would
   read as a silent success while nothing actually fired. Fixed to `429` + a `Retry-After` header (the
   remaining cooldown, in whole seconds, derived from `SlidingWindowCounter.retryAfterMs` — a new read-only
   method, additive to every other `allow()` caller) + a distinct `{replayCooldown: true}` body, logging one
   disclosure-safe line (`endpoint.id` + "replay cooldown", never the payload). The Part 1 narrative's
   "retries are spaced well beyond 60s" claim above was never proven against a real provider's spec (Svix/
   Standard webhooks retry at ~5s after a non-2xx) — read it as illustrative, not a verified bound.
2. **`PtyHost.waitForMcpSeen` never rejects** (see its own doc, `pty/host.ts`) — the pre-Round-2 claim that
   `onOutcome`'s `dispatched:false` comes "only when `waitForMcpSeen` rejects" was impossible as stated.
   `dispatched:false` actually comes from `dispatch()` throwing (inside `enqueueDurableNudge`,
   `sessions/service.ts`) — which in practice meant **either** `enqueueDurableMessage` genuinely failing to
   land (correct), **or** a POST-EFFECT step inside it throwing AFTER `pty.enqueueStdin` already succeeded
   (the "double-fire edge": `enqueueStdin` lands, but the follow-up `db.appendEvent` durability write then
   throws — e.g. `SQLITE_BUSY` — and the resulting `dispatched:false` would make a caller like this file's
   `fireWebhookTarget` undo its dedupe row for a delivery that is actually live).
   **Round 2's chosen fix here — wrapping `db.appendEvent` in a blanket non-fatal try/catch, swallowing
   every failure — was ITSELF WRONG and was REVERTED by Round 3 below.** It is recorded here only so the
   mistake isn't reinvented: for a "dropped" delivery (session-dead/shell-terminal), that write is the
   ONLY effect of the whole attempt, so swallowing its failure turned a genuine TOTAL LOSS into a false
   `dispatched:true` — the webhook dedupe row was then kept forever on a delivery that was actually gone.
   See Round 3 for the real fix (a typed error distinguishing "something landed anyway" from "nothing did").
3. **`onOutcome` now fires EXACTLY ONCE on every path, including when it throws itself.** Before this round,
   a throwing `onOutcome` on the deferred (MCP-role) path was invoked TWICE — once from `dispatch()`'s own
   `onOutcome?.({dispatched:true, ...})` call, and again from the `.then(dispatch).catch(...)` handler the
   resulting rejection then triggered — while a synchronous-path `enqueueDurableMessage` throw invoked it
   ZERO times (nothing wrapped the bare `dispatch()` call in the non-MCP branch). Fixed by routing every
   outcome through one `fire()` helper (self-guarding against a double call) and switching to the two-arg
   `promise.then(onFulfilled, onRejected)` form instead of `.then().catch()`, so `dispatch`'s own internal
   try/catch is the only thing that can report an outcome on the deferred path.
4. **The raw `pty.enqueueStdin` fallback in `fireWebhookTarget` was DELETED.** It existed only for a bare
   hermetic test stub omitting `enqueueDurableNudge` — production's real `SessionService` always has it —
   but its continued existence meant `webhook-ingress.mjs`'s own (15a)/(15b) scenarios drove that
   unreachable path and asserted the OPPOSITE of the real contract (that a "dropped" `deliveryState` alone
   undoes the dedupe row, when in fact `dispatched` — not `deliveryState` — decides the outcome once
   `enqueueDurableNudge` is in the loop). `enqueueDurableNudge` is now a REQUIRED dependency on
   `WebhookIngressDeps.sessions` (`pty` narrowed to `Pick<PtyHost, "isAlive">`, `enqueueStdin` dropped — it
   is no longer called from this file at all). (15a)/(15b) were rewritten to exercise the real
   `enqueueDurableNudge`-routed contract instead; see `webhook-ingress.mjs` and `webhook-enqueue-durable-
   nudge.mjs`'s own (P1d), now a regression guard that the deleted fallback stays gone (a missing dependency
   fails the fire loudly, never a silent fallback) rather than a test of the fallback itself.
5. New direct unit coverage of the REAL `SessionService.enqueueDurableNudge` against a fake `PtyHost`
   (`enqueue-durable-nudge-outcome.mjs`) — a "dropped" deliveryState under `dispatched:true` keeps its
   durable row; `pty.enqueueStdin` itself throwing (nothing landed) reports `dispatched:false` with no row,
   on both the sync and deferred paths; item 2's fix verified directly; and item 3's exactly-once guarantee
   verified on both paths including a throwing callback, with no unhandled rejection.

## Round 3 (DELTA Code Review 7d17e57a of 8c650bd6+31085e65, verdict CHANGES) — BLOCKING, reverts Round 2's swallow

**The blocking Major**: Round 2's blanket non-fatal try/catch around `enqueueDurableMessage`'s
`db.appendEvent` write was wrong on `deliveryState: "dropped"` (`pty/host.ts:8401` session-dead,
`:8404` shell-terminal). For that state the write is the ONLY effect — nothing is sitting in the pty's
FIFO either — so swallowing its failure reported a TOTAL LOSS as `dispatched:true`: the webhook dedupe row
was kept forever on a delivery that was actually gone, and it also defeated `carryPendingToSuccessor`'s own
catch (~line 10130), which would then have resolved the OLD record as superseded with nothing left to
deliver it.

**The fix**: reverted the swallow — `enqueueDurableMessage` throws again on an `appendEvent` failure, for
EVERY caller, exactly as it did before Round 2 ever existed. The throw is now a typed
`class PostEffectPersistError extends Error { landed; deliveryState; result; msgId }`
(`sessions/service.ts`, module-scope, not exported — both the throw site and the one place that inspects it
live in this file). `landed` is `true` ONLY for `deliveryState: "queued"` (something real is sitting in the
recipient's pty FIFO regardless of this write's own failure); it is `false` for `"dropped"` (no other
effect, so a failed write here is a genuine total loss). `enqueueDurableNudge`'s `dispatch()` catch is the
ONLY place that inspects it: `landed` ⇒ `fire({dispatched:true, result: {...e.result, msgId: e.msgId}})`
(the double-fire-edge fix from Round 2 survives, now correctly scoped); anything else (a plain throw, or
`landed:false`) ⇒ `fire({dispatched:false, error: e})`. Every OTHER caller of `enqueueDurableMessage`
(`carryPendingToSuccessor`, `handleGiveUpExhausted`, `enqueueSystemNudge`, and ~27 more) sees a plain thrown
`Error` exactly as before — `PostEffectPersistError` IS an `Error`, so `(e as Error).message` logging at
every existing catch site still works; only `enqueueDurableNudge`'s catch does an `instanceof` check.
**The wrapper's own `message` string appends the original cause's `.message`** (not just `.cause`) — a
caller like `carryPendingToSuccessor` (`sessions/service.ts` ~10162) logs `(e as Error).message` alone, so
without this the real failure (e.g. `SQLITE_BUSY`) would be invisible to it, buried only in `.cause`, which
that catch never reads.

**Verified exactly as before Round 2**: `carryPendingToSuccessor` still keeps a re-mint-failed record
unresolved and re-arms it on the predecessor (`carry-pending-to-successor-mint-then-resolve.mjs`,
`post-spawn-bookkeeping-best-effort.mjs` scenario H — both re-run clean, unaffected by this change since
they inject the failure a level up, at `enqueueDurableMessage` itself). `handleGiveUpExhausted`'s re-mint
call (`sessions/service.ts` ~9329) is still a bare, unwrapped call to `enqueueDurableMessage` — if its OWN
`appendEvent` fails, the throw propagates straight out of `handleGiveUpExhausted` BEFORE the
`console.warn("re-minted as ${reminted.msgId}")` line ever runs, so that log can never claim a durable
record it doesn't have; this is structural (the throw happens before the assignment it would need), not a
new guard.

**Tests, in `enqueue-durable-nudge-outcome.mjs`**: (1b) "dropped" + `appendEvent` ALSO throws ⇒
`dispatched:false`, and (mirroring `fireWebhookTarget`'s own reject-on-dispatched:false contract, simulated
locally rather than through a real webhook endpoint) a webhook-shaped caller's dedupe row is undone — RED
on `31085e65` (negative-control proven: reverting `sessions/service.ts` to `31085e65` makes this scenario
fail). (3) "queued" + `appendEvent` throws ⇒ `dispatched:true` (Round 2's test, kept, now exercising
`PostEffectPersistError.landed` instead of the swallow). (5) a non-nudge caller (`enqueueSystemNudge`)
still sees the throw propagate.

**Also in this round**: `webhooks/ingress.ts`'s `onOutcome` comment and reject message, and the (15a) test
fixture's `Error` text, no longer say "the MCP-seen wait failed" (impossible, per Round 2 item 2) — reworded
to "the enqueue itself never landed". `remote-rate-limit.ts`'s `retryAfterMs` uses `hits[0]` instead of
`Math.min(...hits)` — `hits` is already time-ordered (a filtered-then-pushed array), so the oldest entry is
always index 0; no need to re-scan for the minimum.

## Do not

- Do not read `enqueueDurableNudge`'s `onOutcome` `dispatched:true` as "delivered now" — it means "recorded,
  and will reach the recipient eventually" (immediately via `enqueueStdin`'s handed-off/queued branches, or
  on the recipient's next resume via the durable redrive). Only `dispatched:false` means nothing was ever
  recorded.
- Do not widen `fireWebhookTarget`'s MCP-gated branch to also check `enqueueDurableMessage`'s own
  `deliveryState` and reject on "dropped" — that was the pre-convergence rule and no longer applies once the
  message is durably recorded; see Part 1 above for why.
- Do not reintroduce a raw `pty.enqueueStdin` fallback in `fireWebhookTarget` for a bare test stub — Round 2
  item 4 deleted it deliberately (see above); give a test stub a real `enqueueDurableNudge` instead.
- Do not replace the replay-cooldown gate with a per-(endpoint, deliveryId) attempt CAP — see the rejected
  option above; a cap permanently swallows a legitimate later redelivery once exhausted, which is exactly
  the bug `72c58b1c` fixed.
- **Do not move the cooldown check into the fire's `.catch()` to gate the UNDO instead of the ATTEMPT** — see
  the "first implementation draft" section above. Gating the undo leaves a failed-and-kept row
  indistinguishable from a successful one, silently reopening `72c58b1c`'s exact bug at a 60-second delay
  instead of a cap's longer one. The gate belongs BEFORE `recordWebhookDelivery`, exactly like the
  pre-existing rate-limiter check beside it; the `.catch()`'s undo must stay unconditional.
- Do not key the replay-cooldown on `endpoint.id` alone (that's the EXISTING spawn-rate limiter's job, a
  different, coarser bound) or on `deliveryId` alone (a bogus/malicious id could collide across unrelated
  endpoints) — it must be the composite `${endpoint.id}:${deliveryId}` key.
- Do not respond to a cooldown-blocked replay with `200 {duplicate:true}` — Round 2's lead ruling: it is
  429 + `Retry-After` + `{replayCooldown: true}`, since no dedupe row was ever recorded for it.
- **Do not swallow `enqueueDurableMessage`'s `db.appendEvent` failure in a blanket non-fatal try/catch** —
  Round 2 did exactly this and Round 3 reverted it as a blocking defect: for a "dropped" delivery that
  write is the ONLY effect, so swallowing its failure reports a total loss as `dispatched:true`, keeping a
  caller's dedupe row forever on a delivery that is actually gone, and defeats `carryPendingToSuccessor`'s
  own catch. Throw a typed `PostEffectPersistError` (carrying `landed`/`deliveryState`/`result`/`msgId`)
  instead, and let ONLY `enqueueDurableNudge`'s `dispatch()` catch inspect `landed` — every other caller
  must keep seeing a plain throw.
- Do not make `enqueueDurableNudge`'s `dispatch()` catch treat EVERY `PostEffectPersistError` as
  `dispatched:true` — only one whose `landed` is `true` (a "queued" deliveryState); a "dropped" one with
  `landed:false` is a genuine total loss and must report `dispatched:false`.
