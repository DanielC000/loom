# 44968963 — Any excluded-dir (fixture) touch fails the whole diff closed; no consumer-resolving heuristic

## Narrative

ANY EXCLUDED-DIR (`fixtures/`, `census/`) TOUCH FAILS THIS DIFF CLOSED — card `44968963`, the decision between two candidates. Card `815b4b30` stopped a `fixtures/`/`census/` path from being pushed into `EmitCompareGateResult.changedTestFiles` and run AS a test — correct, since the full suite's own discovery walk never descends there either. But that fix left a gap: a diff changing a shared fixture PLUS one of its consumer test files still reached `eligible:true` (the consumer alone proves eligibility), running only that one consumer while the fixture's OTHER consumers — outside the diff, unrun by either gate — could equally have broken. Measured on this repo (card `44968963` DoD-1): `fake-codescape-cli.mjs` has 6 consumers, `echo-env.mjs` has 3 — this is a real, reachable exposure, not a hypothetical one.

## The rejected candidate: resolve a fixture's consumers

The candidate that would have PRESERVED speed here — resolve a changed fixture's consumers and fold them into `changedTestFiles` — was rejected. Every real consumer in this repo names its fixture the same way: `path.join(__dirname, "fixtures", "<literal-basename>.mjs")` — a computed path, not an `import`, so a resolver can only ever be a TEXTUAL heuristic (grep the fixture's basename across `test/**`), never a structural one. That heuristic happens to find all of today's consumers, but "happened to find them all" is exactly the standard this card's own DoD-3 rules out (a guessed resolver that misses a consumer is WORSE than always running the full gate, because a clean `eligible:true` LOOKS precise while silently proving nothing for the consumer it missed) — and nothing stops a future test file from referencing a fixture through a shared constant, a computed/interpolated name, or an indirection this repo doesn't use today, none of which a basename grep would ever see. There is no way to PROVE such a resolver cannot miss a consumer, only ways to observe that it hasn't yet — so it fails the same asymmetry as everything else in this file: a wrong skip is a bad merge, a wrong full-run is minutes. Unconditionally failing closed the moment ANY excluded-dir path changes needs no resolver to trust, so it cannot have this failure mode.

## The accepted cost

This also forces the full gate for the previously-reduced case where a fixture change ships alongside a real test file change that has nothing to do with the fixture (`test/emit-compare-gate-scope.mjs` case (J) — see that test's own updated expectation). That diff shape is not provably safe to reduce without exactly the resolver this decision rejects, so the regression is accepted, not overlooked.

## Do not

- Do not build a textual (basename-grep) fixture-consumer resolver to preserve the reduced-gate speed for a mixed fixture+consumer diff — it can only ever observe that it hasn't missed a consumer yet, never prove it, and a wrong skip is a bad merge while a wrong full-run only costs minutes.
- Do not treat the forced full-gate on a fixture-plus-unrelated-test-file diff as a regression to fix — it is an accepted, named cost of closing the real, measured exposure (6 and 3 consumers respectively for two fixtures on this repo).

## Consequences

A diff touching any `fixtures/`/`census/` path always runs the full gate, closing a real exposure where a shared fixture's other consumers (outside the diff) could break silently — at the cost of the previously-reduced case where a fixture change ships alongside an unrelated test file change.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `computeEmitCompareGate`'s own doc comment (~line 2983, excluded-dir section), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
