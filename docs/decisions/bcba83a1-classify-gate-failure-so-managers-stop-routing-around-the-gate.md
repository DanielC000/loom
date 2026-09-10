# bcba83a1 — classify a gate failure (kill/timeout/genuine) so managers stop routing around it

## Narrative

`classifyGateFailure` exists to let the merge gate tell a transient external kill (an OOM-killer/resource-limit SIGKILL under memory pressure) from a genuine test/build failure. Before card bcba83a1, the merge gate surfaced BOTH shapes as the same flat "build gate failed" — managers learned from repeated experience that the gate "lies" under host load, and hand-rolled an unsafe `--no-verify` squash to route around it, defeating the gate's whole purpose for every merge that happened to land during contention, not just the transient ones.

Three buckets, mutually exclusive: "kill" — an external signal terminated the step and OUR OWN `runGateStep` timeout bound was NOT the cause (`failedTimedOut` false, `failedSignal` set) — the shape of an OOM-killer/cgroup/resource-limit kill; retry-eligible. "timeout" — OUR OWN `gateTimeoutMs` bound killed the step (`failedTimedOut` true; `runGateStep` always pairs this with `signal:"SIGKILL"`, but the CAUSE is our own bound, not an external kill) — a separate bucket because a retry here may just re-time-out under the same load; retry-eligible, but deliberately so. "genuine" — a clean non-zero exit (or a spawn error) with no signal and no timeout: a real test/build failure, NEVER retried — retrying would waste cycles and could mask a flaky-passing test.

## Do not

- Do not fold a "kill"/"timeout" classification back into a flat failure — that regresses to the exact behavior that taught managers to bypass the gate with `--no-verify`.
- Do not retry a "genuine" classification — it wastes cycles and risks masking a flaky-passing test.

## Source

JSDoc comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `classifyGateFailure`: originally lines 1136-1149, as of tranche 1's HEAD (commit `18bb69e3`). Extracted by tranche 2; no wording changed, wrapped source lines joined into a flowing paragraph and `*`/bullet markers stripped.
