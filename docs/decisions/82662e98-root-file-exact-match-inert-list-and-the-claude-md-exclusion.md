# 82662e98 — Root-level exact-match inert files, and why `CLAUDE.md` is permanently excluded

## Narrative

`INERT_MERGE_EXACT_PATHS` is the list of root-level, EXACT-match file paths proven inert by the SAME `readFileSync`/`existsSync`/`readdirSync`/`createReadStream` corpus measurement `INERT_MERGE_PATH_PREFIXES`'s own doc describes for `docs/` (card `82662e98`) — a `startsWith` PREFIX cannot express these at all: `"README.md"` has no directory component to match, so a root file needs its own exact-equality list, not a wider prefix. Verified (2026-09-04): zero real reads of any of these five names anywhere in `packages/daemon/test/*.mjs`. The only `README.md` hits found were `path.join(<throwaway-fixture-repo>, "README.md")` in `merge-gate.mjs`/`merge-union-gate.mjs`/`worker-prompt.mjs`/`worktrees.mjs` — a SYNTHETIC git fixture repo each test builds itself (`makeProject(...)`), never this project's own root file — the identical "synthetic fixture ≠ real content" distinction `ASSET_READING_TEST_REPO_PATHS`'s own membership doc already draws for `assets/**`.

## `CLAUDE.md` is deliberately, permanently excluded

`CLAUDE.md` IS DELIBERATELY, PERMANENTLY EXCLUDED — do not add it here without re-deriving this argument first: `test/kickoff-real-spawn.mjs` reads THIS repo's own real root `CLAUDE.md` and embeds real content (`claudeMd.slice(0, 4000)`) into realistic kickoff payloads it uses to exercise the bracketed-paste escaping path — a genuine, non-synthetic behavioral dependency on its actual bytes. This exact case is already investigated and pinned as a regression test: card `5149c036`, `merge-gate-inert-diff.mjs` scenario (M) and `emit-compare-gate.mjs` scenario (O) both assert a CLAUDE.md-only (or CLAUDE.md-alongside-comment-only-.ts) diff must still force the full gate. Adding CLAUDE.md here would directly regress both.

Same per-repo re-verification requirement as `INERT_MERGE_PATH_PREFIXES` — `isInertMergeDiff` re-checks each of these against THIS repo's own corpus (via `repoTreeReferencesInertPrefix`) at gate time, never trusting this list alone for a project other than Loom.

## Enforcement: `inert-exact-path-corpus-guard.mjs`, and its indirection blind spot

`inert-exact-path-corpus-guard.mjs` is the standing backstop for `INERT_MERGE_EXACT_PATHS`, a member of `STATIC_GUARD_REPO_PATHS`: a read-call-scoped literal scan of the WHOLE `test/` corpus asserting none of the five listed root files is genuinely read anywhere, with a positive control that the same technique correctly flags `CLAUDE.md` as genuinely read (real specimens: `kickoff-real-spawn.mjs`, `spawn-command-line-preflight.mjs`).

This guard is a source-TEXT property the reduced/emit-compare path cannot reason about on its own, for a specific, measured reason: `isInertMergeDiff`'s own live per-repo re-verification (`repoTreeReferencesInertPrefix`) requires a read-call name and an anchor on the SAME LINE, and is PROVABLY BLIND to the exact indirection shape `CLAUDE.md`'s own real reads use — an anchor on an earlier line, with the filename read through that constant on a later one. This was measured directly, not assumed. A future test that reads one of the five exact-path filenames using that SAME indirection shape would clear the live per-repo scanner exactly like `CLAUDE.md`'s real reads do, so this corpus-wide guard — always run, unconditionally, on every reduced gate — is what actually catches it, not the per-diff re-verification alone.

The guard deliberately does not try to auto-classify a hit as "real" vs. "synthetic fixture": every pinned hit was hand-verified once, and any new hit fails the guard loudly rather than being silently trusted.

## Do not

- Do not add `CLAUDE.md` to `INERT_MERGE_EXACT_PATHS` — `test/kickoff-real-spawn.mjs` has a genuine behavioral dependency on its real content, and two pinned regression scenarios (`merge-gate-inert-diff.mjs` (M), `emit-compare-gate.mjs` (O)) directly assert against exactly this.
- Do not treat a `path.join(<fixture-repo>, "README.md")` hit in a test as evidence against adding `README.md` here — that's a synthetic fixture repo the test builds itself, never this project's own root file.
- Do not express a root-level exact file as a `startsWith` prefix entry — a root filename has no directory component to match; it needs the exact-equality list.
- Do not have `inert-exact-path-corpus-guard.mjs` auto-classify a hit as "real" vs. "synthetic fixture" — every pinned hit was hand-verified once; a new hit must fail the guard loudly, not be silently trusted.

## Consequences

The five listed root files (`README.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`) can be treated as inert for gate purposes on Loom (re-verified per-repo elsewhere), while `CLAUDE.md` — despite being a similarly-shaped root markdown file — stays correctly excluded because of its real, measured behavioral dependency.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `INERT_MERGE_EXACT_PATHS`'s own doc comment (~line 2261, as of this worktree's HEAD before this extraction), and `STATIC_GUARD_REPO_PATHS`'s per-entry comment for `inert-exact-path-corpus-guard.mjs` (~line 2686, as of commit `084cde93` before the second extraction pass added the "Enforcement" section above). Wrapped source lines joined into flowing paragraphs, `*`/`//` comment markers stripped, no wording changed.
