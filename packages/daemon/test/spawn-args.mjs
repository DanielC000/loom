// buildSpawnArgs / argv-ordering test (PR H2). Deterministic, no daemon, no claude — asserts the
// startup/kickoff prompt is always positional behind a `--` end-of-options separator, so a prompt
// beginning with - / -- can't be parsed as a flag. Run: node test/spawn-args.mjs
import { buildSpawnArgs } from "../dist/pty/host.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const mcpServers = { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } };

// A kickoff prompt that STARTS WITH A DASH (the H2 footgun) must survive as positional text.
{
  const prompt = "--dangerously-do-a-thing then build the feature";
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: prompt });
  const sep = args.indexOf("--");
  check("dashed prompt: a `--` separator is present", sep !== -1);
  check("dashed prompt: the prompt is the LAST arg", args[args.length - 1] === prompt);
  check("dashed prompt: `--` immediately precedes the prompt", args[sep + 1] === prompt && sep === args.length - 2);
  check("dashed prompt: every real flag precedes `--`", args.slice(0, sep).includes("--mcp-config") && args.slice(0, sep).includes("--settings"));
  check("dashed prompt: only ONE `--` (the prompt isn't itself counted as a separator)", args.filter((a) => a === "--").length === 1);
}

// A normal prompt is positional too (consistent path).
{
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it" });
  check("normal prompt: behind `--`, last arg", args[args.length - 2] === "--" && args[args.length - 1] === "build it");
}

// No startup prompt (resume path) → no trailing `--`/positional, and --resume leads.
{
  const args = buildSpawnArgs({ resumeId: "engine-123", settingsPath: "S", mode: "acceptEdits", mcpServers });
  check("resume (no prompt): no `--` separator emitted", !args.includes("--"));
  check("resume (no prompt): --resume <id> leads", args[0] === "--resume" && args[1] === "engine-123");
  check("resume (no prompt): --mcp-config still present", args.includes("--mcp-config"));
}

// --mcp-config's value sits right before `--` (so the variadic is terminated by it, not by the prompt).
{
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "-x" });
  const cfg = args.indexOf("--mcp-config");
  check("--mcp-config value precedes the `--` separator", cfg !== -1 && args.indexOf("--") > cfg + 1);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — buildSpawnArgs puts the prompt last behind a `--` separator (dashed prompts stay positional), flags lead, resume omits the separator."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
