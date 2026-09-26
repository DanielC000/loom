import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e78756dd — the batch merge releases its per-repo merge guard on EVERY exit after a passing gate, not only a clean return.
// REAL git on temp repos + an INJECTED `runGate` seam (the merge-gate-red-any-end.mjs fixture shape). Decision record:
// docs/decisions/c24dd48a-*.md (`holdRepoGuardOnExit` needs an unconditional `finally` reaching `endSquash` on every exit path).
//
// A passing gate link calls `holdRepoGuardOnExit`, so `runExclusive`'s finally KEEPS the per-repo guard for the squash; the batch used to
// release it only by an inline `endSquash` after `runBatchedMerge` returned, so a throw between the pass and that line leaked it forever
// (every later same-repo merge queued, repoContended, until a daemon restart).
//
//   (A)  BATCH: the single-file retry passes COMPLETELY, then its `next` throws (T3c's shape) ⇒ guard released, a following merge admitted.
//   (B)  BATCH: the gate passes WHOLE, then the code after `runExclusive` throws (the `build_gate` evtBatch) ⇒ same.
//   (C)  SOLO PARITY: a solo merge whose gate passed, then a throw inside the squash bracket ⇒ same (already true; pinned so the two
//        paths cannot diverge again).
//   (D)  POSITIVE CONTROL (the check can fail): a passing batch that never throws still ends with the guard free, and the following
//        merge is admitted (a leak here would be caught by the SAME assertions).
// Each case asserts `activeMergeRepos` for the repo AND `squashOnlySnapshot()` are empty after the op settles, AND that a following
// same-repo merge is actually ADMITTED (it runs its gate and lands) rather than left queued.
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/batch-guard-release-on-throw.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";

