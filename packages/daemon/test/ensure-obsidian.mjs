import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Obsidian auto-start (self-healing vault preflight) — DETERMINISTIC, CLAUDE-FREE, NETWORK-FREE, and it
// NEVER launches the real GUI app (every seam is mocked). Covers the four DoD facets end-to-end:
//   1. CONFIG PLUMBING (shared): resolveConfig resolves `obsidian` + injects LOOM_OBSIDIAN_* into
//      sessionEnv ONLY when autoStart is on (additive-when-off → byte-identical default sessionEnv).
//   2. VALIDATOR GATING (daemon mcp): `obsidian.autoStart` is agent-settable; `obsidian.path` (a host
//      EXECUTABLE the preflight launches) is HUMAN-only — REJECTED on the agent path, like gateCommand.
//   3. PROBE + GATING + FALLBACK (helper): disabled→no launch; up→no launch; headless/not-installed/
//      launch-throw/timeout→graceful, NEVER throws.
//   4. LAUNCH-COMMAND CONSTRUCTION (helper): the OS-correct command for win/mac/linux + path override.
//
// Run: 1) build (turbo builds shared first), 2) node test/ensure-obsidian.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveConfig, obsidianSessionEnv } = await import("@loom/shared");
const { validateProjectConfigOverride, validateAgentProjectConfigOverride } = await import("../dist/mcp/platform.js");
const {
  ensureObsidian, buildLaunchCommand, defaultObsidianPath, readConfigFromEnv, isHeadless,
} = await import("../assets/scripts/ensure-obsidian.mjs");

// =================== 1. CONFIG PLUMBING (resolveConfig + obsidianSessionEnv) ========================
{
  // Default (override-less): OFF, and NO LOOM_OBSIDIAN_* leaks into sessionEnv (additive-when-off).
  const def = resolveConfig(undefined);
  check("default obsidian.autoStart is false", def.obsidian.autoStart === false);
  check("default obsidian has no path", def.obsidian.path === undefined);
  check("default sessionEnv carries NO LOOM_OBSIDIAN_AUTOSTART (byte-identical when off)", !("LOOM_OBSIDIAN_AUTOSTART" in def.sessionEnv));
  check("default sessionEnv carries NO LOOM_OBSIDIAN_PATH", !("LOOM_OBSIDIAN_PATH" in def.sessionEnv));
  // An empty override ({}) is the same off path.
  check("empty-override sessionEnv stays clean", !("LOOM_OBSIDIAN_AUTOSTART" in resolveConfig({}).sessionEnv));

  // autoStart ON → LOOM_OBSIDIAN_AUTOSTART=1 injected, no path var unless a path is set.
  const on = resolveConfig({ obsidian: { autoStart: true } });
  check("autoStart on → obsidian.autoStart true", on.obsidian.autoStart === true);
  check("autoStart on → sessionEnv.LOOM_OBSIDIAN_AUTOSTART === '1'", on.sessionEnv.LOOM_OBSIDIAN_AUTOSTART === "1");
  check("autoStart on (no path) → no LOOM_OBSIDIAN_PATH", !("LOOM_OBSIDIAN_PATH" in on.sessionEnv));

  // autoStart ON + path → both env vars injected, and the resolved field carries the path.
  const withPath = resolveConfig({ obsidian: { autoStart: true, path: "/opt/Obsidian.AppImage" } });
  check("autoStart on + path → resolved obsidian.path set", withPath.obsidian.path === "/opt/Obsidian.AppImage");
  check("autoStart on + path → sessionEnv.LOOM_OBSIDIAN_PATH set", withPath.sessionEnv.LOOM_OBSIDIAN_PATH === "/opt/Obsidian.AppImage");

  // path WITHOUT autoStart → no env injection (the helper would no-op anyway); path still resolves.
  const pathOnly = resolveConfig({ obsidian: { path: "/opt/Obsidian.AppImage" } });
  check("path only (autoStart off) → no env injection", !("LOOM_OBSIDIAN_AUTOSTART" in pathOnly.sessionEnv) && !("LOOM_OBSIDIAN_PATH" in pathOnly.sessionEnv));

  // The pure transport helper: {} when off, the vars when on.
  check("obsidianSessionEnv({autoStart:false}) === {}", Object.keys(obsidianSessionEnv({ autoStart: false })).length === 0);
  check("obsidianSessionEnv({autoStart:true}) carries only the flag", obsidianSessionEnv({ autoStart: true }).LOOM_OBSIDIAN_AUTOSTART === "1" && !("LOOM_OBSIDIAN_PATH" in obsidianSessionEnv({ autoStart: true })));

  // The existing default sessionEnv (the two alt-screen vars) is preserved untouched.
  check("default alt-screen sessionEnv vars preserved", def.sessionEnv.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN === "1" && def.sessionEnv.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT === "1");
}

