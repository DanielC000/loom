# 08ac0e79 — the ownership-mismatch give-up: requeue+alarm SYNCHRONOUSLY, defer only the busy clear

## Round 1 — the removed bail, and why it was missing

Card `844ca34e` round 3 removed `giveUpWithoutWriting`'s `live.enterConfirmed` bail, stating the change
"matches the ordinary give-up path's own discipline" (see that card's own record, Round 3 section). That
claim does not hold against the actual code: the ordinary give-up path (`fireEnterAndVerify`'s whole
chain — `sendEnterAndVerify`, `awaitReassertSettle`, `awaitGiveUpConfirmSettle`, `fireEnterAndVerify`'s own
entry, and its final pre-commit recheck) checks `live.enterConfirmed` as a bail condition at every single
link. `giveUpWithoutWriting` was the ONE site in the whole give-up chain missing it. Found during the
investigation of card `08ac0e79` ("keep busy true when a give-up fires on a turn the engine actually
started"), discovered-from card `2ff893f3`.

## Round 2 (Code Review `c01109bc`) — round 1's own fix was wrong, in both directions

Round 1 made the ENTIRE continuation — the `setBusy(false)` AND the `requeueGiveUpOrigin` call — bail
together on `live.enterConfirmed`, reasoning "every sibling in the chain already bails on this signal."
That framing was wrong for this specific site, for a reason the siblings don't share: EVERY sibling in
`fireEnterAndVerify`'s chain wrote a real Enter for its OWN generation, so a confirming hook landing in
their window CAN be that generation's own proof. `giveUpWithoutWriting` writes NOTHING — this generation
never had an Enter to confirm — so a hook landing in ITS window can never be about this generation at all.
It is always evidence that some OTHER lineage's turn (the one that actually owns the composer — commonly
the lineage that caused the mismatch in the first place) is genuinely in flight. "Parity with the
siblings" was the wrong frame from the start.

Making the requeue conditional on the same flag was the more serious half of the bug: this origin was
already spliced out of `live.pending` at drain time, with `onDeliver` already fired (the durable row
reads `delivered`). Its only remaining copy at this point is `live.giveUpOrigin` — and the very next
`submit()` call (the other lineage's turn, about to run) overwrites that field. Skipping
`requeueGiveUpOrigin` when `enterConfirmed` was true therefore permanently LOST the origin — reproduced by
the Code Reviewer in both the "UserPromptSubmit then Stop" and the "Stop/StopFailure directly" variants,
where round-1's code dropped it every time; pre-fix (no bail at all) it was requeued every time.

### The fix

- `requeueGiveUpOrigin(sessionId, gen, true)` must never be skipped — SUPERSEDED in Round 3: it moved out
  of this method entirely, to run synchronously at the mismatch site in `submit()` itself. See Round 3.
- `live.enterConfirmed` gates ONLY the `setBusy(false)` call: a confirming hook has already decided busy's
  correct value for this moment (see MINOR-3 in Round 3 below for why "another lineage's turn is in
  flight" overclaims this — a Stop means a turn just ENDED, not started), so leave `busy` exactly as that
  hook left it. If no hook landed, clear `busy` as before.
- `maybeFireGiveUpRecoveryAlarm` fires unconditionally, on every give-up through this method, same as
  before round 1 ever touched it — it must never be skipped by the `enterConfirmed` branch.

### Cost — CORRECTED in Round 3 below (MINOR-3); do not trust this paragraph alone

Round 2 claimed here that no multi-minute stall is introduced and that the requeued origin "drains on the
very next natural trigger." Both overstated the normal case as the ONLY case: the no-stall claim holds
only while the owning turn's own Stop genuinely arrives (a lost Stop still falls back to `healIfStuck`'s
staleness bound), and the origin does NOT drain as an ordinary turn while the mismatch's own cause (the
owning lineage still owning the composer) persists — it re-mismatches and cycles through this same path,
bounded by `GIVE_UP_REQUEUE_LIMIT`. See Round 3's MINOR-3 section for the corrected statements.

### The duplicate-delivery trade (the fused case) — stated at its TRUE strength (corrected in round 3)

When `submit()`'s ownership check fails with `live.composerOwnerLineage === null` (card `ef78c885`'s fused
shape — the physical composer content is a MIX from more than one lineage, not cleanly attributable), the
bytes an in-flight OTHER turn is about to submit can already PHYSICALLY CONTAIN this origin's own stranded
text, fused together with other content. We accept duplicate-over-loss here, consistent with this
project's own "fail toward a duplicate, never a loss" posture (card `88f11385`, cited at
`requeueGiveUpOrigin`'s own doc) — but round 2's claim that the EXISTING content-match purge "DOES prevent
the double delivery" for this case was WRONG, caught by Code Review `3de1021c` (MAJOR-2):
`purgeConfirmedGiveUpRequeueCore`'s `matchesSig` (host.ts ~13178-13182) is WHOLE-TEXT `len`+`fnv` equality
only — the reported prompt's full length and hash must equal one stored signature's full length and hash,
exactly, with no substring/partial form. A genuinely FUSED prompt (A's text joined with something else)
can never produce that equality against A's own stored signature, by construction. **In the fused case,
the duplicate is essentially always unpurged** — this purge does not reach it at all, in either direction
of the equality check.

What the purge DOES catch is a narrower, DIFFERENT, non-fused shape: a confirming hook that reports EXACTLY
one stored signature's own text, with nothing else joined to it — e.g. a genuine late echo of this exact
origin's own content, not a fusion. Verified live (`pty-giveup-ownership-mismatch-enterconfirmed-bail.mjs`
scenario (E)): with round 3's synchronous requeue (so the signature is seeded before any hook delivery, not
raced against being overwritten), a `UserPromptSubmit` reporting A's own exact text DOES get found and
purged — logged `CONFIRMED logicalId=... (content-matched...)` and `GIVE-UP RECOVERY was a false negative
(content-matched) ... purged a still-queued duplicate`. That is a real, FIXED outcome for that specific
shape, not a guess — but it is a different shape from the fused case above, which this purge cannot reach
regardless of round 3's fix. `Stop`/`StopFailure` never attempts content match at all either way (it
structurally carries no `prompt` field — card `844ca34e` round 5's own "Do not" rule on this).

