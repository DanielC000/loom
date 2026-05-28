// Usage-limit RESUME test (PR #19c-b). Deterministic — NO real cap; a short park is synthesized.
//   PART 1 (hermetic, in-process; no daemon, no claude): the RateLimitWatcher state machine driven
//     with a STUB pty + a real temp Db — resume / wait / stopped-not-resumed / deadline-bail /
//     recovering-success / recovering-wait / re-cap-preserves-deadline / awareness-cleared.
//   PART 2 (live, real claude): a warmed session is parked via a synthetic StopFailure with a ~2s
//     reset; the daemon's ALWAYS-ON watcher resumes it (re-submits the held turn → busy re-arms).
//
// RUN against a fresh isolated LOOM_HOME daemon. PART 2 needs a SHORT watcher tick:
//   1) LOOM_HOME=<temp> LOOM_RATE_LIMIT_WATCH_INTERVAL_MS=1000 node dist/index.js
//   2) LOOM_HOME=<temp> node test/usage-limit-resume.mjs        (SAME LOOM_HOME)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { Db } from "../dist/db.js";
import { RateLimitWatcher } from "../dist/orchestration/rate-limit-watcher.js";
import { detectUsageLimit, rateLimitedUntil, rateLimitDeadline } from "../dist/orchestration/usage-limit.js";
import { recordClaudeRateLimit, isLikelyNearClaudeUsageLimit } from "../dist/orchestration/usage-awareness.js";
import { writeJsonAtomic } from "../dist/pty/claude-config.js";

const BASE = "http://127.0.0.1:4317";
const LOOM = process.env.LOOM_HOME;
if (!LOOM) { console.error("LOOM_HOME must be set (and match the daemon's)."); process.exit(2); }
const USAGE_FILE = path.join(LOOM, "tmp", "claude-usage.json");
const clearUsage = () => { for (const f of [USAGE_FILE, USAGE_FILE + ".tmp"]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } };

