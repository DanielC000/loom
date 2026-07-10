import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Codescape wiring epic `369dde3c`, card C3 — fire register/reingest/drop lifecycle hooks. DETERMINISTIC +
// CLAUDE-FREE (a fake pty stub) + NETWORK-FREE (a spy CodescapeSupervisor duck-type injected via
// SessionService's `opts.codescape`, mirroring codescape-mcp-spawn.mjs's C2 test), but a REAL Db + REAL
// git worktree ops (mirroring worktree-process-reap.mjs) so spawnWorker/confirmWorkerMerge/gcWorktreeDir
// run for real end-to-end.
//
// Proves the DoD:
//   (1) register fires on spawnWorker, AFTER createWorktree resolves, with a non-empty baseRef
//       (= the branch name) and worktreeId === codescapeWorktreeId(taskId) — but is SKIPPED for a
//       taskless spawn (no stable id to register).
//   (2) reingest fires after finalizeMerge succeeds, on BOTH the Green (normal squash) path and the
//       ALREADY_MERGED (idempotent re-confirm) path — and is BACKGROUNDED: confirmWorkerMerge/finalizeMerge
//       resolve BEFORE the fake's artificial delay elapses, proving it is never awaited inline.
//   (3) drop fires when gcWorktreeDir GENUINELY removes a worktree (post-merge), with the SAME worktreeId
//       used at register — but NEVER fires for recycleWorker (which reuses the worktree, never calling
//       gcWorktreeDir at all).
//   (4) NEGATIVE CASE: LOOM_DEV off, OR the project not codescape-enabled, ⇒ the spy client is called
//       ZERO times across an equivalent spawn/merge/gc lifecycle — byte-identical otherwise.
//
// Run: 1) build daemon, 2) node test/codescape-lifecycle-hooks.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

