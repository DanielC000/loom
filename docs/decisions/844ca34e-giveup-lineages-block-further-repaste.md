# 844ca34e — `Live.giveUpLineages` + `Live.composerOwnerLineage`: no re-paste while a different lineage's unconfirmed body sits in the composer

## Round 1 (superseded by round 2 below — read round 2 first)

Investigation (two real specimens, worker `3e9e4522`/`ea677c89`, byte-exact log reconstruction) found that
`submit()`'s "composer possibly dirty — clearing defensively" branch (the backspace+repaste fallback) fires
again on a kickoff re-mint's own first attempt, every time it re-mints. A re-mint is a brand-new
`QueuedMessage` object, so the old `isGiveUpRedelivery` check (`origin.every(m => m.giveUpGen !==
undefined)`) can never recognize it as a redelivery of a lineage that already gave up — it only ever
protected a SAME-msgId redelivery. Round 1's fix: `Live.giveUpLineages` (a `Set<string>` of `logicalId`)
marks every lineage that has given up at least once, and `submit()` took Enter-only UNCONDITIONALLY for
any marked lineage, regardless of `composerDirtyLenBelieved`/`composerDirtyLen` trust (card `4796f999`'s
gate).

**Round 1 was WRONG** (Code Review 8555d247, round 2 below) — it answered "has this lineage ever given up"
but never "whose text is CURRENTLY in the composer." Those are different questions, and round 1 silently
reopened exactly the fusion/substitution risk card `4796f999` was built to prevent.

## Round 2 — ownership, not just lineage history

Two real shapes the Code Review traced:
- **Shape 1**: lineage A gives up, then a genuinely DIFFERENT lineage B clears+pastes its own body and
  ALSO gives up. Round 1 would have A's later redelivery go Enter-only (A is marked) and press Enter
  against B's still-unconfirmed body — on a real terminal, that submits B's content under A's identity: A
  lost, B delivered twice.
- **Shape 2**, seen live in `kickoff-giveup-content-mismatch.mjs`'s own log: a Loom-authored
  `[loom:prompt-mismatch]` NOTICE pastes and gives up, then a marked kickoff re-mint goes Enter-only — on
  a real terminal, that would submit the notice's text as the kickoff.

**The fix**: `Live.composerOwnerLineage` (`Set<string> | null`) tracks whichever logicalId(s) LAST
PHYSICALLY wrote the composer's current body — set at the same two write-sites `composerBodyWrittenForGen`
is (the clear+repaste branch, and the plain-paste branch when `composerDirtyLen === 0` at write time),
cleared at the same two decisive-confirm reset sites `composerDirtyLen` is (`UserPromptSubmit`/
`Stop`/`StopFailure`, gated on `composerDirtyLenClearedByGen === submitGeneration`). `submit()`'s branch
decision now reads:
- `composerDirtyLen > 0 && composerLen === 0 && lineageEverGaveUp` (this write's own lineage has given up
  before) → check OWNERSHIP: `composerOwnerLineage` must exactly equal this write's own origin logicalIds
  (same `.every()`/exact-set discipline fa27d262 already established for a coalesced batch). MATCH →
  Enter-only (safe: content-identity across one lineage's own attempts is structural — a same-msgId
  redelivery never mutates `text`, a re-mint's text is `framePossibleDuplicate(originalText, rootMsgId)`,
  a pure function of two values that never change for one lineage). MISMATCH (or owner unknown) → never
  Enter, never re-paste — `giveUpWithoutWriting` treats the cycle as an immediate give-up, converging
  through the ordinary bounded requeue/re-mint/park machinery (`requeueGiveUpOrigin`) without ever writing
  a single byte under the wrong identity.
