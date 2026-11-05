import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d1614667 — the codex `--version` prewarm (pty/codex-doctrine.ts#prewarmCodexVersionAsync) must (1) launch
// a Windows `.cmd` npm shim as node + its real entry with NO shell in the child's ancestry, and a timeout must
// kill that REAL child; (2) run under the same OPENAI_* scrub a codex session gets (CODEX_HOME flows; the
// human-only LOOM_PASS_OPENAI_ENV=1 hatch forwards); (3) fail closed on an unparsable shim, logging and leaving
// the cache unset (never throwing, never falling back to cmd.exe).
//
// The launch cases drive a REAL child via the shared npm-shim fixture (test/_codex-npm-shim.mjs) and a stub CLI
// (fixtures/version-probe-cli.mjs) — never the real codex. The pure env-builder cases run on every OS; the
// shim cases are WINDOWS-ONLY (a `.cmd` shim is a Windows mechanism) and print a WARN SKIP elsewhere.
//
// Run: 1) build, 2) node test/codex-version-prewarm-launch.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useOwnLoomHome, mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { waitUntil } from "./_wait.mjs";
import { writeNpmCodexShim } from "./_codex-npm-shim.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = useOwnLoomHome("cvp-");
requireHermeticEnv();
const codexHome = mkdtempManaged("cvp-codexhome-");
process.env.CODEX_HOME = codexHome;
delete process.env.LOOM_PASS_OPENAI_ENV;

let importN = 0;
// Fresh module instance per scenario (the version cache is module-level and early-returns once warm).
const freshDoctrine = () => import(`../dist/pty/codex-doctrine.js?s=${++importN}`);

// ── pure env builder (every OS) ───────────────────────────────────────────────────────────────────────────
{
  const { buildCodexVersionProbeEnv } = await freshDoctrine();
  const raw = { OPENAI_API_KEY: "sk-canary", openai_base_url: "http://x", CODEX_API_KEY: "c", CODEX_ACCESS_TOKEN: "t", CODEX_HOME: "/h", PATH: "/p" };
  const scrubbed = buildCodexVersionProbeEnv(raw);
  check("env builder drops OPENAI_* (any case), CODEX_API_KEY and CODEX_ACCESS_TOKEN", !("OPENAI_API_KEY" in scrubbed) && !("openai_base_url" in scrubbed) && !("CODEX_API_KEY" in scrubbed) && !("CODEX_ACCESS_TOKEN" in scrubbed));
  check("env builder keeps CODEX_HOME and unrelated vars", scrubbed.CODEX_HOME === "/h" && scrubbed.PATH === "/p");
  process.env.LOOM_PASS_OPENAI_ENV = "1";
  const passed = buildCodexVersionProbeEnv(raw);
  delete process.env.LOOM_PASS_OPENAI_ENV;
  check("[control] LOOM_PASS_OPENAI_ENV=1 forwards the canary (so the scrub above is not vacuous)", passed.OPENAI_API_KEY === "sk-canary");
}

// ── ENOENT (codex not installed) is SILENT — every OS. Control: a bogus-but-present failure still logs (cases C/E). ──
{
  process.env.LOOM_CODEX_BIN = path.join(tmpHome, "definitely-not-installed", "codex");
  const { prewarmCodexVersionAsync, getCachedCodexVersion } = await freshDoctrine();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); };
  try {
    prewarmCodexVersionAsync();
    // Anchor on the exec callback having run: poll for ENOENT-free settle via a spawn of the same missing path.
    await new Promise((resolve) => import("node:child_process").then(({ execFile }) => execFile(process.env.LOOM_CODEX_BIN, ["--version"], () => resolve())));
    await new Promise((r) => setImmediate(r));
  } finally { console.warn = origWarn; }
  check("ENOENT (codex not installed) logs NOTHING", warns.length === 0);
  check("ENOENT leaves the cache unset", getCachedCodexVersion() === null);
  delete process.env.LOOM_CODEX_BIN;
}

