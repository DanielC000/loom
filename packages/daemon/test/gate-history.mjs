import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// gate_history() (card 753d9911): `listGateEvents` (db.ts) already reads the complete, paginated,
// JOIN-enriched settled-gate-run series — INCLUDING rejected runs, whose durationMs/gateCap/
// concurrentGates are stamped unconditionally, before any pass/fail branching — but until this card it was
// wired to exactly ONE consumer, the human-only web Gates page. No MCP tool existed. Proves:
//   (unit)  Db.listGateEvents + the toGateHistoryRow mapper: a REJECTED row is returned with its
//           durationMs/gateCap/concurrentGates intact and passed:false (the whole point of this card — the
//           case the nudge/gate_status/gate_queue trio all drop), scoped to ONE project's rows only.
//   (e2e)   the REAL MCP tool `gate_history`, registered on the MANAGER surface only (never the worker's
//           pinned depth-1 surface — this is an investigative/trend read, not a live-op check), driven
//           against a REAL router/client. A caller scoped to project P1 gets ONLY P1's rows — a foreign
//           project's rows are never returned at all (stronger than gate_queue's own field-level
//           redaction: there is nothing to redact because there is nothing foreign in the payload), and
//           the foreign project's task title never appears anywhere in the JSON.
//   (card 3aec1df6) a merge row's `failingTest` reads `null` BY CONSTRUCTION (a real `build_gate` event
//           never carries it — the diagnostic lives on the separate, excluded `merge_rejected` event and,
//           since 9f6598dd, on `pending_gate_ops`) — and the row now carries `opId`, the reachability key
//           to that detail. The (unit)/(e2e) blocks above prove the MAPPER against a synthetic fixture;
//           the (e2e, REAL WRITE PATH) block below drives an ACTUAL rejected merge through the REAL
//           `confirmWorkerMergeTracked` — the only way to prove the production `evt("build_gate", {opId:
//           thisOpId, ...})` call site itself stamps it (a synthetic-fixture test would stay green even
//           if that call site were reverted — caught live: removing `opId: thisOpId` from the real code
//           and rerunning left every fixture-driven check above GREEN, since seed() writes detail_json
//           directly and never calls the production code at all).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-history.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gh-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const GIT_ID = "-c user.email=gh@loom -c user.name=gh";
const now = new Date().toISOString();

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gh\n");
  execSync(`git init -q && git config user.email gh@loom && git config user.name gh && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// Card e082bf4d: confirmWorkerMergeTracked can legitimately degrade to the async {settled:false, op}
// pending path under host contention instead of settling inline — mirrors gate-status.mjs's own
// settleMergeEitherPath helper so this test tolerates either shape without a slow, flaky fixed wait.
async function settleMergeEitherPath(sessions, r, label) {
  if (r.settled) return { opId: r.value.opId, value: r.value, viaAsync: false };
  const opId = r.op.opId;
  await waitUntil(() => (sessions.gateStatus(opId).state === "settled" ? true : undefined), { timeoutMs: 20_000, label: `${label}: async merge op to settle` });
  return { opId, value: undefined, viaAsync: true };
}

function seed(db) {
  // A short random suffix (not just Date.now()) keeps P1/P2 unique across the two blocks below even when
  // both call seed() within the same millisecond on a fast host — the same DB file backs both blocks
  // (one process, one LOOM_HOME), so a collision here would silently mix one block's rows into the other.
  const uniq = randomUUID().slice(0, 8);
  const P1 = `gh-own-${Date.now()}-${uniq}`, P2 = `gh-foreign-${Date.now()}-${uniq}`;
  db.insertProject({ id: P1, name: "Own Project", repoPath: `/tmp/${P1}`, vaultPath: `/tmp/${P1}`, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertProject({ id: P2, name: "Foreign Project", repoPath: `/tmp/${P2}`, vaultPath: `/tmp/${P2}`, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const a1 = `${P1}-a1`, a2 = `${P2}-a2`;
  db.insertAgent({ id: a1, projectId: P1, name: "dev-1", startupPrompt: "", position: 0 });
  db.insertAgent({ id: a2, projectId: P2, name: "dev-2", startupPrompt: "", position: 0 });
  const t1 = `${P1}-task`, t2 = `${P2}-task`;
  db.insertTask({ id: t1, projectId: P1, title: "Own project task title", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertTask({ id: t2, projectId: P2, title: "Foreign project task title — must never leak", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const mgr1 = `${P1}-mgr`;
  db.insertSession({ id: mgr1, projectId: P1, agentId: a1, engineSessionId: null, title: null, cwd: `/tmp/${P1}`, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const w1 = `${P1}-wkr`, w2 = `${P2}-wkr`;
  db.insertSession({ id: w1, projectId: P1, agentId: a1, engineSessionId: null, title: null, cwd: `/tmp/${P1}`, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t1, worktreePath: `/tmp/${P1}-wt`, branch: "loom/p1-branch" });
  db.insertSession({ id: w2, projectId: P2, agentId: a2, engineSessionId: null, title: null, cwd: `/tmp/${P2}`, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t2, worktreePath: `/tmp/${P2}-wt`, branch: "loom/p2-branch" });

  // A HISTORICAL merge gate on P1 (card 753d9911 DIRECTIVE #4) — inserted FIRST so its insertion-order
  // `seq` (never-reused monotonic, what `listGateEvents` actually orders newest-first BY, not `ts`) is the
  // OLDEST of P1's three rows, matching the `ts` below and keeping the other two rows' pre-existing
  // newest-first ordering assertions correct. This is the shape every row recorded BEFORE
  // concurrentGatesMax shipped (card c6750500) actually has — durationMs/gateCap/concurrentGates present,
  // concurrentGatesMax simply ABSENT from detail_json entirely (never backfilled).
  db.appendEvent({
    id: randomUUID(), ts: new Date(Date.now() - 4000).toISOString(), managerSessionId: mgr1, workerSessionId: w1,
    taskId: t1, kind: "build_gate",
    detail: { passed: true, durationMs: 45000, gateCap: 2, concurrentGates: 1 },
  });
  // A PASSED merge gate on P1.
  db.appendEvent({
    id: randomUUID(), ts: new Date(Date.now() - 3000).toISOString(), managerSessionId: mgr1, workerSessionId: w1,
    taskId: t1, kind: "build_gate",
    detail: { passed: true, durationMs: 61234, gateCap: 2, concurrentGates: 1, concurrentGatesMax: 1 },
  });
  // A REJECTED merge gate on P1 — the case this whole card is about: durationMs/gateCap/concurrentGates
  // are recorded on a rejection too (evt() fires unconditionally, before any pass/fail branch).
  // Card 3aec1df6: a REAL `build_gate` event NEVER carries `failingTest`/`phase` in its own detail_json
  // (see service.ts's `evt("build_gate", ...)` call sites — only `opId`/`passed`/timing/concurrency) — the
  // rich diagnostic is written to the SEPARATE `merge_rejected` event `GATE_HISTORY_KINDS` excludes, and
  // (since 9f6598dd) to `pending_gate_ops.verdict_payload_json`, reachable via `gate_status(opId)`. The
  // fixture below now matches that shape: `opId` only, no inline `failingTest` — and a matching
  // `pending_gate_ops` row is seeded further down so the opId this row carries actually resolves.
  const rejectedOpId = randomUUID();
  db.appendEvent({
    id: randomUUID(), ts: new Date(Date.now() - 2000).toISOString(), managerSessionId: mgr1, workerSessionId: w1,
    taskId: t1, kind: "build_gate",
    detail: { opId: rejectedOpId, passed: false, durationMs: 84567, gateCap: 2, concurrentGates: 2, concurrentGatesMax: 2 },
  });
  // A gate on the FOREIGN project P2 — must never surface for a P1 caller.
  db.appendEvent({
    id: randomUUID(), ts: new Date(Date.now() - 1000).toISOString(), managerSessionId: `${P2}-mgr`, workerSessionId: w2,
    taskId: t2, kind: "build_gate",
    detail: { passed: true, durationMs: 12345, gateCap: 2, concurrentGates: 1, concurrentGatesMax: 1 },
  });

  // The DURABLE tombstone the rejected row's `opId` above points at — mirrors what
  // `confirmWorkerMergeTracked`'s onSettle actually writes via `deriveMergeGateVerdict` (card 9f6598dd) for
  // a real rejected merge: a settled "merge" row carrying `gateDetail.failingTest`/`stderrTail`. This is
  // the reachability chain's OTHER end — `gate_status(rejectedOpId)` must resolve to this.
  db.insertPendingGateOp({
    opId: rejectedOpId, kind: "merge", key: `merge:${w1}`, ownerSessionId: mgr1,
    projectId: P1, taskId: t1, branch: "loom/p1-branch",
    startedAt: new Date(Date.now() - 2500).toISOString(), state: "pending", surfacedPending: false,
  });
  db.settlePendingGateOp(rejectedOpId, {
    kind: "fail",
    payload: {
      gateDetail: { phase: "test", failedStep: "pnpm test", failingTest: "gate-history.mjs", exitCode: 1, timedOut: false, stderrTail: "--- gate output tail ---\nExpected 1 to equal 2" },
      outputTail: "--- gate output tail ---\nExpected 1 to equal 2",
      settledAt: new Date().toISOString(), totalDurationMs: 84567,
    },
  });

  return { P1, P2, mgr1, w1, w2, t1, t2, rejectedOpId };
}

// ── (unit) Db.listGateEvents + toGateHistoryRow — rejected rows survive, cross-project scoped ────────────
{
  const dbs = [];
  try {
    const db = new Db();
    dbs.push(db);
    const { P1, P2, rejectedOpId } = seed(db);

    const page = db.listGateEvents({ projectId: P1, limit: 100, offset: 0 });
    check("(unit) total reflects ONLY P1's 3 rows (never P2's)", page.total === 3);
    check("(unit) all 3 P1 rows returned", page.items.length === 3);

    const rejected = page.items.find((r) => r.outcome === "reject");
    const passed = page.items.find((r) => r.durationMs === 61234);
    const historical = page.items.find((r) => r.durationMs === 45000);
    check("(unit) a REJECTED row IS returned at all (the whole point of this card)", !!rejected);
    check("(unit) the rejected row has passed:false (boolean derived from outcome)", rejected?.passed === false);
    check("(unit) the rejected row STILL carries durationMs (recorded unconditionally, not passed-only)", rejected?.durationMs === 84567);
    check("(unit) the rejected row carries gateCap/concurrentGates/concurrentGatesMax too", rejected?.gateCap === 2 && rejected?.concurrentGates === 2 && rejected?.concurrentGatesMax === 2);
    // Card 3aec1df6: `failingTest` reads NULL on a merge row BY CONSTRUCTION — a real `build_gate` event
    // never carries it (see the fixture's own comment above). This is the card's original complaint,
    // reproduced here as the expected (documented) shape, not a bug this test is catching.
    check("(unit) the rejected row's OWN failingTest is null on a merge row — by design, see GateHistoryRow's own doc", rejected?.failingTest === null);
    check("(unit) the rejected row carries opId — the reachability key to gate_status (card 3aec1df6)", rejected?.opId === rejectedOpId);
    check("(unit) a row whose detail never stamped opId reads back opId:null (the passed row)", passed?.opId === null);
    check("(unit) the passed row has passed:true and its own durationMs/gateCap/concurrentGates/concurrentGatesMax", passed?.passed === true && passed?.durationMs === 61234 && passed?.gateCap === 2 && passed?.concurrentGates === 1 && passed?.concurrentGatesMax === 1);
    check("(unit) enrichment (branch / workerLabel, composed from agent+task title) is present for an OWN-project row", passed?.branch === "loom/p1-branch" && passed?.workerLabel === "dev-1 · Own project task title");
    check("(unit) the foreign project's task title never appears in a P1-scoped page", !JSON.stringify(page).includes("Foreign project task title"));

    // DIRECTIVE #4: the HISTORICAL shape — a row recorded before concurrentGatesMax shipped. Its
    // durationMs/gateCap/concurrentGates must stay intact while concurrentGatesMax comes back null —
    // this is the shape real historical data actually has, so it's the one that needs the assertion,
    // not the always-populated case the other two rows already cover.
    check("(unit) a HISTORICAL row (no concurrentGatesMax in its detail) IS returned", !!historical);
    check("(unit) the historical row's durationMs/gateCap/concurrentGates are intact", historical?.durationMs === 45000 && historical?.gateCap === 2 && historical?.concurrentGates === 1);
    check("(unit) the historical row's concurrentGatesMax comes back null (never backfilled), not 0 or undefined", historical?.concurrentGatesMax === null);
    check("(unit) the historical row's opId also reads back null (a row from before this field shipped)", historical?.opId === null);

    // Negative control: an unscoped read (no projectId) DOES see both — proves the P1-only result above
    // is the scoping filter actually working, not an accidental absence of P2's row altogether.
    const all = db.listGateEvents({ limit: 100, offset: 0 });
    check("(negative control) an UNSCOPED read sees all 4 rows across both projects", all.total === 4);

    // Pagination: limit:1 should clamp to exactly 1 item, newest first (the rejected row, inserted last).
    const paged = db.listGateEvents({ projectId: P1, limit: 1, offset: 0 });
    check("(unit) limit:1 returns exactly 1 item", paged.items.length === 1 && paged.limit === 1);
    check("(unit) newest-first ordering: the rejected (later) row comes first", paged.items[0].outcome === "reject");
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  }
}

// ── (e2e, MCP) the REAL gate_history tool — manager-only, project-scoped, over a REAL router/client ──────
{
  const dbs = [];
  try {
    const db = new Db();
    dbs.push(db);
    const { P1, P2, mgr1, w1, rejectedOpId } = seed(db);

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});
    const router = new OrchestrationMcpRouter(db, sessions);

    const connect = async (sessionId, role) => {
      const server = router.buildServer(sessionId, role);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: `gate-history-${sessionId}`, version: "0" });
      await client.connect(clientT);
      return { server, client, call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args ?? {} })).content[0].text) };
    };

    const mgr = await connect(mgr1, "manager");
    check("(e2e, MCP) gate_history IS registered on the manager's own MCP surface", Object.keys(mgr.server._registeredTools).includes("gate_history"));

    const result = await mgr.call("gate_history");
    check("(e2e, MCP) gate_history: total/items reflect ONLY P1's 3 rows", result.total === 3 && result.items.length === 3);
    const rejectedRow = result.items.find((r) => r.outcome === "reject");
    check("(e2e, MCP) gate_history: the rejected row IS returned, passed:false, durationMs intact", !!rejectedRow && rejectedRow.passed === false && rejectedRow.durationMs === 84567);
    check("(e2e, MCP) gate_history: nextOffset is null (nothing more to page)", result.nextOffset === null);

    // ── Card 3aec1df6: the reachability chain, both directions, over the REAL tool pair ──────────────────
    // BEFORE the pivot: gate_history's own row reads failingTest:null for this merge rejection — this IS
    // the card's original complaint, reproduced here as the documented (expected) shape.
    check("(e2e, MCP) BEFORE the pivot: gate_history's own row reads failingTest:null for a merge rejection (by design — see GateHistoryRow's own doc)", rejectedRow.failingTest === null);
    check("(e2e, MCP) BEFORE the pivot: the opId IS present on the row (the reachability key gate_history was missing)", rejectedRow.opId === rejectedOpId);
    // AFTER the pivot: feeding that exact opId to the REAL gate_status tool resolves the SAME op and
    // returns the full diagnostic gate_history's own row could not carry.
    const statusResult = await mgr.call("gate_status", { opId: rejectedRow.opId });
    check("(e2e, MCP) AFTER the pivot: gate_status(opId) resolves the SAME op — state:settled, gateType:merge, passed:false", statusResult.state === "settled" && statusResult.gateType === "merge" && statusResult.passed === false);
    check("(e2e, MCP) AFTER the pivot: gate_status(opId) carries the failing test gate_history's own row cannot", statusResult.gateDetail?.failingTest === "gate-history.mjs");
    check("(e2e, MCP) AFTER the pivot: gate_status(opId) also carries the output tail", statusResult.gateDetail?.stderrTail === "--- gate output tail ---\nExpected 1 to equal 2" && statusResult.outputTail === "--- gate output tail ---\nExpected 1 to equal 2");
    check("(e2e, MCP CROSS-PROJECT CHECK) the foreign project's id/name/task title never appear anywhere in the response", !JSON.stringify(result).includes(P2) && !JSON.stringify(result).includes("Foreign Project") && !JSON.stringify(result).includes("Foreign project task title"));

    // DIRECTIVE #4, over the REAL MCP tool: the historical row (no concurrentGatesMax stamped) comes back
    // with concurrentGatesMax:null while its durationMs/gateCap/concurrentGates stay intact — and a
    // CURRENT row's concurrentGatesMax is a real number, not null, so the two are visibly distinguishable.
    const historicalRow = result.items.find((r) => r.durationMs === 45000);
    const currentRow = result.items.find((r) => r.durationMs === 61234);
    check("(e2e, MCP) the historical row IS returned with concurrentGatesMax:null (never backfilled)",
      !!historicalRow && historicalRow.concurrentGatesMax === null && historicalRow.gateCap === 2 && historicalRow.concurrentGates === 1);
    check("(e2e, MCP) a CURRENT row's concurrentGatesMax is a real number, distinguishing it from the historical null",
      !!currentRow && currentRow.concurrentGatesMax === 1);

    // Pagination round-trip via the tool itself, all 3 rows, newest-first: rejected, passed(61234), historical(45000).
    const firstPage = await mgr.call("gate_history", { limit: 1, offset: 0 });
    check("(e2e, MCP) limit:1 returns exactly 1 item with a non-null nextOffset", firstPage.items.length === 1 && firstPage.nextOffset === 1 && firstPage.items[0].outcome === "reject");
    const secondPage = await mgr.call("gate_history", { limit: 1, offset: firstPage.nextOffset });
    check("(e2e, MCP) paging via nextOffset reaches the SECOND row (still non-null, a third remains)", secondPage.items.length === 1 && secondPage.nextOffset === 2 && secondPage.items[0].durationMs === 61234);
    const thirdPage = await mgr.call("gate_history", { limit: 1, offset: secondPage.nextOffset });
    check("(e2e, MCP) paging reaches the THIRD (historical) row, nextOffset now null", thirdPage.items.length === 1 && thirdPage.nextOffset === null && thirdPage.items[0].durationMs === 45000);
    await mgr.client.close();

    // Role gate: gate_history is a MANAGER-ONLY read (an investigative trend tool, not a live-op check a
    // depth-1 worker needs) — confirm it's absent from the worker's pinned surface and the pinned set is
    // otherwise UNCHANGED (mgmt-surface.mjs / my-context-gate.mjs / idle-report.mjs / inbox-pull.mjs /
    // orch-scope.mjs pin the exact 6-tool list: {directive_status, gate_queue, gate_status, my_context,
    // run_gate, worker_report} — this card must not silently grow that list).
    const wkr = await connect(w1, "worker");
    const wTools = Object.keys(wkr.server._registeredTools);
    check("(e2e, MCP) gate_history is NOT on the worker's surface", !wTools.includes("gate_history"));
    check("(e2e, MCP) worker surface is STILL EXACTLY the pinned 6-tool set (unchanged by this card)",
      wTools.slice().sort().join(",") === "directive_status,gate_queue,gate_status,my_context,run_gate,worker_report");
    await wkr.client.close();
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  }
}

// ── (e2e, REAL WRITE PATH) drives an ACTUAL rejected merge through the REAL confirmWorkerMergeTracked —
// the only block in this file that exercises service.ts's own `evt("build_gate", {opId: thisOpId, ...})`
// call site, not a synthetic detail_json fixture. Every check above this point proves the MAPPER
// (toGateHistoryRow reads `detail.opId` correctly); this proves the PRODUCER actually writes it. Caught
// live during development: temporarily reverting `opId: thisOpId` at that call site left every
// fixture-driven check in this file GREEN, because seed() never calls production code at all — this block
// is what would have gone RED. ──────────────────────────────────────────────────────────────────────────
{
  const dbs = [];
  const worktrees = [];
  try {
    const P = `gh-realpath-${Date.now()}`;
    const repo = path.join(os.tmpdir(), `${P}-repo`);
    makeRepo(repo);
    const db = new Db();
    dbs.push(db);
    db.insertProject({ id: P, name: "GH-REALPATH", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "t", startupPrompt: "", position: 0 });
    const taskId = `${P}-task`, workerId = `${P}-wkr`, mgrId = `${P}-mgr`;
    db.insertTask({ id: taskId, projectId: P, title: "GH-REALPATH-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feat.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m feat`, { cwd: worktreePath });
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const richFailGate = async () => ({
      passed: false, failedStep: "pnpm test", failedStatus: 1, failedSignal: null, failedTimedOut: false,
      outputTail: "FAIL  real_path_test.mjs", failingTest: "real_path_test.mjs",
      steps: [{ step: "pnpm test", durationMs: 900, status: 1 }],
    });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: richFailGate });

    const r = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
    const { opId, viaAsync } = await settleMergeEitherPath(sessions, r, "e2e real write path");
    if (!viaAsync) {
      check("(e2e, REAL WRITE PATH) confirmWorkerMergeTracked settled INLINE this run, merged:false (a real rejection)", r.ok === true && r.value.merged === false);
    }

    const page = db.listGateEvents({ projectId: P, limit: 10, offset: 0 });
    const row = page.items.find((x) => x.outcome === "reject");
    check("(e2e, REAL WRITE PATH) the REAL confirmWorkerMergeTracked call produced a rejected gate_history row", !!row);
    check("(e2e, REAL WRITE PATH — THE ACTUAL FIX) that row's opId, read back through the REAL db.listGateEvents, equals the REAL op's opId", row?.opId === opId);
    check("(e2e, REAL WRITE PATH) that row's own failingTest is still null (index, not detail — by design, same as the fixture-driven proof above)", row?.failingTest === null);

    const status = sessions.gateStatus(opId);
    check("(e2e, REAL WRITE PATH) feeding gate_history's REAL opId to the REAL gate_status resolves the SAME op", status.state === "settled" && status.gateType === "merge" && status.passed === false);
    check("(e2e, REAL WRITE PATH) gate_status(opId) carries the REAL failing test this row's own failingTest could not", status.gateDetail?.failingTest === "real_path_test.mjs");
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
    for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — gate_history() reuses db.listGateEvents verbatim (no duplicate query logic), returns a REJECTED run with durationMs/gateCap/concurrentGates/passed:false intact (the exact case gate_queue/gate_status/the nudge all drop, and the whole point of card 753d9911), is scoped to the CALLER's own project with no projectId argument to widen it (a foreign project's rows are never returned at all, never merely redacted), paginates correctly via limit/offset/nextOffset, and is registered on the manager surface ONLY — the worker's pinned depth-1 tool set is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
