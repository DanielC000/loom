import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6cef30d5: schedule_*/wake_* tool results must echo BOTH a UTC rendering and a local rendering
// of every time field, plus a server-now stamp (both forms) — additive only, never renaming/removing
// an existing field. HERMETIC + CLAUDE-FREE + NETWORK-FREE: exercises the SAME helper
// (orchestration/time-echo.js) the mcp/orchestration.ts, mcp/platform.ts, and mcp/server.ts tool
// handlers call, against a REAL Schedule (via SessionService.createSchedule) and a REAL Wake (via
// WakeService.schedule) — a representative schedule result and a representative wake result.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { PtyHost } from "../dist/pty/host.js";
import { SessionService } from "../dist/sessions/service.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { WakeService } from "../dist/orchestration/wake.js";
import { localTimeString, nowEcho, withScheduleTimeEcho, withWakeTimeEcho } from "../dist/orchestration/time-echo.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ============================================================================================
// (0) Pure helper contract — localTimeString / nowEcho, no Db involved.
// ============================================================================================
{
  const iso = "2026-07-21T05:10:00.000Z";
  const local = localTimeString(iso);
  check("(0) localTimeString returns a non-empty string", typeof local === "string" && local.length > 0);
  check("(0) localTimeString is deterministic for the same instant", localTimeString(iso) === local);

  const frozenNow = new Date("2026-07-21T04:00:00.000Z");
  const stamp = nowEcho(frozenNow);
  check("(0) nowEcho.now is the ISO instant passed in", stamp.now === "2026-07-21T04:00:00.000Z");
  check("(0) nowEcho.nowLocal is a non-empty local rendering", typeof stamp.nowLocal === "string" && stamp.nowLocal.length > 0);
}

