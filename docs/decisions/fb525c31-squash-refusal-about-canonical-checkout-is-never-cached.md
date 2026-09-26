# fb525c31 — a refusal about the canonical checkout is never cached, so a re-confirm after cleaning it is a real re-attempt

## Narrative

`worker_merge_confirm`'s until-superseded verdict cache (card `1555e361`, identity extended by `c06f876a`) classified every non-landed result that wasn't a special case as `"rejected"` and replayed it. That is right for a gate verdict about the branch, but wrong for a refusal about the state of the CANONICAL CHECKOUT: staged dirt or a dirty/untracked overlap on a path the branch touches (`canonical_staged_dirt` / `canonical_dirty_overlap`, refused at admission before any gate, or at squash time after a passing gate), and the squash itself failing after a passing gate (`conflict` / `merge_failed`). The documented remedy is for a human to clean the checkout and re-confirm, but those results are unstamped, so their identity is just the branch tip. Cleaning the checkout moves neither the tip nor main, so the re-confirm replayed the stale refusal until the worker pushed or `forceRemoveWorktree:true` was used. Reproduced by `merge-confirm-squash-refusal-recall.mjs` (a never-behind branch: no forward, so nothing masks it — the older scenario (f) used a behind-main branch whose forward changes the identity).

Fix: the four refusal sites (three admission preflights, one squash-time) build their result through ONE constructor, `squashRefusedResult` (`sessions/service.ts`), which sets `squashRefused:true`; `classifyOutcome` reads only that field and returns `"squash-refused"`, which is in `NEVER_CACHED_OUTCOMES`. The test pins the wrapped-site count and both polarities.

**Which stay cached, and why:** `STAGE_EMPTY_RETRY` and `orphaned_zero_ahead` are about the BRANCH (no diff vs main / work missing from it). Their remedy (re-task, cherry-pick) moves the tip, which is already an identity miss, and re-gating an empty branch wastes a lane. They replay as before.

**Why 1555e361 is not reopened:** its hazard is a flaky RED laundered into green by a re-run. These refusals follow a GREEN gate (or precede any gate), so a re-gate can only stay green or turn red — the safe direction. It is also not a poll: a plain re-call with nothing moved after a branch-level verdict is still a cache hit.

**Accepted cost:** a re-call after a post-gate squash refusal re-runs the gate (one lane, bounded by the gate semaphore). A re-call while the checkout is still dirty is refused fast by the admission preflights (`detectCanonicalStagedDirt` / `detectCanonicalDirtyOverlap` / `detectCanonicalUntrackedOverlap`) before any gate — pinned by the test.

**Rejected alternative:** reuse the passed gate and re-run only the squash. The existing reuse machinery only reuses a worker's `run_gate` self-check op, not the merge's own passed gate, so this needs a new proof that the tree, canonical main and merge-gate setting are all unchanged; a bug there lands an untested tree. Too much risk on the merge path for one saved gate lane.

Related: `c06f876a-merge-verdict-cache-identity-includes-main-tip.md`, `1555e361-merge-gate-recall-trap-until-superseded-verdict-cache.md`, `99a1cf6f-gatebaseinvalidated-is-a-real-verdict-never-cache-it.md`.

## Do not

- Do not reuse a passed merge gate to re-run only the squash without a tree + main + mergeGate identity proof.
- Do not hand-set `squashRefused` at a refusal site; go through `squashRefusedResult`, and keep the structural pin in the test in step.
- Do not add `STAGE_EMPTY_RETRY` / `orphaned_zero_ahead` to the uncached set without a reason beyond "they are refusals": they are about the branch and their remedy already changes the identity.
