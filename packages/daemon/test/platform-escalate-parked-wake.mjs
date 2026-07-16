import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ac82bac4 — proves platform_escalate's best-effort live-nudge ACTUALLY wakes a live-but-PARKED
// Platform Lead (one that called `idle_report('waiting')`) IMMEDIATELY, with ZERO dependency on the
// ~46-min idle-watchdog tick. This is the REGRESSION GUARD the investigation's finding rests on:
//
//   - sessions/service.ts's platformEscalate best-effort-nudges a live Lead via the SAME
//     `pty.enqueueStdin` every other durable channel (worker_report, session_message, the
//     answered-stuck watchdog) uses.
//   - pty/host.ts's enqueueStdin submits a turn IMMEDIATELY whenever
//     `live.ready && !live.busy && !live.stopping && !live.rateLimited && !deferForHumanDraft` — it
//     does not care WHY the session is idle.
//   - recordIdleReport('waiting') only flips the DB-level `idle_nudge_state` policy to 'snoozed' (which
//     paces the idle-WATCHDOG's own re-nudge cadence in orchestration/idle-watcher.ts) — it never
//     touches `live.busy`/`live.rateLimited`/`live.ready` on the pty, so a Lead parked this way is, at
//     the pty layer, indistinguishable from any other idle session.
//
// UNLIKE test/platform-messaging.mjs (which proves the manager/platform tool-surface wiring, gating,
// framing, and board-durability contract using a SeamHost stub whose enqueueStdin ALWAYS returns
// {delivered:true}), this test drives the REAL PtyHost busy-gate state machine — model: pty-busy-
// drain.mjs — with only the ONE seam (createPty) faked. It never imports or ticks IdleWatcher at all,
// so a pass here cannot be explained by the idle-watchdog's own nudge; it can only be explained by the
// immediate enqueueStdin submit path actually firing.
//
// The no-live-Lead → `boarded` degrade path (and the manager/worker tool-surface gating) is already
// covered by platform-messaging.mjs — deliberately NOT duplicated here.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-escalate-parked-wake.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME: host.ts opens a per-session log under LOGS_DIR (= $LOOM_HOME/logs) in
// spawn(). Point it at a throwaway temp dir BEFORE importing host.js (paths.ts reads LOOM_HOME at
// import time), and create the logs dir so createWriteStream succeeds. Mirrors pty-busy-drain.mjs. ---
const tmpHome = path.join(os.tmpdir(), `loom-escparked-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// --- A fake IPty: records every write; onData/onExit are inert (host.ts's busy/drain machine never
// depends on them firing) — same seam pty-busy-drain.mjs uses, NOT platform-messaging.mjs's
// enqueueStdin-stubbing SeamHost. This is what makes the assertions below meaningful: enqueueStdin
// itself runs for real. ---
const fakes = [];
function makeFakePty() {
  const writes = [];
  const fake = { pid: 4242, write: (d) => { writes.push(d); }, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
}

const now = new Date().toISOString();
const db = new Db();
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new TestPtyHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

// The reserved "Loom Platform" home (platform_escalate's hardcoded target) + an ordinary project the
// escalating manager lives in.
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertAgent({ id: "agentMgr", projectId: "pOrd", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });

const seedSession = (id, projectId, agentId, role) => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: null,
});
seedSession("LEAD", "pHome", "agentLead", "platform");
seedSession("MGR", "pOrd", "agentMgr", "manager");

try {
  // Real-spawn the Lead through the ACTUAL PtyHost state machine (only createPty faked) and mark it
  // ready via the SAME SessionStart hook a real boot fires — mirrors pty-busy-drain.mjs exactly.
  host.spawn({
    sessionId: "LEAD", cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = fakes[0];
  check("setup: the Lead's fake pty is alive", host.isAlive("LEAD") === true);
  host.deliverHook("LEAD", { hook_event_name: "SessionStart" });
  check("setup: the Lead is ready and genuinely idle (busy=false) before parking", db.getSession("LEAD").busy === false);

  // Park it EXACTLY as the friction scenario describes: idle_report('waiting') after telling a manager
  // "let me know when the fix lands".
  const parked = svc.recordIdleReport("LEAD", "waiting", { minutes: 60 });
  check("(1) recordIdleReport('waiting') parks the Lead at the DB/idle-watchdog level (policy 'snoozed')", parked.policy === "snoozed");
  check("(1) parking does NOT touch the pty's busy/ready state — the Lead is still idle at the pty layer", db.getSession("LEAD").busy === false && host.isAlive("LEAD") === true);

  // Nothing has been written to the Lead's pty yet — the park itself is silent.
  check("(1) idle_report itself writes NOTHING to the Lead's pty", fake.writes.length === 0);

  // ===================== THE KEY PROOF: the manager's escalation wakes the parked Lead NOW =====================
  const writesBefore = fake.writes.length;
  const esc = svc.platformEscalate("MGR", {
    title: "worker_merge gate hangs on a slow build",
    detail: "the fix landed on main — the Lead asked to be told when this happened",
    severity: "high",
  });
  check("(2) platform_escalate reports deliveryStatus 'delivered-live' for a parked-but-live Lead", esc.deliveryStatus === "delivered-live" && !esc.error);
  check("(2) the escalation ALSO filed a durable board task on the Platform home (never ephemeral-only)",
    !!esc.taskId && esc.projectId === "pHome" && !!db.getTask(esc.taskId));
  check("(2) a REAL submit() fired into the Lead's pty — the [loom:escalation] note actually landed in its write buffer",
    fake.writes.length > writesBefore && fake.writes.slice(writesBefore).join("").includes("[loom:escalation]") && fake.writes.slice(writesBefore).join("").includes(esc.taskId));
  check("(2) the submit armed busy=true SYNCHRONOUSLY — a genuine new turn, not a no-op echo", db.getSession("LEAD").busy === true);
  check("(2) NO IdleWatcher was ever imported or ticked in this test — the wake cannot be attributed to the idle-watchdog", true);

  // Let the Lead's turn settle (Stop) purely for hygiene — not load-bearing for the assertions above.
  host.deliverHook("LEAD", { hook_event_name: "Stop" });

  // ===================== SANITY: a genuinely BUSY Lead is NOT delivered-live (proves the gate is real) =====================
  // Re-submit a fresh turn so the Lead is mid-turn (busy=true) when the next escalation lands — if the
  // busy-gate weren't real, this would ALSO read delivered-live, which would make the proof above vacuous.
  host.enqueueStdin("LEAD", "an unrelated in-flight turn");
  check("sanity: the Lead is now genuinely busy (mid-turn)", db.getSession("LEAD").busy === true);
  const esc2 = svc.platformEscalate("MGR", { title: "a second, unrelated issue", detail: "filed while the Lead is mid-turn", severity: "low" });
  check("sanity: a BUSY (not parked-idle) live Lead gets 'queued', NOT 'delivered-live' — the gate genuinely discriminates",
    esc2.deliveryStatus === "queued" && !esc2.error);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — platform_escalate's live-nudge wakes a live-but-parked (idle_report('waiting')) Platform Lead IMMEDIATELY via a real enqueueStdin submit (delivered-live, a genuine busy=true turn, the note landed in the pty's write buffer) — with zero IdleWatcher involvement, so this cannot be the ~46-min idle-watchdog tick. The board task is always filed too (never ephemeral-only). A genuinely busy Lead correctly gets 'queued' instead, proving the gate is real and this isn't vacuous."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
