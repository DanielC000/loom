# 0910531e — The JS/TS-applicability gate, and `repoTreeReferencesInertPrefix`'s exit-code mechanics

## Narrative

`repoTreeHasJsTsSourceFile` (Code Review finding on `1c0d4aa4`) checks whether `treeish` in `repoPath` has ANY tracked path ending in a JS/TS source extension (`/\.(?:[cm]?[jt]sx?)$/i`) — i.e. whether the read-call/anchor scan (see [[1c0d4aa4-per-repo-inert-prefix-rescan-is-fail-closed-on-exit-code-not-pattern]]) could EVER match anything in this repo's tracked tree. The scan's vocabulary (`readFileSync`, `__dirname`, `import.meta.url`, …) is JS/TS-only lexically and can never appear in a Python/Go/Rust/Ruby file — so in a repo with ZERO files at these extensions, `git grep`'s "no match" is not evidence of an absence, it's a TAUTOLOGY: the pattern was never capable of matching this repo's corpus regardless of what it actually reads. Reproduced with a paired-language control (identical dependency, differing only in language: a Python project with a real `docs/`-reading test still returned "no match" pre-fix).

This is a DIFFERENT question from "does this repo reference `docs/`" and is checked FIRST, before that grep's result is ever trusted: `false` here means the grep result carries no information, and the caller fails closed exactly as for a git error or timeout. `true` does not assert the repo has NO other languages too (mixed-language repos are common) — only that the scan has SOMETHING to apply to.

Lists the WHOLE tracked tree via `git ls-tree` (no content read, cheap) rather than scoping to the `docs/`-adjacent paths — a project's JS/TS source is typically nowhere near `docs/` (e.g. `src/`), so a scoped check would defeat the applicability test. FAILS CLOSED on any git error/timeout (`applicable:false`); `degradedReason` is set ONLY on that indeterminate path, never on a genuine confirmed-empty result, so the caller can log an ACCURATE diagnostic instead of always claiming "no JS/TS file found."

## `repoTreeReferencesInertPrefix`'s own mechanics

Uses `git grep` directly via `child_process.spawn` (not `simple-git`'s `.raw()`) SPECIFICALLY so the real process exit code is observable: `GIT_GREP_NO_MATCH_EXIT_CODE` (= 1) is the ONLY outcome treated as a confirmed absence — every other outcome (spawn error, non-1 nonzero exit, e.g. a bad `treeish`, or a timeout) resolves `true` ("references it"), forcing the full gate rather than trusting an unproven scan.

Scoped to `treeish` (the diff's own `baseSha`), never the repo's current working tree. On a BLOBLESS PARTIAL CLONE, `git grep <treeish>` is not unconditionally local — it fetches missing blob content from the promisor remote on demand (a missing blob without network access fails with exit 128, which is NOT the no-match code, so it still fails closed).

ANY OUTCOME OTHER THAN A CONFIRMED MATCH (0) OR NO-MATCH (1) IS LOGGED, not just fail-closed silently: fail-closed alone made a degraded outcome (missing `git` on PATH, an unresolvable `baseSha`, a partial-clone fetch failure) indistinguishable from an ordinary gate run, with zero operator signal the mechanism had silently stopped skipping ANYTHING. `console.warn` with the captured stderr tail makes a persistently-broken scan at least visible.

POSITIVE-CONTROLLED by `inert-prefix-repo-scan.mjs` (fires against a fixture built to trip it) and `merge-gate-inert-diff.mjs` scenario (K) (end-to-end: a repo whose own test reads `docs/` still forces the full gate). Both fixtures build their trigger text via string concatenation, never a literal — a literal would match this scan's OWN vocabulary once committed to this repo.

## Do not

- Do not trust ANY "no match" result without first confirming the repo is JS/TS — otherwise every non-JS/TS project gets a 100% false confirmed-absence.
- Do not scope the `git ls-tree` applicability scan to the token's own directory — JS/TS source is typically elsewhere.
- Do not use `simple-git`'s `.raw()` wrapper here — the real exit code must be directly observable.
- Do not build a positive-control fixture's trigger text as a literal string — string-concatenate it, or this scan matches the fixture-construction code itself.

## Consequences

A non-JS/TS project no longer gets a 100%, silent false confirmed-absence from this scan; every degraded outcome is now logged rather than indistinguishable from an ordinary run.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `repoTreeHasJsTsSourceFile`'s own doc comment (~line 2365) and `repoTreeReferencesInertPrefix`'s own doc comment (~line 2430), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
