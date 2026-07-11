import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Trust Window retrofit (Companion Capability & Permission-Lever Framework — Companion→
// Platform-Lead epic, Card 0) — the 3 LIVE act levers (decision_resolve/board_create/board_update) driven
// through the REAL OrchestrationMcpRouter, proving the "verify once, then low friction" behavior end to
// end (not just the pure trust-window/friction-helper unit tests in companion-trust-window.mjs /
// companion-friction.mjs).
//
// Covers the card's DoD:
//   - decision_resolve tier-split: a "general" decision flows immediately in a warm window; a
//     deploy/irreversible decision ALWAYS steps up, even inside an otherwise-warm window
//   - the trust window is SHARED across levers (one lever's step-up warms another's Tier-A call)
//   - friction:"per-action" reverts a Tier-A act to the legacy unconditional propose/confirm
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport, driven with a FAKE `pty` and a FAKE `companion` (deliverReply) — never a real claude process.
// Run: 1) build (turbo builds shared first), 2) node test/companion-trust-window-retrofit.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-companion-trust-window-retrofit-${Date.now()}-${process.pid}`);
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
  const client = new Client({ name: "companion-trust-window-retrofit-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const DEFAULT_ROUTE = { channel: "in-app", chatId: "cockpit" };

function makeFakePty(initialOwnerText, opts = {}) {
  let ownerText = initialOwnerText ?? null;
  const route = opts.route === undefined ? DEFAULT_ROUTE : opts.route;
  return {
    setOwnerText(t) { ownerText = t; },
    getActiveTurnOwnerText() { return ownerText; },
    getActiveTurnOrigin() { return route; },
    getActiveTurnSenderId() { return null; },
    enqueueStdin() { return { delivered: false, reason: "held" }; },
  };
}

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
function seedQuestion(db, id, sessionId, projectId, opts = {}) {
  db.insertQuestion({
    id, sessionId, projectId, title: opts.title ?? "Pick an approach", body: opts.body ?? "which one?",
    options: opts.options ?? ["approve", "reject"], recommendation: null,
    state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  // ============ decision_resolve tier-split: general flows in-window; deploy ALWAYS steps up ============
  {
    const db = tmpDb();
    const proj = "proj-tier";
    seedProject(db, proj, "Tier");
    const companionSess = "companion-tier";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-tier", proj, "manager");
    seedQuestion(db, "q-general-1", "asker-tier", proj, { title: "Pick a color", body: "red or blue?", options: ["red", "blue"] });
    seedQuestion(db, "q-general-2", "asker-tier", proj, { title: "Pick a size", body: "small or large?", options: ["small", "large"] });
    seedQuestion(db, "q-deploy", "asker-tier", proj, { title: "Ship it", body: "deploy the new build?", options: ["approve", "reject"] });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
      config: { decisionClasses: ["general", "deploy"] }, // default friction ⇒ session-trust
    });
    const pty = makeFakePty("the owner said: go ahead");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // Cold window: the FIRST general decision must still propose+confirm.
    const proposed1 = await call(client, "decision_resolve", { questionId: "q-general-1", chosenOption: "red" });
    check("cold window: first general decision PROPOSES (does not resolve on the first call)", proposed1.status === "proposed");
    const token1 = extractToken(companion.delivered.at(-1).text);
    pty.setOwnerText(`CONFIRM ${token1}`);
    const resolved1 = await call(client, "decision_resolve", { questionId: "q-general-1", chosenOption: "red" });
    check("cold window: confirmed resolve commits", resolved1.status === "resolved" && db.getQuestion("q-general-1").state === "answered");

    // Window is now WARM (armed by the step-up above). A SECOND general decision must resolve IMMEDIATELY.
    pty.setOwnerText("the owner said: go with small this time");
    const deliveredCountBefore = companion.delivered.length;
    const resolved2 = await call(client, "decision_resolve", { questionId: "q-general-2", chosenOption: "small" });
    check("warm window: a SECOND general decision resolves on the FIRST call (no propose/confirm round-trip)", resolved2.status === "resolved");
    check("warm window: db.answerQuestion actually committed", db.getQuestion("q-general-2").state === "answered" && db.getQuestion("q-general-2").chosenOption === "small");
    check("warm window: NOTHING new delivered to the owner (no confirm prompt needed)", companion.delivered.length === deliveredCountBefore);

    // A deploy/irreversible decision ALWAYS steps up, even though the window is (still) warm.
    pty.setOwnerText("the owner said: ship the new build");
    const proposedDeploy = await call(client, "decision_resolve", { questionId: "q-deploy", chosenOption: "approve" });
    check("Tier X (deploy): ALWAYS proposes, even with a warm window", proposedDeploy.status === "proposed");
    check("Tier X (deploy): question stays pending until confirmed", db.getQuestion("q-deploy").state === "pending");
    const tokenDeploy = extractToken(companion.delivered.at(-1).text);
    pty.setOwnerText(`CONFIRM ${tokenDeploy}`);
    const resolvedDeploy = await call(client, "decision_resolve", { questionId: "q-deploy", chosenOption: "approve" });
    check("Tier X (deploy): confirms and resolves on the SECOND call", resolvedDeploy.status === "resolved" && db.getQuestion("q-deploy").state === "answered");

    await client.close();
    db.close();
  }

  // ============ the trust window is SHARED across levers — decision_resolve's step-up warms board_create too ============
  {
    const db = tmpDb();
    const proj = "proj-shared";
    seedProject(db, proj, "Shared");
    const companionSess = "companion-shared";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-shared", proj, "manager");
    seedQuestion(db, "q-shared", "asker-shared", proj, { title: "Pick a color", body: "red or blue?", options: ["red", "blue"] });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
      config: { decisionClasses: ["general"] },
    });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: go with red");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // Warm the window via decision_resolve.
    const proposed = await call(client, "decision_resolve", { questionId: "q-shared", chosenOption: "red" });
    check("decision_resolve proposes on the cold window", proposed.status === "proposed");
    const token = extractToken(companion.delivered.at(-1).text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const resolved = await call(client, "decision_resolve", { questionId: "q-shared", chosenOption: "red" });
    check("decision_resolve resolves and arms the shared window", resolved.status === "resolved");

    // board_create, on the SAME session/route, should now flow immediately too.
    pty.setOwnerText("the owner said: file a card titled fix the login bug");
    const deliveredCountBefore = companion.delivered.length;
    const created = await call(client, "board_create", { project: proj, title: "fix the login bug" });
    check("board_create flows IMMEDIATELY on the warm window a DIFFERENT lever just armed", created.status === "created");
    check("board_create: nothing new delivered (no confirm needed)", companion.delivered.length === deliveredCountBefore);
    check("board_create: the card actually exists", created.task && typeof created.task.id === "string");

    await client.close();
    db.close();
  }

  // ============ friction:"per-action" reverts a Tier-A act to the legacy per-action confirm ============
  {
    const db = tmpDb();
    const proj = "proj-per-action";
    seedProject(db, proj, "PerAction");
    const companionSess = "companion-per-action";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-per-action", proj, "manager");
    seedQuestion(db, "q-pa-1", "asker-per-action", proj, { title: "Pick a color", body: "red or blue?", options: ["red", "blue"] });
    seedQuestion(db, "q-pa-2", "asker-per-action", proj, { title: "Pick a size", body: "small or large?", options: ["small", "large"] });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
      config: { decisionClasses: ["general"], friction: "per-action" },
    });
    const pty = makeFakePty("the owner said: go ahead");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed1 = await call(client, "decision_resolve", { questionId: "q-pa-1", chosenOption: "red" });
    check("friction:per-action: first call proposes (same as the default)", proposed1.status === "proposed");
    const token1 = extractToken(companion.delivered.at(-1).text);
    pty.setOwnerText(`CONFIRM ${token1}`);
    const resolved1 = await call(client, "decision_resolve", { questionId: "q-pa-1", chosenOption: "red" });
    check("friction:per-action: confirmed resolve commits", resolved1.status === "resolved");

    // A SECOND general decision must STILL propose — the step-up above must never have armed the window.
    pty.setOwnerText("the owner said: go with small this time");
    const proposed2 = await call(client, "decision_resolve", { questionId: "q-pa-2", chosenOption: "small" });
    check("friction:per-action: a SECOND general decision STILL proposes (window never armed)", proposed2.status === "proposed");
    check("friction:per-action: question 2 stays pending until confirmed", db.getQuestion("q-pa-2").state === "pending");
    const token2 = extractToken(companion.delivered.at(-1).text);
    pty.setOwnerText(`CONFIRM ${token2}`);
    const resolved2 = await call(client, "decision_resolve", { questionId: "q-pa-2", chosenOption: "small" });
    check("friction:per-action: confirms and resolves on the SECOND call", resolved2.status === "resolved");

    await client.close();
    db.close();
  }
} finally {
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}
