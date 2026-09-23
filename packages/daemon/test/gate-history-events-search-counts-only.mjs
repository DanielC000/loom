import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card eb62d585 — `countsOnly:true` on `gate_history` and `events_search`: a `countsOnly`-shaped
// aggregate on both tools, reusing EACH TOOL'S OWN EXISTING FILTER SET, mirroring `tasks_list`'s own
// `countsOnly` (card 9798200c's `countProjectTasks`). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL
// Db + the REAL routers (manager surface via OrchestrationMcpRouter, platform surface via
// PlatformMcpRouter) driven over an in-process MCP InMemoryTransport, mirroring
// events-search-manager-surface.mjs / gate-history.mjs / platform-forensics-reads.mjs.
//
// Proves the DoD:
//   (1) `countsOnly:true` on `gate_history` returns {total, byGateType, byOutcome} — no `items` — reusing
//       gate_history's OWN project-scope (no other filter exists on that tool).
//   (2) `countsOnly:true` on `events_search` (manager AND platform surfaces) returns {total, byKind} — no
//       `events` — honouring the SAME kind/sessionId/taskId filters the row-returning path accepts, and
//       the SAME unrecognized-`kind` validation (an error, never a silent empty result).
//   (3) Both counts are PROJECT-SCOPED identically to the row-returning path — a foreign project's rows
//       never contribute, proven both negatively (a P1-scoped caller sees only P1) and positively (an
//       UNSCOPED db-level read sees both projects' rows, so the 0-attribution above is the scoping doing
//       its job, not an accidental absence of P2 data).
//   (4) PARITY: countsOnly's `total` matches the row-returning path's own `total` field for the identical
//       filter set — the aggregate is answering the SAME question, just without the rows.
//   (5) 🔴 THE LOAD-BEARING ASSERTION: countsOnly SHORT-CIRCUITS BEFORE any row materialisation — proven
//       by monkey-patching `Db.listGateEvents`/`Db.listOrchestrationEventsBounded` (the row-fetching,
//       JOIN-enriched, spill-eligible path) to THROW, then calling the tool with countsOnly:true and
//       asserting it does NOT throw and still returns the correct numbers — the heavy path was never
//       reached. A POSITIVE CONTROL immediately follows: the SAME monkey-patched db, called WITHOUT
//       countsOnly, DOES throw — proving the patch is genuinely wired into the call path this test cares
//       about, not a no-op that would let assertion (5) pass for the wrong reason (an assertion that only
//       checks the return value, not the short-circuit itself — the exact defect this card exists to
//       remove per its own DoD-4).
//
// Run: 1) build (turbo builds shared first), 2) node test/gate-history-events-search-counts-only.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ghes-counts-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();

