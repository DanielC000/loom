import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cdc262b5 (review round) — a queued ADVISORY dist-importer check withdrawn by a merge gate is only dropped when the MERGE
// CALLER reports coverage: the gate genuinely ran AND passed, was NOT emit-compare-reduced, ran the project's full configured
// gateCommand, and the branch actually LANDED. These cases drive the REAL merge path (confirmWorkerMergeTracked / mergeBatchTracked
// with an injected runGate seam, real git on a Loom-layout temp repo); only the advisory's own cut/build/run-set steps are stubbed.
// The semaphore-level mechanics (who is superseded, before/after-admission split, restart pre-empt) live in dist-importer-supersede.mjs.
//
//   SOLO   (S1) a REDUCED (comment-only) pass that lands          => the advisory RE-RUNS once at the superseded sha
//          (S2) a FULL pass that lands                            => NO re-run
//          (S3) a FULL pass followed by a squash refusal (main moved after the gate: gate_base_invalidated) => RE-RUN
//          (S4) an interval-skipped landing (mergeGateInterval set, no gate admitted)  => NO supersede at all
//   BATCH  (B1) a reduced batch pass that lands                   => RE-RUN once
//          (B2) a full batch pass that lands                      => NO re-run
//          (B3) a RED batch whose per-branch fallbacks then land  => exactly ONE re-run (fallbacks never double-report)
//   (P)  the !preLanded / gateBaseMainHead conjuncts are DEFENCE IN DEPTH (preLanded => merge.ok&&!noop already excludes;
//        gateBaseMainHead is non-null on a non-preLanded run). They are pinned by a source-text check in
//        dist-importer-supersede-coverage-source-pin.mjs, not here.
//
// Every await on a promise this file does not control is bounded (`bounded`) and fails on a NAMED line instead of hanging.
// Run: 1) build daemon (pnpm build), 2) node test/dist-importer-supersede-coverage.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { waitUntil, deferred, ambientScaledBudget } from "./_wait.mjs";

