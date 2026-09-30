import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ed0757d6 — the per-session `--mcp-config` secret file (writeSessionMcpConfig, claude-settings.ts)
// used to be written and NEVER unlinked: it survived rotation, connection deletion, capability removal,
// and session exit/archive indefinitely, leaving a plaintext capability secret on disk. This file proves
// the fix's full DoD:
//   PART 1 — the pure building blocks (claude-settings.js): sessionMcpConfigPath, unlinkSessionMcpConfig,
//            SETTINGS_DIR_READ_DENY_RULE, withSettingsDirDenyForSpawn — in isolation, no pty/DB.
//   PART 2 — the REAL (unsubclassed) `PtyHost.createPty()`, driven through a real child process
//            substituted for `claude` via LOOM_CLAUDE_BIN (the SAME technique
//            transcript-root-deny-chokepoint.mjs / kickoff-real-spawn.mjs already established, reusing
//            their shared fixture test/fixtures/fake-claude-cli.mjs, which never exits on its own):
//              DoD-1: a secret-free spawn unlinks a STALE file left behind for that same sessionId;
//              DoD-2: the EARLIEST safe point (markReady, i.e. SessionStart) unlinks the CURRENT spawn's
//                     own secret file — proven by checking the file is already gone immediately after
//                     `deliverHook(sid, {hook_event_name:"SessionStart"})` returns, no async wait needed
//                     (markReady's unlink call is synchronous, before any of its own async machinery);
//              DoD-2: the pty `onExit` handler is an unconditional backstop for a session that crashes
//                     (or is stopped) BEFORE ever reaching `ready`;
//              DoD-4: SETTINGS_DIR_READ_DENY_RULE is written into settings.json for EVERY role, including
//                     one the transcript-root deny gives NOTHING to (`run`) and one it gives only a
//                     PROJECT-SCOPED rule to (`worker`) — proving this deny is role-UNCONDITIONAL, unlike
//                     the transcript-root deny it sits beside.
//   PART 3 — the boot-time sweep (`pty/mcp-config-gc.js`'s `sweepOrphanedMcpConfigs`), against a REAL Db
//            (temp LOOM_HOME): the crash-before-cleanup backstop, DoD-3.
//
// WINDOWS-ONLY for PART 2 (the LOOM_CLAUDE_BIN .cmd-wrapper substitution technique is Windows-specific —
// see transcript-root-deny-chokepoint.mjs's own header for the same accepted POSIX gap); PARTS 1 and 3
// run everywhere.
//
// Run: 1) build (turbo builds shared first), 2) node test/mcp-config-secret-lifecycle.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-mcgc-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { PtyHost, WINDOWS_COMMAND_LINE_LIMIT } = await import("../dist/pty/host.js");
const {
  sessionMcpConfigPath, unlinkSessionMcpConfig, writeSessionMcpConfig,
  SETTINGS_DIR_READ_DENY_RULE, withSettingsDirDenyForSpawn,
} = await import("../dist/pty/claude-settings.js");
const { sweepOrphanedMcpConfigs } = await import("../dist/pty/mcp-config-gc.js");
const { ensureDirs, SETTINGS_DIR, WORKTREES_DIR } = await import("../dist/paths.js");
const { Db } = await import("../dist/db.js");

ensureDirs();
registerForCleanup(WORKTREES_DIR);

// =====================================================================================================
// PART 1 — the pure building blocks, in isolation (no DB, no pty)
// =====================================================================================================
{
  const sid = "part1-plain";
  const file = sessionMcpConfigPath(sid);
  check("sessionMcpConfigPath resolves under SETTINGS_DIR", file === path.join(SETTINGS_DIR, `${sid}.mcp-config.json`));

  let threw = false;
  try { unlinkSessionMcpConfig(sid); } catch { threw = true; }
  check("unlinkSessionMcpConfig on a MISSING file does not throw (the common case)", !threw);

  writeSessionMcpConfig(sid, { fake: { type: "stdio", command: "x", args: [] } });
  check("(setup) writeSessionMcpConfig actually wrote the file", fs.existsSync(file));
  unlinkSessionMcpConfig(sid);
  check("unlinkSessionMcpConfig removes an EXISTING file", !fs.existsSync(file));

  check("SETTINGS_DIR_READ_DENY_RULE = Read(<SETTINGS_DIR, forward-slashed>/**)",
    SETTINGS_DIR_READ_DENY_RULE === `Read(${SETTINGS_DIR.replace(/\\/g, "/")}/**)`);
  check("SETTINGS_DIR_READ_DENY_RULE has no backslashes (glob-safe on Windows)", !SETTINGS_DIR_READ_DENY_RULE.includes("\\"));

  const empty = withSettingsDirDenyForSpawn({ mode: "acceptEdits", allow: [], deny: [] });
  check("withSettingsDirDenyForSpawn: empty deny -> rule added", empty.deny.length === 1 && empty.deny[0] === SETTINGS_DIR_READ_DENY_RULE);

  const CUSTOM_DENY = "Bash(rm -rf /:*)";
  const withCustom = withSettingsDirDenyForSpawn({ mode: "acceptEdits", allow: [], deny: [CUSTOM_DENY] });
  check("withSettingsDirDenyForSpawn: unions with a project's own custom deny (never replaces)",
    withCustom.deny.includes(CUSTOM_DENY) && withCustom.deny.includes(SETTINGS_DIR_READ_DENY_RULE) && withCustom.deny.length === 2);

  const already = { mode: "acceptEdits", allow: [], deny: [SETTINGS_DIR_READ_DENY_RULE] };
  check("withSettingsDirDenyForSpawn: idempotent — same object reference when already present",
    withSettingsDirDenyForSpawn(already) === already);
}

