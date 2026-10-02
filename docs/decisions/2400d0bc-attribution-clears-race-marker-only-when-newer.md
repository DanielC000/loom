# 2400d0bc — the race-discard marker clears only on a NEWER owner-text attribution, never on any re-attribution

## Context

Card `d326c3c2` made `attributeOwnerText` unconditionally clear `Live.raceDiscardedOwnerSubmitAt`/`raceDiscardedOwnerSubmitGen` the instant it ran, on the theory that any fresh owner attribution proves "the owner's most recent turn is no longer missing." That theory holds for an attribution that's genuinely NEW, but not for one that's just RE-ATTRIBUTING an owner turn that was already current *before* the race happened.

Two concrete paths re-attribute an older turn:

1. **Rate-limit replay.** Owner composer turn X is submitted (Enter outstanding). A raw-terminal line R races in before X's own confirming `UserPromptSubmit` hook fires; that hook discards R and sets the race-discard marker (X's own attribution already happened earlier, at X's original `submit()`). X then dies to a rate limit and parks. `resumeAfterRateLimit` replays X via `live.lastPromptOwnerText`, which re-invokes `attributeOwnerText(live, X)` — clearing the marker even though X predates the race it's being asked to explain away.
2. **A queued composer entry drained late.** Owner composer turn Y is enqueued (queued because the session was busy) *before* R races in. The race sets the marker while Y still sits in `live.pending`. When the busy turn ends, Y drains and `attributeOwnerText(live, Y.ownerText)` runs — again clearing a marker that predates Y's own capture.

In both cases `question_resolve`'s fallback (`resolveOwnerTextForQuestionResolve`, `mcp/questionTool.ts`) would then quote the stale pre-race turn as if it were the owner's latest word, exactly the bug `d326c3c2` existed to prevent.

