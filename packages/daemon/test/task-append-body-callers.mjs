import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e2756e47 — `appendBody` (card 8636f761) wired through the other two `updateProjectTask` callers:
// the in-project `tasks_update` (mcp/server.ts, agent-facing) and the companion `board_update`
// (companion/capabilities.ts, owner-chat-facing). `task-append-body.mjs` already proves the SHARED
// `updateProjectTask` function's appendBody behavior exhaustively (append/preserve/exclusivity/no-
// baseVersion/truncation-guard-still-live) — this file proves the wiring at each ROUTER, not the shared
// function again: that the param actually reaches `updateProjectTask` from each tool's own argument
// parsing, and (for board_update) that appendBody is threaded through the SAME verbatim-owner-text /
// propose-confirm machinery `body` already goes through, not left un-gated.
//
// Proves, PER SITE:
//   tasks_update (mcp/server.ts):
//     (T1) POSITIVE CONTROL: a card with an already-substantial body — appendBody preserves it and adds
//          the note (an empty-body-only test could never detect a clobber).
//     (T2) `body` + `appendBody` together is REJECTED at this router too (whole patch, nothing written).
//   board_update (companion/capabilities.ts):
//     (B1) POSITIVE CONTROL: propose->confirm round-trip with appendBody preserves an existing body and
//          adds the note as its own section.
//     (B2) appendBody is gated by the SAME verbatim-owner-text check as `body` — a non-verbatim appendBody
//          is rejected, nothing proposed/delivered/written (proves the trust boundary wasn't loosened by
//          routing content through a different param).
//     (B3) `body` + `appendBody` together is REJECTED early (before any owner-confirmation round-trip).
//     (B4) appendBody alone satisfies the "at least one field" requirement (no longer just title/body/
//          columnKey/priority/held).
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL TaskMcpRouter / OrchestrationMcpRouter over
// in-memory MCP transports, mirroring worker-task-id-prefix.mjs and companion-board-write.mjs. NO
// network, NO real claude, NO daemon.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-append-body-callers.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-task-append-body-callers-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "task-append-body-callers-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
const DEFAULT_ROUTE = { channel: "in-app", chatId: "cockpit" };

function makeFakePty(initialOwnerText, opts = {}) {
  let ownerText = initialOwnerText ?? null;
  const route = opts.route === undefined ? DEFAULT_ROUTE : opts.route;
  return {
    setOwnerText(t) { ownerText = t; },
    getActiveTurnOwnerText() { return ownerText; },
    getActiveTurnOrigin() { return route; },
    enqueueStdin() { return { delivered: false, reason: "held" }; },
  };
}
function makeFakeCompanion() {
  const delivered = [];
  return { async deliverReply(sessionId, text) { delivered.push({ sessionId, text }); return { delivered: true }; }, delivered };
}
function extractToken(deliveredText) {
  const m = /Reply CONFIRM (\S+) to proceed\.$/.exec(deliveredText);
  if (!m) throw new Error(`could not extract a confirm token from: ${deliveredText}`);
  return m[1];
}
function seedSession(db, id, projectId, role) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role,
  });
}

