// Manual rate-limit OVERRIDE test (Task bce83649) — FULLY HERMETIC: no live daemon, no real claude.
// Builds the real Fastify gateway in-process (buildServer) against a temp Db + a STUB pty, and drives
// the two new HUMAN-only REST routes via app.inject() (no port bound, so it can NEVER touch :4317):
//   A. POST /api/sessions/:id/rate-limit/clear — MIRRORS RateLimitWatcher.resume(): clears the park
//      (rate_limited_until) AND the episode deadline (rate_limit_deadline), drops the GLOBAL usage
//      latch, and re-submits the held turn on a LIVE session (stub pty records the call). 404 unknown.
//      No-op-safe + still clears on a NON-live session (resume returns false — fine).
//   B. POST /api/usage/clear-hold — drops the global latch and CASCADES to parked sessions; here, by
//      section B, no session is left parked (A cleared them), so it touches no row. The cascade itself
//      (clears + resumes every parked LIVE session) is covered in rate-limit-cascade.mjs.
//
// RUN (self-isolating; sets its OWN temp LOOM_HOME before importing dist):
//   1) build the daemon, 2) node test/rate-limit-clear.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rlclear-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const LOOM = process.env.LOOM_HOME;
const LATCH = path.join(LOOM, "tmp", "claude-usage.json"); // the global awareness file (usage-awareness.ts)

// Import dist AFTER LOOM_HOME is set (paths.ts reads it at module-eval time).
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { recordClaudeRateLimit } = await import("../dist/orchestration/usage-awareness.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(LOOM, "loom.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });

// A LIVE parked session and an EXITED (not-live) parked session.
const seedParked = (id, state) => {
  db.insertSession({ id, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
    processState: state, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
  const until = new Date(Date.now() + 60 * 60_000).toISOString();    // parked 1h out
  const deadline = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
  db.setRateLimitedUntil(id, until, `usage limit — resumes ${until}`);
  db.armRateLimitDeadline(id, deadline);
};
seedParked("live", "live");
seedParked("dead", "exited");
// An unparked LIVE session (no-op-safe path).
db.insertSession({ id: "free", projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });

// STUB pty mirroring PtyHost.resumeAfterRateLimit's contract: re-submit only when live → returns false otherwise.
const alive = new Set(["live", "free"]);
const resumed = [];
const pty = { isAlive: (id) => alive.has(id), resumeAfterRateLimit: (id) => { if (!alive.has(id)) return false; resumed.push(id); return true; } };

// Other deps are never touched by these two routes (handlers reference them lazily) — bare stubs suffice.
const stub = {};
const app = await buildServer({ db, pty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });

try {
  // ════════ A. per-session clear + retry (LIVE) ════════
  recordClaudeRateLimit(); // lay the global latch the clear must drop
  check("A: latch file present before clear", fs.existsSync(LATCH));
  const r = await app.inject({ method: "POST", url: "/api/sessions/live/rate-limit/clear" });
  check("A: 200 OK", r.statusCode === 200);
  const body = r.json();
  check("A: response session park cleared (rateLimitedUntil null)", body.rateLimitedUntil === null);
  check("A: response session deadline cleared (rateLimitDeadline null)", body.rateLimitDeadline === null);
  const live = db.getSession("live");
  check("A: DB park column cleared", live.rateLimitedUntil === null);
  check("A: DB episode deadline column cleared", live.rateLimitDeadline === null);
  check("A: DB lastError cleared (mirrors resume's null)", live.lastError === null);
  check("A: GLOBAL latch file removed", !fs.existsSync(LATCH));
  check("A: held turn re-submitted on the LIVE session (pty.resumeAfterRateLimit called)", resumed.length === 1 && resumed[0] === "live");

  // ════════ unknown session → 404 ════════
  const r404 = await app.inject({ method: "POST", url: "/api/sessions/nope/rate-limit/clear" });
  check("A: unknown session → 404", r404.statusCode === 404);

  // ════════ NON-live parked session: still clears both columns; resume is a no-op (returns false) ════════
  recordClaudeRateLimit();
  const rd = await app.inject({ method: "POST", url: "/api/sessions/dead/rate-limit/clear" });
  check("A: 200 OK on a non-live parked session", rd.statusCode === 200);
  const dead = db.getSession("dead");
  check("A: non-live park + deadline cleared anyway", dead.rateLimitedUntil === null && dead.rateLimitDeadline === null);
  check("A: non-live session NOT resumed (resumeAfterRateLimit returned false)", !resumed.includes("dead"));
  check("A: latch dropped on the non-live clear too", !fs.existsSync(LATCH));

  // ════════ no-op-safe on a session that was never parked ════════
  const rf = await app.inject({ method: "POST", url: "/api/sessions/free/rate-limit/clear" });
  check("A: no-op-safe — unparked session → 200, columns stay null", rf.statusCode === 200 && db.getSession("free").rateLimitedUntil === null && db.getSession("free").rateLimitDeadline === null);

  // ════════ B. global hold clear — drops the latch; nothing parked here → touches NO session ════════
  recordClaudeRateLimit();
  check("B: latch present before clear-hold", fs.existsSync(LATCH));
  const rh = await app.inject({ method: "POST", url: "/api/usage/clear-hold" });
  check("B: 200 OK { cleared:true, resumed:0 } — nothing left parked to cascade", rh.statusCode === 200 && rh.json().cleared === true && rh.json().resumed === 0);
  check("B: GLOBAL latch file removed", !fs.existsSync(LATCH));
  check("B: no session row touched (live still clear, free still live)", db.getSession("live").rateLimitedUntil === null && db.getSession("free").processState === "live");
} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(LOOM, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — per-session clear mirrors resume() (clears park + deadline + lastError, drops the global latch, re-submits the held turn on a live session, no-ops a dead one, 404s an unknown id); global clear-hold drops the latch alone."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
