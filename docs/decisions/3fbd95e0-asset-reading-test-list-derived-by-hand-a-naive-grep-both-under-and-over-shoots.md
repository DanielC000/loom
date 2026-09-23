# 3fbd95e0 — `ASSET_READING_TEST_REPO_PATHS` was derived by hand because a naive grep both under- and over-shoots it

## Narrative

`ASSET_READING_TEST_REPO_PATHS` (`packages/daemon/src/git/worktrees.ts`) lists the test files that actually read real, checked-in content under `packages/daemon/assets/**`, so {@link buildReducedGateCommand} can widen a reduced gate whenever a diff touches that tree. Card `3fbd95e0` derived this list BY HAND, once (DoD-3) — not from a glob — on the same posture `STATIC_GUARD_REPO_PATHS` already documents for its own membership: a naive `grep -rl "assets/skills" packages/daemon/test/` (the card's own starting point) is wrong in both directions at once.

**What the naive grep missed:** real consumers of a DIFFERENT `assets/**` subtree, spelled differently than the search string — `ensure-obsidian.mjs` (`../assets/scripts/…`), `skills-conditional.mjs` (`../assets/skill-fragments/…`), and `vault-lint.mjs` (imports `VAULT_LINT_SCRIPT` from `paths.ts`, with no literal `assets/` string anywhere in the test file itself) — plus every test that reads assets only INDIRECTLY, through a seed/store function such as `seedGlobalSkills()` with `LOOM_ASSET_SKILLS` unset (`platform-home.mjs`/`skills-store-durability.mjs` are exactly this shape). An earlier derivation pass, scoped to the direct-read route alone, missed both of those indirect readers — a Code Review finding against that pass is what led to stating the indirect route as its own explicit criterion clause, not just an afterthought.

**What the naive grep wrongly included:** `deploy-staleness.mjs` and `merge-gate-inert-diff.mjs`, both of which construct a SYNTHETIC git fixture repo/worktree with a path merely shaped like `assets/skills/**` to exercise the `.ts` classification logic under test. Neither reads this repo's own real asset content, so a real `assets/**`-only diff cannot move either one — verified by reading each file's own fixture setup, not assumed from the grep hit alone.

## Do not

- Do not re-derive `ASSET_READING_TEST_REPO_PATHS` from a grep for the literal string `assets/skills` (or any other single literal) — it misses indirect readers (route (2): a seed/store function call with the asset-dir override unset) and wrongly includes synthetic-fixture tests whose path merely happens to be shaped like the real tree.
- Do not treat a test that merely constructs a fixture directory named `assets`/`assets/skills` as a real reader — its outcome depends on the `.ts` source code under test, not on real asset content, so a real `assets/**` diff cannot move it.
- **SUPERSEDED by card `bce50c22` — do not carry this bullet's original premise.** It used to say: do not add `spawn-command-line-preflight.mjs`/`kickoff-real-spawn.mjs` here to "cover" the build-mirror indirection, because both read `.claude/skills/**`, a build-time (not diff-time) mirror, so a same-edit-first sibling was the only thing closing the gap. Card `bce50c22` removed that indirection: both tests now `readFileSync` `packages/daemon/assets/skills/worker/SKILL.md` directly (the canonical, tracked source), so they are ordinary direct readers like every other list member and ARE now in `ASSET_READING_TEST_REPO_PATHS`. If either test is ever changed back to reading the `.claude/skills/**` mirror, remove it from the list again — the underlying reasoning (a build-time mirror isn't diff-time-sensitive) still holds, only the two files' own current behavior changed.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `ASSET_READING_TEST_REPO_PATHS`'s own doc comment (~line 2794), as of commit `084cde93` before this extraction. Wrapped source lines joined into flowing paragraphs, `*` comment markers stripped, no wording changed.