An earlier fix attempt tried clearing the marker only on a `submitGeneration` advance — that reopened the bug `d326c3c2` fixed outright (see `d326c3c2`'s own Code Review correction note in `attributeOwnerText`): generation advances on every submit, owner-authored or not.

## Decision

`attributeOwnerText(live, ownerText, capturedSeq?)` takes an explicit rank. It only clears the race-discard marker when `capturedSeq` strictly outranks `live.raceDiscardedOwnerSubmitSeq`.

The rank is a **monotonic per-session sequence counter** (`Live.ownerAttributionSeq`, minted via `nextOwnerAttributionSeq`), never wall-clock time. An early attempt at this fix used `Date.now()` for `capturedAt` and failed its own regression test (`pty-owner-attestation.mjs` test 17) under fast, synchronous test execution: two causally-ordered events can land in the same millisecond, so a strict `>` comparison on wall time can wrongly treat a genuinely later attribution as "not newer" and leave the marker stuck. A counter has no such tie — every mint is strictly greater than the last, regardless of how fast the calls happen.

The rank is threaded through every call site that can replay or late-drain an OLDER owner turn:

- `Live.lastPromptOwnerTextSeq` records the real rank of `lastPromptOwnerText`, stamped only inside `attributeOwnerText` (never re-minted at replay). `resumeAfterRateLimit` reads it and passes it through — to `submit()`'s own trailing `ownerTextSeq` parameter on the direct-replay path, and via `EnqueueStdinTail.ownerTextSeq` on the blocked (queued) replay path.
- `QueuedMessage.ownerTextSeq` records the same thing for a queued composer/agent entry, minted once by `enqueueStdin` at enqueue time (a fresh mint there IS the real rank for an ordinary, non-replay caller) and read back unchanged whenever that entry eventually drains through `submit()`'s origin-array attribution loop.
- `Live.raceDiscardedOwnerSubmitSeq` is minted at the same moment as `raceDiscardedOwnerSubmitAt` (the discard site in `deliverHook`'s `UserPromptSubmit` handling).

Every ORDINARY (non-replay) attribution path — a live composer submit, a raw-terminal Enter, a fresh companion inbound — mints a fresh rank at (or very near) the instant it's authored, so it still outranks any existing marker and the marker still clears exactly as before. Only a genuine re-attribution of an OLDER turn, carrying its original (lower) rank, is now refused.

## Do not

- Do not use wall-clock time (`Date.now()`) for this ordering — see the test-17 failure above; use `live.ownerAttributionSeq` via `nextOwnerAttributionSeq` instead.
- Do not mint a FRESH seq for `resumeAfterRateLimit`'s replay or a late-draining queued entry — that silently reintroduces this exact bug by making a stale turn outrank the marker.
- Do not revert to a `submitGeneration`-advance gate — `d326c3c2`'s own Code Review already proved that gate wrong (generation advances on every submit, not just an owner one).
- Do not widen this ordering check into a general "never clear the marker twice" rule — it keys purely on rank vs. the marker's rank, nothing else.

## Follow-up (card 270b963c, Code Review 81bb4927)

**Gap 1 — a third hand-rebuilt requeue site missed the rank.** `sessions/service.ts`'s
`upgradeCompanionCapabilities` rebuilds each flushed `QueuedMessage` by hand into `enqueueStdin` at two
call sites (the still-alive-pty requeue, and the post-`resume()` requeue) — a THIRD shape of "re-enqueue an
existing `QueuedMessage`" this card's own list above didn't enumerate, because it predates this card and
was never audited against it. Neither site threaded `msg.ownerTextSeq`, so a requeued entry that still
carried its own `ownerText` would mint a FRESH rank at `enqueueStdin` call time — exactly the defect this
record exists to prevent, on a caller this record never named. Unreachable in production today (the
companion-upgrade path is assistant-role only; assistant sessions never set the race-discard marker in the
first place), but the missing-field default was in the wrong direction (silently clears) rather than
fail-closed.

Fixed structurally rather than by enumerating a fourth call site by hand: `PtyHost.requeueQueuedMessage
(sessionId, msg, tail?)` is now the ONE shared unit every re-enqueue of an existing `QueuedMessage` must go
through — it carries `msg.ownerTextSeq` automatically (ahead of whatever `tail` the caller supplies), so a
future caller that forgets to mention it can no longer silently drop it. See its own decision record,
`270b963c`, for the full mechanism; `upgradeCompanionCapabilities`'s two sites now call it.

**Gap 2 (addressed, not a defect) — `resolveOwnerTextForQuestionResolve`'s active-turn path never
consults rank at all.** `question_resolve`'s derivation (`mcp/questionTool.ts`) only checks
`hasRaceDiscardedOwnerSubmit` in its FALLBACK branch (`activeOwnerText === null`). When there IS an active
turn, its owner text is returned unconditionally — even if a race-discard marker was set in between by a
LATER, unrelated submit this active turn has nothing to do with. Ruled **leave unchanged**: the active
turn's owner text is genuinely that turn's text, correctly reported regardless of what happened to some
other, later submit — the marker exists to guard the FALLBACK's "there is no active turn, so quote the
most recent owner turn instead" inference, not to second-guess an active turn that is still, truthfully,
active. Ranks are available now and COULD be compared here, but there is no real ambiguity to resolve by
doing so — see `resolveOwnerTextForQuestionResolve`'s own doc comment for the same note at the call site.

**Round 2 note (card `270b963c`, manager review): both the marker and `recentOwnerTurns` reset per Live,
which fails closed today.** `raceDiscardedOwnerSubmitAt`/`Gen`/`Seq` and `ownerAttributionSeq` all
re-initialize to their empty/zero state on every fresh spawn (including a `resume()`), and
`recentOwnerTurns` is likewise seeded `[]` at every one of those same spawn sites — so a resume never
carries a stale marker or a stale recent-turns window across the boundary; both start genuinely clean in
the new Live. This is why `pty-owner-attestation.mjs` scenario 22 (`resumeAfterRateLimit`'s BLOCKED-branch
rank carry) is GREEN on main today and only goes RED under a deliberate mutation (the tail's
`ownerTextSeq` override removed) — it is not, and has never been, a currently-failing case; it covers
EXISTING, already-correct behavior. Revisit this note if `recentOwnerTurns` (or the marker) is ever made
to survive a resume boundary — at that point a carried rank crossing the SAME boundary (card `270b963c`'s
own cross-Live fix) would need re-examining too, since the two are currently safe only because neither
state persists across the one boundary where a carried rank could reach them.
