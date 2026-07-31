import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card abcf0eba part (a) — the Windows CreateProcess command-line ceiling (raw, unactionable
// "error code: 206" / ERROR_FILENAME_EXCED_RANGE) preflighted at the REAL createPty spawn chokepoint.
//
// Card 0050a17e REWROTE this file: the startup/kickoff prompt no longer rides argv AT ALL (see
// buildSpawnArgs' own doc in pty/host.ts) — it's delivered post-`ready` via submit() instead. That
// removes the Windows ceiling from the ONE thing that used to blow through it (a large agent brief +
// kickoff). The preflight itself (`preflightWindowsCommandLine`) still exists as a real, exact,
// real-spawn-time guard for whatever ELSE rides argv (the settings path, the inline `--mcp-config`
// JSON, `--disallowedTools`) — this file now proves BOTH halves: (1) a startupPrompt of ANY size,
// including the exact real content that used to trip this preflight, contributes NOTHING to the
// composed command line any more, and (2) the boundary math itself is still correct for whatever DOES
// still ride argv (proven here by inflating a non-prompt contributor instead).
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
// spawn and was performed manually against this exact dependency version).
//
// UNITS (stated explicitly, per manager review): the preflight measures a JS string's `.length` —
// i.e. UTF-16 CODE UNITS — of the FULL composed command line: the binary path + EVERY flag/value
// (--settings <path>, --permission-mode, --model if any, --disallowedTools if any, -n if any,
// --strict-mcp-config --mcp-config <json>), ALL joined and Windows-quoted/escaped the same way
// node-pty's own argsToCommandLine would for array args (windowsCommandLine is a behaviourally-equivalent
// ADAPTATION of it, not a byte-for-byte port — see that function's own doc) — i.e. POST-escaping, not a
// raw pre-escaped argv sum. This is deliberately the SAME unit `CreateProcessW`'s documented "32,767
// characters, including the terminating null" ceiling uses: a JS string is natively UTF-16, so `.length`
// counts UTF-16 code units with no re-encoding step — the exact unit Windows itself counts (NOT bytes,
// NOT UTF-8 code units, NOT grapheme clusters). My empirical binary search (this file's header) landed on
// an EXACT integer boundary (32766 OK / 32767 FAIL, zero slack) using ASCII padding, which is consistent
// with — though doesn't by itself prove for non-ASCII — this unit match; the theoretical argument (JS
// length ≡ UTF-16 code units ≡ what CreateProcessW counts) holds regardless of ASCII/non-ASCII content. I
// did not separately re-validate the exact boundary with astral (surrogate-pair) characters against a
// real spawn; I'm stating that rather than presenting it as confirmed.
//
// Part A (pure, cross-platform): windowsCommandLine's quoting + preflightWindowsCommandLine's
// ok/refuse boundary and message content — deterministic, no real spawn. Includes the direct
// prompt-never-contributes regression proof.
// Part B (Windows-only): the REAL (unsubclassed) PtyHost.createPty(), via a real node.exe substituted
// for `claude` (LOOM_CLAUDE_BIN) — proves a REALISTICALLY HUGE real startupPrompt (this project's own
// full CLAUDE.md + full /worker SKILL.md, uncut — the exact content this preflight used to refuse) now
// spawns for real with no throw, while an oversized NON-prompt argv contributor still gets refused
// actionably.
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

// --- CARD 0050a17e's core regression proof: startupPrompt contributes NOTHING to argv, at any size ---
{
  const mcpServers = { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } };
  const base = { settingsPath: "S", mode: "acceptEdits", mcpServers };
  const noPromptArgs = buildSpawnArgs(base);
  const hugePromptArgs = buildSpawnArgs({ ...base, startupPrompt: "X".repeat(200_000) });
  const dashedPromptArgs = buildSpawnArgs({ ...base, startupPrompt: "--dangerously-do-a-thing" });
  check("no-prompt vs 200KB-prompt: byte-identical argv (the prompt contributes NOTHING)",
    JSON.stringify(noPromptArgs) === JSON.stringify(hugePromptArgs));
  check("no-prompt vs dash-prefixed-prompt: byte-identical argv", JSON.stringify(noPromptArgs) === JSON.stringify(dashedPromptArgs));
  check("preflight: a 200KB startupPrompt alone never trips it (nothing else in this argv is oversized)",
    preflightWindowsCommandLine("C:\\claude\\claude.cmd", hugePromptArgs).ok === true);
}

