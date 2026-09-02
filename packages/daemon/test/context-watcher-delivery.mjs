import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ContextWatcher DELIVERY test (card 49fdcbbc). NO claude — the watcher takes an injected pty-slice,
// so the tick tests use a RECORDING STUB that returns a CONTROLLED enqueueStdin result and drive tick()
// directly. Hermetic like context-watcher.mjs / context-watcher-escalate.mjs: each env gets its OWN
// temp .db. Covers: a NOT-accepted nudge (delivered:false, no queued) must NOT stamp last_context_nudge_at
// or increment context_nudge_unanswered (the RED-half control for the original defect — the unfixed code
// stamps unconditionally); a QUEUED-but-not-yet-delivered nudge (delivered:false, queued:true) DOES count
// (the card's explicit "queued should probably count" call); a handed-off nudge (delivered:true) still
// counts (unchanged baseline); and a THROWING enqueueStdin is treated the same as not-accepted, not as a
// silent unconditional record.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { ContextWatcher } from "../dist/orchestration/context-watcher.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-09-02T12:00:00.000Z");

// enqueueResult is a function (id, text) => result, so each test controls exactly what the stub returns.
function makeEnv(enqueueResult, { ratio = 0.8 } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-ctx-del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `cp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ct-${Math.random().toString(36).slice(2, 8)}`;
  db.insertProject({ id: projId, name: "Ctx", repoPath: projId, vaultPath: projId, config: {}, createdAt: NOW.toISOString(), archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return enqueueResult(id, text); },
  };
  const watcher = new ContextWatcher({ db, pty, ratio });
  return { dbFile, db, projId, agentId, alive, enqueued, watcher };
}
function seedManager(e, id, { ctx = 180_000, model = null } = {}) { // 90% of 200k by default → over ratio
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role: "manager",
    ctxInputTokens: ctx, ctxTurns: 1, model,
  });
  e.alive.add(id);
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ===================== (1) NOT accepted (delivered:false, no queued) must NOT be recorded =====================
// THIS is the RED-half control for the original defect: pre-fix, context-watcher.ts discarded the return
// value entirely and called db.recordContextNudge(...) unconditionally, so this case used to stamp the
// row and increment unanswered even though nothing was actually sent.
{
  const e = makeEnv(() => ({ delivered: false }));
  seedManager(e, "mgr-dropped");
  e.watcher.tick(NOW);
  const s = e.db.getContextNudgeState("mgr-dropped");
  check("(1) enqueueStdin still attempted (the stub was called)", e.enqueued.length === 1);
  check("(1) a NOT-accepted nudge (delivered:false, no queued) does NOT stamp last_context_nudge_at", s?.lastContextNudgeAt === null);
  check("(1) a NOT-accepted nudge does NOT increment context_nudge_unanswered", s?.unanswered === 0);
  cleanup(e);
}

// ===================== (2) QUEUED (delivered:false, queued:true) DOES count =====================
{
  const e = makeEnv(() => ({ delivered: false, queued: true, position: 1 }));
  seedManager(e, "mgr-queued");
  e.watcher.tick(NOW);
  const s = e.db.getContextNudgeState("mgr-queued");
  check("(2) a QUEUED (delivered:false, queued:true) nudge DOES stamp last_context_nudge_at", s?.lastContextNudgeAt === NOW.toISOString());
  check("(2) a QUEUED nudge DOES increment context_nudge_unanswered 0→1", s?.unanswered === 1);
  cleanup(e);
}

// ===================== (3) handed-off (delivered:true) still counts — unchanged baseline =====================
{
  const e = makeEnv(() => ({ delivered: true }));
  seedManager(e, "mgr-handed-off");
  e.watcher.tick(NOW);
  const s = e.db.getContextNudgeState("mgr-handed-off");
  check("(3) a delivered:true nudge still stamps + increments (baseline unchanged)", s?.lastContextNudgeAt === NOW.toISOString() && s?.unanswered === 1);
  cleanup(e);
}

// ===================== (4) a THROWING enqueueStdin is treated as not-accepted, not silently recorded =====================
{
  const e = makeEnv(() => { throw new Error("boom"); });
  seedManager(e, "mgr-throws");
  e.watcher.tick(NOW);
  const s = e.db.getContextNudgeState("mgr-throws");
  check("(4) a throwing enqueueStdin does NOT stamp last_context_nudge_at", s?.lastContextNudgeAt === null);
  check("(4) a throwing enqueueStdin does NOT increment context_nudge_unanswered", s?.unanswered === 0);
  cleanup(e);
}

// ===================== (5) a NOT-accepted nudge is retried on the NEXT tick (no false cooldown) =====================
// Since (1) never stamps last_context_nudge_at, a later tick must NOT be silenced by the re-nudge cadence
// — the defect this card fixes is exactly that an undelivered nudge used to "buy silence" for a full
// recycleNudgeIntervalMinutes window.
{
  let calls = 0;
  const e = makeEnv(() => { calls++; return calls === 1 ? { delivered: false } : { delivered: true }; });
  seedManager(e, "mgr-retry");
  e.watcher.tick(NOW);
  check("(5) precondition: first attempt was not accepted → no stamp", e.db.getContextNudgeState("mgr-retry")?.lastContextNudgeAt === null);
  e.watcher.tick(NOW); // same instant — would be inside the cadence window IF a nudge had wrongly been recorded
  check("(5) a follow-up tick retries immediately (no false cooldown from the un-accepted attempt)", calls === 2);
  check("(5) the retry that DOES land is recorded normally", e.db.getContextNudgeState("mgr-retry")?.unanswered === 1);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ContextWatcher only stamps last_context_nudge_at / increments context_nudge_unanswered when enqueueStdin reports the nudge ACCEPTED (delivered OR durably queued); a not-accepted or throwing attempt records nothing and is retried on the next tick instead of buying a false cooldown."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
