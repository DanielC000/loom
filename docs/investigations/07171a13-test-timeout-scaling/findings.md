# 07171a13 — should the per-file test timeout scale with observed gate concurrency? **No — keep the constant.**

Read-only measurement pass against card `07171a13`. **No production code changed. No gate run. No load
generated.** Every number below comes from a readonly query against the live `loom.db`'s
`orchestration_events` table (`{ readonly: true, fileMustExist: true }`, same pattern as
`docs/investigations/99fb882e-gate-suite-timing`) and from reading `packages/daemon/scripts/test-daemon.mjs`
and `packages/daemon/src/orchestration/gate-runner.ts` at the currently-checked-out HEAD, plus three
existing investigations already banked in this repo (`a591a654`, `e4a2e789`, `99fb882e`) and two prior
board cards (`b5af744d`, `cb1101a0`).

**Headline recommendation: do not make `TEST_TIMEOUT_MS` a function of `concurrentGates`/
`concurrentGatesMax` (or any other admission-count signal), and do not widen the blanket constant.**
This is a DoD-1 written recommendation for `question_ask` to the owner, per the card's own instruction
that this is not a change a worker/agent makes on its own authority — see "What this hands to the owner"
at the end.

## 1. The card's own table, re-derived — and one correction to how to read it

`node scripts/concurrency-fail-rate.mjs` (in this directory) reprints the card's own three opIds in full
from `orchestration_events`:

```
df051231  passed:true   durationMs:1079559  concurrentGates:1  concurrentGatesMax:1  (batched, branchCount:2)
cd7bd162  passed:false  durationMs:1245683  concurrentGates:2  concurrentGatesMax:2  (batched, branchCount:3)
d9a2256c  passed:false  durationMs:1300945  concurrentGates:2  concurrentGatesMax:2  (solo)
```

