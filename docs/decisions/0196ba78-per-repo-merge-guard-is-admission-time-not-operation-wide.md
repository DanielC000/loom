# 0196ba78 — the per-repo merge-admission guard is an ADMISSION-time mechanism, not a merge-operation-wide one — deliberately

## Narrative

Card 0196ba78: the per-repo merge-admission guard's (card `92e960d1`) "can never both be RUNNING" claim binds ONLY to ops that actually reach `acquire`/`admit` via `runExclusive` — anything that never calls `runExclusive` is structurally invisible to `activeMergeRepos` and gets NO protection from this guard. Two real paths reach a squash without ever calling `runExclusive`: a merge-gate REUSE (card `e50600d2` — `gateResult = reuseResult ?? await this.gateSemaphore.runExclusive(...)`, short-circuited by `??` when a redundant re-gate is skipped) and a GATELESS project/repo (no `gateCommand` configured, so the whole `if (gate)` block in `confirmWorkerMerge` never runs). This is DELIBERATE, not an oversight the way the unqualified "can never both be RUNNING" claim initially reads.

**Why it's deliberate, not a gap:**

- THE JUSTIFYING CLAUSE IS LANE LANGUAGE: `92e960d1`'s own originating commit (`848f55fb`, 2026-08-04) titled the problem "wasting a lane unrelated work could have used." A reuse-path merge NEVER TAKES A LANE AT ALL — it skips `runExclusive` entirely — so the harm this guard exists to prevent is one reuse is structurally incapable of causing. That's a category fact, not a scoping judgement call.
- THE DATING CONFIRMS IT: `e50600d2` (commit `1a779c8f`, 2026-07-29) predates `92e960d1` (`848f55fb`, 2026-08-04) by six days — this guard was written into a codebase that ALREADY carried a documented, standing reuse-skip exemption from `runExclusive`. The boundary drawn here is the mechanism's natural edge, not a gap that was missed.
- `c24dd48a` (2026-08-05) independently RE-DERIVED the same boundary under review pressure: an earlier draft of that card called `beginSquash`/`endSquash` unconditionally, review caught that this let a reuse/gateless op silently delete a DIFFERENT, genuinely-admitted op's still-active hold (`activeMergeRepos` has no per-op identity), and the shipped fix confines both calls to `gateRan` — i.e. keeps reuse/gateless permanently outside this mechanism. Two independent derivations of the same boundary is strong evidence it's correct.

WHAT ACTUALLY PROTECTS THE EXCLUDED PATHS: not this guard — `requireCanonicalHead`, re-checked INSIDE `mergeBranchLocked`'s own lock (`git/worktrees.ts`) at squash time, fail-closed. A racing reuse/gateless squash against a genuinely-admitted sibling self-aborts with `gateBaseInvalidated` rather than landing unverified content — this is a throughput/wasted-gate-run gap, NOT a data-loss one.

**Residual exposure, precisely scoped — do not round either of these up or down:**

- GATELESS: on a project where every binding of a given `repoPath` sets a `gateCommand` (the ordinary case, and this project's actual configuration), a gateless race can't occur — there's no gate-running sibling on that repo for a gateless op to race. That is NOT a general guarantee: `gateCommand` is per-PROJECT, `repoPath` is per-REPO, and nothing prevents two DIFFERENT projects on the same daemon from binding the SAME repo path with differing gate configuration — in that arrangement a gateless merge from one project genuinely can race a gate-running merge from the other. Unreachable on any configuration where every project binding this repo sets a `gateCommand`; the residual requires two projects sharing one `repoPath` with differing gate configuration.
- REUSE: has no such conditional escape — it's a live gap under every configuration — but is observed at n=0 in weeks: low OBSERVED frequency on an instrument that can't distinguish "rare" from "never fires," not asserted-low severity.

## Do not

- Do not read the per-repo merge-admission guard's "can never both be RUNNING" claim as covering every merge — a reuse-path or gateless merge never reaches `runExclusive` at all and is structurally invisible to it.
- Do not treat this as a gap needing a fix — it was independently re-derived by two separate cards (`92e960d1`'s own dating, and `c24dd48a`'s review-caught correction), and `requireCanonicalHead`'s in-lock re-check at squash time is what actually protects the excluded paths, unchanged, with a throughput cost, not a data-loss one.
- Do not round the GATELESS residual up to "a general guarantee" or down to "unreachable" — it depends on whether any two projects on this daemon bind the same `repoPath` with differing gate configuration.
- Do not treat "observed at n=0 in weeks" as "asserted low severity" for the REUSE residual — it is an OBSERVED frequency on an instrument that can't tell "rare" from "never fires."

## Source

Inline comment in `packages/daemon/src/orchestration/gate-semaphore.ts` (module-level doc, lines 60-102), commit `390f05ba7`, as of `beeeb7c2`. Relocated by card `772735d2` (tranche 2); no wording changed, wrapped source lines joined into flowing paragraphs and the `*` comment markers stripped.
