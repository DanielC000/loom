import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE_BATCH ALL-DROPPED gate_status (card 92eeb319): a batch op whose candidates were ALL dropped at assembly never calls runGate, so
// the pending_gate_ops tombstone (minted only inside runGate) never existed and gate_status(opId) read `never_existed` for an op that
// demonstrably ran. The tombstone is now minted at the top of the op's closure and settled by onSettle on every completion.
// Proves (REAL git, real SessionService, fake gate):
//   (1) all-dropped op: gate_status(opId) AND its 8-char prefix are `settled` with an explicit no-gate verdict (outcome skipped,
//       skipReason all-candidates-dropped, NOT gate-disabled/gate-interval, batchBranchCount 0, batchLanded false, passed false) and
//       totalDurationMs === settledAt - admittedAt.
//   (2) a NORMAL gated batch is unchanged: pass verdict, durationMs = the gate run (not assembly), admissionWaitMs excludes the worktree
//       cut + assembly, and totalDurationMs still covers cut + assembly + queue + gate.
// Run: 1) pnpm build, 2) node packages/daemon/test/merge-batch-all-dropped-gate-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mbag-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mbag@loom -c user.name=mbag";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const write = (dir, f, c) => fs.writeFileSync(path.join(dir, f), c);

// A 120s sync budget means the call settles synchronously; a degraded `{settled:false}` re-attaches to the SAME in-flight op by key.
async function batchUntilSettled(svc, mgr, ids) {
  const deadline = Date.now() + 60_000;
  let r = await svc.mergeBatchTracked(mgr, ids);
  while (!r.settled) {
    if (Date.now() > deadline) throw new Error(`mergeBatchTracked did not settle within 60s (last op state: ${JSON.stringify(r.op)})`);
    r = await svc.mergeBatchTracked(mgr, ids);
  }
  return r;
}

