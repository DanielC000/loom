// Card c7bf65aa: on a cron change, `schedule_update` MUST recompute next_fire_at from **now**, never
// from the schedule's existing (pre-edit) next_fire_at. A recompute from the stale stored value can
// only ever schedule LATER than the true next occurrence (it can never be sooner), silently skipping
// an earlier-today slot and ratcheting worse with every further edit. HERMETIC + CLAUDE-FREE + NETWORK-FREE.
//
// cron-parser matches wall-clock fields against the HOST's local timezone, so the literal local/UTC-
// boundary scenario reported live (schedule edited a few minutes before local midnight, to a cron whose
// next local occurrence crosses into the next UTC calendar day) needs a PINNED timezone to be
// reproducible on any CI host — never the ambient host TZ. This file re-execs itself ONCE as a child with
// TZ forced to Europe/Vienna (the zone the live repro happened in, UTC+2 in summer) BEFORE any other
// module (incl. `./dist`, which reads Date fields) loads — everything past the re-exec check is a
// DYNAMIC import for exactly that reason: a static top-level import is hoisted ahead of the check.
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.env.LOOM_TZ_REEXEC !== "1") {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, TZ: "Europe/Vienna", LOOM_TZ_REEXEC: "1" },
  });
  process.exit(r.status ?? 1);
}

await import("./_guard.mjs"); // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
const fs = (await import("node:fs")).default;
const os = (await import("node:os")).default;
const path = (await import("node:path")).default;
const { randomUUID } = await import("node:crypto");
const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { nextFireAt } = await import("../dist/orchestration/cron.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-sched-recompute-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const vault = path.join(tmpHome, "vault");
fs.mkdirSync(vault, { recursive: true });
const repo = tmpHome;
const now = new Date().toISOString();
const db = new Db(path.join(tmpHome, "sched.db"));
db.insertProject({ id: "pS", name: "SchedRecomputeProj", repoPath: repo, vaultPath: vault, config: {}, createdAt: now, archivedAt: null });
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

const RealDate = Date;
function freezeAt(instant) {
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant.getTime(); }
  }
  global.Date = FrozenDate;
}
function withFrozenClock(instant, fn) {
  freezeAt(instant);
  try { return fn(); } finally { global.Date = RealDate; }
}

// ============================================================================================
// (1) THE LITERAL live-daemon repro, TZ-pinned: a schedule with nextFireAt=2026-07-21T05:00Z (07:00
// local), edited at 22:44Z Jul 20 (00:44 local Jul 21) to "50 0 * * *" (00:50 local). The true next
// occurrence is 22:50Z Jul 20 — TODAY in UTC terms, even though it's already "tomorrow" locally. A
// recompute that wrongly bases off the stale 05:00Z value instead of now lands a full day later
// (22:50Z Jul 21), exactly as reported.
// ============================================================================================
{
  const scheduleId = randomUUID();
  const staleNextFireAt = "2026-07-21T05:00:00.000Z";
  db.insertSchedule({
    id: scheduleId, name: "Live repro", agentId: "agentMgr", cron: "0 7 * * *", enabled: true,
    nextFireAt: staleNextFireAt, lastFiredAt: null, createdAt: now, kind: "manager", prompt: null,
  });

  const editMoment = new Date("2026-07-20T22:44:00.000Z");
  const updated = withFrozenClock(editMoment, () => svc.updateScheduleAsManager("mgrS", scheduleId, { cron: "50 0 * * *" }));

  check("(1) live repro: recompute lands on 22:50Z Jul 20 (today, not a day late)", updated.nextFireAt === "2026-07-20T22:50:00.000Z");
  check("(1) live repro: recompute is NOT the reported buggy stale-basis result (22:50Z Jul 21)", updated.nextFireAt !== "2026-07-21T22:50:00.000Z");
  check("(1) live repro: the persisted row agrees with the returned value", db.getSchedule(scheduleId)?.nextFireAt === "2026-07-20T22:50:00.000Z");

  // Second probe from the report: an immediate follow-up edit must re-anchor to ITS OWN now, not ratchet
  // off the first edit's result (correct or otherwise).
  const secondEditMoment = new Date("2026-07-20T22:44:30.000Z");
  const updated2 = withFrozenClock(secondEditMoment, () => svc.updateScheduleAsManager("mgrS", scheduleId, { cron: "55 0 * * *" }));
  check("(1) live repro: a second immediate edit lands on 22:55Z Jul 20, not a ratcheted-later slot", updated2.nextFireAt === "2026-07-20T22:55:00.000Z");
}

// ============================================================================================
// (2) TZ-independent generalization: a stale next_fire_at a full day out, from ANY host timezone —
// proves "recompute from now" vs. "recompute from the stale value" diverge everywhere, not just
// Europe/Vienna. Also covers non-cron patches leaving next_fire_at untouched.
// ============================================================================================
{
  const scheduleId = randomUUID();
  const editMoment = new Date();
  const staleFutureNextFireAt = new Date(editMoment.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const newCron = "*/5 * * * *";
  db.insertSchedule({
    id: scheduleId, name: "Generalized check", agentId: "agentMgr", cron: "0 0 1 1 *", enabled: true,
    nextFireAt: staleFutureNextFireAt, lastFiredAt: null, createdAt: now, kind: "manager", prompt: null,
  });

  const updated = withFrozenClock(editMoment, () => svc.updateScheduleAsManager("mgrS", scheduleId, { cron: newCron }));
  const expectedFromNow = nextFireAt(newCron, editMoment);
  const buggyFromStale = nextFireAt(newCron, new Date(staleFutureNextFireAt));

  check("(2) recompute matches a direct nextFireAt(cron, now) call", updated.nextFireAt === expectedFromNow);
  check("(2) recompute does NOT match the from=stale-value basis", updated.nextFireAt !== buggyFromStale);
  check("(2) recompute lands strictly before the stale (24h-out) basis", new Date(updated.nextFireAt).getTime() < new Date(staleFutureNextFireAt).getTime());

  const secondEditMoment = new Date(editMoment.getTime() + 30_000);
  const secondCron = "*/7 * * * *";
  const updated2 = withFrozenClock(secondEditMoment, () => svc.updateScheduleAsManager("mgrS", scheduleId, { cron: secondCron }));
  check("(2) a second cron edit re-anchors to its own now, not the prior edit's next_fire_at", updated2.nextFireAt === nextFireAt(secondCron, secondEditMoment));

  const beforeToggle = db.getSchedule(scheduleId)?.nextFireAt;
  const toggled = svc.updateScheduleAsManager("mgrS", scheduleId, { enabled: false });
  check("(2) an enabled-only update leaves next_fire_at untouched", toggled.nextFireAt === beforeToggle);
  const prompted = svc.updateScheduleAsManager("mgrS", scheduleId, { prompt: "custom prompt" });
  check("(2) a prompt-only update leaves next_fire_at untouched", prompted.nextFireAt === beforeToggle);
}

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — schedule_update's cron-change recompute anchors to the edit moment (now), never the stale pre-edit next_fire_at, including the literal local/UTC-boundary case reported live; non-cron patches leave next_fire_at untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
