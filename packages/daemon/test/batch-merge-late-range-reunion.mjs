import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A HELD BRANCH'S LATE-RANGE UNION MUST NOT UNDO A CHANGE MAIN MADE AND THEN REVERTED (card 13fc5227, Code Review round 1) + the late-range review is exact + the fail-closed paths.
// Companion to batch-merge-late-range-landing.mjs (which proves the first union, the review field and two fail-closed cases). Fixture as there: A adds feature-a.txt + extra-a.txt, a real
// merge_batch retains it after the gate reverts extra-a.txt; main ALSO carries other.txt = "x" from the init commit.
//   (reunion-red)   confirm #1 unions main (other.txt = "y", M1) into A's worktree and the gate is RED, so the union U1 stays on the branch; main then REVERTS other.txt to "x" (M2); confirm #2
//                   re-unions. Using the assembled tip as the merge base AGAIN would take "y" from U1 (an older common base than M1) and land it, undoing main's revert; the plain merge
//                   (merge base M1) keeps "x". Asserts main keeps other.txt == "x" AND loses extra-a.txt. Must be RED on 19d20dd4.
//   (reunion-moved) same, but main moves DURING the (passing) gate: the first confirm is refused because main advanced, U1 stays, the re-confirm lands.
//   (review-exact)  after U1 the review's `lateRange` lists ONLY what will land (extra-a.txt, the late-revert subject) — not main's own changes/subjects.
//   (unverified)    the hold's release cannot be verified (a failing probe) ⇒ refused, "usually transient".
//   (no-tip)        a retain event with no assembledTip/landedTip/landedSha ⇒ refused, names the missing range.
//   (no-live-tip)   the branch ref cannot be read ⇒ refused.
//   (no-gate)       the repo has no gateCommand ⇒ refused (the late-range union exists only on the gated path).
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-late-range-reunion.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmlu-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmlu@loom -c user.name=bmlu";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const noReap = async () => ({ killedPids: [] });
const FAIL = { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
const dbs = [];

async function setup(tag) {
  const repo = path.join(os.tmpdir(), `loom-bmlu-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmlu\n");
  fs.writeFileSync(path.join(repo, "other.txt"), "x\n");
  execSync(`git init -q && git config user.email bmlu@loom && git config user.name bmlu`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const projId = `bmlu-proj-${tag}-${sfx}`, agentId = `bmlu-agent-${tag}-${sfx}`, mgrId = `bmlu-mgr-${tag}-${sfx}`;
  const cut = async (label, files) => {
    const taskId = `bmlu-task-${tag}-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    for (const f of files) fs.writeFileSync(path.join(worktreePath, f), `work ${label} ${f}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a", ["feature-a.txt", "extra-a.txt"]);
  const b = await cut("b", ["feature-b.txt"]);
  const script = path.join(os.tmpdir(), `loom-bmlu-gate-${tag}-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, [
    `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
    `const wt = ${JSON.stringify(a.worktreePath)};`,
    `if (fs.existsSync(path.join(wt, "extra-a.txt"))) {`,
    `  execSync("git rm -q extra-a.txt && git -c user.email=bmlu@loom -c user.name=bmlu commit -q -m late-revert", { cwd: wt, stdio: "ignore" });`,
    `}`,
    `process.exit(0);`,
  ].join("\n"));
  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `BMLU-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmlu-wkr-a-${tag}-${sfx}`, wB = `bmlu-wkr-b-${tag}-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, reapWorktreeProcesses: noReap, ...extra });
  const first = await mk().mergeBatchTracked(mgrId, [wA, wB]);
  const val = first.settled && first.ok ? first.value : undefined;
  check(`(${tag} setup) the batch landed A and B and RETAINED A`, val?.ok === true && !!val.landed.find((l) => l.branch === a.branch)?.branchAdvancedDuringGate);
  const mainCommit = (file, content, subject) => { fs.writeFileSync(path.join(repo, file), content); commitAll(repo, subject, GIT_ID); };
  return { repo, projId, mgrId, wA, a, db, mk, mainCommit, script };
}

const otherOnMain = (repo) => fs.readFileSync(path.join(repo, "other.txt"), "utf8").trim();

try {
  // ── (reunion-red) + (review-exact) ─────────────────────────────────────────────────────────────────────────────────
  {
    const s = await setup("red");
    const { repo, mgrId, wA, a, mk, mainCommit } = s;
    await mk().reviewWorkerMerge(mgrId, wA);
    mainCommit("other.txt", "y\n", "main1-other-y");
    const red = await mk({ runGate: async () => FAIL }).confirmWorkerMerge(mgrId, wA);
    check("(reunion-red setup) confirm #1 was rejected by the red gate (nothing landed) and left the union of main on A's branch", red.merged === false && git(repo, `log ${a.branch} --format=%s`).includes("Merge main into branch (owed commits over"));
    mainCommit("other.txt", "x\n", "main2-revert-other");
    check("(reunion-red setup) main reverted other.txt to x", otherOnMain(repo) === "x");
    // (review-exact) the branch now HOLDS a union of main: the review must report only what will land, not main's own change or its subjects.
    const rev = await mk().reviewWorkerMerge(mgrId, wA);
    const lr = rev.lateRange;
    check("(review-exact) lateRange lists ONLY extra-a.txt (main's other.txt change is NOT reported as the branch's)", !!lr && lr.filesChanged === 1 && lr.files[0]?.file === "extra-a.txt" && lr.deletions === 1);
    check("(review-exact) lateRange subjects are ONLY the branch's own late commit (none of main's subjects)", !!lr && lr.commitSubjects.length === 1 && lr.commitSubjects[0] === "late-revert");
    const res = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(reunion-red) the re-confirm lands: merged:true", res.merged === true);
    check("(reunion-red) OUTCOME: main KEEPS its own revert (other.txt == x), not the stale y", otherOnMain(repo) === "x");
    check("(reunion-red) OUTCOME: main lost the reverted extra-a.txt and still has feature-a.txt", !fs.existsSync(path.join(repo, "extra-a.txt")) && fs.existsSync(path.join(repo, "feature-a.txt")));
  }

  // ── (reunion-moved) main moves during a passing gate ──────────────────────────────────────────────────────────────────
  {
    const s = await setup("moved");
    const { repo, mgrId, wA, a, mk, mainCommit } = s;
    await mk().reviewWorkerMerge(mgrId, wA);
    mainCommit("other.txt", "y\n", "main1-other-y");
    let moved = false;
    const movingGate = async () => { if (!moved) { moved = true; mainCommit("other.txt", "x\n", "main2-revert-other"); } return { passed: true }; };
    const r1 = await mk({ runGate: movingGate }).confirmWorkerMerge(mgrId, wA);
    check("(reunion-moved setup) the first confirm did not land (main advanced during its gate)", r1.merged === false && moved === true);
    let r2 = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    for (let i = 0; i < 2 && r2.merged !== true; i++) r2 = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(reunion-moved) the re-confirm lands: merged:true", r2.merged === true);
    check("(reunion-moved) OUTCOME: main KEEPS its own revert (other.txt == x) and lost extra-a.txt", otherOnMain(repo) === "x" && !fs.existsSync(path.join(repo, "extra-a.txt")) && fs.existsSync(path.join(repo, "feature-a.txt")));
    void a;
  }

  // ── fail-closed paths ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const s = await setup("unverified");
    const { repo, mgrId, wA, a, mk } = s;
    const failing = () => ({ raw: async () => { throw new Error("simulated transient git failure"); } });
    const mainBefore = git(repo, "rev-parse HEAD");
    const rev = await mk({ heldProbeGitFactory: failing }).reviewWorkerMerge(mgrId, wA);
    check("(unverified) worker_merge warns that the release could not be verified and shows no late range", rev.lateRange === undefined && /could not be verified/.test(rev.warning ?? ""));
    const res = await mk({ heldProbeGitFactory: failing, runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(unverified) confirm REFUSES (usually transient, retry); main untouched, branch intact", res.merged === false && /usually transient, retry/.test(res.reason ?? "") && git(repo, "rev-parse HEAD") === mainBefore && !!git(repo, `rev-parse ${a.branch}`));
  }
  {
    const s = await setup("notip");
    const { repo, mgrId, wA, a, db, mk } = s;
    db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() + 5000).toISOString(), managerSessionId: mgrId, kind: "batch_merge_branch_retained", workerSessionId: wA, taskId: a.taskId, detail: { opId: "synthetic", branch: a.branch, phase: "pre-stop" } });
    const mainBefore = git(repo, "rev-parse HEAD");
    const res = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(no-tip) confirm REFUSES: the retain records no readable assembledTip/landedTip; main untouched", res.merged === false && /records no readable assembledTip\/landedTip/.test(res.reason ?? "") && git(repo, "rev-parse HEAD") === mainBefore);
  }
  {
    const s = await setup("nolive");
    const { repo, mgrId, wA, a, mk } = s;
    git(repo, `update-ref -d refs/heads/${a.branch}`);
    const mainBefore = git(repo, "rev-parse HEAD");
    const res = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(no-live-tip) confirm REFUSES: the branch's current tip could not be read; main untouched", res.merged === false && /current tip could not be read/.test(res.reason ?? "") && git(repo, "rev-parse HEAD") === mainBefore);
  }
  {
    const s = await setup("nogate");
    const { repo, mgrId, wA, projId, db, mk } = s;
    const cfg = db.getProject(projId).config;
    db.setProjectConfig(projId, { ...cfg, orchestration: { ...(cfg.orchestration ?? {}), gateCommand: undefined } });
    const mainBefore = git(repo, "rev-parse HEAD");
    const res = await mk().confirmWorkerMerge(mgrId, wA);
    check("(no-gate) confirm REFUSES: a held branch's late range is landed only through the gated union; main untouched", res.merged === false && /no gateCommand/.test(res.reason ?? "") && git(repo, "rev-parse HEAD") === mainBefore);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
