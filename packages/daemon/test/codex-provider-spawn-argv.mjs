import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2ef54430 — pins, at the REAL spawn level, that `createCodexPty` appends the pinned provider's argv
// (the model_provider / model_providers.<id>.* overrides AND the shell_environment_policy.exclude pin) and puts
// the Connection's secret ONLY into the child's env under the fixed var. Drives the REAL (unsubclassed)
// `PtyHost.createCodexPty()` against a fixture CLI that records its own argv + env (fixtures/env-dump-cli.mjs
// via LOOM_CODEX_BIN) — never the real codex, so no ~/.codex touch. Same technique as
// codex-model-pin-spawn-argv.mjs. WINDOWS-ONLY (`.cmd` wrapper); SKIPS (exit 0) elsewhere.
//
// Run: 1) build, 2) node test/codex-provider-spawn-argv.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("WARN  SKIP  codex-provider-spawn-argv.mjs — the .cmd-wrapper fixture mechanism is Windows-only (mirrors codex-model-pin-spawn-argv.mjs's accepted POSIX gap); the pure builder + applyCodexProvider contract are covered by profile-codex-provider.mjs");
  process.exit(0);
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-dump-cli.mjs");
const tmpHome = mkdtempManaged("loom-codex-provider-argv-");
process.env.LOOM_HOME = tmpHome;
const wrapperPath = path.join(tmpHome, "fake-codex.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CODEX_BIN = wrapperPath;
delete process.env.LOOM_PASS_ANTHROPIC_ENV;
// An AMBIENT copy of the key var on the daemon's own env must never reach a child (buildSpawnEnv scrub).
const AMBIENT = "ambient-DO-NOT-FORWARD";
process.env.LOOM_CODEX_PROVIDER_KEY = AMBIENT;

const { PtyHost } = await import("../dist/pty/host.js");
const { CODEX_PROVIDER_KEY_ENV_VAR } = await import("../dist/profiles/codex-provider.js");
const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };

const SECRET = "dummy-secret-from-connection";
const custom = { id: "myhost", baseUrl: "https://api.example.com/v1", connectionId: "c1" };

async function spawnAndCapture(sessionId, pin) {
  const host = new PtyHost(events, {
    getCodexProvider: () => pin,
    resolveConnectionSecret: (cid) => (cid === "c1" ? SECRET : undefined),
    getConnectionForBinding: (cid) => (cid === "c1" ? { host: "api.example.com", authScheme: "api-key" } : undefined),
  });
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, `cwd-${sessionId}-`));
  const argvOutputFile = path.join(tmpHome, `argv-${sessionId}.json`);
  const envOutputFile = path.join(tmpHome, `env-${sessionId}.json`);
  const opts = {
    sessionId, projectId: "proj", cwd: spawnCwd, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: envOutputFile, FIXTURE_ARGV_OUTPUT_FILE: argvOutputFile },
    role: "worker", harness: "codex",
  };
  const pty = host.createCodexPty(opts);
  try {
    await waitUntil(() => fs.existsSync(argvOutputFile) && fs.existsSync(envOutputFile), { label: `${sessionId} fixture dumps to appear` });
    return { argv: JSON.parse(fs.readFileSync(argvOutputFile, "utf8")), env: JSON.parse(fs.readFileSync(envOutputFile, "utf8")) };
  } finally {
    try { pty.kill(); } catch { /* best-effort */ }
  }
}

const cOverrides = (argv) => argv.flatMap((t, i) => (t === "-c" ? [argv[i + 1]] : []));

const c = await spawnAndCapture("prov-custom", custom);
const ov = cOverrides(c.argv);
console.log(`[info] custom argv: ${JSON.stringify(c.argv)}`);
check("custom: the REAL argv carries the model_provider override", ov.includes('model_provider="myhost"'));
check("custom: the REAL argv carries base_url / env_key / wire_api overrides",
  ov.includes('model_providers.myhost.base_url="https://api.example.com/v1"') && ov.includes(`model_providers.myhost.env_key="${CODEX_PROVIDER_KEY_ENV_VAR}"`) && ov.includes('model_providers.myhost.wire_api="responses"'));
check("custom: the REAL argv pins shell_environment_policy.exclude to the key var", ov.includes(`shell_environment_policy.exclude=["${CODEX_PROVIDER_KEY_ENV_VAR}"]`));
check("custom: the child env carries the Connection secret under the fixed var", c.env[CODEX_PROVIDER_KEY_ENV_VAR] === SECRET);
check("custom: the secret appears in NO argv element", c.argv.every((t) => !t.includes(SECRET)));

const b = await spawnAndCapture("prov-builtin", { id: "ollama" });
check("built-in: argv carries model_provider and NOTHING else provider-related", JSON.stringify(cOverrides(b.argv).filter((x) => /^model_provider|^shell_environment_policy/.test(x))) === JSON.stringify(['model_provider="ollama"']));
check("built-in: the AMBIENT key var on the daemon env is scrubbed from the child (and no secret is injected)", !(CODEX_PROVIDER_KEY_ENV_VAR in b.env));

const n = await spawnAndCapture("prov-none", undefined);
check("no pin: no provider/policy override at all (argv byte-identical to before)", cOverrides(n.argv).filter((x) => /^model_provider|^shell_environment_policy/.test(x)).length === 0);
check("no pin: the AMBIENT key var is scrubbed from the child env", !(CODEX_PROVIDER_KEY_ENV_VAR in n.env) && !JSON.stringify(n.env).includes(AMBIENT));

// A stored value that BYPASSED the validator (hand-edited row) carrying a cmd.exe %VAR% must be refused at spawn:
// applyCodexProvider re-validates shape, and codex is launched via the .cmd shim where cmd.exe would expand it.
{
  const host = new PtyHost(events, {
    getCodexProvider: () => ({ ...custom, baseUrl: "https://api.example.com/v1/%LOOM_CODEX_PROVIDER_KEY%" }),
    resolveConnectionSecret: () => SECRET,
    getConnectionForBinding: () => ({ host: "api.example.com", authScheme: "api-key" }),
  });
  const argvFile = path.join(tmpHome, "argv-prov-percent.json");
  let threw = null; let pty = null;
  try {
    pty = host.createCodexPty({ sessionId: "prov-percent", projectId: "proj", cwd: fs.mkdtempSync(path.join(tmpHome, "cwd-pct-")), permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: path.join(tmpHome, "env-prov-percent.json"), FIXTURE_ARGV_OUTPUT_FILE: argvFile }, role: "worker", harness: "codex" });
  } catch (e) { threw = e; }
  try { pty?.kill(); } catch { /* best-effort */ }
  check("a stored %-bearing baseUrl (written past the validator) is REFUSED at spawn, no process launched", !!threw && /refusing to fall back/.test(threw.message) && !fs.existsSync(argvFile) && pty === null);
  check("... and the refusal text carries no secret", !!threw && !threw.message.includes(SECRET));
}

// negative control: the extractor reports nothing when `-c` does not precede the value.
check("[negative control] cOverrides ignores a value not preceded by -c", cOverrides(["-a", 'model_provider="x"']).length === 0);

console.log(failures === 0 ? "\n✅ ALL PASS — createCodexPty appends the provider argv + env-policy pin, injects the secret into env only, and scrubs an ambient key var." : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
