# 3ad2b286 — the Lead's elevated `project_configure` grants deployCommand/python.interpreterPath/obsidian.path/raw sessionEnv too, not just gateCommand/alertWebhook

## Narrative

From the `74f27ab5` review (reviewer `a07ec5fc`): `mcp/platform.ts`'s elevated Platform-Lead `project_configure` validates a config PATCH through `validateProjectConfigOverride` — the FULL human/REST validator, not `validateAgentProjectConfigOverride` — because the platform role is HUMAN-EQUIVALENT (P3, trust boundary; `resolveRole` 404s a non-platform session before this tool is even reachable). The tool's own description, before this card, named only `orchestration.gateCommand`/`alertWebhook` (+ their timeouts) as the "elevated" keys the agent path rejects.

That was incomplete. The FULL validator also accepts, unmodified, every other field the agent-facing schema drops for being host-exec/host-launch capable:

- `orchestration.deployCommand` / `deployCommandTimeoutMs` — a per-project deploy command (design `13235b62`), host-exec by design, mirroring `gateCommand` exactly (see `confirmWorkerMerge`'s gate run and `deployOwnProject` in `sessions/service.ts`).
- `python.interpreterPath` — an arbitrary host Python interpreter the daemon spawns to build its shared venv (host-launch capable).
- `obsidian.path` — an arbitrary host executable the daemon-spawned Obsidian preflight launches (host-launch capable).
- raw `sessionEnv` — arbitrary environment variables that reach every future session this project spawns (an INTERNAL transport the human-only `python.interpreterPath`/`obsidian.path` rejections on the agent path rely on to not be bypassable — see `agentProjectConfigOverrideSchema`'s own doc in `mcp/platform.ts`).

None of these four is checked against `HUMAN_ONLY_PROJECT_CONFIG_KEYS`, `HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS`, or `NON_CLEARABLE_NESTED_PROJECT_CONFIG_KEYS` — those three lists gate `harness` (top-level), `orchestration.mergeGate`/`mergeGateInterval`/`permission.startupModeCycles` (nested), and `orchestration.gateCommand`'s non-clearability, respectively. All four of deployCommand/interpreterPath/obsidian.path/sessionEnv pass straight through the elevated route with no additional guard beyond the FULL validator's own bounds.

## Decision (gen 384)

This is intentional, not a gap to close: the Platform Lead surface is `LOOM_DEV`-only and human-driven (see `CLAUDE.md`'s `LOOM_DEV` section) — a Lead that already has `gateCommand`/`alertWebhook` host-exec capability crosses no NEW trust boundary by also being able to set a deploy command, point the shared Python venv or the Obsidian preflight at a different executable, or write raw session env vars. Widening `HUMAN_ONLY_PROJECT_CONFIG_KEYS`/`HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS` to cover these four would contradict the Lead's whole reason for existing on the full validator in the first place.

## Non-clearable guard check (same review, item 1 follow-up)

`NON_CLEARABLE_NESTED_PROJECT_CONFIG_KEYS` (today: `["orchestration.gateCommand"]`) exists because a blanked/dropped `gateCommand` silently falls back to the "no gateCommand configured" sentinel, which the merge gate then records as an unverified PASS with no warning — a Lead could otherwise neuter gate verification without anyone noticing.

Checked whether `orchestration.deployCommand` needs the same guard: it does not. `deploy_own_project`'s tool (`mcp/orchestration.ts`) is registered ONLY when `deployCommandConfigured` is true (a direct, truthy check on `resolveConfig(...).orchestration.deployCommand`); when absent/blank, the `deploy` tool is simply never registered for that session. There is no silent "unverified PASS" path for deploy the way there is for the gate — blanking/dropping `deployCommand` just visibly removes the capability. The guard's rationale (prevent a silent, unflagged integrity hole) does not transfer, so no guard was added.

## Do not

- Do not treat `project_configure`'s tool description as a closed/complete list of what the elevated route accepts without also checking `HUMAN_ONLY_PROJECT_CONFIG_KEYS` / `HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS` / `NON_CLEARABLE_NESTED_PROJECT_CONFIG_KEYS` directly in `mcp/platform.ts` — those three lists are the actual source of truth; the description is a derived summary that has already drifted once (card `b3a89191`, `a6f1b29b`).
- Do not add `orchestration.deployCommand` to `NON_CLEARABLE_NESTED_PROJECT_CONFIG_KEYS` on the assumption it needs gateCommand's guard — checked above; the silent-unverified-pass consequence that justifies gateCommand's guard does not exist for deploy.
- Do not widen `HUMAN_ONLY_PROJECT_CONFIG_KEYS` / `HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS` to cover deployCommand/python.interpreterPath/obsidian.path/sessionEnv — the Lead surface is LOOM_DEV-only and human-driven, so these are deliberately Lead-settable, not a security gap.

## Source

Card `3ad2b286`, from the `74f27ab5` review (reviewer `a07ec5fc`).
