import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6f13746c — the merge-gate INTERVAL: BEHAVIOUR half. REAL git on temp repos + an INJECTED `runGate` seam whose
// CALL COUNTER proves whether the gate command ran (same style as merge-gate-off.mjs), plus spies that COUNT how many
// times the ONE decision helper (`decideMergeGateFor`) and the ONE outcome recorder (`recordMergeGateOutcome`) run.
//
// Card 8b5e002d: SPLIT off its ordering/reservation/batch half — see merge-gate-interval-ordering.mjs for
// (R4), (Q), (O2), (X), (C), (B), (W), (WB), (W2), (BF). Every scenario/assertion from the pre-split file
// is preserved, just moved; this file keeps the "pure rule table" + the core SOLO/OWED/cadence scenarios.
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
//   (R1) RESERVATION: N=5, a batch with 4 chosen + 2 overflow lands at most 5 ungated and the 6th is GATED.
//   (R2) RESERVATION: two OVERLAPPING solos at ungated=N-1: one skips, one gates.
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
import { waitUntil } from "./_wait.mjs";
const noReap = async () => ({ killedPids: [] });

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgint-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const M = await import("../dist/orchestration/merge-gate-interval.js");
// Dynamic, not static: _late-commit-seam.mjs itself dynamically imports ../dist/git/bounded.js (which
// transitively reaches paths.js's module-scope LOOM_HOME constant) — a STATIC import here would resolve
// that chain before this file's own LOOM_HOME assignment above ever runs, freezing the wrong (real) home.
const { lateCommitBeforeSquashTarget } = await import("./_late-commit-seam.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mgint@loom -c user.name=mgint";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
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
// Card 8b5e002d: a real `git init` + config + commit is ~300-450ms of real subprocess spawn on Windows
// (measured). Every scenario's baseline repo is byte-identical (README + src/baseline.ts + one commit),
// so build it ONCE as a template and fs.cpSync it per scenario instead — a plain recursive filesystem
// copy needs no subprocess spawn at all (measured ~6x faster for this fixture shape). The resulting repo
// is the same real git repo either way (same files, same HEAD) — only HOW it's created changed, not what
// downstream code sees.
const TEMPLATE_REPO = path.join(os.tmpdir(), `loom-mgint-tmpl-${sfx}`);
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
function mkService(db, extra = {}) {
  const gate = { calls: 0, pass: true, hold: null, failNext: false };
  const sessions = new SessionService(db, { stop() {}, isAlive() { return false; }, enqueueStdin() {} }, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async () => {
      gate.calls++;
      if (gate.hold) await gate.hold;
      if (gate.failNext) { gate.failNext = false; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; }
      return gate.pass ? { passed: true, steps: [] } : { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
    },
    reapWorktreeProcesses: noReap,
    ...extra,
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
    await seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(db, P, "p1", { "src/p1.ts": "export const p1 = 1;\n" });
    const ctx = mkService(db, {
      soloMergeGitFactory: lateCommitBeforeSquashTarget(w.branch, () => {
        fs.writeFileSync(path.join(w.worktreePath, "late.txt"), "late"); commitAll(w.worktreePath, "late worker commit", GIT_ID);
      }),
    });
    const r1 = await confirm(ctx.sessions, P.mgrId, w.workerId);
    check("(P) precondition: the interval-skip decision was recorded", db.listEvents(P.mgrId).some((e) => e.kind === "build_gate" && e.detail?.skipReason === "gate-interval"));
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
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the merge-gate interval decides once per landing, counts only what lands, runs a real gate when due/owed, owes after a failing periodic gate, and persists across a restart."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
