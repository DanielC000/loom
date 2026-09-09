# f42c545f — Keep e2e out of the merge gate; run it before release, not as a merge requirement

## Status

accepted

## Context

Loom has a Playwright e2e suite (`packages/web/e2e/`) alongside the daemon's hermetic `test:daemon`
suite. Whether e2e must pass before a branch can merge (folded into the gate command every worker/manager
runs) or run separately, later in the pipeline, was an open question with no recorded decision —
`92cfc09e`'s worker verified the current (separate) shape but found no board card id anywhere this
decision was discussed, so it reported the gap up rather than inventing one. `f42c545f`'s lead ruled: key
the record to this card's own id, since this card's body is now where the decision is recorded.

## Decision

e2e stays **out of** the merge gate. It runs as its own separate CI job (`.github/workflows/ci.yml`'s
`e2e` job, parallel to the `build-test` job that actually gates merges) and is treated the way release
verification is treated generally — see `docs/releasing.md` for the pre-tag CI-green check that closes
the Windows-gate/Linux-CI gap for a release — not as a per-worker or per-merge requirement. A worker's
DoD gate (`CLAUDE.md`'s "Worker DoD test-gate", and the resolved `gateCommand` every session reads live
via `my_context`) is build + `test:daemon` only; e2e is not part of it.

## Do not

- Do not fold `pnpm --filter @loom/web test:e2e` into the resolved `gateCommand` or into `run_gate`'s
  default self-check — it stays a separate CI job, not a merge precondition.
- Do not treat a green `build-test` CI job (or a green `run_gate`) as proof e2e also passed — they are
  independent jobs with independent outcomes.
- Do not assume GitHub branch protection enforces this split structurally — it doesn't (see Evidence);
  the split is enforced by what the gate command names, not by a repo setting.

## Consequences

- Easier: a worker's ordinary DoD stays fast (build + hermetic daemon tests), and e2e's own latency
  (a real browser, a real dev server) never sits on every merge's critical path.
- Harder / accepted: a change that breaks e2e can still land on `main` through the merge gate, and is
  only caught by the separate `e2e` CI job (or, if that's not watched, at release time via the pre-tag
  CI-green check in `docs/releasing.md`) rather than being blocked at merge.
- A user-facing web feature still needs an e2e spec as part of its own task DoD (per this project's
  worker doctrine) — this decision is about what the merge *gate* enforces, not about whether e2e specs
  get written.

## Evidence

- OBSERVED (this session, 2026-09-09): `.github/workflows/ci.yml` defines two top-level, independent
  jobs — `build-test` (install, build, `pnpm --filter @loom/daemon test:daemon`) and `e2e` (install,
  build, Playwright browser install, `pnpm --filter @loom/web test:e2e`). Neither depends on the other
  (`needs:` is absent from both); they run in parallel.
- OBSERVED (this session, 2026-09-09): `gh api repos/DanielC000/loom/branches/main/protection` returned
  HTTP 404 `"Branch not protected"` — nothing at the GitHub level structurally requires either CI job to
  pass before a merge to `main`.
- OBSERVED (this session, 2026-09-09): `my_context()`'s live `gateCommand` field reads
  `"pnpm build && pnpm --filter @loom/daemon test:daemon"` — no e2e step.
- READ-IN-SOURCE: project memory note from `92cfc09e`'s worker records the same three facts as their own
  reading, plus a sweep of `CLAUDE.md`/`docs/`/`git log` for an existing card id tied to this decision,
  finding none — re-swept in this session (`grep` for the decision's own phrasing, case-insensitive,
  whole worktree) with the same zero-hit result, so this record keys to `f42c545f` per the card's ruling.
