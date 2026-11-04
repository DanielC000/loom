import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Fix round on card b7d6b7f3, ask 1 — pin the REAL createPty CALL SITE (pty/host.ts ~:9064:
// `disallowedToolsForSpawn(opts.role, opts.restrictedTools, !!mcpServers.codescape, !!mcpServers.playwright,
// !!mcpServers["image-gen"])`), not just the pure `disallowedToolsForSpawn` function in isolation.
//
// image-gen-capability.mjs's (disallow)/(e2e-disallow) sections already prove the FUNCTION is correct and
// that a HAND-BUILT buildSpawnArgs call threads the flag — but neither ever executes the real `createPty`
// method body, so a mutant at the call site itself (passing a literal `false` instead of
// `!!mcpServers["image-gen"]`, keeping the function's own API unchanged) is INVISIBLE to that file. This
// file drives the REAL (unsubclassed) `PtyHost.createPty()` end to end against a fixture CLI substituted
// via `LOOM_CLAUDE_BIN` (mirrors pty-claude-spawn-env.mjs / codex-model-pin-spawn-argv.mjs's own
// `env-dump-cli.mjs` + argv-capture technique) — never the real claude, so no real spawn hazard.
//
// Proves:
//   (1) image-gen GRANTED (role=worker): the REAL spawn argv carries `mcp__image-gen__generate_video`
//       between `--disallowedTools` and `--strict-mcp-config`, AND the real `--mcp-config` file the same
//       spawn wrote actually mounts an "image-gen" key — so this is proven against what `createPty`
//       itself computed, not a hand-constructed stand-in.
//   (2) image-gen NOT granted (role=worker): the SAME real spawn path never emits generate_video, and the
//       mcp-config file carries no "image-gen" key — byte-identical-off, proven on the real path too.
//   (3) image-gen GRANTED (role=manager): the call site's `!!mcpServers["image-gen"]` is unconditional on
//       role — a manager-role spawn gets the SAME removal (card b7d6b7f3's triage note: "manager/platform
//       get generate_video REMOVED via --disallowedTools").
//
// @decision b7d6b7f3 — never use `negative-control --ref <sha>` for this mutant: no real ref carries the
// current 5-arg signature + export, so reverting the whole file fails this file's own `import` (a
// structural red, not the behavioral one under test) — hand-edit the call site's literal instead.
//
// WINDOWS-ONLY (`.cmd` wrapper, mirrors pty-claude-spawn-env.mjs's own accepted POSIX gap). SKIPS (exit 0).
//
// Run: 1) build (turbo builds shared first), 2) node test/image-gen-disallow-createpty-chokepoint.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("WARN  SKIP  image-gen-disallow-createpty-chokepoint.mjs — the .cmd-wrapper fixture mechanism is Windows-only (mirrors pty-claude-spawn-env.mjs's own accepted POSIX gap); the pure disallowedToolsForSpawn/buildSpawnArgs builders stay covered by image-gen-capability.mjs on every platform.");
  process.exit(0);
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-dump-cli.mjs");
const tmpHome = mkdtempManaged("loom-ig-chokepoint-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_PROJECT_WORK_ROOT;
delete process.env.LOOM_PROJECT_WORK_DIR;
requireHermeticEnv();
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const wrapperPath = path.join(tmpHome, "fake-claude.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CLAUDE_BIN = wrapperPath;

const { PtyHost } = await import("../dist/pty/host.js");
const { ensureDirs } = await import("../dist/paths.js");
ensureDirs();

// A fixture image-gen catalog row, resolved via the GENERIC `resolveCapabilityServer` dispatch exactly
// like image-gen-capability.mjs's own `igRowFixture` — "bundled" kind pointed at a trivial, never-actually-
// executed command (we only need resolveCapabilityServer to return non-null so the real "image-gen" key
// appears in createPty's own `mcpServers` map; the resolved server is never spawned by this file).
const igRowFixture = {
  id: "cap-ig-chokepoint", slug: "image-gen", name: "Image Gen (fixture)", description: "",
  transport: "stdio", kind: "bundled",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: ["--version"] }),
  toolAllowlistJson: JSON.stringify(["mcp__image-gen__generate_image"]),
  wantsScratchDir: false, requiresConnection: true, secretEnvVar: "GEMINI_API_KEY", passEnv: [],
  createdAt: new Date().toISOString(),
};
const STUB_KEY = "AIzaSTUB-chokepoint-do-not-leak";

const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };

