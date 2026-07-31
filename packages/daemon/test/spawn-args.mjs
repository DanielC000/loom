// buildSpawnArgs / argv-ordering test. Deterministic, no daemon, no claude — asserts flag ordering AND
// (card 0050a17e) that `startupPrompt` is accepted for API convenience but is NEVER emitted into argv,
// for ANY input (dash-prefixed, huge, empty, or omitted) — closing the Windows command-line ceiling this
// used to create (a large agent brief + kickoff could blow through CreateProcess's 32766-char limit and
// refuse the spawn outright). The prompt now rides to the engine post-ready via submit() instead (see
// pty/host.ts's scheduleKickoffGuarantee). Run: node test/spawn-args.mjs
import { buildSpawnArgs } from "../dist/pty/host.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const mcpServers = { "loom-tasks": { type: "http", url: `http://127.0.0.1:${process.env.LOOM_PORT || 4317}/mcp/s1` } };

// A startupPrompt that STARTS WITH A DASH (the old H2 footgun, back when it rode positionally) must have
// NO effect on argv at all now — no `--` separator, no trace of its text anywhere in args.
{
  const prompt = "--dangerously-do-a-thing then build the feature";
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: prompt });
  check("dashed prompt: no `--` separator emitted", !args.includes("--"));
  check("dashed prompt: the prompt text does not appear anywhere in argv", !args.includes(prompt));
  check("dashed prompt: every real flag is still present", args.includes("--mcp-config") && args.includes("--settings"));
}

// A normal prompt: same — never rides argv.
{
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it" });
  check("normal prompt: not present anywhere in argv", !args.includes("build it"));
  check("normal prompt: no `--` separator", !args.includes("--"));
}

// A HUGE prompt (the actual incident shape — a large agent brief + kickoff) must have ZERO effect on the
// composed argv length: with vs without it, argv is byte-identical.
{
  const huge = "K".repeat(100_000);
  const withHuge = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: huge });
  const without = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers });
  check("huge prompt: argv is byte-identical to no-prompt argv (the prompt contributes NOTHING to argv)",
    JSON.stringify(withHuge) === JSON.stringify(without));
}

// No startup prompt (resume path) → no trailing `--`/positional, and --resume leads. Byte-identical
// behavior to a fresh spawn WITH a prompt, now that the prompt never touches argv either way.
{
  const args = buildSpawnArgs({ resumeId: "engine-123", settingsPath: "S", mode: "acceptEdits", mcpServers });
  check("resume (no prompt): no `--` separator emitted", !args.includes("--"));
  check("resume (no prompt): --resume <id> leads", args[0] === "--resume" && args[1] === "engine-123");
  check("resume (no prompt): --mcp-config still present", args.includes("--mcp-config"));
}

// --mcp-config's value is the LAST thing on argv now that there's no positional prompt/`--` behind it.
{
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "-x" });
  const cfg = args.indexOf("--mcp-config");
  check("--mcp-config value is the last real flag (no `--`/prompt trailing it)", cfg !== -1 && args.length - 1 === cfg + 1);
}

// --- Profile-pinned model (Phase-3) -------------------------------------------------------------
// A model set → `--model <id>` is emitted as a real flag, right after --permission-mode.
{
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "build it", model: "claude-opus-4-8" });
  const m = args.indexOf("--model");
  check("model set: `--model` is present", m !== -1);
  check("model set: `--model` is immediately followed by the id", args[m + 1] === "claude-opus-4-8");
  check("model set: `--model` follows `--permission-mode`", m > args.indexOf("--permission-mode"));
  check("model set: no `--` separator (prompt still doesn't ride argv)", !args.includes("--"));
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
  const cfg = args.indexOf("--mcp-config");
  check("sessionName set: `-n` is present", n !== -1);
  check("sessionName set: `-n` is immediately followed by the name", args[n + 1] === "loom-loom-dev-fix-thing");
  check("sessionName set: `-n` precedes `--strict-mcp-config`/`--mcp-config` (H2 ordering)", n < cfg);
  check("sessionName set: no `--` separator (prompt still doesn't ride argv)", !args.includes("--"));
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
// Both `--model` and `-n` set together: both present, in the documented relative order.
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
  ? "\n✅ ALL PASS — buildSpawnArgs NEVER emits startupPrompt into argv (dash-prefixed, huge, or plain — byte-identical argv with or without it), flags lead, resume/fork thread correctly, --model is emitted iff a profile pins one (null/empty ⇒ byte-identical, no --model), and -n <name> emits/omits the same way (byte-identical when absent, always ahead of --mcp-config)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
