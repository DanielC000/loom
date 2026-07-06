import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — "/new" PERSONA REINJECT (companion-persona-after-clear card): "/clear" wipes a
// companion's ONE persona turn (baked in only at fresh spawn) along with the rest of the conversation,
// leaving it identity-less. This re-injects that same fresh-spawn-equivalent prompt (base brief + name +
// memory recall) right after "/clear", via a RAW pty enqueue that bypasses chat-history recording and
// live-viewer rendering entirely. Fully hermetic: a REAL Db, a REAL SessionService (fake PtyHost seam — NO
// real claude), and the REAL CompanionController + factory-built ChatGateway. Proves:
//   (1) SessionService.composeCompanionReinjectPrompt is COMPOSE-ONLY (a pure read, no session/db side
//       effect) and returns a prompt BYTE-IDENTICAL to composing the fresh-spawn path by hand: the agent's
//       own brief + the companion's given name (sourced from the durable companion_config.name column, not
//       re-derivable from the session/agent row) + the SAME memory-recall digest a fresh spawn/resume gets;
//       undefined for a missing session or a non-assistant session.
//   (2) END TO END via CompanionController.handleInAppInbound("/new"): the reinject fires via the injected
//       side-channel (never the narrow submitTurn primitive) and carries the REAL composed persona text.
//   (3) ORDERING: the reinject is enqueued strictly AFTER "/clear" (FIFO — proven by a shared call-order log).
//   (4) NO PERSIST / NO RENDER: the persona text never becomes a companion_messages row (the newly-opened
//       current conversation holds only the ack, exactly like today) and never reaches an attached web viewer
//       as a frame (still exactly the 'cleared' + ack pair) — proving the raw-enqueue side-channel is
//       invisible on both axes.
//   (5) Default-OFF: omitting `reinjectPersona` from CompanionControllerDeps leaves "/new" byte-identical to
//       before this card (no reinject attempted).
// Run: 1) build (turbo builds shared first), 2) node test/companion-persona-reinject.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-companion-reinject-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { InAppChannel, IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { CompanionController } = await import("../dist/companion/controller.js");
const { composeAssistantStartupPrompt, appendMemoryRecallToStartupPrompt } = await import("../dist/sessions/assistant-prompt.js");
const { buildFramedMemoryRecall } = await import("../dist/companion/memory-recall.js");
const { listCompanionMemories, readCompanionMemory, authorCompanionMemory } = await import("../dist/skills/companion-memory-store.js");

const db = new Db();
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new PtyHost(events); // never spawns anything below — compose is a pure db read
const svc = new SessionService(db, host, new OrchestrationControl());

const now = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Reinject", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
const agentId = randomUUID();
db.insertAgent({ id: agentId, projectId: projId, name: "Companion", startupPrompt: "AGENT_OWN_PROMPT", position: 0, profileId: null, endpoint: false, ioSchema: null });
const sessionId = randomUUID();
db.insertSession({
  id: sessionId, projectId: projId, agentId, engineSessionId: `eng-${sessionId}`, title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});
db.upsertCompanionConfig({
  sessionId, botTokenBlob: "", channel: IN_APP_CHANNEL, allowedChatId: sessionId, chatScope: "dm",
  heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true, name: "Aria",
});
const pinnedContent = "---\nname: user-name\ndescription: what to call the user\npinned: true\n---\n\nThe user goes by Dee.";
check("setup: memory authored for the reinject test", authorCompanionMemory(sessionId, "user-name", pinnedContent).ok === true);

