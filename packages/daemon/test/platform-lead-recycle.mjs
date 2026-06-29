import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform Lead SELF-RECYCLE (card 5bb91d07) — the platform analogue of the manager's recycle_me.
// recyclePlatformLead finalises the current Lead and boots its successor in ONE operation. Recycle is a
// PER-LINEAGE 1→1 replacement (NOT a global singleton — multiple live Leads may coexist via Spawn): this
// test proves a recycle never leaves a lineage with two live rows, and double-recycle is refused.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like platform-lead-multi.mjs: a REAL Db +
// SessionService driven against a FAKE pty (createPty/stop seam). A real temp git repo backs the spawn
// cwd; the only thing faked is the claude pty.
//
// PROVES the DoD:
//   (1) self-recycle → EXACTLY ONE live Lead afterward (the successor); predecessor EXITED; successor is
//       a fresh row (new id), role platform, recycledFrom = predecessor, gen+1; a fresh pty spawned with
//       the agent warm-up + the continuation (a normal pickup); hasSuccessor(predecessor) === true so
//       crash-recovery can never resurrect it.
//   (2) NO ORPHAN — the predecessor's pty is hard-stopped on the deferred (3s) teardown.
//   (3) LINEAGE HANDOFF IS ATOMIC + IDEMPOTENT:
//         (3a) at NO observable point does this lineage have two live rows (before/after the synchronous
//              critical section there are exactly 1 / 1; mid-transition is unobservable on the single-
//              threaded loop, which is the whole point of the no-await retire->spawn).
//         (3b) a post-recycle startPlatformLead (a human Spawn) is CREATE-ONLY — it mints a NEW live Lead
//              (NO reuse of the successor), so two live Leads coexist. The live-reuse short-circuit is gone.
//         (3c) a DOUBLE recycle_me on the same predecessor (a double tool-call) is REFUSED — it would
//              otherwise spawn a SECOND successor for that lineage; hasSuccessor makes the second call throw.
//   (4) FAIL-SAFE GUARDS — a blank continuation and a non-platform caller are both refused BEFORE any
//       teardown (predecessor untouched, no successor, no recycle_begin), so a bad call never destroys
//       the live Lead.
//   (5) CHAIN — recycling the successor again yields gen+2 and still EXACTLY ONE live Lead in that lineage.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-lead-recycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-lead-recycle-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// --- a real temp git repo so a spawn has a valid cwd (createPty is faked → no real claude) ---
const repo = path.join(os.tmpdir(), `loom-lead-recycle-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# platform lead self-recycle test repo\n");
execSync(`git init -q && git add . && git -c user.email=lr@loom -c user.name=lr commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Platform", startupPrompt: "LEAD WARMUP BRIEF", position: 0, profileId: null });
db.insertAgent({ id: "agentMgr", projectId: "pHome", name: "Mgr", startupPrompt: "MGR", position: 1, profileId: null });

// Fake pty: capture createPty (spawn) + stop calls; no real claude, no real signals.
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.spawned = []; this.stopped = []; }
  createPty(opts) { this.spawned.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop(id, mode) { this.stopped.push({ id, mode }); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const liveLeads = (agentId) => db.liveSessions(agentId).filter((s) => s.role === "platform");
const platformRows = (agentId) => db.listSessions(agentId).filter((s) => s.role === "platform");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ============================ (1) self-recycle → exactly ONE live Lead afterward ====================
  // Seed a LIVE Lead (the predecessor) — exactly as the human REST startPlatformLead would have created.
  const pred = svc.startPlatformLead("agentLead");
  check("(setup) one live Lead before recycle", liveLeads("agentLead").length === 1 && pred.processState === "live");
  const spawnsBefore = host.spawned.length;

  const succ = await svc.recyclePlatformLead(pred.id, "HANDOFF: 3 projects stood up; backlog drained; next wire X");

  // The CORE invariant — asserted SYNCHRONOUSLY right after the (await-free critical-section) call returns.
  check("(1) EXACTLY ONE live Lead afterward (the successor)", liveLeads("agentLead").length === 1);
  check("(1) the one live Lead IS the successor", liveLeads("agentLead")[0]?.id === succ.id);
  check("(1) successor is a NEW row (different id from the predecessor)", succ.id !== pred.id);
  check("(1) successor is live + role platform", succ.processState === "live" && succ.role === "platform" && db.getSession(succ.id)?.role === "platform");
  check("(1) predecessor is EXITED", db.getSession(pred.id)?.processState === "exited");
  check("(1) successor.recycledFrom = predecessor; gen incremented", db.getSession(succ.id)?.recycledFrom === pred.id && (succ.gen ?? 0) === (pred.gen ?? 0) + 1);
  check("(1) hasSuccessor(predecessor) → true (crash-recovery can never resurrect it)", db.hasSuccessor(pred.id) === true);
  check("(1) exactly TWO platform rows now (the exited predecessor + the live successor)", platformRows("agentLead").length === 2);
  // a FRESH spawn (no resumeId — brand-new platform session) carrying the agent warm-up + the continuation
  check("(1) a fresh pty spawned for the successor (role platform, no resumeId)",
    host.spawned.length === spawnsBefore + 1 && host.spawned.at(-1).sessionId === succ.id && host.spawned.at(-1).role === "platform" && host.spawned.at(-1).resumeId === undefined);
  const succPrompt = host.spawned.at(-1).startupPrompt ?? "";
  check("(1) successor startupPrompt carries the agent warm-up (identity inherited)", succPrompt.includes("LEAD WARMUP BRIEF"));
  check("(1) successor startupPrompt carries the continuation handoff (a normal pickup)", succPrompt.includes("HANDOFF: 3 projects stood up") && succPrompt.includes("[loom:continuation]"));
  // recycle_begin is filed under the predecessor, recycle_complete under the successor (managerSessionId
  // column — listEvents, not listEventsForWorker which keys on worker_session_id). Mirrors recycleManager.
  check("(1) recycle_begin + recycle_complete events recorded (kind platform)",
    db.listEvents(pred.id).some((e) => e.kind === "recycle_begin" && e.detail?.kind === "platform") &&
    db.listEvents(succ.id).some((e) => e.kind === "recycle_complete" && e.detail?.kind === "platform"));

  // ============================ (3c) DOUBLE recycle_me on the predecessor is REFUSED ==================
  // A second recycle_me on the SAME predecessor (a double tool-call) must NOT spawn a second successor —
  // that would be two live Leads. hasSuccessor(predecessor) makes it throw, no spawn, no extra row.
  const spawnsBeforeDouble = host.spawned.length;
  let doubleErr = null;
  try { await svc.recyclePlatformLead(pred.id, "second handoff — should be refused"); } catch (e) { doubleErr = e.message; }
  check("(3c) double recycle on the predecessor is REFUSED (already recycled)", doubleErr === "this Lead has already been recycled — its successor is live");
  check("(3c) double recycle spawned NOTHING (no second successor)", host.spawned.length === spawnsBeforeDouble);
  check("(3c) STILL exactly one live Lead after the refused double recycle", liveLeads("agentLead").length === 1 && liveLeads("agentLead")[0]?.id === succ.id);

  // ============================ (3b) post-recycle Spawn is CREATE-ONLY (no reuse) =====================
  // The live-reuse short-circuit is GONE: a human Spawn (startPlatformLead) now ALWAYS mints a FRESH Lead,
  // even with a live successor present — so multiple live Leads may coexist. (Recycle stays per-lineage
  // 1→1; this Spawn opens a NEW lineage and does not touch the successor's.)
  const spawnsBeforeSpawn = host.spawned.length;
  const extra = svc.startPlatformLead("agentLead");
  check("(3b) post-recycle Spawn mints a NEW Lead (NO reuse of the live successor)", extra.id !== succ.id && extra.processState === "live");
  check("(3b) post-recycle Spawn created a NEW row + a fresh spawn", platformRows("agentLead").length === 3 && host.spawned.length === spawnsBeforeSpawn + 1);
  check("(3b) TWO live Leads now coexist (the successor + the freshly-spawned Lead)", liveLeads("agentLead").length === 2);
  // Retire the extra Lead so the lineage-chain assertions below operate on the successor's single lineage.
  db.setProcessState(extra.id, "exited");
  check("(3b) after retiring the extra Lead, exactly one live Lead remains (the successor)",
    liveLeads("agentLead").length === 1 && liveLeads("agentLead")[0]?.id === succ.id);

  // ============================ (5) CHAIN — recycle the successor again ===============================
  const succ2 = await svc.recyclePlatformLead(succ.id, "SECOND HANDOFF: continue from here");
  check("(5) chained recycle → gen+2", (succ2.gen ?? 0) === (pred.gen ?? 0) + 2);
  check("(5) chained recycle → STILL exactly one live Lead (the newest successor)", liveLeads("agentLead").length === 1 && liveLeads("agentLead")[0]?.id === succ2.id);
  check("(5) the first successor is now exited + has its own successor", db.getSession(succ.id)?.processState === "exited" && db.hasSuccessor(succ.id) === true);

  // ============================ (4) FAIL-SAFE GUARDS (no teardown on a bad call) ======================
  // Blank continuation → refused BEFORE any teardown: the live Lead stays live, gains no successor.
  const liveNow = liveLeads("agentLead")[0]; // succ2
  const beginsBefore = db.listEvents(liveNow.id).filter((e) => e.kind === "recycle_begin").length;
  const spawnsBeforeBlank = host.spawned.length;
  for (const blank of ["", "   ", "\n\t "]) {
    let threw = null;
    try { await svc.recyclePlatformLead(liveNow.id, blank); } catch (e) { threw = e.message; }
    check(`(4) blank continuation refused (${JSON.stringify(blank)})`, threw === "continuationPrompt must not be blank");
  }
  check("(4) FAIL-SAFE: the live Lead was NOT torn down by the blank calls (still live, no successor)",
    db.getSession(liveNow.id)?.processState === "live" && db.hasSuccessor(liveNow.id) === false);
  check("(4) FAIL-SAFE: no recycle_begin recorded + nothing spawned for the refused blank calls",
    db.listEvents(liveNow.id).filter((e) => e.kind === "recycle_begin").length === beginsBefore && host.spawned.length === spawnsBeforeBlank);

  // Non-platform caller → refused. Spawn a plain manager and try to recycle it AS a Lead.
  const mgr = svc.startManager("agentMgr");
  let mgrErr = null;
  try { await svc.recyclePlatformLead(mgr.id, "not a lead"); } catch (e) { mgrErr = e.message; }
  check("(4) non-platform caller refused ('not a platform session')", mgrErr === "not a platform session");
  check("(4) the manager was untouched (still live, no successor)", db.getSession(mgr.id)?.processState === "live" && db.hasSuccessor(mgr.id) === false);
  check("(4) STILL exactly one live Lead after the bad calls", liveLeads("agentLead").length === 1 && liveLeads("agentLead")[0]?.id === succ2.id);

  // ============================ (2) NO ORPHAN — deferred hard-stop of every retired predecessor =======
  // The retired predecessors' ptys are hard-stopped on a 3s defer (so the recycle_me response flushes
  // first). Wait past the defer and confirm both retired predecessors were hard-stopped — no orphan pty.
  await sleep(3200);
  check("(2) predecessor pty hard-stopped on the deferred teardown (no orphan)",
    host.stopped.some((s) => s.id === pred.id && s.mode === "hard"));
  check("(2) the first successor's pty hard-stopped on the chained recycle's deferred teardown (no orphan)",
    host.stopped.some((s) => s.id === succ.id && s.mode === "hard"));
  check("(2) the LIVE successor was NEVER stopped", !host.stopped.some((s) => s.id === succ2.id));
  check("(2) FINAL: still exactly one live Lead after teardown settles", liveLeads("agentLead").length === 1 && liveLeads("agentLead")[0]?.id === succ2.id);
} finally {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recyclePlatformLead: atomic retire-then-spawn keeps EXACTLY ONE live Lead PER LINEAGE, successor inherits identity + a normal pickup, predecessor cleanly retired (no orphan), double-recycle refused; a post-recycle Spawn is create-only (mints a NEW Lead — multiple live Leads may coexist)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