// --- Hermetic LOOM_HOME + sandboxed HOME (mirrors codescape-mcp-spawn.mjs) — set BEFORE importing dist. ---
const tmpHome = path.join(os.tmpdir(), `loom-clh-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.LOOM_DEV;
delete process.env.LOOM_CODESCAPE_ENABLED;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { taskKey, codescapeWorktreeId } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_ID = "-c user.email=clh@loom -c user.name=clh";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function initRepo(repo, readme) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), readme);
  execSync(`git init -q && git config user.email clh@loom && git config user.name clh && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// A spy CodescapeSupervisor duck-type — only the 3 methods C3 calls. `reingestMain` artificially delays
// so the test can prove finalizeMerge never awaits it inline (proof (2) above).
function makeFakeCodescape() {
  const calls = { register: [], reingest: [], drop: [] };
  let reingestInFlight = 0;
  return {
    calls,
    getPort: () => 5555,
    reingestInFlightCount: () => reingestInFlight,
    async registerWorktree(projectId, info) { calls.register.push({ projectId, ...info }); return { ok: true }; },
    async reingestMain(projectId) {
      reingestInFlight++;
      calls.reingest.push({ projectId });
      await sleep(2000); // stands in for the real ~9-11s synchronous server-side reingest — long enough
                          // that even a slow real git merge/gc finishes well within this window.
      reingestInFlight--;
      return { ok: true };
    },
    async dropWorktree(projectId, worktreeId) { calls.drop.push({ projectId, worktreeId }); return { ok: true }; },
  };
}

function seedProject(db, p) {
  db.insertProject({ id: p.projId, name: p.projId, repoPath: p.repo, vaultPath: p.repo, config: p.config ?? {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.mgrAgentId, projectId: p.projId, name: "Mgr", startupPrompt: "", position: 0, profileId: null });
  db.insertAgent({ id: p.workerAgentId, projectId: p.projId, name: "Worker", startupPrompt: "", position: 1, profileId: null });
}

// A real PtyHost with ONLY createPty (the actual claude/node-pty spawn) and isAlive faked out — mirrors
// codescape-mcp-spawn.mjs's SeamHost, needed here because startManager/spawnWorker/recycleWorker all
// drive `this.pty.spawn(...)` (a real PtyHost method), not just the narrow stop/enqueue surface.
class SeamHost extends PtyHost {
  createPty(opts) { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  isAlive() { return false; }
}
function makeHost(db) {
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  return new SeamHost(events);
}

// ===================== (1)-(3) POSITIVE: LOOM_DEV=1 + LOOM_CODESCAPE_ENABLED=1 + project opted in =====================
{
  process.env.LOOM_DEV = "1";
  process.env.LOOM_CODESCAPE_ENABLED = "1";
  const fake = makeFakeCodescape();
  const db = new Db();
  const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
    codescape: fake,
    reapWorktreeProcesses: async () => ({ killedPids: [] }), // no real OS process enumeration needed here
  });

  // maxConcurrentWorkers raised: this test spawns 4 workers under ONE manager, and the fake pty never
  // fires a real onExit (no live process), so a merged/retired worker's row never flips off "live" — the
  // default cap of 3 would reject the later spawns for a reason unrelated to what's under test here.
  const P = { projId: `clh-pos-${sfx}`, mgrAgentId: `clh-pos-mgr-${sfx}`, workerAgentId: `clh-pos-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-clh-pos-${sfx}`), config: { codescape: { enabled: true }, orchestration: { maxConcurrentWorkers: 10 } } };
  initRepo(P.repo, "# clh positive\n");
  seedProject(db, P);

  try {
    const mgr = sessions.startManager(P.mgrAgentId);

    // --- (1) register fires on a TASKED spawn, AFTER createWorktree resolves ---
    const taskId = `clh-task-${sfx}`;
    db.insertTask({ id: taskId, projectId: P.projId, title: "CLH task", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const worker = await sessions.spawnWorker(mgr.id, { taskId, agentId: P.workerAgentId, kickoffPrompt: "GO" });
    const expectedWorktreeId = codescapeWorktreeId(taskId);

    check("(1) register fired exactly once for the tasked spawn", fake.calls.register.length === 1);
    const reg = fake.calls.register[0];
    check("(1) register: projectId matches", reg?.projectId === P.projId);
    check("(1) register: worktreeId === codescapeWorktreeId(taskId) === taskKey(taskId)", reg?.worktreeId === expectedWorktreeId && reg?.worktreeId === taskKey(taskId));
    check("(1) register: path === the real worktree path", reg?.path === worker.worktreePath);
    check("(1) register: baseRef is a non-empty string (the branch name)", typeof reg?.baseRef === "string" && reg.baseRef.length > 0 && reg.baseRef === worker.branch);

    // --- (1b) register is SKIPPED for a taskless spawn (no stable worktreeId) ---
    const registerCountBeforeTaskless = fake.calls.register.length;
    const taskless = await sessions.spawnWorker(mgr.id, { agentId: P.workerAgentId, kickoffPrompt: "SPIKE" });
    check("(1b) register did NOT fire for a taskless spawn (codescapeWorktreeId is null)", fake.calls.register.length === registerCountBeforeTaskless);

    // --- (2)+(3) confirmWorkerMerge (Green path): reingest fires BACKGROUNDED, drop fires with the SAME worktreeId ---
    fs.writeFileSync(path.join(worker.worktreePath, "change.txt"), "worker change\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "change.txt"`, { cwd: worker.worktreePath });
    const reingestCountBefore = fake.calls.reingest.length;
    const confirm = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(2) confirmWorkerMerge (Green) lands the merge", confirm.merged === true);
    check("(2) reingest fired after the Green-path merge", fake.calls.reingest.length === reingestCountBefore + 1);
    check("(2) reingest: projectId matches", fake.calls.reingest[fake.calls.reingest.length - 1]?.projectId === P.projId);
    // Proves "not awaited inline" robustly (no elapsed-time margin to flake on a loaded runner): if
    // finalizeMerge awaited reingestMain inline, confirmWorkerMerge could not have already resolved above
    // while the fake's 2000ms delay is still in flight.
    check("(2) reingest was still IN FLIGHT right after confirmWorkerMerge resolved (proves it wasn't awaited inline)", fake.reingestInFlightCount() > 0);
    await sleep(2200); // let the backgrounded reingest actually settle before asserting on it further
    check("(2) reingest eventually settles (best-effort, not lost)", fake.reingestInFlightCount() === 0);

    check("(3) the merged worktree was genuinely removed", !fs.existsSync(worker.worktreePath));
    check("(3) drop fired exactly once after the genuine removal", fake.calls.drop.length === 1);
    check("(3) drop: worktreeId === the SAME id used at register", fake.calls.drop[0]?.worktreeId === expectedWorktreeId);
    check("(3) drop: projectId matches", fake.calls.drop[0]?.projectId === P.projId);

    // --- (2b) ALREADY_MERGED path (a stale re-confirm on the already-fully-merged `worker`) also fires
    //     reingest — both the Green path (above) and ALREADY_MERGED converge in the SAME finalizeMerge ---
    const registerCountBeforeRestale = fake.calls.register.length;
    const reingestCountBeforeAM = fake.calls.reingest.length;
    const confirmAgain = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(2b) a stale re-confirm resolves ALREADY_MERGED", confirmAgain.merged === true && confirmAgain.emptyKind === "ALREADY_MERGED");
    check("(2b) register never re-fires on a re-confirm", fake.calls.register.length === registerCountBeforeRestale);
    await sleep(2200); // let the ALREADY_MERGED path's backgrounded reingest settle
    check("(2b) reingest fired again for the ALREADY_MERGED path", fake.calls.reingest.length === reingestCountBeforeAM + 1);

    // --- (4) recycleWorker NEVER fires drop (the worktree persists — gcWorktreeDir is never called) ---
    const taskId3 = `clh-task3-${sfx}`;
    db.insertTask({ id: taskId3, projectId: P.projId, title: "CLH task 3", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });
    const worker3 = await sessions.spawnWorker(mgr.id, { taskId: taskId3, agentId: P.workerAgentId, kickoffPrompt: "GO" });
    const dropCountBeforeRecycle = fake.calls.drop.length;
    const registerCountBeforeRecycle = fake.calls.register.length;
    await sessions.recycleWorker(mgr.id, worker3.id, "handoff: continue the work");
    check("(4) recycleWorker never fires drop", fake.calls.drop.length === dropCountBeforeRecycle);
    check("(4) recycleWorker never fires a fresh register (same worktree reused)", fake.calls.register.length === registerCountBeforeRecycle);
    check("(4) recycled worker's worktree still exists on disk (reused, not removed)", fs.existsSync(worker3.worktreePath));
    // cleanup worker3's worktree by hand (not merged in this test)
    try { fs.rmSync(worker3.worktreePath, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  } finally {
    db.close();
    try { fs.rmSync(P.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.LOOM_DEV;
    delete process.env.LOOM_CODESCAPE_ENABLED;
  }
}

// ===================== (5) NEGATIVE CASE: LOOM_DEV off ⇒ zero hooks fire across the same lifecycle =====================
{
  delete process.env.LOOM_DEV;
  delete process.env.LOOM_CODESCAPE_ENABLED;
  const fake = makeFakeCodescape();
  const db = new Db();
  const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
    codescape: fake,
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
  });
  const N = { projId: `clh-neg-devoff-${sfx}`, mgrAgentId: `clh-neg-devoff-mgr-${sfx}`, workerAgentId: `clh-neg-devoff-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-clh-neg-devoff-${sfx}`), config: { codescape: { enabled: true } } };
  initRepo(N.repo, "# clh negative devoff\n");
  seedProject(db, N);
  try {
    const mgr = sessions.startManager(N.mgrAgentId);
    const taskId = `clh-neg-devoff-task-${sfx}`;
    db.insertTask({ id: taskId, projectId: N.projId, title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const worker = await sessions.spawnWorker(mgr.id, { taskId, agentId: N.workerAgentId, kickoffPrompt: "GO" });
    fs.writeFileSync(path.join(worker.worktreePath, "change.txt"), "worker change\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "change.txt"`, { cwd: worker.worktreePath });
    const confirm = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(5) LOOM_DEV off: merge still lands normally (byte-identical lifecycle)", confirm.merged === true);
    await sleep(50);
    check("(5) LOOM_DEV off: register never fired", fake.calls.register.length === 0);
    check("(5) LOOM_DEV off: reingest never fired", fake.calls.reingest.length === 0);
    check("(5) LOOM_DEV off: drop never fired (even though the worktree WAS genuinely removed)",
      !fs.existsSync(worker.worktreePath) && fake.calls.drop.length === 0);
  } finally {
    db.close();
    try { fs.rmSync(N.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ===================== (6) NEGATIVE CASE: LOOM_DEV+LOOM_CODESCAPE_ENABLED on, but project NOT opted in =====================
{
  process.env.LOOM_DEV = "1";
  process.env.LOOM_CODESCAPE_ENABLED = "1";
  const fake = makeFakeCodescape();
  const db = new Db();
  const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
    codescape: fake,
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
  });
  const N = { projId: `clh-neg-notenabled-${sfx}`, mgrAgentId: `clh-neg-notenabled-mgr-${sfx}`, workerAgentId: `clh-neg-notenabled-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-clh-neg-notenabled-${sfx}`), config: {} };
  initRepo(N.repo, "# clh negative not-enabled\n");
  seedProject(db, N);
  try {
    const mgr = sessions.startManager(N.mgrAgentId);
    const taskId = `clh-neg-notenabled-task-${sfx}`;
    db.insertTask({ id: taskId, projectId: N.projId, title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const worker = await sessions.spawnWorker(mgr.id, { taskId, agentId: N.workerAgentId, kickoffPrompt: "GO" });
    fs.writeFileSync(path.join(worker.worktreePath, "change.txt"), "worker change\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "change.txt"`, { cwd: worker.worktreePath });
    const confirm = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(6) project not codescape-enabled: merge still lands normally", confirm.merged === true);
    await sleep(50);
    check("(6) project not enabled: register never fired", fake.calls.register.length === 0);
    check("(6) project not enabled: reingest never fired", fake.calls.reingest.length === 0);
    check("(6) project not enabled: drop never fired (even though the worktree WAS genuinely removed)",
      !fs.existsSync(worker.worktreePath) && fake.calls.drop.length === 0);
  } finally {
    db.close();
    try { fs.rmSync(N.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.LOOM_DEV;
    delete process.env.LOOM_CODESCAPE_ENABLED;
  }
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape lifecycle hooks (card C3): register fires after createWorktree resolves in spawnWorker (skipped for a taskless spawn), with a non-empty baseRef and worktreeId === codescapeWorktreeId(taskId); reingest fires after finalizeMerge succeeds on BOTH the Green and ALREADY_MERGED paths, backgrounded (never awaited inline); drop fires only on a GENUINE gcWorktreeDir removal with the SAME worktreeId, and NEVER on a recycleWorker reuse; and the negative case (LOOM_DEV off, or the project not opted in) fires zero hooks across an otherwise byte-identical spawn/merge/gc lifecycle."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
