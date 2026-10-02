import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ed0757d6 — the per-session `--mcp-config` secret file (writeSessionMcpConfig, claude-settings.ts)
// used to be written and NEVER unlinked: it survived rotation, connection deletion, capability removal,
// and session exit/archive indefinitely, leaving a plaintext capability secret on disk. Card a50b8afd
// widened this file's own scope: (b1) the mcpToken header is now a `${LOOM_MCP_TOKEN}` placeholder, never
// a literal value, and (b2) the SIBLING `--settings` file (`<sid>.json`, the hook token) gets the exact
// same lifecycle this file already established for mcp-config.json. This file proves the fix's full DoD:
//   PART 1 — the pure building blocks (claude-settings.js): sessionMcpConfigPath, unlinkSessionMcpConfig,
//            sessionSettingsPath, unlinkSessionSettings, SETTINGS_DIR_READ_DENY_RULE,
//            withSettingsDirDenyForSpawn — in isolation, no pty/DB. Also buildMcpServers (host.js), pure:
//            the mcpToken placeholder (b1). Card 2be634f2 considered — and REJECTED — generalizing that
//            SAME placeholder pattern to third-party capability connection secrets: claude's own process
//            env is inherited by everything it spawns, including the agent's own Bash/PowerShell, so
//            putting a capability secret there would hand the agent a raw third-party secret for the
//            whole session. The tests below PIN the rejected shape: a capability secret stays the
//            LITERAL value in the map/file on every platform, and is NEVER added to claude's own spawn
//            env — see docs/decisions/2be634f2-capability-secret-env-placeholder-generalization.md.
//   PART 2 — the REAL (unsubclassed) `PtyHost.createPty()`, driven through a real child process
//            substituted for `claude` via LOOM_CLAUDE_BIN (the SAME technique
//            transcript-root-deny-chokepoint.mjs / kickoff-real-spawn.mjs already established, reusing
//            their shared fixture test/fixtures/fake-claude-cli.mjs, which never exits on its own):
//              DoD-1: a secret-free spawn unlinks a STALE file left behind for that same sessionId;
//              DoD-2: the EARLIEST safe point (markReady, i.e. SessionStart) unlinks the CURRENT spawn's
//                     own secret file(s) — mcp-config.json AND (card a50b8afd) settings.json — proven by
//                     checking both files are already gone immediately after
//                     `deliverHook(sid, {hook_event_name:"SessionStart"})` returns, no async wait needed
//                     (markReady's unlink calls are synchronous, before any of its own async machinery);
//              DoD-2: the pty `onExit` handler is an unconditional backstop for a session that crashes
//                     (or is stopped) BEFORE ever reaching `ready`, for BOTH files;
//              DoD-4: SETTINGS_DIR_READ_DENY_RULE is written into settings.json for EVERY role, including
//                     one the transcript-root deny gives NOTHING to (`run`) and one it gives only a
//                     PROJECT-SCOPED rule to (`worker`) — proving this deny is role-UNCONDITIONAL, unlike
//                     the transcript-root deny it sits beside.
//              (b1): a real spawn's written mcp-config.json file contains NO mcpToken bytes, while the
//                     real spawned process's OWN env carries the real value (via the fixture's additive
//                     FIXTURE_ENV_DUMP_FILE dump — see fake-claude-cli.mjs's own doc).
//   PART 3 — the boot-time sweep (`pty/mcp-config-gc.js`'s `sweepOrphanedSettingsDirSecrets`), against a
//            REAL Db (temp LOOM_HOME): the crash-before-cleanup backstop, DoD-3, now covering BOTH file
//            kinds under ONE sweep.
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

