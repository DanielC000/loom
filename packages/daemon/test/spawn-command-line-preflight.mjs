import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card abcf0eba part (a) — the Windows CreateProcess command-line ceiling (raw, unactionable
// "error code: 206" / ERROR_FILENAME_EXCED_RANGE) preflighted at the REAL createPty spawn chokepoint.
//
// WINDOWS_COMMAND_LINE_LIMIT and windowsCommandLine (a behaviourally-equivalent ADAPTATION of node-pty's
// argv->command-line quoting for ARRAY args — NOT a byte-for-byte port; see windowsCommandLine's own doc
// in pty/host.ts and test/node-pty-quoting-parity.mjs for the measured comparison, card 9fea4196) are NOT
// guessed: they were empirically re-derived against the REAL node-pty dependency this daemon spawns
// through, via a binary search over real `node.exe` spawns on this Windows dev box. The result: a command
// line of computed length 32766 spawns successfully; 32767 fails with the raw "Cannot create process,
// error code: 206" — confirming BOTH the constant AND that windowsCommandLine matches node-pty's own
// quoting at the real OS boundary, for the array-args inputs this daemon actually passes (this is the RED
// repro this card's verification demands; not re-run here as a hermetic assertion — it needs a real OS
// spawn and was performed manually against this exact dependency version). This test proves the GREEN
// half: wired correctly, the preflight refuses BEFORE any process is created, with an actionable message.
//
// UNITS (stated explicitly, per manager review): the preflight measures a JS string's `.length` —
// i.e. UTF-16 CODE UNITS — of the FULL composed command line: the binary path + EVERY flag/value
// (--settings <path>, --permission-mode, --model if any, --disallowedTools if any, -n if any,
// --strict-mcp-config --mcp-config <json>) + the startupPrompt, ALL joined and Windows-quoted/escaped
// the same way node-pty's own argsToCommandLine would for array args (windowsCommandLine is a
// behaviourally-equivalent ADAPTATION of it, not a byte-for-byte port — see that function's own doc)
// — i.e. POST-escaping, not a raw pre-escaped argv sum. This is deliberately the SAME unit
// `CreateProcessW`'s documented "32,767 characters, including the terminating null" ceiling uses: a
// JS string is natively UTF-16, so `.length` counts UTF-16 code units with no re-encoding step — the
// exact unit Windows itself counts (NOT bytes, NOT UTF-8 code units, NOT grapheme clusters). My
// empirical binary search (this file's header) landed on an EXACT integer boundary (32766 OK / 32767
// FAIL, zero slack) using ASCII padding, which is consistent with — though doesn't by itself prove for
// non-ASCII — this unit match; the theoretical argument (JS length ≡ UTF-16 code units ≡ what
// CreateProcessW counts) holds regardless of ASCII/non-ASCII content. I did not separately
// re-validate the exact boundary with astral (surrogate-pair) characters against a real spawn; I'm
// stating that rather than presenting it as confirmed.
//
// Part A (pure, cross-platform): windowsCommandLine's quoting + preflightWindowsCommandLine's
// ok/refuse boundary and message content — deterministic, no real spawn.
// Part B (Windows-only): the REAL (unsubclassed) PtyHost.createPty(), via a real node.exe substituted
// for `claude` (LOOM_CLAUDE_BIN), actually refuses an oversized-but-REAL prompt (this project's own
// full CLAUDE.md + /worker SKILL.md, not synthetic padding) with the actionable message (never a raw
// OS error) and leaves NO Live entry — while a REALISTIC-scale brief+kickoff (real CLAUDE.md/SKILL.md
// excerpts sized to the incident's own ~11KB/~7KB, NOT a toy string) still spawns for real. Both
// directions are exercised against real, non-synthetic content, with the measured composed
// command-line length reported for each.
//
// Run: 1) build (turbo builds shared first), 2) node test/spawn-command-line-preflight.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// mkdtempManaged creates AND registers this dir for guaranteed cleanup (card 995be21f) — including on
// an unexpected throw, unlike a trailing rmSync loop that only runs if execution reaches it.
const tmpHome = mkdtempManaged("loom-cmdline-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { PtyHost, windowsCommandLine, preflightWindowsCommandLine, WINDOWS_COMMAND_LINE_LIMIT, buildSpawnArgs } =
  await import("../dist/pty/host.js");
const { spawnBudgetWarning, SPAWN_PROMPT_BUDGET_ESTIMATE_CHARS } = await import("../dist/agents/promptLint.js");

// ===================== Part A: pure quoting + preflight (cross-platform) =====================

check("WINDOWS_COMMAND_LINE_LIMIT is the empirically-confirmed 32766 (not a round guess)", WINDOWS_COMMAND_LINE_LIMIT === 32766);

// --- windowsCommandLine quoting cases (hand-verified against CommandLineToArgvW's convention) ---
{
  // A plain arg with no special chars: no quotes added.
  check("plain arg: no quoting added", windowsCommandLine("bin", ["plain"]) === "bin plain");
  // An arg containing a space MUST be quoted (else CommandLineToArgvW would split it in two).
  check("arg with a space: wrapped in quotes", windowsCommandLine("bin", ["has space"]) === 'bin "has space"');
  // An embedded double-quote is escaped as \" and any preceding backslashes are doubled first.
  check("arg with an embedded quote (and a space): backslash-escaped", windowsCommandLine("bin", ['say "hi"']) === 'bin "say \\"hi\\""');
  // A trailing backslash right before the closing quote must be DOUBLED (else it would escape the
  // closing quote itself) — the classic Windows-path-in-a-quoted-arg footgun.
  check("arg ending in a backslash + containing a space: trailing backslash doubled",
    windowsCommandLine("bin", ["C:\\a b\\"]) === 'bin "C:\\a b\\\\"');
  // An empty-string arg must still be quoted (else it vanishes entirely from the command line).
  check("empty-string arg: quoted as \"\"", windowsCommandLine("bin", [""]) === 'bin ""');
}

// --- The exact empirical boundary, reproduced deterministically via buildSpawnArgs + windowsCommandLine
//     (no real spawn needed here — the real-OS cross-check was performed manually; see this file's header) ---
{
  const mcpServers = { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } };
  const bin = "C:\\claude\\claude.cmd";
  // A single "X" startupPrompt has no space/tab, so windowsCommandLine's quoting rule never wraps it in
  // quotes — it contributes EXACTLY its own char count to the command line. That makes `base` (the
  // command-line length contributed by everything ELSE) exact, so padding to any target total is exact.
  const probeArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "X" });
  const base = windowsCommandLine(bin, probeArgs).length - 1;
  const padTo = (total) => "X".repeat(Math.max(1, total - base));
  const atLimitArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: padTo(WINDOWS_COMMAND_LINE_LIMIT) });
  const overLimitArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: padTo(WINDOWS_COMMAND_LINE_LIMIT + 1) });
  const atLimitLen = windowsCommandLine(bin, atLimitArgs).length;
  const overLimitLen = windowsCommandLine(bin, overLimitArgs).length;
  check(`a command line of exactly the limit (${WINDOWS_COMMAND_LINE_LIMIT}) computed len matches`, atLimitLen === WINDOWS_COMMAND_LINE_LIMIT);
  check(`a command line one char over (${WINDOWS_COMMAND_LINE_LIMIT + 1}) computed len matches`, overLimitLen === WINDOWS_COMMAND_LINE_LIMIT + 1);
  check("preflight: AT the limit is ok", preflightWindowsCommandLine(bin, atLimitArgs).ok === true);
  check("preflight: ONE char over the limit is refused", preflightWindowsCommandLine(bin, overLimitArgs).ok === false);
}

