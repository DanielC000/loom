// Claude-free regression guard for card 9c03f5a6 — cycleToMode (pty/host.ts) is now SERIALIZED per
// session via `Live.modeCycleChain`. Before this fix, the AUTOMATIC boot-time mode-cycle (fired once from
// SessionStart, targeting the config default — "auto" by 2 startupModeCycles) and a MANUAL
// worker_set_mode override (setPermissionMode) shared the same pty/footer with NO coordination: if a
// manager called worker_set_mode shortly after spawn — a natural pattern, pushing a freshly-spawned
// worker straight into a mode — the two cycles interleaved their Shift+Tab presses and footer reads, each
// mistaking the other's press for its own registered change. The observed bug (owner-reported, live):
// worker_set_mode(plan) on a freshly-spawned worker returned `landed:"auto"` — the BOOT cycle's own
// default target — regardless of the mode actually requested, and only a RETRY (issued after the boot
// cycle had already finished, so nothing raced it) landed correctly. This exercises the REAL PtyHost
// state machine (spawn/deliverHook/markReady/setPermissionMode) against a FAKE pty fed realistic footer
// text, at the createPty() seam (mirrors pty-mode-convergence.mjs). No real claude, no daemon, no network.
//
// What it locks:
//   1. A manual setPermissionMode call issued WHILE the automatic boot cycle is still converging does NOT
//      press or read the footer until the boot cycle has FULLY finished — proven by asserting the
//      Shift+Tab count advances in the EXACT boot-only sequence (1, then 2) while the boot cycle is still
//      in flight, never jumping ahead to a 3rd press before boot's own "reached" completion.
//   2. Once boot finishes, the manual cycle starts FRESH off the true settled footer and converges to ITS
//      OWN requested target — even when that target is several presses away from where boot landed —
//      landing EXACTLY that target, not a neighbor the boot cycle happened to reach.
//
// RUN: pnpm build (repo root) then `node test/pty-mode-race.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred, timeoutMs, intervalMs = 20) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(intervalMs);
  }
  return true;
};

