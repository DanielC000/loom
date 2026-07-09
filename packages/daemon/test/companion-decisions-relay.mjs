import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `decisions-relay`'s READ half (a `decisions_list`
// tool reporting PENDING decision-inbox questions across the companion's granted projects). Mirrors
// companion-capability-grants.mjs's session-status coverage shape. READ HALF ONLY — the ACT half
// (decision_resolve, card a8ddd6d2) has its own dedicated coverage in companion-decision-resolve.mjs;
// this file only proves decision_resolve's REGISTRATION-gating (present under act, absent under read).
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory MCP
// transport. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   (a) grant present ⇒ decisions_list is registered + returns ONLY the granted project's pending
//       decisions (a pending question on an ungranted project is excluded).
//   (b) a `project` selector naming an ungranted project is rejected with {error}.
//   (c) no grant ⇒ decisions_list is NOT registered (inert + invisible; byte-identical tool surface).
//   (d) a grant row on a non-assistant-role session registers nothing (role gate).
//   (e) a mode:'read' grant never registers decision_resolve (byte-identical read-only surface); a
//       mode:'act' grant DOES register it (card a8ddd6d2 — the ACT half's own guards are tested
//       separately in companion-decision-resolve.mjs).
// Run: 1) build (turbo builds shared first), 2) node test/companion-decisions-relay.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-decisions-relay-${Date.now()}-${process.pid}`);
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
  const client = new Client({ name: "companion-decisions-relay-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
function seedProject(db, id, name) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role, opts = {}) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: opts.title ?? null, cwd: projectId,
    processState: opts.processState ?? "live", resumability: "resumable", busy: opts.busy ?? false,
    createdAt: now, lastActivity: now, lastError: null, role, taskId: opts.taskId ?? null,
  });
}
function seedQuestion(db, id, sessionId, projectId, opts = {}) {
  db.insertQuestion({
    id, sessionId, projectId, title: opts.title ?? `Question ${id}`, body: opts.body ?? "body text",
    options: opts.options ?? null, recommendation: opts.recommendation ?? null,
    state: opts.state ?? "pending", chosenOption: null, note: null,
    createdAt: opts.createdAt ?? now, answeredAt: null, consumedAt: null,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  // ============ (a)+(b) grant scoping: decisions_list returns ONLY the granted project's decisions ============
  {
    const db = tmpDb();
    const projA = "proj-a", projB = "proj-b";
    seedProject(db, projA, "A");
    seedProject(db, projB, "B");
    const companionSess = "companion-decisions";
    seedSession(db, companionSess, projA, "assistant");
    const askerA = "asker-a";
    seedSession(db, askerA, projA, "manager");
    const askerB = "asker-b";
    seedSession(db, askerB, projB, "manager");

    seedQuestion(db, "q-a", askerA, projA, { title: "Pick approach for A" });
    seedQuestion(db, "q-b", askerB, projB, { title: "Pick approach for B" });

    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "decisions-relay", projectId: projA, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(a) the GRANTED companion HAS decisions_list", tools.includes("decisions_list"));

    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const all = await call(client, "decisions_list", {});
    check("(a) decisions_list returns the granted project's pending question", all.decisions.some((d) => d.questionId === "q-a"));
    check("(a) decisions_list excludes the UNGRANTED project's question", !all.decisions.some((d) => d.questionId === "q-b"));
    const row = all.decisions.find((d) => d.questionId === "q-a");
    check("(a) carries title/body/projectId for the pending question", row?.title === "Pick approach for A" && row?.projectId === projA);

    const scoped = await call(client, "decisions_list", { project: projA });
    check("decisions_list: an explicit `project` selector matching the grant is honored", scoped.decisions.some((d) => d.questionId === "q-a"));

    const rejected = await call(client, "decisions_list", { project: projB });
    check("(b) a `project` selector OUTSIDE scope is REJECTED with an {error} (can never widen scope)",
      typeof rejected.error === "string" && rejected.decisions === undefined);

    await client.close();
    db.close();
  }

  // ============ pending-only: an already-consumed question is excluded ============
  {
    const db = tmpDb();
    const proj = "proj-consumed";
    seedProject(db, proj, "Consumed");
    const companionSess = "companion-consumed";
    seedSession(db, companionSess, proj, "assistant");
    const asker = "asker-consumed";
    seedSession(db, asker, proj, "manager");
    seedQuestion(db, "q-pending", asker, proj, { title: "Still pending" });
    seedQuestion(db, "q-consumed", asker, proj, { title: "Already consumed", state: "consumed" });

    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "decisions-relay", projectId: proj });

    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const all = await call(client, "decisions_list", {});
    check("decisions_list includes a pending question", all.decisions.some((d) => d.questionId === "q-pending"));
    check("decisions_list excludes an already-consumed question", !all.decisions.some((d) => d.questionId === "q-consumed"));
    await client.close();
    db.close();
  }

  // ============ (c) no grant ⇒ decisions_list is NOT registered (inert + invisible) ============
  {
    const db = tmpDb();
    const proj = "proj-no-grant";
    seedProject(db, proj, "No grant");
    const companionSess = "companion-no-grant";
    seedSession(db, companionSess, proj, "assistant");

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(c) an ungranted companion does NOT have decisions_list", !tools.includes("decisions_list"));
    check("(c) no grant at all ⇒ decision_resolve is not registered either", !tools.includes("decision_resolve"));
    db.close();
  }

  // ============ (d) registerCompanionCapabilities is role-gated to "assistant" ============
  {
    const db = tmpDb();
    const proj = "proj-role-gate";
    seedProject(db, proj, "Role gate");
    // A grant row on a NON-assistant session id — should never happen via the REST writer (it requires
    // role==="assistant"), but seed it directly to prove the belt-and-suspenders role gate holds even then.
    const mgrSess = "mgr-with-stray-grant";
    seedSession(db, mgrSess, proj, "manager");
    db.upsertCompanionCapabilityGrant({ sessionId: mgrSess, capability: "decisions-relay", projectId: null });

    const orch = new OrchestrationMcpRouter(db, {});
    const mgrTools = await listOf(orch.buildServer(mgrSess, "manager"));
    check("(d) a manager session with a STRAY grant row still does NOT get decisions_list (role gate)", !mgrTools.includes("decisions_list"));
    db.close();
  }

  // ============ (e) decision_resolve is registered ONLY under a mode:'act' grant ============
  {
    const db = tmpDb();
    const proj = "proj-act-mode";
    seedProject(db, proj, "Act mode");
    const companionSess = "companion-act-mode";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "act" });

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(e) decisions_list is still registered under an 'act' grant", tools.includes("decisions_list"));
    check("(e) decision_resolve IS registered under a mode:'act' grant (card a8ddd6d2)", tools.includes("decision_resolve"));
    db.close();
  }

  // ============ (e) a mode:'read' grant NEVER registers decision_resolve (byte-identical read surface) ============
  {
    const db = tmpDb();
    const proj = "proj-read-mode";
    seedProject(db, proj, "Read mode");
    const companionSess = "companion-read-mode";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "decisions-relay", projectId: proj, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(e) decisions_list is registered under a 'read' grant", tools.includes("decisions_list"));
    check("(e) decision_resolve is NOT registered under a mode:'read' grant (byte-identical to before card a8ddd6d2)", !tools.includes("decision_resolve"));
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — decisions_list registers ONLY behind a decisions-relay grant and reports ONLY that grant's PENDING (pending+answered, never consumed) decisions scoped to the granted project(s); a project selector can never widen scope; an ungranted/non-assistant session gets nothing; decision_resolve is registered ONLY under a mode:'act' grant and stays absent under 'read' (byte-identical)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
