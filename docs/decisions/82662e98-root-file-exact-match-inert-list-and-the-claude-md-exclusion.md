# 82662e98 — Root-level exact-match inert files, and why `CLAUDE.md` is permanently excluded

## Narrative

`INERT_MERGE_EXACT_PATHS` is the list of root-level, EXACT-match file paths proven inert by the SAME `readFileSync`/`existsSync`/`readdirSync`/`createReadStream` corpus measurement `INERT_MERGE_PATH_PREFIXES`'s own doc describes for `docs/` (card `82662e98`) — a `startsWith` PREFIX cannot express these at all: `"README.md"` has no directory component to match, so a root file needs its own exact-equality list, not a wider prefix. Verified (2026-09-04): zero real reads of any of these five names anywhere in `packages/daemon/test/*.mjs`. The only `README.md` hits found were `path.join(<throwaway-fixture-repo>, "README.md")` in `merge-gate.mjs`/`merge-union-gate.mjs`/`worker-prompt.mjs`/`worktrees.mjs` — a SYNTHETIC git fixture repo each test builds itself (`makeProject(...)`), never this project's own root file — the identical "synthetic fixture ≠ real content" distinction `ASSET_READING_TEST_REPO_PATHS`'s own membership doc already draws for `assets/**`.

## `CLAUDE.md` is deliberately, permanently excluded

`CLAUDE.md` IS DELIBERATELY, PERMANENTLY EXCLUDED — do not add it here without re-deriving this argument first: `test/kickoff-real-spawn.mjs` reads THIS repo's own real root `CLAUDE.md` and embeds real content (`claudeMd.slice(0, 4000)`) into realistic kickoff payloads it uses to exercise the bracketed-paste escaping path — a genuine, non-synthetic behavioral dependency on its actual bytes. This exact case is already investigated and pinned as a regression test: card `5149c036`, `merge-gate-inert-diff.mjs` scenario (M) and `emit-compare-gate.mjs` scenario (O) both assert a CLAUDE.md-only (or CLAUDE.md-alongside-comment-only-.ts) diff must still force the full gate. Adding CLAUDE.md here would directly regress both.

Same per-repo re-verification requirement as `INERT_MERGE_PATH_PREFIXES` — `isInertMergeDiff` re-checks each of these against THIS repo's own corpus (via `repoTreeReferencesInertPrefix`) at gate time, never trusting this list alone for a project other than Loom.

## Do not

- Do not add `CLAUDE.md` to `INERT_MERGE_EXACT_PATHS` — `test/kickoff-real-spawn.mjs` has a genuine behavioral dependency on its real content, and two pinned regression scenarios (`merge-gate-inert-diff.mjs` (M), `emit-compare-gate.mjs` (O)) directly assert against exactly this.
- Do not treat a `path.join(<fixture-repo>, "README.md")` hit in a test as evidence against adding `README.md` here — that's a synthetic fixture repo the test builds itself, never this project's own root file.
- Do not express a root-level exact file as a `startsWith` prefix entry — a root filename has no directory component to match; it needs the exact-equality list.

## Consequences

The five listed root files (`README.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`) can be treated as inert for gate purposes on Loom (re-verified per-repo elsewhere), while `CLAUDE.md` — despite being a similarly-shaped root markdown file — stays correctly excluded because of its real, measured behavioral dependency.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `INERT_MERGE_EXACT_PATHS`'s own doc comment (~line 2261), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
