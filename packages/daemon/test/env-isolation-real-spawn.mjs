import "./_real-engine-opt-in.mjs";
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fafae623 — THE real-spawn smoke the card's DoD calls for: a REAL `claude` process (not a
// substituted fake binary — the mechanism under test IS claude's own stdio-MCP-spawn behavior, which no
// fixture substitute implements) builds its mcp-config through the REAL, now-rewritten `buildMcpServers`
// and spawns a REAL stdio MCP child. Proves the fix end-to-end, not just its pieces in isolation
// (capability-pass-env.mjs/env-isolated-launch.mjs/browser-testing-spawn.mjs already cover those).
//
// ONE real claude spawn (n=1 — see this file's own disclosure at the bottom). SKIPs (exit 0) if no real
// claude binary is resolvable on this host (mirrors every other optional-real-binary test in this suite)
// — this is NOT the LOOM_CLAUDE_BIN-substitution shape every other "*-real-spawn.mjs" file in this suite
// uses, precisely because a substitute binary implements no MCP-stdio-spawn logic to isolate anything
// FROM — claude's own binary is the one thing that actually does that spawn.
//
// Proves, via a real claude process's real stdio MCP child (fixtures/mcp-env-probe.mjs):
//   (1) LOOM_MCP_TOKEN is FULLY ABSENT (not even blanked to "") — the launcher never forwards it at all.
//   (2) a credential standing in for one delivered to a DIFFERENT capability is ABSENT.
//   (3) the daemon's own ambient env noise is ABSENT.
//   (4) THIS mount's own declared secret (its secretEnvVar) IS present, with the real value.
//   (5) a passEnv-named ambient var IS present; an un-named ambient var is ABSENT (same spawn).
//   (6) the MCP actually connects (tools/list served) — isolation didn't break the spawn.
//
// Run: 1) build (turbo builds shared first), 2) node test/env-isolation-real-spawn.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpHome = useOwnLoomHome("loom-env-isolation-real-spawn-");

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const claudeBin = resolveExecutable(process.env.LOOM_CLAUDE_BIN || "claude");
if (!path.isAbsolute(claudeBin) || !fs.existsSync(claudeBin)) {
  console.log(`WARN  SKIP  env-isolation-real-spawn.mjs — no real claude binary resolvable on this host (resolveExecutable returned ${JSON.stringify(claudeBin)}); this file's proof needs the REAL CLI (see header for why a fixture substitute can't stand in).`);
  await finishAndExit(0);
}

const require = createRequire(path.join(__dirname, "..", "package.json"));
const pty = require("node-pty");

const { buildMcpServers, buildSpawnEnv, applyMcpTokenEnv } = await import("../dist/pty/host.js");
const { mcpTokenRidesEnv, writeSessionMcpConfig } = await import("../dist/pty/claude-settings.js");
const { SETTINGS_DIR } = await import("../dist/paths.js");
fs.mkdirSync(SETTINGS_DIR, { recursive: true });

const PROBE_FIXTURE = path.join(__dirname, "fixtures", "mcp-env-probe.mjs");
const sessionId = "env-isolation-real-spawn-s1";
const logFile = path.join(tmpHome, "probe-log.jsonl");

// ===== Build the REAL mcp-config through the REAL, rewritten buildMcpServers =====
const SENTINELS = ["LOOM_MCP_TOKEN", "FIXTURE_SECRET", "PROBE_CRED_FOR_OTHER_MOUNT", "PROBE_PLAIN_VAR", "PASSENV_ALLOWED_VAR", "PASSENV_NOT_ALLOWED_VAR"];
const fakeRow = {
  id: "cap-real-spawn-probe", slug: "env-probe", name: "Env Probe", description: "", transport: "stdio", kind: "bundled",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [PROBE_FIXTURE, logFile, ...SENTINELS] }),
  toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: true, secretEnvVar: "FIXTURE_SECRET",
  passEnv: ["PASSENV_ALLOWED_VAR"], createdAt: new Date().toISOString(),
};
const REAL_MCP_TOKEN = "sentinel-LOOM_MCP_TOKEN";
const mcpServers = buildMcpServers({
  sessionId, port: 4317, role: "worker",
  capabilities: [{ slug: "env-probe", connectionId: "conn1" }], capabilityCatalog: [fakeRow],
  resolveConnectionSecret: () => "sentinel-FIXTURE_SECRET",
  mcpToken: REAL_MCP_TOKEN, mcpTokenRidesEnv: mcpTokenRidesEnv(),
});
check("(setup) the real buildMcpServers mounted 'env-probe'", "env-probe" in mcpServers);
const mcpConfigPath = writeSessionMcpConfig(sessionId, mcpServers);

