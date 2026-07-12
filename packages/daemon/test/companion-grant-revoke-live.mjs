import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — CR fix (whole-surface sweep of epic ccdb1e0c): a
// revoked/downgraded grant must not keep acting on the LIVE companion until a manual respawn.
//
// INVESTIGATION FINDING (read before touching this file): the CR's own hypothesis was that
// `resolveCompanionGrant` runs ONCE at `buildServer`/spawn, so `ctx.scope` (and its `mayAct` re-check) is
// a stale SPAWN-TIME snapshot. That does NOT reproduce — `OrchestrationMcpRouter.buildServer` is rebuilt
// FRESH on every single MCP request (`handle()`'s own doc: "Stateless per request... Rebuilt each call
// from the role"), so `ctx.scope` is ALREADY resolved against the CURRENT db on every tool call, belt-and-
// suspenders re-check included. Test (A) below proves this directly: a revoked friction-free lever
// (session_steer, which never even touches the trust window) is rejected on the very NEXT MCP request,
// with NO code change needed for that path and NO respawn. What the pre-fix code was actually missing is
// narrower: the grant DELETE/PUT/POST REST handlers never called `closeCompanionTrustWindow`, so a WARM
// Companion Trust Window (Framework Card 0) — keyed on (session, route, sender), NOT per-capability — could
// outlive a grant change and let the FIRST Tier-A action after a downgrade-then-re-upgrade of the SAME
// capability skip its confirm. Test (B) proves that's what the added `closeCompanionTrustWindow` calls
// actually fix. Fully hermetic: a REAL Db + the REAL OrchestrationMcpRouter (used as BOTH the gateway's
// `orchMcp` dep AND directly via `buildServer` for MCP tool calls, so they share the SAME trust window
// instance) + the REAL gateway `buildServer` (app.inject) for the grant REST routes. NO network, NO real
// claude, NO daemon.
// Run: 1) build (turbo builds shared first), 2) node test/companion-grant-revoke-live.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-companion-grant-revoke-live-${Date.now()}-${process.pid}`);
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
const { buildServer } = await import("../dist/gateway/server.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-grant-revoke-live-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
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
    async deliverReply(sessionId, text) { delivered.push({ sessionId, text }); return { delivered: shouldDeliver }; },
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
const ptyStub = { liveStartedAt: () => null };

try {
  // ============ (A) DoD-literal: grant act → confirm actable → revoke → NOT actable live, no respawn,
  // including a FRICTION-FREE lever (session_steer never touches the trust window at all — proving this
  // is NOT merely the trust-window fix at work). ============
  {
    const db = tmpDb();
    const proj = "proj-a-revoke";
    seedProject(db, proj, "Revoke live A");
    const companionSess = "companion-revoke-a";
    seedSession(db, companionSess, proj, "assistant");
    const targetSess = "worker-revoke-a";
    seedSession(db, targetSess, proj, "worker");
    // projectId: null (the "own project" shortcut) — matches the REST DELETE route's own default when
    // no ?projectId= query param is given, so the DELETE below targets the SAME natural key this creates.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: null, mode: "act" });

    const pty = makeFakePty("the owner said: steer it");
    const companion = makeFakeCompanion();
    let redirectCalls = 0;
    const sessions = {
      redirectSessionAsCompanion: () => { redirectCalls++; return { delivered: true }; },
    };
    const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
    const app = await buildServer({
      db, pty: ptyStub, sessions: {}, mcp: {}, orchMcp: orch, platformMcp: {}, auditMcp: {},
      userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {},
    });

    // BEFORE revoke — a fresh buildServer() call (simulating the companion's next MCP request).
    {
      const client = await connect(orch.buildServer(companionSess, "assistant"));
      const res = await call(client, "session_steer", { target: targetSess, message: "stop and wait" });
      check("(A) before revoke: session_steer is actable", res.delivered === true);
      await client.close();
    }
    check("(A) before revoke: exactly one redirect call landed", redirectCalls === 1);

    // Revoke via the REAL REST route (proves the actual production code path, not a bare db mutation).
    const del = await app.inject({ method: "DELETE", url: `/api/companion/${companionSess}/grants?capability=session-steer` });
    check("(A) DELETE grant: 200", del.statusCode === 200);

    // AFTER revoke — a FRESH buildServer() call, exactly like the companion's next MCP request; no respawn.
    {
      const tools = await listOf(orch.buildServer(companionSess, "assistant"));
      check("(A) after revoke: session_steer is no longer even registered (live, no respawn)", !tools.includes("session_steer"));
    }
    {
      const client = await connect(orch.buildServer(companionSess, "assistant"));
      let threw = false;
      try {
        await call(client, "session_steer", { target: targetSess, message: "try again" });
      } catch {
        threw = true; // MCP "tool not found" surfaces as a protocol error, not a JSON {error} payload
      }
      check("(A) after revoke: calling session_steer now fails (tool not found)", threw === true);
      await client.close();
    }
    check("(A) after revoke: NO additional redirect call happened", redirectCalls === 1);

    await app.close();
    db.close();
  }

  // ============ (B) the CONCRETE gap closeCompanionTrustWindow fixes: a Tier-A capability's warm window
  // must not survive a downgrade-then-re-upgrade of that SAME capability — otherwise the first act after
  // re-granting skips its confirm even though the owner's grant WRITE (the downgrade) was itself a fresh
  // assertion of reduced trust. ============
  {
    const db = tmpDb();
    const proj = "proj-b-window";
    seedProject(db, proj, "Revoke live B");
    const companionSess = "companion-revoke-b";
    seedSession(db, companionSess, proj, "assistant");
    const asker = "asker-revoke-b";
    seedSession(db, asker, proj, "manager");
    seedQuestion(db, "q1", asker, proj, { title: "Pick a color", body: "red or blue?" });
    seedQuestion(db, "q2", asker, proj, { title: "Pick a size", body: "small or large?" });
    // projectId: null (the "own project" shortcut) — matches the REST PUT routes' own default below.
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "decisions-relay", projectId: null, mode: "act",
      config: { decisionClasses: ["general"] },
    });

    const pty = makeFakePty("the owner said: go with option one");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const app = await buildServer({
      db, pty: ptyStub, sessions: {}, mcp: {}, orchMcp: orch, platformMcp: {}, auditMcp: {},
      userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {},
    });

    // Cold window: q1 needs a full propose→confirm round trip, which ARMS the window (Tier A, general).
    {
      const client = await connect(orch.buildServer(companionSess, "assistant"));
      const proposed = await call(client, "decision_resolve", { questionId: "q1", chosenOption: "approve" });
      check("(B) q1 propose (cold window)", proposed.status === "proposed");
      const token = extractToken(companion.delivered.at(-1).text);
      pty.setOwnerText(`CONFIRM ${token}`);
      const resolved = await call(client, "decision_resolve", { questionId: "q1", chosenOption: "approve" });
      check("(B) q1 confirm resolves + arms the window", resolved.status === "resolved");
      pty.setOwnerText("the owner said: go with option one");
      await client.close();
    }
    check("(B) window is warm after q1's confirm", orch.trustWindow.isWarm({ sessionId: companionSess, route: DEFAULT_ROUTE, senderId: null }) === true);

    // Owner downgrades decisions-relay to read, then immediately re-upgrades it back to act (e.g. toggling
    // it while adjusting the decisionClasses allowlist) — both via the REAL REST routes.
    const down = await app.inject({ method: "PUT", url: `/api/companion/${companionSess}/grants`, payload: { capability: "decisions-relay", mode: "read" } });
    check("(B) PUT downgrade to read: 200", down.statusCode === 200);
    const up = await app.inject({
      method: "PUT", url: `/api/companion/${companionSess}/grants`,
      payload: { capability: "decisions-relay", mode: "act", config: { decisionClasses: ["general"] } },
    });
    check("(B) PUT re-upgrade to act: 200", up.statusCode === 200);

    check("(B) the trust window is COLD after the downgrade+re-upgrade (closeCompanionTrustWindow fired)",
      orch.trustWindow.isWarm({ sessionId: companionSess, route: DEFAULT_ROUTE, senderId: null }) === false);

    // q2 (also "general"/Tier A) must now need a FRESH propose→confirm round trip — NOT the direct-commit
    // low-friction path a still-warm window would have allowed.
    {
      const client = await connect(orch.buildServer(companionSess, "assistant"));
      const proposed = await call(client, "decision_resolve", { questionId: "q2", chosenOption: "approve" });
      check("(B) q2 after re-upgrade: proposes again (does NOT skip confirm on a stale-armed window)", proposed.status === "proposed");
      check("(B) q2 is still pending (no low-friction direct commit happened)", db.getQuestion("q2").state === "pending");
      await client.close();
    }

    await app.close();
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — (A) a revoked capability grant is enforced LIVE on the very next MCP request, no respawn, for a friction-free lever (session_steer) that never touches the trust window at all — proving the daemon's stateless-per-request MCP architecture already re-resolves grants live; and (B) a Tier-A capability's warm Companion Trust Window does NOT survive a downgrade-then-re-upgrade of that SAME capability via the grant REST routes — closeCompanionTrustWindow (this CR fix) correctly closes it, so the first act after re-granting requires a fresh owner confirm rather than silently riding a stale-armed window."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
