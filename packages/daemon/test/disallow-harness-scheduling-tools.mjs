// Role-scoped harness-self-scheduling-tool disallow test (board card 7a624213). Deterministic, no
// daemon, no claude — asserts that a Loom-driven role (worker/setup/auditor/workspace-auditor/assistant/
// manager) spawns with the harness's OWN self-scheduling / remote-trigger tools
// (ScheduleWakeup/CronCreate/CronDelete/CronList/RemoteTrigger) forbidden via `--disallowedTools`, while
// every out-of-scope role's argv on THIS dimension stays BYTE-IDENTICAL. A worker's `ScheduleWakeup` tick
// delivered the harness's own autonomous-`/loop` mandate into a session whose only real instructions come
// from its manager, colliding with a queued `worker_message` at the same idle boundary — this makes the
// harness scheduler structurally unreachable for a Loom-driven role. See HARNESS_SCHEDULING_TOOLS's own
// doc comment (pty/host.ts) for the full role-scope + codex-parity rationale, and
// disallow-harness-scheduling-tools-real-spawn.mjs for the real-spawn proof that a real claude actually
// honors this (this file only proves the pure argv-construction layer).
// Run: node test/disallow-harness-scheduling-tools.mjs
import { buildSpawnArgs, disallowedToolsForRole, HARNESS_SCHEDULING_TOOLS, HUMAN_PROMPT_TOOLS, TASK_TRACKING_TOOLS } from "../dist/pty/host.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const mcpServers = { "loom-tasks": { type: "http", url: `http://127.0.0.1:${process.env.LOOM_PORT || 4317}/mcp/s1` } };

