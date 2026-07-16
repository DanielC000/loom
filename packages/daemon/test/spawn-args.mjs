// buildSpawnArgs / argv-ordering test (PR H2). Deterministic, no daemon, no claude — asserts the
// startup/kickoff prompt is always positional behind a `--` end-of-options separator, so a prompt
// beginning with - / -- can't be parsed as a flag. Run: node test/spawn-args.mjs
import { buildSpawnArgs } from "../dist/pty/host.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const mcpServers = { "loom-tasks": { type: "http", url: `http://127.0.0.1:${process.env.LOOM_PORT || 4317}/mcp/s1` } };

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

// --- Profile-pinned model (Phase-3) -------------------------------------------------------------
// A model set → `--model <id>` is emitted as a real flag (precedes `--`), right after --permission-mode.
{
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", model: "claude-opus-4-8" });
  const m = args.indexOf("--model");
  const sep = args.indexOf("--");
  check("model set: `--model` is present", m !== -1);
  check("model set: `--model` is immediately followed by the id", args[m + 1] === "claude-opus-4-8");
  check("model set: `--model` precedes the `--` separator (it's a real flag)", m < sep);
  check("model set: `--model` follows `--permission-mode`", m > args.indexOf("--permission-mode"));
  check("model set: the prompt is still the LAST arg behind `--`", args[args.length - 2] === "--" && args[args.length - 1] === "build it");
}
// Model NULL / OMITTED → byte-identical to today: NO `--model` anywhere. Asserted against the existing
// no-model argv so a regression that always-emits `--model` is caught.
{
  const base = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it" });
  const withUndef = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", model: undefined });
  const withEmpty = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", model: "" });
  check("model omitted: no `--model` in argv", !base.includes("--model"));
  check("model undefined: argv is byte-identical to the no-model argv", JSON.stringify(withUndef) === JSON.stringify(base));
  check("model empty-string: treated as engine default — no `--model`, byte-identical", JSON.stringify(withEmpty) === JSON.stringify(base));
}
// Resume path with a model would be a contradiction (resume inherits the transcript's model), but assert
// the flag still threads cleanly if ever passed: --resume leads, --model is present, no positional prompt.
{
  const args = buildSpawnArgs({ resumeId: "engine-123", settingsPath: "S", mode: "acceptEdits", mcpServers, model: "claude-sonnet-4-6" });
  check("resume + model: --resume still leads", args[0] === "--resume" && args[1] === "engine-123");
  check("resume + model: --model <id> present", args[args.indexOf("--model") + 1] === "claude-sonnet-4-6");
  check("resume + model: no `--` separator (no prompt)", !args.includes("--"));
}

// Fork: with resumeId, --fork-session follows --resume <id>, then --session-id pre-assigns the fork's id.
{
  const args = buildSpawnArgs({ resumeId: "engine-123", fork: true, forkSessionId: "new-456", settingsPath: "S", mode: "acceptEdits", mcpServers });
  check("fork: --resume <src> leads, then --fork-session --session-id <new>",
    args[0] === "--resume" && args[1] === "engine-123" && args[2] === "--fork-session" && args[3] === "--session-id" && args[4] === "new-456");
}
// Fork flag is inert without a resume target (nothing to fork from) → no --fork-session emitted.
{
  const args = buildSpawnArgs({ fork: true, settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it" });
  check("fork without resumeId: no --fork-session (nothing to fork from)", !args.includes("--fork-session"));
}

// --- Session naming (card f9b47cd1) — `-n <name>` ------------------------------------------------
// buildSpawnArgs itself does NO version-gating (that happens once, at the createPty chokepoint, on the
// installed claude version) — it just emits `-n <name>` when the caller passes one. These tests exercise
// that pure emission/placement/omission contract.
{
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", sessionName: "loom-loom-dev-fix-thing" });
  const n = args.indexOf("-n");
  const sep = args.indexOf("--");
  const cfg = args.indexOf("--mcp-config");
  check("sessionName set: `-n` is present", n !== -1);
  check("sessionName set: `-n` is immediately followed by the name", args[n + 1] === "loom-loom-dev-fix-thing");
  check("sessionName set: `-n` precedes the `--` separator (it's a real flag)", n < sep);
  check("sessionName set: `-n` precedes `--strict-mcp-config`/`--mcp-config` (H2 ordering)", n < cfg);
  check("sessionName set: the prompt is still the LAST arg behind `--`", args[args.length - 2] === "--" && args[args.length - 1] === "build it");
}
// Omitted/undefined/empty ⇒ byte-identical to before this option existed: NO `-n` anywhere.
{
  const base = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it" });
  const withUndef = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", sessionName: undefined });
  const withEmpty = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", sessionName: "" });
  check("sessionName omitted: no `-n` in argv", !base.includes("-n"));
  check("sessionName undefined: argv is byte-identical to the no-name argv", JSON.stringify(withUndef) === JSON.stringify(base));
  check("sessionName empty-string: treated as absent — byte-identical, no `-n`", JSON.stringify(withEmpty) === JSON.stringify(base));
}
// Both `--model` and `-n` set together: both present, in the documented relative order (model, then the
// role disallow list if any, then sessionName, then --strict-mcp-config).
{
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", model: "claude-opus-4-8", sessionName: "loom-loom-mgr" });
  check("model + sessionName: --model precedes -n", args.indexOf("--model") < args.indexOf("-n"));
  check("model + sessionName: -n precedes --mcp-config", args.indexOf("-n") < args.indexOf("--mcp-config"));
}
// A resume/fork spawn CAN still thread sessionName through this pure function if a caller passed one
// (the real caller — createPty via sessions/service.ts — never does on resume/fork; this just asserts
// buildSpawnArgs itself imposes no such restriction, keeping the two concerns separate).
{
  const args = buildSpawnArgs({ resumeId: "engine-123", settingsPath: "S", mode: "acceptEdits", mcpServers, sessionName: "loom-loom-mgr" });
  check("resume + sessionName (hypothetical): -n still emitted correctly", args[args.indexOf("-n") + 1] === "loom-loom-mgr");
  check("resume + sessionName (hypothetical): still no `--` separator (no prompt)", !args.includes("--"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — buildSpawnArgs puts the prompt last behind a `--` separator (dashed prompts stay positional), flags lead, resume omits the separator, --fork-session follows --resume, --model is emitted iff a profile pins one (null/empty ⇒ byte-identical, no --model), and -n <name> emits/omits the same way (byte-identical when absent, always ahead of --mcp-config)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
