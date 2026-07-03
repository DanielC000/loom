## What & why

What does this change do, and why? Link any related issue (`Fixes #123`).

## How it was verified

- [ ] `pnpm build` is green
- [ ] `pnpm --filter @loom/daemon test:daemon` (hermetic suite) is green
- [ ] Added/updated tests for the change (a new daemon `test/*.mjs` file is auto-discovered — no
      array edit needed)

Describe any manual verification (e.g. ran the daemon + web and checked the behavior).

## Notes for reviewers

Anything reviewers should pay attention to — trade-offs, follow-ups, or invariants from `CLAUDE.md`
this touches. Confirm no agent-facing surface gained access to a human-only trust boundary
(vault/git writes, `gateCommand`).
