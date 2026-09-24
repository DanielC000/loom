# 8d4b4433 — manager and platform-lead recycle RE-RESOLVE the harness; worker recycle, resume, fork and boot stay row-pinned

## Narrative

Multi-harness epic `df1f94b0`, card 2 of fleet-harness-switching. Card `66b1b40d` added a human-only default-harness config resolved at fresh worker spawn (`resolveAgentSpawn` → `defaultHarnessForSpawn`). But every recycle path built the successor with `harness: old.harness`, so flipping a Profile's harness (or, once card `4c4eb9af` opens `scope:"fleet"`, the default) could never move an existing manager or Lead lineage: each generation copied the previous row's pin forever.

`recycleManager` and `recyclePlatformLead` already call `resolveAgentSpawn` (for the layered allowlist and model pin) and used to discard its `.harness`. They now use it for both the successor session row and the `pty.spawn` opts, so the two never diverge.

This deliberately breaks the pin-on-recycle precedent from `547d5fc4` (which pinned `skills` off the row so a later profile edit can't change a live session's view). The two differ on purpose: a recycle boots a FRESH context from a written handoff (never `--resume`, see the recycle doc on `recycleManager`), so no engine transcript is tied to the old harness, and the harness is the one attribute an operator needs to be able to change on a long-lived lineage without killing it. `skills`, `browserTesting` and the other carried fields are unchanged and still row-pinned.

Rules:
- An `undefined` re-resolve means claude. Do not fall back to `old.harness` on `undefined`, or codex→claude can never happen.
- Fall back to `old.harness` ONLY when the agent row is missing (nothing to resolve against), mirroring the existing agent-missing behaviour for permission and model.
- `recycleWorker` stays pinned to `old.harness`: same task, worktree and branch, and the worker's CLI must not change mid-task.
- `resume`, `forkSession` and boot-reconcile stay row-pinned. Only a FRESH-context recycle re-resolves.

## Do not

- Do not "fix" the manager/Lead recycle back to `old.harness ?? undefined` for consistency with the worker path — the asymmetry is the feature.
- Do not fall back to `old.harness` when the re-resolve yields `undefined`; only when the agent row is gone.
- Do not take the harness from one source and the safety fields from another. A recycle carries `restrictedTools`/`browserTesting`/`documentConversion`/`capabilities` from the old row (pinned per `547d5fc4`) while the harness is re-resolved; if the re-resolved harness is codex and `codexIncompatibilities(old ROW)` (`profiles/codex-compat.ts`, card `961da6c6`) returns any item, `recycleHarness` keeps `old.harness` and the caller files `harness_default_skipped` for the successor (`workerSessionId` = successor, `managerSessionId` = predecessor, `detail.trigger:"recycle"`). Otherwise a codex successor would run UNrestricted (`createCodexPty` ignores `restrictedTools`), reopening the fail-open card `0770d916` closed. The input is the OLD ROW's fields, not the agent/profile that `defaultHarnessForSpawn` checks: recycle carries the row's fields forward.
- Do not describe the recycle skip as "the fleet default harness is codex": the re-resolved codex can also come from an EXPLICIT codex Profile pin. The event kind is reused from a fresh spawn; `trigger:"recycle"` is the discriminator.
- Do not expect the skip to clear on its own. It is PERMANENT for a lineage whose row carries any of those fields: recycle carries them forever, only a fresh spawn (new agent/profile state) can move it, and every recycle files another skip event. Fail-closed is intended.
- Do not re-resolve in `recycleWorker`, `resume`, `forkSession` or boot-reconcile.

## Waived DoD item

The card's DoD asked for fork/boot pinning coverage. Waived by the manager (lead `gen 371`): `forkSession` refuses a codex-pinned source on main (card `961da6c6`), boot-reconcile goes through resume, and this branch's diff touches neither path. The test header keeps the disclosure.

## Source

`packages/daemon/src/sessions/service.ts` (`recycleManager`, `recyclePlatformLead`); test `packages/daemon/test/recycle-harness-reresolve.mjs`. Note: `scope:"fleet"` is still rejected by the validators (card `4c4eb9af`), so today a manager/Lead re-resolves only from its Profile's own `harness`; the default layer is covered by stubbing `defaultHarnessForSpawn`.