function seed(db) {
  const uniq = randomUUID().slice(0, 8);
  const P1 = `ghes-own-${Date.now()}-${uniq}`, P2 = `ghes-foreign-${Date.now()}-${uniq}`;
  db.insertProject({ id: P1, name: "Own Project", repoPath: `/tmp/${P1}`, vaultPath: `/tmp/${P1}`, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: P2, name: "Foreign Project", repoPath: `/tmp/${P2}`, vaultPath: `/tmp/${P2}`, config: {}, archivedAt: null, createdAt: now });
  const a1 = `${P1}-a1`, a2 = `${P2}-a2`;
  db.insertAgent({ id: a1, projectId: P1, name: "dev-1", startupPrompt: "", position: 0 });
  db.insertAgent({ id: a2, projectId: P2, name: "dev-2", startupPrompt: "", position: 0 });
  const t1 = `${P1}-task`, t2 = `${P2}-task`;
  db.insertTask({ id: t1, projectId: P1, title: "Own project task title", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertTask({ id: t2, projectId: P2, title: "Foreign project task title", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const mgr1 = `${P1}-mgr`, mgr2 = `${P2}-mgr`, plat1 = `${P1}-plat`;
  db.insertSession({ id: mgr1, projectId: P1, agentId: a1, engineSessionId: null, title: null, cwd: `/tmp/${P1}`, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: mgr2, projectId: P2, agentId: a2, engineSessionId: null, title: null, cwd: `/tmp/${P2}`, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: plat1, projectId: P1, agentId: a1, engineSessionId: null, title: null, cwd: `/tmp/${P1}`, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });
  const w1 = `${P1}-wkr`, w2 = `${P2}-wkr`;
  db.insertSession({ id: w1, projectId: P1, agentId: a1, engineSessionId: null, title: null, cwd: `/tmp/${P1}`, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t1, worktreePath: `/tmp/${P1}-wt`, branch: "loom/p1-branch" });
  db.insertSession({ id: w2, projectId: P2, agentId: a2, engineSessionId: null, title: null, cwd: `/tmp/${P2}`, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t2, worktreePath: `/tmp/${P2}-wt`, branch: "loom/p2-branch" });

  // P1: 7 GATE_HISTORY_KINDS events across all three gateTypes + four outcomes, PLUS one excluded
  // build_gate_retry_attempt marker (proves it stays excluded from gate_history's total) and one
  // non-gate kind (kill_switch — proves gate_history's kind filter, and gives events_search's byKind
  // something extra to count that gate_history must NOT).
  //   worker: pass, reject (2)
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgr1, workerSessionId: w1, taskId: t1, kind: "worker_gate", detail: { passed: true, durationMs: 100 } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgr1, workerSessionId: w1, taskId: t1, kind: "worker_gate", detail: { passed: false, durationMs: 50 } });
  //   merge (build_gate/build_gate_retry): pass, cancelled, reject, skipped (4)
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgr1, workerSessionId: w1, taskId: t1, kind: "build_gate", detail: { passed: true, durationMs: 200 } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgr1, workerSessionId: w1, taskId: t1, kind: "build_gate", detail: { cancelled: true } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgr1, workerSessionId: w1, taskId: t1, kind: "build_gate_retry", detail: { passed: false, durationMs: 80 } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgr1, workerSessionId: w1, taskId: t1, kind: "build_gate", detail: { skipped: true, passed: true } });
  //   deploy: pass (1)
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgr1, workerSessionId: null, taskId: null, kind: "deploy", detail: { passed: true, durationMs: 300 } });
  //   excluded from GATE_HISTORY_KINDS (marker-only) — must NOT contribute to gate_history's total
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgr1, workerSessionId: w1, taskId: t1, kind: "build_gate_retry_attempt", detail: {} });
  //   non-gate kind — must NOT contribute to gate_history's total, but DOES count for events_search
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgr1, workerSessionId: null, taskId: null, kind: "kill_switch", detail: { reason: "test" } });

  // P2 (foreign): 2 gate events with a DIFFERENT outcome/type mix, so a scoping bug that merely returns
  // "P1's shape" by coincidence would be caught.
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgr2, workerSessionId: w2, taskId: t2, kind: "worker_gate", detail: { passed: false, durationMs: 20 } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgr2, workerSessionId: w2, taskId: t2, kind: "build_gate", detail: { passed: true, durationMs: 40 } });

  return { P1, P2, mgr1, mgr2, plat1, w1, w2, t1, t2 };
}

