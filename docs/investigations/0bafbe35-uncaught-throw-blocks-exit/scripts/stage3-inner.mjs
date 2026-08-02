// Card 0bafbe35, Stage 3 (INNER — run only via stage3-outer.mjs, never directly). A FAITHFUL COPY of
// packages/daemon/test/kickoff-real-spawn.mjs — every scenario, every check(), unchanged — with EXACTLY
// ONE injected difference: FIXTURE_DEBOUNCE_MS is forced to 150000ms ONLY when role === "manager",
// matching the ordinal position (role #2 of 6) both real card instances failed at. Every other role runs
// at the real file's own default (250ms). Only other adaptation: imports rewritten to absolute file://
// URLs derived from this script's own location (this file lives in docs/investigations/, not
// packages/daemon/test/, so the original relative imports would not resolve) and REPO_ROOT/FIXTURE_PATH
// derived the same way instead of from the original file's import.meta.url. No other logic, comment, or
// check differs from the real file as of this investigation (2026-08-01).
// HOW TO RUN: never directly — stage3-outer.mjs spawns this as a raw child under the real
// TEST_TIMEOUT_MS=120000 ceiling and times it, exactly like scripts/test-daemon.mjs's own runOne().
// MEASURED RESULT (2026-08-01, gate_queue cap=2 activeCount=1 steady throughout — see findings.md):
//   status="timeout", durationMs=120047 (vs the card's own 120061ms/120171ms). Tail character-for-
//   character identical to the card's recorded "GIVE-UP RECOVERY after 4 Enter attempts..." line. A 4th
//   AttachConsole crash fired at real-manager's own spawn — recorded, not chased.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const FIXTURE_PATH = path.join(REPO_ROOT, "packages", "daemon", "test", "fixtures", "fake-claude-cli.mjs");
const { mkdtempManaged, registerForCleanup, finishAndExit } = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "daemon", "test", "_tmp-fixture.mjs")).href);
const { waitUntil } = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "daemon", "test", "_wait.mjs")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("SKIP  stage3-inner.mjs — win32-only, matching the real file's own guard.");
  process.exit(0);
}

const tmpHome = mkdtempManaged("loom-stage3-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const wrapperPath = path.join(tmpHome, "fake-claude.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CLAUDE_BIN = wrapperPath;
process.env.FIXTURE_DEBOUNCE_MS = "250"; // real file's own default — overridden per-role below only for "manager"

const { PtyHost, buildSpawnArgs, MODE_LOG_POLL_MS, MODE_LOG_MAX_ATTEMPTS, READY_FALLBACK_MS } = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "daemon", "dist", "pty", "host.js")).href);
const { ensureDirs, WORKTREES_DIR } = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "daemon", "dist", "paths.js")).href);
ensureDirs();
registerForCleanup(WORKTREES_DIR);

const KICKOFF_PRE_DELIVERY_FLOOR_MS = MODE_LOG_MAX_ATTEMPTS * MODE_LOG_POLL_MS;
const FIXTURE_READY_TIMEOUT_MS = Math.max(15000, READY_FALLBACK_MS);

const claudeMd = fs.readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
const workerSkill = fs.readFileSync(path.join(REPO_ROOT, ".claude", "skills", "worker", "SKILL.md"), "utf8");
console.log(`[measured] real CLAUDE.md=${claudeMd.length} chars, real worker SKILL.md=${workerSkill.length} chars`);

function realisticKickoff(role, targetSize) {
  const base = `[role:${role}] ${claudeMd.slice(0, 4000)}\n\n---\n\n${workerSkill.slice(0, 3000)}\n\n` +
    `Do the "${role}" task now — quote test: says "hi" and uses \`backticks\` and a lone backslash \\ here.`;
  if (!targetSize || base.length >= targetSize) return base;
  const filler = `${claudeMd}\n\n${workerSkill}\n\n`;
  let out = base;
  while (out.length < targetSize) out += filler.slice(0, targetSize - out.length);
  return out;
}

class RealFixtureHarness {
  constructor(host) { this.host = host; this.buffers = new Map(); }
  attach(sessionId) {
    let buf = "";
    const unsub = this.host.subscribe(sessionId, {
      onData: (chunk) => { buf += chunk.toString("utf8"); },
      onControl: () => {},
    });
    this.buffers.set(sessionId, () => buf);
    return unsub;
  }
  text(sessionId) { return this.buffers.get(sessionId)?.() ?? ""; }
}

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new PtyHost(events);
const harness = new RealFixtureHarness(host);
const stoppedSessions = new Set();

