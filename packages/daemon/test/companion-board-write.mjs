import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `board_create`/`board_update`, the `board-reach`
// ACT half (card 7975c034). The 2nd sensitive ACT lever — copies `decision_resolve`'s (card a8ddd6d2)
// exact proven Primitive-C shape, including its post-review CR hardening (the confirm prompt is
// delivered DIRECTLY to the owner, never returned to the companion).
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport, driven with a FAKE `pty` (getActiveTurnOwnerText/getActiveTurnOrigin/enqueueStdin) and a
// FAKE `companion` (deliverReply) — the router only needs these, never a real claude process or chat
// adapter. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   - board_create title-not-verbatim reject
//   - board_create body-not-verbatim reject
//   - write on a read-only-granted project reject (mayAct false), for both board_create and board_update
//   - write on an ungranted project reject (board_create); an update on a card whose project is
//     ungranted rejects too (board_update resolves the card GLOBALLY first)
//   - NO delete tool is ever registered
//   - board_create's Primitive-C round-trip: propose delivers via outbound + returns a bare status,
//     confirm applies exactly once via createProjectTask
//   - board_update's Primitive-C round-trip: propose delivers via outbound + returns a bare status,
//     confirm applies exactly once via updateProjectTask (column move / priority / held)
//   - proactive-turn (no owner text) reject, for both tools
//   - null-route / failed-delivery fail-closed, for both tools
//   - attack-sim: a companion that never received the real token cannot forge a confirm for a swapped
//     action (mirrors companion-decision-resolve.mjs's (g))
//   - cross-tool attack-sim: board_create and board_update SHARE one capability-slug/pending-map
//     namespace (by design) — a real confirm token minted for a board_create propose must not commit a
//     DIFFERENT board_update call (or vice versa) even though it passes Primitive C's own token check;
//     the `pending.action !== ...` discriminator must catch it, and the token is single-use either way
// Run: 1) build (turbo builds shared first), 2) node test/companion-board-write.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-board-write-${Date.now()}-${process.pid}`);
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
  const client = new Client({ name: "companion-board-write-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const DEFAULT_ROUTE = { channel: "in-app", chatId: "cockpit" };

// A FAKE pty — the router only ever calls getActiveTurnOwnerText/getActiveTurnOrigin/enqueueStdin on it
// (registerCompanionCapabilities), never spawns/isAlive/etc. `ownerText` is mutable so a test can
// simulate the owner's confirming reply landing as the NEXT turn's literal text.
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

// A FAKE companion (CompanionHooks) — the ONLY method the outbound seam calls is `deliverReply`, exactly
// the rail `chat_reply` uses. `shouldDeliver:false` simulates a delivery failure.
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

try {
  // ============ board_create: title-not-verbatim reject ============
  {
    const db = tmpDb();
    const proj = "proj-title";
    seedProject(db, proj, "Title");
    const companionSess = "companion-title";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: fix the login bug");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_create", { project: proj, title: "Something the owner never said" });
    check("title-not-verbatim: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("title-not-verbatim: nothing delivered to the owner", companion.delivered.length === 0);
    check("title-not-verbatim: no card was created", db.listTasks(proj).length === 0);
    await client.close();
    db.close();
  }

  // ============ board_create: body-not-verbatim reject ============
  {
    const db = tmpDb();
    const proj = "proj-body";
    seedProject(db, proj, "Body");
    const companionSess = "companion-body";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: fix the login bug, details: it happens on Safari");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_create", { project: proj, title: "fix the login bug", body: "totally fabricated body text" });
    check("body-not-verbatim: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("body-not-verbatim: nothing delivered to the owner", companion.delivered.length === 0);
    check("body-not-verbatim: no card was created", db.listTasks(proj).length === 0);
    await client.close();
    db.close();
  }

  // ============ board_create: act on a read-only-granted project is rejected (mayAct false) ============
  {
    const db = tmpDb();
    const projRead = "proj-readonly";
    const projAct = "proj-actmode";
    seedProject(db, projRead, "Read-only");
    seedProject(db, projAct, "Act-mode");
    const companionSess = "companion-mixed";
    seedSession(db, companionSess, projRead, "assistant");
    // board_create is registered because ANOTHER granted project is act-mode — but the TARGET project
    // (projRead) is only read-mode, and the per-project mayAct recheck must still refuse it.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projRead, mode: "read" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projAct, mode: "act" });
    const pty = makeFakePty("the owner said: add a card");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_create", { project: projRead, title: "add a card" });
    check("board_create read-only project: rejected with an {error} (mayAct false)", typeof res.error === "string" && res.status === undefined);
    check("board_create read-only project: no card was created", db.listTasks(projRead).length === 0);
    await client.close();
    db.close();
  }

  // ============ board_create: write on an ungranted project is rejected ============
  {
    const db = tmpDb();
    const projGranted = "proj-granted";
    const projOther = "proj-other";
    seedProject(db, projGranted, "Granted");
    seedProject(db, projOther, "Other");
    const companionSess = "companion-ungranted";
    seedSession(db, companionSess, projGranted, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projGranted, mode: "act" });
    const pty = makeFakePty("the owner said: add a card");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_create", { project: projOther, title: "add a card" });
    check("board_create ungranted project: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("board_create ungranted project: no card was created anywhere", db.listTasks(projOther).length === 0 && db.listTasks(projGranted).length === 0);
    await client.close();
    db.close();
  }

  // ============ NO delete tool is ever registered ============
  {
    const db = tmpDb();
    const proj = "proj-nodelete";
    seedProject(db, proj, "No delete");
    const companionSess = "companion-nodelete";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("board_create is registered", tools.includes("board_create"));
    check("board_update is registered", tools.includes("board_update"));
    check("NO delete tool is registered (board_delete)", !tools.includes("board_delete"));
    check("only board_list/board_create/board_update are the board tools", tools.filter((t) => t.startsWith("board_")).sort().join(",") === "board_create,board_list,board_update");
    db.close();
  }

  // ============ board_create: unconfirmed does NOT create; confirmed create calls createProjectTask exactly once ============
  {
    const db = tmpDb();
    const proj = "proj-confirm-create";
    seedProject(db, proj, "Confirm create");
    const companionSess = "companion-confirm-create";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: create a card titled Fix login, body: happens on Safari only");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // First call — PROPOSES, never creates.
    const proposed = await call(client, "board_create", { project: proj, title: "Fix login", body: "happens on Safari only" });
    check("propose: returns a BARE status:'proposed', nothing else", proposed.status === "proposed" && Object.keys(proposed).length === 1);
    check("propose: NO promptText is returned to the companion", proposed.promptText === undefined);
    check("propose: NO token is returned to the companion", proposed.token === undefined);
    check("unconfirmed: no card exists yet", db.listTasks(proj).length === 0);
    check("(e) exactly one message was delivered to the owner via the outbound rail", companion.delivered.length === 1);
    check("(e) the delivered text names the exact proposed action", companion.delivered[0].text.includes("Fix login") && companion.delivered[0].text.includes("Safari"));
    check("(e) the delivered text is addressed to THIS companion session", companion.delivered[0].sessionId === companionSess);

    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const created = await call(client, "board_create", { project: proj, title: "Fix login", body: "happens on Safari only" });
    check("confirm: returns status:'created'", created.status === "created");
    const tasks = db.listTasks(proj);
    check("confirm: exactly one card was created", tasks.length === 1);
    check("confirm: title/body persisted via the SAME createProjectTask write tasks_create uses", tasks[0].title === "Fix login" && tasks[0].body === "happens on Safari only");
    check("confirm: no SECOND owner delivery happened on commit", companion.delivered.length === 1);

    // A repeat call with the SAME (now-consumed) confirm text must NOT create a second card.
    const third = await call(client, "board_create", { project: proj, title: "Fix login", body: "happens on Safari only" });
    check("exactly-once: a repeat call with the same confirm text does not create twice", third.status !== "created");
    check("exactly-once: still exactly one card exists", db.listTasks(proj).length === 1);

    await client.close();
    db.close();
  }

  // ============ board_update: unconfirmed does NOT apply; confirmed update calls updateProjectTask exactly once ============
  {
    const db = tmpDb();
    const proj = "proj-confirm-update";
    seedProject(db, proj, "Confirm update");
    const companionSess = "companion-confirm-update";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-upd", proj, { title: "Move me", columnKey: "backlog", priority: "p2" });
    // Companion Trust Window (Framework Card 0): board_update carries no free-text content, so — unlike
    // board_create — a warm trust window has nothing to re-validate and would let a THIRD identical call
    // legitimately re-apply the SAME patch (the intended low-friction behavior). This test's own purpose is
    // verifying Primitive C's single-use/exactly-once round-trip machinery itself, so pin friction:
    // "per-action" to exercise that machinery unconditionally, exactly as before this card.
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act",
      config: { friction: "per-action" },
    });
    const pty = makeFakePty("the owner said: bump that to p0 and move it to in_progress");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "board_update", { id: "t-upd", columnKey: "in_progress", priority: "p0" });
    check("propose: returns a BARE status:'proposed', nothing else", proposed.status === "proposed" && Object.keys(proposed).length === 1);
    check("unconfirmed: card is unchanged", db.getTask("t-upd").columnKey === "backlog" && db.getTask("t-upd").priority === "p2");
    check("exactly one message was delivered to the owner", companion.delivered.length === 1);
    check("the delivered text names the exact proposed change", companion.delivered[0].text.includes("in_progress") && companion.delivered[0].text.includes("p0"));

    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const updated = await call(client, "board_update", { id: "t-upd", columnKey: "in_progress", priority: "p0" });
    check("confirm: returns status:'updated'", updated.status === "updated");
    const task = db.getTask("t-upd");
    check("confirm: columnKey/priority persisted via the SAME updateProjectTask write tasks_update uses", task.columnKey === "in_progress" && task.priority === "p0");
    check("confirm: no SECOND owner delivery happened on commit", companion.delivered.length === 1);

    const third = await call(client, "board_update", { id: "t-upd", columnKey: "in_progress", priority: "p0" });
    check("exactly-once: a repeat call with the same confirm text does not resolve twice", third.status !== "updated");

    await client.close();
    db.close();
  }

  // ============ board_update: held flag round-trip ============
  {
    const db = tmpDb();
    const proj = "proj-held";
    seedProject(db, proj, "Held");
    const companionSess = "companion-held";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-held", proj, { title: "Hold me" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: mark it held");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const proposed = await call(client, "board_update", { id: "t-held", held: true });
    check("held propose: succeeds", proposed.status === "proposed");
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const updated = await call(client, "board_update", { id: "t-held", held: true });
    check("held confirm: applies", updated.status === "updated" && db.getTask("t-held").held === true);
    await client.close();
    db.close();
  }

  // ============ board_update: no fields given is rejected ============
  {
    const db = tmpDb();
    const proj = "proj-nofields";
    seedProject(db, proj, "No fields");
    const companionSess = "companion-nofields";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-nofields", proj, {});
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: update it");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_update", { id: "t-nofields" });
    check("no fields given: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("no fields given: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ board_update: card on a project not in scope is rejected (resolved GLOBALLY first) ============
  {
    const db = tmpDb();
    const projGranted = "proj-upd-granted";
    const projOther = "proj-upd-other";
    seedProject(db, projGranted, "Granted");
    seedProject(db, projOther, "Other");
    const companionSess = "companion-upd-ungranted";
    seedSession(db, companionSess, projGranted, "assistant");
    seedTask(db, "t-other", projOther, { title: "Not yours" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projGranted, mode: "act" });
    const pty = makeFakePty("the owner said: move it");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_update", { id: "t-other", priority: "p0" });
    check("board_update ungranted project: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("board_update ungranted project: card unchanged", db.getTask("t-other").priority === "p2");
    await client.close();
    db.close();
  }

  // ============ board_update: act on a read-only-granted project is rejected ============
  {
    const db = tmpDb();
    const proj = "proj-upd-readonly";
    seedProject(db, proj, "Read-only update");
    const companionSess = "companion-upd-readonly";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-ro", proj, { title: "Read only card" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "read" });
    // board_update is not even registered under a read-only grant — calling it must 404 from the client's
    // perspective (unknown tool). Prove that instead of calling a nonexistent tool.
    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("read-only grant: board_update is not even registered", !tools.includes("board_update"));
    db.close();
  }

  // ============ (g) false-label attack is structurally dead ============
  {
    const db = tmpDb();
    const proj = "proj-attack";
    seedProject(db, proj, "Attack");
    const companionSess = "companion-attack";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-attack", proj, { title: "Attack target", priority: "p2" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: bump priority to p1");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // A hijacked companion proposes "p1" (what it will TRUTHFULLY tell the owner) — the tool's return
    // carries no token, so the companion has nothing to embed in a false-labeled message.
    const proposed = await call(client, "board_update", { id: "t-attack", priority: "p1" });
    check("attack setup: propose succeeds, no token in the return", proposed.status === "proposed" && proposed.token === undefined && proposed.promptText === undefined);

    // The companion GUESSES a plausible-looking confirm string and tries to commit a DIFFERENT change.
    pty.setOwnerText("CONFIRM GUESSED");
    const forged = await call(client, "board_update", { id: "t-attack", priority: "p0" });
    check("attack: a companion-guessed token does NOT commit the swapped action", forged.status !== "updated");
    check("attack: the card priority is unchanged", db.getTask("t-attack").priority === "p2");

    // Only the OWNER's real reply (containing the daemon-delivered token) can commit — and it commits the
    // ORIGINALLY proposed action (p1), never whatever the companion's forged call asked for.
    const realToken = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${realToken}`);
    const resolved = await call(client, "board_update", { id: "t-attack", priority: "p1" });
    check("attack: the REAL owner confirm commits the ORIGINALLY proposed action (p1)", resolved.status === "updated" && db.getTask("t-attack").priority === "p1");

    await client.close();
    db.close();
  }

  // ============ cross-tool attack: propose board_create, confirm via board_update ============
  // board_create/board_update share ONE capability-slug namespace ("board-reach") for Primitive C, so
  // Primitive C's own token check alone would happily match a create's token against an update call on
  // the same (session, route) — the `pending.action !== ...` discriminator inside each tool is the ONLY
  // thing that catches this. This is the one invariant that's genuinely new vs single-tool decision_resolve.
  {
    const db = tmpDb();
    const proj = "proj-cross";
    seedProject(db, proj, "Cross tool");
    const companionSess = "companion-cross";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-cross", proj, { title: "Existing card", priority: "p2" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: create a card titled Cross tool card");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "board_create", { project: proj, title: "Cross tool card" });
    check("cross-tool (create→update): board_create propose succeeds", proposed.status === "proposed");
    const token = extractToken(companion.delivered.at(-1).text);

    // The owner's REAL confirm token (minted for the pending CREATE) is delivered on a board_UPDATE call
    // instead — same session+route, same shared pending-map key. Primitive C's token check alone would
    // pass; the action-discriminator must reject it.
    pty.setOwnerText(`CONFIRM ${token}`);
    const crossed = await call(client, "board_update", { id: "t-cross", priority: "p0" });
    check("cross-tool (create→update): board_update with the create's token does NOT resolve to 'updated'", crossed.status !== "updated");
    check("cross-tool (create→update): the crossed call reports a mismatch, not a fresh propose", typeof crossed.error === "string");
    check("cross-tool (create→update): no card was created", db.listTasks(proj).length === 1);
    check("cross-tool (create→update): the existing card was NOT updated", db.getTask("t-cross").priority === "p2");

    // Single-use: the token was consumed by the crossed attempt above (Primitive C deletes on ANY
    // verbatim-token match, independent of what the lever does with the commit) — a repeat with the SAME
    // (now-stale) confirm text must not commit anything either, from either tool.
    const repeatUpdate = await call(client, "board_update", { id: "t-cross", priority: "p0" });
    check("cross-tool (create→update): a repeat crossed attempt with the consumed token does not commit either", repeatUpdate.status !== "updated");
    check("cross-tool (create→update): card still unchanged after the repeat", db.getTask("t-cross").priority === "p2");

    await client.close();
    db.close();
  }

  // ============ cross-tool attack, reverse direction: propose board_update, confirm via board_create ============
  {
    const db = tmpDb();
    const proj = "proj-cross-rev";
    seedProject(db, proj, "Cross tool reverse");
    const companionSess = "companion-cross-rev";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-cross-rev", proj, { title: "Existing card", priority: "p2" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: bump priority to p0");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "board_update", { id: "t-cross-rev", priority: "p0" });
    check("cross-tool (update→create): board_update propose succeeds", proposed.status === "proposed");
    const token = extractToken(companion.delivered.at(-1).text);

    // The owner's REAL confirm token (minted for the pending UPDATE) is delivered on a board_CREATE call
    // instead. Note this never even reaches board_create's own Primitive B check — the shared-slug
    // confirm branch is tried FIRST, and the action-discriminator must reject it there.
    pty.setOwnerText(`CONFIRM ${token}`);
    const crossed = await call(client, "board_create", { project: proj, title: "Sneaky new card" });
    check("cross-tool (update→create): board_create with the update's token does NOT resolve to 'created'", crossed.status !== "created");
    check("cross-tool (update→create): the crossed call reports a mismatch, not a fresh propose", typeof crossed.error === "string");
    check("cross-tool (update→create): no card was created", db.listTasks(proj).length === 1);
    check("cross-tool (update→create): the existing card was NOT updated", db.getTask("t-cross-rev").priority === "p2");

    // Single-use: a repeat with the SAME (now-consumed) confirm text must not commit anything either.
    const repeatCreate = await call(client, "board_create", { project: proj, title: "Sneaky new card" });
    check("cross-tool (update→create): a repeat crossed attempt with the consumed token does not commit either", repeatCreate.status !== "created");
    check("cross-tool (update→create): still no card created after the repeat", db.listTasks(proj).length === 1);

    await client.close();
    db.close();
  }

  // ============ no reply-to route ⇒ fail closed (both tools) ============
  {
    const db = tmpDb();
    const proj = "proj-noroute";
    seedProject(db, proj, "No route");
    const companionSess = "companion-noroute";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-noroute", proj, {});
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: add a card", { route: null });
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const resCreate = await call(client, "board_create", { project: proj, title: "add a card" });
    check("no route (create): rejected with an {error}", typeof resCreate.error === "string" && resCreate.status === undefined);
    check("no route (create): no card was created", db.listTasks(proj).length === 1); // only the seeded one
    check("no route (create): NO delivery was even attempted", companion.delivered.length === 0);

    const resUpdate = await call(client, "board_update", { id: "t-noroute", priority: "p0" });
    check("no route (update): rejected with an {error}", typeof resUpdate.error === "string" && resUpdate.status === undefined);
    check("no route (update): card unchanged", db.getTask("t-noroute").priority === "p2");
    check("no route (update): NO delivery was even attempted", companion.delivered.length === 0);

    await client.close();
    db.close();
  }

  // ============ a failed outbound delivery ⇒ fail closed (create) ============
  {
    const db = tmpDb();
    const proj = "proj-faildelivery-create";
    seedProject(db, proj, "Fail delivery create");
    const companionSess = "companion-faildelivery-create";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: add a card");
    const companion = makeFakeCompanion(false); // simulate no-adapter / send-failed
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const resCreate = await call(client, "board_create", { project: proj, title: "add a card" });
    check("failed delivery (create): rejected with an {error}", typeof resCreate.error === "string" && resCreate.status === undefined);
    check("failed delivery (create): no card was created", db.listTasks(proj).length === 0);
    // Even if the owner somehow guessed the (never-delivered) token, nothing should be resolvable — the
    // stray OwnerConfirmStore token from the failed propose above is left standing (mirrors
    // decision_resolve's own documented tradeoff: harmless, since our own pendingBoardWrites entry was
    // never set for it), so a follow-up call under the SAME session/route may report either a fresh
    // propose OR a confirm-mismatch against that stray token — either way it must never fabricate a card.
    const orphanCreate = await call(client, "board_create", { project: proj, title: "add a card" });
    check("failed delivery (create): a follow-up call never resolves to 'created'", orphanCreate.status !== "created");
    check("failed delivery (create): still no card exists", db.listTasks(proj).length === 0);

    await client.close();
    db.close();
  }

  // ============ a failed outbound delivery ⇒ fail closed (update) ============
  {
    const db = tmpDb();
    const proj = "proj-faildelivery-update";
    seedProject(db, proj, "Fail delivery update");
    const companionSess = "companion-faildelivery-update";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-faildelivery", proj, {});
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: bump priority");
    const companion = makeFakeCompanion(false); // simulate no-adapter / send-failed
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const resUpdate = await call(client, "board_update", { id: "t-faildelivery", priority: "p0" });
    check("failed delivery (update): rejected with an {error}", typeof resUpdate.error === "string" && resUpdate.status === undefined);
    check("failed delivery (update): card unchanged", db.getTask("t-faildelivery").priority === "p2");

    await client.close();
    db.close();
  }

  // ============ proactive-turn reject (Primitive A null — no owner text), both tools ============
  {
    const db = tmpDb();
    const proj = "proj-proactive";
    seedProject(db, proj, "Proactive");
    const companionSess = "companion-proactive";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-proactive", proj, {});
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty(null); // no owner text this turn — a proactive/heartbeat/reminder turn
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const resCreate = await call(client, "board_create", { project: proj, title: "add a card" });
    check("proactive turn (create): rejected with an {error} (no owner text)", typeof resCreate.error === "string" && resCreate.status === undefined);
    check("proactive turn (create): nothing delivered to the owner", companion.delivered.length === 0);

    const resUpdate = await call(client, "board_update", { id: "t-proactive", priority: "p0" });
    check("proactive turn (update): rejected with an {error} (no owner text)", typeof resUpdate.error === "string" && resUpdate.status === undefined);
    check("proactive turn (update): nothing delivered to the owner", companion.delivered.length === 0);

    await client.close();
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — board_create/board_update reject a non-verbatim title/body, act on a read-only-granted or ungranted project, any proactive (no-owner-text) turn, a missing reply-to route, and a failed outbound delivery; NO delete tool is ever registered; neither tool ever applies on the first (propose) call, both deliver the confirm prompt to the OWNER directly (never the companion, which receives no promptText/token), and both apply EXACTLY ONCE via the existing createProjectTask/updateProjectTask writes once the owner's own next turn carries the confirm token — a companion that never saw the token cannot forge a confirm for a swapped action; and a real confirm token minted for one tool's proposal can never commit the OTHER tool's write, in either direction, even though they share one capability-slug/pending-map namespace by design."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
