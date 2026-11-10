# 4a95e9fc — a settled red `run_gate` on the candidate's own tip refuses an interval skip, unless a recorded `overrideReason`

Specimen: a manager landed a branch ungated under the merge-gate interval although its own full `run_gate` self-check on that same head was red, on a private "unrelated flake" judgement. `decideMergeGate` read only cadence state, so the system neither forced a real gate nor recorded that an override happened. Companion to `6f13746c` (the interval itself).

## What it does

- While the latest settled `run_gate` verdict on the branch's own tip is a fail, an INTERVAL skip becomes a gated landing (`reason:"red-self-check"`), or proceeds only with a non-empty, bounded `overrideReason`.
- The override is RECORDED, not authenticated (a manager supplies it), and is never a pass: it rides the merge result, the `merge_done` and `build_gate` events, the `gate_history` row (`overrideReason`) and the `[loom:merge-done]` nudge.
- Under `mergeGate:"off"` (cadence never) nothing is forced or refused: the result carries a `redSelfCheckNote` warning only. A human switched the gate off; this does not second-guess that.
- The verdict is read from the DURABLE `worker_gate` events (`settleHead` + `branch`, stamped on every pass/fail settle), never the in-memory `lastWorkerGateCheck` slot — the host restarts several times a day and a slot-only read would fail open.
- Identity is the BRANCH's own tip read BEFORE any union-merge forward of main, resolved THROUGH merges of main: from the tip, walk first parents (at most 50 hops) while the commit is a merge whose second parent is an ancestor of the mainline HEAD, and collect that head set (`mergeOfMainHeadSet`, `git/mainline-watch.ts`). A confirm that ends with no recorded gate failure (cancelled while queued, `gate_base_invalidated`, a refusal after the pre-gate union-merge) leaves a union-merge commit M on the branch with `gateOwed` still false; without the walk the next confirm reads tip M while the red sits on the commit under it. A settled red on ANY head of the set counts (newest red across the set wins by event order); each head keeps newest-verdict-wins, and a green on one head never clears a red on another. This also carries a red through a worker's OWN merge of main: it fails closed (more gating) and is accepted.
- `settleHead` is the head the gate was ADMITTED against (what it actually ran on); the settle-time worktree head is stamped as `settleWorktreeHead` only when it differs (the tree moved mid-run). A red counts on either head, a green only on `settleHead`.
- A gate forced by a red is NAMED, never silent: `redSelfCheckOpId` + `redSelfCheckNote` on a solo result (a rejection too), `redSelfCheckOpIds` + `redSelfCheckNote` on the `merge_batch` result and its `build_gate` event. The note does not claim the real gate ran when the diff was an inert docs-only skip. Under cadence never an `overrideReason` changes nothing: "warning only; override not needed", and it is not recorded as used. `merge_batch` refuses an `overrideReasons` key that is not in `workerSessionIds`. An unresolvable branch tip logs a warning and fails open.
- A later green on the SAME head clears the red. A cancelled run, a thrown-error row, a landing-check row and a row with no `settleHead` carry no verdict.

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
