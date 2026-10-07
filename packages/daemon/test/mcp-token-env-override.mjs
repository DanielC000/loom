import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a50b8afd, Code Review round 2 — two standing guarantees this file proves, both already true BY
// CONSTRUCTION before this round (the explicit mcpToken env-assignment lines in createPty/createCodexPty
// run AFTER buildSpawnEnv has already merged sessionEnv, so they are always the LAST write to that key),
// but not previously proven by a test:
//   PART 1 — buildSpawnEnv (pure, no pty): a LOOM_MCP_TOKEN inherited from the DAEMON's own process env
//            is scrubbed, exactly like the existing CLAUDECODE/CLAUDE_CODE_* scrub.
//   PART 2 — a REAL claude spawn (LOOM_CLAUDE_BIN substitution, reusing test/fixtures/fake-claude-cli.mjs):
//            a project's sessionEnv.LOOM_MCP_TOKEN can NEVER override the minted token in the process's
//            OWN real env — proven via the fixture's additive FIXTURE_ENV_DUMP_FILE hook.
//   PART 3 — a REAL codex spawn (LOOM_CODEX_BIN substitution, the SAME fake-claude-cli.mjs fixture — its
//            contract doesn't depend on claude-specific argv shape): the identical guarantee for
//            createCodexPty, which sets `env[MCP_TOKEN_ENV_VAR]` unconditionally on EVERY platform.
//   PART 4 — Code Review round 3: createShellPty's OWN, separate env-build path (it bypasses
//            buildSpawnEnv entirely, by design) ALSO scrubs an inherited LOOM_MCP_TOKEN — proven via a
//            real `node -e` child that dumps its own env to a file.
//
// WINDOWS-ONLY for PARTS 2/3/4 (the LOOM_CLAUDE_BIN/LOOM_CODEX_BIN .cmd-wrapper substitution technique is
// Windows-specific — see transcript-root-deny-chokepoint.mjs's own header for the accepted POSIX gap);
// PART 1 runs everywhere.
//
// Run: 1) build (turbo builds shared first), 2) node test/mcp-token-env-override.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-mtenv-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Card 849acf9b: PART 2's real claude spawn below reaches ensureTrustedResilient -> ensureTrusted
// (host.ts) unconditionally, which writes a trust entry into whatever claudeJsonPath() resolves to. Left
// unredirected, that landed in the OWNER'S REAL ~/.claude.json on every run. Redirect CLAUDE_CONFIG_DIR
// (claudeJsonPath() honors it directly) AND HOME/USERPROFILE (belt-and-suspenders —
// discoverProjectMcpServerNames, also called from ensureTrusted, walks up from cwd to os.homedir() for
// ~/.mcp.json) to this test's own temp root BEFORE the ../dist import, same convention as
// trust-lock.mjs/claude-config-worktree-prune.mjs. Harmless for PART 1/3/4 (PART 3 is codex-only —
// createCodexPty never reaches ensureTrusted at all — and PART 1/4 never spawn a real claude process).
const claudeConfigDir = path.join(tmpHome, "claude-config");
fs.mkdirSync(claudeConfigDir, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { PtyHost, buildSpawnEnv } = await import("../dist/pty/host.js");
const { MCP_TOKEN_ENV_VAR } = await import("../dist/pty/codex-host.js");
const { ensureDirs, WORKTREES_DIR } = await import("../dist/paths.js");
const { claudeJsonPath } = await import("../dist/pty/claude-config.js");

ensureDirs();
registerForCleanup(WORKTREES_DIR);

// Assert the redirect actually took before PART 2's real claude spawn below can reach ensureTrusted. A
// dropped/broken redirect fails HERE, by name, and this file ABORTS rather than falling through to a
// real spawn that would write the owner's real ~/.claude.json.
{
  const resolvedClaudeJsonPath = path.resolve(claudeJsonPath());
  const expectedClaudeJsonPath = path.resolve(path.join(claudeConfigDir, ".claude.json"));
  check("claudeJsonPath() resolves under this test's own temp CLAUDE_CONFIG_DIR, never the real ~/.claude.json",
    resolvedClaudeJsonPath === expectedClaudeJsonPath);
  if (resolvedClaudeJsonPath !== expectedClaudeJsonPath) {
    console.log(`\n❌ ${failures} FAILURE(S) — refusing to proceed: claudeJsonPath() does not resolve under this test's own CLAUDE_CONFIG_DIR, so PART 2's real claude spawn below would reach the OWNER'S REAL ~/.claude.json. Aborting before any real spawn.`);
    await finishAndExit(1);
  }
}

// =====================================================================================================
// PART 1 — buildSpawnEnv scrubs an inherited LOOM_MCP_TOKEN from the DAEMON's own process env
// =====================================================================================================
{
  const pollutedProcessEnv = { ...process.env, [MCP_TOKEN_ENV_VAR]: "stray-inherited-from-daemon-own-env" };
  const env = buildSpawnEnv(pollutedProcessEnv, {}, tmpHome);
  check(`(PART 1) buildSpawnEnv scrubs an inherited ${MCP_TOKEN_ENV_VAR} from processEnv, same as CLAUDECODE/CLAUDE_CODE_*`,
    env[MCP_TOKEN_ENV_VAR] === undefined);
  // Positive control: prove the scrub is SPECIFIC to this one key, not an accidental drop of everything —
  // an unrelated inherited var must still survive.
  const envWithUnrelated = buildSpawnEnv({ ...process.env, LOOM_UNRELATED_PROBE_VAR: "survives" }, {}, tmpHome);
  check("(PART 1 positive control) an UNRELATED inherited env var survives the scrub untouched (proves this isn't a blanket env wipe)",
    envWithUnrelated.LOOM_UNRELATED_PROBE_VAR === "survives");
  // Card a50b8afd: a DELIBERATE sessionEnv override is NOT touched by this scrub (the scrub only strips
  // the DAEMON's own processEnv, before the sessionEnv merge) — this is intentional; PART 2/3 below prove
  // the LATER mint-and-assign line is what actually protects against this value reaching a real spawn.
  const envWithSessionOverride = buildSpawnEnv(process.env, { [MCP_TOKEN_ENV_VAR]: "deliberate-session-value" }, tmpHome);
  check("(PART 1) buildSpawnEnv itself does NOT strip a sessionEnv-provided value — that protection is the CALLER's own later assignment, proven in PART 2/3",
    envWithSessionOverride[MCP_TOKEN_ENV_VAR] === "deliberate-session-value");
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude-cli.mjs");
const wrapperPath = (name) => {
  const p = path.join(tmpHome, name);
  fs.writeFileSync(p, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
  return p;
};

if (process.platform !== "win32") {
  console.log("WARN  SKIP  mcp-token-env-override.mjs PARTS 2/3 — the LOOM_CLAUDE_BIN/LOOM_CODEX_BIN .cmd-wrapper substitution technique this file uses is Windows-only (process.platform !== 'win32' here); see transcript-root-deny-chokepoint.mjs's own header for the accepted POSIX gap.");
} else {
  const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

  // =====================================================================================================
  // PART 2 — a REAL claude spawn: sessionEnv.LOOM_MCP_TOKEN can NEVER override the minted token
  // =====================================================================================================
  {
    process.env.LOOM_CLAUDE_BIN = wrapperPath("fake-claude-part2.cmd");
    const sid = "mtenv-part2-claude";
    const dumpPath = path.join(tmpHome, `${sid}-env-dump.json`);
    const outputPath = path.join(tmpHome, `${sid}-fixture-output`);
    const host = new PtyHost(events);
    host.spawn({
      sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, role: "worker",
      sessionEnv: {
        FIXTURE_OUTPUT_FILE: outputPath,
        FIXTURE_ENV_DUMP_FILE: dumpPath,
        [MCP_TOKEN_ENV_VAR]: "attacker-controlled-via-sessionenv", // what this test is attacking with
      },
    });
    try {
      const liveToken = host.live.get(sid)?.mcpToken;
      check("(PART 2 setup) the live session has a real, non-empty minted mcpToken", typeof liveToken === "string" && liveToken.length > 0);
      await waitUntil(() => fs.existsSync(dumpPath), { label: `${sid} fixture env dump`, timeoutMs: 15000 });
      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      check("(PART 2, card a50b8afd regression) claude's REAL spawned env carries the MINTED token, not the sessionEnv attacker value",
        dump[MCP_TOKEN_ENV_VAR] === liveToken);
      check("(PART 2 negative control) the attacker-controlled sessionEnv value does NOT survive into the real spawn's env",
        dump[MCP_TOKEN_ENV_VAR] !== "attacker-controlled-via-sessionenv");
    } finally {
      try { host.stop(sid, "hard"); } catch { /* best-effort */ }
      try { await waitUntil(() => !host.isAlive(sid), { label: `${sid} pty exit (cleanup)`, timeoutMs: 15000 }); } catch { /* best-effort */ }
    }
  }

  // =====================================================================================================
  // PART 3 — a REAL codex spawn (fake binary): the SAME guarantee for createCodexPty
  // =====================================================================================================
  {
    process.env.LOOM_CODEX_BIN = wrapperPath("fake-codex-part3.cmd");
    const sid = "mtenv-part3-codex";
    const dumpPath = path.join(tmpHome, `${sid}-env-dump.json`);
    const outputPath = path.join(tmpHome, `${sid}-fixture-output`);
    const host = new PtyHost(events);
    host.spawn({
      sessionId: sid, cwd: tmpHome, permission: {}, geometry: { cols: 120, rows: 40 }, role: undefined, harness: "codex",
      sessionEnv: {
        FIXTURE_OUTPUT_FILE: outputPath,
        FIXTURE_ENV_DUMP_FILE: dumpPath,
        [MCP_TOKEN_ENV_VAR]: "attacker-controlled-via-sessionenv-codex",
      },
    });
    try {
      const liveToken = host.liveCodex?.get(sid)?.mcpToken;
      check("(PART 3 setup) the live codex session has a real, non-empty minted mcpToken", typeof liveToken === "string" && liveToken.length > 0);
      await waitUntil(() => fs.existsSync(dumpPath), { label: `${sid} fixture env dump`, timeoutMs: 15000 });
      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      check("(PART 3, card a50b8afd regression) codex's REAL spawned env carries the MINTED token, not the sessionEnv attacker value",
        dump[MCP_TOKEN_ENV_VAR] === liveToken);
      check("(PART 3 negative control) the attacker-controlled sessionEnv value does NOT survive into the real codex spawn's env",
        dump[MCP_TOKEN_ENV_VAR] !== "attacker-controlled-via-sessionenv-codex");
    } finally {
      try { host.stop(sid, "hard"); } catch { /* best-effort */ }
    }
  }

  // =====================================================================================================
  // PART 4 — Code Review round 3: createShellPty also scrubs an inherited LOOM_MCP_TOKEN (it bypasses
  // buildSpawnEnv entirely, by design — "inherits the daemon's env wholesale" — so PART 1's scrub alone
  // does NOT cover this path; it needs its own, separate proof). A real node child dumps its OWN env to a
  // file — the same shape as the fake-claude-cli fixture, but inline here since this is a plain `node -e`
  // shell command, not a substituted claude/codex binary.
  // =====================================================================================================
  {
    const host = new PtyHost(events);
    const dumpPath = path.join(tmpHome, "part4-shell-env-dump.json");
    const script = `require('fs').writeFileSync(process.argv[1], JSON.stringify({ LOOM_MCP_TOKEN: process.env.LOOM_MCP_TOKEN ?? null }))`;
    const priorValue = process.env[MCP_TOKEN_ENV_VAR];
    process.env[MCP_TOKEN_ENV_VAR] = "stray-inherited-on-daemon-process-itself";
    try {
      host.spawnShell({
        id: "part4-shell", cwd: tmpHome, command: process.execPath, args: ["-e", script, dumpPath],
        geometry: { cols: 120, rows: 40 }, label: "test",
      });
      await waitUntil(() => fs.existsSync(dumpPath), { label: "part4-shell env dump", timeoutMs: 15000 });
      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      check("(PART 4, card a50b8afd Code Review round 3 FIX) createShellPty scrubs an inherited LOOM_MCP_TOKEN from the daemon's own process env — a plain shell does NOT inherit it",
        dump.LOOM_MCP_TOKEN === null || dump.LOOM_MCP_TOKEN === undefined);
    } finally {
      if (priorValue === undefined) delete process.env[MCP_TOKEN_ENV_VAR]; else process.env[MCP_TOKEN_ENV_VAR] = priorValue;
      try { host.stop("part4-shell", "hard"); } catch { /* best-effort */ }
    }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — buildSpawnEnv scrubs an inherited LOOM_MCP_TOKEN from the daemon's own process env, a project's sessionEnv/credentialEnv can never override the per-spawn MINTED mcpToken in the REAL spawned process's env on both the claude and codex paths, and createShellPty's own separate (buildSpawnEnv-bypassing) env-build path scrubs it too."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
