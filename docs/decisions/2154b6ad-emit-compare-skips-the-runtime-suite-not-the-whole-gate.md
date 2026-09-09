# 2154b6ad — `computeEmitCompareGate`: skip only the RUNTIME SUITE, via isolated transpile comparison

## Narrative

`computeEmitCompareGate` decides whether a merge gate's ~668-test `test:daemon` runtime suite can be SKIPPED for this diff (owner-requested: two comment-only branches burned a full ~15min gate each). Distinct from `isInertMergeDiff`, which proves a diff can skip the gate ENTIRELY: this proves only that the diff's COMPILED BEHAVIOR is unchanged, so `pnpm build` and the static source-text guards still run UNCONDITIONALLY — only the runtime test suite is ever skipped, and only for compiled `.ts`/script `.mjs` paths (proven inert at a different compiler `target`), a changed `test/*.mjs` file, and a changed asset path (widens the run to `ASSET_READING_TEST_REPO_PATHS`, no behavior proof). A path already certified inert is SKIPPED from classification entirely rather than gating (see [[b97f643d-classification-loop-skips-a-provably-inert-path-first]]). Every OTHER path fails this diff closed to the full gate.

## Why not "skip when the diff is comments-only"

Five of the six static guards grep raw FILE CONTENT — e.g. `clock-path-regression-guard.mjs`'s `/Date\.now\(\)/` scan. A comment-only edit CAN flip one: a real owner branch introduced the literal string `Date.now()` inside an explanatory comment. So "comments only" alone is unsafe as a gate-SKIP predicate. This function only ever widens what may be skipped (the runtime suite); the guards always run regardless, making that counterexample STRUCTURALLY impossible here.

## Why not "byte-identical full compiled emit"

Falsified by measurement before being built: `tsconfig.json` never sets `removeComments` — comments are emitted VERBATIM into `dist/**/*.js`. A comment-only diff therefore produces a NON-identical full-program emit — that check would never have fired for the branches that prompted this card. Fixed by transpiling each CHANGED file ALONE with `removeComments:true` forced for this comparison only (never the real `dist/` build) — see `transpileIgnoringCommentsAndWhitespace`.

## A hand-rolled scanner loop is not a safe substitute for `ts.transpileModule`

An earlier draft drove `ts.createScanner` directly in a `while` loop. It DESYNCED on a template literal containing `${...}` interpolation elsewhere in the file — the scanner needs `reScanTemplateToken`/`reScanSlashToken` calls at the right points, and a bare `scan()` loop never makes them. Reproduced: a multi-line JSDoc got silently swallowed into an unrelated template-literal token, so an edit INSIDE that comment flipped the verdict by accident. `transpileModule` uses the real parser and doesn't have this failure mode.

## The soundness precondition, and the type-only-edit non-bug

Comparing each changed file's transpile output IN ISOLATION is only sound if no OTHER file's compiled behavior can depend on a changed file's TYPE-only content. Two known TS mechanisms could break that — `emitDecoratorMetadata` and `const enum` (inlined at every use site program-wide). Neither exists here today, but `emitCompareSoundnessOk` RE-CHECKS BOTH LIVE on every call rather than trusting a comment — a future tsconfig edit or a new `const enum` would otherwise silently reverse this precondition (see `packages/daemon/test/emit-compare-soundness-guard.mjs`).

NOT A BUG: a TYPE-ONLY edit also transpiles identically and is therefore proven eligible too. CORRECT — types are erased before this comparison runs, and `pnpm build` (still unconditional) re-typechecks it.

FAILS CLOSED on every uncertain case: a git error, an unresolvable `typescript` module, any out-of-scope path, any non-`M` status on a compiled file, or a failed soundness precondition all return `eligible:false`.

## `emitCompareSoundnessOk` — checking BOTH tsconfig files in the real `extends` chain

Reads directly off `worktreePath` — a plain filesystem walk, not git; both properties are PROGRAM-WIDE, not diff-scoped. Fails closed to `false` on any read/parse error.

`packages/daemon/tsconfig.json` `extends` `tsconfig.base.json` and carries its OWN `compilerOptions` block — the more natural place to add a daemon-specific option. An earlier version read ONLY the base config, so `emitDecoratorMetadata:true` added to the PACKAGE file would have been invisible: a type-only edit would transpile identically while the REAL emit's metadata silently changed — `eligible:true` on a genuine behavior change. Both files are now checked independently; a third layer, if ever added, must widen this too.

## Do not

- Do not check only `tsconfig.base.json` for the soundness precondition — a daemon-specific compiler option added to `packages/daemon/tsconfig.json` itself would be invisible.
- Do not forget to widen `emitCompareSoundnessOk` if a third config layer is ever added to the daemon's `extends` chain.
- Do not use "comments only" as a gate-SKIP predicate — a real owner branch proved a comment can flip a content-grepping static guard.
- Do not compare full-program compiled emit byte-for-byte — TypeScript emits comments verbatim by default here, so that never fires for a comment-only diff.
- Do not drive `ts.createScanner` in a hand-rolled loop — it desyncs on template-literal interpolation; use `ts.transpileModule`.
- Do not treat a type-only-edit's eligibility as a bug to "fix" — it is correct.

## Consequences

A comment-only or type-only diff to daemon source can skip the ~15min runtime suite while `pnpm build` and every static guard still run unconditionally — without reopening either of two previously-considered, measurement-falsified designs (comments-only skip, full-emit byte comparison).

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `computeEmitCompareGate`'s own doc comment, as of this worktree's pre-extraction HEAD. Wrapped lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
