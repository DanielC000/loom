import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH FINALIZE TIP GUARD — TWO EDGES batch-merge-branch-advanced-during-gate.mjs does not cover (card a498cc3c; guard from card 42daa283).
// mergeBatchTracked retains a landed branch (no finalize) when `!assembledTip || !liveTip || liveTip !== assembledTip`, and finalizeMerge re-checks
// the same tip after the worker stop. That sibling test only ever drives the "tip MOVED to another sha" arm. Here:
//   (U) UNREADABLE tip => FAIL CLOSED. A candidate's branch ref is deleted mid-gate, so the live tip cannot be read. The batch must RETAIN
//       (flag liveTip:null, phase pre-stop, durable event), never finalize on the strength of "nothing moved". (u) same arm at finalizeMerge itself.
//   (N) NOOP (already-in-ancestry) landing. A candidate whose tip is ALREADY an ancestor of main and whose work has a trailer squash on main lands as
//       `noop:true` (ALREADY_MERGED) with assembledTip = its branch tip. The guard must apply to it exactly as to a fresh landing:
//       N1 unmoved => finalized normally (branch deleted, merge_done); N2 committed-to mid-gate => RETAINED with its worktree and the late commit.
// Controls: B (a normal candidate, unmoved) finalizes; N1 is the unmoved control for N2 and A's control is B.
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-finalize-guard-edges.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmfge-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmfge@loom -c user.name=bmfge";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// NOTE: `refs/heads/<b>` (never `<b>^{commit}` — cmd.exe treats `^` as its escape char on Windows).
const refExists = (repo, ref) => { try { git(repo, `rev-parse --verify --quiet refs/heads/${ref}`); return true; } catch { return false; } };
const subjectsOf = (repo, b) => { try { return git(repo, `log ${b} --format=%s`).split("\n"); } catch { return []; } };
const dbs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-bmfge-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmfge\n");
  execSync(`git init -q && git config user.email bmfge@loom && git config user.name bmfge`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function seedDb(tag, repo, script) {
  const projId = `bmfge-proj-${tag}-${sfx}`, agentId = `bmfge-agent-${tag}-${sfx}`, mgrId = `bmfge-mgr-${tag}-${sfx}`;
  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `BMFGE-${tag}`, repoPath: repo, vaultPath: repo, config: script ? { orchestration: { gateCommand: `node "${script}"` } } : {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const addWorker = (label, w) => {
    const wId = `bmfge-wkr-${tag}-${label}-${sfx}`;
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
    return wId;
  };
  return { db, projId, agentId, mgrId, addWorker };
}
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
const eventsOf = (db, wId, kind) => db.listEventsForWorker(wId).filter((e) => e.kind === kind);

async function cutWorker(repo, projId, tag, label, file) {
  const taskId = `bmfge-task-${tag}-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, file), `work ${label}\n`);
  commitAll(worktreePath, label, GIT_ID);
  return { taskId, branch, worktreePath };
}

// Put `w`'s work on main the way a solo squash does (a trailer squash commit), THEN merge the branch itself into main, so the branch tip is an
// ANCESTOR of main while a `Loom-Worker-Branch` squash for it also exists: the batch lands it as noop/ALREADY_MERGED.
function landAsAncestorPlusSquash(repo, w) {
  git(repo, `merge --squash ${w.branch}`);
  const msg = path.join(os.tmpdir(), `loom-bmfge-msg-${sfx}-${path.basename(w.worktreePath)}.txt`);
  registerForCleanup(msg);
  fs.writeFileSync(msg, `feat(test): squashed ${w.branch}\n\nLoom-Worker-Branch: ${w.branch}\n`);
  git(repo, `${GIT_ID} commit -q -F "${msg}"`);
  git(repo, `${GIT_ID} merge --no-ff -q -m "merge ${w.branch}" ${w.branch}`);
  return git(repo, `log --grep="Loom-Worker-Branch: ${w.branch}" -F --format=%H`);
}

try {
  // ── (U)+(N): one REAL mergeBatchTracked run over A (ref deleted mid-gate), N1 (noop, unmoved: also the readable-tip control for A), N2 (noop, moved mid-gate). Three candidates = the batch cap ──
  {
    const tag = "e2e";
    const repo = makeRepo(tag);
    const script = path.join(os.tmpdir(), `loom-bmfge-gate-${tag}-${sfx}.mjs`);
    registerForCleanup(script);
    const S = seedDb(tag, repo, script);
    const a = await cutWorker(repo, S.projId, tag, "a", "feature-a.txt");
    const n1 = await cutWorker(repo, S.projId, tag, "n1", "noop-1.txt");
    const n2 = await cutWorker(repo, S.projId, tag, "n2", "noop-2.txt");
    const sq1 = landAsAncestorPlusSquash(repo, n1);
    landAsAncestorPlusSquash(repo, n2);
    check("(N) setup: N1 and N2 tips are ancestors of main, and their work is on main", git(repo, `merge-base HEAD ${n1.branch}`) === git(repo, `rev-parse ${n1.branch}`) && git(repo, `merge-base HEAD ${n2.branch}`) === git(repo, `rev-parse ${n2.branch}`) && fs.existsSync(path.join(repo, "noop-1.txt")) && fs.existsSync(path.join(repo, "noop-2.txt")));

    // The gate (a real child process, idempotent): deletes A's ref (=> unreadable tip) and commits to N2's worktree (=> moved tip); exits 0.
    fs.writeFileSync(script, [
      `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
      `const n2 = ${JSON.stringify(n2.worktreePath)};`,
      `if (!fs.existsSync(path.join(n2, "late-n2.txt"))) {`,
      `  fs.writeFileSync(path.join(n2, "late-n2.txt"), "added during the gate\\n");`,
      `  execSync("git add late-n2.txt && git -c user.email=bmfge@loom -c user.name=bmfge commit -q -m late-n2", { cwd: n2, stdio: "ignore" });`,
      `}`,
      `try { execSync("git update-ref -d refs/heads/${a.branch}", { cwd: ${JSON.stringify(repo)}, stdio: "ignore" }); } catch {}`,
      `process.exit(0);`,
    ].join("\n"));

    const wA = S.addWorker("a", a), wN1 = S.addWorker("n1", n1), wN2 = S.addWorker("n2", n2);
    const aTip = git(repo, `rev-parse ${a.branch}`), n2Tip = git(repo, `rev-parse ${n2.branch}`);
    const sessions = new SessionService(S.db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000 });
    const r = await sessions.mergeBatchTracked(S.mgrId, [wA, wN1, wN2]);
    const result = r.settled && r.ok ? r.value : undefined;
    check("(e2e) the pinned-high budget settled the batch synchronously and it is ok", r.settled === true && result?.ok === true);
    if (process.env.BMFGE_DEBUG) console.log(JSON.stringify({ n1: n1.branch, n2: n2.branch, landed: result?.landed, dropped: result?.dropped, fallback: result?.fallback }, null, 1));
    check("(e2e) the gate really ran (A's ref was deleted, N2 got its late commit)", !refExists(repo, a.branch) && subjectsOf(repo, n2.branch).includes("late-n2"));
    const lA = result?.landed.find((l) => l.branch === a.branch);
    const lN1 = result?.landed.find((l) => l.branch === n1.branch), lN2 = result?.landed.find((l) => l.branch === n2.branch);

    // (U) unreadable tip => fail closed
    check("(U) A landed and its row carries branchAdvancedDuringGate with liveTip:null (UNREADABLE, not 'moved'), assembledTip = the tip it had, phase pre-stop",
      !!lA?.branchAdvancedDuringGate && lA.branchAdvancedDuringGate.liveTip === null && lA.branchAdvancedDuringGate.assembledTip === aTip && lA.branchAdvancedDuringGate.phase === "pre-stop");
    check("(U) A was NOT finalized: task still in_progress, no merge_done, worker unarchived, worktree and its commit kept",
      S.db.getTask(a.taskId)?.columnKey === "in_progress" && eventsOf(S.db, wA, "merge_done").length === 0 && S.db.getSession(wA)?.archivedAt == null && fs.existsSync(path.join(a.worktreePath, "feature-a.txt")));
    const evA = eventsOf(S.db, wA, "batch_merge_branch_retained");
    check("(U) exactly one durable batch_merge_branch_retained event for A with liveTip null and the assembled tip", evA.length === 1 && evA[0].detail?.liveTip === null && evA[0].detail?.assembledTip === aTip && evA[0].detail?.phase === "pre-stop");

    // (N) noop landing
    check("(N) N1 landed as a NOOP: its row reuses the pre-existing trailer squash sha on main (no fresh commit), and all three candidates landed", !!lN1 && !!lN2 && lN1.sha === sq1 && result?.landed.length === 3);
    check("(N1) unmoved noop candidate: NO retain flag, finalized (branch deleted, worktree removed, merge_done filed)",
      lN1?.branchAdvancedDuringGate === undefined && !refExists(repo, n1.branch) && !fs.existsSync(n1.worktreePath) && eventsOf(S.db, wN1, "merge_done").length === 1 && eventsOf(S.db, wN1, "batch_merge_branch_retained").length === 0);
    check("(N2) moved noop candidate: retain flag with assembledTip = its tip at assembly, a DIFFERENT readable liveTip, phase pre-stop",
      !!lN2?.branchAdvancedDuringGate && lN2.branchAdvancedDuringGate.assembledTip === n2Tip && !!lN2.branchAdvancedDuringGate.liveTip && lN2.branchAdvancedDuringGate.liveTip !== n2Tip && lN2.branchAdvancedDuringGate.phase === "pre-stop");
    check("(N2) what survives: branch ref, the late commit, the worktree and the worker; NOT finalized (task in_progress, no merge_done)",
      refExists(repo, n2.branch) && git(repo, `log ${n2.branch} --format=%s`).split("\n").includes("late-n2") && fs.existsSync(path.join(n2.worktreePath, "late-n2.txt")) &&
      S.db.getSession(wN2)?.archivedAt == null && S.db.getTask(n2.taskId)?.columnKey === "in_progress" && eventsOf(S.db, wN2, "merge_done").length === 0);
    check("(N2) the late commit is NOT on main (it was never gated)", !fs.existsSync(path.join(repo, "late-n2.txt")));
    check("(N2) exactly one durable retain event for N2", eventsOf(S.db, wN2, "batch_merge_branch_retained").length === 1);
  }

  // ── (u) finalizeMerge's own post-stop re-check fails closed on an unreadable tip (branch ref gone) ─────────────────────────────────────
  {
    const tag = "fin";
    const repo = makeRepo(tag);
    const S = seedDb(tag, repo, null);
    const w = await cutWorker(repo, S.projId, tag, "f", "f.txt");
    const wId = S.addWorker("f", w);
    const assembled = git(w.worktreePath, "rev-parse HEAD");
    const sessions = new SessionService(S.db, ptyStub, new OrchestrationControl());
    const finArgs = { managerSessionId: S.mgrId, workerSessionId: wId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch, repoPath: repo, projectId: S.projId, mergedSha: assembled, repoKey: null, mergedVerification: "pathset" };
    git(repo, `update-ref -d refs/heads/${w.branch}`);
    check("(u) setup: the branch ref is unreadable", !refExists(repo, w.branch));
    let called = null;
    await sessions.finalizeMerge({ ...finArgs, expectedBranchTip: assembled, onBranchRetained: (live, phase) => { called = { live, phase }; } });
    check("(u) finalize fires onBranchRetained(null, 'at-finalize') for an unreadable tip", called?.live === null && called?.phase === "at-finalize");
    check("(u) nothing finalized: worktree kept, task in_progress, no merge_done", fs.existsSync(path.join(w.worktreePath, "f.txt")) && S.db.getTask(w.taskId)?.columnKey === "in_progress" && eventsOf(S.db, wId, "merge_done").length === 0);
    // Control: the same call with a readable, matching tip DOES finalize (the check discriminates).
    git(repo, `branch ${w.branch} ${assembled}`);
    let controlRetained = false;
    await sessions.finalizeMerge({ ...finArgs, expectedBranchTip: assembled, onBranchRetained: () => { controlRetained = true; } });
    check("(u) control: a readable matching tip finalizes (worktree removed, merge_done filed, not retained)", controlRetained === false && !fs.existsSync(w.worktreePath) && eventsOf(S.db, wId, "merge_done").length === 1);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
