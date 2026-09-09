import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 808ee811: surface a worker's context cost at the recycle decision — in worker_list/worker_status
// (`ctxPct`) AND in worker_report's manager-facing notification + durable event — so a manager never has
// to open a transcript (or a separate worker_list call) at the exact clean-seam moment (a `done`/`blocked`
// report) it decides continue-vs-recycle.
//
// THE INVERSION THIS GUARDS AGAINST: `ctxInputTokens`/`ctxTurns` read `null` for a codex-harness worker
// (no hook-based capture on that harness — see codex-adapter.ts's own doc, card a1916267) and for any
// worker that hasn't completed a turn yet. `ctxPct` MUST render as `null`/"unknown" in both cases, never
// as a measured `0` — a `0` reads as a FRESH seat and would tell a manager to keep going at exactly the
// moment it should recycle.
//
// HERMETIC, NO claude, NO real spawn/merge — two halves:
//   (1) worker_list/worker_status: real Db, driven through the REAL manager MCP tools over an
//       InMemoryTransport pair (mirrors worker-never-completed-turn-signal.mjs's pattern).
//   (2) worker_report: SessionService called directly against a fake PtyHost that records the framed
//       manager-facing text (mirrors worker-report-delivery-status.mjs's pattern).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-context-surface.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { contextPercentFor, contextWindowForModel } from "../../shared/dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const NOW = "2026-09-09T12:00:00.000Z";

// ============================ (0) contextPercentFor — the pure helper ============================
{
  check("(helper) null tokens → null (never a measured 0)", contextPercentFor(null, "claude-sonnet-5") === null);
  check("(helper) undefined tokens → null", contextPercentFor(undefined, "claude-sonnet-5") === null);
  check("(helper) 42000/1M sonnet-5 → 4%", contextPercentFor(42_000, "claude-sonnet-5") === Math.round((42_000 / 1_000_000) * 100));
  check("(helper) 150000/200k default window (no model) → 75%", contextPercentFor(150_000, null) === 75);
  check("(helper) window matches contextWindowForModel exactly (no drift between the two)",
    contextPercentFor(100_000, "claude-haiku-4-5-20251001") === Math.round((100_000 / contextWindowForModel("claude-haiku-4-5-20251001")) * 100));
}

