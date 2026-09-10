# e7bcb0df — the discovery walk cannot audit itself: an independent git cross-check, and the underscore rule made path-wide

## Narrative

Found within ~10 minutes of `b122c7d4` merging — not a regression, a residual that card's own DoD had asked for and didn't close.

**GAP 1 — a self-referential check.** `b122c7d4` landed a post-run assertion: every discovered (`HERMETIC`) name must appear in the executed-names set, or the run fails, naming the gap. Sound for what it targets (discovered but never spawned), but `HERMETIC` and `executedNames` both derive from the SAME `walkMjsFiles` call — a file the walk never discovers is missing from BOTH sides and compares EQUAL, so an under-discovering walk runs fewer tests and reports GREEN. Not a regression (the old shallow walk had the same exposure and no check at all) and no known live instance — this card keeps a count equality CHECKED rather than true by luck.

**GAP 2 — the helper rule checked BASENAME only, so an underscored DIRECTORY excluded nothing.** `EXCLUDED_DIR_NAMES` matched exact directory names, and the underscore skip tested only `path.basename(rel)`. A file at `test/_fixtures/x.mjs`: `_fixtures` != `fixtures` so the walk descends in; the basename has no underscore (it's on the directory, never inspected) → candidate; no assertion marker → VIOLATION → exit 1 before spawning a single test → total gate outage. Live near-miss: a worker (card `eb29e410`) created exactly that file, reasoning "the walk is non-recursive" — true when it started, false the moment `b122c7d4` merged minutes earlier. The convention "underscore = not-a-test" is understood by humans as a PATH rule but was implemented as a BASENAME rule. Fix: test the underscore rule against every path segment, not just the basename — a derivation rule, not another hardcoded name added to the static list.

**The omission (Q2) — a check that could be perfect and never run.** Every acceptance step for a cross-check like this tests it in ISOLATION (call the function directly, seed a fault, assert red). Nothing requires proving it is actually WIRED INTO the real gate path — a worker could implement it perfectly, test it thoroughly, and never call it from the `if (isMain)` block. General form: an omission ships green and silent, where a contradiction at least announces itself through the worker. DoD required demonstrating the real `node scripts/test-daemon.mjs` invocation executes the cross-check, not just an isolated call to the function.

**FIX 1 — cross-check against `git ls-files`, three constraints, each from a real hole:**
1. **Anchor the enumeration.** `git ls-files` is cwd-dependent; from a wrong cwd it can return nothing, and an unvalidated empty reference set passes VACUOUSLY (`∅ ⊆ executedNames` is trivially true — both sides "fail" together and the check reports success). This axis already produced a real false catastrophic reading on this project once — a stale `cd`, with `git log` from the same stale cwd corroborating the false reading rather than catching it. Fix: derive the root via `git rev-parse --show-toplevel` and run `git ls-files` with an explicit `cwd` — never `process.cwd()`.
2. **Validate the reference.** A zero-size reference set is a hard error, thrown, never silently treated as "nothing to compare." A floor on the instrument's INPUT, not the measurement — unlike the retracted count-floor idea (which failed because executed-test count doesn't track coverage).
3. **Compare at the raw enumeration layer, before any classification.** Filtering the git reference by the walk's own rules (underscore, excluded dirs, `NOT_HERMETIC`, marker shape) would make it inherit the walk's own classification logic — independence lost again, one layer down. Only TRAVERSAL is cross-checked: does the walk see the same FILES git sees, full stop.

**Blind spot, stated beside the check:** `git ls-files` sees TRACKED files only — a brand-new, never-`git add`-ed test file is invisible to this check. It protects the MERGE criterion (nothing tracked is silently dropped by the walk), not a worker's own local run with a genuinely new, unstaged file. Never read a clean result here as total coverage. Reports both directions, named distinctly: `inGitNotWalked` (git-tracked, walk never saw it — the real GAP-1 class of bug, treated as fatal) and `walkedNotInGit` (walk saw it, git doesn't track it — a normal untracked local-development state, treated as a warning, never a failure).

## Do not

- Do not compare `HERMETIC` against `executedNames` alone as proof discovery is complete — both derive from the same walk and an under-discovering walk compares equal.
- Do not test the underscore-exclusion rule against a file's basename alone — apply it to every path segment, or an underscore-prefixed DIRECTORY excludes nothing.
- Do not accept a cross-check's isolated unit tests as proof it protects the real gate — prove it fires from the real `if (isMain)` invocation path too.
- Do not filter the git reference list by this walk's own classification rules before comparing — that re-shares the walk's own bug at a lower layer.
- Do not let `git ls-files` run against an ambient `process.cwd()` — anchor it via `git rev-parse --show-toplevel`, and treat an empty reference set as a hard error, never a vacuous pass.

## Source

Inline comments in `packages/daemon/scripts/test-daemon.mjs`: the "walk cannot audit itself" paragraph (module header, originally lines 27-32) and the `auditDiscoveryAgainstGit` design-rationale block (originally lines 676-707), as of this tranche's HEAD. Card `eb29e410` is the live GAP-2 near-miss referenced above; see `packages/daemon/test/test-daemon-discovery.mjs` for the acceptance tests.
