# 5f825506 — a stale exhaustion marker must not re-mark a recovering turn, and a strand in the composer's own recovery drain

Follow-ups from 66ff7321's own CR round 3 (worker 2f25a2f1, reviewing 12e9664a). Investigated and fixed
in two independent parts.

## Part 1 — the stale-marker race

`markContextExhausted`'s own clear (`PtyHost.setBusy`'s `if (busy) live.contextExhausted = false`) and
`SessionService.handleBusyEdge`'s matching DB clear (`db.clearContextExhaustedOnResume`) both run
SYNCHRONOUSLY the instant a rising edge fires — composer bypass, raw-terminal `/compact`, or an
ordinary resume's first turn, it doesn't matter which. But the transcript FILE on disk is written by
the external claude CLI process, with no ordering guarantee relative to that in-process clear. A watcher
tick (`ContextWatcher`/`BusyWorkerWatcher`) landing in that window re-reads the SAME stale "Prompt is
too long" terminal record as still "latest", and `markContextExhausted`'s only guard
(`live.contextExhausted`, just cleared) lets it re-mark — clearing `busy` a second time, mid-turn, and
appending a duplicate `manager_context_exhausted`/`worker_context_exhausted` event (and, for a worker, a
duplicate recycle notice). The hold then survives until ANOTHER rising edge.

### Why the cutoff is `Live.busySince`, never `Session.lastActivity`

`Session.lastActivity` (`db.ts`) is bumped by far more than a busy rising edge — enumerated directly in
`db.ts`: `setLastError` (~7317), `setProcessState` (~7249), `setEngineSessionId` (~7230), the
`restrictedTools` patch (~7357), `companionLeadMode` (~7369), `setRateLimited` (~7487),
`setContextExhausted` itself (~7542), and the generic dynamic `set*` patch (~7396). Any of those firing
MID-TURN, after a genuine in-turn exhaustion record was already written but before a tick happened to
notice it, would advance `lastActivity` PAST that record's own timestamp — a cutoff built on
`lastActivity` would then wrongly treat the real exhaustion as "stale" and ignore it: a fail-open
regression of 66ff7321's own detector, worse than the duplicate re-mark this card fixes.

`Live.busySince` (`pty/host.ts`) has exactly ONE writer in the whole daemon (`setBusy`, confirmed via a
repo-wide grep for `.busySince =`): set to `Date.now()` on a rising edge, `null` on a falling edge,
touched by nothing else. It is the genuine, exclusive turn-start stamp. Exposed to the two watchers via
a new optional `busySinceMs(sessionId): number | null` on `ContextPty`/`BusyWorkerPty` (optional so
every pre-existing fake pty in a sibling test file keeps compiling/running byte-identically — a fake
that doesn't implement it yields `null`, which fails open to the pre-card behaviour, same as an
omitted cutoff).

### Threading

