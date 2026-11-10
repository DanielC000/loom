import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4a95e9fc — an INTERVAL skip is refused while the candidate branch's OWN tip carries a settled RED `run_gate`
// self-check, unless the manager supplies a recorded `overrideReason`. REAL git on temp repos + an INJECTED `runGate`
// seam whose CALL COUNTER proves whether the gate command ran (same style as merge-gate-interval.mjs). The verdict is
// read from the DURABLE `worker_gate` events (`settleHead` + `branch`), never the in-memory slot.
//
//   (U)  the PURE parts: `decideMergeGate`'s red input and `redSelfCheckOnTip`'s event scan (red/green ordering, ignored
//        cancelled / error / landing-check / unstamped rows, other heads).
//   (A)  SOLO interval: a red self-check on the tip ⇒ the interval skip is REFUSED, the real gate runs (never skip-interval).
//   (B)  OVERRIDE: with an overrideReason the skip proceeds, never a pass, and the reason is on the merge result, merge_done,
//        build_gate, the gate_history row and the [loom:merge-done] nudge.
//   (C)  a later GREEN self-check on the SAME head clears the red (the skip is allowed again).
//   (D)  a CANCELLED / errored self-check carries no verdict and never blocks.
//   (E)  main advances AFTER the red (Loom's own union-merge forwards it into the worktree) — still gated.
//   (F)  KNOWN LIMIT: a NEW worker commit after the red is a new head — not covered, the skip is allowed.
//   (G)  RESTART DURABILITY: a fresh SessionService + Db on the same file (the in-memory slot is gone) still sees the red.
//   (H)  gate OFF (cadence never): never forced or refused, only a redSelfCheckNote warning.
//   (I)  cadence EVERY: nothing changes (no note).
//   (BR) BATCH: a red candidate makes an interval-skippable batch run the real gate; (BO) with a per-candidate override both
//        land ungated and ONLY the red one carries the override.
//
//   (J)  round 2: a red is carried THROUGH merges of main (the worker's own, and Loom's union-merge left by a confirm refused at
//        admission with no gate failure recorded) — a two-confirm laundering path; (J3) control: no red ⇒ none invented.
//   (K)  a forced-by-red gate is named on a SOLO REJECTION; (BR) also on the merge_batch result + its build_gate event.
//   (L)  an inert docs-only diff under a red does not claim the real gate ran; (H2) cadence never + overrideReason ⇒ warning
//        only, the override is not recorded as used; (M) merge_batch refuses an overrideReasons key that is not a candidate.
// NOT COVERED: the MCP zod bounds on overrideReason (a surface test); the web UI; the 50-hop cap of the merge walk.
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-red-selfcheck.mjs  (LOOM_DEV unset and =1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";
import { STAMPED_STALENESS } from "./_deploy-staleness-fixture.mjs";
const noReap = async () => ({ killedPids: [] });

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgred-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const M = await import("../dist/orchestration/merge-gate-interval.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mgred@loom -c user.name=mgred";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const head = (repo) => execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();

// ============ (U) the pure parts ============
{
  const st = (o = {}) => ({ ...M.emptyMergeGateState(), ...o });
  const off3 = { mergeGate: "off", mergeGateInterval: 3 }, off = { mergeGate: "off" }, on = { mergeGate: "on" };
  const red = { opId: "op-red", head: "H1" };
  const d = M.decideMergeGate(st(), off3, 1, 0, red);
  check("(U) interval skip + red ⇒ GATE, reason red-self-check, identityValue on, red carried", d.gate === true && d.reason === "red-self-check" && d.identityValue === "on" && d.redSelfCheck?.opId === "op-red");
  const o = M.decideMergeGate(st(), off3, 1, 0, { ...red, overrideReason: "unrelated flake" });
  check("(U) interval skip + red + overrideReason ⇒ still a SKIP (gate-interval), override carried", o.gate === false && o.reason === "skip-interval" && o.skipReason === "gate-interval" && o.redSelfCheck?.overrideReason === "unrelated flake");
  const n = M.decideMergeGate(st(), off, 1, 0, red);
  check("(U) cadence never + red ⇒ NEVER forced: skip-never, red only carried as a warning", n.gate === false && n.reason === "skip-never" && n.skipReason === "gate-disabled" && n.redSelfCheck?.opId === "op-red");
  const e = M.decideMergeGate(st(), on, 1, 0, red);
  check("(U) cadence every ⇒ gated for its own reason, the red is not attached", e.gate === true && e.reason === "every" && e.redSelfCheck === undefined);
  check("(U) owed / interval-due keep their own reasons over the red", M.decideMergeGate(st({ gateOwed: true }), off3, 1, 0, red).reason === "owed" && M.decideMergeGate(st({ ungatedSinceLastPass: 3 }), off3, 1, 0, red).reason === "interval-due");
  check("(U) no red ⇒ byte-identical skip decision (no redSelfCheck key)", !("redSelfCheck" in M.decideMergeGate(st(), off3, 1, 0)));

  const ev = (detail) => ({ detail });
  const R = (opId, h = "H1") => ev({ opId, passed: false, settleHead: h, branch: "b" });
  const G = (opId, h = "H1") => ev({ opId, passed: true, settleHead: h, branch: "b" });
  check("(U) a red on the tip is found", M.redSelfCheckOnTip([R("r1")], "H1")?.opId === "r1");
  check("(U) red THEN green on the same tip ⇒ cleared", M.redSelfCheckOnTip([R("r1"), G("g1")], "H1") === undefined);
  check("(U) green THEN red on the same tip ⇒ red (the newest verdict wins)", M.redSelfCheckOnTip([G("g1"), R("r1")], "H1")?.opId === "r1");
  check("(U) a red on ANOTHER head does not apply; the right head's own verdict does", M.redSelfCheckOnTip([R("r1", "H0")], "H1") === undefined && M.redSelfCheckOnTip([R("r0", "H0"), R("r1", "H1")], "H1")?.opId === "r1");
  check("(U) a green on another head does not clear a red on this one", M.redSelfCheckOnTip([R("r1", "H1"), G("g0", "H0")], "H1")?.opId === "r1");
  check("(U) a NEWER cancelled row (no verdict) never clears a red nor creates one", M.redSelfCheckOnTip([R("r1"), ev({ opId: "c", cancelled: true, settleHead: "H1" })], "H1")?.opId === "r1" && M.redSelfCheckOnTip([ev({ opId: "c", cancelled: true })], "H1") === undefined);
  check("(U) a thrown-error row (passed:false + error) is no verdict", M.redSelfCheckOnTip([ev({ opId: "x", passed: false, error: "boom", settleHead: "H1" })], "H1") === undefined);
  check("(U) landing-check / dist-importer rows are no self-check verdict", M.redSelfCheckOnTip([ev({ opId: "x", passed: false, settleHead: "H1", landingCheckOnly: true }), ev({ opId: "y", passed: false, settleHead: "H1", distImporterCheckOnly: true })], "H1") === undefined);
  check("(U) a row with no settleHead (pre-change / unreadable head) is no verdict", M.redSelfCheckOnTip([ev({ opId: "x", passed: false })], "H1") === undefined);
  check("(U) no tip / empty / detail-less rows ⇒ undefined", M.redSelfCheckOnTip([R("r1")], null) === undefined && M.redSelfCheckOnTip([], "H1") === undefined && M.redSelfCheckOnTip([{}], "H1") === undefined);
  // round 2 — a head SET (the tip plus the commits reached through merges of main)
  check("(U) head set: a red on a LOWER head (under a merge-of-main) is found, naming that head", (() => { const r = M.redSelfCheckOnTip([R("r1", "H0")], ["H1", "H0"]); return r?.opId === "r1" && r.head === "H0"; })());
  check("(U) head set: the NEWEST red across the set wins (by event order)", M.redSelfCheckOnTip([R("r1", "H0"), R("r2", "H1")], ["H1", "H0"])?.opId === "r2" && M.redSelfCheckOnTip([R("r2", "H1"), R("r1", "H0")], ["H1", "H0"])?.opId === "r1");
  check("(U) head set: a green on another head of the set does NOT clear a red; a green on the SAME head does", M.redSelfCheckOnTip([R("r0", "H0"), G("g", "H1")], ["H1", "H0"])?.opId === "r0" && M.redSelfCheckOnTip([R("r0", "H0"), G("g", "H0")], ["H1", "H0"]) === undefined);
  check("(U) head set: a head OUTSIDE the set never counts", M.redSelfCheckOnTip([R("r1", "HX")], ["H1", "H0"]) === undefined);
  const moved = ev({ opId: "m1", passed: false, settleHead: "A", settleWorktreeHead: "B" });
  check("(U) a red from a run whose tree moved counts on BOTH the gated head and the settle head", M.redSelfCheckOnTip([moved], "A")?.opId === "m1" && M.redSelfCheckOnTip([moved], "B")?.opId === "m1");
  check("(U) …but a green from such a run clears only the gated head, never the settle-time one (fails closed)", M.redSelfCheckOnTip([moved, ev({ opId: "m2", passed: true, settleHead: "A", settleWorktreeHead: "B" })], "A") === undefined && M.redSelfCheckOnTip([moved, ev({ opId: "m2", passed: true, settleHead: "A", settleWorktreeHead: "B" })], "B")?.opId === "m1");
}

// ============ fixtures ============
const TEMPLATE_REPO = path.join(os.tmpdir(), `loom-mgred-tmpl-${sfx}`);
registerForCleanup(TEMPLATE_REPO);
(() => {
  mkdirp(TEMPLATE_REPO);
  fs.writeFileSync(path.join(TEMPLATE_REPO, "README.md"), "# mgred\n");
  mkdirp(path.join(TEMPLATE_REPO, "src"));
  fs.writeFileSync(path.join(TEMPLATE_REPO, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email mgred@loom && git config user.name mgred`, { cwd: TEMPLATE_REPO });
  commitAll(TEMPLATE_REPO, "init", GIT_ID);
})();
function makeRepo(repo) { mkdirp(path.dirname(repo)); registerForCleanup(repo); fs.cpSync(TEMPLATE_REPO, repo, { recursive: true }); }
const mk = (label) => ({
  projId: `mgred-${label}-proj-${sfx}`, agentId: `mgred-${label}-agent-${sfx}`, mgrId: `mgred-${label}-mgr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mgred-${label}-${sfx}`),
});
function seedProject(db, P, orchestration) {
  db.insertProject({ id: P.projId, name: "MGRED", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate", ...orchestration } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
async function addWorker(db, P, n, files) {
  const taskId = `mgred-${n}-task-${sfx}`;
  const workerId = `mgred-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  worktrees.push(worktreePath);
  for (const [rel, body] of Object.entries(files)) { mkdirp(path.dirname(path.join(worktreePath, rel))); fs.writeFileSync(path.join(worktreePath, rel), body); }
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
/** A service whose injected gate counts calls; `gate.failNext` makes the NEXT call red. `enqueued` captures every nudge. */
function mkService(db, extra = {}) {
  const gate = { calls: 0, failNext: false, during: null };
  const enqueued = [];
  const pty = { stop() {}, isAlive() { return false; }, enqueueStdin(sessionId, text, source, onDeliver, route, kind) { enqueued.push({ sessionId, text, kind }); } };
  const sessions = new SessionService(db, pty, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    deployStaleness: STAMPED_STALENESS,
    runGate: async () => {
      gate.calls++;
      if (gate.during) { const f = gate.during; gate.during = null; await f(); } // one-shot hook: runs INSIDE the gate window
      if (gate.failNext) { gate.failNext = false; return { passed: false, failedStep: "test", failedStatus: 1, steps: [] }; }
      return { passed: true, steps: [] };
    },
    reapWorktreeProcesses: noReap,
    ...extra,
  });
  return { sessions, gate, enqueued };
}
const selfCheck = async (ctx, workerId, { red = false } = {}) => {
  ctx.gate.failNext = red;
  const r = await ctx.sessions.runWorkerGate(workerId);
  return r.settled && r.ok ? r.value : { __unsettled: r };
};
const confirm = async (ctx, mgrId, workerId, opts) => {
  const r = await awaitTrackedSettle(() => ctx.sessions.confirmWorkerMergeTracked(mgrId, workerId, undefined, opts), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000, pendingOps: ctx.sessions.pendingOps });
  return r.ok ? r.value : { __unsettled: r };
};
const buildGates = (db, P) => db.listEvents(P.mgrId).filter((e) => e.kind === "build_gate");

const dbs = [];
const worktrees = [];
try {
  // ── (A) a red self-check refuses the interval skip ─────────────────────────────────────────────
  {
    const P = mk("a"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "a1", { "src/a1.ts": "export const a1 = 1;\n" });
    const sc = await selfCheck(ctx, w.workerId, { red: true });
    check("(A) precondition: the self-check settled RED", sc.passed === false);
    const stamped = db.listEventsForBranch(w.branch, "worker_gate").find((e) => e.detail?.passed === false);
    check("(A) the red worker_gate event carries settleHead (= the branch tip) and branch", stamped?.detail?.settleHead === execSync(`git rev-parse ${w.branch}`, { cwd: P.repo }).toString().trim() && stamped?.detail?.branch === w.branch);
    const before = ctx.gate.calls;
    const v = await confirm(ctx, P.mgrId, w.workerId);
    check("(A) the landing was GATED (the gate command ran) and NEVER skip-interval", v.merged === true && ctx.gate.calls === before + 1 && v.gateRan === true && v.skipReason === undefined && v.skipped === undefined);
    check("(A) the result says the skip was REFUSED because of the red self-check", /REFUSED/.test(v.redSelfCheckNote ?? "") && /red run_gate self-check/.test(v.redSelfCheckNote ?? "") && v.overrideReason === undefined);
    check("(A) a forced, passing gate resets the interval counter and records a real pass", (() => { const s = db.getMergeGateState(P.projId); return s.ungatedSinceLastPass === 0 && s.lastPassAt !== null; })());
    check("(A) the build_gate event names the red op and carries NO skipReason", (() => { const b = buildGates(db, P).at(-1); return b?.detail?.redSelfCheckOpId === sc.opId && b?.detail?.skipReason === undefined; })());
  }

  // ── (B) override: skip proceeds, recorded everywhere, never a pass ─────────────────────────────
  {
    const P = mk("b"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "b1", { "src/b1.ts": "export const b1 = 1;\n" });
    const sc = await selfCheck(ctx, w.workerId, { red: true });
    // The self-check above must SETTLE synchronously (a long budget); only afterwards shrink it so the confirm degrades to the async path.
    ctx.sessions.syncAttachBudgetMs = 1;
    const first = await ctx.sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId, undefined, { overrideReason: "unrelated flake in X" });
    check("(B) fixture: the call degraded to the async pending path (the path the nudge exists for)", first.settled === false);
    const opId = first.op.opId;
    await waitUntil(() => ctx.sessions.gateStatus(opId).state === "settled", { timeoutMs: 60000, intervalMs: 20, label: "merge-gate-red-selfcheck (B): op settled" });
    const calls = ctx.gate.calls;
    check("(B) the gate command was NOT run for the overridden landing (only the self-check ran)", calls === 1);
    check("(B) build_gate: skipReason gate-interval + overrideReason + redSelfCheckOpId", (() => { const b = buildGates(db, P).at(-1); return b?.detail?.skipReason === "gate-interval" && b?.detail?.overrideReason === "unrelated flake in X" && b?.detail?.redSelfCheckOpId === sc.opId; })());
    check("(B) merge_done carries overrideReason", db.listEvents(P.mgrId).some((e) => e.kind === "merge_done" && e.detail?.overrideReason === "unrelated flake in X"));
    const row = db.listGateEvents({ projectId: P.projId, limit: 10, offset: 0 }).items.find((i) => i.opId === opId);
    check("(B) gate_history row: outcome skipped (NEVER pass) + overrideReason", row?.outcome === "skipped" && row?.overrideReason === "unrelated flake in X");
    const done = ctx.enqueued.find((e) => /\[loom:merge-done\]/.test(e.text));
    check("(B) the [loom:merge-done] nudge carries the override, says RECORDED/not authenticated/NOT a pass", done !== undefined && /unrelated flake in X/.test(done.text) && /RECORDED, not authenticated/.test(done.text) && /NOT a pass/.test(done.text));
    check("(B) the ungated counter advanced (an ungated landing, not a pass)", db.getMergeGateState(P.projId).ungatedSinceLastPass === 1);
  }
  // (B2) the sync result shape carries the override too
  {
    const P = mk("b2"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "b2", { "src/b2.ts": "export const b2 = 1;\n" });
    await selfCheck(ctx, w.workerId, { red: true });
    const v = await confirm(ctx, P.mgrId, w.workerId, { overrideReason: "known flake" });
    check("(B2) merged ungated: skipReason gate-interval, gateRan false, overrideReason on the result, note says overridden", v.merged === true && v.skipReason === "gate-interval" && v.gateRan === false && v.overrideReason === "known flake" && /overrideReason/.test(v.redSelfCheckNote ?? ""));
    check("(B2) and the warning text still says NOT a pass", /NOT a pass/.test(v.warning ?? ""));
    // an override on a landing with NO red is inert: nothing recorded
    const w2 = await addWorker(db, P, "b2x", { "src/b2x.ts": "export const b2x = 1;\n" });
    const v2 = await confirm(ctx, P.mgrId, w2.workerId, { overrideReason: "not needed" });
    check("(B2) an overrideReason with NO red on the tip is inert (no note, no recorded reason)", v2.merged === true && v2.overrideReason === undefined && v2.redSelfCheckNote === undefined && !db.listEvents(P.mgrId).some((e) => e.kind === "merge_done" && e.detail?.overrideReason === "not needed"));
  }

  // ── (C) a later green on the SAME head clears the red ────────────────────────────────────────
  {
    const P = mk("c"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "c1", { "src/c1.ts": "export const c1 = 1;\n" });
    const r1 = await selfCheck(ctx, w.workerId, { red: true });
    // A re-called run_gate on an UNCHANGED tree replays the retained verdict (same opId, gate not re-run — observed, even with force), so a real
    // second verdict on the SAME head is appended here with the exact shape runWorkerGate stamps for a pass.
    const again = await selfCheck(ctx, w.workerId);
    check("(C) precondition: a re-called run_gate on the unchanged tree replays the SAME red op (no new verdict), so the green below is appended as a durable event", again.opId === r1.opId && again.passed === false && ctx.gate.calls === 1);
    db.appendEvent({ id: `c-green-${sfx}`, ts: new Date(Date.now() + 1000).toISOString(), managerSessionId: w.workerId, workerSessionId: w.workerId, taskId: w.taskId, kind: "worker_gate", detail: { passed: true, headCurrent: true, settleHead: r1.validatedHead, branch: w.branch, opId: `c-green-op-${sfx}` } });
    const before = ctx.gate.calls;
    const v = await confirm(ctx, P.mgrId, w.workerId);
    check("(C) the red is CLEARED: the interval skip proceeds, gate not run again, no red note", v.merged === true && v.skipReason === "gate-interval" && ctx.gate.calls === before && v.redSelfCheckNote === undefined);
  }

  // ── (D) a cancelled / errored self-check is no verdict ───────────────────────────────────────
  {
    const P = mk("d"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "d1", { "src/d1.ts": "export const d1 = 1;\n" });
    // Shapes exactly as runWorkerGate's cancelled / thrown-error paths write them (no settleHead).
    db.appendEvent({ id: `d-cancel-${sfx}`, ts: new Date().toISOString(), managerSessionId: w.workerId, workerSessionId: w.workerId, taskId: w.taskId, kind: "worker_gate", detail: { cancelled: true, cancelKind: "manual", cancelDetail: "x", opId: "op-cancel", branch: w.branch } });
    db.appendEvent({ id: `d-err-${sfx}`, ts: new Date().toISOString(), managerSessionId: w.workerId, workerSessionId: w.workerId, taskId: w.taskId, kind: "worker_gate", detail: { passed: false, error: "runner blew up", opId: "op-err", branch: w.branch } });
    const v = await confirm(ctx, P.mgrId, w.workerId);
    check("(D) cancelled + errored self-check rows never block: interval skip proceeds", v.merged === true && v.skipReason === "gate-interval" && ctx.gate.calls === 0 && v.redSelfCheckNote === undefined);
  }

  // ── (E) main advances AFTER the red: the union-merge forward must not launder it ──────────────
  {
    const P = mk("e"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "e1", { "src/e1.ts": "export const e1 = 1;\n" });
    await selfCheck(ctx, w.workerId, { red: true });
    fs.writeFileSync(path.join(P.repo, "main-advance-e.txt"), "main moved forward\n");
    commitAll(P.repo, "main advance e", GIT_ID);
    const before = ctx.gate.calls;
    const v = await confirm(ctx, P.mgrId, w.workerId);
    check("(E) red on X, main advances, confirm ⇒ still GATED (never skip-interval)", v.merged === true && v.gateRan === true && ctx.gate.calls === before + 1 && v.skipReason === undefined && /REFUSED/.test(v.redSelfCheckNote ?? ""));
  }

  // ── (F) KNOWN LIMIT: a NEW worker commit is a new head ───────────────────────────────────────
  {
    const P = mk("f"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "f1", { "src/f1.ts": "export const f1 = 1;\n" });
    await selfCheck(ctx, w.workerId, { red: true });
    fs.writeFileSync(path.join(w.worktreePath, "src", "f1b.ts"), "export const f1b = 1;\n");
    commitAll(w.worktreePath, "feat(x): more f1", GIT_ID);
    const v = await confirm(ctx, P.mgrId, w.workerId);
    check("(F) KNOWN LIMIT: a new worker commit after the red is a NEW head, so the interval skip is allowed (documented, not covered)", v.merged === true && v.skipReason === "gate-interval" && v.redSelfCheckNote === undefined);
  }

  // ── (G) restart durability ───────────────────────────────────────────────────────────────────
  {
    const P = mk("g"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctxA = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "g1", { "src/g1.ts": "export const g1 = 1;\n" });
    await selfCheck(ctxA, w.workerId, { red: true });
    const db2 = new Db(); dbs.push(db2);
    const ctxB = mkService(db2); // a fresh process: no in-memory lastWorkerGateCheck slot
    check("(G) precondition: the fresh service has no in-memory self-check record", ctxB.sessions.lastWorkerGateCheck?.get?.(w.workerId) === undefined);
    const v = await confirm(ctxB, P.mgrId, w.workerId);
    check("(G) after a simulated restart the red is still found (durable events): GATED, never skip-interval", v.merged === true && v.gateRan === true && ctxB.gate.calls === 1 && v.skipReason === undefined);
  }

  // ── (H) gate OFF (cadence never): warn only ──────────────────────────────────────────────────
  {
    const P = mk("h"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off" });
    const w = await addWorker(db, P, "h1", { "src/h1.ts": "export const h1 = 1;\n" });
    await selfCheck(ctx, w.workerId, { red: true });
    const before = ctx.gate.calls;
    const v = await confirm(ctx, P.mgrId, w.workerId);
    check("(H) gate off + red: NOT forced and NOT refused — lands ungated (gate-disabled), gate not run", v.merged === true && v.skipReason === "gate-disabled" && ctx.gate.calls === before);
    check("(H) …but the result carries the red-self-check warning (no override, no pass claim)", /red run_gate self-check/.test(v.redSelfCheckNote ?? "") && /merge gate is OFF/.test(v.redSelfCheckNote ?? "") && v.overrideReason === undefined && /redSelfCheckNote|red run_gate/.test(v.warning ?? ""));
  }

  // ── (I) cadence every: nothing changes ───────────────────────────────────────────────────────
  {
    const P = mk("i"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "on" });
    const w = await addWorker(db, P, "i1", { "src/i1.ts": "export const i1 = 1;\n" });
    await selfCheck(ctx, w.workerId, { red: true });
    const v = await confirm(ctx, P.mgrId, w.workerId);
    check("(I) cadence every: a normal gated landing, no red note (the check is never even consulted)", v.merged === true && v.gateRan === true && v.redSelfCheckNote === undefined);
  }

  // ── (BR) batch: a red candidate forces the shared gate ───────────────────────────────────────
  {
    const P = mk("br"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 5, maxConcurrentWorkers: 4 });
    const w1 = await addWorker(db, P, "br1", { "src/br1.ts": "export const br1 = 1;\n" });
    const w2 = await addWorker(db, P, "br2", { "src/br2.ts": "export const br2 = 2;\n" });
    const sc1 = await selfCheck(ctx, w1.workerId, { red: true });
    const calls0 = ctx.gate.calls;
    const r = await ctx.sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
    const v = r.settled && r.ok ? r.value : undefined;
    let landed = false;
    try { landed = await waitUntil(() => [w1, w2].every((w) => db.getTask(w.taskId).columnKey === "done"), { timeoutMs: 120000, intervalMs: 50, label: "merge-gate-red-selfcheck (BR): both landed" }); } catch { landed = false; }
    const ungated = db.listEvents(P.mgrId).filter((e) => e.kind === "build_gate" && e.detail?.skipReason === "gate-interval").length;
    check("(BR) a red candidate makes the batch run the REAL gate: both landed, ZERO interval skips, the gate command ran", landed && ungated === 0 && ctx.gate.calls > calls0 && v !== undefined);
    check("(BR) the forced gate is NAMED on the merge_batch result (redSelfCheckOpIds + note naming the worker)", v?.redSelfCheckOpIds?.length === 1 && v.redSelfCheckOpIds[0] === sc1.opId && /REFUSED/.test(v.redSelfCheckNote ?? "") && (v.redSelfCheckNote ?? "").includes(w1.workerId.slice(0, 8)));
    check("(BR) …and on the batch's build_gate event", (() => { const b = db.listEvents(P.mgrId).filter((e) => e.kind === "build_gate" && e.detail?.batched === true).at(-1); return b?.detail?.redSelfCheckOpIds?.[0] === sc1.opId && /REFUSED/.test(b.detail.redSelfCheckNote ?? ""); })());
  }
  // ── (BO) batch with a per-candidate override: both land ungated, ONLY the red one carries it ───
  {
    const P = mk("bo"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 5, maxConcurrentWorkers: 4 });
    const w1 = await addWorker(db, P, "bo1", { "src/bo1.ts": "export const bo1 = 1;\n" });
    const w2 = await addWorker(db, P, "bo2", { "src/bo2.ts": "export const bo2 = 2;\n" });
    await selfCheck(ctx, w1.workerId, { red: true });
    const calls0 = ctx.gate.calls;
    await ctx.sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId], { [w1.workerId]: "flaky, rechecked by hand" });
    let landed = false;
    try { landed = await waitUntil(() => [w1, w2].every((w) => db.getTask(w.taskId).columnKey === "done"), { timeoutMs: 120000, intervalMs: 50, label: "merge-gate-red-selfcheck (BO): both landed" }); } catch { landed = false; }
    const gates = db.listEvents(P.mgrId).filter((e) => e.kind === "build_gate" && e.detail?.skipReason === "gate-interval");
    check("(BO) both landed ungated (gate-interval), the gate command never ran", landed && gates.length === 2 && ctx.gate.calls === calls0);
    check("(BO) ONLY the red candidate's landing carries the override reason", gates.filter((g) => g.detail?.overrideReason === "flaky, rechecked by hand").length === 1 && gates.filter((g) => g.detail?.overrideReason !== undefined).length === 1);
  }
  // ── (J) round 2: a red must not be laundered by a merge of main left on the branch ─────────────
  const tipOf = (repo, branch) => execSync(`git rev-parse refs/heads/${branch}`, { cwd: repo }).toString().trim();
  const parentCount = (repo, sha) => execSync(`git rev-list --parents -n 1 ${sha}`, { cwd: repo }).toString().trim().split(/\s+/).length - 1;
  {
    // (J1) the worker's OWN merge of main on top of the red tip
    const P = mk("j1"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "j1", { "src/j1.ts": "export const j1 = 1;\n" });
    const sc = await selfCheck(ctx, w.workerId, { red: true });
    const T = tipOf(P.repo, w.branch);
    fs.writeFileSync(path.join(P.repo, "main-advance-j1.txt"), "main moved\n");
    commitAll(P.repo, "main advance j1", GIT_ID);
    const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: P.repo }).toString().trim();
    execSync(`git ${GIT_ID} merge --no-edit ${mainBranch}`, { cwd: w.worktreePath, stdio: "pipe" });
    const M1 = tipOf(P.repo, w.branch);
    check("(J1) precondition: the branch tip is now a MERGE commit over the red tip", M1 !== T && parentCount(P.repo, M1) === 2 && execSync(`git rev-parse "${M1}^1"`, { cwd: P.repo }).toString().trim() === T);
    const before = ctx.gate.calls;
    const v = await confirm(ctx, P.mgrId, w.workerId);
    check("(J1) the red on T is carried through the merge of main: GATED, never skip-interval", v.merged === true && v.gateRan === true && ctx.gate.calls === before + 1 && v.skipReason === undefined && v.redSelfCheckOpId === sc.opId && /REFUSED/.test(v.redSelfCheckNote ?? ""));
  }
  {
    // (J2) the two-confirm laundering path: confirm #1 runs AFTER Loom's pre-gate union-merge of main committed M on the branch, then ends WITHOUT a
    // recorded gate failure (main moves inside the gate window ⇒ gate_base_invalidated, gateOwed stays false); confirm #2 reads tip M while the red sits on T.
    const P = mk("j2"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "j2", { "src/j2.ts": "export const j2 = 1;\n" });
    const sc = await selfCheck(ctx, w.workerId, { red: true });
    const T = tipOf(P.repo, w.branch);
    fs.writeFileSync(path.join(P.repo, "main-advance-j2.txt"), "main moved\n");
    commitAll(P.repo, "main advance j2", GIT_ID);
    ctx.gate.during = async () => { fs.writeFileSync(path.join(P.repo, "main-advance-j2b.txt"), "main moved inside the gate window\n"); commitAll(P.repo, "main advance j2b", GIT_ID); };
    const v1 = await confirm(ctx, P.mgrId, w.workerId);
    const M1 = tipOf(P.repo, w.branch);
    check("(J2) precondition: confirm #1 was REFUSED (no merge) yet left a union-merge commit M over the red tip on the branch, with no gate failure owed", v1.merged === false && M1 !== T && parentCount(P.repo, M1) === 2 && db.getMergeGateState(P.projId).gateOwed === false);
    const before = ctx.gate.calls;
    const v2 = await confirm(ctx, P.mgrId, w.workerId);
    check("(J2) confirm #2 still GATES (the red is found through M's first parent), never skip-interval, and names the red op", v2.merged === true && v2.gateRan === true && ctx.gate.calls === before + 1 && v2.skipReason === undefined && v2.redSelfCheckOpId === sc.opId);
  }
  {
    // (J3) control: the SAME merge-of-main shape with NO red must not invent one
    const P = mk("j3"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "j3", { "src/j3.ts": "export const j3 = 1;\n" });
    fs.writeFileSync(path.join(P.repo, "main-advance-j3.txt"), "main moved\n");
    commitAll(P.repo, "main advance j3", GIT_ID);
    const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: P.repo }).toString().trim();
    execSync(`git ${GIT_ID} merge --no-edit ${mainBranch}`, { cwd: w.worktreePath, stdio: "pipe" });
    const v = await confirm(ctx, P.mgrId, w.workerId);
    check("(J3) no red + a merge of main on the branch ⇒ the interval skip proceeds, no note", v.merged === true && v.skipReason === "gate-interval" && ctx.gate.calls === 0 && v.redSelfCheckNote === undefined);
  }

  // ── (K) a forced-by-red gate is named on a SOLO REJECTION too ─────────────────────────────────
  {
    const P = mk("k"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "k1", { "src/k1.ts": "export const k1 = 1;\n" });
    const sc = await selfCheck(ctx, w.workerId, { red: true });
    ctx.gate.failNext = true;
    const v = await confirm(ctx, P.mgrId, w.workerId);
    check("(K) the forced gate was red ⇒ a REJECTION, which still names the red op and says the skip was refused", v.merged === false && v.redSelfCheckOpId === sc.opId && /REFUSED/.test(v.redSelfCheckNote ?? ""));
  }

  // ── (L) an inert docs-only diff under a red: the note must not claim the real gate ran ─────────
  {
    const P = mk("l"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 3 });
    const w = await addWorker(db, P, "l1", { "docs/l1.md": "# l1\n" });
    await selfCheck(ctx, w.workerId, { red: true });
    const before = ctx.gate.calls;
    const v = await confirm(ctx, P.mgrId, w.workerId);
    check("(L) fixture: the docs-only diff was inert-skipped (no gate ran)", v.merged === true && v.gateRan === false && ctx.gate.calls === before);
    check("(L) the note says NO gate ran and does not claim the real merge gate ran", /NO gate ran/.test(v.redSelfCheckNote ?? "") && !/real merge gate ran/.test(v.redSelfCheckNote ?? ""));
  }

  // ── (H2) cadence never + overrideReason: warning only, the override is NOT recorded as used ───
  {
    const P = mk("h2"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off" });
    const w = await addWorker(db, P, "h2", { "src/h2.ts": "export const h2 = 1;\n" });
    await selfCheck(ctx, w.workerId, { red: true });
    const v = await confirm(ctx, P.mgrId, w.workerId, { overrideReason: "not needed under never" });
    check("(H2) the note says warning only / override not needed, and no override is recorded on the result", /warning only; override not needed/.test(v.redSelfCheckNote ?? "") && v.overrideReason === undefined && !/RECORDED/.test(v.redSelfCheckNote ?? ""));
    check("(H2) nor on merge_done / build_gate", !db.listEvents(P.mgrId).some((e) => (e.kind === "merge_done" || e.kind === "build_gate") && e.detail?.overrideReason !== undefined));
  }

  // ── (M) merge_batch refuses an overrideReasons key that is not a candidate ────────────────────
  {
    const P = mk("m"); makeRepo(P.repo);
    const db = new Db(); dbs.push(db);
    const ctx = mkService(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 5, maxConcurrentWorkers: 4 });
    const w1 = await addWorker(db, P, "m1", { "src/m1.ts": "export const m1 = 1;\n" });
    const w2 = await addWorker(db, P, "m2", { "src/m2.ts": "export const m2 = 1;\n" });
    const server = new OrchestrationMcpRouter(db, ctx.sessions).buildServer(P.mgrId, "manager");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "mgred-m", version: "0" });
    await client.connect(clientT);
    const call = async (args) => JSON.parse((await client.callTool({ name: "merge_batch", arguments: args })).content[0].text);
    const out = await call({ workerSessionIds: [w1.workerId, w2.workerId], overrideReasons: { [w1.workerId]: "ok", "not-a-candidate-id": "typo" } });
    check("(M) a stray overrideReasons key is REFUSED by name, and nothing was merged", out.ok === false && /not-a-candidate-id/.test(out.reason ?? "") && db.getTask(w1.taskId).columnKey !== "done" && db.getTask(w2.taskId).columnKey !== "done");
    await client.close();
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
  for (const wt of worktrees) { try { cleanupPathSync(wt); } catch { /* ignore */ } }
  try { cleanupPathSync(process.env.LOOM_HOME); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an interval skip is refused while the candidate's own tip has a settled red run_gate self-check (durable, restart-proof, green-clearable, cancel-blind), an overrideReason is recorded and never a pass, a gate switched off only warns."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
