import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// IdleWatcher DELIVERY test (card f6d72db8, sibling of context-watcher-delivery.mjs / card 49fdcbbc).
// NO claude — the watcher takes an injected pty-slice, so the tick tests use a RECORDING STUB that
// returns a CONTROLLED enqueueStdin result and drive tick() directly. Hermetic like idle-watcher.mjs:
// each env gets its OWN temp .db.
//
// Covers BOTH discard sites the card identified as structurally similar but NOT identical in consequence:
//   (A) the manager idle-nudge path (tick()) — a NOT-accepted nudge must NOT stamp last_idle_nudge_at or
//       increment idle_nudge_unanswered (the RED-half control for the original defect: the unfixed code
//       stamped + incremented unconditionally, which could escalate a human on a nudge never sent); a
//       QUEUED nudge DOES count; a THROWING enqueueStdin is treated the same as not-accepted.
//   (B) the answered-stuck re-nudge path (tickAnsweredStuckQuestions()) — a NOT-accepted re-nudge must NOT
//       mark the question as nudged in the in-memory Set (so it's retried on the NEXT tick instead of being
//       silently suppressed for the rest of the process lifetime); an accepted one DOES mark it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { IdleWatcher } from "../dist/orchestration/idle-watcher.js";
import { OrchestrationControl } from "../dist/orchestration/control.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-09-02T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

