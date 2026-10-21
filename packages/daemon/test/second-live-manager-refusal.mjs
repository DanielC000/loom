import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0368c784 — `SessionService.startNew`/`startManager` refuse a SECOND live-or-starting manager for
// the same agent. From 318b5a21: the web go-live guard (client-side) already treats "starting" as held,
// but nothing on the SERVER refused a second manager at all — a second tab, a direct REST call, or a
// race could still mint two orchestrators for one agent. This is the server-side backstop.
//
// `refuseSecondLiveManager` (service.ts) is a SYNCHRONOUS check placed before `insertSession` inside
// `startNew`'s manager-resolved branch and `startManager` — both non-`async` methods, so TypeScript
// forbids an `await` between the check and the insert; no in-process lock is needed (mirrors
// `recycleManager`'s own anti-double-recycle guard, which relies on the identical property). Keyed on
// VERIFIED pty liveness (never raw processState alone, mirroring `liveOtherPlatformLead`). Card 8e84a403
// (Code Review): there is deliberately NO `hasSuccessor` exemption — a HALTED recycle leaves
// `hasSuccessor(predecessor)` permanently true over a predecessor that is the real live owner, so a live
// successor blocking on its own is the only safe way to cover the coexistence window (see (f2)).
//
// Proves:
//   (a) BASELINE — a fresh agent's first startManager call succeeds.
//   (b) SECOND LIVE MANAGER REFUSED — a second startManager call for the SAME agent throws
//       SecondLiveManagerError naming the holder; no new row, no new pty spawn.
//   (c) VIA startNew — a profile-resolved "manager" role hits the SAME chokepoint: first call succeeds,
//       second is refused.
//   (d) EXISTING-STARTING REFUSAL — a manager row manually left at processState "starting" (simulating
//       the crash/mid-spawn window) with its pty still alive STILL blocks a second start.
//   (e) PHANTOM-LIVE NEGATIVE CONTROL — a session row inserted directly (never actually spawned, so its
//       pty is NOT alive) does NOT block a fresh start — a phantom row must never permanently lock an
//       agent out (mirrors startPlatformLead's own stated rationale).
//   (f) RECYCLE COEXISTENCE — during the ordinary brief predecessor+successor window (both alive), a
//       THIRD start attempt is still refused, naming WHICHEVER live manager the scan finds first.
//   (f2) HALTED RECYCLE — the hole the old `hasSuccessor` exemption used to open: predecessor live
//       (never stopped), successor exited, a `recycle_ownership_transfer_failed` event filed, and
//       `hasSuccessor(predecessor)` permanently true — a fresh start is STILL refused, naming the
//       PREDECESSOR (the genuine live owner).
//   (g) STOP THEN RETRY — once the holding manager's pty genuinely stops, a fresh start for the same
//       agent succeeds again (the guard is not a permanent lock).
//   (h) WORKER NEGATIVE CONTROL — many live "worker"-role sessions under the SAME agentId are entirely
//       unaffected (the guard only ever checks role==="manager").
//   (i) WORKSPACE-AUDITOR NEGATIVE CONTROL — startWorkspaceAuditor stays create-only (two calls, two rows).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty()/stop() seam) whose isAlive() is fully test-controlled (mirrors
// manager-recycle-prespawn-throw-unlinks-predecessor.mjs's own SeamHost shape) — no real claude, no daemon.
//
// Run: 1) build (turbo builds shared first), 2) node test/second-live-manager-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-2ndmgr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService, SecondLiveManagerError } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const repo = path.join(os.tmpdir(), `loom-2ndmgr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# second-live-manager-refusal test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=slm@loom -c user.name=slm");

const now = new Date().toISOString();
const db = new Db();

