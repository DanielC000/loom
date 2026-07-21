// Human-only project/agent MANAGEMENT test. HERMETIC + CLAUDE-FREE in the style of session-archive.mjs
// (direct built Db) + agent-runs-rest.mjs (REAL buildServer driven by app.inject, all other deps STUBBED
// — no pty/claude boots). Covers the card's DoD GUARDS + cascade + happy paths:
//   A. PATCH /api/projects/:id renames + edits vaultPath (happy path); /config still works untouched.
//   A2. PATCH vaultPath:"" UNBINDs a vault on a repo-bound project (distinct from omitting the field);
//       refused on a VAULT-ONLY project (repoPath === vaultPath) to keep at-least-one-of-{repo,vault}.
//   B. archive→restore round-trip (bare DELETE = soft archive; POST /restore brings it back).
//   C. RESERVED guard: the reserved "Loom Platform" home refuses archive AND permanent-delete (4xx).
//   D. LIVE-session block: a project (DELETE + /permanent) AND an agent (DELETE) with a live session
//      are refused ("stop the fleet first"); nothing is removed.
//   E. CASCADE: deleteProject removes its agents + sessions + tasks + schedules (+ keys/runs/wakes) AND
//      the on-disk transcript-snapshot dir; deleteAgent removes its sessions (+ that agent's schedules).
//   F. agent-surface guard: deleteProject/deleteAgent/restoreProject are db methods reached ONLY via the
//      loopback REST routes above — there is no MCP path (asserted structurally in the worker report).
// Run: 1) build the daemon (turbo builds shared first), 2) node test/mgmt-project-agent.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";

