# 4f7f6854 — batch-gate telemetry: the realised-vs-modelled comparison is not yet computable, and the reuse "tautology" is resolved

Read-only measurement pass against card `4f7f6854`. **No production code changed. No gate run. No load
generated.** Every number below comes from one readonly query against the live `loom.db`'s
`orchestration_events` table (same pattern as `docs/investigations/a591a654-gate-timing-attribution`),
run **2026-09-03**, and from reading `packages/daemon/src/git/batch-merge.ts` +
`packages/daemon/src/sessions/service.ts` (`mergeBatch`) + `packages/daemon/src/db.ts`
(`gateRanFromDetail`/`toGateHistoryRow`) at commit `6449bf8d` (the currently-deployed HEAD).

**Headline: DoD-1 (emit a `batch_gate` event) is already shipped and verified live. DoD-2/3/4 (the
realised-saving comparison, the invariance check, the forfeit rate) are NOT YET COMPUTABLE — there is
exactly one batch-gate event in this daemon's entire history, it predates the commit that added
`durationMs`/concurrency stamps to that event, and zero batches have run since that commit went live.
This is the sanctioned "the comparison this card asks for is not available from `gate_history` as it
stands" outcome, not a refutation of the ~26-28% model.** Separately, the open positive control the Lead
flagged for the reuse rate (`e50600d2`) IS now resolved — see §3.

## Reproduce

```
node docs/investigations/4f7f6854-batch-gate-telemetry/scripts/extract-batch-gate-events.mjs
```

Read-only (`{ readonly: true, fileMustExist: true }`). Runs no build, no test, no gate.

## 1. DoD-3 (cheapest check, do first): is a K=3/K=4 batch gate materially longer than K=1?

**NOT MEASURABLE. Zero usable data points.**

`orchestration_events` carries exactly **one** `build_gate` row with `batched:true`, ever, across every
project on this daemon (`id=ed9bf9a0…`, `opId=1cfb5219…`, `ts=2026-09-03T01:46:28.328Z`, `branchCount:2`,
`passed:true`). Its `detail_json`, read in full, carries **no** `durationMs`, `gateCap`,
`concurrentGates`, or `concurrentGatesMax` field at all — not `null`, absent. This is expected and
already named in this repo's own code comment (`service.ts` around the `evtBatch("build_gate", …)` call):
*"first measured missing on the first live batch run (opId 1cfb5219, row ed9bf9a0: every one of these
read back null)"*. Commit `c0fdc501` ("give batch gate rows duration, concurrency and
emitCompareReduced"), committed `2026-09-03T05:12:40+02:00` (`03:12:40Z`), fixed exactly this gap — but
it postdates the one batch run that has ever happened (`01:46:28Z`), so that run's row can never be
backfilled.

**Since `c0fdc501` (and the deploy that shipped it, `6449bf8d`, live from `04:26Z`): zero further
`build_gate` events of ANY kind — batched or solo — have landed, on any project.** The latest
`orchestration_events` row in the whole DB is timestamped `04:36:44Z`, ten minutes after deploy and not
itself a gate event. This is a "not enough elapsed time / activity since restart" gap, not a mechanism
failure — nothing has merged at all since the daemon came back up with the fix live.

