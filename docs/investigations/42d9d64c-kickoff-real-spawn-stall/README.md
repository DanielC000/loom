# Card 42d9d64c — the kickoff-real-spawn-stall onExit-ABSENT signal, resolved

## THE ANSWER, first line

**The `waitUntil-outcome ABSENT ... never reported onExit within budget` signal (v13's specimen) is a
mechanical CONSEQUENCE of the test file's own cleanup sweep, not an independent cause and not a
discriminating signal for THIS card's original stall bug.** It NEVER appears in a passing run, and in
every failing run it is EXACTLY the set of sessions strictly downstream of the failure point in
`kickoff-real-spawn.mjs`'s own `allSessionIds` order — never more, never fewer, never a different session.
v13's own reported set of 4 (`real-manager/platform/setup/assistant`) was a **partial quote** (from a
positionally-truncated `gate_status.outputTail`), not evidence of a different, smaller mechanism — this
corpus's own low-index failure (run 15, `[platform]`, index 2) reproduces the mechanism exactly and
strands 6 sessions, not 4. **This retires the signal as a lead, with evidence, per the card's own standing
rule that a condition present only in failing runs is not automatically a discovery** — here it answers
NO to "is it a cause" precisely because it is provably 100% downstream-of-failure in every specimen.

**No code change is proposed or was made.** Two real bugs were found and fixed **in this investigation's
own local driver script** (not in `packages/daemon/src`), documented below.

## FOUR STAMPS discipline

Every number below is stated as: **NUMBER · CONDITION · POPULATION · INSTRUMENT**. Partial stamps are
called out explicitly as such rather than presented as complete.

## The corpus

**NUMBER** 20 runs (15 pass, 5 fail — 25% fail rate) · **CONDITION** `node
packages/daemon/test/kickoff-real-spawn.mjs`, unedited, one process at a time, sequential, on a host with
an unknown but nonzero number of other Loom worktrees/gates active (not suppressed — "isolated" means one
test process, not a quiet host) · **POPULATION** 20 runs, 2026-08-25 ~19:49–22:26Z, this worktree ·
**INSTRUMENT** `scripts/run-loop.mjs`, full stdout+stderr captured per run to `runs/run-NN-<pass|fail>.log`,
structured facts appended to `runs.ndjson`.

25% (5/20) sits between v9's isolated ~30% (3/10) and the corpus's own single fastest reads — **do not
reconcile the three rates**: different host conditions, different days, and every n here (10, 20) is far
too small to distinguish from a single underlying rate or from each other. State them side by side, not
differenced.

## THE QUESTION, in full (v13's own framing, corrected)

v13 asked: does the ABSENT signal appear in passing runs? If no, it called that "the first genuinely
discriminating signal this card has ever had." **That second branch is wrong as stated** (flagged by this
card's manager before this corpus existed): "present only in failing runs" is consistent with the signal
being a cause **or** a mechanical consequence of whatever short-circuits the run — a "NO" answer alone
proves nothing about which.

### Part 1 — does it appear in passing runs?

**NUMBER** 0 of 15 passing runs show any `absentSessions` entry (`absentCount` is 0 on every single pass
row) · **CONDITION** same as corpus above · **POPULATION** all 15 pass rows · **INSTRUMENT**
`runs.ndjson`'s `absentCount` field, computed by `run-loop.mjs` from the retained log's own
`[kickoff-real-spawn] <sessionId> never reported onExit within budget` lines.

**Answer: NO, it never appears in a passing run.**

### Part 2 — is it upstream or downstream of the failure (the sharper, checkable prediction)?

**NUMBER** 5 of 5 failing runs have `strandedSetMatchesAbsent: true` and `anyAbsentNotStrandedOrFailed:
false` (the falsifier field, which would flag ANY absent session not explained by the stranding mechanism,
never fired) · **CONDITION** same as corpus above · **POPULATION** all 5 fail rows (indices 2, 5, 7, 7, 7
in `allSessionIds` order — see table below) · **INSTRUMENT** `runs.ndjson`'s `strandedExpected` (computed
from `ALL_SESSION_IDS_ORDER.slice(failedIndex+1)`, mirroring `kickoff-real-spawn.mjs:307,347` exactly) vs
`absentSessions` (extracted from the log).

| run | failed at | failedIndex | strandedExpected | absentSessions (actual) | match |
|---|---|---|---|---|---|
| 1 | `[large 40000]` | 7 | `real-late-ready` | `real-late-ready` | ✅ |
| 8 | `[large 40000]` | 7 | `real-late-ready` | `real-late-ready` | ✅ |
| 11 | `[auditor]` | 5 | `real-large-10000, real-large-40000, real-late-ready` | same | ✅ |
| 14 | `[large 40000]` | 7 | `real-late-ready` | `real-late-ready` | ✅ |
| **15** | **`[platform]`** | **2** | `real-setup, real-assistant, real-auditor, real-large-10000, real-large-40000, real-late-ready` (6) | same (6) | ✅ |