// --- Actionable message content: names the size, the limit, how far over, and (with parts) the
//     specific knobs + which one to shorten. This is the whole point of the card — never a bare
//     "error code: 206". ---
{
  const mcpServers = { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } };
  const hugePrompt = "X".repeat(40_000);
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: hugePrompt });
  const result = preflightWindowsCommandLine("C:\\claude\\claude.cmd", args, [
    { label: "agent base brief", chars: 11_000 },
    { label: "this spawn's kickoffPrompt", chars: 29_000 },
  ]);
  check("oversized spawn: preflight reports not-ok", result.ok === false);
  check("message names the assembled command-line length", /is \d+ characters/.test(result.message));
  check("message names the Windows CreateProcess limit (32766)", result.message.includes("32766"));
  check("message names the raw OS symptom it replaces (error code: 206)", result.message.includes("error code: 206"));
  check("message includes the breakdown: agent base brief size", result.message.includes("agent base brief is 11000 chars"));
  check("message includes the breakdown: kickoffPrompt size", result.message.includes("this spawn's kickoffPrompt is 29000 chars"));
  check("message names the LARGER contributor as the knob to shorten", result.message.includes('currently "this spawn\'s kickoffPrompt"'));
}
// Without a breakdown, the message still stands alone (actionable, just less granular) — every
// non-worker spawn path (manager/platform/resume/fork) omits startupPromptParts.
{
  const mcpServers = { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } };
  const args = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers, startupPrompt: "X".repeat(40_000) });
  const result = preflightWindowsCommandLine("C:\\claude\\claude.cmd", args);
  check("no breakdown: still refused, with a generic 'shorten the startup prompt' knob", result.ok === false && result.message.includes("Shorten the startup prompt"));
}

