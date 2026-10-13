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
//   (2) reingest-main fires after finalizeMerge succeeds on the Green (normal squash) path — BACKGROUNDED:
//       confirmWorkerMerge resolves BEFORE the fake's artificial delay elapses, proving it is never
//       awaited inline. NO Loom-side debounce/scheduling (codescape's own server-side single-flight queue
//       owns that). (2b) a SUBSEQUENT ALREADY_MERGED re-confirm on the SAME already-finalized worker
//       converges into the SAME finalizeMerge but does NOT refire reingest (card daaf7fc9: a replay lands
//       zero new commits, so refiring would be a pointless full-repo reingest burst — see
//       codescape-reingest-replay-guard.mjs for the boot-reconcile shape of the identical fix).
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
//   (9)/(10) Card 73cc6d06: gcWorktreeDir now fires fireCodescapeDrop BEFORE attempting the actual
//       removal, unconditionally, instead of only after a successful remove — closing the window where
//       codescape's own fs.watch on the worktree dir spins (and leaks memory, Windows) if the dir is
//       deleted while still watched, and the gap where a wedged/failed removal never dropped the
//       registration at all. (9) proves the ORDERING directly at the removeDir call site: the fake
//       codescape client's dropWorktree pushes into `calls.drop` synchronously, so a removeDir override
//       that records `calls.drop.length` at ITS OWN first synchronous line must already see the drop.
//       (10) proves drop still fires on the removal-FAILURE path (a removeDir override that always
//       cleanly rejects ⇒ gcWorktreeDir's outcome is "left-on-disk", worktree retained) — the exact gap
//       the bug report's 24 "could not remove dir" lines never dropped a registration for.
//   (11) REGRESSION (card 73cc6d06 round 2, caught by code review): the (9)/(10) fix's first cut fired
//       fireCodescapeDrop unconditionally, even when a NEW spawn has already reclaimed this EXACT
//       worktree path (card f487a493's "claimed"/aborted race) — the reclaiming spawn registers the
//       SAME worktreeId (codescapeWorktreeId is keyed by taskId, not session), so dropping it here would
//       race that re-registration and could leave codescape believing a still-live, reused worktree is
//       gone. Simulates the race deterministically by injecting directly into
//       SessionService's own `claimedWorktreePaths` Set (the same technique
//       merge-finalize-resilient.mjs's own CLAIMED-path case (4) already uses) BEFORE confirming the
//       merge, and asserts ZERO drop calls landed for that worktreeId.
//   (8) Card f11f3aae (investigate-first on a narrow timing residual left by 088afc94): a CODE-ORDERING
//       regression guard — fireCodescapeRegisterWorktree is always ISSUED before pty.spawn, across all
//       four lifecycle paths (fresh spawn / resume / forkSession / recycleWorker). Investigated FIRST
//       whether claude's own MCP client retries a failed initial connection (it does NOT for a 404 —
//       Claude Code's docs classify not-found as non-retryable, unlike 5xx/timeout/refused — so this
//       window is real, not self-healing), then scoped the guard to what's actually testable: the CODE
//       ordering, not the real network race (which no hermetic test can reproduce). See the guard's own
//       comment block (section (8) below) for the full citation.
//
// Run: 1) build daemon, 2) node test/codescape-lifecycle-hooks.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { commitAll } from "./_git-commit.mjs";

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
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
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
  execSync(`git init -q && git config user.email clh@loom && git config user.name clh`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

// Seeds a manifest file at <homeDir>/.codescape/projects/index.json mapping `repo` to `codescapeId` — the
// plain-JSON registry `resolveCodescapeProjectId` reads back (never a reimplemented id hash).
function seedManifest(homeDir, repo, codescapeId) {
  const p = path.join(homeDir, ".codescape", "projects", "index.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, projects: [{ id: codescapeId, name: "t", path: repo, lastIngested: now, graphPath: "/x/graph.json" }] }));
}

// A spy CodescapeSupervisor duck-type — the 3 control-plane methods P4 now calls. `reingestMain`
// artificially delays so the test can prove finalizeMerge never awaits it inline. `orderLog` is an
// OPTIONAL shared sequence array (card f11f3aae) — when supplied, registerWorktree appends "register"
// to it at the exact moment it's CALLED (synchronous, before the fire-and-forget promise settles),
// letting a caller compare call order against SeamHost's "spawn" tag below. undefined ⇒ byte-identical
// to today (every existing caller of this factory omits it).
function makeFakeCodescape(homeDir, orderLog) {
  const calls = { register: [], reingest: [], drop: [] };
  let reingestInFlight = 0;
  return {
    calls,
    getHomeDir: () => homeDir,
    // Card 0e4a859a: SessionService's codescape prompt-block gate also reads getPort() — a live port, so
    // the P (positive) scenarios in this file don't throw calling startManager/spawnWorker/recycleWorker.
    getPort: () => 4000,
    resolveProjectId: (repoPath) => resolveCodescapeProjectId(repoPath, homeDir),
    reingestInFlightCount: () => reingestInFlight,
    async registerWorktree(projectId, info) {
      orderLog?.push("register");
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
// `orderLog` (card f11f3aae, optional — see makeFakeCodescape's identical doc): createPty appends
// "spawn" to it at the exact moment `PtyHost.spawn()` calls it — that call is `createPty`'s FIRST
// synchronous action (host.ts), so this tags the true moment claude's own process would be launched.
//
// Card c54d1ea0: `onExit`/`kill` must actually simulate a real node-pty process dying — see
// _seam-host-fixture.mjs (card ec7983c6) for why that wiring is now shared rather than local. This
// subclass only adds the orderLog tap; onExit/kill/pid/etc. come from the shared base.
class SeamHost extends createSeamHost(PtyHost) {
  constructor(events, orderLog) { super(events); this.orderLog = orderLog; }
  createPty(opts) {
    this.orderLog?.push("spawn");
    return super.createPty(opts);
  }
  isAlive() { return false; }
}
function makeHost(db, orderLog) {
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  return new SeamHost(events, orderLog);
}

// Card e66ea3c2: NOT migrated onto _wait.mjs — retry-COUNT contract ({tries, everyMs}); tries*everyMs
// would cap wall-clock and shrink the effective budget under load, where sleep() is a floor not a
// ceiling. Same class as 43f5b242's group 4.
async function waitFor(cond, { tries = 200, everyMs = 50 } = {}) {
  for (let i = 0; i < tries && !cond(); i++) await sleep(everyMs);
  return cond();
}

// Card f11f3aae regression guard (see section (8) below for the full rationale): asserts that, within
// the slice of `orderLog` appended since `sliceStart`, a "register" tag was pushed before a "spawn" tag
// — i.e. fireCodescapeRegisterWorktree was ISSUED before pty.spawn for this one lifecycle call. Polls
// (waitFor) rather than reading orderLog synchronously: both tags are pushed synchronously in the real
// code today, but polling for BOTH tags to appear before comparing order also holds if that ever
// changed, without turning a genuine ordering regression into a flaky pass/fail.
async function assertRegisterBeforeSpawn(orderLog, label, sliceStart) {
  await waitFor(() => {
    const added = orderLog.slice(sliceStart);
    return added.includes("register") && added.includes("spawn");
  });
  const added = orderLog.slice(sliceStart);
  const r = added.indexOf("register");
  const s = added.indexOf("spawn");
  check(`(order) ${label}: fireCodescapeRegisterWorktree is issued before pty.spawn`, r !== -1 && s !== -1 && r < s);
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
  // orderLog (card f11f3aae): a shared call-order sequence — see (8) below for what it guards.
  const orderLog = [];
  const fake = makeFakeCodescape(homeDir, orderLog);
  const db = new Db();
  const sessions = new SessionService(db, makeHost(db, orderLog), new OrchestrationControl(), {
    codescape: fake,
    reapWorktreeProcesses: async () => ({ killedPids: [] }), // no real OS process enumeration needed here
  });
  seedProject(db, P);

  // Card c54d1ea0: every session id spawned below is tracked here and explicitly stopped in the
  // `finally` BEFORE db.close() — a session left live (never merged/recycled) carries its own pending
  // readiness-fallback/kickoff-guarantee timer (pty/host.ts) that fires `Db.setBusy` on whatever `Db`
  // instance its `events.onBusy` closure still references; under load this block's real wall-clock (many
  // real git worktree ops) can outlast those timers' window — READY_FALLBACK_MS (20s, spawn-anchored,
  // the missed-hook path) or, once SessionStart dispatches, MODE_CYCLE_FALLBACK_MS (20s, re-armed from
  // that dispatch) bounded by READY_FALLBACK_ABSOLUTE_CEILING_MS (45s from spawn) — well past this
  // block's own db.close(). (Card 0050a17e later removed the separate STARTUP_PROMPT_GRACE_MS grace
  // window this comment originally cited alongside READY_FALLBACK_MS as a combined ~30s figure — the
  // kickoff-delivery timer now chains on the next tick after markReady instead, so the live windows are
  // the three named above, not that stale sum.) A redundant stop() on an already-retired session (e.g.
  // one confirmWorkerMerge or recycleWorker already stopped) is a safe no-op (PtyHost.stop guards on
  // live.alive).
  const liveIds = [];
  try {
    const mgr = sessions.startManager(P.mgrAgentId);
    liveIds.push(mgr.id);

    // --- (1) register-worktree fires on a TASKED spawn's create-worktree path ---
    const taskId = `clh-task-${sfx}`;
    db.insertTask({ id: taskId, projectId: P.projId, title: "CLH task", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const worker = await sessions.spawnWorker(mgr.id, { taskId, agentId: P.workerAgentId, kickoffPrompt: "GO" });
    liveIds.push(worker.id);

    check("(1) register-worktree fired at least once for the tasked spawn", await waitFor(() => fake.calls.register.length >= 1));
    const reg = fake.calls.register[0];
    check("(1) register-worktree: projectId is codescape's OWN manifest-resolved id (not Loom's project.id)", reg?.projectId === codescapeId);
    check("(1) register-worktree: path is the worker's own worktree", reg?.path === worker.worktreePath);
    check("(1) register-worktree: worktreeId is a stable, non-empty string", typeof reg?.worktreeId === "string" && reg.worktreeId.length > 0);
    check("(1) register-worktree: baseRef is the worker's branch", reg?.baseRef && typeof reg.baseRef === "string");

    // --- (1b) a TASKLESS spawn does NOT register at all — no stable id to register under ---
    const registerCountBeforeTaskless = fake.calls.register.length;
    const taskless = await sessions.spawnWorker(mgr.id, { agentId: P.workerAgentId, kickoffPrompt: "SPIKE" });
    liveIds.push(taskless.id);
    await sleep(150);
    check("(1b) a taskless spawn never fires register-worktree (no stable worktreeId)", fake.calls.register.length === registerCountBeforeTaskless);
    // cleanup the taskless worker's worktree by hand (not merged in this test)
    try { const { removeWorktree } = await import("../dist/git/worktrees.js"); await removeWorktree(P.repo, taskless.worktreePath); } catch { /* best-effort */ }

    // --- (1c) a SECOND tasked spawn registers ITS OWN entry too — per-worktree, not a once-per-project gate ---
    const taskId2 = `clh-task2-${sfx}`;
    db.insertTask({ id: taskId2, projectId: P.projId, title: "CLH task 2", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
    const registerCountBeforeSecond = fake.calls.register.length;
    const worker1b = await sessions.spawnWorker(mgr.id, { taskId: taskId2, agentId: P.workerAgentId, kickoffPrompt: "GO" });
    liveIds.push(worker1b.id);
    check("(1c) a second tasked spawn registers its OWN worktree entry too", await waitFor(() => fake.calls.register.length === registerCountBeforeSecond + 1));
    const reg2 = fake.calls.register[fake.calls.register.length - 1];
    check("(1c) the second registration's worktreeId differs from the first's", reg2?.worktreeId !== reg?.worktreeId);
    check("(1c) the second registration's path is worker1b's own worktree", reg2?.path === worker1b.worktreePath);

    // --- (2)+(3) confirmWorkerMerge (Green path): reingest fires BACKGROUNDED (unconditional) ---
    fs.writeFileSync(path.join(worker.worktreePath, "change.txt"), "worker change\n");
    commitAll(worker.worktreePath, "change.txt", GIT_ID);
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

    // --- (2b) ALREADY_MERGED path (a stale re-confirm on the already-fully-merged `worker`) — both the
    //     Green path (above) and ALREADY_MERGED converge in the SAME finalizeMerge, but a REPLAY of an
    //     already-finalized worker (card daaf7fc9) must NOT refire reingest a second time: `worker` was
    //     already reingested once by the Green-path confirm above, and this re-confirm lands zero new
    //     commits behind it. Was "reingest fires again" before card daaf7fc9's fix — that was the exact
    //     zero-new-commits reingest-burst bug (there via a duplicate confirm instead of a boot-reconcile
    //     replay; see codescape-reingest-replay-guard.mjs for the boot-reconcile shape of the same fix).
    const reingestCountBeforeAM = fake.calls.reingest.length;
    const confirmAgain = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(2b) a stale re-confirm resolves ALREADY_MERGED", confirmAgain.merged === true && confirmAgain.emptyKind === "ALREADY_MERGED");
    // NO fixed wait here (deliberately): finishAlreadyMerged `await`s finalizeMerge directly, and
    // confirmWorkerMerge in turn awaits that whole chain before resolving — so by the time the `await`
    // above returns, finalizeMerge's own (synchronous) `if (!hadPriorMergeDone) this.fireCodescapeReingest(...)`
    // guard has ALREADY been evaluated, one way or the other. `reingestMain`'s push into `calls.reingest`
    // happens synchronously too (before its own artificial delay) — see makeFakeCodescape above — so this
    // is a checkable FACT the instant confirmWorkerMerge settles, not a race a sleep could paper over.
    check("(2b) card daaf7fc9: reingest does NOT refire for an already-finalized replay", fake.calls.reingest.length === reingestCountBeforeAM);
    check("(2b) it settles too (nothing new in flight)", await waitFor(() => fake.reingestInFlightCount() === 0));

    // --- (4) CR fix: recycleWorker RE-FIRES register-worktree (same worktreeId — a re-registration, not a
    //     fresh one) but never fires drop (it never creates a NEW worktree, and never calls gcWorktreeDir —
    //     the worktree persists, reused) ---
    const taskId3 = `clh-task3-${sfx}`;
    db.insertTask({ id: taskId3, projectId: P.projId, title: "CLH task 3", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });
    const worker3 = await sessions.spawnWorker(mgr.id, { taskId: taskId3, agentId: P.workerAgentId, kickoffPrompt: "GO" });
    liveIds.push(worker3.id);
    check("(4) worker3's own spawn-time register-worktree call lands first", await waitFor(() => fake.calls.register.length > 0 && fake.calls.register[fake.calls.register.length - 1]?.path === worker3.worktreePath));
    const worker3RegisteredWorktreeId = fake.calls.register[fake.calls.register.length - 1]?.worktreeId;
    const registerCountBeforeRecycle = fake.calls.register.length;
    const dropCountBeforeRecycle = fake.calls.drop.length;
    const worker3Successor = await sessions.recycleWorker(mgr.id, worker3.id, "handoff: continue the work");
    liveIds.push(worker3Successor.id);
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
    liveIds.push(worker4.id);
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
    liveIds.push(forked.id);
    check("(7b) forkSession() RE-FIRES register-worktree too (same fix, same reasoning)", await waitFor(() => fake.calls.register.length === registerCountBeforeFork + 1));
    const forkReg = fake.calls.register[fake.calls.register.length - 1];
    check("(7b) the fork's re-registration carries the SOURCE's (worker4's) worktree path", forkReg?.path === worker4.worktreePath);
    check("(7b) the fork's re-registration uses the SAME worktreeId as worker4's original spawn", forkReg?.worktreeId === worker4WorktreeId);
    void forked;
    // cleanup worker4's worktree by hand (not merged in this test)
    try { fs.rmSync(worker4.worktreePath, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

    // --- (8) CODE-ORDERING REGRESSION GUARD (card f11f3aae) ---
    // card f11f3aae investigated a narrow timing residual left by 088afc94's re-fire hooks above: the
    // register-worktree POST (fire-and-forget, never awaited — awaiting it would put a network call on
    // the spawn hot path) races claude's OWN MCP client, which connects to /mcp/<codescapeId>/<worktreeId>
    // ~1-3s later. If claude's connect attempt reaches codescape BEFORE the POST lands, the route 404s.
    //
    // INVESTIGATE-FIRST FINDING: this does NOT self-heal. Claude Code's documented MCP behavior
    // (code.claude.com/docs/en/mcp, "Automatic reconnection") retries an HTTP/SSE server's INITIAL
    // connection at startup up to 3x, but ONLY for transient errors (5xx, connection-refused, timeout):
    // "Authentication and not-found errors are not retried because they require a configuration change
    // to resolve." A 404 — exactly what an unregistered worktree route returns (see this file's own
    // fake-codescape-cli.mjs fallback 404, and codescape-mcp-spawn.mjs's identical fixture) — is a
    // not-found error: ZERO retries, and the worker silently has no codescape tools for that session's
    // entire lifetime. Confirmed against the daemon's actually-spawned claude binary (2.1.219 at
    // investigation time), well past the v2.1.121 release the retry-classification behavior shipped in.
    //
    // WHAT THIS CAN AND CANNOT PROVE: the network race itself (POST landing vs. MCP connect) is NOT
    // hermetically testable — there's no real claude process and no real network timing here, so this
    // can't assert the POST always LANDS before claude's first connect attempt. What IS controllable,
    // and IS guarded here, is the CODE ordering 088afc94 established: fireCodescapeRegisterWorktree must
    // always be ISSUED (synchronously) before pty.spawn, in EVERY lifecycle path — so the register POST
    // is always in flight before claude's process (and therefore its MCP client) even exists. If a
    // future refactor reorders these two calls, the window widens from "possible under a slow/loaded
    // host" to "certain on every single spawn" — this guard catches exactly that regression. The
    // residual network-timing race is being raised with codescape directly (register-on-first-use at
    // mount time, their side) rather than built around here.
    const taskId5 = `clh-task5-${sfx}`;
    db.insertTask({ id: taskId5, projectId: P.projId, title: "CLH task 5", body: "", columnKey: "backlog", position: 5, priority: "p2", createdAt: now, updatedAt: now });
    let orderStart = orderLog.length;
    const worker5 = await sessions.spawnWorker(mgr.id, { taskId: taskId5, agentId: P.workerAgentId, kickoffPrompt: "GO" });
    liveIds.push(worker5.id);
    await assertRegisterBeforeSpawn(orderLog, "fresh spawn (spawnWorker)", orderStart);

    // Give worker5 a real engine transcript so resume()'s/forkSession()'s resumability guards pass
    // (mirrors worker4's identical setup above).
    const engId5 = "55555555-5555-4555-8555-555555555555";
    db.setEngineSessionId(worker5.id, engId5);
    const tpath5 = engineTranscriptPath(worker5.worktreePath, engId5);
    fs.mkdirSync(path.dirname(tpath5), { recursive: true });
    fs.writeFileSync(tpath5, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

    orderStart = orderLog.length;
    sessions.resume(worker5.id);
    await assertRegisterBeforeSpawn(orderLog, "resume", orderStart);

    orderStart = orderLog.length;
    const forked5 = sessions.forkSession(worker5.id);
    liveIds.push(forked5.id);
    await assertRegisterBeforeSpawn(orderLog, "forkSession", orderStart);
    void forked5;

    orderStart = orderLog.length;
    const worker5Successor = await sessions.recycleWorker(mgr.id, worker5.id, "handoff: ordering guard");
    liveIds.push(worker5Successor.id);
    await assertRegisterBeforeSpawn(orderLog, "recycleWorker", orderStart);

    // cleanup worker5's worktree by hand (not merged in this test)
    try { fs.rmSync(worker5.worktreePath, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  } finally {
    // Card c54d1ea0: stop every tracked session BEFORE db.close() — see liveIds' own doc above for why
    // this can't be skipped even for sessions confirmWorkerMerge/recycleWorker already stopped.
    for (const id of liveIds) { try { sessions.stopSession(id, "hard"); } catch { /* already gone / not found */ } }
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
  const liveIdsN = []; // card c54d1ea0 — see the positive block's liveIds doc above for why this matters
  try {
    const mgr = sessions.startManager(N.mgrAgentId);
    liveIdsN.push(mgr.id);
    const taskId = `clh-neg-devoff-task-${sfx}`;
    db.insertTask({ id: taskId, projectId: N.projId, title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const worker = await sessions.spawnWorker(mgr.id, { taskId, agentId: N.workerAgentId, kickoffPrompt: "GO" });
    liveIdsN.push(worker.id);
    fs.writeFileSync(path.join(worker.worktreePath, "change.txt"), "worker change\n");
    commitAll(worker.worktreePath, "change.txt", GIT_ID);
    const confirm = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(5) LOOM_DEV off: merge still lands normally (byte-identical lifecycle)", confirm.merged === true);
    await sleep(50);
    check("(5) LOOM_DEV off: no supervisor call ever fired (spawn+merge+gc lifecycle)",
      !fs.existsSync(worker.worktreePath) && fake.calls.register.length === 0 && fake.calls.reingest.length === 0 && fake.calls.drop.length === 0);
  } finally {
    for (const id of liveIdsN) { try { sessions.stopSession(id, "hard"); } catch { /* already gone / not found */ } }
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
  const liveIdsN6 = []; // card c54d1ea0 — see the positive block's liveIds doc above for why this matters
  try {
    const mgr = sessions.startManager(N.mgrAgentId);
    liveIdsN6.push(mgr.id);
    const taskId = `clh-neg-notenabled-task-${sfx}`;
    db.insertTask({ id: taskId, projectId: N.projId, title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const worker = await sessions.spawnWorker(mgr.id, { taskId, agentId: N.workerAgentId, kickoffPrompt: "GO" });
    liveIdsN6.push(worker.id);
    fs.writeFileSync(path.join(worker.worktreePath, "change.txt"), "worker change\n");
    commitAll(worker.worktreePath, "change.txt", GIT_ID);
    const confirm = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(6) project not codescape-enabled: merge still lands normally", confirm.merged === true);
    await sleep(50);
    check("(6) project not enabled: no supervisor call ever fired (spawn+merge+gc lifecycle)",
      !fs.existsSync(worker.worktreePath) && fake.calls.register.length === 0 && fake.calls.reingest.length === 0 && fake.calls.drop.length === 0);
  } finally {
    for (const id of liveIdsN6) { try { sessions.stopSession(id, "hard"); } catch { /* already gone / not found */ } }
    db.close();
    try { fs.rmSync(N.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.LOOM_DEV;
    delete process.env.LOOM_CODESCAPE_BIN;
  }
}

// ===================== (9) ORDERING (card 73cc6d06): fireCodescapeDrop fires BEFORE removeWorktree ever
// touches the dir, not after =====================
// makeFakeCodescape's dropWorktree pushes into `calls.drop` SYNCHRONOUSLY, with no await before the push
// (see its own doc above) — so a `removeDir` override that records `calls.drop.length` at ITS OWN first
// synchronous line (before it does anything else) can only ever see the drop already landed if
// gcWorktreeDir genuinely issues it before calling removeWorktree. On pre-fix code (drop fired only
// inside the `removed` success branch, AFTER removeWorktree returns) this assertion would read 0, not
// >= 1 — this is a real ordering proof, not a timing-sensitive sleep/race.
{
  process.env.LOOM_DEV = "1";
  process.env.LOOM_CODESCAPE_BIN = fixtureCli;
  const homeDir = path.join(tmpHome, `order-home-${sfx}`);
  const O = { projId: `clh-order-${sfx}`, mgrAgentId: `clh-order-mgr-${sfx}`, workerAgentId: `clh-order-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-clh-order-${sfx}`), config: { codescape: { enabled: true }, orchestration: { maxConcurrentWorkers: 10 } } };
  const codescapeId = `clh-order-codescape-${sfx}`;
  initRepo(O.repo, "# clh order\n");
  seedManifest(homeDir, O.repo, codescapeId);
  const fake = makeFakeCodescape(homeDir);
  const removeDirCalls = [];
  const db = new Db();
  const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
    codescape: fake,
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
    // Records how many drop-worktree calls had ALREADY landed the instant removeDir itself is first
    // invoked, then ACTUALLY deletes the dir itself (the override replaces killableRemoveDir entirely —
    // a stub that merely CLAIMS removed:true without deleting anything would leave the dir on disk and
    // falsely fail this block's own "really removed" assertion) so the rest of the merge/gc completes
    // the same way section (3) above already proves it does.
    removeDir: async (target, _timeoutMs) => {
      removeDirCalls.push({ dropCountAtCallTime: fake.calls.drop.length });
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best-effort, mirrors killableRemoveDir's own contract */ }
      return { removed: true, killed: false };
    },
  });
  seedProject(db, O);
  const liveIdsO = [];
  try {
    const mgr = sessions.startManager(O.mgrAgentId);
    liveIdsO.push(mgr.id);
    const taskId = `clh-order-task-${sfx}`;
    db.insertTask({ id: taskId, projectId: O.projId, title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const worker = await sessions.spawnWorker(mgr.id, { taskId, agentId: O.workerAgentId, kickoffPrompt: "GO" });
    liveIdsO.push(worker.id);
    check("(9) setup: register-worktree fired for the ordering worker", await waitFor(() => fake.calls.register.length >= 1));
    const registeredWorktreeId = fake.calls.register[0]?.worktreeId;
    fs.writeFileSync(path.join(worker.worktreePath, "change.txt"), "worker change\n");
    commitAll(worker.worktreePath, "change.txt", GIT_ID);
    const confirm = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(9) the merge lands", confirm.merged === true);
    check("(9) the worktree was actually removed (removeDir override returned removed:true)", !fs.existsSync(worker.worktreePath));
    check("(9) removeDir (the real removal) was actually invoked", removeDirCalls.length >= 1);
    check("(9) fireCodescapeDrop already fired BEFORE removeDir's own first call — the ordering fix",
      (removeDirCalls[0]?.dropCountAtCallTime ?? 0) >= 1);
    check("(9) the drop that fired was for THIS worker's own registered worktreeId",
      fake.calls.drop.some((c) => c.worktreeId === registeredWorktreeId));
  } finally {
    for (const id of liveIdsO) { try { sessions.stopSession(id, "hard"); } catch { /* already gone / not found */ } }
    db.close();
    try { fs.rmSync(O.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.LOOM_DEV;
    delete process.env.LOOM_CODESCAPE_BIN;
  }
}

// ===================== (10) FAILURE PATH (card 73cc6d06): drop still fires when the removal itself FAILS
// =====================
// Before the fix, fireCodescapeDrop lived INSIDE gcWorktreeDir's `removed` success branch only — a
// worktree that was wedged or left-on-disk never deregistered at all (the bug report's 24 "could not
// remove dir" lines, 2026-10-04). A removeDir override that always cleanly rejects (never "killed",
// so removeWorktree retries REMOVE_DIR_CLEAN_RETRY_ATTEMPTS times and then gives up with `removed:false`)
// drives gcWorktreeDir's outcome to "left-on-disk" — this proves the drop call still landed anyway.
{
  process.env.LOOM_DEV = "1";
  process.env.LOOM_CODESCAPE_BIN = fixtureCli;
  const homeDir = path.join(tmpHome, `failpath-home-${sfx}`);
  const F = { projId: `clh-failpath-${sfx}`, mgrAgentId: `clh-failpath-mgr-${sfx}`, workerAgentId: `clh-failpath-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-clh-failpath-${sfx}`), config: { codescape: { enabled: true }, orchestration: { maxConcurrentWorkers: 10 } } };
  const codescapeId = `clh-failpath-codescape-${sfx}`;
  initRepo(F.repo, "# clh failpath\n");
  seedManifest(homeDir, F.repo, codescapeId);
  const fake = makeFakeCodescape(homeDir);
  const db = new Db();
  const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
    codescape: fake,
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
    // A clean (non-"killed") rejection on EVERY attempt — removeWorktree retries
    // REMOVE_DIR_CLEAN_RETRY_ATTEMPTS times (worktrees.ts) and then gives up with removed:false,
    // wedged:false ⇒ gcWorktreeDir's outcome is "left-on-disk"; the directory is never actually touched.
    removeDir: async (_target, _timeoutMs) => ({ removed: false, killed: false }),
  });
  seedProject(db, F);
  const liveIdsF = [];
  let worker; // declared outside the try so `finally` can clean up its (never-removed-by-design) worktree
  try {
    const mgr = sessions.startManager(F.mgrAgentId);
    liveIdsF.push(mgr.id);
    const taskId = `clh-failpath-task-${sfx}`;
    db.insertTask({ id: taskId, projectId: F.projId, title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    worker = await sessions.spawnWorker(mgr.id, { taskId, agentId: F.workerAgentId, kickoffPrompt: "GO" });
    liveIdsF.push(worker.id);
    check("(10) setup: register-worktree fired for the failure-path worker", await waitFor(() => fake.calls.register.length >= 1));
    const registeredWorktreeId = fake.calls.register[0]?.worktreeId;
    fs.writeFileSync(path.join(worker.worktreePath, "change.txt"), "worker change\n");
    commitAll(worker.worktreePath, "change.txt", GIT_ID);
    const confirm = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    check("(10) the merge itself still lands (gc failure doesn't block the merge)", confirm.merged === true);
    // confirmWorkerMerge surfaces the GC outcome as a human-readable `warning` string (worktreeGcWarning,
    // service.ts) — there is no separate `worktreeGcOutcome` field on its own return.
    check("(10) the merge's own warning names the removal-failure path (left-on-disk)", typeof confirm.warning === "string" && confirm.warning.includes("could not be removed"));
    check("(10) the worktree directory is still on disk (removal genuinely failed)", fs.existsSync(worker.worktreePath));
    check("(10) drop-worktree STILL fired despite the removal failure — the fix",
      await waitFor(() => fake.calls.drop.some((c) => c.worktreeId === registeredWorktreeId)));
  } finally {
    for (const id of liveIdsF) { try { sessions.stopSession(id, "hard"); } catch { /* already gone / not found */ } }
    db.close();
    // The worktree directory was never actually removed (that's the point of this test, via the
    // always-rejecting removeDir override above) — clean up ONLY that specific worktree path by hand
    // (never a parent directory — WORKTREES_DIR is a SIBLING of LOOM_HOME, outside tmpHome, so nothing
    // else cleans this one up) so the test doesn't leak it.
    if (worker?.worktreePath) { try { fs.rmSync(worker.worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ } }
    try { fs.rmSync(F.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.LOOM_DEV;
    delete process.env.LOOM_CODESCAPE_BIN;
  }
}

// ===================== (11) REGRESSION (card 73cc6d06 round 2): a reclaiming spawn's already-claimed
// path must NEVER be dropped =====================
// Caught by code review of the (9)/(10) fix's first cut: firing fireCodescapeDrop unconditionally,
// BEFORE even checking whether a NEW spawn has already claimed this exact path (card f487a493's
// "claimed"/aborted race), would race that spawn's own re-registration of the SAME worktreeId
// (codescapeWorktreeId is keyed by taskId, not session id — the reclaiming spawn targets the SAME task,
// hence the SAME path, hence the SAME worktreeId). Simulated the same way
// merge-finalize-resilient.mjs's own CLAIMED-path case (4) simulates it: inject directly into
// SessionService's own `claimedWorktreePaths` Set — the exact seam `reclaimWedgedWorktreePathForSpawn`
// itself populates — BEFORE calling confirmWorkerMerge, so the race is deterministic rather than a real
// concurrent spawn this hermetic test can't reliably schedule.
{
  process.env.LOOM_DEV = "1";
  process.env.LOOM_CODESCAPE_BIN = fixtureCli;
  const { normForCompare } = await import("../dist/git/worktrees.js");
  const homeDir = path.join(tmpHome, `claimrace-home-${sfx}`);
  const R = { projId: `clh-claimrace-${sfx}`, mgrAgentId: `clh-claimrace-mgr-${sfx}`, workerAgentId: `clh-claimrace-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-clh-claimrace-${sfx}`), config: { codescape: { enabled: true }, orchestration: { maxConcurrentWorkers: 10 } } };
  const codescapeId = `clh-claimrace-codescape-${sfx}`;
  initRepo(R.repo, "# clh claimrace\n");
  seedManifest(homeDir, R.repo, codescapeId);
  const fake = makeFakeCodescape(homeDir);
  const db = new Db();
  const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
    codescape: fake,
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
  });
  seedProject(db, R);
  const liveIdsR = [];
  let worker; // declared outside the try so `finally` can clean up its never-actually-removed worktree
  try {
    const mgr = sessions.startManager(R.mgrAgentId);
    liveIdsR.push(mgr.id);
    const taskId = `clh-claimrace-task-${sfx}`;
    db.insertTask({ id: taskId, projectId: R.projId, title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    worker = await sessions.spawnWorker(mgr.id, { taskId, agentId: R.workerAgentId, kickoffPrompt: "GO" });
    liveIdsR.push(worker.id);
    check("(11) setup: register-worktree fired for the claim-race worker", await waitFor(() => fake.calls.register.length >= 1));
    const registeredWorktreeId = fake.calls.register[0]?.worktreeId;
    fs.writeFileSync(path.join(worker.worktreePath, "change.txt"), "worker change\n");
    commitAll(worker.worktreePath, "change.txt", GIT_ID);

    // The injected race: a reclaiming spawn has ALREADY claimed this EXACT path, mirroring
    // reclaimWedgedWorktreePathForSpawn's own claim — this must land BEFORE confirmWorkerMerge so
    // gcWorktreeDir's pre-check (right after it marks `removingWorktreePaths`) sees it.
    const normPath = normForCompare(worker.worktreePath);
    sessions.claimedWorktreePaths.add(normPath);
    let confirm;
    try {
      confirm = await sessions.confirmWorkerMerge(mgr.id, worker.id);
    } finally {
      sessions.claimedWorktreePaths.delete(normPath); // this test's own injected claim, not the daemon's
    }
    check("(11) the merge itself still lands despite the claim-abort", confirm.merged === true);
    check("(11) the worktree was NEVER TOUCHED (still fully present, real .git linkage)",
      fs.existsSync(worker.worktreePath) && fs.existsSync(path.join(worker.worktreePath, ".git")));
    check("(11) drop-worktree did NOT fire for this worktreeId — THE REGRESSION FIX",
      !fake.calls.drop.some((c) => c.worktreeId === registeredWorktreeId));
    check("(11) no drop call fired AT ALL across this worker's whole lifecycle", fake.calls.drop.length === 0);
  } finally {
    for (const id of liveIdsR) { try { sessions.stopSession(id, "hard"); } catch { /* already gone / not found */ } }
    db.close();
    // The worktree was never actually removed (that's the point of this test) — clean up ONLY that
    // specific worktree path by hand (never a parent directory).
    if (worker?.worktreePath) { try { fs.rmSync(worker.worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ } }
    try { fs.rmSync(R.repo, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.LOOM_DEV;
    delete process.env.LOOM_CODESCAPE_BIN;
  }
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape lifecycle hooks (P4 rewrite, card 088afc94): register-worktree fires on spawnWorker's create-worktree path for a TASKED spawn (registering codescape's OWN manifest-resolved project id, this worker's own worktree path/branch, keyed by a stable per-task worktreeId) — a taskless spawn never registers at all (no stable id), and a SECOND tasked spawn registers its OWN distinct entry too (per-worktree, not a once-per-project gate); reingest-main fires after finalizeMerge succeeds on the Green path, backgrounded (never awaited inline) with no Loom-side debounce, but does NOT refire on a subsequent ALREADY_MERGED replay of the SAME already-finalized worker (card daaf7fc9: zero new commits behind a replay); a genuine gcWorktreeDir removal now fires a REAL drop-worktree call (reviving the C1 hook the old rewrite had left an inert no-op) for the merged worker's own worktreeId; recycleWorker RE-FIRES register-worktree under the SAME worktreeId (but never a drop — the worktree is reused, never removed); resume() and forkSession() both re-fire it too, same worktreeId; a code-ordering regression guard (card f11f3aae) confirms register is always ISSUED before pty.spawn across all four lifecycle paths (fresh spawn/resume/fork/recycle — the residual network-timing race that isn't hermetically testable is documented at the guard, not built around); and the negative case (LOOM_DEV off, or the project not opted in) fires zero calls across an otherwise byte-identical spawn/merge/gc lifecycle."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
