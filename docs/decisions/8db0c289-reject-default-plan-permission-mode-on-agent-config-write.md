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

### Round-3 follow-up (card `d8f5de04`): the allowlist alone still let an agent change a human-set mode

Code Reviewer `baaa9744`'s follow-up review of this fix found it sound but incomplete, the opposite way
from the additive-only deny guard: `AGENT_PERMISSION_MODE_ALLOWLIST` gates only the VALUE an agent writes,
never whether that write overwrites a *different* value already stored. A manager/setup patch of
`{permission:{mode:"acceptEdits"}}`, or the elevated Lead's `unset:["permission.mode"]` /
`unset:["permission"]` (an ancestor) / `replace:true` whose replacement omits `permission.mode`, all
reached the stored config unguarded and silently loosened or dropped a human-set `"default"`/`"plan"`.
Probe-confirmed: a stored `"plan"` was dropped by the Lead's `replace:true`.

**Fix:** `isHumanSetPermissionMode(mode)` (new, `mcp/platform.ts`) — true iff a STORED `permission.mode` is
a string outside `AGENT_PERMISSION_MODE_ALLOWLIST`. Undefined (no override at all) and `"acceptEdits"` are
deliberately NOT human-set: every agent-facing write path can produce either state itself, so there is
nothing uniquely human to protect there. Any other stored value can only have reached storage via the
human REST/UI path (or the pre-8db0c289 window) — its mere presence IS the proof; no separate "set-by"
column is needed. Paired with a shared `humanSetPermissionModeRejectionMessage(existingMode)` (new,
`mcp/platform.ts`) naming the stored mode and the human escape hatch, e.g. `permission.mode is "plan"
(human-set); agents may not change or remove it — use the REST config PATCH / Settings UI`.

Applied as an outright REFUSAL (never a silent reshape, unlike `permission.deny`'s additive-union guard —
the card asked for a refusal) at all three agent-facing write call sites: `SessionService
.updateProjectStructural` (manager `project_update`) and `SetupMcpRouter`'s `project_configure`/
`project_update` check only the WRITE direction (neither surface supports `unset`/`replace`); the elevated
`PlatformMcpRouter.project_configure` checks all three directions (write / `unset` exact-or-ancestor /
`replace:true` omitting the key), since it alone supports `unset`/`replace`.

New test coverage (LAYER 6, `agent-permission-mode-default-plan-guard.mjs`): unit coverage for
`isHumanSetPermissionMode`/the message fn; real wiring against all three surfaces seeded with a stored
`"plan"` AND a stored `"default"` — write/unset/unset-ancestor/replace-omit each REFUSED, stored mode
unchanged; negative/no-over-fire controls proving the guard discriminates on the EXISTING stored value,
not merely on "a write/unset/replace touched permission.mode at all": the SAME write/unset/replace
operations against an undefined or already-`"acceptEdits"` stored mode still SUCCEED on every surface
(manager `project_update`, both setup tools, and — round-2 addition, below — the elevated Lead's own
`unset`/`replace:true`), and an `unset` of a SIBLING leaf (`permission.allow`, not an ancestor of `mode`)
still succeeds with `mode` surviving.

