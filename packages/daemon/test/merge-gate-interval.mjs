import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6f13746c — the merge-gate INTERVAL: BEHAVIOUR half. REAL git on temp repos + an INJECTED `runGate` seam whose
// CALL COUNTER proves whether the gate command ran (same style as merge-gate-off.mjs), plus spies that COUNT how many
// times the ONE decision helper (`decideMergeGateFor`) and the ONE outcome recorder (`recordMergeGateOutcome`) run.
//
//   (U) the PURE rule table (orchestration/merge-gate-interval.ts): every / interval boundary (ungated + K > N) /
//       owed / never, K-batch arithmetic, changing N mid-cycle, a pass resets, a failing periodic gate owes, a
//       failing `every` gate does NOT owe, the 6-entry ring + one-row-per-opId dedupe, lastFailure fromSha=null.
//   (S) SOLO, N=2, mergeGate off: two landings go ungated (skipReason "gate-interval", gate never called, note
//       "ungated 1/2", "2/2"), the THIRD runs the real gate (called once, merged, gateRan:true, no skipReason, note
//       says periodic + counter reset), the FOURTH is ungated again (1/2) — decide called ONCE and recorder ONCE per
//       landing; the state SURVIVES a fresh Db on the same file (restart persistence).
//   (O) OWED: N=1. landing 1 ungated; landing 2 is due and the gate FAILS ⇒ merged:false, gateOwed:true, lastFailure
//       {fromSha:null (never passed), toSha:main HEAD, branchTip:that branch's tip}, ungated NOT advanced; landing 3
//       (a different worker) is gated because it is OWED (gate called) and a pass clears owed + lastFailure.
//   (E) cadence `every` (gate ON): a FAILING gate is recorded in `recent`/`lastFailure` but does NOT owe.
//   (G) cadence `never`: an ungated landing is skipReason "gate-disabled" and STILL counts; gate-next (any cadence)
//       makes the next landing gated, and a pass clears it.
//   (P) PIN: an interval-SKIP landing (gateRan:false) is pinned to the tip the "land ungated" decision was acted on — a worker commit
//       landing after that but before mergeBranch's lock is REFUSED in-lock (gateTipMoved, nothing squashed, counter not advanced, never
//       cached: the re-call lands the new tip ungated and counts once).
//   (R) RESERVATION: an ungated decision reserves its landing until it settles, so overlapping confirms cannot overshoot N —
//       (R1) N=5, a batch with 4 chosen + 2 overflow lands at most 5 ungated and the 6th is GATED; (R2) two OVERLAPPING solos at
//       ungated=N-1: one skips, one gates; (R3) a refused/never-landed confirm RELEASES its reservation (nothing leaks).
//       (R4) a batch's not-due K stays RESERVED while its fallbacks are in flight: an overlapping solo is gated.
//   (X) per-REPO state: a pass in repo B never resets repo A's count; the agent view / decision are per repo.
//   (C) a HUMAN cadence change clears gateOwed (+ a `cleared` ring row) but NOT the ungated counter.
//   (Q) ORDER: counter order == main's order. A passing gate's reset must NOT erase an ungated landing that squashed AFTER it on main:
//       N=5, ungated=4; a gated batch holds the repo guard; an overlapping solo skip-decided and waits; the batch fast-forwards, the solo
//       squashes after it ⇒ the counter ends at 1 (not 0).
//   (O2) a skip decision must not outlive a newly OWED gate: refused in-lock ("a gate is now owed"), reservation released, nothing squashed,
//       never cached; the re-call decides gated.
//   (B) BATCH, N=3: K=2 at ungated 0 is not due ⇒ ONE decision, both branches land through the fallback with reason
//       "merge gate interval: not this landing's turn" (gate never called), recorder twice, counter 2; a second K=2
//       (2+2>3) is due ⇒ the REAL shared batch gate runs ONCE, both land, counter resets, ONE ring row (candidates 2).
//   (W) RED ORDER (card 593cedc8): a gated solo FAILS while a skip-decided solo waits on the guard ⇒ the waiter is refused in-lock as gate-owed,
//       nothing squashed; the red's bookkeeping waits for a WITNESS (the waiter's confirm settling, else an 8s bound) so a red recorded AFTER the release loses deterministically (RED pre-fix).
//       (WB) the batch analogue; (W2) under cadence `every` recording a red early is harmless (no owed).
//   (BF) BATCH failing gate under interval: recorded ONCE with candidates:K (no branchTip), gateOwed true.
//
// NOT COVERED: the web UI; a batch dropped-candidate mix; the 479f449f evicted-predecessor rescue landing (it carries
// no gate info, so it is deliberately not counted — see the decision record).
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-interval.mjs
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

