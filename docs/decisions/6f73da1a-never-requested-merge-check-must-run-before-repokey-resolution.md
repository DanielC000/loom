# 6f73da1a — the incident that made the never-requested-merge check run before repoKey resolution

## Narrative

Root cause of the incident that named this card: two archived no-commit probe sessions
(`f9feeccc`, `1bf634de`) stamped `repoKey:"api"` from a since-deregistered multi-repo live-test
repo (`project.repos` went from naming "api" to `[]`) — neither ever called `worker_merge`, so
there was no merge to lose, yet Pass A retried repoKey resolution for them every boot for 26+
days.

## Do not

- Do not fold the "never requested a merge" check into repoKey resolution, or move it after that
  resolution — a stale/deregistered repoKey on a no-op session throws `UnknownRepoKeyError` and
  wedges the boot-reconcile pass forever for a repo it was never going to touch.

## Source

Inline comment above the never-requested-merge early-out in `reconcileOrchestrationOnBoot`
(`packages/daemon/src/sessions/service.ts`), the "Root cause of the incident..." clause. Board
card `6f73da1a` (`fix(orchestration): stop wedging boot-reconcile on a never-requested merge`),
merged as `4c228a3`. Card body confirms the same specimens and duration: `f9feeccc-4c4b-47fa-
bcd2-752cc283da11` and `1bf634de-6b54-4069-b002-a3c6cce494d5`, both on branch
`loom/8cd35e79de26`, wedged for 26+ days / 76+ consecutive boots before the fix; the card's own
DoD traces the true origin to `2026-07-29 08:38Z` via card `c33f94b2`'s measurement. The
"Card 6f73da1a: a worker that NEVER requested a merge..." contract sentence and the
`!worktreeOnDisk`/`isTerminalTask`/`terminalKey`-undefined guard rationale that follows it stay
inline at the same site (Class A/C — a reader must still see why each guard exists without
opening this record).
