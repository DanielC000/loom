import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f951417c — the startup mode-cycle must WAIT (bounded) on `modalWriteBlocked` before pressing Shift+Tab.
//
// THE DEFECT: a boot dialog dismissed right at SessionStart leaves a frozen modal candidate that refuses every
// Loom write for MODAL_DISMISS_SETTLE_MS (1500ms). The cycle's first press fires ~700ms after SessionStart, so it
// was DROPPED at the ptyWrite chokepoint, the cycle ended `footer-unchanged`, and a `default` target (the only
// target that climbs off the acceptEdits boot; startupModeCycles ≡ 3 mod 4) stayed in the MORE permissive
// acceptEdits. Deliberately runs at the REAL 1500ms settle: NO LOOM_MODAL_DISMISS_SETTLE_MS override, since a
// shrunk settle hides exactly this race (the cycle's 700ms settle then outlasts the candidate).
//
// (1) dialog dismissed → SessionStart → target `default`: three Shift+Tabs land and the footer reads default.
// (2) a modal that NEVER clears: no press is ever written (Shift+Tab is not exempt from the chokepoint), the cycle
//     gives up after its bound, logs a loud MODE MISMATCH, ENGAGES the hold (so the PROMPT HELD row + owner escalation
//     fire as the refused press used to), reports ONE durable mode-mismatch (target + landed) and releases (not wedged);
//     the worker's post-ready auto-heal then short-circuits on the engaged hold instead of waiting again.
//
// HERMETIC, claude-free — a fake pty whose Shift+Tab write repaints the next footer.
//
// RUN: pnpm build (from packages/daemon) then `node test/boot-mode-cycle-waits-out-modal-settle.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-bmc-modal-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_MODAL_DISMISS_SETTLE_MS; // the REAL 1500ms settle — the whole point of this file
process.env.LOOM_MODE_LOG_POLL_MS = "5";

const { PtyHost, MODAL_DISMISS_SETTLE_MS } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

check("precondition: the settle is the real production 1500ms", MODAL_DISMISS_SETTLE_MS === 1500);

const SHIFT_TAB = "\x1b[Z";
const FOOTERS = {
  acceptEdits: "accept edits on (shift+tab to cycle)",
  plan: "plan mode on (shift+tab to cycle)",
  auto: "auto mode on (shift+tab to cycle)",
  default: "? for shortcuts · shift+tab to cycle",
};
// Real order off the acceptEdits boot (ACCEPT_EDITS_CYCLE_ORDER).
const ORDER = ["acceptEdits", "plan", "auto", "default"];
const DIALOG_TEXT = "Allow external CLAUDE.md file imports?\n❯ No, disable external imports\n  Yes, allow external imports\nEnter to confirm · Esc to cancel";
const COMPOSER_BOX = `\n${"─".repeat(120)}\n❯ \n${"─".repeat(120)}\n  [Opus 5.5] 📁 loom | 🌿 main`;

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    let dataCb = null;
    let footerIdx = 0;
    const fake = {
      ...base,
      // A landed Shift+Tab repaints the next footer, like the real TUI.
      write: (d) => { writes.push(d); if (d === SHIFT_TAB && footerIdx < ORDER.length - 1) { footerIdx++; fake.feed(`\n${FOOTERS[ORDER[footerIdx]]}\n`); } },
      onData: (cb) => { dataCb = cb; return { dispose() {} }; },
      writes, feed: (s) => { if (dataCb) dataCb(s); },
      currentFooter: () => ORDER[footerIdx],
    };
    fakes.push(fake);
    return fake;
  }
}
const stuckInfos = [];
const host = new TestPtyHost({
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {}, onBusy() {},
  onClaudeBootDialogStuck(sessionId, info) { stuckInfos.push({ sessionId, ...info }); },
});
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); origLog(...a); };
const countShiftTabs = (fake) => fake.writes.filter((w) => w === SHIFT_TAB).length;

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(" ")); origError(...a); };

// ---- (1) dismissed dialog → SessionStart → target `default` -------------------------------------------------
{
  const S = "bmc-1-dismissed-then-default";
  host.spawn({
    sessionId: S, cwd: tmpHome, role: "worker",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 3 }, // → target "default"
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.markMcpSeen(S);
  const f = fakes[fakes.length - 1];
  f.feed(DIALOG_TEXT);
  f.feed(`\n${FOOTERS.acceptEdits}\n`);
  host.deliverHook(S, { hook_event_name: "SessionStart", session_id: "eng-1" }); // the dialog resolves
  f.feed(COMPOSER_BOX); // dismissal evidence → the candidate is now SETTLING (writes refused, hold not engaged)
  f.feed(`\n${FOOTERS.acceptEdits}\n`);
  const reached = await waitUntil(() => host.hasReachedReady(S), { label: "(1) cycle finishes and the session is released", timeoutMs: 15000 });
  check("(1) session reached ready (cycle completed, not wedged)", reached);
  check("(1) all THREE Shift+Tabs landed (acceptEdits→plan→auto→default)", countShiftTabs(f) === 3);
  check("(1) the footer landed in `default`, not stranded in acceptEdits", f.currentFooter() === "default");
  try { host.stop(S, "hard"); } catch { /* ignore */ }
}

// ---- (2) a modal that never clears: never press, loud expiry ------------------------------------------------
{
  const S = "bmc-2-never-clears";
  errors.length = 0;
  host.spawn({
    sessionId: S, cwd: tmpHome, role: "worker",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 3 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.markMcpSeen(S);
  const f = fakes[fakes.length - 1];
  f.feed(DIALOG_TEXT);
  f.feed(`\n${FOOTERS.acceptEdits}\n`);
  host.deliverHook(S, { hook_event_name: "SessionStart", session_id: "eng-2" });
  f.feed(DIALOG_TEXT); // still on screen after SessionStart: a live candidate that never settles away
  f.feed(`\n${FOOTERS.acceptEdits}\n`);
  const released = await waitUntil(() => host.hasReachedReady(S), { label: "(2) bounded wait expires and the session is released", timeoutMs: 15000 });
  check("(2) session released after the bounded wait (not wedged)", released);
  // The worker's heal-after-expiry path (logLandedMode → cycleToMode) runs next; wait for its own cycle to finish too.
  const healed = await waitUntil(() => logs.filter((l) => l.includes(`${S} cycle→default: modal-blocked`)).length >= 2, { label: "(2) the post-ready heal cycle also ends modal-blocked", timeoutMs: 15000 });
  check("(2) the worker auto-heal path ran and also never pressed", healed && logs.some((l) => l.includes(`${S} auto-heal`)));
  check("(2) NO Shift+Tab was ever written into the blocked chokepoint", countShiftTabs(f) === 0);
  check("(2) a loud MODE MISMATCH error was logged", errors.some((e) => e.includes("MODE MISMATCH") && e.includes(S)));
  check("(2) the expiry ENGAGED the hold (PROMPT HELD / escalation path)", host.getMidSessionModalSince(S) !== null);
  const mm = stuckInfos.filter((i) => i.sessionId === S && i.modeMismatch);
  check("(2) exactly ONE durable mode-mismatch report (target default, landed acceptEdits) despite the heal's second expiry",
    mm.length === 1 && mm[0].modeMismatch.target === "default" && mm[0].modeMismatch.landed === "acceptEdits" && mm[0].phase === "mid-session");
  try { host.stop(S, "hard"); } catch { /* ignore */ }
}

console.error = origError;
console.log = origLog;
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