## Round 3 (Code Review `3de1021c`) — the stale-generation loss, and the record corrections it forced

### CRITICAL-1: a different message draining in the deferred window still lost A

Round 2 put BOTH `requeueGiveUpOrigin` and `maybeFireGiveUpRecoveryAlarm` inside the SAME deferred
`setTimeout(0)` callback as the busy-clear decision, gated together on `live.submitGeneration !== gen`.
That gate is the right call FOR THE BUSY CLEAR (a stale generation means some other submit now owns
`busy`) but wrong for the requeue and the alarm: if a DIFFERENT, unrelated message (from a different
sender, not held) was sitting in `live.pending` and the OWNING lineage's Stop lands inside this window, the
Stop's own M2 drain delivers that different message — which bumps `live.submitGeneration` AND overwrites
`live.giveUpOrigin` with ITS OWN origin, since `submit()` sets that field unconditionally at its own top.
By the time the deferred callback finally runs, the stale-gen check now (correctly, for busy, incorrectly
for everything else) bails BEFORE the requeue ever happens — and even if it hadn't bailed, `live.giveUpOrigin`
no longer held A's reference to requeue. A was already spliced out of `live.pending` at the ORIGINAL drain
(`onDeliver` already fired, the durable row reads `delivered`) — lost for good. Reproduced by the Code
Reviewer (`repro/stop-drains-c.mjs`) and by this card's own test, scenario (D) — RED on commit `1b90421c`.

### The fix

