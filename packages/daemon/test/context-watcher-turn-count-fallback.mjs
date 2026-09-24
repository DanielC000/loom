import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ContextWatcher turn-count recycle FALLBACK (card 5b1f7ec6). A null-ctx manager on a harness with
// contextTelemetry:false (codex) gets the ordinary recycle nudge once turnSeq reaches
// orchestration.recycleAtTurnsNoTelemetry; a claude manager (null OR measured ctx) is unaffected.
// Recording-stub pty, drives tick() directly, no real spawns. Hermetic temp .db per env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { ContextWatcher, CONTEXT_RECYCLE_NUDGE_PREFIX } from "../dist/orchestration/context-watcher.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv(orchestration = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-ctxturn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `cp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ct-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "Ctx", repoPath: projId, vaultPath: projId, config: { orchestration: { recycleAtTurnsNoTelemetry: 5, ...orchestration } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = { isAlive: (id) => alive.has(id), enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; } };
  const watcher = new ContextWatcher({ db, pty, ratio: 0, emergencyInterrupt: () => { emergency++; return { fired: true }; } });
  return { dbFile, db, projId, agentId, alive, enqueued, watcher };
}
let emergency = 0;
function seed(e, id, { harness, ctx = null, turns }) {
  const now = new Date().toISOString();
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "manager", harness, ctxInputTokens: ctx, ctxTurns: ctx == null ? null : 1, model: null,
  });
  for (let i = 0; i < turns; i++) e.db.incrementTurnSeq(id);
  e.alive.add(id);
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// (1) codex null-ctx: under N no nudge; at N the ordinary nudge, exactly once (cadence), state recorded.
{
  const e = makeEnv();
  seed(e, "cx", { harness: "codex", turns: 4 });
  e.watcher.tick();
  check("(1a) codex null-ctx at N-1 turns: NOT nudged", e.enqueued.length === 0);
  e.db.incrementTurnSeq("cx");
  e.watcher.tick();
  check("(1b) codex null-ctx at N turns: nudged once", e.enqueued.length === 1 && e.enqueued[0].id === "cx");
  check("(1c) it is the ordinary recycle nudge (prefix + /loom-session-end + recycle_me)", e.enqueued[0]?.text.startsWith(CONTEXT_RECYCLE_NUDGE_PREFIX) && e.enqueued[0].text.includes("/loom-session-end") && e.enqueued[0].text.includes("recycle_me"));
  check("(1d) nudge state recorded (unanswered=1)", e.db.getContextNudgeState("cx")?.unanswered === 1);
  e.watcher.tick();
  check("(1e) cadence: second tick does NOT re-nudge", e.enqueued.length === 1);
  check("(1f) never the emergency interrupt path", emergency === 0);
  cleanup(e);
}

// (2) claude regression: null-ctx claude at high turnSeq is NOT nudged; measured-ctx claude below ratio
// is NOT nudged by turn count, and above ratio is nudged by the ratio path exactly as before.
{
  const e = makeEnv({ recycleAtContextRatio: 0.8 });
  seed(e, "cl-null", { harness: null, turns: 50 });
  seed(e, "cl-claude", { harness: "claude", turns: 50 });
  seed(e, "cl-low", { harness: null, ctx: 10_000, turns: 50 });
  seed(e, "cl-high", { harness: null, ctx: 170_000, turns: 1 });
  e.watcher.tick();
  check("(2a) claude null-ctx (harness null) at 50 turns: NOT nudged", !e.enqueued.some((x) => x.id === "cl-null"));
  check("(2b) claude null-ctx (harness 'claude') at 50 turns: NOT nudged", !e.enqueued.some((x) => x.id === "cl-claude"));
  check("(2c) claude with low measured ctx at 50 turns: NOT nudged by turn count", !e.enqueued.some((x) => x.id === "cl-low"));
  check("(2d) claude over ratio still nudged by the ratio path (~85% text)", e.enqueued.some((x) => x.id === "cl-high" && x.text.includes("~85%")));
  cleanup(e);
}

// (3) disable knobs: fallback 0 disables; project recycleAtContextRatio 0 disables it too.
{
  const e = makeEnv({ recycleAtTurnsNoTelemetry: 0 });
  seed(e, "cx", { harness: "codex", turns: 999 });
  e.watcher.tick();
  check("(3a) recycleAtTurnsNoTelemetry=0 disables the fallback", e.enqueued.length === 0);
  cleanup(e);
  const e2 = makeEnv({ recycleAtContextRatio: 0 });
  seed(e2, "cx", { harness: "codex", turns: 999 });
  e2.watcher.tick();
  check("(3b) recycleAtContextRatio=0 (recycle nudging off) disables it too", e2.enqueued.length === 0);
  cleanup(e2);
}

// (4) escalation: at the unanswered cap, escalate once (event + policy), no nudge, no re-emit.
{
  const e = makeEnv({ maxUnansweredRecycleNudges: 1, recycleNudgeIntervalMinutes: 0 });
  seed(e, "cx", { harness: "codex", turns: 5 });
  e.watcher.tick(); // nudge #1
  e.watcher.tick(); // cap reached → escalate
  e.watcher.tick(); // silent
  const esc = e.db.listEvents("cx").filter((ev) => ev.kind === "context_escalated");
  check("(4a) one nudge, then exactly one context_escalated, policy escalated", e.enqueued.length === 1 && esc.length === 1 && e.db.getContextNudgeState("cx")?.policy === "escalated");
  cleanup(e);
}

console.log(failures ? `\n❌ ${failures} FAILED` : "\n✅ ALL PASS");
process.exit(failures ? 1 : 0);
