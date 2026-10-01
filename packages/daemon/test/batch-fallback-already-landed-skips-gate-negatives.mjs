import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 293d418e — a branch whose content is PROVEN already on main finishes as ALREADY_MERGED WITHOUT running the merge gate.
// REAL git on temp repos + an INJECTED `runGate` counter (the batch-post-gate-throw-outcome.mjs POST fixture: FF lands, then finishAlreadyMerged throws once; a same-ids re-call drops both to the solo fallback).
//   (B1) NEGATIVE: a late commit adding a NEW path never takes the skip — the ordinary path runs for real.
//   (B2) NEGATIVE: a late commit on an ALREADY-CHANGED path never takes the skip (the content proof is non-empty).
//   (C) NEGATIVE: a dirty worktree is never finished by the skip.
//
// SPLIT OFF batch-fallback-already-landed-skips-gate.mjs (card 45d6e631): that file ran 82-120s solo-in-suite
// (per-file timing history: maxPass ~107,008ms vs the 120,000ms blanket ceiling, 1.12x margin, 2/11
// observed SIGTERM kills — see project memory `batch-fallback-already-landed-skips-gate-rides-the-120s-ceiling`).
// These three NEGATIVE scenarios moved here verbatim; (A)/(D) stay in the sibling file, (E)/(F)/(G) moved
// to batch-fallback-already-landed-skips-gate-semantics.mjs. Profiled (Date.now() timers around each
// scenario, instrumented copy never committed; 4 runs, one under a concurrent sibling test lane):
// (B1)+(B2)+(C) solo/loaded max 42,228ms — ~35% of the 120s ceiling, well under the ~50% split target.
//
// Decision record: docs/decisions/293d418e-*.md.  Run: pnpm build, then LOOM_CODEX_BIN=<nonexistent> node test/batch-fallback-already-landed-skips-gate-negatives.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";

process.env.LOOM_GATE_RETRY_SETTLE_MS = "20";
useOwnLoomHome("loom-bgrot-neg-");

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
  db.insertProject({ id: P.projId, name: "BGROT", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "node packages/daemon/test/flaky-mid.mjs", ...(P.orch ?? {}) } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
const PASS_FULL = { passed: true, steps: [{ step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 5, status: 0 }] };
const settle = async (p) => { try { return { value: await p }; } catch (err) { return { thrown: err }; } };
function mkService(db, script) {
  const ctx = { calls: 0 };
  ctx.sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async (gate, ...rest) => { ctx.calls++; return script(ctx.calls, gate, ...rest); },
    reapWorktreeProcesses: noReap,
  });
  return ctx;
}
const dbs = [];
const eventsOf = (db, kind, workerId) => db.listEventsForWorker(workerId).filter((e) => e.kind === kind);

/** POST-FF fixture: the batch fast-forwards both candidates, then the first landed branch's finishAlreadyMerged throws once. */
async function landedFixture(label, orchExtra = {}) {
  const P = mk(label); P.orch = orchExtra; makeRepo(P);
  const db = new Db(); dbs.push(db);
  seedProject(db, P);
  const a = await addWorker(db, P, `${label}a`, { [`src/${label}a.ts`]: `export const ${label}a = 1;\n` });
  const b = await addWorker(db, P, `${label}b`, { [`src/${label}b.ts`]: `export const ${label}b = 2;\n` });
  const ctx = mkService(db, async () => PASS_FULL);
  const svc = ctx.sessions;
  let thrown = false; const o = svc.finishAlreadyMerged.bind(svc);
  svc.finishAlreadyMerged = async (...x) => { if (!thrown) { thrown = true; throw new Error("injected finishAlreadyMerged failure"); } return o(...x); };
  const r1 = await settle(svc.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
  check(`(${label}/setup) the POST-FF throw resolved as postGateThrow (both branches already on main)`, r1.value?.ok && r1.value.value?.postGateThrow === true);
  return { P, db, a, b, ctx, svc };
}

try {
  // (B1) NEGATIVE: a late commit adding a NEW path (branch ahead of its landed commit): the ordinary path runs — the gate runs and the late commit lands for real.
  {
    const { P, db, a, ctx, svc } = await landedFixture("dl");
    fs.writeFileSync(path.join(a.worktreePath, "src", "dla-late.ts"), "export const dlaLate = 999;\n");
    commitAll(a.worktreePath, "feat(x): late change dla", GIT_ID);
    const before = ctx.calls;
    const r = await settle(svc.confirmWorkerMergeTracked(P.mgrId, a.workerId));
    const v = r.value?.ok ? r.value.value : undefined;
    check(`(B1) a late commit adding a new path STILL gates (gate calls +${ctx.calls - before})`, ctx.calls - before >= 1);
    check("(B1) …and is never reported as a gate-skipped finish", v?.gateSkipped === undefined && eventsOf(db, "merge_done", a.workerId).every((e) => e.detail?.gateSkipped === undefined));
  }
  // (B2) a late commit on an ALREADY-CHANGED path (the landed file gets new content): the content check is non-empty, so the skip is NOT taken — nothing finishes, nothing is deleted.
  {
    const { P, db, a, ctx, svc } = await landedFixture("dc");
    fs.writeFileSync(path.join(a.worktreePath, "src", "dca.ts"), "export const dca = 12345;\n");
    commitAll(a.worktreePath, "feat(x): late edit of an already-landed path", GIT_ID);
    const before = ctx.calls;
    const r = await settle(svc.confirmWorkerMergeTracked(P.mgrId, a.workerId));
    const v = r.value?.ok ? r.value.value : undefined;
    check("(B2) a late commit on an already-changed path does NOT take the gate-skip path", v?.gateSkipped === undefined && v?.merged !== true && eventsOf(db, "merge_done", a.workerId).length === 0);
    check("(B2) …and the branch and worktree are untouched", fs.existsSync(a.worktreePath) && execSync(`git branch --list ${a.branch}`, { cwd: P.repo }).toString().trim() !== "");
    void before;
  }

  // (C) NEGATIVE: a dirty worktree is never finished by the skip.
  {
    const { P, db, a, ctx, svc } = await landedFixture("dt");
    fs.writeFileSync(path.join(a.worktreePath, "src", "uncommitted.ts"), "export const x = 1;\n");
    const r = await settle(svc.confirmWorkerMergeTracked(P.mgrId, a.workerId));
    const v = r.value?.ok ? r.value.value : undefined;
    check("(C) a dirty worktree does NOT take the gate-skip path", v?.gateSkipped === undefined && eventsOf(db, "merge_done", a.workerId).every((e) => e.detail?.gateSkipped === undefined));
    check("(C) …and the confirm is refused (merged:false) with the untouched dirty file still on disk", v?.merged === false && fs.existsSync(path.join(a.worktreePath, "src", "uncommitted.ts")));
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — any unlanded delta (new path / already-changed path) or a dirty worktree never takes the already-landed gate-skip path (see batch-fallback-already-landed-skips-gate.mjs for the positive-path scenarios)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
