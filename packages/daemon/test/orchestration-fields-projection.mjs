import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 40f4cae9 — extends the `fields:[...]` projection (card 23fde5f8's `tasks_list`, reusing the SAME
// `pickFields` helper from mcp/tasks.ts, never a second projector) to three more manager-surface read
// tools on mcp/orchestration.ts: `gate_history`, `requests_list`, `events_search`.
//
// Proves, for EACH of the three tools, the DoD line: "a test proving the un-asked-for fields are absent
// from the response itself" —
//   (positive control FIRST, the polarity trap) the unprojected default read carries the fields we will
//   later drop, proving the check can actually SEE them before we assert their absence.
//   (projection) fields:[...] narrows every returned row's key set to EXACTLY the requested names.
//   (unknown field) an unmatched field name is silently ignored, never an error.
//   (ordering) the completeness signal (`total`/`nextOffset`/`hasMore`) is computed from the FULL,
//   unprojected result and is unaffected by which fields were requested.
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE — mirrors gate-history.mjs's harness (a REAL Db + SessionService
// against a stub pty, the REAL OrchestrationMcpRouter driven over an in-process MCP InMemoryTransport).
//
// Run: 1) build (turbo builds shared first), 2) node test/orchestration-fields-projection.mjs
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = os.tmpdir() + `/loom-ofp-home-${Date.now()}-${process.pid}`;
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { buildQuestionAsk } = await import("../dist/mcp/questionTool.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();

const db = new Db();
try {
  const P = `ofp-${Date.now()}-${randomUUID().slice(0, 8)}`;
  db.insertProject({ id: P, name: "Fields Projection Project", repoPath: `/tmp/${P}`, vaultPath: `/tmp/${P}`, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  const a = `${P}-a`;
  db.insertAgent({ id: a, projectId: P, name: "dev", startupPrompt: "", position: 0 });
  const t = `${P}-task`;
  db.insertTask({ id: t, projectId: P, title: "Fields projection task", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const mgr = `${P}-mgr`, w = `${P}-wkr`;
  db.insertSession({ id: mgr, projectId: P, agentId: a, engineSessionId: null, title: null, cwd: `/tmp/${P}`, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: w, projectId: P, agentId: a, engineSessionId: null, title: null, cwd: `/tmp/${P}`, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: t, worktreePath: `/tmp/${P}-wt`, branch: "loom/ofp-branch" });

  // --- gate_history fixture: one PASSED build_gate row ---
  db.appendEvent({
    id: randomUUID(), ts: new Date(Date.now() - 1000).toISOString(), managerSessionId: mgr, workerSessionId: w,
    taskId: t, kind: "build_gate",
    detail: { passed: true, durationMs: 12345, gateCap: 2, concurrentGates: 1, concurrentGatesMax: 1 },
  });

  // --- requests_list fixture: one pending decision request ---
  const built = buildQuestionAsk({ title: "Ship it?", body: "gate green", options: ["yes", "no"], recommendation: "yes" }, { sessionId: mgr, projectId: P });
  if (!("question" in built)) throw new Error("fixture setup: buildQuestionAsk failed: " + JSON.stringify(built));
  db.insertQuestion(built.question);

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});
  const router = new OrchestrationMcpRouter(db, sessions);

  const server = router.buildServer(mgr, "manager");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "ofp-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args ?? {} })).content[0].text);

  // ═══════════════════════════════════ gate_history ═══════════════════════════════════
  {
    const defaultResult = await call("gate_history");
    check("(gate_history) setup: default read returns the 1 seeded row", defaultResult.total === 1 && defaultResult.items.length === 1);
    check("(gate_history) positive control: default read carries gateCap/concurrentGates/branch/workerLabel (fields we'll later drop)",
      defaultResult.items[0].gateCap === 2 && defaultResult.items[0].concurrentGates === 1 &&
      defaultResult.items[0].branch === "loom/ofp-branch" && typeof defaultResult.items[0].workerLabel === "string");

    const projResult = await call("gate_history", { fields: ["outcome", "durationMs"] });
    check("(gate_history) fields projection: total/nextOffset unaffected by projection", projResult.total === 1 && projResult.nextOffset === null);
    const gKeys = Object.keys(projResult.items[0]).sort();
    check("(gate_history) fields projection: row key set is EXACTLY {durationMs,outcome} — no gateCap/concurrentGates/branch/workerLabel/etc",
      gKeys.length === 2 && gKeys[0] === "durationMs" && gKeys[1] === "outcome");
    check("(gate_history) fields projection: values are correct", projResult.items[0].outcome === "pass" && projResult.items[0].durationMs === 12345);

    const typoResult = await call("gate_history", { fields: ["outcome", "thisFieldDoesNotExist"] });
    check("(gate_history) unknown field name: silently ignored, row carries only the real field",
      Object.keys(typoResult.items[0]).length === 1 && typoResult.items[0].outcome === "pass");

    const noIdResult = await call("gate_history", { fields: ["outcome"] });
    check("(gate_history) `id` is NOT auto-added", !("id" in noIdResult.items[0]));
  }

  // ═══════════════════════════════════ requests_list ═══════════════════════════════════
  {
    const defaultResult = await call("requests_list");
    check("(requests_list) setup: default read returns the 1 seeded request", defaultResult.total === 1 && defaultResult.items.length === 1);
    check("(requests_list) positive control: default read carries type/state/createdAt/agentId (fields we'll later drop)",
      defaultResult.items[0].type === "decision" && defaultResult.items[0].state === "pending" &&
      typeof defaultResult.items[0].createdAt === "string" && "agentId" in defaultResult.items[0]);

    const projResult = await call("requests_list", { fields: ["id", "title"] });
    check("(requests_list) fields projection: total/hasMore unaffected by projection", projResult.total === 1 && projResult.hasMore === false);
    const rKeys = Object.keys(projResult.items[0]).sort();
    check("(requests_list) fields projection: row key set is EXACTLY {id,title} — no type/state/createdAt/agentId/etc",
      rKeys.length === 2 && rKeys[0] === "id" && rKeys[1] === "title");
    check("(requests_list) fields projection: values are correct", projResult.items[0].title === "Ship it?");

    const typoResult = await call("requests_list", { fields: ["title", "thisFieldDoesNotExist"] });
    check("(requests_list) unknown field name: silently ignored, row carries only the real field",
      Object.keys(typoResult.items[0]).length === 1 && typoResult.items[0].title === "Ship it?");

    const noIdResult = await call("requests_list", { fields: ["title"] });
    check("(requests_list) `id` is NOT auto-added", !("id" in noIdResult.items[0]));
  }

  // ═══════════════════════════════════ events_search ═══════════════════════════════════
  {
    const defaultResult = await call("events_search");
    check("(events_search) setup: default read returns the 1 seeded build_gate event", defaultResult.total === 1 && defaultResult.events.length === 1);
    check("(events_search) positive control: default read carries taskId/taskTitle/loomSessionId/detail (fields we'll later drop)",
      defaultResult.events[0].taskId === t && defaultResult.events[0].taskTitle === "Fields projection task" &&
      typeof defaultResult.events[0].loomSessionId === "string" && "detail" in defaultResult.events[0]);

    const projResult = await call("events_search", { fields: ["kind", "ts"] });
    check("(events_search) fields projection: total/returned/nextOffset unaffected by projection", projResult.total === 1 && projResult.returned === 1 && projResult.nextOffset === null);
    const eKeys = Object.keys(projResult.events[0]).sort();
    check("(events_search) fields projection: event key set is EXACTLY {kind,ts} — no taskId/taskTitle/loomSessionId/detail/etc",
      eKeys.length === 2 && eKeys[0] === "kind" && eKeys[1] === "ts");
    check("(events_search) fields projection: values are correct", projResult.events[0].kind === "build_gate");

    const typoResult = await call("events_search", { fields: ["kind", "thisFieldDoesNotExist"] });
    check("(events_search) unknown field name: silently ignored, event carries only the real field",
      Object.keys(typoResult.events[0]).length === 1 && typoResult.events[0].kind === "build_gate");

    const noIdResult = await call("events_search", { fields: ["kind"] });
    check("(events_search) `id` is NOT auto-added", !("id" in noIdResult.events[0]));
  }

  await client.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — gate_history/requests_list/events_search's fields:[...] projection genuinely drops un-asked-for keys from the response itself, silently ignores an unmatched field name, never auto-adds id, and leaves each tool's own completeness signal (total/nextOffset/hasMore) unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
