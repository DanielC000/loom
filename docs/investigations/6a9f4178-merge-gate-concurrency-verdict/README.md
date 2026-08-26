# Card 6a9f4178 — `merge-gate-concurrency-verdict.mjs` went red twice, mechanism attribution

Investigation of the two known reds (`239d6b9e` merge attempts 1 and 2) of
`packages/daemon/test/merge-gate-concurrency-verdict.mjs`. The card's own body had already killed three
candidate discriminators (run duration, generic host-load proxy, gate concurrency) by the "present in
both arms" rule before this session started — see the card body for those, not repeated here.

## Outcome

**Mechanism identified, reproduced live under artificial load, and fixed.** Not a production concurrency
defect. `check("(B precondition) P settled merged:true", ...)` (the specific line the card's own
`gate_status(82ab9b08)` read named as the live-scanned failing assertion) failed because
`confirmWorkerMergeTracked`'s `AttachResult` was `{settled:false}`, not because `merged` or `ok` was
false — `PendingOpRegistry.attach()` degrades to `{settled:false}` whenever the real merge work (the test
fakes only `runGate`; `createWorktree`/git merge/squash are all real) takes longer than
`SYNC_ATTACH_BUDGET_MS` (12s, `pending-ops.ts:769`) to resolve. This is documented, ordinary daemon
behavior under host load (`gate-semaphore.ts`'s own top-of-file doc names it explicitly), not a bug in
the merge path. The test assumed synchronous settlement and never polled for the real outcome.

## DoD-1 — does "AttachConsole failed" appear in PASSING runs' tails too?

**Yes — non-discriminating, as the card predicted ("expect this one to die too").** Queried every
`pending_gate_ops` row with a recorded verdict payload directly from the live `loom.db`
(`query-pending-gate-ops.mjs`, `pending-gate-ops-query-output.txt`): of 969 settled rows, 761 carry an
`outputTail` string, and 12 of those contain `"AttachConsole failed"` — **10 `fail`, 2 `pass`**
(ops `8c2ea937` 2026-08-06 and `b81e037d` 2026-08-24, both `verdict:"pass"`). A condition present in both
arms cannot discriminate — killed, joining the three the card already excluded.

## DoD-2/DoD-3 — which condition failed: `ok:false` or `merged:false`?

**Neither.** `settled:false`. Confirmed two ways:

1. **Live-scanned evidence from the real specimen.** `gate_status(82ab9b08)`'s `gateDetail.failingTest`
   (populated by a LIVE stdout scan during the run, NOT subject to the tail's own positional truncation —
   see `gate-runner.ts`'s `createFailingTestTracker` doc) reads
   `"FAIL  (B precondition) P settled merged:true"` — the exact check at
   `merge-gate-concurrency-verdict.mjs:192`. Both attempts' `outputTail`/`gateDetail.stderrTail` (16KB
   fail-cap, dumped in full: `attempt1-b537b3f5-outputTail.txt`, `attempt2-82ab9b08-outputTail.txt`) are
   entirely consumed by `kickoff-real-spawn`'s own output — confirmed by grep, zero hits for
   `verdict`/`settled`/`merged` in either file — so the raw text can't directly show *which* sub-condition
   of the compound `&&` was false. No `ok:false` exception text or `merged:false` diagnostic appears
   anywhere recoverable from either specimen.
2. **Live reproduction** (below) hit the exact same failure family under artificial load and captured the
   real thrown error directly — `{settled:false}`, not a merge-code exception and not `merged:false`.

**This does NOT meet the card's escalation bar** ("if you find `merged:false`, or a real exception in
merge code — STOP AND ESCALATE"). No real exception in merge code was found, and no `merged:false` was
observed. `dd961cf9`'s territory is not implicated.

## Reproduction — reproduced repeatedly, under artificial load only, never via `run_gate`

Per the card's own instruction, this never fired a real `run_gate`/gate run — every trial below is a bare
`node test/<file>.mjs` invocation, built from source first (`pnpm build`). Full detail, counts, and the
generating script: `repro-logs/SUMMARY.txt`, `reproduce-cpu-saturation.sh`.

**Batch 1 — light background load, no reproduction.** 40 runs of `merge-gate-concurrency-verdict.mjs`
alone (4 parallel lanes × 10 rounds): 0/40 failures. Not committed (nothing to show).

**Batch 2 — 16-way CPU saturation (one busy-loop worker per core, 16-core host), 120 runs (6 parallel
lanes × 20 rounds), spanning the moment the fix landed mid-batch.** This produced a clean, large-sample
before/after split:

| | runs | failed/crashed |
|---|---|---|
| PRE-fix (rounds 1–9, 11 — original file) | 60 | **37** |
| POST-fix (round 10, rounds 12–20 — fixed file) | 60 | **0** |

37/60 (~61.7%) under this **artificial, extreme** load — far heavier than anything in the daemon's own
gate telemetry, deliberately, to make the mechanism reproducible in a reasonable number of trials; not a
production reproduction rate estimate. All 37 pre-fix failing logs are committed
(`repro-logs/pre-fix-failing/`), plus 3 representative clean logs from each side for contrast. One
specimen (`round1-a.txt`) shows the mechanism at its most severe: the scenario-B check
`"(B precondition) P settled merged:true"` printed `FAIL` (harmless — the check's own `&&` short-circuits
before dereferencing `rP.value`), but the very next check (`rP.value.gateCap`, no such guard) then threw
an **uncaught `TypeError: Cannot read properties of undefined (reading 'gateCap')`**, crashing the whole
file immediately — so the original test's failure mode under load was not just a false-red check, it was
occasionally a full crash that skipped every remaining assertion, including the negative control.

**Batch 3 — targeted, informed by the co-occurrence lead below: run `kickoff-real-spawn.mjs` immediately
before the verdict test, sequentially, under the same CPU saturation.** Trial 1 (original file): reproduced
scenario **(A)**'s explicit guard —

```
file:///…/merge-gate-concurrency-verdict.mjs:109
    if (!rP0.settled) throw new Error("expected P to settle synchronously (hermetic fake gate, no hold)");
Error: expected P to settle synchronously (hermetic fake gate, no hold)
```

— a different check than either production specimen (both hit the scenario-B check at line 192) but the
identical mechanism: a genuinely uncontended, un-held fake gate (`fakeGatePass` returns immediately) still
degraded to `{settled:false}`, because the REAL git/worktree work behind it crossed 12s under load. Trials
2–8 (fixed file) all passed cleanly (7/7), including trial 2 where `kickoff-real-spawn` itself still
failed (a real stress signal) — see `repro-logs/targeted-kickoff-then-verdict/` and
`repro-logs/SUMMARY.txt`'s own caveat about this batch's load dropping partway through (trials 3–8 ran
under lighter ambient load than trial 1, a genuine confound noted there, not hidden — Batch 2's
held-constant-load split is the stronger evidence; this batch corroborates).

**Denominator discipline:** the 37/60 and 0/60 figures are exact counts from a committed, reproducible
recipe, not a percentage asserted without its population — but the load level is artificial and extreme,
so neither number should be read as a production reproduction rate. What this batch establishes cleanly is
the BEFORE/AFTER contrast at a FIXED, held-constant load level, which is what actually demonstrates the fix
closes the mechanism.

## A lead worth naming precisely, not previously in the card: kickoff-real-spawn co-occurrence

`co-occurrence-analysis.mjs` (output: `co-occurrence-analysis-output.txt`) cross-references
`daemon-per-file-timing.ndjson`'s `kind:"file"` rows (filtered on `name`, never `run-start`'s `selected[]`
array — the card's own warning): **both of the 2 known verdict-test failures occurred in the same overall
gate run as a `kickoff-real-spawn.mjs` failure** (runUids `1787690219923-37384` and
`1787692587336-26900`). `kickoff-real-spawn` fails in 29/488 runs in the corpus overall (~5.9%), so
`P(verdict fails | kickoff fails) = 2/29`, but `P(kickoff fails | verdict fails) = 2/2` — a real, if
thin (n=2), asymmetric correlation, narrower than the generic "host contention" the card already killed
on a coarse per-run mean-file-duration proxy (that proxy is symmetric across ALL ~726 files; this is
specific to one other real-spawn test).

**This is a correlation lead, not a proven causal chain** — `merge-gate-concurrency-verdict.mjs` uses a
PTY STUB (no real node-pty/conpty spawn at all), so any causal link runs through a HOST-level side effect
of `kickoff-real-spawn`'s real conpty spawn/teardown activity (the SAME `AttachConsole failed`/
`_getConsoleProcessList` 5s-fallback-timer mechanism `docs/investigations/239d6b9e-conpty-kill-nondeterminism`
independently documents for a sibling test, `pty-conpty-dll-kill.mjs`) — e.g. leaked processes/handles or
disk/CPU pressure from real child-process churn — not a shared in-process resource. The reproduction above
is consistent with this lead (the one reproduced trial ran `kickoff-real-spawn` immediately before the
verdict test, under CPU saturation) but does not by itself prove the co-occurrence is causal rather than
"both are more likely to fail when the host is already struggling, for independent reasons." Left
explicitly unresolved, same posture as the sibling investigation's own "candidate discriminator... not
proven" for the conpty-kill file.

