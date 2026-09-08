import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// events_search on the MANAGER surface (card 60c1fff8): the real registration already existed only on
// the LOOM_DEV-gated Platform surface (mcp/platform.ts) — a manager had no way to query the durable
// event store at all, so any card whose DoD is "search the event log for X" was structurally
// undischargeable by its own named reader (escalation 406976ce). This is the manager-surface read path:
// a THIN registration on OrchestrationMcpRouter reusing the SAME query code (`eventsSearchQuery`, shared
// via mcp/eventsSearch.js) the Platform surface already used — never a second, hand-copied predicate.
//
// PROJECT-SCOPED SERVER-SIDE, NOT BY ARGUMENT — identical posture to `gate_history` (see gate-history.mjs)
// and `gate_queue`: there is no `projectId` parameter, so a caller cannot even ASK for another project's
// rows. Proves that structurally (a `projectId` arg is hard-rejected by the strict schema, not silently
// dropped) AND proves that every OTHER input the tool accepts (kind, sessionId, taskId) still cannot
// surface a foreign project's row — not the happy path alone (DoD-2).
//
// Also proves DoD-3: the known companion hazard from card 009c1ae5 (events_search silently returning []
// on an unrecognized `kind`, partially fixed by card 529e4b73) does not regress on the manager surface —
// an unknown kind is a hard, explicit error here too, naming the bad value, via the SAME validation the
// Platform surface uses (platform-forensics-reads.mjs already proves this for that surface; this file is
// the manager-surface sibling proof, not a re-derivation of the platform test).
//
// Run: 1) build (turbo builds shared first), 2) node test/events-search-manager-surface.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-es-mgr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();

function seed(db) {
  const uniq = randomUUID().slice(0, 8);
  const P1 = `es-own-${Date.now()}-${uniq}`, P2 = `es-foreign-${Date.now()}-${uniq}`;
  db.insertProject({ id: P1, name: "Own Project", repoPath: `/tmp/${P1}`, vaultPath: `/tmp/${P1}`, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: P2, name: "Foreign Project", repoPath: `/tmp/${P2}`, vaultPath: `/tmp/${P2}`, config: {}, createdAt: now, archivedAt: null });
  const a1 = `${P1}-a1`, a2 = `${P2}-a2`;
  db.insertAgent({ id: a1, projectId: P1, name: "dev-1", startupPrompt: "", position: 0 });
  db.insertAgent({ id: a2, projectId: P2, name: "dev-2", startupPrompt: "", position: 0 });
  const t1 = `${P1}-task`, t2 = `${P2}-task`;
  db.insertTask({ id: t1, projectId: P1, title: "Own project task title", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertTask({ id: t2, projectId: P2, title: "Foreign project task title — must never leak", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const mgr1 = `${P1}-mgr`, mgr2 = `${P2}-mgr`;
  db.insertSession({ id: mgr1, projectId: P1, agentId: a1, engineSessionId: null, title: null, cwd: `/tmp/${P1}`, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: mgr2, projectId: P2, agentId: a2, engineSessionId: null, title: null, cwd: `/tmp/${P2}`, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const w1 = `${P1}-wkr`, w2 = `${P2}-wkr`;
  db.insertSession({ id: w1, projectId: P1, agentId: a1, engineSessionId: null, title: null, cwd: `/tmp/${P1}`, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t1, worktreePath: `/tmp/${P1}-wt`, branch: "loom/p1-branch" });
  db.insertSession({ id: w2, projectId: P2, agentId: a2, engineSessionId: null, title: null, cwd: `/tmp/${P2}`, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t2, worktreePath: `/tmp/${P2}-wt`, branch: "loom/p2-branch" });

  // P1 events: one gate kind, one non-gate kind (proves this tool isn't limited to gate_history's kinds).
  db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() - 3000).toISOString(), managerSessionId: mgr1, workerSessionId: w1, taskId: t1, kind: "build_gate", detail: { passed: true, durationMs: 111 } });
  db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() - 2000).toISOString(), managerSessionId: mgr1, workerSessionId: null, taskId: null, kind: "kill_switch", detail: { reason: "test" } });

  // P2 events — the foreign project's data. Must never surface for a P1-scoped caller, through ANY input.
  db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() - 1500).toISOString(), managerSessionId: mgr2, workerSessionId: w2, taskId: t2, kind: "build_gate", detail: { passed: true, durationMs: 222 } });
  db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() - 1000).toISOString(), managerSessionId: mgr2, workerSessionId: null, taskId: null, kind: "kill_switch", detail: { reason: "foreign" } });

  return { P1, P2, mgr1, mgr2, w1, w2, t1, t2 };
}

