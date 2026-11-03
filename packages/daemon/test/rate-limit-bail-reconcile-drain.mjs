// Card dfef375f round 2 item 1 (CRITICAL): a bail must NOT clear PtyHost's in-memory `live.rateLimited`
// flag. Round 1's own fix did exactly that (a now-removed `clearRateLimitedFlag`), which let the ~10s
// reconcile timer drain the held queue into the still-capped account and start a fresh episode instead
// of leaving the session genuinely suppressed until a human cleared it — a regression against decision
// sha:c6338ae1's own "Do not" (never clear `live.rateLimited` anywhere except the start of
// `resumeAfterRateLimit`).
//
// This drives the REAL host path end to end: park (a StopFailure) -> bail (via `bailRateLimitEpisode`,
// the SAME shared helper BOTH real bail call sites — index.ts's loop breaker and
// RateLimitWatcher.bail() — now use) -> reconcile() -> the held queue must stay held exactly as it did
// while still parked. Only an explicit `resumeAfterRateLimit` may unstick it (the positive control,
// proving the check above discriminates rather than passing vacuously).
//
// Exercises the real PtyHost state machine (submit/enqueueStdin/deliverHook/drainPending/reconcile/
// resumeAfterRateLimit) against a FAKE pty injected via the createPty() seam, plus a REAL temp SQLite Db
// — no real claude, no daemon, no network. Sibling to pty-rate-limit-park-drain.mjs (which proves the
// ordinary park-survives-reconcile case this test's BAIL case is the round-2 companion of).
//
// RUN (no daemon needed): node test/rate-limit-bail-reconcile-drain.mjs
//   Requires the daemon built first (reads ../dist/*): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE
// importing host.js — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-rlbail-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { bailRateLimitEpisode } = await import("../dist/orchestration/rate-limit-bail.js");

const fakes = [];
function makeFakePty(base) {
  const writes = [];
  const fake = { ...base, write: (d) => { writes.push(d); }, writes };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) { return makeFakePty(super.createPty(opts)); }
}

const busyLog = [];
const rateLimitedLog = [];
const events = {
  onEngineSessionId() {},
  onBusy(_id, busy) { busyLog.push(busy); },
  onContextStats() {},
  onRateLimited(id, until, detail) { rateLimitedLog.push({ id, until, detail }); },
  onExit() {},
};
const host = new TestPtyHost(events);

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);
const SID = "sess-rlbail";
const now = new Date().toISOString();
db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });
db.insertSession({
  id: SID, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
});

const KILLED = "INTERRUPTED_TURN";
const MSG1 = "[loom:from-manager]\nQUEUED_ONE";
const PASTE_START = "\x1b[200~";

host.spawn({
  sessionId: SID, cwd: tmpHome,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
const fake = fakes[0];
check("setup: spawn used the injected fake pty (no real claude)", !!fake && host.isAlive(SID) === true);
const written = () => fake.writes.join("");
const countOf = (m) => written().split(m).length - 1;

host.deliverHook(SID, { hook_event_name: "SessionStart" });

try {
  const rp = host.enqueueStdin(SID, KILLED);
  check("setup: the to-be-killed turn submitted immediately (busy armed)", rp.delivered === true);
  await new Promise((r) => setTimeout(r, 120)); // flush the async paste-end + Enter before measuring new work

  const r1 = host.enqueueStdin(SID, MSG1, "system");
  check("setup: MSG1 queued behind the busy turn", r1.delivered === false && r1.position === 1);

  const pasteBaseline = countOf(PASTE_START);

  // ═══════════════ THE PARK: a StopFailure rate_limit hook parks the session ═══════════════
  host.deliverHook(SID, { hook_event_name: "StopFailure", error: "rate_limit" });
  check("PARK: onRateLimited fired exactly once", rateLimitedLog.length === 1 && rateLimitedLog[0].id === SID);
  check("PARK: the held queue was NOT drained (still [MSG1])", JSON.stringify(host.getPending(SID)) === JSON.stringify([MSG1]));

  // ═══════════════ THE BAIL: the SAME shared helper both real call sites use ═══════════════
  bailRateLimitEpisode(db, host, SID, "test: usage limit not cleared — auto-resume abandoned", { reason: "loop_breaker" });
  const row = db.getSession(SID);
  check("BAIL: DB park columns cleared (rateLimitedUntil + rateLimitDeadline both null)",
    row.rateLimitedUntil === null && row.rateLimitDeadline === null);
  const bailed = db.listOrchestrationEventsBounded({ kind: ["rate_limit_bailed"], sessionId: SID, limit: 10, offset: 0 });
  check("BAIL: rate_limit_bailed recorded exactly once", bailed.total === 1);

  // ═══ THE CRITICAL FIX (round 2 item 1): the bail above must NOT have touched live.rateLimited ═══
  // If it had (round 1's own regression), this reconcile would drain the held queue straight into the
  // DB-cleared-but-still-in-memory-capped session, exactly the bug a Code Review caught.
  host.reconcile();
  check("BAIL->RECONCILE: the held queue was NOT drained (still [MSG1]) — the session stays suppressed",
    JSON.stringify(host.getPending(SID)) === JSON.stringify([MSG1]));
  check("BAIL->RECONCILE: no new submit (the reconcile drain stayed suppressed)", countOf(PASTE_START) === pasteBaseline);
  check("BAIL->RECONCILE: busy stayed false (no turn was started by the reconcile)", busyLog[busyLog.length - 1] === false);

  // ═══ POSITIVE CONTROL: only resumeAfterRateLimit (decision sha:c6338ae1's sole clear site) unsticks it ═══
  // Proves the checks above actually discriminate — they are not vacuously true because NOTHING can
  // ever unstick this session.
  const ok = host.resumeAfterRateLimit(SID);
  check("RESUME: resumeAfterRateLimit returns true (live session)", ok === true);
  check("RESUME: exactly one new submit (the replay)", countOf(PASTE_START) === pasteBaseline + 1);
  await new Promise((r) => setTimeout(r, 120));
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("RESUME->STOP: the held queue finally drained (pending empty)", host.getPending(SID).length === 0);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — bailRateLimitEpisode (the shared helper both real bail call sites use) never touches PtyHost's in-memory rateLimited flag; the held queue survives a reconcile tick after a bail exactly as it does while still parked, and only resumeAfterRateLimit can unstick it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
