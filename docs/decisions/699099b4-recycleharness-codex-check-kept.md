# 699099b4 — keep `recycleHarness`'s codex-incompatibility check as dead-but-deliberate defense in depth

Follow-up from `7955458e`'s second Code Review (Minor #4): is `recycleHarness`'s `codexIncompatibilities`
branch (and the `harnessDrainStatus.blocked` / recycle-trigger `harness_default_skipped` plumbing built on
it) a clean, small dead-code removal?

## Evidence

Confirmed structurally unreachable for every real caller — `resolveAgentSpawn`'s role-based force
(`7955458e`, `TRANSCRIPT_ROOT_DENY_ROLES` in `profiles/codex-compat.ts`) always preempts it for role
`manager`/`platform`, the only two roles that ever call `recycleHarness`. Full file:line evidence, the
grep of every `blocked` consumer (gateway, web UI, e2e), and the narrower-removal analysis are recorded in
project memory `recycleharness-codex-branch-provably-dead`, not restated here.

## Ruling

Manager decision: KEEP the code. Dead today is not reason enough to delete it — `7955458e` deliberately
retained this check as a second layer of codex/transcript isolation, should a future role ever reach
`recycleHarness` without being a `TRANSCRIPT_ROOT_DENY_ROLES` member. Removing defense-in-depth for no
behaviour gain is a bad trade, and the REST/UI `blocked` surface costs nothing to keep as-is.

## Do not

- Do not delete `recycleHarness`'s `codexIncompatibilities` branch, `harnessDrainStatus.blocked`, or the
  recycle-trigger `harness_default_skipped` events as dead code — they are intentional defense-in-depth.
- Do not re-litigate this without new information (e.g. a real new caller of `recycleHarness`, or a
  concrete cost to keeping it) — re-read the project memory note above first.