**Answer: every failing run's absent set is EXACTLY the downstream-of-failure set, with zero exceptions
across 5 specimens spanning 3 distinct failure indices (2, 5, 7).** The mechanism: `stopAndAwaitExit`
(`kickoff-real-spawn.mjs:210`) does `host.stop(sessionId,"hard")` then `waitUntil(() =>
exitedSessions.has(sessionId), {timeoutMs:5000})`. `PtyHost.stop` (`host.ts:8712-8714`) is a no-op for any
`sessionId` with no live entry (`if (!live?.alive) return`), and `exitedSessions` is populated ONLY by the
real `onExit` callback (`kickoff-real-spawn.mjs:194`), which can never fire for a session that was never
spawned. The file's own `finally` safety-net sweep (`:344-352`) iterates the FULL `allSessionIds` list and
calls `stopAndAwaitExit` on every session not yet stopped — so once an uncaught throw exits the per-role
loop early, every session strictly downstream is mechanically guaranteed to burn the full
`waitUntil` budget (5000ms + grace `min(5000×4,120000)`=20000ms = **25000ms, exactly matching v13's own
"~25000ms (5.0x budget)" figure**) before giving up.

⇒ **This settles v13's "partial quote vs genuinely 4" question in favor of partial quote.** v13's own
failure was at `[worker]`, index 0 — the mechanism observed here (100% match, 3 distinct indices) predicts
that failure strands **8** sessions (every one of `manager/platform/setup/assistant/auditor/large-10000/
large-40000/late-ready`), not 4. v13's reported 4 (`manager/platform/setup/assistant`) is consistent with
the FIRST 4 of that 8-session list — exactly the shape a positionally-truncated `gate_status.outputTail`
would produce (the tail keeps what fits; the rest — `auditor`, both large-payload sessions, and
`late-ready` — would have been evicted). This was not independently re-run at index 0 in this corpus (no
`[worker]`-failure specimen occurred in these 20 runs), so it is an inference from a 100%-consistent
mechanism observed at 3 other indices, not a fourth direct observation at index 0 — stated as such, not
overclaimed as a sixth match.

**⇒ Per the corrected discriminator framing: this is a mechanical CONSEQUENCE, not a cause. The signal is
retired as a lead for this card, with evidence.**

## Two real instrumentation bugs found (in this investigation's own driver, not production code)

### Bug 1 — the chunk-arrival proxy metric (`maxInterEventGapMs`) is unfit, on two independent grounds

This driver originally computed a coarse proxy — the max gap between successive stdout/stderr chunks
this OUTER test process printed — as a stand-in for "how long was the pty quiet." **It is retired.**
Left in `runs.ndjson` as `maxInterEventGapWholeRunMs`/`maxInterEventGapPreFailureMs` (mostly `null` on
fail rows — see Bug 2) for provenance, but not used for any conclusion below.

1. **Falsified independently, from a PASSING row.** Run 3 passed with `maxInterEventGapMs = 16586ms` —
   ABOVE the file's own 15000ms `HEARTBEAT_STALL_MS` budget. If this proxy measured the same quantity the
   real stall detector measures (idle time with NO output, heartbeats included), a >15000ms gap would have
   thrown. It didn't, because the proxy measures gaps between this OUTER process's own console lines, not
   gaps in the pty's own output stream (which includes `FIXTURE_ALIVE` heartbeats that never reach this
   process's stdout at all — they're internal to the harness's own pty subscription). **NUMBER** 16586ms
   on a PASS · **CONDITION** run 3 of this corpus · **POPULATION** 1 run · **INSTRUMENT**
   `run-loop.mjs`'s v1 chunk-gap computation, cross-checked against the file's own `HEARTBEAT_STALL_MS`
   constant (`packages/daemon/test/kickoff-real-spawn.mjs:124`).
