# 72c58b1c — webhook dedupe row: recorded immediately before the fire, undone ONLY on a fire that provably had no effect

Follow-up to `07af871d` (Code Review e089cd2b): `ingress.ts` recorded the delivery dedupe row well before
the out-of-band wake/spawn fire, and the fire's `.catch()` only `console.error`'d — never removed the row.
A fire failure (a `resume`/`startNew` error) therefore left the row in place for the rest of the retention
window, permanently swallowing that delivery, including a provider's manual Redeliver (same GUID/body,
same dedupe key either way).

## Round 1 — record placement + undo on failure

Kept the dedupe check-then-record fully synchronous (no `await` between `hasWebhookDelivery` and the
INSERT) — that's what already made a concurrent duplicate dedupe at most once, since nothing can interleave
mid-handler on Node's single event-loop turn, and it's untouched by every later round. Moved the record from
right after the rate-limit check to immediately before `fireWebhookTarget(...)` (after `JSON.parse` /
`formatWebhookEventBlock` / `reply.send()`), so nothing between "checked" and "recorded" can throw and
strand the row with no undo point. Added `Db.deleteWebhookDelivery` and called it from the fire's
`.catch()`, itself wrapped in a try/catch so a delete failure can't suppress the original fire-failure log
or escape as an unhandled rejection. `fireWebhookTarget`'s wake-mode branch was also fixed to check
`enqueueStdin`'s `deliveryState === "dropped"` and throw — unlike `resume`/`startNew`, `enqueueStdin`
reports failure as a plain return value, never a throw (see decision `13e32e1d`: `delivered:false` alone is
NOT a failure — a `"queued"`/held outcome is a real, durable success).

## Round 2 — Code Review 1c76bbca reproduced a BLOCKING double-fire regression

**The rule Round 1 was missing: undo the dedupe row ONLY when the fire provably had NO side effect.**
Round 1's `.catch()` undid the row on ANY throw from `fireWebhookTarget` — but a throw does not always mean
nothing happened. Two concrete ways a fire can have ALREADY had its effect and still throw:

1. **The bookkeeping stamp, not the fire itself, throws.** `fireWebhookTarget` called
   `deps.db.updateWebhookEndpointLastFired(...)` AFTER a successful `startNew`/`enqueueStdin` — if THAT
   throws (e.g. SQLITE_BUSY), the whole function rejects, and the route's `.catch()` deleted the row even
   though a session had already spawned (or a nudge had already delivered). A redelivery of the same event
   then created a SECOND live session for one webhook delivery.
2. **`SessionService.startNew` can itself throw AFTER `pty.spawn` has already succeeded** —
   `sessions/service.ts`, the `discovery_block_injection` observability event (card badba5a8) recorded
   right after the spawn's own try/catch closes (the try/catch only covers everything through `pty.spawn`;
   this call sat unguarded after it). A DB failure on that ONE informational `appendEvent` call used to
   propagate straight out of `startNew()`, indistinguishable from "never spawned" to any caller relying on
   "startNew() throws ⟺ no live session resulted" — which webhook ingress does.

**The fix, in both places:**
- `fireWebhookTarget` moved `updateWebhookEndpointLastFired` into its own best-effort try/catch, AFTER the
  fire branch — a failure there is logged (`"...informational only, not fatal"`) but never rethrown, so it
  can never reach the route's undo-triggering `.catch()`.
- `SessionService.startNew`'s `discovery_block_injection` `appendEvent` call is now wrapped in its own
  try/catch, logged on failure, never rethrown. `resume`/`startNew` otherwise still throw on every
  SYNCHRONOUS failure (every OTHER failure path in `sessions/service.ts` wraps its spawn in `try { ... }
  catch (e) { this.reconcileFailedSpawn(session.id, e); throw e; }`, verified at source) — this was the one
  call site that didn't, fixed at its root rather than worked around from webhook ingress, since webhook
  ingress has no way to recover the new session's id on a throw to check its live-ness itself (the id is
  generated inside `startNew` and never surfaces on a throw).

**Scope of "invariant restored" — narrow this to what's actually true.** `startNew`/`resume`/`enqueueStdin`
do not throw after their real side effect for any CURRENTLY KNOWN post-effect step — `appendEvent` (this
round) and `onBusy` persistence (Round 3, below). This is NOT a closed-form guarantee against every future
post-effect step: a new one added later (inside `startNew`/`resume` after their own spawn succeeds, or
inside `fireWebhookTarget` after its fire branch) that throws on failure would be a REGRESSION of this
card, not a hypothetical — see the "Do not" list.