**These `durationMs` values (1080–1301s, ~18–22 min) are the WHOLE GATE STEP's wall time — the entire
~864-file suite — not the `56.2s`/SIGTERM-killed figure the card cites for `batch-merge-robustness.mjs`
specifically.** That per-file number lives in the per-file gate-timing NDJSON
(`~/.loom/gate-timing/daemon-per-file-timing.ndjson`, the instrument `a591a654` also used), a different
store from `orchestration_events`. This pass did not have that NDJSON's rows for these three specific
opIds available to re-derive the per-file number directly — flagging this as a genuine gap rather than
implying it was checked. The whole-gate durations above are still useful context (they confirm all three
are full 864-ish-file runs, consistent with the card's own framing), but do not conflate the two
instruments — see project memory `a-rule-stored-next-to-an-artifact-does-not-check-it`'s "four stamps"
discipline: state which instrument a number comes from.

## 2. Same question, much larger n — `gate_history` already has the answer to "does fail rate rise with concurrency"

`node scripts/concurrency-fail-rate.mjs` buckets **every** Loom-project `build_gate`(+retry) row with a
real `durationMs` (`reused` rows excluded) and `durationMs > 500_000ms` (a full-scale proxy, validated
below) by outcome:

```
FULL-SCALE ONLY (>500s), n=1063:
  concurrentGates=1:     n=686  fail=93  failRate=13.6%
  concurrentGates=2:     n=269  fail=53  failRate=19.7%

  concurrentGatesMax=1:  n=313  fail=29  failRate=9.3%
  concurrentGatesMax=2:  n=370  fail=72  failRate=19.5%
  concurrentGatesMax=3:  n=1    fail=0   failRate=0.0%
```

**Proxy validation:** 0 of the 1063 full-scale rows carry `emitCompareReduced===true` (reduced gates
measured 27–130s standalone elsewhere in this same dataset — see the raw dump in §1 of the script's
stderr output), confirming the `>500s` cut cleanly separates full-suite runs from reduced ones.

**Date range:** the `concurrentGates` population spans 2026-07-23 → 2026-09-05 (~6.5 weeks); the
`concurrentGatesMax` population (a later-added field) spans 2026-08-01 → 2026-09-05 (~5 weeks).

**Reading this honestly, in both directions:**
- **This corroborates the card's own directional worry, at ~350x the n.** Fail rate roughly doubles
  going from uncontended to co-admitted, both by admission-instant (`concurrentGates`) and by
  whole-run-max (`concurrentGatesMax`). This is a real, much-larger-sample signal the card's own n=3
  table could not provide.
- **It does NOT establish that TIMEOUTS specifically drive this.** Confirmed empirically here (matches
  `99fb882e`'s own earlier finding, re-verified): **merge-kind `build_gate` rows in this dataset do not
  reliably carry a `timedOut` or `failingTest` field** — of the rows sampled at HEAD (see the raw
  `--- seq=... ---` dump this script's earlier draft produced), most `passed:false` rows carry only
  `durationMs`/`concurrentGates`/`concurrentGatesMax`, nothing naming *why* they failed. Per-step /
  per-file detail (`verdict_payload_json`) is populated only for `kind='gate'` rows — a worker's own
  `run_gate` self-check — never for `kind='merge'` rows (`99fb882e`'s own finding, unchanged today). **So
  this 2× fail-rate rise is a real signal about gate outcomes in general, not a demonstrated signal about
  per-file timeouts in particular** — it could equally be ordinary flaky/real assertion failures that also
  become likelier under contention, or content unrelated to timing at all.
- **It is confounded by time, and this project has already measured that this specific confound is
  real.** The population spans ~5–6.5 weeks. `99fb882e`'s own DoD-1 (same repo, same table, re-verified
  here rather than re-run) found the **daily minimum full-suite duration rose ~75% over just 10.5 days**
  or a comparable earlier window, independent of concurrency — a "rising floor." If co-admission also
  became more common later in this window (plausible — more batching/more parallel workers as the fleet
  matured), a naive concurrency-vs-fail-rate correlation over a multi-week span cannot cleanly separate
  "concurrency causes more failures" from "the suite got slower/flakier over time AND concurrency also
  rose over time" — two different explanations for the same table. This pass did not attempt to
  time-slice the correlation to control for that; flagged as a real limit on what §2 can support, not
  glossed over.
- **`concurrentGates`/`concurrentGatesMax` is a semaphore-admission-only signal — blind to the load that
  actually matters.** This is already documented at the tool level (`gate_queue`'s own description) and
  confirmed by the card's own bounds: `cgMax` cannot see a hand-run test, a worker running its own
  affected files directly (this project's own DoD default), or any non-agent host load. So even a
  *validated* concurrency→fail-rate correlation would only be scaling on a partial, noisy proxy for the
  thing that's actually slowing files down.

## 3. Why "scale by concurrency" specifically is very likely the wrong lever, independent of §2's confounds

`docs/investigations/a591a654-gate-timing-attribution/findings.md` (already banked in this repo, not
re-run here) measured the **same suite at the same pool size** running **21–77% more SUM-seconds inside a
merge-gate worktree than standalone, in all 4 sampled runs** — and critically, **this slowdown is present
even in the two runs with ZERO foreign-gate contention** (its own "What is UNATTRIBUTED" section: 21–50%
SUM increase, 11–23% slower per-file median, at genuinely zero measured gate-semaphore overlap). That
investigation explicitly could not identify the mechanism (candidates: per-worktree `node_modules`/cache
locality, AV scanning a fresh worktree, ordinary background daemon activity) — but the fact of an
unattributed floor, independent of `concurrentGates`, is itself decisive for this card's specific
question: **a timeout that scales only with `concurrentGates`/`concurrentGatesMax` would give zero benefit
to the dominant, always-present floor case, and would only ever activate for the narrower (and here,
only 1-vs-2) co-admission case.** If a dynamic signal is worth building at all, the host-CPU-busy sampler
`test-daemon.mjs` already runs continuously through every gate run (`createHostLoadSampler()` /
`onHostSample`, `scripts/test-daemon.mjs:1684-1719`, emitting a `host-sample` NDJSON row on every tick) is
a strictly better candidate variable than `concurrentGates`, because it is not blind to the floor or to
non-gate host load — but see §4 for why even that is not free of the real cost this card asks to weigh.

## 4. The real, demonstrated cost of ANY scaling — this project has already run this experiment twice

**Twice, independently, this project has widened a wall-clock ceiling to tolerate host-condition-driven
slowness, and both times the record shows why that specific move is a bad trade — not hypothetically, but
as lived history on this exact repo:**

1. **Card `cb1101a0`** (`serve-static.mjs`'s 5000ms poll ceiling, widened from 1000ms in `d02b61f9` after a
   contended-gate rejection): held **12 days**, then failed again under the same contention shape. The
   card's own verdict, verbatim: *"The previous remedy was a 5x widen. It held 12 days and then failed
   again — in another cap=2 run. A third widen is not a fix; it is the same move at a larger number, and it
   degrades the test's power to detect a real hang every time it is applied."* Its own resolution direction
   was explicitly **not** another widen — it points at Loom's own gate-runner as the model to copy (§5).

2. **Card `b5af744d`** (`batch-merge.mjs`, split into `batch-merge.mjs` + `batch-merge-robustness.mjs`
   earlier today, commit `0fdea785` — the very split whose successor file is what motivated *this* card)
   **explicitly ruled out a `TEST_TIMEOUT_OVERRIDES` entry for this exact file**, verbatim: *"NOT a
   `TEST_TIMEOUT_OVERRIDES` entry. Ruled out explicitly: it is the `cb1101a0` widen-treadmill, and it would
   leave a file that takes 88s of a 2-lane daemon-global gate untouched. Do not propose it."*

**Scaling `TEST_TIMEOUT_MS` by observed concurrency is the same move as both of these, generalized and
made automatic.** It does not reduce a file's real wall-clock cost (in `batch-merge`'s own case,
established by `b5af744d`'s own profiling to be pure git-volume content growth, not a cuttable fixed cost)
— it only tolerates that cost for longer, and specifically in the co-admission case where a lane of the
daemon-global 2-lane `GateSemaphore` is already scarcest, so the file occupies it for even longer,
delaying whoever else is queued.

**Separately, and more fundamentally (this is the card's own DoD-2 concern, and it is not hypothetical
either): `docs/investigations/e4a2e789-host-load-sampler/findings.md` (already banked, not re-run here)
found that at least one gate-suite test's historical timeouts are dominated by a CRASH-turned-HANG, not
genuine slowness.** For `kickoff-real-spawn.mjs`, of 11 recorded merge-gate rejections, **7 were `timeout`**
— and that investigation reproduced a real mechanism (a node-pty `AttachConsole` failure inside `.kill()`)
that can hang the test process **past its own success banner**, confirmed first-party in that file's own
header comment (*"an uncaught async exception from node-pty's console-list-agent helper... is capable of
hanging the whole process past its own success banner"*). **A scaled-up timeout does not rescue this
class of failure — it cannot, because the process is genuinely stuck, not genuinely working — it only
makes the daemon (and whoever is queued behind this lane) wait longer to learn the same thing.** This is
exactly the cost the card's own DoD-2 asks to weigh honestly, and this repo already has a specimen of it,
not just the general principle.

## 5. What DOES look like a legitimate lever — not decided or implemented here

**Loom's own merge-gate STEP timeout already solves a structurally identical problem, one layer up, and
does it without either of the costs in §4.** `GATE_EXTEND_IDLE_MS`
(`packages/daemon/src/orchestration/gate-runner.ts:461`, default 60s) auto-extends a step's timeout for as
long as it keeps producing output — keyed off **progress** (bytes on stdout/stderr), not elapsed
wall-clock — specifically because, per that file's own comment (line ~472), *"elapsed time alone cannot
tell 'working hard' from 'hung'."* The idle/extend logic lives at `gate-runner.ts:780-816`.

**The per-file `TEST_TIMEOUT_MS` mechanism (`scripts/test-daemon.mjs`) has no equivalent today.**
`spawnWithTimeout` (`scripts/test-daemon.mjs:1124-1170`) is a bare `setTimeout(() => { ...; child.kill(); },
timeoutMs)` with no relationship to the child's `stdout`/`stderr` `data` events, which this same function
already listens on (lines 1135-1136) — the signal a stall-aware version would need is already being read,
just not used for this purpose. This shape would NOT carry either cost from §4: a genuinely silent/hung
process (including the AttachConsole crash-hang in §4) still gets killed at the same short ceiling, while
a process that's still visibly working (e.g. `batch-merge-robustness`'s real, git-volume-driven cost)
gets real headroom without the daemon having to guess a multiplier from a noisy admission-count proxy.

**This is flagged as the most promising direction, not decided or landed here** — it changes a mechanism,
not just a pinned value, so it is its own design decision and its own card if the owner wants to pursue
it; out of this card's DoD, which is a recommendation only.

## 5b. A curated, already-shipped mitigation for this failure class exists — verified, and it does not answer this card

A manager redirect during this pass pointed at `ISOLATED_REAL_SPAWN_BASENAMES`
(`scripts/test-daemon.mjs:1053-1066`, currently **12** members) + its gating flag,
`LOOM_GATE_ISOLATED_REAL_SPAWN_PHASE` (`ISOLATED_REAL_SPAWN_PHASE_ENABLED`, `scripts/test-daemon.mjs:1094`):
when set to `"1"`, these 12 real-spawn/git-heavy files run **first and sequentially at pool 1**, instead of
contending inside the ordinary 3-lane pool — a direct structural answer to "timing-sensitive files get
killed under contention," and a relayed finding said it is wired but never actually enabled anywhere.

**Re-derived independently rather than trusted (per this project's own standing rule — a relayed
COUNT is not the same as a relayed ABSENCE):**
```
git grep -in "LOOM_GATE_ISOLATED_REAL_SPAWN_PHASE"   → 3 hits, repo-wide, no assignment anywhere
  scripts/test-daemon.mjs:1088  (doc comment: "Set ... =1 to opt in")
  scripts/test-daemon.mjs:1094  (the read site: process.env.LOOM_GATE_ISOLATED_REAL_SPAWN_PHASE === "1")
  src/orchestration/gate-timing-band.ts:74  (doc comment, describes the flag as unset)
No .github/workflows hit. No tracked .env file. ~/.loom/.env does not exist on this daemon at all
(confirmed: `ls` reports "No such file or directory").
```
**Confirmed: the flag is unset everywhere this daemon could read it from — the relayed finding checks out.**

**Was this a deliberate park or an accidental non-wire-up? Deliberate — the file's own comment already
answers it, and `git log` confirms the commit it describes.** `scripts/test-daemon.mjs:1073-1094` (card
`0f0816e2`'s CR follow-up, introduced in commit `fa9dfb92`, 2026-08-28) states the measured tradeoff
directly:
- **Measured cost, standalone, on the (then-)10-file subset: +229.4s / +117%** (493.2s → 426.0s aggregate,
  but wall-clock tracks aggregate at pool 1, so +229.4s of real wall-clock for that subset alone).
- **Estimated cost embedded in the real full gate: +230s to +285s, ~24–30% of a ~16-minute gate** — stated
  explicitly as *"a PERMANENT tax on every merge gate on this daemon-global, capped, SHARED resource (a
  busy fleet's other projects queue behind it too)."*
- **For a benefit the filing card's own DoD-4 explicitly forbids claiming**, verbatim: *"no causal
  mechanism behind the intermittent timeouts was ever identified."*
⇒ **This was switched off on purpose, with the cost measured and the benefit explicitly unproven — not
forgotten.** This is a complete, sufficient answer to "why is this default off," so this pass did not go
looking for a second explanation.

**The quoted cost is now understated, not current.** The measurement above was taken against a
**10-file** version of the list; two more members were added afterward (`merge-canonical-dirty-overlap-
backstop`, card `4b7ff996`; `merge-canonical-untracked-overlap-backstop`, card `98d6264d` — both still
present in the file's own membership doc as "ADDED" entries, not part of the original measurement) and the
list is 12 today. Enabling the flag today would cost **more** than the quoted +230–285s, not the same or
less — the number in the comment was never updated after the list grew.

**And critically: `batch-merge-robustness.mjs` — the file that actually triggered this card — is not, and
has never been, a member of `ISOLATED_REAL_SPAWN_BASENAMES`.** Checked directly (`grep -c` against the
file): 21 `createWorktree` calls, 0 `new Db(`/`new SessionService(` boots, 0 real pty spawns — a real
git-subprocess volume comparable to (by raw `createWorktree` count, higher than) several current members
(`merge-canonical-dirty-overlap-backstop`: 4×, `merge-stranded-backstop`: 2×), but paired with none of the
in-process daemon-boot half those members also carry. **⇒ Even if the flag were enabled today, it would
not isolate or protect this card's own trigger file at all** — it would only sequence the 12 already-listed
files, adding their cost to every gate, while `batch-merge-robustness.mjs` kept running in the ordinary
contended pool exactly as it does today.

**Conclusion, folded into the DoD-1 recommendation: do not enable `LOOM_GATE_ISOLATED_REAL_SPAWN_PHASE` as
this card's answer.** It is not a fix for the file that motivated this card, it carries a real, measured
(and now understated) permanent tax on every gate on this shared daemon, and its own filing card already
disclaims a proven causal benefit against intermittent timeouts. Whether `batch-merge-robustness.mjs`
itself belongs on `ISOLATED_REAL_SPAWN_BASENAMES` — its real-git volume looks like a plausible fit by the
list's own stated criteria — is a separate, judgment-curated question for whoever owns that list next; not
decided here, and orthogonal to whether the flag should ever default on (that default is card `7bc340b7`'s
scope, not this one's).

**The two `TEST_TIMEOUT_OVERRIDES` entries flagged for a possible stale justification (`:981`–`:982`,
`merge-canonical-dirty-overlap-backstop` / `merge-canonical-untracked-overlap-backstop`) — checked, and
NOT stale, no edit made.** Their comments justify the 300s override by **list membership** ("comparable
real-git-subprocess volume to `merge-stranded-backstop`", "carries the SAME override for consistency with
that model") — a static classification fact that holds regardless of whether the isolated-phase
*scheduling* mechanism tied to that list ever executes. Neither comment claims the isolated phase runs or
that these files benefit from its sequencing; the override applies unconditionally at
`scripts/test-daemon.mjs:1296` (`TEST_TIMEOUT_OVERRIDES[name] ?? TEST_TIMEOUT_MS`), independent of the
flag, and both files are today running in the ordinary contended pool with this override already active.
Nothing here points at a mechanism that never executes — it points at a list that exists and groups these
files correctly regardless of the flag.

## 6. On "just keep splitting" — also not a complete answer, on the campaign's own numbers

The card's own headline number — a file at `~1.36×` headroom (`batch-merge`, pre-split) crossed a
`~2.1×` blow-up factor once co-admitted (per the card's `df051231`/`d9a2256c` comparison for
`batch-merge-robustness.mjs`) — **already exceeds the margin splitting realistically buys**: `b5af744d`'s
own split targeted "≥2× headroom" as comfortable, and a ~2.1× swing between host conditions can erase that
on its own, independent of file content. **Splitting remains legitimate only when per-scenario profiling
finds real, cuttable structure** (as `b5af744d` did — no single dead fixed cost, but a clean scenario-group
boundary existed) — it is not a safe blind response to "this file is close to the ceiling," and a file
that is already lean and still crosses under contention is evidence the ceiling problem is
host-condition-driven, not file-content-driven, which is exactly this card's own point.

## What this hands to the owner (DoD-1)

**Recommendation: keep `TEST_TIMEOUT_MS` a fixed constant. Do not scale it by `concurrentGates`/
`concurrentGatesMax` or any other signal, and do not widen it.** Reasons, in order of weight:
1. The dominant slowdown (§3, `a591a654`) is present even at zero measured gate contention — scaling on
   admission count would not address the common case.
2. Scaling (of any kind) inherits the same cost this project has already paid twice for widening a fixed
   ceiling (§4, cards `cb1101a0` and `b5af744d`) — it tolerates a real cost for longer rather than reducing
   it, worst exactly when a gate lane is scarcest.
3. A real, reproduced failure class (§4, `e4a2e789`'s AttachConsole crash-hang) cannot be rescued by any
   timeout increase — it can only be made to wait longer before reporting the same result.
4. The one signal that WOULD generalize correctly — progress/stall-awareness (§5) — already exists one
   layer up in this codebase and is not yet applied at the per-file level; that is the lever worth a
   dedicated follow-up card, not a decision this card should make unilaterally.
5. Splitting is not a safe fallback either once a file is already lean (§6) — treat a further crossing as
   an escalation, as this card itself is doing, not as a cue to split again.
6. **The one already-shipped, zero-new-code mitigation for exactly this failure class
   (`LOOM_GATE_ISOLATED_REAL_SPAWN_PHASE` / `ISOLATED_REAL_SPAWN_BASENAMES`, §5b) does not answer this
   card either** — it was deliberately left off with a measured, real, now-understated permanent cost
   (+24–30% of every full gate, more today) against an explicitly unproven benefit, and even if enabled it
   would not isolate `batch-merge-robustness.mjs` (not currently a member of that list) from contention at
   all. Whether that file belongs on the list is a separate, judgment-curated question for whoever owns
   it next.

**Separately, worth its own (lower-priority) card:** `gate_history`/`orchestration_events` cannot today
attribute a merge-gate failure to "timeout" vs. any other cause (§2) — only worker self-check `kind='gate'`
ops get persisted per-step detail. That gap limits how well any future pass on this exact question, or any
adjacent one, can be evidenced from this store without re-deriving from the per-file NDJSON or a live
repro.

## Reproduce

```sh
node docs/investigations/07171a13-test-timeout-scaling/scripts/concurrency-fail-rate.mjs
```

Read-only (`{ readonly: true, fileMustExist: true }`). Runs no build, no test, no gate. `a591a654`'s and
`e4a2e789`'s own findings/scripts (cited, not re-run) are reproducible from their own directories per
their own "Reproduce" sections.