const { PtyHost, WINDOWS_COMMAND_LINE_LIMIT, buildMcpServers, applyMcpTokenEnv, collectMcpEnvSecrets, playwrightMcpServer, blanksMcpToken } = await import("../dist/pty/host.js");
const { MCP_TOKEN_ENV_VAR } = await import("../dist/pty/codex-host.js");
const {
  sessionMcpConfigPath, unlinkSessionMcpConfig, writeSessionMcpConfig,
  sessionSettingsPath, unlinkSessionSettings, mcpTokenRidesEnv,
  SETTINGS_DIR_READ_DENY_RULE, withSettingsDirDenyForSpawn,
} = await import("../dist/pty/claude-settings.js");
const { sweepOrphanedSettingsDirSecrets } = await import("../dist/pty/mcp-config-gc.js");
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

  // --- Card a50b8afd (b2): the SIBLING `--settings` file gets the SAME pure-building-block shape ---
  const settingsFile = sessionSettingsPath(sid);
  check("sessionSettingsPath resolves under SETTINGS_DIR", settingsFile === path.join(SETTINGS_DIR, `${sid}.json`));

  let settingsThrew = false;
  try { unlinkSessionSettings(sid); } catch { settingsThrew = true; }
  check("unlinkSessionSettings on a MISSING file does not throw (the common case)", !settingsThrew);

  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: {}, permissions: { defaultMode: "acceptEdits", allow: [], deny: [] } }));
  check("(setup) a settings file exists before unlink", fs.existsSync(settingsFile));
  unlinkSessionSettings(sid);
  check("unlinkSessionSettings removes an EXISTING file", !fs.existsSync(settingsFile));

  // --- Card a50b8afd (b1), Code Review platform-split: mcpTokenRidesEnv is the ONE decision helper ---
  check("mcpTokenRidesEnv('win32') -> true", mcpTokenRidesEnv("win32") === true);
  check("mcpTokenRidesEnv('linux') -> false", mcpTokenRidesEnv("linux") === false);
  check("mcpTokenRidesEnv('darwin') -> false", mcpTokenRidesEnv("darwin") === false);
  check("mcpTokenRidesEnv() with no arg resolves the REAL host platform", mcpTokenRidesEnv() === (process.platform === "win32"));

  // --- buildMcpServers: BOTH platform branches, forced via injection — on ANY host, independent of what
  // this test is actually running on (card a50b8afd Code Review: "test both branches on any host") ---
  const REAL_TOKEN = "this-must-never-appear-in-the-map-c33a1b9e";
  const win32Servers = buildMcpServers({ sessionId: "probe-sid", port: 4317, role: "worker", mcpToken: REAL_TOKEN, mcpTokenRidesEnv: true });
  const posixServers = buildMcpServers({ sessionId: "probe-sid", port: 4317, role: "worker", mcpToken: REAL_TOKEN, mcpTokenRidesEnv: false });
  check("(b1, forced win32) Authorization header is the literal ${MCP_TOKEN_ENV_VAR} placeholder, never the real token",
    win32Servers["loom-tasks"]?.headers?.Authorization === `Bearer \${${MCP_TOKEN_ENV_VAR}}`);
  check("(b1, forced win32, negative control) the real token string does NOT appear anywhere in the win32-branch map",
    !JSON.stringify(win32Servers).includes(REAL_TOKEN));
  check("(b1, forced POSIX) Authorization header is the LITERAL real token, unchanged from pre-card behavior",
    posixServers["loom-tasks"]?.headers?.Authorization === `Bearer ${REAL_TOKEN}`);
  check("(b1, forced POSIX, negative control) the placeholder string does NOT appear in the POSIX-branch map (proves the two branches actually differ, not just one always winning)",
    !JSON.stringify(posixServers).includes("${LOOM_MCP_TOKEN}"));
  check("(b1 positive control) a map built WITHOUT mcpToken carries no headers field at all REGARDLESS of mcpTokenRidesEnv (proves the assertions above discriminate on mcpToken presence, not just 'always true')",
    buildMcpServers({ sessionId: "probe-sid", port: 4317, role: "worker", mcpTokenRidesEnv: true })["loom-tasks"]?.headers === undefined
    && buildMcpServers({ sessionId: "probe-sid", port: 4317, role: "worker", mcpTokenRidesEnv: false })["loom-tasks"]?.headers === undefined);
  check("(b1) omitting mcpTokenRidesEnv entirely defaults to the REAL host platform's own mcpTokenRidesEnv() value",
    JSON.stringify(buildMcpServers({ sessionId: "probe-sid", port: 4317, role: "worker", mcpToken: REAL_TOKEN }))
    === JSON.stringify(mcpTokenRidesEnv() ? win32Servers : posixServers));

  // --- Card a50b8afd, Code Review round 3: applyMcpTokenEnv — the EXTRACTED env-decision, pure, BOTH
  // branches assertable with no spawn at all. This is the test that catches a regression IN THE HELPER
  // ITSELF; it does NOT, by itself, catch a regression at the CALL SITE (createPty bypassing the helper or
  // inlining the conditional again) — the forced-platform REAL-spawn tests further down close that gap. ---
  const envTrue = {};
  applyMcpTokenEnv(envTrue, "real-token-abc", true);
  check("(applyMcpTokenEnv) ridesEnv:true sets the real token", envTrue[MCP_TOKEN_ENV_VAR] === "real-token-abc");
  const envFalse = {};
  applyMcpTokenEnv(envFalse, "real-token-abc", false);
  check("(applyMcpTokenEnv) ridesEnv:false sets NOTHING", envFalse[MCP_TOKEN_ENV_VAR] === undefined && Object.keys(envFalse).length === 0);
  const envNoToken = {};
  applyMcpTokenEnv(envNoToken, undefined, true);
  check("(applyMcpTokenEnv) no mcpToken sets NOTHING even when ridesEnv:true", envNoToken[MCP_TOKEN_ENV_VAR] === undefined);

  // --- Card 2be634f2: CONSIDERED AND REJECTED generalizing (b1)'s placeholder pattern to third-party
  // capability connection secrets — claude's own process env is inherited by everything it spawns
  // (including the agent's own Bash/PowerShell), so putting a capability secret there would hand the
  // agent a raw third-party secret for the whole session. These pin the REJECTED shape: a capability
  // secret stays the LITERAL value in the map, on EITHER platform, regardless of `mcpTokenRidesEnv` —
  // unlike the mcpToken header, which still differs per platform. Two catalog rows: a plain
  // requiresConnection grant and one that ALSO wantsScratchDir (proves the separate outputDirEnvVar
  // scratch-dir value is unaffected by whatever this grant's own secret does). ---
  {
    const CRED_ROW_A = {
      id: "cap-a", slug: "cap-a", name: "Cap A", description: "test", transport: "stdio", kind: "bundled",
      provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: ["a.js"] }),
      toolAllowlistJson: JSON.stringify([]), wantsScratchDir: false, requiresConnection: true, secretEnvVar: "CRED_A_TOKEN",
      createdAt: new Date().toISOString(),
    };
    const CRED_ROW_SCRATCH = {
      id: "cap-c", slug: "cap-c", name: "Cap C", description: "test", transport: "stdio", kind: "bundled",
      provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: ["c.js"], outputDirEnvVar: "CAP_C_OUTPUT_DIR" }),
      toolAllowlistJson: JSON.stringify([]), wantsScratchDir: true, requiresConnection: true, secretEnvVar: "CRED_C_TOKEN",
      createdAt: new Date().toISOString(),
    };
    const CAP_CATALOG = [CRED_ROW_A, CRED_ROW_SCRATCH];
    const CAP_GRANTS = [{ slug: "cap-a", connectionId: "conn-a" }, { slug: "cap-c", connectionId: "conn-c" }];
    const CAP_SECRETS = { "conn-a": "secret-A-f3a1", "conn-c": "secret-C-7be0" };
    const resolveCapSecret = (id) => CAP_SECRETS[id];

    const win32CapServers = buildMcpServers({
      sessionId: "probe-sid", port: 4317, role: "worker",
      capabilities: CAP_GRANTS, capabilityCatalog: CAP_CATALOG, resolveConnectionSecret: resolveCapSecret,
      mcpTokenRidesEnv: true,
    });
    check("(2be634f2 REJECTED, win32-forced) cap-a's secret stays the LITERAL value — never a placeholder, even with ridesEnv true",
      win32CapServers["cap-a"]?.env?.CRED_A_TOKEN === "secret-A-f3a1");
    check("(2be634f2 REJECTED, win32-forced) cap-c's secret ALSO stays literal",
      win32CapServers["cap-c"]?.env?.CRED_C_TOKEN === "secret-C-7be0");
    check("(2be634f2 REJECTED, win32-forced, negative control) no LOOM_CAP_SECRET_ placeholder string appears anywhere in the map",
      !JSON.stringify(win32CapServers).includes("LOOM_CAP_SECRET_"));
    check("(2be634f2) cap-c's outputDirEnvVar value is a real path, unaffected by its sibling secret",
      win32CapServers["cap-c"]?.env?.CAP_C_OUTPUT_DIR?.includes("probe-sid"));

    const posixCapServers = buildMcpServers({
      sessionId: "probe-sid", port: 4317, role: "worker",
      capabilities: CAP_GRANTS, capabilityCatalog: CAP_CATALOG, resolveConnectionSecret: resolveCapSecret,
      mcpTokenRidesEnv: false,
    });
    check("(2be634f2 REJECTED, POSIX-forced) cap-a's secret ALSO stays the literal value — platform makes no difference for capability secrets",
      posixCapServers["cap-a"]?.env?.CRED_A_TOKEN === "secret-A-f3a1");
    check("(2be634f2 REJECTED) the win32-forced and POSIX-forced maps are IDENTICAL for the capability secret fields — `ridesEnv` has NO effect here, unlike the mcpToken header",
      win32CapServers["cap-a"].env.CRED_A_TOKEN === posixCapServers["cap-a"].env.CRED_A_TOKEN
      && win32CapServers["cap-c"].env.CRED_C_TOKEN === posixCapServers["cap-c"].env.CRED_C_TOKEN);

    // --- Card 8d26596b: the chokepoint fix — EVERY stdio mount buildMcpServers builds gets LOOM_MCP_TOKEN
    // forced to the empty string, unconditionally on BOTH platforms, never per-producer, while keeping its
    // own env keys intact; http mounts are UNTOUCHED (never get an env field at all). Covers: playwright
    // (a Loom-owned stdio mount with no env of its own), a capability WITH a secret (cap-a), a capability
    // WITH an outputDirEnvVar scratch-dir value (cap-c), and a capability with NEITHER (cap-noenv — proves
    // `env` is never omitted for a stdio mount any more, unlike the pre-card shape). ---
    {
      const NOENV_ROW = {
        id: "cap-noenv", slug: "cap-noenv", name: "Cap NoEnv", description: "test", transport: "stdio", kind: "bundled",
        provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: ["noenv.js"] }),
        toolAllowlistJson: JSON.stringify([]), wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
        createdAt: new Date().toISOString(),
      };
      const ALL_CATALOG = [CRED_ROW_A, CRED_ROW_SCRATCH, NOENV_ROW];
      const ALL_GRANTS = [...CAP_GRANTS, { slug: "cap-noenv" }];
      const win32All = buildMcpServers({
        sessionId: "probe-8d26596b", port: 4317, role: "worker", browserTesting: true,
        capabilities: ALL_GRANTS, capabilityCatalog: ALL_CATALOG, resolveConnectionSecret: resolveCapSecret,
        mcpTokenRidesEnv: true,
      });
      const posixAll = buildMcpServers({
        sessionId: "probe-8d26596b", port: 4317, role: "worker", browserTesting: true,
        capabilities: ALL_GRANTS, capabilityCatalog: ALL_CATALOG, resolveConnectionSecret: resolveCapSecret,
        mcpTokenRidesEnv: false,
      });
      for (const [label, servers] of [["forced win32", win32All], ["forced POSIX", posixAll]]) {
        check(`(8d26596b, ${label}) the Loom-owned playwright stdio mount carries LOOM_MCP_TOKEN blanked to ""`,
          servers.playwright?.type === "stdio" && servers.playwright?.env?.[MCP_TOKEN_ENV_VAR] === "");
        check(`(8d26596b, ${label}) a capability WITH a secret (cap-a) keeps its own secret key intact AND carries the blank`,
          servers["cap-a"]?.env?.CRED_A_TOKEN === "secret-A-f3a1" && servers["cap-a"]?.env?.[MCP_TOKEN_ENV_VAR] === "");
        check(`(8d26596b, ${label}) a capability WITH outputDirEnvVar (cap-c) keeps its scratch-dir key intact AND carries the blank`,
          servers["cap-c"]?.env?.CAP_C_OUTPUT_DIR?.includes("probe-8d26596b") && servers["cap-c"]?.env?.[MCP_TOKEN_ENV_VAR] === "");
        check(`(8d26596b, ${label}) a capability with NEITHER a secret nor outputDirEnvVar still gets an env block, carrying ONLY the blank`,
          servers["cap-noenv"]?.env?.[MCP_TOKEN_ENV_VAR] === "" && Object.keys(servers["cap-noenv"]?.env ?? {}).length === 1);
        check(`(8d26596b, ${label}) http mounts are UNTOUCHED — no env field at all, ever`,
          servers["loom-tasks"]?.env === undefined && servers["loom-orchestration"]?.env === undefined);
      }
      // playwrightMcpServer() (the raw producer) never sets env itself — proves the blank is applied ONLY
      // at the buildMcpServers chokepoint, never pushed down into the producer.
      check("(8d26596b) the raw playwrightMcpServer() producer itself carries NO env field at all (the blank is chokepoint-only)",
        playwrightMcpServer("/tmp/whatever").env === undefined);
      // Negative control: the blank is never collected as a "secret" by collectMcpEnvSecrets (its `if (v)`
      // falsy-string guard skips ""), so it can never trigger file-diversion or redaction on its own.
      check("(8d26596b negative control) collectMcpEnvSecrets never collects the empty-string LOOM_MCP_TOKEN blank",
        collectMcpEnvSecrets({ x: { type: "stdio", command: "y", args: [], env: { [MCP_TOKEN_ENV_VAR]: "" } } }).length === 0);

      // --- Card 8d26596b, Code Review: blanksMcpToken is keyed on NOT-http, never on the "stdio" literal —
      // claude treats a TYPE-LESS {command,args} mcp-config entry as stdio too, so a future producer that
      // omits `type` entirely must still get the blank. No current producer emits a type-less entry, so
      // this asserts the predicate directly (the same reason applyMcpTokenEnv is itself directly testable,
      // above) rather than trying to coax one out of buildMcpServers end-to-end. ---
      check("(8d26596b) blanksMcpToken({command,args}, no type at all) -> true (a type-less entry still gets blanked)",
        blanksMcpToken({ command: "x", args: [] }) === true);
      check("(8d26596b) blanksMcpToken({type:'stdio',...}) -> true", blanksMcpToken({ type: "stdio" }) === true);
      check("(8d26596b) blanksMcpToken({type:'http',...}) -> false (http mounts are never touched)",
        blanksMcpToken({ type: "http" }) === false);
    }
  }

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
  // Card 280b1e44: a plain `host.spawn()` with no capability grant is NO LONGER a genuinely secret-free
  // spawn — buildMcpServers now adds an Authorization header carrying the per-session mcpToken to every
  // real spawn, so `capabilitySecrets` (collectMcpEnvSecrets, which sweeps `headers` too) is non-empty for
  // EVERY real production spawn today. DoD-1 below needs a TRUE no-token spawn to exercise createPty's
  // stale-file-cleanup branch (now only reachable this way — see buildSpawnArgs' mcpConfigPath doc) — this
  // subclass drops the mcpToken arg before delegating, exactly the "test-only createPty override" that doc
  // describes.
  class NoMcpTokenPtyHost extends PtyHost {
    createPty(opts, hookToken) { return super.createPty(opts, hookToken); }
  }
  const noTokenHost = new NoMcpTokenPtyHost(events, {
    getCapabilityCatalog: () => [CRED_DEF],
    resolveConnectionSecret: (id) => (id === "conn1" ? "super-secret-value" : undefined),
  });

  // Card a50b8afd, Code Review round 3: the injectable `resolveMcpTokenRidesEnv` seam — a test forces
  // EITHER platform branch through a REAL spawn, on THIS host, regardless of its real OS. This is what
  // actually closes the gap the review found: a test of `applyMcpTokenEnv` in isolation (PART 1, below)
  // cannot catch a regression at the CALL SITE itself (e.g. someone reverting it back to an unconditional
  // assignment) — only a real spawn through the real call site, with the decision forced both ways, can.
  class ForcedPosixPtyHost extends PtyHost {
    resolveMcpTokenRidesEnv() { return false; }
  }
  class ForcedWin32PtyHost extends PtyHost {
    resolveMcpTokenRidesEnv() { return true; }
  }

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
  // Card 280b1e44: DoD-1 needs a TRUE no-mcpToken spawn (see noTokenHost's own doc above) — tracked in its
  // own list so the finally block below stops it on the RIGHT host instance.
  const noTokenSpawned = [];
  const spawnNoToken = (sessionId, role = "worker") => {
    noTokenHost.spawn({
      sessionId, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role,
    });
    noTokenSpawned.push(sessionId);
  };

  try {
    // --- DoD-1: a SECRET-FREE spawn unlinks a STALE file left behind for that same sessionId ---
    {
      const sid = "mcgc-dod1-stale";
      const staleFile = sessionMcpConfigPath(sid);
      writeSessionMcpConfig(sid, { fake: { type: "stdio", command: "x", args: [], env: { FAKE_TOKEN: "old-leaked-secret" } } });
      check("(DoD-1 setup) a stale mcp-config file exists BEFORE the secret-free spawn", fs.existsSync(staleFile));
      spawnNoToken(sid);
      check("(DoD-1) a spawn WITHOUT secrets unlinks the STALE file for that sessionId — SYNCHRONOUSLY, inside createPty", !fs.existsSync(staleFile));
    }

    // --- DoD-2 (markReady): the CURRENT spawn's own secret file is gone right after SessionStart ---
    {
      const sid = "mcgc-dod2-ready";
      spawnWithSecret(sid);
      const file = sessionMcpConfigPath(sid);
      const settingsFile = sessionSettingsPath(sid);
      check("(DoD-2 setup) a secret-bearing spawn DOES write its own mcp-config file", fs.existsSync(file));
      check("(DoD-2 setup) the written file actually contains the secret", fs.readFileSync(file, "utf8").includes("super-secret-value"));
      check("(DoD-2 setup, card a50b8afd) a real spawn DOES write its own settings file too", fs.existsSync(settingsFile));
      host.deliverHook(sid, { hook_event_name: "SessionStart" });
      check("(DoD-2) markReady (SessionStart) unlinks the CURRENT spawn's own secret file, synchronously", !fs.existsSync(file));
      check("(DoD-2, card a50b8afd) markReady (SessionStart) ALSO unlinks the settings file, synchronously", !fs.existsSync(settingsFile));
    }

    // --- Card a50b8afd, Code Review round 2: markReady reached WITHOUT SessionStart ever firing (the
    // spawn-armed readiness-fallback timer's real shape — this test calls markReady directly rather than
    // waiting out READY_FALLBACK_MS, which is the same call that timer itself makes) must NOT unlink the
    // settings file — the CLI may not have parsed it yet on a slow cold start. The mcp-config unlink stays
    // unconditional (pre-existing ed0757d6 behavior, out of this card's scope — see the record's own
    // "open question" note), so only the settings-file assertion discriminates the fix. ---
    {
      const sid = "mcgc-a50b8afd-no-sessionstart";
      spawnWithSecret(sid);
      const settingsFile = sessionSettingsPath(sid);
      check("(no-SessionStart setup) a real spawn DOES write its own settings file", fs.existsSync(settingsFile));
      check("(no-SessionStart setup) sessionStartObserved starts false (deliverHook SessionStart was never called)", host.live.get(sid)?.sessionStartObserved === false);
      // Mirrors exactly what the real READY_FALLBACK_MS timer calls (host.ts) when SessionStart never
      // arrives — markReady() directly, with no deliverHook("SessionStart") ever having run.
      host.markReady(sid);
      check("(no-SessionStart) markReady still marks the session ready (the fallback's whole point)", host.live.get(sid)?.ready === true);
      check("(no-SessionStart, card a50b8afd FIX) markReady WITHOUT SessionStart does NOT unlink the settings file — the CLI may not have parsed it yet", fs.existsSync(settingsFile));

      // --- Card a50b8afd, Code Review round 3: the late-SessionStart linger. markReady already ran above
      // (live.ready is now true) WITHOUT ever unlinking the settings file — its own `live.ready` early-
      // return guard means a later markReady call would be a permanent no-op. A real slow boot's
      // SessionStart hook STILL arrives after this; it must unlink the file ITSELF, or the file lingers
      // for the rest of the session. This is the exact scenario the review named: "markReady with no
      // SessionStart, then deliverHook SessionStart, then the file is gone." ---
      host.deliverHook(sid, { hook_event_name: "SessionStart" });
      check("(late-SessionStart, card a50b8afd Code Review round 3 FIX) a SessionStart arriving AFTER markReady already ran (via the fallback) still unlinks the settings file",
        !fs.existsSync(settingsFile));
    }

    // --- Card a50b8afd, Code Review round 2: the try-block-move fix — a throw from writeSessionMcpConfig
    // ITSELF (not just the later Windows-argv-preflight throw "CR fix 1" below already covers) must still
    // clean up the ALREADY-WRITTEN settings file. Forced deterministically + cross-platform: pre-create a
    // DIRECTORY at the exact path writeSessionMcpConfig's own `fs.writeFileSync(tmp, ...)` targets, so that
    // call throws EISDIR instead of writing a file — no renameSync-EPERM/Windows-specific trick needed. ---
    {
      const sid = "mcgc-a50b8afd-trycleanup";
      const mcpConfigTmpPath = `${sessionMcpConfigPath(sid)}.tmp`;
      const settingsFile = sessionSettingsPath(sid);
      fs.mkdirSync(mcpConfigTmpPath, { recursive: true });
      let threw = false;
      try {
        host.spawn({
          sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
          geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker",
          capabilities: [{ slug: "needs-cred", connectionId: "conn1" }],
        });
      } catch {
        threw = true;
      }
      check("(try-cleanup setup) writeSessionMcpConfig's own write genuinely THREW (EISDIR against the pre-created directory, not a no-op)", threw);
      check("(try-cleanup, card a50b8afd FIX) the ALREADY-WRITTEN settings file is cleaned up even though the throw came from writeSessionMcpConfig itself, BEFORE the old try block used to open", !fs.existsSync(settingsFile));
      fs.rmSync(mcpConfigTmpPath, { recursive: true, force: true });
      // Deliberately NOT pushed to `spawned` — spawn() threw, so createPty never returned a pty and no
      // `Live` entry was ever registered; there is nothing for host.stop() to act on.
    }

    // --- Card a50b8afd (b1): a REAL spawn's mcp-config.json carries NO mcpToken bytes, while the REAL
    // spawned process's own env DOES carry the real value (via the fixture's additive env-dump hook) ---
    {
      const sid = "mcgc-b1-env-placeholder";
      const dumpPath = path.join(tmpHome, `${sid}-env-dump.json`);
      host.spawn({
        sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
        geometry: { cols: 120, rows: 40 }, sessionEnv: { FIXTURE_ENV_DUMP_FILE: dumpPath }, role: "worker",
      });
      spawned.push(sid);
      const file = sessionMcpConfigPath(sid);
      check("(b1 setup) a real spawn DOES write its own mcp-config file (mcpToken alone forces file mode)", fs.existsSync(file));
      const fileContent = fs.readFileSync(file, "utf8");
      const liveToken = host.live.get(sid)?.mcpToken;
      check("(b1 setup) the live session actually has a real, non-empty mcpToken to check against", typeof liveToken === "string" && liveToken.length > 0);
      check("(b1) the written mcp-config.json FILE contains the PLACEHOLDER, never the real token bytes",
        fileContent.includes("${LOOM_MCP_TOKEN}") && !fileContent.includes(liveToken));
      await waitUntil(() => fs.existsSync(dumpPath), { label: `${sid} fixture env dump`, timeoutMs: 15000 });
      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      check("(b1) the REAL spawned process's OWN env carries the real mcpToken value (negative control: compared against the actual live value, not a guess)",
        dump.LOOM_MCP_TOKEN === liveToken);
    }

    // --- Card 2be634f2: REJECTED — on THIS host (win32, real resolveMcpTokenRidesEnv()), a capability
    // secret must stay the LITERAL value in the file, and the REAL spawned process's own env must carry
    // NO `LOOM_CAP_SECRET_*` var at all — the finding that killed the placeholder design: claude's env is
    // inherited by the agent's own shell, so putting a third-party secret there would be readable from
    // the agent's own Bash/PowerShell for the whole session. ---
    {
      const sid = "mcgc-2be634f2-cap-secret-stays-off-env";
      const dumpPath = path.join(tmpHome, `${sid}-env-dump.json`);
      host.spawn({
        sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
        geometry: { cols: 120, rows: 40 }, sessionEnv: { FIXTURE_ENV_DUMP_FILE: dumpPath }, role: "worker",
        capabilities: [{ slug: "needs-cred", connectionId: "conn1" }],
      });
      spawned.push(sid);
      const file = sessionMcpConfigPath(sid);
      const fileContent = fs.readFileSync(file, "utf8");
      check("(2be634f2 REJECTED) the written mcp-config.json FILE contains the LITERAL capability-secret bytes, never a placeholder",
        fileContent.includes("super-secret-value") && !fileContent.includes("LOOM_CAP_SECRET_"));
      await waitUntil(() => fs.existsSync(dumpPath), { label: `${sid} fixture env dump`, timeoutMs: 15000 });
      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      check("(2be634f2 REJECTED — THE FINDING THIS PINS) the REAL spawned process's OWN env carries NO LOOM_CAP_SECRET_* var at all — the secret is NEVER inherited by the agent's own shell",
        Object.keys(dump.capabilitySecrets ?? {}).length === 0);
    }

    // --- Card a50b8afd, Code Review round 3: the SAME real-spawn proof as above, but with the platform
    // decision FORCED via the injectable `resolveMcpTokenRidesEnv` seam — on THIS host (win32), the block
    // above already proves the true branch, but only because this host's REAL platform happens to resolve
    // true; it says NOTHING about whether the FALSE branch's call site actually works. This block forces
    // BOTH branches explicitly, closing that gap on any host. ---
    {
      // Card 2be634f2: both forced hosts ALSO carry the capability catalog + resolver (same shape as
      // `host`/`noTokenHost` above) and both spawns ALSO request the "needs-cred" capability — pins the
      // REJECTED design on BOTH forced platforms at the real CALL SITE, not just the pure helper (PART 1):
      // a capability secret must stay literal and off claude's env regardless of `ridesEnv`, unlike the
      // mcpToken header which genuinely differs per platform below.
      const capOpts = {
        getCapabilityCatalog: () => [CRED_DEF],
        resolveConnectionSecret: (id) => (id === "conn1" ? "super-secret-value" : undefined),
      };
      const forcedPosixHost = new ForcedPosixPtyHost(events, capOpts);
      const sid = "mcgc-a50b8afd-forced-posix";
      const dumpPath = path.join(tmpHome, `${sid}-env-dump.json`);
      forcedPosixHost.spawn({
        sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
        geometry: { cols: 120, rows: 40 }, sessionEnv: { FIXTURE_ENV_DUMP_FILE: dumpPath }, role: "worker",
        capabilities: [{ slug: "needs-cred", connectionId: "conn1" }],
      });
      try {
        const file = sessionMcpConfigPath(sid);
        const liveToken = forcedPosixHost.live.get(sid)?.mcpToken;
        check("(forced-POSIX setup) a real spawn still writes its own mcp-config file", fs.existsSync(file));
        check("(forced-POSIX setup) the live session has a real, non-empty mcpToken", typeof liveToken === "string" && liveToken.length > 0);
        const fileContent = fs.readFileSync(file, "utf8");
        check("(forced-POSIX, card a50b8afd Code Review round 3 FIX) with ridesEnv FORCED false, the mcp-config.json FILE carries the LITERAL token, never the placeholder",
          fileContent.includes(liveToken) && !fileContent.includes("${LOOM_MCP_TOKEN}"));
        check("(forced-POSIX, card 2be634f2 REJECTED) with ridesEnv FORCED false, the capability secret stays the LITERAL value, never a placeholder",
          fileContent.includes("super-secret-value") && !fileContent.includes("LOOM_CAP_SECRET_"));
        await waitUntil(() => fs.existsSync(dumpPath), { label: `${sid} fixture env dump`, timeoutMs: 15000 });
        const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
        check("(forced-POSIX, card a50b8afd Code Review round 3 FIX — THE REGRESSION THIS CLOSES) with ridesEnv FORCED false, the REAL spawned process's env does NOT carry LOOM_MCP_TOKEN at all",
          dump.LOOM_MCP_TOKEN === null || dump.LOOM_MCP_TOKEN === undefined);
        check("(forced-POSIX, card 2be634f2 REJECTED) with ridesEnv FORCED false, the REAL spawned process's env carries NO LOOM_CAP_SECRET_* var at all",
          Object.keys(dump.capabilitySecrets ?? {}).length === 0);
      } finally {
        try { forcedPosixHost.stop(sid, "hard"); } catch { /* best-effort */ }
        try { await waitUntil(() => !forcedPosixHost.isAlive(sid), { label: `${sid} pty exit (cleanup)`, timeoutMs: 15000 }); } catch { /* best-effort */ }
      }

      const forcedWin32Host = new ForcedWin32PtyHost(events, capOpts);
      const sid2 = "mcgc-a50b8afd-forced-win32";
      const dumpPath2 = path.join(tmpHome, `${sid2}-env-dump.json`);
      forcedWin32Host.spawn({
        sessionId: sid2, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
        geometry: { cols: 120, rows: 40 }, sessionEnv: { FIXTURE_ENV_DUMP_FILE: dumpPath2 }, role: "worker",
        capabilities: [{ slug: "needs-cred", connectionId: "conn1" }],
      });
      try {
        const file2 = sessionMcpConfigPath(sid2);
        const liveToken2 = forcedWin32Host.live.get(sid2)?.mcpToken;
        const fileContent2 = fs.readFileSync(file2, "utf8");
        check("(forced-win32, via the SAME injectable seam) the mcp-config.json FILE carries the placeholder, never the literal token",
          fileContent2.includes("${LOOM_MCP_TOKEN}") && !fileContent2.includes(liveToken2));
        check("(forced-win32, card 2be634f2 REJECTED) the capability secret, UNLIKE the mcpToken header just above, stays the LITERAL value even with ridesEnv FORCED true",
          fileContent2.includes("super-secret-value") && !fileContent2.includes("LOOM_CAP_SECRET_"));
        await waitUntil(() => fs.existsSync(dumpPath2), { label: `${sid2} fixture env dump`, timeoutMs: 15000 });
        const dump2 = JSON.parse(fs.readFileSync(dumpPath2, "utf8"));
        check("(forced-win32, via the SAME injectable seam) the REAL spawned process's env DOES carry the real mcpToken",
          dump2.LOOM_MCP_TOKEN === liveToken2);
        check("(forced-win32, card 2be634f2 REJECTED — THE FINDING THIS PINS) the REAL spawned process's env carries NO LOOM_CAP_SECRET_* var, even with ridesEnv FORCED true — the secret is never inherited by the agent's own shell",
          Object.keys(dump2.capabilitySecrets ?? {}).length === 0);
      } finally {
        try { forcedWin32Host.stop(sid2, "hard"); } catch { /* best-effort */ }
        try { await waitUntil(() => !forcedWin32Host.isAlive(sid2), { label: `${sid2} pty exit (cleanup)`, timeoutMs: 15000 }); } catch { /* best-effort */ }
      }
    }

    // --- DoD-2 (onExit backstop): a session that never reaches `ready` still gets cleaned up on exit ---
    {
      const sid = "mcgc-dod2-exit";
      spawnWithSecret(sid);
      const file = sessionMcpConfigPath(sid);
      const settingsFile = sessionSettingsPath(sid);
      check("(DoD-2/exit setup) a secret-bearing spawn DOES write its own mcp-config file", fs.existsSync(file));
      check("(DoD-2/exit setup, card a50b8afd) a real spawn DOES write its own settings file too", fs.existsSync(settingsFile));
      // Deliberately NEVER deliver SessionStart — simulates a crash/abandon before `ready`.
      host.stop(sid, "hard");
      // A REAL child process's exit is genuinely async (the OS/node-pty fires it on a later tick) —
      // unlike markReady's synchronous unlink above, this can't be checked immediately after stop()
      // returns. Wait for the OBSERVABLE event (the session going non-alive), never a blind sleep.
      await waitUntil(() => !host.isAlive(sid), { label: `${sid} pty exit`, timeoutMs: 15000 });
      check("(DoD-2/exit) the pty onExit backstop unlinks the file even though `ready` never fired", !fs.existsSync(file));
      check("(DoD-2/exit, card a50b8afd) the pty onExit backstop ALSO unlinks the settings file", !fs.existsSync(settingsFile));
    }

    // --- Code Review fix #1: a THROW after the write (the Windows argv preflight) still cleans up its
    // own file — a spawn that dies here gets NO `Live` entry, so neither markReady nor onExit would ever
    // reach it; RED on the pre-fix tip (bec87fe7 alone, before this follow-up commit). An oversized
    // `--model` value is a directly test-controllable way to force preflightWindowsCommandLine to fail,
    // independent of anything else in argv. ---
    {
      const sid = "mcgc-cr1-preflight-throw";
      const file = sessionMcpConfigPath(sid);
      const settingsFile = sessionSettingsPath(sid);
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
      check("(CR fix 1, card a50b8afd) the SAME throw ALSO unlinks the just-written settings file", !fs.existsSync(settingsFile));
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
    // Card 280b1e44: a REAL child process's exit is genuinely async (see DoD-2/exit's own note above) —
    // and now that every spawned session here carries a real mcp-config file (not just the DoD-2/exit
    // one), PART 3's boot-sweep counts below would flake/inflate if this returned before each onExit
    // handler's own unlink actually ran. Wait for each to go non-alive, not just fire stop().
    for (const sid of spawned) { try { host.stop(sid, "hard"); } catch { /* best-effort — may already be stopped */ } }
    for (const sid of noTokenSpawned) { try { noTokenHost.stop(sid, "hard"); } catch { /* best-effort — may already be stopped */ } }
    for (const sid of spawned) { try { await waitUntil(() => !host.isAlive(sid), { label: `${sid} pty exit (cleanup)`, timeoutMs: 15000 }); } catch { /* best-effort */ } }
    for (const sid of noTokenSpawned) { try { await waitUntil(() => !noTokenHost.isAlive(sid), { label: `${sid} pty exit (cleanup)`, timeoutMs: 15000 }); } catch { /* best-effort */ } }
  }
}

