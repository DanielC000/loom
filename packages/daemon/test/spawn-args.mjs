// buildSpawnArgs / argv-ordering test. Deterministic, no daemon, no claude — asserts flag ordering AND
// (card 0050a17e) that `startupPrompt` is accepted for API convenience but is NEVER emitted into argv,
// for ANY input (dash-prefixed, huge, empty, or omitted) — closing the Windows command-line ceiling this
// used to create (a large agent brief + kickoff could blow through CreateProcess's 32766-char limit and
// refuse the spawn outright). The prompt now rides to the engine post-ready via submit() instead (see
// pty/host.ts's scheduleKickoffGuarantee). Also (card 282107e8) asserts `--append-system-prompt
// <LOOM_PASTED_CONTENT_SYSTEM_PROMPT>` is emitted UNCONDITIONALLY, for every role/spawn-kind, as a FIXED
// constant (see docs/decisions/282107e8-pasted-content-is-the-sessions-real-user-turn.md). Run: node
// test/spawn-args.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpawnArgs, LOOM_PASTED_CONTENT_SYSTEM_PROMPT } from "../dist/pty/host.js";

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

// --- card 282107e8: --append-system-prompt <LOOM_PASTED_CONTENT_SYSTEM_PROMPT> -------------------
// Fixed, non-interpolated, unconditional for EVERY role (including plain) and every spawn kind.
{
  check("the constant is non-empty and reasonably short (fixed, not variable-length)",
    typeof LOOM_PASTED_CONTENT_SYSTEM_PROMPT === "string" &&
    LOOM_PASTED_CONTENT_SYSTEM_PROMPT.length > 50 && LOOM_PASTED_CONTENT_SYSTEM_PROMPT.length < 2000);
  // Fresh/"plain" spawn — no role-conditional params at all (disallowedTools/model/sessionName all
  // omitted) — the flag is still present. This IS the "plain role" case: plain sessions carry no
  // disallowedTools/model/sessionName either, so this call shape already covers it.
  const plain = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers });
  const fIdx = plain.indexOf("--append-system-prompt");
  check("plain spawn: --append-system-prompt is present", fIdx !== -1);
  check("plain spawn: its value is the exact fixed constant", plain[fIdx + 1] === LOOM_PASTED_CONTENT_SYSTEM_PROMPT);
  check("plain spawn: it precedes --strict-mcp-config/--mcp-config", fIdx >= 0 && fIdx < plain.indexOf("--strict-mcp-config"));

  // Every optional dimension set at once (manager-shaped: model + disallowedTools + sessionName) —
  // still present, still the SAME value (no interpolation from any of these inputs).
  const loaded = buildSpawnArgs({
    settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "lead it",
    model: "claude-opus-4-8", disallowedTools: ["AskUserQuestion"], sessionName: "loom-loom-mgr",
  });
  const lIdx = loaded.indexOf("--append-system-prompt");
  check("fully-loaded spawn (model+disallowedTools+sessionName): --append-system-prompt still present", lIdx !== -1);
  check("fully-loaded spawn: value unchanged by any other param", loaded[lIdx + 1] === LOOM_PASTED_CONTENT_SYSTEM_PROMPT);

  // Resume and fork — the two spawn kinds that never carry a startupPrompt — still get it.
  const resumeArgs = buildSpawnArgs({ resumeId: "engine-123", settingsPath: "S", mode: "acceptEdits", mcpServers });
  check("resume: --append-system-prompt is present with the exact fixed value",
    resumeArgs[resumeArgs.indexOf("--append-system-prompt") + 1] === LOOM_PASTED_CONTENT_SYSTEM_PROMPT);
  const forkArgs = buildSpawnArgs({ resumeId: "engine-123", fork: true, forkSessionId: "new-456", settingsPath: "S", mode: "acceptEdits", mcpServers });
  check("fork: --append-system-prompt is present with the exact fixed value",
    forkArgs[forkArgs.indexOf("--append-system-prompt") + 1] === LOOM_PASTED_CONTENT_SYSTEM_PROMPT);

  // Two calls differing in literally every OTHER param still carry byte-identical --append-system-prompt
  // framing (flag name + value) — proves it is truly unconditional/non-interpolated, not accidentally
  // keyed off any of these inputs.
  check("flag+value pair is identical across a plain vs. a fully-loaded call",
    JSON.stringify([plain[fIdx], plain[fIdx + 1]]) === JSON.stringify([loaded[lIdx], loaded[lIdx + 1]]));
}
// Codex is structurally untouched: this constant/flag is claude-only, since createCodexPty is a
// separate method that never calls buildSpawnArgs (profile-field-consumer-guard.mjs already pins
// "buildSpawnArgs(" itself as absent from the codex-spawn region — re-verified here directly against
// the new token so this file doesn't just lean on another file's control).
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const hostTsPath = path.join(__dirname, "..", "src", "pty", "host.ts");
  const hostTs = fs.readFileSync(hostTsPath, "utf8");
  const codexStart = hostTs.indexOf("protected createCodexPty(opts: SpawnOpts");
  const codexEnd = hostTs.indexOf("private captureCodexEngineSessionId(sessionId: string, live: CodexLive, cwd: string, attempt = 0): void {", codexStart);
  check("codex-spawn region anchors found", codexStart !== -1 && codexEnd !== -1 && codexEnd > codexStart);
  const codexRegion = hostTs.slice(codexStart, codexEnd);
  check("(control) codex-spawn region does NOT contain LOOM_PASTED_CONTENT_SYSTEM_PROMPT", !codexRegion.includes("LOOM_PASTED_CONTENT_SYSTEM_PROMPT"));
  check("(control) codex-spawn region does NOT contain --append-system-prompt", !codexRegion.includes("--append-system-prompt"));
  // Positive control for the negative checks above: the SAME two tokens ARE present in the real
  // buildSpawnArgs function body, so an always-green (e.g. a broken anchor) can't hide behind this.
  // Bounded by the NEXT top-level declaration (not a fixed slice length) — WINDOWS_COMMAND_LINE_LIMIT is
  // the real declaration buildSpawnArgs' own closing brace is followed by, re-verified every run rather
  // than assumed, so this can't silently start under- or over-shooting the function's real end.
  const buildSpawnArgsStart = hostTs.indexOf("export function buildSpawnArgs(o: {");
  const buildSpawnArgsEnd = hostTs.indexOf("export const WINDOWS_COMMAND_LINE_LIMIT", buildSpawnArgsStart);
  check("buildSpawnArgs region anchors found", buildSpawnArgsStart !== -1 && buildSpawnArgsEnd !== -1 && buildSpawnArgsEnd > buildSpawnArgsStart);
  const buildSpawnArgsRegion = hostTs.slice(buildSpawnArgsStart, buildSpawnArgsEnd);
  check("(control) buildSpawnArgs' own body DOES contain LOOM_PASTED_CONTENT_SYSTEM_PROMPT", buildSpawnArgsRegion.includes("LOOM_PASTED_CONTENT_SYSTEM_PROMPT"));
  check("(control) buildSpawnArgs' own body DOES contain --append-system-prompt", buildSpawnArgsRegion.includes("--append-system-prompt"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — buildSpawnArgs NEVER emits startupPrompt into argv (dash-prefixed, huge, or plain — byte-identical argv with or without it), flags lead, resume/fork thread correctly, --model is emitted iff a profile pins one (null/empty ⇒ byte-identical, no --model), -n <name> emits/omits the same way (byte-identical when absent, always ahead of --mcp-config), and --append-system-prompt <LOOM_PASTED_CONTENT_SYSTEM_PROMPT> (card 282107e8) is emitted unconditionally, as a fixed constant, for every role/spawn-kind — and is structurally absent from the codex-spawn region."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
