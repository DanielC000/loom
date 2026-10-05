# f021e26d — reject `bypassPermissions`, a `permission.deny` removal, and an invalid pty geometry on every agent-facing project-config surface

## Narrative

Card `f021e26d` (full review lane 4, discovered from `486d4238`): a reviewer reproduced three gaps in
`validateAgentProjectConfigOverride` (`mcp/platform.ts`) — the validator shared by the manager's own
`project_update` and the setup/operator surface's `project_configure`/`project_update`.

1. **`permission.mode:"bypassPermissions"` was accepted.** A project's stored `permission.mode` is the
   boot-time default for every session that project ever spawns (`claude-settings.ts`'s
   `writeSessionSettings`), so an agent setting it to `bypassPermissions` would disable the
   acceptEdits+allowlist sandbox for every future session in that project — not just one worker's live
   mode. This directly contradicts `worker_set_mode`'s own fail-closed boundary (`sessions/service.ts`'s
   `WORKER_SETTABLE_MODES`, decision `610abe29`): "an agent must never be able to escalate a worker out of
   its sandbox." The bug let an agent do exactly that, one layer up, through config instead of through
   `worker_set_mode` directly.
2. **`permission.deny` could be wiped.** `mergeConfigOverride`'s deep-merge replaces arrays wholesale
   (`permission.allow`/`deny` "likewise" — see `deepMergeRecord`'s own doc), so an agent patch of
   `{permission:{deny:[]}}` (or any narrower list) silently discarded every human-set deny entry, with no
   way for the agent-facing validator to tell "the agent meant to shrink this" from "the agent never
   looked at the existing list at all."
3. **pty geometry had no bounds.** `{pty:{cols:0,rows:-5}}` validated and persisted; `config.pty` is
   threaded straight through to `PtyHost.spawn()`'s `geometry` (see `sessions/service.ts`'s many
   `geometry: config.pty` call sites), so a stored zero/negative/non-integer value could break a future
   spawn. The live-resize path already had an equivalent bound
   (`gateway/server.ts`'s `isValidTerminalDimension`, card `37d4325d`) but the config-write path never did.

The runtime effect of a stored `bypassPermissions` mode was CONFIRMED, not merely suspected, for every
role except worker/assistant. `pty/host.ts`'s `computeBootMode` (~1345) boots directly at the session's
resolved mode TARGET only when that target is itself one of `DIRECT_BOOT_MODES` (`acceptEdits`/`plan`/
`auto`); otherwise it falls back to `toCliPermissionMode(permission.mode)` — the STORED mode, verbatim,
as the `--permission-mode` boot flag. `sessions/service.ts`'s `withRolePermissionModeCyclesPin` (~2322)
pins a target of `auto` ONLY for `worker`/`assistant` roles, independent of the shared
`permission.startupModeCycles` knob; every other role (manager/platform/setup/auditor/plain) has no such
pin, so a fresh spawn with no `resumeModeTarget` and no project-level `startupModeCycles` set resolves no
target at all, and `computeBootMode` falls straight through to the stored mode. So a stored
`bypassPermissions` reached the real `--permission-mode` boot flag directly, pre-fix, for exactly those
roles — the fix closes the escalation at the config-write boundary regardless, since a config value an
agent should never have been able to set in the first place is a defect on its own terms.

## Fix

- `agentPermissionOverride` (new, `mcp/platform.ts`) narrows `permission.mode` to exclude
  `bypassPermissions` — derived from `permissionOverride.shape.mode.unwrap().exclude(...)`, never a
  hand-copied enum, so the two can't drift apart. Wired into `agentProjectConfigOverrideSchema` by
  `.omit`+`.extend`ing `permission` (the same pattern already used for `orchestration`/`obsidian`/
  `python`), so the top-level key stays agent-settable — only the one forbidden value is rejected.
  `validateProjectConfigOverride` (the human/REST path) is untouched; it still accepts
  `bypassPermissions` as the deliberate human-only escape valve.
- The elevated Platform Lead `project_configure` route (`mcp/platform.ts`) uses the FULL human-equivalent
  validator (`validateProjectConfigOverride`), which would otherwise still accept `bypassPermissions` —
  so a separate raw-payload check rejects it there too, mirroring the existing
  `HUMAN_ONLY_PROJECT_CONFIG_KEYS`/`HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS` posture on that same route: the
  Lead is human-driven but still an agent, and this closes the exact escalation point 1 describes even on
  the elevated surface.
- `mergeConfigOverride` gains a second guard option, `additiveOnlyPermissionDenyGuard` (mirroring the
  existing `additiveOnlyRotationGuard`, decision `1069c8e1`): when set, `permission.deny` merges as a
  TOKEN UNION — every existing entry survives, a patch can only ADD. `permission.allow` is deliberately
  unaffected (plain replace either way — an agent widening its own allowlist is not the same escalation
  as an agent narrowing a human's deny list). Set `true` on every agent-facing config-write call site
  (`sessions/service.ts`'s `updateProjectStructural`, `mcp/setup.ts`'s `project_configure` and
  `project_update`); left unset on the human-equivalent Lead `project_configure` and the human REST PATCH,
  which stay the deliberate release valve for a legitimate human-initiated deny-list retirement.
- `ptyOverride` bounds `cols`/`rows` to `z.number().int().min(1).max(2000)` on BOTH validators (not just
  the agent path — this is a correctness fix for every caller, not an escalation-specific one). The
  `2000` ceiling mirrors `gateway/server.ts`'s `MAX_TERMINAL_RESIZE_DIMENSION` (card `37d4325d`); it isn't
  imported across that layering boundary, so it's restated here as `PTY_GEOMETRY_DIMENSION_MAX`.

Tests: `packages/daemon/test/agent-config-permission-pty-guard.mjs` — schema/validator unit coverage for
all three fixes, plus real end-to-end wiring through `SessionService.updateProjectStructural`,
`SetupMcpRouter`'s `project_configure`/`project_update`, and `PlatformMcpRouter`'s elevated
`project_configure`, with the human/REST validator exercised as a control throughout. Verified RED against
the pre-fix source (reverted, rebuilt, re-run) and GREEN again after restoring the fix.

## Do not

- Do not let `permission.mode:"bypassPermissions"` reach ANY agent-facing project-config write path,
  including the elevated Platform Lead `project_configure` — it is a project-wide boot-time default, not
  a single worker's live mode, so the blast radius of letting it through is every future session that
  project spawns, not one session.
- Do not revert `mergeConfigOverride`'s `permission.deny` handling back to a plain array replace on an
  agent-facing call site — that silently re-opens the deny-wipe this card closes. The human-equivalent
  Lead `project_configure` and the REST PATCH path are the ONLY paths allowed to shrink `permission.deny`
  (a deliberate human release valve), exactly mirroring the rotation guard's own asymmetry.
- Do not conflate `additiveOnlyPermissionDenyGuard` with `additiveOnlyRotationGuard` into one flag — they
  protect unrelated fields and are reviewed/tested independently; keep them as two options on
  `MergeConfigOverrideOptions`, set together at each agent-facing call site, not merged into one meaning.
- Do not bound `pty.cols`/`rows` only on the agent validator — the stored value reaches `PtyHost.spawn()`
  for every spawn regardless of who wrote it, so the human/REST validator needs the same bound.
- Do not hand-copy the `permission.mode` enum when narrowing it for the agent path — derive it from
  `permissionOverride.shape.mode` (`.unwrap().exclude([...])`) so the two schemas can never drift apart.

## Related

- `docs/decisions/610abe29-worker-set-mode-is-the-only-mode-change-path-fails-closed.md` — the sibling
  boundary this card closes one layer up (config instead of the live `worker_set_mode` tool).
- `docs/decisions/1069c8e1-additive-only-rotation-guard-protects-all-three-fields.md` — the prior
  precedent for an additive-only merge guard on `mergeConfigOverride`, reused (as a second, independent
  option) rather than re-invented here.
- `docs/decisions/8db0c289-reject-default-plan-permission-mode-on-agent-config-write.md` — extends this
  card's `agentPermissionOverride.mode` exclude list and elevated-route raw check to also reject
  `"default"`/`"plan"`, which reach the real boot flag via this exact same `computeBootMode` fallback.

## Source

`packages/daemon/src/mcp/platform.ts` (`agentPermissionOverride`, `ptyOverride`,
`applyAdditiveOnlyPermissionDenyGuard`, `mergeConfigOverride`, the elevated `project_configure` route's
raw-payload `bypassPermissions` check), `packages/daemon/src/mcp/setup.ts` and
`packages/daemon/src/sessions/service.ts` (the `additiveOnlyPermissionDenyGuard: true` call sites), as of
commit `24172e55` (the landed squash-merge on main; `727dd094` was a pre-squash worker commit that
predated this file's own addition to the branch and never reached main under that sha).