**Round-2 verification (Code Reviewer `bf8988d7`):** the reviewer judged "the new exports don't exist
pre-fix, so the test fails at import" an insufficient RED proof — it shows the fix is *present*, not that
each of its legs actually *does* anything — and found the round-1 test's own no-over-fire coverage
incomplete: mutating the elevated Lead's guard condition to over-fire on every `unset`/`replace:true`
(regardless of the stored mode) still left that version of the test fully green, because it never
exercised `unset`/`replace:true` SUCCEEDING at all. The reviewer instead ran a BEHAVIOURAL negative
control — neutralizing each guard leg individually in the compiled `dist` and re-running this test — and
confirmed it goes RED for every leg, on every surface and in every direction: **A 29, B 12, C 10, D 6, E 8,
F 4, G 6 FAIL**. This proves each leg is actually exercised by some assertion, but it does **NOT isolate**
the legs from one another: the write/unset/unset-ancestor/replace-omit checks for a given `seedMode` all
run in sequence against the SAME project row, so a failure attributed to one leg's neutralization is not
guaranteed to be independent of state an earlier (now-wrongly-permitted) leg's write left on that same row.
Path normalization (`unsetDropsConfigPath`'s ancestor/descendant logic), `replace:true`'s own semantics,
and the other writers (manager/setup) all held throughout. The round-2 fix: this record's LAYER 6 above
gained the explicit `unset`/`replace:true`-SUCCEEDS controls (both the already-`"acceptEdits"` and the
absent-mode seed) that the round-1 version never had. Verified RED→GREEN, tree restored byte-identical,
via `pnpm --filter @loom/daemon negative-control`.

**Scope ruling (lead decision, Loom manager gen 401):** the Code Reviewer separately asked whether a
stored `"bypassPermissions"` should be exempt from this guard's protection — e.g. if a human had set it,
should an agent be allowed to at least TIGHTEN it back toward `"acceptEdits"`, since that direction only
narrows the permission gate rather than widening it? Ruling: **no — ANY human-set stored mode is the
human's to change, `"bypassPermissions"` included.** An agent may not change or remove it in EITHER
direction, tighten or loosen: a human may have set `"bypassPermissions"` deliberately (e.g. a trusted,
fully-sandboxed project) and an agent silently tightening it back to `"acceptEdits"` is still an
unrequested, undisclosed change to a human's own decision, not a safety improvement the agent gets to make
unasked. This is already the CURRENT behaviour — `isHumanSetPermissionMode` was never scoped to
`"default"`/`"plan"` only, it is "anything outside `AGENT_PERMISSION_MODE_ALLOWLIST`", which already
includes a stored `"bypassPermissions"` — so this ruling changes no code, only the WORDING: every
tool-description sentence describing this guard (`orchestration.ts`'s `project_update`, both setup
descriptions, the elevated Lead's `project_configure`) now says "change or remove… in either direction,
tighten or loosen" and names a stored `"bypassPermissions"` explicitly, rather than the narrower "loosen"
framing the round-1 wording used.

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
- Do not treat `AGENT_PERMISSION_MODE_ALLOWLIST` alone as sufficient (card `d8f5de04`) — it gates only the
  VALUE an agent writes, never whether that write overwrites a *different* value already stored. Every
  agent-facing write/unset/replace path must also check `isHumanSetPermissionMode` against the EXISTING
  stored mode and REFUSE outright (never silently reshape) if the write/unset/replace would change or drop
  it — mirrors the write guard above, not the `permission.deny` additive-union guard.
- Do not add `permission.mode` to `HUMAN_ONLY_PROJECT_CONFIG_PATHS`/`HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS`
  as a shortcut for the `d8f5de04` guard above — those lists are unconditionally human-only BY KEY
  (`harness`, `orchestration.mergeGate`, …); this protection is conditional on the EXISTING STORED VALUE
  (an agent may still freely set `permission.mode` when nothing human-set is stored), so it needs its own
  `isHumanSetPermissionMode` check, not that list.
- Do not hand-copy `isHumanSetPermissionMode`/`humanSetPermissionModeRejectionMessage` elsewhere — all
  three write surfaces (manager `project_update`, setup `project_configure`/`project_update`, the elevated
  Lead `project_configure`) must import and call the same two exported symbols from `mcp/platform.ts`.
- Do not scope `isHumanSetPermissionMode` to exclude a stored `"bypassPermissions"` on the theory that an
  agent "tightening" it back toward `"acceptEdits"` is a safety improvement, not a violation (lead decision,
  Loom manager gen 401, card `d8f5de04`) — ANY human-set stored mode is the human's to change, including
  `"bypassPermissions"`; an agent may not change or remove it in EITHER direction, tighten or loosen.

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

Round-3 follow-up (card `d8f5de04`) additionally touches: `packages/daemon/src/mcp/platform.ts`
(`isHumanSetPermissionMode`, `humanSetPermissionModeRejectionMessage`, the elevated `project_configure`
route's write/unset/replace guard block), `packages/daemon/src/sessions/service.ts`
(`updateProjectStructural`'s write guard), `packages/daemon/src/mcp/setup.ts` (`project_configure`'s and
`project_update`'s write guards), and `packages/daemon/src/mcp/orchestration.ts` /
`packages/daemon/src/mcp/setup.ts` (tool-description wording) — plus LAYER 6 of
`packages/daemon/test/agent-permission-mode-default-plan-guard.mjs`.
