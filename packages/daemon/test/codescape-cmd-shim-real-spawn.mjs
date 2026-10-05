import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8ddd12c6 (round 2, superseding e929acdf/774be91e — see docs/decisions/8ddd12c6's own "Round 1
// (superseded)" section): a resolved npm `.cmd` shim (e.g. an npm-global `codescape` install on Windows)
// is parsed and spawned as node + its real entry script, NEVER routed through cmd.exe. Round 1 routed a
// resolved `.cmd` through a hand-built, quoted `cmd.exe /d /s /c "<command line>"` invocation — Code
// Review 3b69bdea reproduced four real defects in that approach with real spawns on this host: (1)
// CRITICAL single-level escaping let an injection payload re-expand through the shim's own `%*` and
// create a marker file; (2) MAJOR an unquoted shim path containing a space failed outright; (3) MAJOR
// every spawned child became cmd.exe itself, so `kill()` only killed the wrapper and orphaned the real
// node process (a surviving grandchild, confirmed by exact pid); (4) MAJOR the test's own quoting case
// didn't discriminate. This file proves round 2 fixes all four, RED against round 1's code for the
// injection (1) and kill/orphan (3) cases specifically (manually verified: `git show e929acdf:...`
// restored + rebuilt, this exact file run, (a)'s injection-marker check and (b)'s kill/grandchild check
// both failed — see the worker report for the restore/rebuild/restore cycle).
//
// Builds a REAL npm `cmd-shim`-shaped `.cmd` file (verified against this host's real npm-installed
// `codex.cmd`/`corepack.cmd`/`pnpm.cmd` — all byte-identical in shape) inside a directory containing a
// SPACE and an `&` (CR MAJOR finding 2), whose entry is a copy of the existing, already-covered fixture
// CLI (test/fixtures/fake-codescape-cli.mjs). This exercises the REAL win32 spawn boundary
// `winCmdShimSpawnTarget`/`parseNpmCmdShim` (pty/resolve-bin.ts) now routes through node directly — a
// mocked exec could never catch this (memory `real-spawn-smoke-for-subprocess-features`). Claude/codex/
// network free.
//
// Run: 1) build (turbo builds shared first), 2) node test/codescape-cmd-shim-real-spawn.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnProcess } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

if (process.platform !== "win32") {
  // Card 85bd4052-shaped WARN SKIP (see codex-version-real-spawn.mjs's own header): the `.cmd`-wrapper
  // fixture mechanism this file uses is Windows-only.
  console.log("WARN  SKIP  codescape-cmd-shim-real-spawn.mjs — the .cmd-wrapper fixture this file uses is Windows-only (process.platform !== 'win32' here); see codex-version-real-spawn.mjs's header for the accepted POSIX gap this mirrors.");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CLI = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");

const tmpHome = mkdtempManaged("loom-cs-cmdshim-");
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_DEV = "1";
delete process.env.LOOM_CODESCAPE_ENABLED;

/** The real npm `cmd-shim` template (verified against this host's own `%APPDATA%\npm\codex.cmd` /
 *  `corepack.cmd` / `pnpm.cmd` — byte-identical in shape across all three). `relativeEntry` is the
 *  `%dp0%`-relative path cmd-shim fills in for the installed package's own entry script. */
function npmCmdShimTemplate(relativeEntry) {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeEntry}" %*`,
    "",
  ].join("\r\n");
}

// A real npm-global-install shape, deliberately rooted in a directory containing a SPACE and an `&` (CR
// MAJOR finding 2 — round 1 failed outright on exactly this shape, since it never quoted the command
// itself before handing it to cmd.exe).
const installDir = path.join(tmpHome, "John Smith & Co", "npm");
fs.mkdirSync(path.join(installDir, "node_modules", "fake-codescape", "bin"), { recursive: true });
const entryPath = path.join(installDir, "node_modules", "fake-codescape", "bin", "fake-codescape.mjs");
fs.copyFileSync(FIXTURE_CLI, entryPath);
const shimPath = path.join(installDir, "fake-codescape.cmd");
fs.writeFileSync(shimPath, npmCmdShimTemplate("node_modules\\fake-codescape\\bin\\fake-codescape.mjs"));
process.env.LOOM_CODESCAPE_BIN = shimPath;

const { winCmdShimSpawnTarget, needsWindowsCmdShim, parseNpmCmdShim } = await import("../dist/pty/resolve-bin.js");
const { CodescapeSupervisor } = await import("../dist/codescape/supervisor.js");
const { isCodescapeSupervisorEnabled } = await import("../dist/paths.js");

