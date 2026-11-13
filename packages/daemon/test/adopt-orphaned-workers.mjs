import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 11ca11fd — SessionService.adoptOrphanedWorkers: hand a STOPPED manager's live workers (+ wakes,
// questions, ...) to the project's live manager. Proves:
//   (A) success: workers reparented, wake + question moved, audit event filed under the NEW manager, the
//       stale [loom:orphaned-fleet] banner cleared;
//   (B) every server-side refusal (live old, new not live, other project, same id, non-manager roles,
//       recycle-superseded old, no live orphans, unknown ids) throws AdoptOrphanedWorkersRefusalError and
//       moves NOTHING;
//   (C) PARTIAL FAILURE: a non-worker step that keeps failing refuses with NO worker moved (the worker move
//       is the last step), and re-running after the step recovers completes the adopt;
//   (D) REST: Tier-0 — loopback 200 / 400 / 404 / 409, a non-loopback peer is refused and moves nothing;
//   (E) SURFACE: only the Platform Lead router registers the tool (manager/worker/setup/auditor/... never);
//       the platform tool resolves id-prefixes and surfaces a refusal as {error}.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: real Db + SessionService over a fake pty seam.
// Run: 1) build (turbo builds shared first), 2) node test/adopt-orphaned-workers.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-adopt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService, AdoptOrphanedWorkersRefusalError } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { WorkspaceAuditMcpRouter } = await import("../dist/mcp/user-audit.js");
const { RunMcpRouter } = await import("../dist/mcp/run.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const repo = path.join(os.tmpdir(), `loom-adopt-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# adopt-orphaned-workers\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=adopt@loom -c user.name=adopt");

const now = new Date().toISOString();
const db = new Db();
class SeamHost extends createSeamHost(PtyHost) {
  isAlive() { return false; }
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pA", name: "A", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "pB", name: "B", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agA", projectId: "pA", name: "Mgr", startupPrompt: "x", position: 0, profileId: null });
db.insertAgent({ id: "agB", projectId: "pB", name: "MgrB", startupPrompt: "x", position: 0, profileId: null });

const BANNER = "[loom:orphaned-fleet] This manager exited while 1 worker(s)/child session(s) were still live";
const mk = (id, o = {}) => db.insertSession({
  id, projectId: o.projectId ?? "pA", agentId: o.projectId === "pB" ? "agB" : "agA", engineSessionId: `eng-${id}`, title: null, cwd: repo,
  processState: o.processState ?? "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: o.lastError ?? null, role: o.role ?? "manager", parentSessionId: o.parentSessionId ?? null,
  ...(o.recycledFrom ? { recycledFrom: o.recycledFrom } : {}),
  ...(o.taskId ? { taskId: o.taskId } : {}),
});
const parentOf = (id) => db.getSession(id)?.parentSessionId ?? null;
const adoptEvents = (id) => db.listEventsForSession(id).filter((e) => e.kind === "orphaned_workers_adopted");
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const refuse2 = refusal;

