# bed49000 — the codescape kickoff orientation block is gated by conventional-commit type, not deleted outright

## Narrative

Card bed49000 — worker kickoffs carry the codescape orientation block (`CODESCAPE_PROMPT_BLOCK_ASSET`) unconditionally; a Platform Auditor sample (n=4 transcripts) found it net-negative for docs-only work (skipped outright — a code graph over symbols cannot help a task that never touches one) while structural/exploration/refactor work was left untested either way. Gate, don't delete: a code graph plausibly earns its keep on a large refactor, and the sample cannot see that case, so a false KEEP (an unhelpful block on a docs task) is cheap — one skippable paragraph — while a false EXCLUDE (a withheld block on a task that could have used it) is not, so the boundary is deliberately conservative: exclude only what's cheaply and reliably knowable before the worker has touched a single file, default to keeping it for everything else.

Signal: this project's own Conventional-Commits `type(scope): summary` title convention (`CLAUDE.md` "Conventional Commits" + "Commit scopes" — managers title board cards this way). The leading `type` is a cheap, reliable, already-documented proxy for task shape, known at dispatch time (before any worktree/file is touched) via the task's `title` alone — no new task field, no text-mining the kickoff prompt. Excluded types: `docs` (pure prose — the sampled CHANGELOG case) and `style` (formatting-only) — neither ever touches code structure a symbol graph could illuminate. Every other type (`feat`, `fix`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`), a title that doesn't parse as `type(scope): …`, and a taskless spawn (`undefined`/`null`) all default to KEEP.

Not attempted: the card's scope section also names "single-file" and "test-fixture" dispatches as candidates to exclude. Neither has a signal available at dispatch time distinct from the type prefix above (a task is not yet known to be single-file until the worker decides how many files to touch; "test-fixture" vs. a test task that does need structural exploration cannot be told apart from a title alone) — rather than guess with a brittle keyword heuristic, this gate leaves both classes on the conservative KEEP default. Whether the graph ever helps a kept class remains unestablished (no measurement, either direction) — this gate narrows exposure to the one class with clear negative evidence, it does not claim the kept classes are proven to benefit.

## Do not

- Do not delete the codescape kickoff block outright — gate it by task type instead, since a large-refactor case that could benefit from it was never sampled.
- Do not exclude "single-file" or "test-fixture" dispatches by a brittle keyword heuristic — no dispatch-time signal distinguishes them reliably from the type prefix; leave them on the conservative KEEP default.
- Do not read the KEEP default for non-docs/style types as proof the graph helps those tasks — it is unestablished either direction; this gate only narrows exposure to the one class with clear negative evidence.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the codescape kickoff-block type-gate's top-of-block doc): lines 1673-1701, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
