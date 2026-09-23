import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 788ed7f4 — flag an owner message left without a disposition at park. A manager (or the Platform
// Lead) received an owner-typed request via the chat composer, replied vaguely, and never actually did
// anything with it — no card, no escalation, no Request — and nothing noticed until the next park.
//
// MECHANISM: the composer REST route (POST /api/sessions/:id/input, gateway/server.ts) is the ONE channel
// that identifies an owner-authored message for a manager/platform session (raw-terminal input bypasses
// this entirely — a known, separately-tracked gap, card b4b9b707 — and Companion inbound is irrelevant,
// since idle_report is role-gated to manager/platform only). It records an open episode on the SESSION ROW
// itself (pending_owner_msg_excerpt/at/count — db.ts), FIRST-message-wins (a later "ok" never replaces the
// real ask), with a count of how many owner messages have landed since. `idle_report('waiting'|'done')`
// (SessionService.recordIdleReport) fires the warning ONCE per open episode, then clears it — a disposition
// tool call (tasks_create/platform_escalate/question_ask/question_resolve, or the Lead's own
// project_task_create) clears it BEFORE any park, by occurrence alone, never by content matching. The
// episode is REPARENTED (a true move) across a manager/platform recycle, unlike idle_nudge_policy's own
// reset-on-recycle default — a park-then-recycle is exactly how such a message would otherwise get lost.
//
// Covers:
//   (D) DB-LAYER — record/clear/first-vs-latest(+count)/new-message-new-episode/reparent-as-a-true-move.
//   (S) SERVICE — recordIdleReport surfaces the FIRST message + count, fires ONCE then clears, a NEW
//       message after a clear starts a fresh episode, 'working' never surfaces/clears it, the audit event
//       never carries the raw excerpt (length + age only — the LOOM_LOG_MESSAGE_CONTENT posture).
//   (R) THE COMPOSER ROUTE — sets the episode for manager/platform ONLY (not worker; Companion is refused
//       before ever reaching it), bounds the excerpt at the write site.
//   (M) THE FOUR (+ the Lead's own project_task_create) DISPOSITION TOOLS — each clears an open episode on
//       success, over the REAL MCP tool handlers; a FAILED disposition call does NOT clear it.
//   (C) RECYCLE — both recycleManager and recyclePlatformLead carry an open episode onto the successor
//       (a true move — gone from the retired predecessor), and the successor's own idle_report sees it.
//   (N) STRUCTURAL CONTROL — recordPendingOwnerMessage has exactly ONE production call site (the composer
//       route), proving a system-routed [loom:*] turn / worker_report / peer message can never trigger it
//       (none of those go through that route at all) — with a positive control that the pattern itself
//       isn't broken (it DOES match somewhere).
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: isolated LOOM_HOME, a real Db, the REAL SessionService + MCP
// routers (called directly via their `_registeredTools[name].handler(...)`, mirroring
// question-recycle-survival.mjs) and the REAL gateway `buildServer` driven via `app.inject()` (mirroring
// composer-input-sender-coalesce.mjs) — no live daemon, no real claude, no bound port, no real pty.
//
// Run: 1) build (turbo builds shared first), 2) node test/owner-message-park-disposition.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ownermsg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { cleanupPathSync } = await import("./_tmp-fixture.mjs");

const dbFile = path.join(tmpHome, "owner-msg.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

const freshSession = (id, projectId, agentId, role) => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: projectId,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role,
});

