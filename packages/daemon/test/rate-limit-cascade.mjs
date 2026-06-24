// Rate-limit lifecycle durable-fix test (card 759697c2) — FULLY HERMETIC: no live daemon, no real
// claude. Builds the real Fastify gateway in-process (buildServer) against a temp Db + a STUB pty, and
// covers the two durable fixes for stale RATE-LIMITED entries lingering in the Attention queue:
//
//   A. CASCADE — POST /api/usage/clear-hold now clears the global latch AND, for EVERY session parked
//      with rate_limited_until, runs the per-session clear (setRateLimitedUntil(null) +
//      clearRateLimitDeadline) and RESUMES the LIVE ones (resumeAfterRateLimit). Scope: the clear hits
//      every parked row (live or stale-exited); the resume is LIVE-only. So clearing the hold
//      auto-clears the flags AND re-submits the held turns — the user never retries each by hand.
//   B. CLEAR-ON-EXIT — an exited/terminal session must never read RATE-LIMITED. The onExit hook
//      (index.ts) clears the park columns via db.clearRateLimit, WITHOUT clobbering lastError. This
//      test mirrors onExit's rate-limit-relevant sequence and asserts the row is no longer rate-limited
//      while its lastError survives.
//
// RUN (self-isolating; sets its OWN temp LOOM_HOME before importing dist):
//   1) build the daemon, 2) node test/rate-limit-cascade.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rlcascade-${Date.now()}`);
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

const future = new Date(Date.now() + 60 * 60_000).toISOString();   // parked 1h out
const deadline = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
const seedParked = (id, state, lastError = `usage limit — resumes ${future}`) => {
  db.insertSession({ id, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
    processState: state, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
  db.setRateLimitedUntil(id, future, lastError);
  db.armRateLimitDeadline(id, deadline);
};

// STUB pty mirroring PtyHost.resumeAfterRateLimit's contract: re-submit only when live → false otherwise.
const alive = new Set();
const resumed = [];
const pty = { isAlive: (id) => alive.has(id), resumeAfterRateLimit: (id) => { if (!alive.has(id)) return false; resumed.push(id); return true; } };
const stub = {};
const app = await buildServer({ db, pty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });

try {
  // ════════ A. CASCADE: clear-hold clears + resumes ALL rate-limited LIVE sessions ════════
  // Two LIVE parked sessions, one EXITED parked session (stale), one LIVE unparked session.
  seedParked("live1", "live");
  seedParked("live2", "live");
  seedParked("dead1", "exited"); // a stale parked row that pre-dates clear-on-exit — must clear, never resume
  db.insertSession({ id: "free", projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
  alive.add("live1"); alive.add("live2"); alive.add("free");

  check("A: listRateLimited returns exactly the three parked rows", db.listRateLimited().map((s) => s.id).sort().join(",") === "dead1,live1,live2");

  recordClaudeRateLimit(); // lay the global latch the cascade must drop
  check("A: latch file present before clear-hold", fs.existsSync(LATCH));

  const r = await app.inject({ method: "POST", url: "/api/usage/clear-hold" });
  check("A: 200 OK", r.statusCode === 200);
  check("A: body { cleared:true, resumed:2 } — both LIVE parked sessions resumed", r.json().cleared === true && r.json().resumed === 2);
  check("A: GLOBAL latch file removed", !fs.existsSync(LATCH));

  // Every parked row's park + deadline are cleared (live AND the stale-exited one).
  for (const id of ["live1", "live2", "dead1"]) {
    const s = db.getSession(id);
    check(`A: ${id} park column cleared (rateLimitedUntil null)`, s.rateLimitedUntil === null);
    check(`A: ${id} episode deadline cleared (rateLimitDeadline null)`, s.rateLimitDeadline === null);
  }
  check("A: held turn re-submitted on EACH live parked session (resumeAfterRateLimit per live session)",
    resumed.length === 2 && resumed.includes("live1") && resumed.includes("live2"));
  check("A: the EXITED parked session was NOT resumed (resume scoped to LIVE)", !resumed.includes("dead1"));
  check("A: the unparked LIVE session was untouched + not resumed", db.getSession("free").processState === "live" && !resumed.includes("free"));
  check("A: listRateLimited is now empty (nothing left parked)", db.listRateLimited().length === 0);

  // ════════ B. CLEAR-ON-EXIT: an exited session never appears rate-limited; lastError survives ════════
  // A LIVE parked session carrying a meaningful lastError (e.g. a banner the attention surface keys off).
  seedParked("exiter", "live", "[loom:crash-loop] died repeatedly");
  const before = db.getSession("exiter");
  check("B: pre-exit — parked with a FUTURE rate_limited_until (would read RATE-LIMITED)",
    before.rateLimitedUntil !== null && new Date(before.rateLimitedUntil).getTime() > Date.now());

  // Mirror index.ts onExit's rate-limit-relevant sequence EXACTLY (setProcessState → setBusy → clearRateLimit).
  db.setProcessState("exiter", "exited");
  db.setBusy("exiter", false);
  db.clearRateLimit("exiter");

  const after = db.getSession("exiter");
  check("B: post-exit — rate_limited_until cleared (never reads RATE-LIMITED again)", after.rateLimitedUntil === null);
  check("B: post-exit — rate_limit_deadline cleared too", after.rateLimitDeadline === null);
  check("B: post-exit — processState is exited", after.processState === "exited");
  check("B: clear-on-exit PRESERVES lastError (only the two park columns are touched)", after.lastError === "[loom:crash-loop] died repeatedly");
} finally {
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(LOOM, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — clear-hold CASCADES (clears every parked row's park+deadline, drops the global latch, re-submits the held turn on EACH live parked session, never resumes a non-live one); clear-on-exit clears the park columns (so an exited session never reads RATE-LIMITED) while preserving lastError."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
