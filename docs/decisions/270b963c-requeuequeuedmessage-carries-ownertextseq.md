# 270b963c — `requeueQueuedMessage` carries an existing `QueuedMessage`'s `ownerTextSeq` automatically

## Narrative

Code Review `81bb4927` of `2400d0bc` flagged a latent defect of the same class `2400d0bc` itself fixed:
`sessions/service.ts`'s `upgradeCompanionCapabilities` rebuilds each flushed `QueuedMessage` by hand into
`enqueueStdin` at two call sites (the still-alive-pty requeue and the post-`resume()` requeue), threading
`giveUpHeldUntil`/`onGiveUpExhausted`/`logicalId`/`mintedAtGen`/`mintedAtWallClock` through the tail
object — but never `ownerTextSeq`. Per `2400d0bc`'s own invariant, `enqueueStdin` mints a FRESH
`ownerTextSeq` (via `nextOwnerAttributionSeq`) whenever the caller omits an explicit override, and
`attributeOwnerText` clears `live.raceDiscardedOwnerSubmitSeq` the instant it sees a rank that outranks
the marker. A dropped `ownerTextSeq` on a requeued entry that still carries its own `ownerText` therefore
mints a rank representing "now" rather than the turn's real, earlier capture time — which can outrank and
wrongly clear a race-discard marker set in between. This is unreachable in production today (the
companion-upgrade path is assistant-role only, and assistant sessions never set the marker in the first
place), but the defect is in the DEFAULT direction (missing ⇒ clears) rather than fail-closed.

Fix: `PtyHost.requeueQueuedMessage(sessionId, msg, tail?)` is the one shared unit every re-enqueue of an
EXISTING `QueuedMessage` goes through. It carries `msg.ownerTextSeq` automatically (alongside the other
positional fields `enqueueStdin` itself reads straight off `msg`: `text`/`source`/`onDeliver`/`route`/
`kind`/`questionId`/`ownerText`/`proactive`/`senderId`), ahead of whatever `tail` the caller supplies — so
an explicit override in `tail` still wins, but a caller that simply forgot to mention `ownerTextSeq` can
no longer silently drop it. `upgradeCompanionCapabilities`'s two requeue sites now call this helper,
passing only the tail fields that differ between them (e.g. `mintedAtGen` omitted across the `resume()`
boundary per card `02baa3a5`).