// --- The exact empirical boundary, reproduced deterministically — now probed via the SETTINGS PATH
//     (a real argv contributor that survives this card) instead of startupPrompt (which no longer
//     contributes at all). Proves the boundary math itself is still exactly correct for whatever DOES
//     still ride argv; the real-OS cross-check was performed manually — see this file's header. ---
{
  const mcpServers = { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } };
  const bin = "C:\\claude\\claude.cmd";
  // A settingsPath made of "X" has no space/tab, so windowsCommandLine's quoting rule never wraps it in
  // quotes — it contributes EXACTLY its own char count to the command line. That makes `base` (the
  // command-line length contributed by everything ELSE) exact, so padding to any target total is exact.
  const probeArgs = buildSpawnArgs({ settingsPath: "X", mode: "acceptEdits", mcpServers });
  const base = windowsCommandLine(bin, probeArgs).length - 1;
  const padTo = (total) => "X".repeat(Math.max(1, total - base));
  const atLimitArgs = buildSpawnArgs({ settingsPath: padTo(WINDOWS_COMMAND_LINE_LIMIT), mode: "acceptEdits", mcpServers });
  const overLimitArgs = buildSpawnArgs({ settingsPath: padTo(WINDOWS_COMMAND_LINE_LIMIT + 1), mode: "acceptEdits", mcpServers });
  const atLimitLen = windowsCommandLine(bin, atLimitArgs).length;
  const overLimitLen = windowsCommandLine(bin, overLimitArgs).length;
  check(`a command line of exactly the limit (${WINDOWS_COMMAND_LINE_LIMIT}) computed len matches`, atLimitLen === WINDOWS_COMMAND_LINE_LIMIT);
  check(`a command line one char over (${WINDOWS_COMMAND_LINE_LIMIT + 1}) computed len matches`, overLimitLen === WINDOWS_COMMAND_LINE_LIMIT + 1);
  check("preflight: AT the limit is ok", preflightWindowsCommandLine(bin, atLimitArgs).ok === true);
  check("preflight: ONE char over the limit is refused", preflightWindowsCommandLine(bin, overLimitArgs).ok === false);
}

