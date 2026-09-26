import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A MERGE FINALIZE MUST NOT FORCE-REMOVE A WORKTREE THAT HOLDS UNCOMMITTED WORK (card 6796c9ea).
// 42daa283 retains a batch candidate whose COMMITTED tip moved while the gate ran; an UNCOMMITTED edit made in the
// candidate's worktree in that window (untracked file, or a tracked file modified) was still destroyed when finalize
// force-removed the worktree after a green batch. `finalizeMerge` -> `gcWorktreeDir` (the ONE removal chokepoint the solo
// `worker_merge_confirm`, `merge_batch` and every ALREADY_MERGED finish share) now asks `readWorktreeUncommittedState` first
// and RETAINS a dirty worktree, and FAILS CLOSED when the status cannot be read.
// Fixtures: a REAL mergeBatchTracked whose gate command (a real child process) writes into the candidates' worktrees:
//   (dirty)   A gets an UNTRACKED file, B has a TRACKED file modified, D is the clean control (must still be removed).
//   (unknown) the gate breaks A's worktree `.git` link so `git status` errors: retained (fail closed), D still removed.
// Plus (unit) finalizeMerge directly: the shared solo/batch removal path, forceRemoveWorktree override, and the
// noise-only (`.claude/` untracked) control that must still be removed.
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-dirty-worktree-retained.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bdw-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bdw@loom -c user.name=bdw";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const refExists = (repo, ref) => { try { git(repo, `rev-parse --verify --quiet refs/heads/${ref}`); return true; } catch { return false; } };
const dbs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-bdw-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bdw\n");
  execSync(`git init -q && git config user.email bdw@loom && git config user.name bdw`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };

async function batchScenario(mode) {
  const tag = mode;
  const repo = makeRepo(tag);
  const projId = `bdw-proj-${tag}-${sfx}`, agentId = `bdw-agent-${tag}-${sfx}`, mgrId = `bdw-mgr-${tag}-${sfx}`;
  const cut = async (label) => {
    const taskId = `bdw-task-${tag}-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, `feature-${label}.txt`), `work ${label}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a"), b = await cut("b"), d = await cut("d");

  // IDEMPOTENT gate (exits 0 always): the "worker" edits candidate worktrees WITHOUT committing while the gate runs.
  const script = path.join(os.tmpdir(), `loom-bdw-gate-${tag}-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, [
    `import fs from "node:fs"; import path from "node:path";`,
    `const A = ${JSON.stringify(a.worktreePath)}, B = ${JSON.stringify(b.worktreePath)};`,
    mode === "dirty"
      ? `fs.writeFileSync(path.join(A, "scratch-untracked.txt"), "uncommitted, made during the gate\\n");\nfs.appendFileSync(path.join(B, "feature-b.txt"), "tracked edit made during the gate\\n");`
      : `fs.rmSync(path.join(A, ".git"), { force: true }); // replace (a direct overwrite of a hidden .git file is EPERM on Windows)\nfs.writeFileSync(path.join(A, ".git"),"gitdir: " + path.join(A, "no-such-gitdir") + "\\n");`,
    `process.exit(0);`,
  ].join("\n"));

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `BDW-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bdw-wkr-${tag}-a-${sfx}`, wB = `bdw-wkr-${tag}-b-${sfx}`, wD = `bdw-wkr-${tag}-d-${sfx}`;
  const members = [[wA, a, "a"], [wB, b, "b"], [wD, d, "d"]];
  for (const [wId, w, label] of members) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  // syncAttachBudgetMs pinned HIGH through the constructor seam: the settled value is read directly (never widen the production budget).
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000 });
  const r = await sessions.mergeBatchTracked(mgrId, members.map((m) => m[0]));
  check(`(${tag}) the batch settled synchronously (pinned-high budget)`, r.settled === true);
  const result = r.settled && r.ok ? r.value : undefined;
  const row = (br) => result?.landed.find((l) => l.branch === br);
  check(`(${tag}) batch ok:true and A, B, D all landed on main`, result?.ok === true && !!row(a.branch) && !!row(b.branch) && !!row(d.branch)
    && ["feature-a.txt", "feature-b.txt", "feature-d.txt"].every((f) => fs.existsSync(path.join(repo, f))));

  // Control (clean candidate) — proves the check discriminates: D is still finalized exactly as before.
  check(`(${tag}) control: clean D's worktree WAS removed and its branch deleted`, !fs.existsSync(d.worktreePath) && !refExists(repo, d.branch));
  check(`(${tag}) control: clean D's landed row carries NO worktreeRetainedDirty and no branchAdvancedDuringGate`, row(d.branch)?.worktreeRetainedDirty === undefined && row(d.branch)?.branchAdvancedDuringGate === undefined);
  check(`(${tag}) control: clean D's task moved off in_progress and merge_done filed`, db.getTask(d.taskId)?.columnKey !== "in_progress" && db.listEventsForWorker(wD).some((e) => e.kind === "merge_done"));

  if (mode === "dirty") {
    // What SURVIVES, not merely that a flag fired.
    check("(dirty) A's UNTRACKED file survives on disk with its content", fs.existsSync(path.join(a.worktreePath, "scratch-untracked.txt")) && /made during the gate/.test(fs.readFileSync(path.join(a.worktreePath, "scratch-untracked.txt"), "utf8")));
    check("(dirty) B's TRACKED-file edit survives on disk", fs.existsSync(path.join(b.worktreePath, "feature-b.txt")) && /tracked edit made during the gate/.test(fs.readFileSync(path.join(b.worktreePath, "feature-b.txt"), "utf8")));
    const fa = row(a.branch)?.worktreeRetainedDirty, fb = row(b.branch)?.worktreeRetainedDirty;
    check("(dirty) A's landed row names the retention (unverified:false) and lists the untracked file", !!fa && fa.unverified === false && fa.files.includes("scratch-untracked.txt"));
    check("(dirty) B's landed row names the retention and lists the modified tracked file", !!fb && fb.unverified === false && fb.files.includes("feature-b.txt"));
    check("(dirty) A's and B's branch refs are kept (their worktrees still have them checked out)", refExists(repo, a.branch) && refExists(repo, b.branch));
    check("(dirty) the MERGE itself stands: main carries A's and B's committed work, the uncommitted files are NOT on main", fs.existsSync(path.join(repo, "feature-a.txt")) && !fs.existsSync(path.join(repo, "scratch-untracked.txt")) && !/tracked edit/.test(fs.readFileSync(path.join(repo, "feature-b.txt"), "utf8")));
    check("(dirty) A's task still moved to the terminal lane and merge_done filed (landing is not undone)", db.getTask(a.taskId)?.columnKey !== "in_progress" && db.listEventsForWorker(wA).some((e) => e.kind === "merge_done"));
    check("(dirty) not confused with the tip-moved signal: no branchAdvancedDuringGate on A or B", row(a.branch)?.branchAdvancedDuringGate === undefined && row(b.branch)?.branchAdvancedDuringGate === undefined);
  } else {
    const fa = row(a.branch)?.worktreeRetainedDirty;
    check("(unknown) A's worktree is RETAINED when its status cannot be read (fail closed)", fs.existsSync(a.worktreePath) && fs.existsSync(path.join(a.worktreePath, "feature-a.txt")));
    check("(unknown) A's landed row reports the retention with unverified:true", !!fa && fa.unverified === true && fa.files.length === 0);
    check("(unknown) B (status readable, clean) was removed as before", !fs.existsSync(b.worktreePath) && row(b.branch)?.worktreeRetainedDirty === undefined);
  }
}