// ============================ (1) worker_list / worker_status: ctxPct ============================
{
  const dbFile = path.join(os.tmpdir(), `loom-wctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = "proj-wctx";
  const agentId = "agent-wctx";
  db.insertProject({ id: projId, name: "WCTX", repoPath: projId, vaultPath: projId, config: {}, createdAt: NOW, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: NOW, lastActivity: NOW, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });

  function seedWorker(id, taskId, extra = {}) {
    db.insertSession({ id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId, processState: "live", resumability: "unknown", busy: true, createdAt: NOW, lastActivity: NOW, lastError: null, role: "worker", parentSessionId: "mgr", taskId, ctxInputTokens: null, ctxTurns: null, model: null, ...extra });
  }
  // (w-measured) a real measured worker on the 1M sonnet-5 window.
  seedWorker("w-measured", "task-measured", { ctxInputTokens: 700_000, model: "claude-sonnet-5" });
  db.incrementTurnSeq("w-measured");
  // (w-fresh) never completed a turn — ctxInputTokens genuinely null, must NOT read as ctxPct:0.
  seedWorker("w-fresh", "task-fresh");
  // (w-codex) simulates the codex-harness gap (card a1916267): a turn completed, but ctxInputTokens
  // stays null because that harness has no hook-based capture chokepoint at all.
  seedWorker("w-codex", "task-codex", { harness: "codex" });
  db.incrementTurnSeq("w-codex");

  const sessionsStub = {
    peekPendingMerge() { return undefined; },
    listPendingSpawns() { return []; },
    listCapQueuedSpawns() { return []; },
    isArchivedWithoutReport() { return false; },
    async getDanglingWorkers() { return []; },
  };
  const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
  const server = router.buildServer("mgr", "manager");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "worker-context-surface-test", version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

  try {
    const list = await call("worker_list");

    const measured = list.find((w) => w.workerSessionId === "w-measured");
    check("(w-measured) worker_list: ctxInputTokens is the real measured value", measured && measured.ctxInputTokens === 700_000);
    check("(w-measured) worker_list: ctxPct = round(700000/1_000_000*100) = 70", measured && measured.ctxPct === 70);

    const fresh = list.find((w) => w.workerSessionId === "w-fresh");
    check("(w-fresh) worker_list: ctxInputTokens is null (no completed turn yet)", fresh && fresh.ctxInputTokens === null);
    check("(w-fresh) worker_list: ctxPct is null — NOT a measured 0 (the inversion this card exists to prevent)", fresh && fresh.ctxPct === null);
    check("(w-fresh) ctxPct !== 0 explicitly (a 0 would misread as a fresh, low-cost seat)", fresh.ctxPct !== 0);

    const codex = list.find((w) => w.workerSessionId === "w-codex");
    check("(w-codex) worker_list: ctxInputTokens is null (codex has no hook-based capture — card a1916267)", codex && codex.ctxInputTokens === null);
    check("(w-codex) worker_list: ctxPct is null, not 0, DESPITE a completed turn (the real-world gap named on the card)", codex && codex.ctxPct === null && codex.neverCompletedTurn === false);

    // --- worker_status carries the same field for a single worker ---
    const statusMeasured = await call("worker_status", { workerSessionId: "w-measured" });
    check("(w-measured) worker_status: ctxPct matches worker_list (70)", statusMeasured.ctxPct === 70);
    const statusFresh = await call("worker_status", { workerSessionId: "w-fresh" });
    check("(w-fresh) worker_status: ctxPct is null, matching worker_list", statusFresh.ctxPct === null);
  } finally {
    db.close();
    try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
    for (const ext of ["-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  }
}

// ============================ (2) worker_report: framed notification + durable event ============================
{
  const dbFile = path.join(os.tmpdir(), `loom-wctx-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = "proj-wctx-r";
  const agentId = "agent-wctx-r";
  db.insertProject({ id: projId, name: "WCTXR", repoPath: projId, vaultPath: projId, config: {}, createdAt: NOW, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

  const enqueued = [];
  const pty = {
    enqueueStdin: (id, text) => {
      enqueued.push({ id, text });
      const s = db.getSession(id);
      return s?.processState === "live" ? { delivered: true } : { delivered: false };
    },
  };
  const control = new OrchestrationControl();
  const sessions = new SessionService(db, pty, control);

  function seedSession(id, opts) {
    db.insertSession({ id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: NOW, lastActivity: NOW, lastError: null, ctxInputTokens: null, ctxTurns: null, model: null, worktreePath: null, branch: null, rateLimitedUntil: null, ...opts });
  }
  function seedTask(id) {
    db.insertTask({ id, projectId: projId, title: "T-" + id, body: "", columnKey: "in_progress", position: 0, priority: "p2", createdAt: NOW, updatedAt: NOW });
  }
  const evDetail = (workerId) => db.listEventsForWorker(workerId).find((e) => e.kind === "worker_report")?.detail;

  // (measured) a worker whose context IS known at report time.
  seedSession("mgr-M", { role: "manager", processState: "live" });
  seedTask("tk-M");
  seedSession("wkr-M", { role: "worker", processState: "live", parentSessionId: "mgr-M", taskId: "tk-M", ctxInputTokens: 636_000, model: "claude-sonnet-5" });
  const resM = await sessions.workerReport("wkr-M", { status: "done", summary: "DONE-M" });
  check("(measured) worker_report reaches the manager", resM.deliveryStatus === "delivered-live");
  const framedM = enqueued.find((x) => x.id === "mgr-M" && /DONE-M/.test(x.text))?.text;
  check("(measured) framed notification carries a ctx percentage", !!framedM && /\| ctx: 64% \(636000 tokens\)/.test(framedM));
  const detailM = evDetail("wkr-M");
  check("(measured) durable event detail carries ctxInputTokens", detailM?.ctxInputTokens === 636_000);
  check("(measured) durable event detail carries ctxPct = 64", detailM?.ctxPct === 64);

  // (unknown) a worker whose context is NOT measured (never completed a turn / codex-style gap) — the
  // inversion case: this must read "unknown", NEVER a bare 0 that would misread as a fresh, cheap seat.
  seedSession("mgr-U", { role: "manager", processState: "live" });
  seedTask("tk-U");
  seedSession("wkr-U", { role: "worker", processState: "live", parentSessionId: "mgr-U", taskId: "tk-U" }); // ctxInputTokens stays null
  const resU = await sessions.workerReport("wkr-U", { status: "done", summary: "DONE-U" });
  check("(unknown) worker_report reaches the manager", resU.deliveryStatus === "delivered-live");
  const framedU = enqueued.find((x) => x.id === "mgr-U" && /DONE-U/.test(x.text))?.text;
  check("(unknown) framed notification says 'ctx: unknown' — never a percentage", !!framedU && / \| ctx: unknown/.test(framedU));
  check("(unknown) framed notification NEVER renders 'ctx: 0%' (the exact inversion this card fixes)", !!framedU && !/ctx: 0%/.test(framedU));
  const detailU = evDetail("wkr-U");
  check("(unknown) durable event detail: ctxInputTokens is null (present key, not omitted)", detailU && detailU.ctxInputTokens === null);
  check("(unknown) durable event detail: ctxPct is null, never 0", detailU && detailU.ctxPct === null);

  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_list/worker_status expose ctxPct, and worker_report's manager-facing notification + durable event carry the worker's context cost at report time — rendering honestly as null/\"unknown\" (never a measured 0) whenever ctxInputTokens itself is unmeasured, including the codex-harness gap."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
