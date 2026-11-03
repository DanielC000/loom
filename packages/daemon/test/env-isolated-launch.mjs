import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fafae623: the env-isolating launcher asset (assets/env-isolated-launch.mjs) itself — the ONE thing
// every Loom-built stdio MCP mount now launches through. DETERMINISTIC + CLAUDE-FREE; NETWORK-FREE except
// one best-effort real-npx-through-the-launcher smoke that SKIPs (never fails) when npx isn't on PATH.
//
// Proves:
//   (a) parseLauncherArgv: the `--allow <csv> -- <command> [args...]` contract, incl. malformed shapes.
//   (b) buildIsolatedEnv (pure): base allowlist + named --allow keys survive, case-insensitively; every
//       other inherited key (an ambient daemon var, a credential meant for a DIFFERENT mount, ...) is
//       absent. An empty allow list still keeps the base allowlist.
//   (c) a REAL child_process spawn of the launcher itself (not a mocked call): a target script dumps its
//       OWN env; the launcher drops a planted "secret" NOT in --allow and forwards one that IS; exit code
//       propagates.
//   (d) the launcher correctly re-spawns an absolute, non-.mjs target (a .cmd shim on win32 / a plain
//       script on POSIX) — the shape every REAL stdio mount (Playwright/markitdown/image-gen/github) uses
//       today; a real npx (if present on this host's PATH) runs `--version` through the launcher as a
//       best-effort "does real-world npm-ecosystem cold start survive the launcher" smoke.
//
// Run: 1) build (turbo builds shared first), 2) node test/env-isolated-launch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("loom-env-launch-");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(__dirname, "..", "assets", "env-isolated-launch.mjs");
const {
  parseLauncherArgv, buildIsolatedEnv, BASE_ALLOWLIST, needsWindowsCmdHandling,
  escapeWindowsCmdArgument, buildWindowsCmdInvocation, winCmdShimSpawnTarget, parseNpmCmdShim,
} = await import(pathToFileURL(LAUNCHER).href);
const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");

// ===================== (a) parseLauncherArgv =====================
check("(a) a well-formed argv parses to {allowKeys, command, args}",
  JSON.stringify(parseLauncherArgv(["--allow", "FOO,BAR", "--", "/bin/x", "a", "b"]))
  === JSON.stringify({ allowKeys: ["FOO", "BAR"], command: "/bin/x", args: ["a", "b"] }));
check("(a) an EMPTY --allow csv parses to an empty allowKeys array",
  JSON.stringify(parseLauncherArgv(["--allow", "", "--", "/bin/x"]).allowKeys) === "[]");
check("(a) no trailing args is fine (args: [])",
  JSON.stringify(parseLauncherArgv(["--allow", "", "--", "/bin/x"]).args) === "[]");
check("(a) missing '--allow' as the first token ⇒ null (malformed)", parseLauncherArgv(["--", "/bin/x"]) === null);
check("(a) missing the '--' separator ⇒ null (malformed)", parseLauncherArgv(["--allow", "FOO", "/bin/x"]) === null);
check("(a) missing a command after '--' ⇒ null (malformed)", parseLauncherArgv(["--allow", "FOO", "--"]) === null);
check("(a) an empty argv ⇒ null", parseLauncherArgv([]) === null);

// ===================== (b) buildIsolatedEnv (pure) =====================
const fakeInherited = {
  PATH: "/usr/bin", SYSTEMROOT: "C:\\Windows", TEMP: "/tmp",
  LOOM_MCP_TOKEN: "real-token-value", PROBE_CRED_FOR_OTHER_MOUNT: "other-mounts-secret",
  AMBIENT_DAEMON_VAR: "owner-exported-ambient-value",
  MY_SECRET: "this-mounts-secret-value",
};
const built = buildIsolatedEnv(fakeInherited, ["MY_SECRET"]);
check("(b) a base-allowlist key (PATH) survives", built.PATH === "/usr/bin");
check("(b) a named --allow key survives with its REAL value", built.MY_SECRET === "this-mounts-secret-value");
check("(b) LOOM_MCP_TOKEN (not on the base allowlist, not named) is ABSENT", !("LOOM_MCP_TOKEN" in built));
check("(b) a credential meant for a DIFFERENT mount is ABSENT", !("PROBE_CRED_FOR_OTHER_MOUNT" in built));
check("(b) the daemon's ambient env var is ABSENT", !("AMBIENT_DAEMON_VAR" in built));