// ===================== (A) success =====================
mk("oldA", { processState: "exited", lastError: BANNER });
mk("newA");
db.insertTask({ id: "tA1", projectId: "pA", title: "Task A1", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
mk("wA1", { role: "worker", parentSessionId: "oldA", taskId: "tA1" });
mk("wA2", { role: "worker", parentSessionId: "oldA" });
mk("wA-dead", { role: "worker", parentSessionId: "oldA", processState: "exited" });
db.insertWake({ id: "wakeA", sessionId: "oldA", wakeAt: now, note: "n", createdAt: now });
db.recordPendingOwnerMessage("oldA", "old ask", "2026-01-01T00:00:00.000Z"); db.recordPendingOwnerMessage("oldA", "old ask 2", "2026-01-01T00:01:00.000Z");
db.recordPendingOwnerMessage("newA", "new ask", "2026-02-01T00:00:00.000Z");
svc.capQueue.record("oldA", "agA", null, "queued kickoff");
db.insertQuestion({ id: "qA", sessionId: "oldA", projectId: "pA", type: "decision", title: "q", body: "b", options: null,
  recommendation: null, state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null });
{
  const nudges = [];
  const origEnqueue = svc.enqueueDurableNudge;
  svc.enqueueDurableNudge = (...a) => { nudges.push(a); };
  const r = svc.adoptOrphanedWorkers("oldA", "newA", "platform-lead");
  check("(A) both live workers reparented onto the new manager", parentOf("wA1") === "newA" && parentOf("wA2") === "newA" && r.reparentedWorkers === 2);
  check("(A) result names exactly the live worker ids", JSON.stringify([...r.workerIds].sort()) === JSON.stringify(["wA1", "wA2"]));
  check("(A) an already-exited child is NOT moved", parentOf("wA-dead") === "oldA");
  check("(A) the old manager's wake moved", db.getWake("wakeA")?.sessionId === "newA");
  check("(A) the old manager's question moved", db.getQuestion("qA")?.sessionId === "newA");
  check("(A) the cap-queue entry moved to the new manager", svc.capQueue.listByManager("newA").length === 1 && svc.capQueue.listByManager("oldA").length === 0);
  const mergedPom = db.getPendingOwnerMessage("newA");
  check("(A) pending owner message MERGED: earlier at + its excerpt kept, counts summed (2+1)", mergedPom?.at === "2026-01-01T00:00:00.000Z" && mergedPom?.excerpt === "old ask" && mergedPom?.count === 3);
  check("(A) the old manager's pending owner message is cleared", db.getPendingOwnerMessage("oldA") === null);
  // The durable enqueue is gated on the recipient's MCP-seen signal (never fires on this fake pty), so assert at
  // the service's enqueueDurableNudge boundary: the call that makes the notice durable.
  const notice = nudges.find((n) => String(n[2]).includes("[loom:adopted-workers]"));
  check("(A) a durable [loom:adopted-workers] notice is enqueued to the NEW manager, naming old manager, each live worker and its task",
    !!notice && notice[0] === "newA" && notice[2].includes("oldA") && notice[2].includes("wA1") && notice[2].includes("wA2")
    && notice[2].includes("task tA1") && notice[2].includes("Task A1") && !notice[2].includes("wA-dead"));
  svc.enqueueDurableNudge = origEnqueue;
  const ev = adoptEvents("oldA");
  check("(A) one orphaned_workers_adopted event, filed under the NEW manager, trigger recorded",
    ev.length === 1 && ev[0].managerSessionId === "newA" && ev[0].detail?.trigger === "platform-lead" && ev[0].detail?.reparentedWorkers === 2);
  check("(A) the stale orphaned-fleet banner on the old manager is cleared", db.getSession("oldA")?.lastError == null);
  const again = refusal(() => svc.adoptOrphanedWorkers("oldA", "newA"));
  check("(A) a second adopt refuses: no live orphans left", again instanceof AdoptOrphanedWorkersRefusalError && /no live workers/.test(again.message));
}

// ===================== (B) refusals — each moves NOTHING =====================
{
  mk("oldB", { processState: "exited" }); mk("wB1", { role: "worker", parentSessionId: "oldB" });
  mk("newB");
  const expectRefusal = (label, fn, re) => {
    const e = refusal(fn);
    check(`(B) ${label} -> AdoptOrphanedWorkersRefusalError`, e instanceof AdoptOrphanedWorkersRefusalError && (!re || re.test(e.message)));
    check(`(B) ${label}: no worker moved`, parentOf("wB1") === "oldB");
  };
  mk("liveOld"); mk("wLive", { role: "worker", parentSessionId: "liveOld" });
  expectRefusal("old manager still live", () => svc.adoptOrphanedWorkers("liveOld", "newB"), /still live/);
  check("(B) live old manager: its worker not moved", parentOf("wLive") === "liveOld");
  mk("exitedNew", { processState: "exited" });
  expectRefusal("target not live", () => svc.adoptOrphanedWorkers("oldB", "exitedNew"), /not a live/);
  mk("otherProj", { projectId: "pB" });
  expectRefusal("target in another project", () => svc.adoptOrphanedWorkers("oldB", "otherProj"), /different projects/);
  expectRefusal("target equals old", () => svc.adoptOrphanedWorkers("oldB", "oldB"), /same session/);
  mk("workerTarget", { role: "worker" });
  expectRefusal("target is a worker, not a manager", () => svc.adoptOrphanedWorkers("oldB", "workerTarget"), /not a manager/);
  mk("platOld", { processState: "exited", role: "platform" });
  check("(B) old is a platform lead (not a manager) -> refused",
    refusal(() => svc.adoptOrphanedWorkers("platOld", "newB")) instanceof AdoptOrphanedWorkersRefusalError);
  expectRefusal("unknown target id", () => svc.adoptOrphanedWorkers("oldB", "nope-nope"), /not found/);
  check("(B) unknown old id -> refused", refusal(() => svc.adoptOrphanedWorkers("nope-nope", "newB")) instanceof AdoptOrphanedWorkersRefusalError);
  // recycle-superseded old manager: a successor row links back via recycledFrom
  mk("supOld", { processState: "exited" }); mk("wSup", { role: "worker", parentSessionId: "supOld" });
  mk("supSucc", { recycledFrom: "supOld" });
  const sup = refusal(() => svc.adoptOrphanedWorkers("supOld", "newB"));
  check("(B) recycle-superseded old manager -> refused (its recycle owns the fleet)", sup instanceof AdoptOrphanedWorkersRefusalError && /recycle/.test(sup.message));
  check("(B) recycle-superseded old manager: worker not moved", parentOf("wSup") === "supOld");
  // `starting` (resume/respawn in flight, crash recovery resuming the manager before its workers) is NOT stopped
  mk("startOld", { processState: "starting" }); mk("wStart", { role: "worker", parentSessionId: "startOld" });
  const starting = refuse2(() => svc.adoptOrphanedWorkers("startOld", "newB"));
  check("(B) old manager in `starting` -> refused as not stopped", starting instanceof AdoptOrphanedWorkersRefusalError && /not stopped \(starting\)/.test(starting.message));
  check("(B) `starting` old manager: worker not moved", parentOf("wStart") === "startOld");
  mk("noneOld", { processState: "none" }); mk("wNone", { role: "worker", parentSessionId: "noneOld" });
  check("(B) old manager in `none` is accepted as stopped (adopt succeeds)", svc.adoptOrphanedWorkers("noneOld", "newB").reparentedWorkers === 1 && parentOf("wNone") === "newB");
  // an UNRESOLVED halted recycle: point the caller at recycle_reattempt
  mk("haltOld", { processState: "exited" }); mk("wHalt", { role: "worker", parentSessionId: "haltOld" });
  mk("haltSucc", { recycledFrom: "haltOld" });
  db.appendEvent({ id: "ev-halt", ts: new Date().toISOString(), managerSessionId: "haltSucc", workerSessionId: "haltOld",
    kind: "recycle_ownership_transfer_failed", detail: { gen: db.getSession("haltSucc").gen } });
  const halted = refuse2(() => svc.adoptOrphanedWorkers("haltOld", "newB"));
  check("(B) unresolved halted recycle -> refused, pointing at recycle_reattempt", halted instanceof AdoptOrphanedWorkersRefusalError && /recycle_reattempt/.test(halted.message));
  check("(B) halted old manager: worker not moved", parentOf("wHalt") === "haltOld");
  mk("emptyOld", { processState: "exited" });
  const none = refusal(() => svc.adoptOrphanedWorkers("emptyOld", "newB"));
  check("(B) no live orphans -> refused", none instanceof AdoptOrphanedWorkersRefusalError && /no live workers/.test(none.message));
  check("(B) none of the refusals filed an audit event", adoptEvents("oldB").length === 0 && adoptEvents("emptyOld").length === 0);
}

// ===================== (C) partial failure: workers are the LAST step =====================
{
  mk("oldC", { processState: "exited", lastError: BANNER });
  mk("newC");
  mk("wC1", { role: "worker", parentSessionId: "oldC" });
  db.insertQuestion({ id: "qC", sessionId: "oldC", projectId: "pA", type: "decision", title: "q", body: "b", options: null,
    recommendation: null, state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null });
  const original = Db.prototype.reparentQuestions;
  let calls = 0;
  Db.prototype.reparentQuestions = function () { calls++; throw new Error("injected PERMANENT failure (scenario C)"); };
  try {
    const e = refusal(() => svc.adoptOrphanedWorkers("oldC", "newC"));
    check("(C) a permanently failing step refuses, naming the step", e instanceof AdoptOrphanedWorkersRefusalError && /questions/.test(e.message));
    check("(C) the failing step was retried exactly once (2 calls)", calls === 2);
    check("(C) the refusal text says re-run finishes it and warns resuming the old manager loses the moved state",
      /re-run this adopt to finish/.test(e.message) && /Resuming the old manager instead/.test(e.message));
    check("(C) NO worker moved when a non-worker step failed (workers are the commit point)", parentOf("wC1") === "oldC");
    check("(C) no audit event on the failed attempt", adoptEvents("oldC").length === 0);
  } finally {
    Db.prototype.reparentQuestions = original;
  }
  const r = svc.adoptOrphanedWorkers("oldC", "newC");
  check("(C) re-running after the step recovers completes the adopt", r.reparentedWorkers === 1 && parentOf("wC1") === "newC" && db.getQuestion("qC")?.sessionId === "newC");
}

// ===================== (D) REST route: Tier-0 =====================
{
  mk("oldD", { processState: "exited" }); mk("newD"); mk("wD1", { role: "worker", parentSessionId: "oldD" });
  const stub = {};
  const app = await buildServer({
    db, pty: stub, sessions: svc, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub,
    setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
  });
  try {
    const url = (id) => `/api/sessions/${id}/adopt-orphaned-workers`;
    const post = (id, payload, remoteAddress) => app.inject({ method: "POST", url: url(id), payload, ...(remoteAddress ? { remoteAddress } : {}) });
    check("(D) missing newManagerId -> 400", (await post("oldD", {})).statusCode === 400);
    check("(D) unknown old id -> 404", (await post("00000000-0000-0000-0000-000000000000", { newManagerId: "newD" })).statusCode === 404);
    check("(D) unknown new id -> 404", (await post("oldD", { newManagerId: "00000000-0000-0000-0000-000000000000" })).statusCode === 404);
    const live = await post("newD", { newManagerId: "newD" });
    check("(D) a refusal (same session / live) -> 409", live.statusCode === 409 && typeof JSON.parse(live.payload).error === "string");
    const remote = await post("oldD", { newManagerId: "newD" }, "10.20.30.40");
    check("(D) a NON-loopback peer is refused (not 2xx, not the service's 409)", remote.statusCode >= 400 && remote.statusCode !== 409 && remote.statusCode !== 404);
    check("(D) the non-loopback attempt moved nothing", parentOf("wD1") === "oldD");
    const ok = await post("oldD", { newManagerId: "newD" });
    const body = JSON.parse(ok.payload);
    check("(D) loopback success -> 200 with the result", ok.statusCode === 200 && body.reparentedWorkers === 1 && parentOf("wD1") === "newD");
    check("(D) the REST trigger is recorded as human-rest", adoptEvents("oldD")[0]?.detail?.trigger === "human-rest");
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
}

// ===================== (E) MCP surface =====================
{
  const TOOL = "session_adopt_orphaned_workers";
  const PATTERN = /adopt.?orphan/i;
  const names = async (server) => {
    const client = new Client({ name: "adopt-surface", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const n = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    return n;
  };
  const roles = ["manager", "worker", "assistant", "platform", "setup", "auditor", "workspace-auditor", "run"];
  for (const role of roles) mk(`s-${role}`, { role });
  const orch = new OrchestrationMcpRouter(db, {});
  const platform = new PlatformMcpRouter(db, {});
  const surfaces = [
    ["orchestration/manager", orch.buildServer("s-manager", "manager")],
    ["orchestration/worker", orch.buildServer("s-worker", "worker")],
    ["orchestration/assistant", orch.buildServer("s-assistant", "assistant")],
    ["orchestration/platform", orch.buildServer("s-platform", "platform")],
    ["setup", new SetupMcpRouter(db, {}).buildServer("s-setup")],
    ["audit", new AuditMcpRouter(db, {}).buildServer("s-auditor")],
    ["workspace-audit", new WorkspaceAuditMcpRouter(db, {}).buildServer("s-workspace-auditor")],
    ["run", new RunMcpRouter(db, {}).buildServer("s-run")],
    ["tasks/manager", new TaskMcpRouter(db, {}).buildServer("pA", "s-manager")],
    ["tasks/worker", new TaskMcpRouter(db, {}).buildServer("pA", "s-worker")],
  ];
  for (const [label, server] of surfaces) {
    check(`(E) ${label}: no adopt-orphaned tool`, !(await names(server)).some((n) => PATTERN.test(n)));
  }
  check("(E) RED proof: the sweep pattern matches the real platform tool name", PATTERN.test(TOOL));
  const platServer = platform.buildServer("s-platform");
  check("(E) the Platform Lead router DOES register it", (await names(platServer)).includes(TOOL));

  const platformWithSessions = new PlatformMcpRouter(db, svc);
  const client = new Client({ name: "adopt-tool", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([platformWithSessions.buildServer("s-platform").connect(st), client.connect(ct)]);
  const call = async (args) => JSON.parse((await client.callTool({ name: TOOL, arguments: args })).content[0].text);
  mk("oldE", { processState: "exited" }); mk("newE"); mk("wE1", { role: "worker", parentSessionId: "oldE" });
  const bad = await call({ oldManagerId: "oldE", newManagerId: "oldE" });
  check("(E) tool surfaces a refusal as {error}", typeof bad.error === "string" && parentOf("wE1") === "oldE");
  const good = await call({ oldManagerId: "oldE", newManagerId: "newE" });
  check("(E) tool adopts and moves the worker", good.reparentedWorkers === 1 && parentOf("wE1") === "newE");
  check("(E) the tool's trigger is recorded as platform-lead", adoptEvents("oldE")[0]?.detail?.trigger === "platform-lead");
  await client.close();
}

db.close();
cleanupPathSync(tmpHome);
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — adoptOrphanedWorkers: success + every refusal moves nothing, a failing non-worker step leaves the workers untouched and a re-run completes, the REST route is Tier-0, and only the Platform Lead surface registers the tool."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
