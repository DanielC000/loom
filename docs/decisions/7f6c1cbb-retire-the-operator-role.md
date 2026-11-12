# 7f6c1cbb — retire the Operator role (`loom-operator`), with a boot migration

Owner decision 2026-11-12: retire it in TypeScript now (the owner had already marked it drop, feature-inventory row A06).

## Why

The role was unreachable and had become superseded and risky: `platform.operatorEnabled` defaults off, the web client cannot spawn role `operator`, `profileSpawnRole` clamps an operator profile to a plain session, the seeded agent lived in the LOOM_HOME-bound Platform home where every git write is refused, and since f437d4e9 the Platform Lead has the same `git_*` and `vault_write` tools. Its `git_checkout` bypassed every `project_checkout_branch` refusal and the watermark, and codex auto-approved its tools (90dc3c8c).

## What was removed

`mcp/operator.ts` and the `/mcp-operator` gateway mount; the `buildMcpServers` attach and allowlist; `LOOM_OPERATOR_SERVER_ID` (and its entries in `LOOM_FIRST_PARTY_SERVER_IDS` / `CODEX_AUTO_APPROVE_MCP_SERVER_IDS`); `startOperator` and the `role:"operator"` branch of `POST /api/agents/:id/sessions` (that role value is now a 400); `platform.operatorEnabled` and `OPERATOR_ENABLED_DEFAULT`; the Settings panel; `seedOperatorAgent` and its seed-on-flip hook; the bundled "Elevated Operator" profile; `"operator"` in `SESSION_ROLES` and `PROFILE_ROLE_SCHEMA`; the promptLint `OPERATOR_TOOLS` table; the web role-display card; `seededAgentIds.operator` on the setup-home response; and the four operator tests.

## The migration (`setup/retire-operator.ts`, called from boot in `index.ts`)

An install that ran the old code can hold four kinds of leftovers. All handling is idempotent and lives in that one file; a throw is logged and never gates boot.

1. **Stored `operatorEnabled` config key.** The platform-config validators are `.strict()`, so a stored unknown key would 400 every later PATCH. Decision: **accept-and-ignore on read, persist the strip at boot.** `RETIRED_PLATFORM_CONFIG_KEYS` / `stripRetiredPlatformConfigKeys` (shared) are applied inside `Db.getPlatformConfig()`, and the boot step rewrites the stored blob without the key. A NEW write naming the key is rejected like any unknown key. A corrupt blob is never overwritten.
2. **Operator-role session rows** become plain (`role` NULL). They are history; the surface they used is gone.
3. **The seeded agent**, found by its id marker `setup.operatorAgentId` only (never by name, so a human's same-named agent is never touched): **deleted when pristine** (startup prompt byte-identical to a shipped value, bound to the pristine seeded profile or to nothing, no session history, not an API endpoint); **otherwise kept untouched**. The marker and its one-shot name-migration sentinel are always removed.
4. **Profiles still carrying role `operator`**: **deleted only when it is the pristine seeded rig** (equal to its own seed snapshot) **and no surviving agent is bound to it**; every other one, including a user-made operator-role profile, has its role set to plain (NULL) and is kept with its name, description, skills and model untouched.

Never delete anything a user customized. A profile is "pristine" when it is still named "Elevated Operator" and equals its OWN stored seed snapshot (`base_snapshot`, via `profileEqualsOwnBaseSnapshot` in `profiles/customization.ts`, the customization engine's own comparison). Hardcoded shipped constants were tried first and wrongly kept a real owner's untouched profile, because later default migrations had rewritten `model`/`harness`. A missing snapshot reads as customized (kept). The agent's prompt is still compared to the shipped prompt texts, which were never rewritten.

## Do not

- Do not re-add `operator` to `SESSION_ROLES` / `PROFILE_ROLE_SCHEMA` without re-reading the removal rationale above; a stored role value of `operator` is only ever read by the migration.
- Do not match the seeded agent by name in the migration, and do not delete a profile that any agent still uses.
- Do not drop the read-time strip in `Db.getPlatformConfig()` on the grounds that the boot step persists it: the strict validators would reject the stored key between an upgrade and the first boot-step run.
- Do not remove the retired key from `RETIRED_PLATFORM_CONFIG_KEYS` once a different feature reuses its name without migrating first.

## Verification

`packages/daemon/test/retire-operator-migration.mjs` builds the legacy state in real on-disk SQLite files under a temp LOOM_HOME, reopens them on the new code, and asserts the four cases above plus idempotency and the corrupt-blob guard. It does not cover a DB copied from a real pre-migration install (workers never touch `~/.loom`); the lead is asked to run that aggregate check.