async function verifyRealDelivery(label, sessionId, role, kickoff) {
  // ===== THE ONE INJECTED DIFFERENCE FROM THE REAL FILE =====
  process.env.FIXTURE_DEBOUNCE_MS = role === "manager" ? "150000" : "250";
  console.log(`STAGE3-DEBOUNCE label=${label} role=${role} FIXTURE_DEBOUNCE_MS=${process.env.FIXTURE_DEBOUNCE_MS}`);
  // ============================================================
  const outputFile = path.join(tmpHome, `received-${sessionId}`);
  process.env.FIXTURE_OUTPUT_FILE = outputFile;
  const opts = {
    sessionId, cwd: tmpHome, startupPrompt: kickoff, role,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  };

  const reproArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers: {}, startupPrompt: kickoff });
  check(`${label} buildSpawnArgs never emits the kickoff into argv`, !reproArgs.includes(kickoff) && !reproArgs.includes("--"));

  const spawnStartedAt = performance.now();
  host.spawn(opts);
  harness.attach(sessionId);

  check(`${label} live.lastPrompt seeded synchronously at spawn(), before ready/submit ever ran`,
    host.live.get(sessionId)?.lastPrompt === kickoff);

  const readyWaitStartedAt = performance.now();
  try {
    await waitUntil(() => /FIXTURE_READY/.test(harness.text(sessionId)), { label: `${label} real fixture process signals FIXTURE_READY`, timeoutMs: FIXTURE_READY_TIMEOUT_MS });
  } finally {
    console.log(`   [measured ${label}] spawn()→FIXTURE_READY: ${Math.round(performance.now() - readyWaitStartedAt)}ms (budget ${FIXTURE_READY_TIMEOUT_MS}ms)`);
  }
  check(`${label} the real child process never reported an extra positional argv entry`, !/FIXTURE_FAIL/.test(harness.text(sessionId)));

  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });

  const deliveryTimeoutMs = KICKOFF_PRE_DELIVERY_FLOOR_MS + Math.max(15000, kickoff.length * 2);
  const deliveryWaitStartedAt = performance.now();
  try {
    await waitUntil(() => /FIXTURE_RECEIVED/.test(harness.text(sessionId)), { label: `${label} real fixture reports FIXTURE_RECEIVED`, timeoutMs: deliveryTimeoutMs });
  } finally {
    console.log(`   [measured ${label}] SessionStart→FIXTURE_RECEIVED: ${Math.round(performance.now() - deliveryWaitStartedAt)}ms (budget ${deliveryTimeoutMs}ms = ${KICKOFF_PRE_DELIVERY_FLOOR_MS}ms floor + ${Math.max(15000, kickoff.length * 2)}ms pacing, kickoff ${kickoff.length} chars)`);
  }
  console.log(`   [measured ${label}] spawn()→kickoff-landed (total): ${Math.round(performance.now() - spawnStartedAt)}ms (kickoff ${kickoff.length} chars)`);

  const receivedCount = (harness.text(sessionId).match(/FIXTURE_RECEIVED/g) || []).length;
  check(`${label} the kickoff was received exactly once (no duplicate delivery)`, receivedCount === 1);

  const receivedPath = `${outputFile}.1`;
  const fileExists = fs.existsSync(receivedPath);
  check(`${label} the fixture's output file was written`, fileExists);
  const receivedRaw = fileExists ? fs.readFileSync(receivedPath, "utf8") : "";
  const rawMatch = receivedRaw.includes(kickoff);
  if (!rawMatch) {
    let i = 0; while (i < Math.min(kickoff.length, receivedRaw.length) && kickoff[i] === receivedRaw[i]) i++;
    console.log(`   [debug ${label}] sent.length=${kickoff.length} received.length=${receivedRaw.length}`);
    console.log(`   [debug ${label}] first diff at index ${i}: sent=${JSON.stringify(kickoff.slice(Math.max(0, i - 20), i + 20))} received=${JSON.stringify(receivedRaw.slice(Math.max(0, i - 20), i + 20))}`);
  }
  check(`${label} the kickoff text arrived on the real child's real stdin, byte-for-byte intact (file compare)`, rawMatch);

  try { host.stop(sessionId, "hard"); } catch { /* best-effort cleanup */ }
  stoppedSessions.add(sessionId);
}

const ROLES = ["worker", "manager", "platform", "setup", "assistant", "auditor"];

try {
  for (const role of ROLES) {
    const sessionId = `real-${role}`;
    await verifyRealDelivery(`[${role}]`, sessionId, role, realisticKickoff(role));
  }

  for (const targetSize of [10_000, 40_000]) {
    const sessionId = `real-large-${targetSize}`;
    const kickoff = realisticKickoff("worker", targetSize);
    check(`[large ${targetSize}] fixture is actually built to the target scale`, kickoff.length >= targetSize);
    await verifyRealDelivery(`[large ${targetSize}]`, sessionId, "worker", kickoff);
  }

  {
    process.env.FIXTURE_READY_DELAY_MS = "2000";
    try {
      await verifyRealDelivery("[late-ready]", "real-late-ready", "worker", realisticKickoff("worker"));
    } finally {
      delete process.env.FIXTURE_READY_DELAY_MS;
    }
  }
} finally {
  const allSessionIds = [...ROLES.map((role) => `real-${role}`), ...[10_000, 40_000].map((n) => `real-large-${n}`), "real-late-ready"];
  for (const sessionId of allSessionIds) {
    if (stoppedSessions.has(sessionId)) continue;
    try { host.stop(sessionId, "hard"); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? `\nALL PASS (unexpected — the forced stall at [manager] should have thrown before this line)`
  : `\nFAILURE(S)=${failures}`);
await finishAndExit(failures === 0 ? 0 : 1);
