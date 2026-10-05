# bd9a483b — stale landing-check re-verification accepts Loom's own re-union of main, never raw head-equality

## Narrative

`confirmWorkerMerge`'s ungated-landing-check path re-verifies, in-lock, that the worktree the check ran
against is still the one about to be squashed. The existing ungated point's `heldStamp`/`skipBranchTip`
(already computed for the squash pin just above) are reused as-is for this re-check — no second git read.

Raw head-equality between the check's pre-head and the held stamp's head is wrong here: Loom's OWN
re-union of main — triggered just above, in-lock, whenever main moved during the guard wait — also moves
`heldStamp.head`. Comparing by raw equality would then make this check NEVER settle on a busy main: a
livelock, not a safety property. Only a genuinely NEW WORKER commit landing during the check's run (or
its queue/guard wait) makes the check's own verdict stale.

The check reuses the SAME reviewed-tip-rule walker `worker_merge_confirm` itself calls elsewhere
(`verifyReviewedTipChain`, card `bbccf470`) — it accepts fast-forwards through main and clean merges of
main, and rejects anything else (a real worker commit). A verified chain is NOT stale: the check's own
verdict (branch content + whatever main looked like at check time) still covers landing onto a NEWER
main, because an interval-skipped landing is, by policy, never gated against main's content at all
(gate-disabled/interval both skip that re-derivation entirely) — the check never claimed to validate
against one specific main tip.

## The held-branch asymmetry (CR round 4) — and its round-5 correction

A HELD branch's own re-union of main is built over its *owed base* (`mergeMainIntoWorktree`'s `owedBase`
— see card `13fc5227`), not the branch's fork point. `reviewedTipVerdict` (one of `verifyReviewedTipChain`'s
two callers) already passes `owed.kind === "range" ? [owed.base] : []` as `extraUnionBases`. This
landing-check stale re-check passed no `extraUnionBases` at all — a two-path asymmetry that could
silently drift further apart. Both callers now derive their extra union bases through the single
`extraUnionBasesForOwedBase` helper from the same owed-base source, so they cannot diverge again.

Round 4 framed the fix as closing a livelock: "without the owed base, a held branch's re-union reads as
stale because its tree differs from a plain two-way merge-tree of `prev`/`m`". **That framing was refuted
at this call site** (test (11) in `ungated-landing-check.mjs`, plus the reviewer's own `git merge-tree`
negative control). For a single-hop, non-conflicting main move, the flat structural check
(`merge-tree(prev, m)`, auto merge-base) and the sequential owed-base replay
(`computeOwedLanding(owedBase, prev, m)`) **provably agree** — not because they are two independently
sound algorithms that happen to coincide, but because `prev` at this call site has *already* had the
owed-base union applied by the in-call re-union that runs immediately above the stale re-check, every
time, for a held branch. By the time `verifyReviewedTipChain(prev, m)` runs, `prev` already contains the
owed commits merged onto main's new tip, so `merge-tree`'s auto-computed base and the owed-base replay's
explicit base name the same commit — one hop, one merge base. A main move that instead overlaps the exact
path an owed commit touches makes both computations conflict identically (same algorithm, same effective
inputs), and `mergeMainIntoWorktree`'s owedBase branch returns `ok:false` on that conflict before ever
committing — the worktree HEAD never changes, so the stale re-check's own
`landingCheckPreHead !== heldStamp.head` guard never even fires. So within a single `confirmWorkerMerge`
call, there is no reachable one-hop scenario where omitting `extraUnionBasesForOwedBase` flips a held
branch's `merged:true` to `merged:false` without also breaking the merge via a conflict that bypasses the
check entirely — the round-4 "livelock on every move" framing does not reproduce at the content level for
this call site.

The fix itself is still correct, for a narrower reason: it is an **anti-drift/consistency fix**, not a
livelock fix. It closes a real asymmetry — one caller of `verifyReviewedTipChain` passing the owed base,
the other not — that could silently diverge further on a future edit to either call site, and it was
verified by a WIRING-level spy test proving the stale re-check actually calls the shared helper with the
branch's real owedBase (RED on `1b2e544a`, where the helper was never called there; GREEN after the fix).

**What WOULD make the owed base load-bearing (not merely anti-drift) here:** a `prev` that does NOT yet
carry a post-landing union with `owedBase` when `verifyReviewedTipChain` runs — e.g. a future refactor
that calls the stale re-check BEFORE the in-call re-union, or a multi-hop scenario (main moved more than
once since the branch was held, so the single auto-computed merge-base no longer coincides with the
sequential owed-base replay's chosen base). Neither is reachable at today's single-hop call site; both are
exactly the shape a future edit could introduce, which is what the shared helper guards against.

## Do not

- Do not compare `landingCheckPreHead`/`heldStamp.head` (or any pre/post stamp pair on this path) by raw
  equality — Loom's own re-union of main moves the head too, and raw equality livelocks a busy main.
- Do not call `verifyReviewedTipChain` from either this re-check or `reviewedTipVerdict` without routing
  through `extraUnionBasesForOwedBase` — a hand-written `owed.kind === "range" ? [owed.base] : []` at a
  new call site is exactly the drift this helper exists to prevent, even though at today's single-hop
  call site the two computations provably agree either way (see above) — the guard is for FUTURE drift,
  not a currently-reachable misclassification.
- Do not re-litigate a content-level RED/GREEN repro for THIS call site (single-hop, in-call union always
  applied first) without first checking whether a multi-hop or pre-union scenario is actually what's
  needed — see "What WOULD make the owed base load-bearing" above.

## Consequences

The Narrative section's livelock avoidance (comparing by reviewed-tip-chain rather than raw head-equality)
is real and applies to every branch, held or not — that is what actually stops this check from livelocking
on a busy main. The held-branch `extraUnionBasesForOwedBase` fix in this section is narrower: it is an
anti-drift/consistency fix between `reviewedTipVerdict` and this stale re-check, not a second,
independently load-bearing livelock fix — see the round-5 correction above for why no held-branch
livelock reproduces at today's single-hop call site either way. An un-held branch's behavior is unchanged
(`extraUnionBasesForOwedBase` returns `[]` when there is no owed base).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`'s ungated-landing-check
stale re-check, as of this worktree's HEAD before this extraction (card round 3), trimmed by round 4.
The round-5 correction's reasoning is adapted from test (11)'s own narrative header in
`packages/daemon/test/ungated-landing-check.mjs` (moved here per round 5 M2; that test now carries only a
short pointer back to this record).
