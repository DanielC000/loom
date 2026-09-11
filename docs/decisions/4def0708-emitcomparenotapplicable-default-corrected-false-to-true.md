# 4def0708 — `emitCompareNotApplicable`'s declaration default was the informative `false`; corrected to the uninformative `true`

## Narrative

`confirmWorkerMerge`'s local `emitCompareNotApplicable` flag (`sessions/service.ts`) carries whether
`computeEmitCompareGate`'s predicate said this repo's layout could never have been eligible for a reduced
gate (see `docs/decisions/2db8a3dd-notapplicable-vs-notreducible-first-terminal-wins.md` for the predicate
itself). Before card 4def0708, its declaration defaulted to `false` — the INFORMATIVE value, meaning "the
predicate ran and said this repo/diff IS applicable". Several routes skip the predicate block entirely
(`inertSkip`, the `reuseResult` self-check reuse, or an unresolved `!gateBaseMainHead` — reachable via the
`preLanded` capture earlier in the same method, when main's current tip can't be read), and each of them
left the flag at that `false` initialiser — which the `emitCompareReduced`-stamping guards elsewhere in
the method then read as a genuine "a real gate spawned and was PROVEN not reduced" verdict, even though the
predicate was never consulted at all: a fabricated `emitCompareReduced:false`.

The fix flips the default to the UNINFORMATIVE `true` (⇒ omit `emitCompareReduced` downstream): only the
guarded assignments reached exclusively when the predicate actually ran ever set the flag to `false`. Every
guard downstream that reads `emitCompareNotApplicable` to decide whether to report `emitCompareReduced` —
at both the gate-rejection return and the plain-GREEN return in the same method — is correct with no
change to the guard expression itself, because the fix is entirely in the flag's own initial value.

## Do not

- Do not default a flag that means "the predicate said not-applicable" to the informative value (`false`,
  here) — a route that skips the predicate entirely will leave the default in place, and a downstream
  reader has no way to tell "genuinely ran and decided" from "never ran, still at its initialiser". Default
  to the uninformative value instead.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`'s gate-rejection return
(~line 13355), as of this tranche's HEAD, describing the consequence of the fix for that call site. The
fix itself (the flag's own declaration and the three skip routes) lives earlier in the same method
(`let emitCompareNotApplicable = true;`, ~line 11809, "DEFAULT CORRECTED, card 4def0708") — a site still
inline and unresolved as of this tranche, out of this tranche's edited line range. Condensed and reworded,
not verbatim.
