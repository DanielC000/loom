import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card fbb6e8ec — buildSpawnEnv (pty/host.ts) scrubs a sessionEnv-SOURCED CLAUDE_CONFIG_DIR, leaving the
// daemon's own process.env.CLAUDE_CONFIG_DIR (a92a0913's supported relocation path) untouched. HERMETIC:
// isolates LOOM_HOME + HOME/USERPROFILE before any dist import — claudeConfigHome()/
// transcriptRootReadDenyRules() read process.env.CLAUDE_CONFIG_DIR fresh per call, and paths.js reads
// LOOM_HOME at import time (useOwnLoomHome's own import-ordering assert catches a late set).
//
// Proves:
//   (1) a sessionEnv CLAUDE_CONFIG_DIR is DROPPED from buildSpawnEnv's output when the daemon has none.
//   (2) when the daemon's OWN process.env.CLAUDE_CONFIG_DIR IS set, that value reaches the spawn env
//       UNCHANGED, and a conflicting sessionEnv-sourced value does NOT win (the fail-open bug this card
//       closes — a92a0913's own "Correction" paragraph named this exact gap).
//   (3) a dropped sessionEnv value is logged (naming the key) but the VALUE itself is never echoed in
//       the diagnostic.
//   (4) win32: a case-variant spelling of the key ("claude_config_dir", "Claude_Config_Dir") is ALSO
//       scrubbed (env var names are case-insensitive there); POSIX: a differently-cased key is left
//       completely untouched — same split as the write-time validator (mcp/platform.ts). Pinned for BOTH
//       platforms EXPLICITLY (a direct isClaudeConfigDirEnvKey(k, platform) unit test, plus the real
//       buildSpawnEnv integration under a temporary process.platform override, restored after), never
//       gated behind an `if (process.platform === ...)` branch that only exercises the ambient host.
//   (5) once scrubbed, the resulting spawn env's CLAUDE_CONFIG_DIR AGREES with what claudeConfigHome()/
//       transcriptRootReadDenyRules() resolve for the same daemon-ambient value — i.e. the real engine's
//       spawn env and Loom's own transcript reader/deny-rule root can no longer disagree via sessionEnv.
//   (6) a sessionEnv with no CLAUDE_CONFIG_DIR key at all is completely unaffected (no false positive) —
//       and every OTHER sessionEnv key still passes through untouched (narrow scrub, not a wholesale drop).
//   (7) card fbb6e8ec review round 2: a sessionEnv carrying TWO win32-case-variant spellings of the SAME
//       key in one object (e.g. "CLAUDE_CONFIG_DIR" and "claude_config_dir") has BOTH dropped, each
//       logged by its own name, never just the first (the exact gap the reviewer proved end to end on
//       round 1's `Object.keys(...).find(...)`-based scrub) — proven with the daemon's own value UNSET
//       (the child-visible result must be fully absent) AND SET (the child-visible result must be the
//       daemon's value, never either sessionEnv-sourced variant).
//
// Every CLAUDE_CONFIG_DIR-set assertion also confirms the REAL result differs from what the pre-fix
// (unscrubbed) behavior would have produced — never a check whose only failure mode is "the export
// doesn't exist" (lesson 298).
//
// Run: 1) build (turbo builds shared first), 2) node test/claude-config-dir-sessionenv-spawn-scrub.mjs
import path from "node:path";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("loom-ccdses-"); // sets LOOM_HOME before any dist import — paths.js reads it at module load

const { buildSpawnEnv } = await import("../dist/pty/host.js");
const { claudeConfigHome, isClaudeConfigDirEnvKey } = await import("../dist/pty/claude-config.js");
const { transcriptRootReadDenyRules } = await import("../dist/pty/claude-transcript.js");
const { toClaudeAbsoluteGlob } = await import("../dist/pty/loom-home-deny.js");

const sandboxHome = mkdtempManaged("loom-ccdses-home-");
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE

const spawnCwd = path.resolve("/fake/ccdses-cwd");
const processEnvBase = { PATH: "/usr/bin", HOME: sandboxHome };

/** Capture console.warn output during `fn` (synchronous), restoring the real console.warn afterward. */
function captureWarnings(fn) {
  const real = console.warn;
  const lines = [];
  console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
  let result;
  try { result = fn(); } finally { console.warn = real; }
  return { result, lines };
}

