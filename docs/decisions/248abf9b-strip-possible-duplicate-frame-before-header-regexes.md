# 248abf9b — strip the possible-duplicate frame before any start-anchored `[loom:...]` header regex

## Narrative

Found during the Code Review of card 84a0b357 (worker bf0b51b5): `handleGiveUpExhausted`
(`sessions/service.ts`) calls `framePossibleDuplicate(text, rootMsgId)` on ANY durable message's stored
text when it re-mints after an in-session give-up — unconditional on message kind. That wraps
`[loom:possible-duplicate root:<hex8>] ` ahead of whatever text was already there (`pty/host.ts`'s
`framePossibleDuplicate`). Any later consumer that applies a start-anchored (`^`) regex or `startsWith`
check to that same stored text — expecting to find ITS OWN tag at the true start of the string — silently
stops matching the moment a cross-remint has occurred, because the possible-duplicate tag is now in front
of it.

A Round 2 Code Review (a73fd0c4) on this card's first pass found a third site the original sweep missed
(`attemptPendingQueueCarry`'s `isStaleContextNudge`) and corrected the preview site's own remedy (the
possible-duplicate tag should be KEPT in the preview, not discarded, since it's the signal that the
refused instruction may be a duplicate the worker already acted on).

## Classification — every start-anchored `[loom:...]`-style check against durable/queued message text

One line per site, `file:line` as of this card's own commit, classified strips-already / needed-strip-now
(fixed by this card) / never-sees-framed-text (structurally immune or out of this card's scope):

- **`sessions/service.ts`, `workerReport`'s done-refusal preview (~line 13092)** — `FROM_MANAGER_HEADER_RE`
  applied to `e.detail.text`. NEEDED STRIP (fixed): now strips the dup tag, strips the impersonating
  `[loom:from-manager]` header off the remainder, then RE-PREPENDS the dup tag ahead of the header-stripped
  body (kept, not discarded — it's the duplicate-of-already-acted-on signal this preview exists to carry).
- **`sessions/service.ts`, `carryPendingToSuccessor` (~line 11614)** — `PEER_MESSAGE_FRAME_RE` applied to
  `rec.detail.text`. NEEDED STRIP (fixed): tests the dup-tag-stripped text, and when it matches, re-prepends
  the recovered dup-tag prefix FIRST, ahead of the new `[loom:inherited-by-recycle]` label — so a LATER
  `stripPossibleDuplicateFrame` call still finds the tag at the true start.
- **`sessions/service.ts`, `attemptPendingQueueCarry`'s `isStaleContextNudge` (~line 15386)** — tests
  `CONTEXT_RECYCLE_NUDGE_PREFIX` / `[${CONTEXT_EMERGENCY_REDIRECT_TAG}]` against both the flushed `m.text`
  and the durable `rec.detail.text`. NEEDED STRIP (fixed): the durable emergency redirect
  (`redirectManagerForEmergencyRecycle` -> `deliverRedirect` -> `enqueueDurableMessage`) is re-minted
  through the same `handleGiveUpExhausted` path on give-up, which silently defeated this purge and carried
  a stale "recycle now" redirect to the fresh successor. Fixed once, at the top of the shared
  `isStaleContextNudge` closure, covering both call sites.
- **`pty/host.ts`, `isUntaggedSystemNudge` (~line 2816)** — `!text.startsWith("[loom:")`. NEVER SEES
  FRAMED TEXT AS A PROBLEM: a dup-wrapped text still starts with `"[loom:"` (the dup tag is itself
  `[loom:possible-duplicate...`), so this check cannot misfire on a framed text regardless. Also
  documented LOG-ONLY (never drops/modifies).
- **`pty/host.ts`, `isPasteRecoveryAttempt`'s caller (~line 10320) and `annotatePasteRecoveryAge`
  (~line 736)** — `PASTE_RECOVERY_TAG` checks. STRIPS ALREADY (cards 78e4b3f2, 4af5aefa) — the idiom this
  card's own fixes reuse.
- **`pty/host.ts`, the prompt-mismatch loop-breaker (~line 9305)** — `PROMPT_MISMATCH_*_TAG` checks.
  STRIPS ALREADY (card 84a0b357, this card's own parent).
- **`sessions/service.ts`, the worker-report prefix check (~line 13741)** — `[loom:worker-report]`
  prefix. STRIPS ALREADY.

No other start-anchored `[loom:...]`-style regex or `startsWith` check against durable/queued message
text exists anywhere else in `packages/daemon/src` (verified via a repo-wide grep for `startsWith(` +
`[loom`, `.test(` + `loom:`, and `new RegExp`/literal `/^\[loom` at the time of this card).

## Do not

- Do not apply `FROM_MANAGER_HEADER_RE`, `PEER_MESSAGE_FRAME_RE`, `isStaleContextNudge`'s own prefix
  checks, or any other start-anchored `[loom:...]`-style regex/`startsWith` check to durable or queued
  message text without first calling `stripPossibleDuplicateFrame` on it — a cross-remint via
  `handleGiveUpExhausted` can have wrapped a `[loom:possible-duplicate root:…] ` tag ahead of it at any
  time, for any message kind.
- Do not add a NEW such check anywhere in this file without the same strip — grep for
  `stripPossibleDuplicateFrame` usage first to find the established idiom before hand-rolling a new one.
- When re-labelling a re-minted message (e.g. `carryPendingToSuccessor`'s inherited-by-recycle label),
  keep the possible-duplicate tag FIRST in the final text, ahead of the new label — never let a label
  bury it, or a LATER `stripPossibleDuplicateFrame` call can no longer find it at the true start.
- Do not discard the possible-duplicate tag when building a human/worker-facing PREVIEW of a durable
  message — re-prepend it after stripping only the impersonating header it was wrapping. The tag is
  itself useful signal (this instruction may be a duplicate of one already acted on), not noise.

## Source

Inline comments in `packages/daemon/src/sessions/service.ts`, at each of the three fixed sites above, as
of this card's own commit.
