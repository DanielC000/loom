# b97f643d — Skip a provably-inert path in the classification loop, reusing the SAME predicate

## Narrative

A path already certified inert by `isInertMergePath` (e.g. `docs/**`) is SKIPPED in `computeEmitCompareGate`'s classification loop, before it can hit the `notEligible` catch-all — REUSING that exact predicate (list AND matching logic), never a second hand-copied one (this file's own recurring shared-unit-divergence warning). Without this, a diff that is otherwise reducible (comment-only `.ts`, or a changed test file) but ALSO touches one provably-inert `docs/` path fell to the FULL gate — strictly MORE expensive than either the `docs/` path alone (which already skips the gate entirely via `isInertMergeDiff`, itself built on this same predicate) or the reducible part alone. This is purely NARROWING: it can only ever remove a path from consideration that would otherwise have forced `eligible:false`, never admit a path that isn't ALSO already provably inert by the same predicate the full-skip path trusts.

## Does not, by itself, guarantee an all-inert diff never reaches this function

This function has TWO callers in `sessions/service.ts`, and they are NOT guarded the same way. The PRIMARY classification site is gated `!inertSkip`, with `inertSkip` freshly re-derived from `isInertMergeDiff` immediately above — so an all-inert diff structurally cannot reach this function through that site. The ADMISSION-TIME RECLASSIFICATION site is gated only on a PRIOR classification having been eligible and never re-consults `isInertMergeDiff` — so a diff that shrinks to all-inert paths between pre-wait classification and admission CAN reach this function that way. For THAT path, it is the pre-existing empty-set guard ("no eligible changed path left to prove inert") — not this skip — that fails the result closed; this skip only ensures the reason is that guard rather than the "path outside emit-compare scope" catch-all further down. Traced at card `b97f643d`; judged acceptable as-is (narrow window, fails toward the safe full-gate outcome either way) rather than widened to re-consult `isInertMergeDiff` a second time.

## Do not

- Do not hand-copy a second inert-path list/matcher for this classification loop — reuse `isInertMergePath` directly; a second copy is exactly the shared-unit divergence this file's other decisions warn against repeatedly.
- Do not assume this skip alone guarantees an all-inert diff never reaches this function — the admission-time reclassification call site can still reach it via a diff that shrank to all-inert between classification and admission; the empty-set guard, not this skip, is what fails that case closed.
- Do not widen this to re-consult `isInertMergeDiff` a second time at the reclassification site "to be safe" — judged acceptable as-is; the window is narrow and fails toward the safe full-gate outcome either way.

## Consequences

A diff that mixes a provably-inert path with an otherwise-reducible change no longer falls to the full gate just because of the inert path — closing a real, strictly-more-expensive-than-necessary case, while leaving a narrow, judged-acceptable window at the admission-time reclassification call site.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `computeEmitCompareGate`'s classification loop, at the `isInertMergePath` skip (~line 2983), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*`/`//` comment markers stripped, no wording changed.