// ===== Build claude's own spawn env via the REAL buildSpawnEnv + applyMcpTokenEnv (createPty's own
// sequence), then plant the stand-ins for a delivered credential (for a DIFFERENT mount) + ambient
// daemon noise + the passEnv ambient var — exactly like createPty's credentialEnv/sessionEnv merges do. =====
// cwd MUST be an already-trusted directory (never a fresh temp dir) — claude shows a blocking "do you
// trust this folder?" dialog for an unrecognized cwd, which would hang this spawn forever. This worktree
// is already trusted (we're running inside it), exactly like the card's own investigation-phase probes
// used LOOM_WORKTREE for the same reason.
const spawnCwd = process.env.LOOM_WORKTREE && fs.existsSync(process.env.LOOM_WORKTREE) ? process.env.LOOM_WORKTREE : path.join(__dirname, "..", "..", "..");
const env = buildSpawnEnv(process.env, {
  PROBE_CRED_FOR_OTHER_MOUNT: "sentinel-PROBE_CRED_FOR_OTHER_MOUNT",
  PROBE_PLAIN_VAR: "sentinel-PROBE_PLAIN_VAR",
  PASSENV_ALLOWED_VAR: "sentinel-PASSENV_ALLOWED_VAR",
  PASSENV_NOT_ALLOWED_VAR: "sentinel-PASSENV_NOT_ALLOWED_VAR",
}, spawnCwd);
applyMcpTokenEnv(env, REAL_MCP_TOKEN, mcpTokenRidesEnv());
env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT = "1";

const settingsStub = path.join(SETTINGS_DIR, `${sessionId}.json`);
fs.writeFileSync(settingsStub, JSON.stringify({ hooks: {} }));
const args = ["--settings", settingsStub, "--permission-mode", "acceptEdits", "--strict-mcp-config", "--mcp-config", mcpConfigPath];

console.log(`[env-isolation-real-spawn] spawning real claude: ${claudeBin}`);
const p = pty.spawn(claudeBin, args, { name: "xterm-256color", cols: 120, rows: 40, cwd: spawnCwd, env });
const capturedPid = p.pid;
p.onExit(() => {});

try {
  await waitUntil(() => fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("tools-list-served"), {
    timeoutMs: 30000, intervalMs: 200, label: "the probe MCP to log a served tools/list (real MCP handshake through real claude)",
  });
} catch (err) {
  console.log(`WARN  the real claude spawn did not reach a served tools/list within budget: ${err.message}`);
} finally {
  try { p.kill(); } catch { /* best-effort */ }
  // Kill ONLY the captured pid's tree (never by image name or port) — Windows taskkill, mirrors the
  // card's own investigation-phase recipe.
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/PID", String(capturedPid), "/T", "/F"]); } catch { /* best-effort */ }
  }
}

const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const startLine = lines.find((l) => l.ev === "start");
check("(setup) the probe fixture actually started and logged (the real spawn reached it)", !!startLine);

if (startLine) {
  check("(1) LOOM_MCP_TOKEN is FULLY ABSENT from the real stdio child's env (not even blanked)", startLine.sentinelPresence.LOOM_MCP_TOKEN === false);
  check("(2) a credential standing in for a DIFFERENT mount's delivery is ABSENT", startLine.sentinelPresence.PROBE_CRED_FOR_OTHER_MOUNT === false);
  check("(3) the daemon's own ambient env noise is ABSENT", startLine.sentinelPresence.PROBE_PLAIN_VAR === false);
  check("(4) THIS mount's own declared secret (secretEnvVar) IS present, with the real value", startLine.sentinelPresence.FIXTURE_SECRET === true && startLine.sentinelValueMatches.FIXTURE_SECRET === true);
  check("(5) a passEnv-named ambient var IS present in the real stdio child's env", startLine.sentinelPresence.PASSENV_ALLOWED_VAR === true && startLine.sentinelValueMatches.PASSENV_ALLOWED_VAR === true);
  check("(5b) an UN-named ambient var (same spawn) is still ABSENT", startLine.sentinelPresence.PASSENV_NOT_ALLOWED_VAR === false);
}
check("(6) the real MCP actually connected through the real claude process (tools/list served)", lines.some((l) => l.ev === "tools-list-served"));

// ===== disclosed: ONE real claude session started above; confirm no stray claude.exe remains =====
// Scoped to the process NAME too, not just the command-line marker — an unscoped command-line match is
// self-referential (THIS very powershell/bash check's own argv embeds the session id literal, so an
// unscoped match always "finds" itself and its own shell wrappers; card fafae623's own project-memory
// note on this exact trap: giveup-measurement-methodology).
if (process.platform === "win32") {
  const stray = spawnSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude.exe' -and $_.CommandLine -match [regex]::Escape('${sessionId}') } | Select-Object -ExpandProperty ProcessId`],
    { encoding: "utf8" });
  const strayPids = (stray.stdout ?? "").split(/\s+/).filter(Boolean);
  check("(cleanup) no stray claude.exe referencing this session id remains after the captured-pid kill", strayPids.length === 0);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card fafae623's real-spawn DoD: a REAL claude process, mounting a stdio MCP through the REAL rewritten buildMcpServers, delivers NEITHER LOOM_MCP_TOKEN (fully absent, not blanked) NOR a credential standing in for a different mount NOR the daemon's ambient env to the real spawned stdio child — while THIS mount's own secretEnvVar and a passEnv-named ambient var both correctly arrive, an un-named ambient var in the same spawn still doesn't, and the MCP still connects (served tools/list) — one real claude spawn, captured-pid killed, no stray process left."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
