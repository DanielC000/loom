# 0bafbe35 — the second in-suite failure shape: a deterministic, no-contention reproduction

Card `0bafbe35` ("the second in-suite failure shape — a 120s hang with GIVE-UP RECOVERY — still
UNREPRODUCED and UNNAMED") asked for a FORCED reproduction of the hang shape, not a sampled one, and for
the residual (the file's own 120171ms total vs. a single `waitUntil`'s own 49737ms "ARRIVED LATE"
sub-span) to be targeted specifically, not just the sub-span lag. Three staged, deterministic experiments
did this. **No production code was changed as part of this investigation.** All three stages ran as
scratch driver scripts against the already-built `dist/pty/host.js` and the existing
`fake-claude-cli.mjs` test fixture — read-only consumers of production code, never edits to it.

## Pre-registration (written before Stage 3 ran, quoted verbatim)

**Prediction:** the unmodified 6-role sweep with the stall injected at the manager-role position, under
the real `TEST_TIMEOUT_MS=120000`, lands at `status:"timeout"` at ~120000ms with the
`GIVE-UP RECOVERY after 4 Enter attempts` tail — matching the card's own 120061ms / 120171ms.

**What would refute it, agreed in advance:** (a) the process exits on its own (fast `exit 1`); (b) it
times out but the tail does NOT match; (c) it lands nowhere near ~120s.

**The limit, pre-committed so it cannot be slid past later:** a match proves **the shape is reproducible
by this mechanism.** It does **NOT** prove the production failures had this cause. Other mechanisms can
produce the same shape, and this project has been burned exactly there
([[corroborating-a-premise-is-not-corroborating-the-inference]]). It is correct to write *"the 120s-hang
shape is now deterministically reproducible via an uncaught-throw-blocks-exit path"*; it is **not**
correct to write *"the card's failures were caused by this."* What would move the stronger, causal claim
forward: recovering ambient host-load/timing data from the moment of an ACTUAL gate rejection and checking
it for the same signature (process never self-exits, external-killed at the ceiling) instead of inferring
it; or, once card `a1a8c5c4`'s missing PASS/FAIL output-capture channel lands, finding a real gate's own
captured `outputTail` showing the same non-exit pattern. Neither has been done here.

## Stage 1 — force GIVE-UP RECOVERY deterministically, no real contention needed

Script: `scripts/stage1-force-giveup.mjs`. Condition: `gate_queue` cap=2, **activeCount=2 throughout**
(two Loom-fleet merge gates running the whole time — real ambient load, not an idle box).

Two scenarios, same bare-`PtyHost` harness shape `kickoff-real-spawn.mjs` itself uses (no `index.ts`
bootstrap, no `onGiveUpExhausted` wiring):

- **control** (`FIXTURE_DEBOUNCE_MS=250`, the fixture's real default): GIVE-UP SUPPRESSED fired (the
  fixture produced output before the daemon's 4th attempt timed out). `FIXTURE_RECEIVED` still took
  9246ms from spawn — slower than an idle box would predict, consistent with the two active gates.
- **forced** (`FIXTURE_DEBOUNCE_MS=10000`, past the daemon's own ~4-6s give-up window): **GIVE-UP
  RECOVERY fired, with a tail byte-identical to the card's own quoted line**
  (`GIVE-UP RECOVERY after 4 Enter attempts — no engine output observed since the final Enter write;
  turn never confirmed started; recovering busy so the session doesn't wedge`). No redrain was ever
  logged — confirmed empirically, not just by reading the source, that the requeue-hold-redrain machinery
  never fires here (see "reconcile() is not wired" below). `FIXTURE_RECEIVED` still appeared, 20234ms
  after spawn, from the fixture's own eventual flush alone — no daemon-side retry involved.

**Unplanned:** between the control scenario's `host.stop(...,"hard")` and the forced scenario's
`host.spawn()` — one kill immediately followed by one new spawn, no concurrency at all — node-pty's
`conpty_console_list_agent.js` threw `Error: AttachConsole failed`, the same signature as card
`e4a2e789`'s named crash shape. This script's own process did NOT die (both scenarios completed, the
summary printed, clean exit 0) — see "AttachConsole specimens" below.

## Why the requeue/redrain arc cannot be the mechanism here — a real, code-grounded correction

`requeueGiveUpOrigin` (`host.ts`) puts a given-up message back on `live.pending`, `giveUpHeldUntil`-tagged
for `GIVE_UP_HOLD_MS` (default 20000ms) — but does not itself schedule anything. The ONLY things that ever
redrain a held entry or re-check `healIfStuck` after the initial call are a Stop hook, a box-free
transition, or `reconcile()` — and `reconcile()`'s own doc (`host.ts:5247`) says it is *"wired to a timer
in `index.ts`."* The bare `new PtyHost(events)` both `kickoff-real-spawn.mjs` and every script in this
investigation construct never goes through `index.ts`. `kickoff-real-spawn.mjs`'s own `events` object also
carries no `onGiveUpExhausted` callback. **Neither the redrain-after-hold arc nor `healIfStuck`'s
stale-busy backstop can ever fire in this test context — confirmed both by reading the source and by
observing zero redrain log lines across Stage 1's forced run.** This directly shaped Stage 2 and 3's own
design: forcing a late-but-eventually-arriving `FIXTURE_RECEIVED` needs only a delayed fixture flush, not
a simulated retry cascade.

(A real production session — not this test harness — DOES have all of that machinery wired, and produces
a genuinely different, much longer arc when it fires; that is a separate, real finding from the same
investigation, recorded in project memory rather than here, since it bears on production message delivery
generally and not on this card's specific in-suite shape.)

## Stage 2 — does the process exit promptly after the uncaught throw? It does not.

Scripts: `scripts/stage2-inner.mjs` (the forced scenario, structured to mirror
`kickoff-real-spawn.mjs`'s own lack of a `try/catch` around the `FIXTURE_RECEIVED` wait) and
`scripts/stage2-outer.mjs` (spawns it as a real raw child and times its exit, the same shape
`test-daemon.mjs`'s own `runOne()` uses). Condition: `gate_queue` cap=2, **activeCount 0→1** — 0 active
gates at launch, one Loom merge gate started partway through the run (~89s in, ~5-6s before the
AttachConsole crash below) — a genuinely different ambient condition from Stage 1's steady-2.

`FIXTURE_DEBOUNCE_MS` was forced to 150000ms — past `waitUntil`'s own grace deadline
(budget 19000ms + grace `min(19000×4,120000)`=76000ms = 95000ms) — so the wait deterministically hits its
`ABSENT` branch (never the fixture-timing-dependent `ARRIVED LATE` branch) at a known, fixed elapsed time.

**Result:**
- The throw fired at +95248.5ms — matching the math (`[waitUntil-outcome] ABSENT through 95008ms`).
- The outer-`finally`'s `host.stop("stage2-worker","hard")` ran immediately after: **`durationMs=11.91`
  — fast.** This is a real measured data point that WEAKENS (does not refute — n=1) the
  node-pty-kill-may-block synthesis below.
- Immediately after that `stop()`, a second AttachConsole crash fired (specimen 3 of 4 total — see below).
- Node then printed the uncaught `waitUntil` `Error`'s own stack trace (the genuine "uncaught exception"
  report) — **and the process just sat there.** No further child output appeared.
- The outer harness's own 130s absolute bound eventually had to `SIGTERM` it, at +130033.6ms since launch.
- **`msFromThrowMarkerToExit = 34656.3ms` — and this is explicitly a LOWER BOUND, not the true hang
  duration**, since the process was killed rather than allowed to exit on its own. It gave no sign of
  ever exiting unassisted.

**Why this is the headline result of the whole investigation:** it explains the card's own
`status:"timeout"` failures (an EXTERNAL `child.kill()` at `TEST_TIMEOUT_MS`, not a fast `exit 1`)
*mechanically*, not just plausibly. The hang is not caused by anything being SLOW — the one thing
measured directly (`stop()`) was fast, and nothing else ran in the interim. It hangs because, once an
uncaught `waitUntil` throw fires anywhere in this file, **the process structurally cannot self-terminate.**
The root cause of *why* Node doesn't self-terminate here has not been established (candidates not yet
checked: `_tmp-fixture.mjs`'s own `beforeExit`/`exit` hooks; a lingering handle from the crashed
AttachConsole helper subprocess; something in node-pty itself keeping the event loop referenced) — flagged
as open, not guessed at further.

## Node-pty-kill-may-block synthesis — MINE, UNESTABLISHED

Speculative synthesis, not a daemon claim: node-pty's Windows kill path may itself invoke the same
console-list-agent helper that throws `AttachConsole failed` (used to enumerate/verify the console process
list at teardown, not only at spawn) — under contention this could either throw fast (the known crash) or
block without throwing (a slow, silent stall inside a single `host.stop(...,"hard")` call), which would
make the crash and a hang two outcomes of one mechanism. **Stage 2's own measurement (`stop()` took
11.91ms) is evidence against this synthesis holding in that specific run** — it is not what made that run
hang. Kept labelled mine and unestablished throughout this investigation on explicit instruction, precisely
because it is the kind of hypothesis that gets adopted as fact by restatement.

## Stage 3 — the actual reproduction: does the full sweep land at status:"timeout" with the matching tail?

Scripts: `scripts/stage3-inner.mjs` (a faithful copy of `kickoff-real-spawn.mjs` — every scenario, every
`check()`, unchanged — with exactly one injected line: `FIXTURE_DEBOUNCE_MS` forced to 150000ms only when
`role === "manager"`, matching the ordinal position — role #2 of 6 — both real card instances failed at)
and `scripts/stage3-outer.mjs` (mirrors `test-daemon.mjs`'s own `runOne()`: spawn, `TEST_TIMEOUT_MS=120000`,
`child.kill()` on timeout, `status: timedOut ? "timeout" : status`). Condition: `gate_queue` cap=2,
**activeCount=1 steady throughout** (same op start→end) — a third, distinct ambient condition from Stage
1's steady-2 and Stage 2's 0→1 transition.

**Result — the pre-registered prediction was confirmed, and none of the three agreed-in-advance
refutation conditions were met:**
- `status="timeout"`, `durationMs=120047` — vs. the card's own 120061ms/120171ms, within ~15-125ms.
- Tail, extracted from the raw combined output:
  `GIVE-UP RECOVERY after 4 Enter attempts — no engine output observed since the final Enter write; turn
  never confirmed started; recovering busy so the session doesn't wedge` — **character-for-character
  identical** to the card's own recorded tail.
- (a) the process did NOT exit on its own — it genuinely required the outer `child.kill()`, consistent
  with Stage 2. (b) the tail matches exactly, not approximately. (c) it landed at 120047ms, not "nowhere
  near" 120000ms.

**A verification bug in the first run of this experiment, kept in rather than hidden:** the outer
harness's first version of the character-level tail diff scanned `stdout` only. The `GIVE-UP RECOVERY`
line is written via `console.error` — i.e. it lands on `stderr` — so that first automated diff reported
zero matches even though the line was present (visible directly in the combined terminal output). The
match was confirmed by manual inspection at the time; `stage3-outer.mjs` as committed here scans both
`stdout` and `stderr` and would report the match automatically on a re-run. A findings document that hides
its author's own near-miss is less trustworthy, not more, so it stays in.

Because the forced debounce (150000ms) was chosen for a deterministic, guaranteed-to-fire ABSENT-branch
throw, this run's own `[waitUntil-outcome]` was `ABSENT through 95005ms`, not the card's own
`ARRIVED LATE at 49737ms` sub-variant — a deliberate choice, not an attempt to match that specific number.
Per Stage 2's finding, both sub-branches throw through the identical `_wait.mjs` code path, so the
downstream mechanism (uncaught throw → no self-exit → external kill at the ceiling) applies identically
regardless of which sub-branch triggers it; the 49737ms figure specifically was never chased.

## What this does NOT explain

Two things this investigation surfaced and left open, stated as such rather than glossed over:

1. **Why Node doesn't self-terminate after the uncaught throw here** — see Stage 2's own paragraph above.
2. **A separate, real puzzle from the same broader delivery-path investigation** (not this card's own
   in-suite shape, but the production submit/confirm path this shape's tail text belongs to): on a real
   session, `fireEnterAndVerify` writes an Enter unconditionally on every one of 4 attempts, no silent
   skip — eight Loom-issued `tag=enter` writes were confirmed, via the daemon's own `[pty-write]` log,
   to have registered nothing, while a single, later, out-of-band `tag=chunk` keystroke resolved the
   turn. Genuinely unexplained; not investigated further here since it is outside this card's own scope
   (a bare-`PtyHost` test harness with no reconcile/heal machinery wired at all, as established above).

## AttachConsole specimens — recorded, not chased

Four total across this investigation, none investigated further per standing instruction (this card's own
DoD-3 — whether AttachConsole is a consequence of "any hard kill" — was already refuted on a separate,
code-grounded argument: `kickoff-real-spawn.mjs` itself calls `host.stop(id,"hard")` unconditionally after
every scenario, pass or fail, so hard-kill presence has zero variance across the outcomes it would need to
discriminate):

1. Stage 1: between the control scenario's `stop()` and the forced scenario's `spawn()` — one kill
   immediately followed by one new spawn, no concurrency.
2. Stage 2: at `stage2-worker`'s own outer-finally `stop()` — a single spawn + single stop, no concurrency
   at all, 0 active gates at launch (1 by the time of the crash).
3. Stage 3: at `real-manager`'s own `spawn()`.

All three (plus a fourth counted the same way across Stage 1's two runs) fired at a far lower concurrency
bar than card `e4a2e789`'s established conjunction (peak cross-process concurrency ~7-8 AND per-copy
sequential spawn depth ≥9) — none of these runs had more than 1-2 real pty sessions alive at once. This
weakens that conjunction's claimed *necessity* (not its reality — it may still be *sufficient*) and is
being tracked separately at n=3-4 by the card's own manager; not this investigation's to chase further.

## Condition stamps, together

| Stage | `gate_queue` condition | Outcome |
|---|---|---|
| 1 | cap=2, activeCount=2 steady | RECOVERY forced, exact tail match, no redrain |
| 2 | cap=2, activeCount 0→1 | throw fires on schedule; process never self-exits (≥34.66s, lower bound) |
| 3 | cap=2, activeCount=1 steady | `status="timeout"`, 120047ms, exact tail match |

The same outcome (deterministic reproduction, no self-exit, matching signature) held under three
genuinely different real ambient conditions — a stronger result than three identical runs would have
been.

## Retitle proposed and approved

Original: *"test(daemon): the second in-suite failure shape — a 120s hang with GIVE-UP RECOVERY — is
still UNREPRODUCED and UNNAMED"*. Proposed and approved by the card's manager:
*"test(daemon): the second in-suite failure shape's 120s hang is now REPRODUCED — an uncaught-throw-
blocks-exit mechanism, deterministic, no contention required."*
