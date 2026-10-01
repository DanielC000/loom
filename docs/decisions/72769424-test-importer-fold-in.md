# 72769424 — widening the reduced gate to a changed test file's transitive importers

## Narrative

THE GAP: `git/worktrees.ts`'s classification loop treated only underscore-prefixed `test/*.mjs` paths as
non-runnable helpers — every other changed test file was added to `changedTestFiles` (or
`notHermeticExcluded`) on its own, with no notion that another, UNCHANGED test file might import it.
`test/fixed-wait-witness-guard-selftest.mjs` imports 8 functions from
`test/fixed-wait-witness-guard.mjs`; a diff touching only the guard file reduced to
`--only=fixed-wait-witness-guard`, never running the selftest, so an export rename/signature change could
merge green on the reduced gate and only go red on main's next full gate.

THE FIX: `foldInTestImporters` (`git/worktrees.ts`) computes the TRANSITIVE closure of importers of every
already-classified changed test file (`changedTestFiles` + `notHermeticExcluded`), via a real static-
import-graph scan of the whole `packages/daemon/test/**` corpus, and folds qualifying importers into those
same two arrays — no new field, no change to `buildReducedGateCommand` or any canonical merge/landing
function. The scan parses each file with `ts.createSourceFile` + `forEachChild` (a genuine AST walk), never
a hand-rolled regex or `ts.createScanner` loop.

WHY A REAL PARSE, NOT REGEX: measured directly on this repo's own corpus —
`test/codex-real-spawn-lock-membership-guard.mjs` embeds the literal text
`'import { thing } from "./thing.mjs";'` as a synthetic-fixture object-literal VALUE inside a JS object, not
a real import. A regex scan over raw source text cannot tell that apart from a genuine import declaration;
an AST only ever matches an actual `ImportDeclaration`/`ExportDeclaration`/dynamic-`import()` node, so it's
immune to this false-positive class by construction (the same reason `@decision 2154b6ad` already forbids
`ts.createScanner` for the transpile-comparison case — a hand-rolled token scan desyncs on template
literals).