// =====================================================================================================
// (1) daemon has NO CLAUDE_CONFIG_DIR set — a sessionEnv-sourced one is dropped entirely, never leaks.
// =====================================================================================================
{
  delete process.env.CLAUDE_CONFIG_DIR;
  const maliciousDir = mkdtempManaged("loom-ccdses-bad1-");
  const { result: env, lines } = captureWarnings(() =>
    buildSpawnEnv(processEnvBase, { CLAUDE_CONFIG_DIR: maliciousDir, OTHER_VAR: "kept" }, spawnCwd),
  );
  check("(1) a sessionEnv CLAUDE_CONFIG_DIR is dropped when the daemon has none set", !("CLAUDE_CONFIG_DIR" in env));
  check("(1) a sibling sessionEnv key is unaffected (narrow scrub, not a wholesale drop)", env.OTHER_VAR === "kept");
  check("(1) a diagnostic names the dropped KEY", lines.some((l) => l.includes("CLAUDE_CONFIG_DIR")));
  check("(1) the diagnostic never echoes the dropped VALUE", !lines.some((l) => l.includes(maliciousDir)));
}

// =====================================================================================================
// (2)+(5) daemon HAS CLAUDE_CONFIG_DIR set — that value reaches the engine unchanged, a conflicting
// sessionEnv override does NOT win, and the result AGREES with Loom's own reader/deny-rule root.
// =====================================================================================================
{
  const daemonDir = mkdtempManaged("loom-ccdses-daemon-");
  process.env.CLAUDE_CONFIG_DIR = daemonDir;
  const processEnvWithDaemon = { ...processEnvBase, CLAUDE_CONFIG_DIR: daemonDir };
  const maliciousDir = mkdtempManaged("loom-ccdses-bad2-");

  const env = buildSpawnEnv(processEnvWithDaemon, { CLAUDE_CONFIG_DIR: maliciousDir }, spawnCwd);
  check("(2) the DAEMON's own CLAUDE_CONFIG_DIR reaches the spawn env unchanged", env.CLAUDE_CONFIG_DIR === daemonDir);
  check("(2) a conflicting sessionEnv-sourced override does NOT win (the fail-open gap this card closes)", env.CLAUDE_CONFIG_DIR !== maliciousDir);

  // (5) the SAME daemon-ambient value is what claudeConfigHome() / the transcript-root deny rules
  // resolve to — proving the spawn env and Loom's own reader/deny-rule root can no longer disagree.
  check("(5) claudeConfigHome() resolves to the SAME value now reaching the spawn env",
    path.resolve(claudeConfigHome()) === path.resolve(env.CLAUDE_CONFIG_DIR));
  const projectsRoot = path.join(daemonDir, "projects");
  const expectedAbsolute = `Read(${toClaudeAbsoluteGlob(projectsRoot)}/**)`;
  const rules = transcriptRootReadDenyRules();
  check("(5) the transcript-root deny rules are built from that SAME agreeing daemon root",
    rules.includes(expectedAbsolute));
  check("(5) the deny rules do NOT reflect the malicious sessionEnv-sourced path at all",
    !rules.some((r) => r.includes(maliciousDir.replace(/\\/g, "/"))));

  delete process.env.CLAUDE_CONFIG_DIR;
}

// =====================================================================================================
// (4a) case-insensitivity split, direct predicate test — explicit `platform` param, BOTH branches
// pinned unconditionally regardless of which host this actually runs on.
// =====================================================================================================
{
  check("(4a) win32: lowercase case-variant matches", isClaudeConfigDirEnvKey("claude_config_dir", "win32") === true);
  check("(4a) win32: mixed-case case-variant matches", isClaudeConfigDirEnvKey("Claude_Config_Dir", "win32") === true);
  check("(4a) POSIX: a lowercase case-variant does NOT match (exact case only)", isClaudeConfigDirEnvKey("claude_config_dir", "linux") === false);
  check("(4a) POSIX: a mixed-case case-variant does NOT match (exact case only)", isClaudeConfigDirEnvKey("Claude_Config_Dir", "linux") === false);
}

// =====================================================================================================
// (4b) case-insensitivity split, through the REAL integration (buildSpawnEnv) — both branches pinned
// explicitly via a temporary process.platform override, restored immediately after each (same pattern
// as test/start-guard-race.mjs), so this is not at the mercy of whichever OS actually ran this test.
// =====================================================================================================
{
  delete process.env.CLAUDE_CONFIG_DIR;
  const maliciousDir = mkdtempManaged("loom-ccdses-bad3-");
  const realPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const lowerWin = buildSpawnEnv(processEnvBase, { claude_config_dir: maliciousDir }, spawnCwd);
    const mixedWin = buildSpawnEnv(processEnvBase, { Claude_Config_Dir: maliciousDir }, spawnCwd);
    check("(4b) win32: a lowercase case-variant key is ALSO scrubbed", !("claude_config_dir" in lowerWin));
    check("(4b) win32: a mixed-case case-variant key is ALSO scrubbed", !("Claude_Config_Dir" in mixedWin));

    Object.defineProperty(process, "platform", { value: "linux" });
    const lowerPosix = buildSpawnEnv(processEnvBase, { claude_config_dir: maliciousDir }, spawnCwd);
    const mixedPosix = buildSpawnEnv(processEnvBase, { Claude_Config_Dir: maliciousDir }, spawnCwd);
    check("(4b) POSIX: a differently-cased key is left completely untouched (not reserved there)",
      lowerPosix.claude_config_dir === maliciousDir && mixedPosix.Claude_Config_Dir === maliciousDir);
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform });
  }
}