⇒ **There is no batch gate row in this daemon's history that carries a duration.** DoD-3 cannot be
answered either way from live data today. Re-run the reproduce script above once a handful of K≥2
batches have landed post-`04:26Z` and this becomes directly answerable (`durationMs` on a `batchCount:K`
row vs. the solo population's own `durationMs` distribution, matched by branch/test-file-set size where
possible — see the card's own warning against a naive `mean(solo) × K` comparison, §2 below).

## 2. DoD-2: gates-per-merged-branch (wall-clock), before vs after

**"Before" = 1.000, by construction (per the card's own framing) — a solo merge is always exactly one
gate for one branch, trivially, needing no data.**

**"After" is not computable for the same reason as §1: the one live batch row carries no `durationMs`,
and zero batches have run since the field started being recorded.** No wall-clock ratio can be reported
in either direction. Do not read the absence of a number here as "no saving" — it is "no observation
yet," and the card is explicit that this outcome must be stated plainly rather than papered over with
whatever rows happen to exist.

**The card's own sampling-bias caveat (its final triage note) also applies to whatever "before" data
future runs use**: a naive solo population pulled from `gate_history` is conditioned on "no reusable
green self-check was available" (see §3) — not a clean "cost of a solo merge" sample. Any future pass
computing a real ratio should bucket by `gateRan`/`reused` and state the solo population's conditioning
explicitly, exactly as that note requires.

## 3. The open positive control (reuse-rate tautology) — RESOLVED

The card's most recent triage note left this **explicitly open**: *"I have not established that a
reused merge produces a `gate_history` row AT ALL... do NOT quote a reuse rate from this table in either
direction."* This pass closes it, two ways.

### 3a. Source-level proof

`confirmWorkerMerge` (`sessions/service.ts`) calls `evt("build_gate", {...})` **unconditionally** on its
plain-GREEN return path — the call sits *before* the `if (gateRan) { … }` block that follows it, not
inside it. The stamped detail explicitly branches on the reuse case:

```
gateSpawned: gateRan,
...(gateRan ? {} : inertSkip ? { skipped: true, skipReason: "inert-docs-only-diff" } : { reused: true, reusedOpId }),
```

`db.ts`'s `gateRanFromDetail` (feeding `gate_history.gateRan`) reads this same field: `detail.gateSpawned
=== false` (or `detail.reused === true`) ⇒ `gateRan: false`. So a reused merge is not merely
*permitted* to leave a row — the code path that would skip logging it does not exist. `gate_history` and
`orchestration_events` are the SAME underlying rows (`Db.listGateEvents` is a JOIN over
`orchestration_events`), so this settles both instruments at once.

### 3b. Empirical confirmation, live data

The extraction script finds **5 reuse rows within the Loom project's own `build_gate` history** (full
history, all 5 with `reused:true`, `reusedOpId` naming the self-check `opId`, `durationMs:0` — correct,
since nothing was spawned):

| ts | taskId | reusedOpId |
|---|---|---|
| 2026-07-29T00:20:19.530Z | `2c9582d3…` | `66b52359…` |
| 2026-07-30T00:32:54.304Z | `c54d1ea0…` | `47ada7da…` |
| 2026-08-01T17:55:17.180Z | `5ff6586d…` | `83385cae…` |
| 2026-08-26T08:11:25.759Z | `5d4a4d02…` | `65138cce…` |
| 2026-08-31T19:25:08.487Z | `43f5b242…` | `11d5c6ac…` |

An unscoped (all-projects) sweep for the same `"reused":true` marker turns up **51** rows total — the
mechanism is neither dead nor Loom-specific, just infrequent.

### 3c. The rate this settles — and what it does NOT settle

**Loom-project reuse rate, full history, solo `build_gate` rows only: 5/1351 = 0.37%.** This is a real,
now-measured number, not a tautology — the instrument has been shown capable of returning a **non-zero**
answer (the required positive-control shape per this project's own doctrine: a check confirming
something absent needs to be shown capable of returning present first). ⚠️ **This is a full-history
figure, not a recent-window one** — it is offered as proof the instrument works, not as a claim about
today's reuse rate under current worker/manager behavior. It is directionally consistent with the Lead's
own later-stated read (worker doctrine defaults away from `run_gate`, and stale-base invalidation from
sequential merging routinely voids whatever self-check exists) — reuse being genuinely rare, not merely
unrecorded.

## 4. DoD-4: forfeit rate

**0 `batch_merge_forfeited` events, ever, across every project on this daemon.** Against a denominator of
**1** total batch attempt (the one row in §1, which passed clean and fast-forwarded). **0/1 — far too
small a sample to generalize, and stated as such rather than rounded to "0%."**

## 5. Why volume is this low — context, not a defect

`merge_batch` is a manager-invoked MCP tool (`packages/daemon/src/mcp/orchestration.ts`), not automatic —
a manager must hold ≥2 ready worker session ids on the same repo and explicitly call it instead of
`worker_merge_confirm` per worker. One live use in this daemon's history is consistent with an opt-in
tool that just shipped, not with the mechanism being broken. A manager that calls `merge_batch` but ends
up with fewer than 2 eligible candidates degrades silently to the ordinary per-branch path
(`sessions/service.ts`, the `chosen.length < 2` branch) — that path emits no distinguishing event, so the
true "batch attempted, degraded to solo" count is not recoverable from `orchestration_events` as it
stands. Flagged here as a real coverage gap for whoever next extends this telemetry, not fixed in this
pass (out of this card's DoD, and would be new production code on a card that was scoped as
measurement-only).

## What to do next

Nothing further is computable from this repo's live data today. Re-run
`scripts/extract-batch-gate-events.mjs` after a handful of real K≥2 batches have landed post-`c0fdc501`
(`03:12:40Z` / deploy `04:26Z`) — at that point DoD-2 and DoD-3 both become directly answerable from the
same query, and the falsifier (<15% realised wall-clock saving at K=3-4) can actually be checked against
real numbers instead of the model.
