import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `board_relocate`, the CROSS-PROJECT move lever
// (card bfa25ea5, epic ccdb1e0c lever 5). Reuses `board_create`/`board_update`'s exact proven
// Primitive-C shape (card 7975c034) — see companion-board-write.mjs for that lever's own coverage — but
// board_relocate is ALWAYS Tier X (catastrophic): it never flows through a warm trust window, and it
// requires act-mode on BOTH the card's current project AND the destination project.
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport, driven with a FAKE `pty` (getActiveTurnOwnerText/getActiveTurnOrigin/enqueueStdin) and a
// FAKE `companion` (deliverReply) — the router only needs these, never a real claude process or chat
// adapter. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   - no grant / read-only grant ⇒ board_relocate absent (act-only + hasActGrant)
//   - Tier X: first call PROPOSES (no move happens), a matching confirm relocates exactly once; a
//     propose→confirm PAYLOAD mismatch (different toProject) is rejected; a token-MISMATCH (wrong/typo'd
//     confirm text) is retryable (leaves the pending standing, distinct from a payload mismatch)
//   - both-project-act: source not act-granted ⇒ rejected; destination not act-granted (ungranted or
//     read-only) ⇒ rejected; no-op (same project) ⇒ rejected
//   - backing op: after relocate, the card's projectId == destination; the landing column is VALID on
//     the destination board — BOTH the "same columnKey exists on dest → kept" case AND the "columnKey
//     absent on dest → falls back to dest's first/landing column" case; position is fresh
//   - fromProject drift: a card that moved out-of-band between propose and confirm rejects rather than
//     silently committing a different move than the one the owner confirmed
//   - safety guard: a card with a LIVE worker session bound to it refuses to relocate
//   - Primitive A (no owner text) ⇒ rejected; no route ⇒ rejected
//   - cross-kind shared-map attack: a real confirm token minted for board_create's proposal can never
//     commit board_relocate's write (or vice versa), even though they share one capability-slug/pending-
//     map namespace by design — mirrors companion-board-write.mjs's own create↔update attack tests
//   - additive: board-reach surface byte-identical when no act grant / no relocate call
// Run: 1) build (turbo builds shared first), 2) node test/companion-board-relocate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-board-relocate-${Date.now()}-${process.pid}`);
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
  const client = new Client({ name: "companion-board-relocate-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const DEFAULT_ROUTE = { channel: "in-app", chatId: "cockpit" };

// A FAKE pty — the router only ever calls getActiveTurnOwnerText/getActiveTurnOrigin/getActiveTurnSenderId/
// enqueueStdin on it (registerCompanionCapabilities), never spawns/isAlive/etc. `ownerText` is mutable so a
// test can simulate the owner's confirming reply landing as the NEXT turn's literal text.
function makeFakePty(initialOwnerText, opts = {}) {
  let ownerText = initialOwnerText ?? null;
  const route = opts.route === undefined ? DEFAULT_ROUTE : opts.route;
  const enqueued = [];
  return {
    setOwnerText(t) { ownerText = t; },
    getActiveTurnOwnerText() { return ownerText; },
    getActiveTurnOrigin() { return route; },
    getActiveTurnSenderId() { return null; },
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
function seedProject(db, id, name, config = {}) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config, createdAt: now, archivedAt: null });
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

// A destination board WITHOUT an "in_progress" column — used for the fallback-to-first-column case.
// role:"defaultLanding" makes "triage" the landing column columnKeyForRole resolves to.
const NO_IN_PROGRESS_COLUMNS = [
  { key: "triage", label: "Triage", role: "defaultLanding" },
  { key: "shipped", label: "Shipped", role: "terminal" },
];

try {
  // ============ no grant at all ⇒ board_relocate absent ============
  {
    const db = tmpDb();
    const proj = "proj-nogrant";
    seedProject(db, proj, "No grant");
    const companionSess = "companion-nogrant";
    seedSession(db, companionSess, proj, "assistant");
    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("no grant: board_relocate is not registered", !tools.includes("board_relocate"));
    db.close();
  }

  // ============ read-only grant ⇒ board_relocate absent (act-only + hasActGrant) ============
  {
    const db = tmpDb();
    const proj = "proj-readonly-only";
    seedProject(db, proj, "Read-only only");
    const companionSess = "companion-readonly-only";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "read" });
    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("read-only grant: board_relocate is not registered", !tools.includes("board_relocate"));
    check("read-only grant: board_create/board_update are not registered either", !tools.includes("board_create") && !tools.includes("board_update"));
    check("read-only grant: board_list/board_get still registered", tools.includes("board_list") && tools.includes("board_get"));
    db.close();
  }

  // ============ additive: act grant registers board_relocate alongside the existing board tools ============
  {
    const db = tmpDb();
    const proj = "proj-additive";
    seedProject(db, proj, "Additive");
    const companionSess = "companion-additive";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("act grant: board_relocate is registered", tools.includes("board_relocate"));
    check(
      "act grant: exactly board_create/board_get/board_list/board_relocate/board_update are the board tools",
      tools.filter((t) => t.startsWith("board_")).sort().join(",") === "board_create,board_get,board_list,board_relocate,board_update",
    );
    check("act grant: still no delete tool", !tools.includes("board_delete"));
    db.close();
  }

  // ============ both-project-act: source not act-granted (read-only) ⇒ rejected ============
  {
    const db = tmpDb();
    const projSrc = "proj-src-readonly";
    const projDest = "proj-dest-actmode";
    seedProject(db, projSrc, "Source read-only");
    seedProject(db, projDest, "Dest act-mode");
    const companionSess = "companion-src-readonly";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-src-ro", projSrc, { columnKey: "in_progress" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "read" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projDest, mode: "act" });
    const pty = makeFakePty("the owner said: move it to the other project");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_relocate", { taskId: "t-src-ro", toProject: projDest });
    check("source read-only: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("source read-only: card unchanged", db.getTask("t-src-ro").projectId === projSrc);
    check("source read-only: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ both-project-act: destination ungranted ⇒ rejected ============
  {
    const db = tmpDb();
    const projSrc = "proj-src-actmode";
    const projDest = "proj-dest-ungranted";
    seedProject(db, projSrc, "Source act-mode");
    seedProject(db, projDest, "Dest ungranted");
    const companionSess = "companion-dest-ungranted";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-dest-ug", projSrc, { columnKey: "in_progress" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "act" });
    const pty = makeFakePty("the owner said: move it to the other project");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_relocate", { taskId: "t-dest-ug", toProject: projDest });
    check("destination ungranted: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("destination ungranted: card unchanged", db.getTask("t-dest-ug").projectId === projSrc);
    check("destination ungranted: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ both-project-act: destination read-only (granted but not act) ⇒ rejected ============
  {
    const db = tmpDb();
    const projSrc = "proj-src-actmode2";
    const projDest = "proj-dest-readonly";
    seedProject(db, projSrc, "Source act-mode 2");
    seedProject(db, projDest, "Dest read-only");
    const companionSess = "companion-dest-readonly";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-dest-ro", projSrc, { columnKey: "in_progress" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projDest, mode: "read" });
    const pty = makeFakePty("the owner said: move it to the other project");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_relocate", { taskId: "t-dest-ro", toProject: projDest });
    check("destination read-only: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("destination read-only: card unchanged", db.getTask("t-dest-ro").projectId === projSrc);
    await client.close();
    db.close();
  }

  // ============ no-op: toProject === card's current project ⇒ rejected ============
  {
    const db = tmpDb();
    const proj = "proj-noop";
    seedProject(db, proj, "No-op");
    const companionSess = "companion-noop";
    seedSession(db, companionSess, proj, "assistant");
    seedTask(db, "t-noop", proj, {});
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: proj, mode: "act" });
    const pty = makeFakePty("the owner said: move it");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_relocate", { taskId: "t-noop", toProject: proj });
    check("no-op relocate: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("no-op relocate: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ proactive-turn reject (Primitive A null — no owner text) ============
  {
    const db = tmpDb();
    const projSrc = "proj-proactive-src";
    const projDest = "proj-proactive-dest";
    seedProject(db, projSrc, "Proactive source");
    seedProject(db, projDest, "Proactive dest");
    const companionSess = "companion-proactive";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-proactive", projSrc, {});
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projDest, mode: "act" });
    const pty = makeFakePty(null); // no owner text this turn — a proactive/heartbeat/reminder turn
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_relocate", { taskId: "t-proactive", toProject: projDest });
    check("proactive turn: rejected with an {error} (no owner text)", typeof res.error === "string" && res.status === undefined);
    check("proactive turn: card unchanged", db.getTask("t-proactive").projectId === projSrc);
    check("proactive turn: nothing delivered to the owner", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ no reply-to route ⇒ fail closed ============
  {
    const db = tmpDb();
    const projSrc = "proj-noroute-src";
    const projDest = "proj-noroute-dest";
    seedProject(db, projSrc, "No route source");
    seedProject(db, projDest, "No route dest");
    const companionSess = "companion-noroute";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-noroute", projSrc, {});
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projDest, mode: "act" });
    const pty = makeFakePty("the owner said: move it", { route: null });
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "board_relocate", { taskId: "t-noroute", toProject: projDest });
    check("no route: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("no route: card unchanged", db.getTask("t-noroute").projectId === projSrc);
    check("no route: NO delivery was even attempted", companion.delivered.length === 0);
    await client.close();
    db.close();
  }

  // ============ Tier X round-trip + backing op: SAME columnKey exists on dest → kept; fresh position ============
  {
    const db = tmpDb();
    const projSrc = "proj-tierx-src";
    const projDest = "proj-tierx-dest-same"; // default kanbanColumns include "in_progress" too
    seedProject(db, projSrc, "Tier X source");
    seedProject(db, projDest, "Tier X dest (same column)");
    const companionSess = "companion-tierx";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-tierx", projSrc, { title: "Misfiled card", columnKey: "in_progress", position: 42 });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projDest, mode: "act" });
    const pty = makeFakePty("the owner said: move that card to the other project");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // First call — Tier X ALWAYS proposes, never a low-friction direct commit (unlike board_create/update).
    const proposed = await call(client, "board_relocate", { taskId: "t-tierx", toProject: projDest });
    check("propose: returns a BARE status:'proposed', nothing else", proposed.status === "proposed" && Object.keys(proposed).length === 1);
    check("propose: NO promptText is returned to the companion", proposed.promptText === undefined);
    check("propose: NO token is returned to the companion", proposed.token === undefined);
    check("unconfirmed: card has not moved yet", db.getTask("t-tierx").projectId === projSrc);
    check("exactly one message was delivered to the owner via the outbound rail", companion.delivered.length === 1);
    check("the delivered text names the exact proposed move", companion.delivered[0].text.includes(projSrc) && companion.delivered[0].text.includes(projDest));

    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const relocated = await call(client, "board_relocate", { taskId: "t-tierx", toProject: projDest });
    check("confirm: returns status:'relocated'", relocated.status === "relocated");
    const moved = db.getTask("t-tierx");
    check("confirm: projectId reassigned to the destination", moved.projectId === projDest);
    check("confirm: same columnKey (\"in_progress\") kept — it exists on the destination board", moved.columnKey === "in_progress");
    check("confirm: position is fresh (not the original seeded 42)", moved.position !== 42);
    check("confirm: no SECOND owner delivery happened on commit", companion.delivered.length === 1);

    // A repeat call with the SAME (now-consumed) confirm text must NOT relocate again / re-move it.
    const third = await call(client, "board_relocate", { taskId: "t-tierx", toProject: projDest });
    check("exactly-once: a repeat call with the same confirm text does not relocate twice", third.status !== "relocated");

    await client.close();
    db.close();
  }

  // ============ backing op: columnKey absent on dest → falls back to dest's first/landing column ============
  {
    const db = tmpDb();
    const projSrc = "proj-fallback-src";
    const projDest = "proj-fallback-dest"; // custom board with NO "in_progress" column
    seedProject(db, projSrc, "Fallback source");
    seedProject(db, projDest, "Fallback dest", { kanbanColumns: NO_IN_PROGRESS_COLUMNS });
    const companionSess = "companion-fallback";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-fallback", projSrc, { title: "Misfiled card 2", columnKey: "in_progress" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projDest, mode: "act" });
    const pty = makeFakePty("the owner said: move that card to the other project");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "board_relocate", { taskId: "t-fallback", toProject: projDest });
    check("fallback propose: succeeds", proposed.status === "proposed");
    const token = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${token}`);
    const relocated = await call(client, "board_relocate", { taskId: "t-fallback", toProject: projDest });
    check("fallback confirm: returns status:'relocated'", relocated.status === "relocated");
    const moved = db.getTask("t-fallback");
    check("fallback: projectId reassigned to the destination", moved.projectId === projDest);
    check("fallback: card never orphaned onto the non-existent \"in_progress\" key", moved.columnKey !== "in_progress");
    check("fallback: card lands on the destination's landing column (\"triage\")", moved.columnKey === "triage");

    await client.close();
    db.close();
  }

  // ============ propose→confirm mismatch (different toProject) is rejected, no move ============
  {
    const db = tmpDb();
    const projSrc = "proj-mismatch-src";
    const projA = "proj-mismatch-a";
    const projB = "proj-mismatch-b";
    seedProject(db, projSrc, "Mismatch source");
    seedProject(db, projA, "Mismatch dest A");
    seedProject(db, projB, "Mismatch dest B");
    const companionSess = "companion-mismatch";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-mismatch", projSrc, { title: "Card" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projA, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projB, mode: "act" });
    const pty = makeFakePty("the owner said: move it to project A");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "board_relocate", { taskId: "t-mismatch", toProject: projA });
    check("mismatch setup: propose (to A) succeeds", proposed.status === "proposed");
    const token = extractToken(companion.delivered[0].text);

    // The real confirm token (minted for the pending A-relocate) is delivered, but the tool is called
    // with a DIFFERENT toProject (B) — Primitive C's own token check would pass; the payload-match
    // discriminator inside board_relocate must reject it.
    pty.setOwnerText(`CONFIRM ${token}`);
    const mismatched = await call(client, "board_relocate", { taskId: "t-mismatch", toProject: projB });
    check("mismatch: does NOT resolve to 'relocated'", mismatched.status !== "relocated");
    check("mismatch: reports a mismatch error, not a fresh propose", typeof mismatched.error === "string");
    check("mismatch: card was NOT moved to B", db.getTask("t-mismatch").projectId === projSrc);

    // Single-use: the token was consumed by the mismatched attempt above — a repeat with the same (now
    // stale) confirm text must not commit anything either.
    const repeat = await call(client, "board_relocate", { taskId: "t-mismatch", toProject: projA });
    check("mismatch: a repeat attempt with the consumed token does not commit either", repeat.status !== "relocated");
    check("mismatch: card still unchanged after the repeat", db.getTask("t-mismatch").projectId === projSrc);

    await client.close();
    db.close();
  }

  // ============ a failed outbound delivery ⇒ fail closed ============
  {
    const db = tmpDb();
    const projSrc = "proj-faildelivery-src";
    const projDest = "proj-faildelivery-dest";
    seedProject(db, projSrc, "Fail delivery source");
    seedProject(db, projDest, "Fail delivery dest");
    const companionSess = "companion-faildelivery-relocate";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-faildelivery-rel", projSrc, {});
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projDest, mode: "act" });
    const pty = makeFakePty("the owner said: move it");
    const companion = makeFakeCompanion(false); // simulate no-adapter / send-failed
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "board_relocate", { taskId: "t-faildelivery-rel", toProject: projDest });
    check("failed delivery: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("failed delivery: card unchanged", db.getTask("t-faildelivery-rel").projectId === projSrc);

    await client.close();
    db.close();
  }

  // ============ token-mismatch is RETRYABLE — the pending proposal stays standing, distinct from a
  // payload mismatch (which reports the same shape but is a fresh-token, wrong-payload rejection) ============
  {
    const db = tmpDb();
    const projSrc = "proj-tokenmismatch-src";
    const projDest = "proj-tokenmismatch-dest";
    seedProject(db, projSrc, "Token mismatch source");
    seedProject(db, projDest, "Token mismatch dest");
    const companionSess = "companion-tokenmismatch";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-tokenmismatch", projSrc, {});
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projDest, mode: "act" });
    const pty = makeFakePty("the owner said: move it");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "board_relocate", { taskId: "t-tokenmismatch", toProject: projDest });
    check("token-mismatch setup: propose succeeds", proposed.status === "proposed");

    // A companion-guessed (wrong) token — the attest layer itself rejects it (never even reaches this
    // lever's own payload-match discriminator).
    pty.setOwnerText("CONFIRM GUESSED");
    const wrongToken = await call(client, "board_relocate", { taskId: "t-tokenmismatch", toProject: projDest });
    check("token-mismatch: reports status:'confirm-mismatch' (distinct from a payload mismatch's bare {error})", wrongToken.status === "confirm-mismatch");
    check("token-mismatch: card not moved", db.getTask("t-tokenmismatch").projectId === projSrc);

    // The pending proposal is left STANDING (retryable) — the REAL token, replied afterward, still commits
    // the originally-proposed relocate.
    const realToken = extractToken(companion.delivered[0].text);
    pty.setOwnerText(`CONFIRM ${realToken}`);
    const relocated = await call(client, "board_relocate", { taskId: "t-tokenmismatch", toProject: projDest });
    check("token-mismatch: the REAL token (replied after a wrong guess) still commits the relocate", relocated.status === "relocated");
    check("token-mismatch: card now in the destination project", db.getTask("t-tokenmismatch").projectId === projDest);

    await client.close();
    db.close();
  }

  // ============ cross-kind shared-map attack: board_create and board_relocate share ONE capability-slug/
  // pending-map namespace ("board-reach") — a real confirm token minted for one kind's proposal must never
  // commit the OTHER kind's write, in either direction (mirrors companion-board-write.mjs's own create↔update
  // cross-tool attack tests, extended to the new relocate tool) ============
  {
    const db = tmpDb();
    const projA = "proj-crosskind-a";
    const projB = "proj-crosskind-b";
    seedProject(db, projA, "Cross-kind A");
    seedProject(db, projB, "Cross-kind B");
    const companionSess = "companion-crosskind";
    seedSession(db, companionSess, projA, "assistant");
    seedTask(db, "t-crosskind", projA, { title: "Existing card", priority: "p2" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projA, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projB, mode: "act" });
    const pty = makeFakePty("the owner said: create a card titled Cross-kind card");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    // Direction 1: propose board_create, confirm via board_relocate with the REAL (create) token.
    const proposedCreate = await call(client, "board_create", { project: projA, title: "Cross-kind card" });
    check("cross-kind (create→relocate): board_create propose succeeds", proposedCreate.status === "proposed");
    const createToken = extractToken(companion.delivered.at(-1).text);
    pty.setOwnerText(`CONFIRM ${createToken}`);
    const crossedRelocate = await call(client, "board_relocate", { taskId: "t-crosskind", toProject: projB });
    check("cross-kind (create→relocate): board_relocate with the create's token does NOT resolve to 'relocated'", crossedRelocate.status !== "relocated");
    check("cross-kind (create→relocate): reports a mismatch, not a fresh propose", typeof crossedRelocate.error === "string");
    check("cross-kind (create→relocate): no card was created", db.listTasks(projA).length === 1);
    check("cross-kind (create→relocate): the existing card was NOT relocated", db.getTask("t-crosskind").projectId === projA);
    // Single-use: the create's token was consumed by the crossed attempt — a repeat with the same
    // (now-consumed) confirm text must not commit anything either.
    const repeatCreate = await call(client, "board_create", { project: projA, title: "Cross-kind card" });
    check("cross-kind (create→relocate): a repeat crossed attempt does not commit either", repeatCreate.status !== "created");
    check("cross-kind (create→relocate): still no card created after the repeat", db.listTasks(projA).length === 1);

    // Direction 2 (reverse): propose board_relocate, confirm via board_create with the REAL (relocate) token.
    pty.setOwnerText("the owner said: move that card to B instead");
    const proposedRelocate = await call(client, "board_relocate", { taskId: "t-crosskind", toProject: projB });
    check("cross-kind (relocate→create): board_relocate propose succeeds", proposedRelocate.status === "proposed");
    const relocateToken = extractToken(companion.delivered.at(-1).text);
    pty.setOwnerText(`CONFIRM ${relocateToken}`);
    const crossedCreate = await call(client, "board_create", { project: projA, title: "Sneaky new card" });
    check("cross-kind (relocate→create): board_create with the relocate's token does NOT resolve to 'created'", crossedCreate.status !== "created");
    check("cross-kind (relocate→create): reports a mismatch, not a fresh propose", typeof crossedCreate.error === "string");
    check("cross-kind (relocate→create): no NEW card was created", db.listTasks(projA).length === 1);
    check("cross-kind (relocate→create): the existing card was NOT relocated", db.getTask("t-crosskind").projectId === projA);

    await client.close();
    db.close();
  }

  // ============ fromProject drift: the card moved (out-of-band) between propose and confirm — the confirm
  // must reject rather than silently committing a different move than the one the owner confirmed ============
  {
    const db = tmpDb();
    const projSrc = "proj-drift-src";
    const projDest = "proj-drift-dest";
    const projMoved = "proj-drift-moved"; // where the card drifts to BEFORE the confirm lands
    seedProject(db, projSrc, "Drift source");
    seedProject(db, projDest, "Drift dest");
    seedProject(db, projMoved, "Drift moved-to");
    const companionSess = "companion-drift";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-drift", projSrc, {});
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projDest, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projMoved, mode: "act" });
    const pty = makeFakePty("the owner said: move it to dest");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const proposed = await call(client, "board_relocate", { taskId: "t-drift", toProject: projDest });
    check("drift setup: propose succeeds", proposed.status === "proposed");
    const token = extractToken(companion.delivered[0].text);

    // Simulate an OUT-OF-BAND move landing between propose and confirm (e.g. a second relocate, or a
    // human drag-and-drop) — the card's CURRENT project is no longer what it was at propose time.
    db.relocateTask("t-drift", { projectId: projMoved, columnKey: "backlog", position: 999 });
    check("drift setup: card really did move out-of-band", db.getTask("t-drift").projectId === projMoved);

    pty.setOwnerText(`CONFIRM ${token}`);
    const drifted = await call(client, "board_relocate", { taskId: "t-drift", toProject: projDest });
    check("drift: confirm rejects — the card's current project no longer matches what was proposed against", drifted.status !== "relocated");
    check("drift: reports a mismatch, not a fresh propose", typeof drifted.error === "string");
    check("drift: the card stays wherever it drifted to, NOT force-moved to dest", db.getTask("t-drift").projectId === projMoved);

    await client.close();
    db.close();
  }

  // ============ safety guard: a card with a LIVE worker session bound to it refuses to relocate ============
  {
    const db = tmpDb();
    const projSrc = "proj-livework-src";
    const projDest = "proj-livework-dest";
    seedProject(db, projSrc, "Live worker source");
    seedProject(db, projDest, "Live worker dest");
    const companionSess = "companion-livework";
    seedSession(db, companionSess, projSrc, "assistant");
    seedTask(db, "t-livework", projSrc, {});
    // A LIVE worker session bound to this task (mirrors the task-delete guard's own live-session shape).
    db.insertAgent({ id: "a-worker-livework", projectId: projSrc, name: "worker", startupPrompt: "", position: 0 });
    db.insertSession({
      id: "worker-livework", projectId: projSrc, agentId: "a-worker-livework", engineSessionId: "eng-worker-livework",
      title: null, cwd: projSrc, processState: "live", resumability: "resumable", busy: false,
      createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: "t-livework",
    });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projSrc, mode: "act" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: projDest, mode: "act" });
    const pty = makeFakePty("the owner said: move it");
    const companion = makeFakeCompanion();
    const orch = new OrchestrationMcpRouter(db, {}, companion, pty);
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "board_relocate", { taskId: "t-livework", toProject: projDest });
    check("live worker: rejected with an {error}", typeof res.error === "string" && res.status === undefined);
    check("live worker: card unchanged", db.getTask("t-livework").projectId === projSrc);
    check("live worker: nothing delivered to the owner (rejected before Primitive C)", companion.delivered.length === 0);

    await client.close();
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — board_relocate is registered only under an act-mode grant (additive alongside board_create/board_update/board_get/board_list); it requires act-mode on BOTH the card's current project and the destination (source-read-only, dest-ungranted, dest-read-only, and a same-project no-op are all rejected); it is ALWAYS Tier X (no low-friction direct-commit path, unlike board_create/board_update — that dead branch fails SAFE if it were ever reached) — it never applies on the first (propose) call, delivers the confirm prompt to the OWNER directly, and applies EXACTLY ONCE via the new relocateProjectTask backing op once the owner's own next turn carries the confirm token; a payload mismatch (a different toProject) or a card that drifted to a different project between propose and confirm is rejected and never force-moves the card; a wrong/typo'd confirm token is retryable (leaves the pending standing) distinct from a payload mismatch; the backing op reassigns projectId, keeps the card's columnKey when it exists on the destination board or falls back to the destination's landing column otherwise (never orphaning it onto a non-existent key), and assigns a fresh position; a card with a live worker session bound to it refuses to relocate; a real confirm token minted for board_create's proposal can never commit board_relocate's write (or vice versa), even though they share one capability-slug/pending-map namespace by design; and a proactive (no-owner-text) turn, a missing reply-to route, and a failed outbound delivery are all rejected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
