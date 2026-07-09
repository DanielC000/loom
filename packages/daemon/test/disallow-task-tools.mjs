// Board-driven-role task-tracking-tool disallow test (Platform card 33f9f181). Deterministic, no daemon,
// no claude — asserts that a board-driven role (manager/platform/auditor) spawns with the engine's NATIVE
// TaskCreate/TaskGet/TaskList/TaskOutput/TaskStop/TaskUpdate tools forbidden via `--disallowedTools`, so
// the harness has no reason to inject its recurring "task tools haven't been used recently…"
// `<system-reminder>` — pure noise for a role whose real task surface is the `mcp__loom-tasks__tasks_*`
// board (a disjoint tool namespace, untouched by this disallow). Every out-of-scope role's argv on THIS
// dimension stays BYTE-IDENTICAL. See disallow-prompt-tools.mjs for the separate human-prompt disallow
// (auditor carries BOTH; manager/platform carry ONLY this one).
// Run: node test/disallow-task-tools.mjs
import { buildSpawnArgs, disallowedToolsForRole, TASK_TRACKING_TOOLS, HUMAN_PROMPT_TOOLS } from "../dist/pty/host.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const mcpServers = { "loom-tasks": { type: "http", url: `http://127.0.0.1:${process.env.LOOM_PORT || 4317}/mcp/s1` } };

// --- The tool list itself ----------------------------------------------------------------------
check("TASK_TRACKING_TOOLS = the six native Task* tools (NOT the mcp__loom-tasks__tasks_* board tools)",
  JSON.stringify([...TASK_TRACKING_TOOLS]) ===
    JSON.stringify(["TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate"]));

// --- Per-role mapping (disallowedToolsForRole) -------------------------------------------------
// IN scope: the board-driven roles — their real task surface is the loom-tasks MCP board, so the native
// Task tools are pure noise (the recurring reminder is gated on their availability, not on tool schemas
// having been loaded — see host.ts's TASK_TRACKING_TOOLS doc comment).
for (const role of ["manager", "platform", "auditor"]) {
  check(`role '${role}': every task-tracking tool disallowed`,
    TASK_TRACKING_TOOLS.every((t) => disallowedToolsForRole(role).includes(t)));
}
// `auditor` carries BOTH concerns — the human-prompt disallow (it's Loom-driven, never blocks on a human)
// AND the task-tracking disallow (it's board-driven) — unioned into one list.
check("role 'auditor': carries BOTH human-prompt AND task-tracking disallow",
  JSON.stringify(disallowedToolsForRole("auditor")) ===
    JSON.stringify([...HUMAN_PROMPT_TOOLS, ...TASK_TRACKING_TOOLS]));
// manager/platform carry ONLY the task-tracking disallow (never human-prompt — see disallow-prompt-tools.mjs).
for (const role of ["manager", "platform"]) {
  check(`role '${role}': task-tracking disallow ONLY (no human-prompt tools)`,
    JSON.stringify(disallowedToolsForRole(role)) === JSON.stringify([...TASK_TRACKING_TOOLS]));
}

// OUT of scope: every role whose real task surface isn't the board the same way — worker/setup/
// workspace-auditor/run/assistant (Loom-driven, human-prompt-disallowed, but NOT task-tracking-disallowed)
// plus plain (null/undefined). NO task-tracking tool ever appears in their disallow list.
for (const role of ["worker", "setup", "workspace-auditor", "run", "assistant", null, undefined]) {
  check(`role '${String(role)}': NO task-tracking tool disallowed (byte-identical on this dimension)`,
    TASK_TRACKING_TOOLS.every((t) => !disallowedToolsForRole(role).includes(t)));
}

// --- buildSpawnArgs: the flag is emitted + ordered correctly, board-driven roles -----------------
{
  const tools = disallowedToolsForRole("manager");
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "lead it", disallowedTools: tools });
  const d = args.indexOf("--disallowedTools");
  const strict = args.indexOf("--strict-mcp-config");
  const cfg = args.indexOf("--mcp-config");
  const sep = args.indexOf("--");
  check("manager: `--disallowedTools` is present", d !== -1);
  check("manager: the six tool names follow the flag, in order",
    ["TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate"]
      .every((name, i) => args[d + 1 + i] === name));
  check("manager: `--disallowedTools` precedes `--strict-mcp-config` (its variadic is terminated by that flag)", d < strict && d + 7 === strict);
  check("manager: `--mcp-config` value still sits right before the `--` separator", cfg !== -1 && sep > cfg + 1 && sep === args.length - 2);
  check("manager: the prompt is still the LAST arg behind `--`", args[args.length - 2] === "--" && args[args.length - 1] === "lead it");
}

// --- Byte-identical proof for the out-of-scope path ---------------------------------------------
// worker's argv (human-prompt disallow only) must contain NONE of the task-tracking tool names.
{
  const workerArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", disallowedTools: disallowedToolsForRole("worker") });
  check("worker argv: contains no task-tracking tool name", TASK_TRACKING_TOOLS.every((t) => !workerArgs.includes(t)));
  const plainArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", disallowedTools: disallowedToolsForRole(null) });
  check("plain argv: NO `--disallowedTools` at all", !plainArgs.includes("--disallowedTools"));
}

// Resume path (no prompt): the task-tracking disallow still threads for a resumed manager/platform/auditor.
{
  const args = buildSpawnArgs({ resumeId: "engine-456", settingsPath: "S", mode: "acceptEdits", mcpServers, disallowedTools: disallowedToolsForRole("platform") });
  check("resume platform: --resume <id> leads", args[0] === "--resume" && args[1] === "engine-456");
  check("resume platform: --disallowedTools present with the task-tracking tools", TASK_TRACKING_TOOLS.every((t) => args.includes(t)));
  check("resume platform: no `--` separator (no prompt)", !args.includes("--"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — manager/platform/auditor spawn with the native Task* tools disallowed (auditor also keeps its human-prompt disallow); worker/setup/workspace-auditor/run/assistant/plain stay byte-identical on this dimension."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
