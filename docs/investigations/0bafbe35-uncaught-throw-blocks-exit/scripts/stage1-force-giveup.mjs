// Card 0bafbe35, Stage 1 — force GIVE-UP RECOVERY deterministically, no real host contention needed.
// WHAT IT FORCES: a bare-PtyHost session (same shape kickoff-real-spawn.mjs's own harness uses — no
// index.ts, no reconcile() timer, no onGiveUpExhausted wiring) whose fixture (fake-claude-cli.mjs)
// flushes on its own FIXTURE_DEBOUNCE_MS timer. Two scenarios: a control at the fixture's real default
// (250ms, expect SUPPRESSED) and a forced run at 10000ms (past the daemon's own ~4-6s give-up window,
// expect RECOVERY). Neither scenario touches production code — this is a read-only consumer of the
// already-built dist/pty/host.js and the existing test fixture.
// HOW TO RUN (from repo root, after `pnpm build`):
//   node docs/investigations/0bafbe35-uncaught-throw-blocks-exit/scripts/stage1-force-giveup.mjs
// MEASURED RESULT (2026-08-01, gate_queue cap=2 activeCount=2 throughout — see findings.md):
//   control (250ms):  GIVE-UP SUPPRESSED; FIXTURE_RECEIVED at +9246ms
//   forced (10000ms): GIVE-UP RECOVERY, tail byte-identical to the card's own quoted line; no redrain
//                      ever logged (confirms reconcile() is not wired here); FIXTURE_RECEIVED still
//                      appeared at +20234ms, from the fixture's own eventual flush alone.
//   Unplanned: an AttachConsole crash fired between the two scenarios (one kill immediately followed by
//   one spawn, no concurrency) — recorded in findings.md as specimen 1/2, not chased further.
// NOT DISCOVERABLE BY THE TEST RUNNER: scripts/test-daemon.mjs's TEST_DIR is packages/daemon/test only;
// this file lives under docs/investigations/, structurally outside that scan.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const FIXTURE_PATH = path.join(REPO_ROOT, "packages", "daemon", "test", "fixtures", "fake-claude-cli.mjs");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-stage1-"));
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const wrapperPath = path.join(tmpHome, "fake-claude.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CLAUDE_BIN = wrapperPath;

const { PtyHost } = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "daemon", "dist", "pty", "host.js")).href);
const { ensureDirs } = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "daemon", "dist", "paths.js")).href);
ensureDirs();

class Harness {
  constructor(host) { this.host = host; this.buf = ""; this.firstSeenAt = new Map(); }
  attach(sessionId) {
    return this.host.subscribe(sessionId, {
      onData: (chunk) => {
        const text = chunk.toString("utf8");
        this.buf += text;
        if (/FIXTURE_RECEIVED/.test(text) && !this.firstSeenAt.has("FIXTURE_RECEIVED")) {
          this.firstSeenAt.set("FIXTURE_RECEIVED", performance.now());
        }
      },
      onControl: () => {},
    });
  }
}

// events object DELIBERATELY mirrors kickoff-real-spawn.mjs's own bare harness exactly — no
// onGiveUpExhausted callback, matching the real test's own setup, so this specimen's wiring gap (no
// reconcile timer, no onGiveUpExhausted) is faithfully reproduced, not accidentally improved on.
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

const claudeMd = fs.readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
function kickoffText() {
  return `[role:worker] ${claudeMd.slice(0, 4000)}\n\nDo the "worker" task now.`;
}

async function runScenario(label, debounceMs, watchWindowMs) {
  console.log(`\n===== SCENARIO ${label}: FIXTURE_DEBOUNCE_MS=${debounceMs} =====`);
  const host = new PtyHost(events);
  const harness = new Harness(host);
  const sessionId = `stage1-${label}`;
  const outputFile = path.join(tmpHome, `received-${sessionId}`);
  process.env.FIXTURE_OUTPUT_FILE = outputFile;
  process.env.FIXTURE_DEBOUNCE_MS = String(debounceMs);

  const opts = {
    sessionId, cwd: tmpHome, startupPrompt: kickoffText(), role: "worker",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  };

  const t0 = performance.now();
  host.spawn(opts);
  harness.attach(sessionId);

  const readyDeadline = t0 + 20000;
  while (!/FIXTURE_READY/.test(harness.buf) && performance.now() < readyDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const readyAt = performance.now();
  console.log(`[${label}] FIXTURE_READY at +${Math.round(readyAt - t0)}ms`);

  const kickoffAt = performance.now();
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  console.log(`[${label}] delivered SessionStart at +${Math.round(kickoffAt - t0)}ms — watching for ${watchWindowMs}ms`);

  const watchDeadline = performance.now() + watchWindowMs;
  while (performance.now() < watchDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  const receivedAt = harness.firstSeenAt.get("FIXTURE_RECEIVED");
  if (receivedAt !== undefined) {
    console.log(`[${label}] RESULT: FIXTURE_RECEIVED appeared at +${Math.round(receivedAt - t0)}ms (${Math.round(receivedAt - kickoffAt)}ms after SessionStart)`);
  } else {
    console.log(`[${label}] RESULT: FIXTURE_RECEIVED NEVER appeared within the ${watchWindowMs}ms watch window`);
  }

  try { host.stop(sessionId, "hard"); } catch (e) { console.log(`[${label}] stop() threw: ${e?.message}`); }
  return { label, receivedAt: receivedAt !== undefined ? receivedAt - t0 : null };
}

const results = [];
results.push(await runScenario("control-250ms", 250, 15000));
results.push(await runScenario("forced-10000ms", 10000, 60000));

console.log("\n===== SUMMARY =====");
for (const r of results) console.log(JSON.stringify(r));

process.exit(0);
