# 8db0c289 — reject `permission.mode:"default"`/`"plan"` on every agent-facing project-config write path

## Narrative

Card `8db0c289` (discovered from `db1ceb7d`, itself discovered from `f021e26d`): `db1ceb7d`'s own
investigation confirmed that `agentPermissionOverride.mode` (`mcp/platform.ts`) excluded only
`"bypassPermissions"` — `"default"` and `"plan"` stayed agent-settable project-wide via the manager's
`project_update` and the setup router's `project_configure`/`project_update`. This card investigated
whether that gap was exploitable the same way `f021e26d` proved for `bypassPermissions`, and confirmed it
is — for a different, but equally severe, failure shape.

### The mechanism (identical fallback `f021e26d` already proved)

`withRolePermissionModeCyclesPin` (`sessions/service.ts`) pins a spawn's boot-cycle target to `auto`
**only** for `worker`/`assistant`. Every other role — `manager`/`platform`/`setup`/`auditor`/
`workspace-auditor`/`run` — that reaches a fresh spawn with no `resumeModeTarget` and the typical
`startupModeCycles:0` falls straight through `computeBootMode` (`pty/host.ts`) to
`toCliPermissionMode(permission.mode)` — the raw **stored** config value, verbatim, as the real
`--permission-mode` boot flag. (A `"plain"` role-less session reaches the identical fallback too, but is
owner-interactive by design — a human really is at that session's own PTY — so it is excluded from the
blast-radius analysis below.)

### What each forbidden value actually does, confirmed via a hermetic script against the real built
`dist/pty/host.js` (no real claude, no daemon, no `~/.loom` touched):

```
stored permission.mode:"default" (no target) -> boot flag: "manual"
stored permission.mode:"plan"    (no target) -> boot flag: "plan"

role                 | ExitPlanMode disallowed? | can self-escape a direct `plan` boot?
manager              | false                     | yes, ExitPlanMode tool is present
platform             | false                     | yes, ExitPlanMode tool is present
setup                | true                      | NO — permanently trapped
auditor              | true                      | NO — permanently trapped
workspace-auditor    | true                      | NO — permanently trapped
run                  | true                      | NO — permanently trapped
```

