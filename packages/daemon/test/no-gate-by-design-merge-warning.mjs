import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-warning suppression test for Project.noGateByDesign (card 58b0bb60). REAL git on temp repos, NO
// claude and NO live daemon — drives SessionService.confirmWorkerMerge() directly against an isolated
// LOOM_HOME (mirrors merge-confirm-idempotent.mjs / merge-gate-diagnostic.mjs's in-process style).
//
// THE PROBLEM: a deliberately gateless project (vault/markdown/knowledge, no buildable code) got the
// per-merge "unverified: no gateCommand is configured…" warning on EVERY merge — noise for an intentional
// absence. THE FIX: confirmWorkerMerge's gateWarning is now gated on `gate || project.noGateByDesign`.
//
// Proves the DoD:
//   (1) FLAGGED + no gateCommand → merges CLEAN, no warning at all (the noise is gone).
//   (2) UNFLAGGED + no gateCommand → STILL warns (a genuinely missing gate stays surfaced) — the control.
//   (3) a project WITH a gateCommand configured is UNAFFECTED by the flag either way: the gate still RUNS
//       (a green gate merges with no warning) whether noGateByDesign is true or false.
// Run: 1) build daemon (pnpm build), 2) node test/no-gate-by-design-merge-warning.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ngbd-mw-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=ngbdmw@loom -c user.name=ngbdmw";
const now = new Date().toISOString();

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function seed(p, { gateCommand, noGateByDesign } = {}) {
  db.insertProject({
    id: p.projId, name: "NGBD-MW", repoPath: p.repo, vaultPath: p.repo,
    config: gateCommand ? { orchestration: { gateCommand } } : {},
    createdAt: now, archivedAt: null, reserved: false, referenceRepos: [],
    noGateByDesign: !!noGateByDesign,
  });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "NGBD-MW-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# ngbd-mw\n");
  execSync(`git init -q && git config user.email ngbdmw@loom && git config user.name ngbdmw && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `ngbd-mw-${label}-proj-${sfx}`, agentId: `ngbd-mw-${label}-agent-${sfx}`, taskId: `ngbd-mw-${label}-task-${sfx}`,
  mgrId: `ngbd-mw-${label}-mgr-${sfx}`, workerId: `ngbd-mw-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-ngbd-mw-${label}-${sfx}`), file,
});
const F = mk("f", "feat-f.txt"); // (1) flagged, no gate → clean
const U = mk("u", "feat-u.txt"); // (2) unflagged, no gate → still warns (control)
const G0 = mk("g0", "feat-g0.txt"); // (3a) gateCommand configured, flag false → unaffected
const G1 = mk("g1", "feat-g1.txt"); // (3b) gateCommand configured, flag true → unaffected

async function commitAndConfirm(p, opts) {
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p, opts);
  return sessions.confirmWorkerMerge(p.mgrId, p.workerId);
}

try {
  // ── (1) FLAGGED + no gateCommand → merges clean, NO warning ─────────────────────────────────────────
  makeRepo(F);
  {
    const confirmF = await commitAndConfirm(F, { noGateByDesign: true });
    check("(1) merged:true", confirmF.merged === true);
    check("(1) NO warning at all — the flag suppressed the no-gate noise", confirmF.warning === undefined);
    check("(1) task moved to done", db.getTask(F.taskId).columnKey === "done");
  }

  // ── (2) CONTROL: UNFLAGGED + no gateCommand → still warns ───────────────────────────────────────────
  makeRepo(U);
  {
    const confirmU = await commitAndConfirm(U, { noGateByDesign: false });
    check("(2) merged:true", confirmU.merged === true);
    check("(2) warning IS present (an unflagged gateless project stays surfaced)", typeof confirmU.warning === "string");
    check("(2) warning names the missing gateCommand", /unverified: no gateCommand is configured/.test(confirmU.warning ?? ""));
  }

  // ── (3a) gateCommand configured, flag FALSE → gate still runs, no warning ───────────────────────────
  makeRepo(G0);
  {
    const confirmG0 = await commitAndConfirm(G0, { gateCommand: 'node -e "process.exit(0)"', noGateByDesign: false });
    check("(3a) merged:true (green gate ran)", confirmG0.merged === true);
    check("(3a) no warning (a configured gate needs no no-gate warning)", confirmG0.warning === undefined);
  }

  // ── (3b) gateCommand configured, flag TRUE → gate STILL runs (flag doesn't skip it), no warning ─────
  makeRepo(G1);
  {
    const confirmG1 = await commitAndConfirm(G1, { gateCommand: 'node -e "process.exit(0)"', noGateByDesign: true });
    check("(3b) merged:true (green gate ran — the flag never bypasses gate EXECUTION, only the warning)", confirmG1.merged === true);
    check("(3b) no warning either way", confirmG1.warning === undefined);
  }
} finally {
  db.close();
  for (const p of [F, U, G0, G1]) {
    for (const d of [p.repo, p.worktreePath]) { if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } } }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a project flagged noGateByDesign merges with NO 'unverified: no gateCommand' warning, an unflagged gateless project still warns (control), and a project WITH a gateCommand configured is unaffected by the flag either way (the gate still runs; the flag only silences the no-gate warning path)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
