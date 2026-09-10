# a3c3ade8 — git_commit's authoredContent reuse is hardening beyond the card's own spec

## Narrative

The `git-push` lever (card `a3c3ade8`) has two tools: `git_commit` (Tier A) and `git_push` (Tier X). `git_commit`'s `message` defaults to requiring Primitive B (a verbatim owner quote) — mirroring `board_create`'s own default-verbatim posture — UNLESS this project's grant config sets `authoredContent:true` (the same reused key/semantics as `board-reach`'s own Tier-A residual opt-in), in which case the companion may author a real commit message.

This `authoredContent` gate on `git_commit` is deliberate hardening BEYOND the card's own explicit spec. Without it, a warm Tier-A trust window would let an injected turn commit fabricated local history with ZERO owner disclosure — nothing is shown to the owner on the low-friction direct-commit path. That is the same class of risk `board_create`'s own `authoredContent` gate already defends against, so `git_commit` was given the identical guard rather than shipping without it.

## Do not

- Do not remove the `authoredContent` gate from `git_commit` on the grounds that the original card didn't require it — it was added deliberately, closing a zero-disclosure injection risk on the warm Tier-A path.

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`git-push`'s top-of-block doc, the `git_commit` paragraph): lines 2508-2517, as of this tranche's HEAD. Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
