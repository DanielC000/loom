# 8126f1a0 — reading the first real single-file gate retry

Read-only observation against card `8126f1a0` ("the ⚠ WEAKER PASS signal has never fired in
production"). **No production code was changed. No suite/gate was run. No DB write occurred.**
`loom.db` was opened directly with `better-sqlite3({ readonly: true, fileMustExist: true })` — safe
against the live WAL-mode DB while the daemon keeps writing to it.

The firing happened naturally, before this card needed to force one (its DoD-3, "force one
deliberately", is therefore moot). All numbers below are reproducible: `scripts/extract-weaker-pass-
evidence.mjs` re-queries `loom.db` and regenerates `data/weaker-pass-evidence.json`;
`scripts/report.mjs` reads only that JSON (no DB access) and reproduces every number here.

## DoD-1/2 — the specimen, verified at source

Exactly **one** row in `orchestration_events` carries a non-null `retriedFile`, anywhere in the DB:

```
2026-08-06T08:34:32.883Z  build_gate_single_file_retry
  {"retriedFile":"kickoff-real-spawn","retryPassed":true,
   "priorFailingTest":"FAIL  kickoff-real-spawn  (exit 1)",
   "opId":"5f7e5dcc-8a06-4e9e-8a57-d6ab4bc27947"}

2026-08-06T08:34:32.884Z  build_gate
  {"passed":true,"durationMs":754016,"gateCap":2,"concurrentGates":1,"concurrentGatesMax":1,
   "gateSpawned":true,"retriedFile":"kickoff-real-spawn","retryPassed":true,
   "opId":"5f7e5dcc-8a06-4e9e-8a57-d6ab4bc27947"}
```

Task `066d317c`, branch `loom/2917cf33cab2`, merged as `c295064f`. This **confirms** the manager's
`[loom:merge-done]` quote against the durable record, not just the transient nudge text: `retriedFile`
genuinely names `kickoff-real-spawn`, `retryPassed` matches the merged (passing) outcome, and the
⚠ WEAKER PASS clause is legible on the SAME `build_gate` row `gate_history` reads — it is not only in
the nudge text, which the project's own memory warns can round/differ from the durable record.

**Confirmed the retry genuinely re-ran the file — not a no-op.** `pending_gate_ops.verdict_payload_json`
for this `opId` carries the FIRST attempt's own step breakdown at millisecond precision:

```
pnpm build:                         1156.41ms
pnpm --filter @loom/daemon test:daemon: 705072.33ms  (exit 1 — this is what failed)
first-attempt sum:                  706228.74ms  (706.2s)
```

The `build_gate` event's own `durationMs` (754016ms) is measured from the SAME clock
(`gateStartedAt`) across **both** the first attempt and the retry — the single-file retry runs
inline, with no settle delay (unlike the separate transient-kill retry mechanism, which does sleep
`orchestration.gateRetry.settleMs` first; this is a different code path, see
`sessions/service.ts:11671-11687`). Subtracting:

```
retry's own duration ≈ 754016 - 706228.74 = 47787.3ms  (≈47.8s)
```

**≈48 seconds for a real spawn test to run in isolation is not consistent with a no-op that exited
instantly** (that would show as a delta of a few ms to low hundreds of ms) — it is consistent with
`kickoff-real-spawn` genuinely re-executing (per the daemon's own doctrine, this test drives a real
node-pty spawn of the `claude` CLI, which plausibly costs tens of seconds). **The retry fired for
real, not as a silent no-op reporting a false green.**

## DoD-4 — wall-clock actually saved

**On this run alone:** the retry cost ~47.8s to recover a failure whose first (full-suite) attempt
had cost 706.2s. Had the daemon instead rejected the merge outright (pre-`344ce950` behavior) and a
manager had to notice + re-fire `worker_merge_confirm` for a brand-new full gate run, that fresh
attempt would cost comparably to this run's own first attempt (~706s) — **so this firing saved
roughly 658 seconds (~11 minutes) of gate wall-clock**, on top of avoiding the queueing wait for a
second admission cycle and the manager round-trip latency to notice the rejection at all (neither
measured here — both are additional, unquantified savings on top of the ~11 minutes).

**A real, non-hypothetical precedent for that "manager re-fires, full gate reruns" cost** turned up
in the pre-feature history (see case study below): branch `loom/d878a91ffb04` was rejected on the
SAME test (`kickoff-real-spawn`) on 2026-08-05, and the bare re-fire that followed cost **881673ms
(~14.7 min)** — a concrete apples-to-apples number for what this specimen's retry avoided, close to
mgr #127's own "~12-18min" estimate for a full re-run.

## DoD-4 — re-checking mgr #127's premise: **does NOT reproduce as stated, under any natural reading**

The card's motivating premise was "`gate_history` read, n=14, found 5 of the last 14 merge-gate runs
REJECTED, all five followed by a PASS on the same branch." This was never independently re-verified
before `344ce950` shipped (per that card's own worker, who correctly declined it as out of scope).
Re-checked here, against the **same population `gate_history` itself reads** (`orchestration_events`
where `kind='build_gate'`), bounded to strictly before card `344ce950`'s own `created_at`
(`2026-08-05T21:54:54.149Z` — the moment mgr #127 could actually have been reading this):

| reading | n | rejections | later-passed-same-branch |
|---|---|---|---|
| last 14 **build_gate runs** (any outcome) | 14 | **1** | 1 |
| last 14 **rejections** specifically | 14 | 14 | **14** |
| **full pre-feature population** (back to 2026-07-03) | 1470 | 197 | 156 (79.2%) |

**Neither natural reading of "n=14" reproduces "5 rejections."** The literal "last 14 gate runs"
reading finds only 1 rejection in that window, not 5. Reading "n=14" as "the last 14 *rejections*"
instead gives a suspiciously clean 14-for-14 later-pass rate — closer in spirit to the card's framing,
but still not "5 of 14," and I have no way to recover exactly what population or window mgr #127
actually queried. **This is a finding, not a failure to compute:** the specific "5 of 14" figure
cannot be independently corroborated from the durable record as literally stated.

**A separate, more important gap in the premise's own logic, found while checking it:** "later passed
on the same branch" does **not** distinguish a genuinely flaky bare re-run from a worker pushing a
real fix to the same branch before the next gate attempt — both look identical in this event log (same
branch name, a later `build_gate passed:true` row). Since every task's branch is worked until it
passes before merging, a high later-pass rate is close to tautological and was never, by itself,
evidence of *flakiness* specifically. This caveat applies equally to mgr #127's original n=14 claim
and to the fuller n=197 figure measured here — **neither should be cited as "proof of pure flakiness"
without checking, case by case, whether the code actually changed in between.**

**One case *was* checked directly, and it is a clean, genuine bare-re-run precedent — not a fix:**

```
2026-08-05T20:04:13.690Z  build_gate      passed:false  (sha 5464f601…, failing: kickoff-real-spawn)
2026-08-05T20:04:13.900Z  merge_rejected
2026-08-05T20:19:15.764Z  build_gate      passed:true   (~15 min later, SAME session)
2026-08-05T20:19:24.222Z  merge_done
```

**No event of any kind exists for that session between the rejection and the re-pass** — no
`merge_request`, no `message_worker`, no `worker_report`. The manager re-fired the merge gate on the
identical `sha` with zero worker action in between, and it passed 15 minutes later purely on a bare
re-run. **This is genuine flakiness evidence, on the exact same test (`kickoff-real-spawn`) our
specimen retried** — a real, pre-existing precedent for the class of bug `344ce950` targets, distinct
from (and more reliable than) the un-reproducible "5 of 14" figure.

## Bounds respected

- **No cause asserted** for gate rejections anywhere above — every number here is "what happened",
  never "why the suite failed this run."
- **`failingTestCount === 1` guard untouched** — not read, not modified.
- `kickoff-real-spawn`'s own flakiness/order-dependence is explicitly out of scope for this card (a
  separate card per the kickoff) — noted here only as a byproduct of verifying the retry mechanism,
  not investigated further.

## What this does not cover

- Did not attempt to determine WHY `kickoff-real-spawn` specifically flakes (out of scope, see above).
- The "79.2% later-passed" figure over the full pre-feature population is a same-branch proxy, not a
  code-diff-verified flakiness rate — only the one case study above was diffed against intervening
  events to rule out a fix. Extending that per-case check to the other 196 rejections was not done.
- `mgr #127`'s exact query (tool used, project scope, exact timestamp) is unrecoverable — no audit
  trail exists for an ad hoc `gate_history` read, so "5 of 14" can be reported as unreproduced, not as
  disproven.

## Reproduce this

```sh
node docs/investigations/8126f1a0-weaker-pass-first-firing/scripts/extract-weaker-pass-evidence.mjs
node docs/investigations/8126f1a0-weaker-pass-first-firing/scripts/report.mjs
```

`extract-weaker-pass-evidence.mjs` is the only script that touches `loom.db`, and only ever with
`{ readonly: true, fileMustExist: true }`. `report.mjs` reads only the committed JSON.
