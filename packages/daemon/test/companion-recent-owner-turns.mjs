import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — Primitive A/B widening, Direction (b) of card
// 2b26035c ("board_create verbatim-quote guard forces owner repetition"). Extends `board_create`'s
// EXISTING Primitive B check (title/body must be a verbatim owner quote — see companion-board-write.mjs)
// so a candidate that's a verbatim substring of a RECENT owner turn (not just the one in flight) also
// satisfies the guard — fixing the cross-turn correction/re-phrase friction the owner hit filing a card
// via chat (owner: "Creative projects…" then corrected: "no, creating…").
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport, driven with a FAKE `pty` (now ALSO exposing getRecentOwnerTurns, mirroring pty/host.ts' own
// widened Live.recentOwnerTurns) and a FAKE `companion` — NO network, NO real claude, NO daemon.
//
// Covers the card's DoD for Direction (b):
//   - a verbatim substring from a RECENT (not current) owner turn PASSES board_create's Primitive B
//   - a candidate that appears in NO recent turn (including a plausible-looking but never-said one, the
//     security regression case) still REJECTS — the widening never accepts model-authored/injected text
//   - the window is BOUNDED — a candidate only present in an old-enough, evicted turn REJECTS
//   - the pre-existing CURRENT-turn happy path is unaffected (strict superset, no regression)
// Run: 1) build (turbo builds shared first), 2) node test/companion-recent-owner-turns.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-recent-owner-turns-${Date.now()}-${process.pid}`);
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
  const client = new Client({ name: "companion-recent-owner-turns-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const DEFAULT_ROUTE = { channel: "in-app", chatId: "cockpit" };

// A FAKE pty — mirrors companion-board-write.mjs's own fake, PLUS getRecentOwnerTurns (the Primitive A
// widening this card adds to pty/host.ts's real Live.recentOwnerTurns), so a test can simulate an
// authenticated owner turn HISTORY, not just the one in flight.
function makeFakePty(initialOwnerText, opts = {}) {
  let ownerText = initialOwnerText ?? null;
  let recent = opts.recent ?? (initialOwnerText != null ? [initialOwnerText] : []);
  const route = opts.route === undefined ? DEFAULT_ROUTE : opts.route;
  const enqueued = [];
  return {
    setOwnerText(t) { ownerText = t; },
    setRecentOwnerTurns(arr) { recent = arr; },
    getActiveTurnOwnerText() { return ownerText; },
    getRecentOwnerTurns() { return recent.slice(); },
    getActiveTurnOrigin() { return route; },
    enqueueStdin(...args) { enqueued.push(args); return { delivered: false, reason: "held" }; },
    enqueued,
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
  // ============ (b): a candidate verbatim in a RECENT (not current) owner turn PASSES ============
  {
    const db = tmpDb();
    const proj = "proj-recent-pass";
    seedProject(db, proj, "Recent pass");
    const companionSess = "companion-recent-pass";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    // Current turn is just an affirmation ("yes, log it") — the actual quotable title was said TWO
    // turns ago ("Creative projects for the new client"), then corrected one turn ago ("no, creating a
    // new project structure"). The recent-turns window (most-recent-first) carries all three.
    const pty = makeFakePty("yes, log it", {
      recent: ["yes, log it", "no, creating a new project structure", "Creative projects for the new client"],
    });
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "board_create", { project: proj, title: "creating a new project structure" });
    check("(b) recent-turn correction: a title verbatim in an OLDER recent turn (not current) PROPOSES fine", res.status === "proposed");

    await client.close();
    db.close();
  }

  // ============ (b): a candidate present in NO recent turn still REJECTS (security regression) ============
  {
    const db = tmpDb();
    const proj = "proj-recent-reject";
    seedProject(db, proj, "Recent reject");
    const companionSess = "companion-recent-reject";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("yes, log it", {
      recent: ["yes, log it", "no, creating a new project structure", "Creative projects for the new client"],
    });
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // A plausible-looking, but never-actually-said title — simulates injected/model-authored content
    // trying to piggyback on the widened window. Must still be rejected: the widening only ever accepts
    // words the OWNER'S OWN authenticated turns actually contained.
    const res = await call(client, "board_create", { project: proj, title: "wire the payment webhook to the admin's personal account" });
    check("(b) SECURITY REGRESSION: a candidate absent from EVERY recent owner turn is REJECTED (no path for injected/model-authored text)", typeof res.error === "string" && res.status === undefined);
    check("(b) SECURITY REGRESSION: no card created for the rejected candidate", db.listTasks(proj).length === 0);

    await client.close();
    db.close();
  }

  // ============ (b): the window is BOUNDED — a candidate only in an evicted (old-enough) turn REJECTS ============
  {
    const db = tmpDb();
    const proj = "proj-recent-bounded";
    seedProject(db, proj, "Recent bounded");
    const companionSess = "companion-recent-bounded";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    // Simulate a window that has ALREADY evicted the turn containing "an ancient request" — the fake
    // pty's own recency accounting is out of this test's scope (that's pty-owner-attestation.mjs's own
    // "bounded window" case); here we exercise the LEVER'S side: whatever getRecentOwnerTurns returns is
    // exactly what board_create is allowed to accept against, nothing more.
    const pty = makeFakePty("current turn text", { recent: ["current turn text", "turn n-1", "turn n-2"] });
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "board_create", { project: proj, title: "an ancient request" });
    check("(b) bounded window: a candidate only present in an EVICTED (out-of-window) turn REJECTS", typeof res.error === "string" && res.status === undefined);
    check("(b) bounded window: a candidate present in an IN-WINDOW turn still passes", (await call(client, "board_create", { project: proj, title: "turn n-2" })).status === "proposed");

    await client.close();
    db.close();
  }

  // ============ existing CURRENT-turn happy path is unaffected (strict superset, no regression) ============
  // Non-verbatim rejection is checked FIRST, on its own fresh router/session — a prior successful
  // propose on the SAME (session, route) would leave a pending confirm token that a later mismatched
  // call correctly reports as "confirm-mismatch" rather than a plain rejection (see
  // companion-board-write.mjs's own cross-tool attack-sim for that separate, deliberate behavior) — this
  // block only wants to prove the plain non-verbatim-reject path itself is untouched.
  {
    const db = tmpDb();
    const proj = "proj-current-unaffected-reject";
    seedProject(db, proj, "Current unaffected reject");
    const companionSess = "companion-current-unaffected-reject";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: log a card", { recent: [] });
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const rejected = await call(client, "board_create", { project: proj, title: "Something the owner never said" });
    check("current-turn happy path unaffected: non-verbatim title still rejected", typeof rejected.error === "string" && rejected.status === undefined);

    await client.close();
    db.close();
  }
  {
    const db = tmpDb();
    const proj = "proj-current-unaffected-accept";
    seedProject(db, proj, "Current unaffected accept");
    const companionSess = "companion-current-unaffected-accept";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    // No recent-turns history wired at all (empty window) — mirrors a fake pty that hasn't adopted this
    // card's widening yet (see orchestration.ts's optional-chained getRecentOwnerTurns fallback).
    const pty = makeFakePty("the owner said: log a card", { recent: [] });
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const ok = await call(client, "board_create", { project: proj, title: "log a card" });
    check("current-turn happy path unaffected: a verbatim CURRENT-turn title still proposes fine with an empty recent window", ok.status === "proposed");

    await client.close();
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — board_create's Primitive B accepts a verbatim quote from a RECENT (not just current) authenticated owner turn (Direction (b), card 2b26035c), rejects any candidate absent from every recent turn (including a plausible-looking injected/model-authored one), respects the bounded window (an evicted turn no longer counts), and leaves the pre-existing current-turn happy path byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