// ===================== pure parsing / shim helpers (no spawn) =====================
check("(shim) needsWindowsCmdShim is true for a resolved .cmd", needsWindowsCmdShim("C:\\x\\y.cmd") === true);
check("(shim) needsWindowsCmdShim is true for .bat too (case-insensitive)", needsWindowsCmdShim("C:\\x\\Y.BAT") === true);
check("(shim) needsWindowsCmdShim is false for a real .exe (no rerouting needed)", needsWindowsCmdShim("C:\\x\\y.exe") === false);
check("(shim) winCmdShimSpawnTarget is a byte-identical passthrough for a non-.cmd command", (() => {
  const t = winCmdShimSpawnTarget("C:\\x\\y.exe", ["a", "b"]);
  return t.command === "C:\\x\\y.exe" && JSON.stringify(t.args) === JSON.stringify(["a", "b"]);
})());

{
  const parsed = parseNpmCmdShim(shimPath);
  check("(parse) entry resolves to the real .mjs entry script on disk", parsed.entry === entryPath && fs.existsSync(parsed.entry));
  check("(parse) nodeBin falls back to the currently-running node (no sibling node.exe present)", parsed.nodeBin === process.execPath);
}

{
  const t = winCmdShimSpawnTarget(shimPath, ["ingest", "a b"]);
  check("(shim) a .cmd command is rerouted to node directly — NOT cmd.exe", t.command === process.execPath);
  check("(shim) rerouted args are [entryPath, ...originalArgs] — no shell, no quoted command line", JSON.stringify(t.args) === JSON.stringify([entryPath, "ingest", "a b"]));
  check("(shim) no windowsVerbatimArguments field — there is no cmd.exe command line left to re-quote", t.windowsVerbatimArguments === undefined);
}

// ===================== sibling node.exe preference (pure parse, no real exe needed) =====================
{
  const siblingDir = path.join(tmpHome, "with-sibling-node");
  fs.mkdirSync(path.join(siblingDir, "node_modules", "fake-codescape", "bin"), { recursive: true });
  const siblingEntry = path.join(siblingDir, "node_modules", "fake-codescape", "bin", "fake-codescape.mjs");
  fs.copyFileSync(FIXTURE_CLI, siblingEntry);
  const siblingShim = path.join(siblingDir, "fake-codescape.cmd");
  fs.writeFileSync(siblingShim, npmCmdShimTemplate("node_modules\\fake-codescape\\bin\\fake-codescape.mjs"));
  const siblingNodeExe = path.join(siblingDir, "node.exe");
  fs.writeFileSync(siblingNodeExe, ""); // never executed — parsing only ever checks fs.existsSync
  const parsed = parseNpmCmdShim(siblingShim);
  check("(parse, sibling) nodeBin prefers the shim's own sibling node.exe when present on disk — mirrors the shim's own IF EXIST branch", parsed.nodeBin === siblingNodeExe);
}

// ===================== refusal: a non-npm .cmd is never routed through a shell =====================
{
  const bogusShim = path.join(tmpHome, "bogus.cmd");
  fs.writeFileSync(bogusShim, "@echo off\r\necho not an npm cmd-shim\r\n");
  let threw = null;
  try { winCmdShimSpawnTarget(bogusShim, ["x"]); } catch (err) { threw = err; }
  check("(refuse) a non-npm .cmd throws rather than falling back to a shell", threw instanceof Error);
  check("(refuse) the thrown error names the actual path", !!threw?.message.includes(bogusShim));
}

// ===================== item 4 (card adeb453f): supervisor-level refusal end to end =====================
// ingest() surfaces the same refusal through its own async, never-throws contract: ok:false, with "not a
// recognisable npm cmd-shim" in the captured output tail (runBounded's catch around winCmdShimSpawnTarget
// — see supervisor.ts's own card 8ddd12c6 comment there).
{
  const badIngestSup = new CodescapeSupervisor({ homeDir: path.join(tmpHome, "bad-ingest-home"), ingestTimeoutMs: 15_000 });
  await badIngestSup.start([], path.join(tmpHome, "bogus.cmd"));
  badIngestSup.stop(); // start() with no repoPaths still spawns `serve` — stop it immediately, out of scope here.
  const r = await badIngestSup.ingest(path.join(tmpHome, "some-other-repo"));
  check("(item4, ingest) a non-npm .cmd surfaces ok:false through ingest()", r.ok === false);
  check('(item4, ingest) the output tail names "not a recognisable npm cmd-shim"', !!r.errorTail?.includes("not a recognisable npm cmd-shim"));
}

