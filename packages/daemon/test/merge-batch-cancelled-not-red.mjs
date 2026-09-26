import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 13571c71 — a merge_batch CANCELLED while still QUEUED is not a gate verdict: no gate ran, so it must not count as a RED (which,
// under a merge-gate interval, sets gateOwed), and — a cancel means stop — it must not start a per-candidate fallback either.
//   (P) the ONE predicate `isMergeGateRed` (orchestration/gate-semaphore.ts) shared by the solo and batch paths.
//   (C1) BATCH, gate off + interval N=2, ungated 1: K=2 is due ⇒ the batch gate QUEUES behind a held slot, is cancelled while queued ⇒
//        result {ok:false, cancelled:true}, every candidate `started:false`, the gate command never called, NO per-candidate solo confirm
//        started (no fallbackOfBatchOpId row in the gate queue, no merge event for either worker), gateOwed stays false, the ungated
//        counter stays 1, no ring row, `recordMergeGateFailure` never called, main untouched, the settle nudge is `[loom:merge-batch-cancelled]`.
//   (C2) SOLO parity: the same cancel-while-queued on a due solo confirm records nothing either (cancelled:true, state unchanged).
//   (C3) NEGATIVE CONTROL: the same batch shape with a FAILING gate still records the red (gateOwed true) — the fix did not disable it.
//   (C5) the async settle nudge is [loom:merge-batch-cancelled] and states nothing was started.
//   (C4) a cancelled batch is never cached/replayed: a re-fire after the cancel is a FRESH run.
//   (C6) a cancelled batch reports each candidate's OWN reason (held one included) through the one reporting path and starts nothing.
// NOT COVERED: cancel while RUNNING (refused for merge gates — see gate-cancel.mjs); a cancelled batch that also dropped candidates.
// Run: 1) build daemon (pnpm build), 2) node test/merge-batch-cancelled-not-red.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil, deferred } from "./_wait.mjs";
const noReap = async () => ({ killedPids: [] });

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgint-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { withCanonicalIndexLock } = await import("../dist/git/repo-lock.js");
const M = await import("../dist/orchestration/merge-gate-interval.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mgint@loom -c user.name=mgint";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
// `holdAlive` lets a test make a worker look alive until it releases it, stalling a batch's post-guard finalize (finishAlreadyMerged waits for the pty to die).
// `holdAlive` is the deterministic form: a worker stays alive until the TEST releases it (no wall-clock), and `alivePolls` counts how many
// times finalize polled it (its wait loop is bounded at 50 polls, so a count < 50 proves the hold was never expired by that bound).
const holdAlive = new Set();
const alivePolls = new Map();
const ptyStub = { stop() {}, isAlive(id) { if (!holdAlive.has(id)) return false; alivePolls.set(id, (alivePolls.get(id) ?? 0) + 1); return true; }, enqueueStdin() {} };
const head = (repo) => execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
const tip = (repo, branch) => execSync(`git rev-parse ${branch}`, { cwd: repo }).toString().trim();

// ============ fixtures ============
function makeRepo(repo) {
  mkdirp(repo);
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mgint\n");
  mkdirp(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email mgint@loom && git config user.name mgint`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}
const mk = (label) => ({
  projId: `mgint-${label}-proj-${sfx}`, agentId: `mgint-${label}-agent-${sfx}`, mgrId: `mgint-${label}-mgr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mgint-${label}-${sfx}`),
});
async function seedProject(db, P, orchestration) {
  db.insertProject({ id: P.projId, name: "MGINT", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate", ...orchestration } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
async function addWorker(db, P, n, files) {
  const taskId = `mgint-${n}-task-${sfx}`;
  const workerId = `mgint-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  worktrees.push(worktreePath);
  for (const [rel, body] of Object.entries(files)) { mkdirp(path.dirname(path.join(worktreePath, rel))); fs.writeFileSync(path.join(worktreePath, rel), body); }
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
/** A service whose injected gate honours `gate.pass` and counts calls; spies count the ONE decision + ONE recorder. */
function mkService(db) {
  const gate = { calls: 0, pass: true, hold: null, failNext: false };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    finalizeWorkerDeathPolls: 600, // (Q)'s hold must outlive the solo's landing on a loaded host: ~60s instead of the default ~5s
    runGate: async () => {
      gate.calls++;
      if (gate.hold) await gate.hold;
      if (gate.failNext) { gate.failNext = false; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; }
      return gate.pass ? { passed: true, steps: [] } : { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
    },
    reapWorktreeProcesses: noReap,
  });
  const spy = { decide: 0, record: 0, recorded: [] };
  const origDecide = sessions.decideMergeGateFor.bind(sessions);
  sessions.decideMergeGateFor = (...a) => { spy.decide++; return origDecide(...a); };
  const origRecord = sessions.recordMergeGateOutcome.bind(sessions);
  sessions.recordMergeGateOutcome = (pid, ev, ...rest) => { spy.record++; spy.recorded.push(ev.kind); return origRecord(pid, ev, ...rest); };
  return { sessions, gate, spy };
}
const confirm = async (sessions, mgrId, workerId) => {
  const r = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  return r.settled && r.ok ? r.value : { __unsettled: r };
};
const reset = (ctx) => { ctx.gate.calls = 0; ctx.spy.decide = 0; ctx.spy.record = 0; ctx.spy.recorded.length = 0; };


const { isMergeGateRed } = await import("../dist/orchestration/gate-semaphore.js");

/** Count `recordMergeGateFailure` calls (the ONE red recorder) and capture the messages enqueued to a manager. */
function spyRed(ctx) {
  const s = { red: 0, msgs: [] };
  const orig = ctx.sessions.recordMergeGateFailure.bind(ctx.sessions);
  ctx.sessions.recordMergeGateFailure = async (...a) => { s.red++; return orig(...a); };
  const origMsg = ctx.sessions.enqueueDurableMessage.bind(ctx.sessions);
  ctx.sessions.enqueueDurableMessage = (t, m, ...rest) => { s.msgs.push(String(m)); return origMsg(t, m, ...rest); };
  return s;
}
/** Occupy the ONLY slot (cap 1) with a held worker-type entry so the merge under test genuinely QUEUES. */
function occupySlot(ctx) {
  const held = deferred();
  const p = ctx.sessions.gateSemaphore.runExclusive(1, { gateType: "worker", projectId: "mbc-other", sessionId: `mbc-holder-${sfx}`, worktreePath: "/wt/mbc-holder" }, async () => { await held.promise; return "holder"; });
  return { release: () => held.resolve(), done: p };
}
const queuedMerge = (ctx) => ctx.sessions.gateSemaphore.snapshot().entries.find((e) => e.gateType === "merge" && e.phase === "queued");

const dbs = [];
const worktrees = [];
try {
  // ── (P) the predicate ──────────────────────────────────────────────────────────────────────────
  check("(P) a settled failing verdict is a red", isMergeGateRed({ passed: false }) === true);
  check("(P) a cancelled outcome is NOT a red (no gate ran)", isMergeGateRed({ passed: false, cancelled: true }) === false);
  check("(P) a pass is not a red", isMergeGateRed({ passed: true }) === false);

  // ── (C1) BATCH cancelled while queued ────────────────────────────────────────────────────────────
  {
    const P = mk("c1"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    const spy = spyRed(ctx);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2, maxConcurrentGates: 1 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 1 });
    const b1 = await addWorker(db, P, "c1a", { "src/c1a.ts": "export const c1a = 1;\n" });
    const b2 = await addWorker(db, P, "c1b", { "src/c1b.ts": "export const c1b = 2;\n" });
    const mainBefore = head(P.repo);
    const holder = occupySlot(ctx);
    const batchP = ctx.sessions.mergeBatchTracked(P.mgrId, [b1.workerId, b2.workerId]); // 1+2 > 2 ⇒ due ⇒ gated ⇒ queues behind the holder
    const entry = await waitUntil(() => queuedMerge(ctx), { timeoutMs: 60000, intervalMs: 20, label: "merge-batch-cancelled-not-red (C1): the batch gate is queued" });
    check("(C1) setup: the batch gate is genuinely QUEUED (holder occupies the slot, gate command not called)", !!entry && ctx.gate.calls === 0);
    const cancel = await ctx.sessions.cancelGateOp(P.mgrId, entry.opId, { scope: { kind: "project" } });
    check("(C1) setup: cancelling the QUEUED batch gate succeeds", cancel.outcome === "cancelled" && cancel.phase === "queued");
    const r = await batchP;
    const v = r.settled && r.ok ? r.value : undefined;
    holder.release(); await holder.done;
    check("(C1) the batch result is {ok:false, cancelled:true}", v?.ok === false && v.cancelled === true && /gate cancelled/.test(v.reason ?? ""));
    check("(C1) NOTHING was started: every candidate is reported started:false, landed is empty", v && v.landed.length === 0 && v.fallback.length === 2 && v.fallback.every((f) => f.started === false));
    check("(C1) the gate command was never called (no batch gate, no per-candidate solo gate)", ctx.gate.calls === 0);
    check("(C1) NO per-candidate solo confirm was started: no queued/active gate row, no merge event for either worker",
      ctx.sessions.gateSemaphore.snapshot().entries.length === 0 &&
      !db.listEvents(P.mgrId).some((e) => (e.kind === "build_gate" || e.kind === "merge_done" || e.kind === "merge_rejected") && [b1.workerId, b2.workerId].includes(e.workerSessionId)));
    const s = db.getMergeGateState(P.projId);
    check("(C1) gateOwed stays FALSE (a cancel is not a red) — RED on the pre-fix code", s.gateOwed === false && spy.red === 0);
    check("(C1) the ungated counter is unchanged (1) and no ring row was written", s.ungatedSinceLastPass === 1 && s.recent.length === 0 && s.lastFailure === null);
    check("(C1) canonical main is untouched", head(P.repo) === mainBefore);
    // (C4) a cancelled batch is never cached/replayed: a re-fire is NOT served the cancellation.
    const re = await ctx.sessions.mergeBatchTracked(P.mgrId, [b1.workerId, b2.workerId]);
    const rv = re.settled && re.ok ? re.value : undefined;
    check("(C4) a re-fire after the cancel is a FRESH run (gate called, batch landed), never a replayed cancellation", rv?.ok === true && rv.cancelled === undefined && ctx.gate.calls >= 1);
  }

  // ── (C2) SOLO parity ─────────────────────────────────────────────────────────────────────────────
  {
    const P = mk("c2"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    const spy = spyRed(ctx);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2, maxConcurrentGates: 1 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 2 });
    const w = await addWorker(db, P, "c2a", { "src/c2a.ts": "export const c2a = 1;\n" });
    const holder = occupySlot(ctx);
    const soloP = ctx.sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId); // 2+1 > 2 ⇒ due ⇒ gated ⇒ queues
    const entry = await waitUntil(() => queuedMerge(ctx), { timeoutMs: 60000, intervalMs: 20, label: "merge-batch-cancelled-not-red (C2): the solo gate is queued" });
    const cancel = await ctx.sessions.cancelGateOp(P.mgrId, entry.opId, { scope: { kind: "project" } });
    const r = await soloP;
    const v = r.settled && r.ok ? r.value : undefined;
    holder.release(); await holder.done;
    check("(C2) setup: the solo gate was cancelled while queued", cancel.outcome === "cancelled" && v?.cancelled === true && v.merged === false);
    const s = db.getMergeGateState(P.projId);
    check("(C2) SOLO parity: cancel records no red — gateOwed false, counter unchanged (2), no ring row", s.gateOwed === false && spy.red === 0 && s.ungatedSinceLastPass === 2 && s.recent.length === 0);
  }

  // ── (C5) the ASYNC settle nudge for a cancelled batch (sync budget forced to 0 so the settle arrives as a nudge) ──
  {
    const P = mk("c5"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    ctx.sessions.syncAttachBudgetMs = 0; // private readonly in TS, plain in JS: the settle is delivered ONLY as the nudge
    const spy = spyRed(ctx);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2, maxConcurrentGates: 1 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 1 });
    const b1 = await addWorker(db, P, "c5a", { "src/c5a.ts": "export const c5a = 1;\n" });
    const b2 = await addWorker(db, P, "c5b", { "src/c5b.ts": "export const c5b = 2;\n" });
    const holder = occupySlot(ctx);
    void ctx.sessions.mergeBatchTracked(P.mgrId, [b1.workerId, b2.workerId]);
    const entry = await waitUntil(() => queuedMerge(ctx), { timeoutMs: 60000, intervalMs: 20, label: "merge-batch-cancelled-not-red (C5): the batch gate is queued" });
    await ctx.sessions.cancelGateOp(P.mgrId, entry.opId, { scope: { kind: "project" } });
    await waitUntil(() => spy.msgs.some((m) => /\[loom:merge-batch-/.test(m)), { timeoutMs: 60000, intervalMs: 20, label: "merge-batch-cancelled-not-red (C5): the settle nudge" });
    holder.release(); await holder.done;
    const nudge = spy.msgs.find((m) => /\[loom:merge-batch-/.test(m)) ?? "";
    check("(C5) the settle nudge is [loom:merge-batch-cancelled], says NOTHING was started, and is not merge-batch-failed", /^\[loom:merge-batch-cancelled\]/.test(nudge) && /NOTHING was started/.test(nudge) && !spy.msgs.some((m) => /\[loom:merge-batch-failed\]/.test(m)));
  }

  // ── (C6) a cancelled batch keeps each candidate's OWN reason (one reporting path) and still starts nothing ──────────
  {
    const P = mk("c6"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2, maxConcurrentGates: 1 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 1 });
    const b1 = await addWorker(db, P, "c6a", { "src/c6a.ts": "export const c6a = 1;\n" });
    const b2 = await addWorker(db, P, "c6b", { "src/c6b.ts": "export const c6b = 2;\n" });
    const held = await addWorker(db, P, "c6h", { "src/c6h.ts": "export const c6h = 3;\n" });
    // Seam: mark the third candidate's branch as held (a retained, never-gated later commit), exactly what `isBranchHeld` reports for one.
    const origHeld = ctx.sessions.isBranchHeld.bind(ctx.sessions);
    ctx.sessions.isBranchHeld = async (branch, ...rest) => branch === held.branch ? { retain: { detail: { assembledTip: null, liveTip: null, phase: "pre-stop" } }, gitUnverified: false } : origHeld(branch, ...rest);
    const holder = occupySlot(ctx);
    const batchP = ctx.sessions.mergeBatchTracked(P.mgrId, [b1.workerId, b2.workerId, held.workerId]);
    const entry = await waitUntil(() => queuedMerge(ctx), { timeoutMs: 60000, intervalMs: 20, label: "merge-batch-cancelled-not-red (C6): the batch gate is queued" });
    await ctx.sessions.cancelGateOp(P.mgrId, entry.opId, { scope: { kind: "project" } });
    const r = await batchP;
    const v = r.settled && r.ok ? r.value : undefined;
    holder.release(); await holder.done;
    const by = (id) => v?.fallback.find((f) => f.workerSessionId === id);
    check("(C6) the cancelled batch started NOTHING: every candidate started:false, gate never called", v?.cancelled === true && v.fallback.length === 3 && v.fallback.every((f) => f.started === false) && ctx.gate.calls === 0);
    check("(C6) the HELD candidate keeps its own actionable reason (held, NOT re-attempted) plus the cancelled suffix", /held, NOT re-attempted/.test(by(held.workerId)?.reason ?? "") && /\(batch cancelled — not started\)$/.test(by(held.workerId)?.reason ?? ""));
    check("(C6) the ordinary candidates say the batch was cancelled before its gate ran, with the same suffix", [b1, b2].every((w) => /cancelled before its gate ran \(batch cancelled — not started\)$/.test(by(w.workerId)?.reason ?? "")));
  }

  // ── (C3) NEGATIVE CONTROL: a real batch red is still recorded ────────────────────────────────────
  {
    const P = mk("c3"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    const spy = spyRed(ctx);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2, maxConcurrentGates: 1 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 1 });
    const b1 = await addWorker(db, P, "c3a", { "src/c3a.ts": "export const c3a = 1;\n" });
    const b2 = await addWorker(db, P, "c3b", { "src/c3b.ts": "export const c3b = 2;\n" });
    ctx.gate.failNext = true;
    const r = await ctx.sessions.mergeBatchTracked(P.mgrId, [b1.workerId, b2.workerId]);
    const v = r.settled && r.ok ? r.value : undefined;
    const s = db.getMergeGateState(P.projId);
    check("(C3) a REAL failing batch gate is still a red: recorded exactly once with candidates:2 (its per-candidate fallback gated solos then legitimately pass and clear owed), not marked cancelled", v?.ok === false && v.cancelled === undefined && spy.red === 1 && s.recent.filter((e) => e.result === "fail" && e.candidates === 2).length === 1);
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a merge_batch cancelled while queued is not a gate red and starts nothing; solo and batch share one rule; a real red is still recorded."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