{
  const dbs = [];
  try {
    const db = new Db();
    dbs.push(db);
    const { P1, P2, mgr1, mgr2, plat1 } = seed(db);

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});
    const orchRouter = new OrchestrationMcpRouter(db, sessions);
    const platRouter = new PlatformMcpRouter(db, sessions);

    const connect = async (server, name) => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name, version: "0" });
      await client.connect(clientT);
      return { client, call: async (n, args) => JSON.parse((await client.callTool({ name: n, arguments: args ?? {} })).content[0].text) };
    };

    const mgr1c = await connect(orchRouter.buildServer(mgr1, "manager"), "ghes-mgr1");
    const mgr2c = await connect(orchRouter.buildServer(mgr2, "manager"), "ghes-mgr2");
    const platc = await connect(platRouter.buildServer(plat1), "ghes-plat1");

    // ═══════════════════════════ (1) gate_history countsOnly — shape + numbers ═══════════════════════
    const ghCounts = await mgr1c.call("gate_history", { countsOnly: true });
    check("(1) countsOnly response has NO `items`/`offset`/`nextOffset` (not a page envelope)", ghCounts.items === undefined && ghCounts.offset === undefined && ghCounts.nextOffset === undefined);
    check("(1) total excludes the build_gate_retry_attempt marker and the kill_switch non-gate row (7, not 9)", ghCounts.total === 7);
    check("(1) byGateType: worker:2, merge:4 (build_gate x3 + build_gate_retry x1), deploy:1",
      ghCounts.byGateType.worker === 2 && ghCounts.byGateType.merge === 4 && ghCounts.byGateType.deploy === 1);
    check("(1) byOutcome: pass:3 (worker+merge+deploy), reject:2, cancelled:1, skipped:1",
      ghCounts.byOutcome.pass === 3 && ghCounts.byOutcome.reject === 2 && ghCounts.byOutcome.cancelled === 1 && ghCounts.byOutcome.skipped === 1);
    const ghSumType = Object.values(ghCounts.byGateType).reduce((a, b) => a + b, 0);
    const ghSumOutcome = Object.values(ghCounts.byOutcome).reduce((a, b) => a + b, 0);
    check("(1) byGateType and byOutcome each sum to total (no row double-counted or dropped)", ghSumType === ghCounts.total && ghSumOutcome === ghCounts.total);

    // ═══════════════════════════ (4) PARITY — countsOnly.total === the row-returning path's total ══════
    const ghPage = await mgr1c.call("gate_history", { limit: 100 });
    check("(4) gate_history countsOnly.total matches the paginated read's own `total` for the same scope", ghPage.total === ghCounts.total && ghPage.total === 7);

    // ═══════════════════════════ (3) gate_history — foreign-project scoping, both directions ══════════
    const ghCountsP2 = await mgr2c.call("gate_history", { countsOnly: true });
    check("(3a) P2's own countsOnly sees ONLY its 2 rows (never P1's 7)", ghCountsP2.total === 2 && ghCountsP2.byGateType.worker === 1 && ghCountsP2.byGateType.merge === 1);
    check("(3a) P2's outcome mix is its OWN (reject:1, pass:1) — not coincidentally P1's shape", ghCountsP2.byOutcome.reject === 1 && ghCountsP2.byOutcome.pass === 1 && ghCountsP2.byOutcome.cancelled === undefined);
    const ghUnscoped = db.countGateEvents({ projectId: null });
    check("(3b) POSITIVE CONTROL: an UNSCOPED db-level count sees BOTH projects' gate rows (7+2=9) — proves the P1/P2 split above is the scoping doing its job, not an accidental absence", ghUnscoped.total === 9);

    // ═══════════════════════════ (2) events_search countsOnly — shape + numbers + kind filter ═════════
    const esCounts = await mgr1c.call("events_search", { countsOnly: true });
    check("(2) countsOnly response has NO `events`/`offset`/`nextOffset`", esCounts.events === undefined && esCounts.offset === undefined && esCounts.nextOffset === undefined);
    check("(2) total includes EVERY kind (9), unlike gate_history's filtered 7", esCounts.total === 9);
    check("(2) byKind: worker_gate:2, build_gate:3, build_gate_retry:1, deploy:1, build_gate_retry_attempt:1, kill_switch:1",
      esCounts.byKind.worker_gate === 2 && esCounts.byKind.build_gate === 3 && esCounts.byKind.build_gate_retry === 1 &&
      esCounts.byKind.deploy === 1 && esCounts.byKind.build_gate_retry_attempt === 1 && esCounts.byKind.kill_switch === 1);
    const esByKindFiltered = await mgr1c.call("events_search", { countsOnly: true, kind: ["build_gate"] });
    check("(2) the `kind` filter narrows countsOnly exactly like the row-returning path — total:3, byKind only has build_gate", esByKindFiltered.total === 3 && Object.keys(esByKindFiltered.byKind).length === 1 && esByKindFiltered.byKind.build_gate === 3);

    // ═══════════════════════════ (4) PARITY for events_search ═══════════════════════════════════════
    const esPage = await mgr1c.call("events_search", { limit: 100 });
    check("(4) events_search countsOnly.total matches the row-returning path's own `total`", esPage.total === esCounts.total && esPage.total === 9);

    // ═══════════════════════════ (3) events_search — foreign-project scoping, both directions ═══════
    const esCountsP2 = await mgr2c.call("events_search", { countsOnly: true });
    check("(3c) P2's own events_search countsOnly sees ONLY its 2 rows", esCountsP2.total === 2 && esCountsP2.byKind.worker_gate === 1 && esCountsP2.byKind.build_gate === 1);
    const esUnscoped = db.countOrchestrationEventsBounded({ projectId: null });
    check("(3d) POSITIVE CONTROL: an UNSCOPED db-level count sees BOTH projects' events (9+2=11)", esUnscoped.total === 11);

    // ═══ unrecognized kind is still an explicit error under countsOnly, same validation as the row path ═══
    const esBadKind = await mgr1c.call("events_search", { countsOnly: true, kind: ["not_a_real_kind"] });
    check("countsOnly reuses the SAME kind validation — an unrecognized kind is an explicit error, never a silent empty count", typeof esBadKind.error === "string" && esBadKind.error.includes("not_a_real_kind"));

    // ═══════════════════════════ Platform surface: events_search countsOnly ═══════════════════════════
    const platToolNames = (await platc.client.listTools?.()) ?? null; // not required; smoke only below
    const platCountsAll = await platc.call("events_search", { countsOnly: true, projectId: P1 });
    check("Platform surface events_search countsOnly, scoped to P1 via its own projectId arg, matches the manager surface's own total", platCountsAll.total === 9 && platCountsAll.byKind.build_gate === 3);
    const platCountsUnscoped = await platc.call("events_search", { countsOnly: true });
    check("Platform surface events_search countsOnly with NO projectId sums across every project (>= P1+P2's own 11)", platCountsUnscoped.total >= 11);

    // ═══════════════════════════ (5) 🔴 THE SHORT-CIRCUIT PROOF ═══════════════════════════════════════
    const realListGateEvents = db.listGateEvents.bind(db);
    const realListOrchEvents = db.listOrchestrationEventsBounded.bind(db);
    db.listGateEvents = () => { throw new Error("listGateEvents (row-fetching path) was called — countsOnly did NOT short-circuit"); };
    db.listOrchestrationEventsBounded = () => { throw new Error("listOrchestrationEventsBounded (row-fetching path) was called — countsOnly did NOT short-circuit"); };
    try {
      const ghUnderPatch = await mgr1c.call("gate_history", { countsOnly: true });
      check("(5) gate_history countsOnly does NOT throw with listGateEvents patched to throw — the heavy path was never reached", ghUnderPatch.total === 7 && ghUnderPatch.error === undefined);
      const esUnderPatch = await mgr1c.call("events_search", { countsOnly: true });
      check("(5) events_search countsOnly does NOT throw with listOrchestrationEventsBounded patched to throw — the heavy path was never reached", esUnderPatch.total === 9 && esUnderPatch.error === undefined);

      // POSITIVE CONTROL: the SAME patched db, called WITHOUT countsOnly, DOES throw — proves the patch
      // is genuinely wired into the call path, not a no-op that would make the assertions above pass
      // for the wrong reason (a countsOnly call that coincidentally never fails regardless of the patch).
      let ghThrew = false;
      try { await mgr1c.call("gate_history", { limit: 10 }); } catch { ghThrew = true; }
      check("(5) POSITIVE CONTROL: gate_history WITHOUT countsOnly DOES throw under the same patch (proves the patch is live, not vacuous)", ghThrew === true);
      let esThrew = false;
      try { await mgr1c.call("events_search", { limit: 10 }); } catch { esThrew = true; }
      check("(5) POSITIVE CONTROL: events_search WITHOUT countsOnly DOES throw under the same patch (proves the patch is live, not vacuous)", esThrew === true);
    } finally {
      db.listGateEvents = realListGateEvents;
      db.listOrchestrationEventsBounded = realListOrchEvents;
    }

    // Sanity: with the real methods restored, both tools work normally again.
    const ghRestored = await mgr1c.call("gate_history", { limit: 10 });
    check("gate_history works normally again after restoring the real method", Array.isArray(ghRestored.items) && ghRestored.total === 7);

    await mgr1c.client.close();
    await mgr2c.client.close();
    await platc.client.close();
    void P2; void platToolNames;
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `countsOnly:true` on gate_history/events_search (manager + platform surfaces) returns a {total, by...} aggregate that (a) matches the row-returning path's own total, (b) stays project-scoped identically to the row path (foreign rows never contribute, proven both negatively and via an unscoped positive control), (c) still validates `kind` the same way, and (d) — the load-bearing DoD-4 assertion — genuinely short-circuits before the row-fetching/JOIN-enriched/spill-eligible path, proven by a throw-on-call monkeypatch of Db.listGateEvents/listOrchestrationEventsBounded plus a positive control showing the SAME patch does trip the ordinary row-returning path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
