import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6f13746c — the merge-gate INTERVAL: ordering/reservation/batch half. See merge-gate-interval.mjs
// for the pure rule table (U) and the core SOLO/OWED/cadence/pin scenarios (S/O/E/G/P/R1/R2) — this file
// (card 8b5e002d) was split off that one so the two can schedule in separate test-runner lanes; every
// scenario/assertion below is unchanged from before the split, just moved.
//
//   (R4) a batch's not-due K stays RESERVED while its fallbacks are in flight: an overlapping solo is gated.
//   (Q) ORDER: counter order == main's order. A passing gate's reset must NOT erase an ungated landing that squashed AFTER it on main.
//   (O2) a skip decision must not outlive a newly OWED gate: refused in-lock, reservation released, nothing squashed, never cached.
//   (X) per-REPO state: a pass in repo B never resets repo A's count; the agent view / decision are per repo.
//   (C) a HUMAN cadence change clears gateOwed (+ a `cleared` ring row) but NOT the ungated counter.
//   (B) BATCH, N=3: K=2 at ungated 0 is not due ⇒ fallback lands both ungated; a second K=2 IS due ⇒ the real shared batch gate runs.
//   (W) RED ORDER (card 593cedc8): a gated solo FAILS while a skip-decided solo waits on the guard ⇒ the waiter is refused in-lock as
//       gate-owed, nothing squashed; the red's bookkeeping waits for a WITNESS (the waiter's confirm settling, else an 8s bound) so a
//       red recorded AFTER the release loses deterministically (RED pre-fix). (WB) the batch analogue. (W2) cadence `every` is harmless.
//   (BF) BATCH failing gate under interval: recorded ONCE with candidates:K (no branchTip), gateOwed true.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-interval-ordering.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil, deferred } from "./_wait.mjs";
const noReap = async () => ({ killedPids: [] });

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgord-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { withCanonicalIndexLock } = await import("../dist/git/repo-lock.js");
const M = await import("../dist/orchestration/merge-gate-interval.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mgord@loom -c user.name=mgord";
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

// ============ fixtures ============
// Card 8b5e002d: same template-repo-via-fs.cpSync fixture speedup as merge-gate-interval.mjs (see that
// file's own comment) — real `git init` is ~300-450ms of subprocess spawn per scenario on Windows; a
// plain recursive filesystem copy of an already-built, byte-identical baseline repo needs none.
const TEMPLATE_REPO = path.join(os.tmpdir(), `loom-mgord-tmpl-${sfx}`);
registerForCleanup(TEMPLATE_REPO);
(() => {
  mkdirp(TEMPLATE_REPO);
  fs.writeFileSync(path.join(TEMPLATE_REPO, "README.md"), "# mgint\n");
  mkdirp(path.join(TEMPLATE_REPO, "src"));
  fs.writeFileSync(path.join(TEMPLATE_REPO, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email mgint@loom && git config user.name mgint`, { cwd: TEMPLATE_REPO });
  commitAll(TEMPLATE_REPO, "init", GIT_ID);
})();
function makeRepo(repo) {
  mkdirp(path.dirname(repo));
  registerForCleanup(repo);
  fs.cpSync(TEMPLATE_REPO, repo, { recursive: true });
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

/** RED-ORDER WITNESS (card 593cedc8). Stubs the red's bookkeeping to wait until EITHER the skip-decided waiter's confirm has SETTLED
 *  ("waiter-settled" — the waiter got through its in-lock owed check before the red existed, i.e. the red is recorded AFTER the release: the
 *  bug) OR a bounded timeout elapses ("bound" — the waiter could not settle while the red was recorded: the fix). `fired` names which one
 *  happened. The bound is a cap; the waiter's settlement is the witness. Call `w.watch(promise)` with the waiter's confirm. */
function armRedWitness(ctx, boundMs = 8_000) {
  const w = { fired: null, calls: 0, waiterHadGuard: null };
  const settled = deferred();
  // Second, TIMING-INDEPENDENT witness: has the waiter ALREADY acquired its repo guard when the trigger fires? Under the fix the gate still holds
  // the guard while the red is recorded, so it cannot have; under any post-release ordering it acquires within ms, however slowly it settles.
  let guardAcquired = false;
  const sem = ctx.sessions.gateSemaphore;
  const origAcq = sem.acquireRepoGuardOnly.bind(sem);
  sem.acquireRepoGuardOnly = async (...a) => { const rel = await origAcq(...a); guardAcquired = true; return rel; };
  w.watch = (p) => { p.then(() => settled.resolve(), () => settled.resolve()); return p; };
  const origFail = ctx.sessions.recordMergeGateFailure.bind(ctx.sessions);
  ctx.sessions.recordMergeGateFailure = async (...args) => {
    w.calls++;
    let timer;
    w.fired = await Promise.race([settled.promise.then(() => "waiter-settled"), new Promise((r) => { timer = setTimeout(() => r("bound"), boundMs); })]);
    clearTimeout(timer);
    w.waiterHadGuard = guardAcquired;
    return origFail(...args);
  };
  return w;
}

const dbs = [];
const worktrees = [];
try {
  // ── (R4) a batch's not-due decision RESERVES its K until its fallbacks settle — an overlapping solo sees it ─────────
  {
    const P = mk("r4"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2, maxConcurrentWorkers: 4 });
    const w1 = await addWorker(db, P, "r4a", { "src/r4a.ts": "export const r4a = 1;\n" });
    const w2 = await addWorker(db, P, "r4b", { "src/r4b.ts": "export const r4b = 2;\n" });
    const w3 = await addWorker(db, P, "r4c", { "src/r4c.ts": "export const r4c = 3;\n" });
    let release;
    const held = withCanonicalIndexLock(P.repo, () => new Promise((r) => { release = r; }));
    const batchP = ctx.sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
    // wait (observable, not a sleep) until the batch's K=2 reservation is visible: a K=1 decision now reads 0 + 2 pending + 1 > 2 ⇒ gate
    await waitUntil(() => ctx.sessions.decideMergeGateFor(P.projId, 1).gate === true, { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-interval (R4): the batch's reservation is visible" });
    const soloP = confirm(ctx.sessions, P.mgrId, w3.workerId);
    release(); await held;
    await batchP;
    const v3 = await soloP;
    check("(R4) a solo overlapping the in-flight batch fallback was GATED (the batch's reserved K counted) — not a 3rd ungated landing past N=2", v3.merged === true && v3.gateRan === true && v3.skipReason === undefined);
    check("(R4) the batch's two candidates still landed ungated (gate-interval)", db.listEvents(P.mgrId).filter((e) => e.kind === "build_gate" && e.detail?.skipReason === "gate-interval").length === 2);
  }

  // ── (Q) the counter's order equals main's order ────────────────────────────────────────────────────
  {
    const P = mk("q"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 5 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 4 });
    const b1 = await addWorker(db, P, "q1", { "src/q1.ts": "export const q1 = 1;\n" });
    const b2 = await addWorker(db, P, "q2", { "src/q2.ts": "export const q2 = 2;\n" });
    const sw = await addWorker(db, P, "q3", { "src/q3.ts": "export const q3 = 3;\n" });
    let releaseGate; ctx.gate.hold = new Promise((r) => { releaseGate = r; });
    const batchP = ctx.sessions.mergeBatchTracked(P.mgrId, [b1.workerId, b2.workerId]);
    await waitUntil(() => ctx.gate.calls === 1, { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-interval (Q): the batch gate is running (holding the repo guard)" });
    const soloP = confirm(ctx.sessions, P.mgrId, sw.workerId); // 4+pending0+1 > 5 is false ⇒ SKIP-decided; then it waits on the repo guard
    await waitUntil(() => ctx.spy.decide >= 2, { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-interval (Q): the solo has taken its skip decision" });
    // hold the BATCH's post-guard finalize (its workers look alive) until the SOLO has fully landed — an event, not a time window: in the buggy
    // order (record in finalize) the solo records 5 first and the batch's later pass then resets it to 0.
    holdAlive.add(b1.workerId); holdAlive.add(b2.workerId);
    releaseGate();
    const vs = await soloP;
    const pollsWhenSoloSettled = Math.max(alivePolls.get(b1.workerId) ?? 0, alivePolls.get(b2.workerId) ?? 0);
    holdAlive.clear();
    const rb = await batchP;
    const vb = rb.settled && rb.ok ? rb.value : undefined;
    check("(Q) the gated batch landed both and the overlapping solo landed UNGATED (gate-interval) after it", vb?.ok === true && vb.landed.length === 2 && vs.merged === true && vs.skipReason === "gate-interval" && ctx.gate.calls === 1);
    check("(Q) the hold was still in force when the solo settled (finalize's death-poll wait, 600 polls here, not exhausted), so the batch's finalize could not have run first", pollsWhenSoloSettled < 600);
    check("(Q) records landed in main's order: the batch's pass, THEN the solo's ungated landing", JSON.stringify(ctx.spy.recorded) === JSON.stringify(["pass", "ungated"]));
    check("(Q) the ungated solo squashed AFTER the batch on main, so the counter ends at 1 — the pass's reset did NOT erase it (0 would be the bug)", db.getMergeGateState(P.projId).ungatedSinceLastPass === 1);
  }
  // ── (O2) a skip decision does not outlive a newly OWED gate ─────────────────────────────────────────
  {
    const P = mk("o2"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 1 });
    const b1 = await addWorker(db, P, "o2a", { "src/o2a.ts": "export const o2a = 1;\n" });
    const b2 = await addWorker(db, P, "o2b", { "src/o2b.ts": "export const o2b = 2;\n" });
    const sw = await addWorker(db, P, "o2s", { "src/o2s.ts": "export const o2s = 3;\n" });
    let releaseGate; ctx.gate.hold = new Promise((r) => { releaseGate = r; }); ctx.gate.failNext = true;
    const batchP = ctx.sessions.mergeBatchTracked(P.mgrId, [b1.workerId, b2.workerId]); // 1+2 > 2 ⇒ gated; its gate will FAIL
    await waitUntil(() => ctx.gate.calls === 1, { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-interval (O2): the batch gate is running" });
    const soloP = confirm(ctx.sessions, P.mgrId, sw.workerId); // 1+0+1 > 2 is false ⇒ skip-decided, waits on the guard
    await waitUntil(() => ctx.spy.decide >= 2, { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-interval (O2): the solo has taken its skip decision" });
    ctx.sessions.mergeGateGateNext(P.projId); // a gate becomes owed AFTER the solo's skip decision
    releaseGate();
    await batchP;
    const vs = await soloP;
    check("(O2) the solo's skip decision was REFUSED in-lock because a gate is now owed (merged:false, nothing squashed)", vs.merged === false && /a gate is now owed/.test(vs.reason ?? "") && !fs.existsSync(path.join(P.repo, "src", "o2s.ts")));
    // (the failed batch's two candidates then fell back to solo confirms that ran the owed gate and PASSED, which clears the flag — so the
    // remaining checks are about what the refusal left behind)
    check("(O2) the refused confirm RELEASED its reservation (a fresh K=1 decision sees ONLY the recorded count — a leaked unit would tip it to gate)", (() => { const st = db.getMergeGateState(P.projId); return !st.gateOwed && ctx.sessions.decideMergeGateFor(P.projId, 1).gate === (st.ungatedSinceLastPass + 1 > 2); })());
    ctx.gate.hold = null;
    const vs2 = await confirm(ctx.sessions, P.mgrId, sw.workerId);
    check("(O2) NEVER cached: the re-call re-decides fresh and lands (not a replayed refusal)", vs2.merged === true && vs2.cacheHit === undefined && fs.existsSync(path.join(P.repo, "src", "o2s.ts")));
  }

  // ── (X) per-REPO state ─────────────────────────────────────────────────────────────────────────────
  {
    const P = mk("x"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    db.updateProject(P.projId, { repos: [{ key: "repoB", path: P.repo + "-b" }] });
    ctx.sessions.recordMergeGateOutcome(P.projId, { kind: "ungated", landed: 2 }, "primary");
    ctx.sessions.recordMergeGateOutcome(P.projId, { kind: "ungated", landed: 1 }, "repoB");
    ctx.sessions.recordMergeGateOutcome(P.projId, { kind: "pass", sha: "bbb", opId: "opB", periodic: true }, "repoB");
    check("(X) a PASS in repo B does NOT reset repo A's (primary) count", db.getMergeGateState(P.projId, "primary").ungatedSinceLastPass === 2 && db.getMergeGateState(P.projId, "repoB").ungatedSinceLastPass === 0);
    check("(X) lastPassSha is per repo (B has one, primary has none)", db.getMergeGateState(P.projId, "repoB").lastPassSha === "bbb" && db.getMergeGateState(P.projId, "primary").lastPassSha === null);
    check("(X) the agent view is per repo and names it (repoKey)", (() => { const a = ctx.sessions.mergeGateAgentView(P.projId, "primary"); const bb = ctx.sessions.mergeGateAgentView(P.projId, "repoB"); return a.repoKey === "primary" && a.ungatedSinceLastPass === 2 && bb.repoKey === "repoB" && bb.ungatedSinceLastPass === 0; })());
    check("(X) the decision is per repo (primary at 2 of N=3 ⇒ K=2 gated; repoB at 0 ⇒ K=2 skipped)", ctx.sessions.decideMergeGateFor(P.projId, 2, undefined, "primary").gate === true && ctx.sessions.decideMergeGateFor(P.projId, 2, undefined, "repoB").gate === false);
    check("(X) a reservation is per (project, repo) too", (() => { const h = ctx.sessions.reserveMergeGate(P.projId, "repoB", 3); const gB = ctx.sessions.decideMergeGateFor(P.projId, 1, undefined, "repoB").gate; const gA = ctx.sessions.decideMergeGateFor(P.projId, 1, undefined, "primary").gate; h.release(); return gB === true && gA === false && ctx.sessions.decideMergeGateFor(P.projId, 1, undefined, "repoB").gate === false; })());
    check("(X) an unknown repoKey has no status (undefined)", ctx.sessions.mergeGateStatus(P.projId, "nope") === undefined && ctx.sessions.mergeGateStatus(P.projId, "repoB").repoKey === "repoB");
    check("(X) the state survives deleteProject cascade cleanly (all repo rows removed)", (() => { db.deleteProject(P.projId); return db.listMergeGateStates(P.projId).length === 0; })());
  }

  // ── (C) a human cadence change clears gateOwed (not the counter) ───────────────────────────────────
  {
    const P = mk("c2"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 2, gateOwed: true });
    const cleared = ctx.sessions.clearMergeGateOwedOnCadenceChange(P.projId);
    const st = db.getMergeGateState(P.projId);
    check("(C) clearMergeGateOwedOnCadenceChange cleared the owed repo and reports it", cleared.length === 1 && cleared[0] === "primary");
    check("(C) gateOwed false, ungated counter KEPT (2), a `cleared` ring row with reason cadence-changed", st.gateOwed === false && st.ungatedSinceLastPass === 2 && st.recent.at(-1)?.result === "cleared" && st.recent.at(-1)?.reason === "cadence-changed");
    check("(C) a second call is a no-op (nothing owed ⇒ nothing cleared, no new ring row)", ctx.sessions.clearMergeGateOwedOnCadenceChange(P.projId).length === 0 && db.getMergeGateState(P.projId).recent.length === st.recent.length);
  }

  // ── (B) BATCH, N=3 ────────────────────────────────────────────────────────────────────────────────
  {
    const P = mk("b"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const b1 = await addWorker(db, P, "b1", { "src/b1.ts": "export const b1 = 1;\n" });
    const b2 = await addWorker(db, P, "b2", { "src/b2.ts": "export const b2 = 2;\n" });
    const r1 = await ctx.sessions.mergeBatchTracked(P.mgrId, [b1.workerId, b2.workerId]);
    const v1 = r1.settled && r1.ok ? r1.value : undefined;
    check("(B1) K=2 at ungated 0 (0+2>3 false) is NOT due: ok:false, reason names the interval, every fallback entry too", v1?.ok === false && v1.reason === "merge gate interval: not this landing's turn" && v1.fallback.length === 2 && v1.fallback.every((f) => f.reason === "merge gate interval: not this landing's turn"));
    let landed = false;
    try { landed = await waitUntil(() => db.getTask(b1.taskId).columnKey === "done" && db.getTask(b2.taskId).columnKey === "done", { timeoutMs: 60000, intervalMs: 50, label: "merge-gate-interval (B1): both fallback merges landed" }); } catch { landed = false; }
    check("(B1) both branches landed through the per-branch fallback; the gate command was NEVER called", landed && ctx.gate.calls === 0 && fs.existsSync(path.join(P.repo, "src", "b1.ts")) && fs.existsSync(path.join(P.repo, "src", "b2.ts")));
    check("(B1) decide ran ONCE for the whole batch (the fallback HONOURS it — no per-branch re-decide)", ctx.spy.decide === 1);
    check("(B1) the recorder ran ONCE PER LANDED CANDIDATE (2), both ungated; counter = 2", ctx.spy.record === 2 && ctx.spy.recorded.every((k) => k === "ungated") && db.getMergeGateState(P.projId).ungatedSinceLastPass === 2);
    check("(B1) both landings are skipReason gate-interval build_gate rows", db.listEvents(P.mgrId).filter((e) => e.kind === "build_gate" && e.detail?.skipReason === "gate-interval").length === 2);
    reset(ctx);

    const b3 = await addWorker(db, P, "b3", { "src/b3.ts": "export const b3 = 3;\n" });
    const b4 = await addWorker(db, P, "b4", { "src/b4.ts": "export const b4 = 4;\n" });
    const r2 = await ctx.sessions.mergeBatchTracked(P.mgrId, [b3.workerId, b4.workerId]);
    const v2 = r2.settled && r2.ok ? r2.value : undefined;
    check("(B2) K=2 at ungated 2 (2+2>3) IS due: the real shared batch gate ran ONCE and landed both", v2?.ok === true && v2.landed.length === 2 && ctx.gate.calls === 1);
    check("(B2) decide ONCE; a passing BATCH gate records ONCE (not per candidate), as a PASS", ctx.spy.decide === 1 && ctx.spy.record === 1 && ctx.spy.recorded.every((k) => k === "pass"));
    const sb = db.getMergeGateState(P.projId);
    check("(B2) counter reset to 0; lastPassSha = main HEAD; ONE ring row for the batch op (candidates 2)", sb.ungatedSinceLastPass === 0 && sb.lastPassSha === head(P.repo) && sb.recent.length === 1 && sb.recent[0].candidates === 2 && sb.recent[0].result === "pass" && sb.recent[0].toSha === sb.lastPassSha);
  }

  // ── (W) a gate RED is recorded before the gate releases its repo guard (card 593cedc8) ─────────────
  {
    const P = mk("w"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 2 }); // 2+1 > 2 ⇒ the first solo is GATED
    const a = await addWorker(db, P, "wa", { "src/wa.ts": "export const wa = 1;\n" });
    const b = await addWorker(db, P, "wb", { "src/wb.ts": "export const wb = 2;\n" });
    const w = armRedWitness(ctx);
    let releaseGate; ctx.gate.hold = new Promise((r) => { releaseGate = r; }); ctx.gate.failNext = true;
    const aP = confirm(ctx.sessions, P.mgrId, a.workerId);
    await waitUntil(() => ctx.gate.calls === 1, { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-interval (W): the gated solo's gate is running" });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 0 }); // an interleaved pass elsewhere: the next decision is a SKIP
    const bP = w.watch(confirm(ctx.sessions, P.mgrId, b.workerId));
    await waitUntil(() => ctx.spy.decide >= 2, { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-interval (W): the second solo has taken its skip decision" });
    releaseGate();
    const va = await aP; const vb = await bP;
    check("(W) precondition: the waiter could NOT settle or take the repo guard before the red was recorded (witness fired: " + w.fired + ", waiterHadGuard: " + w.waiterHadGuard + ")", w.calls >= 1 && w.fired === "bound" && w.waiterHadGuard === false);
    check("(W) the gated solo FAILED (merged:false) and owes the next landing a gate", va.merged === false && db.getMergeGateState(P.projId).gateOwed === true);
    check("(W) the skip-decided waiter was REFUSED in-lock as gate-owed and nothing was squashed (a landing on top of a known red is the bug)", vb.merged === false && /a gate is now owed/.test(vb.reason ?? "") && !fs.existsSync(path.join(P.repo, "src", "wb.ts")));
    check("(W) the red was recorded exactly ONCE (opId-deduped ring)", db.getMergeGateState(P.projId).recent.filter((e) => e.result === "fail").length === 1);
  }
  // ── (WB) the BATCH analogue: a failing batch gate records its red before releasing the guard (card 593cedc8) ──
  {
    const P = mk("wb"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 1 });
    const b1 = await addWorker(db, P, "wb1", { "src/wb1.ts": "export const wb1 = 1;\n" });
    const b2 = await addWorker(db, P, "wb2", { "src/wb2.ts": "export const wb2 = 2;\n" });
    const sw = await addWorker(db, P, "wbs", { "src/wbs.ts": "export const wbs = 3;\n" });
    const w = armRedWitness(ctx);
    let releaseGate; ctx.gate.hold = new Promise((r) => { releaseGate = r; }); ctx.gate.failNext = true;
    const batchP = ctx.sessions.mergeBatchTracked(P.mgrId, [b1.workerId, b2.workerId]); // 1+2 > 2 ⇒ gated; its gate will FAIL
    await waitUntil(() => ctx.gate.calls === 1, { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-interval (WB): the batch gate is running" });
    const soloP = w.watch(confirm(ctx.sessions, P.mgrId, sw.workerId)); // 1+0+1 > 2 is false ⇒ skip-decided, waits on the guard
    await waitUntil(() => ctx.spy.decide >= 2, { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-interval (WB): the solo has taken its skip decision" });
    releaseGate();
    await batchP;
    const vs = await soloP;
    check("(WB) precondition: the waiter could NOT settle or take the repo guard before the red was recorded (witness fired: " + w.fired + ", waiterHadGuard: " + w.waiterHadGuard + ")", w.calls >= 1 && w.fired === "bound" && w.waiterHadGuard === false);
    check("(WB) the skip-decided waiter was REFUSED in-lock as gate-owed and nothing was squashed", vs.merged === false && /a gate is now owed/.test(vs.reason ?? "") && !fs.existsSync(path.join(P.repo, "src", "wbs.ts")));
    check("(WB) the batch red was recorded exactly ONCE with candidates:2", db.getMergeGateState(P.projId).recent.filter((e) => e.result === "fail" && e.candidates === 2).length === 1);
  }
  // ── (W2) cadence `every`: recording a red before the release is harmless (no owed flag) ─────────────
  {
    const P = mk("w2"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "on" });
    const a = await addWorker(db, P, "w2a", { "src/w2a.ts": "export const w2a = 1;\n" });
    ctx.gate.failNext = true;
    const va = await confirm(ctx.sessions, P.mgrId, a.workerId);
    const s = db.getMergeGateState(P.projId);
    check("(W2) under `every` the red is recorded once but does NOT owe", va.merged === false && s.gateOwed === false && s.recent.filter((e) => e.result === "fail").length === 1);
  }

  // ── (BF) BATCH failing gate ───────────────────────────────────────────────────────────────────────
  {
    const P = mk("bf"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 1 });
    const f1 = await addWorker(db, P, "f1", { "src/f1.ts": "export const f1 = 1;\n" });
    const f2 = await addWorker(db, P, "f2", { "src/f2.ts": "export const f2 = 2;\n" });
    ctx.gate.pass = false;
    const r = await ctx.sessions.mergeBatchTracked(P.mgrId, [f1.workerId, f2.workerId]);
    const v = r.settled && r.ok ? r.value : undefined;
    check("(BF) K=2 at N=1 is due (0+2>1): the batch gate ran and FAILED ⇒ ok:false, nothing landed by the batch", v?.ok === false && v.landed.length === 0 && ctx.gate.calls >= 1);
    const s = db.getMergeGateState(P.projId);
    const batchRow = s.recent.find((e) => e.candidates === 2);
    check("(BF) the batch failure is recorded ONCE with candidates:2 and NO branchTip", batchRow && batchRow.result === "fail" && batchRow.branchTip === undefined && batchRow.branch === undefined && s.recent.filter((e) => e.candidates === 2).length === 1);
    check("(BF) gateOwed:true (a failing periodic batch gate owes the next landing)", s.gateOwed === true);
    check("(BF) the ungated counter did not advance (nothing landed)", s.ungatedSinceLastPass === 0);
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the merge-gate interval's reservation accounting is per (project, repo), ordered to main's landing order, and never leaks across a refused/overlapping confirm."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
