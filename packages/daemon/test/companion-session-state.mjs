import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card F (db6f0606, epic ccdb1e0c lever 7a) — companion `sessions_status` gains an optional `state`
// input ("live" default | "exited" | "all") so the Companion can enumerate STOPPED sessions (to later
// resume one), mirroring the Lead's own list_all_sessions state filter (mcp/platform.ts ~L781).
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL OrchestrationMcpRouter over an in-memory
// MCP transport. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   (a) default (no `state`) ⇒ only live sessions — BYTE-IDENTICAL to pre-card behavior.
//   (b) state:"exited" ⇒ only exited/stopped sessions in granted scope.
//   (c) state:"all" ⇒ both live and exited sessions in granted scope.
//   (d) scope is still enforced regardless of `state` — an ungranted project's sessions never appear.
// Run: 1) build (turbo builds shared first), 2) node test/companion-session-state.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-session-state-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-session-state-test", version: "0" });
  await client.connect(clientT);
  return client;
}
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
    createdAt: now, lastActivity: opts.lastActivity ?? now, lastError: null, role, taskId: opts.taskId ?? null,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  const db = tmpDb();
  const projA = "proj-a", projB = "proj-b";
  seedProject(db, projA, "A");
  seedProject(db, projB, "B");
  const companionSess = "companion-state";
  seedSession(db, companionSess, projA, "assistant");

  const liveInA = "live-a";
  seedSession(db, liveInA, projA, "worker", { busy: true, taskId: "task-a" });
  const exitedInA = "exited-a";
  seedSession(db, exitedInA, projA, "worker", { processState: "exited" });
  const liveInB = "live-b";
  seedSession(db, liveInB, projB, "worker");
  const exitedInB = "exited-b";
  seedSession(db, exitedInB, projB, "worker", { processState: "exited" });

  // Grant session-status for projA only — projB stays ungranted for the scope-enforcement check.
  db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-status", projectId: projA });

  const orch = new OrchestrationMcpRouter(db, {});
  const client = await connect(orch.buildServer(companionSess, "assistant"));

  // (a) default (no `state`) ⇒ only live sessions in scope — byte-identical to pre-card behavior.
  // (The companion's own session is also live and in projA, so "live" scope = {companionSess, liveInA}.)
  const byDefault = await call(client, "sessions_status", {});
  check("(a) default: includes the live session in the granted project", byDefault.sessions.some((s) => s.sessionId === liveInA));
  check("(a) default: excludes the exited session in the granted project", !byDefault.sessions.some((s) => s.sessionId === exitedInA));
  check("(a) default: only the live in-scope sessions are returned", byDefault.sessions.length === 2);

  // Explicit state:"live" must match the default exactly.
  const explicitLive = await call(client, "sessions_status", { state: "live" });
  check("(a) state:\"live\" matches the default exactly", JSON.stringify(explicitLive) === JSON.stringify(byDefault));

  // (b) state:"exited" ⇒ only exited sessions in scope.
  const exited = await call(client, "sessions_status", { state: "exited" });
  check("(b) state:\"exited\": includes the exited session in the granted project", exited.sessions.some((s) => s.sessionId === exitedInA));
  check("(b) state:\"exited\": excludes the live session in the granted project", !exited.sessions.some((s) => s.sessionId === liveInA));
  check("(b) state:\"exited\": only the one exited in-scope session is returned", exited.sessions.length === 1);

  // (c) state:"all" ⇒ both live and exited sessions in scope.
  const all = await call(client, "sessions_status", { state: "all" });
  check("(c) state:\"all\": includes the live session in the granted project", all.sessions.some((s) => s.sessionId === liveInA));
  check("(c) state:\"all\": includes the exited session in the granted project", all.sessions.some((s) => s.sessionId === exitedInA));
  check("(c) state:\"all\": every in-scope session is returned", all.sessions.length === 3);

  // (d) scope is still enforced regardless of state — projB's sessions never appear, at any state.
  check("(d) default: excludes the ungranted project's live session", !byDefault.sessions.some((s) => s.sessionId === liveInB));
  check("(d) state:\"exited\": excludes the ungranted project's exited session", !exited.sessions.some((s) => s.sessionId === exitedInB));
  check("(d) state:\"all\": excludes BOTH of the ungranted project's sessions",
    !all.sessions.some((s) => s.sessionId === liveInB) && !all.sessions.some((s) => s.sessionId === exitedInB));

  // (e) a session stopped THROUGH LOOM is archived on exit (archiveOnExit) — it must still be listed under
  // exited/all, flagged archived + resumable, and distinguishable from a dead (unresumable) exit.
  const stoppedA = "stopped-a";
  seedSession(db, stoppedA, projA, "worker", { processState: "exited" });
  db.archiveSession(stoppedA);
  const deadA = "dead-a";
  seedSession(db, deadA, projA, "worker", { processState: "exited" });
  db.setResumability(deadA, "dead");
  db.archiveSession(deadA);
  const stoppedB = "stopped-b";
  seedSession(db, stoppedB, projB, "worker", { processState: "exited" });
  db.archiveSession(stoppedB);
  const exited2 = await call(client, "sessions_status", { state: "exited" });
  const row = exited2.sessions.find((s) => s.sessionId === stoppedA);
  check("(e) exited: lists the archived stopped session", !!row);
  check("(e) exited: row is flagged archived + resumable", row?.archived === true && row?.resumability === "resumable");
  check("(e) exited: an archived DEAD exit is omitted (noise for find-one-to-resume)", !exited2.sessions.some((s) => s.sessionId === deadA));
  check("(e) all: an archived DEAD exit is kept and flagged resumability dead", (await call(client, "sessions_status", { state: "all" })).sessions.find((s) => s.sessionId === deadA)?.resumability === "dead");
  check("(e) exited: an unarchived exit is flagged archived:false", exited2.sessions.find((s) => s.sessionId === exitedInA)?.archived === false);
  check("(e) exited: ungranted project's archived session stays hidden", !exited2.sessions.some((s) => s.sessionId === stoppedB));
  const all2 = await call(client, "sessions_status", { state: "all" });
  check("(e) all: includes the archived stopped session", all2.sessions.some((s) => s.sessionId === stoppedA));
  const live2 = await call(client, "sessions_status", {});
  check("(e) default live view still excludes archived stopped sessions", !live2.sessions.some((s) => s.sessionId === stoppedA));

  // (f) bounded + newest-first: 60 archived stopped sessions with strictly increasing lastActivity (> the 50 default cap).
  const base = Date.parse("2030-01-01T00:00:00.000Z");
  for (let i = 0; i < 60; i++) {
    const id = `bulk-${String(i).padStart(2, "0")}`;
    seedSession(db, id, projA, "worker", { processState: "exited", lastActivity: new Date(base + i * 1000).toISOString() });
    db.archiveSession(id);
  }
  const capped = await call(client, "sessions_status", { state: "exited" });
  check("(f) exited: capped at the default 50 rows", capped.sessions.length === 50);
  check("(f) exited: truncated:true when over the cap", capped.truncated === true);
  const expectedTotal = 60 + 1 /* stopped-a */ + 1 /* exited-a (unarchived) */;
  check("(f) exited: total is the true matching count", capped.total === expectedTotal);
  check("(f) exited: newest activity first (bulk-59 leads, bulk-10 is last kept)",
    capped.sessions[0].sessionId === "bulk-59" && capped.sessions[49].sessionId === "bulk-10");
  check("(f) exited: the oldest rows are the ones dropped", !capped.sessions.some((s) => s.sessionId === "bulk-00" || s.sessionId === stoppedA));
  const small = await call(client, "sessions_status", { state: "exited", limit: 3 });
  check("(f) explicit limit honoured", small.sessions.length === 3 && small.truncated === true && small.total === expectedTotal);
  const huge = await call(client, "sessions_status", { state: "all", limit: 100000 });
  check("(f) limit is clamped to the max (200)", huge.sessions.length <= 200);
  const allCapped = await call(client, "sessions_status", { state: "all" });
  check("(f) all: capped with total/truncated", allCapped.sessions.length === 50 && allCapped.truncated === true && allCapped.total > 50);
  const fits = await call(client, "sessions_status", { state: "exited", limit: 200 });
  check("(f) truncated:false when everything fits", fits.truncated === false && fits.sessions.length === expectedTotal && fits.total === expectedTotal);
  const liveAfter = await call(client, "sessions_status", {});
  check("(f) live view unbounded and its shape unchanged (no total/truncated)", !("total" in liveAfter) && !("truncated" in liveAfter));

  await client.close();
  db.close();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sessions_status's `state` filter defaults to \"live\" byte-identical to pre-card behavior, \"exited\" surfaces only stopped sessions, \"all\" surfaces both, and per-project grant scope holds at every state value."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
