// Usage-limit DETECT + PARK + global-awareness test (PR #19c-a). Deterministic — NO real cap is
// ever hit; we synthesize the StopFailure hook. Two parts:
//   PART 1 (hermetic, in-process; no daemon, no claude): the pure detection + park math, the DB
//     park column + DTO surfacing, the global awareness record, and the Scheduler's limit-aware
//     skip (driven through the REAL awareness record + a threaded `now`, so it exercises the
//     default wiring index.ts relies on).
//   PART 2 (live, real claude — busy-flag style): POST a synthetic StopFailure{error:"rate_limit"}
//     to /internal/hook for a genuinely-live session → assert it parks (rate_limited_until in the
//     future, busy cleared, lastError set) and records global awareness, end-to-end through the
//     relay→gateway→deliverHook→onRateLimited→DB+awareness chain.
//
// RUN against a fresh isolated LOOM_HOME daemon (PART 2 needs the HTTP endpoints + a real claude):
//   1) LOOM_HOME=<temp> node dist/index.js
//   2) LOOM_HOME=<temp> node test/usage-limit-detect.mjs        (SAME LOOM_HOME)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { Db } from "../dist/db.js";
import { Scheduler } from "../dist/orchestration/scheduler.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";
import { detectUsageLimit, rateLimitedUntil, DEFAULT_RATE_LIMIT_BACKOFF_MS } from "../dist/orchestration/usage-limit.js";
import {
  recordClaudeRateLimit, isLikelyNearClaudeUsageLimit, getClaudeExpectedResetAt,
} from "../dist/orchestration/usage-awareness.js";
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

// --- detection: primary signal, billing_error/clean-Stop exclusion, output-RE backstop, reset read ---
{
  check("detect: StopFailure{rate_limit} → limited",
    detectUsageLimit({ hook_event_name: "StopFailure", error: "rate_limit" }).limited === true);
  check("detect: StopFailure{billing_error} → NOT limited (must not park)",
    detectUsageLimit({ hook_event_name: "StopFailure", error: "billing_error" }).limited === false);
  check("detect: clean Stop → NOT limited",
    detectUsageLimit({ hook_event_name: "Stop" }).limited === false);
  check("detect: backstop RE on error text (StopFailure '429 too many requests') → limited",
    detectUsageLimit({ hook_event_name: "StopFailure", error: "429 too many requests" }).limited === true);
  const withReset = detectUsageLimit({ hook_event_name: "StopFailure", error: "rate_limit", resetsAt: 1800000000 });
  check("detect: reads resetsAt from the payload when present", withReset.limited === true && withReset.resetsAtSeconds === 1800000000);
}

// --- park math: reset present → reset+10s buffer; reset absent → now + default backoff ---
{
  const now = new Date("2026-05-28T12:00:00.000Z");
  const resetSec = Math.floor(new Date("2026-05-28T17:00:00.000Z").getTime() / 1000);
  check("park-math: reset present → rate_limited_until = reset + 10s buffer",
    rateLimitedUntil(resetSec, now) === new Date(resetSec * 1000 + 10_000).toISOString());
  check("park-math: reset absent → rate_limited_until = now + default backoff (5h)",
    rateLimitedUntil(undefined, now) === new Date(now.getTime() + DEFAULT_RATE_LIMIT_BACKOFF_MS).toISOString());
  check("park-math: default backoff is 5h", DEFAULT_RATE_LIMIT_BACKOFF_MS === 5 * 60 * 60_000);
}