// =================== 2. VALIDATOR GATING (path is human-only, like gateCommand) =====================
{
  const obs = (o) => ({ obsidian: o });
  // FULL / human (REST) path accepts both fields.
  check("human path: obsidian.autoStart accepted", validateProjectConfigOverride(obs({ autoStart: true })).ok === true);
  check("human path: obsidian.path accepted", validateProjectConfigOverride(obs({ autoStart: true, path: "C:\\Program Files\\Obsidian\\Obsidian.exe" })).ok === true);

  // AGENT (loom-platform / setup MCP) path: autoStart OK, path REJECTED as an unknown key.
  check("agent path: obsidian.autoStart accepted (benign convenience)", validateAgentProjectConfigOverride(obs({ autoStart: true })).ok === true);
  const rejected = validateAgentProjectConfigOverride(obs({ path: "/evil/binary" }));
  check("agent path: obsidian.path REJECTED (host-launch escape hatch is human-only)", rejected.ok === false);
  check("agent path: rejection reason names obsidian.path", rejected.ok === false && /obsidian\.?.*path/.test(rejected.error));
  // autoStart + path together still rejected on the agent path (the path key trips .strict()).
  check("agent path: {autoStart,path} together still REJECTED", validateAgentProjectConfigOverride(obs({ autoStart: true, path: "/x" })).ok === false);
  // Type guard: a non-boolean autoStart is rejected on BOTH paths.
  check("human path: non-boolean autoStart rejected", validateProjectConfigOverride(obs({ autoStart: "yes" })).ok === false);
  // An unknown obsidian sub-key is rejected (typo guard via .strict()).
  check("agent path: unknown obsidian sub-key rejected", validateAgentProjectConfigOverride(obs({ autoStart: true, frob: 1 })).ok === false);
}

// =================== 3 + 4. HELPER: probe / gating / fallback / launch construction ================

// OS-aware default targets.
check("defaultObsidianPath(win32) → Program Files\\Obsidian\\Obsidian.exe", defaultObsidianPath("win32", { ProgramFiles: "C:\\Program Files" }) === "C:\\Program Files\\Obsidian\\Obsidian.exe");
check("defaultObsidianPath(darwin) → /Applications/Obsidian.app", defaultObsidianPath("darwin", {}) === "/Applications/Obsidian.app");
check("defaultObsidianPath(linux) → bare 'obsidian' on PATH", defaultObsidianPath("linux", {}) === "obsidian");

// Launch-command construction per OS (+ path override).
{
  const win = buildLaunchCommand({ platform: "win32", env: { ProgramFiles: "C:\\Program Files" } });
  check("win launch: exec Obsidian.exe directly, detached", win.command === "C:\\Program Files\\Obsidian\\Obsidian.exe" && win.args.length === 0 && win.detached === true);
  const mac = buildLaunchCommand({ platform: "darwin", env: {} });
  check("mac launch: `open /Applications/Obsidian.app`", mac.command === "open" && mac.args[0] === "/Applications/Obsidian.app");
  const lin = buildLaunchCommand({ platform: "linux", env: {} });
  check("linux launch: exec `obsidian` on PATH", lin.command === "obsidian");
  // A configured path override wins on every OS.
  const override = buildLaunchCommand({ platform: "win32", path: "D:\\Apps\\Obsidian.exe", env: {} });
  check("path override wins (win)", override.command === "D:\\Apps\\Obsidian.exe");
  const macOverride = buildLaunchCommand({ platform: "darwin", path: "/Apps/Obsidian.app", env: {} });
  check("path override wins (mac, via open)", macOverride.command === "open" && macOverride.args[0] === "/Apps/Obsidian.app");
}

// readConfigFromEnv parses the injected vars.
check("readConfigFromEnv reads autoStart + path", (() => { const c = readConfigFromEnv({ LOOM_OBSIDIAN_AUTOSTART: "1", LOOM_OBSIDIAN_PATH: "/x" }); return c.autoStart === true && c.path === "/x"; })());
check("readConfigFromEnv: absent → off, no path", (() => { const c = readConfigFromEnv({}); return c.autoStart === false && c.path === undefined; })());
check("readConfigFromEnv: blank path → undefined", readConfigFromEnv({ LOOM_OBSIDIAN_AUTOSTART: "1", LOOM_OBSIDIAN_PATH: "   " }).path === undefined);

// isHeadless detection.
check("isHeadless: CI → true", isHeadless({ CI: "true" }, "linux") === true);
check("isHeadless: linux + no display → true", isHeadless({}, "linux") === true);
check("isHeadless: linux + DISPLAY set → false", isHeadless({ DISPLAY: ":0" }, "linux") === false);
check("isHeadless: macOS (interactive desktop) → false", isHeadless({}, "darwin") === false);
check("isHeadless: win32 → false", isHeadless({}, "win32") === false);
check("isHeadless: force flag overrides → true", isHeadless({ LOOM_OBSIDIAN_FORCE_HEADLESS: "1" }, "darwin") === true);