// =====================================================================================================
// (7) card fbb6e8ec review round 2 (MAJOR finding): TWO win32-case-variant spellings of the SAME key in
// one sessionEnv object must BOTH be dropped — round 1's `Object.keys(...).find(...)`-based scrub only
// ever dropped the FIRST match, leaving a second spelling to reach the real child process env. Proven
// with the daemon's own CLAUDE_CONFIG_DIR both UNSET and SET, under a forced win32 platform (so this
// proof doesn't depend on which host actually runs it).
// =====================================================================================================
{
  const realPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const maliciousDir1 = mkdtempManaged("loom-ccdses-two1-");
    const maliciousDir2 = mkdtempManaged("loom-ccdses-two2-");

    // --- daemon value UNSET: the child-visible result must be fully absent, from EITHER variant. ---
    delete process.env.CLAUDE_CONFIG_DIR;
    const { result: envUnset, lines: linesUnset } = captureWarnings(() =>
      buildSpawnEnv(processEnvBase, { CLAUDE_CONFIG_DIR: maliciousDir1, claude_config_dir: maliciousDir2, OTHER_VAR: "kept" }, spawnCwd),
    );
    check("(7) daemon unset: CLAUDE_CONFIG_DIR is absent from the spawn env", !("CLAUDE_CONFIG_DIR" in envUnset));
    check("(7) daemon unset: claude_config_dir is ALSO absent (the second variant, round-1's bug)", !("claude_config_dir" in envUnset));
    check("(7) daemon unset: a sibling key is unaffected", envUnset.OTHER_VAR === "kept");
    check("(7) daemon unset: both dropped keys are each named in their own diagnostic line",
      linesUnset.some((l) => l.includes('"CLAUDE_CONFIG_DIR"')) && linesUnset.some((l) => l.includes('"claude_config_dir"')));

    // --- daemon value SET: the child-visible result must be the DAEMON's value, never either variant. ---
    const daemonDir = mkdtempManaged("loom-ccdses-two-daemon-");
    process.env.CLAUDE_CONFIG_DIR = daemonDir;
    const processEnvWithDaemon = { ...processEnvBase, CLAUDE_CONFIG_DIR: daemonDir };
    const envSet = buildSpawnEnv(processEnvWithDaemon, { CLAUDE_CONFIG_DIR: maliciousDir1, claude_config_dir: maliciousDir2 }, spawnCwd);
    check("(7) daemon set: the resolved CLAUDE_CONFIG_DIR is the daemon's own value", envSet.CLAUDE_CONFIG_DIR === daemonDir);
    check("(7) daemon set: neither sessionEnv-sourced variant won", envSet.CLAUDE_CONFIG_DIR !== maliciousDir1 && envSet.claude_config_dir !== maliciousDir2);
    check("(7) daemon set: the second variant's key is not left dangling on the result either", !("claude_config_dir" in envSet));
    delete process.env.CLAUDE_CONFIG_DIR;
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform });
  }
}

// =====================================================================================================
// (6) no false positive: an absent sessionEnv key, and every OTHER sessionEnv key, pass through unaffected.
// =====================================================================================================
{
  delete process.env.CLAUDE_CONFIG_DIR;
  const env = buildSpawnEnv(processEnvBase, { LOOM_DEJA_BIN: "/usr/bin/deja" }, spawnCwd);
  check("(6) a sessionEnv with no CLAUDE_CONFIG_DIR key is completely unaffected", env.LOOM_DEJA_BIN === "/usr/bin/deja");
  check("(6) and still carries no CLAUDE_CONFIG_DIR of its own", !("CLAUDE_CONFIG_DIR" in env));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — buildSpawnEnv drops a sessionEnv-sourced CLAUDE_CONFIG_DIR (logging only the key, never the value), leaves the daemon's own process.env.CLAUDE_CONFIG_DIR untouched so it still reaches the engine and still agrees with claudeConfigHome()/the transcript-root deny rules, honours the win32-case-insensitive/POSIX-exact-case split, and never touches an absent key or a sibling sessionEnv var."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
