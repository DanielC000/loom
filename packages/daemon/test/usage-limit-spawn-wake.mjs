import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_spawn usage-limit: STRUCTURED retry-after + AUTO-WAKE on hold-clear (PL Auditor finding #7, P2).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-task-gate.mjs (REAL Db +
// SessionService against a FAKE pty + a real temp git repo) AND rate-limit-cascade.mjs (the REAL Fastify
// clear-usage-hold cascade in-process against a recording stub pty).
//
// The bug (repro): a manager hit a BARE `throw new Error("usage limit active")` on worker_spawn, parked,
// then needed THREE human "retry" pokes to clear ONE transient limit — no deadline to wait for, no auto-wake.
//
// Proves the DoD points:
//   (1) STRUCTURED retry-after — a usage-limited worker_spawn throws a UsageLimitError whose `retryAfter`
//       is the derived deadline (the known reset, here), NOT a bare "usage limit active" string; and the
//       refusal is side-effect-free (no worktree dir, no worker session row).
//   (2) AUTO-WAKE wiring — the blocked manager is registered into the EXISTING rate-limit park machinery
//       (db.listRateLimited + a deadline-armed episode), so a simulated hold-clear (POST /api/usage/clear-hold)
//       WAKES it (resumeAfterRateLimit) and drops its park — no parallel mechanism, no human poke.
//   + a control: with NO latch, the path is unchanged (no retry-after, no park).
//
// Run: 1) build (turbo builds shared first), 2) node test/usage-limit-spawn-wake.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// assert that an async call rejects, returning the thrown error for further structural assertions.
const captureReject = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-ulsw-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const LATCH = path.join(tmpHome, "tmp", "claude-usage.json"); // the global awareness file (usage-awareness.ts)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { recordClaudeRateLimit, clearClaudeRateLimit, getClaudeUsageLimitRetryAfter } =
  await import("../dist/orchestration/usage-awareness.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-ulsw-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# usage-limit-spawn-wake test\n");
execSync(`git init -q && git add . && git -c user.email=ws@loom -c user.name=ws commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pP", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
const taskGood = randomUUID();
db.insertTask({ id: taskGood, projectId: "pP", title: "real", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

// FAKE pty (createPty seam) — spawnWorker never drives a real claude.
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

// "no worktree allocated" = the project's worktree dir was never created (createWorktree mkdirs it).
const ptWorktreeDir = path.join(tmpHome, "worktrees", "pP");
const noSpawnSideEffects = () => !fs.existsSync(ptWorktreeDir) && db.listWorkers("mgr1").length === 0;

try {
  // ════════ CONTROL: no latch ⇒ no usage limit, no park, no retry-after ════════
  clearClaudeRateLimit();
  check("control: getClaudeUsageLimitRetryAfter is undefined when not limited", getClaudeUsageLimitRetryAfter() === undefined);
  check("control: manager is NOT parked (listRateLimited empty)", db.listRateLimited().length === 0);

  // ════════ (1) STRUCTURED retry-after on a usage-limited worker_spawn ════════
  // Lay the global latch with a KNOWN reset 90 min out — the derived retry-after deadline.
  const resetSeconds = Math.floor((Date.now() + 90 * 60_000) / 1000);
  const expectedRetryAfter = new Date(resetSeconds * 1000).toISOString();
  recordClaudeRateLimit(resetSeconds);
  check("setup: latch present + isLikelyNear-equivalent retry-after derived to the known reset",
    fs.existsSync(LATCH) && getClaudeUsageLimitRetryAfter()?.toISOString() === expectedRetryAfter);

  const err = await captureReject(() => svc.spawnWorker("mgr1", { taskId: taskGood, agentId: "agentDev", kickoffPrompt: "GO" }));
  check("(1) usage-limited worker_spawn throws", err != null);
  check("(1) the throw is a STRUCTURED UsageLimitError (name carried)", err?.name === "UsageLimitError");
  check("(1) it carries a retryAfter deadline (NOT undefined)", typeof err?.retryAfter === "string" && err.retryAfter.length > 0);
  check("(1) retryAfter === the derived known-reset deadline", err?.retryAfter === expectedRetryAfter);
  check("(1) message is NOT the bare 'usage limit active' string (carries the deadline)",
    err?.message !== "usage limit active" && String(err?.message).includes(expectedRetryAfter));
  check("(1) the refusal is side-effect-free (no worktree dir, no worker session row)", noSpawnSideEffects());
  check("(1) the card never left backlog (a refused spawn moves nothing)", db.getTask(taskGood).columnKey === "backlog");

  // ════════ (2) AUTO-WAKE: the blocked manager is registered into the rate-limit park machinery ════════
  const parked = db.getSession("mgr1");
  check("(2) manager is parked with rate_limited_until === retryAfter", parked.rateLimitedUntil === expectedRetryAfter);
  check("(2) manager has an armed episode give-up deadline (> retryAfter)",
    !!parked.rateLimitDeadline && new Date(parked.rateLimitDeadline).getTime() > Date.parse(expectedRetryAfter));
  check("(2) manager is in listRateLimited (the clear-hold cascade work set)",
    db.listRateLimited().some((s) => s.id === "mgr1"));
  check("(2) manager is in listRateLimitEpisodes (the RateLimitWatcher work set: live + deadline-armed)",
    db.listRateLimitEpisodes().some((s) => s.id === "mgr1"));

  // ════════ (2) a SIMULATED hold-clear WAKES the parked manager (the REAL gateway cascade) ════════
  const resumed = [];
  const pty = { isAlive: () => true, resumeAfterRateLimit: (id) => { resumed.push(id); return true; } };
  const stub = {};
  const app = await buildServer({ db, pty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });
  try {
    const r = await app.inject({ method: "POST", url: "/api/usage/clear-hold" });
    check("(2) clear-hold 200 OK", r.statusCode === 200);
    check("(2) cascade resumed the parked manager (auto-wake, no human poke)",
      r.json().cleared === true && r.json().resumed >= 1 && resumed.includes("mgr1"));
    const woken = db.getSession("mgr1");
    check("(2) manager park cleared by the cascade (rate_limited_until null)", woken.rateLimitedUntil === null);
    check("(2) manager episode deadline cleared too (rate_limit_deadline null)", woken.rateLimitDeadline === null);
    check("(2) GLOBAL latch dropped by the cascade", !fs.existsSync(LATCH));
    check("(2) nothing left parked", db.listRateLimited().length === 0);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a usage-limited worker_spawn throws a STRUCTURED UsageLimitError carrying the derived retry-after deadline (not a bare string) with NO side effect, AND registers the blocked manager into the existing rate-limit park machinery so a simulated clear-usage-hold cascade auto-wakes it — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
