# 4a95e9fc — a settled red `run_gate` on the candidate's own tip refuses an interval skip, unless a recorded `overrideReason`

Specimen: a manager landed a branch ungated under the merge-gate interval although its own full `run_gate` self-check on that same head was red, on a private "unrelated flake" judgement. `decideMergeGate` read only cadence state, so the system neither forced a real gate nor recorded that an override happened. Companion to `6f13746c` (the interval itself).

## What it does

- While the latest settled `run_gate` verdict on the branch's own tip is a fail, an INTERVAL skip becomes a gated landing (`reason:"red-self-check"`), or proceeds only with a non-empty, bounded `overrideReason`.
- The override is RECORDED, not authenticated (a manager supplies it), and is never a pass: it rides the merge result, the `merge_done` and `build_gate` events, the `gate_history` row (`overrideReason`) and the `[loom:merge-done]` nudge.
- Under `mergeGate:"off"` (cadence never) nothing is forced or refused: the result carries a `redSelfCheckNote` warning only. A human switched the gate off; this does not second-guess that.
- The verdict is read from the DURABLE `worker_gate` events (`settleHead` + `branch`, stamped on every pass/fail settle), never the in-memory `lastWorkerGateCheck` slot — the host restarts several times a day and a slot-only read would fail open.
- Identity is the BRANCH's own tip read BEFORE any union-merge forward of main, so Loom's own forward of main cannot launder a red. A later green on the SAME head clears it. A cancelled run, a thrown-error row, a landing-check row and a row with no `settleHead` carry no verdict.

## Known limits

- A NEW commit by the worker is a new head: the old red no longer applies and the skip is allowed. A re-called `run_gate` on an unchanged tree replays the retained verdict (same op, observed even with `force`), so the usual way out of a flaky red is a new commit, which this check deliberately does not follow.
- A read failure (git or db) fails OPEN with a warning: the check only ever adds a refusal.
- `ungatedLandingCheckCommand` is unrelated and independent; it runs only on an interval-skipped landing that this check let through.

## Do not

- Do not read the in-memory `lastWorkerGateCheck` slot for this decision: a restart empties it and the skip fails open.
- Do not key the red on the worktree head after the union-merge forward, or on `validatedHead` (the run's start stamp, which can be a stale label): key on the branch tip read before the forward, against the settle head.
- Do not count a cancelled, thrown-error, landing-check or unstamped `worker_gate` row as a verdict, in either direction.
- Do not force the gate under cadence never; warn only.
- Do not treat `overrideReason` as a pass or as authenticated, and do not drop it from any of the five surfaces above.