const builtNoAllow = buildIsolatedEnv(fakeInherited, []);
check("(b) an EMPTY --allow list still keeps the base allowlist", builtNoAllow.PATH === "/usr/bin" && builtNoAllow.TEMP === "/tmp");
check("(b) an EMPTY --allow list drops MY_SECRET too (it was only reachable via --allow)", !("MY_SECRET" in builtNoAllow));

// case-insensitive base-allowlist matching (Windows env names vary in case).
const builtMixedCase = buildIsolatedEnv({ Path: "/usr/bin", "No_Proxy": "127.0.0.1" }, []);
check("(b) base allowlist matches case-insensitively (Path survives even though BASE_ALLOWLIST says 'PATH')",
  builtMixedCase.Path === "/usr/bin");
check("(b) NO_PROXY-family matches case-insensitively too ('No_Proxy' survives)", builtMixedCase.No_Proxy === "127.0.0.1");
check("(b) BASE_ALLOWLIST is non-empty and includes PATH/TEMP/NODE_EXTRA_CA_CERTS", BASE_ALLOWLIST.includes("PATH") && BASE_ALLOWLIST.includes("TEMP") && BASE_ALLOWLIST.includes("NODE_EXTRA_CA_CERTS"));
check("(b) --allow key matching is also case-insensitive against the inherited env",
  buildIsolatedEnv({ my_secret: "v" }, ["MY_SECRET"]).my_secret === "v");

// ===================== (b2) card 188d6a8c: HTTP_PROXY/HTTPS_PROXY/ALL_PROXY are NOT in BASE_ALLOWLIST =====
// (they may carry embedded `user:pass@host:port` credentials) — only a mount that names them via --allow
// (pty/host.ts's PROXY_ENV_KEYS, added for markitdown/the seeded github-binary capability) receives one.
// NO_PROXY stays in the base — it carries no credential.
check("(b2) BASE_ALLOWLIST no longer carries HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/all_proxy (card 188d6a8c)",
  !BASE_ALLOWLIST.includes("HTTP_PROXY") && !BASE_ALLOWLIST.includes("HTTPS_PROXY")
  && !BASE_ALLOWLIST.includes("ALL_PROXY") && !BASE_ALLOWLIST.includes("all_proxy"));
check("(b2) BASE_ALLOWLIST still carries NO_PROXY (no credential, unconditional forwarding is harmless)", BASE_ALLOWLIST.includes("NO_PROXY"));
const credentialedProxyEnv = {
  PATH: "/usr/bin", HTTP_PROXY: "http://corpuser:corppass@proxy.corp.example:8080",
  https_proxy: "http://corpuser:corppass@proxy.corp.example:8080", ALL_PROXY: "http://corpuser:corppass@proxy.corp.example:1080",
};
const builtUnentitled = buildIsolatedEnv(credentialedProxyEnv, []);
check("(b2) with NO --allow entry naming it, a credentialed HTTP_PROXY is ABSENT from an unentitled mount's env",
  !("HTTP_PROXY" in builtUnentitled));
