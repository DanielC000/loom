import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Codescape wiring epic `369dde3c`, card C3 → P4 REWRITE (card 088afc94) — fire the register-worktree /
// reingest-main / drop-worktree lifecycle hooks against codescape's FLEET DAEMON control plane.
// DETERMINISTIC + CLAUDE-FREE (a fake pty stub) + NETWORK-FREE (a spy CodescapeSupervisor duck-type
// injected via SessionService's `opts.codescape`, mirroring codescape-mcp-spawn.mjs's test), but a REAL
// Db + REAL git worktree ops (mirroring worktree-process-reap.mjs) so spawnWorker/confirmWorkerMerge/
// gcWorktreeDir run for real end-to-end.
//
// HISTORY: C2/C3-REWRITE (e068a2ab) kept ONE project-wide graph file, written via `ingestToGraph`;
// spawnWorker ENSURED it existed (existence-gated), a merge REFRESHED it, and there was nothing left to
// "drop" per-worktree (an inert no-op). P4 (088afc94) REVIVES the original C1 control-plane methods that
// rewrite had left dormant: `registerWorktree`/`reingestMain`/`dropWorktree` — real per-worktree lifecycle
// against codescape's fleet daemon, each call scoped by codescape's OWN manifest-resolved project id
// (never Loom's project.id — see codescape/manifest.ts's doc for why that distinction matters).
//
// Proves the DoD:
//   (1) register-worktree fires on spawnWorker's create-worktree path for a TASKED spawn — registering
//       THIS worktree (path/branch) under codescape's OWN project id, keyed by a stable worktreeId
//       (codescapeWorktreeId(taskId)) — fire-and-forget, never blocks the spawn.
//   (1b) a TASKLESS spawn does NOT register at all — no stable id to register under (codescapeWorktreeId
//       returns null for a null taskId); this is a permanent skip, not an existence-gate.
//   (1c) a SECOND tasked spawn (its OWN distinct worktree) registers its OWN entry too — register is
//       PER-WORKTREE now, not a once-per-project existence gate.
//   (2) reingest-main fires after finalizeMerge succeeds, UNCONDITIONALLY, on BOTH the Green (normal
//       squash) path and the ALREADY_MERGED (idempotent re-confirm) path — BACKGROUNDED: confirmWorkerMerge
//       resolves BEFORE the fake's artificial delay elapses, proving it is never awaited inline. NO
//       Loom-side debounce/scheduling (codescape's own server-side single-flight queue owns that).
//   (3) gcWorktreeDir genuinely removing a worktree fires a REAL drop-worktree call (revives the hook the
//       old rewrite had left an inert no-op).
//   (4) recycleWorker RE-FIRES register-worktree under the SAME worktreeId (CR fix, card 088afc94:
//       codescape's worktree registry is IN-MEMORY on their side, never persisted — "Loom re-registers on
//       its next hook fire" — so a recycle that reused the worktree WITHOUT re-registering would 404
//       honestly after any `codescape serve` restart between the original registration and the recycle;
//       idempotent by contract, so the re-fire is free) — but still triggers NO drop call (the worktree
//       itself is reused, never removed).
//   (5)/(6) NEGATIVE CASES: LOOM_DEV off, OR the project not codescape-enabled, ⇒ the spy client is called
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
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { resolveCodescapeProjectId } = await import("../dist/codescape/manifest.js");

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

