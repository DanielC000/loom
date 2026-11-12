import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f951417c — the boot mode-cycle's wait on a write-blocking modal is CLAMPED to the fallback headroom
// (MODE_CYCLE_FALLBACK_MS from the cycle's start), so a huge LOOM_MODAL_DISMISS_SETTLE_MS can never push the wait
// past the fallback that releases the session. Its own file/process because both constants are frozen at import
// (boot-mode-cycle-waits-out-modal-settle.mjs needs the REAL 1500ms settle).
//
// A dismissed dialog leaves a candidate SETTLING for 60s; with the fallback at 2.5s the cycle must give up (never
// pressing) at ~2.5s, report ONE durable mode-mismatch, and NOT engage a hold on a settling candidate (no 5450ad93
// deadlock). Unclamped, the wait would be settle + 2s ≈ 62s and nothing would be reported inside this file's window.
//
// RUN: pnpm build (from packages/daemon) then `node test/boot-mode-cycle-modal-wait-clamp.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-bmc-clamp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_MODAL_DISMISS_SETTLE_MS = "60000";
process.env.LOOM_MODE_CYCLE_FALLBACK_MS = "2500";
process.env.LOOM_MODE_LOG_POLL_MS = "5";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const SHIFT_TAB = "\x1b[Z";
const DIALOG_TEXT = "Allow external CLAUDE.md file imports?\n❯ No, disable external imports\n  Yes, allow external imports\nEnter to confirm · Esc to cancel";
const COMPOSER_BOX = `\n${"─".repeat(120)}\n❯ \n${"─".repeat(120)}\n  [Opus 5.5] 📁 loom | 🌿 main`;

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    let dataCb = null;
    const fake = { ...base, write: (d) => writes.push(d), onData: (cb) => { dataCb = cb; return { dispose() {} }; }, writes, feed: (s) => { if (dataCb) dataCb(s); } };
    fakes.push(fake);
    return fake;
  }
}
const stuckInfos = [];
const host = new TestPtyHost({
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {}, onBusy() {},
  onClaudeBootDialogStuck(sessionId, info) { stuckInfos.push({ sessionId, ...info }); },
});

const S = "bmc-clamp";
host.spawn({
  sessionId: S, cwd: tmpHome, role: "worker",
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 3 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
host.markMcpSeen(S);
const f = fakes[fakes.length - 1];
f.feed(DIALOG_TEXT);
f.feed("\naccept edits on (shift+tab to cycle)\n");
host.deliverHook(S, { hook_event_name: "SessionStart", session_id: "eng-clamp" });
f.feed(COMPOSER_BOX); // dismissal evidence → a SETTLING candidate (60s)
f.feed("\naccept edits on (shift+tab to cycle)\n");
const t0 = Date.now();
const reported = await waitUntil(() => stuckInfos.some((i) => i.sessionId === S && i.modeMismatch), { label: "mode-mismatch reported inside the clamped wait", timeoutMs: 10000 });
const elapsed = Date.now() - t0;
check("the wait expired and reported a mode mismatch well inside the 62s unclamped bound", reported && elapsed < 8000);
check("no Shift+Tab was ever written", f.writes.filter((w) => w === SHIFT_TAB).length === 0);
check("a SETTLING candidate does not engage the hold (no 5450ad93 deadlock)", host.getMidSessionModalSince(S) === null);
try { host.stop(S, "hard"); } catch { /* ignore */ }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
