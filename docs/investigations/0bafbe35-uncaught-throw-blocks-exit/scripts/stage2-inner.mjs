// Card 0bafbe35, Stage 2 (INNER — run only via stage2-outer.mjs, never directly). WHAT IT FORCES:
// mirrors kickoff-real-spawn.mjs's own structure closely (same _tmp-fixture.mjs helpers, same lack of a
// top-level catch around the FIXTURE_RECEIVED waitUntil) but simplified to ONE role, with
// FIXTURE_DEBOUNCE_MS forced to 150000ms — past waitUntil's own grace deadline (budget 19000ms + grace
// min(19000x4,120000)=76000ms = 95000ms) — so the wait deterministically hits its "ABSENT" throw (never
// the fixture-timing-dependent "ARRIVED LATE" branch) at a known, fixed elapsed time. Question: does the
// child process actually exit promptly after that uncaught throw, or does something keep it alive?
// HOW TO RUN: never directly — stage2-outer.mjs spawns this as a raw child and times its exit.
// MEASURED RESULT (2026-08-01, gate_queue cap=2 activeCount 0->1 across the run — see findings.md):
//   Throw fired at +95248.5ms (matches the math). host.stop(...,"hard") in the outer-finally: 11.91ms
//   (fast — weakens, does not refute, the node-pty-kill-may-block synthesis). The process did NOT exit
//   on its own: msFromThrowMarkerToExit=34656.3ms is a LOWER BOUND (the outer harness force-killed it at
//   its own 130s bound; no natural exit was ever observed). A 3rd AttachConsole crash fired here too —
//   single spawn + single stop, no concurrency at all — recorded, not chased.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const { mkdtempManaged, registerForCleanup, finishAndExit } = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "daemon", "test", "_tmp-fixture.mjs")).href);
const { waitUntil } = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "daemon", "test", "_wait.mjs")).href);

const FIXTURE_PATH = path.join(REPO_ROOT, "packages", "daemon", "test", "fixtures", "fake-claude-cli.mjs");

const tmpHome = mkdtempManaged("loom-stage2-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const wrapperPath = path.join(tmpHome, "fake-claude.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CLAUDE_BIN = wrapperPath;
// Forced FAR past waitUntil's own grace deadline (budget 19000ms + grace min(19000*4,120000)=76000ms =
// 95000ms) so the fixture NEVER flushes within the observed window — deterministic "ABSENT" throw, not
// the fixture-timing-dependent "ARRIVED LATE" branch.
process.env.FIXTURE_DEBOUNCE_MS = "150000";

const { PtyHost } = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "daemon", "dist", "pty", "host.js")).href);
const { ensureDirs, WORKTREES_DIR } = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "daemon", "dist", "paths.js")).href);
ensureDirs();
registerForCleanup(WORKTREES_DIR);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

class RealFixtureHarness {
  constructor(host) { this.host = host; this.buffers = new Map(); }
  attach(sessionId) {
    let buf = "";
    const unsub = this.host.subscribe(sessionId, { onData: (chunk) => { buf += chunk.toString("utf8"); }, onControl: () => {} });
    this.buffers.set(sessionId, () => buf);
    return unsub;
  }
  text(sessionId) { return this.buffers.get(sessionId)?.() ?? ""; }
}

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new PtyHost(events);
const harness = new RealFixtureHarness(host);
const stoppedSessions = new Set();

// Instrumentation: wrap every host.stop("hard") call with performance.now() before/after — tests the
// node-pty-kill-may-block synthesis (MINE, UNESTABLISHED — not the daemon's own claim).
function timedStop(sessionId, label) {
  const before = performance.now();
  console.log(`STAGE2-STOP-START label=${label} sessionId=${sessionId} atMs=${before.toFixed(1)}`);
  try { host.stop(sessionId, "hard"); } catch (e) { console.log(`STAGE2-STOP-THREW label=${label} err=${e?.message}`); }
  const after = performance.now();
  console.log(`STAGE2-STOP-END label=${label} sessionId=${sessionId} atMs=${after.toFixed(1)} durationMs=${(after - before).toFixed(2)}`);
  stoppedSessions.add(sessionId);
}

const claudeMd = fs.readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
function kickoffText() { return `[role:worker] ${claudeMd.slice(0, 4000)}\n\nDo the "worker" task now.`; }

const KICKOFF_PRE_DELIVERY_FLOOR_MS = 8 * 500; // MODE_LOG_MAX_ATTEMPTS * MODE_LOG_POLL_MS, mirrored (kept self-contained rather than re-imported)

async function verifyRealDelivery(label, sessionId, kickoff) {
  const outputFile = path.join(tmpHome, `received-${sessionId}`);
  process.env.FIXTURE_OUTPUT_FILE = outputFile;
  const opts = {
    sessionId, cwd: tmpHome, startupPrompt: kickoff, role: "worker",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  };
  const spawnStartedAt = performance.now();
  host.spawn(opts);
  harness.attach(sessionId);

  const readyWaitStartedAt = performance.now();
  try {
    await waitUntil(() => /FIXTURE_READY/.test(harness.text(sessionId)), { label: `${label} FIXTURE_READY`, timeoutMs: 20000 });
  } finally {
    console.log(`STAGE2-MEASURED label=${label} phase=ready ms=${Math.round(performance.now() - readyWaitStartedAt)}`);
  }

  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });

  const deliveryTimeoutMs = KICKOFF_PRE_DELIVERY_FLOOR_MS + Math.max(15000, kickoff.length * 2);
  console.log(`STAGE2-BUDGET label=${label} deliveryTimeoutMs=${deliveryTimeoutMs}`);
  const deliveryWaitStartedAt = performance.now();
  // NO try/catch here — deliberately mirrors kickoff-real-spawn.mjs's own lack of a catch around this
  // exact call. If it throws, it propagates uncaught, exactly as in the real file. We wrap ONLY to log
  // the throw's own wall-clock marker for the outer harness to key off of, then RE-THROW unchanged.
  try {
    await waitUntil(() => /FIXTURE_RECEIVED/.test(harness.text(sessionId)), { label: `${label} FIXTURE_RECEIVED`, timeoutMs: deliveryTimeoutMs });
  } catch (e) {
    console.log(`STAGE2-THROW-MARKER label=${label} atMs=${(performance.now() - spawnStartedAt).toFixed(1)} iso=${new Date().toISOString()} msg=${e?.message?.slice(0, 200)}`);
    throw e;
  } finally {
    console.log(`STAGE2-MEASURED label=${label} phase=delivery ms=${Math.round(performance.now() - deliveryWaitStartedAt)}`);
  }

  check(`${label} received exactly once`, (harness.text(sessionId).match(/FIXTURE_RECEIVED/g) || []).length === 1);
  timedStop(sessionId, "inline");
}

try {
  await verifyRealDelivery("[worker]", "stage2-worker", kickoffText());
} finally {
  // Mirrors kickoff-real-spawn.mjs's own outer finally exactly: a safety-net stop for any session not
  // already stopped inline — this is the ONLY place a stop happens when the throw above skips the inline
  // timedStop() call (matching the real file's own `host.stop(sessionId, "hard")` in its own finally).
  const allSessionIds = ["stage2-worker"];
  for (const sessionId of allSessionIds) {
    if (stoppedSessions.has(sessionId)) continue;
    timedStop(sessionId, "outer-finally");
  }
}

console.log(`STAGE2-DONE failures=${failures}`);
await finishAndExit(failures === 0 ? 0 : 1);
