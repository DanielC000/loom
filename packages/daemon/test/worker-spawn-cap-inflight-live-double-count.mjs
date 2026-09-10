import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn CONCURRENCY-CAP double-count (card 16637a9e — the LIVE-vs-IN-FLIGHT overlap the cap-axis
// TOCTOU fix (card c2cf86f8 / worker-spawn-cap-toctou-race.mjs) did NOT close).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService driven against a FAKE
// pty (createPty() seam), a real temp git repo behind createWorktree, and a MONKEYPATCHED GitReader.log
// (the same prototype-patch technique agent-runs-idempotency.mjs / codex-host-decisions.mjs already use)
// to deterministically freeze one spawn's post-live tail instead of racing on real timing.
//
// The bug: spawnWorker (sessions/service.ts) flips a worker row to processState:"live" (setProcessState,
// ~line 6122) BEFORE releasing that spawn's per-manager in-flight cap claim (inFlightSpawnCountByManager,
// released only in the outer `finally`, ~line 6249). Between those two points sits a real `await` — the
// wasted-dispatch advisory's `await findShippedCardMatch(...)` (~line 6230), which does a real async git
// read via GitReader. During that window the SAME spawn is counted TWICE by any OTHER concurrent
// worker_spawn's cap check: once via `liveWorkers` (the row is already live in the DB) and once via
// `inFlightForManager` (the claim is still held) — so `liveWorkers + inFlightForManager >= cap` over-counts
// by 1 per spawn currently in this tail, and a spawn that should admit (real usage is under cap) is
// wrongly rejected with "concurrency cap reached".
//
// Why DETERMINISTIC (no sleeps / no luck): GitReader.prototype.log is monkeypatched so the FIRST call
// (spawn A's own findShippedCardMatch) returns a promise this test holds open with an explicit `release()`
// — every other GitReader call (spawn A's own `.branches()`, and anything after release) runs unpatched.
// Spawn A is fired and awaited only up to the point it registers as live and enters that frozen await;
// spawn B (a DIFFERENT task, same manager) is then fired while A is provably stuck there. cap=2, only 1
// real live worker (A) exists at that instant — B must admit. On current (buggy) code it does not.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-spawn-cap-inflight-live-double-count.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wcapdc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { GitReader } = await import("../dist/git/reader.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-wcapdc-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-spawn-cap-inflight-live-double-count test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=ws@loom -c user.name=ws");

const CAP = 2;
const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: CAP } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const taskA = randomUUID();
const taskB = randomUUID();
db.insertTask({ id: taskA, projectId: "pP", title: "task A", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: taskB, projectId: "pP", title: "task B", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends createSeamHost(PtyHost) {}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

// --- freeze spawn A's own findShippedCardMatch (its FIRST GitReader.log call) until we release it ---
const originalLog = GitReader.prototype.log;
let release;
const gate = new Promise((res) => { release = res; });
let patchedCallsSeen = 0;
GitReader.prototype.log = function (...args) {
  patchedCallsSeen++;
  if (patchedCallsSeen === 1) return gate.then(() => originalLog.apply(this, args));
  return originalLog.apply(this, args);
};

const worktrees = [];
try {
  const spawnA = svc.spawnWorker("mgr1", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "GO A" });
  // Tracks whether spawnA has SETTLED (resolved or rejected) — code review finding: without this, a
  // future change that stops routing findShippedCardMatch through GitReader.log would let spawnA sail
  // through to completion while `aLive` (below) still reads true, making the whole test pass VACUOUSLY
  // (B would admit because A finished normally, not because of the double-count fix). Checked below,
  // BEFORE firing B, alongside `patchedCallsSeen` — both must show A is genuinely still frozen inside
  // the monkeypatch, not merely that its row happens to be live.
  let aSettled = false;
  spawnA.then(() => { aSettled = true; }, () => { aSettled = true; });

  // Poll (an OBSERVABLE event: A's own row flips live) — bounded, so a genuine regression (A's spawn
  // is stuck somewhere else entirely) surfaces as a loud, bounded failure rather than hanging forever.
  // Once this resolves, A is durably past setProcessState('live') and paused inside the monkeypatched
  // findShippedCardMatch await, held there by the still-unresolved `gate` promise.
  const deadline = Date.now() + 10_000;
  let aLive = false;
  while (Date.now() < deadline) {
    if (db.listLiveWorkers().some((w) => w.taskId === taskA)) { aLive = true; break; }
    await new Promise((r) => setTimeout(r, 5));
  }
  check("(setup precondition) spawn A reached processState:live while paused inside its own findShippedCardMatch await", aLive);
  check("(setup) exactly 1 real live worker exists at this moment", db.listLiveWorkers().filter((w) => w.parentSessionId === "mgr1").length === 1);
  // Code review finding: prove A is genuinely still frozen (not vacuously passing) BEFORE firing B —
  // both that its promise has not settled, and that the monkeypatch was actually entered.
  check("(setup precondition) spawn A has NOT settled yet — still paused inside the monkeypatched findShippedCardMatch await", !aSettled);
  check("(setup precondition) the monkeypatched GitReader.log was actually entered (patchedCallsSeen >= 1)", patchedCallsSeen >= 1);

  // ===================== the actual bug: B must admit — only 1 of 2 cap slots is really in use =====================
  let bResult, bError;
  try { bResult = await svc.spawnWorker("mgr1", { taskId: taskB, agentId: "agentDev", kickoffPrompt: "GO B" }); }
  catch (e) { bError = e; }

  check("spawn B (different task, cap=2, only 1 real live worker) is NOT rejected for the cap",
    !bError || !/concurrency cap reached/.test(String(bError.message)));
  if (bResult?.worktreePath) worktrees.push(bResult.worktreePath);
  check("spawn B actually landed as a live worker", !!bResult && bResult.role === "worker" && db.getSession(bResult.id)?.processState === "live");

  // release A so it can finish and clean up normally
  release();
  const a = await spawnA;
  if (a?.worktreePath) worktrees.push(a.worktreePath);
  check("spawn A itself still completed successfully once released", a?.role === "worker" && db.getSession(a.id)?.processState === "live");

  // ===================== (2) capacity.inFlight must reflect an OTHER spawn genuinely still in flight =====================
  // Regression pin for the fix's OWN companion change: releasing a spawn's cap claim EARLY (right after
  // it goes live, not in the outer `finally`) makes the spawn-success call site's OLD `excludeOwnClaim:
  // true` argument WRONG — by the time that call runs, THIS spawn's own claim is already gone, so
  // subtracting 1 for it would now wrongly eat into an UNRELATED spawn's still-genuinely-open claim
  // instead. Simulates "one OTHER spawn has claimed a cap slot but has not yet gone live" via the SAME
  // white-box technique worker-spawn-cap-queue.mjs already relies on for `inFlightSpawnTaskIds` (TS
  // `private` is erased at runtime) — deterministic, no second overlapping spawnWorker call needed to
  // pin THIS specific claim.
  const pP2 = "pP2", mgr2 = "mgr2";
  db.insertProject({ id: pP2, name: "P2", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 3 } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgr2", projectId: pP2, name: "Mgr2", startupPrompt: "MGR2", position: 0, profileId: null });
  db.insertAgent({ id: "agentDev2", projectId: pP2, name: "Dev2", startupPrompt: "DEV2", position: 1, profileId: null });
  db.insertSession({ id: mgr2, projectId: pP2, agentId: "agentMgr2", engineSessionId: null, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // one REAL live worker — a pure DB fact (synthetic row, no pty needed: getWorkerCapacity only reads the DB)
  db.insertSession({ id: "synthLive", projectId: pP2, agentId: "agentDev2", engineSessionId: null, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgr2, taskId: null });
  // one OTHER spawn's claim, held open with no real call behind it — same white-box access
  // worker-spawn-cap-queue.mjs already relies on.
  svc.inFlightSpawnCountByManager.set(mgr2, 1);

  const taskD = randomUUID();
  db.insertTask({ id: taskD, projectId: pP2, title: "task D", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  const spawnD = await svc.spawnWorker(mgr2, { taskId: taskD, agentId: "agentDev2", kickoffPrompt: "GO D" });
  if (spawnD?.worktreePath) worktrees.push(spawnD.worktreePath);

  check("(2) spawnD admits (cap=3: 1 real live + 1 simulated in-flight + spawnD itself = 3)", spawnD.role === "worker");
  check("(2) spawnD's OWN returned capacity.live counts BOTH real live workers (synthLive + spawnD)", spawnD.capacity?.live === 2);
  check("(2) spawnD's OWN returned capacity.inFlight reflects the OTHER still-open claim, EQUAL to it — never spawnD's own claim, which already resolved into `live`", spawnD.capacity?.inFlight === 1);
  check("(2) spawnD's OWN returned capacity.free is cap(3) - live(2) - inFlight(1) = 0", spawnD.capacity?.free === 0);

  // Code review finding (⭐ MEASURED GAP): the idempotence guard on `releaseCapSlotClaim` (it releases
  // once at live, then must be a no-op when the outer `finally` calls it again) is otherwise UNTESTED —
  // deleting `if (capSlotClaimReleased) return;` from the built dist left all six cap tests green. The
  // failure it permits: a double release would decrement `mgr2`'s count TWICE for spawnD's own single
  // claim (once early at live, once again in `finally`) — the second decrement has nothing of spawnD's
  // own left to consume, so it eats into the SIBLING simulated claim instead, dropping it to 0 even
  // though nothing about that sibling ever resolved. By the time `await svc.spawnWorker(...)` above
  // returned, spawnD's own `finally` has already run — so this assertion, checked NOW, is checked AFTER
  // exactly the moment a double release would have fired.
  check("(2) the sibling's still-open claim SURVIVES spawnD's own release (no double-release of spawnD's own claim)",
    svc.inFlightSpawnCountByManager.get(mgr2) === 1);

  svc.inFlightSpawnCountByManager.delete(mgr2); // don't leak the simulated claim past this scenario
} finally {
  GitReader.prototype.log = originalLog;
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [...new Set(worktrees.filter(Boolean))]) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? `\n✅ ALL PASS — while spawn A sits live but still holding its in-flight cap claim (frozen inside findShippedCardMatch), a second spawn for a DIFFERENT task on the same manager (cap=${CAP}, only 1 real live worker) still admits — no live+in-flight double-count.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
