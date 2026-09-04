import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e2b6f900 — a PASSING merge gate's durable verdict persists NO concurrency condition, while a
// FAILING one already bakes `cap=… concurrentGates=… concurrentGatesMax=…` into its
// `[loom:merge-rejected]` nudge TEXT (never structured, never reaching `verdict_payload_json`). The fix
// (deriveMergeGateVerdict / ConfirmMergeResult.gateCap|concurrentGates|concurrentGatesMax in
// sessions/service.ts) surfaces the SAME triple, structurally, on BOTH outcomes — AND, per Code Review,
// wires it into gateStatus()'s own read path (its pick-list previously wrote the triple to
// verdict_payload_json but never read it back out — the whole point of the "readable after the fact"
// claim), so this file now asserts against `sessions.gateStatus(opId)` directly, not just the raw DB row.
//
// THE LOAD-BEARING TEST (card DoD-2): a fix tested only on the pass path proves nothing about the
// asymmetry it exists to close — the whole point is that a manager comparing a pass and a fail must see
// COMPARABLE data, not "richer text on one side, nothing on the other". Two scenarios:
//
//   (A) SEQUENTIAL, UNCONTENDED — a PASS and a FAIL, each run alone (never overlapping another gate), both
//       under the identical `maxConcurrentGates=2` config. This is the SAME CONDITION in the strongest,
//       deterministic sense (nothing else ever admitted during either run) — DoD-2's own wording. Both
//       must settle with BYTE-IDENTICAL stamps: {gateCap:2, concurrentGates:1, concurrentGatesMax:1}.
//
//   (B) GENUINELY CONCURRENT — a PASS and a FAIL admitted TOGETHER (cap raised to 2, both children held
//       open until BOTH have started). `concurrentGates` is documented as INSTANT-AT-ADMISSION — real,
//       order-dependent (whichever op is admitted first legitimately sees a smaller number) — so this
//       scenario does NOT assert it's equal across the two; it asserts the field the semaphore's own
//       admit/release bookkeeping tracks as a TRUE max-over-run, `concurrentGatesMax`, reaches the SAME
//       value (2) on BOTH regardless of admission order, and that neither outcome is ever left undefined
//       simply because it happened to be admitted second (or first).
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-gate-concurrency-verdict.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { waitUntil } from "./_wait.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-concstamp-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=concstamp@loom -c user.name=concstamp";
const now = new Date().toISOString();

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# concstamp\n");
  execSync(`git init -q && git config user.email concstamp@loom && git config user.name concstamp`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function seed(db, p, gateCommand) {
  db.insertProject({ id: p.projId, name: "CONCSTAMP", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "CONCSTAMP-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label) => ({
  projId: `concstamp-${label}-proj-${sfx}`, agentId: `concstamp-${label}-agent-${sfx}`, taskId: `concstamp-${label}-task-${sfx}`,
  mgrId: `concstamp-${label}-mgr-${sfx}`, workerId: `concstamp-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-concstamp-${label}-${sfx}`),
});

// Card e2b6f900 Code Review — CRITICAL fix: reads via the REAL `sessions.gateStatus(opId)` method (the
// exact post-hoc recovery path `gate_status(opId)` serves), never the raw `verdict_payload_json` row
// directly. The original version of this file asserted only against `Db.findPendingGateOpByOpId(...)
// .verdictPayload` — which proved the value was WRITTEN, but `gateStatus()`'s own return type/pick-list
// never read the triple back out, so the whole "readable after the fact" claim was untested end-to-end.
// Mirrors gate-status.mjs's own settled-verdict pattern (wait past the live/retained view, then call
// `gateStatus` for real) rather than reaching around it.
async function readSettledStatus(sessions, opId) {
  await waitUntil(() => (sessions.gateStatus(opId).state === "settled" ? true : undefined), { timeoutMs: 10_000, label: `gate_status(${opId}) to reach settled` });
  return sessions.gateStatus(opId);
}

const dbs = [];
const worktrees = [];
try {
  // ══ (A) SEQUENTIAL, UNCONTENDED — the deterministic "SAME condition" proof (DoD-2) ═══════════════════
  {
    const P = mk("seq-p"); // will PASS
    const F = mk("seq-f"); // will FAIL
    makeRepo(P.repo);
    makeRepo(F.repo);
    const db = new Db(); dbs.push(db);
    db.setPlatformConfig({ maxConcurrentGates: 2 }); // headroom for 2, but each op below runs ALONE
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const fakeGatePass = async (gate) => ({ passed: true, steps: [{ step: gate, durationMs: 10, status: 0 }], outputTail: "ok" });
    const fakeGateFail = async (gate) => ({ passed: false, failedStep: gate, failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "FAIL some_test.mjs", failingTest: "some_test.mjs", failingTestCount: 2 });

    const wtP = await createWorktree(P.repo, P.projId, P.taskId);
    P.worktreePath = wtP.worktreePath; P.branch = wtP.branch; worktrees.push(wtP.worktreePath);
    fs.writeFileSync(path.join(wtP.worktreePath, "p.txt"), "p\n");
    commitAll(wtP.worktreePath, "p", GIT_ID);
    seed(db, P, "pnpm gate");
    // confirmWorkerMergeTracked (not the bare confirmWorkerMerge) — ONLY the tracked wrapper's onSettle
    // actually calls deriveMergeGateVerdict/settlePendingGateOp to write the durable verdict_payload_json
    // row this test's whole "readable after the fact" claim depends on; a bare confirmWorkerMerge call
    // never touches that store at all.
    const sessionsP = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGatePass });
    // Card 6a9f4178: `confirmWorkerMergeTracked` degrades to `{settled:false}` once the REAL merge work
    // (createWorktree/git merge/squash — only `runGate` is faked here) runs past `SYNC_ATTACH_BUDGET_MS`
    // (12s) — an ordinary, documented daemon behavior under host contention, not a bug. Under artificial
    // load this test reproducibly hit exactly that: `!rP0.settled` firing with NO merge-code defect
    // involved. `confirmWorkerMergeUntilSettled` is the existing production helper built for this —
    // it polls the SAME already-running op (attach()'s own dedupe) until it genuinely settles, bounded by
    // the project's configured gate timeout × 6, never a fixed sleep/retry.
    const rP0 = await sessionsP.confirmWorkerMergeUntilSettled(P.mgrId, P.workerId);
    if (!rP0.settled) throw new Error("P did not settle within confirmWorkerMergeUntilSettled's own bounded ceiling — a genuine stall, not the sync-attach-budget race this test now waits out");
    const confirmP = rP0.value;

    const wtF = await createWorktree(F.repo, F.projId, F.taskId);
    F.worktreePath = wtF.worktreePath; F.branch = wtF.branch; worktrees.push(wtF.worktreePath);
    fs.writeFileSync(path.join(wtF.worktreePath, "f.txt"), "f\n");
    commitAll(wtF.worktreePath, "f", GIT_ID);
    seed(db, F, "pnpm gate");
    const sessionsF = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGateFail });
    // Card 6a9f4178 — same reasoning as the P call above.
    const rF0 = await sessionsF.confirmWorkerMergeUntilSettled(F.mgrId, F.workerId);
    if (!rF0.settled) throw new Error("F did not settle within confirmWorkerMergeUntilSettled's own bounded ceiling — a genuine stall, not the sync-attach-budget race this test now waits out");
    const confirmF = rF0.value;

    check("(A precondition) P merged:true, F merged:false — a real pass and a real rejection", confirmP.merged === true && confirmF.merged === false);

    // ── THE FIX, sync return: both populated, neither undefined ──────────────────────────────────────
    check("(A — THE FIX) PASS carries the triple on ConfirmMergeResult — before this card a passing merge carried NONE of this", confirmP.gateCap === 2 && confirmP.concurrentGates === 1 && confirmP.concurrentGatesMax === 1);
    check("(A) FAIL carries the triple structurally too (not just baked into detailText)", confirmF.gateCap === 2 && confirmF.concurrentGates === 1 && confirmF.concurrentGatesMax === 1);

    // ── DoD-2, THE LOAD-BEARING ASSERTION: same condition (uncontended, cap=2) ⇒ identical stamps ─────
    check("(A — DoD-2 LOAD-BEARING) PASS and FAIL, run under the IDENTICAL condition, report BYTE-IDENTICAL gateCap/concurrentGates/concurrentGatesMax", confirmP.gateCap === confirmF.gateCap && confirmP.concurrentGates === confirmF.concurrentGates && confirmP.concurrentGatesMax === confirmF.concurrentGatesMax);

    // ── THE FIX, THROUGH THE REAL READ PATH: gate_status(opId) — not the raw DB row — after the op has
    // genuinely settled. This is the exact "manager missed the nudge, calls gate_status later" recovery
    // path the card exists to serve; Code Review's whole point was that this must go through gateStatus()
    // itself, since its pick-list is a separate mechanism from the write side. ─────────────────────────
    const statusP = await readSettledStatus(sessionsP, confirmP.opId);
    const statusF = await readSettledStatus(sessionsF, confirmF.opId);
    check("(A gate_status — THE FIX, DoD-1) gate_status(opId) itself reports the triple for the PASS op — 'readable after the fact' means through THIS call, not just the DB row", statusP.gateCap === 2 && statusP.concurrentGates === 1 && statusP.concurrentGatesMax === 1);
    check("(A gate_status) gate_status(opId) reports the triple for the FAIL op too", statusF.gateCap === 2 && statusF.concurrentGates === 1 && statusF.concurrentGatesMax === 1);
    check("(A gate_status — DoD-2 LOAD-BEARING) gate_status(opId) on the settled PASS op and the settled FAIL op agree byte-for-byte on the triple", statusP.gateCap === statusF.gateCap && statusP.concurrentGates === statusF.concurrentGates && statusP.concurrentGatesMax === statusF.concurrentGatesMax);
  }

  // ══ (B) GENUINELY CONCURRENT — cap reached under real contention, on BOTH outcomes ═══════════════════
  {
    const P = mk("con-p"); // will PASS
    const F = mk("con-f"); // will FAIL
    makeRepo(P.repo);
    makeRepo(F.repo);
    const db = new Db(); dbs.push(db);
    db.setPlatformConfig({ maxConcurrentGates: 2 }); // both admitted+running together, not serialized
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

    const mkHold = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release: (v) => release(v) }; };
    const holds = new Map();
    const calls = [];
    const fakeGate = async (gate, cwd) => {
      calls.push({ cwd });
      await holds.get(cwd).p;
      if (cwd === F.worktreePath) {
        return { passed: false, failedStep: gate, failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "FAIL some_test.mjs", failingTest: "some_test.mjs", failingTestCount: 2 };
      }
      return { passed: true, steps: [{ step: gate, durationMs: 10, status: 0 }], outputTail: "ok" };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    const wtP = await createWorktree(P.repo, P.projId, P.taskId);
    P.worktreePath = wtP.worktreePath; P.branch = wtP.branch; worktrees.push(wtP.worktreePath);
    fs.writeFileSync(path.join(wtP.worktreePath, "p.txt"), "p\n");
    commitAll(wtP.worktreePath, "p", GIT_ID);
    seed(db, P, "pnpm gate");

    const wtF = await createWorktree(F.repo, F.projId, F.taskId);
    F.worktreePath = wtF.worktreePath; F.branch = wtF.branch; worktrees.push(wtF.worktreePath);
    fs.writeFileSync(path.join(wtF.worktreePath, "f.txt"), "f\n");
    commitAll(wtF.worktreePath, "f", GIT_ID);
    seed(db, F, "pnpm gate");

    holds.set(P.worktreePath, mkHold());
    holds.set(F.worktreePath, mkHold());

    // Card 6a9f4178: `confirmWorkerMergeUntilSettled`, not the raw `confirmWorkerMergeTracked` — see the
    // scenario (A) call sites above for why. The FIRST internal call it makes IS `confirmWorkerMergeTracked`
    // (same mint, same `runGate` invocation `calls.push` below observes), so this changes nothing about the
    // "both children co-live" precondition below — it only adds a bounded poll-until-settled AFTER that.
    const pP = sessions.confirmWorkerMergeUntilSettled(P.mgrId, P.workerId);
    const pF = sessions.confirmWorkerMergeUntilSettled(F.mgrId, F.workerId);
    // Wait until BOTH gate children have genuinely started — the precondition that makes this a real
    // concurrency proof (both admitted while the other is still live) rather than an accidentally
    // serialized run.
    await waitUntil(() => (calls.length === 2 ? true : undefined), { timeoutMs: 10_000, label: "both PASS and FAIL gate children to start" });
    check("(B precondition) both children are genuinely CO-LIVE at the same instant (cap raised to 2)", calls.length === 2);

    holds.get(P.worktreePath).release();
    holds.get(F.worktreePath).release();
    const [rP, rF] = await Promise.all([pP, pF]);

    check("(B precondition) P settled merged:true", rP.settled === true && rP.ok === true && rP.value.merged === true);
    check("(B precondition) F settled merged:false (a real gate rejection)", rF.settled === true && rF.ok === true && rF.value.merged === false);

    // `gateCap` is a plain config echo — always equal regardless of admission order.
    check("(B) gateCap is populated and equal on BOTH outcomes (a plain config echo, order-independent)", rP.value.gateCap === 2 && rF.value.gateCap === 2);
    // `concurrentGates` is documented INSTANT-AT-ADMISSION — real, legitimately order-dependent (see
    // ConfirmMergeResult.gateCap's own doc) — so this does NOT assert the two are equal. But Code Review
    // finding (card e2b6f900): a bare `typeof … === "number"` check would pass unchanged even if the
    // implementation stamped some fixed constant on both, never actually reading the semaphore — it proves
    // nothing about correctness, only that a number exists. `Math.max` IS a deterministic, real invariant
    // here: both children are held open until BOTH have started (the precondition above), so neither op
    // could have released before the other was admitted — whichever was admitted SECOND necessarily
    // observed the first already active, so its own `concurrentGates` must read 2. This is the exact
    // failure a same-constant-on-both bug would be caught by.
    check("(B — THE FIX, discriminating) at least one of PASS/FAIL genuinely observed BOTH ops admitted (max(concurrentGates) === 2) — not just \"a number was present\"", Math.max(rP.value.concurrentGates, rF.value.concurrentGates) === 2);
    // `concurrentGatesMax` (GateSemaphore's own admit/release high-water-mark for EACH op's own lifetime)
    // DOES reach the same true max regardless of which op was admitted first — both were co-live for their
    // entire held duration, so both observe the other joining.
    check("(B — DoD-2) concurrentGatesMax reaches the SAME true max-over-run (2) on BOTH the PASS and the FAIL, regardless of admission order", rP.value.concurrentGatesMax === 2 && rF.value.concurrentGatesMax === 2);

    const statusP = await readSettledStatus(sessions, rP.value.opId);
    const statusF = await readSettledStatus(sessions, rF.value.opId);
    check("(B gate_status — THE FIX) gate_status(opId) round-trips the triple for BOTH outcomes, matching the sync return exactly", statusP.gateCap === rP.value.gateCap && statusP.concurrentGates === rP.value.concurrentGates && statusP.concurrentGatesMax === rP.value.concurrentGatesMax && statusF.gateCap === rF.value.gateCap && statusF.concurrentGates === rF.value.concurrentGates && statusF.concurrentGatesMax === rF.value.concurrentGatesMax);
  }

  // ══ NEGATIVE CONTROL — a gateless project reports NONE of this (nothing to report, not a fabricated 0) ═
  {
    const G = mk("g");
    makeRepo(G.repo);
    const dbG = new Db(); dbs.push(dbG);
    const ptyStubG = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessionsG = new SessionService(dbG, ptyStubG, new OrchestrationControl(), {});
    const wtG = await createWorktree(G.repo, G.projId, G.taskId);
    G.worktreePath = wtG.worktreePath; G.branch = wtG.branch; worktrees.push(wtG.worktreePath);
    fs.writeFileSync(path.join(wtG.worktreePath, "g.txt"), "g\n");
    commitAll(wtG.worktreePath, "g", GIT_ID);
    seed(dbG, G, null); // no gateCommand configured
    const confirmG = await sessionsG.confirmWorkerMerge(G.mgrId, G.workerId);
    check("(negative control — precondition) gateless merge still succeeds", confirmG.merged === true);
    check("(negative control — THE DISCRIMINATOR) gateCap/concurrentGates/concurrentGatesMax are ALL undefined for a gateless project — never a fabricated 0/cap, distinguishing \"no gate ran\" from \"ran with cap 0\"", confirmG.gateCap === undefined && confirmG.concurrentGates === undefined && confirmG.concurrentGatesMax === undefined);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card e2b6f900: a PASSING merge gate's settled verdict now persists the SAME `gateCap`/" +
    "`concurrentGates`/`concurrentGatesMax` triple a FAILING one does — both on the synchronous " +
    "ConfirmMergeResult and, load-bearingly, in the durable `verdict_payload_json` store `gate_status(opId)` " +
    "reads after the fact. (A) Two sequential, uncontended merges (cap=2 configured, neither actually " +
    "overlapping the other) — one PASS, one FAIL — settle with BYTE-IDENTICAL stamps under the identical " +
    "condition, closing the asymmetry where only a rejection ever surfaced this (as unstructured text, " +
    "never durably). (B) Two merges admitted TOGETHER under real contention reach the same true " +
    "concurrentGatesMax (2) on both outcomes regardless of admission order, and neither leaves the triple " +
    "undefined. A gateless project still reports none of it — undefined, not a fabricated 0."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
