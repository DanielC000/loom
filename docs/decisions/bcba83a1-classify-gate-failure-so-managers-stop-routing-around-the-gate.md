# bcba83a1 — classify a gate failure (kill/timeout/genuine) so managers stop routing around it

## Narrative

`classifyGateFailure` exists to let the merge gate tell a transient external kill (an OOM-killer/resource-limit SIGKILL under memory pressure) from a genuine test/build failure. Before card bcba83a1, the merge gate surfaced BOTH shapes as the same flat "build gate failed" — managers learned from repeated experience that the gate "lies" under host load, and hand-rolled an unsafe `--no-verify` squash to route around it, defeating the gate's whole purpose for every merge that happened to land during contention, not just the transient ones.

Three buckets, mutually exclusive: "kill" — an external signal terminated the step and OUR OWN `runGateStep` timeout bound was NOT the cause (`failedTimedOut` false, `failedSignal` set) — the shape of an OOM-killer/cgroup/resource-limit kill; retry-eligible. "timeout" — OUR OWN `gateTimeoutMs` bound killed the step (`failedTimedOut` true; `runGateStep` always pairs this with `signal:"SIGKILL"`, but the CAUSE is our own bound, not an external kill) — a separate bucket because a retry here may just re-time-out under the same load; retry-eligible, but deliberately so. "genuine" — a clean non-zero exit (or a spawn error) with no signal and no timeout: a real test/build failure, NEVER retried — retrying would waste cycles and could mask a flaky-passing test.

## The auto-retry mechanism, and its rejection-headline wording

TRANSIENT-KILL AUTO-RETRY: on a retry-eligible classification only (never a clean non-zero exit — see classification above), `confirmWorkerMerge` settles briefly then re-runs the SAME gate ONCE before reporting anything. A pass here falls through to the normal squash-merge exactly as if the gate had been green the first time — the squash decision itself is UNCHANGED by this retry ever having happened (see `retriedFile`/`retryPassed` — [[344ce950-bounded-multi-file-retry-cost-and-pass-after-retry-is-weaker-evidence]] — for why a pass-after-retry still stays visible downstream).

When the gate still ends up rejected, `reason`/the rejection headline vary for a retry-eligible classification — "gate killed by \<signal\> [(possibly OOM/resource)] — \<retry outcome\>" / "gate timed out (possibly resource-starved under load) — \<retry outcome\>" — instead of the flat "build gate failed"; but ONLY for those two classes — a genuine clean non-zero exit keeps the exact bare "build gate failed" string, so the existing back-compat contract for a real test/build failure (`merge-gate-diagnostic.mjs` case A) is untouched. The "kill" headline names the ACTUAL signal rather than asserting OOM outright (Code Review follow-up on this card): a SIGSEGV/SIGABRT from a broken native addon is a genuine deterministic crash, not memory pressure, and mislabeling it "likely OOM" would misdirect a manager diagnosing a real bug. The "(possibly OOM/resource)" hint is appended ONLY for SIGKILL — the signal an OOM-killer/cgroup limit actually sends.

## Do not

- Do not fold a "kill"/"timeout" classification back into a flat failure — that regresses to the exact behavior that taught managers to bypass the gate with `--no-verify`.
- Do not retry a "genuine" classification — it wastes cycles and risks masking a flaky-passing test.
- Do not treat a pass after the transient-kill auto-retry as anything other than a fall-through to the normal squash-merge — the squash decision is unaffected by the retry having happened.
- Do not assert "likely OOM" for a SIGSEGV/SIGABRT kill headline — name the actual signal; only SIGKILL gets the "(possibly OOM/resource)" hint.

## Source

JSDoc comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `classifyGateFailure`: originally lines 1136-1149, as of tranche 1's HEAD (commit `18bb69e3`). Extracted by tranche 2; no wording changed, wrapped source lines joined into a flowing paragraph and `*`/bullet markers stripped. The auto-retry-mechanism and headline-wording section above is from two further sites in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`: the TRANSIENT-KILL AUTO-RETRY block's intro (as of this tranche's HEAD) and the KILL CLASSIFICATION rejection-headline comment further down the same method. Condensed and reworded, not verbatim.