`maybeFireGiveUpRecoveryAlarm` and `requeueGiveUpOrigin(sessionId, gen, true)` now run SYNCHRONOUSLY, at
the mismatch site in `submit()` itself (right where the mismatch is detected, before `submit()`'s own
trailing M1 `setBusy(true)`) — NOT deferred at all any more. At that point `live.giveUpOrigin`/
`live.giveUpOriginWrittenText` are freshly set by THIS `submit()` call and nothing has had a chance to
overwrite them yet, so the race is closed by construction, not by a tighter check. ONLY the busy-clear
decision stays deferred (`giveUpWithoutWritingBusyClear`, a renamed and narrowed method — it does nothing
else now), still gated on `live.enterConfirmed` and the stale-generation check, because `submit()`'s own
trailing M1 `setBusy(true)` runs immediately after and would fight a synchronous clear (card `844ca34e`'s
original "Do not call setBusy(false) synchronously" rule — unchanged, and still the only reason anything
here needs to be deferred at all).

**Verified safe before building** (per the review's own request): `requeueGiveUpOrigin` only `unshift`s
into `live.pending` and never calls `drainPending` itself (see that method's own doc) — and nothing between
the synchronous requeue and `submit()`'s own trailing M1 `setBusy(true)` calls `drainPending` either, so
there is no synchronous drain or re-mismatch loop within the same tick. Confirmed empirically too: the
reviewer's repro and this card's scenario (D) both show A surviving with no new loop or crash.
**Scope of this claim (round 4):** this is a SAME-SESSION safety argument only — it covers the requeue and
the alarm, which read/write nothing but `live`/`sessionId` and so can never reach another session's own
`enqueueStdin`. It says nothing about the EXHAUSTED branch's `onGiveUpExhausted` callback, which can
dispatch CROSS-session (a sender-facing park notice to a different session entirely) — that is a
different hazard (the M2 `finalizingTurn` guard, PtyHost-wide, not session-scoped), fixed separately by
deferring that one callback's invocation off-stack; see Round 4 below.

### MINOR-3 — three claims corrected to their true strength

- **"No multi-minute stall" holds only if the owning turn's Stop actually arrives.** If ONLY a
  `UserPromptSubmit` lands (never a Stop for that turn — e.g. the Stop itself is lost, the same class of
  hook-relay drop this whole investigation started from) and the owning turn never otherwise clears busy,
  `busy` stays `true` until `healIfStuck`'s dual staleness bound (`busySince` AND `lastOutputAt` both
  stale — `BUSY_STALE_MS`, minutes by default) eventually recovers it. This is the SAME backstop every
  other give-up path already relies on for the same residual case — not a new risk this card introduces —
  but round 2's record overstated the normal case as if it were the ONLY case.
- **"Proves a different lineage's turn is in flight" overclaimed.** A `UserPromptSubmit` landing does
  mean a turn just started (in flight); a `Stop`/`StopFailure` landing means a turn just ENDED — the
  opposite state. The correct, honest framing (now in both the code comment and this record): a confirming
  hook has ALREADY decided busy's correct value for this moment, whichever way it went — true if a turn
  just started, false if one just ended — and this give-up must never override that decision either way.
- **"Drains on the next natural trigger" was wrong while the mismatch's own cause (the owning lineage still
  owning the composer) persists.** Nothing in this fix releases that ownership. A's NEXT redelivery attempt
  re-mismatches against the SAME owner every time, cycling through this exact give-up path again — it does
  not drain as an ordinary turn. This is bounded by `GIVE_UP_REQUEUE_LIMIT`: once A's own `giveUpRequeues`
  count exceeds it, the terminal branch in `requeueGiveUpOrigin` hands it to `onGiveUpExhausted` (a durable
  message) or drops it (a non-durable one, e.g. a raw human/enqueueStdin-originated turn with no such
  callback wired — see that method's own doc for the "fail toward a duplicate, never a loss" scope this
  does NOT cover) — NOT silently: the exhausted-budget `console.error` at this method's own GIVE-UP
  RECOVERY line (host.ts ~12767) fires regardless of whether a callback is wired, naming the message id,
  its length/redacted excerpt, and whether a callback was handed off or there was none to preserve. Only
  the DOWNSTREAM handling is absent for a callback-less entry, never the log. "Drains on the next trigger"
  was simply the wrong verb for what actually happens.

## Round 4 (Code Review `cba0d2f2`) — the exhausted callback's own M2 throw, and deferring it off-stack

### CRITICAL: the synchronous requeue moved the loss window, not closed it, for the EXHAUSTED branch

