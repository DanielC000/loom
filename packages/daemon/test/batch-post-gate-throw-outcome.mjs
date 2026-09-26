import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c8e1f2aa — a merge_batch step that throws AFTER a passing gate reports a per-candidate outcome through runFallback's no-start mode.
// REAL git on temp repos + an INJECTED `runGate` seam (the batch-guard-release-on-throw.mjs fixture shape). Decision record: docs/decisions/13571c71-*.md.
//   (PRE)   the gate passes whole, then the post-runExclusive build_gate event throws (BEFORE the fast-forward): the batch fast-forward did NOT land.
//   (MOVED-PRE / FORFEIT) another merge moves main while the batch gate runs, then a throw before the fast-forward / after the forfeit: the BATCH did NOT land (batchLanded false), whatever main did.
//   (POST)  the first landed branch's finishAlreadyMerged throws (AFTER the fast-forward): the batch fast-forward DID land.
//   (the ASYNC settle-notice case lives in batch-post-gate-throw-notice.mjs — split so each file stays well under the 120s blanket ceiling)
// Each case asserts: every candidate reported started:false with the honest batch-landed claim; landed stays []; the repo guard is released;
// gate_status carries batchLanded false/true; the retained verdict is NEVER cached (a re-call re-mints, no cacheHit).
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/batch-post-gate-throw-outcome.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

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

const dbs = [];
const headOf = (repo) => execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
async function repro(label, { inject, patchSvc, budget, expectMoved, moveMain }) {
  const P = mk(label); makeRepo(P);
  const db = new Db(); dbs.push(db);
  seedProject(db, P);
  const a = await addWorker(db, P, `${label}a`, { [`src/${label}a.ts`]: `export const ${label}a = 1;\n` });
  const b = await addWorker(db, P, `${label}b`, { [`src/${label}b.ts`]: `export const ${label}b = 2;\n` });
  let releaseGate; const gateHold = budget ? new Promise((r) => { releaseGate = r; }) : null; // the gate stays held until the caller has degraded (no timer)
  let movedOnce = false; // moveMain: ANOTHER merge lands on canonical main while the batch gate runs (main moves, the batch does not land)
  const ctx = mkService(db, async () => { if (gateHold) await gateHold; if (moveMain && !movedOnce) { movedOnce = true; execSync("git commit --allow-empty -q -m other-merge", { cwd: P.repo }); } return PASS_FULL; });
  if (budget) ctx.sessions.syncAttachBudgetMs = budget;
  const msgs = []; const origEDM = ctx.sessions.enqueueDurableMessage.bind(ctx.sessions);
  ctx.sessions.enqueueDurableMessage = (t, m, o) => { msgs.push(String(m)); return origEDM(t, m, o); };
  patchSvc?.(ctx.sessions);
  inject?.(db);
  const head0 = headOf(P.repo);
  let r = await settle(ctx.sessions.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
  let v;
  if (budget) {
    check(`(${label}) the caller degraded past the attach budget (settled:false)`, r.value?.settled === false);
    releaseGate();
    await waitUntil(() => msgs.some((m) => m.includes("[loom:merge-batch-")), { timeoutMs: ADMIT_BUDGET_MS, label: "the batch settle notice" });
    const note = msgs.find((m) => m.includes("[loom:merge-batch-")) ?? "";
    check(`(${label}) the settle notice is [loom:merge-batch-unknown], says AFTER its gate passed, and names main state (not "landed nothing")`, note.includes("[loom:merge-batch-unknown]") && note.includes("AFTER its gate passed") && note.includes(expectMoved) && !note.includes("landed nothing"));
    check(`(${label}) the notice says the candidates were NOT started`, /2 candidate\(s\) NOT started/.test(note));
    const opId = /\[op ([0-9a-f-]+)\]/.exec(note)?.[1];
    const gs = opId ? ctx.sessions.gateStatus(opId) : null;
    check(`(${label}) gate_status(op) batchLanded === ${expectMoved.includes("NOT") ? "false" : "true"}`, gs?.batchLanded === !expectMoved.includes("NOT"));
  } else {
    v = r.value?.ok ? r.value.value : undefined;
    check(`(${label}) the throw became a resolved value {ok:false, postGateThrow:true} (not a rethrown error)`, !!v && v.ok === false && v.postGateThrow === true);
    check(`(${label}) landed stays [] and EVERY candidate is reported started:false`, v?.landed?.length === 0 && v?.fallback?.length === 2 && v.fallback.every((f) => f.started === false));
    check(`(${label}) each reason names the recovery + the honest batch-landed claim ("${expectMoved}")`, v?.fallback?.every((f) => f.reason.includes("AFTER the batch gate passed") && f.reason.includes(expectMoved) && f.reason.includes("worker_merge_confirm")));
    const opId = v?.opId; const gs = opId ? ctx.sessions.gateStatus(opId) : null;
    check(`(${label}) gate_status(op) batchLanded === ${expectMoved.includes("NOT") ? "false" : "true"} (never a bare pass)`, gs?.state === "settled" && gs.batchLanded === !expectMoved.includes("NOT"));
  }
  check(`(${label}) main HEAD moved iff the batch landed or another merge moved it (the claim is about the BATCH, not main)`, (headOf(P.repo) !== head0) === (!expectMoved.includes("NOT") || !!moveMain));
  const g = guardState(ctx, P);
  check(`(${label}) the repo guard is released (activeMergeRepos + squashOnlySnapshot empty for the repo)`, !g.held && g.size === 0 && g.squash === 0);
  if (!budget) {
    const r2 = await settle(ctx.sessions.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
    check(`(${label}) a same-ids re-call RE-MINTS (freshMint, no cacheHit) — the post-gate error is never replayed`, !!r2.value?.freshMint && !r2.value?.cacheHit);
  }
}

try {
  await repro("pre", { inject: (db) => throwOnceOnEvent(db, "build_gate"), expectMoved: "the batch fast-forward did NOT land" });
  await repro("post", {
    patchSvc: (svc) => { let f = false; const o = svc.finishAlreadyMerged.bind(svc); svc.finishAlreadyMerged = async (...a) => { if (!f) { f = true; throw new Error("injected finishAlreadyMerged failure"); } return o(...a); }; },
    expectMoved: "the batch fast-forward DID land",
  });
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a post-gate batch throw reports every candidate, states main's real state, releases the guard and is never cached."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
