# 2e52bf99 — Reuse-refusal diagnostics: report every failing condition, and attribute stamp changes to their true cause

## Narrative

`confirmWorkerMerge`'s reuse-a-green-self-check decision (card [[e50600d2-keep-run-gate-for-workers-and-lean-on-reuse]])
needed a manager follow-up once it shipped: when reuse is refused, *why* has to be diagnosable from the
recorded event alone, not re-derived by hand from a transcript.

**Report every failing condition, not just the first.** `reuseRefusalReasons` (outer scope, alongside
`gateRan`/`reusedOpId`, for the same reason: the `evt("build_gate", ...)` call that reads it sits below
the reuse-decision block) is populated with the FULL set of conditions that failed, independently derived
— never just the first one hit. `undefined` whenever reuse actually fired (nothing to explain). Reporting
only the first would bias any distribution built from this field toward whichever condition sits earliest
in the check order, hiding how often a second or third condition is the real blocker.

**Compute every condition unconditionally (hoisted), even once an earlier one already disqualifies
reuse.** Conditions 1-4 (pure reads on `lastCheck`, no I/O) are independently evaluated regardless of
whether an earlier one already fails. Conditions 5/7 (worktree dirty / behind-main) are properties of the
current worktree/git state, independent of whether `lastCheck` even exists, so `freshStamp`/`freshHead`/
`freshBehindMain` are computed unconditionally too. Deliberate: without it, the single most-suspected
cause (no `lastWorkerGateCheck` entry — an in-memory Map wiped by every daemon restart) would explain
itself and stop there, and a fix making the entry durable could still land on a branch ALSO dirty or ALSO
behind main — a second blocker this instrumentation would otherwise hide until the "fix" shipped and
failed to move the reuse rate. Condition 6 (stamp-unchanged) stays conditioned on `lastCheck` existing —
meaningful only relative to a recorded stamp, a genuine not-applicable rather than a measurement gap.
Hoisting never changes the reuse decision: every value is computed exactly once, read by both the reuse
`if` (unchanged operators/order/short-circuit) and the reasons list; nothing between the old call sites
and this hoisted one mutates the worktree, the index, or main (the union-merge/preLanded capture above,
and the timeout-breaker check, are both read/decide-only with respect to worktree content from this
point on).

**"Couldn't measure" is never the same code point as "measured clean."** An unreadable worktree
(`computeWorktreeGateStamp` never throws — it settles as `{head:null, dirty:false}` instead) must never
silently read as `worktree-dirty:false`; `worktreeReadable` (`freshStamp.head !== null`) instead gates a
distinct pair of tokens, `worktree-dirty-unknown`/`stamp-unknown`. Same for condition 7: "couldn't
resolve main's HEAD" (`main-head-unresolved`) is a different cause from "resolved it, main is genuinely
ahead" (`behind-main-unknown` when the count itself failed, `behind-main` when non-zero) — collapsing
them would misattribute a git-infra hiccup as "main advanced."

**Attribute a stamp change to its true cause.** `unionMergeMovedHead` (outer scope, defaults `false`) is
whether the union-merge below actually MOVED HEAD, i.e. `mergeMainIntoWorktree`'s own `merged:true`
(fast-forward OR a real merge commit; VERIFIED by reading that function — its ONLY early-return
short-circuit, a pre-existing merge-base check, returns `merged:false` and never invokes `git merge` at
all when main was already an ancestor). It lets a later stamp-change be attributed correctly: unset on
the preLanded branch (no union-merge ran) and on the "nothing to fold in" short-circuit (main already an
ancestor), so any later stamp change there can only be the worktree/branch itself. When the stamp
differs, the pushed reason is `stamp-changed-by-union-merge` when `unionMergeMovedHead` is true
(structural — main folded in) or `stamp-changed-worktree` otherwise (the worker committed/edited after
its self-check — a real, different signal). Read-only, additive: never influences `reuseResult`, only how
a refusal is explained.

**`reuseRefusalReasons` is captured independent of the later `inertSkip`/`reused` ternary** — stamped at
the reuse-decision block itself, before `inertSkip` is considered, so it reflects why REUSE specifically
was refused regardless of a later inert-diff skip (card `db9b0130`). Absent (never an empty array) when
reuse fired.

## Do not

- Do not report only the first failing reuse condition — report the full set.
- Do not gate conditions 5/7 on conditions 1-4 already passing — unconditional computation is what keeps
  a second blocker from hiding behind a fix for the first.
- Do not let an unreadable worktree read as `worktree-dirty:false` — use the `-unknown` tokens.
- Do not collapse a union-merge-caused stamp change and a worker-caused one into one reason bucket.

## Source

Six sites in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`, as of the tranche-44
worktree's HEAD before this extraction (current line numbers, main moves): `reuseRefusalReasons`'s
outer-scope declaration (~11729), `unionMergeMovedHead`'s outer-scope declaration (~11736), a short
2-line note at `unionMergeMovedHead`'s assignment (~11980, left inline unchanged — already at Class-A
guard length from an earlier tranche), the REFUSAL DIAGNOSTICS hoisting rationale (~12051), the SPLIT
attribution at the stamp-changed reason push (~12146), and the independent-of-the-ternary capture note
(~13147). Wrapped source lines joined into flowing paragraphs, `//` markers stripped, condensed in
places (e.g. the outer-scope/short-circuit/read-decide-only justifications) rather than verbatim
throughout.