{
  const dbs = [];
  try {
    const db = new Db();
    dbs.push(db);
    const { P1, P2, mgr1, w1, w2, t2 } = seed(db);

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});
    const router = new OrchestrationMcpRouter(db, sessions);

    const connect = async (sessionId, role) => {
      const server = router.buildServer(sessionId, role);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: `events-search-${sessionId}`, version: "0" });
      await client.connect(clientT);
      return { server, client, call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args ?? {} })).content[0].text), raw: (name, args) => client.callTool({ name, arguments: args ?? {} }) };
    };

    const mgr = await connect(mgr1, "manager");
    check("(1) events_search IS registered on the manager's own MCP surface", Object.keys(mgr.server._registeredTools).includes("events_search"));

    // ── (1) callable from a manager session, returning only that project's rows (DoD-1) ──────────────────
    const all = await mgr.call("events_search");
    check("(1) no-filter read returns an envelope, ALWAYS {events,total,returned,offset,nextOffset}", Array.isArray(all.events) && typeof all.total === "number" && typeof all.returned === "number" && all.offset === 0 && "nextOffset" in all);
    check("(1) total reflects ONLY P1's 2 rows (never P2's 2)", all.total === 2 && all.events.length === 2);
    check("(1) the foreign project's id/name/task title never appear anywhere in the response", !JSON.stringify(all).includes(P2) && !JSON.stringify(all).includes("Foreign Project") && !JSON.stringify(all).includes("Foreign project task title"));

    // ── (2) cross-project rows unreachable through EVERY input the tool accepts, not just no-filter ───────
    const noProjectIdParam = await mgr.raw("events_search", { projectId: P2 });
    check("(2a) `projectId` is HARD-REJECTED by the strict schema (isError) — there is no argument channel to another project at all", noProjectIdParam.isError === true);
    check("(2a) the rejection names the unrecognized param", typeof noProjectIdParam.content?.[0]?.text === "string" && noProjectIdParam.content[0].text.includes("projectId"));

    const byKind = await mgr.call("events_search", { kind: ["build_gate"] });
    check("(2b) kind-filtered read still returns ONLY P1's row (1), never P2's build_gate row", byKind.total === 1 && byKind.events.length === 1 && byKind.events[0].detail.durationMs === 111);

    const byForeignSessionId = await mgr.call("events_search", { sessionId: w2 });
    check("(2c) filtering by the FOREIGN project's own session id returns EMPTY, not that session's P2 rows", byForeignSessionId.total === 0 && byForeignSessionId.events.length === 0);

    const byForeignTaskId = await mgr.call("events_search", { taskId: t2 });
    check("(2d) filtering by the FOREIGN project's own task id returns EMPTY, not that task's P2 rows", byForeignTaskId.total === 0 && byForeignTaskId.events.length === 0);

    const byBogusSessionId = await mgr.call("events_search", { sessionId: "does-not-exist" });
    check("(2e) filtering by a session id that matches nothing at all also returns EMPTY (no crash, no leak)", byBogusSessionId.total === 0);

    // Positive control: proves the P1-only results above are the scoping filter actually working, not an
    // accidental global absence of P2's data — an UNSCOPED db read (no projectId) sees both.
    const unscoped = db.listOrchestrationEventsBounded({ projectId: null, limit: 100, offset: 0 });
    check("(2f) POSITIVE CONTROL: an unscoped db-level read DOES see all 4 rows across both projects (proves the tool's scoping, not an accidental absence)", unscoped.total === 4);

    // ── (3) an unknown `kind` is REJECTED, never a silent [] — on the manager surface specifically ────────
    const badKind = await mgr.call("events_search", { kind: ["not_a_real_kind"] });
    check("(3) NEGATIVE CONTROL: an UNRECOGNIZED kind is an explicit error (never a silent []), naming the bad value", typeof badKind.error === "string" && badKind.error.includes("not_a_real_kind"));
    check("(3) the rejection names real valid kinds so a caller can pick without guessing", badKind.error.includes("build_gate") && badKind.error.includes("kill_switch"));
    const mixedKind = await mgr.call("events_search", { kind: ["build_gate", "not_a_real_kind"] });
    check("(3) a MIX of one valid + one invalid kind is still rejected wholesale (never silently drops the bad one)", typeof mixedKind.error === "string" && mixedKind.error.includes("not_a_real_kind"));
    // Positive control: proves the rejection above is real (kind DOES matter), not a schema-level fluke —
    // a KNOWN-GOOD kind with a known-present event returns it.
    const goodKind = await mgr.call("events_search", { kind: ["kill_switch"] });
    check("(3) POSITIVE CONTROL: a known-good kind with a known-present event returns it", goodKind.total === 1 && goodKind.events[0].kind === "kill_switch");

    await mgr.client.close();

    // ── role gate: events_search is a MANAGER-ONLY read, absent from the worker's pinned depth-1 surface —
    // it is investigative forensics, not a live-op check a worker needs; the pinned set is unchanged. ─────
    const wkr = await connect(w1, "worker");
    const wTools = Object.keys(wkr.server._registeredTools);
    check("(4) events_search is NOT on the worker's surface", !wTools.includes("events_search"));
    check("(4) worker surface is STILL EXACTLY the pinned 7-tool set (unchanged by this card)",
      wTools.slice().sort().join(",") === "directive_status,gate_cancel,gate_queue,gate_status,my_context,run_gate,worker_report");
    await wkr.client.close();
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — events_search is registered on the manager surface, project-scoped SERVER-SIDE (no projectId argument exists, and every other input the tool accepts still cannot surface a foreign project's row), reuses the SAME query/validation code the Platform surface uses (an unknown kind is rejected here too), and stays off the worker's pinned depth-1 surface."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
