import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `board-reach`'s `authoredContent` per-project
// opt-in (card a5c940a0, epic ccdb1e0c, levers 4+6, Tier A). Extends the EXISTING board_create/
// board_update ACT half (card 7975c034, see companion-board-write.mjs) by making Primitive B (the
// verbatim-owner-quote requirement on title/body) CONDITIONAL on a per-project grant-config flag,
// fail-closed default OFF.
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport, driven with a FAKE `pty` and a FAKE `companion` — NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   - authoredContent OFF (default): byte-identical to today — non-verbatim title/body rejected on the
//     warm path AND the propose path (board_create + board_update); verbatim still accepted
//   - authoredContent ON + WARM window: authored (non-verbatim) title/body commits DIRECTLY, no confirm
//   - authoredContent ON + COLD window: first call proposes (step-up), a matching confirm commits the
//     authored content
//   - board_update with authored title/body actually persists via updateProjectTask; a closed-vocab-only
//     board_update (no title/body) is unaffected
//   - per-project isolation: authoredContent ON for project X, OFF for project Y — never collapsed
// Run: 1) build (turbo builds shared first), 2) node test/companion-authored-content.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-authored-content-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-authored-content-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const DEFAULT_ROUTE = { channel: "in-app", chatId: "cockpit" };

// A FAKE pty — mirrors companion-board-write.mjs's own fake exactly.
function makeFakePty(initialOwnerText, opts = {}) {
  let ownerText = initialOwnerText ?? null;
  const route = opts.route === undefined ? DEFAULT_ROUTE : opts.route;
  const enqueued = [];
  return {
    setOwnerText(t) { ownerText = t; },
    getActiveTurnOwnerText() { return ownerText; },
    getActiveTurnOrigin() { return route; },
    enqueueStdin(...args) { enqueued.push(args); return { delivered: false, reason: "held" }; },
    enqueued,
  };
}

// A FAKE companion (CompanionHooks) — mirrors companion-board-write.mjs's own fake exactly.
function makeFakeCompanion(shouldDeliver = true) {
  const delivered = [];
  return {
    async deliverReply(sessionId, text) {
      delivered.push({ sessionId, text });
      return { delivered: shouldDeliver };
    },
    delivered,
  };
}

// Extract the confirm token the DAEMON delivered to the owner — the one place a test is ALLOWED to know
// it, to simulate the owner's reply.
function extractToken(deliveredText) {
  const m = /Reply CONFIRM (\S+) to proceed\.$/.exec(deliveredText);
  if (!m) throw new Error(`could not extract a confirm token from: ${deliveredText}`);
  return m[1];
}

