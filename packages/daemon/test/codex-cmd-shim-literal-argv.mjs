import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e92cd4a3 — on Windows `codex` resolves to an npm `.cmd` shim. `createCodexPty` used to hand that `.cmd`
// straight to node-pty, so cmd.exe parsed EVERY argv element (`%VAR%` expansion, `^` stripping). It now routes
// through `winCmdShimSpawnTarget` (node + the shim's real entry), so argv must arrive LITERALLY, and an
// unparsable shim must FAIL CLOSED (throw), never fall back to the implicit cmd.exe.
//
// Drives the REAL (unsubclassed) `PtyHost.createCodexPty()` against an npm-cmd-shim-shaped fixture whose entry
// records its own argv (fixtures/env-dump-cli.mjs). The %/^-bearing argv element is the per-session MCP url
// (it embeds the sessionId); LOOM_E92_MARK is set in the child env so a cmd.exe expansion would be VISIBLE.
// Never the real codex, no ~/.codex touch. WINDOWS-ONLY; SKIPS (exit 0) elsewhere.
//
// Run: 1) build, 2) node test/codex-cmd-shim-literal-argv.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
import { writeNpmCodexShim } from "./_codex-npm-shim.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("WARN  SKIP  codex-cmd-shim-literal-argv.mjs — the .cmd-shim mechanism is Windows-only; off win32 winCmdShimSpawnTarget is a byte-identical passthrough (covered by codescape-cmd-shim-real-spawn.mjs's passthrough check).");
  process.exit(0);
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-dump-cli.mjs");
const tmpHome = mkdtempManaged("loom-codex-shim-argv-");
process.env.LOOM_HOME = tmpHome;
// host.spawn({harness:"codex"}) reads codexSessionsRoot() before createCodexPty — never the real ~/.codex.
process.env.CODEX_HOME = mkdtempManaged("loom-codex-shim-argv-codexhome-");
process.env.LOOM_CODEX_BIN = writeNpmCodexShim(tmpHome, FIXTURE_PATH);

const { PtyHost } = await import("../dist/pty/host.js");
const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };

const MARK = "EXPANDED-BY-CMD";
const HOSTILE_ID = "e92-%LOOM_E92_MARK%-a^b";

async function spawnAndCaptureArgv(sessionId) {
  const host = new PtyHost(events);
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, "cwd-"));
  const argvOutputFile = path.join(tmpHome, `argv-${fs.readdirSync(tmpHome).length}.json`);
  const opts = {
    sessionId, cwd: spawnCwd, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: { LOOM_E92_MARK: MARK, FIXTURE_ENV_OUTPUT_FILE: path.join(tmpHome, `env-${path.basename(argvOutputFile)}`), FIXTURE_ARGV_OUTPUT_FILE: argvOutputFile },
    role: "worker", harness: "codex",
  };
  const pty = host.createCodexPty(opts);
  try {
    await waitUntil(() => fs.existsSync(argvOutputFile), { label: "fixture argv dump to appear" });
    return JSON.parse(fs.readFileSync(argvOutputFile, "utf8"));
  } finally {
    try { pty.kill(); } catch { /* best-effort */ }
  }
}

const argv = await spawnAndCaptureArgv(HOSTILE_ID);
const joined = argv.join("\n");
console.log(`[info] argv: ${JSON.stringify(argv)}`);
// Control: the hostile id really reaches argv (otherwise "literal" below would be vacuous).
check("[control] the hostile session id rides argv at all (in the mcp url override)", argv.some((t) => t.includes("e92-")));
check("a %VAR%-bearing argv element arrives LITERALLY (no cmd.exe expansion)", joined.includes("%LOOM_E92_MARK%"));
check("the child env value was NOT substituted into argv", !joined.includes(MARK));
check("a ^ in an argv element arrives intact (not stripped)", joined.includes("a^b"));

