# d005f55b — the diverged-prior accumulation candidate reuses the PRIOR generation's REPORTED signature

## Narrative

Card d005f55b DoD-2 — the SEPARATE, ADDITIVE candidate the card's own fix direction names. `detectComposerAccumulation` can never confirm a fusion whose PRIOR generation's own reported echo had ALREADY diverged from what Loom wrote for it — it sums `recentWrittenTurns` (what Loom WROTE), but the composer's real state is what was actually SUBMITTED (see the card's §THE COMPOUNDING MECHANISM: on a real, arithmetically-exact specimen, `reported(gen11) = written(gen11) + reported(gen10)`, not `written(gen11) + written(gen10)`, once gen10's own report had already mismatched). This tries exactly ONE additional, narrower candidate: the immediately preceding RECORDED generation's own REPORTED signature (never its written one) plus the CURRENT write's own WRITTEN text. Still exact-sum AND exact-hash — no loosening: `fnv1a32Continue` reconstructs the concatenation's hash from the prior entry's own hash alone (see that function's own doc for why this needs no full text), so this confirmation is no less rigorous than the sibling detector above; it only widens WHICH prior signature a candidate is allowed to reuse.

Deliberately narrow — a single two-entry candidate (prior generation's REPORTED value + the current write's own WRITTEN text), not a multi-span search like `detectComposerAccumulation`. The card's own regression fixture (gen=10/gen=11: written 1893/1126, reported 2161/3287) and fix direction name exactly this shape, measured on n=1 pair in the card body; a real-corpus length-only sweep (worker report, card d005f55b) found the SAME sum equation — `reportedLen(N) == writtenLen(N) + reportedLen(prior recorded gen)` — satisfied by 80 of 362 checked mismatches (~22%) across 6 rotations of `daemon-output.log`, so this is not a one-off shape. Widening to a multi-generation REPORTED chain (prior-of-prior, etc.) is unestablished by this sweep (which only checked one hop back) and is explicitly left as a follow-up — see the card's own bounds on not re-litigating scope here.

## Do not

- Do not widen this to a multi-generation REPORTED chain (prior-of-prior, etc.) on the strength of this sweep alone — the ~22% figure only checked one hop back; a deeper chain is an explicit, unestablished follow-up.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`detectComposerAccumulationOverDivergedPrior`'s function doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