// ============================================================================================
// (1) A REPRESENTATIVE SCHEDULE RESULT — created via the real manager surface (service.createSchedule),
// exactly like schedule_create's tool handler would, then decorated the same way that handler is wired to.
// ============================================================================================
{
  const tmpHome = path.join(os.tmpdir(), `loom-sched-echo-${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
  process.env.LOOM_HOME = tmpHome;

  const vault = path.join(tmpHome, "vault");
  fs.mkdirSync(vault, { recursive: true });
  const repo = tmpHome;
  const now = new Date().toISOString();
  const db = new Db(path.join(tmpHome, "sched.db"));
  db.insertProject({ id: "pS", name: "TimeEchoProj", repoPath: repo, vaultPath: vault, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentMgr", projectId: "pS", name: "Mgr", startupPrompt: "AGENT_MGR_DOCTRINE", position: 0, profileId: null });

  class SeamHost extends PtyHost {
    createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  }
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());
  db.insertSession({
    id: "mgrS", projectId: "pS", agentId: "agentMgr", engineSessionId: null, title: null,
    cwd: repo, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });

  const created = svc.createSchedule("mgrS", { agentId: "agentMgr", cron: "0 9 * * *", name: "Morning brief" });
  const echoed = withScheduleTimeEcho(created);

  check("(1) schedule echo preserves every original field verbatim (id/agentId/cron/enabled/kind/prompt/createdAt/name)",
    echoed.id === created.id && echoed.agentId === created.agentId && echoed.cron === created.cron &&
    echoed.enabled === created.enabled && echoed.kind === created.kind && echoed.prompt === created.prompt &&
    echoed.createdAt === created.createdAt && echoed.name === created.name);
  check("(1) schedule echo preserves the original nextFireAt (UTC) unchanged", echoed.nextFireAt === created.nextFireAt);
  check("(1) schedule echo ADDS nextFireAtLocal as a non-empty string", typeof echoed.nextFireAtLocal === "string" && echoed.nextFireAtLocal.length > 0);
  check("(1) schedule echo ADDS a server-now stamp: now (UTC ISO)", typeof echoed.now === "string" && !Number.isNaN(new Date(echoed.now).getTime()));
  check("(1) schedule echo ADDS a server-now stamp: nowLocal", typeof echoed.nowLocal === "string" && echoed.nowLocal.length > 0);
  check("(1) a schedule with no lastFiredAt gets NO lastFiredAtLocal (nothing to render)", !("lastFiredAtLocal" in echoed));

  // A fired schedule (lastFiredAt set) also gets its local twin.
  const withLastFired = { ...created, lastFiredAt: "2026-07-20T09:00:00.000Z" };
  const echoedFired = withScheduleTimeEcho(withLastFired);
  check("(1) a schedule WITH lastFiredAt gets lastFiredAtLocal too", typeof echoedFired.lastFiredAtLocal === "string" && echoedFired.lastFiredAtLocal.length > 0);

  // The recompute-on-cron-change path (card c7bf65aa) still returns the same correctly-anchored
  // nextFireAt — the echo only adds fields, it never changes what was computed.
  const updated = svc.updateScheduleAsManager("mgrS", created.id, { cron: "30 10 * * *" });
  const echoedUpdate = withScheduleTimeEcho(updated);
  check("(1) schedule_update's echoed result still carries the recomputed nextFireAt unchanged", echoedUpdate.nextFireAt === updated.nextFireAt);
  check("(1) ...alongside its local twin", typeof echoedUpdate.nextFireAtLocal === "string" && echoedUpdate.nextFireAtLocal.length > 0);

  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ============================================================================================
// (2) A REPRESENTATIVE WAKE RESULT — via the real WakeService.schedule (the wake_me primitive),
// decorated the same way the wake_me tool handler is wired to. Also covers the actual live incident:
// an in-the-past wakeAt rejection now carries a server-now stamp to check the claim against.
// ============================================================================================
{
  const dbFile = path.join(os.tmpdir(), `loom-wake-echo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `wp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `wt-${Math.random().toString(36).slice(2, 8)}`;
  const sessId = `ws-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "WakeEcho", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id: sessId, projectId: projId, agentId, engineSessionId: "eng-1", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  const pty = {
    isAlive: () => true,
    enqueueStdin: () => ({ delivered: true }),
    getActiveTurnOrigin: () => null,
  };
  const wakes = new WakeService({ db, pty, resume: async () => {} });

  const callMoment = new Date("2026-07-21T04:00:00.000Z");
  const scheduled = wakes.schedule(sessId, { delaySeconds: 60, note: "check the render" }, callMoment);
  const echoed = withWakeTimeEcho(scheduled, callMoment);

  check("(2) wake echo preserves the original wakeId verbatim", echoed.wakeId === scheduled.wakeId);
  check("(2) wake echo preserves the original wakeAt (UTC) unchanged", echoed.wakeAt === scheduled.wakeAt);
  check("(2) wake echo ADDS wakeAtLocal as a non-empty string", typeof echoed.wakeAtLocal === "string" && echoed.wakeAtLocal.length > 0);
  check("(2) wake echo ADDS a server-now stamp: now (UTC ISO)", echoed.now === callMoment.toISOString());
  check("(2) wake echo ADDS a server-now stamp: nowLocal", typeof echoed.nowLocal === "string" && echoed.nowLocal.length > 0);

  // The actual live-incident shape: a wakeAt genuinely in the past is rejected, but the error result
  // now carries the server's own now — self-timestamped, so "was 05:10Z really past?" is answerable
  // straight from the result instead of requiring a second round-trip to ask.
  let threwWithEcho = null;
  try {
    wakes.schedule(sessId, { wakeAt: "2026-07-21T03:00:00.000Z", note: "past wake" }, callMoment);
  } catch (e) {
    threwWithEcho = { error: e.message, ...nowEcho(callMoment) };
  }
  check("(2) an in-the-past wakeAt is rejected", threwWithEcho !== null && /at least/.test(threwWithEcho.error));
  check("(2) ...and the rejection ITSELF carries the server-now stamp to check the claim against",
    threwWithEcho.now === callMoment.toISOString() && typeof threwWithEcho.nowLocal === "string" && threwWithEcho.nowLocal.length > 0);

  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — schedule/wake tool results (and their rejections) echo UTC + local + a server-now stamp, additively, on both a representative schedule result and a representative wake result."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
