import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// gate_queue() (card fa359824 — Codescape manager escalation 530e59a0): the ONE-read answer to "why is my
// gate queued, who holds the slot, how deep am I" that `gate_status(opId)` can't give (it only ever answers
// "what is MY op doing"). Proves:
//   (unit)  SessionService.gateQueueForManager redacts taskId/branch/workerLabel for a DIFFERENT project's
//           entry (never redacted-to-null — the fields are OMITTED), while a CALLER-OWN-project entry
//           carries full detail; running/queued split with correct queuePosition; cap/activeCount/
//           queuedCount reflect the live GateSemaphore registry.
//   (e2e)   the REAL MCP tool `gate_queue`, registered on the manager surface only (never the worker's
//           pinned depth-1 surface), driven against two REAL runWorkerGate ops in TWO DIFFERENT projects —
//           the exact shape of the manager's escalation (a foreign project's gate legitimately holding the
//           daemon-global slot).
//   (4f151331 — the sibling question this card also asks: does the semaphore actually cap concurrency at
//           maxConcurrentGates?) A live snapshot taken WHILE one op holds the only cap-1 slot and a second,
//           different-project op is queued behind it: gate_queue() reports EXACTLY 1 running + 1 queued —
//           NEVER 2 running — at every snapshot across the hold/release/handoff sequence. Combined with the
//           existing gate-semaphore-concurrency.mjs (A) proof (maxActive===1 structurally, cap 1 can never
//           let a second call even ENTER the gate fn while the first holds it) and (B) proof (cap 2 DOES
//           reach maxActive===2 via a rendezvous barrier — the mechanism is capable of showing real
//           concurrency, so its silence at cap 1 isn't a blind instrument), this is a REPORTING-NUANCE
//           finding, not a real cap breach: a manager reading two gate_status(opId) calls "seconds apart"
//           can observe DIFFERENT ops each reporting "running" without the cap ever being exceeded, because
//           GateSemaphore.release() hands the slot directly to the next queued waiter — the first op's
//           entry can be gone and the second's already "running" within the same tick, with no observable
//           window where BOTH show queued or where the first shows anything but gone. Two sequential,
//           single-op reads a few seconds apart can therefore span a genuine hand-off and read as "two
//           different ops both running" even though at no real instant did the registry ever hold 2 running
//           entries — exactly what this test's own snapshots (taken WHILE both are genuinely live) confirm
//           never happens.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-queue.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Card 39196378 CR follow-up: `runWorkerGate` now takes a SECOND real git-stamp read (`admitStamp`)
// AFTER admission but BEFORE the injected `runGate`/fakeGate is ever invoked (service.ts's admitted
// `fn` callback: `admitStamp = await computeWorktreeGateStamp(...); return runGateSeq(...)`). Admission
// itself (the registry recording an entry as "running") happens synchronously inside the semaphore's own
// `acquire()`, so it does NOT wait on that stamp — but the fakeGate closure below (which stands in for
// `runGateSeq`) DOES, and on a loaded/Windows host that stamp read can outlast a fixed sleep. A release
// function (`release1`/`release2`) is only assigned once fakeGate actually runs, so calling it before
// that assignment throws `TypeError: ... is not a function` (the exact failure this closed — a real
// regression from that change, not a flake: 537/538 hermetic tests passed, only this file's fixed-delay
// assumption broke). Poll for the assignment instead of assuming a fixed delay covers it.
async function waitUntilInvoked(getRelease, label, timeoutMs = 5000, intervalMs = 25) {
  const start = performance.now(); // MONOTONIC — avoids the Date.now() CI timing-flake class
  while (performance.now() - start < timeoutMs) {
    if (typeof getRelease() === "function") return;
    await sleep(intervalMs);
  }
  throw new Error(`${label}: the gate runner was not invoked within ${timeoutMs}ms (admission recorded, but the post-admission admitStamp/runGate call never landed — genuinely wedged, not just slow)`);
}

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gq-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const GIT_ID = "-c user.email=gq@loom -c user.name=gq";
const now = new Date().toISOString();

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gq\n");
  execSync(`git init -q && git config user.email gq@loom && git config user.name gq && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// ── (unit) SessionService.gateQueueForManager — redaction + shape, no real spawn ─────────────────────────
{
  const dbs = [];
  const worktrees = [];
  try {
    const db = new Db();
    dbs.push(db);
    const P1 = `gq-own-${Date.now()}`, P2 = `gq-foreign-${Date.now()}`;
    const repo1 = path.join(os.tmpdir(), `${P1}-repo`), repo2 = path.join(os.tmpdir(), `${P2}-repo`);
    makeRepo(repo1);
    makeRepo(repo2);
    db.insertProject({ id: P1, name: "Own Project", repoPath: repo1, vaultPath: repo1, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertProject({ id: P2, name: "Foreign Project", repoPath: repo2, vaultPath: repo2, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "a1", projectId: P1, name: "dev-1", startupPrompt: "", position: 0 });
    db.insertAgent({ id: "a2", projectId: P2, name: "dev-2", startupPrompt: "", position: 0 });
    const t1 = `${P1}-task`, t2 = `${P2}-task`;
    db.insertTask({ id: t1, projectId: P1, title: "Own project task title", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertTask({ id: t2, projectId: P2, title: "Foreign project task title — must never leak", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const wt1 = await createWorktree(repo1, P1, t1);
    const wt2 = await createWorktree(repo2, P2, t2);
    worktrees.push(wt1.worktreePath, wt2.worktreePath);
    const w1 = `${P1}-wkr`, w2 = `${P2}-wkr`;
    db.insertSession({ id: w1, projectId: P1, agentId: "a1", engineSessionId: null, title: null, cwd: wt1.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t1, worktreePath: wt1.worktreePath, branch: wt1.branch });
    db.insertSession({ id: w2, projectId: P2, agentId: "a2", engineSessionId: null, title: null, cwd: wt2.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t2, worktreePath: wt2.worktreePath, branch: wt2.branch });

    let release1, release2;
    const fakeGate = async (_cmd, worktreePath) => new Promise((res) => {
      if (worktreePath === wt1.worktreePath) release1 = res;
      else release2 = res;
    });
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    const p1 = sessions.runWorkerGate(w1).catch((e) => { console.error("p1 rejected:", e); });
    await sleep(500); // let w1's gate get admitted (cap 1, nothing else queued yet)
    const p2 = sessions.runWorkerGate(w2).catch((e) => { console.error("p2 rejected:", e); }); // queues behind w1 (SAME daemon-global cap)
    await sleep(500); // let w2 register as queued

    const own = sessions.gateQueueForManager(P1);
    check("(unit) cap resolves to the schema default (1, no platform override)", own.cap === 1);
    check("(unit) activeCount/queuedCount reflect the live registry (1 running, 1 queued)", own.activeCount === 1 && own.queuedCount === 1);
    check("(unit) exactly 1 running + 1 queued entry, never both running", own.running.length === 1 && own.queued.length === 1);
    const ownRunning = own.running[0];
    check("(unit) the OWN-project (P1) entry is the one running", ownRunning.projectId === P1 && ownRunning.gateType === "worker");
    check("(unit) an OWN-project entry carries taskId/branch/workerLabel", ownRunning.taskId === t1 && ownRunning.branch === wt1.branch && ownRunning.workerLabel === "dev-1 · Own project task title");
    check("(unit) a running entry has queuePosition:null", ownRunning.queuePosition === null);
    check("(unit) opId is present on the running entry (chainable into gate_status)", typeof ownRunning.opId === "string" && ownRunning.opId.length > 0);

    const foreignQueued = own.queued[0];
    check("(unit) the FOREIGN-project (P2) entry is the one queued", foreignQueued.projectId === P2 && foreignQueued.projectName === "Foreign Project");
    check("(unit) a FOREIGN-project entry OMITS taskId/branch/workerLabel entirely (never redacted-to-null)",
      !("taskId" in foreignQueued) && !("branch" in foreignQueued) && !("workerLabel" in foreignQueued));
    check("(unit) the foreign task's title never appears anywhere in the snapshot",
      !JSON.stringify(own).includes("Foreign project task title"));
    check("(unit) a queued entry reports queuePosition:1", foreignQueued.queuePosition === 1);

    // Now scope the SAME live state from P2's own perspective — the roles flip: P2 sees ITS OWN entry
    // (queued) with full detail, and P1's entry (running) redacted.
    const foreign = sessions.gateQueueForManager(P2);
    check("(unit) from P2's own view, its queued entry carries full detail", foreign.queued[0].taskId === t2 && foreign.queued[0].workerLabel === "dev-2 · Foreign project task title — must never leak");
    check("(unit) from P2's own view, P1's running entry is redacted", !("taskId" in foreign.running[0]) && !("branch" in foreign.running[0]));

    await waitUntilInvoked(() => release1, "(unit) w1's fakeGate");
    release1({ passed: true });
    await sleep(200); // let the handoff settle: w1's entry clears, w2 gets admitted (registry admission
    // is synchronous inside acquire() — it does NOT wait on w2's own post-admission admitStamp read, so
    // this sleep only needs to cover the handoff itself, not fakeGate's invocation)
    const afterHandoff = sessions.gateQueueForManager(P1);
    check("(unit, handoff) after release, exactly 1 running (the FORMER queued entry) + 0 queued — never a moment with 2 running",
      afterHandoff.running.length === 1 && afterHandoff.queued.length === 0 && afterHandoff.running[0].projectId === P2);

    await waitUntilInvoked(() => release2, "(unit) w2's fakeGate");
    release2({ passed: true });
    await sleep(200);
    const afterAll = sessions.gateQueueForManager(P1);
    check("(unit) registry empty once both settle (no leaked entries)", afterAll.running.length === 0 && afterAll.queued.length === 0 && afterAll.activeCount === 0 && afterAll.queuedCount === 0);

    await Promise.all([p1, p2]);
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
    for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── (e2e, MCP) the REAL gate_queue tool, manager-surface-only, over a REAL router/client ─────────────────
{
  const dbs = [];
  const worktrees = [];
  try {
    const P1 = `gq-mcp-own-${Date.now()}`, P2 = `gq-mcp-foreign-${Date.now()}`;
    const repo1 = path.join(os.tmpdir(), `${P1}-repo`), repo2 = path.join(os.tmpdir(), `${P2}-repo`);
    makeRepo(repo1);
    makeRepo(repo2);
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P1, name: "MCP Own", repoPath: repo1, vaultPath: repo1, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertProject({ id: P2, name: "MCP Foreign", repoPath: repo2, vaultPath: repo2, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "ma1", projectId: P1, name: "dev-1", startupPrompt: "", position: 0 });
    db.insertAgent({ id: "ma2", projectId: P2, name: "dev-2", startupPrompt: "", position: 0 });
    const mgrId = `${P1}-mgr`;
    db.insertSession({ id: mgrId, projectId: P1, agentId: "ma1", engineSessionId: null, title: null, cwd: repo1, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const t1 = `${P1}-task`, t2 = `${P2}-task`;
    db.insertTask({ id: t1, projectId: P1, title: "MCP own task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertTask({ id: t2, projectId: P2, title: "MCP foreign task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const wt1 = await createWorktree(repo1, P1, t1);
    const wt2 = await createWorktree(repo2, P2, t2);
    worktrees.push(wt1.worktreePath, wt2.worktreePath);
    const w1 = `${P1}-wkr`, w2 = `${P2}-wkr`;
    db.insertSession({ id: w1, projectId: P1, agentId: "ma1", engineSessionId: null, title: null, cwd: wt1.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t1, worktreePath: wt1.worktreePath, branch: wt1.branch });
    db.insertSession({ id: w2, projectId: P2, agentId: "ma2", engineSessionId: null, title: null, cwd: wt2.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t2, worktreePath: wt2.worktreePath, branch: wt2.branch });

    let release1, release2;
    const fakeGate = async (_cmd, worktreePath) => new Promise((res) => {
      if (worktreePath === wt1.worktreePath) release1 = res;
      else release2 = res;
    });
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const router = new OrchestrationMcpRouter(db, sessions);

    const connect = async (sessionId, role) => {
      const server = router.buildServer(sessionId, role);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: `gate-queue-${sessionId}`, version: "0" });
      await client.connect(clientT);
      return { server, client, call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args ?? {} })).content[0].text) };
    };

    const mgr = await connect(mgrId, "manager");
    check("(e2e, MCP) gate_queue IS registered on the manager's own MCP surface", Object.keys(mgr.server._registeredTools).includes("gate_queue"));

    const p1 = sessions.runWorkerGate(w1).catch(() => {});
    // Two real git-stamp reads now straddle admission, not one: `startStamp` (fire, BEFORE this call even
    // queues) precedes admission as before, and `admitStamp` (card 39196378) is taken AFTER admission but
    // BEFORE the fakeGate below is ever invoked. This sleep only needs to outlast the FIRST (registry
    // admission is synchronous inside acquire() and doesn't wait on the second) — `waitUntilInvoked` below
    // is what actually waits out the second, since a fixed sleep can't safely bound a real git call.
    await sleep(500); // let w1's gate genuinely get admitted (real git-stamp work precedes admission)
    const p2 = sessions.runWorkerGate(w2).catch(() => {}); // different project, SAME daemon-global cap
    await sleep(500); // let w2 register as queued

    const snap = await mgr.call("gate_queue");
    check("(e2e, MCP) gate_queue: cap/activeCount/queuedCount correct", snap.cap === 1 && snap.activeCount === 1 && snap.queuedCount === 1);
    check("(e2e, MCP) gate_queue: exactly 1 running + 1 queued — never 2 running (the 4f151331 question)", snap.running.length === 1 && snap.queued.length === 1);
    check("(e2e, MCP) gate_queue: the running entry is P1's OWN op, full detail", snap.running[0].projectId === P1 && snap.running[0].taskId === t1 && snap.running[0].workerLabel === "dev-1 · MCP own task");
    check("(e2e, MCP) gate_queue: the queued entry is P2's FOREIGN op, redacted (project named, task/branch omitted)",
      snap.queued[0].projectId === P2 && snap.queued[0].projectName === "MCP Foreign" && !("taskId" in snap.queued[0]) && !("workerLabel" in snap.queued[0]));

    await waitUntilInvoked(() => release1, "(e2e, MCP) w1's fakeGate");
    release1({ passed: true });
    await sleep(200); // handoff settle only — see the admission-vs-invocation note above
    const afterHandoff = await mgr.call("gate_queue");
    check("(e2e, MCP) after handoff: exactly 1 running (now P2's, redacted) + 0 queued", afterHandoff.running.length === 1 && afterHandoff.queued.length === 0 && afterHandoff.running[0].projectId === P2 && !("taskId" in afterHandoff.running[0]));

    await waitUntilInvoked(() => release2, "(e2e, MCP) w2's fakeGate");
    release2({ passed: true });
    await sleep(200);
    const afterAll = await mgr.call("gate_queue");
    check("(e2e, MCP) empty once both settle", afterAll.running.length === 0 && afterAll.queued.length === 0);
    await Promise.all([p1, p2]);
    await mgr.client.close();

    // Role gate: gate_queue must NEVER appear on the worker's pinned depth-1 surface (mgmt-surface.mjs /
    // my-context-gate.mjs / etc. pin the EXACT list {gate_status, my_context, run_gate, worker_report}).
    const wkr = await connect(w1, "worker");
    const wTools = Object.keys(wkr.server._registeredTools);
    check("(e2e, MCP) gate_queue is NOT on the worker surface (manager-only tool)", !wTools.includes("gate_queue"));
    check("(e2e, MCP) worker surface is still EXACTLY the pinned 4-tool set (gate_queue didn't leak in)",
      wTools.slice().sort().join(",") === "gate_status,my_context,run_gate,worker_report");
    await wkr.client.close();
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
    for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── (unit) recentTimeoutStreak — the SECOND, independent signal (escalation 4f151331) ────────────────────
// The manager found gate_status/GateSemaphore's own bookkeeping can lie: a runGateStep timeout can settle
// (freeing the slot) without its process tree actually dying, so a fresh op can legitimately be admitted
// (or correctly reported "queued") while an ORPHANED process from an earlier, already-evicted attempt on
// the SAME worktree is still alive. gate_queue can't see the orphan directly (out of scope for this card —
// that's process-tree territory owned elsewhere), but it CAN surface the one signal that already survives
// that eviction: the gate-timeout circuit breaker's own per-branch streak. Proves a REAL timedOut result
// (via runWorkerGate, not a synthetic field poke) increments the streak, and a SUBSEQUENT fresh op on that
// SAME branch carries it in gate_queue — a nonzero streak on an otherwise-unremarkable "queued"/"running"
// entry is exactly the anomaly signal that was missing from the incident.
{
  const dbs = [];
  const worktrees = [];
  try {
    const db = new Db();
    dbs.push(db);
    const P = `gq-streak-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    db.insertProject({ id: P, name: "Streak Project", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "sa1", projectId: P, name: "dev-1", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`;
    db.insertTask({ id: taskId, projectId: P, title: "Streak task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const wt = await createWorktree(repo, P, taskId);
    worktrees.push(wt.worktreePath);
    const w = `${P}-wkr`;
    db.insertSession({ id: w, projectId: P, agentId: "sa1", engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId, worktreePath: wt.worktreePath, branch: wt.branch });

    let mode = "timeout"; // first call times out; flip to "hold" for the second, controllable call
    let releaseSecond;
    const fakeGate = async () => {
      if (mode === "timeout") return { passed: false, failedTimedOut: true, failedSignal: "SIGKILL" };
      return new Promise((res) => { releaseSecond = res; });
    };
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: fakeGate,
      reapWorktreeProcesses: async () => ({ killedPids: [] }), // stub — no real OS process scanning in this test
      gateOpRetainMs: 0, // disable the settle-grace retention window — this test issues back-to-back calls, each expecting its OWN fresh invocation
    });

    const first = await sessions.runWorkerGate(w);
    check("(unit, streak) the first (timed-out) run_gate call settles normally", first.settled === true && first.ok === true && first.value.passed === false);
    check("(unit, streak) gateTimeoutStreakCount is 1 after one timedOut result", sessions.gateTimeoutStreakCount(wt.branch) === 1);

    mode = "hold";
    const p2 = sessions.runWorkerGate(w).catch((e) => { console.error("second run_gate rejected:", e); });
    await sleep(1000); // let the fresh op register (breaker doesn't trip until GATE_TIMEOUT_BREAKER_THRESHOLD)

    const snap = sessions.gateQueueForManager(P);
    check("(unit, streak) a fresh op on the SAME branch is live (running, since nothing else contends for the slot)", snap.running.length === 1 && snap.running[0].branch === wt.branch);
    check("(unit, streak) that entry carries recentTimeoutStreak:1 — the second, independent signal", snap.running[0].recentTimeoutStreak === 1);

    // Same latent-fragile shape as the two blocks above (card 39196378 CR follow-up): admission (what
    // `snap` just checked) is synchronous and doesn't wait on the post-admission admitStamp read, but
    // `fakeGate` itself — and therefore `releaseSecond`'s assignment — does. Don't assume the 1000ms
    // above (generous, but still fixed) also covers this.
    await waitUntilInvoked(() => releaseSecond, "(unit, streak) the second call's fakeGate");
    releaseSecond({ passed: true });
    await sleep(200);
    const afterPass = sessions.gateQueueForManager(P);
    check("(unit, streak) registry empty once the second (passing) op settles", afterPass.running.length === 0 && afterPass.queued.length === 0);
    check("(unit, streak) a PASSING result clears the streak back to 0", sessions.gateTimeoutStreakCount(wt.branch) === 0);
    await p2;
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
    for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — gate_queue() answers cap/activeCount/queuedCount + running/queued detail from ONE read, redacts taskId/branch/workerLabel for a cross-project entry (never redacted-to-null — omitted), is registered on the manager surface only (the worker's pinned 4-tool depth-1 surface is untouched), never reports 2 entries as \"running\" at cap 1 across a real hold/queue/handoff/settle sequence (corroborating gate-semaphore-concurrency.mjs's structural proof that the cap genuinely bounds concurrency), and — answering escalation 4f151331's design ask — surfaces the independent gate-timeout-streak signal so a fresh op on a recently-timed-out branch carries a visible anomaly flag instead of looking indistinguishable from a clean one."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
