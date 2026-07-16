import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — CR follow-up on card 2b26035c ("board_create
// verbatim-quote guard forces owner repetition"): a "session"-scoped inline authored-content grant
// (Direction (a), see companion-authored-content-grant.mjs) must NOT survive a "/new"/"/reset" — that's
// both the tool's own doc promise ("until reset/recycle") and the intuitive clean-slate semantics of a
// conversation reset. Before this follow-up, `resetConversation` (chat-gateway.ts) never called
// `closeTrustWindow`, so the sessionId being unchanged across "/new" let the in-memory grant silently
// carry over into the "fresh" conversation.
//
// Fully hermetic, wiring the SAME two real components production wires together for exactly this path
// (index.ts:~569 `closeTrustWindow: (sid) => orchMcp.closeCompanionTrustWindow(sid)`):
//   - a REAL Db + REAL OrchestrationMcpRouter over an in-memory MCP transport (the companion's own tool
//     surface — grants + spends the authored-content grant via board_create, exactly like
//     companion-authored-content-grant.mjs)
//   - a REAL CompanionController + factory-built ChatGateway (mirrors companion-new.mjs's own harness),
//     with `closeTrustWindow` wired to `orch.closeCompanionTrustWindow` — the production wiring, not a
//     spy — so this proves the ACTUAL close path, not just that some callback fired
// NO network, NO real claude, NO daemon.
//
// Covers:
//   - a SESSION-scoped grant lets an authored (non-verbatim) board_create commit BEFORE "/new"
//   - "/new" (via CompanionController.handleInAppInbound) is what triggers the close — asserted via the
//     SAME session's later board_create call, not by peeking at internals
//   - the SAME grant is GONE after "/new" — a later authored (non-verbatim) board_create on the SAME
//     project is rejected again, requiring a fresh grant or a verbatim quote
//   - a fresh grant AFTER "/new" still works (the capability itself isn't broken, just its prior grant)
// Run: 1) build (turbo builds shared first), 2) node test/companion-reset-clears-grant.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-reset-clears-grant-${Date.now()}-${process.pid}`);
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
const { InAppChannel, IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { CompanionController } = await import("../dist/companion/controller.js");

async function connectMcp(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-reset-clears-grant-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const callTool = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

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

const now0 = new Date().toISOString();

try {
  const db = new Db(path.join(tmpHome, `${randomUUID()}.db`));
  const proj = "proj-reset-clears-grant";
  db.insertProject({ id: proj, name: "Reset clears grant", repoPath: proj, vaultPath: proj, config: {}, createdAt: now0, archivedAt: null });
  const agentId = randomUUID();
  const sessionId = randomUUID();
  db.insertAgent({ id: agentId, projectId: proj, name: "Companion", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
  db.insertSession({
    id: sessionId, projectId: proj, agentId, engineSessionId: `eng-${sessionId}`, title: null, cwd: proj,
    processState: "live", resumability: "resumable", busy: false, createdAt: now0, lastActivity: now0, lastError: null, role: "assistant",
  });
  db.upsertCompanionCapabilityGrant({ sessionId, capability: "board-reach", projectId: proj, mode: "act" });
  db.upsertCompanionBinding({ sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, scope: "dm" });

  // The REAL router — the companion's own tool surface (grants + spends the authored-content grant).
  const pty = makeFakePty("let the companion author cards for the rest of this chat");
  const mcpCompanion = makeFakeCompanion();
  const orch = new OrchestrationMcpRouter(db, {}, mcpCompanion, pty);
  const mcpClient = await connectMcp(orch.buildServer(sessionId, "assistant"));

  // The REAL CompanionController + factory-built ChatGateway, wired EXACTLY like index.ts:~569 —
  // `closeTrustWindow` points at the SAME router's `closeCompanionTrustWindow`, the production path.
  const inApp = new InAppChannel({
    record: (sid, author, text) => db.insertCompanionMessage({ id: randomUUID(), sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, author, text, createdAt: new Date().toISOString() }),
  });
  const cfg = {
    botToken: null, allowedChatId: sessionId, sessionId, chatScope: "dm",
    homeChannel: IN_APP_CHANNEL, homeChatId: sessionId, heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
  };
  const controller = new CompanionController({
    db, submitTurn: () => ({ delivered: true }),
    pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
    hooks: { companionSessionIds: new Set() }, env: {}, inApp, resolveEffective: () => [cfg],
    closeTrustWindow: (sid) => orch.closeCompanionTrustWindow(sid), // the SAME production wiring as index.ts
  });
  await controller.reconcile();

  // --- Grant a SESSION-scoped authored-content grant, and spend it once — proves it's live BEFORE /new ---
  const grantProposed = await callTool(mcpClient, "authored_content_grant", { project: proj, scope: "session" });
  check("setup: grant proposes fine", grantProposed.status === "proposed");
  const grantToken = extractToken(mcpCompanion.delivered[0].text);
  pty.setOwnerText(`CONFIRM ${grantToken}`);
  const grantGranted = await callTool(mcpClient, "authored_content_grant", { project: proj, scope: "session" });
  check("setup: a real owner confirm commits the SESSION-scoped grant", grantGranted.status === "granted");

  // The board-write Tier-A trust window is COLD here (first-ever board_create on this session/route), so
  // an authored (non-verbatim) title goes through propose→confirm, not a direct commit.
  pty.setOwnerText("the owner said: file the first one, before reset");
  const beforeResetProposed = await callTool(mcpClient, "board_create", { project: proj, title: "Authored BEFORE /new, never said verbatim" });
  check("before /new: authored content proposes (cold window)", beforeResetProposed.status === "proposed");
  const beforeResetToken = extractToken(mcpCompanion.delivered[mcpCompanion.delivered.length - 1].text);
  pty.setOwnerText(`CONFIRM ${beforeResetToken}`);
  const beforeReset = await callTool(mcpClient, "board_create", { project: proj, title: "Authored BEFORE /new, never said verbatim" });
  check("before /new: the live session grant lets authored (non-verbatim) content commit", beforeReset.status === "created");

  // --- Trigger the ACTUAL "/new" path via the real CompanionController — production code, not a spy ---
  const resetResult = await controller.handleInAppInbound(sessionId, "/new");
  check("/new: handled as a command (never becomes a turn)", resetResult.accepted === false && resetResult.reason === "command" && resetResult.command === "new");

  // --- The grant must be GONE now: a later authored (non-verbatim) call on the SAME project is rejected ---
  pty.setOwnerText("the owner said: file another one, after reset");
  const afterReset = await callTool(mcpClient, "board_create", { project: proj, title: "Authored AFTER /new, never said verbatim, should be rejected" });
  check("SECURITY/DOC-PROMISE: after /new, the session-scoped grant is CLEARED — the same authored content is rejected again", typeof afterReset.error === "string" && afterReset.status === undefined);
  check("after /new: no NEW card was created for the rejected attempt", !db.listTasks(proj).some((t) => t.title.includes("should be rejected")));

  // --- The capability itself is not broken — a FRESH grant after /new still works ---
  const freshGrantProposed = await callTool(mcpClient, "authored_content_grant", { project: proj, scope: "once" });
  check("after /new: a FRESH grant can still be proposed", freshGrantProposed.status === "proposed");
  const freshToken = extractToken(mcpCompanion.delivered[mcpCompanion.delivered.length - 1].text);
  pty.setOwnerText(`CONFIRM ${freshToken}`);
  const freshGranted = await callTool(mcpClient, "authored_content_grant", { project: proj, scope: "once" });
  check("after /new: the fresh grant commits", freshGranted.status === "granted");
  // The trust window was also cleared by /new (closeCompanionTrustWindow closes both), so this is
  // ANOTHER cold propose→confirm, not a direct commit.
  pty.setOwnerText("the owner said: file this last one");
  const freshCreateProposed = await callTool(mcpClient, "board_create", { project: proj, title: "Authored via a FRESH post-reset grant, never said verbatim" });
  check("after /new: a genuinely fresh grant proposes fine (cold window)", freshCreateProposed.status === "proposed");
  const freshCreateToken = extractToken(mcpCompanion.delivered[mcpCompanion.delivered.length - 1].text);
  pty.setOwnerText(`CONFIRM ${freshCreateToken}`);
  const freshCreate = await callTool(mcpClient, "board_create", { project: proj, title: "Authored via a FRESH post-reset grant, never said verbatim" });
  check("after /new: a genuinely fresh grant still lets authored content commit", freshCreate.status === "created");

  await mcpClient.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a 'session'-scoped inline authored-content grant is live before '/new', is CLEARED by the real '/new' path (CompanionController → resetConversation → closeTrustWindow → OrchestrationMcpRouter.closeCompanionTrustWindow → AuthoredContentGrantStore.clearSession), so a repeat authored call on the same project after '/new' is rejected again, and a fresh grant minted after '/new' still works — the reset is a real clean-slate boundary for this grant, matching both the tool's doc promise and '/lock's own step-down posture."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
