/**
 * THE canonical role-refusal check for spawning a session via an AGENT-facing tool (never human REST,
 * which carries no such restriction). THREE agent-facing surfaces mint sessions this way: the Platform
 * Lead's own `session_spawn` (this file's own directory, `mcp/platform.ts`), the companion
 * `session-spawn` lever (`companion/capabilities.ts`, Tier X, manager|plain ONLY), and the ungated Setup
 * Assistant's own `session_spawn` (`mcp/setup.ts`) — all three must refuse the EXACT same role set with
 * the EXACT same error text, so none of them can drift apart on Loom's self-elevation guard (setup.ts's
 * own inline copy had already drifted — "human-REST/boot-only" vs this helper's "human-REST-only",
 * missing "/operator", missing the manager-job clause — before it was folded onto this helper). Only
 * "manager" or "plain" may ever be minted this way: never "platform" (human-REST-only — no
 * self-elevation) and never "worker" (a worker needs a manager parent + a task, which stays a manager's
 * orchestration job) — nor anything else.
 *
 * Returns the {error} string for a disallowed role, or `null` when `role` is allowed.
 */
export function spawnableRoleError(role: string): string | null {
  if (role === "manager" || role === "plain") return null;
  return `session_spawn refuses role "${role}" — only "manager" or "plain" may be spawned here. ` +
    "A platform/auditor/setup/operator session is human-REST-only (no self-elevation) and a worker requires a manager parent + task (a manager's orchestration job).";
}