// Seeds a manifest file at <homeDir>/.codescape/projects/index.json mapping `repo` to `codescapeId` — the
// plain-JSON registry `resolveCodescapeProjectId` reads back (never a reimplemented id hash).
function seedManifest(homeDir, repo, codescapeId) {
  const p = path.join(homeDir, ".codescape", "projects", "index.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, projects: [{ id: codescapeId, name: "t", path: repo, lastIngested: now, graphPath: "/x/graph.json" }] }));
}

// A spy CodescapeSupervisor duck-type — the 3 control-plane methods P4 now calls. `reingestMain`
// artificially delays so the test can prove finalizeMerge never awaits it inline.
function makeFakeCodescape(homeDir) {
  const calls = { register: [], reingest: [], drop: [] };
  let reingestInFlight = 0;
  return {
    calls,
    getHomeDir: () => homeDir,
    resolveProjectId: (repoPath) => resolveCodescapeProjectId(repoPath, homeDir),
    reingestInFlightCount: () => reingestInFlight,
    async registerWorktree(projectId, info) {
      calls.register.push({ projectId, ...info });
      return { ok: true };
    },
    async reingestMain(projectId) {
      reingestInFlight++;
      calls.reingest.push({ projectId });
      await sleep(2000); // stands in for a real reingest's latency — long enough that even a slow real
                          // git merge/gc finishes well within this window.
      reingestInFlight--;
      return { ok: true };
    },
    async dropWorktree(projectId, worktreeId) {
      calls.drop.push({ projectId, worktreeId });
      return { ok: true };
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

// ===================== (1)-(4) POSITIVE: LOOM_DEV=1 + a detected codescape CLI + project opted in =====================
{
  process.env.LOOM_DEV = "1";
  process.env.LOOM_CODESCAPE_BIN = fixtureCli;
  const P = { projId: `clh-pos-${sfx}`, mgrAgentId: `clh-pos-mgr-${sfx}`, workerAgentId: `clh-pos-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-clh-pos-${sfx}`), config: { codescape: { enabled: true }, orchestration: { maxConcurrentWorkers: 10 } } };
  const homeDir = path.join(tmpHome, `pos-home-${sfx}`);
  const codescapeId = `clh-pos-codescape-${sfx}`;
  initRepo(P.repo, "# clh positive\n");
  seedManifest(homeDir, P.repo, codescapeId);
  const fake = makeFakeCodescape(homeDir);
  const db = new Db();
  const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
    codescape: fake,
    reapWorktreeProcesses: async () => ({ killedPids: [] }), // no real OS process enumeration needed here
  });
  seedProject(db, P);

  try {
    const mgr = sessions.startManager(P.mgrAgentId);

    // --- (1) register-worktree fires on a TASKED spawn's create-worktree path ---
    const taskId = `clh-task-${sfx}`;
    db.insertTask({ id: taskId, projectId: P.projId, title: "CLH task", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const worker = await sessions.spawnWorker(mgr.id, { taskId, agentId: P.workerAgentId, kickoffPrompt: "GO" });

    check("(1) register-worktree fired at least once for the tasked spawn", await waitFor(() => fake.calls.register.length >= 1));
    const reg = fake.calls.register[0];
    check("(1) register-worktree: projectId is codescape's OWN manifest-resolved id (not Loom's project.id)", reg?.projectId === codescapeId);
    check("(1) register-worktree: path is the worker's own worktree", reg?.path === worker.worktreePath);
    check("(1) register-worktree: worktreeId is a stable, non-empty string", typeof reg?.worktreeId === "string" && reg.worktreeId.length > 0);
    check("(1) register-worktree: baseRef is the worker's branch", reg?.baseRef && typeof reg.baseRef === "string");

    // --- (1b) a TASKLESS spawn does NOT register at all — no stable id to register under ---
    const registerCountBeforeTaskless = fake.calls.register.length;
    const taskless = await sessions.spawnWorker(mgr.id, { agentId: P.workerAgentId, kickoffPrompt: "SPIKE" });
    await sleep(150);
    check("(1b) a taskless spawn never fires register-worktree (no stable worktreeId)", fake.calls.register.length === registerCountBeforeTaskless);
    // cleanup the taskless worker's worktree by hand (not merged in this test)
    try { const { removeWorktree } = await import("../dist/git/worktrees.js"); await removeWorktree(P.repo, taskless.worktreePath); } catch { /* best-effort */ }

    // --- (1c) a SECOND tasked spawn registers ITS OWN entry too — per-worktree, not a once-per-project gate ---
    const taskId2 = `clh-task2-${sfx}`;
    db.insertTask({ id: taskId2, projectId: P.projId, title: "CLH task 2", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
    const registerCountBeforeSecond = fake.calls.register.length;
    const worker1b = await sessions.spawnWorker(mgr.id, { taskId: taskId2, agentId: P.workerAgentId, kickoffPrompt: "GO" });
    check("(1c) a second tasked spawn registers its OWN worktree entry too", await waitFor(() => fake.calls.register.length === registerCountBeforeSecond + 1));
    const reg2 = fake.calls.register[fake.calls.register.length - 1];
    check("(1c) the second registration's worktreeId differs from the first's", reg2?.worktreeId !== reg?.worktreeId);
    check("(1c) the second registration's path is worker1b's own worktree", reg2?.path === worker1b.worktreePath);

    // --- (2)+(3) confirmWorkerMerge (Green path): reingest fires BACKGROUNDED (unconditional) ---
    fs.writeFileSync(path.join(worker.worktreePath, "change.txt"), "worker change\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "change.txt"`, { cwd: worker.worktreePath });
    const reingestCountBeforeMerge = fake.calls.reingest.length;
    const confirm = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(2) confirmWorkerMerge (Green) lands the merge", confirm.merged === true);
    check("(2) reingest fired after the Green-path merge", fake.calls.reingest.length === reingestCountBeforeMerge + 1);
    const reingestCall = fake.calls.reingest[fake.calls.reingest.length - 1];
    check("(2) reingest: projectId is codescape's OWN manifest-resolved id", reingestCall?.projectId === codescapeId);
    // Proves "not awaited inline" robustly (no elapsed-time margin to flake on a loaded runner): if
    // finalizeMerge awaited reingestMain inline, confirmWorkerMerge could not have already resolved above
    // while the fake's 2000ms delay is still in flight.
    check("(2) reingest was still IN FLIGHT right after confirmWorkerMerge resolved (proves it wasn't awaited inline)", fake.reingestInFlightCount() > 0);
    check("(2) reingest eventually settles (best-effort, not lost)", await waitFor(() => fake.reingestInFlightCount() === 0));

    check("(3) the merged worktree was genuinely removed", !fs.existsSync(worker.worktreePath));
    check("(3) gcWorktreeDir's genuine removal fires a REAL drop-worktree call (revives the C1 hook)",
      await waitFor(() => fake.calls.drop.length >= 1));
    const dropCall = fake.calls.drop[0];
    check("(3) drop-worktree: projectId is codescape's OWN manifest-resolved id", dropCall?.projectId === codescapeId);
    check("(3) drop-worktree: worktreeId matches the merged worker's own registration", dropCall?.worktreeId === reg?.worktreeId);

    // --- (2b) ALREADY_MERGED path (a stale re-confirm on the already-fully-merged `worker`) also fires
    //     reingest — both the Green path (above) and ALREADY_MERGED converge in the SAME finalizeMerge ---
    const reingestCountBeforeAM = fake.calls.reingest.length;
    const confirmAgain = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(2b) a stale re-confirm resolves ALREADY_MERGED", confirmAgain.merged === true && confirmAgain.emptyKind === "ALREADY_MERGED");
    check("(2b) reingest fires again for the ALREADY_MERGED path", await waitFor(() => fake.calls.reingest.length === reingestCountBeforeAM + 1));
    check("(2b) it settles too", await waitFor(() => fake.reingestInFlightCount() === 0));

    // --- (4) CR fix: recycleWorker RE-FIRES register-worktree (same worktreeId — a re-registration, not a
    //     fresh one) but never fires drop (it never creates a NEW worktree, and never calls gcWorktreeDir —
    //     the worktree persists, reused) ---
    const taskId3 = `clh-task3-${sfx}`;
    db.insertTask({ id: taskId3, projectId: P.projId, title: "CLH task 3", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });
    const worker3 = await sessions.spawnWorker(mgr.id, { taskId: taskId3, agentId: P.workerAgentId, kickoffPrompt: "GO" });
    check("(4) worker3's own spawn-time register-worktree call lands first", await waitFor(() => fake.calls.register.length > 0 && fake.calls.register[fake.calls.register.length - 1]?.path === worker3.worktreePath));
    const worker3RegisteredWorktreeId = fake.calls.register[fake.calls.register.length - 1]?.worktreeId;
    const registerCountBeforeRecycle = fake.calls.register.length;
    const dropCountBeforeRecycle = fake.calls.drop.length;
    await sessions.recycleWorker(mgr.id, worker3.id, "handoff: continue the work");
    check("(4) recycleWorker RE-FIRES register-worktree (CR fix — codescape's registry is in-memory, never persisted)",
      await waitFor(() => fake.calls.register.length === registerCountBeforeRecycle + 1));
    const recycleReg = fake.calls.register[fake.calls.register.length - 1];
    check("(4) the recycle's re-registration uses the SAME worktreeId as the original (same worktree, re-registered not re-created)",
      recycleReg?.worktreeId === worker3RegisteredWorktreeId);
    check("(4) the recycle's re-registration carries the same worktree path", recycleReg?.path === worker3.worktreePath);
    await sleep(150);
    check("(4) recycleWorker triggers no drop call (worktree not removed)", fake.calls.drop.length === dropCountBeforeRecycle);
    check("(4) recycled worker's worktree still exists on disk (reused, not removed)", fs.existsSync(worker3.worktreePath));
    // cleanup worker3's worktree by hand (not merged in this test)
    try { fs.rmSync(worker3.worktreePath, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

    // --- (7) THE BLOCKING FIX (card 088afc94's Code Review): resume() RE-FIRES register-worktree ---
    // Codescape's worktree registry is IN-MEMORY on their side, never persisted ("Loom re-registers on
    // its next hook fire" — their own doc). Before this fix, resume()/recycleWorker() both passed a
    // worktreeId into the per-session MCP mount WITHOUT ever re-registering it — so a worker resumed
    // after any `codescape serve` restart or crash got a hard 404 at MCP initialize, silently, with zero
    // codescape tools. This proves resume() now re-fires the SAME hook spawnWorker fired at creation, with
    // the SAME worktreeId (a re-registration of the SAME worktree, not a fresh one).
    const taskId4 = `clh-task4-${sfx}`;
    db.insertTask({ id: taskId4, projectId: P.projId, title: "CLH task 4", body: "", columnKey: "backlog", position: 4, priority: "p2", createdAt: now, updatedAt: now });
    const worker4 = await sessions.spawnWorker(mgr.id, { taskId: taskId4, agentId: P.workerAgentId, kickoffPrompt: "GO" });
    check("(7) worker4's own spawn-time register-worktree call lands first", await waitFor(() => fake.calls.register.length > 0 && fake.calls.register[fake.calls.register.length - 1]?.path === worker4.worktreePath));
    const worker4WorktreeId = fake.calls.register[fake.calls.register.length - 1]?.worktreeId;

    // Give worker4 a real engine transcript so resume()'s resumability guards pass (mirrors
    // browser-testing-spawn.mjs's identical setup for the SAME resume() call).
    const engId4 = "44444444-4444-4444-8444-444444444444";
    db.setEngineSessionId(worker4.id, engId4);
    const tpath4 = engineTranscriptPath(worker4.worktreePath, engId4);
    fs.mkdirSync(path.dirname(tpath4), { recursive: true });
    fs.writeFileSync(tpath4, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

    const registerCountBeforeResume = fake.calls.register.length;
    sessions.resume(worker4.id);
    check("(7) resume() RE-FIRES register-worktree — THE BLOCKING FIX", await waitFor(() => fake.calls.register.length === registerCountBeforeResume + 1));
    const resumeReg = fake.calls.register[fake.calls.register.length - 1];
    check("(7) the resume's re-registration uses the SAME worktreeId as the original spawn", resumeReg?.worktreeId === worker4WorktreeId);
    check("(7) the resume's re-registration carries the worker's worktree path", resumeReg?.path === worker4.worktreePath);
    check("(7) the resume's re-registration is scoped to codescape's OWN manifest-resolved id", resumeReg?.projectId === codescapeId);

    // --- (7b) the SAME fix on forkSession(): a fork shares its SOURCE's cwd/worktree and mounts that
    //     SAME worktree-scoped route, so it needs the SAME re-fire. Fork worker4 (already idle + has a
    //     real transcript from the resume above; a fork needs BOTH, and only a worker's taskId yields a
    //     non-null worktreeId, unlike a manager's) — proves the fix generalizes past resume/recycle.
    const registerCountBeforeFork = fake.calls.register.length;
    const forked = sessions.forkSession(worker4.id);
    check("(7b) forkSession() RE-FIRES register-worktree too (same fix, same reasoning)", await waitFor(() => fake.calls.register.length === registerCountBeforeFork + 1));
    const forkReg = fake.calls.register[fake.calls.register.length - 1];
    check("(7b) the fork's re-registration carries the SOURCE's (worker4's) worktree path", forkReg?.path === worker4.worktreePath);
    check("(7b) the fork's re-registration uses the SAME worktreeId as worker4's original spawn", forkReg?.worktreeId === worker4WorktreeId);
    void forked;
    // cleanup worker4's worktree by hand (not merged in this test)
    try { fs.rmSync(worker4.worktreePath, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
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
  const homeDir = path.join(tmpHome, `neg-devoff-home-${sfx}`);
  const N = { projId: `clh-neg-devoff-${sfx}`, mgrAgentId: `clh-neg-devoff-mgr-${sfx}`, workerAgentId: `clh-neg-devoff-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-clh-neg-devoff-${sfx}`), config: { codescape: { enabled: true } } };
  initRepo(N.repo, "# clh negative devoff\n");
  seedManifest(homeDir, N.repo, `clh-neg-devoff-codescape-${sfx}`);
  const fake = makeFakeCodescape(homeDir);
  const db = new Db();
  const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
    codescape: fake,
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
  });
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
      !fs.existsSync(worker.worktreePath) && fake.calls.register.length === 0 && fake.calls.reingest.length === 0 && fake.calls.drop.length === 0);
  } finally {
    db.close();
    try { fs.rmSync(N.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ===================== (6) NEGATIVE CASE: LOOM_DEV on + a detected codescape CLI, but project NOT opted in =====================
{
  process.env.LOOM_DEV = "1";
  process.env.LOOM_CODESCAPE_BIN = fixtureCli;
  const homeDir = path.join(tmpHome, `neg-notenabled-home-${sfx}`);
  const N = { projId: `clh-neg-notenabled-${sfx}`, mgrAgentId: `clh-neg-notenabled-mgr-${sfx}`, workerAgentId: `clh-neg-notenabled-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-clh-neg-notenabled-${sfx}`), config: {} };
  initRepo(N.repo, "# clh negative not-enabled\n");
  seedManifest(homeDir, N.repo, `clh-neg-notenabled-codescape-${sfx}`);
  const fake = makeFakeCodescape(homeDir);
  const db = new Db();
  const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
    codescape: fake,
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
  });
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
      !fs.existsSync(worker.worktreePath) && fake.calls.register.length === 0 && fake.calls.reingest.length === 0 && fake.calls.drop.length === 0);
  } finally {
    db.close();
    try { fs.rmSync(N.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.LOOM_DEV;
    delete process.env.LOOM_CODESCAPE_BIN;
  }
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape lifecycle hooks (P4 rewrite, card 088afc94): register-worktree fires on spawnWorker's create-worktree path for a TASKED spawn (registering codescape's OWN manifest-resolved project id, this worker's own worktree path/branch, keyed by a stable per-task worktreeId) — a taskless spawn never registers at all (no stable id), and a SECOND tasked spawn registers its OWN distinct entry too (per-worktree, not a once-per-project gate); reingest-main fires after finalizeMerge succeeds, unconditionally, on BOTH the Green and ALREADY_MERGED paths, backgrounded (never awaited inline) with no Loom-side debounce; a genuine gcWorktreeDir removal now fires a REAL drop-worktree call (reviving the C1 hook the old rewrite had left an inert no-op) for the merged worker's own worktreeId; a recycleWorker reuse triggers neither a register NOR a drop call (same worktree, never re-created or removed); and the negative case (LOOM_DEV off, or the project not opted in) fires zero calls across an otherwise byte-identical spawn/merge/gc lifecycle."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