function makeHost(withImageGen) {
  return new PtyHost(events, {
    getCapabilityCatalog: () => (withImageGen ? [igRowFixture] : []),
    resolveConnectionSecret: () => STUB_KEY,
  });
}

/** Drives the REAL createPty() to a real spawned fixture child; returns {argv, mcpConfig}. */
async function spawnAndCapture(sessionId, { role, withImageGen }) {
  const host = makeHost(withImageGen);
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, `cwd-${sessionId}-`));
  const argvOutputFile = path.join(tmpHome, `argv-${sessionId}.json`);
  const envOutputFile = path.join(tmpHome, `env-${sessionId}.json`);
  const opts = {
    sessionId, cwd: spawnCwd, role,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 },
    sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: envOutputFile, FIXTURE_ARGV_OUTPUT_FILE: argvOutputFile },
    capabilities: withImageGen ? [{ slug: "image-gen", connectionId: "conn-ig-chokepoint" }] : [],
  };
  const pty = host.createPty(opts);
  try {
    await waitUntil(() => fs.existsSync(argvOutputFile), { label: `${sessionId} fixture's argv dump file to appear` });
    const argv = JSON.parse(fs.readFileSync(argvOutputFile, "utf8"));
    const mcpConfigIdx = argv.indexOf("--mcp-config");
    const mcpConfigPath = mcpConfigIdx !== -1 ? argv[mcpConfigIdx + 1] : null;
    const mcpConfig = mcpConfigPath && fs.existsSync(mcpConfigPath) ? JSON.parse(fs.readFileSync(mcpConfigPath, "utf8")) : null;
    return { argv, mcpConfig };
  } finally {
    try { pty.kill(); } catch { /* best-effort */ }
  }
}

function assertDisallowBetweenFlags(argv, label) {
  const d = argv.indexOf("--disallowedTools");
  const strict = argv.indexOf("--strict-mcp-config");
  check(`${label}: --disallowedTools present and precedes --strict-mcp-config`, d !== -1 && strict !== -1 && d < strict);
  const videoIdx = argv.indexOf("mcp__image-gen__generate_video");
  check(`${label}: generate_video (if present) sits between --disallowedTools and --strict-mcp-config`,
    videoIdx === -1 || (videoIdx > d && videoIdx < strict));
}

// ===================== (1) image-gen GRANTED, role=worker =====================
{
  const { argv, mcpConfig } = await spawnAndCapture("ig-worker-on", { role: "worker", withImageGen: true });
  assertDisallowBetweenFlags(argv, "(1 worker+image-gen)");
  check("(1 worker+image-gen) REAL createPty argv includes generate_video in --disallowedTools",
    argv.includes("mcp__image-gen__generate_video"));
  check("(1 worker+image-gen) the REAL mcp-config this spawn wrote actually mounts an 'image-gen' server",
    !!mcpConfig?.mcpServers?.["image-gen"]);
}

// ===================== (2) image-gen NOT granted, role=worker (byte-identical-off on the real path) =====================
{
  const { argv, mcpConfig } = await spawnAndCapture("ig-worker-off", { role: "worker", withImageGen: false });
  assertDisallowBetweenFlags(argv, "(2 worker, no image-gen)");
  check("(2 worker, no image-gen) REAL createPty argv does NOT include generate_video",
    !argv.includes("mcp__image-gen__generate_video"));
  check("(2 worker, no image-gen) the REAL mcp-config carries no 'image-gen' key",
    !mcpConfig?.mcpServers?.["image-gen"]);
}

// ===================== (3) image-gen GRANTED, role=manager — the call site is role-unconditional =====================
{
  const { argv, mcpConfig } = await spawnAndCapture("ig-manager-on", { role: "manager", withImageGen: true });
  assertDisallowBetweenFlags(argv, "(3 manager+image-gen)");
  check("(3 manager+image-gen) REAL createPty argv includes generate_video in --disallowedTools too (role-unconditional union)",
    argv.includes("mcp__image-gen__generate_video"));
  check("(3 manager+image-gen) the REAL mcp-config this spawn wrote actually mounts an 'image-gen' server",
    !!mcpConfig?.mcpServers?.["image-gen"]);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card b7d6b7f3 fix-round ask 1: the REAL createPty() call site (pty/host.ts ~:9064) threads `!!mcpServers[\"image-gen\"]` into disallowedToolsForSpawn correctly — proven end to end through a real spawn of a fixture claude substitute (never a hand-built buildSpawnArgs call), for a granted worker spawn (generate_video removed), an ungranted worker spawn (byte-identical off), and a granted manager spawn (role-unconditional) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