// =====================================================================================================
// PART 2 — the REAL (unsubclassed) createPty, through a real node.exe substituted for `claude`
// =====================================================================================================
if (process.platform !== "win32") {
  console.log("WARN  SKIP  mcp-config-secret-lifecycle.mjs part 2 — the LOOM_CLAUDE_BIN .cmd-wrapper substitution technique this file uses is Windows-only (process.platform !== 'win32' here); see transcript-root-deny-chokepoint.mjs's own header for the accepted POSIX gap.");
} else {
  const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude-cli.mjs");
  const wrapperPath = path.join(tmpHome, "fake-claude.cmd");
  fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
  process.env.LOOM_CLAUDE_BIN = wrapperPath;
  // The fixture writes its received-input file under this dir; give it one per session isn't needed here
  // since this file never asserts on stdin content — but FIXTURE_OUTPUT_FILE is a REQUIRED env var (the
  // fixture exits 1 without it), so point it at a throwaway path even though nothing reads it back.
  process.env.FIXTURE_OUTPUT_FILE = path.join(tmpHome, "fixture-output");

  const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

  // Registry-capability wiring: a fake catalog row + a fake connection-secret resolver, so a spawn that
  // asks for `{slug:"needs-cred", connectionId:"conn1"}` actually gets a real secret injected into its
  // mcpServers map — exactly what makes createPty divert to writeSessionMcpConfig (mcpConfigHasSecret).
  const CRED_DEF = {
    id: "cap1", slug: "needs-cred", name: "Needs Cred", description: "test", transport: "stdio", kind: "bundled",
    provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: ["--version"] }),
    toolAllowlistJson: JSON.stringify([]), wantsScratchDir: false, requiresConnection: true, secretEnvVar: "FAKE_TOKEN",
    createdAt: new Date().toISOString(),
  };
  const host = new PtyHost(events, {
    getCapabilityCatalog: () => [CRED_DEF],
    resolveConnectionSecret: (id) => (id === "conn1" ? "super-secret-value" : undefined),
  });

  const readWrittenDeny = (sessionId) => {
    const file = path.join(SETTINGS_DIR, `${sessionId}.json`);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    return json.permissions?.deny ?? [];
  };

  const spawned = [];
  const spawnWithSecret = (sessionId, role = "worker") => {
    host.spawn({
      sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role,
      capabilities: [{ slug: "needs-cred", connectionId: "conn1" }],
    });
    spawned.push(sessionId);
  };
  const spawnNoSecret = (sessionId, role = "worker") => {
    host.spawn({
      sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role,
    });
    spawned.push(sessionId);
  };

  try {
    // --- DoD-1: a SECRET-FREE spawn unlinks a STALE file left behind for that same sessionId ---
    {
      const sid = "mcgc-dod1-stale";
      const staleFile = sessionMcpConfigPath(sid);
      writeSessionMcpConfig(sid, { fake: { type: "stdio", command: "x", args: [], env: { FAKE_TOKEN: "old-leaked-secret" } } });
      check("(DoD-1 setup) a stale mcp-config file exists BEFORE the secret-free spawn", fs.existsSync(staleFile));
      spawnNoSecret(sid);
      check("(DoD-1) a spawn WITHOUT secrets unlinks the STALE file for that sessionId — SYNCHRONOUSLY, inside createPty", !fs.existsSync(staleFile));
    }

    // --- DoD-2 (markReady): the CURRENT spawn's own secret file is gone right after SessionStart ---
    {
      const sid = "mcgc-dod2-ready";
      spawnWithSecret(sid);
      const file = sessionMcpConfigPath(sid);
      check("(DoD-2 setup) a secret-bearing spawn DOES write its own mcp-config file", fs.existsSync(file));
      check("(DoD-2 setup) the written file actually contains the secret", fs.readFileSync(file, "utf8").includes("super-secret-value"));
      host.deliverHook(sid, { hook_event_name: "SessionStart" });
      check("(DoD-2) markReady (SessionStart) unlinks the CURRENT spawn's own secret file, synchronously", !fs.existsSync(file));
    }

    // --- DoD-2 (onExit backstop): a session that never reaches `ready` still gets cleaned up on exit ---
    {
      const sid = "mcgc-dod2-exit";
      spawnWithSecret(sid);
      const file = sessionMcpConfigPath(sid);
      check("(DoD-2/exit setup) a secret-bearing spawn DOES write its own mcp-config file", fs.existsSync(file));
      // Deliberately NEVER deliver SessionStart — simulates a crash/abandon before `ready`.
      host.stop(sid, "hard");
      // A REAL child process's exit is genuinely async (the OS/node-pty fires it on a later tick) —
      // unlike markReady's synchronous unlink above, this can't be checked immediately after stop()
      // returns. Wait for the OBSERVABLE event (the session going non-alive), never a blind sleep.
      await waitUntil(() => !host.isAlive(sid), { label: `${sid} pty exit`, timeoutMs: 15000 });
      check("(DoD-2/exit) the pty onExit backstop unlinks the file even though `ready` never fired", !fs.existsSync(file));
    }

    // --- Code Review fix #1: a THROW after the write (the Windows argv preflight) still cleans up its
    // own file — a spawn that dies here gets NO `Live` entry, so neither markReady nor onExit would ever
    // reach it; RED on the pre-fix tip (bec87fe7 alone, before this follow-up commit). An oversized
    // `--model` value is a directly test-controllable way to force preflightWindowsCommandLine to fail,
    // independent of anything else in argv. ---
    {
      const sid = "mcgc-cr1-preflight-throw";
      const file = sessionMcpConfigPath(sid);
      const hugeModel = "x".repeat(WINDOWS_COMMAND_LINE_LIMIT + 1000);
      let threw = false;
      try {
        host.spawn({
          sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
          geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker",
          capabilities: [{ slug: "needs-cred", connectionId: "conn1" }],
          model: hugeModel,
        });
      } catch {
        threw = true;
      }
      check("(CR fix 1 setup) the oversized-argv spawn actually THREW (the preflight really tripped, not a no-op)", threw);
      check("(CR fix 1) a throw AFTER the write (Windows argv preflight) still unlinks the just-written secret file", !fs.existsSync(file));
      // Deliberately NOT pushed to `spawned` — spawn() threw, so createPty never returned a pty and no
      // `Live` entry was ever registered; there is nothing for host.stop() to act on.
    }

    // --- DoD-4: SETTINGS_DIR_READ_DENY_RULE is written for EVERY role, unconditionally ---
    for (const role of ["worker", "run", "manager", "assistant"]) {
      const sid = `mcgc-dod4-${role}`;
      spawnNoSecret(sid, role);
      const deny = readWrittenDeny(sid);
      check(`(DoD-4) role '${role}': WRITTEN settings.json permissions.deny INCLUDES the SETTINGS_DIR rule (unconditional, unlike the transcript-root deny)`,
        deny.includes(SETTINGS_DIR_READ_DENY_RULE));
    }
  } finally {
    for (const sid of spawned) { try { host.stop(sid, "hard"); } catch { /* best-effort cleanup — may already be stopped */ } }
  }
}

