// Role-scoped interactive-prompt-tool disallow test (board card 8dd1dd1c). Deterministic, no daemon,
// no claude — asserts that a Loom-driven role (worker/setup/auditor/workspace-auditor/run) spawns with
// the human-prompt tools forbidden via `--disallowedTools`, while every out-of-scope role's argv stays
// BYTE-IDENTICAL. A worker that called AskUserQuestion blocked itself waiting on input that can never
// come from the human; this makes the prompt tools structurally un-callable for those roles.
// Run: node test/disallow-prompt-tools.mjs
import { buildSpawnArgs, disallowedToolsForRole, HUMAN_PROMPT_TOOLS } from "../dist/pty/host.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const mcpServers = { "loom-tasks": { type: "http", url: `http://127.0.0.1:${process.env.LOOM_PORT || 4317}/mcp/s1` } };

// --- The tool list itself ----------------------------------------------------------------------
check("HUMAN_PROMPT_TOOLS = AskUserQuestion + the two plan-mode prompts",
  JSON.stringify([...HUMAN_PROMPT_TOOLS]) === JSON.stringify(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]));

// --- Per-role mapping (disallowedToolsForRole) -------------------------------------------------
// IN scope: every Loom-driven, never-blocks-on-a-human role gets the full prompt-tool list.
// `run` is human-LESS (fully autonomous) — nobody can answer a prompt, so it joins the disallow class.
// `assistant` (the long-lived Companion) reaches its human over a CHAT channel + answers via chat_reply,
// so its stdin is never a live TUI human — an interactive prompt would block on input that never comes.
// `auditor` also carries the (separately-tested, in disallow-task-tools.mjs) task-tracking disallow, so
// its list is a SUPERSET of HUMAN_PROMPT_TOOLS rather than an exact match — checked via `includes` for
// every role here; the other five roles get the stronger exact-equality check since nothing else applies.
for (const role of ["worker", "setup", "auditor", "workspace-auditor", "run", "assistant"]) {
  check(`role '${role}': all human-prompt tools disallowed`,
    HUMAN_PROMPT_TOOLS.every((t) => disallowedToolsForRole(role).includes(t)));
}
for (const role of ["worker", "setup", "workspace-auditor", "run", "assistant"]) {
  check(`role '${role}': human-prompt disallow list is EXACTLY HUMAN_PROMPT_TOOLS (nothing else)`,
    JSON.stringify(disallowedToolsForRole(role)) === JSON.stringify([...HUMAN_PROMPT_TOOLS]));
}
// OUT of scope for the HUMAN-PROMPT disallow specifically: manager/orchestrator + the human-driven
// platform lead never get AskUserQuestion/ExitPlanMode/EnterPlanMode disallowed (a manager legitimately
// surfaces decisions to the human) — though manager/platform DO separately carry the task-tracking
// disallow (see disallow-task-tools.mjs); that's a disjoint concern this file doesn't assert on.
for (const role of ["manager", "platform"]) {
  check(`role '${role}': no HUMAN-PROMPT tool disallowed`,
    HUMAN_PROMPT_TOOLS.every((t) => !disallowedToolsForRole(role).includes(t)));
}
// A genuinely plain/role-less session gets NO disallow at all (neither concern applies).
for (const role of [null, undefined]) {
  check(`role '${String(role)}': NO disallow (left byte-identical)`,
    disallowedToolsForRole(role).length === 0);
}
// The returned array is a fresh COPY (a caller can't mutate the shared constant).
{
  const a = disallowedToolsForRole("worker");
  a.push("Mutated");
  check("disallowedToolsForRole returns a fresh array (no shared-state mutation)",
    disallowedToolsForRole("worker").length === HUMAN_PROMPT_TOOLS.length);
}

// --- buildSpawnArgs: the flag is emitted + ordered correctly -----------------------------------
{
  const tools = disallowedToolsForRole("worker");
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", disallowedTools: tools });
  const d = args.indexOf("--disallowedTools");
  const strict = args.indexOf("--strict-mcp-config");
  const cfg = args.indexOf("--mcp-config");
  const sep = args.indexOf("--");
  check("worker: `--disallowedTools` is present", d !== -1);
  check("worker: the three tool names follow the flag, in order",
    args[d + 1] === "AskUserQuestion" && args[d + 2] === "ExitPlanMode" && args[d + 3] === "EnterPlanMode");
  check("worker: `--disallowedTools` precedes `--strict-mcp-config` (its variadic is terminated by that flag)", d < strict && d + 4 === strict);
  check("worker: `--disallowedTools` follows `--permission-mode` (a real flag, mid-argv)", d > args.indexOf("--permission-mode"));
  check("worker: `--mcp-config` value still sits right before the `--` separator", cfg !== -1 && sep > cfg + 1 && sep === args.length - 2);
  check("worker: the prompt is still the LAST arg behind `--`", args[args.length - 2] === "--" && args[args.length - 1] === "build it");
  check("worker: every disallowed tool name precedes `--`", tools.every((t) => { const i = args.indexOf(t); return i !== -1 && i < sep; }));
}

// With a model pinned too, the flag slots between --model and --strict-mcp-config (both real flags, in order).
{
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "x", model: "claude-opus-4-8", disallowedTools: disallowedToolsForRole("auditor") });
  const m = args.indexOf("--model");
  const d = args.indexOf("--disallowedTools");
  const strict = args.indexOf("--strict-mcp-config");
  check("worker+model: order is --model … --disallowedTools … --strict-mcp-config", m < d && d < strict);
}

// --- Byte-identical proof for the off / out-of-scope path --------------------------------------
// A plain (role-less) session's argv (disallowedTools = []) must be byte-identical to the no-arg argv —
// and crucially to the SAME spawn with NO disallowedTools key at all. This is the additive-when-applicable
// invariant. (Manager is no longer a zero-disallow example — see disallow-task-tools.mjs.)
{
  const base = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it" });
  const plainTools = disallowedToolsForRole(null); // []
  const withEmpty = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", disallowedTools: plainTools });
  const withUndef = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", disallowedTools: undefined });
  check("plain/out-of-scope: NO `--disallowedTools` in argv", !withEmpty.includes("--disallowedTools"));
  check("empty disallow list: argv byte-identical to the no-arg argv", JSON.stringify(withEmpty) === JSON.stringify(base));
  check("undefined disallow: argv byte-identical to the no-arg argv", JSON.stringify(withUndef) === JSON.stringify(base));
  // And the worker argv differs from the plain argv ONLY by the inserted flag+names (4 extra tokens).
  const worker = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", disallowedTools: disallowedToolsForRole("worker") });
  check("worker argv = plain argv + exactly 4 inserted tokens (flag + 3 names)", worker.length === base.length + 4);
}

// Resume path (no prompt): the disallow still threads, --resume still leads, no `--` separator emitted.
{
  const args = buildSpawnArgs({ resumeId: "engine-123", settingsPath: "S", mode: "acceptEdits", mcpServers, disallowedTools: disallowedToolsForRole("worker") });
  check("resume worker: --resume <id> leads", args[0] === "--resume" && args[1] === "engine-123");
  check("resume worker: --disallowedTools present", args.includes("--disallowedTools"));
  check("resume worker: no `--` separator (no prompt)", !args.includes("--"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker/setup/auditor/workspace-auditor/run/assistant spawn with AskUserQuestion + Exit/EnterPlanMode disallowed; manager/platform get none of those (plain stays fully byte-identical). See disallow-task-tools.mjs for the separate task-tracking disallow."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
