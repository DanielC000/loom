import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card [companion] fix — platform_escalate must not re-emit an opaque, content-free attention-push alert
// every cycle when no Platform Lead is live to act on it. EVIDENCE (session 5db71873): the SAME
// escalation fired repeatedly (m:769d781d ×4, m:cd97ed8f ×2, m:446c8ff9 ×4) with no live Lead handler and
// decisions_list often empty — each re-file was a fresh orchestration_event, so attention-push's watermark
// treated it as genuinely new and re-pushed a Companion turn producing nothing the owner could act on.
//
// Proves:
//   (a) two IDENTICAL escalations (same title) from the same origin project, filed while the first is
//       still PENDING (unclaimed on the Platform board — no live Lead to pick it up), dedupe: the 2nd call
//       reuses the first's taskId, returns `deduped: true`, files NO new task, and appends NO new
//       `platform_escalate` orchestration_event — so attention-push (which tail-polls that event log) has
//       nothing new to alert on.
//   (b) a DIFFERENT title from the same project is NOT deduped — a genuinely distinct issue still files.
//   (c) once the Lead picks up the first escalation (moves it off the landing lane), a 3rd call with the
//       SAME original title is no longer deduped — it's treated as a fresh occurrence, matching
//       escalation_status's own pending → in_progress semantics.
//   (d) a dedup does not fire a redundant live-Lead nudge (only the genuinely-new-event live-nudge path is
//       exercised — platform-escalate-parked-wake.mjs already covers that live-nudge wiring itself).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE — a REAL Db + SessionService driven directly (no MCP layer;
// escalation-status.mjs / platform-messaging.mjs already cover the tool-surface wiring).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-escalate-dedup.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-escdedup-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// No live Lead in this test at all — the exact "no live handler" scenario from the evidence. A fake pty
// host is enough; enqueueStdin is never reached because no session has role "platform"/processState "live".
class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  enqueueStdin() { throw new Error("no live Lead in this test — enqueueStdin should never be reached"); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentMgr", projectId: "pOrd", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertSession({
  id: "MGR", projectId: "pOrd", agentId: "agentMgr", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});

const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const platformEscalateEvents = () => db.listEscalationsForProject("pOrd");

try {
  const TITLE = "worker_merge gate hangs on a slow build";

  // ===================== (a) identical re-escalation while unclaimed dedupes =====================
  const esc1 = svc.platformEscalate("MGR", { title: TITLE, detail: "Three workers stalled 4+ min.", severity: "high" });
  check("(a) 1st escalation files a fresh task", !!esc1.taskId && !esc1.deduped);
  const tasksAfter1 = db.listTasks("pHome").length;
  const eventsAfter1 = platformEscalateEvents().length;

  const esc2 = svc.platformEscalate("MGR", { title: TITLE, detail: "Three workers stalled 4+ min.", severity: "high" });
  check("(a) 2nd IDENTICAL escalation reuses the SAME taskId", esc2.taskId === esc1.taskId);
  check("(a) 2nd IDENTICAL escalation reports deduped:true", esc2.deduped === true);
  check("(a) no new Platform task was filed", db.listTasks("pHome").length === tasksAfter1);
  check("(a) no new platform_escalate orchestration_event was appended (attention-push has nothing new to alert on)",
    platformEscalateEvents().length === eventsAfter1);

  // A 3rd call, same title, still dedupes — this is the "loops with zero owner-facing value" repro made whole.
  const esc3 = svc.platformEscalate("MGR", { title: TITLE, detail: "still stalled", severity: "high" });
  check("(a) a 3rd identical re-escalation ALSO dedupes (the per-cycle loop is broken)", esc3.taskId === esc1.taskId && esc3.deduped === true);
  check("(a) still no new task/event after a 3rd repeat", db.listTasks("pHome").length === tasksAfter1 && platformEscalateEvents().length === eventsAfter1);

  // Title matching is normalized (case/whitespace-insensitive) — a trivial rephrase of the same title still
  // dedupes, so a manager can't dodge the guard with cosmetic variation.
  const esc4 = svc.platformEscalate("MGR", { title: `  ${TITLE.toUpperCase()}  `, detail: "same issue, shouty title", severity: "high" });
  check("(a) a normalized-equal title (case/whitespace) also dedupes", esc4.taskId === esc1.taskId && esc4.deduped === true);

  // ===================== (b) a genuinely different title is NOT deduped =====================
  const escOther = svc.platformEscalate("MGR", { title: "a completely different problem", detail: "unrelated", severity: "low" });
  check("(b) a different title files a genuinely new task", !!escOther.taskId && escOther.taskId !== esc1.taskId && !escOther.deduped);
  check("(b) a new platform_escalate event WAS appended for the distinct issue", platformEscalateEvents().length === eventsAfter1 + 1);

  // ===================== (c) once picked up (moved off the landing lane), the SAME title re-files fresh ====
  db.updateTask(esc1.taskId, { columnKey: "review" }); // the Lead claims it
  const esc5 = svc.platformEscalate("MGR", { title: TITLE, detail: "recurred after being picked up", severity: "high" });
  check("(c) after the original is claimed (no longer pending), the SAME title is treated as a fresh occurrence",
    !!esc5.taskId && esc5.taskId !== esc1.taskId && !esc5.deduped);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — platform_escalate dedupes an identical, still-unclaimed re-escalation (same normalized title, no new task, no new orchestration_event ⇒ attention-push has nothing new to loop on), leaves a genuinely distinct title unaffected, and lets the same title re-file fresh once the Lead has claimed the original."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