WHY THE WORKTREE'S OWN DISK, NOT `git show ref:path` PER FILE: `ref` is this worktree's own HEAD
(`@decision fe848bfc`), so reading real files off `worktreePath` directly is sound and avoids ~770 separate
`git show` subprocess spawns for a full-corpus scan. This mirrors `loadHarnessSetExport`'s own precedent of
reading worktree files directly rather than paying per-file git-process overhead — but unlike that loader,
this scan never executes worktree code (it's a pure parse of static text), so it needs no child-process/
timeout isolation the way `import()`-ing a worktree module does.

WHY A NON-LITERAL DYNAMIC IMPORT IS NEVER SCOPED TO THE REACHABLE SLICE: a dynamic `import()` call whose
argument is not a plain string literal (a computed/templated specifier) could resolve to ANYTHING at
runtime, including a changed test file — this scan has no way to rule that out (round 3 removed the one
mechanism that ever tried — see below). The unsound shortcut would be to only treat this as a hazard for
files already found reachable from the changed set by the graph walk itself; that's circular — the whole
point of treating it as a hazard is that such a file might NOT be textually/graph-reachable from the
changed set at all (nothing points to it by literal name) and still import the changed file at runtime via
the computed specifier. So the check runs over the WHOLE corpus, unconditionally, whenever an
importer-scan runs at all.

⚠️ CORRECTION (round 2, Code Review): the ORIGINAL version of this paragraph claimed "zero such patterns
exist in the real corpus" — this was FALSE AS WRITTEN. `grep -lP "\bimport\(\s*pathToFileURL" -r
packages/daemon/test --include=*.mjs` finds 24 real files with exactly this shape, and the original code's
response to ANY one of them was to abort the ENTIRE importer-fold-in computation for the WHOLE diff,
corpus-wide, every time — making the test-file arm of the reduced gate permanently dead on this repo's own
corpus, including for the card's own motivating case (a diff touching only
`fixed-wait-witness-guard.mjs`). See "Round 2" below for what shipped instead of a corrected claim about an
empty set that was never empty, and "Round 3" for why that round-2 fix was itself removed.

WHY A DISCOVERED IMPORTER IS STILL CLASSIFIED AGAINST NOT_HERMETIC/EXCLUDED_DIR_NAMES: folding a name
straight into `changedTestFiles` without checking would let a NOT_HERMETIC importer reach
`test:daemon --only=`, which refuses any name outside the discovered hermetic set — exactly the real
`5113c720` merge blocker `@decision 17cd1f30` already fixed for directly-changed files. A discovered
importer gets the identical treatment: NOT_HERMETIC folds into `notHermeticExcluded`; an EXCLUDED_DIR_NAMES
(fixtures/census) or underscore-helper importer is skipped as a run target (the harness never discovers
either on its own anyway) but is still walked as a graph PASS-THROUGH node, so a real test importing a
HELPER that itself imports the changed file is still found, transitively — the shape a bare "who directly
imports this file" check would miss.

WHAT WAS DELIBERATELY NOT DONE: moving `fixed-wait-witness-guard.mjs`'s shared functions into a new
underscore-prefixed module (the card's own "consider... do it only if it's clean" suggestion) was declined.
The general importer-fold-in mechanism already finds the selftest's import of the guard file correctly
without that refactor, and reorganizing a sensitive, heavily-documented guard file that is both an
importable library AND a `STATIC_GUARD_REPO_PATHS` bare-`node`-invoked CLI script would touch
`working-tree-eol-guard.mjs` too (it also imports `listUntrackedTestFiles` from the guard file) for no
behavioral benefit now that the general scan covers this case and any future one shaped like it.

## Round 2 (removed in round 3 — kept here only as history)

A Code Review reproduced a BLOCKING defect in the shipped version of this card: all 24 real
`import(pathToFileURL(X).href)`-shaped files in the corpus hit the single `hasUnresolvedDynamicImport`
branch, and that branch made `foldInTestImporters` return `{ ok: false }` — which `computeEmitCompareGate`
turns into `eligible: false` for the WHOLE diff, unconditionally, the instant ANY one of those 24 files is
parsed (every run — this corpus is scanned in full whenever at least one test file is in the diff). The
test-file arm of the reduced gate was therefore dead on arrival on this repo's own corpus, including for
the card's own motivating `fixed-wait-witness-guard.mjs` case.

Round 2 shipped two independent fixes: (2a) a hand-rolled AST classifier
(`canProveDynamicImportOutsideTestDir`/`analyzeStaticPathExpr`/`findSingleConstVariableInitializer`/
`fileImportsPathToFileURLFromNodeUrl`) that recognized the exact `pathToFileURL(X).href` shape and tried to
PROVE the resolved path falls outside `test/` via a bounded (12-hop) identifier/path-segment chase — a
single-declaration, **`const`-only** local-identifier resolution, deliberately never trusting a `let`/`var`
or an ambiguous name; and (2b) making a file whose dynamic import still can't be ruled out a WILDCARD
IMPORTER instead of a corpus-wide abort — seeded into the importer-graph BFS as if it already imports
something in `roots`, so the file (and anyone who transitively imports it) is still pulled into the run set
without aborting the whole diff's reduction. (2a) is GONE as of round 3 (see below); (2b) — the wildcard
mechanics themselves — is UNCHANGED and is what the code does today for every non-literal dynamic import,
unconditionally. Round 2 also fixed a third, independent gap: a `"D"`-status (deleted) test path used to be
dropped on the floor by the classification loop instead of being seeded into `foldInTestImporters`'s graph
as a `deletedTestFiles` root — an import edge is purely TEXTUAL (an importer's own `import "./foo.mjs"`
line doesn't care whether `foo.mjs` still exists on disk), so a diff that deletes `foo.mjs` while modifying
some unrelated `bar.mjs` used to leave any unchanged test still importing `./foo.mjs` un-widened-to. This
fix is also UNCHANGED by round 3.

## Round 3: the classifier itself produced two more false-SAFE bugs — removed rather than patched a third time

A fresh review reproduced two further false-SAFE defects in (2a), on top of the ones it was built to fix:

1. **Shadowing.** The const-only shadow check ignored a parameter, `let`, `var`, `catch`, function/class,
   or import binding of the same name. `const target = …dist…; async function load(target) { return
   import(pathToFileURL(target).href); }` and a block-scoped `let target` shadow both classified SAFE, yet
   at runtime they import whatever the shadowing binding actually holds — which could be the changed test
   file. `path`/`pathToFileURL`/`fileURLToPath` were also matched by identifier TEXT alone, with no check
   that the name wasn't itself shadowed or rebound.
2. **Case.** `!segments.includes("test")` was case-sensitive: `path.join(__dirname, "..", "TEST",
   "guard7.mjs")` classified SAFE and would load `test/guard7.mjs` on Windows — which is the gate host.

A false-SAFE classification here is a silent-merge-then-red-main bug of the exact shape this whole card
exists to close — the classifier's entire JOB was to rule out a hazard, so every new false-SAFE bug it
grows is strictly worse than having no classifier at all, which merely keeps the file a wildcard.

DECISION: do not patch the classifier a third time. REMOVE (2a) entirely — the hand-rolled JS binding
resolver that each review round finds another hole in. Every test-corpus file containing a dynamic
`import()` whose argument is not a plain string literal is now a WILDCARD IMPORTER, UNCONDITIONALLY — folded
in exactly the way (2b) already folds in an unclassifiable file (seeded into `visited`/`queue`, never
`roots`; still walked through NOT_HERMETIC/EXCLUDED_DIR_NAMES classification like any other discovered
importer). It's sound by construction — there is nothing left to prove wrong — at the cost only of extra
`--only=` entries on a diff that touches a test file, never a correctness risk.

DELETED: `canProveDynamicImportOutsideTestDir`, `analyzeStaticPathExpr`, `findSingleConstVariableInitializer`,
`fileImportsPathToFileURLFromNodeUrl`, their supporting types (`StaticPathSegments`,
`TsPropertyAccessNodeLike`, `TsVariableDeclarationNodeLike`, `TsVariableDeclarationListNodeLike`,
`TsImportDeclNodeLike`), the `PATH_EXPR_RESOLVE_MAX_DEPTH`/`TS_NODE_FLAG_CONST` constants, and the three
`TestImportTsModuleLike` interface members (`isPropertyAccessExpression`/`isVariableDeclaration`/
`isIdentifier`) added only to support them — plus their dedicated test scenario. `extractModuleSpecifiers`
now sets `hasUnresolvedDynamicImport` for ANY non-string-literal dynamic import argument, with no
classification call at all.

KEPT, unchanged by this round: the `deletedTestFiles` graph-seeding (2, round 2 above), the wildcard
mechanics (2b, round 2 above), and fail-closed behavior on an unreadable test directory or an unresolvable
`typescript` module.

The test file's former "AST CLASSIFICATION" scenario (proving the common shape contributes no hazard) is
replaced with scenarios proving every shape that used to fool the classifier — a shadowed parameter, a
shadowed block-scoped `let`, an uppercase `"TEST"` segment, and a path built with no `__dirname` anchor at
all (so it would actually resolve relative to the RUNTIME cwd, not this file's location, even where its
literal segments alone looked resolvable) — now simply fold in like any other wildcard. Its negative control
(a literal dynamic import argument should never be treated as a wildcard) was also corrected: the prior
version had the literal importer import the CHANGED file directly, so it was folded in via the ordinary
literal-specifier graph edge regardless of any wildcard logic — proving nothing about wildcard-vs-literal
discrimination specifically. The corrected control has the literal importer name a DIFFERENT, unchanged
file, and asserts it is NOT folded in.

## Round 4: two defects a fresh Code Review reproduced in the round-3 shipped code — a host event-loop
freeze (Critical, fixed by moving the scan to a child process — see its own sub-section below), and a false
"the spawn residual is just one instance" claim in this file's own prior text (corrected just below)

### Round 4, defect 2: a false "spawn residual is just one instance" claim in this file's own round-3 text

KNOWN RESIDUAL THROUGH ROUND 3, PARTIALLY CLOSED round 4 — SUBPROCESS-SPAWN DEPENDENCY FORMS WERE INVISIBLE
TO THIS SCAN THROUGH ROUND 3: the importer-graph only ever followed `import`/`export ... from`/dynamic-
`import()` edges — never a test that `spawn()`s/`execFileSync()`s another test file as a CHILD PROCESS.

⚠️ CORRECTION (round 4, Code Review, reviewer 6ae38be6): round 3's text here claimed "Exactly ONE real
subprocess-spawn instance" and "zero `readFileSync`-of-a-sibling-`test/*.mjs`-file instances exist" — BOTH
FALSE AS WRITTEN. The real corpus has at least FIVE real spawn-another-test-file specimens, not one:
`real-homedir-transcript-leak-isolation.mjs` (spawns `companion-memory-recall.mjs`,
`resume-already-live-guard.mjs`, `periodic-snapshot.mjs`, `shutdown-snapshot.mjs`, each via a literal
`file:` property on a `TARGETS` array), `engine-session-rotation-isolation.mjs` (spawns
`engine-session-rotation.mjs` via a literal path-joined filename), `field-consumer-guard-warnings-surface.mjs`
(spawns `profile-field-consumer-guard.mjs` both directly and via a `--only=profile-field-consumer-guard`
harness-selector literal), `guard-exit-hook-loom-home-scope.mjs` (spawns `human-only-surface-leak-guard.mjs`
via a literal path-joined filename), and `test-daemon-failures-epilogue-flush.mjs` (spawns
`epilogue-flush-fixture.mjs` both via a `--only=epilogue-flush-fixture` literal and directly). And
`fixed-wait-negative-guard.mjs` and `clock-path-regression-guard.mjs` DO `readFileSync()` sibling
`test/*.mjs` file content (to scan it for fixed-wait/`Date.now()` idioms) — harmlessly, because both are
already in `STATIC_GUARD_REPO_PATHS` and so already run unconditionally on every reduced-gate pass,
regardless of what this scan does or doesn't widen to.

THE FIX (round 4): `findSpawnTargetEdges` (`git/worktrees.ts`) adds a CONSERVATIVE, over-inclusive TEXTUAL
edge for exactly this gap — every string literal {@link extractModuleSpecifiers} finds ANYWHERE in a file
(not just an import specifier; bounded to `SPAWN_EDGE_MAX_LITERAL_LEN` characters) is checked against two
shapes: the literal contains another corpus file's full basename (`name.mjs`) anywhere in it (a bare
filename, a path, or a longer string that embeds it — the shape 4 of the 5 real specimens use), or the
literal is a `--only=<stem>[,<stem>...]` harness-selector argument naming another corpus file's bare stem
(the shape 2 of the 5 use). This is deliberately a STRING-LITERAL match, never a regex over raw text — the
literals themselves are still collected via the real AST walk, so `codex-real-spawn-lock-membership-guard.mjs`'s
own fake-import-text-as-object-value specimen is handled the same correct way the import-specifier scan
already handles it (a literal INSIDE a string value is still just a string value, never mistaken for a real
import). Verified against the real corpus: re-running test scenario (H) (touching only
`fixed-wait-witness-guard.mjs`) with this fix finds 2 MORE real importers beyond the round-3 count (51 vs
49) — `cli-stop-cmdshim-separator.mjs` (names `cli-stop-pid-identity.mjs`, itself already in the visited
set, inside a human-readable skip message) and `prod-guard-structural.mjs` (names its own
`fixtures/_bare-default-db-open.mjs` spawn fixture, a SIXTH real specimen this round's own testing turned
up beyond the 5 the triggering review named) — both confirmed by temporarily disabling just this one
mechanism, rebuilding, and observing the count drop back to exactly 49.

STILL A RESIDUAL, deliberately: a target file name reached only via `eval(...)`/`new Function(...)`-
constructed source, or a `require(...)`/`createRequire(...)` resolution, has no AST-visible string literal
naming the target the way a plain string argument does — see {@link extractModuleSpecifiers}'s own doc.
Generalizing further than "every string literal in the file" is a new, open-ended detection problem with
its own long tail of soundness questions, not a cheap extension of this fix.

### Round 4, defect 1 (Critical): the scan was blocking the HOST EVENT LOOP, not just "costing suite time" — moved to a child process

A fresh Code Review reproduced a BLOCKING Critical defect in `foldInTestImporters` as shipped through round
3: `listAllTestMjsFilesRelative` (`fs.readdirSync`, recursive), `fs.readFileSync` of every corpus file, and
`ts.createSourceFile`/`forEachChild` (a genuine, non-trivial AST walk) all ran SYNCHRONOUSLY, in a single
`for` loop with no `await`, directly on the daemon's own event loop — not merely "slow", but a real,
measured EVENT-LOOP GAP for the whole scan's duration, during which every project's HTTP/WS/MCP/PTY traffic
on the shared daemon process was frozen. This is categorically different from — and was previously
mis-stated as — "a small fraction of the full suite's own runtime" (the framing round 2/3 used above): suite
RUNTIME is a cost paid by the gate process; an EVENT-LOOP FREEZE is a cost paid by every OTHER tenant of the
same daemon, including ones with nothing to do with this merge.

MEASURED, with a `setInterval` probe ticking every 20ms concurrently with a real `computeEmitCompareGate`
call against this repo's own real 1324-file corpus (test scenario (I), `node:perf_hooks`'
`performance.now()` around each tick): pre-fix, max observed gap between probe ticks was **~6.0s** (a
single local run, Windows, Node 22 — essentially the WHOLE scan's wall-clock duration, confirming the
freeze was total, not partial). The scan itself took ~9.1–10.4s wall-clock across several local runs
(`Date.now()`/`performance.now()` around the call) — ~3.7% of the 1324-file corpus by population, but 100%
of that time was an unresponsive daemon, not merely "part of a ~16-minute suite" as the prior framing here
implied.

THE FIX: the CPU-bound half of the scan (file listing, reading, AST parsing, edge-building, and the BFS —
everything `scanTestImporterClosure` now does) runs in a KILLABLE CHILD PROCESS
(`scanTestImporterClosureInChildProcess`), re-importing THIS SAME compiled module (`import.meta.url`, never
a worktree's copy — the scan LOGIC stays the host's trusted code; only `testDirAbs`, the DATA it reads,
points into the worktree under test) via `node --input-type=module -e`, the same isolation shape
{@link loadHarnessSetExport} already established for the harness-config loads (`@decision fca110cf`). Bound
by `TEST_IMPORTER_SCAN_TIMEOUT_MS` (120s); any mechanism failure (spawn error, timeout-kill, non-zero exit,
unparsable output) fails the whole diff closed to the full gate, same as every other mechanism failure this
function already handled. `foldInTestImporters` itself now only does the (small, ~50-entry)
NOT_HERMETIC/EXCLUDED_DIR_NAMES classification loop over the child's `visited` result, in-process — cheap,
since it's over the DISCOVERED IMPORTER set, never the whole corpus.

MEASURED POST-FIX: the same probe against the same real corpus observed a max gap of **~44–52ms** (several
local runs) — the daemon's event loop stays responsive throughout. The scan's own wall-clock cost actually
ROSE to ~15–19s (child-process spawn + re-importing the daemon's own module graph in a fresh process adds
real overhead on top of the parse itself) — a DELIBERATE trade: this round's fix is for the BLOCKING
property, not for wall-clock speed, and a slower-but-non-blocking scan is strictly preferable to a
faster-but-freezing one for a shared daemon process. See test scenario (I) for the live measurement, logged
on every run rather than trusting a number restated here.

## Do not

- Do not scope treating a non-literal dynamic import as a hazard to only files reachable from the changed
  set by the graph walk — see the circularity argument above; it must stay corpus-wide.
- Do not fold a discovered importer (textually-found OR wildcard) into `changedTestFiles` without first
  classifying it against NOT_HERMETIC/EXCLUDED_DIR_NAMES exactly like a directly-changed path —
  `test:daemon --only=` refuses any NOT_HERMETIC name outright, and the full gate never runs an
  EXCLUDED_DIR_NAMES/underscore-helper file either.
- Do not replace the AST-based scan (`ts.createSourceFile`/`forEachChild`) with a regex — this repo's own
  corpus contains a real string-literal false positive for exactly that approach
  (`codex-real-spawn-lock-membership-guard.mjs`).
- Do not read test-file content via `git show ref:path` per file as "more correct" — `ref` is this
  worktree's own HEAD by construction (`@decision fe848bfc`), so reading disk directly is sound and avoids
  hundreds of subprocess spawns.
- Do not make `foldInTestImporters` abort the whole diff again just because a file's dynamic import is
  non-literal — seed it as a wildcard importer into `visited`/`queue` instead (never into `roots`, which
  would skip its own NOT_HERMETIC/EXCLUDED_DIR_NAMES classification). Aborting is exactly the defect round 2
  closed: it made the test-file arm of the reduction permanently dead on this repo's own corpus.
- Do not drop a `"D"`-status (deleted) test path from `foldInTestImporters`'s graph seeds — an import edge
  is purely textual and doesn't care whether the target still exists on disk; see (G) in the test file for
  the reproduced RED case this closes.
- Do not generalize this scan to `eval(...)`/`new Function(...)`-constructed source or a
  `require(...)`/`createRequire(...)` resolution without re-reading the "STILL A RESIDUAL" paragraph above
  first — that remains a materially different, open-ended detection problem. (Round 4 DID generalize to the
  subprocess-spawn case itself, via the conservative string-literal match in `findSpawnTargetEdges` — this
  bullet is about what's STILL left out, not a blanket "never touch subprocess spawn".)
- **Do not reintroduce a per-file AST classifier that tries to PROVE a non-literal dynamic import resolves
  outside `test/`.** Round 2's version was patched once for a correctness gap and still shipped two more
  false-SAFE bugs on the very next review (shadowing, case-sensitivity) — a false SAFE here is strictly
  worse than treating the file as an unconditional wildcard, since the classifier's only job is to rule out
  a hazard and a wrong "safe" verdict is silent until main goes red. If the wildcard population ever grows
  large enough that the reduction stops being worth it, re-measure (test scenario (H) logs the live
  population on every run) and raise it as a real finding — don't reach for classification to shrink the
  number back down.
- **Do not call `scanTestImporterClosure` from the host's own event loop again.** That is the exact round-4
  blocking defect — see "Round 4" above. It is exported ONLY so the child process spawned by
  `scanTestImporterClosureInChildProcess` can `import()` and call it; never add a second, in-process caller.
- Do not narrow `findSpawnTargetEdges`'s match to "literal must sit in a call-argument position" — a real
  specimen (`real-homedir-transcript-leak-isolation.mjs`) names its spawn target inside an object property
  value, not a call argument; the match must stay "any string literal anywhere in the file".

## Consequences

A diff touching only a test file that other test files import now correctly widens the reduced gate's
`--only=` set to include those importers, closing the exact silent-merge-then-red-main gap
`fixed-wait-witness-guard-selftest.mjs` demonstrated. The cost is one full-corpus parse of
`packages/daemon/test/**/*.mjs` (via `typescript`), run in a CHILD PROCESS (round 4 — see above, never on
the host's own event loop) whenever at least one test-shaped path (changed or deleted) is in the diff —
wall-clock ~15–19s post-round-4 on the real 1324-file corpus (up from ~9.4s pre-round-4: child-process
spawn overhead), but with the host daemon's event loop staying responsive throughout (max observed gap
~44–52ms, down from a ~6.0s FULL FREEZE pre-round-4) — the trade this round made deliberately, for a shared
daemon process where "blocks every other tenant's HTTP/WS/MCP/PTY traffic for ~6-9s" is a materially worse
cost than "this one gate's own classification step takes several extra seconds."

The reduction is no longer permanently dead on this repo's own corpus (round 2), and a
deletion-plus-unrelated-edit diff correctly finds the deleted file's own importers too (round 2). As of
round 3, every real `pathToFileURL(X).href`-shaped file in the corpus (and anything that transitively
imports one) is an unconditional wildcard rather than 22-of-24 being classified away. As of round 4, a file
that SPAWNS another corpus file as a child process (never `import`s it) is also found, via a conservative
textual literal match — measured at 51 files of 1324 for the card's own motivating diff (up from 49 in
round 3: 2 more real spawn-adjacent importers found), still a small fraction of the corpus and well below
the point where the reduction would stop being worth it, in exchange for a scan that can no longer be
fooled by a shadowed identifier, a case mismatch, or a spawned-rather-than-imported dependency.

## Source

New code in `packages/daemon/src/git/worktrees.ts` (card `72769424`), not an extraction from a prior inline
comment.
