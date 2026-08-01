import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Regression test for card 02baa3a5 — "upgradeCompanionCapabilities drops logicalId + both age fields at
// TWO call sites needing OPPOSITE fixes".
//
// SessionService.upgradeCompanionCapabilities (service.ts) has TWO enqueueStdin call sites that carry a
// captured QueuedMessage's fields back onto a session, and they want OPPOSITE treatment of mintedAtGen:
//
//   - Site A (service.ts ~2386, the ABORT path): reached only when the OLD pty never dies within the
//     graceful+hard stop bound. Followed IMMEDIATELY by a throw — `resume()` is NEVER reached. Entries
//     go back onto the SAME, still-alive pty: no boundary crossed, submitGeneration never resets, so
//     mintedAtGen is STILL VALID evidence and must SURVIVE.
//   - Site B (service.ts ~2410-2416, the POST-resume() redeliver loop): reached only AFTER resume() has
//     returned a session backed by a BRAND-NEW Live (submitGeneration restarts at 0). A carried
//     mintedAtGen would be compared against an unrelated counter — a unit error, not evidence — so it
//     must be DELIBERATELY OMITTED, exactly like carryPendingToSuccessor (card 1c47454b) treats the same
//     kind of boundary. mintedAtWallClock (an absolute Date.now(), boundary-independent) survives at BOTH
//     sites.
//
// Both sites also dropped `logicalId` (the 4a0af485 survives-every-requeue-or-re-mint invariant) — this
// file proves it now survives at BOTH sites (same treatment, no boundary relevance).
//
// A test that asserted the SAME thing at both sites would be testing the bug (see the card) — the two
// blocks below deliberately assert OPPOSITE outcomes for mintedAtGen.
//
// Site A is driven with a "never dies" fake pty (kill() never fires its exit callback) so the abort path
// fires deterministically — this rides service.ts's own fixed (non-configurable) 80+20 x 100ms die-wait
// loops, so this block genuinely costs ~10s of real wall time; there is no faster way to reach that path
// without changing production code. Site B is driven with the ORDINARY SeamHost (real onExit wiring) with
// the graceful-stop escalation env-shrunk (same knobs companion-live-upgrade.mjs already uses) so the pty
// dies fast and resume() actually runs.
//
// Run: 1) build daemon, 2) node test/companion-upgrade-carry-opposite-sites.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cuops-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Shrink graceful-stop escalation (read once at pty/host.js import time) and the busy-wait bound (read
// once at sessions/service.js import time) — same knobs companion-live-upgrade.mjs uses. These only
// affect Site B (Site A's fake pty never dies regardless of these timers).
process.env.LOOM_GRACEFUL_GAP_MS = "50";
process.env.LOOM_GRACEFUL_RETRY_MS = "150";
process.env.LOOM_GRACEFUL_KILL_MS = "300";
process.env.LOOM_UPGRADE_BUSY_WAIT_MS = "300";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const mkFleet = (db, label) => {
  const projId = randomUUID();
  db.insertProject({ id: projId, name: `CUOps ${label}`, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
  const profileId = randomUUID();
  db.insertProfile({
    id: profileId, name: `CUOps ${label}`, role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null,
    browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, connections: [], capabilities: [],
  });
  const agentId = randomUUID();
  db.insertAgent({ id: agentId, projectId: projId, name: `CUOps ${label}`, startupPrompt: "", position: 0, profileId, endpoint: false, ioSchema: null });
  const sessionId = randomUUID();
  const engineId = `eng-cuops-${label}-${sfx}`;
  const cwd = path.join(tmpHome, `cwd-${label}`);
  fs.mkdirSync(cwd, { recursive: true });
  db.insertSession({
    id: sessionId, projectId: projId, agentId, engineSessionId: engineId, title: null, cwd,
    processState: "starting", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "assistant", browserTesting: false, documentConversion: false, restrictedTools: false,
    noCommit: false, skills: null, connections: [], capabilities: [],
  });
  const tpath = engineTranscriptPath(cwd, engineId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hello" } }) + "\n");
  return { sessionId, engineId, cwd, agentId, projId };
};

// ===================== SITE A — the ABORT path: the OLD pty NEVER dies =====================
{
  console.log("\n--- Site A (abort path): never-dies pty ---");
  class NeverDiesHost extends createSeamHost(PtyHost) {
    constructor(events) { super(events); this.capture = []; }
    createPty(opts) {
      this.capture.push(opts);
      const base = super.createPty(opts);
      // kill() deliberately never invokes its exit callback — simulates a wedged process that ignores
      // both Ctrl-C and a hard kill, so isAlive() stays true forever and the abort path fires.
      return { ...base, kill() { /* never exits */ } };
    }
  }
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const host = new NeverDiesHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());
  const { sessionId, engineId, cwd } = mkFleet(db, "sitea");

  db.setProcessState(sessionId, "starting");
  host.spawn({
    sessionId, cwd, permission: { allow: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 },
    resumeId: engineId, role: "assistant", browserTesting: false, documentConversion: false,
    capabilities: [], restrictedTools: false, skills: null,
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });

  const primer = host.enqueueStdin(sessionId, "PRIMER_TURN", "system");
  check("(A) setup: primer turn submits immediately (arms busy)", primer.delivered === true);
  check("(A) setup: session is BUSY before the upgrade starts", host.isBusy(sessionId) === true);

  const MINTED_GEN = 47;
  const MINTED_WALLCLOCK = Date.now() - 90_000;
  const queued = host.enqueueStdin(
    sessionId, "SITE_A_TARGET: still-alive carry", "system", undefined, undefined, "agent",
    undefined, undefined, undefined, undefined, undefined, undefined, "logical-site-a",
    MINTED_GEN, MINTED_WALLCLOCK,
  );
  check("(A) setup: the target message QUEUES behind the busy primer turn", queued.delivered === false && queued.reason === "held");

  let threw = null;
  const t0 = performance.now();
  try { await svc.upgradeCompanionCapabilities(sessionId); } catch (e) { threw = e; }
  const elapsedMs = performance.now() - t0;
  console.log(`    (Site A wait: ${Math.round(elapsedMs)}ms — rides service.ts's fixed die-wait loops)`);

  check("(A) upgrade ABORTS (throws) when the old pty never dies", threw instanceof Error && /did not stop in time/.test(threw.message));
  check("(A) never reached resume(): no second pty.spawn happened (only the initial setup spawn)", host.capture.length === 1);

  const pendingAfter = host.getPendingEntries(sessionId);
  const gotAge = pendingAfter.find((m) => m.text === "SITE_A_TARGET: still-alive carry");
  check("(A) THE FIX: the target entry is pushed back onto the SAME (still-alive) pty", !!gotAge);
  check("(A) THE FIX: mintedAtGen SURVIVES — same session, same counter, no boundary crossed", gotAge?.mintedAtGen === MINTED_GEN);
  check("(A) THE FIX: mintedAtWallClock also survives", gotAge?.mintedAtWallClock === MINTED_WALLCLOCK);

  const flushed = host.flushPending(sessionId);
  const gotId = flushed.find((m) => m.text === "SITE_A_TARGET: still-alive carry");
  check("(A) THE FIX: logicalId SURVIVES the abort-path requeue", gotId?.logicalId === "logical-site-a");

  db.close();
}

// ===================== SITE B — the POST-resume() redeliver loop: the OLD pty DOES die =====================
{
  console.log("\n--- Site B (post-resume redeliver): pty dies, resume() runs ---");
  class DiesHost extends createSeamHost(PtyHost) {}
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const host = new DiesHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());
  const { sessionId, engineId, cwd } = mkFleet(db, "siteb");

  db.setProcessState(sessionId, "starting");
  host.spawn({
    sessionId, cwd, permission: { allow: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 },
    resumeId: engineId, role: "assistant", browserTesting: false, documentConversion: false,
    capabilities: [], restrictedTools: false, skills: null,
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });

  const primer = host.enqueueStdin(sessionId, "PRIMER_TURN", "system");
  check("(B) setup: primer turn submits immediately (arms busy)", primer.delivered === true);
  check("(B) setup: session is BUSY before the upgrade starts", host.isBusy(sessionId) === true);

  const MINTED_GEN = 47;
  const MINTED_WALLCLOCK = Date.now() - 90_000;
  const queued = host.enqueueStdin(
    sessionId, "SITE_B_TARGET: post-resume carry", "system", undefined, undefined, "agent",
    undefined, undefined, undefined, undefined, undefined, undefined, "logical-site-b",
    MINTED_GEN, MINTED_WALLCLOCK,
  );
  check("(B) setup: the target message QUEUES behind the busy primer turn", queued.delivered === false && queued.reason === "held");

  const upgraded = await svc.upgradeCompanionCapabilities(sessionId);
  check("(B) upgrade SUCCEEDS (the old pty died in time, resume() ran)", upgraded.id === sessionId && upgraded.engineSessionId === engineId);

  const pendingAfter = host.getPendingEntries(sessionId);
  const gotAge = pendingAfter.find((m) => m.text === "SITE_B_TARGET: post-resume carry");
  check("(B) THE FIX: the target entry was redelivered onto the FRESH (resumed) pty", !!gotAge);
  check("(B) THE FIX: mintedAtWallClock SURVIVES the boundary (absolute clock, no unit mismatch)", gotAge?.mintedAtWallClock === MINTED_WALLCLOCK);
  check(
    "(B) THE FIX: mintedAtGen is DELIBERATELY ABSENT — a fresh Live's submitGeneration restarts at 0; carrying 47 across would be a unit error, not evidence (OPPOSITE of Site A's assertion above)",
    gotAge?.mintedAtGen === undefined,
  );

  const flushed = host.flushPending(sessionId);
  const gotId = flushed.find((m) => m.text === "SITE_B_TARGET: post-resume carry");
  check("(B) THE FIX: logicalId SURVIVES the post-resume redeliver too (same treatment as Site A — no boundary relevance)", gotId?.logicalId === "logical-site-b");

  db.close();
}

for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — upgradeCompanionCapabilities carries logicalId at BOTH call sites; mintedAtWallClock at BOTH; and mintedAtGen SURVIVES at the never-resumed abort path (Site A, no boundary crossed) while it is DELIBERATELY OMITTED at the post-resume() redeliver loop (Site B, a fresh Live's submitGeneration boundary) — the two sites' opposite treatment, both proven against the real PtyHost queue via getPendingEntries/flushPending, not assumed from the call site alone."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
