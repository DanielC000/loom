# 7a64f16b — a lone stale give-up signature needs CONTENT ANCESTRY, not just uniqueness, before it resolves

Found by `a0735d53`'s own worker during investigation, and already flagged there as a known, pre-existing,
deliberately-deferred limitation (see `docs/decisions/a0735d53-giveup-lineages-release-ungated-from-clearprefix-gate.md`'s
"Known pre-existing limitation" section, now updated to point here).

## The bug

`purgeConfirmedGiveUpRequeueCore` (`packages/daemon/src/pty/host.ts`) resolves a content match purely on
signature equality once exactly one logicalId holds it (`matchedLogicalIds.length === 1`) — with no check
on whether the confirming hook's own text is actually that lineage's own echo, versus simply being the
CURRENT, legitimately-outstanding generation's own fresh, UNRELATED submission that happens to share
byte-identical text with an older, stale `ambiguousDispatches`/`retiredGiveUpSignatures` entry. `bc0774c4`'s
ambiguity decline only guards a match spanning MORE than one distinct logicalId — it does not guard this
single-stale-entry-vs-fresh-unrelated-text case at all.

Deterministic repro (see `packages/daemon/test/pty-giveup-lone-signature-ancestry.mjs` scenario (a)): a
lineage L1 gives up on short text ("continue"), archiving its signature as the sole holder. A totally
separate, never-given-up, self-rooted dispatch G3 — confirmed via its own expected hook — happens to carry
byte-identical text. Pre-fix, G3's own confirmation wrongly resolved L1: its `giveUpLineages` mark was
released, its requeued duplicate was purged from `live.pending`, and `onGiveUpConfirmed` fired for L1.

## Consequence: genuine loss, window-dependent

`GIVE_UP_HOLD_MS` defaults to 20s — the requeued duplicate drains normally (an intended duplicate-delivery
fallback) once that hold expires, unless purged first. If the false match lands **while** the duplicate is
still held, it is deleted before it would have naturally redelivered — since the original write never
actually landed, this is a genuine, silent, permanent loss. If it lands **after** the hold already expired
(duplicate already delivered for real), the consequence degrades to cosmetic: a spurious `onGiveUpConfirmed`
fire, an early/wrong `composerDirtyLen` clear, and a wrongly-released `giveUpLineages` mark.

Aggravated sub-case: if the stale lineage had already reached PARKED (its requeue+remint budget exhausted,
a `[loom:redelivery-parked]` notice already sent to its manager), the false match ALSO fires
`sessions.handleGiveUpConfirmed`, sending a FALSE `[loom:redelivery-confirmed]` notice claiming the parked
message "has now been CONFIRMED delivered" — a false all-clear about a message that was never actually
resolved. See `packages/daemon/test/pty-giveup-lone-signature-ancestry-parked.mjs`.

## The fix: content ancestry, not a generation-number proxy

`live.lastPrompt` is the currently-outstanding write's own text (set by `submit()` in lockstep with
`enterConfirmed=false`/`++submitGeneration`). When `submitWasOutstanding` is true AND the confirming hook's
content ALSO equals `live.lastPrompt` (i.e. this hook is at least explainable as the current generation's
own confirmation), the matched lineage is resolved ONLY if it is genuinely that SAME identity:

- no later WRITE has happened since the matched entry's own archived batchId (the common self/retry/probe-C
  shape — `requeueGiveUpOrigin` nulls `live.giveUpOrigin` at give-up time, so that field alone cannot
  answer this for a chain with no later write) — checked against `Live.lastWriteGeneration`, a field
  stamped ONLY at submit()'s own actual write, never the raw `submitGeneration` counter (see Round 2
  below for why that distinction is load-bearing), **or**
- a later write's own `live.giveUpOrigin` shares the matched logicalId (the auto-joined-resend shape, card
  `844ca34e` round 3).

Otherwise the match is DECLINED — same "handled, not resolved" shape as the pre-existing `bc0774c4`
ambiguous-decline branch.

### Why not a bare generation-number comparison

A first draft gated on `resolvedBatchId !== live.submitGeneration` alone, whenever `submitWasOutstanding`
was true. Two real counter-examples killed it:

1. **A genuine late echo of an older lineage, while an unrelated DIFFERENT-text write is outstanding.** L1
   gives up on "continue"; G3 (different text, "foo") is written and still outstanding; L1's own REAL late
   echo ("continue") then arrives. This hook unambiguously belongs to L1 (content doesn't even match G3's
   own text) and must resolve — but a bare generation-number gate declined it, since `resolvedBatchId`
   (L1's) ≠ `live.submitGeneration` (G3's), with no regard for content at all. See scenario (b) in the test.
2. **An auto-joined resend of the SAME identity, at a LATER generation than its own archived batchId.**
   `pty-giveup-resend-bypass-unsuppressed-park.mjs` scenario (1): a manual resend auto-joins an
   already-parked root's SAME logicalId (`hasAmbiguousMatch`) and lands its own write at a brand-new,
   later generation. The archived entry's own batchId is still the ORIGINAL (much earlier) generation. A
   bare generation-number gate wrongly declined this self-confirmation too, breaking a pre-existing,
   already-tested recovery path.