// trySpawnChild (the `serve` path): warns on each failed attempt and gives up after a BOUNDED number of
// restarts — never an infinite retry loop. A tiny test-seam backoff schedule (restartBackoffMs) keeps
// this fast instead of waiting out the real multi-minute default schedule.
{
  const warnings = [];
  const errors = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args) => { warnings.push(args.join(" ")); origWarn(...args); };
  console.error = (...args) => { errors.push(args.join(" ")); origError(...args); };
  let sup2 = null;
  try {
    sup2 = new CodescapeSupervisor({
      homeDir: path.join(tmpHome, "bad-serve-home"),
      restartBackoffMs: [5, 5],
      restartWindowMs: 60_000,
      maxRestartsPerWindow: 50,
    });
    await sup2.start([], path.join(tmpHome, "bogus.cmd"));
    await waitUntil(() => errors.some((m) => m.includes("gave up")), { timeoutMs: 5_000, label: "trySpawnChild gives up after exhausting its bounded backoff" });
    check("(item4, serve) trySpawnChild warns on the failed spawn attempt", warnings.some((m) => m.includes("[codescape] serve spawn failed") && m.includes("not a recognisable npm cmd-shim")));
    check("(item4, serve) the restart loop is BOUNDED — it gives up rather than retrying forever", errors.some((m) => m.includes("gave up")));
    check("(item4, serve) no real child ever came up across any attempt", sup2.getSpawnCount() === 0);
    check("(item4, serve) getPort() reflects the given-up state — broken stays visibly down", sup2.getPort() === null);
  } finally {
    console.warn = origWarn;
    console.error = origError;
    sup2?.stop();
  }
}

// ===================== gate sanity: the shim resolves + the supervisor is enabled =====================
check("(gate) isCodescapeSupervisorEnabled() is TRUE (LOOM_DEV=1 + the shim resolves on disk)", isCodescapeSupervisorEnabled() === true);

// ===================== real spawn: ingest() through the real npm-shim shape =====================
// Public per ingest()'s own doc ("independently of start()'s own bootstrap loop"), but today
// `this.codescapePath` is only ever set by start() (card b8de5876) — so start() is the real call path
// this exercises, exactly as boot does. We pass NO repoPaths to start() itself (avoids entangling this
// test with spawnServe()'s own `serve` lifecycle, a separate concern from this card) and instead call the
// public ingest() directly afterward, which is what boot's own bootstrap loop does per repoPath.
const homeDir = path.join(tmpHome, "home");
const sup = new CodescapeSupervisor({ homeDir, ingestTimeoutMs: 15_000 });
await sup.start([], shimPath);
sup.stop(); // start() with no repoPaths still spawns `serve` — stop it immediately, out of scope here.

const repoPathPlain = path.join(tmpHome, "some-repo");
// A repoPath with a SPACE and `&` (CR MAJOR finding 2) — distinct from the shim's OWN install dir above
// also containing a space+`&`, so a plain-but-unescaped round-1 failure can't hide behind "only the shim
// path itself was ever the problem".
const repoPathSpacesAmp = path.join(tmpHome, "a repo & co");
// An argument carrying the exact CVE-2024-27980 metacharacter set — ", &, %, !, ^ — that must arrive
// VERBATIM as plain argv text, never interpreted (there is no shell left to interpret anything).
const repoPathQuoting = 'a repo & co "nick"name %percent% !bang! ^caret^';
// The injection payload from CR CRITICAL finding 1: under round 1's cmd.exe routing, an npm shim's own
// `%*` re-expansion let this break out and create a marker file via the shell itself.
const injectionMarker = path.join(tmpHome, "INJECTED2");
const repoPathInjection = `x"&echo INJECTED2>${injectionMarker}`;

const r1 = await sup.ingest(repoPathPlain);
check("(real-spawn) ingest() through the real npm-shim shape succeeds (ok:true)", r1.ok === true);
check("(real-spawn) outcome is 'ready' on a plain repoPath", r1.outcome === "ready");

const r2 = await sup.ingest(repoPathSpacesAmp);
check("(real-spawn, space+amp) ingest() succeeds for a repoPath containing a space and `&` — round 1 failed outright on exactly this shape (CR MAJOR finding 2)", r2.ok === true);

const r3 = await sup.ingest(repoPathQuoting);
check('(real-spawn, quoting) ingest() succeeds for a repoPath containing ", &, %, !, ^', r3.ok === true);