Round 3's fix made `requeueGiveUpOrigin` itself run synchronously at the mismatch site — correct for the
requeue and the alarm (see Round 3 above). But when the redelivery it processes has ALREADY exhausted its
`GIVE_UP_REQUEUE_LIMIT`, that same synchronous call reaches the terminal branch and invoked
`m.onGiveUpExhausted?.()` synchronously too, in the SAME call. When the mismatch redelivery itself was
drained by a Stop hook — the ordinary trigger, via `drainPending` inside `deliverHook`'s Stop/StopFailure
case — this synchronous invocation runs INSIDE that Stop's own M2 `finalizingTurn` window (host.ts
~10200→10389; see the M2 INVARIANT box at `deliverHook`'s Stop case for why that window must stay
synchronous at all). If the origin's `onGiveUpExhausted` callback (wired by `enqueueDurableMessage` to
`handleGiveUpExhausted`, sessions/service.ts) reaches its PARK branch, that branch sends a
`[loom:redelivery-parked]` notice to the ORIGINAL SENDER — a DIFFERENT session from the one whose Stop is
currently draining — via `enqueueDurableMessage` → `enqueueStdin`. `finalizingTurn` is a single flag on
`PtyHost`, not per-session, so that OTHER (idle) session's `enqueueStdin` call reaches the idle-submit
path and trips the M2 invariant guard (host.ts ~10609/~10720) — THROWS. `handleGiveUpExhausted`'s own
`try { enqueueDurableMessage(...) } catch {}` (sessions/service.ts ~10561, pre-this-round) swallowed that
throw with no logging at all — the sender-facing park notice was silently lost. Reproduced by the Code
Reviewer (`repro/m2-park-notice.mjs`).

### The fix

`requeueGiveUpOrigin` still runs the REQUEUE and the ALARM synchronously, unchanged from Round 3 — neither
of those touches anything outside `live`, so neither can trip the M2 guard. Only the EXHAUSTED branch's
`onGiveUpExhausted` invocation changes: instead of calling it inline, the method COLLECTS `{id, cb}` for
every exhausted member into a local array and, after its loop, schedules ONE trailing `setTimeout(0)` that
invokes each collected callback, each in its own `try`/`catch` (logging loudly via `console.error` on a
throw — unchanged in spirit from the old inline catch, just relocated). A bare `setTimeout(0)` is a
macrotask: it cannot run until the current call stack — through `deliverHook`'s own Stop-case `finally`
that flips `finalizingTurn` back to `false` — has returned control to the event loop. So by the time any
collected callback actually fires, `finalizingTurn` is guaranteed false, and the SAME
`enqueueDurableMessage`/`enqueueStdin` call that used to throw now succeeds cleanly.

**This does NOT reopen Round 3's stale-generation loss.** The collected closures capture only `m.id` and
`m.onGiveUpExhausted` — never `live`, `sessionId`, or anything else that reads or writes
`live.giveUpOrigin` — so deferring their INVOCATION changes nothing about when `live.giveUpOrigin` is read
or overwritten. Round 3's fix depended entirely on the REQUEUE itself (which still runs synchronously,
unchanged by this round) completing before a later message could overwrite `live.giveUpOrigin`; it never
depended on the exhausted callback's own timing.

**Other callers of `requeueGiveUpOrigin` do not depend on `onGiveUpExhausted` running synchronously, from
PtyHost's OWN logic.** Checked both: `fireEnterAndVerify`'s own GIVE-UP RECOVERY branch (host.ts, inside
its `awaitGiveUpConfirmSettle` callback) calls `requeueGiveUpOrigin(sessionId, gen)` and returns — nothing
after that call reads a result from it. `healIfStuck`'s stale-busy backstop calls
`requeueGiveUpOrigin(sessionId, gen)` in its own `if` branch and also returns immediately after — same
shape. Neither caller is itself inside an M2 window in the first place (fireEnterAndVerify's chain runs
off its own bounded-wait timers, `healIfStuck` runs off the reconcile tick).

