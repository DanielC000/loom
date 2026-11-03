// Card dfef375f round 4 item 2: a FRESH `Live` must clear the durable `rate_limit_bailed_at` marker (if
// any) — a new pty is never suppressed, but the DB-side "needs a human" marker from a PRIOR bailed
// episode survives independently of the in-memory `Live` unless something clears it. `onExit` already
// clears it (index.ts), but `onExit` never fires for a daemon RESTART — the predecessor pty's process is
// simply gone, with no exit event ever delivered to this daemon's own event handlers. Without this fix, a
// crash-then-resume (or a boot-reconcile resume) leaves the stale marker in place, and the per-session
// "Clear & retry" action would then replay `live.lastPrompt` into what is now an ordinary, healthy,
// never-actually-rate-limited session (decision 81f9c887's hazard — its own `live.busy` guard can't catch
// this, since a fresh resume is genuinely idle).
//
// This drives the REAL `PtyHost.spawn()` chokepoint (claude branch) against a FAKE pty injected via the
// createPty() seam, wiring `events.onFreshLive` exactly as index.ts wires it in production
// (`db.setRateLimitBailedAt(sessionId, null)`) — proving the WIRING CONTRACT: PtyHost actually fires the
// event at the chokepoint every spawn/resume/fork/recycle passes through, not just that the DB call
// itself works (that part is a one-line `Db` method with no logic to prove).
//
// No real claude, no daemon, no network.
//
// Run: 1) build (turbo builds shared first), 2) node test/rate-limit-bailed-at-fresh-live-clear.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rlbailfresh-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { bailRateLimitEpisode } = await import("../dist/orchestration/rate-limit-bail.js");

class TestPtyHost extends createSeamHost(PtyHost) {}

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });

// Mirrors index.ts's REAL production wiring byte-for-byte (see PtyHostEvents.onFreshLive's own doc).
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onFreshLive(sessionId) { db.setRateLimitBailedAt(sessionId, null); },
};
const host = new TestPtyHost(events);

const SID = "sess-rlbail-fresh";
db.insertSession({
  id: SID, projectId: "p", agentId: "t", engineSessionId: "engine-sid-rlbail-fresh", title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
});

try {
  // ═══ FIRST SPAWN (the session's original boot) ═══
  host.spawn({
    sessionId: SID, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  check("setup: the first spawn used the injected fake pty (no real claude)", host.isAlive(SID) === true);

  // ═══ THE INCIDENT: the SAME shared helper both real bail call sites use ═══
  bailRateLimitEpisode(db, host, SID, "test: usage limit not cleared — auto-resume abandoned", { reason: "loop_breaker" });
  const bailedRow = db.getSession(SID);
  check("setup: the bail stamped the durable marker", typeof bailedRow.rateLimitBailedAt === "string" && bailedRow.rateLimitBailedAt.length > 0);

  // ═══ THE DAEMON RESTART: the predecessor pty's process is simply gone — no onExit ever fires for it.
  // A fresh boot-reconcile resume calls PtyHost.spawn() again for the SAME session id, exactly like this
  // one call (never anything that routes through onExit's own clear). ═══
  host.spawn({
    sessionId: SID, cwd: tmpHome, resumeId: "engine-sid-rlbail-fresh",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  check("setup: the resume spawn is alive too (fresh Live, no onExit in between)", host.isAlive(SID) === true);

  // THE REGRESSION PROOF: the fresh Live's own onFreshLive call must have cleared the marker.
  const resumedRow = db.getSession(SID);
  check(
    "FRESH LIVE: the durable rate_limit_bailed_at marker is cleared by the resume alone (no onExit, no human clear)",
    resumedRow.rateLimitBailedAt === null,
  );
  // The attention-queue AUTO-RESUME ABANDONED row (packages/web/src/lib/attention.ts) keys directly on
  // this same `isBailed` predicate (`!!s.rateLimitBailedAt`) — the cleared marker above IS the row
  // disappearing; nothing further to assert on the daemon side.
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a fresh Live (resume/fork/recycle, mirroring a daemon-restart boot-reconcile resume with no onExit in between) clears the durable rate_limit_bailed_at marker at the ONE chokepoint every spawn passes through, so a crash-then-resume can never leave a stale AUTO-RESUME ABANDONED row behind."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