const post = async (u, b) => (await fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) })).json();
const postRaw = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const get = async (u) => (await fetch(BASE + u)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ============================ PART 1 — hermetic (no daemon, no claude) ============================
function makeEnv() {
  const dbFile = path.join(os.tmpdir(), `loom-resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  // FKs are enforced (better-sqlite3 default), so the parent project + topic must exist.
  db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
  db.insertTopic({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });
  const resumed = [];
  const alive = new Set();
  const pty = { isAlive: (id) => alive.has(id), resumeAfterRateLimit: (id) => { resumed.push(id); return true; } };
  return { dbFile, db, resumed, alive, watcher: new RateLimitWatcher({ db, pty }) };
}
function cleanupEnv(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
// Seed a session row directly (FKs are off), then layer the park/deadline via the real Db methods.
function seed(e, id, o = {}) {
  const { state = "live", until = null, deadline = null, busy = false, error = null } = o;
  const now = new Date().toISOString();
  e.db.insertSession({
    id, projectId: "p", topicId: "t", engineSessionId: null, title: null, cwd: "/x",
    processState: state, resumability: "unknown", busy, createdAt: now, lastActivity: now, lastError: error,
  });
  if (until !== null) e.db.setRateLimitedUntil(id, until, error);
  if (deadline !== null) e.db.armRateLimitDeadline(id, deadline);
  if (state === "live") e.alive.add(id);
}

// T1 — parked & the reset has passed → RESUME (clear park, KEEP deadline, clear awareness, re-submit).
{
  const e = makeEnv();
  clearUsage();
  recordClaudeRateLimit(); // a lingering global record the resume should relax
  const now = new Date();
  const deadline = new Date(now.getTime() + 60 * 60_000).toISOString();
  seed(e, "due", { until: new Date(now.getTime() - 1000).toISOString(), deadline });
  e.watcher.tick(now);
  const s = e.db.getSession("due");
  check("resume: due parked session → resumeAfterRateLimit called", e.resumed.length === 1 && e.resumed[0] === "due");
  check("resume: park cleared (rate_limited_until null)", s.rateLimitedUntil === null);
  check("resume: episode deadline KEPT (recovery continues)", s.rateLimitDeadline === deadline);
  check("resume: global awareness relaxed (no lingering over-block)", isLikelyNearClaudeUsageLimit(new Date()) === false);
  clearUsage(); cleanupEnv(e);
}

// T2 — parked but the reset is still in the future → WAIT (no resume, state untouched).
{
  const e = makeEnv();
  const now = new Date();
  const until = new Date(now.getTime() + 60 * 60_000).toISOString();
  const deadline = new Date(now.getTime() + 6 * 60 * 60_000).toISOString();
  seed(e, "waiting", { until, deadline });
  e.watcher.tick(now);
  const s = e.db.getSession("waiting");
  check("wait: future-reset parked session → NOT resumed", e.resumed.length === 0);
  check("wait: park + deadline untouched", s.rateLimitedUntil === until && s.rateLimitDeadline === deadline);
  cleanupEnv(e);
}

// T3 — a parked session that was STOPPED/killed (not live) → NOT resumed (cancel on stop).
{
  const e = makeEnv();
  const now = new Date();
  seed(e, "stopped", { state: "exited", until: new Date(now.getTime() - 1000).toISOString(), deadline: new Date(now.getTime() + 60 * 60_000).toISOString() });
  e.watcher.tick(now);
  check("cancel-on-stop: a non-live parked session is never resumed", e.resumed.length === 0);
  cleanupEnv(e);
}

// T4 — parked & past the deadline → BAIL (errored lastError, park + deadline cleared, not resumed).
{
  const e = makeEnv();
  const now = new Date();
  seed(e, "bail", { until: new Date(now.getTime() - 1000).toISOString(), deadline: new Date(now.getTime() - 1000).toISOString() });
  e.watcher.tick(now);
  const s = e.db.getSession("bail");
  check("deadline-bail: past the deadline → NOT resumed", e.resumed.length === 0);
  check("deadline-bail: park + deadline cleared", s.rateLimitedUntil === null && s.rateLimitDeadline === null);
  check("deadline-bail: marked errored (lastError mentions abandoned auto-resume)", typeof s.lastError === "string" && s.lastError.includes("auto-resume abandoned"));
  cleanupEnv(e);
}

// T5 — recovering (re-submitted; park null, deadline set) & idle → SUCCESS (end episode = clear deadline).
{
  const e = makeEnv();
  const now = new Date();
  seed(e, "recovered", { until: null, deadline: new Date(now.getTime() + 60 * 60_000).toISOString(), busy: false });
  e.watcher.tick(now);
  const s = e.db.getSession("recovered");
  check("recovery-success: idle after a resume → episode ended (deadline cleared)", s.rateLimitDeadline === null);
  check("recovery-success: not re-submitted again", e.resumed.length === 0);
  cleanupEnv(e);
}

// T6 — recovering & still busy (turn in flight) → WAIT (episode NOT prematurely ended).
{
  const e = makeEnv();
  const now = new Date();
  const deadline = new Date(now.getTime() + 60 * 60_000).toISOString();
  seed(e, "midturn", { until: null, deadline, busy: true });
  e.watcher.tick(now);
  const s = e.db.getSession("midturn");
  check("recovery-wait: busy recovering session → deadline kept (not ended early)", s.rateLimitDeadline === deadline);
  cleanupEnv(e);
}

// T7 — recovering & busy but PAST the deadline → BAIL (a hung resume is given up on).
{
  const e = makeEnv();
  const now = new Date();
  seed(e, "hung", { until: null, deadline: new Date(now.getTime() - 1000).toISOString(), busy: true });
  e.watcher.tick(now);
  const s = e.db.getSession("hung");
  check("hung-bail: recovering past the deadline → deadline cleared + errored", s.rateLimitDeadline === null && typeof s.lastError === "string" && s.lastError.includes("auto-resume abandoned"));
  cleanupEnv(e);
}

// T8 — re-cap composes: a second cap during recovery sets a NEW future park but PRESERVES the
// original episode deadline (COALESCE) — the loop stays bounded from the first hit. Simulates the
// §19c-a detect→onRateLimited wiring exactly.
{
  const e = makeEnv();
  const firstNow = new Date();
  const originalDeadline = rateLimitDeadline(undefined, firstNow); // now+6h
  seed(e, "recap", { until: null, deadline: originalDeadline, busy: true }); // mid-recovery
  // A re-cap StopFailure arrives (detect fires, then the same DB writes index.ts makes):
  check("re-cap: detect still flags a second rate_limit StopFailure", detectUsageLimit({ hook_event_name: "StopFailure", error: "rate_limit" }).limited === true);
  const reNow = new Date(firstNow.getTime() + 5 * 60_000);
  const newUntil = rateLimitedUntil(undefined, reNow);
  e.db.setRateLimitedUntil("recap", newUntil, `usage limit — resumes ${newUntil}`);
  e.db.armRateLimitDeadline("recap", rateLimitDeadline(undefined, reNow)); // COALESCE must keep the original
  const s = e.db.getSession("recap");
  check("re-cap: a NEW future park is set", s.rateLimitedUntil === newUntil && new Date(newUntil).getTime() > reNow.getTime());
  check("re-cap: the original episode deadline is PRESERVED (not reset)", s.rateLimitDeadline === originalDeadline);
  cleanupEnv(e);
}

// ===================== PART 2 — live: synthetic short park → always-on watcher resumes ============
async function waitForSession(sessionId, pred, timeoutMs, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await get("/api/sessions")).find((s) => s.id === sessionId) ?? last;
    if (last && pred(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

const dir = path.join(os.tmpdir(), `loom-resume-live-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "README.md"), "# usage-limit resume live test\n");
execSync(`git init -q && git add . && git -c user.email=rl@loom -c user.name=rl commit -q -m "init"`, { cwd: dir });

const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKey = path.resolve(dir).replace(/\\/g, "/");
const realHadKeyBefore = (() => {
  try { return trustKey in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; }
})();

let session = null;
try {
  const P = await post("/api/projects", { name: `RLresume-${Date.now()}`, repoPath: dir, vaultPath: dir });
  const STARTUP = "Respond with exactly the word READY and nothing else, then stop. Do not use any tools and do not ask any questions.";
  const topic = await post(`/api/projects/${P.id}/topics`, { name: "rl", startupPrompt: STARTUP });
  session = await post(`/api/topics/${topic.id}/sessions`, {});
  check("live: session spawned", session.processState === "live");

  const warmed = await waitForSession(session.id, (s) => !!s.engineSessionId, 60_000, 250);
  check("live: engine session id captured", !!warmed?.engineSessionId);
  const idle = await waitForSession(session.id, (s) => s.busy === false, 90_000, 250);
  check("live: idle after the startup turn (busy=false)", idle?.busy === false);

  // Synthesize a SHORT cap: resetsAt ~2.5s out → §19c-a parks until ≈ reset+10s. The always-on
  // watcher (short tick) should resume it shortly after.
  clearUsage();
  const resetSec = Math.floor((Date.now() + 2500) / 1000);
  await postRaw("/internal/hook", { sessionId: session.id, hook: { hook_event_name: "StopFailure", session_id: warmed?.engineSessionId, error: "rate_limit", resetsAt: resetSec } });

  const parked = await waitForSession(session.id, (s) => !!s.rateLimitedUntil, 5_000);
  check("live: parked (rate_limited_until set) + episode deadline armed", !!parked?.rateLimitedUntil && !!parked?.rateLimitDeadline);

  // The watcher re-submits the held turn → busy re-arms. Catch the busy=true window (the resumed
  // "READY and stop" turn runs for ~1s).
  const rearmed = await waitForSession(session.id, (s) => s.busy === true && s.rateLimitedUntil === null, 15_000, 100);
  check("live: watcher resumed — held turn re-submitted (busy re-armed, park cleared)", rearmed?.busy === true && rearmed?.rateLimitedUntil === null);

  // The resumed turn completes → episode resolves (deadline cleared) and the session is idle+live.
  const done = await waitForSession(session.id, (s) => s.rateLimitDeadline === null && s.busy === false, 30_000, 250);
  check("live: episode resolved after recovery (deadline cleared, session live + idle)", done?.rateLimitDeadline === null && done?.processState === "live");
} finally {
  try { if (session?.id) await postRaw(`/api/sessions/${session.id}/stop`, { mode: "hard" }); } catch { /* ignore */ }
  await sleep(1500);
  clearUsage();
  if (!realHadKeyBefore) {
    try {
      const cfg = JSON.parse(fs.readFileSync(realClaudeJson, "utf8"));
      if (cfg.projects && trustKey in cfg.projects) { delete cfg.projects[trustKey]; writeJsonAtomic(realClaudeJson, cfg); }
    } catch { /* nothing to clean */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the watcher resumes a parked session at its reset (re-submits the held turn), waits before it, re-caps preserve the episode deadline, stopped sessions are not resumed, the deadline bails a never-clearing cap, and global awareness relaxes on resume."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