const r4 = await sup.ingest(repoPathInjection);
check("(real-spawn, injection) ingest() succeeds (there is no shell left to reject or mangle the payload)", r4.ok === true);
check("(real-spawn, injection) NO marker file was created — there is no shell between us and node to interpret `&echo ... >` (CR CRITICAL finding 1, reproduced on round 1's code)", !fs.existsSync(injectionMarker));

const callsFile = path.join(homeDir, "fake-codescape-calls.jsonl");
const calls = fs.existsSync(callsFile)
  ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const ingestCalls = calls.filter((c) => c.cmd === "ingest");
check("(real-spawn) exactly 4 ingest calls were recorded by the REAL child process (not mocked)", ingestCalls.length === 4);
check("(real-spawn) call #1's repoPath round-tripped verbatim", ingestCalls[0]?.repoPath === repoPathPlain);
check("(real-spawn, space+amp) call #2's repoPath round-tripped verbatim — no shell tokenization on the space/`&`", ingestCalls[1]?.repoPath === repoPathSpacesAmp);
check('(real-spawn, quoting) call #3\'s repoPath (", &, %, !, ^) round-tripped verbatim — proves there is no quoting/escaping layer left to get wrong, not just that spawn succeeds', ingestCalls[2]?.repoPath === repoPathQuoting);
check("(real-spawn, injection) call #4's repoPath (the injection payload) round-tripped verbatim, inert as plain argv text — never interpreted", ingestCalls[3]?.repoPath === repoPathInjection);

// ===================== real spawn: kill() leaves NO surviving grandchild (exact pid) =====================
// CR MAJOR finding 3: under round 1's cmd.exe routing, every spawned child WAS cmd.exe — child.kill()
// only ever killed that wrapper, orphaning the real node process underneath (reproduced: a surviving
// grandchild after kill(), confirmed by exact pid). This drives winCmdShimSpawnTarget + a real spawn()
// directly (bypassing CodescapeSupervisor's own health/restart machinery, which is a separate concern
// from this card) against a standalone long-lived fixture that self-reports its OWN real pid to a file —
// the decisive check is `child.pid === realPid`: round 1 never satisfies this (child.pid is cmd.exe's
// pid, a distinct grandchild holds the real one), round 2 always does (there is no wrapper at all).
{
  const killDir = path.join(tmpHome, "kill-check");
  fs.mkdirSync(killDir, { recursive: true });
  const pidFile = path.join(killDir, "real-process.pid");
  const longLivedEntry = path.join(killDir, "node_modules", "fake-codescape", "bin", "fake-codescape.mjs");
  fs.mkdirSync(path.dirname(longLivedEntry), { recursive: true });
  fs.writeFileSync(longLivedEntry, [
    'import fs from "node:fs";',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "setInterval(() => {}, 1 << 30);",
  ].join("\n"));
  const killShim = path.join(killDir, "fake-codescape.cmd");
  fs.writeFileSync(killShim, npmCmdShimTemplate("node_modules\\fake-codescape\\bin\\fake-codescape.mjs"));

  const target = winCmdShimSpawnTarget(killShim, []);
  const child = spawnProcess(target.command, target.args, { cwd: killDir, stdio: "ignore" });

  await waitUntil(() => fs.existsSync(pidFile), { timeoutMs: 10_000, label: "real process pid file written" }).catch(() => {});
  const realPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8").trim()) : NaN;
  check("(kill) the fixture wrote its own real pid", Number.isFinite(realPid) && realPid > 0);
  check("(kill) the spawned child's pid IS the real process's pid — no intermediary cmd.exe wrapper (CR MAJOR finding 3)", child.pid === realPid);
  check("(kill) the real process is actually alive before kill()", Number.isFinite(realPid) && isAlive(realPid));

  child.kill();

  const diedWithinBudget = await waitUntil(() => !isAlive(realPid), { timeoutMs: 10_000, label: "real process pid gone after kill()" }).then(() => true).catch(() => false);
  check("(kill) the REAL process is ACTUALLY GONE after kill() — not orphaned behind a dead cmd.exe wrapper (CR MAJOR finding 3, reproduced on round 1's code)", diedWithinBudget);

  // Safety net regardless of the outcome above — never leak a real OS process out of this test, and
  // never by name/port: only by the exact pid this test itself captured.
  if (Number.isFinite(realPid) && isAlive(realPid)) { try { process.kill(realPid); } catch { /* best-effort */ } }
}

await finishAndExit(failures === 0 ? 0 : 1);
