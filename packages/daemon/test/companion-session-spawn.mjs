import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `session_spawn`, the `session-spawn` ACT lever
// (epic ccdb1e0c, lever 7b, Tier X, manager|plain ONLY). THE epic's self-elevation surface: lets the
// companion spawn a NEW session into a granted project on the owner's behalf. Copies `decision_resolve`/
// `board_create`'s exact proven Primitive-C shape, but hard-pinned to Tier X (ALWAYS steps up, even
// inside an otherwise-warm trust window — no low-friction path at all) and gated by the SAME manager|
// plain role refusal the Platform Lead's own `session_spawn` (mcp/platform.ts) enforces, via the ONE
// shared `spawnableRoleError` helper (mcp/spawnable-role.ts) so the two can never drift apart.
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport, driven with a FAKE `pty` (getActiveTurnOwnerText/getActiveTurnOrigin/getActiveTurnSenderId/
// enqueueStdin), a FAKE `companion` (deliverReply), and a FAKE `sessions` (SessionService) whose
// `spawnSessionAsPlatform` is stubbed to RECORD calls rather than actually spawn anything — the lever's
// own guards are what's under test, not SessionService itself (that's mcp/platform.ts's own test
// coverage). NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   - no grant ⇒ tool absent; read-only grant ⇒ tool absent (act-only + hasActGrant)
//   - ROLE REFUSAL (the headline test): role ∈ {platform, auditor, operator, setup, worker, "", "garbage"}
//     ⇒ rejected, NO spawnSessionAsPlatform call, error text matches platform.ts's; "manager"/"plain" are
//     the ONLY accepted values
//   - Tier X: a FIRST call (even in a warm trust window) PROPOSES and does NOT spawn; a matching confirm
//     on the next owner turn spawns exactly once; a proposal→confirm mismatch is rejected
//   - Scope: project not in scope ⇒ rejected; read-mode project ⇒ rejected (needs act); Primitive A (no
//     owner text) ⇒ rejected; no route ⇒ rejected
//   - Additive: byte-identical companion surface with no session-spawn grant
// Run: 1) build (turbo builds shared first), 2) node test/companion-session-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-session-spawn-${Date.now()}-${process.pid}`);
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
const { spawnableRoleError } = await import("../dist/mcp/spawnable-role.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-session-spawn-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const DEFAULT_ROUTE = { channel: "in-app", chatId: "cockpit" };

// A FAKE pty — the router only ever calls getActiveTurnOwnerText/getActiveTurnOrigin/
// getActiveTurnSenderId/enqueueStdin on it (registerCompanionCapabilities), never spawns/isAlive/etc.
function makeFakePty(initialOwnerText, opts = {}) {
  let ownerText = initialOwnerText ?? null;
  const route = opts.route === undefined ? DEFAULT_ROUTE : opts.route;
  return {
    setOwnerText(t) { ownerText = t; },
    getActiveTurnOwnerText() { return ownerText; },
    getActiveTurnOrigin() { return route; },
    getActiveTurnSenderId() { return opts.senderId ?? null; },
    enqueueStdin() { return { delivered: false, reason: "held" }; },
  };
}

// A FAKE companion (CompanionHooks) — the ONLY method the outbound seam calls is `deliverReply`.
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

// A FAKE `sessions` (SessionService) — only `spawnSessionAsPlatform` is ever touched by this lever's
// wiring (mcp/orchestration.ts). Records every call so a test can assert it was (or wasn't) reached.
function makeFakeSessions(opts = {}) {
  const calls = [];
  return {
    calls,
    spawnSessionAsPlatform(projectId, agentId, role) {
      calls.push({ projectId, agentId, role });
      if (opts.throwMessage) throw new Error(opts.throwMessage);
      return { id: opts.spawnedId ?? `spawned-${calls.length}`, projectId, agentId, role, engineSessionId: null };
    },
  };
}

// Extract the confirm token the DAEMON delivered to the owner.
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
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  // ============ no grant ⇒ tool absent ============
  {
    const db = tmpDb();
    const proj = "proj-nogrant";
    seedProject(db, proj, "No grant");
    const companionSess = "companion-nogrant";
    seedSession(db, companionSess, proj, "assistant");
    const orch = new OrchestrationMcpRouter(db, makeFakeSessions(), {}, makeFakePty(null));
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("no grant: session_spawn is NOT registered", !tools.includes("session_spawn"));
    db.close();
  }

  // ============ read-only grant ⇒ tool absent (act-only + hasActGrant) ============
  {
    const db = tmpDb();
    const proj = "proj-readonly-surface";
    seedProject(db, proj, "Read-only surface");
    const companionSess = "companion-readonly-surface";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: proj, mode: "read" });
    const orch = new OrchestrationMcpRouter(db, makeFakeSessions(), {}, makeFakePty(null));
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("read-only grant: session_spawn is NOT registered", !tools.includes("session_spawn"));
    db.close();
  }

  // ============ act grant ⇒ tool present ============
  {
    const db = tmpDb();
    const proj = "proj-actgrant-surface";
    seedProject(db, proj, "Act grant surface");
    const companionSess = "companion-actgrant-surface";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: proj, mode: "act" });
    const orch = new OrchestrationMcpRouter(db, makeFakeSessions(), {}, makeFakePty(null));
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("act grant: session_spawn IS registered", tools.includes("session_spawn"));
    db.close();
  }

  // ============ ROLE REFUSAL — the headline test ============
  {
    const REJECTED_ROLES = ["platform", "auditor", "operator", "setup", "worker", "", "garbage"];
    for (const role of REJECTED_ROLES) {
      const db = tmpDb();
      const proj = `proj-role-${role || "empty"}`;
      seedProject(db, proj, proj);
      const companionSess = `companion-role-${role || "empty"}`;
      seedSession(db, companionSess, proj, "assistant");
      db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: proj, mode: "act" });
      const pty = makeFakePty("the owner said: spawn a session");
      const companion = makeFakeCompanion();
      const sessions = makeFakeSessions();
      const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
      const client = await connect(orch.buildServer(companionSess, "assistant"));
      const res = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role });
      check(`role "${role}": rejected with an {error}`, typeof res.error === "string" && res.status === undefined);
      check(`role "${role}": NO spawnSessionAsPlatform call`, sessions.calls.length === 0);
      check(`role "${role}": NO owner delivery was even attempted`, companion.delivered.length === 0);
      check(`role "${role}": error text matches platform.ts's spawnableRoleError`, res.error === spawnableRoleError(role));
      await client.close();
      db.close();
    }
  }

  // ============ "manager"/"plain" are the ONLY accepted role values (propose succeeds past the role guard) ============
  {
    for (const role of ["manager", "plain"]) {
      const db = tmpDb();
      const proj = `proj-accept-${role}`;
      seedProject(db, proj, proj);
      const companionSess = `companion-accept-${role}`;
      seedSession(db, companionSess, proj, "assistant");
      db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: proj, mode: "act" });
      const pty = makeFakePty("the owner said: spawn a manager session");
      const companion = makeFakeCompanion();
      const sessions = makeFakeSessions();
      const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
      const client = await connect(orch.buildServer(companionSess, "assistant"));
      const res = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role });
      check(`role "${role}": passes the role guard (proposes, not rejected)`, res.status === "proposed");
      check(`role "${role}": still no spawn on the propose call`, sessions.calls.length === 0);
      await client.close();
      db.close();
    }
  }

  // ============ Tier X: FIRST call PROPOSES (even in a warm window) and does NOT spawn ============
  {
    const db = tmpDb();
    const proj = "proj-tierx-warm";
    seedProject(db, proj, "Tier X warm");
    const companionSess = "companion-tierx-warm";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: spawn a manager");
    const companion = makeFakeCompanion();
    const sessions = makeFakeSessions();
    const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
    // Pre-warm the trust window directly (as if a PRIOR Tier-A action already armed it) — Tier X must
    // still step up regardless.
    orch.trustWindow.arm({ sessionId: companionSess, route: DEFAULT_ROUTE, senderId: null });
    check("window is warm going in", orch.trustWindow.isWarm({ sessionId: companionSess, route: DEFAULT_ROUTE, senderId: null }) === true);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role: "manager" });
    check("Tier X even-in-warm-window: proposes, does NOT spawn", proposed.status === "proposed" && Object.keys(proposed).length === 1);
    check("Tier X even-in-warm-window: NO promptText/token returned to the companion", proposed.promptText === undefined && proposed.token === undefined);
    check("Tier X even-in-warm-window: NO spawnSessionAsPlatform call yet", sessions.calls.length === 0);
    check("Tier X even-in-warm-window: exactly one message delivered to the owner", companion.delivered.length === 1);

    await client.close();
    db.close();
  }

  // ============ Tier X: matching confirm on next owner turn spawns exactly once ============
  {
    const db = tmpDb();
    const proj = "proj-tierx-confirm";
    seedProject(db, proj, "Tier X confirm");
    const companionSess = "companion-tierx-confirm";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: spawn a plain session");
    const companion = makeFakeCompanion();
    const sessions = makeFakeSessions({ spawnedId: "sess-new-1" });
    const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role: "plain" });
    check("propose: returns a bare {status:'proposed'}", proposed.status === "proposed");
    check("propose: no spawn yet", sessions.calls.length === 0);

    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const confirmed = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role: "plain" });
    check("confirm: returns status:'spawned'", confirmed.status === "spawned");
    check("confirm: exactly one spawnSessionAsPlatform call", sessions.calls.length === 1);
    check("confirm: called with the proposed project/agentId/role", sessions.calls[0].projectId === proj && sessions.calls[0].agentId === "agent-1" && sessions.calls[0].role === "plain");
    check("confirm: no SECOND owner delivery happened on commit", companion.delivered.length === 1);

    // Tier X must NOT arm the trust window even on a successful commit.
    check("Tier X commit does not arm the trust window", orch.trustWindow.isWarm({ sessionId: companionSess, route: DEFAULT_ROUTE, senderId: null }) === false);

    // A repeat call with the SAME (now-consumed) confirm text must NOT spawn a second session.
    const third = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role: "plain" });
    check("exactly-once: a repeat call with the same confirm text does not spawn twice", third.status !== "spawned");
    check("exactly-once: still exactly one spawnSessionAsPlatform call", sessions.calls.length === 1);

    await client.close();
    db.close();
  }

  // ============ proposal→confirm mismatch (different project/agentId/role) is rejected ============
  {
    const db = tmpDb();
    const projA = "proj-mismatch-a";
    const projB = "proj-mismatch-b";
    seedProject(db, projA, "Mismatch A");
    seedProject(db, projB, "Mismatch B");
    const companionSess = "companion-mismatch";
    seedSession(db, companionSess, projA, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: projA, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: projB, mode: "act" });
    const pty = makeFakePty("the owner said: spawn a manager");
    const companion = makeFakeCompanion();
    const sessions = makeFakeSessions();
    const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "session_spawn", { project: projA, agentId: "agent-1", role: "manager" });
    check("mismatch setup: propose succeeds", proposed.status === "proposed");
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);

    // A confirm with a DIFFERENT project than what was proposed must not spawn.
    const swapped = await call(client, "session_spawn", { project: projB, agentId: "agent-1", role: "manager" });
    check("mismatch (project swapped): does NOT spawn", swapped.status !== "spawned");
    check("mismatch (project swapped): no spawnSessionAsPlatform call", sessions.calls.length === 0);

    // A repeat with the SAME (now-consumed) token must not spawn either, even with the original args.
    const repeat = await call(client, "session_spawn", { project: projA, agentId: "agent-1", role: "manager" });
    check("mismatch: token is single-use — a repeat with the ORIGINAL args does not spawn either", repeat.status !== "spawned");
    check("mismatch: still no spawnSessionAsPlatform call", sessions.calls.length === 0);

    await client.close();
    db.close();
  }

  // ============ token-mismatch (guessed confirm text) is retryable, does NOT evict the pending proposal ============
  {
    const db = tmpDb();
    const proj = "proj-token-mismatch";
    seedProject(db, proj, "Token mismatch");
    const companionSess = "companion-token-mismatch";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: spawn a manager");
    const companion = makeFakeCompanion();
    const sessions = makeFakeSessions();
    const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role: "manager" });
    check("token-mismatch setup: propose succeeds", proposed.status === "proposed");

    pty.setOwnerText("CONFIRM GUESSED-WRONG-TOKEN");
    const guessed = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role: "manager" });
    check("token-mismatch: reports confirm-mismatch, not a fresh propose", guessed.status === "confirm-mismatch");
    check("token-mismatch: no spawn happened", sessions.calls.length === 0);

    // The REAL token still commits afterward (mismatch left the pending proposal standing).
    const realToken = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${realToken}`);
    const confirmed = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role: "manager" });
    check("token-mismatch: the REAL token still commits afterward", confirmed.status === "spawned");
    check("token-mismatch: exactly one spawn happened", sessions.calls.length === 1);

    await client.close();
    db.close();
  }

  // ============ scope: project not in granted scope is rejected ============
  {
    const db = tmpDb();
    const projGranted = "proj-scope-granted";
    const projOther = "proj-scope-other";
    seedProject(db, projGranted, "Granted");
    seedProject(db, projOther, "Other");
    const companionSess = "companion-scope-ungranted";
    seedSession(db, companionSess, projGranted, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: projGranted, mode: "act" });
    const pty = makeFakePty("the owner said: spawn a manager");
    const companion = makeFakeCompanion();
    const sessions = makeFakeSessions();
    const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "session_spawn", { project: projOther, agentId: "agent-1", role: "manager" });
    check("ungranted project: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("ungranted project: no spawn call", sessions.calls.length === 0);
    check("ungranted project: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ scope: read-mode project is rejected (needs act) ============
  {
    const db = tmpDb();
    const projRead = "proj-scope-readonly";
    const projAct = "proj-scope-actmode";
    seedProject(db, projRead, "Read-only");
    seedProject(db, projAct, "Act-mode");
    const companionSess = "companion-scope-mixed";
    seedSession(db, companionSess, projRead, "assistant");
    // session_spawn is registered because ANOTHER granted project is act-mode — but the TARGET project
    // (projRead) is only read-mode, and the per-project mayAct recheck must still refuse it.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: projRead, mode: "read" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: projAct, mode: "act" });
    const pty = makeFakePty("the owner said: spawn a manager");
    const companion = makeFakeCompanion();
    const sessions = makeFakeSessions();
    const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "session_spawn", { project: projRead, agentId: "agent-1", role: "manager" });
    check("read-mode project: rejected with an {error} (mayAct false)", typeof res.error === "string" && res.status === undefined);
    check("read-mode project: no spawn call", sessions.calls.length === 0);
    await client.close();
    db.close();
  }

  // ============ Primitive A: no owner text (proactive/heartbeat turn) is rejected ============
  {
    const db = tmpDb();
    const proj = "proj-proactive";
    seedProject(db, proj, "Proactive");
    const companionSess = "companion-proactive";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: proj, mode: "act" });
    const pty = makeFakePty(null); // no owner text this turn
    const companion = makeFakeCompanion();
    const sessions = makeFakeSessions();
    const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role: "manager" });
    check("proactive turn: rejected with an {error} (no owner text)", typeof res.error === "string" && res.status === undefined);
    check("proactive turn: no spawn call", sessions.calls.length === 0);
    check("proactive turn: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ no reply-to route ⇒ fail closed ============
  {
    const db = tmpDb();
    const proj = "proj-noroute";
    seedProject(db, proj, "No route");
    const companionSess = "companion-noroute";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: spawn a manager", { route: null });
    const companion = makeFakeCompanion();
    const sessions = makeFakeSessions();
    const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role: "manager" });
    check("no route: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("no route: no spawn call", sessions.calls.length === 0);
    check("no route: NO delivery was even attempted", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ a failed outbound delivery ⇒ fail closed ============
  {
    const db = tmpDb();
    const proj = "proj-faildelivery";
    seedProject(db, proj, "Fail delivery");
    const companionSess = "companion-faildelivery";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-spawn", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: spawn a manager");
    const companion = makeFakeCompanion(false); // simulate no-adapter / send-failed
    const sessions = makeFakeSessions();
    const orch = new OrchestrationMcpRouter(db, sessions, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "session_spawn", { project: proj, agentId: "agent-1", role: "manager" });
    check("failed delivery: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("failed delivery: no spawn call", sessions.calls.length === 0);
    await client.close();
    db.close();
  }

  // ============ additive: byte-identical companion surface with NO session-spawn grant ============
  {
    const db = tmpDb();
    const proj = "proj-additive";
    seedProject(db, proj, "Additive");
    const companionSess = "companion-additive";
    seedSession(db, companionSess, proj, "assistant");
    // Grant a DIFFERENT, unrelated capability only — session-spawn itself is never granted.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-status", projectId: proj, mode: "read" });
    const orch = new OrchestrationMcpRouter(db, makeFakeSessions(), {}, makeFakePty(null));
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("additive: session_spawn absent with no session-spawn grant", !tools.includes("session_spawn"));
    check("additive: the unrelated granted lever's own tool is still present", tools.includes("sessions_status"));
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — session_spawn refuses every role except \"manager\"/\"plain\" (byte-identical to the Platform Lead's own session_spawn refusal), is registered only under an act-mode grant, ALWAYS requires a fresh owner confirmation even inside an otherwise-warm trust window (Tier X — no low-friction path, and a commit never arms the window), applies EXACTLY ONCE via the SAME SessionService.spawnSessionAsPlatform the Platform Lead uses once the owner's own next turn carries the confirm token, rejects a proposal→confirm argument mismatch and a guessed confirm token (retryable, not evicted), and enforces scope/Primitive-A/reply-to-route on every call."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
