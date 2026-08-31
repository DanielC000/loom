import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// gate_queue() (card fa359824 — Codescape manager escalation 530e59a0): the ONE-read answer to "why is my
// gate queued, who holds the slot, how deep am I" that `gate_status(opId)` can't give (it only ever answers
// "what is MY op doing"). Proves:
//   (unit)  SessionService.gateQueueForManager redacts taskId/branch/workerLabel for a DIFFERENT project's
//           entry (never redacted-to-null — the fields are OMITTED, and the omission is now flagged with an
//           explicit `redacted: true`, card 80d54122 DoD-3), while a CALLER-OWN-project entry carries full
//           detail (and no `redacted` marker at all); running/queued split with correct queuePosition;
//           cap/activeCount/queuedCount reflect the live GateSemaphore registry. `recentTimeoutStreak`
//           (see the (unit, streak) block below) is CROSS-PROJECT — card 80d54122 DoD-1/2 determined its
//           prior own-project-only scoping was incidental, not deliberate, so this ONE bare integer now
//           crosses the redaction boundary while taskId/branch/workerLabel do not.
//   (e2e)   the REAL MCP tool `gate_queue`, registered on BOTH the manager AND worker surfaces (card
//           d04f9c76 added the worker exposure), driven against two REAL runWorkerGate ops in TWO
//           DIFFERENT projects — the exact shape of the manager's escalation (a foreign project's gate
//           legitimately holding the daemon-global slot) — AND, for the worker surface, a live proof that
//           a WORKER caller gets the SAME project-scoped redaction a manager on that project would, never
//           more (redaction is keyed off caller PROJECT, never caller ROLE).
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
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

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
//
// Retrofitted onto the shared _wait.mjs waitUntil (card 0b8d8148): this file was excluded from the
// 22796d42 migration on the stated reason "deliberately performance.now(); migrating as-is reintroduces
// a documented CI flake class." That reason was accurate ONLY while _wait.mjs's own waitUntil was
// Date.now()-anchored — card 32ac0273 made it performance.now()-anchored (monotonic) before batch 3 even
// started, so both sides now share the same clock and the original discriminator no longer holds. This
// file's local waitUntil/waitUntilInvoked are pure poll-until-predicate loops (no lower-bound elapsed-time
// assertion), the exact shape already migrated elsewhere — same timeoutMs/intervalMs defaults and
// throw-on-timeout contract preserved; no call site here ever used the return value, so delegating
// straight to the shared helper (rather than swallowing its timeout like the "return false" wrappers
// elsewhere) is the faithful migration for a contract that already throws.
async function waitUntilInvoked(getRelease, label, timeoutMs = 5000, intervalMs = 25) {
  return sharedWaitUntil(() => typeof getRelease() === "function", { timeoutMs, intervalMs, label });
}
// Card 7b3a585a (from the 7b634e58 audit): `runWorkerGate` reads a REAL async git subprocess
// (`computeWorktreeGateStamp`) BEFORE the semaphore ever sees the op, so "issue op 1, then op 2" does NOT
// by itself guarantee op 1 is ADMITTED first — that depends on how long each op's git subprocess takes,
// which is genuinely elapsed-time dependent, not JS-synchronous-guaranteed. A fixed `sleep(...)` before
// issuing a competing op is a bet on a margin, not a guarantee. This polls the LIVE gateQueueForManager/
// snapshotGates registry for the actual admission state instead, so ordering is ESTABLISHED BY OBSERVATION.
// Card 43f5b242: the local `waitUntil(cond, label, timeoutMs, intervalMs)` wrapper that used to sit here
// was removed — its (cond, label, ...) positional order put `label` where the shared `_wait.mjs` helper
// expects a bare timeout number, the exact silent-misread shape that card exists to eliminate. Call sites
// below now call `sharedWaitUntil` directly with an explicit options object (same timeoutMs:5000/
// intervalMs:25 the old wrapper defaulted to — values unchanged).

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gq-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME); // this file's own cleanup below only rmSync's the worktrees array, never this home dir

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
    registerForCleanup(repo1); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never these repo dirs
    registerForCleanup(repo2);
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
    await sharedWaitUntil(() => sessions.gateQueueForManager(P1).activeCount === 1, { timeoutMs: 5000, intervalMs: 25, label: "(unit) w1's gate admitted" }); // cap 1, nothing else queued yet
    const p2 = sessions.runWorkerGate(w2).catch((e) => { console.error("p2 rejected:", e); }); // queues behind w1 (SAME daemon-global cap)
    await sharedWaitUntil(() => sessions.gateQueueForManager(P1).queuedCount === 1, { timeoutMs: 5000, intervalMs: 25, label: "(unit) w2 registered as queued" });

    const own = sessions.gateQueueForManager(P1);
    check("(unit) cap resolves to the schema default (1, no platform override)", own.cap === 1);
    check("(unit) activeCount/queuedCount reflect the live registry (1 running, 1 queued)", own.activeCount === 1 && own.queuedCount === 1);
    check("(unit) exactly 1 running + 1 queued entry, never both running", own.running.length === 1 && own.queued.length === 1);
    const ownRunning = own.running[0];
    check("(unit) the OWN-project (P1) entry is the one running", ownRunning.projectId === P1 && ownRunning.gateType === "worker");
    check("(unit) an OWN-project entry carries taskId/branch/workerLabel", ownRunning.taskId === t1 && ownRunning.branch === wt1.branch && ownRunning.workerLabel === "dev-1 · Own project task title");
    check("(unit) a running entry has queuePosition:null", ownRunning.queuePosition === null);
    check("(unit) opId is present on the running entry (chainable into gate_status)", typeof ownRunning.opId === "string" && ownRunning.opId.length > 0);
    // Card 80d54122: an own-project entry carries no `redacted` marker at all (not even `false`) — its
    // absence is itself the "this is your own project, nothing here is withheld" signal.
    check("(unit) an OWN-project entry carries NO `redacted` marker", !("redacted" in ownRunning));
    check("(unit) an OWN-project entry carries recentTimeoutStreak:0 (a real measured zero, not an omission)", ownRunning.recentTimeoutStreak === 0);

    const foreignQueued = own.queued[0];
    check("(unit) the FOREIGN-project (P2) entry is the one queued", foreignQueued.projectId === P2 && foreignQueued.projectName === "Foreign Project");
    check("(unit) a FOREIGN-project entry OMITS taskId/branch/workerLabel entirely (never redacted-to-null)",
      !("taskId" in foreignQueued) && !("branch" in foreignQueued) && !("workerLabel" in foreignQueued));
    // Card 80d54122 DoD-3: the omission above is now self-evident via an explicit boolean, and DoD-1/2
    // (recentTimeoutStreak's redaction was INCIDENTAL, not deliberate — see the card) moved this ONE bare
    // integer into the unconditional tier, so a foreign entry now carries it same as an own entry would.
    check("(unit) a FOREIGN-project entry carries an explicit redacted:true marker", foreignQueued.redacted === true);
    check("(unit) a FOREIGN-project entry NOW carries recentTimeoutStreak:0 (bare integer, no identity)", foreignQueued.recentTimeoutStreak === 0);
    check("(unit) the foreign task's title never appears anywhere in the snapshot",
      !JSON.stringify(own).includes("Foreign project task title"));
    check("(unit) a queued entry reports queuePosition:1", foreignQueued.queuePosition === 1);

    // Now scope the SAME live state from P2's own perspective — the roles flip: P2 sees ITS OWN entry
    // (queued) with full detail, and P1's entry (running) redacted.
    const foreign = sessions.gateQueueForManager(P2);
    check("(unit) from P2's own view, its queued entry carries full detail", foreign.queued[0].taskId === t2 && foreign.queued[0].workerLabel === "dev-2 · Foreign project task title — must never leak");
    check("(unit) from P2's own view, its OWN entry carries no `redacted` marker", !("redacted" in foreign.queued[0]));
    check("(unit) from P2's own view, P1's running entry is redacted", !("taskId" in foreign.running[0]) && !("branch" in foreign.running[0]));
    check("(unit) from P2's own view, P1's running entry carries redacted:true", foreign.running[0].redacted === true);
    check("(unit) from P2's own view, P1's running entry STILL carries recentTimeoutStreak:0", foreign.running[0].recentTimeoutStreak === 0);

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
    registerForCleanup(repo1); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never these repo dirs
    registerForCleanup(repo2);
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
    // BEFORE the fakeGate below is ever invoked. Card 7b3a585a: that FIRST stamp read happens BEFORE the
    // semaphore ever sees the op, so a fixed sleep before issuing the competing op only ever BETS that it
    // outlasts a real async git subprocess — poll the live registry for actual admission instead.
    await sharedWaitUntil(() => sessions.gateQueueForManager(P1).activeCount === 1, { timeoutMs: 5000, intervalMs: 25, label: "(e2e, MCP) w1's gate genuinely admitted" }); // real git-stamp work precedes admission
    const p2 = sessions.runWorkerGate(w2).catch(() => {}); // different project, SAME daemon-global cap
    await sharedWaitUntil(() => sessions.gateQueueForManager(P1).queuedCount === 1, { timeoutMs: 5000, intervalMs: 25, label: "(e2e, MCP) w2 registered as queued" });

    const snap = await mgr.call("gate_queue");
    check("(e2e, MCP) gate_queue: cap/activeCount/queuedCount correct", snap.cap === 1 && snap.activeCount === 1 && snap.queuedCount === 1);
    check("(e2e, MCP) gate_queue: exactly 1 running + 1 queued — never 2 running (the 4f151331 question)", snap.running.length === 1 && snap.queued.length === 1);
    check("(e2e, MCP) gate_queue: the running entry is P1's OWN op, full detail", snap.running[0].projectId === P1 && snap.running[0].taskId === t1 && snap.running[0].workerLabel === "dev-1 · MCP own task");
    check("(e2e, MCP) gate_queue: the queued entry is P2's FOREIGN op, redacted (project named, task/branch omitted)",
      snap.queued[0].projectId === P2 && snap.queued[0].projectName === "MCP Foreign" && !("taskId" in snap.queued[0]) && !("workerLabel" in snap.queued[0]));

    // Card d04f9c76: gate_queue is now ALSO registered on the WORKER surface (same tool, same
    // project-scoped redaction — see registerGateQueue's doc) so a worker can check lane availability
    // itself instead of firing run_gate blind. Prove a WORKER caller (w1, on P1) gets EXACTLY the same
    // shape the manager just saw above: its OWN project's running entry in full detail, the FOREIGN
    // project's queued entry redacted — captured while the ops are still genuinely live, not after they've
    // settled (a redaction bug that only showed up on a settled/empty snapshot would be invisible here).
    const wkrLive = await connect(w1, "worker");
    check("(e2e, MCP) gate_queue IS registered on the worker's own MCP surface", Object.keys(wkrLive.server._registeredTools).includes("gate_queue"));
    const wSnap = await wkrLive.call("gate_queue");
    check("(e2e, MCP worker) gate_queue: cap/activeCount/queuedCount match the manager's own read", wSnap.cap === 1 && wSnap.activeCount === 1 && wSnap.queuedCount === 1);
    check("(e2e, MCP worker) gate_queue: the running entry is w1's OWN project (P1), full detail", wSnap.running[0].projectId === P1 && wSnap.running[0].taskId === t1 && wSnap.running[0].workerLabel === "dev-1 · MCP own task");
    check("(e2e, MCP worker) gate_queue: the queued entry is the FOREIGN project (P2), redacted — taskId/branch/workerLabel OMITTED for a WORKER caller too (redaction is keyed off CALLER PROJECT, never caller ROLE)",
      wSnap.queued[0].projectId === P2 && !("taskId" in wSnap.queued[0]) && !("branch" in wSnap.queued[0]) && !("workerLabel" in wSnap.queued[0]));
    await wkrLive.client.close();

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

    // Role gate: gate_queue IS on the worker's pinned depth-1 surface as of card d04f9c76 (mgmt-surface.mjs
    // / my-context-gate.mjs / idle-report.mjs / inbox-pull.mjs / orch-scope.mjs pin the EXACT list — card
    // 35c96aa6 added directive_status alongside it: {directive_status, gate_queue, gate_status, my_context,
    // run_gate, worker_report}) — read-only + project-scoped (directive_status: read-only + own-lineage-
    // scoped), so neither adds any writable/manager-only surface (see the live redaction proof above).
    const wkr = await connect(w1, "worker");
    const wTools = Object.keys(wkr.server._registeredTools);
    check("(e2e, MCP) gate_queue IS on the worker surface (read-only, project-scoped)", wTools.includes("gate_queue"));
    check("(e2e, MCP) worker surface is EXACTLY the pinned 6-tool set",
      wTools.slice().sort().join(",") === "directive_status,gate_queue,gate_status,my_context,run_gate,worker_report");
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
// entry is exactly the anomaly signal that was missing from the incident. ALSO proves card 80d54122's fix:
// a caller from a THIRD, unrelated project reads the SAME real nonzero streak (1, not 0, not omitted) off
// this entry, while taskId/branch/workerLabel stay redacted (with an explicit redacted:true) on that same
// cross-project read — the bare integer crosses the boundary, nothing else does.
{
  const dbs = [];
  const worktrees = [];
  try {
    const db = new Db();
    dbs.push(db);
    const P = `gq-streak-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    registerForCleanup(repo); // this scenario's own cleanup only rmSync's `worktrees` + LOOM_HOME, never this repo dir
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
    // Lower severity than the two sites above (nothing else contends for the slot, so there's no ordering
    // to flip) — but still poll rather than sleep for the fresh op to actually register as admitted.
    await sharedWaitUntil(() => sessions.gateQueueForManager(P).activeCount === 1, { timeoutMs: 5000, intervalMs: 25, label: "(unit, streak) the fresh op registered as running" });

    const snap = sessions.gateQueueForManager(P);
    check("(unit, streak) a fresh op on the SAME branch is live (running, since nothing else contends for the slot)", snap.running.length === 1 && snap.running[0].branch === wt.branch);
    check("(unit, streak) that entry carries recentTimeoutStreak:1 — the second, independent signal", snap.running[0].recentTimeoutStreak === 1);

    // Card 80d54122: negative control first — a caller from a project that owns NOTHING in this registry
    // (never touched `P`) sees P's entry as fully foreign, proving the redaction itself still applies to
    // taskId/branch/workerLabel...
    const foreignView = sessions.gateQueueForManager(`${P}-not-the-owner`);
    check("(unit, streak) cross-project caller sees exactly 1 running entry (P's)", foreignView.running.length === 1);
    check("(unit, streak) cross-project caller still gets taskId/branch/workerLabel REDACTED",
      !("taskId" in foreignView.running[0]) && !("branch" in foreignView.running[0]) && !("workerLabel" in foreignView.running[0]));
    check("(unit, streak) cross-project caller sees an explicit redacted:true marker", foreignView.running[0].redacted === true);
    // ...positive proof: the SAME entry's recentTimeoutStreak is now a REAL nonzero value (1, not 0 and not
    // omitted) from that same cross-project read — this is the actual answer to the card's DoD, not just a
    // structural assertion: the bare integer crosses the project boundary, nothing else does.
    check("(unit, streak) cross-project caller ALSO sees the REAL nonzero recentTimeoutStreak:1 (now unconditional, not own-project-gated)",
      foreignView.running[0].recentTimeoutStreak === 1);

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

// ── (unit, repoGuardOnly) Code Review MAJOR fix, card b9e07a4a: a foreign-project repoGuardOnly entry
// omits taskId/branch/workerLabel AND repoPath entirely — an earlier version leaked `repoPath` (an
// absolute HOST FILESYSTEM PATH) unconditionally, disclosing another project's repo directory name and
// this host's own layout. Written to the SAME standard as the (unit) block above ("the foreign task's
// title never appears anywhere in the snapshot") — a foreign repoPath test written to that standard fails
// on the leak immediately, which is exactly what this proves didn't ship. ──────────────────────────────
{
  const dbs = [];
  try {
    const db = new Db();
    dbs.push(db);
    const P1 = `gq-rgo-own-${Date.now()}`, P2 = `gq-rgo-foreign-${Date.now()}`;
    db.insertProject({ id: P1, name: "RGO Own", repoPath: "/tmp/rgo-own", vaultPath: "/tmp/rgo-own", config: {}, createdAt: now, archivedAt: null });
    db.insertProject({ id: P2, name: "RGO Foreign", repoPath: "/tmp/rgo-foreign-secret-path", vaultPath: "/tmp/rgo-foreign-secret-path", config: {}, createdAt: now, archivedAt: null });
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});

    const release = await sessions.gateSemaphore.acquireRepoGuardOnly({
      repoPath: "/tmp/rgo-foreign-secret-path/repo", projectId: P2, sessionId: "foreign-sess",
      taskId: "foreign-task", branch: "loom/foreign", opId: "rgo-op-1",
    });
    try {
      const view = sessions.gateQueueForManager(P1); // P1 is NOT the owner of this hold
      check("(unit, repoGuardOnly) exactly 1 repoGuardOnly entry visible", view.repoGuardOnly.length === 1);
      const foreign = view.repoGuardOnly[0];
      check("(unit, repoGuardOnly) foreign entry is phase:holding", foreign.phase === "holding");
      check("(unit, repoGuardOnly) foreign entry OMITS taskId/branch/workerLabel/repoPath entirely (never redacted-to-null)",
        !("taskId" in foreign) && !("branch" in foreign) && !("workerLabel" in foreign) && !("repoPath" in foreign));
      check("(unit, repoGuardOnly) the foreign repo path never appears anywhere in the snapshot",
        !JSON.stringify(view).includes("rgo-foreign-secret-path"));
      check("(unit, repoGuardOnly) opId/projectId/projectName still present (the sanctioned set)",
        foreign.opId === "rgo-op-1" && foreign.projectId === P2 && foreign.projectName === "RGO Foreign");

      // From P2's OWN view, the same entry carries full detail — including repoPath.
      const ownView = sessions.gateQueueForManager(P2);
      const own = ownView.repoGuardOnly[0];
      check("(unit, repoGuardOnly) from P2's own view, repoPath/taskId/branch ARE present",
        own.repoPath === "/tmp/rgo-foreign-secret-path/repo" && own.taskId === "foreign-task" && own.branch === "loom/foreign");
    } finally {
      release();
    }
    const afterRelease = sessions.gateQueueForManager(P1);
    check("(unit, repoGuardOnly) empty once released (no leaked entry)", afterRelease.repoGuardOnly.length === 0);
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — gate_queue() answers cap/activeCount/queuedCount + running/queued detail from ONE read, redacts taskId/branch/workerLabel for a cross-project entry (never redacted-to-null — omitted), is registered on BOTH the manager AND worker surfaces with the SAME project-scoped redaction either way (the worker's pinned 5-tool depth-1 surface holds), never reports 2 entries as \"running\" at cap 1 across a real hold/queue/handoff/settle sequence (corroborating gate-semaphore-concurrency.mjs's structural proof that the cap genuinely bounds concurrency), surfaces the independent gate-timeout-streak signal so a fresh op on a recently-timed-out branch carries a visible anomaly flag instead of looking indistinguishable from a clean one, and — card b9e07a4a — the separate repoGuardOnly array applies the SAME redaction, including the absolute host repoPath a foreign caller must never see."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