function makeRepo(name) {
  const repo = path.join(os.tmpdir(), `loom-mbag-${name}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  write(repo, "README.md", "# mbag\n");
  write(repo, "shared.txt", "base\n");
  execSync(`git init -q && git config user.email mbag@loom && git config user.name mbag`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

const worktrees = [];
let db;
try {
  db = new Db();
  const P = `mbag-proj-${sfx}`;
  const repo = makeRepo("repo");
  db.insertProject({ id: P, name: "MBAG", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "node -e \"process.exit(0)\"" } }, createdAt: now, archivedAt: null });
  const agentId = `${P}-dev`;
  db.insertAgent({ id: agentId, projectId: P, name: "dev", startupPrompt: "", position: 0 });
  const mgrId = `${P}-mgr1`;
  db.insertSession({ id: mgrId, projectId: P, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  async function addWorker(label, file, content) {
    const taskId = `mbag-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, P, taskId);
    worktrees.push(worktreePath);
    if (file) { write(worktreePath, file, content); commitAll(worktreePath, `feat(test): ${label}`, GIT_ID); }
    db.insertTask({ id: taskId, projectId: P, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const workerId = `${P}-wkr-${label}`;
    db.insertSession({ id: workerId, projectId: P, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    return { workerId, taskId, branch, worktreePath };
  }

  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
  const known = new Set();
  const GATE_MS = 400;
  // The batch's own private worktree passes after a fixed run time (to size durationMs against); any known worker worktree fails fast so a
  // fallback confirm drains instead of holding the shared gate slot.
  const fakeGate = async (_cmd, wt) => {
    if (known.has(wt)) return { passed: false, reason: "test: fallback gate rejected" };
    await new Promise((r) => setTimeout(r, GATE_MS)); // TIMING-GUARD-SAFE: a fixed gate duration to size durationMs against, not a negative assertion
    return { passed: true };
  };
  const svc = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate, gateOpRetainMs: 0, syncAttachBudgetMs: 120_000 });

  // ── (1) ALL-DROPPED batch (same shape as merge-batch-drop-reasons.mjs scenario 1) ──
  const c = await addWorker("res", "shared.txt", "worker version\n");
  const d = await addWorker("foreign", "foreign-own.txt", "own\n");
  const side = await addWorker("side", "side.txt", "side\n");
  known.add(c.worktreePath); known.add(d.worktreePath); known.add(side.worktreePath);
  write(repo, "shared.txt", "main version\n");
  commitAll(repo, "chore(test): main edits shared", GIT_ID);
  try { execSync(`git ${GIT_ID} merge --no-edit ${git(repo, "rev-parse HEAD")}`, { cwd: c.worktreePath, stdio: "pipe" }); } catch { /* conflict expected */ }
  write(c.worktreePath, "shared.txt", "hand resolved\n");
  commitAll(c.worktreePath, "Merge main into branch (resolved)", GIT_ID);
  execSync(`git ${GIT_ID} merge --no-edit ${side.branch}`, { cwd: d.worktreePath, stdio: "pipe" });

  const r1 = await batchUntilSettled(svc, mgrId, [c.workerId, d.workerId]);
  const v1 = r1.value ?? r1;
  const opId1 = v1.opId;
  check("(1) precondition: a batch ran, nothing landed, ok:false", r1.settled === true && v1.ok === false && v1.landed.length === 0 && typeof opId1 === "string");
  const gs = svc.gateStatus(opId1);
  console.log("gate_status(all-dropped opId) =", JSON.stringify(gs));
  check("(1) gate_status(opId) is settled, NOT never_existed", gs.state === "settled");
  check("(1) it is a merge op with an explicit no-gate verdict: outcome skipped, passed false", gs.gateType === "merge" && gs.outcome === "skipped" && gs.passed === false);
  check("(1) it says plainly that the BATCH gate never ran and the candidates went to their own confirms (not 'landed nothing')",
    typeof gs.reason === "string" && /the batch gate never ran: every candidate was dropped at assembly and handed to its own worker_merge_confirm/.test(gs.reason) && !/landed nothing/.test(gs.reason));
  check("(1) skipReason is all-candidates-dropped — NOT the gate-disabled/gate-interval an ungated landing carries", gs.skipReason === "all-candidates-dropped");
  check("(1) batchBranchCount:0 and batchLanded:false are the measured negatives", gs.batchBranchCount === 0 && gs.batchLanded === false);
  check("(1) no gate-run facts are fabricated (no steps, no durationMs, no outputTail)", gs.steps === undefined && gs.durationMs === undefined && gs.outputTail === undefined);
  check("(1) admittedAt/settledAt present and totalDurationMs === settledAt - admittedAt exactly",
    typeof gs.admittedAt === "string" && typeof gs.settledAt === "string" && gs.totalDurationMs === Date.parse(gs.settledAt) - Date.parse(gs.admittedAt));
  const gsPrefix = svc.gateStatus(opId1.slice(0, 8));
  check("(1) the 8-char opId prefix resolves to the same settled verdict", gsPrefix.state === "settled" && gsPrefix.outcome === "skipped" && gsPrefix.skipReason === "all-candidates-dropped");
  check("(1) no build_gate event exists for the op (no gate ran)", !db.listEvents(mgrId).some((e) => e.kind === "build_gate" && e.detail?.opId === opId1));

  // ── (2) NORMAL gated batch: two clean branches land ──
  const a = await addWorker("a", "a-only.txt", "from a\n");
  const b = await addWorker("b", "b-only.txt", "from b\n");
  known.add(a.worktreePath); known.add(b.worktreePath);
  const r2 = await batchUntilSettled(svc, mgrId, [a.workerId, b.workerId]);
  const v2 = r2.value ?? r2;
  const opId2 = v2.opId;
  check("(2) precondition: the normal batch landed both branches", v2.ok === true && v2.landed.length === 2 && typeof opId2 === "string");
  const g2 = svc.gateStatus(opId2);
  console.log("gate_status(normal opId) =", JSON.stringify({ state: g2.state, outcome: g2.outcome, durationMs: g2.durationMs, totalDurationMs: g2.totalDurationMs, admittedAt: g2.admittedAt, settledAt: g2.settledAt, batchBranchCount: g2.batchBranchCount, batchLanded: g2.batchLanded }));
  check("(2) a gated batch is still a settled pass with batchBranchCount 2 / batchLanded true", g2.state === "settled" && g2.outcome === "pass" && g2.passed === true && g2.batchBranchCount === 2 && g2.batchLanded === true);
  check("(2) no skipReason on a gated batch", g2.skipReason === undefined);
  const bg = db.listEvents(mgrId).find((e) => e.kind === "build_gate" && e.detail?.opId === opId2);
  check("(2) its build_gate event carries the phase timings", !!bg && typeof bg.detail.worktreeCutMs === "number" && typeof bg.detail.assemblyMs === "number" && typeof bg.detail.admissionWaitMs === "number");
  check("(2) durationMs (verdict AND event) is the gate RUN — at least the fake gate's own duration", g2.durationMs >= GATE_MS - 50 && bg?.detail.durationMs >= GATE_MS - 50);
  check("(2) admissionWaitMs is queue wait only: it excludes the worktree cut + assembly (an empty queue waits ~nothing)", bg?.detail.admissionWaitMs >= 0 && bg?.detail.admissionWaitMs < 250);
  check("(2) totalDurationMs (settledAt - admittedAt) covers cut + assembly + queue + gate",
    g2.totalDurationMs === Date.parse(g2.settledAt) - Date.parse(g2.admittedAt) && g2.totalDurationMs >= bg.detail.worktreeCutMs + bg.detail.assemblyMs + bg.detail.admissionWaitMs + bg.detail.durationMs - 5);
} finally {
  if (db) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
