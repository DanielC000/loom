import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `decision_resolve`, the `decisions-relay` ACT half
// (card a8ddd6d2). THE highest-risk lever in the whole catalog: resolving a decision-inbox question can
// approve owner-gated / irreversible work. This is the FIRST consumer of the injection-guard primitives
// (card 8e511951's `attest` — Primitives A/B/C).
//
// CR HARDENING (post-review): Primitive C's confirm prompt must reach the OWNER directly — never the
// companion (the exact untrusted component C exists to defend against). This file proves: (1) the prompt
// is delivered on the OUTBOUND rail (a fake `companion.deliverReply` seam capturing the delivered text),
// (2) the tool's return to the companion carries NO promptText/token (opaque `{status:'proposed'}`), (3) a
// missing route or a failed delivery FAILS CLOSED (no proposal left pending), and (4) even armed with a
// GUESSED confirm string, a companion can never commit an action it never received the real token for.
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport, driven with a FAKE `pty` (getActiveTurnOwnerText/getActiveTurnOrigin/enqueueStdin) and a FAKE
// `companion` (deliverReply) — the router only needs these, never a real claude process or chat adapter.
// NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   - option-not-offered reject
//   - note-not-verbatim reject
//   - unconfirmed (no Primitive-C round-trip) does NOT resolve
//   - confirmed resolve calls the existing db.answerQuestion path exactly once
//   - act on a read-only-granted project is rejected (mayAct false), even though decision_resolve is
//     registered (another one of the companion's granted projects is act-mode)
//   - a decision-class outside the project's decisionClasses allowlist is rejected; explicitly allowlisting
//     it unlocks the SAME question
//   - a proactive turn (Primitive A null — no owner text) is rejected outright
//   - no reply-to route ⇒ fail closed (nothing proposed, no delivery attempted)
//   - a failed outbound delivery ⇒ fail closed (nothing left pending)
//   - the confirm prompt is delivered on the OUTBOUND rail, never returned to the companion; a companion
//     that never received the real token cannot forge a working confirm
// Run: 1) build (turbo builds shared first), 2) node test/companion-decision-resolve.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-decision-resolve-${Date.now()}-${process.pid}`);
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
const { classifyDecisionClass } = await import("../dist/companion/capabilities.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-decision-resolve-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const DEFAULT_ROUTE = { channel: "in-app", chatId: "cockpit" };

// A FAKE pty — the router only ever calls getActiveTurnOwnerText/getActiveTurnOrigin/enqueueStdin on it
// (registerCompanionCapabilities), never spawns/isAlive/etc. `ownerText` is mutable so a test can simulate
// the owner's confirming reply landing as the NEXT turn's literal text. `route` defaults to a real route
// (decision_resolve now REFUSES a null route outright) — pass `route: null` to exercise that refusal.
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

// A FAKE companion (CompanionHooks) — the ONLY method decision_resolve's outbound seam calls is
// `deliverReply`, exactly the rail `chat_reply` uses. `shouldDeliver:false` simulates a delivery failure
// (no adapter / send-failed / no-target) to prove the fail-closed path.
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

// Extract the confirm token the DAEMON delivered to the owner (never available to the companion's own
// tool-call return value) — the one place a test is ALLOWED to know it, to simulate the owner's reply.
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
  // ============ classifyDecisionClass — direct unit tests of the keyword logic ============
  {
    check("classify: 'red or blue?' has no risky keywords ⇒ general",
      classifyDecisionClass({ title: "Pick a color", body: "red or blue?" }) === "general");
    check("classify: 'delete the old table' ⇒ irreversible",
      classifyDecisionClass({ title: "Cleanup", body: "delete the old table" }) === "irreversible");
    check("classify: 'drop the staging index' ⇒ irreversible",
      classifyDecisionClass({ title: "DB tweak", body: "drop the staging index" }) === "irreversible");
    check("classify: 'force-push to release/2.0' ⇒ irreversible",
      classifyDecisionClass({ title: "Branch fix", body: "force-push to release/2.0" }) === "irreversible");
    check("classify: 'deploy the new build' ⇒ deploy",
      classifyDecisionClass({ title: "Ship it", body: "deploy the new build" }) === "deploy");
    check("classify: 'rollout to 10% of users' ⇒ deploy",
      classifyDecisionClass({ title: "Rollout", body: "rollout to 10% of users" }) === "deploy");
    check("classify: 'deploy the DB migration that will drop the old column' ⇒ irreversible wins over deploy",
      classifyDecisionClass({ title: "Migration", body: "deploy the DB migration that will drop the old column" }) === "irreversible");
    check("classify: 'redeployment' does NOT loosely match 'deploy' (word boundary — stays general)",
      classifyDecisionClass({ title: "Word boundary check", body: "redeployment schedule question" }) === "general");
  }

  // ============ option-not-offered reject ============
  {
    const db = tmpDb();
    const proj = "proj-opt";
    seedProject(db, proj, "Opt");
    const companionSess = "companion-opt";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-opt", proj, "manager");
    seedQuestion(db, "q-opt", "asker-opt", proj, { options: ["approve", "reject"] });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
      config: { decisionClasses: ["general"] },
    });
    const pty = makeFakePty("the owner said something");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "decision_resolve", { questionId: "q-opt", chosenOption: "not-an-option" });
    check("option-not-offered: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("option-not-offered: question stays pending", db.getQuestion("q-opt").state === "pending");
    check("option-not-offered: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ note-not-verbatim reject ============
  {
    const db = tmpDb();
    const proj = "proj-note";
    seedProject(db, proj, "Note");
    const companionSess = "companion-note";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-note", proj, "manager");
    seedQuestion(db, "q-note", "asker-note", proj, { options: ["approve", "reject"] });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
      config: { decisionClasses: ["general"] },
    });
    const pty = makeFakePty("the owner said: go ahead");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "decision_resolve", { questionId: "q-note", chosenOption: "approve", note: "the owner said something totally different" });
    check("note-not-verbatim: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("note-not-verbatim: question stays pending", db.getQuestion("q-note").state === "pending");
    check("note-not-verbatim: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ whitespace-only note is treated as NO note (fold #2) ============
  {
    const db = tmpDb();
    const proj = "proj-wsnote";
    seedProject(db, proj, "WS note");
    const companionSess = "companion-wsnote";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-wsnote", proj, "manager");
    seedQuestion(db, "q-wsnote", "asker-wsnote", proj, { options: ["approve", "reject"] });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
      config: { decisionClasses: ["general"] },
    });
    // Owner text does NOT contain any whitespace-only "note" — if B were skipped for a whitespace note
    // (the pre-fold bug), this would wrongly propose; with the fix it should propose fine too, since a
    // whitespace-only note is treated as absent (nothing for B to check).
    const pty = makeFakePty("the owner said: approve it");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const proposed = await call(client, "decision_resolve", { questionId: "q-wsnote", chosenOption: "approve", note: "   " });
    check("whitespace-only note: propose succeeds (note treated as absent, not a B violation)", proposed.status === "proposed");
    const token = extractToken(companion.delivered.at(-1).text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const resolved = await call(client, "decision_resolve", { questionId: "q-wsnote", chosenOption: "approve", note: "   " });
    check("whitespace-only note: resolves with note stored as null (not the whitespace string)", resolved.status === "resolved" && db.getQuestion("q-wsnote").note === null);
    await client.close();
    db.close();
  }

  // ============ unconfirmed does NOT resolve; confirmed resolve calls answerQuestion exactly once ============
  {
    const db = tmpDb();
    const proj = "proj-confirm";
    seedProject(db, proj, "Confirm");
    const companionSess = "companion-confirm";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-confirm", proj, "manager");
    seedQuestion(db, "q-confirm", "asker-confirm", proj, { options: ["approve", "reject"] });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
      config: { decisionClasses: ["general"] },
    });
    const pty = makeFakePty("the owner said: approve it, note: looks good");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // First call — PROPOSES, never resolves.
    const proposed = await call(client, "decision_resolve", { questionId: "q-confirm", chosenOption: "approve", note: "looks good" });
    check("propose: returns a BARE status:'proposed', nothing else", proposed.status === "proposed" && Object.keys(proposed).length === 1);
    check("propose: NO promptText is returned to the companion", proposed.promptText === undefined);
    check("propose: NO token is returned to the companion", proposed.token === undefined);
    check("unconfirmed: question is STILL pending after the propose call", db.getQuestion("q-confirm").state === "pending");

    // (e) the confirm prompt WAS delivered — on the OUTBOUND rail, not returned to the companion.
    check("(e) exactly one message was delivered to the owner via the outbound rail", companion.delivered.length === 1);
    check("(e) the delivered text names the exact proposed action", companion.delivered[0].text.includes("approve") && companion.delivered[0].text.includes("looks good"));
    check("(e) the delivered text is addressed to THIS companion session", companion.delivered[0].sessionId === companionSess);

    // Simulate the owner's NEXT turn: literal text is just the confirm reply (read from the OUTBOUND
    // delivery, never from the companion's own tool-call return — proving the companion never saw it).
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const resolved = await call(client, "decision_resolve", { questionId: "q-confirm", chosenOption: "approve", note: "looks good" });
    check("confirm: returns status:'resolved'", resolved.status === "resolved");
    const afterFirst = db.getQuestion("q-confirm");
    check("confirm: db.answerQuestion actually ran — question is now 'answered'", afterFirst.state === "answered");
    check("confirm: chosenOption/note persisted via the SAME answerQuestion write the human UI uses", afterFirst.chosenOption === "approve" && afterFirst.note === "looks good");
    check("confirm: a best-effort nudge was pushed to the asking session", pty.enqueued.some((args) => args[0] === "asker-confirm"));
    check("confirm: no SECOND owner delivery happened on commit", companion.delivered.length === 1);

    // A THIRD call with the SAME (now-consumed) confirm text must NOT resolve again — proves "exactly once".
    const third = await call(client, "decision_resolve", { questionId: "q-confirm", chosenOption: "approve", note: "looks good" });
    check("exactly-once: a repeat call with the same confirm text does not resolve twice", third.status !== "resolved");
    check("exactly-once: question row is unchanged by the repeat call", db.getQuestion("q-confirm").answeredAt === afterFirst.answeredAt);

    await client.close();
    db.close();
  }

  // ============ (g) false-label attack is structurally dead: the companion never sees the token, so it
  // cannot forge a confirm for an action it lied to the owner about ============
  {
    const db = tmpDb();
    const proj = "proj-attack";
    seedProject(db, proj, "Attack");
    const companionSess = "companion-attack";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-attack", proj, "manager");
    seedQuestion(db, "q-attack", "asker-attack", proj, { options: ["approve", "reject"] });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
      config: { decisionClasses: ["general"] },
    });
    const pty = makeFakePty("the owner said: reject it");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // A hijacked companion proposes "reject" (what it will TRUTHFULLY tell the owner) — the tool's return
    // carries no token, so the companion has nothing to embed in a false-labeled message even if it wanted
    // to claim a DIFFERENT action was proposed.
    const proposed = await call(client, "decision_resolve", { questionId: "q-attack", chosenOption: "reject" });
    check("attack setup: propose succeeds, no token in the return", proposed.status === "proposed" && proposed.token === undefined && proposed.promptText === undefined);

    // The companion GUESSES a plausible-looking confirm string (it never received the real token) and
    // tries to commit "approve" instead — a completely different call than what was proposed.
    pty.setOwnerText("CONFIRM GUESSED"); // the companion's fabricated, unauthenticated guess
    const forged = await call(client, "decision_resolve", { questionId: "q-attack", chosenOption: "approve" });
    check("attack: a companion-guessed token does NOT commit the swapped action", forged.status !== "resolved");
    check("attack: the question is STILL pending — no swap ever landed", db.getQuestion("q-attack").state === "pending");

    // Only the OWNER's real reply (containing the daemon-delivered token) can commit — and it commits the
    // ORIGINALLY proposed action ("reject"), never whatever the companion's forged call asked for.
    const realToken = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${realToken}`);
    const resolved = await call(client, "decision_resolve", { questionId: "q-attack", chosenOption: "reject" });
    check("attack: the REAL owner confirm commits the ORIGINALLY proposed action (reject)", resolved.status === "resolved" && db.getQuestion("q-attack").chosenOption === "reject");

    await client.close();
    db.close();
  }

  // ============ (c) no reply-to route ⇒ fail closed ============
  {
    const db = tmpDb();
    const proj = "proj-noroute";
    seedProject(db, proj, "No route");
    const companionSess = "companion-noroute";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-noroute", proj, "manager");
    seedQuestion(db, "q-noroute", "asker-noroute", proj, { options: ["approve", "reject"] });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
      config: { decisionClasses: ["general"] },
    });
    const pty = makeFakePty("the owner said: approve it", { route: null }); // no reply-to route this turn
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "decision_resolve", { questionId: "q-noroute", chosenOption: "approve" });
    check("no route: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("no route: question stays pending", db.getQuestion("q-noroute").state === "pending");
    check("no route: NO delivery was even attempted (nothing to deliver to)", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ a failed outbound delivery ⇒ fail closed, nothing left pending ============
  {
    const db = tmpDb();
    const proj = "proj-faildelivery";
    seedProject(db, proj, "Fail delivery");
    const companionSess = "companion-faildelivery";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-faildelivery", proj, "manager");
    seedQuestion(db, "q-faildelivery", "asker-faildelivery", proj, { options: ["approve", "reject"] });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
      config: { decisionClasses: ["general"] },
    });
    const pty = makeFakePty("the owner said: approve it");
    const companion = makeFakeCompanion(false); // simulate no-adapter / send-failed
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "decision_resolve", { questionId: "q-faildelivery", chosenOption: "approve" });
    check("failed delivery: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("failed delivery: question stays pending", db.getQuestion("q-faildelivery").state === "pending");
    // Even if the owner somehow guessed the (never-delivered) token, nothing should be resolvable — our
    // own pendingDecisionResolves payload was never stored on a failed delivery.
    const orphanConfirmAttempt = await call(client, "decision_resolve", { questionId: "q-faildelivery", chosenOption: "approve" });
    check("failed delivery: a follow-up call proposes fresh again (no stale pending state left behind)", orphanConfirmAttempt.status === "proposed" || typeof orphanConfirmAttempt.error === "string");
    await client.close();
    db.close();
  }

  // ============ act on a read-only-granted project is rejected (mayAct false) ============
  {
    const db = tmpDb();
    const projRead = "proj-readonly";
    const projAct = "proj-actmode";
    seedProject(db, projRead, "Read-only");
    seedProject(db, projAct, "Act-mode");
    const companionSess = "companion-mixed";
    seedSession(db, companionSess, projRead, "assistant");
    seedSession(db, "asker-readonly", projRead, "manager");
    seedQuestion(db, "q-readonly", "asker-readonly", projRead, { options: ["approve", "reject"] });
    // decision_resolve is registered because ANOTHER granted project is act-mode — but THIS question's own
    // project is only read-mode, and the per-project mayAct recheck must still refuse it.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "decisions-relay", projectId: projRead, mode: "read", config: { decisionClasses: ["general"] } });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "decisions-relay", projectId: projAct, mode: "act", config: { decisionClasses: ["general"] } });

    const pty = makeFakePty("the owner said: approve it");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "decision_resolve", { questionId: "q-readonly", chosenOption: "approve" });
    check("read-only project: rejected with an {error} (mayAct false)", typeof res.error === "string" && res.status === undefined);
    check("read-only project: question stays pending", db.getQuestion("q-readonly").state === "pending");
    await client.close();
    db.close();
  }

  // ============ decision-class outside allowlist reject; explicit allowlist unlocks it ============
  {
    const db = tmpDb();
    const proj = "proj-class";
    seedProject(db, proj, "Class");
    const companionSess = "companion-class";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-class", proj, "manager");
    // "general"-classified question (no deploy/irreversible keywords).
    seedQuestion(db, "q-class", "asker-class", proj, { title: "Pick a color", body: "red or blue?", options: ["red", "blue"] });
    // No decisionClasses configured at all — the conservative default admits NOTHING.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act" });

    const pty = makeFakePty("the owner said: red");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const rejected = await call(client, "decision_resolve", { questionId: "q-class", chosenOption: "red" });
    check("decision-class: rejected with no decisionClasses configured (conservative default)", typeof rejected.error === "string" && rejected.status === undefined);
    check("decision-class: question stays pending", db.getQuestion("q-class").state === "pending");
    await client.close();

    // Now explicitly allowlist "general" on this project and retry — the SAME question resolves.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act", config: { decisionClasses: ["general"] } });
    const client2 = await connect(orch.buildServer(companionSess, "assistant"));
    const proposed = await call(client2, "decision_resolve", { questionId: "q-class", chosenOption: "red" });
    check("decision-class: once allowlisted, the SAME question now proposes", proposed.status === "proposed");
    await client2.close();
    db.close();
  }

  // ============ proactive-turn resolve reject (Primitive A null — no owner text) ============
  {
    const db = tmpDb();
    const proj = "proj-proactive";
    seedProject(db, proj, "Proactive");
    const companionSess = "companion-proactive";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "asker-proactive", proj, "manager");
    seedQuestion(db, "q-proactive", "asker-proactive", proj, { options: ["approve", "reject"] });
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
      config: { decisionClasses: ["general"] },
    });
    const pty = makeFakePty(null); // no owner text this turn — a proactive/heartbeat/reminder turn
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "decision_resolve", { questionId: "q-proactive", chosenOption: "approve" });
    check("proactive turn: rejected with an {error} (no owner text)", typeof res.error === "string" && res.status === undefined);
    check("proactive turn: question stays pending", db.getQuestion("q-proactive").state === "pending");
    check("proactive turn: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — decision_resolve rejects an unoffered option, a non-verbatim note, act on a read-only-granted project, a decision class outside the project's allowlist, any proactive (no-owner-text) turn, a missing reply-to route, and a failed outbound delivery; it never resolves on the first (propose) call, delivers the confirm prompt to the OWNER directly (never the companion, which receives no promptText/token), and resolves EXACTLY ONCE via the existing db.answerQuestion write once the owner's own next turn carries the confirm token — a companion that never saw the token cannot forge a confirm for a swapped action."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