## The fix (DoD-4 — genuinely a timing precondition)

`packages/daemon/test/merge-gate-concurrency-verdict.mjs`: swapped all four `confirmWorkerMergeTracked`
call sites for the existing, already-shipped `SessionService.confirmWorkerMergeUntilSettled` — a
production helper (built for the REST merge route, `service.ts:14159`) that polls the SAME already-running
op (`attach()`'s own dedupe) until it genuinely settles, bounded by the project's configured gate timeout
× 6, never a fixed sleep/retry/widened constant. This is exactly "anchor the wait to an OBSERVABLE event"
— `fixed-wait-negative-guard` does not apply (this isn't a negative assertion, and the wait ceiling is a
real, already-existing production bound, not a new fixed sleep invented for the test).

Re-verified: the Batch 2 before/after split above (37/60 pre-fix, 0/60 post-fix, same held-constant 16-way
CPU saturation) is exactly this validation, gathered as a natural experiment because the fix landed
mid-batch. `pnpm build` clean; `node test/merge-gate-concurrency-verdict.mjs` passes under normal
(unloaded) conditions post-fix; `pnpm --filter @loom/daemon guards` — all 6 guards pass (this is a
`packages/daemon/test/*.mjs` change).

## Files in this directory

- `README.md` — this file.
- `query-pending-gate-ops.mjs` / `pending-gate-ops-query-output.txt` — DoD-1's AttachConsole cross-check
  + the three merge attempts' full history, read directly (read-only) from the live `loom.db`.
- `dump-op-tail.mjs`, `attempt1-b537b3f5-outputTail.txt`, `attempt2-82ab9b08-outputTail.txt` — the full
  (16KB fail-cap) `outputTail` for both real failing attempts.
- `co-occurrence-analysis.mjs` / `co-occurrence-analysis-output.txt` — the kickoff-real-spawn co-occurrence
  lead, computed directly from `daemon-per-file-timing.ndjson`.
- `reproduce-cpu-saturation.sh` — the exact recipe that produced Batch 2's before/after split.
- `repro-logs/SUMMARY.txt` — counts and denominators for every reproduction batch.
- `repro-logs/pre-fix-failing/` — all 37 failing/crashing logs from Batch 2's pre-fix half.
- `repro-logs/pre-fix-sample-passing/`, `repro-logs/post-fix-sample-passing/` — 3 representative clean
  logs from each side of the fix, for contrast (the full 120-log raw set is not committed — see SUMMARY).
- `repro-logs/targeted-kickoff-then-verdict/` — Batch 3's kickoff-real-spawn+verdict sequential trials.
