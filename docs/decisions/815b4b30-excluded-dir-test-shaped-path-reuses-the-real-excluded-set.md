# 815b4b30 — An excluded-dir path isn't a test at all; reuse the REAL `EXCLUDED_DIR_NAMES`, never a copy

## Narrative

A path sitting inside an `EXCLUDED_DIR_NAMES` subtree (`fixtures/`, `census/`) is, by construction, not a test at all in `computeEmitCompareGate`'s classification loop — `scripts/test-daemon.mjs`'s own discovery walk never descends into either directory, so the full suite never runs it either. Checked FIRST, before the underscore/shell-safety checks that follow: those two checks exist only to protect what `buildReducedGateCommand` is about to interpolate into a shell-executed `&&` chain, and an excluded-dir path is never going to reach that chain at all, so subjecting it to those checks could only ever produce a spurious `notEligible` for a file this function is about to skip anyway.

REUSE, not reimplementation: two independent notions of "is this a test" is exactly the shared-unit divergence that produced this bug (a fixture/census path was treated as a real test here while `test-daemon.mjs`'s own walk already excluded it) — so this loads the REAL `EXCLUDED_DIR_NAMES` Set by dynamically importing THIS DIFF'S OWN worktree copy of `scripts/test-daemon.mjs` (`loadExcludedTestDirNames`), never a hand-copied second list. `loom:not-a-test:`/`loom:gate-exempt:` markers are NOT re-checked here: both only change how the full-suite banner ANNOTATES a file already inside an excluded dir — neither makes the full suite actually RUN it, so neither carries information for this decision.

Once a path is recognized as excluded-dir, card `44968963` takes over: a fixture/census file's OTHER consumers can sit anywhere else in `test/**`, entirely outside this diff, and this function has no sound way to enumerate them (see [[44968963-any-excluded-dir-touch-fails-closed-no-fixture-consumer-resolver]] for why a consumer-resolver was rejected) — so ANY changed path landing here fails the WHOLE diff closed to the full gate immediately, rather than being silently dropped from consideration the way it was before that card. This is strictly narrower than before: it can only ever turn a past `eligible:true` into `eligible:false`, never the reverse.

## `loadExcludedTestDirNames` — loading the real set, from the diff's OWN worktree

`loadExcludedTestDirNames` loads the REAL `EXCLUDED_DIR_NAMES` Set from `scripts/test-daemon.mjs` — dynamically imported from `worktreePath` itself (the diff's OWN checked-out copy), not this daemon process's own installed copy: a future edit to the script must be seen immediately, not after a daemon restart. `test-daemon.mjs` is deliberately import-safe for exactly this ("an out-of-band harness ... needs to import this file's export without ALSO triggering a full run as a side effect").

FAILS CLOSED to `null` on any error — an unreadable/unparseable script, a missing `scripts/` directory (never shipped in the packaged `loomctl` npm install), or an export that isn't a `Set`. Never resolve ambiguity to an empty-but-truthy Set — a caller getting `null` MUST fail the whole diff closed, exactly like the `typescript`-unresolvable case.

On Windows, dynamic `import()` needs a `file://` URL, never a bare drive-letter path (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) — same caveat `test/census/lib.mjs`'s own import already documents; `pathToFileURL(scriptPath).href` handles this.

`loadNotHermeticNames` (card `17cd1f30`) applies the identical pattern to the harness's OTHER driftable name set, `NOT_HERMETIC` — loaded from the same diff-local worktree copy, same fail-closed-to-`null` contract.

## Do not

- Do not hand-copy `EXCLUDED_DIR_NAMES` (or a second notion of "is this a test") for this classification loop — dynamically import the diff's own `scripts/test-daemon.mjs` copy via `loadExcludedTestDirNames`; a hand-copied second list is exactly the divergence that produced the original bug.
- Do not re-check `loom:not-a-test:`/`loom:gate-exempt:` markers here — they only affect the full-suite banner's annotation, never whether a file actually runs, so they carry no information for this reduced-gate decision.
- Do not run the underscore/shell-safety checks against an excluded-dir path before this check — that path never reaches the shell-interpolated chain those checks protect, so running them first could only produce a spurious refusal.
- Do not read `EXCLUDED_DIR_NAMES`/`NOT_HERMETIC` from this daemon process's own installed copy of `test-daemon.mjs` — always import from the diff's OWN `worktreePath` checkout, so a future edit to either set is seen immediately, not after a daemon restart.
- Do not resolve a `loadExcludedTestDirNames`/`loadNotHermeticNames` failure (missing script, unparseable, non-`Set` export) to an empty-but-truthy Set — a caller getting `null` must fail the whole diff closed.
- Do not pass a bare drive-letter path to dynamic `import()` on Windows — use `pathToFileURL(scriptPath).href`, or it throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`.

## Consequences

An excluded-dir path is recognized as "not a real test" using the SAME set the full suite's own discovery walk uses, closing the shared-unit divergence that let a fixture/census path be misclassified as a real test here — and, per card `44968963`, any such path now fails the whole diff closed rather than being silently dropped.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `computeEmitCompareGate`'s classification loop, at the `EMIT_COMPARE_TEST_PREFIX` excluded-dir check (~line 3005), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