// Hermetic LOOM_HOME + fast footer polling (defaults: 200ms/15 polls ≈ 3s change-wait). Raise the press
// cap so the manual cycle (auto → plan is 3 presses forward in the cycle order — see below) has room to
// complete, and pin the outer retry count to 1 so this test isolates the QUEUEING fix specifically,
// independent of the separate bounded-retry behavior covered in worker-set-mode.mjs. MODE_CYCLE_SETTLE_MS
// (700ms, fixed) is NOT env-overridable — all sleeps below account for it as a fixed cost.
const tmpHome = path.join(os.tmpdir(), `loom-pmr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_RESUME_MODE_POLL_MS = "40";
process.env.LOOM_RESUME_MODE_MAX_POLLS = "3"; // change-wait cap ≈ 120ms
process.env.LOOM_RESUME_MODE_MAX_PRESSES = "6"; // boot needs 2, the manual override needs 3 more
process.env.LOOM_MODE_OVERRIDE_MAX_ATTEMPTS = "1"; // isolate queueing from the separate retry behavior
process.env.LOOM_READY_FALLBACK_MS = "9000";

const { PtyHost } = await import("../dist/pty/host.js");

const SHIFT_TAB = "\x1b[Z";
const ACCEPT_EDITS_FOOTER = "accept edits on (shift+tab to cycle)";
const PLAN_FOOTER = "plan mode on (shift+tab to cycle)";
const AUTO_FOOTER = "auto mode on (shift+tab to cycle)";
const DEFAULT_FOOTER = "(shift+tab to cycle)"; // no mode label — the unlabeled "default" state
// detectPermissionMode reads only the trailing 8192 bytes of the ring and picks the LAST labeled token —
// transitioning TO the unlabeled "default" state emits no label of its own, so a stale "auto mode on"
// still sitting in that trailing window would otherwise win. Pad the ring past that window first so the
// read sees ONLY the fresh (unlabeled) content, mirroring how continued real output eventually flushes a
// stale label out — a test-harness accommodation, not a production behavior change.
const RING_WINDOW_PAD = "x".repeat(8300);

const fakes = [];
function makeFakePty() {
  const writes = [];
  let dataCb = null;
  const fake = {
    pid: 4242, write: (d) => writes.push(d),
    onData: (cb) => { dataCb = cb; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes,
    feed: (s) => { if (dataCb) dataCb(s); },
  };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const countShiftTabs = (fake) => fake.writes.filter((w) => w === SHIFT_TAB).length;

const SID = "sess-mode-race";

try {
  // ---- Spawn with a REAL boot-cycle target (startupModeCycles:2 → auto), matching production config. ----
  host.spawn({
    sessionId: SID, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker",
  });
  const f = fakes[fakes.length - 1];
  f.feed(ACCEPT_EDITS_FOOTER);
  host.deliverHook(SID, { hook_event_name: "SessionStart", session_id: "eng-mode-race" });

  // ---- Issue the manual override IMMEDIATELY — before the boot cycle has even taken its first read.
  // ---- This is the exact "manager pushes a freshly-spawned worker into a mode" race window. ----
  const setModePromise = host.setPermissionMode(SID, "plan");

  // ---- Boot cycle's 1st press (acceptEdits → plan attempt) — the manual call must NOT have pressed yet. ----
  check("only the BOOT cycle's 1st Shift+Tab has fired (manual call is queued, not racing)",
    await waitUntil(() => countShiftTabs(f) === 1, 2000));
  await sleep(60); // give a racing (unfixed) 2nd cycle a window to press too, if the bug were present
  check("still exactly 1 press — no concurrent press from the queued manual call", countShiftTabs(f) === 1);
  f.feed(PLAN_FOOTER); // boot's 1st press registers

  // ---- Boot cycle's 2nd press (plan → auto attempt) — still no interleaving from the manual call. ----
  check("only the BOOT cycle's 2nd Shift+Tab has fired", await waitUntil(() => countShiftTabs(f) === 2, 1000));
  await sleep(60);
  check("still exactly 2 presses — the manual call has NOT started pressing during boot's cycle", countShiftTabs(f) === 2);
  f.feed(AUTO_FOOTER); // boot's 2nd press registers — boot cycle reaches ITS target (auto) and finishes

  // ---- Only NOW may the queued manual cycle begin: its own MODE_CYCLE_SETTLE_MS(700ms) settle, then a
  // ---- FRESH footer read (auto — the true, uncontested state) before its first press. ----
  check("the manual cycle's 1st press (auto → default attempt) fires only AFTER boot fully finished",
    await waitUntil(() => countShiftTabs(f) === 3, 2000));
  f.feed(RING_WINDOW_PAD + DEFAULT_FOOTER);
  check("the manual cycle's 2nd press (default → acceptEdits attempt)",
    await waitUntil(() => countShiftTabs(f) === 4, 1000));
  f.feed(ACCEPT_EDITS_FOOTER);
  check("the manual cycle's 3rd press (acceptEdits → plan attempt)",
    await waitUntil(() => countShiftTabs(f) === 5, 1000));
  f.feed(PLAN_FOOTER); // the manual cycle reaches ITS requested target

  const landed = await setModePromise;
  check(`the manual override resolves EXACTLY its requested target 'plan' (got '${landed}') — not the boot ` +
    "cycle's default 'auto' (the exact bug reported live)", landed === "plan");
  check("converged in exactly 5 presses total (2 boot + 3 manual) — no overshoot from interleaving", countShiftTabs(f) === 5);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a manual worker_set_mode call issued while the automatic boot-time mode-cycle is still "
    + "converging QUEUES behind it (Live.modeCycleChain) instead of racing it: no interleaved presses, and "
    + "once boot finishes the manual call converges from a fresh, uncontested footer read to EXACTLY its "
    + "own requested target — closing the bug where a freshly-spawned worker's mode override landed on the "
    + "boot cycle's default target regardless of what was requested."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