- `composerDirtyLen > 0 && composerLen === 0` and this lineage has NEVER given up before → the ORIGINAL
  full clear+repaste branch, unchanged (this is always a FRESH lineage's own first attempt at clearing).
- `composerDirtyLen === 0` (genuinely clean) → the plain full-paste branch, UNCONDITIONALLY — ownership
  and lineage history are never even consulted here. This is ruling (d)'s own fall-through, the thing that
  prevents loss: a marked lineage's later re-mint still lands in full once the composer is actually clean,
  rather than being silently skipped via a no-op Enter against nothing.

Card `4796f999`'s own `composerDirtyLenBelieved === composerDirtyLen` trust check is RETIRED and its code
DELETED (not left dormant beside its replacement): `giveUpGen` is only ever assigned inside the SAME
`requeueGiveUpOrigin` call that adds the matching `logicalId` to `giveUpLineages`, so the old
`isGiveUpRedelivery` check that trust gate paired with was already PROVABLY SUBSUMED by `lineageEverGaveUp`
before ownership even entered the picture — keeping it as a second, narrower disjunct would have been dead
code, not defense in depth.

`c148f118`'s `composerDirtyLen`/`composerDirtyLenBelieved` accounting and reset semantics are UNTOUCHED —
round 2, like round 1, only changes which branch `submit()` takes, never the arithmetic.

**What this prevents, precisely stated** (narrower than round 1's own "never re-pastes" framing): no
re-paste while the composer holds a DIFFERENT lineage's own unconfirmed body. A lineage's FIRST-EVER
attempt, and any attempt while the composer reads genuinely clean, still pastes in full — this card only
blocks a marked lineage's SECOND+ physical write while something else (or nothing attributable) currently
occupies the composer.

## Do not

- Do not clear `giveUpLineages` anywhere — it is a permanent, Live-lifetime mark (a respawn gets a fresh
  `Live` and starts empty); clearing it would let a stale cycle re-paste a lineage this card already
  protected. (It IS bounded by count, like `ambiguousDispatches` — eviction is a memory-safety backstop,
  not a semantic clear; see the cap below.) **REVISED in Round 3 below**: releasing ONE id at the exact
  moment ITS OWN ownership is decisively confirmed resolved is safe — this blanket "never" is about a
  bulk/arbitrary clear, not that narrower, provably-safe case.
- Do not read `giveUpLineages` with `.some()` across a coalesced `origin` batch — use `.every()`, mirroring
  `isGiveUpRedelivery`/card `fa27d262`: a batch mixing a fresh, never-given-up member must still take the
  full clear+repaste, or that member's own body is silently dropped.
- Do not gate Enter-only on `composerDirtyLenBelieved === composerDirtyLen` (card `4796f999`'s retired
  trust check) — that question is dead; `composerOwnerLineage` is the real discriminator.
- Do not read a lineage's own FIRST attempt (the very first time it is ever submitted, before any give-up)
  as already protected — `giveUpLineages` is populated only AFTER a give-up; a lineage's first physical
  paste is unaffected by this card, by design (nothing to protect yet).
- Do not check `composerOwnerLineage` with a subset/overlap test — require an EXACT set match (same size,
  every id present both ways). A partial overlap (e.g. a coalesced write whose origin is a SUBSET of the
  recorded owner set, or vice versa) means some of the composer's content belongs to a member NOT in this
  write's own origin — treat that as a mismatch, not a match.
- Do not call `markGiveUpDirty` from the ownership-mismatch branch — nothing new was physically written
  this cycle, so there is nothing new to mark as possibly-stranded (mirrors how the Enter-only branch
  never calls it either, gated by the same `composerBodyWrittenForGen !== gen` fact).
- Do not call `setBusy(false)` synchronously from inside the ownership-mismatch branch — the M1 invariant's
  trailing `setBusy(true)` runs unconditionally at the end of `submit()`, after the branch decision; fight
  it and you lose. `giveUpWithoutWriting` defers via `setTimeout(0)`, exactly mirroring how the ordinary
  multi-attempt give-up sequence is already async relative to `submit()` itself returning.
- Do not clear `composerOwnerLineage` at the CONFIRMED-resolution site (`purgeConfirmedGiveUpRequeue`'s
  partial `composerDirtyLen -= resolved` subtraction) — that site is content-blind bookkeeping resolution
  for a possibly-OLDER generation's contribution, not proof the CURRENT physical terminal is empty. Only
  the two decisive-confirm sites (which fully zero `composerDirtyLen`) legitimately mean "nothing owns the
  composer until the next write."
- Do not decouple `logicalId` from `rootMsgId` in `enqueueDurableMessage`'s `hasAmbiguousMatch` auto-join
  to fix the resend residual below — that was tried in round 2 and REVERTED (breaks
  `pty-giveup-coalesced-membersig-resend.mjs` scenario (5), which depends on the auto-joined resend
  sharing `logicalId` with the original). Round 3's fix (below) is the dedicated-flag approach round 2's
  own record already predicted as the correct shape.

## Round 3 (Code Review 53d2adb2, round 2's MAJOR finding) — the resend residual, fixed

Round 2 left ONE known residual: a manual same-text resend after a `[loom:redelivery-parked]` notice
auto-joins the OLD chain's `rootMsgId` (`hasAmbiguousMatch`, card 4a0af485) — correct, and load-bearing
for the late-confirm purge. But inheriting that OLD `rootMsgId` also means inheriting its `giveUpLineages`
mark, so if a DIFFERENT lineage ("owner B") physically owns the composer by the time the resend arrives,
the resend's OWN write was silently blocked by `giveUpWithoutWriting` — never even attempting to land —
and if it later parked too, that park was silently suppressed as "duplicate-parked" of the root's EARLIER
park (`suppressMootParkNotice`).

**The fix**: `QueuedMessage.bypassOwnershipGateOnce` (set ONLY for a dispatch that itself auto-joined via
`hasAmbiguousMatch` — `sessions/service.ts`'s `isAutoJoinedResend`, OR'd across a re-mint of that SAME
chain so the property survives it) lets THIS write skip the ownership-mismatch check in `submit()` and
take the ordinary full clear+repaste branch instead — a fair, unblocked attempt, same as a fresh lineage's
own first try, while still sharing `logicalId` (so the late-confirm purge keeps working unchanged).
`handleGiveUpExhausted`'s PARKED branch now also overrides `suppressMootParkNotice`'s "duplicate-parked"
verdict specifically for that same dispatch's chain — a second failure after a deliberate resend is
genuinely new information, not a repeat of the first; every other moot reason (confirmed-after-park,
superseded-by-newer-directive) is unaffected. Test: `pty-giveup-resend-bypass-unsuppressed-park.mjs`.

Four smaller fixes landed alongside it:
- `requeueGiveUpOrigin`'s new `wroteNothing` param (true only from `giveUpWithoutWriting`) excludes a
  no-write generation from `live.giveUpConfirmQueue`'s content-blind positional-purge fallback — such a
  generation never had a real PTY write for a confirming hook to legitimately attribute via FIFO
  position. Test: `pty-giveup-round3-minor2-wrotenothing.mjs`.
- `giveUpWithoutWriting` no longer bails early on `live.enterConfirmed` — it checks only identity/alive/
  generation, matching the ordinary give-up path's own discipline.
- `Live.giveUpLineages` is now a true LRU (delete-then-add on every touch, mirroring `a9e4240f`'s
  identical fix for `ambiguousDispatches`) AND releases an id at the moment its OWN composer ownership is
  decisively confirmed (the two `composerOwnerLineage`-nulling sites) — a resolved chain no longer sits
  marked for the rest of the `Live`'s lifetime. This REVISES the round-1/2 "Do not clear `giveUpLineages`
  anywhere" rule above: clearing a SPECIFIC id at the moment its OWN ownership is decisively proven
  resolved is safe (nothing will ever redeliver under that exact id again), unlike a blanket clear. Test:
  `pty-giveup-round3-minors.mjs` (MINOR 4a/4b).
- The plain/fused `else` branch in `submit()` (card `ef78c885`'s own `composerLen>0` shape) now marks
  `composerOwnerLineage` UNKNOWN (null) when the write FUSES with still-stranded content
  (`composerDirtyLen>0` at write time) instead of attributing the fused composer to the fresh write's own
  lineage — a later marked lineage redelivering against fused content now parks loudly instead of wrongly
  taking Enter-only against content it doesn't actually own. Test: `pty-giveup-round3-minors.mjs`
  (MINOR 5).
- An ownership-mismatch give-up (`giveUpWithoutWriting`) now counts toward card `c00231e2`'s owner
  give-up burst alarm (`maybeFireGiveUpRecoveryAlarm`), same as every other give-up flavor — it was
  previously invisible to that alarm.

## Round 4 (Code Review 8d98f9d4, round 3's MAJOR finding) — the bypass was not one-shot, and the LRU-release claim had a hole

**BLOCKING (MAJOR): round 3's `bypassOwnershipGateOnce` was not actually one-shot.**
`requeueGiveUpOrigin`'s `kept.push({...m})` spread carried it forward unchanged into a requeued copy
(despite the field's own doc already promising "stripped on requeue" — it never was), AND the re-mint
path re-set it via `isAutoJoinedResend` being read for BOTH the duplicate-parked override AND the write
bypass. Measured on the round-3 commit (a5f791b9): the resend's body written 4x, 1426 backspace bytes —
the exact compounding-paste pattern this whole card exists to fix, reopened.

**The fix**: `bypassOwnershipGateOnce` is now explicitly stripped (`bypassOwnershipGateOnce: undefined`)
in the `kept` spread, and is computed in `enqueueDurableMessage` from THIS call's own fresh
`autoJoinedId` match ONLY — never from `ctx.isAutoJoinedResend` (which still OR's forward across a
re-mint, but ONLY for the separate duplicate-parked-override purpose; a re-mint always supplies its own
`ctx.rootMsgId`, which already resets `autoJoinedId` to `undefined`, so the write bypass is structurally
unreachable on a re-mint with nothing further to gate). The bypass is ALSO now gated on the matched root
having actually PARKED (`SessionService.isRootParked`, reading the same durable `session_message_gave_up`
signal `suppressMootParkNotice` already reads) — a fresh identical dispatch while the original chain is
merely still requeued gets no bypass at all (ruling: "onto a PARKED root", literally). The `origin.some`
check for a coalesced batch is now `.every`, mirroring `lineageEverGaveUp`'s own fa27d262 discipline.
Test: `pty-giveup-resend-bypass-unsuppressed-park.mjs` — a write-counter assertion (body written EXACTLY
once across the resend's whole chain) proven RED on a5f791b9, GREEN after; a new scenario (3) proves the
not-yet-parked case gets no bypass.

**A SECOND, SELF-DISCOVERED bug, found by restoring the body-count guard the round-3 CR asked for**
(ruling (e): round 3's own `composerBodyWrittenForGen`-vs-gen snapshot was ITSELF judged tautological —
`giveUpWithoutWriting`'s branch structurally never touches that field for its own generation, so the
snapshot was true by construction regardless of whether reaching that branch was the right decision;
replaced with a real write-count check, restored to the SAME placement the original pre-round-3 check
used): restoring it immediately caught a REAL regression in round 3's own MINOR 4 "release on decisive
confirm" — `kickoff-giveup-content-mismatch.mjs` scenario (C) started failing. Root cause: the
`UserPromptSubmit`/`Stop` decisive-confirm sites are DELIBERATELY content-blind (card 3ce3fa39 — they
fire on a bare `submitGeneration` match, proving only that a hook arrived for this generation, never that
its CONTENT matched what Loom wrote). Round 3's blanket "nothing will ever redeliver under this logicalId
again" claim (above) is FALSE for exactly the case this test scenario forces: a genuinely MISMATCHED
`UserPromptSubmit` (reported content ≠ written content) still satisfies the generation-match gate, so it
still released the lineage's `giveUpLineages` mark — and the SAME lineage's later redelivery then wrongly
treated itself as never-given-up, re-pasting its body a second time (the EXACT compounding-paste class
this card exists to prevent, reopened by MINOR 4 itself).

**The fix (round 4) — SUPERSEDED by round 5 below, do not re-adopt**: a cheap, EARLY, single-string-
comparison check (`upsContentMismatch`, computed right where `submitWasOutstanding` already is, BEFORE
the gated reset) gated ONLY the `giveUpLineages` release at the `UserPromptSubmit` site — never when the
reported prompt doesn't match what was written. This paragraph originally framed staying conservative
(suppressing the release for EVERY divergence, benign or not, rather than threading the much larger
mismatch-classification pipeline's own benign/genuine distinction through) as a RARE cost — "just
slightly less aggressive about reclaiming memory." **That framing was FALSIFIED by round 5's own
production measurement**: a real engine echo routinely carries the `<pasted_content>` composer wrap, so
`hook.prompt` (wrapped) is essentially NEVER byte-identical to `live.lastPrompt` (unwrapped) — the release
was DEAD in production (191/253 retained `[prompt-echo]` mismatches, 180 of them exactly the wrapper's
own +58 chars), not merely conservative on a rare divergence. The `Stop`/`StopFailure` claim below it
("unaffected... never reaches Stop's own gated block for the SAME generation anyway") is ALSO superseded
— round 5 removes that site's release outright, so whether it was reached rarely or often no longer
matters.

## Round 5 (lead's own kickoff, round 4's CR b9ddeaa5) — a POSITIVE content match, not an absence of mismatch

**The fix**: `purgeConfirmedGiveUpRequeueCore`'s return widened to also carry `contentMatchedLogicalIds`
(`host.ts`) — the exact set of logicalIds it just proved delivered BY CONTENT, reusing the SAME normalized
signature match (and `0658d6d8`'s `<pasted_content>` unwrap) the purge already performs, never a second,
raw comparison. `UserPromptSubmit`'s release now iterates that set instead of `composerOwnerLineage`
gated on `!upsContentMismatch` — a wrapped echo of the owner's own body resolves and releases; a wrapped
echo of different content, or no hook content at all, resolves nothing and releases nothing. The purge
call itself moved ahead of the `composerDirtyLenClearedByGen`-gated reset block (value-equivalent either
way — the reset block unconditionally overwrites `composerDirtyLen`/`composerDirtyMarkedGens` whenever
its own gate fires, regardless of what the purge's `clearComposerDirtyOnConfirm` already did a moment
earlier), so the release decision has the matched set in hand before it runs.

`Stop`/`StopFailure` applies the identical rule, not a special case: its own purge call (no `reportedPrompt`
— that hook carries no `prompt` field at all, ever) always returns an EMPTY `contentMatchedLogicalIds`, so
this site now NEVER releases a `giveUpLineages` mark — closing the round-4 gap where its release was
UNCONDITIONAL with no content check whatsoever. `composerOwnerLineage` is still nulled there (the composer
is proven empty by the decisive confirm); only the lineage-mark release is gone.

Tests: `pty-giveup-lineage-release-content-match.mjs` — a wrapped echo of the owner's own body releases
(RED on `cfb9b7ff`); a wrapped echo of unrelated content stays marked (negative control, unaffected by
either version); a Stop-site confirm (no prompt field) stays marked (RED on `cfb9b7ff`, where Stop
released unconditionally). `pty-giveup-coalesced-batch-bypass-every.mjs` pins round 4's own
`bypassOwnershipGateOnce` `.every` discipline (host.ts ~11577) with the one shape no prior test
constructed — a 2-member batch with only ONE member flagged — RED if `.every` regresses to `.some`.

## Do not (round 5 additions)

- Do not gate a `giveUpLineages` release on the ABSENCE of a raw mismatch (`hook.prompt !== live.lastPrompt`)
  — that comparison is dead in production against a wrapped echo; gate on the PRESENCE of a positive,
  normalized content match instead (`purgeConfirmedGiveUpRequeueCore`'s own `contentMatchedLogicalIds`).
- Do not add a second, independent content-comparison/unwrap implementation for this release decision —
  reuse `purgeConfirmedGiveUpRequeue`'s existing one, or the two can silently drift (one unwraps the CLI's
  literal-tag escape per `691d02e1`, the other wouldn't).
- Do not release anything at the `Stop`/`StopFailure` site on the theory that it's "probably fine" because
  `UserPromptSubmit` usually gets there first — that site structurally CAN be reached as the generation's
  only confirming hook (a lost `UserPromptSubmit`), and it can never prove content by construction (no
  `prompt` field exists on it), so the correct behavior is NEVER release there, not "rarely".

## Do not (round 4 additions)

- Do not read `isAutoJoinedResend` (the duplicate-parked-override flag) as interchangeable with the write
  bypass — they are computed from related but DIFFERENT conditions (one OR's forward across a re-mint via
  `ctx.isAutoJoinedResend`, the other reads only THIS call's own fresh `autoJoinedId` match AND requires
  the root to be PARKED) for exactly the reason round 3's MAJOR bug existed: conflating them re-grants the
  write bypass on every re-mint retry.
  **Superseded in part by `a5987cf3`: the notice override now keys on `joinedOntoParkedRoot` (renamed
  from `isAutoJoinedResend`, narrowed to require the matched root was already PARKED) — see that card's
  own record for why "ever auto-joined" alone was too broad.**
- Do not release a lineage from `giveUpLineages` at a content-blind decisive-confirm site without also
  checking whether this SPECIFIC hook was a genuine content match — `UserPromptSubmit`'s own gated reset
  fires on a bare generation match, which a mismatched hook still satisfies.