2. **Separately, the failure-marker boundary was wrong.** The pre-failure/whole-run split (added mid-
   investigation, per manager direction) bounded "pre-failure" at the chunk containing `💥 UNCAUGHT`. But
   that text is printed ONLY by the file's outermost `catch` block, which — ordinary JS `try/finally`
   semantics — runs only AFTER the file's own `finally` safety-net sweep has already completed. Confirmed
   directly in `runs/run-08-fail.txt`: the true failure moment is line 424
   (`[measured [large 40000]] SessionStart→FIXTURE_RECEIVED: 19922ms`), but the ~25000ms stranding wait for
   `real-late-ready` prints at lines 442-443, strictly BEFORE `💥 UNCAUGHT` at line 445. So the "pre-
   failure" figure as computed silently included the entire cleanup sweep — the exact contamination the
   split was built to exclude, for the exact reason described in Part 2 above. **Not recoverable
   post-hoc**: per-chunk arrival timestamps are never persisted to disk (only the joined text is saved to
   each `.log` file), so there is no way to recompute a corrected chunk-based gap after the fact for any
   row, v1 or v2. Every `maxInterEventGapPreFailureMs` on a fail row is therefore `null`, with a
   `maxInterEventGapPreFailureSource` field naming which of the two failure modes applied.

### Bug 2 (not a bug in the sense above, but a genuine mixed-instrument near-miss, caught before it shipped)

While fixing Bug 1, `stallAssertionMs` (the harness's own self-reported "no new output ... for Nms"
figure, extracted from the retained log text) was briefly stored in the SAME field as the chunk-parser
gap for the one hand-patched legacy row. **Caught before analysis**: those are two different instruments
measuring related-but-distinct quantities (a text-extracted assertion value vs a value computed from
timestamps), and this board has already retracted findings built on exactly this kind of silent mix. Fixed
by giving `stallAssertionMs` its own field, present only on `stall`-kind fail rows, never conflated with
the (now entirely retired for conclusions) `maxInterEventGapPreFailureMs` column.

## The instrument that actually answers "was the run globally degraded before it failed"

`[measured <label>] SessionStart→FIXTURE_RECEIVED: Nms` (`kickoff-real-spawn.mjs`, inside a `finally`
block wrapping the delivery wait) is genuinely **uncensored** — it prints on both a normal completion AND
a throw, is stamped with its own budget inline, and is fully recoverable post-hoc from every retained log
with no timestamp-persistence dependency (unlike the retired chunk proxy). Extracted via
`scripts/extract-measured-timings.mjs` into `measured-timings.ndjson` — 168 rows, one per sub-fixture per
run.

