# 18bfe989 — an undefined transpile target is now a compile error, not a silent ES5 fallback

## Narrative

Code Reviewer `110f15dd`, finding F4 on card `bafc68e7`, spotted a two-path asymmetry: `deploy-staleness.ts`'s `loadTypeScriptSync` validates the resolved `typescript` module's surface before trusting its cast, while `git/worktrees.ts`'s `computeEmitCompareGate` casts `imported.default ?? imported` straight to `TypeScriptModuleLike` with no such check. `target` was typed `unknown`, so an explicit `undefined` (a `ScriptTarget.ES2022`/`.ESNext` lookup that missed) would satisfy the type and reach `tsModule.transpileModule` unguarded.

MEASURED (reviewer, `typescript` 5.9.3): `transpileModule` with `target: undefined` does not throw or warn under the diagnostics options this code uses — it silently fixes up to `ES5`. `export class C { x = 1; }` and `export class C { x: number; constructor() { this.x = 1; } }` transpile byte-identical at `ES5` and differ at `ES2022`/`ESNext` (`useDefineForClassFields`). A real behavioural change could therefore read transpile-identical and `computeEmitCompareGate` would reduce a gate that should have run in full — a fail-open returning the success value, the same shape as the `404bfc75` fail-open that created `bafc68e7`.

Reachability is low (needs a resolved `typescript` missing `ScriptTarget.ES2022`/`.ESNext`, unrealistic with a pinned devDependency), but `computeEmitCompareGate` already anticipates non-standard resolution via its `notApplicableHere("typescript module not resolvable …")` branch. Worth closing because the fix is free, not because the failure is likely.

## The fix — narrow the types, not a runtime check

`emit-compare-soundness.ts`'s shared `TypeScriptModuleLike.ScriptTarget` is now `Record<string, number>` (was `Record<string, unknown>`), and `target` is now `number` (was `unknown`). This repo's `noUncheckedIndexedAccess: true` then types `mod.ScriptTarget.ES2022`/`.ESNext` as `number | undefined` at both call sites, forcing each to narrow away `undefined` before it can reach `target: number` — MEASURED: reverting either type back to `unknown` reproduces exactly `TS2345: Argument of type 'number | undefined' is not assignable to parameter of type 'number'` at both call sites. Zero runtime cost, no second validator to keep in sync with `deploy-staleness.ts`'s existing one.

## Where each caller narrows, and what it does on a miss

- `deploy-staleness.ts`'s `computeAncestorBehaviouralMatch`: right after `loadTypeScriptSync()` returns non-null, reads `ScriptTarget.ES2022` into `es2022Target`, returns `null` (this function's own fail-closed value) if `undefined`, before either transpile call.
- `git/worktrees.ts`'s `computeEmitCompareGate`: narrows `ES2022`/`ESNext` right before the `.ts`/`.mjs` loops respectively (per-loop, so a diff touching only one file kind doesn't fail on the other target being absent). A miss returns `notApplicableHere(reason, "typescript-unresolvable")` — the same category used for "typescript module not resolvable". Never `notReducible`, never `eligible:true`.

## DoD-3 — does `loadTypeScriptSync`'s validation become redundant?

No. Its `"ES2022" in mod.ScriptTarget` check is now partially redundant with the new explicit narrow right after it — but it still does real, otherwise-unguarded work: `typeof mod?.transpileModule !== "function"`, `typeof mod.ScriptTarget !== "object" || mod.ScriptTarget === null` (absent/null at runtime regardless of declared type), and `"NodeNext" in mod.ModuleKind` (`ModuleKind` was deliberately left `Record<string, unknown>` — the DoD asked for narrowing `ScriptTarget`/`target`, not `ModuleKind`). None of this disappears with the type change.

## Test — `test/emit-compare-transpile-target-narrowing.mjs`

A test asserting the types compile today isn't RED-provable — a compile error is the mechanism, not something `pnpm build` re-derives. The file checks: (1) a source-text scan confirming `ScriptTarget: Record<string, number>` and `target: number,` are still declared — RED-proved by reverting the source to the pre-fix shape (fails) and restoring (passes); (2) a behavioural reproduction, against the real built function + real `typescript` devDependency, of the reviewer's fixture pair: byte-identical at `target: undefined` (plain JS can pass `undefined` at runtime where the type system would refuse it at compile time) and byte-different at the real `ES2022` target.

Added to `CHANGED_TS_TEXT_SCANNER_REPO_PATHS`: checks (A)/(B) raw-scan real pre-compile `.ts` source (never `dist/**`) for a presence-only real-code-token match — the same shape `gateway-token.mjs`/`loopback-secret.mjs` occupy, more exposed to a comment-only diff (no tsc-emit reprint step at all).

## Do not

- Do not widen `ScriptTarget` back to `Record<string, unknown>`, or `target` back to `unknown` — either alone reopens the hole this card closes.
- Do not remove either call site's `=== undefined` narrow as "the type already guarantees it" — the type guarantees the opposite: `noUncheckedIndexedAccess` is what makes the lookup `number | undefined`, and the narrow is what turns that into a fail-closed runtime branch instead of a compile error.
- Do not delete `loadTypeScriptSync`'s runtime validation believing the type narrowing supersedes it — see DoD-3 above; it still guards `transpileModule` being a function and `ModuleKind.NodeNext`.
- Do not remove `test/emit-compare-transpile-target-narrowing.mjs` from `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` — its (A)/(B) checks read real pre-compile `.ts` source with no comment-stripping, so a comment-only diff can flip them as readily as it can flip `gateway-token.mjs`.

## Source

`packages/daemon/src/emit-compare-soundness.ts`; call sites in `deploy-staleness.ts` (`computeAncestorBehaviouralMatch`) and `git/worktrees.ts` (`computeEmitCompareGate`); `packages/daemon/test/emit-compare-transpile-target-narrowing.mjs`.
