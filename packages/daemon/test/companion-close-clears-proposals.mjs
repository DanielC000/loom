import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 327bcaaa ("Companion 'proposed' actions linger as stubs the Companion can neither list nor
// withdraw") — the session-close hygiene half of the fix. Before this card, `closeCompanionTrustWindow`
// (mcp/orchestration.ts, called from every session recycle/unbind/re-pair AND from `/new`/`/reset`)
// cleared the trust window + the inline authored-content grant, but NEVER cleared an outstanding
// (unconfirmed) Primitive-C proposal — neither the shared `OwnerConfirmStore` token/summary/expiry
// (attestation.ts) nor an ACT lever's own remembered payload (`pendingBoardWrites`/
// `pendingDecisionResolves`/`pendingAuthoredGrants`/`pendingSpawns`, capabilities.ts). A recycled/
// unbound/re-paired session's pending proposal became permanently-orphaned dead memory — never a
// security issue (nothing can ever confirm it once the session is gone), but genuine leaked state that
// only a full daemon restart would clear.
//
// CR FOLLOW-UP (this card): the first pass of this test only asserted the BEHAVIORAL surface — that a
// captured pre-close token no longer commits. That's a REAL but WEAKER claim than "the payload map was
// cleared": every lever's commit path checks the confirm TOKEN (OwnerConfirmStore) FIRST, before it ever
// reads its own payload map, so "the token doesn't commit" passes whether or not the payload map was
// actually cleared — it would pass identically if `clearPendingProposalsForSession` were deleted entirely
// and only `OwnerConfirmStore.clearSession` ran. That gap is exactly how the ORIGINAL version of this fix
// shipped with `pendingSpawns` (session-spawn's own payload map) un-cleared — nothing in this file
// observed the maps directly, so a missed map produced no test failure. This version adds a DIRECT,
// ISOLATING assertion via the test-only `pendingProposalCountForSession` introspection export: it counts
// entries across ALL FOUR payload maps for a session, so it can FAIL on a payload-map regression even if
// the token half of the clear still works perfectly. The pre-existing behavioral checks are kept too
// (they prove the user-facing outcome, which the count alone doesn't).
//
// Covers, for THREE distinct ACT levers (board-reach's `pendingBoardWrites`, decisions-relay's
// `pendingDecisionResolves`, and session-spawn's `pendingSpawns` — the exact lever the first pass missed):
//   - each PROPOSES (left unconfirmed) — `pendingProposalCountForSession` is NON-ZERO right after
//   - closeCompanionTrustWindow(sessionId) is called directly (the method under test, the SAME method
//     index.ts wires to every close path — its production wiring for the `/new` path specifically is
//     already covered end-to-end by companion-reset-clears-grant.mjs)
//   - `pendingProposalCountForSession` is EXACTLY ZERO right after the close, independent of any token —
//     this is the assertion that fails if a payload map (like `pendingSpawns` before this follow-up) is
//     missed
//   - the CAPTURED pre-close tokens also no longer commit anything (behavioral confirmation of the same
//     fact, from the outside)
//   - the capability itself is not broken — a FRESH propose→confirm after the close still works normally
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport, driven with FAKE `pty`/`companion`/`sessions` (mirrors companion-board-write.mjs/
// companion-decision-resolve.mjs/companion-session-spawn.mjs's own harnesses). NO network, NO real
// claude, NO daemon.
// Run: 1) build (turbo builds shared first), 2) node test/companion-close-clears-proposals.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-close-clears-proposals-${Date.now()}-${process.pid}`);
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
const { pendingProposalCountForSession } = await import("../dist/companion/capabilities.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-close-clears-proposals-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const DEFAULT_ROUTE = { channel: "in-app", chatId: "cockpit" };

function makeFakePty(initialOwnerText) {
  let ownerText = initialOwnerText ?? null;
  return {
    setOwnerText(t) { ownerText = t; },
    getActiveTurnOwnerText() { return ownerText; },
    getActiveTurnOrigin() { return DEFAULT_ROUTE; },
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
// A FAKE `sessions` (SessionService) — only `spawnSessionAsPlatform` is ever touched by session_spawn's
// wiring (mcp/orchestration.ts). Records every call so a test can assert whether it was reached.
function makeFakeSessions() {
  const calls = [];
  return {
    calls,
    spawnSessionAsPlatform(projectId, agentId, role) {
      calls.push({ projectId, agentId, role });
      return { id: `spawned-${calls.length}`, projectId, agentId, role, engineSessionId: null };
    },
  };
}
function extractToken(deliveredText) {
  const m = /Reply CONFIRM (\S+) to proceed\.$/.exec(deliveredText);
  if (!m) throw new Error(`could not extract a confirm token from: ${deliveredText}`);
  return m[1];
}

const now = new Date().toISOString();

try {
  const db = new Db(path.join(tmpHome, `${randomUUID()}.db`));
  const proj = "proj-close-clears";
  db.insertProject({ id: proj, name: "Close clears proposals", repoPath: proj, vaultPath: proj, config: {}, createdAt: now, archivedAt: null });
  const companionSess = "companion-close-clears";
  const agentId = "a-close-clears";
  db.insertAgent({ id: agentId, projectId: proj, name: "assistant", startupPrompt: "", position: 0 });
  db.insertSession({
    id: companionSess, projectId: proj, agentId, engineSessionId: `eng-${companionSess}`, title: null, cwd: proj,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
  });
  const askerSess = "asker-close-clears";
  db.insertAgent({ id: "a-asker-close-clears", projectId: proj, name: "manager", startupPrompt: "", position: 0 });
  db.insertSession({
    id: askerSess, projectId: proj, agentId: "a-asker-close-clears", engineSessionId: `eng-${askerSess}`, title: null, cwd: proj,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  db.insertQuestion({
    id: "q-close-clears", sessionId: askerSess, projectId: proj, title: "Pick an approach", body: "which one?",
    options: ["approve", "reject"], recommendation: null, state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  });
  db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
  db.upsertCompanionCapabilityGrant({
    sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act",
    config: { decisionClasses: ["general"] },
  });
  db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: proj, mode: "act" });

  const pty = makeFakePty("the owner said: file it and approve it");
  const companion = makeFakeCompanion();
  const sessions = makeFakeSessions();
  const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
  const client = await connect(orch.buildServer(companionSess, "assistant"));

  check("setup: no proposals pending yet", pendingProposalCountForSession(companionSess) === 0);

  // --- Propose on THREE distinct levers, leave all three unconfirmed — proves the pre-close state is
  // genuinely live on every payload map `clearPendingProposalsForSession` is responsible for. ---
  const boardProposed = await call(client, "board_create", { project: proj, title: "file it and approve it" });
  check("setup: board_create proposes fine", boardProposed.status === "proposed");
  const boardToken = extractToken(companion.delivered.at(-1).text);

  const decisionProposed = await call(client, "decision_resolve", { questionId: "q-close-clears", chosenOption: "approve" });
  check("setup: decision_resolve proposes fine", decisionProposed.status === "proposed");
  const decisionToken = extractToken(companion.delivered.at(-1).text);

  const spawnProposed = await call(client, "session_spawn", { project: proj, agentId, role: "plain" });
  check("setup: session_spawn proposes fine", spawnProposed.status === "proposed");
  const spawnToken = extractToken(companion.delivered.at(-1).text);

  check("setup: all three tokens are real and distinct", new Set([boardToken, decisionToken, spawnToken]).size === 3);

  // --- ISOLATING assertion #1 (the fix for the CR follow-up): the payload maps are genuinely non-empty
  // right now, checked DIRECTLY — independent of whether any token still works. ---
  check("ISOLATING: pendingProposalCountForSession is non-zero with 3 outstanding proposals (one per lever)", pendingProposalCountForSession(companionSess) === 3);

  // --- The method under test: called directly, exactly as every close path (recycle/unbind/re-pair,
  // /new via CompanionController → resetConversation) invokes it in production. ---
  orch.closeCompanionTrustWindow(companionSess);

  // --- ISOLATING assertion #2 (THE assertion that fails if a payload map is missed, e.g. the
  // `pendingSpawns` gap this follow-up closes): checked BEFORE any of the token-confirm attempts below,
  // so nothing here could accidentally re-populate a map and mask a regression. ---
  check("ISOLATING: pendingProposalCountForSession is EXACTLY ZERO immediately after closeCompanionTrustWindow", pendingProposalCountForSession(companionSess) === 0);

  // --- Behavioral confirmation, from the outside: none of the three captured pre-close tokens commit
  // anything anymore. This corroborates (but, per the CR follow-up's own doc above, does NOT substitute
  // for) the isolating assertion above — the commit path checks the token before the payload, so this
  // alone couldn't have caught a payload-map-only regression. ---
  pty.setOwnerText(`CONFIRM ${boardToken}`);
  const boardAfterClose = await call(client, "board_create", { project: proj, title: "file it and approve it" });
  check("behavioral: the pre-close board_create token no longer commits ('created') after closeCompanionTrustWindow", boardAfterClose.status !== "created");
  check("behavioral: no card was created from the orphaned token", db.listTasks(proj).length === 0);

  pty.setOwnerText(`CONFIRM ${decisionToken}`);
  const decisionAfterClose = await call(client, "decision_resolve", { questionId: "q-close-clears", chosenOption: "approve" });
  check("behavioral: the pre-close decision_resolve token no longer commits ('resolved') after closeCompanionTrustWindow", decisionAfterClose.status !== "resolved");
  check("behavioral: the question is still pending", db.getQuestion("q-close-clears").state === "pending");

  pty.setOwnerText(`CONFIRM ${spawnToken}`);
  const spawnAfterClose = await call(client, "session_spawn", { project: proj, agentId, role: "plain" });
  check("behavioral: the pre-close session_spawn token no longer commits ('spawned') after closeCompanionTrustWindow", spawnAfterClose.status !== "spawned");
  check("behavioral: spawnSessionAsPlatform was never called from the orphaned token", sessions.calls.length === 0);

  // --- The capability itself is not broken — a FRESH propose→confirm after the close still works ---
  pty.setOwnerText("the owner said: file a fresh one now");
  const freshProposed = await call(client, "board_create", { project: proj, title: "file a fresh one now" });
  check("after close: a FRESH board_create can still be proposed", freshProposed.status === "proposed");
  const freshToken = extractToken(companion.delivered.at(-1).text);
  pty.setOwnerText(`CONFIRM ${freshToken}`);
  const freshCreated = await call(client, "board_create", { project: proj, title: "file a fresh one now" });
  check("after close: the fresh proposal commits normally", freshCreated.status === "created");
  check("after close: exactly the one fresh card exists", db.listTasks(proj).length === 1 && db.listTasks(proj)[0].title === "file a fresh one now");

  await client.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — closeCompanionTrustWindow (the real close path every recycle/unbind/re-pair AND '/new'/'/reset' invokes) clears an outstanding Primitive-C proposal for the closing session on BOTH the shared OwnerConfirmStore AND every ACT lever's own payload map (board-reach's pendingBoardWrites, decisions-relay's pendingDecisionResolves, session-spawn's pendingSpawns — the exact map the pre-CR-follow-up version of this fix missed), proven via a DIRECT pendingProposalCountForSession count (3 pending → 0 immediately after close, independent of any token) as well as behaviorally (no pre-close token commits anything on any of the three levers afterward) — and the capability itself keeps working for a genuinely fresh proposal made afterward."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
