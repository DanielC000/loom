import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3fdfc2d6 (C4) — pins that the profile `model` pin (opts.model) reaches the REAL argv of a codex spawn
// as an ADJACENT `-c model="<id>"` pair, for a fresh AND a `resume <uuid>` spawn, and that an unset or
// implausible pin adds nothing. Drives the REAL (unsubclassed) `PtyHost.createCodexPty()` against a fixture
// CLI that records its own argv (fixtures/env-dump-cli.mjs via LOOM_CODEX_BIN) — never the real codex, so
// no ~/.codex/config.toml touch and no acquireCodexRealSpawnLock(). Same technique as
// codex-update-check-spawn-argv.mjs. WINDOWS-ONLY (`.cmd` wrapper); SKIPS (exit 0) elsewhere.
//
// Run: 1) build, 2) node test/codex-model-pin-spawn-argv.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("WARN  SKIP  codex-model-pin-spawn-argv.mjs — the .cmd-wrapper fixture mechanism is Windows-only (mirrors codex-update-check-spawn-argv.mjs's accepted POSIX gap); the pure builder is still covered by codex-host-decisions.mjs.");
  process.exit(0);
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-dump-cli.mjs");
const tmpHome = mkdtempManaged("loom-codex-model-pin-argv-");
process.env.LOOM_HOME = tmpHome;
const wrapperPath = path.join(tmpHome, "fake-codex.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CODEX_BIN = wrapperPath;

const { PtyHost } = await import("../dist/pty/host.js");
const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };

async function spawnAndCaptureArgv(sessionId, optsOverlay) {
  const host = new PtyHost(events);
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, `cwd-${sessionId}-`));
  const argvOutputFile = path.join(tmpHome, `argv-${sessionId}.json`);
  const opts = {
    sessionId, cwd: spawnCwd, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: path.join(tmpHome, `env-${sessionId}.json`), FIXTURE_ARGV_OUTPUT_FILE: argvOutputFile },
    role: "worker", harness: "codex",
    ...optsOverlay,
  };
  const pty = host.createCodexPty(opts);
  try {
    await waitUntil(() => fs.existsSync(argvOutputFile), { label: `${sessionId} fixture's argv dump file to appear` });
    return JSON.parse(fs.readFileSync(argvOutputFile, "utf8"));
  } finally {
    try { pty.kill(); } catch { /* best-effort */ }
  }
}

/** Every value that follows a `-c` token whose value starts with `model` (adjacent pairs only). */
const modelOverrides = (argv) => argv.flatMap((t, i) => (t === "-c" && /^model\s*=/.test(argv[i + 1] ?? "") ? [argv[i + 1]] : []));

const RESUME_ID = "11111111-1111-1111-1111-111111111111";

const fresh = await spawnAndCaptureArgv("codex-model-fresh", { model: "gpt-5-codex" });
console.log(`[info] fresh argv: ${JSON.stringify(fresh)}`);
check('fresh spawn carries exactly one adjacent -c model="gpt-5-codex" pair', JSON.stringify(modelOverrides(fresh)) === JSON.stringify(['model="gpt-5-codex"']));

const resume = await spawnAndCaptureArgv("codex-model-resume", { model: "gpt-5-codex", resumeId: RESUME_ID });
console.log(`[info] resume argv: ${JSON.stringify(resume)}`);
check("resume spawn still leads with `resume <uuid>` (the subcommand)", resume[0] === "resume" && resume[1] === RESUME_ID);
check('resume spawn carries the -c model="gpt-5-codex" pair AFTER the subcommand', JSON.stringify(modelOverrides(resume)) === JSON.stringify(['model="gpt-5-codex"']) && resume.indexOf('model="gpt-5-codex"') > 1);

const unset = await spawnAndCaptureArgv("codex-model-unset", {});
check("an unset pin adds NO model override (argv byte-identical to pre-change)", modelOverrides(unset).length === 0);

const evil = await spawnAndCaptureArgv("codex-model-evil", { model: 'x" -s danger-full-access' });
console.log(`[info] evil-pin argv: ${JSON.stringify(evil)}`);
check("an argv/TOML-injection-shaped pin is dropped, never passed through", modelOverrides(evil).length === 0 && !evil.includes("danger-full-access") && !evil.some((t) => t.includes("danger-full-access")));

// negative control: the extractor must be able to report a pair when one exists / nothing when not adjacent.
check("[negative control] modelOverrides finds nothing when `model=` is not preceded by -c", modelOverrides(["-a", "never", 'model="x"']).length === 0);

console.log(failures === 0 ? "\n✅ ALL PASS — profile model pin reaches codex's real argv (fresh + resume), unset adds nothing, injection-shaped pin dropped." : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
