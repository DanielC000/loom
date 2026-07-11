import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Event-trigger REST CRUD (Loom Event Triggers subsystem, card f5d07121 T2, /api/event-triggers).
// Fully hermetic: a REAL Db on a temp file + the REAL buildServer (app.inject) — NO live network, NO
// real claude, NO daemon.
//
// Covers: eventKind allowlist validation, the mode<->target coherence + existence check on BOTH create
// and update (mirrors poll-jobs-rest.mjs's create/update validation-asymmetry fix), the nullable
// projectId scope (including an explicit clear-to-null on update), and — the DoD's explicit NO-MCP-WRITER
// requirement — that NONE of the daemon's MCP routers (loom-tasks / loom-orchestration / loom-platform /
// loom-audit / loom-user-audit / loom-setup / loom-run) register any event-trigger tool: this dispatcher
// fires autonomously across arbitrary event kinds, broader than any agent should self-configure, so it is
// REST-only exactly like poll_jobs/connections/schedules.
//
// ALSO covers the two CR-caught baseline-watermark fixes (f5d07121-T2-①/③): CREATE seeds a brand-new
// trigger's lastSeq to the CURRENT bus max (never 0), and an UPDATE that flips a trigger disabled->enabled
// re-seeds lastSeq the same way — both so a trigger never replays events that predate its creation, or
// that accrued while it sat disabled. (The dispatcher-side consequence — a freshly-baselined trigger
// actually fires zero times on pre-existing events — is proven in the sibling test/event-trigger-
// dispatch.mjs, which exercises tick() directly; this file proves the REST layer performs the seed.)
//
// Run: 1) build (turbo builds shared first), 2) node test/event-triggers-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { buildServer } from "../dist/gateway/server.js";
import { EVENT_TRIGGER_EVENT_KINDS } from "@loom/shared";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(os.tmpdir(), `loom-evtrig-rest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "etr-proj";
const otherProjId = "etr-proj-2";
const agentId = "etr-agent";
const otherAgentId = "etr-agent-2";
const sessId = "etr-sess";
db.insertProject({ id: projId, name: "ETR", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: otherProjId, name: "ETR2", repoPath: otherProjId, vaultPath: otherProjId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "spawn-target", startupPrompt: "", position: 0 });
db.insertAgent({ id: otherAgentId, projectId: projId, name: "spawn-target-2", startupPrompt: "", position: 1 });
db.insertSession({
  id: sessId, projectId: projId, agentId, engineSessionId: "eng-1", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
});

const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
const inject = (opts) => app.inject(opts);

try {
  // --- CREATE validation ---
  const badKind = await inject({ method: "POST", url: "/api/event-triggers", payload: {
    eventKind: "not_a_real_kind", mode: "spawn", agentId,
  } });
  check("CREATE: an eventKind outside EVENT_TRIGGER_EVENT_KINDS -> 400", badKind.statusCode === 400);
  check("CREATE: the rejected create wrote NO row", db.listEventTriggers().length === 0);

  const badMode = await inject({ method: "POST", url: "/api/event-triggers", payload: {
    eventKind: "worker_report", mode: "spawn", // no agentId
  } });
  check("CREATE: mode 'spawn' with no agentId -> 404", badMode.statusCode === 404);
  check("CREATE: still no row written", db.listEventTriggers().length === 0);

  const badTarget = await inject({ method: "POST", url: "/api/event-triggers", payload: {
    eventKind: "worker_report", mode: "wake", targetSessionId: "does-not-exist",
  } });
  check("CREATE: mode 'wake' with a nonexistent targetSessionId -> 404", badTarget.statusCode === 404);

  const badProject = await inject({ method: "POST", url: "/api/event-triggers", payload: {
    eventKind: "worker_report", mode: "spawn", agentId, projectId: "no-such-project",
  } });
  check("CREATE: a nonexistent projectId -> 404", badProject.statusCode === 404);
  check("CREATE: still no row written after all rejections", db.listEventTriggers().length === 0);

  const good = await inject({ method: "POST", url: "/api/event-triggers", payload: {
    eventKind: "worker_report", mode: "spawn", agentId, projectId: projId,
  } });
  check("CREATE: valid spawn trigger -> 201", good.statusCode === 201);
  const trigger = JSON.parse(good.payload);
  check("CREATE: persisted with the normalized target (agentId set, targetSessionId cleared)", trigger.agentId === agentId && trigger.targetSessionId === null);
  check("CREATE: fresh watermark + never-fired defaults", trigger.lastSeq === 0 && trigger.lastFiredAt === null);
  check("CREATE: defaults enabled:true when omitted", trigger.enabled === true);

  // ============ CR REGRESSION (①) — CREATE seeds lastSeq to the CURRENT bus max, NEVER 0 ============
  // The trigger.lastSeq===0 assertion above is a coincidence of an empty bus (0 IS the max on an empty
  // table) and does NOT by itself prove the fix — so append some HISTORICAL events first, forcing a
  // nonzero bus max, then create a trigger and assert its lastSeq lands exactly at that max (not 0).
  for (let i = 0; i < 3; i++) {
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: sessId, kind: "worker_report", detail: { historical: i } });
  }
  const busMaxBeforeCreate = db.getMaxEventSeq();
  check("(setup) the bus now has a NONZERO max (historical events landed)", busMaxBeforeCreate > 0);
  const noReplay = await inject({ method: "POST", url: "/api/event-triggers", payload: {
    eventKind: "worker_report", mode: "spawn", agentId,
  } });
  check("CREATE (①): a freshly-created trigger's lastSeq is seeded to the CURRENT bus max, not 0", JSON.parse(noReplay.payload).lastSeq === busMaxBeforeCreate);
  check("CREATE (①): NOT hardcoded to 0 despite historical events already on the bus", JSON.parse(noReplay.payload).lastSeq !== 0);

  // ============ CR REGRESSION (③) — a disabled->enabled UPDATE reseeds lastSeq the SAME way ============
  const reenableTrigger = JSON.parse((await inject({ method: "POST", url: "/api/event-triggers", payload: {
    eventKind: "worker_report", mode: "spawn", agentId, enabled: false,
  } })).payload);
  check("(setup) the disabled trigger's own baseline is the CURRENT max at ITS creation", reenableTrigger.lastSeq === db.getMaxEventSeq());
  // More matching events accrue WHILE the trigger sits disabled.
  for (let i = 0; i < 4; i++) {
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: sessId, kind: "worker_report", detail: { whileDisabled: i } });
  }
  const busMaxWhileDisabled = db.getMaxEventSeq();
  check("(setup) the bus advanced further while the trigger was disabled", busMaxWhileDisabled > reenableTrigger.lastSeq);
  const reenabled = await inject({ method: "POST", url: `/api/event-triggers/${reenableTrigger.id}`, payload: { enabled: true } });
  check("UPDATE (③): re-enabling -> 200", reenabled.statusCode === 200);
  check("UPDATE (③): lastSeq RE-SEEDED to the bus max AT RE-ENABLE TIME (the whole disabled-window backlog is skipped)", JSON.parse(reenabled.payload).lastSeq === busMaxWhileDisabled);

  // A no-op enable (already enabled -> enabled:true again, or any patch that doesn't cross
  // disabled->enabled) must NOT reseed — only the disabled->enabled TRANSITION does.
  const moreEvents = db.getMaxEventSeq();
  db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: sessId, kind: "worker_report", detail: { afterReenable: true } });
  const noopEnable = await inject({ method: "POST", url: `/api/event-triggers/${reenableTrigger.id}`, payload: { enabled: true } });
  check("UPDATE (③): a no-op 'enabled:true' patch on an ALREADY-enabled trigger does NOT reseed lastSeq", JSON.parse(noopEnable.payload).lastSeq === moreEvents);

  // A create with an explicit eventKind not on the allowlist string-wise (case sensitivity / typo) is
  // still rejected even though it superficially resembles a real one.
  const typoKind = await inject({ method: "POST", url: "/api/event-triggers", payload: {
    eventKind: "Worker_Report", mode: "spawn", agentId,
  } });
  check("CREATE: a case-mismatched eventKind is REJECTED (exact allowlist match only)", typoKind.statusCode === 400);

  // --- GET list ---
  const list = await inject({ method: "GET", url: "/api/event-triggers" });
  check("GET list: 200, includes the created trigger", list.statusCode === 200 && JSON.parse(list.payload).some((t) => t.id === trigger.id));

  // --- UPDATE validation — the SAME mode<->target check applies here (poll-jobs-rest's asymmetry fix) ---
  const patchToOrphanAgent = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { agentId: "totally-bogus" } });
  check("UPDATE: patching agentId to a nonexistent agent -> 404 (mode unchanged, still 'spawn')", patchToOrphanAgent.statusCode === 404);
  check("UPDATE: the row is UNCHANGED after the rejected patch (still points at the real agent)", db.getEventTrigger(trigger.id).agentId === agentId);

  const patchBadKind = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { eventKind: "bogus_kind" } });
  check("UPDATE: an invalid eventKind -> 400, row unchanged", patchBadKind.statusCode === 400 && db.getEventTrigger(trigger.id).eventKind === "worker_report");

  const patchBadProject = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { projectId: "no-such-project-2" } });
  check("UPDATE: a nonexistent projectId -> 404, row unchanged", patchBadProject.statusCode === 404 && db.getEventTrigger(trigger.id).projectId === projId);

  const patchToWakeNoSession = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { mode: "wake" } }); // no targetSessionId, existing agentId irrelevant to 'wake'
  check("UPDATE: switching mode to 'wake' with no targetSessionId -> 404 (not silently stored inconsistent)", patchToWakeNoSession.statusCode === 404);
  check("UPDATE: the row STAYS 'spawn' (rejected patch never partially applied)", db.getEventTrigger(trigger.id).mode === "spawn");

  const patchToWakeBadSession = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { mode: "wake", targetSessionId: "nope" } });
  check("UPDATE: switching to 'wake' with a nonexistent targetSessionId -> 404", patchToWakeBadSession.statusCode === 404);

  const patchToWakeOk = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { mode: "wake", targetSessionId: sessId } });
  check("UPDATE: switching to 'wake' with a REAL targetSessionId -> 200, mode+target both updated", patchToWakeOk.statusCode === 200);
  const afterWake = db.getEventTrigger(trigger.id);
  check("UPDATE: persisted mode='wake', targetSessionId set, agentId cleared (normalized, not left stale)", afterWake.mode === "wake" && afterWake.targetSessionId === sessId && afterWake.agentId === null);

  // A no-op-target patch (only 'enabled') still re-validates the EFFECTIVE (existing) pairing — proving
  // the check isn't just gated on "did the body include mode/targetSessionId/agentId" (the enable-toggle path).
  const toggleOff = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { enabled: false } });
  check("UPDATE (enable-toggle): a no-op-target patch (only 'enabled') still succeeds — existing pairing is valid", toggleOff.statusCode === 200 && db.getEventTrigger(trigger.id).enabled === false);
  const toggleOn = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { enabled: true } });
  check("UPDATE (enable-toggle): flips back on", toggleOn.statusCode === 200 && db.getEventTrigger(trigger.id).enabled === true);

  // projectId: explicit clear-to-null (all-projects scope) round-trips distinctly from "omitted" (unchanged).
  const clearProject = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { projectId: null } });
  check("UPDATE: an explicit projectId:null clears the scope to all-projects", clearProject.statusCode === 200 && db.getEventTrigger(trigger.id).projectId === null);
  const omitProject = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { enabled: true } }); // projectId omitted entirely
  check("UPDATE: omitting projectId leaves the (already-null) scope untouched", omitProject.statusCode === 200 && db.getEventTrigger(trigger.id).projectId === null);
  const resetProject = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { projectId: otherProjId } });
  check("UPDATE: setting projectId to a REAL project scopes it there", resetProject.statusCode === 200 && db.getEventTrigger(trigger.id).projectId === otherProjId);

  // Switching back to spawn with a valid agent works cleanly, proving the normalization round-trips.
  const patchBackToSpawn = await inject({ method: "POST", url: `/api/event-triggers/${trigger.id}`, payload: { mode: "spawn", agentId: otherAgentId } });
  check("UPDATE: switching back to 'spawn' with a valid agentId -> 200", patchBackToSpawn.statusCode === 200);
  const afterSpawn2 = db.getEventTrigger(trigger.id);
  check("UPDATE: persisted mode='spawn', agentId=otherAgentId, targetSessionId cleared", afterSpawn2.mode === "spawn" && afterSpawn2.agentId === otherAgentId && afterSpawn2.targetSessionId === null);

  // --- UPDATE on a nonexistent id -> 404 ---
  const patchMissing = await inject({ method: "POST", url: "/api/event-triggers/does-not-exist", payload: { enabled: false } });
  check("UPDATE: a nonexistent trigger id -> 404", patchMissing.statusCode === 404);

  // --- DELETE ---
  const del = await inject({ method: "DELETE", url: `/api/event-triggers/${trigger.id}` });
  check("DELETE: 200 ok", del.statusCode === 200 && JSON.parse(del.payload).ok === true);
  check("DELETE: the row is gone", db.getEventTrigger(trigger.id) === undefined);

  console.log(failures === 0
    ? "\n✅ ALL PASS — /api/event-triggers CREATE validates the eventKind allowlist + mode<->target pairing + target/project existence, UPDATE enforces the IDENTICAL checks against the EFFECTIVE post-patch state (every rejected patch leaves the row exactly as it was), the nullable projectId scope round-trips including an explicit clear-to-null, and DELETE removes the row."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  await app.close();
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
process.exit(failures === 0 ? 0 : 1);