Companion fix (same review, item 2): `attributeOwnerText`'s own fail-closed direction — an attribution
whose rank is genuinely UNKNOWN (no `capturedSeq` was ever captured, as opposed to "a fresh mint was
explicitly requested") must never clear the marker, since an unknown rank cannot be proven to outrank it.
`attributeOwnerText(live, ownerText, capturedSeq)` already only clears when `seq > live.raceDiscardedOwnerSubmitSeq`
(2400d0bc's own comparison) — the remaining gap was never in that comparison, but in callers failing to
supply the real captured rank in the first place, which this card's `requeueQueuedMessage` closes.

**Round 2 (manager review): the first round still left one hole — a MISSING rank reached `enqueueStdin`
as `undefined`, not as an explicit "unknown".** `requeueQueuedMessage` originally passed
`ownerTextSeq: msg.ownerTextSeq` verbatim; a `msg` whose own rank was never recorded is `undefined`, and
`undefined` is exactly what `enqueueStdin` reads as "no override supplied — ordinary fresh capture, mint a
rank now" (the contract every normal producer relies on). So a requeue of a rank-less entry still minted a
FRESH, necessarily-outranking seq — the identical bug this whole record exists to close, one layer
removed. Fixed by giving `ownerTextSeq` a genuine third state, not just two: `undefined` stays "not
supplied — fresh capture, mint" (unchanged for every ordinary producer); a real number is "known rank, use
it verbatim" (2400d0bc's existing behavior, unchanged); `null` is a NEW, explicit "rank is UNKNOWN — never
mint, never outranks" sentinel. `requeueQueuedMessage` now sends `msg.ownerTextSeq ?? null` (collapsing
both "never recorded" and "explicitly unknown" onto the same sentinel); `attributeOwnerText` treats
`capturedSeq === null` as incapable of ever outranking the marker (skips the clear entirely, and stores
`null` on `Live.lastPromptOwnerTextSeq` too, rather than fabricate a rank the entry never had); and
`resumeAfterRateLimit`'s two replay call sites — which used to coerce `live.lastPromptOwnerTextSeq ??
undefined` — now pass the field through verbatim, so `null` survives a SECOND hop (an unknown-rank entry
that itself later gets rate-limited and replayed) too.

**Round 3 (Code Review `97e0a1f1`, Round 2 of manager review): a rank is only valid WITHIN one Live, same
as `mintedAtGen`.** `sessions/service.ts`'s `upgradeCompanionCapabilities` has TWO requeue loops — one
requeues onto the SAME still-alive pty (no Live change), the other runs AFTER `resume()` has already
spawned a FRESH pty (a fresh Live, whose `ownerAttributionSeq` counter restarts at 0). The post-resume
loop called `requeueQueuedMessage(sessionId, msg, { mintedAtGen: undefined, ... })` — deliberately
omitting `mintedAtGen` for exactly this cross-Live reason — but left `ownerTextSeq` to
`requeueQueuedMessage`'s own default carry (`msg.ownerTextSeq ?? null`), which passes a REAL predecessor
rank (e.g. `7`, from the OLD Live's counter) through unchanged. That predecessor rank can outrank a
race-discard marker set EARLY in the fresh Live (e.g. rank `1`, since its own counter restarted at 0),
wrongly clearing it — the `2400d0bc` bug one layer removed, on a caller this record's first two rounds
both audited but didn't catch (the bug needs a resume boundary specifically, not just a requeue).
Unreachable in production today (the companion-upgrade path is assistant-role only; assistant sessions
never set the marker), but introduced by this branch's own Round 1/2 work, not pre-existing.

Fixed by passing `ownerTextSeq: null` explicitly at the post-resume call site — "unknown in this Live's
rank space," never the predecessor's real number — mirroring `mintedAtGen: undefined`'s own reasoning one
line above it. The still-alive-pty requeue loop (same Live, no boundary crossed) is UNCHANGED — its
default carry of `msg.ownerTextSeq` remains correct there, same as `mintedAtGen` staying carried there too.
`requeueQueuedMessage`'s own doc comment (`pty/host.ts`) now states this rule directly: a rank, like
`mintedAtGen`, is only valid within the ONE Live it was minted in; a cross-Live requeue must override the
default carry with an explicit `null`.

Test: `companion-live-upgrade.mjs`'s "CROSS-LIVE ownerTextSeq" block — an owner turn attested pre-upgrade
bumps the OLD Live's rank counter past zero; the next owner-attested message queues (held) while the old
pty is stopping, carrying that real predecessor rank; the upgrade resumes into a fresh Live; a race IN
THE FRESH LIVE sets the marker at the fresh Live's own first rank; the carried entry finally drains as its
own turn. Verified RED on commit `4f959010` (the tip before this fix — the carried entry's real
predecessor rank outranks and clears the fresh Live's marker) and GREEN after.

## Do not

- Do not re-rebuild a `QueuedMessage` by hand into `enqueueStdin` anywhere a message's OWN prior
  `ownerTextSeq`/`ownerText`/`source`/`route`/`kind`/`questionId`/`proactive`/`senderId` must be
  preserved — call `PtyHost.requeueQueuedMessage(sessionId, msg, tail)` instead, so a future field this
  method's positional-field list doesn't yet cover gets the same scrutiny the next time one is added.
- Do not pass a caller-supplied `ownerTextSeq` override through `tail` unless the entry being requeued is
  genuinely re-attributing an EARLIER turn's text (the `resumeAfterRateLimit` shape) OR crossing a resume
  boundary into a fresh Live (the `null` override, Round 3 below) — the default (`msg.ownerTextSeq ??
  null`) is correct for every other (same-Live) requeue.
- Do not let `requeueQueuedMessage`'s default carry (`msg.ownerTextSeq`) cross a RESUME boundary — a rank
  is only valid within the ONE Live it was minted in, exactly like `mintedAtGen`; a caller requeuing into a
  fresh Live (a `resume()` happened since the entry was minted) must override with an explicit
  `ownerTextSeq: null` in `tail` (Round 3 below).
- Do not read a requeue site's own silence on `ownerTextSeq` as evidence it never mattered — it mattered
  the instant the race-discard marker (`2400d0bc`) existed as a consumer; a future field with the same
  "invisible until a specific race" shape deserves the same structural (not call-site) fix.
- Do not let `ownerTextSeq: undefined` ever reach `enqueueStdin` from a REQUEUE caller — `undefined` there
  means "mint a fresh rank," which is correct ONLY for an ordinary fresh-capture producer, never for a
  requeue of a message whose own rank may be missing. Coerce a missing rank to the explicit `null`
  sentinel instead (`requeueQueuedMessage` already does this; a future requeue-shaped helper must too).
- Do not coerce `null` back to `undefined` anywhere on a replay path (the bug `resumeAfterRateLimit`'s two
  call sites had before this round) — `null` must survive every hop, however many times an unknown-rank
  entry gets requeued/replayed again, or it silently reopens this exact defect on the Nth hop.

## Source

`packages/daemon/src/pty/host.ts` (`PtyHost.requeueQueuedMessage`, added alongside `enqueueStdin`);
`packages/daemon/src/sessions/service.ts` (`upgradeCompanionCapabilities`'s two requeue loops, converted
to call it). Card `270b963c`, discovered from Code Review `81bb4927` of `2400d0bc`.