// =====================================================================================================
// PART 3 — the boot-time sweep (sweepOrphanedSettingsDirSecrets), against a REAL Db. Card a50b8afd widened
// this sweep to cover BOTH file kinds under one pass — every scenario below is seeded for BOTH kinds,
// under the SAME sessionId, to prove the per-kind classification never interferes with the shared
// liveness rule (see classifySettingsDirFile's own doc in mcp-config-gc.ts for the suffix-ordering this
// depends on: ".mcp-config.json" is itself a suffix-superset of plain ".json").
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
    // Card a50b8afd: the settings-file siblings — SAME sessionIds as the mcp-config seeds above, so a
    // single live/exited/no-row/starting session plausibly has BOTH files at once, exactly like a real
    // spawn does.
    function seedSettingsFile(sid) { fs.writeFileSync(sessionSettingsPath(sid), JSON.stringify({ hooks: {} })); }
    function seedSettingsTmpFile(sid) { fs.writeFileSync(`${sessionSettingsPath(sid)}.tmp`, JSON.stringify({ hooks: {} })); }

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
    seedSettingsFile("sweep-live");
    seedSettingsFile("sweep-starting");
    seedSettingsFile("sweep-exited");
    seedSettingsFile("sweep-no-row");
    seedSettingsTmpFile("sweep-tmp-live");
    seedSettingsTmpFile("sweep-tmp-exited");

    const result = sweepOrphanedSettingsDirSecrets(db);

    // The exact count here does double duty: it's the DoD-3 assertion AND a cross-part leak check — if any
    // earlier PART left an unexpected SETTINGS_DIR file behind (PART 2's own spawns all clean up after
    // themselves, but a regression there would silently inflate this number), the count would drift off 12
    // and this line would catch it, not just the more specific per-file checks below.
    check("(DoD-3) scanned count = exactly the 12 seeded files (6 mcp-config + 6 settings; also a cross-part leak check)", result.scanned === 12);
    check("(DoD-3) a LIVE session's mcp-config file is NEVER reaped", fs.existsSync(sessionMcpConfigPath("sweep-live")));
    check("(DoD-3) a STARTING session's mcp-config file is NEVER reaped", fs.existsSync(sessionMcpConfigPath("sweep-starting")));
    check("(DoD-3) an EXITED session's orphaned mcp-config file IS reaped", !fs.existsSync(sessionMcpConfigPath("sweep-exited")));
    check("(DoD-3) a NO-DB-ROW mcp-config file IS reaped (nothing left that could still need it)", !fs.existsSync(sessionMcpConfigPath("sweep-no-row")));
    check("(DoD-3) a LIVE session's STRANDED .tmp mcp-config file is NEVER reaped (same rule as the plain case)", fs.existsSync(`${sessionMcpConfigPath("sweep-tmp-live")}.tmp`));
    check("(DoD-3) an EXITED session's STRANDED .tmp mcp-config file IS reaped (same rule as the plain case)", !fs.existsSync(`${sessionMcpConfigPath("sweep-tmp-exited")}.tmp`));
    // Card a50b8afd: the settings-file siblings, under the IDENTICAL per-sessionId liveness rule —
    // "sweep-live" proving its own mcp-config.json AND settings.json BOTH survive together is also the
    // negative control for suffix-matching order: if the classifier ever mistook ".mcp-config.json" for
    // the shorter ".json" suffix, it would mis-extract "sweep-live.mcp-config" as the sessionId, find no
    // such DB row, and WRONGLY reap it despite the real session being live — this assertion would go RED.
    check("(DoD-3, card a50b8afd) a LIVE session's settings file is NEVER reaped", fs.existsSync(sessionSettingsPath("sweep-live")));
    check("(DoD-3, card a50b8afd) a STARTING session's settings file is NEVER reaped", fs.existsSync(sessionSettingsPath("sweep-starting")));
    check("(DoD-3, card a50b8afd) an EXITED session's orphaned settings file IS reaped", !fs.existsSync(sessionSettingsPath("sweep-exited")));
    check("(DoD-3, card a50b8afd) a NO-DB-ROW settings file IS reaped", !fs.existsSync(sessionSettingsPath("sweep-no-row")));
    check("(DoD-3, card a50b8afd) a LIVE session's STRANDED .tmp settings file is NEVER reaped", fs.existsSync(`${sessionSettingsPath("sweep-tmp-live")}.tmp`));
    check("(DoD-3, card a50b8afd) an EXITED session's STRANDED .tmp settings file IS reaped", !fs.existsSync(`${sessionSettingsPath("sweep-tmp-exited")}.tmp`));
    check("(DoD-3) the reaped list names exactly the 6 expected files, no more",
      result.reaped.sort().join(",") === [
        "sweep-exited.mcp-config.json", "sweep-no-row.mcp-config.json", "sweep-tmp-exited.mcp-config.json.tmp",
        "sweep-exited.json", "sweep-no-row.json", "sweep-tmp-exited.json.tmp",
      ].sort().join(","));

    // Re-running immediately after: the reaped files are gone, so a fresh sweep of the SAME (still-real,
    // now-cleaner) SETTINGS_DIR finds nothing left of them to reap again, and never throws.
    let threwOnRerun = false;
    let rerunResult;
    try { rerunResult = sweepOrphanedSettingsDirSecrets(db); } catch { threwOnRerun = true; }
    check("(DoD-3) a second sweep never throws", !threwOnRerun);
    check("(DoD-3) a second sweep no longer finds the already-reaped files",
      [...rerunResult?.reaped ?? []].every((name) => !["sweep-exited.mcp-config.json", "sweep-no-row.mcp-config.json", "sweep-tmp-exited.mcp-config.json.tmp", "sweep-exited.json", "sweep-no-row.json", "sweep-tmp-exited.json.tmp"].includes(name)));
  } finally {
    // Card ed0757d6 Code Review fix #3: an un-closed Db leaked the temp LOOM_HOME's loom.db handle,
    // leaving mkdtempManaged's own cleanup unable to remove it (EBUSY) and stranding the whole temp dir.
    db.close();
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the mcp-config secret file gets a full lifecycle: a secret-free spawn clears a stale file (DoD-1), the current spawn's own file is cleared at the earliest safe point (SessionStart/markReady) with an unconditional onExit backstop (DoD-2), SETTINGS_DIR is denied to every role unconditionally (DoD-4), a boot-time sweep catches anything a hard crash left behind (DoD-3), the settings/hook-token file gets the SAME lifecycle (card a50b8afd), and the mcpToken header is a placeholder, never a literal value, backed by the real spawned process's own env (card a50b8afd, b1)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