try {
  // ============================ tasks_update (mcp/server.ts) ============================
  {
    const db = new Db(path.join(tmpHome, `${randomUUID()}.db`));
    db.insertProject({ id: "pWorker", name: "Worker Project", repoPath: "C:/w", vaultPath: "C:/w", config: {}, createdAt: now, archivedAt: null, reserved: false });
    const originalBody = "**Worker report.**\n\nRan the targeted test file, all green. Commit abc1234 on loom/e2756e47.";
    db.insertTask({ id: "t-report", projectId: "pWorker", title: "task with a real report", body: originalBody, columnKey: "in_progress", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
    const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });
    const server = new TaskMcpRouter(db, wakes).buildServer("pWorker", "S");
    const client = await connect(server);

    // (T1) POSITIVE CONTROL — appendBody through the tasks_update ROUTER preserves the worker's report.
    const appended = await call(client, "tasks_update", { id: "t-report", appendBody: "Manager triage: looks correct, merging." });
    check("(T1) tasks_update+appendBody: no error", !appended.error);
    check("(T1) tasks_update+appendBody: the ORIGINAL worker report SURVIVES", appended.body?.includes("Ran the targeted test file, all green. Commit abc1234 on loom/e2756e47."));
    check("(T1) tasks_update+appendBody: the new note is present", appended.body?.includes("Manager triage: looks correct, merging."));
    check("(T1) tasks_update+appendBody: added as its own timestamped section", appended.body?.includes("## Triage note —"));
    check("(T1) tasks_update+appendBody: persisted to the DB row, report intact", db.getTask("t-report").body.includes("Ran the targeted test file, all green."));

    // (T2) body + appendBody together is rejected at this router, nothing written.
    const bodyBefore = db.getTask("t-report").body;
    const both = await call(client, "tasks_update", { id: "t-report", body: "clobbered", appendBody: "also this" });
    check("(T2) tasks_update: body+appendBody together is REJECTED", typeof both.error === "string");
    check("(T2) tasks_update: the card is untouched by the rejected call", db.getTask("t-report").body === bodyBefore);

    await client.close();
    db.close();
  }

  // ============================ board_update (companion/capabilities.ts) ============================
  {
    const db = new Db(path.join(tmpHome, `${randomUUID()}.db`));
    const proj = "proj-board-append";
    db.insertProject({ id: proj, name: "Board Append", repoPath: proj, vaultPath: proj, config: {}, createdAt: now, archivedAt: null });
    const companionSess = "companion-board-append";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act",
      config: { friction: "per-action" }, // pin per-action so this exercises propose→confirm, not a warm-window shortcut
    });
    const originalBody = "Decision log: kicked off 2026-08-20, three options on the table.";
    db.insertTask({ id: "t-board-report", projectId: proj, title: "decision card", body: originalBody, columnKey: "backlog", position: 0, priority: "p2", createdAt: now, updatedAt: now });

    const pty = makeFakePty("the owner said: add a note that we picked option two");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // (B4) appendBody alone satisfies "at least one field" — this call must PROPOSE, not error out.
    const proposed = await call(client, "board_update", { id: "t-board-report", appendBody: "we picked option two" });
    check("(B4) board_update+appendBody alone: proposes (not rejected for 'no fields given')", proposed.status === "proposed");
    check("(B4) propose: card UNCHANGED (nothing applies on propose)", db.getTask("t-board-report").body === originalBody);

    // (B1) POSITIVE CONTROL — confirm the proposal; the ORIGINAL decision log must survive underneath.
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const updated = await call(client, "board_update", { id: "t-board-report", appendBody: "we picked option two" });
    check("(B1) board_update+appendBody confirm: applies", updated.status === "updated");
    const afterConfirm = db.getTask("t-board-report");
    check("(B1) board_update+appendBody confirm: the ORIGINAL decision log SURVIVES", afterConfirm.body.includes("Decision log: kicked off 2026-08-20, three options on the table."));
    check("(B1) board_update+appendBody confirm: the note itself is present", afterConfirm.body.includes("we picked option two"));
    check("(B1) board_update+appendBody confirm: added as its own timestamped section", afterConfirm.body.includes("## Triage note —"));

    // (B2) a NON-verbatim appendBody is rejected — the owner never said this text — nothing delivered/written.
    pty.setOwnerText("the owner said: move it to review");
    const deliveredBefore = companion.delivered.length;
    const bodyBeforeReject = db.getTask("t-board-report").body;
    const rejected = await call(client, "board_update", { id: "t-board-report", appendBody: "a note the companion invented, not something the owner said" });
    check("(B2) board_update: a non-verbatim appendBody is REJECTED", typeof rejected.error === "string" && rejected.status === undefined);
    check("(B2) board_update: nothing delivered to the owner for the rejected call", companion.delivered.length === deliveredBefore);
    check("(B2) board_update: the card is untouched by the rejected call", db.getTask("t-board-report").body === bodyBeforeReject);

    // (B3) body + appendBody together is rejected EARLY — before any owner-confirmation round-trip.
    pty.setOwnerText("the owner said: replace the body with something and also append a note");
    const deliveredBeforeBoth = companion.delivered.length;
    const bodyBeforeBoth = db.getTask("t-board-report").body;
    const both = await call(client, "board_update", { id: "t-board-report", body: "something", appendBody: "also append a note" });
    check("(B3) board_update: body+appendBody together is REJECTED", typeof both.error === "string" && both.status === undefined);
    check("(B3) board_update: no confirmation was ever proposed/delivered for the rejected call", companion.delivered.length === deliveredBeforeBoth);
    check("(B3) board_update: the card is untouched by the rejected call", db.getTask("t-board-report").body === bodyBeforeBoth);

    await client.close();
    db.close();
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — appendBody (card 8636f761) is correctly wired through BOTH remaining updateProjectTask callers (card e2756e47): the in-project tasks_update router preserves an existing worker report while adding a triage note and rejects body+appendBody together; the companion board_update router does the same across its propose→confirm round-trip, gates appendBody under the SAME verbatim-owner-text check body already has, and accepts appendBody alone as a meaningful field."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