try {
  // =========================================================================================================
  // (1) composeCompanionReinjectPrompt: compose-only, byte-identical to the fresh-spawn compose path by hand
  // =========================================================================================================
  {
    const expected = appendMemoryRecallToStartupPrompt(
      composeAssistantStartupPrompt("AGENT_OWN_PROMPT", "Aria"),
      buildFramedMemoryRecall(listCompanionMemories(sessionId), (n) => readCompanionMemory(sessionId, n)),
    );
    const prompt = svc.composeCompanionReinjectPrompt(sessionId);
    check("(1) compose returns a non-empty prompt", !!prompt);
    check("(1) compose is BYTE-IDENTICAL to hand-composing the fresh-spawn path", prompt === expected);
    check("(1) carries the base brief heading", prompt.startsWith("# Loom Companion"));
    check("(1) carries the given name (sourced from companion_config.name, not the session/agent row)", prompt.includes("Your name is Aria."));
    check("(1) carries the agent's own brief", prompt.includes("AGENT_OWN_PROMPT"));
    check("(1) carries the memory recall digest (same as a fresh spawn/resume would get)", prompt.includes("Recalled from your own durable memory") && prompt.includes("The user goes by Dee."));

    // No session/db side effect from calling compose: a second call is identical, and the session row itself
    // (busy/processState) is untouched — proves this is a pure read, never a spawn/write path.
    check("(1) compose is idempotent / repeatable (pure — no state mutated)", svc.composeCompanionReinjectPrompt(sessionId) === prompt);
    const sessionAfter = db.getSession(sessionId);
    check("(1) the session row is completely untouched by composing (no spawn/write side effect)",
      sessionAfter.busy === false && sessionAfter.processState === "live" && sessionAfter.engineSessionId === `eng-${sessionId}`);

    check("(1) undefined for a missing session", svc.composeCompanionReinjectPrompt("no-such-session") === undefined);

    const nonAssistantId = randomUUID();
    db.insertSession({
      id: nonAssistantId, projectId: projId, agentId, engineSessionId: `eng-${nonAssistantId}`, title: null, cwd: projId,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
    });
    check("(1) undefined for a non-assistant-role session", svc.composeCompanionReinjectPrompt(nonAssistantId) === undefined);
  }

  // =========================================================================================================
  // (2)-(4) end to end via CompanionController.handleInAppInbound: real composed text, ordering, no-persist/render
  // =========================================================================================================
  {
    db.upsertCompanionBinding({ sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, scope: "dm" });
    db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author: "user", text: "my name is Daniel", createdAt: now });
    db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author: "companion", text: "hi Daniel!", createdAt: now });

    const inApp = new InAppChannel({
      record: (sid, author, text) => db.insertCompanionMessage({ id: randomUUID(), sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, author, text, createdAt: new Date().toISOString() }),
    });
    const frames = [];
    inApp.attach(sessionId, { deliver: (f) => frames.push(f) });

    // A shared call-order log — the (3) ordering assertion below. submitSpy is the SAME submitTurn primitive
    // companion-new.mjs exercises; reinjectPersonaSpy mirrors index.ts's REAL wiring exactly (a raw enqueue
    // built from SessionService.composeCompanionReinjectPrompt) so this proves the REAL composed text flows
    // through, not a test double's fixed string.
    const order = [];
    const submitted = [];
    const submitSpy = (sid, text, route) => { order.push("clear"); submitted.push({ sid, text, route }); return { delivered: true }; };
    const enqueued = [];
    const reinjectPersonaSpy = (sid) => {
      const prompt = svc.composeCompanionReinjectPrompt(sid);
      order.push("reinject");
      if (prompt) enqueued.push({ sid, text: prompt, source: "system" });
    };

    const cfg = {
      botToken: null, allowedChatId: sessionId, sessionId, chatScope: "dm",
      homeChannel: IN_APP_CHANNEL, homeChatId: sessionId, heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
    };
    const controller = new CompanionController({
      db, submitTurn: submitSpy,
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks: { companionSessionIds: new Set() }, env: {}, inApp, resolveEffective: () => [cfg],
      reinjectPersona: reinjectPersonaSpy,
    });
    await controller.reconcile();

    const r = await controller.handleInAppInbound(sessionId, "/new");
    check("(2) /new: still never becomes a turn (unaffected by the reinject side-channel)", r.accepted === false && r.reason === "command" && r.command === "new");

    check("(2) the reinject side-channel fired exactly once, for this session", enqueued.length === 1 && enqueued[0].sid === sessionId);
    check("(2) it carries the REAL composed persona text (base brief + name), not a placeholder", enqueued[0].text.startsWith("# Loom Companion") && enqueued[0].text.includes("Your name is Aria."));
    check("(2) it is tagged source:\"system\" (the raw-enqueue side-channel, mirrors the memory-recall resume-inject)", enqueued[0].source === "system");

    check("(3) ORDERING: '/clear' is enqueued strictly before the persona reinject (FIFO)", order.length === 2 && order[0] === "clear" && order[1] === "reinject");

    const afterMessages = db.listCurrentCompanionMessages(sessionId);
    check("(4) NO PERSIST: the NEW current conversation holds just the ack — the persona reinject added NO row", afterMessages.length === 1 && afterMessages[0].author === "companion");
    check("(4) NO PERSIST: none of the persisted rows carry the persona/base-brief text", !afterMessages.some((m) => m.text.includes("Loom Companion") || m.text.includes("Your name is Aria.")));

    check("(4) NO RENDER: exactly the SAME two live frames as a plain /new — 'cleared' then the ack", frames.length === 2 && frames[0].type === "cleared" && frames[1].type === "chat");
    check("(4) NO RENDER: neither frame carries the persona/base-brief text", !frames.some((f) => (f.text ?? "").includes("Loom Companion") || (f.text ?? "").includes("Your name is Aria.")));
  }

  // =========================================================================================================
  // (5) default-OFF: omitting `reinjectPersona` leaves "/new" byte-identical to before this card
  // =========================================================================================================
  {
    db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author: "user", text: "one more message", createdAt: new Date().toISOString() });

    const inApp = new InAppChannel({
      record: (sid, author, text) => db.insertCompanionMessage({ id: randomUUID(), sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, author, text, createdAt: new Date().toISOString() }),
    });
    const frames = [];
    inApp.attach(sessionId, { deliver: (f) => frames.push(f) });
    const submitted = [];
    const submitSpy = (sid, text, route) => { submitted.push({ sid, text, route }); return { delivered: true }; };
    const cfg = {
      botToken: null, allowedChatId: sessionId, sessionId, chatScope: "dm",
      homeChannel: IN_APP_CHANNEL, homeChatId: sessionId, heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
    };
    const controller = new CompanionController({
      db, submitTurn: submitSpy,
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks: { companionSessionIds: new Set() }, env: {}, inApp, resolveEffective: () => [cfg],
      // reinjectPersona OMITTED
    });
    await controller.reconcile();
    await controller.handleInAppInbound(sessionId, "/new");

    check("(5) default-OFF: '/clear' still submitted (unaffected)", submitted.length === 1 && submitted[0].text === "/clear");
    check("(5) default-OFF: the NEW current conversation holds just the ack (no reinject attempted, no crash)", db.listCurrentCompanionMessages(sessionId).length === 1);
    check("(5) default-OFF: still exactly the 'cleared' + ack frame pair", frames.length === 2 && frames[0].type === "cleared" && frames[1].type === "chat");
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — composeCompanionReinjectPrompt is a pure, compose-only read that reproduces the exact fresh-spawn prompt (base brief + companion_config.name + memory recall) and is undefined for a missing/non-assistant session; the '/new' reinject side-channel fires the REAL composed text strictly AFTER '/clear' (FIFO) via a raw enqueue that never persists a companion_messages row and never renders a frame to an attached viewer; and omitting the side-channel leaves '/new' byte-identical to before this card."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
