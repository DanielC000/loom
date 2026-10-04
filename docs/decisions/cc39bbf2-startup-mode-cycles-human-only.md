# cc39bbf2 — `permission.startupModeCycles` is HUMAN-only, never agent-writable

## Narrative

`startupModeCycles` was declared on the shared `PermissionPolicy` type (`packages/shared/src/config.ts`)
but absent from `permissionOverride`'s `.strict()` validator shape — so a stored config carrying it would
400 on any config PATCH that tried to set it, on every surface, human included. It is not dead: it drives
`pty/host.ts`'s `computeBootMode`/`resolveModeTarget` fallback climb (for any boot target that isn't
directly expressible as a `--permission-mode` flag value) and the resume/auto-heal convergence target via
`modeAfterCyclesFromAcceptEdits`. Card 51926260 (the direct-boot optimization) narrowed its role but did
not retire it.

The field tunes a value that's version-sensitive to the real `claude` CLI's own Shift+Tab cycle order
(see the field's own doc comment in `config.ts`) — moving it changes the boot-mode behavior of EVERY
future session a project spawns, not one worker's live mode. That makes it the same trust class as
`gateCommand`/`harness`/`obsidian.path`/`python.interpreterPath`: a knob a human may legitimately want to
retune (e.g. after a CLI update reorders the cycle), but never one an agent should be able to retune
silently out from under every session the project boots.

Fix: add `startupModeCycles: z.number().int().min(0).max(20).optional()` to `permissionOverride` ONLY —
never to `agentPermissionOverride`, which is a separately-declared object, not derived from
`permissionOverride` via `.omit()`. That makes it settable via the REST config PATCH / Settings UI (and
`project_create`, which shares the same full validator), while it stays a `.strict()`-rejected unknown key
on every agent-facing `project_configure` variant (manager/worker core MCP, the setup-assistant router).
The elevated Platform Lead `project_configure` reuses the FULL human validator though (see
`validateProjectConfigOverride` at that route), so it would otherwise accept the field too — closed by
adding `"permission.startupModeCycles"` to `HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS`, which the Lead route
already checks on both the SET path (line ~1500) and the unset/replace-drop path (line ~1508), mirroring
`orchestration.mergeGate`/`mergeGateInterval`.

Bound chosen as 0-20: `modeAfterCyclesFromAcceptEdits` already modulo-wraps any integer safely (no crash
risk from an out-of-range stored value), but a tight bound still rejects a fat-fingered value at the API
edge rather than storing it silently. 20 is well past the current 4-entry cycle length, leaving headroom
for the CLI adding modes before the bound itself needs revisiting.

No Settings UI change was needed: the UI never had a control for this field (only `permission.allow` is
editable there), and since card 65aa951c the config form builds a delta rather than cloning the stored
override, so there is nothing left to echo back into a save. A stored row already carrying the field
(today, only ever written by daemon test fixtures via the unvalidated `db.setProjectConfig` helper) is
tolerated, not stripped or rejected: `mergeConfigOverride`'s deep-merge only validates the incoming PATCH
delta, never re-validates the merged whole, so a legacy value survives untouched until an explicit write
replaces it.

## Do not

- Do not add `startupModeCycles` to `agentPermissionOverride` or any other agent-facing permission schema
  — it is a project-wide boot-time default, not a single worker's live mode; the blast radius of letting
  an agent retune it is every future session the project spawns.
- Do not drop `"permission.startupModeCycles"` from `HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS` — the elevated
  Platform Lead `project_configure` reuses the FULL human validator and would otherwise accept (and be
  able to clear) this field with no further guard.
- Do not treat the 0-20 bound as a safety requirement for `modeAfterCyclesFromAcceptEdits` itself — that
  function already wraps any integer safely. The bound exists to reject obviously-wrong input at the API
  edge, not to prevent a crash.

## Source

`packages/daemon/src/mcp/platform.ts` (`permissionOverride`, `agentPermissionOverride`,
`HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS`). Board card `cc39bbf2`, discovered from card `654869e2`.
