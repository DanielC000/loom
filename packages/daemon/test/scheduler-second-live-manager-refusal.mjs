import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0368c784 — one of the callers that now gets a SecondLiveManagerError from startManager is the
// Scheduler's own periodic manager spawn (index.ts wires `startManager: (agentId, prompt, opts) =>
// sessions.startManager(...)`). The Scheduler already has a per-schedule try/catch (card 0ad1ca68's own
// finding 2 area, see scheduler.ts's own doc) that logs a thrown spawn as a durable schedule_fire_failed
// event, claims the slot, and leaves the schedule ENABLED — unchanged production code, no new wiring
// needed. This test proves that existing machinery correctly absorbs the NEW error type end to end, with
// the REAL SessionService/SecondLiveManagerError (not a fake stub throwing a generic Error, as
// scheduler-fire-failed.mjs already covers for the generic case):
//   (1) a schedule whose agent already has a LIVE manager fires, throws SecondLiveManagerError, and the
//       Scheduler logs it as a schedule_fire_failed event (never crashes the tick).
//   (2) the pre-existing live manager is COMPLETELY UNTOUCHED (still the same id, still live) — "the
//       daemon is fine".
//   (3) the schedule stays ENABLED and its slot is still claimed (next_fire_at advanced) — a refusal is
//       a transient condition, not a permanent cadence kill.
//   (4) NO second session row was created for the agent.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + SessionService + Scheduler driven
// against a FAKE pty (createPty()/isAlive() seam, same shape as second-live-manager-refusal.mjs).
//
// Run: 1) build (turbo builds shared first), 2) node test/scheduler-second-live-manager-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-sched-2ndmgr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { Scheduler } = await import("../dist/orchestration/scheduler.js");

const repo = path.join(os.tmpdir(), `loom-sched-2ndmgr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# scheduler-second-live-manager-refusal test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=ssm@loom -c user.name=ssm");

const now = new Date().toISOString();
const db = new Db();

class SeamHost extends createSeamHost(PtyHost) {
  aliveIds = new Set();
  createPty(opts, hookToken, mcpToken) { this.aliveIds.add(opts.sessionId); return super.createPty(opts, hookToken, mcpToken); }
  stop(id) { this.aliveIds.delete(id); }
  isAlive(id) { return this.aliveIds.has(id); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pSched", name: "Sched Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentSched", projectId: "pSched", name: "Sched", startupPrompt: "MGR", position: 0, profileId: null });

try {
  // Pre-existing LIVE manager for the scheduled agent — the real scenario the card describes.
  const existing = svc.startManager("agentSched");
  check("(setup) a manager is already live for agentSched", existing.processState === "live" && host.isAlive(existing.id));

  const scheduler = new Scheduler({
    db, control: new OrchestrationControl(),
    startManager: (agentId, prompt, opts) => svc.startManager(agentId, prompt, opts),
  });
  db.insertSchedule({
    id: "schSecondMgr", agentId: "agentSched", cron: "*/5 * * * *", enabled: true,
    nextFireAt: new Date(Date.now() - 60_000).toISOString(), lastFiredAt: null, createdAt: now,
  });
  const beforeTick = new Date();
  await scheduler.tick(beforeTick);

  // (1) the Scheduler's own try/catch absorbed the SecondLiveManagerError as a durable failure event.
  const evs = db.listEvents("").filter((e) => e.kind === "schedule_fire_failed");
  check("(1) the scheduled fire records exactly one schedule_fire_failed event (never crashes the tick)",
    evs.length === 1);
  check("(1b) its detail carries the SecondLiveManagerError's own message, naming the live holder",
    typeof evs[0]?.detail?.error === "string" && evs[0].detail.error.includes(existing.id));

  // (2) the pre-existing live manager is completely untouched — "the daemon is fine".
  check("(2) the pre-existing manager is UNTOUCHED — same id, still live",
    db.getSession(existing.id)?.id === existing.id && db.getSession(existing.id)?.processState === "live");

  // (3) the schedule stays enabled and its slot is still claimed.
  const sched = db.getSchedule("schSecondMgr");
  check("(3) the schedule stays ENABLED after a refused fire", sched.enabled === true);
  check("(3b) the slot is still claimed (next_fire_at advanced despite the refusal)",
    new Date(sched.nextFireAt).getTime() > beforeTick.getTime());

  // (4) no second session row was created for the agent.
  check("(4) NO second session row exists for agentSched (exactly one, the pre-existing manager)",
    db.listSessions("agentSched").length === 1);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a scheduled manager spawn whose agent already has a live manager is refused via SecondLiveManagerError, absorbed cleanly by the Scheduler's existing per-schedule try/catch (logged as schedule_fire_failed, schedule stays enabled, slot still claimed), the pre-existing manager is untouched, and no second session row is created."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
