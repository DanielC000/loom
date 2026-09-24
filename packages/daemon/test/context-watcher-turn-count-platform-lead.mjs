import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ContextWatcher turn-count fallback for the PLATFORM LEAD (card a1263b45). The manager loop never sees
// role:'platform'; a codex (contextTelemetry:false) Lead with null ctx gets the ordinary recycle nudge at
// recycleAtTurnsNoTelemetry turns. A claude Lead (null OR measured ctx) stays unwatched, as before.
// Recording-stub pty, drives tick() directly, no real spawns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { ContextWatcher, CONTEXT_RECYCLE_NUDGE_PREFIX } from "../dist/orchestration/context-watcher.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv(orchestration = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-ctxlead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `cp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ct-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "Ctx", repoPath: projId, vaultPath: projId, config: { orchestration: { recycleAtTurnsNoTelemetry: 5, ...orchestration } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "lead", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = { isAlive: (id) => alive.has(id), enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; } };
  const watcher = new ContextWatcher({ db, pty, ratio: 0 });
  return { dbFile, db, projId, agentId, alive, enqueued, watcher };
}
function seed(e, id, { harness, ctx = null, turns, role = "platform" }) {
  const now = new Date().toISOString();
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role, harness, ctxInputTokens: ctx, ctxTurns: ctx == null ? null : 1, model: null,
  });
  for (let i = 0; i < turns; i++) e.db.incrementTurnSeq(id);
  e.alive.add(id);
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// (1) codex Lead, null ctx: nothing under N; at N the ordinary nudge exactly once.
{
  const e = makeEnv();
  seed(e, "lead-cx", { harness: "codex", turns: 4 });
  e.watcher.tick();
  check("(1a) codex Lead at N-1 turns: NOT nudged", e.enqueued.length === 0);
  e.db.incrementTurnSeq("lead-cx");
  e.watcher.tick();
  check("(1b) codex Lead at N turns: nudged once", e.enqueued.length === 1 && e.enqueued[0].id === "lead-cx");
  check("(1c) ordinary recycle nudge (prefix + recycle_me)", e.enqueued[0]?.text.startsWith(CONTEXT_RECYCLE_NUDGE_PREFIX) && e.enqueued[0].text.includes("recycle_me"));
  check("(1d) nudge state recorded (unanswered=1)", e.db.getContextNudgeState("lead-cx")?.unanswered === 1);
  e.watcher.tick();
  check("(1e) cadence: second tick does NOT re-nudge", e.enqueued.length === 1);
  cleanup(e);
}

// (2) claude regression pin: a claude Lead (harness null or 'claude', null or measured ctx) is never nudged.
{
  const e = makeEnv({ recycleAtContextRatio: 0.8 });
  seed(e, "l-null", { harness: null, turns: 50 });
  seed(e, "l-claude", { harness: "claude", turns: 50 });
  seed(e, "l-high", { harness: null, ctx: 170_000, turns: 50 });
  e.watcher.tick();
  check("(2) claude Leads (null ctx / measured high ctx) at 50 turns: none nudged", e.enqueued.length === 0);
  cleanup(e);
}

// (3) knobs: fallback 0 disables; a non-platform, non-manager role is not swept in.
{
  const e = makeEnv({ recycleAtTurnsNoTelemetry: 0 });
  seed(e, "lead-cx", { harness: "codex", turns: 999 });
  e.watcher.tick();
  check("(3a) recycleAtTurnsNoTelemetry=0 disables it for the Lead", e.enqueued.length === 0);
  cleanup(e);
  const e2 = makeEnv();
  seed(e2, "wk", { harness: "codex", turns: 999, role: "worker" });
  e2.watcher.tick();
  check("(3b) a codex worker is not swept in", e2.enqueued.length === 0);
  cleanup(e2);
}

// (4) escalation reuses the shared path: one nudge, one context_escalated, then silent.
{
  const e = makeEnv({ maxUnansweredRecycleNudges: 1, recycleNudgeIntervalMinutes: 0 });
  seed(e, "lead-cx", { harness: "codex", turns: 5 });
  e.watcher.tick(); e.watcher.tick(); e.watcher.tick();
  const esc = e.db.listEvents("lead-cx").filter((ev) => ev.kind === "context_escalated");
  check("(4) one nudge, exactly one context_escalated, policy escalated", e.enqueued.length === 1 && esc.length === 1 && e.db.getContextNudgeState("lead-cx")?.policy === "escalated");
  cleanup(e);
}

console.log(failures ? `\n❌ ${failures} FAILED` : "\n✅ ALL PASS");
process.exit(failures ? 1 : 0);