**Why wake mode's `resume()` post-effect throw does NOT need the same fix (reviewer-confirmed) — but its
`submit()`→`setBusy` post-effect throw DID (Round 3).** These are two DIFFERENT post-effect steps on the
wake-mode path, with two different verdicts:
- `resume()` has an analogous shape to `startNew` (code can run after its own try/catch closes), and CAN
  throw after a session has genuinely come back alive. But for WAKE mode, the delivery's actual effect is
  the `enqueueStdin` call, not `resume()` itself — and `enqueueStdin` is only ever reached AFTER `resume()`
  returns without throwing. So a `resume()` throw (whichever internal step causes it) always means
  `enqueueStdin` never ran for this attempt — no nudge was delivered, so undoing the row is correct. And a
  redelivery's retry-resume is idempotent regardless (`resume()`'s own `isAlive` short-circuit at its top
  makes resuming an already-live session a no-op) — so even if `resume()` partially succeeded (the session
  came back alive) before throwing on some later step, a retry's `resume()` call is harmless and the
  retry's `enqueueStdin` still delivers exactly once. **This one is genuinely safe by design — no fix
  needed, then or now.**
- `submit()` (called synchronously by `enqueueStdin` for an idle session) writes the paste/Enter FIRST,
  then calls `this.setBusy(sessionId, true, reason)` as its own LAST synchronous statement (`pty/host.ts`)
  — AFTER the nudge has already gone out. This one was a REAL defect, reviewer-reproduced (Round 3): a
  throw from `setBusy`'s `onBusy` callout here made `enqueueStdin` look like a failed delivery even though
  the text had already been written. Unlike `resume()`, this was NOT safe by design — it is fixed the same
  way (A) is: at the root, inside `setBusy` itself (see Round 3), not by special-casing wake mode.
Spawn mode's `startNew()` has no `resume()`-style idempotent escape hatch either way: every call mints a
brand-new session, so "session created, later step threw" is a genuine double-spawn risk spawn mode alone
carries — which is why (A)'s fix lives in `startNew` specifically, while `setBusy`'s fix (Round 3) is
shared by both modes at their common root.

## Round 3 — Code Review aeae8525 reproduced ONE MORE bypass: `PtyHost.setBusy`'s `onBusy` persistence

Same root class as Round 2, a THIRD post-effect step: `PtyHost.setBusy` calls `this.events.onBusy(sessionId,
busy)` (which, in the real wiring, mirrors the flip to the DB AND drives the manager idle-notification —
`index.ts`'s `onBusy` → `db.setBusy`, then `notifyManagerOfIdleWorker`/`purgeStaleIdleNudgeForReengagedWorker`
— a callout failure can skip ANY of the three, not just the DB write) AFTER the busy transition's own real
effect, and `setBusy` has two callers that run it after a real side effect:
- `PtyHost.spawn()`'s own spawn-time optimistic set (`"spawn-startup-prompt"`) — called AFTER `createPty`
  has already returned a live pty process (NOT inside `createPty` itself). A throw here is Round 2's
  trigger (2), just reached through a different call (`setBusy` rather than `appendEvent`) — same
  "startNew looks failed, row marked exited, redelivery double-spawns" shape, reproduced with an alive pid
  + an "exited" row.
- `submit()`'s own trailing set (see above) — a throw here undoes the dedupe row after a wake-mode nudge
  had already gone out.

**The fix:** `PtyHost` gets ONE new private helper, `persistBusy(sessionId, busy)`, that wraps
`this.events.onBusy(...)` in a try/catch, logs on failure (naming that the busy persistence AND the manager
idle-notification it also drives may have been skipped — not just "informational" bookkeeping), never
rethrows. `setBusy` calls it instead of calling `events.onBusy` directly. The in-memory
`live.busy`/`live.busySince` flip stays UNCONDITIONAL — it happens before `persistBusy` is called, so a
caller that immediately checks busy state (e.g. a concurrent `enqueueStdin` queuing behind it) still sees
the correct value regardless of whether persistence succeeded. Checked first, per the ruling: grepped every
`onBusy` consumer and every test that makes `onBusy` throw — nothing relies on `setBusy`/`onBusy` throwing;
the existing "prespawn throw ⇒ marks exited" test family (`session-startmanager-prespawn-throw-marks-exited.mjs`
and its siblings) injects its throw at a DIFFERENT site (their own `createPty`/`resolveCodescapeInjectionStatus`
stub), never through `onBusy`, and all still pass unchanged.

## Round 3b — the SAME bug, on codex's sibling path (`setCodexBusy`)