// =====================================================================================================
// PART 3 — the boot-time sweep (sweepOrphanedMcpConfigs), against a REAL Db
// =====================================================================================================
{
  const db = new Db();
  try {
    const now = new Date().toISOString();
    db.insertProject({ id: "proj1", name: "P", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "agent1", projectId: "proj1", name: "A", startupPrompt: "", position: 0 });

    function insertSessionRow({ id, processState }) {
      db.insertSession({
        id, projectId: "proj1", agentId: "agent1", engineSessionId: null, title: null,
        cwd: tmpHome, processState, resumability: "unknown", busy: false,
        createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null,
        harness: "claude",
      });
    }

    function seedFile(sid) { fs.writeFileSync(sessionMcpConfigPath(sid), JSON.stringify({ mcpServers: {} })); }
    // Card ed0757d6 Code Review fix #2: a `.tmp` file (writeSessionMcpConfig's write-then-rename can strand
    // one on a crash, or a Windows renameSync EPERM) carries the SAME secret and must be swept under the
    // SAME liveness rule — seed both a reapable and a NOT-reapable `.tmp` to prove the rule applies both
    // ways, not just "any .tmp is fair game".
    function seedTmpFile(sid) { fs.writeFileSync(`${sessionMcpConfigPath(sid)}.tmp`, JSON.stringify({ mcpServers: {} })); }

    insertSessionRow({ id: "sweep-live", processState: "live" });
    insertSessionRow({ id: "sweep-starting", processState: "starting" });
    insertSessionRow({ id: "sweep-exited", processState: "exited" });
    insertSessionRow({ id: "sweep-tmp-live", processState: "live" });
    insertSessionRow({ id: "sweep-tmp-exited", processState: "exited" });
    // No row inserted for "sweep-no-row" — its file predates any row we can find.
    seedFile("sweep-live");
    seedFile("sweep-starting");
    seedFile("sweep-exited");
    seedFile("sweep-no-row");
    seedTmpFile("sweep-tmp-live");
    seedTmpFile("sweep-tmp-exited");
    // A non-mcp-config file under SETTINGS_DIR (a plain settings.json) must be untouched by this sweep.
    const untouchedSettingsFile = path.join(SETTINGS_DIR, "sweep-live.json");
    fs.writeFileSync(untouchedSettingsFile, "{}");

    const result = sweepOrphanedMcpConfigs(db);

    // The exact count here does double duty: it's the DoD-3 assertion AND a cross-part leak check — if any
    // earlier PART left an unexpected *.mcp-config.json[.tmp] behind in the REAL SETTINGS_DIR (PART 2's own
    // spawns all clean up after themselves, but a regression there would silently inflate this number), the
    // count would drift off 6 and this line would catch it, not just the more the specific per-file checks below.
    check("(DoD-3) scanned count = exactly the 6 seeded *.mcp-config.json[.tmp] files (the plain .json settings file is NOT counted; also a cross-part leak check)", result.scanned === 6);
    check("(DoD-3) a LIVE session's mcp-config file is NEVER reaped", fs.existsSync(sessionMcpConfigPath("sweep-live")));
    check("(DoD-3) a STARTING session's mcp-config file is NEVER reaped", fs.existsSync(sessionMcpConfigPath("sweep-starting")));
    check("(DoD-3) an EXITED session's orphaned mcp-config file IS reaped", !fs.existsSync(sessionMcpConfigPath("sweep-exited")));
    check("(DoD-3) a NO-DB-ROW mcp-config file IS reaped (nothing left that could still need it)", !fs.existsSync(sessionMcpConfigPath("sweep-no-row")));
    check("(DoD-3) a LIVE session's STRANDED .tmp file is NEVER reaped (same rule as the plain case)", fs.existsSync(`${sessionMcpConfigPath("sweep-tmp-live")}.tmp`));
    check("(DoD-3) an EXITED session's STRANDED .tmp file IS reaped (same rule as the plain case)", !fs.existsSync(`${sessionMcpConfigPath("sweep-tmp-exited")}.tmp`));
    check("(DoD-3) the reaped list names exactly the 3 expected files, no more",
      result.reaped.sort().join(",") === ["sweep-exited.mcp-config.json", "sweep-no-row.mcp-config.json", "sweep-tmp-exited.mcp-config.json.tmp"].sort().join(","));
    check("(DoD-3) a plain settings.json file (wrong suffix) is left completely untouched", fs.existsSync(untouchedSettingsFile));

    // Re-running immediately after: the reaped files are gone, so a fresh sweep of the SAME (still-real,
    // now-cleaner) SETTINGS_DIR finds nothing left of them to reap again, and never throws.
    let threwOnRerun = false;
    let rerunResult;
    try { rerunResult = sweepOrphanedMcpConfigs(db); } catch { threwOnRerun = true; }
    check("(DoD-3) a second sweep never throws", !threwOnRerun);
    check("(DoD-3) a second sweep no longer finds the already-reaped files",
      !rerunResult?.reaped.includes("sweep-exited.mcp-config.json") && !rerunResult?.reaped.includes("sweep-no-row.mcp-config.json") && !rerunResult?.reaped.includes("sweep-tmp-exited.mcp-config.json.tmp"));
  } finally {
    // Card ed0757d6 Code Review fix #3: an un-closed Db leaked the temp LOOM_HOME's loom.db handle,
    // leaving mkdtempManaged's own cleanup unable to remove it (EBUSY) and stranding the whole temp dir.
    db.close();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the mcp-config secret file gets a full lifecycle: a secret-free spawn clears a stale file (DoD-1), the current spawn's own file is cleared at the earliest safe point (SessionStart/markReady) with an unconditional onExit backstop (DoD-2), SETTINGS_DIR is denied to every role unconditionally (DoD-4), and a boot-time sweep catches anything a hard crash left behind (DoD-3)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