// --- Actionable message content: names the size, the limit, and how far over — never a bare
//     "error code: 206". No more per-part breakdown (card 0050a17e removed it along with
//     startupPromptParts/PromptSizePart — a breakdown of the prompt's own contributors would now
//     describe text that isn't even part of the measured command line). ---
{
  const mcpServers = { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } };
  const args = buildSpawnArgs({ settingsPath: "X".repeat(40_000), mode: "acceptEdits", mcpServers });
  const result = preflightWindowsCommandLine("C:\\claude\\claude.cmd", args);
  check("oversized spawn: preflight reports not-ok", result.ok === false);
  check("message names the assembled command-line length", /is \d+ characters/.test(result.message));
  check("message names the Windows CreateProcess limit (32766)", result.message.includes("32766"));
  check("message names the raw OS symptom it replaces (error code: 206)", result.message.includes("error code: 206"));
  check("message no longer names the startup prompt as the knob to shorten (it can't be — it's not on argv)",
    !/startup prompt/i.test(result.message));
  check("message names the argv contributors that DO still ride argv", /MCP config|settings path|disallowed-tools/i.test(result.message));
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

  // --- THE CARD'S OWN REGRESSION PROOF, at real-spawn scale: the EXACT content that used to trip this
  // preflight (the full real CLAUDE.md + full real /worker SKILL.md, uncut, not synthetic padding) must
  // now spawn for REAL with no throw — because it no longer contributes to argv at all. ---
  const claudeMd = fs.readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const workerSkill = fs.readFileSync(path.join(REPO_ROOT, ".claude", "skills", "worker", "SKILL.md"), "utf8");
  const oversizedRealisticPrompt = `${claudeMd}\n\n---\n\n${workerSkill}`;
  check("fixture prompt is genuinely oversized relative to the old ceiling (not a toy string)",
    oversizedRealisticPrompt.length > WINDOWS_COMMAND_LINE_LIMIT);
  check("fixture prompt actually contains real quote/escape-relevant characters (not synthetic)",
    oversizedRealisticPrompt.includes("\"") || oversizedRealisticPrompt.includes("\\") || oversizedRealisticPrompt.includes("`"));

  // Reproduce (independently of the real spawn) the command line this spawn actually produces, to
  // REPORT the measured length (logged below — the FULL real CLAUDE.md + SKILL.md, tens of KB, not a
  // fixed figure worth restating here since it drifts as those files grow) — proving it's now driven
  // purely by the fixed/non-prompt argv, not by the real prose above.
  const reportMcpServers = { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/huge-1" } };
  const settingsPathForReport = path.join(tmpHome, "tmp", "settings", "huge-1.json");
  const reportArgsWithPrompt = buildSpawnArgs({ settingsPath: settingsPathForReport, mode: "acceptEdits", mcpServers: reportMcpServers, startupPrompt: oversizedRealisticPrompt });
  const reportArgsNoPrompt = buildSpawnArgs({ settingsPath: settingsPathForReport, mode: "acceptEdits", mcpServers: reportMcpServers });
  const reportCmdLine = windowsCommandLine(process.execPath, reportArgsWithPrompt);
  console.log(`\n[measured] oversized-but-real fixture (full CLAUDE.md + full worker SKILL.md): raw combined=${oversizedRealisticPrompt.length} chars, but FULL composed command line (WITH the prompt passed) = ${reportCmdLine.length} chars, vs WINDOWS_COMMAND_LINE_LIMIT=${WINDOWS_COMMAND_LINE_LIMIT} (headroom = ${WINDOWS_COMMAND_LINE_LIMIT - reportCmdLine.length} chars)`);
  check("the real (tens-of-KB) prompt contributes ZERO of that composed length (identical with/without it)",
    JSON.stringify(reportArgsWithPrompt) === JSON.stringify(reportArgsNoPrompt));

  const hugeId = "huge-1";
  let hugeThrew = null;
  try { host.spawn(baseOpts(hugeId, oversizedRealisticPrompt)); } catch (e) { hugeThrew = e; }
  check("oversized-but-REAL prompt (the old positive control): real createPty does NOT throw any more", hugeThrew === null);
  check("oversized-but-REAL prompt: a real Live entry WAS registered (a real process actually spawned)", host.isAlive(hugeId) === true);
  if (hugeThrew) console.log("   (unexpected throw:", hugeThrew.message.slice(0, 300), ")");
  try { host.stop(hugeId, "hard"); } catch { /* best-effort cleanup */ }

  // --- The preflight mechanism ITSELF still works for what remains on argv (a control that the fix
  // didn't just delete the whole check) — inflate the settings path instead of the prompt.
  // createPty derives settingsPath internally (writeSessionSettings) rather than accepting one as a
  // SpawnOpts field, so there's no real spawn-level lever to inflate JUST the settings path without
  // reaching into private machinery; prove the control at the buildSpawnArgs+preflight layer instead —
  // still the REAL functions the real spawn uses, just not routed through a full createPty this time
  // (Part A already covers this same shape deterministically — this is the same check, restated here
  // as the control paired with Part B's real-spawn positive case above, for the reader who skips A). ---
  const inflatedSettingsArgs = buildSpawnArgs({ settingsPath: "X".repeat(40_000), mode: "acceptEdits", mcpServers: reportMcpServers });
  const inflatedPreflight = preflightWindowsCommandLine(process.execPath, inflatedSettingsArgs);
  check("control: an oversized NON-prompt argv contributor (settings path) is STILL refused — the whole check wasn't deleted, only the prompt's contribution to it",
    inflatedPreflight.ok === false);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the startup prompt (any size, any content, dash-prefixed or not) contributes NOTHING to the composed Windows command line any more — the exact real content that used to trip this preflight (full CLAUDE.md + worker SKILL.md) now spawns for real with no throw. The Windows command-line preflight itself (grounded against a real node-pty binary search: 32766 chars OK, 32767 FAIL) still refuses actionably for whatever DOES remain on argv (settings path / MCP config / disallowed-tools)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1); // awaits real cleanup, then exits deterministically — no hang-on-drain risk from the real node.exe children spawned above
