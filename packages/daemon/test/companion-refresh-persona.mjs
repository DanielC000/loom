import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — "/refresh": a live, NON-destructive persona/memory upgrade for a long-lived companion.
// Unlike "/new"/"/reset" (which "/clear"s the whole conversation before reinjecting persona), "/refresh"
// recomposes+re-enqueues the SAME fresh-spawn-equivalent prompt (base brief + name + memory recall) with NO
// "/clear" and NO history reset — an agent-definition edit (persona brief, given name, or memory) lands
// mid-conversation while the existing conversation is untouched. Fully hermetic: a REAL Db, a REAL
// SessionService (fake PtyHost seam — NO real claude), and the REAL CompanionController + factory-built
// ChatGateway. Proves:
//   (1) "/refresh" is a registered command (COMMANDS map + COMMAND_MENU).
//   (2) commandHandler("refresh") acks accurately from deps.refreshPersona's return: "reloaded" when a
//       prompt was actually composed+enqueued, a friendly "nothing to refresh" when it wasn't (missing/
//       non-assistant session, or no injected side-channel at all).
//   (3) END TO END via CompanionController.handleInAppInbound("/refresh"): the reinject fires via the
//       injected side-channel with the REAL composed persona text (SessionService.composeCompanionReinjectPrompt)
//       — same text/shape "/new"'s reinject uses — and NO "/clear" is ever submitted (the key behavioral
//       difference from "/new": the underlying conversation is never touched).
//   (4) NO PERSIST / NO RENDER: the persona text never becomes a companion_messages row and never reaches an
//       attached web viewer as a frame — only the ack does (mirrors "/new"'s reinject invisibility).
//   (5) NOT a conversation boundary: pre-existing history is untouched by "/refresh" (unlike "/new", whose ack
//       IS the intentional boundary marker) — every message present before "/refresh" is still present after.
//   (6) Default-OFF: omitting `reinjectPersona` leaves "/refresh" acking "nothing to refresh" and still
//       swallowed as a command (never becomes a turn, never crashes).
// Run: 1) build (turbo builds shared first), 2) node test/companion-refresh-persona.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-companion-refresh-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { InAppChannel, IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { CompanionController } = await import("../dist/companion/controller.js");
const { commandHandler, registeredCommandNames, COMMAND_MENU } = await import("../dist/companion/commands.js");
const { inMemoryVoicePrefs } = await import("../dist/companion/voice-prefs.js");

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
db.insertProject({ id: projId, name: "Refresh", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
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
db.upsertCompanionBinding({ sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, scope: "dm" });

function makeController(reinjectPersona) {
  const inApp = new InAppChannel({
    record: (s, author, text) => db.insertCompanionMessage({ id: randomUUID(), sessionId: s, channel: IN_APP_CHANNEL, chatId: s, author, text, createdAt: new Date().toISOString() }),
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
    ...(reinjectPersona ? { reinjectPersona } : {}),
  });
  return { controller, frames, submitted };
}

try {
  // =========================================================================================================
  // (1) "/refresh" is a registered command
  // =========================================================================================================
  {
    check("registeredCommandNames includes 'refresh'", registeredCommandNames().includes("refresh"));
    check("COMMAND_MENU advertises 'refresh'", COMMAND_MENU.map((c) => c.command).includes("refresh"));
  }

  // =========================================================================================================
  // (2) commandHandler("refresh") acks from deps.refreshPersona's return value
  // =========================================================================================================
  {
    const route = { sessionId: "s", channel: "c", chatId: "c", senderId: null };
    const okResult = commandHandler("refresh")(undefined, route, inMemoryVoicePrefs(), { refreshPersona: () => true });
    check("(2) refreshPersona:true -> a 'reloaded' ack", /reload/i.test(okResult.ack));

    const noopResult = commandHandler("refresh")(undefined, route, inMemoryVoicePrefs(), { refreshPersona: () => false });
    check("(2) refreshPersona:false -> a friendly 'nothing to refresh' ack, not an error", /nothing to refresh/i.test(noopResult.ack));
  }

  // =========================================================================================================
  // (3)-(5) end to end via CompanionController.handleInAppInbound: real composed text, no /clear, no persist/render, no history disturbance
  // =========================================================================================================
  {
    db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author: "user", text: "my name is Daniel", createdAt: now });
    db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author: "companion", text: "hi Daniel!", createdAt: now });
    const beforeMessages = db.listCurrentCompanionMessages(sessionId);

    // Mirrors index.ts's REAL wiring exactly (a raw enqueue built from SessionService.composeCompanionReinjectPrompt,
    // returning whether a prompt was composed) so this proves the REAL composed text flows through, not a stub.
    const enqueued = [];
    const reinjectPersonaSpy = (sid) => {
      const prompt = svc.composeCompanionReinjectPrompt(sid);
      if (prompt) enqueued.push({ sid, text: prompt, source: "system" });
      return !!prompt;
    };
    const { controller, frames, submitted } = makeController(reinjectPersonaSpy);
    await controller.reconcile();

    const r = await controller.handleInAppInbound(sessionId, "/refresh");
    check("(3) '/refresh' never becomes a turn (a command result, not accepted)", r.accepted === false && r.reason === "command" && r.command === "refresh");
    check("(3) acked", r.acked === true);
    check("(3) the reinject side-channel fired exactly once, for this session", enqueued.length === 1 && enqueued[0].sid === sessionId);
    check("(3) it carries the REAL composed persona text (base brief + name), not a placeholder", enqueued[0].text.startsWith("# Loom Companion") && enqueued[0].text.includes("Your name is Aria."));
    check("(3) it is tagged source:\"system\" (the raw-enqueue side-channel)", enqueued[0].source === "system");

    check("(3) KEY DIFFERENCE from '/new': NO '/clear' (or any turn) is ever submitted — the conversation is untouched", submitted.length === 0);

    const afterMessages = db.listCurrentCompanionMessages(sessionId);
    // "/refresh" is transport chrome like "/status"/"/whoami" (NOT a "/new"-style conversation-boundary
    // marker) — its ack is never persisted at all, so the row count is completely unchanged.
    check("(4) NO PERSIST: neither the persona reinject NOR the ack itself added a row", afterMessages.length === beforeMessages.length);
    check("(4) NO PERSIST: none of the persisted rows carry the persona/base-brief text", !afterMessages.some((m) => m.text.includes("Loom Companion") || m.text.includes("Your name is Aria.")));
    check("(5) NOT a conversation boundary: the pre-existing messages are still present, untouched", beforeMessages.every((m) => afterMessages.some((a) => a.id === m.id)));

    check("(4) NO RENDER: exactly ONE live frame — the ack (no 'cleared' frame, unlike '/new')", frames.length === 1 && frames[0].type === "chat");
    check("(4) NO RENDER: the frame doesn't carry the persona/base-brief text", !(frames[0].text ?? "").includes("Loom Companion") && !(frames[0].text ?? "").includes("Your name is Aria."));
  }

  // =========================================================================================================
  // (6) default-OFF: omitting `reinjectPersona` leaves "/refresh" a harmless no-op ack
  // =========================================================================================================
  {
    const beforeCount = db.listCurrentCompanionMessages(sessionId).length;
    const { controller, frames, submitted } = makeController(undefined);
    await controller.reconcile();

    const r = await controller.handleInAppInbound(sessionId, "/refresh");
    check("(6) default-OFF: still swallowed as a command (never a turn, never crashes)", r.accepted === false && r.reason === "command" && r.command === "refresh");
    check("(6) default-OFF: no turn ever submitted", submitted.length === 0);
    check("(6) default-OFF: the ack reports nothing to refresh", frames.some((f) => f.type === "chat" && /nothing to refresh/i.test(f.text)));
    check("(6) default-OFF: the ack itself is transport chrome too — no new persisted row", db.listCurrentCompanionMessages(sessionId).length === beforeCount);
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — '/refresh' is a registered command that recomposes+re-enqueues the REAL fresh-spawn-equivalent persona/memory prompt via the same raw-enqueue side-channel '/new' uses, but WITHOUT ever submitting '/clear' or resetting history — the conversation and pre-existing messages are completely untouched, the reinject never persists a row or renders a frame, and omitting the side-channel degrades to a harmless 'nothing to refresh' ack."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
