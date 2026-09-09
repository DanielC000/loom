# 1c0d4aa4 — per-repo inert-prefix re-scan is fail-closed on EXIT CODE, not pattern coverage

## Narrative

`isInertMergeDiff` reports whether every path changed between `baseSha` and `ref` falls under an `INERT_MERGE_PATH_PREFIXES` prefix — a provable property of the changed file SET, not a prediction about test coverage (this is a strict, safe subset of the deferred "scope the gate to the diff" idea, `1055f5e3`, which infers coverage and is NOT what this does). `true` means a merge gate for this diff cannot change any test outcome; `false` means "not proven inert."

FAILS CLOSED on every uncertain case: a git error/timeout, zero changed paths, any path outside the allowlist, or every changed path IS on the allowlist but THIS repo's own corpus (via `repoTreeReferencesInertPrefix`) references the matched prefix, or that scan couldn't confirm otherwise. `INERT_MERGE_PATH_PREFIXES`'s allowlist was only ever measured against LOOM's own corpus, but `isInertMergeDiff` runs for every project this daemon serves — so it re-verifies PER-REPO, at `baseSha`, before trusting the allowlist for a project it was never measured against (both the prefix list and, card `82662e98`, the exact-path list — `escapeEreLiteral`d there since a bare `"README.md"`'s `.` would otherwise over-match).

## `INERT_PREFIX_READ_CALL_NAMES` — reusing `db9b0130`'s measurement, plus a refinement it needed a human for

The SAME read-call names `db9b0130`'s hand-measurement used to prove Loom's corpus never reads `docs/` are reused here to make that measurement PER-REPO — PLUS one refinement the manual measurement's own 2026-08-27 re-verification needed a HUMAN to apply: it found "exactly 2 hits, both `path.join(<tempRepo>, "docs", …)`" and judged them NOT real reads by hand — both are `merge-gate-inert-diff.mjs` assertions against a THROWAWAY git fixture the test builds itself, structurally incapable of being affected by any diff under evaluation. A bare "does 'docs' appear near a read-call" scan can't tell that apart from a genuine read, and measured directly DOES regress Loom's own skip on those 2 lines (`inert-prefix-repo-scan.mjs` scenario (4) pins this).

The fix: require the SAME call to ALSO reference a real-source-tree anchor (`__dirname`, `__filename`, `process.cwd()`, `import.meta.url`, `import.meta.dirname`) in its argument list — a fixture path built from a test-local variable never carries one of these literally. Re-verified after committing: `docs` returns to confirmed absence, `assets` (genuinely anchor-referenced) still returns found. The anchor may appear on EITHER side of the token — `readFileSync(new URL("../docs/x.md", import.meta.url))` puts the token first — so the scan matches `anchor…token` OR `token…anchor`.

## Not a perfect discriminator — three shape gaps, and the axis that matters

Measured: 11 realistic read shapes, 4 matched, 7 missed. The EXIT-CODE axis is fail-closed (any non-confirmed-no-match outcome forces the full gate); the PATTERN-COVERAGE axis is NOT — a miss is indistinguishable from a true absence, so each named gap below is fail-OPEN:
1. **Indirection**: a read anchored through a locally-defined constant on an earlier line (`const ROOT = path.resolve(__dirname, "..")`) is invisible to this single-line scan.
2. **Nested parens in the anchor itself**: `readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "docs", "x.md"))` — the standard ESM `__dirname` replacement — closes three parens between anchor and token; a line-based regex can't cross them. A real parser would be needed (see `computeEmitCompareGate`'s own "hand-rolled scanner" warning for why one isn't attempted here).
3. **Multi-line calls**: `git grep` matches per-line; a prettier-wrapped call split across lines is invisible regardless of pattern.

Accepted deliberately: the alternative (no anchor requirement) is a CONFIRMED false positive against Loom's own corpus; this NARROWS the pre-card gap (100% false-negative for every non-Loom project) without claiming to close it. A confirmed no-match exit code is strong evidence the gate can safely skip, never a guarantee.

## A fourth, whole-language gap (card `0910531e`) — see its own record

All three shape gaps above are occasional misses WITHIN a JS/TS repo. A FOURTH, much larger gap — this scan's vocabulary is ALL JS/TS, so it can never match in a Python/Go/Rust/Ruby repo, making every "no match" there a 100% false confirmed-absence — was found separately and closed by `repoTreeHasJsTsSourceFile`; see [[0910531e-js-ts-applicability-gate-and-git-grep-exit-code-mechanics]] for that gate and for `repoTreeReferencesInertPrefix`'s own exit-code mechanics (`GIT_GREP_NO_MATCH_EXIT_CODE` = 1 is the only outcome treated as confirmed absence).

## Do not

- Do not treat `isInertMergeDiff`'s `true` as a coverage prediction — the deferred `1055f5e3` idea (infers coverage) is a different, NOT-implemented mechanism.
- Do not resolve any uncertain case to `true` — every one fails closed to `false`.
- Do not remove the anchor requirement in the read-call scan — the alternative is a CONFIRMED false positive against Loom's own corpus (2 throwaway-fixture hits).
- Do not read a confirmed no-match exit code as proof of absence — strong evidence only, given the three named shape gaps.
## Consequences

A project other than Loom whose own tests genuinely read a top-level `docs/` (or an exact root file) is protected from a silently-skipped gate — at the cost of a per-merge re-scan, imperfect on three named, accepted, fail-open shape gaps within JS/TS repos.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `isInertMergeDiff`'s own doc comment (~line 2296) and `INERT_PREFIX_READ_CALL_NAMES`'s own doc comment (~line 2362), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
