# 01777ceb — a merge gate's verdict is trusted ONLY when it ran on the exact commit the branch ref names, via ONE shared predicate

## Narrative

Filed by lead `gen 373` (2026-09-25) from Code Reviewer `bd182d8d`'s review of `94c28d2a`. `94c28d2a` had
stopped caching a gate FAIL whose worktree HEAD left the gated commit and came back (a round trip). The
reviewer reproduced two sibling, PRE-EXISTING holes `94c28d2a` never touched:

- **P1 — a plain branch move, main not advanced.** The gate FAILs after the branch moves T1→T2; the
  worker resets to T1 after settle. A re-call read a `cacheHit` at identity T1, although the red was
  earned on T1/T2 content.
- **P2 — a HEAD-only move that never returns.** The worktree is left detached at T3 while the branch ref
  stays at T1, then the gate FAILs. It was stamped `gatedIdentity=T1` and cached, because the stamp only
  ever compared the BRANCH ref, never the worktree HEAD actually used to run the gate.

A Code Review of `01777ceb` itself (`2d179a74`) then found a CRITICAL, pre-existing sibling on the PASS
side: a worktree detached BEFORE the gate starts lets a PASS squash the BRANCH ref's content (never
gated), while the gate actually ran on the detached HEAD. Both are the SAME root cause — a link is "clean"
only if its pre-spawn worktree head equals the branch tip it claims to have gated — so both are fixed on
ONE shared predicate, for FAIL (void) and PASS (refuse) alike.

Introduced across five commits on 2026-09-25 (`5cc93f3b6` → `c1ff9d6e4` → `a65a2d9f4` → `0cd9565b6` →
`dfbf1e003`, the card's own recorded merge sha).

## Decision

**`gateHeadOnBranch(head, branchTip)`** (`git/worktrees.ts`) is THE one pure helper for "did the gate run
on the commit its verdict names" — every caller (the merge gate's own `captureGatedTip`, the `run_gate`
self-check's settle stamp, and the reuse proof at confirm time) feeds it the two reads it already has;
none implements its own local head-vs-ref comparison.

A link counts as **clean** only when BOTH hold: its pre-spawn worktree head equals its `gatedTip` (read
from the branch ref, not assumed), AND it did not leave that commit during its own run (per the reflog
delta `d099087f` already detects). This is the ONE predicate (`gateFinalLinkState`) shared by both sides:

- **FAIL** whose final link was not clean is stored under a **void identity** (`void:<opId>`, never the
  pre-forward sha) — no future tip can equal it, so a re-call always re-gates and still announces the
  identity mismatch, rather than replaying the red as a cheap `cacheHit`.
- **PASS** with ANY contributing link not clean (the flags are sticky across single-file/resumed links,
  reset only at a whole-gate re-run's re-pin) is refused as `gateTipMoved` — squashing the branch ref would
  land content the gate never actually tested.
- An **unreadable reflog snapshot** (a git timeout/error) is "could not verify" (`gateReflogUnverified`),
  never "moved and came back" — it must never be treated as either a clean round trip or a confirmed move.
- The **reuse squash** stays pinned to the exact tip the reuse proof saw (`reuseExpectedTip` →
  `expectedBranchTip`, mirroring the real-gate path's own `975c774b` pin) — a commit landing between the
  proof and the lock must still be caught, not silently absorbed into an unverified `reused:true`.

`describeGateHeadCurrency`'s own check ORDER matters and is itself anchored by card `92dcd9f1`: null-stamp
UNKNOWN, then admit-vs-settle RACY, then the ABA round-trip check, then the start-vs-settle CLEAN/RELABELED
shortcut — see that id's own follow-up note on `d099087f`'s record for why the order was wrong before.

## Do not

- Do not add a second, local "is the worktree head the branch tip" check anywhere — route every caller
  through `gateHeadOnBranch`; a third ad hoc comparison is exactly how this class of bug recurred twice.
- Do not fall back to the pre-forward `verdictIdentity` (the branch sha at confirm start) for a FAIL whose
  final link was not clean — that sha is cheap to return to later and would let a stale re-call replay the
  earned-on-different-content red as a `cacheHit`. Key it on an identity no future tip can equal instead.
- Do not treat an unreadable reflog snapshot as a round trip (`movedAndBack`) OR as a clean pass — it is
  neither; it is UNKNOWN, and both a FAIL and a PASS must fail closed on it rather than guess.
- Do not let `gateTipMoved.live` carry two meanings — it is ALWAYS the branch's live tip; a worktree HEAD
  off that tip travels in its own separate `worktreeHead` (+ `headOffBranch`) field.
- Do not leave the reused-squash pin unset — a commit landing between the reuse proof and the squash lock
  must still be caught as an unverified reuse, not silently squashed at a now-stale tip.
- Do not fix only the FAIL side or only the merge gate: the `run_gate` self-check stamps the WORKTREE head
  too, so a detached self-check used to read `headCurrent:true` and get REUSED by a later merge, landing
  the branch ref's never-gated content. Both the merge gate and the self-check read `gateHeadOnBranch`.
- Do not assume this predicate is per-op — it is PER-LINK (reset by every `captureGatedTip`): an earlier
  link's move must never void or refuse a later, genuinely clean link's identity.

## Related

`94c28d2a` (the round-trip-only fix this card extends) · `d099087f` (the reflog-delta ABA detector this
predicate's "did not leave during its run" half reuses) · `92dcd9f1` (the check-order correction inside
`describeGateHeadCurrency`) · `c3e1bfc3` (the unreadable-reflog-is-not-a-round-trip sibling fix on
`run_gate`'s own settle stamp).
