# 6144fe32 — the REST merge ceiling has to absorb real, un-gated git work, not just gate attempts

## Narrative

Card 6144fe32: `confirmWorkerMergeUntilSettled`'s ceiling (`gateCommandTimeoutMs * 6`) has to absorb the
real, un-gated git subprocess work that happens around the gate step — the union-merge/checkout/squash
`confirmWorkerMerge` performs before and after `runGate` resolves — not merely repeated gate attempts.

MEASURED THE HARD WAY: a test wired with a tiny `gateCommandTimeoutMs` to keep this ceiling small in a
targeted run learned this directly — its own post-release re-attach raced a REAL squash (not a stubbed
one) against a 6-second ceiling (1000ms × 6) and lost under host load. The wrapper gave up with
`settled:false` on the one assertion that waits for the post-release settle, even though nothing about
the merge itself was wrong.

## Why bounded at all, and why 6x specifically

BOUNDED so a genuinely wedged op can't hang the HTTP handler forever: the ceiling is sized off the
project's own configured `gateCommandTimeoutMs`, falling back to `DEFAULT_REST_MERGE_CEILING_MS` only
when it can't be resolved at all. Sized at 6x: one merge attempt can itself cost up to ~3x
`gateCommandTimeoutMs` (one auto-extend on the first try, plus one un-extended retry), and this op can
ALSO sit queued behind roughly one more gate of the same worst-case size before it is ever admitted — 6x
covers both without needing to read live queue depth. This budget also has to absorb the real, un-gated
git subprocess work around the gate step — unbounded by `gateCommandTimeoutMs`, not merely gate attempts
— which is the specific hazard this card's own specimen measured. On exceeding the ceiling, the wrapper
returns `{settled:false, opId}` rather than fabricating a result — the caller must report "still
running", never a synthesized "not merged", since a false negative would invite the exact duplicate
re-trigger this mechanism prevents.

## Do not

- Do not size the REST merge ceiling as if it only has to cover repeated gate attempts — real,
  un-gated git subprocess work (union-merge, checkout, squash) runs around the gate step too and must fit
  inside the same budget.
- Do not shrink `gateCommandTimeoutMs` in a test to keep the ceiling small without accounting for the real
  squash time that still has to fit inside `gateCommandTimeoutMs * 6` — a too-tight ceiling races real git
  work, not just the stubbed gate.

## Source

Test file `packages/daemon/test/merge-rest-route-tracked.mjs` and board card `6144fe32`'s own body (a
`test(daemon)` card whose fix targeted the wall-clock race described above), plus the `* 6` ceiling
comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMergeUntilSettled`'s own JSDoc, as of
this tranche's HEAD.