// --- DB park column + DTO surfacing (in-process Db with its own temp file) ---
{
  const dbFile = path.join(os.tmpdir(), `loom-rl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  const projId = `rp-${Math.random().toString(36).slice(2, 8)}`, topicId = `rt-${Math.random().toString(36).slice(2, 8)}`, sid = `rs-${Math.random().toString(36).slice(2, 8)}`;
  db.insertProject({ id: projId, name: "RL", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertTopic({ id: topicId, projectId: projId, name: "t", startupPrompt: "x", position: 0 });
  db.insertSession({
    id: sid, projectId: projId, topicId, engineSessionId: null, title: null, cwd: projId,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  });
  check("db: a fresh session has rateLimitedUntil = null", db.getSession(sid).rateLimitedUntil === null);
  const until = new Date(Date.now() + 3_600_000).toISOString();
  db.setRateLimitedUntil(sid, until, `usage limit — resumes ${until}`);
  const got = db.getSession(sid);
  check("db: setRateLimitedUntil persists rate_limited_until", got.rateLimitedUntil === until);
  check("db: setRateLimitedUntil sets the human lastError", typeof got.lastError === "string" && got.lastError.includes("usage limit"));
  check("db: park bumps last_activity (parked-not-dead heartbeat)", new Date(got.lastActivity).getTime() >= new Date(now).getTime());
  const item = db.listAllSessions().find((s) => s.id === sid);
  check("db: SessionListItem (GET /api/sessions DTO) surfaces rateLimitedUntil", !!item && item.rateLimitedUntil === until);
  db.setRateLimitedUntil(sid, null, null);
  check("db: clearing the park sets rateLimitedUntil back to null", db.getSession(sid).rateLimitedUntil === null);
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// --- global awareness record (the whole-queue limit signal) ---
{
  clearUsage();
  check("awareness: no record → not near limit", isLikelyNearClaudeUsageLimit(new Date()) === false);

  const base = new Date();
  const resetSec = Math.floor((base.getTime() + 60_000) / 1000); // resets ~60s out
  recordClaudeRateLimit(resetSec);
  check("awareness: after a hit (reset in the future) → near limit", isLikelyNearClaudeUsageLimit(base) === true);
  const expected = getClaudeExpectedResetAt(base);
  check("awareness: getClaudeExpectedResetAt returns the recorded reset", !!expected && expected.getTime() === resetSec * 1000);
  check("awareness: once the known reset has passed → NOT near limit",
    isLikelyNearClaudeUsageLimit(new Date(resetSec * 1000 + 1000)) === false);

  clearUsage();
  recordClaudeRateLimit(); // no reset known (the common case)
  check("awareness: hit with no known reset → near limit (recency heuristic)", isLikelyNearClaudeUsageLimit(new Date()) === true);
  check("awareness: no known reset → getClaudeExpectedResetAt undefined", getClaudeExpectedResetAt(new Date()) === undefined);
  clearUsage();
}

// --- Scheduler limit-awareness (bullet 3) via the REAL awareness record + threaded now ---
{
  clearUsage();
  const dbFile = path.join(os.tmpdir(), `loom-rlsched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const now0 = new Date().toISOString();
  const projId = `sp-${Math.random().toString(36).slice(2, 8)}`, topicId = `st-${Math.random().toString(36).slice(2, 8)}`;
  db.insertProject({ id: projId, name: "S", repoPath: projId, vaultPath: projId, config: {}, createdAt: now0, archivedAt: null });
  db.insertTopic({ id: topicId, projectId: projId, name: "t", startupPrompt: "drain", position: 0 });
  const control = new OrchestrationControl();
  const calls = [];
  const scheduler = new Scheduler({ db, control, startManager: (tid) => { const id = `mgr-${calls.length}`; calls.push({ topicId: tid, id }); return { id }; } });
  db.insertSchedule({ id: "sch-rl", topicId, cron: "*/5 * * * *", enabled: true, nextFireAt: new Date(Date.now() - 60_000).toISOString(), lastFiredAt: null, createdAt: now0 });

  const base = new Date();
  const resetSec = Math.floor((base.getTime() + 60_000) / 1000); // limited until ~60s out
  recordClaudeRateLimit(resetSec);
  await scheduler.tick(base);
  check("scheduler: due schedule while usage-limited → does NOT fire", calls.length === 0 && db.getSchedule("sch-rl").lastFiredAt === null);
  await scheduler.tick(new Date(resetSec * 1000 + 120_000)); // well past the reset
  check("scheduler: after the recorded reset passes → fires", calls.length === 1 && calls[0].topicId === topicId);

  clearUsage();
  db.close();
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ===================== PART 2 — live: synthetic StopFailure → park (real claude) =====================
// busy-flag.mjs pattern: spawn a real session, warm it to idle, then POST a synthetic rate-limit
// StopFailure to /internal/hook and assert the park lands end-to-end.
async function waitForSession(sessionId, pred, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await get("/api/sessions")).find((s) => s.id === sessionId) ?? last;
    if (last && pred(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

const dir = path.join(os.tmpdir(), `loom-rl-live-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "README.md"), "# usage-limit live test\n");
execSync(`git init -q && git add . && git -c user.email=rl@loom -c user.name=rl commit -q -m "init"`, { cwd: dir });

const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKey = path.resolve(dir).replace(/\\/g, "/");
const realHadKeyBefore = (() => {
  try { return trustKey in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; }
})();

let session = null;
try {
  const P = await post("/api/projects", { name: `RL-${Date.now()}`, repoPath: dir, vaultPath: dir });
  const STARTUP = "Respond with exactly the word READY and nothing else, then stop. Do not use any tools and do not ask any questions.";
  const topic = await post(`/api/projects/${P.id}/topics`, { name: "rl", startupPrompt: STARTUP });
  session = await post(`/api/topics/${topic.id}/sessions`, {});
  check("live: session spawned", session.processState === "live");

  // Warm to idle: engine id captured AND the startup turn's Stop has cleared busy.
  const warmed = await waitForSession(session.id, (s) => !!s.engineSessionId, 60_000);
  check("live: engine session id captured", !!warmed?.engineSessionId);
  const idle = await waitForSession(session.id, (s) => s.busy === false, 90_000);
  check("live: idle after the startup turn (busy=false)", idle?.busy === false);

  // Synthesize the cap: a rate-limit StopFailure for this live session (no reset → 5h default backoff).
  clearUsage();
  const before = Date.now();
  await postRaw("/internal/hook", { sessionId: session.id, hook: { hook_event_name: "StopFailure", session_id: warmed?.engineSessionId, error: "rate_limit" } });

  const parked = await waitForSession(session.id, (s) => !!s.rateLimitedUntil, 10_000);
  check("live: rate_limited_until set in the future", !!parked?.rateLimitedUntil && new Date(parked.rateLimitedUntil).getTime() > Date.now());
  const dtMs = parked?.rateLimitedUntil ? new Date(parked.rateLimitedUntil).getTime() - before : 0;
  check("live: park window ≈ 5h default backoff (no reset in payload)", dtMs > 5 * 60 * 60_000 - 120_000 && dtMs < 5 * 60 * 60_000 + 120_000);
  check("live: busy stays cleared on the rate-limit StopFailure", parked?.busy === false);
  check("live: lastError carries the human 'usage limit — resumes …' string", typeof parked?.lastError === "string" && parked.lastError.includes("usage limit"));

  const usage = (() => { try { return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); } catch { return null; } })();
  check("live: global awareness recorded (lastRateLimitAt written)", !!usage?.lastRateLimitAt);
  check("live: a now-limited account reads as near-limit (whole-queue awareness)", isLikelyNearClaudeUsageLimit(new Date()) === true);
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
  ? "\n✅ ALL PASS — rate-limit StopFailure is detected (billing_error/clean-Stop excluded), parks the session (rate_limited_until + lastError, busy cleared), records global awareness, and the Scheduler skips firing while limited then resumes after the reset."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