// A probe seam that yields queued booleans (then sticks on the last). A fake clock so the bounded poll
// terminates instantly (sleep advances `t`; now() reads it).
const makeProbe = (...queue) => { const q = [...queue]; return () => (q.length > 1 ? q.shift() : q[0]); };
const fakeClock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

// (a) DISABLED → never launch (the headline gating case).
{
  let launched = 0;
  const r = await ensureObsidian({ env: {}, platform: "linux", probe: makeProbe(false), launch: () => { launched++; } });
  check("disabled → status 'disabled'", r.status === "disabled");
  check("disabled → launch NOT called", launched === 0 && r.launched === false);
}

// (b) ENABLED + already UP → never launch.
{
  let launched = 0;
  const r = await ensureObsidian({ env: { LOOM_OBSIDIAN_AUTOSTART: "1" }, platform: "darwin", probe: makeProbe(true), launch: () => { launched++; } });
  check("enabled+up → status 'ready'", r.status === "ready");
  check("enabled+up → launch NOT called", launched === 0 && r.launched === false);
}

// (c) ENABLED + DOWN + HEADLESS → graceful, no launch.
{
  let launched = 0;
  const r = await ensureObsidian({ env: { LOOM_OBSIDIAN_AUTOSTART: "1", CI: "true" }, platform: "linux", probe: makeProbe(false), launch: () => { launched++; } });
  check("enabled+down+headless → status 'headless'", r.status === "headless");
  check("enabled+down+headless → launch NOT called", launched === 0);
}

// (d) ENABLED + DOWN + target MISSING (absolute path, existsSync false) → not-installed, no launch.
{
  let launched = 0;
  const clk = fakeClock();
  const r = await ensureObsidian({
    env: { LOOM_OBSIDIAN_AUTOSTART: "1" }, platform: "win32",
    probe: makeProbe(false), launch: () => { launched++; },
    existsSync: () => false, now: clk.now, sleep: clk.sleep,
  });
  check("enabled+down+missing-target → status 'not-installed'", r.status === "not-installed");
  check("enabled+down+missing-target → launch NOT called", launched === 0);
}

// (e) ENABLED + DOWN + launch succeeds + probe recovers → launched, ready, with the correct command.
{
  let launchedCmd = null;
  const r = await ensureObsidian({
    env: { LOOM_OBSIDIAN_AUTOSTART: "1" }, platform: "darwin",
    probe: makeProbe(false, true), // down at first, ready after launch
    launch: (cmd) => { launchedCmd = cmd; },
    existsSync: () => true, ...fakeClock(),
  });
  check("enabled+down+recovers → status 'ready'", r.status === "ready");
  check("enabled+down+recovers → launched true", r.launched === true);
  check("enabled+down+recovers → launched the OS-correct command", launchedCmd && launchedCmd.command === "open" && launchedCmd.args[0] === "/Applications/Obsidian.app");
  check("enabled+down+recovers → result echoes the command", r.command && r.command.command === "open");
}

// (f) ENABLED + DOWN + launch THROWS → never throws, falls back to not-installed.
{
  let threw = false;
  let r;
  try {
    r = await ensureObsidian({
      env: { LOOM_OBSIDIAN_AUTOSTART: "1" }, platform: "darwin", // non-headless so we reach the launch
      probe: makeProbe(false), launch: () => { throw new Error("ENOENT"); },
      existsSync: () => true, ...fakeClock(),
    });
  } catch { threw = true; }
  check("launch-throw → ensureObsidian does NOT throw", threw === false);
  check("launch-throw → status 'not-installed'", r && r.status === "not-installed");
}

// (g) ENABLED + DOWN + probe NEVER recovers → bounded → timeout (launched), no hang.
{
  const r = await ensureObsidian({
    env: { LOOM_OBSIDIAN_AUTOSTART: "1" }, platform: "win32",
    probe: makeProbe(false), launch: () => {},
    existsSync: () => true, ...fakeClock(), timeoutMs: 5000, pollMs: 500,
  });
  check("enabled+down+never-ready → status 'timeout' (bounded, no hang)", r.status === "timeout");
  check("enabled+down+never-ready → launched true", r.launched === true);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — obsidian auto-start: resolveConfig injects LOOM_OBSIDIAN_* only when on (byte-identical off), obsidian.path is human-only (rejected on the agent path), and the preflight gates/probes/falls-back gracefully + constructs the OS-correct launch command (never throws, never launches a real app)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