Both are fixed by checking actual identity (via `live.giveUpOrigin`) instead of a numeric proxy.

## Round 2 (Code Review MAJOR, blocking) — `submitGeneration` is not "last write"

Round 1 shipped with arm 1 keyed on `resolvedBatchId === live.submitGeneration`. That assumes "the counter
is unchanged ⇒ nothing has been written since." **False.** Every site that increments `submitGeneration`,
classified by whether it corresponds to an actual write:

| Site (`pty/host.ts`) | Writes? |
| --- | --- |
| `submit()`, `const gen = ++live.submitGeneration` | **YES** — the one real write path |
| `healIfStuck`'s out-of-band stale-busy branch | NO — bumps only to invalidate a stale verify-retry chain |
| `stop()`'s graceful/hard entry | NO — same, for a deliberate stop |
| `interruptForRedirect`'s Esc-cancel | NO — same, for a redirect interrupt |

`healIfStuck` bumps `submitGeneration` AND calls `requeueGiveUpOrigin` (nulling `live.giveUpOrigin`) while
`enterConfirmed` stays false and `lastPrompt` stays the stranded lineage's own text. A heal firing between
a lineage's give-up and that SAME lineage's own genuine late echo therefore broke BOTH arms at once (arm 1:
batch no longer equals the bumped counter; arm 2: `giveUpOrigin` is null) — DECLINING a genuine self-
confirmation that worked before this card ever existed. The Code Reviewer reproduced this exactly (an 8s
hold, `genBeforeHeal=1 genNow=2 ... DECLINED ... duplicateStillQueued=true`) and confirmed it vanishes with
the decline check removed entirely.

**Fix:** `Live.lastWriteGeneration` — a NEW field, stamped ONLY inside `submit()` at its own `const gen =
++live.submitGeneration` line, never at any of the three no-write sites above. Arm 1 now compares a
matched entry's own batchId against `lastWriteGeneration`, which a no-write bump can never move. Test:
`packages/daemon/test/pty-giveup-lone-signature-ancestry-heal.mjs` — directly backdates
`live.busySince`/`live.lastOutputAt` (no real-time wait, no fake engine output needed — `healIfStuck`'s own
guard is a bare staleness check) to force the heal branch deterministically, then proves a genuine late
echo still resolves afterward.

### `resumeAfterRateLimit` — a related, narrower gap, fixed where safe

`resumeAfterRateLimit`'s two replay call sites passed NO origin at all (a pre-existing, documented choice:
"a give-up there has no origin to restore — unchanged"). Investigated whether this reopens the SAME
declined-echo shape: tracing it, `retireResolvedArchiveEntries` (called on every `turnEnded:true` hook,
including the rate-limiting StopFailure itself) sweeps a logicalId's retired signature the instant nothing
in `ambiguousDispatches`/`live.pending` still references it — and a redrain already moves a giveUpGen-
tagged entry's "current" slot to `retiredGiveUpSignatures` BEFORE a rate limit can even hit it (card
`4a0af485` Major 2). By the time the rate-limiting StopFailure fires, the one retired signature a LATER
replay-confirmation could have coincidentally matched is already swept — so the single-prior-cycle
"declined when it should resolve" shape could not be constructed as a reachable repro. This is a scoped
report, not an exhaustive one: a coalesced multi-member origin or a second pending duplicate under the
same logicalId were not tried.