try {
  // ==================================== (D) DB-LAYER ====================================
  {
    db.insertProject({ id: "pD", name: "PD", repoPath: "pD", vaultPath: "pD", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "aD", projectId: "pD", name: "t", startupPrompt: "x", position: 0 });
    freshSession("mgrD", "pD", "aD", "manager");
    freshSession("mgrD2", "pD", "aD", "manager");

    check("(D1) no episode initially", db.getPendingOwnerMessage("mgrD") === null);

    const t1 = new Date(Date.now() - 5000).toISOString();
    db.recordPendingOwnerMessage("mgrD", "the real ask", t1);
    let p = db.getPendingOwnerMessage("mgrD");
    check("(D2) first message opens the episode", p?.excerpt === "the real ask" && p?.at === t1 && p?.count === 1);

    db.recordPendingOwnerMessage("mgrD", "ok", new Date().toISOString());
    p = db.getPendingOwnerMessage("mgrD");
    check("(D3) FIRST-WINS: excerpt/at stay pinned to the FIRST message, never the later 'ok'", p?.excerpt === "the real ask" && p?.at === t1);
    check("(D3) count bumps to 2", p?.count === 2);

    db.recordPendingOwnerMessage("mgrD", "still ok", new Date().toISOString());
    p = db.getPendingOwnerMessage("mgrD");
    check("(D4) a third message: excerpt still pinned, count bumps to 3", p?.excerpt === "the real ask" && p?.count === 3);

    db.clearPendingOwnerMessage("mgrD");
    check("(D5) clear closes the episode", db.getPendingOwnerMessage("mgrD") === null);

    const t3 = new Date().toISOString();
    db.recordPendingOwnerMessage("mgrD", "a brand new ask", t3);
    p = db.getPendingOwnerMessage("mgrD");
    check("(D6) NEW-MESSAGE-NEW-EPISODE: a message after a clear starts fresh", p?.excerpt === "a brand new ask" && p?.at === t3 && p?.count === 1);

    db.reparentPendingOwnerMessage("mgrD", "mgrD2");
    check("(D7) reparent copies the open episode onto the target", db.getPendingOwnerMessage("mgrD2")?.excerpt === "a brand new ask");
    check("(D7) reparent CLEARS the source (a TRUE MOVE, mirrors reparentWakes/reparentQuestions)", db.getPendingOwnerMessage("mgrD") === null);

    db.reparentPendingOwnerMessage("mgrD", "mgrD2"); // mgrD has nothing pending now
    check("(D8) reparenting an EMPTY source is a no-op (target keeps its own state)", db.getPendingOwnerMessage("mgrD2")?.excerpt === "a brand new ask");
  }

  // ==================================== (S) SERVICE ====================================
  {
    db.insertProject({ id: "pS", name: "PS", repoPath: "pS", vaultPath: "pS", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "aS", projectId: "pS", name: "t", startupPrompt: "x", position: 0 });
    const svc = new SessionService(db, /* pty */ {}, /* control */ {});
    let n = 0;
    const freshManager = () => { const id = `mgrS${++n}`; freshSession(id, "pS", "aS", "manager"); return id; };

    // (S1) nothing pending → no warning field at all, on either waiting or done.
    {
      const id = freshManager();
      const rWait = svc.recordIdleReport(id, "waiting");
      const rDone = svc.recordIdleReport(id, "done");
      check("(S1) waiting with nothing pending → no unhandledOwnerMessage", rWait.unhandledOwnerMessage === undefined && rWait.warning === undefined);
      check("(S1) done with nothing pending → no unhandledOwnerMessage", rDone.unhandledOwnerMessage === undefined && rDone.warning === undefined);
    }

    // (S2) baseline: one owner message, no disposition → 'waiting' surfaces it, naming the excerpt + age.
    {
      const id = freshManager();
      const at = new Date(Date.now() - 3 * 60_000).toISOString();
      db.recordPendingOwnerMessage(id, "please compare loom-codex vs claude code", at);
      const r = svc.recordIdleReport(id, "waiting");
      check("(S2) surfaces unhandledOwnerMessage", !!r.unhandledOwnerMessage);
      check("(S2) excerpt matches the owner's message", r.unhandledOwnerMessage?.excerpt === "please compare loom-codex vs claude code");
      check("(S2) count is 1 (only one message)", r.unhandledOwnerMessage?.count === 1);
      check("(S2) ageMinutes ≈ 3", r.unhandledOwnerMessage?.ageMinutes >= 2 && r.unhandledOwnerMessage?.ageMinutes <= 4);
      check("(S2) warning is a loud, addressed string naming the excerpt", typeof r.warning === "string" && r.warning.includes("please compare loom-codex vs claude code"));
      check("(S2) a SINGLE message never appends '(+N more)'", !r.warning.includes("more)"));
    }

    // (S3) FIRE-ONCE-THEN-CLEAR: the same episode never re-surfaces on a later park with no new message.
    {
      const id = freshManager();
      db.recordPendingOwnerMessage(id, "one ask", new Date().toISOString());
      const r1 = svc.recordIdleReport(id, "waiting");
      check("(S3) first park surfaces it", !!r1.unhandledOwnerMessage);
      const r2 = svc.recordIdleReport(id, "waiting");
      check("(S3) a SECOND park (no new owner message) does NOT re-surface it", r2.unhandledOwnerMessage === undefined && r2.warning === undefined);
      check("(S3) the DB episode is actually cleared", db.getPendingOwnerMessage(id) === null);
    }

    // (S4) NEW-MESSAGE-NEW-EPISODE: after a fire-once clear, a fresh owner message surfaces again.
    {
      const id = freshManager();
      db.recordPendingOwnerMessage(id, "first ask", new Date().toISOString());
      svc.recordIdleReport(id, "waiting"); // fires + clears
      db.recordPendingOwnerMessage(id, "second, unrelated ask", new Date().toISOString());
      const r = svc.recordIdleReport(id, "waiting");
      check("(S4) a NEW owner message after the clear surfaces AGAIN", r.unhandledOwnerMessage?.excerpt === "second, unrelated ask");
    }

    // (S5) FIRST-VS-LATEST (+count): several owner messages before any park; warns with the FIRST + count.
    {
      const id = freshManager();
      db.recordPendingOwnerMessage(id, "the REAL request", new Date().toISOString());
      db.recordPendingOwnerMessage(id, "ok", new Date().toISOString());
      db.recordPendingOwnerMessage(id, "also this", new Date().toISOString());
      const r = svc.recordIdleReport(id, "waiting");
      check("(S5) names the FIRST message, not the latest ('ok')", r.unhandledOwnerMessage?.excerpt === "the REAL request");
      check("(S5) count reflects all 3", r.unhandledOwnerMessage?.count === 3);
      check("(S5) warning text says '(+2 more)'", r.warning.includes("(+2 more)"));
    }

    // (S6) 'working' NEVER surfaces or clears it.
    {
      const id = freshManager();
      db.recordPendingOwnerMessage(id, "still open", new Date().toISOString());
      const r = svc.recordIdleReport(id, "working");
      check("(S6) 'working' never surfaces the episode", r.unhandledOwnerMessage === undefined && r.warning === undefined);
      check("(S6) 'working' never clears it either", db.getPendingOwnerMessage(id) !== null);
      const rWait = svc.recordIdleReport(id, "waiting");
      check("(S6) a later 'waiting' still surfaces the untouched episode", rWait.unhandledOwnerMessage?.excerpt === "still open");
    }

    // (S7) 'done' fires the check too, not just 'waiting'.
    {
      const id = freshManager();
      db.recordPendingOwnerMessage(id, "closing thought", new Date().toISOString());
      const r = svc.recordIdleReport(id, "done");
      check("(S7) 'done' surfaces it too", r.unhandledOwnerMessage?.excerpt === "closing thought");
    }

    // (S8) the durable audit event NEVER carries the raw excerpt — length + age only.
    {
      const id = freshManager();
      db.recordPendingOwnerMessage(id, "sensitive owner text", new Date().toISOString());
      svc.recordIdleReport(id, "waiting");
      const evt = db.listEvents(id).find((e) => e.kind === "idle_report");
      check("(S8) audit event never carries the raw excerpt", !JSON.stringify(evt?.detail ?? {}).includes("sensitive owner text"));
      check("(S8) audit event DOES carry length + age", typeof evt?.detail?.unhandledOwnerMessageLength === "number" && typeof evt?.detail?.unhandledOwnerMessageAgeMinutes === "number");
    }
  }

  // ==================================== (R) THE COMPOSER ROUTE ====================================
  {
    db.insertProject({ id: "pR", name: "PR", repoPath: "pR", vaultPath: "pR", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "aR", projectId: "pR", name: "t", startupPrompt: "x", position: 0 });
    freshSession("mgrR", "pR", "aR", "manager");
    freshSession("leadR", "pR", "aR", "platform");
    freshSession("wkrR", "pR", "aR", "worker");
    freshSession("compR", "pR", "aR", "assistant");

    const ptyStub = { enqueueStdin: () => ({ delivered: false }) };
    const stub = {};
    const app = await buildServer({ db, pty: ptyStub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
    try {
      const post = (id, text) => app.inject({ method: "POST", url: `/api/sessions/${id}/input`, payload: { text } });

      await post("mgrR", "the real owner request");
      check("(R1) a MANAGER composer turn sets the pending episode", db.getPendingOwnerMessage("mgrR")?.excerpt === "the real owner request");

      await post("leadR", "lead-directed owner request");
      check("(R2) a PLATFORM (Lead) composer turn ALSO sets it", db.getPendingOwnerMessage("leadR")?.excerpt === "lead-directed owner request");

      await post("wkrR", "text sent to a worker session");
      check("(R3) a WORKER composer turn does NOT set it (idle_report has no worker surface to warn on)", db.getPendingOwnerMessage("wkrR") === null);

      const assistantResp = await post("compR", "text sent to a companion");
      check("(R4) a Companion (assistant) session still gets the existing 403 refusal", assistantResp.statusCode === 403);
      check("(R4) and never sets it either (refused before reaching this logic)", db.getPendingOwnerMessage("compR") === null);

      // First-wins holds through the real route too: mgrR already has an OPEN episode from (R1).
      const long = "x".repeat(500);
      await post("mgrR", long);
      const pAfterLong = db.getPendingOwnerMessage("mgrR");
      check("(R5) first-wins holds through the route (the (R1) excerpt stays pinned)", pAfterLong?.excerpt === "the real owner request" && pAfterLong?.count === 2);

      // Bounded excerpt: a fresh episode from an over-300-char message is truncated at the write site.
      db.clearPendingOwnerMessage("mgrR");
      await post("mgrR", long);
      const pLong = db.getPendingOwnerMessage("mgrR");
      check("(R6) an over-300-char message is bounded at the write site", pLong?.excerpt.length <= 301 && pLong?.excerpt.endsWith("…"));
    } finally {
      await app.close();
    }
  }

  // ==================================== (M) THE DISPOSITION TOOLS ====================================
  {
    const ptyStub = {
      enqueueStdin: () => ({ delivered: true }),
      getActiveTurnOwnerText: () => "yes, go ahead",
      getRecentOwnerTurns: () => ["yes, go ahead"],
    };
    db.insertProject({ id: "pM", name: "PM", repoPath: "pM", vaultPath: "pM", config: {}, createdAt: now, archivedAt: null });
    db.insertProject({ id: "pHomeM", name: "Loom Platform", repoPath: "pHomeM", vaultPath: "pHomeM", config: {}, createdAt: now, archivedAt: null, reserved: true });
    db.insertAgent({ id: "aM", projectId: "pM", name: "t", startupPrompt: "x", position: 0 });
    db.insertAgent({ id: "aLeadM", projectId: "pHomeM", name: "lead", startupPrompt: "x", position: 0 });

    const svc = new SessionService(db, ptyStub, new OrchestrationControl());
    const wakes = new WakeService({ db, pty: ptyStub, resume: () => {} });

    // --- (M1) tasks_create (mcp/server.ts, the manager/worker task-board surface) ---
    {
      const sid = "mM-tasks";
      freshSession(sid, "pM", "aM", "manager");
      db.recordPendingOwnerMessage(sid, "please file this", new Date().toISOString());
      const server = new TaskMcpRouter(db, wakes).buildServer("pM", sid);
      const res = JSON.parse((await server._registeredTools["tasks_create"].handler({ title: "A real card" })).content[0].text);
      check("(M1) tasks_create succeeds", !res.error);
      check("(M1) tasks_create clears the open episode", db.getPendingOwnerMessage(sid) === null);
    }

    // --- (M2) platform_escalate (mcp/orchestration.ts, manager surface) ---
    {
      const sid = "mM-escalate";
      freshSession(sid, "pM", "aM", "manager");
      db.recordPendingOwnerMessage(sid, "please escalate this", new Date().toISOString());
      const server = new OrchestrationMcpRouter(db, svc, {}, ptyStub).buildServer(sid, "manager");
      const res = JSON.parse((await server._registeredTools["platform_escalate"].handler({ title: "A Loom bug found by " + sid, detail: "repro steps" })).content[0].text);
      check("(M2) platform_escalate succeeds", !res.error);
      check("(M2) platform_escalate clears the open episode", db.getPendingOwnerMessage(sid) === null);
    }

    // --- (M3) question_ask (mcp/orchestration.ts, manager surface) ---
    {
      const sid = "mM-ask";
      freshSession(sid, "pM", "aM", "manager");
      db.recordPendingOwnerMessage(sid, "please ask the owner", new Date().toISOString());
      const server = new OrchestrationMcpRouter(db, svc, {}, ptyStub).buildServer(sid, "manager");
      const res = JSON.parse((await server._registeredTools["question_ask"].handler({ title: "Ship it?", body: "gate is green" })).content[0].text);
      check("(M3) question_ask succeeds", !res.error);
      check("(M3) question_ask clears the open episode", db.getPendingOwnerMessage(sid) === null);
    }

    // --- (M4) question_resolve (mcp/orchestration.ts, manager surface) ---
    {
      const sid = "mM-resolve";
      freshSession(sid, "pM", "aM", "manager");
      const server = new OrchestrationMcpRouter(db, svc, {}, ptyStub).buildServer(sid, "manager");
      const asked = JSON.parse((await server._registeredTools["question_ask"].handler({ title: "Deploy now?", body: "confirm" })).content[0].text);
      // question_ask above already cleared any (nonexistent) episode; NOW seed one to prove resolve clears it.
      db.recordPendingOwnerMessage(sid, "please resolve this", new Date().toISOString());
      const res = JSON.parse((await server._registeredTools["question_resolve"].handler({ questionId: asked.questionId })).content[0].text);
      check("(M4) question_resolve succeeds", !res.error);
      check("(M4) question_resolve clears the open episode", db.getPendingOwnerMessage(sid) === null);
    }

    // --- (M5) the Lead's OWN surface (mcp/platform.ts): question_ask / question_resolve / project_task_create ---
    {
      const sid = "leadM";
      freshSession(sid, "pHomeM", "aLeadM", "platform");
      const server = new PlatformMcpRouter(db, svc, undefined, ptyStub).buildServer(sid);

      db.recordPendingOwnerMessage(sid, "lead: please ask", new Date().toISOString());
      const asked = JSON.parse((await server._registeredTools["question_ask"].handler({ title: "Approve X?", body: "y" })).content[0].text);
      check("(M5a) Lead question_ask succeeds", !asked.error);
      check("(M5a) Lead question_ask clears the open episode", db.getPendingOwnerMessage(sid) === null);

      db.recordPendingOwnerMessage(sid, "lead: please resolve", new Date().toISOString());
      const resolved = JSON.parse((await server._registeredTools["question_resolve"].handler({ questionId: asked.questionId })).content[0].text);
      check("(M5b) Lead question_resolve succeeds", !resolved.error);
      check("(M5b) Lead question_resolve clears the open episode", db.getPendingOwnerMessage(sid) === null);

      db.recordPendingOwnerMessage(sid, "lead: please file a card", new Date().toISOString());
      const created = JSON.parse((await server._registeredTools["project_task_create"].handler({ projectId: "pM", title: "A Lead-filed card" })).content[0].text);
      check("(M5c) Lead project_task_create succeeds", !created.error);
      check("(M5c) Lead project_task_create clears the open episode", db.getPendingOwnerMessage(sid) === null);
    }

    // --- (M6) NEGATIVE: a FAILED disposition call does NOT clear the episode (occurrence means a real
    // success, never a mere attempt) ---
    {
      const sid = "mM-fail";
      freshSession(sid, "pM", "aM", "manager");
      db.recordPendingOwnerMessage(sid, "still open", new Date().toISOString());
      const server = new OrchestrationMcpRouter(db, svc, {}, ptyStub).buildServer(sid, "manager");
      const res = JSON.parse((await server._registeredTools["question_resolve"].handler({ questionId: "nonexistent-id" })).content[0].text);
      check("(M6) a bogus question_resolve call fails", !!res.error);
      check("(M6) a FAILED disposition does NOT clear the episode", db.getPendingOwnerMessage(sid)?.excerpt === "still open");
    }
  }

  // ==================================== (C) RECYCLE CARRIES THE EPISODE ====================================
  {
    class PtyStub {
      constructor() { this.live = new Set(); this.spawned = []; }
      spawn(opts) { this.spawned.push(opts); this.live.add(opts.sessionId); }
      stop(id) { this.live.delete(id); }
      isAlive(id) { return this.live.has(id); }
      flushPending() { return []; }
      getPending() { return []; }
      enqueueStdin() { return { delivered: true }; }
    }

    // --- (C1) recycleManager ---
    {
      db.insertProject({ id: "pC1", name: "PC1", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
      db.insertAgent({ id: "aC1", projectId: "pC1", name: "Manager", startupPrompt: "BRIEF", position: 0 });
      const oldId = "mgrC1-old";
      db.insertSession({
        id: oldId, projectId: "pC1", agentId: "aC1", engineSessionId: "eng-c1", title: null, cwd: tmpHome,
        processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
      });
      db.recordPendingOwnerMessage(oldId, "unfinished owner ask", new Date().toISOString());

      const pty = new PtyStub();
      pty.live.add(oldId);
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const fresh = await sessions.recycleManager(oldId, "successor: 1 unhandled owner message outstanding");

      check("(C1) the open episode was REPARENTED onto the successor", db.getPendingOwnerMessage(fresh.id)?.excerpt === "unfinished owner ask");
      check("(C1) it's gone from the retired predecessor (moved, not copied)", db.getPendingOwnerMessage(oldId) === null);

      const r = sessions.recordIdleReport(fresh.id, "waiting");
      check("(C1) the SUCCESSOR's own idle_report surfaces the carried episode", r.unhandledOwnerMessage?.excerpt === "unfinished owner ask");
    }

    // --- (C2) recyclePlatformLead ---
    {
      db.insertProject({ id: "pC2", name: "Loom Platform C2", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
      db.insertAgent({ id: "aC2", projectId: "pC2", name: "Platform", startupPrompt: "LEAD BRIEF", position: 0 });
      const oldId = "leadC2-old";
      db.insertSession({
        id: oldId, projectId: "pC2", agentId: "aC2", engineSessionId: "eng-c2", title: null, cwd: tmpHome,
        processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform",
      });
      db.recordPendingOwnerMessage(oldId, "unfinished owner ask to the lead", new Date().toISOString());

      const pty = new PtyStub();
      pty.live.add(oldId);
      const sessions = new SessionService(db, pty, new OrchestrationControl());
      const fresh = await sessions.recyclePlatformLead(oldId, "successor: 1 unhandled owner message outstanding");

      check("(C2) the open episode was REPARENTED onto the successor Lead", db.getPendingOwnerMessage(fresh.id)?.excerpt === "unfinished owner ask to the lead");
      check("(C2) it's gone from the retired predecessor", db.getPendingOwnerMessage(oldId) === null);
    }
  }

  // ==================================== (N) STRUCTURAL CONTROL ====================================
  {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const srcDir = path.join(testDir, "..", "src");
    const tsFiles = fs.readdirSync(srcDir, { recursive: true })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(srcDir, f));
    const CALL = /\.recordPendingOwnerMessage\(/;
    const hits = tsFiles.filter((f) => CALL.test(fs.readFileSync(f, "utf8")));
    const relHits = hits.map((f) => path.relative(srcDir, f).replace(/\\/g, "/"));
    check("(N-control) positive: the call pattern DOES match somewhere (the regex itself isn't broken)", relHits.length > 0);
    check("(N-control) exactly ONE production call site", relHits.length === 1);
    check("(N-control) that one call site is gateway/server.ts (the composer route) — never a worker/system/peer path", relHits[0] === "gateway/server.ts");
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an owner-authored composer message opens a FIRST-message-wins episode (excerpt+count), " +
    "recordIdleReport surfaces it ONCE on a 'waiting'/'done' park and clears it (never on 'working', never " +
    "logging the raw excerpt), each disposition tool (tasks_create/platform_escalate/question_ask/" +
    "question_resolve, plus the Lead's project_task_create) clears it by occurrence on success only, a " +
    "manager/platform recycle carries an open episode onto the successor as a true move, and the composer " +
    "route is structurally the ONE place that can ever open one."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
