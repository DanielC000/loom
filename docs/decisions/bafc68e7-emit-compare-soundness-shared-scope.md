# bafc68e7 — one emit-compare soundness predicate, parameterized by scope

## Narrative

Card `404bfc75` added a transpile-identity check to `deploy-staleness.ts`, duplicating (not importing)
`git/worktrees.ts`'s existing soundness predicate (`emitCompareSoundnessOk`/`walkTsFiles`, `@decision
2154b6ad`) and its transpile helper (`transpileIgnoringCommentsAndWhitespace`) rather than reaching into
`git/worktrees.ts` — a deliberate, correct call at the time: that file is high-blast-radius (it also holds
`STATIC_GUARD_REPO_PATHS` and the reduced-gate path lists) and the worker's authorized lane did not include
it. The two copies had already diverged in scope (deliberately) and, transiently, in catch semantics (a
real fail-open, sent back BLOCKING on `404bfc75` and fixed before this card started — see that card's own
record).

This card moved both the predicate/walker and the transpile helper into one new module,
`packages/daemon/src/emit-compare-soundness.ts`, importable by both `git/worktrees.ts` and
`deploy-staleness.ts` with no import edge between those two files (verified: `deploy-staleness.ts` imports
only `paths.js`, `git/writer.js`, `deploy-packages.js`, and — new, this card — `emit-compare-soundness.js`;
`git/worktrees.ts` does not import `deploy-staleness.ts`).

## Which caller uses which scope and target, and why

| Caller | tsconfigRelPaths | srcDirRelPaths | transpile target(s) |
| --- | --- | --- | --- |
| `git/worktrees.ts` (`computeEmitCompareGate`) | `tsconfig.base.json`, `packages/daemon/tsconfig.json` | `packages/daemon/src` | `ES2022` for a changed `.ts` file (matches `tsconfig.base.json`'s real target, so the emitted syntax shape is representative of what `dist/` ships); `ESNext` for a changed `.mjs` script (a script is never compiled by this repo's tsconfig chain at all — `ES2022` would be unsound there, since it can downlevel syntax the original file never runs through) |
| `deploy-staleness.ts` (`computeAncestorBehaviouralMatch`) | the daemon pair above, **plus** `packages/shared/tsconfig.json` | the daemon dir above, **plus** `packages/shared/src` | `ES2022` (this caller's diff is scoped to `RESTART_RELEVANT_PATHSPECS`, i.e. `packages/daemon/src`/`packages/shared/src` — always real, compiled `.ts`, never a script) |

`deploy-staleness.ts`'s wider scope is **deliberate and unchanged by this card**: its own diff can span
either `packages/daemon/src` or `packages/shared/src` (`RESTART_RELEVANT_PATHSPECS`), unlike
`computeEmitCompareGate`'s daemon-only reduced-gate scope. Both scopes are passed explicitly at each call
site, in an `EmitCompareSoundnessScope` object — never defaulted, since a default is exactly what let the
prior two copies diverge silently.

## The transpile-helper decision — SHARE it, not just the predicate

`deploy-staleness.ts`'s original doc comment justified duplicating `transpileIgnoringCommentsAndWhitespace`
(not just the predicate) on an async-vs-sync ground: "that module's version is private to a much larger,
`async`-shaped, merge-gate-specific function; this module is synchronous throughout." Re-examined against
the real code: the function itself is a **pure, synchronous** transform — `tsModule.transpileModule(...)`
— in both copies. The async-ness the old doc pointed at belongs to the *loader* that produces `tsModule`
(`git/worktrees.ts` uses an async `import("typescript")`; `deploy-staleness.ts` uses a synchronous
`createRequire` load), not to the transpile step itself, and the loader was never the thing being shared.
The two copies' only REAL difference was signature shape: `git/worktrees.ts`'s took an explicit `target`
and returned `{ outputText }`; `deploy-staleness.ts`'s hardcoded `ES2022` and returned a bare `string`.

Decision: share it. `target` is now a required, explicit parameter at every call site (`git/worktrees.ts`
passes `ES2022`/`ESNext` as it already did; `deploy-staleness.ts` now passes `ES2022` explicitly instead of
hardcoding it internally), and every caller destructures `.outputText`. This closes the same
shared-unit-divergence risk on this primitive that motivated consolidating the predicate, at the cost of
one extra explicit argument per call site — no behavior change to either caller.

## ⚠️ CORRECTED (Code Review, same day) — the single-definition guard's own regex needed a reduced-gate seat

`test/emit-compare-soundness-single-definition-guard.mjs` (DoD-5) originally argued it needed no seat on
`CHANGED_TS_TEXT_SCANNER_REPO_PATHS`, on the same "reintroducing a duplicate is itself a behavioural `.ts`
edit, already caught by `computeEmitCompareGate`" ground the STATIC_GUARD_REPO_PATHS doc's shape-(6)
correctly uses for `emit-compare-soundness-guard.mjs`. That ground does NOT transfer: shape (6) works
because the production predicate is RE-CHECKED LIVE inside `computeEmitCompareGate` using the identical
logic the guard re-derives, so anything that breaks one breaks the other identically. This guard's
declaration regex has no such live twin — `computeEmitCompareGate` never re-derives "does exactly one
`function <name>(` exist"; it only proves transpile-identity.

MEASURED (re-verified independently against the real `typescript` package, not merely asserted):
`function walkTsFiles(x)` vs `function walkTsFiles/* c */(x)` transpile BYTE-IDENTICAL under
`removeComments:true` (`computeEmitCompareGate` calls this eligible, reduced-gate), while the guard's
original `\s*\(` regex flips from match to non-match on the exact same edit — the identical hazard
`CHANGED_TS_TEXT_SCANNER_REPO_PATHS`'s own shape-(4) correction already documents for
`loopback-secret.mjs`/`gateway-token.mjs`. Fix: (1) the regex is hardened to tolerate an inline block
comment in the gap between tokens (reduces, does not eliminate, the surface — a multi-line or
nested-comment gap is not attempted); (2) per that list's own doctrine, hardening is never a substitute for
list membership — the guard is now a genuine member of `CHANGED_TS_TEXT_SCANNER_REPO_PATHS`.

**A SECOND, independent comment shape was found (Code Review, same pass) and re-verified independently:** a
BARE `/* ... */` block comment (no per-line `* ` prefix, unlike JSDoc) can carry an interior line reading
`function <name>(...) {...}` at column 0 as ordinary prose — MEASURED (own repro, not the reviewer's):
this hardened regex still matches such a bare-block-comment line, while the identical text inside a
JSDoc-prefixed (`* `-per-line) comment does not. This is a **false POSITIVE** (a spurious extra
"definition"), the mirror image of the false NEGATIVE above. NOT fixed here — deliberately deferred (a
comment-stripping pass, the shape `codescape-supervisor-shutdown-wiring.mjs` already uses, was offered and
would close it) because list membership already closes the actual correctness gap (a real regression is
still caught, at the full gate) and this direction fails SAFE — it can only make an innocent comment-only
diff fail loudly, never mask a real duplicate.

## ⚠️ ALSO CORRECTED (Code Review, same pass) — F2: an empty scope array read as "sound"

`emitCompareSoundnessOk`'s `EmitCompareSoundnessScope` fields are plain `string[]` — the type system cannot
distinguish a real path list from `[]`. MEASURED: `{tsconfigRelPaths:[], srcDirRelPaths:[]}` (and either
array alone empty) returned `true` — an empty scope scans nothing and reports "sound" purely because an
empty loop trivially finds no violation. Fixed: `emitCompareSoundnessOk` now returns `false` immediately if
either array is empty, before doing any I/O. RED-proved via
`test/emit-compare-soundness-empty-scope-guard.mjs`, an INTEGRATION test against the real, built function
(`dist/emit-compare-soundness.js`) — the one test in this card's surface that imports production code
directly rather than re-deriving it, because the property under test is the function's own input-validation
behavior, not its regex/walk logic.

## ⚠️ ALSO CORRECTED (Code Review, same pass) — F3: (F)'s claim over-reached what it actually tests

`test/emit-compare-soundness-guard.mjs`'s (F) control and the file's closing success banner claimed proof
that "the scope parameter itself is load-bearing" and would catch "a caller that silently narrowed its own
scope." MEASURED FALSE for PRODUCTION scope: the guard never reads `emit-compare-soundness.ts`,
`git/worktrees.ts`, or `deploy-staleness.ts` — `DAEMON_SCOPE`/`DAEMON_SHARED_SCOPE` are hand-copied literals
inside the guard itself (stated honestly in the file's own header, then contradicted by (F)'s own comment
and the banner — the qualifier dying in the label, inside one artifact). Corrected: (F) and the banner now
claim only that the scope *parameter* discriminates on a synthetic tree, explicitly disclaiming any proof
about either caller's real scope constant. Reading the real literals is real, separately-carded hardening
(it would itself then need an F1-style reduced-gate list seat) — not done here.

## Do not

- Do not default `EmitCompareSoundnessScope` — see the anchor at the interface's own definition.
- Do not remove `test/emit-compare-soundness-single-definition-guard.mjs` from
  `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` on the belief that hardening its regex made it immune — see the
  correction above; hardening narrows the surface, it does not prove closure.
- Do not remove the empty-array check at the top of `emitCompareSoundnessOk` as "belt and suspenders" — an
  empty `scope` array is the one input the type system cannot rule out, and it is the specific shape this
  module's own motivating defect (a check that returns the success value) took.
- Do not let `git/worktrees.ts` import `deploy-staleness.ts` or vice versa to reach this module — both
  import `emit-compare-soundness.ts` directly, keeping the import graph exactly as flat as before this card.
- Do not widen `git/worktrees.ts`'s scope to daemon+shared, or narrow `deploy-staleness.ts`'s to
  daemon-only, "for consistency" — each scope is a real, load-bearing behavior of its own caller; a scope
  change is a behavior change, not a tidy-up.
- Do not let `test/emit-compare-soundness-guard.mjs` import this module's `emitCompareSoundnessOk` —
  that guard is a deliberate structural RE-DERIVATION (it reads injectable text/fixtures, not a real
  worktree path) so it can exercise the two regexes/walk independently; importing the production function
  would make it pass by construction. See that guard's own header.

## Source

`packages/daemon/src/emit-compare-soundness.ts` (new module, `@decision bafc68e7` + `@decision 2154b6ad`
anchors); call sites in `packages/daemon/src/git/worktrees.ts` (`computeEmitCompareGate`) and
`packages/daemon/src/deploy-staleness.ts` (`computeAncestorBehaviouralMatch`);
`test/emit-compare-soundness-single-definition-guard.mjs`, `test/emit-compare-soundness-empty-scope-guard.mjs`,
and `test/emit-compare-soundness-guard.mjs`'s (E)/(F) sections.