- **`"default"` → boots as the CLI's `"manual"` mode** (`toCliPermissionMode`, `claude-settings.ts`) — the
  CLI's own ask-every-non-preapproved-action mode. It has **no tool-level escape at all** (unlike `plan`,
  it is not one gated transition — it blocks on *every* non-allowlisted tool call, indefinitely). None of
  `manager`/`platform`/`setup`/`auditor`/`workspace-auditor`/`run` has a human watching its live PTY
  (that is the entire point of Loom's unattended-boot design — `acceptEdits` + allowlist — per `CLAUDE.md`).
  ⇒ a project-wide DoS, for any one of those roles, the moment an agent (mis)configures
  `permission.mode:"default"` for that project.
- **`"plan"` → boots DIRECTLY into plan mode** (`plan` ∈ `DIRECT_BOOT_MODES`, so `computeBootMode` passes
  it through unchanged). For `setup`/`auditor`/`workspace-auditor`/`run` — all in `LOOM_DRIVEN_ROLES`, so
  `disallowedToolsForRole` strips `ExitPlanMode` — this is a **permanent trap**: no tool to request exiting
  plan mode, and no human to answer one either. For `manager`/`platform` (which keep `ExitPlanMode`), a
  direct `plan` boot is **not new risk** on its own — it's the same code path already relied on for the
  legitimate, human-only `startupModeCycles:1` config (see `boot-mode-direct.mjs`'s own test "a config
  that WANTS plan"). The gap closed here is that an **agent** could trigger the identical effect directly,
  bypassing the human-only `startupModeCycles` knob — a project-wide boot-default write an agent should
  never be able to make, independent of whether the specific role it happens to land on can self-escape.

### Lead decision on the elevated Platform Lead surface

The elevated Platform Lead `project_configure` route reuses the full human-equivalent validator
(`validateProjectConfigOverride`), which accepts all four `permission.mode` values — `f021e26d` already
closed `bypassPermissions` there with a separate raw-payload check, on the reasoning "human-driven but
still an agent." This card's investigation flagged whether `"default"`/`"plan"` should get the same
treatment as a judgment call (lower severity than disabling the gate outright); this was decided as a
**lead decision (Loom manager gen 401)** — no owner Request backs this ruling — to **mirror `f021e26d`**:
the stored mode is a project-wide boot default regardless of who writes it, "plan"
permanently traps `setup`/`auditor`/`workspace-auditor`/`run` and "default" wedges every unattended role,
which is a fleet-DoS class, not a cosmetic misconfiguration — and the human REST/UI path loses nothing by
staying the sole escape hatch, exactly as it already is for `bypassPermissions`.

## Fix

- `AGENT_PERMISSION_MODE_ALLOWLIST` (new, `mcp/platform.ts`) = `permissionOverride.shape.mode.unwrap().extract(["acceptEdits"])`
  — an **allowlist, not a denylist** (round-2 review correction, below): `agentPermissionOverride.mode` is
  this schema directly, so only `"acceptEdits"` is agent-settable and any value added to
  `permissionOverride`'s own `mode` enum in the future starts out **forbidden** on the agent path by
  construction, rather than silently inherited as agent-settable the way a denylist would have let it.
- `agentPermissionModeRejectionMessage(mode)` (new, `mcp/platform.ts`) — one shared function deriving its
  message from `AGENT_PERMISSION_MODE_ALLOWLIST.options`, read by BOTH the agent schema's pre-check
  (`validateAgentProjectConfigOverride`, which short-circuits before `safeParse` so a forbidden mode gets
  this clear message instead of zod's generic "Invalid enum value") and the elevated Lead
  `project_configure`'s raw-payload check — so the two routes can never phrase the same refusal
  differently, and the Lead check reads the identical allowlist.
- The three tool-description strings `db1ceb7d` added (`orchestration.ts`'s `project_update`; `setup.ts`'s
  `project_configure` and `project_update`) now name `"default"`/`"plan"` as rejected alongside
  `"bypassPermissions"`.
- `agent-config-permission-pty-guard.mjs` (the `f021e26d` test) narrowed its "still ACCEPTS" loop to
  `acceptEdits` only (it previously asserted `"default"`/`"plan"` were accepted — now stale by
  construction); the new rejection coverage for both lives in this card's own test.
- New test: `packages/daemon/test/agent-permission-mode-default-plan-guard.mjs` — the boot-mode mechanism
  itself (hermetic, pure functions: which `--permission-mode` flag a stored `default`/`plan` produces, and
  which roles have no escape, with negative controls for both), the schema/validator unit layer (agent
  path rejects with the clear message, human/REST path CONTROL unchanged, `acceptEdits` CONTROL still
  accepted and still boots unattended), real end-to-end wiring through `SessionService.updateProjectStructural`,
  `SetupMcpRouter`'s `project_configure`/`project_update`, and `PlatformMcpRouter`'s elevated
  `project_configure`, AND (round-2 addition) that a human-set stored `"plan"`/`"default"` mode SURVIVES
  an unrelated agent patch (e.g. `memory.topK`) through all three of those same write paths — the merge
  never silently touches a field the patch didn't name. Verified RED against the pre-fix source and GREEN
  after, tree restored byte-identical, via `pnpm --filter @loom/daemon negative-control`.
- Grepped shipped skills (`setup-assistant`, `platform-lead`) and `*.md` docs for any place teaching an
  agent to set `permission.mode` to `"plan"`/`"default"` via `project_configure`/`project_update` — none
  found; no doctrine text needed updating.

### Round-2 Code Review correction

Code Reviewer `baaa9744` found the fix sound (independently reproduced the RED/GREEN negative control,
confirmed the 17 MCP-surface tests and guards green) and required four follow-ups, all applied here: (1)
this record's own heading and prose had misattributed the Lead-surface ruling above to "the owner" — it
is a **lead decision (Loom manager gen 401)**, with no owner Request backing it; (2) the denylist
(`AGENT_FORBIDDEN_PERMISSION_MODES`) was replaced with the allowlist described above, so a future enum
addition fails closed by default instead of needing a human to remember to add it to a denylist; (3) the
new test gained the human-set-mode-survives-an-unrelated-patch coverage named above, which previously
rested on a single comment rather than an assertion; (4) the agent schema's rejection message was made
explicit (`permission.mode "<x>" is human-only; agents may set only "acceptEdits"`) rather than zod's
default.

## Do not

- Do not let `permission.mode` outside `AGENT_PERMISSION_MODE_ALLOWLIST` reach ANY agent-facing
  project-config write path, including the elevated Platform Lead `project_configure` — any value other
  than `"acceptEdits"` is a project-wide boot-time default, not a single session's live mode, and reaches
  the real `--permission-mode` boot flag verbatim for every role `withRolePermissionModeCyclesPin` doesn't
  pin.
- Do not revert `AGENT_PERMISSION_MODE_ALLOWLIST` back to a denylist (`.exclude([...])`) — an allowlist is
  the point: a value added to `permissionOverride`'s own `mode` enum later must start out FORBIDDEN on the
  agent path by construction, never silently inherited as agent-settable the way a denylist would.
- Do not hand-copy `AGENT_PERMISSION_MODE_ALLOWLIST` or `agentPermissionModeRejectionMessage` elsewhere,
  and do not let the elevated Lead's raw-payload check drift from the schema's own allowlist/message — all
  three call sites must read the same two symbols.
- Do not read `"plain"` (role-less) sessions as sharing this blast radius despite reaching the identical
  `computeBootMode` fallback — a plain session is owner-interactive by design (a human really is at that
  PTY), so neither `"manual"`'s live-approval requirement nor `"plan"`'s `ExitPlanMode` gate actually
  blocks it. Do not widen this fix's reasoning to plain sessions without re-checking that premise.
- Do not treat a direct `"plan"` boot for `manager`/`platform` as the newly-closed gap — it was already a
  supported, intentional path via the human-only `startupModeCycles:1` config; the gap this card closes is
  only that an agent could trigger the equivalent effect directly, as a project-wide default, bypassing
  that human-only knob.
- Do not widen `withRolePermissionModeCyclesPin`'s pin to cover `setup`/`auditor`/`workspace-auditor`/`run`
  as an alternative fix — that was considered and rejected implicitly by closing the gap at the
  config-write boundary instead (mirrors `f021e26d`'s own choice for `bypassPermissions`): the pin exists
  to make a worker/assistant's *own* boot survive an unrelated project knob, not to compensate for an
  agent being allowed to write a dangerous value in the first place.

## Related

- `docs/decisions/f021e26d-reject-bypasspermissions-deny-removal-invalid-pty-geometry.md` — the sibling
  fix this card extends: the identical `computeBootMode` fallback, closed the same way, for
  `bypassPermissions`; this card adds `"default"`/`"plan"` to the same exclude list and raw check. Also
  carries a cross-reference back to this card.
- `docs/decisions/016ee373-direct-boot-modes-typed-as-compile-time-guard.md` — why `DIRECT_BOOT_MODES`
  (which makes a stored `"plan"` boot directly rather than via a Shift+Tab climb) is typed the way it is.
- `docs/decisions/760cd01d-pin-worker-boot-mode-to-auto.md` / `docs/decisions/5603f40f-pin-assistant-boot-mode-to-auto.md`
  — the two existing pins `withRolePermissionModeCyclesPin` applies; every other role's absence of a pin
  is what makes the fallback in this card's narrative reachable.
- `docs/decisions/8dd1dd1c-role-scoped-human-prompt-disallow.md` — `LOOM_DRIVEN_ROLES` and why
  `ExitPlanMode` is disallowed for `setup`/`auditor`/`workspace-auditor`/`run` but not `manager`/`platform`.

## Source

`packages/daemon/src/mcp/platform.ts` (`AGENT_PERMISSION_MODE_ALLOWLIST`,
`agentPermissionModeRejectionMessage`, `agentPermissionOverride`,
`validateAgentProjectConfigOverride`'s pre-check, the elevated `project_configure` route's raw-payload
check), `packages/daemon/src/mcp/orchestration.ts` and `packages/daemon/src/mcp/setup.ts` (tool-description
wording), `packages/daemon/test/agent-permission-mode-default-plan-guard.mjs` and
`packages/daemon/test/agent-config-permission-pty-guard.mjs`.