// --- The tool list itself ----------------------------------------------------------------------
check("HARNESS_SCHEDULING_TOOLS = ScheduleWakeup + the Cron trio + RemoteTrigger",
  JSON.stringify([...HARNESS_SCHEDULING_TOOLS]) ===
    JSON.stringify(["ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "RemoteTrigger"]));

// --- Per-role mapping (disallowedToolsForRole) -------------------------------------------------
// IN scope: every Loom-driven role whose stdin is never a live human, PLUS manager (its own idle loop
// runs entirely on idle_report/wake_me, never a harness tick — see HARNESS_SCHEDULING_TOOLS's own doc).
for (const role of ["worker", "setup", "auditor", "workspace-auditor", "assistant", "manager"]) {
  check(`role '${role}': every harness-scheduling tool disallowed`,
    HARNESS_SCHEDULING_TOOLS.every((t) => disallowedToolsForRole(role).includes(t)));
}
// OUT of scope, each for its own stated reason (see HARNESS_SCHEDULING_TOOLS's own doc):
//   platform  — the human-driven Platform Lead (owner-interactive, not Loom-driven)
//   run       — an ephemeral, owner-triggered Agent Run with no idle boundary for a tick to collide with
//   operator  — human-spawned-only; untouched by either existing disallow switch, a deliberate consistency call
//   null/undef — a plain/role-less owner-interactive terminal, where /loop is a legitimate owner feature
for (const role of ["platform", "run", "operator", null, undefined]) {
  check(`role '${String(role)}': NO harness-scheduling tool disallowed (byte-identical on this dimension)`,
    HARNESS_SCHEDULING_TOOLS.every((t) => !disallowedToolsForRole(role).includes(t)));
}

// --- Exact composition per role: harness-scheduling rides LAST in the union (human-prompt, then
// task-tracking, then harness-scheduling — see disallowedToolsForRole's own switch order) -------------
check("role 'worker': EXACTLY human-prompt + harness-scheduling (no task-tracking)",
  JSON.stringify(disallowedToolsForRole("worker")) === JSON.stringify([...HUMAN_PROMPT_TOOLS, ...HARNESS_SCHEDULING_TOOLS]));
check("role 'manager': EXACTLY task-tracking + harness-scheduling (no human-prompt)",
  JSON.stringify(disallowedToolsForRole("manager")) === JSON.stringify([...TASK_TRACKING_TOOLS, ...HARNESS_SCHEDULING_TOOLS]));
check("role 'auditor': EXACTLY human-prompt + task-tracking + harness-scheduling (all three)",
  JSON.stringify(disallowedToolsForRole("auditor")) ===
    JSON.stringify([...HUMAN_PROMPT_TOOLS, ...TASK_TRACKING_TOOLS, ...HARNESS_SCHEDULING_TOOLS]));
check("role 'run': EXACTLY human-prompt (harness-scheduling deliberately excluded)",
  JSON.stringify(disallowedToolsForRole("run")) === JSON.stringify([...HUMAN_PROMPT_TOOLS]));
check("role 'platform': EXACTLY task-tracking (harness-scheduling deliberately excluded)",
  JSON.stringify(disallowedToolsForRole("platform")) === JSON.stringify([...TASK_TRACKING_TOOLS]));

// The returned array is a fresh COPY (a caller can't mutate the shared constant).
{
  const a = disallowedToolsForRole("worker");
  a.push("Mutated");
  check("disallowedToolsForRole returns a fresh array (no shared-state mutation)",
    disallowedToolsForRole("worker").length === HUMAN_PROMPT_TOOLS.length + HARNESS_SCHEDULING_TOOLS.length);
}

// --- buildSpawnArgs: the flag is emitted + ordered correctly, on a role with ONLY this dimension -------
// `manager` carries task-tracking + harness-scheduling and NOTHING else, so its argv isolates the
// harness-scheduling tokens' own position cleanly (worker/auditor also carry human-prompt tokens ahead of
// them — already covered by disallow-prompt-tools.mjs/disallow-task-tools.mjs's own ordering checks).
{
  const tools = disallowedToolsForRole("manager");
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "lead it", disallowedTools: tools });
  const d = args.indexOf("--disallowedTools");
  const strict = args.indexOf("--strict-mcp-config");
  const cfg = args.indexOf("--mcp-config");
  check("manager: `--disallowedTools` is present", d !== -1);
  check("manager: the five harness-scheduling tool names follow the six task-tracking ones, in order",
    HARNESS_SCHEDULING_TOOLS.every((name, i) => args[d + 1 + TASK_TRACKING_TOOLS.length + i] === name));
  check("manager: `--disallowedTools` precedes `--strict-mcp-config` (its variadic is terminated by that flag, no new flag inserted)", d < strict && d + 1 + tools.length === strict);
  check("manager: `--disallowedTools` follows `--permission-mode` (a real flag, mid-argv)", d > args.indexOf("--permission-mode"));
  check("manager: `--mcp-config` value is the last real flag (no `--`/prompt trailing it — the prompt never rides argv)", cfg !== -1 && args.length - 1 === cfg + 1);
  check("manager: no `--` separator (the prompt never rides argv)", !args.includes("--"));
  check("manager: every disallowed tool name precedes `--mcp-config`", tools.every((t) => { const i = args.indexOf(t); return i !== -1 && i < cfg; }));
}

// --- Byte-identical proof for the out-of-scope path ---------------------------------------------
// platform's argv (task-tracking disallow only) must contain NONE of the harness-scheduling tool names.
{
  const platformArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "lead it", disallowedTools: disallowedToolsForRole("platform") });
  check("platform argv: contains no harness-scheduling tool name", HARNESS_SCHEDULING_TOOLS.every((t) => !platformArgs.includes(t)));
  const runArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "run it", disallowedTools: disallowedToolsForRole("run") });
  check("run argv: contains no harness-scheduling tool name", HARNESS_SCHEDULING_TOOLS.every((t) => !runArgs.includes(t)));
  const plainArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "x", disallowedTools: disallowedToolsForRole(null) });
  check("plain argv: NO `--disallowedTools` at all", !plainArgs.includes("--disallowedTools"));
}

// Resume path (no prompt): the harness-scheduling disallow still threads for a resumed worker/manager.
{
  const args = buildSpawnArgs({ resumeId: "engine-789", settingsPath: "S", mode: "acceptEdits", mcpServers, disallowedTools: disallowedToolsForRole("manager") });
  check("resume manager: --resume <id> leads", args[0] === "--resume" && args[1] === "engine-789");
  check("resume manager: --disallowedTools present with the harness-scheduling tools", HARNESS_SCHEDULING_TOOLS.every((t) => args.includes(t)));
  check("resume manager: no `--` separator (no prompt)", !args.includes("--"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker/setup/auditor/workspace-auditor/assistant/manager spawn with ScheduleWakeup/CronCreate/CronDelete/CronList/RemoteTrigger disallowed, riding the SAME --disallowedTools flag (no new flag, no argv position change); platform/run/operator/plain stay byte-identical on this dimension. See disallow-harness-scheduling-tools-real-spawn.mjs for the real-spawn proof."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