// Fail closed: a .cmd that is not a recognisable npm shim must throw, never run through cmd.exe.
{
  const bogus = path.join(tmpHome, "bogus-codex.cmd");
  fs.writeFileSync(bogus, "@echo off\r\necho not an npm cmd-shim\r\n");
  process.env.LOOM_CODEX_BIN = bogus;
  let threw = null;
  try { await spawnAndCaptureArgv("e92-bogus"); } catch (err) { threw = err; }
  check("an unparsable .cmd shim FAILS CLOSED (throws) rather than falling back to cmd.exe", threw instanceof Error && /not a recognisable npm cmd-shim/.test(threw.message));
  check("the failure names the shim path", !!threw?.message.includes(bogus));
  check("the failure names the remedy (install codex as an npm global; standard npm shim)", /npm global/.test(threw?.message ?? "") && /standard npm shim/.test(threw?.message ?? ""));

  // A refusal leaves NO side effects. (a) createCodexPty: the per-session scratch dir (created further down that
  // method than the shim resolution) must not exist. (b) the full spawn path (host.spawn -> spawnCodexProcess,
  // which writes <cwd>/AGENTS.md doctrine for a worker before it reaches createCodexPty) must not write it.
  const { sessionScratchDir } = await import("../dist/paths.js");
  check("[control] the scratch dir IS created by a successful createCodexPty (so its absence below is meaningful)", await (async () => {
    process.env.LOOM_CODEX_BIN = writeNpmCodexShim(fs.mkdtempSync(path.join(tmpHome, "ok-shim-")), FIXTURE_PATH);
    await spawnAndCaptureArgv("e92-ok-scratch");
    process.env.LOOM_CODEX_BIN = bogus;
    return fs.existsSync(sessionScratchDir("e92-ok-scratch"));
  })());
  check("a refused shim creates no per-session scratch dir (createCodexPty resolves before side effects)", !fs.existsSync(sessionScratchDir("e92-bogus")));

  // Positive control for the AGENTS.md absence check below: a SUCCESSFUL host.spawn into a separate cwd (same
  // role/harness) DOES write AGENTS.md, so "absent after a refusal" cannot pass vacuously.
  {
    process.env.LOOM_CODEX_BIN = writeNpmCodexShim(fs.mkdtempSync(path.join(tmpHome, "ok-shim2-")), FIXTURE_PATH);
    const okCwd = fs.mkdtempSync(path.join(tmpHome, "cwd-ok-"));
    const okHost = new PtyHost(events);
    try {
      okHost.spawn({ sessionId: "e92-ok-spawn", cwd: okCwd, permission: {}, geometry: { cols: 120, rows: 40 }, role: "worker", harness: "codex", sessionEnv: {} });
      check("[control] a successful host.spawn into a separate cwd DOES write AGENTS.md (so its absence below is meaningful)", fs.existsSync(path.join(okCwd, "AGENTS.md")));
    } catch (err) {
      check(`[control] successful host.spawn did not throw: ${err?.message ?? err}`, false);
    } finally {
      try { okHost.stop("e92-ok-spawn", "hard"); } catch { /* best-effort */ }
    }
    process.env.LOOM_CODEX_BIN = bogus;
  }

  const refusedCwd = fs.mkdtempSync(path.join(tmpHome, "cwd-refused-"));
  let spawnThrew = null;
  try {
    new PtyHost(events).spawn({ sessionId: "e92-bogus-spawn", cwd: refusedCwd, permission: {}, geometry: { cols: 120, rows: 40 }, role: "worker", harness: "codex", sessionEnv: {} });
  } catch (err) { spawnThrew = err; }
  check("host.spawn with a refused shim throws the same remedy error", spawnThrew instanceof Error && /standard npm shim/.test(spawnThrew.message));
  check("host.spawn with a refused shim writes NO AGENTS.md doctrine into the cwd", !fs.existsSync(path.join(refusedCwd, "AGENTS.md")));
}

finishAndExit(failures);
