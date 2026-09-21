# 51bc64f2 — `codex-trust-block-poll.mjs` scenario A's setup check raced the very poll it was testing

## The specimen this diagnoses

Card `51bc64f2` tracked an ABSENT `[waitUntil-outcome]` on scenario A's setup check (`packages/daemon/test/codex-trust-block-poll.mjs`, "the simulated late write actually landed on disk") across three captured reds: Windows gate `48b2f8a8` (2026-09-18), Linux CI `35589820758` (2026-09-21), Windows gate `220bee69` (2026-09-21). Card `65c1ecc7` added unconditional instrumentation (`[scenario-A late-write timer] fired at +Nms (scheduled +2200ms, drift ...)`) to the late-write `setTimeout` callback so a future red could discriminate "callback never fired" from "callback fired but the append itself failed." `220bee69`'s specimen showed the line present with healthy drift (+7ms) — ruling out both hypotheses this card had been narrowing between (a specific co-scheduled sibling test; general contention under the test-runner's concurrent pool) and leaving only: why does `fs.appendFileSync` inside the callback not make `containsBlock(CWD_A)` true, when the callback demonstrably ran on time and did not throw?

## The mechanism, confirmed by direct instrumentation

Temporary diagnostics were added to the production poll path itself (`pollConfigDiffAfterSpawn` in `codex-doctrine.ts`, and the `removeAddedTrustBlocks` call site in `host.ts`), logging every poll tick's timestamp/result and the exact moment a strip is invoked. Run locally, in ISOLATION (`node test/codex-trust-block-poll.mjs`, no other test file involved), 10 consecutive times: 2 of 10 runs reproduced the ABSENT failure. Both captured runs showed the identical signature:

```
[scenario-A late-write timer] fired at +2204ms (scheduled +2200ms, drift +4ms)
[DIAG poll] tick @+2207ms changed=true
[DIAG strip] codex-trust-poll-a poll settled changed=true removable=1 @<t>
[DIAG strip] codex-trust-poll-a calling removeAddedTrustBlocks @<t>
[DIAG strip] codex-trust-poll-a removeAddedTrustBlocks returned @<t+1>
```

The production poll tick landed **3ms** after the append (both failing runs), and `removeAddedTrustBlocks` ran within 1ms of detecting the change. The 8 passing runs showed the poll tick catching the change 30–121ms after the append — comfortably long enough for the test's own `waitUntil` (10ms poll interval) to sample `containsBlock(CWD_A) === true` at least once before the strip landed.

**The write genuinely lands on disk and is then correctly stripped by the very code under test.** `pollConfigDiffAfterSpawn`/`removeAddedTrustBlocks` behave exactly as designed — this is not a production defect. The defect is in the test's OWN setup-check assertion: it polled `containsBlock(CWD_A)` at a 10ms granularity to confirm the append landed, but that polled read races the production poll's own strip, and the "block present" state can be strictly shorter-lived (single-digit ms) than one poll interval — the observer can lose the race outright and never sample `true`, even though the write unambiguously happened.

**Root cause of why the race is winnable at all:** `LATE_WRITE_SCHEDULED_DELAY_MS` (2200ms, chosen to land comfortably inside the poll's 3000ms deadline) sits in near-phase with the production poll's own interval cadence (`CODEX_TRUST_DIFF_POLL_INTERVAL_MS`, env-shrunk to 100ms for this test, ticking at `n × 100ms` relative to when the trust dialog is answered). Because both the append's schedule and the poll's cadence are anchored to nominally the same event (the trust-dialog answer completing) but observed through independently-jittered timer chains, the phase gap between "the append fires" and "the nearest subsequent poll tick" drifts run-to-run — landing in a several-millisecond "danger zone" often enough to be a real, reproducible-in-isolation flake, not merely a full-suite contention artifact.

## Why the card's "order-dependent vs environment-dependent" framing never had a chance to resolve

Both remaining hypotheses on the card predicted a **delayed callback**. The instrumentation correctly ruled out both once `220bee69` showed healthy drift — but the true mechanism doesn't need a delayed callback at all: the callback fires on schedule, every time; what varies is whether the production poll's own next tick happens to land close enough behind it to win the observation race. This is why the failure reproduces in total isolation, with no other test file or full-suite concurrency involved.

## Do not

- Do not widen the 2500ms setup-check budget, or add a retry — neither addresses a race that can resolve in single-digit milliseconds; both were already correctly ruled out on the card for the pre-fix ABSENT signature and remain wrong for this mechanism too.
- Do not treat `pollConfigDiffAfterSpawn`/`removeAddedTrustBlocks` as buggy — the confirmed mechanism is a test-design race, not a production defect; leave that code alone.
- Do not re-introduce a polled `waitUntil(() => containsBlock(...) === true, ...)` for the "did the simulated late write land" setup check — read the flag back synchronously, inside the same `setTimeout` callback as the `fs.appendFileSync` call, before yielding to the event loop; that's what makes the observation race-free against the production poll's own independently-scheduled tick.