useOwnLoomHome("lm-disupc-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=disupc@loom -c user.name=disupc";
const FULL_GATE = "pnpm build && pnpm --filter @loom/daemon test:daemon";
const now = new Date().toISOString();
const sfx = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const BUDGET_MS = ambientScaledBudget(30_000, 3);
const ADV_SHA = "a".repeat(40);
const ADV_PATH = "packages/daemon/dist/foo.js";

async function bounded(p, label, timeoutMs = BUDGET_MS) {
  const s = { done: false };
  p.then(() => { s.done = true; }, () => { s.done = true; });
  try { await waitUntil(() => s.done, { label, timeoutMs }); }
  catch { console.log(`FAIL  ${label} (did not settle within ${timeoutMs}ms)`); process.exit(1); }
  return p;
}

const PASS = { passed: true, steps: [{ step: "gate", durationMs: 5, status: 0 }] };
const RED = { passed: false, failedStep: "pnpm build", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "boom", steps: [{ step: "pnpm build", durationMs: 5, status: 1 }] };

const baseSrc = (f) => `// ${f} docs\nexport function ${f}(x: number): boolean {\n  return x === 0;\n}\n`;
const editedSrc = (f, kind) => (kind === "comment" ? baseSrc(f).replace(`// ${f} docs`, `// ${f} docs (clarified)`) : baseSrc(f).replace("x === 0", "x === 1"));

function makeRepo(P) {
  fs.mkdirSync(P.repo, { recursive: true });
  registerForCleanup(P.repo);
  fs.writeFileSync(path.join(P.repo, "README.md"), "# disupc\n");
  fs.writeFileSync(path.join(P.repo, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { target: "ES2022" } }));
  fs.mkdirSync(path.join(P.repo, "packages", "daemon", "src"), { recursive: true });
  fs.writeFileSync(path.join(P.repo, "packages", "daemon", "tsconfig.json"), JSON.stringify({ extends: "../../tsconfig.base.json", compilerOptions: { outDir: "dist", rootDir: "src", types: ["node"] } }));
  for (const f of ["fa", "fb"]) fs.writeFileSync(path.join(P.repo, "packages", "daemon", "src", `${f}.ts`), baseSrc(f));
  execSync(`git init -q -b main && git config user.email disupc@loom && git config user.name disupc`, { cwd: P.repo });
  commitAll(P.repo, "init", GIT_ID);
}
async function addWorker(db, P, n, file, kind) {
  const taskId = `disupc-${n}-task-${sfx}`; const workerId = `disupc-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "src", `${file}.ts`), editedSrc(file, kind));
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

const dbs = [];
let n = 0;
function mkEnv(orch = {}) {
  n++;
  const P = { projId: `disupc-p${n}-${sfx}`, agentId: `disupc-a${n}-${sfx}`, mgrId: `disupc-m${n}-${sfx}`, repo: path.join(os.tmpdir(), `lm-disupc-repo${n}-${sfx}`) };
  makeRepo(P);
  const db = new Db(path.join(os.tmpdir(), `lm-disupc-db${n}-${sfx}.db`)); dbs.push(db);
  db.insertProject({ id: P.projId, name: "DISUPC", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: FULL_GATE, ...orch } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
  const rec = { cuts: [], builds: 0, gateCmds: [] };
  const script = { fn: async () => PASS };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async (gate, ...rest) => { rec.gateCmds.push(gate); return script.fn(rec.gateCmds.length, gate, ...rest); },
    reapWorktreeProcesses: noReap,
    distImporterCheckCreateWorktree: async (_r, _p, taskId, _o, repoKey, sha) => {
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), "lm-disupc-wt-"));
      registerForCleanup(wt);
      rec.cuts.push({ taskId, repoKey, sha });
      return { worktreePath: wt, branch: `loom/disupc-${rec.cuts.length}` };
    },
    distImporterCheckBuild: async (_wt, signal) => {
      rec.builds++;
      await new Promise((res) => { if (signal?.aborted) return res(); signal?.addEventListener("abort", () => res(), { once: true }); });
      return { ok: true };
    },
    distImporterCheckComputeRunSet: async () => ({ ok: true, candidates: [{ path: "packages/daemon/test/a.mjs", touchedCount: 1 }], corpusSize: 4 }),
    distImporterCheckRemoveWorktree: async () => ({ removed: true, wedged: false, aborted: false }),
    distImporterCheckListCheckedOutBranches: async () => new Set(),
  });
  const sem = sessions.gateSemaphore;
  const cap = sessions.gateQueueForManager(P.projId).cap;
  const advisoryEntries = () => sem.snapshot().entries.filter((x) => x.distImporterCheckOnly);
  const supersededEvents = () => db.listEvents(P.mgrId).filter((x) => x.kind === "worker_gate" && x.detail?.distImporterCheckOnly === true && x.detail?.superseded === true);
  return { P, db, sessions, sem, cap, rec, script, advisoryEntries, supersededEvents };
}

/** Saturate the cap and queue ONE advisory behind it. */
async function queueAdvisory(e) {
  const holders = [];
  for (let i = 0; i < e.cap; i++) {
    const d = deferred(); const started = deferred();
    const run = e.sem.runExclusive(e.cap, { gateType: "deploy", projectId: e.P.projId, sessionId: e.P.mgrId, taskId: null, branch: null, opId: `hold-${i}-${sfx}` }, async () => { started.resolve(); await d.promise; return "ok"; }, "high").catch(() => "rejected");
    await bounded(started.promise, `holder ${i} admitted`);
    holders.push({ release: () => d.resolve(), run });
  }
  const advisory = e.sessions.enqueueDistImporterCheck(e.P.projId, "primary", e.P.repo, e.P.mgrId, ADV_SHA, [ADV_PATH]);
  await waitUntil(() => e.advisoryEntries().some((x) => x.phase === "queued"), { label: "advisory queued behind the holders" });
  return { holders, advisory };
}
const cancelAdvisories = (e) => e.advisoryEntries().forEach((x) => { if (x.phase === "running") e.sem.cancelRunning(x.id, "test cleanup"); else e.sem.cancelQueued(x.id, "manual", "test cleanup"); });
const drain = async (holders) => { holders.forEach((h) => h.release()); await bounded(Promise.all(holders.map((h) => h.run)), "holders drained"); };

/**
 * Queue an advisory behind a saturated cap, start the REAL merge (`start()`), release one holder so the merge gate is admitted (which
 * supersedes the advisory), and return the merge's settled result. `gated:false` skips the admission wait (an interval-skipped landing).
 */
async function drive(e, start, { gated = true } = {}) {
  const { holders, advisory } = await queueAdvisory(e);
  const merge = start();
  if (gated) await waitUntil(() => e.sem.snapshot().entries.some((x) => x.gateType === "merge" && x.phase === "queued"), { label: "the merge gate queued behind the holders", timeoutMs: BUDGET_MS });
  // An ungated landing never queues, so the advisory must stay QUEUED (cap still saturated) until the landing has finished: that is
  // the state in which a wrongly-superseding ungated landing would withdraw it.
  if (gated) holders[0].release();
  if (gated) await bounded(advisory, "the superseded advisory settled");
  const result = await bounded(merge, "the merge settled");
  if (!gated) holders[0].release();
  return { holders, advisory, result };
}
const soloLanded = (r) => r.settled === true && r.ok === true && r.value?.merged === true;

/** After a landing that must NOT re-run: nothing re-enqueued (synchronous witness: the re-enqueue registers inside the merge's own finally). */
function noReRun(label, e) {
  check(`${label}: nothing held and no advisory re-entered the queue or reached a worktree cut`,
    e.sessions.supersededAdvisories.size === 0 && e.advisoryEntries().length === 0 && e.rec.cuts.length === 0 && e.sessions.activeDistImporterRuns.size === 0);
}
async function reRanOnce(label, e) {
  try { await waitUntil(() => e.rec.cuts.length === 1, { label: `${label}: the superseded advisory re-ran`, timeoutMs: BUDGET_MS }); }
  catch { check(`${label}: the superseded advisory re-ran (it never did within ${BUDGET_MS}ms: the landing was dropped)`, false); return; }
  check(`${label}: it re-ran exactly once, at the superseded sha`, e.rec.cuts.length === 1 && e.rec.cuts[0].sha === ADV_SHA);
  check(`${label}: the held map is empty (re-enqueued once, not held again)`, e.sessions.supersededAdvisories.size === 0);
}

try {
  // ── SOLO ──────────────────────────────────────────────────────────────────────────────────────────
  { // (S1) reduced pass that lands
    const e = mkEnv();
    const w = await addWorker(e.db, e.P, "s1", "fa", "comment");
    const { holders, result } = await drive(e, () => e.sessions.confirmWorkerMergeTracked(e.P.mgrId, w.workerId));
    check("(S1) precondition: it LANDED on a REDUCED gate (command is not the configured full gate, no full suite)", soloLanded(result) && e.rec.gateCmds.length === 1 && e.rec.gateCmds[0] !== FULL_GATE && !e.rec.gateCmds[0].includes("test:daemon"));
    check("(S1) precondition: the advisory WAS superseded by that gate", e.supersededEvents().length === 1);
    await reRanOnce("(S1) a reduced pass is NOT coverage", e);
    cancelAdvisories(e); await drain(holders);
  }
  { // (S2) full pass that lands
    const e = mkEnv();
    const w = await addWorker(e.db, e.P, "s2", "fa", "behavior");
    const { holders, result } = await drive(e, () => e.sessions.confirmWorkerMergeTracked(e.P.mgrId, w.workerId));
    check("(S2) precondition: it LANDED on the FULL configured gate", soloLanded(result) && e.rec.gateCmds.length === 1 && e.rec.gateCmds[0] === FULL_GATE);
    check("(S2) precondition: the advisory WAS superseded by that gate", e.supersededEvents().length === 1);
    noReRun("(S2) a full pass that landed IS coverage", e);
    await drain(holders);
    noReRun("(S2) ...and still nothing once the cap drained", e);
  }
  { // (S3) full pass, then a squash refusal (main moves after the gate => gate_base_invalidated)
    const e = mkEnv();
    const w = await addWorker(e.db, e.P, "s3", "fa", "behavior");
    e.script.fn = async () => { fs.writeFileSync(path.join(e.P.repo, "moved.txt"), "main moved\n"); commitAll(e.P.repo, "chore: main moves after the gate", GIT_ID); return PASS; };
    const { holders, result } = await drive(e, () => e.sessions.confirmWorkerMergeTracked(e.P.mgrId, w.workerId));
    check("(S3) precondition: the FULL gate passed but the squash REFUSED (not merged, gateBaseInvalidated)", result.settled === true && result.ok === true && result.value?.merged === false && result.value?.gateBaseInvalidated === true && e.rec.gateCmds[0] === FULL_GATE);
    check("(S3) precondition: the advisory WAS superseded by that gate", e.supersededEvents().length === 1);
    await reRanOnce("(S3) a pass that did not LAND is NOT coverage", e);
    cancelAdvisories(e); await drain(holders);
  }
  { // (S4) a real interval-skipped landing: no gate admitted => no supersede at all
    const e = mkEnv({ mergeGate: "off", mergeGateInterval: 2 });
    const w = await addWorker(e.db, e.P, "s4", "fa", "behavior");
    const { holders, advisory, result } = await drive(e, () => e.sessions.confirmWorkerMergeTracked(e.P.mgrId, w.workerId), { gated: false });
    check("(S4) precondition: it LANDED ungated by the interval (no gate command ran, skipReason gate-interval)", soloLanded(result) && result.value.skipReason === "gate-interval" && e.rec.gateCmds.length === 0);
    check("(S4) the queued advisory was NOT superseded: no superseded event and nothing held", e.supersededEvents().length === 0 && e.sessions.supersededAdvisories.size === 0);
    check(`(S4) ...and it is still QUEUED in the semaphore (phases: ${e.advisoryEntries().map((x) => x.phase).join(",") || "none"})`, e.advisoryEntries().some((x) => x.phase === "queued"));
    // The post-landing kick folds a follow-up behind the in-flight loop, so cancelling one entry can start the next: cancel until the loop settles.
    let loopDone = false; advisory.then(() => { loopDone = true; }, () => { loopDone = true; });
    await waitUntil(() => { cancelAdvisories(e); return loopDone; }, { label: "(S4) cleanup: the advisory loop settled once cancelled", timeoutMs: BUDGET_MS });
    await drain(holders);
  }

  // ── BATCH ─────────────────────────────────────────────────────────────────────────────────────────
  { // (B1) reduced batch pass that lands
    const e = mkEnv();
    const a = await addWorker(e.db, e.P, "b1a", "fa", "comment");
    const b = await addWorker(e.db, e.P, "b1b", "fb", "comment");
    const { holders, result } = await drive(e, () => e.sessions.mergeBatchTracked(e.P.mgrId, [a.workerId, b.workerId]));
    check("(B1) precondition: the batch LANDED on a REDUCED gate", result.settled === true && result.ok === true && result.value?.landed?.length === 2 && e.rec.gateCmds.length === 1 && e.rec.gateCmds[0] !== FULL_GATE && !e.rec.gateCmds[0].includes("test:daemon"));
    check("(B1) precondition: the advisory WAS superseded by that gate", e.supersededEvents().length === 1);
    await reRanOnce("(B1) a reduced batch pass is NOT coverage", e);
    cancelAdvisories(e); await drain(holders);
  }
  { // (B2) full batch pass that lands
    const e = mkEnv();
    const a = await addWorker(e.db, e.P, "b2a", "fa", "behavior");
    const b = await addWorker(e.db, e.P, "b2b", "fb", "behavior");
    const { holders, result } = await drive(e, () => e.sessions.mergeBatchTracked(e.P.mgrId, [a.workerId, b.workerId]));
    check("(B2) precondition: the batch LANDED on the FULL configured gate", result.settled === true && result.ok === true && result.value?.landed?.length === 2 && e.rec.gateCmds.length === 1 && e.rec.gateCmds[0] === FULL_GATE);
    check("(B2) precondition: the advisory WAS superseded by that gate", e.supersededEvents().length === 1);
    noReRun("(B2) a full batch pass that landed IS coverage", e);
    await drain(holders);
    noReRun("(B2) ...and still nothing once the cap drained", e);
  }
  { // (B3) RED batch, then per-branch fallbacks (full gates, each landing) => exactly ONE re-run, no double report
    const e = mkEnv();
    const a = await addWorker(e.db, e.P, "b3a", "fa", "behavior");
    const b = await addWorker(e.db, e.P, "b3b", "fb", "behavior");
    e.script.fn = async (callNo) => (callNo === 1 ? RED : PASS);
    const { holders, result } = await drive(e, () => e.sessions.mergeBatchTracked(e.P.mgrId, [a.workerId, b.workerId]));
    check("(B3) precondition: the batch gate was RED and the fallbacks ran their own gates (3 gate calls) and landed", result.settled === true && e.rec.gateCmds.length === 3 && e.rec.gateCmds.every((c) => c === FULL_GATE));
    check("(B3) precondition: ONLY the batch gate superseded the advisory (fallbacks never do)", e.supersededEvents().length === 1);
    await reRanOnce("(B3) a RED batch gate is NOT coverage", e);
    cancelAdvisories(e); await drain(holders);
    check("(B3) and the fallbacks' own landings did not re-run it a second time", e.rec.cuts.length === 1);
  }

  // The (P) source-text pin of the coverage expressions lives in dist-importer-supersede-coverage-source-pin.mjs.
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* best-effort */ } }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