A webhook's target agent can be codex-harnessed (a profile or the platform default names `harness:
"codex"`) — `PtyHost.setCodexBusy` had the IDENTICAL unguarded `this.events.onBusy(...)` call, reachable
synchronously from `enqueueStdin` → `enqueueStdinCodex` → `submitCodex` for an idle codex session. Note the
ordering difference from claude: `submitCodex` calls `setCodexBusy(true,"submit")` BEFORE its own text
write (the opposite of claude's `submit()`, which writes first), so a throw here means "nothing was
delivered yet" rather than a genuine double-fire — but it still violates the SAME invariant webhook
ingress depends on (`enqueueStdin` never throws), so it needed the identical fix regardless of ordering.

**The fix, done right the first time this round:** `persistBusy` is the ONE chokepoint for BOTH callers —
`setBusy` (claude) and `setCodexBusy` (codex) — never two separate try/catch copies. Confirmed by a source
scan (also pinned as a structural test case, see below) that `persistBusy` is the ONLY direct caller of
`events.onBusy(` in `host.ts`.

Deliberately NOT touched, per the reviewer's own ruling — each is its own card:
- The four sibling `discovery_block_injection` `appendEvent` call sites (`resume`-adjacent paths,
  `spawnWorker`, `recycleWorker`, `recycleManager`) — same shape as (A)'s `startNew` fix, not yet audited.
- `reconcileFailedSpawn`'s own orphan-pty behavior (it marks a row "exited" but does not verify the
  underlying process is actually dead) — a separate, pre-existing concern this card's fixes don't touch.

## Round 2 — a duplicate arriving while the first fire is still in flight (no code change; documents existing, unchanged behavior)

If delivery A's fire is in flight (its dedupe row already recorded, its 200 already sent) and a duplicate
delivery B for the SAME id arrives before A's fire settles, B's `hasWebhookDelivery` check finds A's row and
B is ACKed as a duplicate (`200 {duplicate:true}`) — B is dropped, not queued or retried. If A's fire then
fails and its row is undone, B is NOT automatically retried; the sender must redeliver again (a manual
Redeliver, or the provider's own at-least-once retry) for it to get a chance to fire. This is not a
regression from any round of this card — the merge-base already recorded the row before firing (Round 1's
fix moved WHEN inside that same window, not WHETHER a mid-flight duplicate sees it), so B's fate here is
unchanged by anything in this card.

## Do not

- Do not move `recordWebhookDelivery` back to right after the rate-limit check — that reopens the
  payload-parsing/reply-failure swallow window Round 1 closed.
- Do not add an `await` between the `hasWebhookDelivery` check and the `recordWebhookDelivery` INSERT — see
  Round 1's own reasoning above; a different concurrency mechanism would be needed to keep "at most once".
- Do not treat `enqueueStdin`'s `delivered:false` as a failure on its own — check `deliveryState ===
  "dropped"` (decision `13e32e1d`); a `"queued"` outcome is a success that will still deliver.
- Do not let `deleteWebhookDelivery` (in the fire's `.catch()`) or the `updateWebhookEndpointLastFired`
  best-effort wrapper suppress an unrelated error or escape as an unhandled rejection — both are try/caught
  and logged independently.
- **Do not undo the dedupe row for ANY throw from `fireWebhookTarget` without first asking whether the fire
  provably had no effect.** This is the Round 2 rule, and it is a STANDING one, not closed by Rounds 2/3
  fixing the two post-effect steps known at review time. A future post-effect step (inside
  `fireWebhookTarget` after its fire branch, inside `startNew`/`resume` after their own spawn succeeds, or
  inside `PtyHost.setBusy`'s own two callers) that can throw on failure MUST be made non-fatal (best-effort,
  its own try/catch) the same way — never let it become a new way for a successful fire to look like a
  failed one. See the "Scope of 'invariant restored'" note above: this is an open-ended obligation on future
  changes, not a closed proof about the current code.
- Do not "fix" wake mode's `resume()` the same way `startNew` was fixed — it does not have the same defect
  class (see the reviewer-confirmed reasoning above); doing so would be unnecessary convergence with no
  bug behind it. This does NOT extend to `submit()`'s own trailing `setBusy` call — that one WAS a real
  defect (Round 3) and is fixed at the root, in the shared `persistBusy` helper.
- Do not fix `events.onBusy`'s persistence non-fatality per call site (a guard inside `PtyHost.spawn()`,
  another inside `submit()`, a third inside `setCodexBusy`) — Rounds 3/3b's ruling is ONE fix, `persistBusy`, called
  by both `setBusy` and `setCodexBusy`. Do not add a future THIRD harness's busy-setter as a fourth direct
  `events.onBusy(` caller — route it through `persistBusy` too; the structural pin in
  `pty-setbusy-persistence-non-fatal.mjs` (case D) fails if a new direct caller appears anywhere in
  `host.ts` outside that helper.
- Do not expand this card to also guard the four sibling `discovery_block_injection` `appendEvent` sites or
  to touch `reconcileFailedSpawn`'s orphan-pty behavior — both are deliberately left for their own cards
  (Round 3's ruling).
- Do not read this record as proof `fireWebhookTarget` "mirrors `EventTriggerService.fire`'s own wake/spawn
  branching exactly" — that historical claim went stale when that path moved to
  `SessionService.enqueueDurableNudge` (card 90b9e904); the two are similar in shape, not converged, and
  card 90b9e904 owns any future convergence, not this card.
