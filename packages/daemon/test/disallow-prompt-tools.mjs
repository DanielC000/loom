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
for (const role of ["worker", "setup", "auditor", "workspace-auditor", "run"]) {
  check(`role '${role}': all human-prompt tools disallowed`,
    JSON.stringify(disallowedToolsForRole(role)) === JSON.stringify([...HUMAN_PROMPT_TOOLS]));
}
// OUT of scope: manager/orchestrator + the human-driven platform lead, plus plain (null/undefined)
// — no disallow at all (a manager legitimately surfaces decisions to the human).
for (const role of ["manager", "platform", null, undefined]) {
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
// A manager's argv (disallowedTools = []) must be byte-identical to the no-arg argv — and crucially to
// the SAME spawn with NO disallowedTools key at all. This is the additive-when-applicable invariant.
{
  const base = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it" });
  const managerTools = disallowedToolsForRole("manager"); // []
  const withEmpty = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", disallowedTools: managerTools });
  const withUndef = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", disallowedTools: undefined });
  check("manager/out-of-scope: NO `--disallowedTools` in argv", !withEmpty.includes("--disallowedTools"));
  check("empty disallow list: argv byte-identical to the no-arg argv", JSON.stringify(withEmpty) === JSON.stringify(base));
  check("undefined disallow: argv byte-identical to the no-arg argv", JSON.stringify(withUndef) === JSON.stringify(base));
  // And the worker argv differs from the manager argv ONLY by the inserted flag+names (4 extra tokens).
  const worker = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", disallowedTools: disallowedToolsForRole("worker") });
  check("worker argv = manager argv + exactly 4 inserted tokens (flag + 3 names)", worker.length === base.length + 4);
}

// Resume path (no prompt): the disallow still threads, --resume still leads, no `--` separator emitted.
{
  const args = buildSpawnArgs({ resumeId: "engine-123", settingsPath: "S", mode: "acceptEdits", mcpServers, disallowedTools: disallowedToolsForRole("worker") });
  check("resume worker: --resume <id> leads", args[0] === "--resume" && args[1] === "engine-123");
  check("resume worker: --disallowedTools present", args.includes("--disallowedTools"));
  check("resume worker: no `--` separator (no prompt)", !args.includes("--"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker/setup/auditor/workspace-auditor/run spawn with AskUserQuestion + Exit/EnterPlanMode disallowed; manager/platform/plain stay byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