try {
  await batchScenario("dirty");
  await batchScenario("unknown");

  // ── (unit) finalizeMerge — the ONE shared path (solo confirm, batch, ALREADY_MERGED all call it) ────────
  {
    const repo = makeRepo("fin");
    const projId = `bdw-proj-fin-${sfx}`, agentId = `bdw-agent-fin-${sfx}`, mgrId = `bdw-mgr-fin-${sfx}`;
    const db = new Db(); dbs.push(db);
    db.insertProject({ id: projId, name: "BDW-fin", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());
    const mk = async (label) => {
      const taskId = `bdw-task-fin-${label}-${sfx}`, wId = `bdw-wkr-fin-${label}-${sfx}`;
      const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
      registerForCleanup(worktreePath);
      fs.writeFileSync(path.join(worktreePath, `${label}.txt`), `${label}\n`);
      commitAll(worktreePath, label, GIT_ID);
      db.insertTask({ id: taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
      return { taskId, wId, worktreePath, branch, args: { managerSessionId: mgrId, workerSessionId: wId, taskId, worktreePath, branch, repoPath: repo, projectId: projId, mergedSha: null, repoKey: null } };
    };

    const dirty = await mk("dirty");
    fs.writeFileSync(path.join(dirty.worktreePath, "post-review.txt"), "edited after review\n");
    let cb;
    const res = await sessions.finalizeMerge({ ...dirty.args, onWorktreeRetainedDirty: (i) => { cb = i; } });
    check("(fin) a dirty worktree is retained: dir + file survive, result and callback name it", fs.existsSync(path.join(dirty.worktreePath, "post-review.txt")) && res.dirtyWorktreeRetained?.files.includes("post-review.txt") === true && cb?.files.includes("post-review.txt") === true);
    check("(fin) its branch ref is NOT deleted while the worktree lives", refExists(repo, dirty.branch));
    check("(fin) worktreeGcOutcome stays unset (retention is not a removal failure)", res.worktreeGcOutcome === undefined);

    // forceRemoveWorktree is the manager's explicit 'disposable' override — same semantic as the nested-repo guard.
    const forced = await sessions.finalizeMerge({ ...dirty.args, forceRemoveWorktree: true });
    check("(fin) forceRemoveWorktree:true still removes a dirty worktree (explicit manager override)", !fs.existsSync(dirty.worktreePath) && forced.dirtyWorktreeRetained === undefined);

    // Noise control: daemon-injected untracked `.claude/` files are NOT work and must not block cleanup.
    const noisy = await mk("noisy");
    fs.mkdirSync(path.join(noisy.worktreePath, ".claude", "skills", "x"), { recursive: true });
    fs.writeFileSync(path.join(noisy.worktreePath, ".claude", "skills", "x", "SKILL.md"), "injected\n");
    const nres = await sessions.finalizeMerge(noisy.args);
    check("(fin) control: a worktree with only daemon-injected .claude/ noise is removed", !fs.existsSync(noisy.worktreePath) && nres.dirtyWorktreeRetained === undefined);

    // Dead leftover (the Windows busy-handle case): the dir survives but has NO `.git` link, so `git status` would fail "not a git
    // repository". It has nothing git can lose and must reach removal (the re-finalize paths exist for exactly this), NOT be retained as "unknown".
    const dead = await mk("dead");
    fs.rmSync(path.join(dead.worktreePath, ".git"), { force: true });
    fs.writeFileSync(path.join(dead.worktreePath, "leftover-untracked.txt"), "x\n");
    const dres = await sessions.finalizeMerge(dead.args);
    check("(fin) control: a leftover dir with NO .git link is NOT retained as unknown — it proceeds to removal", dres.dirtyWorktreeRetained === undefined && !fs.existsSync(dead.worktreePath));

    // node_modules control: an UNTRACKED node_modules/ install (repo without a .gitignore for it) is provisioned noise, not work.
    const nm = await mk("nm");
    fs.mkdirSync(path.join(nm.worktreePath, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(nm.worktreePath, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    const nmres = await sessions.finalizeMerge(nm.args);
    check("(fin) control: untracked node_modules/ alone does NOT retain the worktree", nmres.dirtyWorktreeRetained === undefined && !fs.existsSync(nm.worktreePath));

    // Vanished directory: nothing to lose, finalize proceeds (never wedges on a missing dir).
    const gone = await mk("gone");
    fs.rmSync(gone.worktreePath, { recursive: true, force: true });
    const gres = await sessions.finalizeMerge(gone.args);
    check("(fin) control: an already-missing worktree dir does not block finalize", gres.dirtyWorktreeRetained === undefined && db.listEventsForWorker(gone.wId).some((e) => e.kind === "merge_done"));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