What WAS fixed, as a small and safe change (capturing `live.giveUpOrigin` before the replay, since a
rate-limited StopFailure proves `enterConfirmed` so no pending give-up can null it out from under this
read): the replay now carries that identity forward on both its paths (`submit()`'s own `origin` param
directly; `enqueueStdin`'s `logicalId` tail override for the head member on the blocked path). This closes
a MORE SEVERE, directly-reachable consequence on the common (non-blocked) path specifically — pre-fix, if
the replay itself then genuinely gave up, `requeueGiveUpOrigin` early-returned on `!origin`: not a wrongly-
declined ancestry match, but a bare, silent, untraceable DROP (no archive, no requeue, nothing left in
`live.pending`). Test: `packages/daemon/test/pty-giveup-rate-limit-replay-origin.mjs`.

Side effect, not a new behavior: with the origin now passed on the non-blocked path, `submit()` takes
owner-text and sender attribution from the origin members themselves (`m.ownerText`/`m.ownerTextSeq`/
`originSenderId`, derived from `origin[0].senderId`) instead of the `live.lastPromptOwnerText`/
`lastPromptOwnerTextSeq`/`lastPromptSenderId` params the replay also still passes as fallbacks — identical
in the normal case (those fields were themselves originally derived from the SAME origin members at the
killed turn's own write time), and more correct whenever a raw-terminal turn had separately set
`lastPromptOwnerText` out of band.

### Scope: this fix covers raw `enqueueStdin` producers and retired-signature-only matches

Same-text DURABLE dispatches (worker/manager/human messages, anything routed through
`sessions/service.ts`'s `enqueueDurableMessage`) already auto-join an EXISTING, STILL-AMBIGUOUS lineage's
identity via `hasAmbiguousMatch` (the `4a0af485` contract) BEFORE they ever reach PtyHost as a distinct
logicalId — for that call shape, with that one precondition, the coincidental-collision bug this card
fixes was already structurally avoided. This fix's own reachable surface is: (1) a message minted via a
RAW `PtyHost.enqueueStdin` call that bypasses `enqueueDurableMessage`/`hasAmbiguousMatch` entirely (several
call sites in `host.ts` do this directly — kickoff, system injects, give-up remint); (2) a durable dispatch
whose `rootMsgId`/`resendOf` is already set (so `hasAmbiguousMatch` is skipped) coincidentally matching an
UNRELATED lineage; (3) a match against `retiredGiveUpSignatures` specifically, which `hasAmbiguousMatch`
never consults at all (by design — only a PROVEN engine confirmation may use the retired store, never a
dispatch-time guess); and (4) the heal/rate-limit-replay paths above, which have no auto-join concept at
all. No code change was made to `hasAmbiguousMatch`/the auto-join contract itself.

### The `4a0af485` CONFIRMED-gen measurement log also fires on a decline — narrowly

The decline path returns `resolved:true`, which — unpatched — would suppress the UserPromptSubmit
handler's own `4a0af485` DoD#4 log (`CONFIRMED gen=... logicalId=...`), gated on
`hadNoAmbiguityBeforeThisHook && !resolvedByContentMatch`. That OUTER `hadNoAmbiguityBeforeThisHook` gate
(`live.ambiguousDispatches.size === 0`) already suppresses this log for the common decline shape — the
matched entry itself is what keeps `ambiguousDispatches` non-empty — so the fix below changes nothing for
that case. It matters only in the narrower sub-case where the match comes from
`retiredGiveUpSignatures` ALONE (`ambiguousDispatches` otherwise empty): there, a decline HAS positively
attributed the hook to the current generation, just not resolved the retired-only lineage via it, so
suppressing the log would under-count the corpus for exactly that sub-case. Fixed by threading a
`declinedButCurrentGeneration` flag back through `purgeConfirmedGiveUpRequeue`'s return value and
widening the log's own inner gate to `!resolvedByContentMatch || declinedButCurrentGeneration` — reusing
the ONE existing log site rather than duplicating its computation at the decline call site; the OR can
only ADD cases where it fires, never remove one that already fired, so it cannot regress the
existing measurement corpus either way. Test: `pty-giveup-lone-signature-ancestry.mjs` scenario (e) —
directly seeds `retiredGiveUpSignatures` with `ambiguousDispatches` cleared (the shape a redrain would
otherwise produce) to reach the sub-case where the widening is externally observable, and asserts both
the `DECLINED content match` and the widened `CONFIRMED gen=` log fire for the same hook.

## Do not

- Do not gate the decline on `resolvedBatchId !== live.submitGeneration` alone — that bare generation-number
  comparison declines a genuine late echo of an older lineage whenever some OTHER, differently-texted write
  happens to be outstanding at the same moment, and also declines a legitimate auto-joined resend of the
  SAME identity at a later generation than its own archived batchId. Content ancestry (does the hook's
  content match `live.lastPrompt`?) plus logical identity (`live.giveUpOrigin`, or same-batch-as-
  `lastWriteGeneration`) is the discriminator, not generation numbers.
- Do not compare against the raw `live.submitGeneration` counter for the same-batch arm, even after Round 2
  — use `live.lastWriteGeneration` (stamped ONLY at submit()'s own actual write). `submitGeneration` is ALSO
  bumped by three no-write, out-of-band paths (`healIfStuck`, `stop()`, `interruptForRedirect`) that
  invalidate a stale verify-retry chain without ever writing anything — comparing against it directly
  reopens Round 2's exact regression (see that section above).
- Do not assume `live.giveUpOrigin` persists across a give-up as a reliable "current write's own identity"
  signal on its own — `requeueGiveUpOrigin` NULLS it at give-up time (consumed exactly once, as a handoff).
  It is only reliable for a write that happens AFTER a give-up; for "nothing new has been written since
  the matched entry's own batchId," use the same-batch-as-`lastWriteGeneration` check instead.
- Do not treat this as closing the content-match mechanism's remaining coincidental-collision surface
  entirely — a match spanning the CURRENT generation's own identity is still trusted by content alone, same
  as before this card; this only closes the specific lone-stale-entry-vs-unrelated-fresh-text gap, and only
  for the reachable surface named in "Scope" above (a durable dispatch that legitimately auto-joins via
  `hasAmbiguousMatch` was never exposed to begin with).
- Do not re-derive the `resumeAfterRateLimit` residual analysis above by hand next time it's touched — read
  the Round 2 section's own tracing of `retireResolvedArchiveEntries`'s sweep timing first; it is not an
  exhaustive proof of unreachability (see its own scoping caveat).