`detectContextExhaustionInTail(tailText, notBeforeMs?)` (`pty/claude-transcript.ts`) is the ONLY place
that reads the record's own `timestamp` field — kept there per decision `66ff7321`'s "never construct a
wire-format assumption outside this file" rule. `checkContextExhaustion(cwd, engineSessionId, harness,
notBeforeMs?)` (`orchestration/context-exhaustion.ts`) threads it through, carrying no wire-format
knowledge itself. Both marking call sites (`ContextWatcher.checkContextExhaustion` for the
manager/platform path, `BusyWorkerWatcher.tick`'s inline worker check) and the worker loop's read-only
`ContextWatcher.isWorkerContextExhaustedUnmarked` pass `pty.busySinceMs(id) ?? null`.

### Equal-timestamp semantics

A record timestamped EXACTLY at the cutoff (`timestamp === notBeforeMs`) is treated as NOT stale (still
a valid match). `notBeforeMs` is `Date.now()`-precision; a record written by a separate process in the
very same millisecond could easily be a genuine new-turn exhaustion. Rounding a tie toward "still
current" is the same fail-open-on-ambiguity direction as the missing/unparseable-timestamp case — this
feature may only ever REJECT a match it can affirmatively prove predates the turn.

## Do not

- Do not derive the cutoff from `Session.lastActivity` — see "Why the cutoff" above; several of its
  writers can fire mid-turn and would silently reopen a fail-open gap.
- `busySinceMs` IS a required interface member as of round 2 — see "Round 2 — `busySinceMs` made a
  REQUIRED interface member" below for why this reverses the original round-1 choice.
- Do not treat a tie (`timestamp === notBeforeMs`) as stale — round toward "still current" on ambiguity.
- Do not read a missing/unparseable record `timestamp` as stale — fail open to the pre-card behaviour.

## Part 2 — the composer's own recovery message could itself strand

The composer exemption (`enqueueStdin`'s `contextExhaustedHold`/`composerRecoveryBypassesQueue`,
`pty/host.ts`) only ever applied to the IMMEDIATE-submit gate. `drainPending`'s own early return bailed
on `live.contextExhausted` UNCONDITIONALLY, with no sender awareness at all. So a composer arrival that
was ALSO blocked by a DIFFERENT `idleEligible` conjunct at the moment it arrived (rate-limited, a
startup cycle in flight, `drainHeld`, `isHumanSubmitHeld`, `deferForHumanDraft`) never took the
immediate path — it landed in `live.pending`, held — and then NOTHING could ever drain it: every later
`drainPending` call (the periodic `reconcile()` safety net included) kept bailing on
`live.contextExhausted` outright, without ever re-checking whether the OTHER conjunct that blocked it
had since cleared. The queue stayed stranded until a SECOND composer message arrived.

Fix: extract the composer-exemption test into one shared private predicate (the same
`isHumanSubmitHeld`/`deferForHumanDraft` sibling-pair shape decision `2521bf51` already uses for two
gates), and have `drainPending` consult it against its own candidate head/scan entries instead of
bailing on `live.contextExhausted` unconditionally. The exemption is narrowly scoped to the exhaustion
bail alone — every OTHER `idleEligible` conjunct still gates the composer entry exactly as it always
did; only once every OTHER conjunct has cleared does the exhaustion-specific bail stop blocking it.

## Do not (part 2)

- Do not relax any conjunct OTHER than the exhaustion bail for the composer's entry — a composer entry
  still correctly waits out `rateLimited`/`startupCycleInFlight`/`drainHeld`/`isHumanSubmitHeld`/
  `deferForHumanDraft` like any other arrival; only `live.contextExhausted` itself is special-cased.
- Do not drop the "nothing else can drain anyway while contextExhausted holds" reasoning — it is what
  justifies letting the composer-sender entry jump the ordinary FIFO order inside `drainPending` too. It
  now lives in `drainPending`'s own exhausted-branch composer scan (`pty/host.ts`, the `@decision 5f825506
  (round 3)` comment above the `composerIdx` scan) — the sole policy owner since card `b70eade0` deleted
  `enqueueStdin`'s own `composerRecoveryBypassesQueue` comment that used to carry it.

## Part 3 — `fleet.mjs`'s "Lead surfaces" test couldn't have caught the bug it names

`attention.ts`'s own fetch (`contextExhaustedEventsQuery`) was ALREADY the correct, dedicated
cross-session, kind-filtered query (fixed at round 3 of card `66ff7321` itself — see that card's own
round-3 comment in `attention.ts`), never the role-scoped `managers` (`role==="manager"`) fan-out. But
`fleet.mjs`'s own "a PLATFORM Lead's own exhaustion ... surfaces exactly like a manager's" test called
`activeContextExhaustedAlerts` directly, with a hand-built event array and an `isStillExhausted`
predicate supplied inline by the TEST itself — bypassing `attention.ts`'s own liveness lookup
(`isStillContextExhausted`) entirely. So the test exercised only the half of the mechanism that was
never broken (the latest-wins pairing), never the half that WAS (which session list the liveness
lookup is built from) — it would have passed identically against the pre-round-3 bug.

Fixed by extracting BOTH the liveness lookup and the call to `activeContextExhaustedAlerts` into one
function, `deriveContextExhaustedAlerts(events, allLiveSessions)` (`lib/fleet.ts`), that `attention.ts`
now calls directly instead of duplicating the lookup inline. The new fleet.mjs test
("deriveContextExhaustedAlerts: a PLATFORM Lead's event surfaces when sessions includes non-manager
roles") feeds it a MIXED session list (a worker-role session, and a platform-role Lead, but
deliberately NO manager-role session for that id) and asserts the Lead's own alert still surfaces —
pinning the contract that `allLiveSessions` must be role-inclusive, which the function's own
`isStillExhausted` closure enforces structurally (no `role` check at all).

## Round 2 — the head-only drain check was still vacuous

Round 1's `drainPending` fix (Part 2 above) only ever checked the EFFECTIVE HEAD's own `senderId` — but
the realistic shape has something else already sitting ahead of the composer's own recovery entry (a
held worker report, an idle nudge, queued manager direction), so the bail fired on THAT entry's
`senderId` and returned before ever looking further into the queue. Nothing could then drain the
composer entry either, because every later `drainPending` call (including the periodic `reconcile()`
safety net) hit the identical head-only bail — the queue stayed stuck forever, exactly the strand Part 2
was meant to close, just one layer deeper.

Fix: when the head isn't the composer's own entry, scan the WHOLE queue (not merely from the computed
`startIdx` — same rationale as `enqueueStdin`'s own `composerRecoveryBypassesQueue`: nothing else can
drain anyway while `contextExhausted` holds) for the first non-give-up-held composer-sender entry and
splice ONLY that one entry out, submitting it alone. Every other entry — including a still-give-up-held
one and every non-composer entry ahead of it — stays exactly where it is, in its original relative
order; `Array.prototype.splice` removing one element shifts the rest down without reordering them.

## Do not (round 2)

- Do not reduce the fix to re-checking only the head on a later tick — the strand is that NOTHING ever
  advances the composer entry while something else occupies the head; the fix must look past it.
- Do not coalesce ANY composer entry drained while `live.contextExhausted` holds — one pulled from
  behind a non-composer head, or one sitting at the head itself — with any other queued entry
  (same-sender or otherwise). Every such drain is a single-entry `splice`+`submit`, never joining the
  ordinary same-sender/route-keyed coalescing runs below it in `drainPending`. (Round 2 itself only
  reached the first of those two shapes — see "Round 3 — the HEAD-is-the-composer-entry gap" below for
  the one it missed.)

## Round 2 — `busySinceMs` made a REQUIRED interface member

Round 1 kept `ContextPty.busySinceMs`/`BusyWorkerPty.busySinceMs` OPTIONAL specifically so none of the
pre-existing fake-pty fixtures across the sibling `context-watcher-*.mjs`/`busy-worker-watcher*.mjs`
test files needed updating. Round 2 reverses that: making it a REQUIRED member means the real `PtyHost`
(the only production implementer) must keep a matching, non-optional `busySinceMs` method, or assigning
it to a `pty: ContextPty`/`pty: BusyWorkerPty` parameter fails to compile — catching a future rename or
removal of `PtyHost.busySinceMs` at BUILD TIME instead of letting it silently fail open (a stale cutoff
read as `null` forever, with no compiler signal). The call sites themselves still read
`pty.busySinceMs?.(id) ?? null` — optional chaining type-checks against a required member just as well
as an optional one, and keeping it there costs nothing while staying safe for any hypothetical future
fixture that still doesn't implement the method. `packages/daemon/test/**` is outside `tsconfig.json`'s
`include` (daemon's own tsconfig includes only `src`), so no `.mjs` test fixture is type-checked against
either interface regardless of this change — the two fixtures that DO fully implement `ContextPty`/
`BusyWorkerPty` (`context-watcher-context-exhausted.mjs`, `busy-worker-watcher-context-exhausted.mjs`)
already carried a real `busySinceMs` function from round 1, so neither needed an update for this.

## Do not (round 2, item 2)

- Do not remove the `?.()`/`?? null` at the call sites just because the interface member is now
  required — a sibling test fixture that implements only `isAlive`/`enqueueStdin` (never
  `markContextExhausted`, so it never exercises this code path either) would throw at runtime if the
  call site stopped tolerating a missing method.

## Round 2 — the worker loop's own read-only check gained a regression test

Item 1's threading section above already states that `ContextWatcher.isWorkerContextExhaustedUnmarked`
passes the cutoff through — that was true since round 1, but no test exercised it: every existing test
of this method used a timestamp-less fixture (the fail-open default), which can't distinguish a correct
cutoff pass-through from a call site that silently dropped it. `context-watcher-worker-ratios.mjs`
scenarios (20)/(21) close the gap: (20) a marker predating the worker's own current-turn `busySinceMs`
is correctly ignored (Trigger D fires normally against the over-floor reading); (21), the non-vacuous
positive control, proves the SAME check still correctly suppresses a marker genuinely inside the current
turn. RED proof: a dist mutant forcing the call site's cutoff argument to a literal `null` flips (20)
to a failure (the stale marker is then wrongly read as current, `continue` fires, Trigger D never fires).

## Round 2 — `deriveContextExhaustedAlerts`'s own call site, source-scanned

Item 4's ask was to make the caller's list choice structurally impossible. The function itself already
takes the raw, role-inclusive session list and does its own liveness lookup (round 1's own fix, Part 3
above) — `attention.ts` has nothing left to narrow at the TYPE level (`all` and `managers` are the same
`SessionListItem[]` shape to the compiler either way), so a careless future edit swapping the call
site's second argument from `all` to the nearby `managers` variable would compile cleanly and reintroduce
the round-3 bug silently. Per this item's own fallback instruction, `packages/web/test/fleet.mjs` now
carries a source-scan check pinning that call site's actual second argument to the identifier `all` —
proven RED by temporarily editing `attention.ts`'s own call site to pass `managers` instead (confirmed
failing assertion naming the exact swap), then restored.

## Round 2 — a residual: `busySince` can post-date a genuine exhaustion if the daemon's own hook delivery stalls

Found by the reviewer, not built here (explicitly out of scope for this round). `Live.busySince` is
RE-STAMPED on every `setBusy(true)` rising edge — including a LATE one. If the daemon's own event loop
stalls long enough that a `UserPromptSubmit` hook POST from claude's CLI is processed only AFTER that
hook's own client-side timeout has already elapsed and the CLI itself has moved on, the daemon still
treats that late POST as a genuine new rising edge and re-stamps `busySince` to the (late) processing
time — which can land AFTER a real, already-written exhaustion record's own `timestamp`. Item 1's cutoff
would then read that marker as "predates the turn" and reject it, even though it is the GENUINE record
for the turn that's actually still dead. The session is not silently lost in this scenario — it still
gets caught by the independent stuck-busy healing path (`healIfStuck`) rather than by the exhaustion
detector — but it would surface as a generic stuck-busy recovery instead of a clean, correctly-attributed
`manager_context_exhausted`/`worker_context_exhausted` mark.

The hardening option, NOT built in this round: a SEPARATE, rising-edge-ONLY stamp that is set once per
genuine new turn and never re-stamped by a late/duplicate hook delivery for a turn that already has one
— as opposed to `busySince`, which is deliberately re-stamped on every rising edge by design (see "Why
the cutoff" above — that property is what makes it safe against `Session.lastActivity`'s own mid-turn
writers). Building this needs its own investigation into how to detect "this rising edge is a late
duplicate of one already accounted for" without reintroducing a different fail-open gap; out of scope
here.

## Part 4 — raw-terminal `/compact` (investigated, no code change)

Statically confirmed (installed `claude.exe`, PE VersionInfo `2.1.317`, read via `Get-Item`/`grep -a` —
never executed, never a real transcript): `/compact` is registered `{type:"local",...,
thinClientDispatch:"post-text"}`, and the dispatch-resolver (`function VJs(e,n){if(e.type==="prompt")
return"post-text";switch(e.thinClientDispatch){case"post-text":return"post-text";...}`) resolves that to
the IDENTICAL mode as a bare, unrecognized prompt. So `/compact`'s raw text is submitted through the
same pipeline as an ordinary prompt turn — the one that fires `UserPromptSubmit` — meaning the
raw-terminal path already gets the ordinary rising-edge clear via `deliverHook`'s generic
`case "UserPromptSubmit":` handling (`pty/host.ts`), same as the composer bypass and the round-1 resume
path. It is exposed to the exact same Part 1 race, closed by the same fix (Part 1's cutoff is keyed off
`busySince`, a property of ANY rising edge — not composer-specific), so no separate code change was
needed for this path. Full evidence (binary strings, dispatch-resolver excerpt) filed under card
`5f825506`'s own heading in `docs/decisions/66ff7321-context-exhaustion-detector.md`.

## Round 3 — the HEAD-is-the-composer-entry gap

Round 2's own fix (`drainPending`'s composer branch) only ever fired when the head's own `senderId`
FAILED `exhaustionHoldAppliesTo` — i.e. when the head was NOT the composer's entry, so the branch had to
look past it to find the composer entry sitting further back. But `exhaustionHoldAppliesTo(head.senderId)`
is FALSE whenever the composer entry IS the head (the realistic steady state right after a prior drain,
or simply the first arrival on an otherwise-empty exhausted queue) — in that shape round 2's own
condition never matched at all, and execution fell straight through to the ORDINARY coalescing branches
below. Under the daemon-global `coalesceAgentMessages:true` (the route-keyed branch, which ignores
sender AND kind entirely), that let a held NON-composer entry sitting right behind the composer's own
head entry get folded into the composer's recovery turn in ONE write — reproduced by the reviewer as
`[composer "/compact", manager direction]` + exhausted + the toggle ON: the direction is written AFTER
"/compact" in the same turn (which the CLI reads as part of the compaction instructions, never as its
own turn), and `onDeliver` fires for it too, marking it delivered even though it was never actually
acted on as its own message.

Fix: drop the `exhaustionHoldAppliesTo(head.senderId)` outer condition entirely. While
`live.contextExhausted` holds, `drainPending` ALWAYS takes the single-composer-entry path — head or
not — by scanning the whole queue for the first eligible (non-give-up-held) composer-sender entry and
splicing it out alone. This also removes the round-2 branch's OWN parallel copy of the drain tail (a
direct `this.submit(...)` + `onDeliver` call, duplicated instead of shared): the composer-only splice now
sets `drained = [composerEntry]` and falls through to the SAME shared tail every other drain shape uses
(the `giveUpGen` archive loop — `archiveAmbiguousDispatch` + `ambiguousDispatches.delete` — then
`submit()`, then the `onDeliver` loop), closing the round-2 Minor this round's own CR also flagged (the
splice path was skipping that archive loop — see "Round 3 — the archive loop pin" below).

Tests (`context-exhausted-drain-hold.mjs`): (11a) reproduces the bug under `coalesceAgentMessages:true`
— a composer entry armed as the HEAD (via `isHumanSubmitHeld`, so it can't take the immediate bypass),
with a manager direction queued behind it — and asserts the direction is NEVER folded into the
composer's own write, stays queued, and its `onDeliver` never fires. (11b) is the toggle-OFF control on
an identical setup: same-sender coalescing already happened to protect this exact shape pre-fix (the
direction has a DIFFERENT `senderId`, so the old agent-kind coalesce loop's own same-sender condition
never extended past the composer head) — proving the fix doesn't regress that path. RED proof: a dist
mutant reverting `drainPending`'s composer branch to the round-2 shape (the `exhaustionHoldAppliesTo
(head.senderId)` outer condition, plus the old branch's own parallel submit+onDeliver copy) flips (11a)'s
four MAJOR-FIX assertions to failing; restored cmp-identical afterward.

## Do not (round 3, major)

- Do not reintroduce the `exhaustionHoldAppliesTo(head.senderId)` outer condition on the composer branch
  — see "Round 3 — the HEAD-is-the-composer-entry gap" above for why it silently exempts the single most
  common shape (the composer entry already at the head) from the fix.
- Do not give the composer-only splice its own parallel `submit()`/`onDeliver` call — it must set
  `drained` and fall through to the shared drain tail, or a future fix to that tail (e.g. the archive
  loop) silently stops covering this path too.

## Round 3 — the give-up-held composer entry is correctly excluded from the splice scan

`drainPending`'s composer-entry scan (`live.pending.findIndex((m) => !this.isGiveUpHeld(m) &&
!this.exhaustionHoldAppliesTo(m.senderId))`) excludes a still-give-up-held composer entry exactly like
every other eligible-entry scan in this function — this was already true before round 3 (the exclusion
predates this round's own fix), but no test pinned it for this specific scan. `context-exhausted-
drain-hold.mjs` test (12) closes the gap: a non-composer entry at the head, a GIVE-UP-HELD composer entry
behind it (injected directly into `live.pending` — the established pattern
`pty-giveup-recovery-alarm.mjs`/`pty-giveup-resend-bypass-unsuppressed-park.mjs` already use, rather than
driving a real give-up through the timeout machinery, which this file cannot do safely: it shares ONE
process-wide `SUBMIT_VERIFY_TIMEOUT_MS` with every other session already live in the file, and shortening
it enough to observe here risks firing unrelated give-up cycles for every other still-unconfirmed session
in the same run). (12a) asserts nothing drains while the composer entry's hold is still in force, then
that it drains ALONE once the hold expires — spliced from behind the still-queued, still-held
non-composer entry, which is left untouched, not dropped. RED proof: a dist mutant dropping the
`!this.isGiveUpHeld(m)` conjunct from the scan flips (12a)'s two "nothing drains" assertions (the
give-up-held entry would otherwise be picked immediately); restored cmp-identical afterward.

## Round 3 — the archive loop pin

The composer-only splice falling through to the shared drain tail (see the Major fix above) means the
`giveUpGen` archive loop at the TOP of that tail — `for (const m of drained) { if (m.giveUpGen ===
undefined) continue; this.archiveAmbiguousDispatch(live, m.logicalId); live.ambiguousDispatches.delete
(m.logicalId); }` — now runs for a composer-only drain too, not just the ordinary coalescing branches.
Test (12c) extends (12)'s give-up-held composer scenario with a seeded `live.ambiguousDispatches` entry
for the composer's own `logicalId` and asserts, after the drain: the entry was DELETED from
`ambiguousDispatches`, AND it was ARCHIVED first — `live.retiredGiveUpSignatures.get(logicalId)` now
holds the seeded signature, not merely an absence. RED proof: a dist mutant that skips the archive call
for a composer-sender entry specifically (`if (!this.exhaustionHoldAppliesTo(m.senderId)) continue;`
inserted into the loop) flips exactly (12c)'s two assertions, nothing else; restored cmp-identical
afterward.

## Do not (round 3, minor)

- Do not assume the `!isGiveUpHeld` exclusion in the composer scan is new — it predates round 3 (the
  findIndex predicate is unchanged from round 2); what's new is only the TEST pinning it for this scan.
- Do not drive a real give-up cycle through `SUBMIT_VERIFY_TIMEOUT_MS`/`GIVE_UP_HOLD_MS` etc. to build a
  give-up-held fixture in `context-exhausted-drain-hold.mjs` — shortening those process-wide, module-
  top-level constants risks firing an unrelated give-up cycle for every OTHER still-unconfirmed session
  already live in that same test run. Inject the `giveUpGen`/`giveUpHeldUntil` fields directly onto a
  `live.pending` entry instead (see test (12)'s own comment for the established precedent).

## Round 3 — two composer entries queued FIFO

Round 2's own tests (8b/8c/9/9b) only ever queued ONE composer entry at a time. With the composer entry
itself now always eligible for the splice-and-drain-alone path (the Major fix above), two SUCCESSIVE
composer entries sharing the identical `senderId`/`kind`/route were never explicitly proven to drain
FIFO, one at a time — test (13) closes this: two composer entries queued while `isHumanSubmitHeld` blocks
both, then drained once that hold clears. The FIRST drains alone (never coalesced with the second, even
though they share every field the ordinary same-sender agent-coalesce loop keys on); the second stays
queued until the first's own turn ends, then drains normally. RED proof: the same full round-2-shape dist
mutant used for the Major fix above also flips (13)'s FIFO/no-coalesce assertions — pre-fix, with the
composer entry at the head taking the ordinary same-sender coalescing branch instead of the composer-only
splice, the SECOND composer entry (same `senderId`, same `kind`, same route) satisfies every condition
that loop checks and gets folded into the first's own write.

## Nits

- Test (10)'s own doc comment claimed its REAL `busySinceMs` stamp "threads correctly ... end to end" —
  overclaiming a full watcher-tick integration it never exercises (it reads the real stamp off
  `PtyHost.busySinceMs`, then feeds it DIRECTLY to `detectContextExhaustionInTail`). Reworded to state
  what it actually proves, with a pointer to `context-watcher-worker-ratios.mjs` scenarios (20)/(21) for
  the watcher-tick integration coverage this test doesn't provide.
- `packages/web/test/fleet.mjs`'s source-scan for `attention.ts`'s own `deriveContextExhaustedAlerts(...)`
  call site used a plain (non-global) regex over the WHOLE file, so a future comment mentioning the call
  in parenthesized form (e.g. illustrating the exact bug this scan guards against) ahead of the real call
  site would silently shadow it — `.match` always returns the FIRST hit regardless of whether it's inside
  a comment. Fixed by filtering out comment-only lines (`line.trim().startsWith("//")`) before matching.
  Verified: a synthetic shadowing comment line (`// ... deriveContextExhaustedAlerts(events, managers) ...`)
  ahead of the real call resolves to `managers` under the old unfiltered match and `all` under the new
  comment-filtered one.