// enqueueResult is a function (id, text) => result, so each test controls exactly what the stub returns.
function makeEnv(enqueueResult, { isWorkerStranded = () => true } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-idle-del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `idp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `idt-${Math.random().toString(36).slice(2, 8)}`;
  db.insertProject({ id: projId, name: "IdleDel", repoPath: projId, vaultPath: projId, config: {}, createdAt: NOW.toISOString(), archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text, ...rest) => { enqueued.push({ id, text, rest }); return enqueueResult(id, text); },
  };
  const control = new OrchestrationControl();
  const watcher = new IdleWatcher({ db, pty, control, recycleRatio: 0, notifyIdleWorker: () => {}, isWorkerStranded });
  return { dbFile, db, projId, agentId, alive, enqueued, control, watcher };
}
// Seed a manager idle long enough (60m > the 45m default) to be nudge-eligible.
function seedManager(e, id, { idleMin = 60 } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: minutesAgo(idleMin), lastActivity: minutesAgo(idleMin), lastError: null, role: "manager",
    ctxInputTokens: null, ctxTurns: null, model: null,
  });
  e.alive.add(id);
}
function seedQuestion(e, sessionId, taskId) {
  const id = `q-${Math.random().toString(36).slice(2, 8)}`;
  e.db.insertQuestion({
    id, sessionId, projectId: e.projId, type: "decision", title: "a decision", body: "",
    options: null, recommendation: null, taskId,
    permissionAction: null, permissionScope: null, permissionExpiresAt: null, credentialEnvVar: null,
    state: "answered", chosenOption: null, note: null, createdAt: minutesAgo(60),
    answeredAt: minutesAgo(30), consumedAt: null,
  });
  return id;
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ==================== (A1) manager path: NOT accepted (delivered:false, no queued) ====================
// THIS is the RED-half control for the original defect: pre-fix, idle-watcher.ts discarded the return
// value entirely (empty catch, unconditional recordIdleNudge) — this case used to stamp the row and
// increment unanswered even though nothing was actually sent, which could eventually ESCALATE a human
// attention alert on a manager that was never actually nudged.
{
  const e = makeEnv(() => ({ delivered: false }));
  seedManager(e, "mgr-dropped");
  e.watcher.tick(NOW);
  const s = e.db.getIdleNudgeState("mgr-dropped");
  check("(A1) enqueueStdin still attempted (the stub was called)", e.enqueued.length === 1);
  check("(A1) a NOT-accepted nudge (delivered:false, no queued) does NOT stamp last_idle_nudge_at", s?.lastIdleNudgeAt === null);
  check("(A1) a NOT-accepted nudge does NOT increment idle_nudge_unanswered", s?.unanswered === 0);
  cleanup(e);
}

// ==================== (A2) manager path: QUEUED (delivered:false, queued:true) DOES count ====================
{
  const e = makeEnv(() => ({ delivered: false, queued: true, position: 1 }));
  seedManager(e, "mgr-queued");
  e.watcher.tick(NOW);
  const s = e.db.getIdleNudgeState("mgr-queued");
  check("(A2) a QUEUED (delivered:false, queued:true) nudge DOES stamp last_idle_nudge_at", s?.lastIdleNudgeAt === NOW.toISOString());
  check("(A2) a QUEUED nudge DOES increment idle_nudge_unanswered 0→1", s?.unanswered === 1);
  cleanup(e);
}

// ==================== (A3) manager path: handed-off (delivered:true) still counts — baseline ====================
{
  const e = makeEnv(() => ({ delivered: true }));
  seedManager(e, "mgr-handed-off");
  e.watcher.tick(NOW);
  const s = e.db.getIdleNudgeState("mgr-handed-off");
  check("(A3) a delivered:true nudge still stamps + increments (baseline unchanged)", s?.lastIdleNudgeAt === NOW.toISOString() && s?.unanswered === 1);
  cleanup(e);
}

// ==================== (A4) manager path: a THROWING enqueueStdin is treated as not-accepted ====================
{
  const e = makeEnv(() => { throw new Error("boom"); });
  seedManager(e, "mgr-throws");
  e.watcher.tick(NOW);
  const s = e.db.getIdleNudgeState("mgr-throws");
  check("(A4) a throwing enqueueStdin does NOT stamp last_idle_nudge_at", s?.lastIdleNudgeAt === null);
  check("(A4) a throwing enqueueStdin does NOT increment idle_nudge_unanswered", s?.unanswered === 0);
  cleanup(e);
}

// ==================== (A5) manager path: a NOT-accepted nudge is retried on a LATER tick (no false cooldown) ====
// Since (A1) never stamps last_idle_nudge_at, a later tick must NOT be silenced by the re-nudge cadence —
// the defect this card fixes is exactly that an undelivered nudge used to "buy silence" for a full
// idleNudgeMinutes window (and count toward the escalation cap besides). The second tick is spaced past
// IDLE_SCAN_THROTTLE_MINUTES (5m) — a SEPARATE, pre-existing in-memory board-rescan throttle (card
// a193398f) that this card's fix does not touch and that would otherwise skip the re-derivation (and so
// never even attempt a retry) regardless of whether the earlier nudge was recorded.
{
  let calls = 0;
  const e = makeEnv(() => { calls++; return calls === 1 ? { delivered: false } : { delivered: true }; });
  seedManager(e, "mgr-retry");
  e.watcher.tick(NOW);
  check("(A5) precondition: first attempt was not accepted → no stamp", e.db.getIdleNudgeState("mgr-retry")?.lastIdleNudgeAt === null);
  const LATER = new Date(NOW.getTime() + 6 * 60_000); // past the 5m scan-rescan throttle
  e.watcher.tick(LATER); // still well under idleNudgeMinutes(45) worth of extra idling — would be inside
  // the cadence window IF the earlier not-accepted attempt had wrongly been recorded as a sent nudge.
  check("(A5) a follow-up tick retries (no false cooldown from the un-accepted attempt)", calls === 2);
  check("(A5) the retry that DOES land is recorded normally", e.db.getIdleNudgeState("mgr-retry")?.unanswered === 1);
  cleanup(e);
}

// ==================== (B1) answered-stuck path: NOT accepted must NOT mark the question nudged ====================
// RED-half control for the second site: pre-fix, tickAnsweredStuckQuestions discarded the return value
// (empty catch, unconditional Set.add) — an undelivered "pull it" re-nudge was marked nudged anyway and
// would never re-fire for the rest of the process lifetime (the Set has no other expiry/cadence).
{
  const e = makeEnv(() => ({ delivered: false }));
  seedManager(e, "mgr-stuck-dropped");
  e.db.insertTask({ id: "tk-stuck-dropped", projectId: e.projId, title: "t", body: "", columnKey: "todo", position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  const qid = seedQuestion(e, "mgr-stuck-dropped", "tk-stuck-dropped");
  e.watcher.tick(NOW);
  const attemptsAfterFirst = e.enqueued.filter((x) => x.rest?.[4] === qid).length;
  check("(B1) an answered-stuck re-nudge attempt was made", attemptsAfterFirst === 1);
  // A second tick (still within the same answered→still-answered window) must retry — proving it was
  // NOT marked nudged in the Set by the not-accepted attempt.
  e.watcher.tick(NOW);
  const attemptsAfterSecond = e.enqueued.filter((x) => x.rest?.[4] === qid).length;
  check("(B1) a NOT-accepted answered-stuck re-nudge is retried on the next tick (not marked nudged)", attemptsAfterSecond === 2);
  cleanup(e);
}

// ==================== (B2) answered-stuck path: an ACCEPTED re-nudge DOES mark the question nudged ====================
{
  const e = makeEnv(() => ({ delivered: true }));
  seedManager(e, "mgr-stuck-ok");
  e.db.insertTask({ id: "tk-stuck-ok", projectId: e.projId, title: "t", body: "", columnKey: "todo", position: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  const qid = seedQuestion(e, "mgr-stuck-ok", "tk-stuck-ok");
  e.watcher.tick(NOW);
  const attemptsAfterFirst = e.enqueued.filter((x) => x.rest?.[4] === qid).length;
  check("(B2) an accepted answered-stuck re-nudge attempt was made", attemptsAfterFirst === 1);
  e.watcher.tick(NOW);
  const attemptsAfterSecond = e.enqueued.filter((x) => x.rest?.[4] === qid).length;
  check("(B2) an ACCEPTED answered-stuck re-nudge is NOT retried (marked nudged in the Set)", attemptsAfterSecond === 1);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — IdleWatcher only stamps last_idle_nudge_at / increments idle_nudge_unanswered (manager path) or marks a question nudged (answered-stuck path) when enqueueStdin reports the nudge ACCEPTED (delivered OR durably queued); a not-accepted or throwing attempt records nothing and is retried instead of buying a false cooldown / permanent suppression."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