const now = new Date().toISOString();
function seedProject(db, id, name) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
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
function seedTask(db, id, projectId, opts = {}) {
  db.insertTask({
    id, projectId, title: opts.title ?? `Task ${id}`, body: opts.body ?? "",
    columnKey: opts.columnKey ?? "backlog", position: opts.position ?? 0,
    priority: opts.priority ?? "p2", createdAt: now, updatedAt: now,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

// Warm the trust window on (session, route) via a plain verbatim board_create propose+confirm round-trip
// — mirrors companion-trust-window-retrofit.mjs's own "shared window" recipe. Returns nothing; the caller's
// NEXT call on the same session/route flows through the low-friction path.
async function warmWindow(client, pty, companion, project, verbatimTitle) {
  pty.setOwnerText(`the owner said: ${verbatimTitle}`);
  const deliveredBefore = companion.delivered.length;
  const proposed = await call(client, "board_create", { project, title: verbatimTitle });
  if (proposed.status !== "proposed") throw new Error(`warmWindow: expected propose, got ${JSON.stringify(proposed)}`);
  const token = extractToken(companion.delivered[deliveredBefore].text);
  pty.setOwnerText(`CONFIRM ${token}`);
  const resolved = await call(client, "board_create", { project, title: verbatimTitle });
  if (resolved.status !== "created") throw new Error(`warmWindow: expected create, got ${JSON.stringify(resolved)}`);
}

try {
  // ============ authoredContent OFF (default): board_create non-verbatim still rejected, warm path ============
  {
    const db = tmpDb();
    const proj = "proj-off-create-warm";
    seedProject(db, proj, "Off create warm");
    const companionSess = "companion-off-create-warm";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty(null);
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    await warmWindow(client, pty, companion, proj, "warm this window");

    pty.setOwnerText("the owner said: log a card");
    const res = await call(client, "board_create", { project: proj, title: "Something the owner never said" });
    check("authoredContent OFF, warm window: non-verbatim title still rejected", typeof res.error === "string" && res.status === undefined);
    check("authoredContent OFF, warm window: no extra card created", db.listTasks(proj).length === 1); // only warmWindow's own card

    await client.close();
    db.close();
  }

  // ============ authoredContent OFF (default): board_create non-verbatim rejected, cold propose path ============
  {
    const db = tmpDb();
    const proj = "proj-off-create-cold";
    seedProject(db, proj, "Off create cold");
    const companionSess = "companion-off-create-cold";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: log a card");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "board_create", { project: proj, title: "Something the owner never said" });
    check("authoredContent OFF, cold: non-verbatim title rejected at propose", typeof res.error === "string" && res.status === undefined);
    check("authoredContent OFF, cold: nothing delivered", companion.delivered.length === 0);
    check("authoredContent OFF, cold: no card created", db.listTasks(proj).length === 0);

    // Verbatim still works — byte-identical to before this card.
    const ok = await call(client, "board_create", { project: proj, title: "log a card" });
    check("authoredContent OFF, cold: verbatim title still proposes fine", ok.status === "proposed");

    await client.close();
    db.close();
  }

  // ============ authoredContent OFF (default): board_update non-verbatim title/body rejected (warm + cold) ============
  {
    const db = tmpDb();
    const proj = "proj-off-update";
    seedProject(db, proj, "Off update");
    const companionSess = "companion-off-update";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-off-update", proj, { title: "Original title", body: "Original body" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty(null);
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // Cold propose path.
    pty.setOwnerText("the owner said: bump priority");
    const coldRes = await call(client, "board_update", { id: "t-off-update", title: "A fabricated new title" });
    check("authoredContent OFF, board_update cold: non-verbatim title rejected", typeof coldRes.error === "string" && coldRes.status === undefined);
    check("authoredContent OFF, board_update cold: card unchanged", db.getTask("t-off-update").title === "Original title");

    // Warm the window via board_create (shared window), then try board_update's warm path.
    await warmWindow(client, pty, companion, proj, "warm this window for update");
    pty.setOwnerText("the owner said: bump priority");
    const warmRes = await call(client, "board_update", { id: "t-off-update", body: "A fabricated new body" });
    check("authoredContent OFF, board_update warm: non-verbatim body rejected", typeof warmRes.error === "string" && warmRes.status === undefined);
    check("authoredContent OFF, board_update warm: card body unchanged", db.getTask("t-off-update").body === "Original body");

    await client.close();
    db.close();
  }

  // ============ authoredContent ON + WARM window: board_create authored content commits DIRECTLY ============
  {
    const db = tmpDb();
    const proj = "proj-on-create-warm";
    seedProject(db, proj, "On create warm");
    const companionSess = "companion-on-create-warm";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act",
      config: { authoredContent: true },
    });
    const pty = makeFakePty(null);
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    await warmWindow(client, pty, companion, proj, "warm this window");

    pty.setOwnerText("the owner said: file something about the login bug");
    const deliveredBefore = companion.delivered.length;
    const created = await call(client, "board_create", {
      project: proj, title: "Fix the intermittent login failure on Safari", body: "Users report random logouts; needs investigation.",
    });
    check("authoredContent ON, warm: authored (non-verbatim) card created DIRECTLY", created.status === "created");
    check("authoredContent ON, warm: no confirm round-trip (no new delivery)", companion.delivered.length === deliveredBefore);
    const tasks = db.listTasks(proj).filter((t) => t.title === "Fix the intermittent login failure on Safari");
    check("authoredContent ON, warm: authored title/body actually persisted", tasks.length === 1 && tasks[0].body === "Users report random logouts; needs investigation.");

    await client.close();
    db.close();
  }

  // ============ authoredContent ON + COLD window: board_create authored content proposes then commits on confirm ============
  {
    const db = tmpDb();
    const proj = "proj-on-create-cold";
    seedProject(db, proj, "On create cold");
    const companionSess = "companion-on-create-cold";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act",
      config: { authoredContent: true },
    });
    const pty = makeFakePty("the owner said: file something about the login bug");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "board_create", {
      project: proj, title: "Fix the intermittent login failure on Safari", body: "Users report random logouts.",
    });
    check("authoredContent ON, cold: authored content PROPOSES (step-up), does not create yet", proposed.status === "proposed");
    check("authoredContent ON, cold: no card created yet", db.listTasks(proj).length === 0);
    check("authoredContent ON, cold: confirm prompt delivered to the owner, naming the authored content", companion.delivered.length === 1 && companion.delivered[0].text.includes("Fix the intermittent login failure on Safari"));

    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const created = await call(client, "board_create", {
      project: proj, title: "Fix the intermittent login failure on Safari", body: "Users report random logouts.",
    });
    check("authoredContent ON, cold: confirm commits the authored content", created.status === "created");
    const tasks = db.listTasks(proj);
    check("authoredContent ON, cold: authored title/body persisted", tasks.length === 1 && tasks[0].title === "Fix the intermittent login failure on Safari" && tasks[0].body === "Users report random logouts.");

    await client.close();
    db.close();
  }

  // ============ authoredContent ON + WARM window: board_update authored title/body commits DIRECTLY, persists ============
  {
    const db = tmpDb();
    const proj = "proj-on-update-warm";
    seedProject(db, proj, "On update warm");
    const companionSess = "companion-on-update-warm";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-on-update-warm", proj, { title: "Old title", body: "Old body", priority: "p2" });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act",
      config: { authoredContent: true },
    });
    const pty = makeFakePty(null);
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    await warmWindow(client, pty, companion, proj, "warm this window for update");

    pty.setOwnerText("the owner said: rewrite that card");
    const deliveredBefore = companion.delivered.length;
    const updated = await call(client, "board_update", {
      id: "t-on-update-warm", title: "A much clearer authored title", body: "A well-formed authored body explaining the issue.", priority: "p1",
    });
    check("authoredContent ON, board_update warm: authored update applied DIRECTLY", updated.status === "updated");
    check("authoredContent ON, board_update warm: no confirm round-trip", companion.delivered.length === deliveredBefore);
    const task = db.getTask("t-on-update-warm");
    check("authoredContent ON, board_update warm: authored title persisted via updateProjectTask", task.title === "A much clearer authored title");
    check("authoredContent ON, board_update warm: authored body persisted via updateProjectTask", task.body === "A well-formed authored body explaining the issue.");
    check("authoredContent ON, board_update warm: closed-vocab priority also applied", task.priority === "p1");

    await client.close();
    db.close();
  }

  // ============ authoredContent ON + COLD window: board_update authored content proposes then commits ============
  {
    const db = tmpDb();
    const proj = "proj-on-update-cold";
    seedProject(db, proj, "On update cold");
    const companionSess = "companion-on-update-cold";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-on-update-cold", proj, { title: "Old title", body: "Old body" });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act",
      config: { authoredContent: true },
    });
    const pty = makeFakePty("the owner said: rewrite that card");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "board_update", { id: "t-on-update-cold", title: "A much clearer authored title" });
    check("authoredContent ON, board_update cold: authored title PROPOSES", proposed.status === "proposed");
    check("authoredContent ON, board_update cold: card unchanged before confirm", db.getTask("t-on-update-cold").title === "Old title");

    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const updated = await call(client, "board_update", { id: "t-on-update-cold", title: "A much clearer authored title" });
    check("authoredContent ON, board_update cold: confirm commits authored title", updated.status === "updated");
    check("authoredContent ON, board_update cold: authored title persisted", db.getTask("t-on-update-cold").title === "A much clearer authored title");

    await client.close();
    db.close();
  }

  // ============ board_update with ONLY closed-vocab fields is unaffected by authoredContent either way ============
  {
    const db = tmpDb();
    const proj = "proj-on-update-closedvocab";
    seedProject(db, proj, "On update closed vocab");
    const companionSess = "companion-on-update-closedvocab";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-closedvocab", proj, { title: "Unchanged title", priority: "p2" });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act",
      config: { authoredContent: true },
    });
    const pty = makeFakePty(null);
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    await warmWindow(client, pty, companion, proj, "warm this window");

    pty.setOwnerText("the owner said: bump it to p0");
    const updated = await call(client, "board_update", { id: "t-closedvocab", priority: "p0" });
    check("closed-vocab-only board_update: applies fine with authoredContent ON", updated.status === "updated");
    check("closed-vocab-only board_update: title untouched", db.getTask("t-closedvocab").title === "Unchanged title");
    check("closed-vocab-only board_update: priority applied", db.getTask("t-closedvocab").priority === "p0");

    await client.close();
    db.close();
  }

  // ============ per-project isolation: authoredContent ON for project X, OFF (default) for project Y ============
  {
    const db = tmpDb();
    const projOn = "proj-iso-on";
    const projOff = "proj-iso-off";
    seedProject(db, projOn, "Iso on");
    seedProject(db, projOff, "Iso off");
    const companionSess = "companion-iso";
    seedSession(db, companionSess, projOn, "assistant");
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "board-reach", projectId: projOn, mode: "act",
      config: { authoredContent: true },
    });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projOff, mode: "act" });
    const pty = makeFakePty(null);
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // Warm the window on projOn (board_create's route-scoped window is shared across projects for this
    // session/route, but each project's OWN authoredContent config is read independently per call).
    await warmWindow(client, pty, companion, projOn, "warm this window");

    pty.setOwnerText("the owner said: file something");
    const onRes = await call(client, "board_create", { project: projOn, title: "An authored title never said verbatim" });
    check("per-project isolation: authoredContent ON project admits authored content", onRes.status === "created");

    const offRes = await call(client, "board_create", { project: projOff, title: "An authored title never said verbatim" });
    check("per-project isolation: authoredContent OFF (default) project STILL requires verbatim, even with the SAME warm window", typeof offRes.error === "string" && offRes.status === undefined);
    check("per-project isolation: no card created on the OFF project", db.listTasks(projOff).length === 0);

    await client.close();
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — authoredContent OFF (default) keeps board_create/board_update byte-identical (verbatim required on both the warm and cold paths); authoredContent ON for a project lets both tools author real (non-verbatim) title/body, committing directly on a warm window and via the normal propose/confirm round-trip on a cold one, with board_update's authored content actually persisting via updateProjectTask; closed-vocab-only board_update calls are unaffected; and the opt-in is read per-project, never collapsed across a shared warm window."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