// ===================== Part (b): agent_create/agent_update spawn-budget warning =====================
{
  check("a short brief: no budget warning", spawnBudgetWarning("a short worker brief") === null);
  check("empty/absent brief: no budget warning", spawnBudgetWarning(undefined) === null && spawnBudgetWarning("") === null);
  const bigBrief = "X".repeat(SPAWN_PROMPT_BUDGET_ESTIMATE_CHARS * 0.6); // over the 50% warn threshold
  const warning = spawnBudgetWarning(bigBrief);
  check("a brief over the warn threshold: returns a warning", typeof warning === "string");
  check("warning names the brief's own size", warning.includes(String(bigBrief.length)));
  check("warning is framed as an ESTIMATE (never presented as the exact limit)", /estimate/i.test(warning));
  check("warning points at the real, exact check (pty/host.ts preflightWindowsCommandLine)", warning.includes("preflightWindowsCommandLine"));
}

// ===================== Part B: real createPty wiring (Windows-only — the preflight is win32-gated) =====================
if (process.platform !== "win32") {
  console.log("SKIP  Part B (real createPty wiring) — this preflight is Windows-only (process.platform !== 'win32' here); the boundary itself was verified on a real Windows box (see this file's header).");
} else {
  // Substitute a real, trivial, always-present executable for `claude` — resolveExecutable passes an
  // absolute path through unchanged, so LOOM_CLAUDE_BIN=process.execPath makes createPty's real spawn
  // actually launch a real (harmless) node.exe process instead of a real `claude`.
  process.env.LOOM_CLAUDE_BIN = process.execPath;
  // The real (unmocked) createPty writes into SETTINGS_DIR (tmp/settings) — normally created once at
  // daemon boot (index.ts's ensureDirs()), which this hermetic test doesn't otherwise run.
  const { ensureDirs, WORKTREES_DIR } = await import("../dist/paths.js");
  ensureDirs();
  registerForCleanup(WORKTREES_DIR); // WORKTREES_DIR is a SIBLING of LOOM_HOME, not nested inside it — production code (ensureDirs) created this dir, not this file, so register it for the same guaranteed cleanup (mirrors worktrees-base-isolation.mjs)
  const events = {
    onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  };
  const host = new PtyHost(events);
  const baseOpts = (sessionId, startupPrompt) => ({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 },
    sessionEnv: {},
    startupPrompt,
  });

  // --- NEGATIVE CONTROL (manager-required): a REALISTIC brief+kickoff, near the incident's own
  // reported scale, must still spawn for REAL. Not a toy string — this project's OWN real CLAUDE.md
  // (real prose: markdown, backticks, em-dashes, and literal embedded double-quotes in its JSON
  // examples) and its own real /worker skill doctrine, sliced to ~11KB / ~7KB (matching the incident's
  // reported "~11 KB brief + ~7 KB kickoff") and joined the SAME way composeWorkerStartupPrompt joins
  // a real worker's brief + dynamic part ("\n\n---\n\n"). A preflight with an inverted comparison, a
  // wrong unit, or an order-of-magnitude-off constant would refuse THIS — it would not look like a
  // clean pass on a trivially-small string, because this one is realistically large and realistically
  // textured (real quotes, real escaping-relevant characters).
  const claudeMd = fs.readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const workerSkill = fs.readFileSync(path.join(REPO_ROOT, ".claude", "skills", "worker", "SKILL.md"), "utf8");
  const realisticBrief = claudeMd.slice(0, 11_000);
  const realisticKickoff = workerSkill.slice(0, 7_000);
  const realisticPrompt = `${realisticBrief}\n\n---\n\n${realisticKickoff}`;
  check("realistic fixture actually contains real quote/escape-relevant characters (not synthetic)",
    realisticPrompt.includes("\"") || realisticPrompt.includes("\\") || realisticPrompt.includes("`"));

  // Reproduce (independently of the real spawn) the SAME composed command line this spawn will
  // produce, purely so we can REPORT the measured length vs the limit — createPty doesn't hand its
  // internal computation back to the caller.
  const reportMcpServers = { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/realistic-1" } };
  const reportArgs = buildSpawnArgs({ settingsPath: path.join(tmpHome, "tmp", "settings", "realistic-1.json"), mode: "acceptEdits", mcpServers: reportMcpServers, startupPrompt: realisticPrompt });
  const reportCmdLine = windowsCommandLine(process.execPath, reportArgs);
  console.log(`\n[measured] realistic negative control: raw brief=${realisticBrief.length} chars, raw kickoff=${realisticKickoff.length} chars, raw combined=${realisticPrompt.length} chars`);
  console.log(`[measured] FULL composed command line (bin + every flag, POST-escaping) = ${reportCmdLine.length} chars, vs WINDOWS_COMMAND_LINE_LIMIT=${WINDOWS_COMMAND_LINE_LIMIT} (margin = ${WINDOWS_COMMAND_LINE_LIMIT - reportCmdLine.length} chars headroom)`);
  console.log(`[measured] escaping/overhead inflation vs raw combined prompt alone: ${(reportCmdLine.length / realisticPrompt.length).toFixed(4)}x`);

  const realisticId = "realistic-1";
  let realisticThrew = null;
  try { host.spawn(baseOpts(realisticId, realisticPrompt)); } catch (e) { realisticThrew = e; }
  check("REALISTIC brief+kickoff (~18KB raw, real project text): real createPty does NOT throw", realisticThrew === null);
  check("REALISTIC brief+kickoff: a real Live entry was registered (a real process actually spawned)", host.isAlive(realisticId) === true);
  if (realisticThrew) console.log("   (unexpected throw:", realisticThrew.message.slice(0, 300), ")");
  try { host.stop(realisticId, "hard"); } catch { /* best-effort cleanup */ }

  // --- POSITIVE CONTROL (oversized, but STILL real content — not synthetic padding): the full real
  // CLAUDE.md + the full real /worker SKILL.md, uncut, joined the same way. Proves the refusal isn't
  // an artifact of "X" padding specifically — genuine markdown/prose at this scale trips it too. ---
  const oversizedRealisticPrompt = `${claudeMd}\n\n---\n\n${workerSkill}`;
  const oversizedCmdLine = windowsCommandLine(process.execPath, buildSpawnArgs({ settingsPath: path.join(tmpHome, "tmp", "settings", "realistic-huge.json"), mode: "acceptEdits", mcpServers: reportMcpServers, startupPrompt: oversizedRealisticPrompt }));
  console.log(`[measured] oversized-but-real fixture (full CLAUDE.md + full worker SKILL.md): raw combined=${oversizedRealisticPrompt.length} chars, FULL composed command line=${oversizedCmdLine.length} chars, vs limit=${WINDOWS_COMMAND_LINE_LIMIT} (over by ${oversizedCmdLine.length - WINDOWS_COMMAND_LINE_LIMIT} chars)`);

  const hugeId = "huge-1";
  let hugeThrew = null;
  try { host.spawn(baseOpts(hugeId, oversizedRealisticPrompt)); } catch (e) { hugeThrew = e; }
  check("oversized-but-REAL prompt: real createPty THROWS (refused before any process creation)", hugeThrew !== null);
  check("oversized-but-REAL prompt: the thrown message is the ACTIONABLE one, not a raw OS error",
    hugeThrew && hugeThrew.message.includes("Spawn refused") && hugeThrew.message.includes(String(WINDOWS_COMMAND_LINE_LIMIT)));
  check("oversized-but-REAL prompt: NO Live entry was ever registered for it", host.isAlive(hugeId) === false);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Windows command-line preflight (grounded against a real node-pty binary search: 32766 chars OK, 32767 FAIL) refuses an oversized spawn ACTIONABLY (size, limit, over-amount, which knob to shorten) before any process is created, the agent_create/agent_update spawn-budget warning flags an oversized base brief as an estimate, and a real (unsubclassed) createPty spawn proves the wiring end-to-end on Windows."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1); // awaits real cleanup, then exits deterministically — no hang-on-drain risk from the real node.exe children spawned above