// ============ (U) the pure rule table ============
{
  const st = (o = {}) => ({ ...M.emptyMergeGateState(), ...o });
  const D = (state, orch, K = 1) => M.decideMergeGate(state, orch, K);
  const on = { mergeGate: "on" }, off = { mergeGate: "off" }, off3 = { mergeGate: "off", mergeGateInterval: 3 };
  check("(U) every: gate on ⇒ gate, reason every, identityValue on", D(st(), on).gate === true && D(st(), on).reason === "every" && D(st(), on).identityValue === "on");
  check("(U) never: gate off, no interval ⇒ skip, skipReason gate-disabled, identityValue off", (() => { const d = D(st(), off); return d.gate === false && d.reason === "skip-never" && d.skipReason === "gate-disabled" && d.identityValue === "off"; })());
  check("(U) never keeps skipping however high the counter (it is the 'unverified' figure)", D(st({ ungatedSinceLastPass: 500 }), off).gate === false);
  check("(U) interval N=3: ungated 0,1 ⇒ skip (0+1>3 no, 1+1>3 no)", !D(st({ ungatedSinceLastPass: 0 }), off3).gate && !D(st({ ungatedSinceLastPass: 1 }), off3).gate);
  check("(U) interval N=3: ungated 2 ⇒ STILL skip (2+1>3 is false) — N landings go ungated", !D(st({ ungatedSinceLastPass: 2 }), off3).gate);
  check("(U) interval N=3: ungated 3 ⇒ GATE (3+1>3), reason interval-due", (() => { const d = D(st({ ungatedSinceLastPass: 3 }), off3); return d.gate && d.reason === "interval-due"; })());
  check("(U) interval skip carries skipReason gate-interval", D(st(), off3).skipReason === "gate-interval");
  check("(U) batch K counts branches: ungated 1 + K=2 ⇒ 3 > 3 false ⇒ skip; K=3 ⇒ 4 > 3 ⇒ gate", !D(st({ ungatedSinceLastPass: 1 }), off3, 2).gate && D(st({ ungatedSinceLastPass: 1 }), off3, 3).gate);
  check("(U) owed beats every skip: cadence never + owed ⇒ gate, reason owed", (() => { const d = D(st({ gateOwed: true }), off); return d.gate && d.reason === "owed"; })());
  check("(U) changing N mid-cycle clamps naturally: 5 ungated, N lowered to 2 ⇒ gate; raised to 9 ⇒ skip", D(st({ ungatedSinceLastPass: 5 }), { mergeGate: "off", mergeGateInterval: 2 }).gate && !D(st({ ungatedSinceLastPass: 5 }), { mergeGate: "off", mergeGateInterval: 9 }).gate);
  // transitions
  check("(U) pending reservations count like landed ones: N=3, ungated 1 + pending 1 + K=1 = 3 ⇒ skip; pending 2 ⇒ 4 > 3 ⇒ gate", !M.decideMergeGate(st({ ungatedSinceLastPass: 1 }), off3, 1, 1).gate && M.decideMergeGate(st({ ungatedSinceLastPass: 1 }), off3, 1, 2).gate);
  check("(U) pending is ignored under cadence every/never (only `interval` counts)", M.decideMergeGate(st(), on, 1, 99).reason === "every" && M.decideMergeGate(st(), off, 1, 99).gate === false);
  { const owed = M.applyGateFail(st({ ungatedSinceLastPass: 4, lastPassSha: "P" }), { at: "T", opId: "o", toSha: "H", periodic: true });
    const cl = M.applyCadenceCleared(owed, "T9");
    check("(U) applyCadenceCleared: owed cleared, ungated counter KEPT, a `cleared`/cadence-changed ring row appended", cl.gateOwed === false && cl.ungatedSinceLastPass === 4 && cl.recent.at(-1).result === "cleared" && cl.recent.at(-1).reason === "cadence-changed" && cl.lastFailure !== null);
    check("(U) applyCadenceCleared is a NO-OP (same object) when nothing was owed", M.applyCadenceCleared(st(), "T") === st() || (() => { const z = st(); return M.applyCadenceCleared(z, "T") === z; })()); }
  const s1 = M.applyUngatedLanding(st(), 2);
  check("(U) an ungated landing adds the LANDED count", s1.ungatedSinceLastPass === 2 && M.applyUngatedLanding(s1, 1).ungatedSinceLastPass === 3);
  const pass = M.applyGatePass(st({ ungatedSinceLastPass: 5, gateOwed: true, lastFailure: { at: "t", result: "fail", opId: "x", fromSha: null, toSha: "h" } }), { at: "T1", sha: "sha1", opId: "op1", periodic: true, candidates: 2 });
  check("(U) ANY pass resets: counter 0, owed false, lastFailure cleared, lastPass* set, ring row written", pass.ungatedSinceLastPass === 0 && pass.gateOwed === false && pass.lastFailure === null && pass.lastPassAt === "T1" && pass.lastPassSha === "sha1" && pass.recent.length === 1 && pass.recent[0].candidates === 2);
  check("(U) a NON-periodic pass (cadence every) resets but writes NO ring row", M.applyGatePass(st({ ungatedSinceLastPass: 2 }), { at: "T", sha: "s", opId: "o", periodic: false }).recent.length === 0);
  const fail = M.applyGateFail(st({ lastPassSha: "P" }), { at: "T2", opId: "op2", toSha: "H", branchTip: "B", periodic: true });
  check("(U) a failing PERIODIC gate owes, records fromSha=lastPassSha..toSha and the branchTip", fail.gateOwed === true && fail.lastFailure.fromSha === "P" && fail.lastFailure.toSha === "H" && fail.lastFailure.branchTip === "B" && fail.recent.length === 1);
  check("(U) a failing gate under `every` (periodic:false) records but does NOT owe", (() => { const f = M.applyGateFail(st(), { at: "T", opId: "o", toSha: "H", periodic: false }); return f.gateOwed === false && f.lastFailure !== null && f.recent.length === 1; })());
  check("(U) never-passed ⇒ fromSha is null (the UI says 'since tracking began')", M.applyGateFail(st(), { at: "T", opId: "o", toSha: "H", periodic: true }).lastFailure.fromSha === null);
  check("(U) a failure does NOT advance the ungated counter", M.applyGateFail(st({ ungatedSinceLastPass: 4 }), { at: "T", opId: "o", toSha: "H", periodic: true }).ungatedSinceLastPass === 4);
  let ring = st();
  for (let i = 0; i < 9; i++) ring = M.applyGateFail(ring, { at: `T${i}`, opId: `op${i}`, toSha: "H", periodic: true });
  check("(U) the ring is capped at 6 (newest kept)", ring.recent.length === 6 && ring.recent[0].opId === "op3" && ring.recent[5].opId === "op8");
  let dd = M.applyGatePass(st(), { at: "T", sha: "s", opId: "same", periodic: true });
  dd = M.applyGatePass(dd, { at: "T", sha: "s2", opId: "same", periodic: true });
  check("(U) one gate op ⇒ ONE ring row even when K landings each report it (opId dedupe)", dd.recent.length === 1);
  const av = M.agentViewOf(st({ ungatedSinceLastPass: 3 }), off3);
  check("(U) agentViewOf: nextLandingGated computed for a single branch (3+1>3 ⇒ true), key set exact (incl. repoKey)", av.nextLandingGated === true && av.repoKey === "primary" && JSON.stringify(Object.keys(av).sort()) === JSON.stringify(["cadence", "gateOwed", "interval", "nextLandingGated", "repoKey", "ungatedSinceLastPass"]));
  check("(U) counterNote: never for cadence every; 'ungated 2/3' for an ungated interval landing", M.counterNote(st(), on, { gatedLanding: true, periodic: false }) === undefined && /ungated 0\/3/.test(M.counterNote(st(), off3, { gatedLanding: false, periodic: false })));
}

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
  // ── (S) SOLO, N=2 ────────────────────────────────────────────────────────────────────────────────
  {
    const P = mk("s"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const ws = [];
    for (let i = 1; i <= 4; i++) ws.push(await addWorker(db, P, `s${i}`, { [`src/s${i}.ts`]: `export const s${i} = ${i};\n` }));

    const v1 = await confirm(ctx.sessions, P.mgrId, ws[0].workerId);
    check("(S1) landing 1: merged, gate NEVER called, skipped, skipReason gate-interval", v1.merged === true && ctx.gate.calls === 0 && v1.skipped === true && v1.skipReason === "gate-interval" && v1.gateRan === false);
    check("(S1) the warning says INTERVAL mode + not a pass (never the OFF wording)", /INTERVAL mode/.test(v1.warning ?? "") && /NOT a pass/.test(v1.warning ?? "") && !/is OFF/.test(v1.warning ?? ""));
    check("(S1) note reads \"ungated 1/2\"", /ungated 1\/2/.test(v1.mergeGateNote ?? ""));
    check("(S1) decide ran ONCE and the recorder ONCE (an ungated landing)", ctx.spy.decide === 1 && ctx.spy.record === 1 && ctx.spy.recorded[0] === "ungated");
    check("(S1) build_gate + merge_done events carry skipReason gate-interval", db.listEvents(P.mgrId).filter((e) => e.kind === "build_gate" && e.detail?.skipReason === "gate-interval").length === 1 && db.listEvents(P.mgrId).filter((e) => e.kind === "merge_done" && e.detail?.skipReason === "gate-interval").length === 1);
    check("(S1) gate_history outcome is \"skipped\" (never pass)", db.listGateEvents({ projectId: P.projId, limit: 10, offset: 0 }).items[0]?.outcome === "skipped");
    check("(S1) durable state: ungated 1, not owed, no lastPass", (() => { const s = db.getMergeGateState(P.projId); return s.ungatedSinceLastPass === 1 && !s.gateOwed && s.lastPassAt === null; })());
    reset(ctx);

    const v2 = await confirm(ctx.sessions, P.mgrId, ws[1].workerId);
    check("(S2) landing 2: still ungated, note \"ungated 2/2\", gate never called", v2.skipReason === "gate-interval" && /ungated 2\/2/.test(v2.mergeGateNote ?? "") && ctx.gate.calls === 0);
    check("(S2) the agent view now says the NEXT landing is gated", ctx.sessions.mergeGateAgentView(P.projId).nextLandingGated === true && ctx.sessions.mergeGateAgentView(P.projId).ungatedSinceLastPass === 2);
    // restart persistence: a FRESH Db on the same file sees the same durable state
    const db2 = new Db(); dbs.push(db2);
    check("(S2) RESTART PERSISTENCE: a fresh Db reads ungated 2", db2.getMergeGateState(P.projId).ungatedSinceLastPass === 2);
    reset(ctx);

    const v3 = await confirm(ctx.sessions, P.mgrId, ws[2].workerId);
    check("(S3) landing 3 is the periodic GATED landing: gate called once, merged, gateRan:true, no skip", v3.merged === true && ctx.gate.calls === 1 && v3.gateRan === true && v3.skipped === undefined && v3.skipReason === undefined);
    check("(S3) note names the periodic gated landing", /periodic gated landing/.test(v3.mergeGateNote ?? ""));
    check("(S3) decide ONCE, recorder ONCE (a pass)", ctx.spy.decide === 1 && ctx.spy.record === 1 && ctx.spy.recorded[0] === "pass");
    const s3 = db.getMergeGateState(P.projId);
    check("(S3) a GREEN gated landing resets: ungated 0, lastPassSha = main HEAD, one ring row (pass)", s3.ungatedSinceLastPass === 0 && s3.lastPassSha === head(P.repo) && s3.recent.length === 1 && s3.recent[0].result === "pass");
    reset(ctx);

    const v4 = await confirm(ctx.sessions, P.mgrId, ws[3].workerId);
    check("(S4) landing 4: ungated again (1/2), gate not called", v4.skipReason === "gate-interval" && /ungated 1\/2/.test(v4.mergeGateNote ?? "") && ctx.gate.calls === 0);
    // idempotent re-call after the branch landed: must NOT double count
    const before = db.getMergeGateState(P.projId).ungatedSinceLastPass;
    reset(ctx);
    await ctx.sessions.confirmWorkerMergeTracked(P.mgrId, ws[3].workerId).catch(() => {});
    check("(S4) re-confirming an already-landed branch does NOT re-count (counter unchanged)", db.getMergeGateState(P.projId).ungatedSinceLastPass === before);
  }

  // ── (O) OWED after a failing periodic gate ─────────────────────────────────────────────────────────
  {
    const P = mk("o"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 1 });
    const w1 = await addWorker(db, P, "o1", { "src/o1.ts": "export const o1 = 1;\n" });
    const w2 = await addWorker(db, P, "o2", { "src/o2.ts": "export const o2 = 2;\n" });
    const w3 = await addWorker(db, P, "o3", { "src/o3.ts": "export const o3 = 3;\n" });
    await confirm(ctx.sessions, P.mgrId, w1.workerId);
    reset(ctx);
    ctx.gate.pass = false;
    const mainBefore = head(P.repo);
    const v2 = await confirm(ctx.sessions, P.mgrId, w2.workerId);
    check("(O) the due gate ran and FAILED ⇒ merged:false, main untouched", ctx.gate.calls === 1 && v2.merged === false && head(P.repo) === mainBefore);
    const s2 = db.getMergeGateState(P.projId);
    check("(O) gateOwed:true after the failing periodic gate", s2.gateOwed === true);
    check("(O) lastFailure: fromSha null (never passed), toSha = main HEAD, branchTip = the rejected branch's tip", s2.lastFailure && s2.lastFailure.fromSha === null && s2.lastFailure.toSha === mainBefore && s2.lastFailure.branchTip === tip(P.repo, w2.branch) && s2.lastFailure.branch === w2.branch && s2.lastFailure.result === "fail");
    check("(O) the failure did NOT advance the ungated counter (still 1) and a fail ring row exists", s2.ungatedSinceLastPass === 1 && s2.recent.length === 1 && s2.recent[0].result === "fail");
    check("(O) the recorder was NOT called for the rejected landing (nothing landed)", ctx.spy.record === 0);
    check("(O) the agent view reports gateOwed + nextLandingGated", (() => { const a = ctx.sessions.mergeGateAgentView(P.projId); return a.gateOwed && a.nextLandingGated; })());
    reset(ctx);
    ctx.gate.pass = true;
    const d3 = ctx.sessions.decideMergeGateFor(P.projId, 1);
    check("(O) decision for the next landing: gate, reason owed", d3.gate === true && d3.reason === "owed");
    reset(ctx);
    const v3 = await confirm(ctx.sessions, P.mgrId, w3.workerId);
    check("(O) the NEXT landing (a different worker) is gated because it is OWED, and passes", ctx.gate.calls === 1 && v3.merged === true && v3.gateRan === true);
    const s3 = db.getMergeGateState(P.projId);
    check("(O) a pass clears owed + lastFailure and resets the counter; lastPassSha = main HEAD", s3.gateOwed === false && s3.lastFailure === null && s3.ungatedSinceLastPass === 0 && s3.lastPassSha === head(P.repo));
    check("(O) the failing op's ring row survives the pass (history), plus the pass row", s3.recent.length === 2 && s3.recent[0].result === "fail" && s3.recent[1].result === "pass");
  }

  // ── (E) cadence EVERY: a failing gate is recorded but does NOT owe ─────────────────────────────────
  {
    const P = mk("e"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, {});
    const w = await addWorker(db, P, "e1", { "src/e1.ts": "export const e1 = 1;\n" });
    ctx.gate.pass = false;
    const v = await confirm(ctx.sessions, P.mgrId, w.workerId);
    const s = db.getMergeGateState(P.projId);
    check("(E) gate ON + failing gate: rejected, recorded in lastFailure + recent, but gateOwed stays FALSE", v.merged === false && s.gateOwed === false && s.lastFailure !== null && s.recent.length === 1);
    check("(E) the agent view is cadence every and has no merge-gate note noise", ctx.sessions.mergeGateAgentView(P.projId).cadence === "every");
    ctx.gate.pass = true;
    const w2 = await addWorker(db, P, "e2", { "src/e2.ts": "export const e2 = 2;\n" }); // (the failed branch's red verdict is cached, so land a DIFFERENT worker)
    const v2 = await confirm(ctx.sessions, P.mgrId, w2.workerId);
    check("(E) a green landing lands with NO mergeGateNote (cadence every) and no ring row for a non-periodic pass", v2.merged === true && v2.mergeGateNote === undefined && db.getMergeGateState(P.projId).recent.length === 1);
  }

  // ── (G) cadence NEVER + gate-next ─────────────────────────────────────────────────────────────────
  {
    const P = mk("g"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off" });
    const w1 = await addWorker(db, P, "g1", { "src/g1.ts": "export const g1 = 1;\n" });
    const w2 = await addWorker(db, P, "g2", { "src/g2.ts": "export const g2 = 2;\n" });
    const v1 = await confirm(ctx.sessions, P.mgrId, w1.workerId);
    check("(G) never: landing is skipReason gate-disabled, gate not called, and STILL counts (ungated 1)", v1.skipReason === "gate-disabled" && ctx.gate.calls === 0 && db.getMergeGateState(P.projId).ungatedSinceLastPass === 1);
    check("(G) never: the note has no /N (\"ungated 1 since the last passing gate\")", /ungated 1 since/.test(v1.mergeGateNote ?? ""));
    const gn = ctx.sessions.mergeGateGateNext(P.projId);
    check("(G) gate-next ⇒ gateOwed:true, nextLandingGated:true (cadence never)", gn.gateOwed === true && gn.nextLandingGated === true && gn.cadence === "never");
    reset(ctx);
    const v2 = await confirm(ctx.sessions, P.mgrId, w2.workerId);
    check("(G) the next landing runs the gate (owed), passes, clears owed, resets the counter", ctx.gate.calls === 1 && v2.gateRan === true && (() => { const s = db.getMergeGateState(P.projId); return !s.gateOwed && s.ungatedSinceLastPass === 0; })());
  }

  // ── (P) the skip landing is pinned (card 01777ceb's pin, on the gate-interval sibling) ────────────────
  {
    const P = mk("p"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, "p1", { "src/p1.ts": "export const p1 = 1;\n" });
    let release;
    const held = withCanonicalIndexLock(P.repo, () => new Promise((r) => { release = r; }));
    const confirming = confirm(ctx.sessions, P.mgrId, w.workerId);
    await waitUntil(() => db.listEvents(P.mgrId).some((e) => e.kind === "build_gate" && e.detail?.skipReason === "gate-interval"), { timeoutMs: 60000, label: "the interval-skip decision was recorded" });
    fs.writeFileSync(path.join(w.worktreePath, "late.txt"), "late"); commitAll(w.worktreePath, "late worker commit", GIT_ID);
    release(); await held;
    const r1 = await confirming;
    check("(P) the interval-skip landing was REFUSED in-lock as gateTipMoved (nothing squashed, late commit not landed)", r1.merged === false && r1.gateTipMoved?.phase === "in-lock" && !fs.existsSync(path.join(P.repo, "p1.ts")) && !fs.existsSync(path.join(P.repo, "src", "p1.ts")) && !fs.existsSync(path.join(P.repo, "late.txt")));
    check("(P) it reports gateRan:false and the gate command was never called", r1.gateRan === false && ctx.gate.calls === 0);
    check("(P) a refused landing does NOT advance the ungated counter", db.getMergeGateState(P.projId).ungatedSinceLastPass === 0);
    check("(R3) the refused confirm RELEASED its reservation (K=2 at N=2 still skips — a leaked unit would make it 3>2 ⇒ gate)", ctx.sessions.decideMergeGateFor(P.projId, 2).gate === false);
    const r2 = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(P) never cached: the re-call lands the NEW tip (late.txt included) ungated, counted once", r2.merged === true && r2.skipReason === "gate-interval" && fs.existsSync(path.join(P.repo, "late.txt")) && db.getMergeGateState(P.projId).ungatedSinceLastPass === 1);
  }

  // ── (R1) N=5, batch of 4 chosen + 2 overflow ⇒ at most 5 ungated, the 6th gated ─────────────────────
  {
    const P = mk("r1"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 5, maxConcurrentWorkers: 4 });
    const ws = [];
    for (let i = 1; i <= 6; i++) ws.push(await addWorker(db, P, `r1-${i}`, { [`src/r1-${i}.ts`]: `export const r1_${i} = ${i};\n` }));
    const r = await ctx.sessions.mergeBatchTracked(P.mgrId, ws.map((w) => w.workerId));
    const v = r.settled && r.ok ? r.value : undefined;
    let landedAll = false;
    try { landedAll = await waitUntil(() => ws.every((w) => db.getTask(w.taskId).columnKey === "done"), { timeoutMs: 120000, intervalMs: 50, label: "merge-gate-interval (R1): all six landed" }); } catch { landedAll = false; }
    const skips = db.listEvents(P.mgrId).filter((e) => e.kind === "build_gate" && e.detail?.skipReason === "gate-interval").length;
    check("(R1) the batch chose 4 (+2 overflow) and the 4 chosen took the not-due fallback", v?.ok === false && v.fallback.length === 6);
    check("(R1) all six landed", landedAll);
    check("(R1) EXACTLY 5 landed ungated (skipReason gate-interval) and the 6th was GATED (the gate ran once)", skips === 5 && ctx.gate.calls === 1);
    check("(R1) the gated 6th landing reset the counter (0) — never more than N=5 ungated between passes", db.getMergeGateState(P.projId).ungatedSinceLastPass === 0);
  }

  // ── (R2) two OVERLAPPING solos at ungated = N-1: one skips, one gates ──────────────────────────────
  {
    const P = mk("r2"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 2 });
    const a = await addWorker(db, P, "r2a", { "src/r2a.ts": "export const r2a = 1;\n" });
    const b = await addWorker(db, P, "r2b", { "src/r2b.ts": "export const r2b = 2;\n" });
    const [va, vb] = await Promise.all([confirm(ctx.sessions, P.mgrId, a.workerId), confirm(ctx.sessions, P.mgrId, b.workerId)]);
    const skipped = [va, vb].filter((v) => v.skipReason === "gate-interval").length;
    const gated = [va, vb].filter((v) => v.gateRan === true).length;
    check("(R2) both merged; exactly ONE went ungated (gate-interval) and exactly ONE was gated (gateRan) — no overshoot past N=3", va.merged === true && vb.merged === true && skipped === 1 && gated === 1 && ctx.gate.calls === 1);
    check("(R2) decide ran once per landing (2)", ctx.spy.decide === 2);
    check("(R2) nothing leaked: the reservation was released (a fresh K=1 decision sees only the recorded count)", ctx.sessions.decideMergeGateFor(P.projId, 1).gate === (db.getMergeGateState(P.projId).ungatedSinceLastPass + 1 > 3));
  }

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
  ? "\n✅ ALL PASS — the merge-gate interval decides once per landing, counts only what lands, runs a real gate when due/owed, owes after a failing periodic gate, and persists across a restart."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