process.env.LOOM_GATE_RETRY_SETTLE_MS = "20";
useOwnLoomHome("loom-bgrot-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bgrot@loom -c user.name=bgrot";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const ADMIT_BUDGET_MS = 20_000; // a POSITIVE wait: a leaked guard never admits, so this only ever expires on a real leak

const mk = (label) => ({
  projId: `bgrot-${label}-proj-${sfx}`, agentId: `bgrot-${label}-agent-${sfx}`, mgrId: `bgrot-${label}-mgr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-bgrot-${label}-${sfx}`),
});
function makeRepo(P) {
  fs.mkdirSync(P.repo, { recursive: true });
  registerForCleanup(P.repo);
  fs.writeFileSync(path.join(P.repo, "README.md"), "# bgrot\n");
  fs.mkdirSync(path.join(P.repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(P.repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  fs.mkdirSync(path.join(P.repo, "packages", "daemon", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(P.repo, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
  fs.mkdirSync(path.join(P.repo, "packages", "daemon", "test"), { recursive: true });
  fs.writeFileSync(path.join(P.repo, "packages", "daemon", "test", "flaky-mid.mjs"), "// stub\n");
  execSync(`git init -q && git config user.email bgrot@loom && git config user.name bgrot`, { cwd: P.repo });
  commitAll(P.repo, "init", GIT_ID);
}
async function addWorker(db, P, n, files) {
  const taskId = `bgrot-${n}-task-${sfx}`; const workerId = `bgrot-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(worktreePath, rel)), { recursive: true }); fs.writeFileSync(path.join(worktreePath, rel), body); }
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
function seedProject(db, P) {
  db.insertProject({ id: P.projId, name: "BGROT", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "node packages/daemon/test/flaky-mid.mjs", } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
const GENUINE_ONLY = {
  passed: false, failedStep: "node packages/daemon/test/flaky-mid.mjs", failedStatus: 1, failedSignal: null, failedTimedOut: false,
  outputTail: "", failingTest: "FAIL  flaky-mid", failingTestCount: 1, failTierTest: "FAIL  flaky-mid", failTierTestCount: 1, failTierAll: ["FAIL  flaky-mid"],
  steps: [{ step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 20, status: 1 }],
};
const PASS_ONE = { passed: true, steps: [{ step: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-mid", durationMs: 5, status: 0 }] };
const PASS_FULL = { passed: true, steps: [{ step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 5, status: 0 }] };
const settle = async (p) => { try { return { value: await p }; } catch (err) { return { thrown: err }; } };
const withBudget = async (p) => { let t; const to = new Promise((r) => { t = setTimeout(() => r("TIMEOUT"), ADMIT_BUDGET_MS); }); try { return await Promise.race([p, to]); } finally { clearTimeout(t); } };
function throwOnceOnEvent(db, kind) {
  const orig = db.appendEvent.bind(db); let fired = false;
  db.appendEvent = (e) => { if (!fired && e.kind === kind) { fired = true; throw new Error(`injected ${kind} failure`); } return orig(e); };
  return () => fired;
}
function mkService(db, script) {
  const ctx = { calls: 0 };
  ctx.sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async (gate, ...rest) => { ctx.calls++; return script(ctx.calls, gate, ...rest); },
    reapWorktreeProcesses: noReap,
  });
  return ctx;
}
const guardState = (ctx, P) => {
  const sem = ctx.sessions.gateSemaphore;
  return { held: sem.activeMergeRepos.has(P.repo), size: sem.activeMergeRepos.size, squash: sem.squashOnlySnapshot().filter((s) => s.repoPath === P.repo).length };
};
/** A following same-repo solo merge: it must be ADMITTED (its gate runs) and land, not sit queued behind a leaked guard. */
async function followingMergeAdmitted(ctx, P, db, c) {
  const before = ctx.calls;
  const r = await withBudget(settle(ctx.sessions.confirmWorkerMergeTracked(P.mgrId, c.workerId)));
  const v = r === "TIMEOUT" ? null : r.value;
  return { timedOut: r === "TIMEOUT", gateRan: ctx.calls > before, merged: v?.settled === true && v.ok === true && v.value?.merged === true };
}
async function caseBatch(label, script, inject, expectPrecondition) {
  const P = mk(label); makeRepo(P);
  const db = new Db(); dbs.push(db);
  seedProject(db, P);
  const a = await addWorker(db, P, `${label}a`, { [`src/${label}a.ts`]: `export const ${label}a = 1;\n` });
  const b = await addWorker(db, P, `${label}b`, { [`src/${label}b.ts`]: `export const ${label}b = 2;\n` });
  const c = await addWorker(db, P, `${label}c`, { [`src/${label}c.ts`]: `export const ${label}c = 3;\n` });
  const ctx = mkService(db, script);
  const fired = inject ? inject(db) : () => true;
  await settle(ctx.sessions.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
  check(`(${label}) precondition: ${expectPrecondition.text}`, fired() && ctx.calls === expectPrecondition.calls);
  const g = guardState(ctx, P);
  check(`(${label}) THE FIX: the repo guard is released after the batch settles (activeMergeRepos + squashOnlySnapshot empty for the repo)`, !g.held && g.size === 0 && g.squash === 0);
  const f = await followingMergeAdmitted(ctx, P, db, c);
  check(`(${label}) a following same-repo merge is ADMITTED (gate ran, not left queued) and lands`, !f.timedOut && f.gateRan && f.merged);
  return { P, ctx };
}

const dbs = [];
try {
  // (A) T3c's shape: complete single-file pass, then a throw in its `next`.
  await caseBatch("a", (n) => (n === 1 ? GENUINE_ONLY : PASS_ONE), (db) => throwOnceOnEvent(db, "build_gate_single_file_retry"),
    { calls: 2, text: "the chain ended by the injected throw AFTER the single-file retry passed completely (2 gate calls, injection fired)" });
  // (B) whole-gate pass, then the post-`runExclusive` evtBatch("build_gate") throws.
  await caseBatch("b", () => PASS_FULL, (db) => throwOnceOnEvent(db, "build_gate"),
    { calls: 1, text: "the gate passed whole, then the post-runExclusive build_gate event threw (1 gate call, injection fired)" });
  // (D) positive control: no throw ⇒ the same assertions hold on the clean path.
  await caseBatch("d", () => PASS_FULL, null, { calls: 1, text: "a clean batch pass (1 gate call, no injection)" });
  // (C) solo parity: gate passes, then a throw INSIDE the squash bracket (reviewedTipVerdict runs between beginSquash and mergeBranch; it also runs pre-gate, so only throw once the gate has run).
  {
    const P = mk("c"); makeRepo(P);
    const db = new Db(); dbs.push(db);
    seedProject(db, P);
    const w = await addWorker(db, P, "cw", { "src/cw.ts": "export const cw = 1;\n" });
    const c2 = await addWorker(db, P, "cw2", { "src/cw2.ts": "export const cw2 = 2;\n" });
    const ctx = mkService(db, () => PASS_FULL);
    const realVerdict = ctx.sessions.reviewedTipVerdict.bind(ctx.sessions);
    let injected = false;
    ctx.sessions.reviewedTipVerdict = async (...a) => { if (!injected && ctx.calls >= 1) { injected = true; throw new Error("injected in-squash failure"); } return realVerdict(...a); };
    const r = await settle(ctx.sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId));
    check("(C) precondition: the solo gate passed and the injected in-squash throw fired (op did not merge)", injected && ctx.calls === 1 && !(r.value?.ok && r.value.value?.merged === true));
    const g = guardState(ctx, P);
    check("(C) SOLO PARITY: the repo guard is released (activeMergeRepos + squashOnlySnapshot empty for the repo)", !g.held && g.size === 0 && g.squash === 0);
    const f = await followingMergeAdmitted(ctx, P, db, c2);
    check("(C) a following same-repo merge is ADMITTED and lands", !f.timedOut && f.gateRan && f.merged);
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the batch (and solo) merge guard is released on every exit after a passing gate; a following same-repo merge is admitted."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