const tmpHome = path.join(os.tmpdir(), `loom-mgmt-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45417";
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { snapshotTranscript, archivedTranscriptExists, archivedTranscriptPath, encodeProjectDir } =
  await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const mkProject = (id, over = {}) => ({ id, name: id, repoPath: "C:/tmp/loom-mgmt", vaultPath: "C:/tmp/loom-mgmt/vault", config: {}, createdAt: now, archivedAt: null, reserved: false, ...over });
const mkAgent = (id, projectId, over = {}) => ({ id, projectId, name: id, startupPrompt: "", position: 0, profileId: null, endpoint: false, ioSchema: null, ...over });
const mkSession = (id, projectId, agentId, over = {}) => ({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: "C:/tmp/loom-mgmt",
  processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, ...over,
});
const mkSchedule = (id, agentId) => ({ id, agentId, cron: "0 * * * *", enabled: true, nextFireAt: now, lastFiredAt: null, createdAt: now, kind: "manager" });
const mkTask = (id, projectId) => ({ id, projectId, title: id, body: "", columnKey: "todo", position: 0, priority: "p2", createdAt: now, updatedAt: now });

// ── transcript fixture for the snapshot-cascade assertion (unique cwd → unique encoded dir) ──
const fakeCwd = path.join(os.tmpdir(), `loom-mgmt-cwd-${Date.now()}`);
const engineId = `mgmt-engine-${Date.now()}`;
const claudeDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(fakeCwd));
const claudeFile = path.join(claudeDir, `${engineId}.jsonl`);

try {
  // ════════ A. PATCH rename / vaultPath (happy path) + /config still independent ════════
  db.insertProject(mkProject("pEdit"));
  const renamed = await app.inject({ method: "PATCH", url: "/api/projects/pEdit", payload: { name: "Renamed", vaultPath: "D:/new/vault" } });
  check("A: PATCH 200", renamed.statusCode === 200);
  check("A: rename + vaultPath written", db.getProject("pEdit").name === "Renamed" && db.getProject("pEdit").vaultPath === "D:/new/vault");
  const blankName = await app.inject({ method: "PATCH", url: "/api/projects/pEdit", payload: { name: "   " } });
  check("A: blank name → 400", blankName.statusCode === 400);
  const missing = await app.inject({ method: "PATCH", url: "/api/projects/nope", payload: { name: "x" } });
  check("A: PATCH unknown project → 404", missing.statusCode === 404);
  // /config remains a SEPARATE route, untouched by the structural PATCH (config still {} after rename).
  check("A: PATCH name did NOT touch config", JSON.stringify(db.getProject("pEdit").config) === "{}");

  // ════════ A2. UNBIND a vault via PATCH vaultPath:"" (card 9fe578b3 — complete the vault-optional story) ════════
  // A repo-bound project (repoPath !== vaultPath) CAN clear its vault: an explicit "" is an UNBIND,
  // distinct from omitting the field (which leaves the stored value untouched — proven by section A above,
  // where PATCH {name} alone never touched vaultPath).
  db.insertProject(mkProject("pUnbind", { repoPath: "C:/tmp/loom-mgmt/repo", vaultPath: "C:/tmp/loom-mgmt/vault" }));
  const unbind = await app.inject({ method: "PATCH", url: "/api/projects/pUnbind", payload: { vaultPath: "" } });
  check("A2: PATCH vaultPath:\"\" on a repo-bound project → 200 (unbind)", unbind.statusCode === 200);
  check("A2: vaultPath cleared, repoPath untouched",
    db.getProject("pUnbind").vaultPath === "" && db.getProject("pUnbind").repoPath === "C:/tmp/loom-mgmt/repo");
  // Omitting vaultPath entirely is still a no-op (leave-as-is) — rebind it, then confirm a bare {name}
  // PATCH does NOT re-clear it.
  db.updateProject("pUnbind", { vaultPath: "C:/tmp/loom-mgmt/vault2" });
  const noop = await app.inject({ method: "PATCH", url: "/api/projects/pUnbind", payload: { name: "pUnbind" } });
  check("A2: PATCH with vaultPath OMITTED → 200, vaultPath left untouched",
    noop.statusCode === 200 && db.getProject("pUnbind").vaultPath === "C:/tmp/loom-mgmt/vault2");

  // A VAULT-ONLY project (no separate repo — repoPath === vaultPath, the shape mcp/setup.ts's project_create
  // and the REST create route both produce for a no-repo bind) REFUSES the same unbind: it would otherwise
  // leave the project with nothing usable bound at all.
  db.insertProject(mkProject("pVaultOnly", { repoPath: "C:/tmp/loom-mgmt/notes", vaultPath: "C:/tmp/loom-mgmt/notes" }));
  const refused = await app.inject({ method: "PATCH", url: "/api/projects/pVaultOnly", payload: { vaultPath: "" } });
  check("A2: PATCH vaultPath:\"\" on a VAULT-ONLY project → 400 (refused)", refused.statusCode === 400);
  check("A2: vault-only project's vaultPath UNCHANGED after the refusal",
    db.getProject("pVaultOnly").vaultPath === "C:/tmp/loom-mgmt/notes");
  const badType = await app.inject({ method: "PATCH", url: "/api/projects/pUnbind", payload: { vaultPath: 123 } });
  check("A2: PATCH vaultPath as a non-string → 400", badType.statusCode === 400);

  // A LEGACY repo-bound project (repoPath === vaultPath, but repoPath IS a real git repo — the shape a
  // project created before cdc3792d has, when the default was vaultPath = repoPath) is NOT vault-only:
  // it genuinely has a repo, so the unbind must SUCCEED (card d867e478 — the over-refusal fix).
  const legacyRepo = path.join(os.tmpdir(), `loom-mgmt-legacyrepo-${Date.now()}-${process.pid}`);
  fs.mkdirSync(legacyRepo, { recursive: true });
  fs.writeFileSync(path.join(legacyRepo, "README.md"), "# legacy\n");
  execSync(`git init -q && git add . && git -c user.email=t@loom -c user.name=t commit -q -m init`, { cwd: legacyRepo });
  db.insertProject(mkProject("pLegacyRepoBound", { repoPath: legacyRepo, vaultPath: legacyRepo }));
  const legacyUnbind = await app.inject({ method: "PATCH", url: "/api/projects/pLegacyRepoBound", payload: { vaultPath: "" } });
  check("A2: PATCH vaultPath:\"\" on a legacy repo-bound project (repoPath===vaultPath, real git repo) → 200 (unbind)", legacyUnbind.statusCode === 200);
  check("A2: legacy project's vaultPath cleared, repoPath untouched",
    db.getProject("pLegacyRepoBound").vaultPath === "" && db.getProject("pLegacyRepoBound").repoPath === legacyRepo);
  fs.rmSync(legacyRepo, { recursive: true, force: true });

  // ════════ B. archive → restore round-trip ════════
  const arch = await app.inject({ method: "DELETE", url: "/api/projects/pEdit" });
  check("B: bare DELETE soft-archives (200, ok)", arch.statusCode === 200 && JSON.parse(arch.body).ok === true);
  check("B: archived project hidden from listProjects + archivedAt stamped",
    !db.listProjects().some((p) => p.id === "pEdit") && !!db.getProject("pEdit").archivedAt);
  const archList = await app.inject({ method: "GET", url: "/api/projects/archived" });
  check("B: GET /api/projects/archived surfaces the archived project",
    archList.statusCode === 200 && JSON.parse(archList.body).some((p) => p.id === "pEdit"));
  const rest = await app.inject({ method: "POST", url: "/api/projects/pEdit/restore" });
  check("B: POST /restore clears archivedAt (200)", rest.statusCode === 200 && db.getProject("pEdit").archivedAt === null);
  check("B: restored project back in listProjects", db.listProjects().some((p) => p.id === "pEdit"));

  // ════════ C. RESERVED guard — refuse archive AND permanent-delete ════════
  db.insertProject(mkProject("pReserved", { reserved: true }));
  const ra = await app.inject({ method: "DELETE", url: "/api/projects/pReserved" });
  check("C: reserved project archive → 400", ra.statusCode === 400 && /reserved/i.test(JSON.parse(ra.body).error));
  const rp = await app.inject({ method: "DELETE", url: "/api/projects/pReserved/permanent" });
  check("C: reserved project permanent-delete → 400", rp.statusCode === 400 && /reserved/i.test(JSON.parse(rp.body).error));
  check("C: reserved project still present after both refusals", !!db.getProject("pReserved"));

  // ════════ D. LIVE-session block — project (archive + permanent) AND agent ════════
  db.insertProject(mkProject("pLive"));
  db.insertAgent(mkAgent("aLive", "pLive"));
  db.insertSession(mkSession("sLive", "pLive", "aLive", { processState: "live" }));
  const la = await app.inject({ method: "DELETE", url: "/api/projects/pLive" });
  check("D: archive project with a live session → 400 (stop the fleet first)", la.statusCode === 400 && /stop the fleet first/.test(JSON.parse(la.body).error));
  const lp = await app.inject({ method: "DELETE", url: "/api/projects/pLive/permanent" });
  check("D: permanent-delete project with a live session → 400", lp.statusCode === 400 && /stop the fleet first/.test(JSON.parse(lp.body).error));
  const lag = await app.inject({ method: "DELETE", url: "/api/agents/aLive" });
  check("D: delete agent with a live session → 400", lag.statusCode === 400 && /stop the fleet first/.test(JSON.parse(lag.body).error));
  check("D: nothing removed (project/agent/session all survive the live block)",
    !!db.getProject("pLive") && !!db.getAgent("aLive") && !!db.getSession("sLive"));

  // ════════ E. CASCADE — deleteProject (rows + on-disk snapshots) + deleteAgent ════════
  // Build a fully-populated project: 2 agents, sessions under each, tasks, schedules, an api key + run.
  db.insertProject(mkProject("pCas"));
  db.insertAgent(mkAgent("aCas1", "pCas"));
  db.insertAgent(mkAgent("aCas2", "pCas", { position: 1 }));
  db.insertSession(mkSession("sCas1", "pCas", "aCas1", { engineSessionId: engineId, cwd: fakeCwd }));
  db.insertSession(mkSession("sCas2", "pCas", "aCas2"));
  db.insertTask(mkTask("tCas1", "pCas"));
  db.insertSchedule(mkSchedule("schCas1", "aCas1"));
  const keyCas = db.createApiKey({ projectId: "pCas", name: "k", endpointAgentIds: [], caps: { maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null } });
  db.insertRun({ id: "rCas1", projectId: "pCas", agentId: "aCas1", sessionId: null, keyId: keyCas.key.id, status: "completed", input: null, schema: null, result: null, usage: null, transcriptRef: null, error: null, webhookUrl: null, idempotencyKey: null, createdAt: now, startedAt: null, endedAt: null });
  // orchestration_events are session-keyed (manager OR worker) with NO project_id — a permanent delete
  // must clear them so the cross-project Activity feed shows no orphans. Seed: one row where BOTH ids are
  // under pCas (manager-branch match) + one where only the WORKER is under pCas but the manager is an
  // unrelated survivor (worker-branch match — proves the OR clause, not just the manager column).
  db.appendEvent({ id: "evCas1", ts: now, managerSessionId: "sCas2", workerSessionId: "sCas1", taskId: null, kind: "worker_report", detail: null });
  db.appendEvent({ id: "evCas2", ts: now, managerSessionId: "survivorMgr", workerSessionId: "sCas1", taskId: null, kind: "worker_report", detail: null });
  check("E: orchestration_events seeded before delete", db.listEvents("sCas2").length === 1 && db.listEvents("survivorMgr").length === 1);
  // Seed an on-disk transcript snapshot for one session so the dir-removal is provable.
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(claudeFile, '{"type":"user","message":{"content":"hi"}}\n');
  snapshotTranscript(fakeCwd, engineId, "pCas", "sCas1");
  check("E: snapshot seeded under archives/pCas before delete", archivedTranscriptExists("pCas", "sCas1"));

  const delP = await app.inject({ method: "DELETE", url: "/api/projects/pCas/permanent" });
  check("E: permanent-delete → 200", delP.statusCode === 200 && JSON.parse(delP.body).ok === true);
  check("E: project row gone", !db.getProject("pCas"));
  check("E: agents cascaded", db.listAgents("pCas").length === 0 && !db.getAgent("aCas1") && !db.getAgent("aCas2"));
  check("E: sessions cascaded", !db.getSession("sCas1") && !db.getSession("sCas2"));
  check("E: tasks cascaded", db.listTasks("pCas").length === 0 && !db.getTask("tCas1"));
  check("E: schedules cascaded", !db.getSchedule("schCas1") && !db.listSchedules().some((s) => s.id === "schCas1"));
  check("E: keys + runs cascaded", db.listApiKeys("pCas").length === 0 && !db.getRun("rCas1"));
  check("E: orchestration_events cascaded (manager-branch + worker-branch from a survivor manager)",
    db.listEvents("sCas2").length === 0 && db.listEvents("survivorMgr").length === 0);
  check("E: on-disk snapshot dir removed (archives/pCas gone)",
    !archivedTranscriptExists("pCas", "sCas1") && !fs.existsSync(path.dirname(archivedTranscriptPath("pCas", "sCas1"))));

  // deleteAgent cascade — its sessions + that agent's schedules go; the OTHER agent's are untouched.
  db.insertProject(mkProject("pAg"));
  db.insertAgent(mkAgent("aGone", "pAg"));
  db.insertAgent(mkAgent("aKeep", "pAg", { position: 1 }));
  db.insertSession(mkSession("sGone1", "pAg", "aGone"));
  db.insertSession(mkSession("sGone2", "pAg", "aGone"));
  db.insertSession(mkSession("sKeep", "pAg", "aKeep"));
  db.insertSchedule(mkSchedule("schGone", "aGone"));
  db.insertSchedule(mkSchedule("schKeep", "aKeep"));
  // orchestration_events for the agent's sessions (manager + worker branch) + a run-keyed run_event for
  // one of the agent's runs — both must cascade with the agent (but NOT the sibling aKeep's audit row).
  db.appendEvent({ id: "evGone1", ts: now, managerSessionId: "sGone1", workerSessionId: "sGone2", taskId: null, kind: "worker_report", detail: null });
  db.appendEvent({ id: "evGone2", ts: now, managerSessionId: "survivorMgr2", workerSessionId: "sGone1", taskId: null, kind: "worker_report", detail: null });
  db.appendEvent({ id: "evKeep", ts: now, managerSessionId: "sKeep", workerSessionId: null, taskId: null, kind: "worker_report", detail: null });
  db.insertRun({ id: "rGone", projectId: "pAg", agentId: "aGone", sessionId: null, keyId: null, status: "completed", input: null, schema: null, result: null, usage: null, transcriptRef: null, error: null, webhookUrl: null, idempotencyKey: null, createdAt: now, startedAt: null, endedAt: null });
  db.insertRunEvent({ id: "reGone", projectId: "pAg", keyId: null, runId: "rGone", kind: "cap_rejected", detail: null, createdAt: now });
  const delA = await app.inject({ method: "DELETE", url: "/api/agents/aGone" });
  check("E: delete agent → 200", delA.statusCode === 200 && JSON.parse(delA.body).deleted.sessions === 2);
  check("E: agent row gone", !db.getAgent("aGone"));
  check("E: agent's sessions cascaded", !db.getSession("sGone1") && !db.getSession("sGone2"));
  check("E: agent's schedule cascaded", !db.getSchedule("schGone"));
  check("E: agent's orchestration_events cascaded (manager + worker branch)",
    db.listEvents("sGone1").length === 0 && db.listEvents("survivorMgr2").length === 0);
  check("E: agent's run + its run_event cascaded", !db.getRun("rGone") && !db.listRunEvents("pAg").some((e) => e.id === "reGone"));
  check("E: sibling agent + its session/schedule/audit-event UNTOUCHED",
    !!db.getAgent("aKeep") && !!db.getSession("sKeep") && !!db.getSchedule("schKeep") && !!db.getProject("pAg") && db.listEvents("sKeep").length === 1);
  const delMissing = await app.inject({ method: "DELETE", url: "/api/agents/nope" });
  check("E: delete unknown agent → 404", delMissing.statusCode === 404);
} finally {
  await app.close();
  db.close();
  try { fs.rmSync(claudeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(fakeCwd, { recursive: true, force: true }); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project rename/vaultPath; vaultPath:\"\" unbinds on a repo-bound project but is refused on a vault-only one; archive↔restore; reserved guard (archive + permanent); live-session block (project + agent); deleteProject cascades rows + on-disk snapshots; deleteAgent cascades its sessions/schedules only."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