**Round 4's "strict improvement, never a behavior change they relied on" claim here was WRONG, and CR4
(`a1be67e1`) proved it.** Round 4's own deferral was UNCONDITIONAL (every exhausted callback, from every
caller, ran off-stack) — so even though PtyHost's OWN logic in `fireEnterAndVerify`/`healIfStuck` doesn't
depend on synchronous invocation, the deferral still changed the OBSERVABLE TIMING for every call through
those paths too, not just the Stop-drained one. Two tests that exercise exhaustion exclusively via
`reconcile()`/`UserPromptSubmit` — never a Stop, never inside `finalizingTurn`
(`message-giveup-remint-no-repaste.mjs`, `pty-giveup-marked-resend-autojoin.mjs`) — flaked 3-of-4 runs at
round 4's tip, reading a parked event / a "re-minted as" log line the instant busy went false, with no
settle. "Never a behavior change they relied on" was true of PtyHost's own code; it was false of the
TIMING those tests observed. See Round 5 below for the fix.

**Also fixed (the reviewer's own follow-up, in scope for this round):** `handleGiveUpExhausted`'s
`try { enqueueDurableMessage(...) } catch {}` (sessions/service.ts ~10561) now logs the caught error loudly
via `console.error` instead of swallowing it — so an invariant throw reaching this site (from THIS bug, or
any other cause) is never silent again, even though the M2-throw cause itself is now closed by the
deferral above.

Regression test: `pty-giveup-ownership-mismatch-enterconfirmed-bail.mjs` scenario (F) — a Stop-drained
mismatch redelivery driven to exhaustion (3 cycles, `GIVE_UP_REQUEUE_LIMIT=2`), whose `onGiveUpExhausted`
callback dispatches into a SECOND, idle session. Proven RED on commit `8bd5ec6c` (reverted, rebuilt,
re-run: the dispatch never lands, `waitUntil` times out) and GREEN after.

**Fallout: the deferral is a real, observable timing change — several EXISTING tests assumed synchronous
invocation.** `onGiveUpExhausted` used to fire in the SAME synchronous tick as the preceding busy-clear for
every caller (not just the Stop-drained case); several tests read a captured side effect (a `rootMsgId`,
an `exhaustedLog` entry, a local `aGaveUpExhausted` flag) the instant they observed `busy` flip to `false`,
with no settle in between — a correct assumption pre-round-4, now a race. A full sweep of every test
DEFINING a real (non-`PtyStub`) `onGiveUpExhausted`/`onKickoffGiveUpExhausted` callback found four that
READ the race and failed outright (`kickoff-giveup-content-mismatch.mjs`, `kickoff-giveup-exhausted.mjs`,
`kickoff-giveup-exhausted-deferred.mjs`, `pty-giveup-exhausted-remint-purge-decline.mjs`) and one more
(`pty-enter-only-verifies-composer-trust.mjs`) that happened to still pass only because its shared
`waitUntil` poll interval (10ms, vs. the failing files' 2ms) gave the deferred `setTimeout(0)` enough
margin — a lucky pass, not a safe one. All five now `waitUntil`-poll for the callback's own effect instead
of reading it immediately.

**"Every OTHER test not affected" was FALSE — CR4 found two more, and the reason the round-4 sweep missed
them is the real lesson.** That sweep grepped for every file DEFINING `onGiveUpExhausted`/
`onKickoffGiveUpExhausted` — but `message-giveup-remint-no-repaste.mjs` and
`pty-giveup-marked-resend-autojoin.mjs` never define the callback at all: they drive the REAL
`SessionService`/`handleGiveUpExhausted` production path and read ITS downstream, durable effects (a
`session_message_gave_up` event with `outcome:"parked"`, a `"re-minted as"` log line) the instant they
observed `busy` flip false — the SAME race, one layer further from the callback's own definition site. **A
definition-grep can only ever find callback AUTHORS, never callback READERS — the two are disjoint
populations, and only a union of both sweeps is complete.** Round 5 fixed both files the same way (poll for
the actual effect) and re-swept the whole corpus by grepping for READER vocabulary instead
(`session_message_gave_up`, `redelivery-parked`, `worker-spawn-broken`, an exact `outcome:"parked"`/`PARKED
after` match, `reminted`, `"re-minted as"` — a bare `parked` substring match is too broad, 109 files, mostly
unrelated rate-limit-park vocabulary; the precise forms above narrowed it to 41) — every hit run and green.

## Do not

- Do not make `requeueGiveUpOrigin` (or `maybeFireGiveUpRecoveryAlarm`) conditional on
  `live.submitGeneration === gen`, `live.enterConfirmed`, or any other signal evaluated AFTER a deferred
  `setTimeout(0)` — a DIFFERENT message draining in that window can overwrite `live.giveUpOrigin` before
  the deferred callback ever runs, losing this origin for good (proven in round 2, then again in round 3
  with a different trigger). Call them SYNCHRONOUSLY, at the mismatch site itself, before `submit()`'s own
  trailing M1 `setBusy(true)` — never defer anything that touches `live.giveUpOrigin`.
- Do not defer the busy-clear decision's OWN logic beyond what `card 844ca34e`'s original rule requires —
  only `setBusy(false)` itself needs to wait for M1; nothing else in this path does.
- Do not read a hook landing in `giveUpWithoutWritingBusyClear`'s window as proof about THIS generation —
  it never wrote anything, so the hook is always about a different lineage's turn, whichever direction
  (started or ended) that hook actually signals.
- Do not claim the content-match purge covers the FUSED-composer duplicate case — `matchesSig`'s whole-text
  equality structurally cannot match a joined/fused prompt. It DOES cover a narrower, non-fused exact-echo
  shape (scenario (E)) — the two are not the same claim; never conflate them.
- Do not try to close the fused-case duplicate risk by building new dedupe — if it's ever worth closing,
  extend the EXISTING `ambiguousDispatches` mechanism (e.g. a substring/partial match mode), don't add a
  second one.
- Do not invoke a budget-exhausted member's `onGiveUpExhausted` synchronously inside `requeueGiveUpOrigin`'s
  own loop WHILE `this.finalizingTurn` is true (round 4/5) — that method itself can run inside
  `deliverHook`'s M2 `finalizingTurn` window (a Stop draining the mismatch redelivery), and the callback can
  reach `enqueueStdin` for a DIFFERENT, idle session, tripping the M2 invariant guard. Collect `{id, cb}`
  and invoke off-stack via a trailing `setTimeout(0)` in that case — see Round 4/5 above.
- Do not defer EVERY exhausted callback unconditionally (round 4's own shape) — round 5 narrowed this to
  `this.finalizingTurn`-gated, because the unconditional form changed observable timing for every caller,
  not just the one case that needed it, and broke two unrelated tests (see Round 5 above).
- Do not let the collected exhausted-callback closures capture `live` or `live.giveUpOrigin` — capture only
  `m.id`/`m.onGiveUpExhausted` (plus `sessionId`, a plain string, harmless for logging) — or deferring their
  invocation could reopen Round 3's stale-generation loss.

## Round 5 (Code Review `a1be67e1`) — narrow the deferral to the one case that needs it

CR4 confirmed round 4's fix closes CR3's M2 notice loss, that the per-callback try/catch isolates a throw
correctly, and that the five tests round 4 fixed are sound — but found a MAJOR regression round 4's own
unconditional deferral introduced: `message-giveup-remint-no-repaste.mjs` and
`pty-giveup-marked-resend-autojoin.mjs`, BOTH unchanged by round 4, now flake 3-of-4 runs at round 4's tip
and pass 3/3 on `8bd5ec6c` — because they read `handleGiveUpExhausted`'s own downstream effects (a parked
event, a re-mint log line) the instant they observe `busy` flip false, and round 4's ALWAYS-defer broke
that timing for EVERY caller, not just the Stop-drained one.

### The fix

`requeueGiveUpOrigin` now defers a budget-exhausted member's `onGiveUpExhausted` off-stack ONLY when
`this.finalizingTurn` is true AT THE MOMENT this method is invoked — the one case the M2 throw can actually
happen. Every other caller (`fireEnterAndVerify`'s GIVE-UP RECOVERY branch, `healIfStuck`) invokes the
collected callbacks SYNCHRONOUSLY, in a plain loop, exactly as every caller did before round 4 ever existed
— restoring byte-identical timing for the overwhelming majority of give-ups, which never touch the M2
window at all. `this.finalizingTurn` is read once, after the loop that builds `exhausted` — a single
synchronous call to `requeueGiveUpOrigin` can never observe it change value mid-call (nothing yields to the
event loop until the chosen branch — the synchronous loop, or the `setTimeout(0)` schedule — actually runs),
so checking it once there is equivalent to checking it at each callback's own would-be invocation point.

**This removes the CR's own deferral-window concerns for `fireEnterAndVerify`/`healIfStuck`** — a late
confirming hook now has no window where it could miss an unwritten park record, a re-mint can no longer
escape the `logicalId` purge by racing a deferred dispatch, and a recycle flush reading pending/durable
state synchronously after one of these call sites can no longer observe a stale snapshot. All three were
CR4's stated worries about keeping the deferral broad; narrowing it to `finalizingTurn`-only closes them by
construction, for every caller except the one that still needs deferring.

**The remaining window, stated at its true strength:** ONLY a budget-exhausted give-up whose
`requeueGiveUpOrigin` call happens to run while `this.finalizingTurn` is true (today: exclusively a Stop
hook's own `drainPending` call draining a mismatch redelivery that exhausts) still defers its
`onGiveUpExhausted` by exactly one macrotask (a bare `setTimeout(0)`) — bounded, never more than one event-
loop tick, and only on that one path. Every other give-up, exhausted or not, anywhere else in this file,
observes zero timing change from round 4 at all.

**Test (F)'s RED is now a direct assertion, not merely a `waitUntil` timeout shape.** The file now captures
every `console.error` call; scenario (F) asserts, IMMEDIATELY after the Stop call (before the later bounded
wait, so it is evaluated regardless of whether that wait later times out) that neither "M2 invariant
violated" nor "onGiveUpExhausted threw" was ever logged for this cycle. Verified RED on `8bd5ec6c` (the
assertion itself prints `FAIL`, before the later wait's own timeout crash) and GREEN at this round's tip.

**The two racy files are also made robust independently of the narrowing**, per the same discipline as
round 4's five: `message-giveup-remint-no-repaste.mjs` now `waitUntil`-polls for the durable
`session_message_gave_up`/`outcome:"parked"` event instead of reading it the instant busy-false settles;
`pty-giveup-marked-resend-autojoin.mjs` now polls for the `"re-minted as"` log line the same way. Neither
currently drives its exhaustion through a Stop hook (both use `reconcile()`/`UserPromptSubmit` only), so
neither exercises the `finalizingTurn`-gated defer path today — but the poll makes them correct regardless
of whether a future change ever routes them through it, rather than relying on "doesn't currently hit M2"
as an implicit, undocumented invariant.

**The reader sweep (not a definition sweep).** Round 4's sweep grepped for files DEFINING
`onGiveUpExhausted` — necessarily blind to a file that reads the callback's DOWNSTREAM effects without ever
defining it itself (exactly the shape of both regressions above). Round 5 re-swept by grepping for READER
vocabulary instead: `session_message_gave_up`, `redelivery-parked`, `worker-spawn-broken`, an exact
`outcome:"parked"`/`PARKED after` match, `reminted`, `"re-minted as"` (a bare `parked` substring is far too
broad — 109 files, mostly unrelated rate-limit-park vocabulary; the precise forms narrowed it to 41). Every
hit run, serially, one lane — all green.

## Source

`packages/daemon/src/pty/host.ts`: the synchronous `@decision 08ac0e79` call site inside `submit()`'s
ownership-mismatch branch, `giveUpWithoutWritingBusyClear`'s own JSDoc + inline anchor (round 3), and
`requeueGiveUpOrigin`'s own `@decision 08ac0e79` anchor on its `finalizingTurn`-gated exhausted-callback
dispatch (round 4/5). `packages/daemon/src/sessions/service.ts`: `handleGiveUpExhausted`'s own
`enqueueDurableMessage` catch, now logging loudly (round 4).
