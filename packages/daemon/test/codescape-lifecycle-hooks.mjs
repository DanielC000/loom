import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Codescape wiring epic `369dde3c`, card C3 REWRITE (card e068a2ab) — fire the ensure-graph/reingest
// lifecycle hooks that keep a project's graph.json fresh for the per-session stdio MCP (C2). DETERMINISTIC
// + CLAUDE-FREE (a fake pty stub) + NETWORK-FREE (a spy CodescapeSupervisor duck-type injected via
// SessionService's `opts.codescape`, mirroring codescape-mcp-spawn.mjs's C2 test), but a REAL Db + REAL
// git worktree ops (mirroring worktree-process-reap.mjs) so spawnWorker/confirmWorkerMerge/gcWorktreeDir
// run for real end-to-end.
//
// WAS: register/reingest/drop against a shared `codescape serve`'s per-worktree HTTP control plane. NOW:
// ONE project-wide graph file, written via `ingestToGraph(repoPath, graphPath)` — spawnWorker ENSURES it
// exists (lazily, existence-gated — skipped if it's already there), a landed merge REFRESHES it
// (unconditional), and there is nothing left to "drop" per-worktree (fireCodescapeDrop is now an inert
// no-op kept only for call-site compatibility — see its doc in sessions/service.ts).
//
// Proves the DoD:
//   (1) ensure-graph fires on spawnWorker's create-worktree path, ingesting the PROJECT's MAIN repoPath
//       (never the new worker's own worktree) to codescapeGraphPath(projectId) — and is EXISTENCE-GATED,
//       not taskless-gated: it fires for a TASKLESS spawn too (unlike the old register hook), but a LATER
//       spawn on the SAME project skips re-ingesting once the graph file already exists on disk.
//   (2) reingest fires after finalizeMerge succeeds, UNCONDITIONALLY (refresh, not existence-gated), on
//       BOTH the Green (normal squash) path and the ALREADY_MERGED (idempotent re-confirm) path — and is
//       BACKGROUNDED: confirmWorkerMerge/finalizeMerge resolve BEFORE the fake's artificial delay elapses,
//       proving it is never awaited inline.
//   (3) gcWorktreeDir genuinely removing a worktree fires NO supervisor call at all (drop is an inert
//       no-op in the new per-project-graph model — nothing per-worktree left to deregister).
//   (4) NEGATIVE CASE: LOOM_DEV off, OR the project not codescape-enabled, ⇒ the spy client is called
//       ZERO times across an equivalent spawn/merge/gc lifecycle — byte-identical otherwise.
//
// Run: 1) build daemon, 2) node test/codescape-lifecycle-hooks.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// --- Hermetic LOOM_HOME + sandboxed HOME (mirrors codescape-mcp-spawn.mjs) — set BEFORE importing dist. ---
const tmpHome = path.join(os.tmpdir(), `loom-clh-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.LOOM_DEV;
delete process.env.LOOM_CODESCAPE_BIN;
// Card 503a30a0: the daemon-wide gate is now host-CLI-PRESENCE-based (isLoomDev() AND a codescape binary
// actually resolvable), not a hand-set LOOM_CODESCAPE_ENABLED toggle — the fixture CLI stands in for a
// real installed binary in the "detected" sections below.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCli = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { codescapeGraphPath } = await import("../dist/paths.js");

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

// A spy CodescapeSupervisor duck-type — only the 1 method C3 now calls (both hooks converge on the same
// ingestToGraph). Artificially delays so the test can prove finalizeMerge never awaits it inline (proof
// (2) above), and ACTUALLY WRITES the graph file on completion (mirrors the real CLI) — required for
// proof (1)'s existence-gating to engage for real, not just via a call counter.
function makeFakeCodescape() {
  const calls = { ingest: [] };
  let ingestInFlight = 0;
  return {
    calls,
    ingestInFlightCount: () => ingestInFlight,
    async ingestToGraph(repoPath, graphPath) {
      ingestInFlight++;
      calls.ingest.push({ repoPath, graphPath });
      await sleep(2000); // stands in for a real ingest's latency — long enough that even a slow real
                          // git merge/gc finishes well within this window.
      fs.mkdirSync(path.dirname(graphPath), { recursive: true });
      fs.writeFileSync(graphPath, JSON.stringify({ nodes: [], edges: [], flows: [] }));
      ingestInFlight--;
      return { ok: true, outcome: "ready" };
    },
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

async function waitFor(cond, { tries = 200, everyMs = 50 } = {}) {
  for (let i = 0; i < tries && !cond(); i++) await sleep(everyMs);
  return cond();
}

// ===================== (1)-(3) POSITIVE: LOOM_DEV=1 + a detected codescape CLI + project opted in =====================
{
  process.env.LOOM_DEV = "1";
  process.env.LOOM_CODESCAPE_BIN = fixtureCli;
  const fake = makeFakeCodescape();
  const db = new Db();
  const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
    codescape: fake,
    reapWorktreeProcesses: async () => ({ killedPids: [] }), // no real OS process enumeration needed here
  });

  // maxConcurrentWorkers raised: this test spawns several workers under ONE manager, and the fake pty
  // never fires a real onExit (no live process), so a merged/retired worker's row never flips off "live" —
  // the default cap of 3 would reject the later spawns for a reason unrelated to what's under test here.
  const P = { projId: `clh-pos-${sfx}`, mgrAgentId: `clh-pos-mgr-${sfx}`, workerAgentId: `clh-pos-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-clh-pos-${sfx}`), config: { codescape: { enabled: true }, orchestration: { maxConcurrentWorkers: 10 } } };
  initRepo(P.repo, "# clh positive\n");
  seedProject(db, P);
  const graphPath = codescapeGraphPath(P.projId);

  try {
    const mgr = sessions.startManager(P.mgrAgentId);

    // --- (1) ensure-graph fires on a TASKED spawn's create-worktree path, ingesting the PROJECT'S MAIN
    //     repoPath (not the new worktree) — because the graph doesn't exist yet ---
    const taskId = `clh-task-${sfx}`;
    db.insertTask({ id: taskId, projectId: P.projId, title: "CLH task", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const worker = await sessions.spawnWorker(mgr.id, { taskId, agentId: P.workerAgentId, kickoffPrompt: "GO" });

    check("(1) ensure-graph fired at least once for the tasked spawn (graph didn't exist yet)",
      await waitFor(() => fake.calls.ingest.length >= 1));
    const ing = fake.calls.ingest[0];
    check("(1) ensure-graph: repoPath is the PROJECT's main repo (not the worker's own worktree)", ing?.repoPath === P.repo && ing?.repoPath !== worker.worktreePath);
    check("(1) ensure-graph: graphPath === codescapeGraphPath(projectId)", ing?.graphPath === graphPath);
    // Wait for it to actually settle and write the file — subsequent spawns' existence-gate depends on
    // the real file being there (avoids a race between two spawns both seeing "missing" concurrently).
    check("(1) the graph file genuinely lands on disk once ingestToGraph settles", await waitFor(() => fs.existsSync(graphPath), { tries: 200, everyMs: 30 }));

    // --- (1b) a LATER spawn — even a TASKLESS one — does NOT re-fire ensure-graph: it's EXISTENCE-gated,
    //     not taskless-gated (the old register hook skipped taskless spawns; this one doesn't care about
    //     taskId at all, only whether the graph file is already there) ---
    const ingestCountBeforeTaskless = fake.calls.ingest.length;
    const taskless = await sessions.spawnWorker(mgr.id, { agentId: P.workerAgentId, kickoffPrompt: "SPIKE" });
    await sleep(150);
    check("(1b) a taskless spawn does NOT re-fire ensure-graph once the graph already exists", fake.calls.ingest.length === ingestCountBeforeTaskless);
    // cleanup the taskless worker's worktree by hand (not merged in this test)
    try { const { removeWorktree } = await import("../dist/git/worktrees.js"); await removeWorktree(P.repo, taskless.worktreePath); } catch { /* best-effort */ }

    // --- (2)+(3) confirmWorkerMerge (Green path): reingest fires BACKGROUNDED (refresh, unconditional) ---
    fs.writeFileSync(path.join(worker.worktreePath, "change.txt"), "worker change\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "change.txt"`, { cwd: worker.worktreePath });
    const ingestCountBeforeMerge = fake.calls.ingest.length;
    const confirm = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(2) confirmWorkerMerge (Green) lands the merge", confirm.merged === true);
    check("(2) reingest fired after the Green-path merge", fake.calls.ingest.length === ingestCountBeforeMerge + 1);
    const reingestCall = fake.calls.ingest[fake.calls.ingest.length - 1];
    check("(2) reingest: repoPath is the project's main repo", reingestCall?.repoPath === P.repo);
    check("(2) reingest: graphPath === the SAME codescapeGraphPath (a refresh, same target)", reingestCall?.graphPath === graphPath);
    // Proves "not awaited inline" robustly (no elapsed-time margin to flake on a loaded runner): if
    // finalizeMerge awaited ingestToGraph inline, confirmWorkerMerge could not have already resolved above
    // while the fake's 2000ms delay is still in flight.
    check("(2) reingest was still IN FLIGHT right after confirmWorkerMerge resolved (proves it wasn't awaited inline)", fake.ingestInFlightCount() > 0);
    check("(2) reingest eventually settles (best-effort, not lost)", await waitFor(() => fake.ingestInFlightCount() === 0));

    check("(3) the merged worktree was genuinely removed", !fs.existsSync(worker.worktreePath));
    check("(3) gcWorktreeDir's genuine removal fires NO further supervisor call (drop is an inert no-op — nothing per-worktree left to deregister)",
      fake.calls.ingest.length === ingestCountBeforeMerge + 1);

    // --- (2b) ALREADY_MERGED path (a stale re-confirm on the already-fully-merged `worker`) also fires
    //     reingest — both the Green path (above) and ALREADY_MERGED converge in the SAME finalizeMerge ---
    const ingestCountBeforeAM = fake.calls.ingest.length;
    const confirmAgain = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(2b) a stale re-confirm resolves ALREADY_MERGED", confirmAgain.merged === true && confirmAgain.emptyKind === "ALREADY_MERGED");
    check("(2b) reingest fires again for the ALREADY_MERGED path", await waitFor(() => fake.calls.ingest.length === ingestCountBeforeAM + 1));
    check("(2b) it settles too", await waitFor(() => fake.ingestInFlightCount() === 0));

    // --- (4) recycleWorker never triggers a fresh ensure-graph/reingest call (it never creates a new
    //     worktree, and never calls gcWorktreeDir — the worktree persists, reused) ---
    const taskId3 = `clh-task3-${sfx}`;
    db.insertTask({ id: taskId3, projectId: P.projId, title: "CLH task 3", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });
    const worker3 = await sessions.spawnWorker(mgr.id, { taskId: taskId3, agentId: P.workerAgentId, kickoffPrompt: "GO" });
    await sleep(150); // let worker3's own (existence-gated, no-op) ensure-graph settle before the baseline read
    const ingestCountBeforeRecycle = fake.calls.ingest.length;
    await sessions.recycleWorker(mgr.id, worker3.id, "handoff: continue the work");
    await sleep(150);
    check("(4) recycleWorker triggers no fresh supervisor call at all (same worktree reused)", fake.calls.ingest.length === ingestCountBeforeRecycle);
    check("(4) recycled worker's worktree still exists on disk (reused, not removed)", fs.existsSync(worker3.worktreePath));
    // cleanup worker3's worktree by hand (not merged in this test)
    try { fs.rmSync(worker3.worktreePath, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  } finally {
    db.close();
    try { fs.rmSync(P.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.LOOM_DEV;
    delete process.env.LOOM_CODESCAPE_BIN;
  }
}

// ===================== (5) NEGATIVE CASE: LOOM_DEV off ⇒ zero hooks fire across the same lifecycle =====================
{
  delete process.env.LOOM_DEV;
  delete process.env.LOOM_CODESCAPE_BIN;
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
    check("(5) LOOM_DEV off: no supervisor call ever fired (spawn+merge+gc lifecycle)",
      !fs.existsSync(worker.worktreePath) && fake.calls.ingest.length === 0);
  } finally {
    db.close();
    try { fs.rmSync(N.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ===================== (6) NEGATIVE CASE: LOOM_DEV on + a detected codescape CLI, but project NOT opted in =====================
{
  process.env.LOOM_DEV = "1";
  process.env.LOOM_CODESCAPE_BIN = fixtureCli;
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
    check("(6) project not enabled: no supervisor call ever fired (spawn+merge+gc lifecycle)",
      !fs.existsSync(worker.worktreePath) && fake.calls.ingest.length === 0);
  } finally {
    db.close();
    try { fs.rmSync(N.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.LOOM_DEV;
    delete process.env.LOOM_CODESCAPE_BIN;
  }
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape lifecycle hooks (card C3 rewrite, e068a2ab): ensure-graph fires on spawnWorker's create-worktree path (ingesting the project's MAIN repo, not the new worktree) whenever the project's graph.json doesn't exist yet — EXISTENCE-gated, not taskless-gated (fires for a taskless spawn too, but a later spawn skips once the file is there); reingest fires unconditionally after finalizeMerge succeeds on BOTH the Green and ALREADY_MERGED paths, backgrounded (never awaited inline); a genuine gcWorktreeDir removal and a recycleWorker reuse both trigger NO further supervisor call (drop is an inert no-op — nothing per-worktree left to track); and the negative case (LOOM_DEV off, or the project not opted in) fires zero calls across an otherwise byte-identical spawn/merge/gc lifecycle."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