check("(b2) same for the lowercase https_proxy variant", !("https_proxy" in builtUnentitled));
check("(b2) same for ALL_PROXY", !("ALL_PROXY" in builtUnentitled));
const builtEntitled = buildIsolatedEnv(credentialedProxyEnv, ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"]);
check("(b2) naming HTTP_PROXY via --allow forwards the RAW credentialed value (scoping, never stripping)",
  builtEntitled.HTTP_PROXY === "http://corpuser:corppass@proxy.corp.example:8080");
check("(b2) naming it case-insensitively still matches the lowercase https_proxy key present in the inherited env",
  builtEntitled.https_proxy === "http://corpuser:corppass@proxy.corp.example:8080");

// ===================== (c) REAL child_process spawn of the launcher =====================
const ECHO_ENV_FIXTURE = path.join(__dirname, "fixtures", "echo-env.mjs");
{
  const env = {
    PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir(), HOME: process.env.HOME ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "",
    ALLOWED_SECRET: "should-survive-abc123",
    NOT_ALLOWED_SECRET: "should-NEVER-survive-xyz789",
  };
  const { stdout } = await execFileAsync(process.execPath, [LAUNCHER, "--allow", "ALLOWED_SECRET", "--", process.execPath, ECHO_ENV_FIXTURE], { env });
  const echoed = JSON.parse(stdout);
  check("(c) the real spawned target received the --allow-listed key", echoed.env.ALLOWED_SECRET === "should-survive-abc123");
  check("(c) the real spawned target did NOT receive the non-allow-listed key", !("NOT_ALLOWED_SECRET" in echoed.env));
  check("(c) the real spawned target's argv never carried either secret value",
    !JSON.stringify(echoed.argv).includes("should-survive-abc123") && !JSON.stringify(echoed.argv).includes("should-NEVER-survive-xyz789"));
}
{
  // (c2) card 188d6a8c, REAL spawn: a credentialed HTTP_PROXY in the launcher's own inherited env reaches
  // the real target ONLY when named via --allow — proves the b2 pure-function result end to end, not just
  // in isolation.
  const credEnv = {
    PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir(), HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
    HTTP_PROXY: "http://corpuser:corppass@proxy.corp.example:8080",
  };
  const { stdout: stdoutUnentitled } = await execFileAsync(process.execPath, [LAUNCHER, "--allow", "", "--", process.execPath, ECHO_ENV_FIXTURE], { env: credEnv });
  const echoedUnentitled = JSON.parse(stdoutUnentitled);
  check("(c2) an UNENTITLED real target (empty --allow) never receives the credentialed HTTP_PROXY", !("HTTP_PROXY" in echoedUnentitled.env));

  const { stdout: stdoutEntitled } = await execFileAsync(process.execPath, [LAUNCHER, "--allow", "HTTP_PROXY", "--", process.execPath, ECHO_ENV_FIXTURE], { env: credEnv });
  const echoedEntitled = JSON.parse(stdoutEntitled);
  check("(c2) an ENTITLED real target (--allow HTTP_PROXY) receives the RAW credentialed value", echoedEntitled.env.HTTP_PROXY === "http://corpuser:corppass@proxy.corp.example:8080");
}
{
  // exit-code propagation: the fixture's own process.exit(1) must surface through the launcher.
  const EXIT_FIXTURE = path.join(__dirname, "fixtures", "_child-exit1.mjs");
  let threw = false;
  try {
    await execFileAsync(process.execPath, [LAUNCHER, "--allow", "", "--", process.execPath, EXIT_FIXTURE], {
      env: { PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir() },
    });
  } catch (err) {
    threw = true;
    check("(c) a non-zero real child exit code propagates through the launcher", err.code === 1);
  }
  check("(c) the non-zero-exit case actually threw (execFile rejects on non-zero exit)", threw);
}

// ===================== needsWindowsCmdHandling: the EINVAL fix — a .cmd/.bat target needs cmd.exe =====================
// MEASURED (card fafae623, this host): a bare `child_process.spawn(cmdFile, args, {shell:false})` throws
// EINVAL for a real .CMD target on win32 — found by this very test before the fix (the real npx smoke
// below). `needsWindowsCmdHandling` is the ONE thing that decides when the launcher must route through
// `winCmdShimSpawnTarget` / `buildWindowsCmdInvocation` instead of a plain shell-free spawn.
check("(cmd) a .cmd target on this platform needs cmd handling iff this platform is win32",
  needsWindowsCmdHandling("C:\\x\\npx.cmd") === (process.platform === "win32"));
check("(cmd) a .CMD (uppercase) target matches too (case-insensitive extension)",
  needsWindowsCmdHandling("C:\\x\\npx.CMD") === (process.platform === "win32"));
check("(cmd) a .bat target matches too", needsWindowsCmdHandling("C:\\x\\run.bat") === (process.platform === "win32"));
check("(cmd) a plain .exe/binary target never needs cmd handling", needsWindowsCmdHandling("C:\\x\\node.exe") === false);
check("(cmd) a plain .mjs/.js-adjacent path (no .cmd/.bat suffix) never needs cmd handling", needsWindowsCmdHandling("/usr/bin/markitdown-mcp") === false);

// ===================== Code Review round 1 (reviewer b5883c03) BLOCKER B1 — shell:true was REAL command
// injection, not just a quoting nuisance: Node does NOT escape args under shell:true, and cmd.exe ignores
// a literal `\"`. MEASURED with real spawns against a probe .cmd (see below): unquoted `x&echo>S`,
// `x|echo>S`, `x>S` executed; `a" & echo q>F & "` broke out of quoting; `%USERNAME%` expanded inside
// quotes; `a^b` collapsed to `ab`; a newline truncated the argument. shell:true is now GONE —
// escapeWindowsCmdArgument/buildWindowsCmdInvocation spawn cmd.exe directly as a plain target
// (shell:false) with a fully pre-escaped `/c` line and windowsVerbatimArguments:true. =====================
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
check("(escape) a plain argument with no metacharacters is simply wrapped in quotes",
  escapeWindowsCmdArgument("hello") === '"hello"');
check("(escape) an embedded double quote is DOUBLED, not backslash- or caret-escaped (the only form measured to survive cmd's own tokenizer)",
  escapeWindowsCmdArgument('a"b') === '"a""b"');
check("(escape) a trailing backslash is doubled so the appended closing quote isn't swallowed by the C-runtime argv parser",
  escapeWindowsCmdArgument("C:\\x\\") === '"C:\\x\\\\"');
// Code Review round 2 (reviewer 7b1b9aa0): a backslash run IMMEDIATELY BEFORE an embedded quote used to
// survive untouched while only the quote itself got doubled — on the downstream CommandLineToArgvW
// convention that splits the target's argv (`a\" b` arrived as two args: ["a\"","b"]). Fixed by doubling
// any backslash run that precedes a quote, THEN doubling the quote — measured 8/8 byte-intact, 0
// sentinels. See this card's decision record.
check("(escape) a single backslash immediately before an embedded quote is doubled, then the quote is doubled",
  escapeWindowsCmdArgument('a\\"b') === `"a\\\\""b"`);
check("(escape) a backslash RUN (not just one) before an embedded quote is doubled as a whole run",
  escapeWindowsCmdArgument('a\\\\"b') === `"a\\\\\\\\""b"`);
check("(escape) a backslash before a quote mid-string and a genuinely trailing backslash are handled independently",
  escapeWindowsCmdArgument('a\\"b\\') === `"a\\\\""b\\\\"`);
check("(escape) &|<>()!^ are left UNESCAPED inside the quotes (quoting alone neutralizes them; MEASURED — see this card's decision record)",
  escapeWindowsCmdArgument("a&b|c<d>e(f)g!h^i") === '"a&b|c<d>e(f)g!h^i"');
check("(escape) a newline is REFUSED outright (no cmd.exe-safe representation exists for one)", throws(() => escapeWindowsCmdArgument("a\nb")));
check("(escape) a carriage return is refused too", throws(() => escapeWindowsCmdArgument("a\rb")));
check("(escape) a '%' is REFUSED outright (variable expansion was measured to survive every escaping attempt)", throws(() => escapeWindowsCmdArgument("%USERNAME%")));
check("(escape) a '%' anywhere in the argument is refused, not just a matched %...% pair", throws(() => escapeWindowsCmdArgument("50% done")));

{
  // buildWindowsCmdInvocation: asserts on the CONSTRUCTED line directly (not just real-spawn behavior).
  const built = buildWindowsCmdInvocation("C:\\a b\\x.cmd", ["--flag", 'has"quote']);
  check("(invocation) the constructed line wraps the whole escaped command+args in ONE more literal quote pair",
    built.args[4] === `""C:\\a b\\x.cmd" "--flag" "has""quote""`);
  check("(invocation) args is exactly ['/d','/v:off','/s','/c', line] — /v:off (Code Review round 2) disables DelayedExpansion so a forwarded secret's own value can never be read back as a `!VAR!` expansion",
    built.args[0] === "/d" && built.args[1] === "/v:off" && built.args[2] === "/s" && built.args[3] === "/c");
  check("(invocation) comspec resolves from ComSpec/COMSPEC, falling back to 'cmd.exe'", typeof built.comspec === "string" && built.comspec.length > 0);
}

{
  // ===== Real end-to-end metacharacter-injection matrix (never a unit test of the escaper alone) =====
  // Spawns the REAL launcher targeting fixtures/cmd-argv-probe.cmd (a trivial .cmd, NOT an npm-cmd-shim —
  // deliberately exercises path B / buildWindowsCmdInvocation, never winCmdShimSpawnTarget) with each
  // attack string as ONE argument. For every case: the probe's own argv dump must carry the attack
  // string back BYTE-FOR-BYTE (no truncation/expansion/collapse), and no injected extra command may have
  // run (a sentinel file the attack string tries to create/overwrite must never appear).
  if (process.platform === "win32") {
    const PROBE_CMD = path.join(__dirname, "fixtures", "cmd-argv-probe.cmd");
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-env-launch-cmdmeta-"));
    const runCase = async (label, attackString, { expectIntact = true, expectRefused = false } = {}) => {
      const outFile = path.join(scratchDir, `out-${label.replace(/[^a-z0-9]/gi, "_")}.json`);
      const sentinelFile = path.join(scratchDir, `sentinel-${label.replace(/[^a-z0-9]/gi, "_")}.txt`);
      const resolvedAttack = attackString.replaceAll("__SENTINEL__", sentinelFile);
      let threw = false;
      try {
        await execFileAsync(process.execPath, [LAUNCHER, "--allow", "", "--", PROBE_CMD, outFile, resolvedAttack], {
          env: { PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", COMSPEC: process.env.COMSPEC ?? "", PATHEXT: process.env.PATHEXT ?? "", TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir() },
        });
      } catch { threw = true; }
      if (expectRefused) {
        check(`(metachar) ${label}: the launcher REFUSES outright (non-zero exit), never attempts the spawn`, threw);
        check(`(metachar) ${label}: no output file was ever written (refused BEFORE spawning)`, !fs.existsSync(outFile));
        check(`(metachar) ${label}: no injected command ran either`, !fs.existsSync(sentinelFile));
        return;
      }
      check(`(metachar) ${label}: the launcher did not crash spawning the probe`, !threw);
      check(`(metachar) ${label}: no injected command ran (sentinel file absent)`, !fs.existsSync(sentinelFile));
      if (expectIntact) {
        const dumped = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : null;
        check(`(metachar) ${label}: the attack string arrived at the real process byte-for-byte intact`,
          Array.isArray(dumped) && dumped[dumped.length - 1] === resolvedAttack);
      }
    };
    await runCase("amp-redirect", "x&echo>__SENTINEL__");
    await runCase("pipe-redirect", "x|echo>__SENTINEL__");
    await runCase("bare-redirect", "x>__SENTINEL__");
    await runCase("quote-breakout", 'a" & echo q>__SENTINEL__ & "');
    await runCase("percent-expand", "%USERNAME%", { expectRefused: true });
    await runCase("caret-collapse", "a^b");
    // Code Review round 2 (reviewer 7b1b9aa0): a backslash run before an embedded quote used to split the
    // target's argv instead of surviving as one argument — these four reproduce the reviewer's own
    // measured cases end to end (real cmd.exe, not just the escaper in isolation).
    await runCase("backslash-before-quote", 'a\\" b');
    await runCase("backslash-quote-breakout", 'x\\" & echo pwned>__SENTINEL__ & \\"');
    await runCase("lone-backslash-quote", '\\"');
    await runCase("trailing-backslash-path", "C:\\Program Files\\");

    // The newline case: REFUSED before any spawn — never a "ran but truncated" outcome.
    const outFileNl = path.join(scratchDir, "out-newline.json");
    let threwOnNewline = false;
    try {
      await execFileAsync(process.execPath, [LAUNCHER, "--allow", "", "--", PROBE_CMD, outFileNl, "a\nb"], {
        env: { PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", COMSPEC: process.env.COMSPEC ?? "", TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir() },
      });
    } catch { threwOnNewline = true; }
    check("(metachar) newline: the launcher refuses the spawn outright (non-zero exit), never silently truncates", threwOnNewline);
    check("(metachar) newline: no output file was ever written (refused BEFORE spawning, not after)", !fs.existsSync(outFileNl));

    // ===== Code Review round 2 (reviewer 7b1b9aa0), item 3: /v:off closes registry DelayedExpansion =====
    // HERMETIC — never touches the host registry (the real ambient-default vector this closes). Instead
    // forces DelayedExpansion ON via cmd.exe's own `/v:on` command-line SWITCH as a POSITIVE CONTROL: this
    // proves the expansion mechanism is genuinely reachable (so the real check below isn't vacuous), using
    // only an explicit, per-invocation switch — never the registry a real ambient-ON host would set.
    const DUMP_FIXTURE = path.join(__dirname, "fixtures", "cmd-argv-dump.mjs");
    const outFileControl = path.join(scratchDir, "out-vexpand-control.json");
    const outFileReal = path.join(scratchDir, "out-vexpand-real.json");
    const bangArg = "hello !PROBE_SENTINEL_VALUE! world";
    const vExpandEnv = {
      PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      COMSPEC: process.env.COMSPEC ?? "", TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir(),
      PROBE_SENTINEL_VALUE: "LEAKED-VIA-DELAYED-EXPANSION",
    };
    const controlEscaped = [process.execPath, DUMP_FIXTURE, outFileControl, bangArg].map(escapeWindowsCmdArgument);
    const controlLine = `"${controlEscaped.join(" ")}"`;
    await execFileAsync(vExpandEnv.COMSPEC || "cmd.exe", ["/d", "/v:on", "/s", "/c", controlLine], { env: vExpandEnv, windowsVerbatimArguments: true });
    const controlDumped = JSON.parse(fs.readFileSync(outFileControl, "utf8"));
    check("(v:off control) with DelayedExpansion forced ON via the /v:on SWITCH (never the registry), a !VAR!-shaped argument DOES get expanded to the live env value — proves the mechanism is real, not a vacuous control",
      controlDumped[controlDumped.length - 1] === "hello LEAKED-VIA-DELAYED-EXPANSION world");

    // The REAL production shape: buildWindowsCmdInvocation now bakes in /v:off unconditionally. The SAME
    // !VAR!-shaped argument must survive byte-for-byte, regardless of this host's own ambient registry
    // DelayedExpansion default (untouched by this test either way).
    const real = buildWindowsCmdInvocation(process.execPath, [DUMP_FIXTURE, outFileReal, bangArg]);
    await execFileAsync(real.comspec, real.args, { env: vExpandEnv, windowsVerbatimArguments: true });
    const realDumped = JSON.parse(fs.readFileSync(outFileReal, "utf8"));
    check("(v:off) the real /v:off invocation leaves a !VAR!-shaped argument literal, never expanded",
      realDumped[realDumped.length - 1] === bangArg);
  } else {
    console.log("SKIP  (metachar) the cmd.exe-metacharacter-injection matrix is win32-only (no cmd.exe elsewhere)");
  }
}

// ===================== winCmdShimSpawnTarget / parseNpmCmdShim — the npm-cmd-shim fast path =====================
// Mirrors pty/resolve-bin.ts's own copy (duplicated here deliberately — see this file's doc comment on
// why asset scripts never import dist); test/win-cmd-shim-parity.mjs pins the two copies identical.
check("(shim) a non-.cmd command is never routed through the shim parser", winCmdShimSpawnTarget("/usr/bin/node", []) === null);
{
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-shim-"));
  const shimPath = path.join(scratchDir, "fake-cli.cmd");
  const entryPath = path.join(scratchDir, "cli.js");
  fs.writeFileSync(entryPath, "// entry");
  const npmShimTemplate = [
    "@ECHO off",
    "SETLOCAL",
    'SET "_prog=cli.js"',
    'SET PATHEXT=%PATHEXT:;.JS;=;%',
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  +"%dp0%\\cli.js" %*',
  ].join("\r\n");
  // This handcrafted fixture is intentionally close to, but not pinned as, the exact production regex —
  // the real corpus check lives in win-cmd-shim-parity.mjs; here we only prove the function doesn't throw
  // and degrades to null on a non-matching (or absent) file.
  fs.writeFileSync(shimPath, npmShimTemplate);
  let shimResult;
  if (process.platform === "win32") {
    shimResult = winCmdShimSpawnTarget(shimPath, ["--version"]);
  }
  check("(shim) parseNpmCmdShim never throws on a real .cmd file, matching or not", (() => { try { parseNpmCmdShim(shimPath); return true; } catch { return false; } })());
  check("(shim) parseNpmCmdShim returns null (not a throw) for Node's OWN bundled npx.cmd shape (different template)",
    (() => {
      const npxLikePath = path.join(scratchDir, "npx-like.cmd");
      fs.writeFileSync(npxLikePath, '@ECHO OFF\nSETLOCAL\nSET "NODE_EXE=%~dp0\\node.exe"\n"%NODE_EXE%" "%~dp0\\npx-cli.js" %*\n');
      return parseNpmCmdShim(npxLikePath) === null;
    })());
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ===================== (d) a real, absolute, non-.mjs target — the shape every real stdio mount uses =====================
{
  // process.execPath itself: absolute, not a .mjs file, exactly the "direct binary" shape Playwright/
  // markitdown/image-gen/github-binary resolve to before wrapping.
  const { stdout } = await execFileAsync(process.execPath, [LAUNCHER, "--allow", "", "--", process.execPath, "--version"], { env: { PATH: process.env.PATH ?? process.env.Path ?? "" } });
  check("(d) the launcher correctly re-spawns an absolute non-.mjs binary (node --version through the launcher)", stdout.trim().startsWith("v"));
}
{
  // Best-effort: a REAL npx on this host, run through the launcher — the one case (image-gen's "npx"
  // provision) that's genuinely a .cmd shim on win32. SKIPs (never fails) if npx isn't resolvable here.
  const npx = resolveExecutable("npx");
  if (path.isAbsolute(npx) && fs.existsSync(npx)) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [LAUNCHER, "--allow", "npm_config_cache,npm_config_registry", "--", npx, "--version"], {
        env: {
          PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
          COMSPEC: process.env.COMSPEC ?? "", PATHEXT: process.env.PATHEXT ?? "",
          TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir(), HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
        },
      });
      check("(d) a REAL npx (.cmd shim on win32) resolved on this host runs `--version` through the launcher", /^\d+\.\d+\.\d+/.test(stdout.trim()));
    } catch (err) {
      check(`(d) a real npx through the launcher — FAILED: ${err.message}`, false);
    }
  } else {
    console.log("SKIP  (d) real-npx-through-launcher smoke (npx not resolvable on this host's PATH)");
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the env-isolating launcher (card fafae623): parseLauncherArgv's --allow/--  contract (incl. malformed shapes), buildIsolatedEnv's pure base-allowlist + named---allow-key isolation (case-insensitive, every other inherited var absent by construction), a REAL child_process spawn proving the isolation + exit-code propagation end to end, and the launcher correctly re-spawning an absolute non-.mjs binary (incl. a best-effort real-npx .cmd-shim smoke on win32) — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