if (process.platform !== "win32") {
  console.log("WARN  SKIP  codex-version-prewarm-launch.mjs (shim cases) — the .cmd-shim mechanism is Windows-only; off win32 winCmdShimSpawnTarget is a passthrough.");
  finishAndExit(failures);
} else {
  const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "version-probe-cli.mjs");
  const scratch = mkdtempManaged("cvp-scratch-");
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

  process.env.OPENAI_API_KEY = "sk-canary-d1614667";
  process.env.OPENAI_BASE_URL = "http://canary.invalid";
  process.env.CODEX_API_KEY = "canary-codex-key";

  // ── A: launch + env, scrub mode ───────────────────────────────────────────────────────────────────────
  {
    const out = path.join(scratch, "probe-a.json");
    process.env.FIXTURE_PROBE_OUT = out;
    process.env.LOOM_CODEX_BIN = writeNpmCodexShim(fs.mkdtempSync(path.join(tmpHome, "shim-a-")), FIXTURE_PATH);
    const { prewarmCodexVersionAsync, getCachedCodexVersion } = await freshDoctrine();
    prewarmCodexVersionAsync();
    await waitUntil(() => getCachedCodexVersion() !== null, { timeoutMs: 8000, label: "version cache populated via shim" });
    const rec = JSON.parse(fs.readFileSync(out, "utf8"));
    check("version parsed from the real child's stdout", getCachedCodexVersion() === "7.7.7");
    check("the child received argv [--version] literally", rec.argv.length === 1 && rec.argv[0] === "--version");
    check("the child's parent is THIS process (no cmd.exe/shell in the ancestry)", rec.ppid === process.pid);
    check("OPENAI_API_KEY / OPENAI_BASE_URL / CODEX_API_KEY canaries are ABSENT from the child's env", !("OPENAI_API_KEY" in rec.env) && !("OPENAI_BASE_URL" in rec.env) && !("CODEX_API_KEY" in rec.env));
    check("CODEX_HOME is PRESENT in the child's env", rec.env.CODEX_HOME === codexHome);
  }

  // ── B: hatch forwards ─────────────────────────────────────────────────────────────────────────────────
  {
    const out = path.join(scratch, "probe-b.json");
    process.env.FIXTURE_PROBE_OUT = out;
    process.env.LOOM_PASS_OPENAI_ENV = "1";
    const { prewarmCodexVersionAsync, getCachedCodexVersion } = await freshDoctrine();
    prewarmCodexVersionAsync();
    await waitUntil(() => getCachedCodexVersion() !== null, { timeoutMs: 8000, label: "version cache populated (hatch)" });
    delete process.env.LOOM_PASS_OPENAI_ENV;
    const rec = JSON.parse(fs.readFileSync(out, "utf8"));
    check("[control] with LOOM_PASS_OPENAI_ENV=1 the canary DOES reach the child (scrub in A is discriminating)", rec.env.OPENAI_API_KEY === "sk-canary-d1614667");
  }

  // ── C: timeout kills the REAL child ───────────────────────────────────────────────────────────────────
  {
    const pidFile = path.join(scratch, "hang.pid");
    process.env.FIXTURE_PROBE_HANG = "1";
    process.env.FIXTURE_PROBE_PID_FILE = pidFile;
    const { prewarmCodexVersionAsync, getCachedCodexVersion } = await freshDoctrine();
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warns.push(a.join(" ")); };
    prewarmCodexVersionAsync();
    let pid = null;
    try {
      await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").length > 0, { timeoutMs: 8000, label: "hanging child wrote its pid" });
      pid = Number(fs.readFileSync(pidFile, "utf8"));
      check("[control] the hanging child is alive before the timeout", isAlive(pid));
      // The prewarm's 8s timeout fires and its callback logs the failure; anchor on that observable event.
      await waitUntil(() => warns.some((w) => /codex version prewarm failed/.test(w)), { timeoutMs: 15000, label: "prewarm timeout logged" });
      check("a timeout still LOGS (real failure, not ENOENT) with killed in the bounded line", warns.some((w) => /prewarm failed/.test(w) && /killed/.test(w)));
      await waitUntil(() => !isAlive(pid), { timeoutMs: 5000, label: "hanging child gone after timeout" });
      check("the timeout killed the REAL child process (captured pid no longer alive)", !isAlive(pid));
    } finally {
      console.warn = origWarn;
      // Leak guard: kill ONLY the captured pid if a RED run left it alive.
      if (pid && isAlive(pid)) { try { process.kill(pid); } catch { /* already gone */ } }
    }
    check("a timed-out prewarm leaves the cache unset", getCachedCodexVersion() === null);
    delete process.env.FIXTURE_PROBE_HANG;
  }

  // ── D: unparsable shim fails closed — logs, no throw, cache unset ─────────────────────────────────────
  {
    const bogus = path.join(tmpHome, "bogus-codex.cmd");
    fs.writeFileSync(bogus, "@echo off\r\necho not an npm cmd-shim\r\n");
    process.env.LOOM_CODEX_BIN = bogus;
    const { prewarmCodexVersionAsync, getCachedCodexVersion } = await freshDoctrine();
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warns.push(a.join(" ")); };
    let threw = null;
    try { prewarmCodexVersionAsync(); } catch (e) { threw = e; } finally { console.warn = origWarn; }
    check("an unparsable shim does NOT throw out of the best-effort prewarm", threw === null);
    check("it logs the fail-closed remedy (standard npm shim)", warns.some((w) => /codex version prewarm failed/.test(w) && /standard npm shim/.test(w)));
    check("the cache stays unset", getCachedCodexVersion() === null);
  }

  // ── E: a non-zero exit is a REAL failure — still logs, bounded to one line (no stderr / command line) ───
  {
    process.env.FIXTURE_PROBE_EXIT = "3";
    process.env.LOOM_CODEX_BIN = writeNpmCodexShim(fs.mkdtempSync(path.join(tmpHome, "shim-e-")), FIXTURE_PATH);
    const { prewarmCodexVersionAsync, getCachedCodexVersion } = await freshDoctrine();
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warns.push(a.join(" ")); };
    try {
      prewarmCodexVersionAsync();
      await waitUntil(() => warns.some((w) => /codex version prewarm failed/.test(w)), { timeoutMs: 8000, label: "non-zero exit logged" });
    } finally { console.warn = origWarn; delete process.env.FIXTURE_PROBE_EXIT; }
    const line = warns.find((w) => /prewarm failed/.test(w)) ?? "";
    check("non-zero exit still LOGS the failure (not silenced like ENOENT)", line.length > 0);
    check("the log line is bounded: no child stderr line 2, no multi-line dump", !/SECRET-LINE-2/.test(line) && !/\n/.test(line));
    check("the log line carries the err.code", /code=3/.test(line));
    check("cache stays unset after a failed exit", getCachedCodexVersion() === null);
  }

  finishAndExit(failures);
}
