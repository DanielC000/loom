# 8abf427f — the emit-compare soundness guard now reads the REAL production scope constants

## Narrative

Code Reviewer `110f15dd` (findings F3/F5/F6 on card `bafc68e7`) measured that
`test/emit-compare-soundness-guard.mjs`'s controls do not cover the production predicate at all: with
`DAEMON_SHARED_SCOPE` collapsed to equal `DAEMON_SCOPE` (the exact regression (F) claims to catch), only
ONE check went red — "(F) DISCRIMINATING". Every other section — (A)/(A2)/(B)/both (C) arms/(D)/(E)/all
four (E) arms — stayed green, because none of them ever reads the real `WORKTREES_EMIT_COMPARE_SCOPE`
(`git/worktrees.ts`) or `DEPLOY_STALENESS_EMIT_COMPARE_SCOPE` (`deploy-staleness.ts`) —
`DAEMON_SCOPE`/`DAEMON_SHARED_SCOPE` are hand-copied literals inside the guard itself, and (F) only proves
the *scope parameter* discriminates, never that either caller's *real* scope constant is covered. A
production scope NARROWING was therefore undetectable by this guard.

## The fix — (G)/(H)

(G) reads `WORKTREES_EMIT_COMPARE_SCOPE`/`DEPLOY_STALENESS_EMIT_COMPARE_SCOPE` as TEXT out of the real
`git/worktrees.ts`/`deploy-staleness.ts` source (`extractScopeLiteral`, tolerant of either a bare string
literal or a `path.join(...)` call as an array element — the two shapes the real constants use) and
asserts each still matches this guard's own `DAEMON_SCOPE`/`DAEMON_SHARED_SCOPE` copy. (H) is the negative
control: synthetic source text shaped like the real declaration but missing one path element must be
reported as a mismatch. Still does NOT import `emitCompareSoundnessOk` or the scope constants — same
structural-re-derivation posture the rest of the file commits to (see its own header).

**Why comparison, not re-use:** importing the real constants directly would let an accidental future
import make (G) pass by construction, and would stop testing the LITERAL staying in sync — the actual gap
is "the guard's copy silently drifted," which only a text-level comparison can catch.

## Reduced-gate seat (DoD-2)

(G) reads real `packages/daemon/src/**/*.ts` SOURCE TEXT and pattern-matches it — unlike (A)/(E)'s
const-enum walk (shape (6): re-verified LIVE inside `computeEmitCompareGate` on every reduced-path call,
so it has a live twin to inherit immunity from), nothing in production re-derives "does the hand-copied
scope literal still match the real constant" — no live twin here. `emit-compare-soundness-guard.mjs` is
therefore a genuine member of `CHANGED_TS_TEXT_SCANNER_REPO_PATHS`, the same ground
`emit-compare-soundness-single-definition-guard.mjs` already established for itself (`bafc68e7`'s own
record, "CORRECTED TWICE" section).

## (C)/(D) cleanup (DoD-4)

(C)'s second arm was `check(label, true)` — an unconditional pass, decoration. Deleted, not converted: it
only stated a fact in prose the surrounding comments already state.

(D) asserted `JSON.parse('...').compilerOptions?.emitDecoratorMetadata === true` on an inline object
literal — testing `JSON.parse`/optional-chaining, zero connection to any predicate. Converted to a real
negative control: a synthetic tree whose `tsconfig.base.json` sets `emitDecoratorMetadata:true` now must
make the guard's own re-derived `soundnessOk()` return `false`.

## `walkTsFiles` (DoD-5/DoD-6)

Un-exported from `emit-compare-soundness.ts` (DoD-5): MEASURED no external consumer — both
`git/worktrees.ts` and `deploy-staleness.ts` import only `emitCompareSoundnessOk`,
`transpileIgnoringCommentsAndWhitespace`, and the two types. Its no-try/catch contract (a `readdirSync`
failure must propagate to `emitCompareSoundnessOk`'s own catch) is hazard-specific; exported under this
generic a name it would invite a future caller for whom that throw is a footgun.

DoD-6 asked whether the single-definition guard reserving the bare name `walkTsFiles` repo-wide under
`packages/daemon/src` (an unrelated future module needing a local `function walkTsFiles(` must rename) is
worth narrowing. Decision: leave it. A future rename is cheap; a silently-narrowed single-definition guard
is not, and no other real file today needs distinguishing from a genuine re-duplication.

## Do not

- Do not let `test/emit-compare-soundness-guard.mjs` import `emitCompareSoundnessOk`, the two production
  scope constants, or `extractScopeLiteral`'s inputs from anywhere but real source TEXT.
- Do not remove `emit-compare-soundness-guard.mjs` from `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` on the belief
  that (A)/(E)'s shape-(6) immunity extends to (G) — it does not; (G) has no live twin in production.
- Do not re-add (C)'s deleted decorative arm, or revert (D) to an inline-literal check.
- Do not narrow the single-definition guard's reserved `walkTsFiles` name to a path-scoped exemption
  without re-deriving DoD-6's cost/benefit first.

## Source

`packages/daemon/test/emit-compare-soundness-guard.mjs` ((G)/(H), (C)/(D) cleanup);
`packages/daemon/src/emit-compare-soundness.ts` (`walkTsFiles` un-export);
`packages/daemon/test/emit-compare-soundness-single-definition-guard.mjs` (DoD-6 decision note);
`packages/daemon/src/git/worktrees.ts` (`CHANGED_TS_TEXT_SCANNER_REPO_PATHS` seat + shape-(6) doc update).