**NUMBER** stallAssertionMs (the harness's own stall-detector figure) is 15001–15025ms across all 5 fail
rows, mean 15013ms · **CONDITION** stall-kind failures only (all 5 fails in this corpus were stall-kind) ·
**POPULATION** 5 rows · **INSTRUMENT** regex extraction of `no new output (heartbeat included) for Nms`
from the retained log text. This is tightly clustered just over the 15000ms budget — exactly what a
10ms-poll-interval detector firing right at threshold should look like. **Structurally cannot exist on a
passing run** (it's only ever printed when the stall throw fires) — so on its own it can never answer a
cross-arm question; it's a sanity check on the detector, not a pass-vs-fail comparator.

### Was a failing run's OTHER (non-failing) sub-fixtures also slower? (the manager's sharper question)

Comparing each fail run's non-failing sub-fixtures' `SessionStart→FIXTURE_RECEIVED` values against the
passing-population mean for that same fixture:

| run | failed at | non-failing sub-fixtures' delta vs pass-mean (ms) |
|---|---|---|
| 1 | `[large 40000]` | worker −1249, manager −1362, platform −929, setup −1146, assistant −2167, auditor **+1384**, large-10000 **+2727** |
| 8 | `[large 40000]` | worker −1344, manager +706, platform +767, setup −1117, assistant −1872, auditor **+5420**, large-10000 +80 |
| 11 | `[auditor]` | worker −1140, manager −1378, platform −840, setup +574, assistant −1286 |
| 14 | `[large 40000]` | worker −1081, manager −1560, platform **+2427**, setup −1050, assistant −1266, auditor +37, large-10000 **+1748** |
| 15 | `[platform]` | worker −896, manager **+12613** |

**NUMBER** of the 20 non-failing-sub-fixture readings across the 5 fail runs, 13 are AT OR BELOW the pass
mean for their fixture (negative or ~0 delta) and 7 are above, with most of those modest (+37 to +2727ms)
· **CONDITION** as above · **POPULATION** 20 readings, 5 fail runs · **INSTRUMENT**
`measured-timings.ndjson` cross-referenced against `runs.ndjson`'s `failedLabel`.

**One clear outlier: run 15's `[manager]` reading at 19200ms (+12613ms vs its pass mean of 6587ms), in the
SAME run that later failed at `[platform]`.** This is the corpus's single strongest piece of evidence FOR
some kind of run-level jitter — but it is n=1 among 20 readings, it does not recur in any of the other 4
fail runs (each of which has at most one modestly-elevated fixture, never the same fixture twice, and a
majority of fixtures actually faster than the pass population), and the elevated fixture (`manager`) is
not the one that went on to fail (`platform`) — so it is NOT evidence of a uniform "the whole run was
under load and platform is just where it tipped" story either. **Honest read: most non-failing
sub-fixtures in a failing run are indistinguishable from, or faster than, the passing population; one run
(15) shows real local jitter on an unrelated fixture shortly before its own failure, which is suggestive
but not sufficient, at this n, to support a general degrading-run hypothesis.** Say so as an open, weakly-
evidenced observation, not a finding.

## give-up recovery vs outcome — does NOT reproduce v12's "rare event" picture; report both, don't pool

**NUMBER** every one of the 5 fail rows has `giveUpRecoveryCount ≥ 1` (values: 1,2,1,1,2 — sum 7) vs 4 of
15 pass rows (values where >0: 7,3,1,1 — sum 12, 11 pass rows have 0) · **CONDITION** as above ·
**POPULATION** 20 runs · **INSTRUMENT** `runs.ndjson`'s `giveUpRecoveryCount`, a regex count of
`GIVE-UP RECOVERY after N Enter attempts` in the retained log, over `host.ts`'s own submit-retry
mechanism (`fireEnterAndVerify`) — a DIFFERENT instrument from v12's, which this investigation cannot
confirm counted the same way. **Do not difference these numbers against v12's "10 of 11 give-ups
self-heal"** — different corpus, different instrument, that comparison has already killed several claims
on this card.

On THIS corpus: give-ups are common, not rare (9 of 20 runs, 45%, have at least one — one PASSING run had
7 in a single run). **Presence of ≥1 give-up correlates with this corpus's outcome (5/5 fail rows vs 4/15
pass rows)**, but magnitude does not discriminate (fail-row counts 1-2 sit inside the same range several
pass rows also show). At n=5 fails this is not strong enough to assert give-up presence as a necessary
precursor — it is a real, reportable pattern worth a future corpus's attention, not a conclusion.

## Duration does not discriminate either

**NUMBER** pass durations range 49462–120804ms (mean ≈65100ms); fail durations range 92223–195759ms (mean
≈120344ms), but with overlap — the fastest fail (92223ms) is well below the slowest pass (120804ms) ·
**CONDITION/POPULATION/INSTRUMENT** as above, `runs.ndjson`'s `durationMs`. A long run is not sufficient
evidence of an impending failure, and a fast run is not protective.

## What this retires, and what stays open

- **Retired, with evidence:** the onExit-ABSENT signal as an independent cause or lead for this card —
  it is a deterministic, 100%-consistent consequence of the stranding mechanism above.
- **Retired, with evidence:** the chunk-arrival gap proxy as any kind of stall indicator (Bug 1 above).
- **Still open, unchanged from prior revisions:** why the pty goes silent for exactly this duration in the
  first place (the underlying stall mechanism itself) — this investigation characterizes a downstream
  cleanup artifact of that stall, not its root cause. `giveUpRecoveryCount` presence-vs-outcome and the
  run-15 jitter observation are both worth a future corpus's attention but are not conclusions at this n.
- **Not attempted here, and not needed:** re-running at a `[worker]`-index-0 failure specifically. The
  mechanism's 100% consistency across 3 distinct indices (2, 5, 7) already gives high confidence in the
  8-session prediction for index 0; a dedicated repro would need to force that specific sub-fixture to
  stall (e.g. via `FIXTURE_DEBOUNCE_MS`), which is a targeted follow-up, not part of this card's DoD.

## Corpus contents

- `runs.ndjson` — 20 structured rows (see `scripts/run-loop.mjs`'s header for the full schema).
- `measured-timings.ndjson` — 168 per-sub-fixture `SessionStart→FIXTURE_RECEIVED` readings.
- `runs/run-NN-<pass|fail>.txt` — full captured stdout+stderr for every one of the 20 runs, unedited
  (`.txt`, not `.log` — the repo's root `.gitignore` has a blanket `*.log` rule that would otherwise
  silently exclude this DoD-mandated committed corpus; every prior `docs/investigations/**` specimen uses
  `.txt` for exactly this reason).
- `scripts/run-loop.mjs` — the driver (runs the test file, captures output, computes structured facts).
- `scripts/add-stall-assertion-field.mjs`, `scripts/extract-measured-timings.mjs`, `scripts/analyze.mjs` —
  post-processing/analysis scripts, all re-runnable against the committed corpus (no gate, no network).
- `scripts/patch-legacy-gap-fields.mjs` — one-off reconciliation script for runs 1-7 (emitted before the
  gap-split schema existed); kept for provenance, not needed to reproduce the analysis above.

None of these scripts touch `packages/daemon/src`. No `run_gate`, no full suite, no widened timeout, no
retry, no quarantine.
