import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// THE SYNTHETIC HELD/RELEASE CASE — split out of batch-merge-retain-hold-release.mjs by card 03b4f491
// (see docs/decisions/03b4f491-*.md): that file ran 24-33s solo but was SIGTERM-killed at the 120s
// ceiling in an advisory ~695-file check on a loaded host. The core (setup + hand-deleted-branch) case
// stays in batch-merge-retain-hold-release.mjs; the standalone finalizeMerge CAS-skip unit is in
// batch-merge-retain-hold-release-cas-skip.mjs.
// Rebuilds the SAME real mixed batch [A,B,C] (so B is a real, already-landed branch — byte-identical
// setup to the sibling file, but its own three setup assertions are NOT re-asserted here; they're
// covered once, in batch-merge-retain-hold-release.mjs), then proves:
//   (release)  a synthetic retain (a hand-appended batch_merge_branch_retained event for D) is held
//              until a REAL merge_done newer than the retain releases it — the negative control runs
//              last, since a released candidate may land.
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-retain-hold-release-synthetic-retain.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmrh-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmrh@loom -c user.name=bmrh";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const dbs = [];
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-bmrh-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmrh\n");
  execSync(`git init -q && git config user.email bmrh@loom && git config user.name bmrh`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };

try {
  // ── the same real mixed batch as the sibling file, to produce a real, already-landed B — assertions
  // for this setup are NOT re-run here (they're covered once, in batch-merge-retain-hold-release.mjs). ──
  const repo = makeRepo("mix");
  const projId = `bmrh-proj-${sfx}`, agentId = `bmrh-agent-${sfx}`, mgrId = `bmrh-mgr-${sfx}`;
  const cut = async (label, file) => {
    const taskId = `bmrh-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, file), `work ${label}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a", "feature-a.txt");
  const b = await cut("b", "feature-b.txt");
  const c = await cut("c", "feature-a.txt"); // add/add conflict with A once A has landed ⇒ dropped, never finished
  const d = await cut("d", "feature-d.txt");  // synthetic held candidate for the (release) cases; not in the first batch

  const script = path.join(os.tmpdir(), `loom-bmrh-gate-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, [
    `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
    `const wt = ${JSON.stringify(a.worktreePath)};`,
    `if (!fs.existsSync(path.join(wt, "late-commit.txt"))) {`,
    `  fs.writeFileSync(path.join(wt, "late-commit.txt"), "added during the gate\\n");`,
    `  execSync("git add late-commit.txt && git -c user.email=bmrh@loom -c user.name=bmrh commit -q -m late-commit", { cwd: wt, stdio: "ignore" });`,
    `}`,
    `process.exit(0);`,
  ].join("\n"));

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: "BMRH", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmrh-wkr-a-${sfx}`, wB = `bmrh-wkr-b-${sfx}`, wC = `bmrh-wkr-c-${sfx}`, wD = `bmrh-wkr-d-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"], [wC, c, "c"], [wD, d, "d"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  // A budget pinned HIGH through the constructor seam so the outcome cannot depend on host speed.
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, ...extra });
  const svc1 = mk();

  await svc1.mergeBatchTracked(mgrId, [wA, wB, wC]); // lands A (retained pre-stop) and B; drops C — see the sibling file for the asserted setup checks
  try {
    await waitUntil(() => db.listEventsForWorker(wC).some((e) => e.kind === "merge_rejected" || e.kind === "merge_cancelled"), { timeoutMs: 90_000, label: "C's fallback confirm to settle (rejected)" });
  } catch { /* the sibling file asserts this settling; here it's only an ordering wait before the release checks below */ }

  const heldEntry = (val, w) => val?.fallback.find((f) => f.workerSessionId === w && f.started === false && /held/.test(f.reason));
  const refire = async (svc, ids) => {
    let r = await svc.mergeBatchTracked(mgrId, ids);
    if (!r.settled) {
      await waitUntil(() => svc.gateStatus(r.op.opId).state === "settled", { timeoutMs: 90_000, label: "re-fire op to settle" });
      r = await svc.mergeBatchTracked(mgrId, ids);
    }
    return r.settled && r.ok ? r.value : undefined;
  };

  // (release) NEGATIVE CONTROL — last, since a released candidate may land.
  // D: a synthetic retain (ref-kept-after-finalize) on a branch with a real commit — the candidate the (release) control releases.
  db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrId, kind: "batch_merge_branch_retained", workerSessionId: wD, taskId: d.taskId, detail: { opId: "synthetic", branch: d.branch, assembledTip: "0".repeat(40), liveTip: "1".repeat(40), phase: "ref-kept-after-finalize" } });
  check("(release) precondition: D is held before the release", !!heldEntry(await refire(mk(), [wD, wB]), wD));
  db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() + 5).toISOString(), managerSessionId: mgrId, kind: "merge_done", workerSessionId: wD, taskId: d.taskId, detail: { branch: d.branch } });
  const releaseDVal = await refire(mk(), [wD, wB]);
  check("(release control) a merge_done NEWER than D's retain RELEASES D (no held entry)", !heldEntry(releaseDVal, wD));
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
