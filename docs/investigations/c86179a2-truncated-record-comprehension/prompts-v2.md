# Design 2 (v2) prompts — corrected, leak-scrubbed shared preamble

Shared task text (appended to each arm's own reference-material section):
```
SCENARIO: A software daemon has a concurrency-control guard ("the admission guard") whose job is to stop
two merge operations on the same shared repository from both actively running their gate checks at the
same time (a "race"). Two specific kinds of merge, called REUSE-path merges and GATELESS merges, are both
known to be structurally excluded from this guard's protection — neither one is covered by it.

A teammate makes this claim: "Since REUSE-path merges and GATELESS merges are both excluded from the
admission guard, they must carry the same residual race risk in our current production setup. So it's
fine to deprioritize monitoring both of them equally, with the same justification."

QUESTION (answer using ONLY the information given to you in this prompt, including any reference
material below; do not use any tools to browse, search, or fetch anything — this is a closed-book
reasoning task from the text provided; if the material given to you does not settle the question, say so
plainly rather than guessing):

Is the teammate's claim correct — do REUSE-path merges and GATELESS merges actually carry the same
residual race risk in the current setup, such that it is fine to deprioritize monitoring both equally for
the same reason?

Answer with exactly one of: YES (the claim is correct, treat them the same) / NO (the claim is wrong,
they do NOT carry the same risk) / INSUFFICIENT INFORMATION (the material given does not let you judge
either way). Then give 2-4 sentences of reasoning.

Format your answer EXACTLY as:
Answer: YES / NO / INSUFFICIENT INFORMATION
Reasoning: ...
```

## Arm 1 reference material (lines 49-98 of gate-semaphore.ts, truncated — same extraction as v1)
```
 * PER-REPO MERGE ADMISSION (card 92e960d1): a SECOND, narrower exclusivity guard alongside the
 * per-worktree one above — `descriptor.repoPath` (set ONLY on a `merge`-kind descriptor, by
 * `confirmWorkerMerge`) gates admission via `activeMergeRepos`, so two `merge`-kind gates targeting the
 * SAME canonical repo can never both be RUNNING at once, regardless of `cap`/tier — closing the class
 * where two same-repo merges race concurrently, one guaranteed to burn a full gate run before aborting at
 * squash (canonical main is a single shared resource; see `mergeBranchLocked`'s `requireCanonicalHead`
 * re-check in git/worktrees.ts). Composes with the worktree guard and the priority queue exactly the same
 * way that guard already does (`mergeRepoFree`, alongside `worktreeFree`, in `acquire`/`grantNext`) — a
 * `worker`/`deploy` gate is structurally unaffected (see `mergeRepoFree`'s own doc), and two merges on
 * DIFFERENT repos are never cross-serialized.
 *
 * ⚠️ SCOPE, MADE EXPLICIT (card 0196ba78 — this is an ADMISSION-time mechanism, not a
 * merge-OPERATION-wide one): the "can never both be RUNNING" claim above binds ONLY to ops that actually
 * reach `acquire`/`admit` via `runExclusive` — anything that never calls `runExclusive` is structurally
 * invisible to `activeMergeRepos` and gets NO protection from this guard. Two real paths reach a squash
 * without ever calling `runExclusive`: a merge-gate REUSE (card e50600d2 — `gateResult = reuseResult ??
 * await this.gateSemaphore.runExclusive(...)`, short-circuited by `??` when a redundant re-gate is
 * skipped) and a GATELESS project/repo (no `gateCommand` configured, so the whole `if (gate)` block in
 * `confirmWorkerMerge` never runs). THIS IS DELIBERATE, not an oversight the way the unqualified claim
 * above initially reads:
 *   - THE JUSTIFYING CLAUSE ABOVE IS LANE LANGUAGE: this guard's own originating commit (`848f55fb`,
 *     2026-08-04) titled the problem "wasting a lane unrelated work could have used." A reuse-path merge
 *     NEVER TAKES A LANE AT ALL — it skips `runExclusive` entirely — so the harm this guard exists to
 *     prevent is one reuse is structurally incapable of causing. That's a category fact, not a scoping
 *     judgement call.
 *   - THE DATING CONFIRMS IT: `e50600d2` (commit `1a779c8f`, 2026-07-29) predates `92e960d1`
 *     (`848f55fb`, 2026-08-04) by six days — this guard was written into a codebase that ALREADY carried
 *     a documented, standing reuse-skip exemption from `runExclusive` (see the reuse producer's own doc
 *     at its `confirmWorkerMerge` call site in service.ts). The boundary drawn here is the mechanism's
 *     natural edge, not a gap that was missed.
 *   - `c24dd48a` (2026-08-05) independently RE-DERIVED the same boundary under review pressure: an
 *     earlier draft of that card called `beginSquash`/`endSquash` unconditionally, review caught that
 *     this let a reuse/gateless op silently delete a DIFFERENT, genuinely-admitted op's still-active hold
 *     (`activeMergeRepos` has no per-op identity), and the shipped fix confines both calls to `gateRan`
 *     — i.e. keeps reuse/gateless permanently outside this mechanism (see that call site's own doc in
 *     service.ts). Two independent derivations of the same boundary is strong evidence it's correct.
 *
 * WHAT ACTUALLY PROTECTS THE EXCLUDED PATHS: not this guard — `requireCanonicalHead`, re-checked INSIDE
 * `mergeBranchLocked`'s own lock (git/worktrees.ts) at squash time, fail-closed. A racing reuse/gateless
 * squash against a genuinely-admitted sibling self-aborts with `gateBaseInvalidated` rather than landing
 * unverified content — this is a throughput/wasted-gate-run gap, NOT a data-loss one.
 *
 * RESIDUAL EXPOSURE, PRECISELY SCOPED — do not round either of these up or down:
 *   - GATELESS: on a project where every binding of a given `repoPath` sets a `gateCommand` (the ordinary
 *     case, and this project's actual configuration), a gateless race can't occur — there's no
 *     gate-running sibling on that repo for a gateless op to race. That is NOT a general guarantee:
 *     `gateCommand` is per-PROJECT, `repoPath` is per-REPO, and nothing prevents two DIFFERENT projects on
 *     the same daemon from binding the SAME repo path with differing gate configuration — in that
 *     arrangement a gateless merge from one project genuinely can race a gate-running merge from the
 *     other. Unreachable on any configuration where every project binding this repo sets a gateCommand;
```

## Arm 2 reference material (lines 49-103 of gate-semaphore.ts, complete — same extraction as v1)
```
 * PER-REPO MERGE ADMISSION (card 92e960d1): a SECOND, narrower exclusivity guard alongside the
 * per-worktree one above — `descriptor.repoPath` (set ONLY on a `merge`-kind descriptor, by
 * `confirmWorkerMerge`) gates admission via `activeMergeRepos`, so two `merge`-kind gates targeting the
 * SAME canonical repo can never both be RUNNING at once, regardless of `cap`/tier — closing the class
 * where two same-repo merges race concurrently, one guaranteed to burn a full gate run before aborting at
 * squash (canonical main is a single shared resource; see `mergeBranchLocked`'s `requireCanonicalHead`
 * re-check in git/worktrees.ts). Composes with the worktree guard and the priority queue exactly the same
 * way that guard already does (`mergeRepoFree`, alongside `worktreeFree`, in `acquire`/`grantNext`) — a
 * `worker`/`deploy` gate is structurally unaffected (see `mergeRepoFree`'s own doc), and two merges on
 * DIFFERENT repos are never cross-serialized.
 *
 * ⚠️ SCOPE, MADE EXPLICIT (card 0196ba78 — this is an ADMISSION-time mechanism, not a
 * merge-OPERATION-wide one): the "can never both be RUNNING" claim above binds ONLY to ops that actually
 * reach `acquire`/`admit` via `runExclusive` — anything that never calls `runExclusive` is structurally
 * invisible to `activeMergeRepos` and gets NO protection from this guard. Two real paths reach a squash
 * without ever calling `runExclusive`: a merge-gate REUSE (card e50600d2 — `gateResult = reuseResult ??
 * await this.gateSemaphore.runExclusive(...)`, short-circuited by `??` when a redundant re-gate is
 * skipped) and a GATELESS project/repo (no `gateCommand` configured, so the whole `if (gate)` block in
 * `confirmWorkerMerge` never runs). THIS IS DELIBERATE, not an oversight the way the unqualified claim
 * above initially reads:
 *   - THE JUSTIFYING CLAUSE ABOVE IS LANE LANGUAGE: this guard's own originating commit (`848f55fb`,
 *     2026-08-04) titled the problem "wasting a lane unrelated work could have used." A reuse-path merge
 *     NEVER TAKES A LANE AT ALL — it skips `runExclusive` entirely — so the harm this guard exists to
 *     prevent is one reuse is structurally incapable of causing. That's a category fact, not a scoping
 *     judgement call.
 *   - THE DATING CONFIRMS IT: `e50600d2` (commit `1a779c8f`, 2026-07-29) predates `92e960d1`
 *     (`848f55fb`, 2026-08-04) by six days — this guard was written into a codebase that ALREADY carried
 *     a documented, standing reuse-skip exemption from `runExclusive` (see the reuse producer's own doc
 *     at its `confirmWorkerMerge` call site in service.ts). The boundary drawn here is the mechanism's
 *     natural edge, not a gap that was missed.
 *   - `c24dd48a` (2026-08-05) independently RE-DERIVED the same boundary under review pressure: an
 *     earlier draft of that card called `beginSquash`/`endSquash` unconditionally, review caught that
 *     this let a reuse/gateless op silently delete a DIFFERENT, genuinely-admitted op's still-active hold
 *     (`activeMergeRepos` has no per-op identity), and the shipped fix confines both calls to `gateRan`
 *     — i.e. keeps reuse/gateless permanently outside this mechanism (see that call site's own doc in
 *     service.ts). Two independent derivations of the same boundary is strong evidence it's correct.
 *
 * WHAT ACTUALLY PROTECTS THE EXCLUDED PATHS: not this guard — `requireCanonicalHead`, re-checked INSIDE
 * `mergeBranchLocked`'s own lock (git/worktrees.ts) at squash time, fail-closed. A racing reuse/gateless
 * squash against a genuinely-admitted sibling self-aborts with `gateBaseInvalidated` rather than landing
 * unverified content — this is a throughput/wasted-gate-run gap, NOT a data-loss one.
 *
 * RESIDUAL EXPOSURE, PRECISELY SCOPED — do not round either of these up or down:
 *   - GATELESS: on a project where every binding of a given `repoPath` sets a `gateCommand` (the ordinary
 *     case, and this project's actual configuration), a gateless race can't occur — there's no
 *     gate-running sibling on that repo for a gateless op to race. That is NOT a general guarantee:
 *     `gateCommand` is per-PROJECT, `repoPath` is per-REPO, and nothing prevents two DIFFERENT projects on
 *     the same daemon from binding the SAME repo path with differing gate configuration — in that
 *     arrangement a gateless merge from one project genuinely can race a gate-running merge from the
 *     other. Unreachable on any configuration where every project binding this repo sets a gateCommand;
 *     the residual requires two projects sharing one `repoPath` with differing gate configuration.
 *   - REUSE: has no such conditional escape — it's a live gap under every configuration — but is observed
 *     at n=0 in weeks (card 0196ba78): low OBSERVED frequency on an instrument that can't distinguish
 *     "rare" from "never fires," not asserted-low severity.
 */
```

## Arm 3 reference material
```
none is available for this guard's internals.
```