// isAlive() is FULLY test-controlled (mirrors manager-recycle-prespawn-throw-unlinks-predecessor.mjs):
// `aliveIds` tracks exactly which session ids were ever actually spawned through this host (so a row
// inserted directly via db.insertSession, never spawned, correctly reads NOT alive — the phantom-row
// scenario (e) needs this; a bare `!stoppedIds.has(id)` shape would wrongly read every never-spawned id
// as alive).
class SeamHost extends createSeamHost(PtyHost) {
  aliveIds = new Set();
  spawned = [];
  createPty(opts, hookToken, mcpToken) {
    this.aliveIds.add(opts.sessionId);
    this.spawned.push(opts);
    return super.createPty(opts, hookToken, mcpToken);
  }
  stop(id) { this.aliveIds.delete(id); }
  isAlive(id) { return this.aliveIds.has(id); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pMgr", name: "Mgr Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentA", projectId: "pMgr", name: "A", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentB", projectId: "pMgr", name: "B", startupPrompt: "MGR", position: 1, profileId: null });
db.insertAgent({ id: "agentC", projectId: "pMgr", name: "C", startupPrompt: "MGR", position: 2, profileId: null });
db.insertAgent({ id: "agentPhantom", projectId: "pMgr", name: "Phantom", startupPrompt: "MGR", position: 3, profileId: null });
db.insertAgent({ id: "agentRecycle", projectId: "pMgr", name: "Recycle", startupPrompt: "MGR", position: 4, profileId: null });
db.insertAgent({ id: "agentHalt", projectId: "pMgr", name: "Halt", startupPrompt: "MGR", position: 9, profileId: null });
db.insertAgent({ id: "agentStop", projectId: "pMgr", name: "Stop", startupPrompt: "MGR", position: 5, profileId: null });
db.insertAgent({ id: "agentWorker", projectId: "pMgr", name: "Worker", startupPrompt: "WORKER", position: 6, profileId: null });
db.insertAgent({ id: "agentWsAudit", projectId: "pMgr", name: "WsAudit", startupPrompt: "WSAUDIT", position: 7, profileId: null });
db.insertProfile({ id: "profMgrRig", name: "Manager Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentNewMgr", projectId: "pMgr", name: "NewMgr", startupPrompt: "", position: 8, profileId: "profMgrRig" });

try {
  // ============================ (a) BASELINE — first startManager succeeds =========================
  const a1 = svc.startManager("agentA");
  check("(a) first startManager succeeds — role manager, live", a1.role === "manager" && a1.processState === "live");
  check("(a) its pty reads alive", host.isAlive(a1.id) === true);

  // ============== (b) SECOND LIVE MANAGER REFUSED — names the holder, no new row/spawn ================
  const spawnedBeforeB = host.spawned.length;
  const rowsBeforeB = db.listSessions("agentA").length;
  let threwB = null;
  try { svc.startManager("agentA"); } catch (e) { threwB = e; }
  check("(b) a second startManager for the SAME agent throws SecondLiveManagerError",
    threwB instanceof SecondLiveManagerError);
  check("(b) the error names the holding session id", threwB?.holderSessionId === a1.id && threwB.message.includes(a1.id));
  check("(b) NO new session row was inserted", db.listSessions("agentA").length === rowsBeforeB);
  check("(b) NO new pty was spawned", host.spawned.length === spawnedBeforeB);

  // ============================ (c) VIA startNew (profile-resolved manager) ========================
  const c1 = svc.startNew("agentNewMgr");
  check("(c) startNew whose profile resolves role===\"manager\" succeeds on the first call",
    c1.role === "manager" && c1.processState === "live");
  let threwC = null;
  try { svc.startNew("agentNewMgr"); } catch (e) { threwC = e; }
  check("(c) a second startNew for the SAME profile-resolved-manager agent is refused",
    threwC instanceof SecondLiveManagerError && threwC.holderSessionId === c1.id);

  // ============================ (d) EXISTING-STARTING REFUSAL ========================================
  // Force agentA's live row back to "starting" (simulating the near-instantaneous crash/mid-spawn
  // window) while its pty stays registered alive — the guard must still refuse.
  db.setProcessState(a1.id, "starting");
  check("(d-setup) agentA's row is now 'starting', pty still alive", db.getSession(a1.id)?.processState === "starting" && host.isAlive(a1.id));
  let threwD = null;
  try { svc.startManager("agentA"); } catch (e) { threwD = e; }
  check("(d) a 'starting' (not yet live) manager row STILL blocks a second start",
    threwD instanceof SecondLiveManagerError && threwD.holderSessionId === a1.id);
  db.setProcessState(a1.id, "live"); // restore for later scenarios' own sanity, though agentA isn't reused below

  // ============================ (e) PHANTOM-LIVE NEGATIVE CONTROL ====================================
  // A session row inserted DIRECTLY (never spawned through the host) reads processState "live" in the
  // DB but is NOT alive per the pty — it must never block a fresh start for that agent.
  db.insertSession({
    id: "phantomRow", projectId: "pMgr", agentId: "agentPhantom", engineSessionId: "eng-phantom", title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null,
  });
  check("(e-setup) the phantom row reads 'live' in the DB but its pty is NOT alive",
    db.getSession("phantomRow")?.processState === "live" && host.isAlive("phantomRow") === false);
  let threwE = null;
  let sessionE = null;
  try { sessionE = svc.startManager("agentPhantom"); } catch (e) { threwE = e; }
  check("(e) a phantom-live row (pty dead) does NOT block a fresh start",
    threwE === null && sessionE?.role === "manager" && sessionE?.processState === "live");

  // ============================ (f) RECYCLE SUCCESSOR+PREDECESSOR COEXISTENCE ========================
  // Card 8e84a403 (Code Review): the guard has NO `hasSuccessor` exemption any more — a halted recycle
  // leaves `hasSuccessor(predecessor)` permanently true over a predecessor that is the real live owner
  // (see (f2) below), so excluding a row on that basis alone is unsafe. During the ordinary brief
  // coexistence window BOTH predecessor and successor are alive; a third start is still correctly
  // refused — it just names WHICHEVER live manager the scan finds first, not specifically the successor.
  const f1 = svc.startManager("agentRecycle");
  check("(f-setup) agentRecycle's first manager is live", f1.processState === "live" && host.isAlive(f1.id));
  const f2 = await svc.recycleManager(f1.id, "handoff — continue from here");
  check("(f-setup) recycleManager minted a successor; BOTH predecessor and successor are alive, predecessor hasSuccessor",
    f2.id !== f1.id && host.isAlive(f1.id) && host.isAlive(f2.id) && db.hasSuccessor(f1.id) === true);
  let threwF = null;
  try { svc.startManager("agentRecycle"); } catch (e) { threwF = e; }
  check("(f) a THIRD start during the predecessor+successor coexistence window is refused, naming A live manager for this agent",
    threwF instanceof SecondLiveManagerError && [f1.id, f2.id].includes(threwF.holderSessionId));

  // ============== (f2) HALTED RECYCLE — the hole the hasSuccessor exemption used to open =============
  // Mirrors recycleManager's real HALT shape (@decision f1969787): the predecessor is NEVER stopped, the
  // successor dies before reaching ready, a `recycle_ownership_transfer_failed` event is filed
  // (workerSessionId: predecessor, managerSessionId: successor — see service.ts's own comment on that
  // field), and `hasSuccessor(predecessor)` stays true FOREVER (never nulled, unlike the pre-spawn-throw
  // path). The predecessor is the one genuine live owner; a fresh start must refuse naming IT.
  const f2pred = svc.startManager("agentHalt");
  check("(f2-setup) agentHalt's manager is live", f2pred.processState === "live" && host.isAlive(f2pred.id));
  db.insertSession({
    id: "f2HaltedSuccessor", projectId: "pMgr", agentId: "agentHalt", engineSessionId: "eng-f2-halted", title: null,
    cwd: repo, processState: "exited", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager", parentSessionId: null,
    recycledFrom: f2pred.id,
  });
  db.appendEvent({
    id: "evtF2OwnershipFailed", ts: new Date().toISOString(),
    managerSessionId: "f2HaltedSuccessor", workerSessionId: f2pred.id, kind: "recycle_ownership_transfer_failed",
    detail: { recycledFrom: f2pred.id, gen: 1, failedSteps: ["workers"] },
  });
  check("(f2-setup) the halted successor is exited, NOT alive, yet hasSuccessor(predecessor) stays true",
    db.getSession("f2HaltedSuccessor")?.processState === "exited" && host.isAlive("f2HaltedSuccessor") === false &&
    db.hasSuccessor(f2pred.id) === true);
  let threwF2 = null;
  try { svc.startManager("agentHalt"); } catch (e) { threwF2 = e; }
  check("(f2) a fresh start after a HALTED recycle is refused, naming the PREDECESSOR (the real live owner, not excluded despite hasSuccessor)",
    threwF2 instanceof SecondLiveManagerError && threwF2.holderSessionId === f2pred.id);

  // ============================ (g) STOP THEN RETRY ===================================================
  const g1 = svc.startManager("agentStop");
  check("(g-setup) agentStop's manager is live and alive", g1.processState === "live" && host.isAlive(g1.id));
  host.stop(g1.id); // genuinely stop the pty (mirrors a real Ctrl-C/kill — isAlive flips false)
  check("(g-setup) after stop(), its pty reads NOT alive", host.isAlive(g1.id) === false);
  let threwG = null;
  let sessionG = null;
  try { sessionG = svc.startManager("agentStop"); } catch (e) { threwG = e; }
  check("(g) once the holder genuinely stops, a fresh start for the SAME agent succeeds",
    threwG === null && sessionG?.id !== g1.id && sessionG?.role === "manager");

  // ============================ (h) WORKER NEGATIVE CONTROL ===========================================
  // Many LIVE "worker"-role sessions under the SAME agentId are untouched — the guard only ever checks
  // role==="manager" (startNew's call site is gated on `role === "manager"`).
  for (const [id, eng] of [["worker1", "eng-w1"], ["worker2", "eng-w2"], ["worker3", "eng-w3"]]) {
    db.insertSession({
      id, projectId: "pMgr", agentId: "agentWorker", engineSessionId: eng, title: null,
      cwd: repo, processState: "live", resumability: "unknown", busy: false,
      createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: f1.id,
    });
    host.aliveIds.add(id); // genuinely alive, same as a real worker
  }
  check("(h-setup) three LIVE worker-role sessions exist under agentWorker",
    db.listSessions("agentWorker").filter((s) => s.role === "worker" && s.processState === "live").length === 3);
  let threwH = null;
  let sessionH = null;
  try { sessionH = svc.startNew("agentWorker"); } catch (e) { threwH = e; } // role-less profile ⇒ resolves undefined, not "manager"
  check("(h) startNew against an agent with 3 live workers is NOT refused by the manager-singleton guard (role never resolves to manager here)",
    threwH === null && sessionH?.role === undefined);

  // ============================ (i) WORKSPACE-AUDITOR NEGATIVE CONTROL ================================
  const i1 = svc.startWorkspaceAuditor("agentWsAudit");
  const i2 = svc.startWorkspaceAuditor("agentWsAudit");
  check("(i) startWorkspaceAuditor stays CREATE-ONLY — two calls mint two distinct rows, unaffected by this guard",
    i1.id !== i2.id && db.listSessions("agentWsAudit").filter((s) => s.role === "workspace-auditor").length === 2);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — startManager/startNew refuse a second live-or-starting manager for the same agent, naming a live holder; a phantom-live row (pty dead) never blocks; the ordinary recycle coexistence window still refuses (naming whichever live manager is found); a HALTED recycle's never-stopped predecessor still blocks despite hasSuccessor staying permanently true; a genuinely-stopped holder releases the slot; workers and workspace-auditor are unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
