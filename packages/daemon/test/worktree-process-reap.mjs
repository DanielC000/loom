import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Task 8e5a7a5e — the dangling-worktree PREVENTION: reap escaped build/dev-server processes rooted in a
// worktree BEFORE removal. Live evidence (2026-07-03/04): 7 orphaned `esbuild.exe` service processes
// (own executable running FROM inside a dead worktree) + 7 orphaned `vite` dev-servers (global node.exe,
// but cwd/handles + command-line referencing a worktree's packages/web) held Windows file handles open in
// already-git-pruned worktree dirs, making `removeWorktree` fail with ERROR_SHARING_VIOLATION forever.
// `reapOrphanedDescendants` (board card 621ef252) only walks the PTY's OWN process tree, so a DETACHED/
// re-parented survivor (exactly this shape) escapes it entirely — this is the generalization: match by
// executable path OR cwd OR command line against the worktree DIRECTORY itself, independent of any pid
// ancestry, and kill it before the removal is even attempted.
//
// Proves, in three tiers:
//   (unit)   processRootedInWorktree — pure path-matching, incl. the prefix-collision safety guard (a
//            SIBLING worktree dir whose name merely EXTENDS the target string must never match).
//   (real)   reapProcessesRootedInWorktree against REAL OS processes (no daemon, no claude): a process
//            whose SCRIPT PATH lives under worktree A is found + killed by the REAL enumerator/killer,
//            while an unrelated process rooted in a DIFFERENT worktree B is left completely untouched —
//            the safety invariant a live/protected worktree can never be swept, proven end-to-end.
//   (wired)  SessionService's gcWorktreeDir chokepoint — shared by finalizeMerge (confirmWorkerMerge) and
//            boot-reconcile Pass B — calls the injected reap seam for exactly the worktree it is about to
//            discard, BEFORE the removal (proven via an ordering flag the fake removeDir checks), and
//            NEVER for a worktree Pass B decides to KEEP (still holds real work).
// Run: 1) build daemon, 2) node test/worktree-process-reap.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { spawn as spawnProcess } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wpr-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, killableRemoveDir } = await import("../dist/git/worktrees.js");
const { processRootedInWorktree, reapProcessesRootedInWorktree } = await import("../dist/pty/host.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntil = async (cond, timeoutMs, stepMs = 100) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
};
const GIT_ID = "-c user.email=wpr@loom -c user.name=wpr";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ============================== (unit) processRootedInWorktree ==============================
{
  const WT = "/home/x/.loom/worktrees/proj1/abcdef123456";
  const proc = (over) => ({ pid: 1, exePath: null, cwd: null, commandLine: null, ...over });

  check("(unit) exact exePath match", processRootedInWorktree(proc({ exePath: WT }), WT) === true);
  check("(unit) exePath under the worktree (esbuild-service shape)",
    processRootedInWorktree(proc({ exePath: `${WT}/node_modules/.pnpm/@esbuild+win32-x64@0.1/esbuild.exe` }), WT) === true);
  check("(unit) cwd under the worktree", processRootedInWorktree(proc({ cwd: `${WT}/packages/web` }), WT) === true);
  check("(unit) commandLine referencing the worktree (vite shape — global node.exe, cmdline names the path)",
    processRootedInWorktree(proc({ commandLine: `node "${WT}/packages/web/node_modules/.bin/vite"` }), WT) === true);
  check("(unit) backslash + mixed-case (win32-style) path still matches (normalized)",
    processRootedInWorktree(proc({ exePath: `${WT.replace(/\//g, "\\").toUpperCase()}\\ESBUILD.EXE` }), WT) === true);
  check("(unit) none of exePath/cwd/commandLine reference the worktree → no match",
    processRootedInWorktree(proc({ exePath: "/usr/bin/node", cwd: "/tmp/other", commandLine: "node server.js" }), WT) === false);
  check("(unit) an all-null proc never matches (and never throws)", processRootedInWorktree(proc({}), WT) === false);

  // THE SAFETY-CRITICAL GUARD: a SIBLING worktree whose directory name merely EXTENDS the target string as
  // a literal prefix (e.g. target "...abcdef123456" vs a real sibling "...abcdef123456-def-extra") must
  // NEVER be read as "under" the target — worktree keys are 12-hex task hashes so this is defense-in-depth,
  // not a load-bearing assumption, but a substring match without a path-boundary check would still be wrong.
  const SIBLING = `${WT}-sibling-extra`;
  check("(unit) PREFIX-COLLISION GUARD: a sibling dir whose name EXTENDS the target is NOT matched",
    processRootedInWorktree(proc({ exePath: `${SIBLING}/esbuild.exe` }), WT) === false);
  check("(unit) PREFIX-COLLISION GUARD holds for cwd too", processRootedInWorktree(proc({ cwd: SIBLING }), WT) === false);
}

// ============================== (unit) reapProcessesRootedInWorktree self-exclusion ==============================
// SAFETY backstop added after code review: the daemon's OWN pid must NEVER be a kill target, even if a
// (currently theoretical) match were to occur — this is enforced structurally in
// reapProcessesRootedInWorktree itself, independent of processRootedInWorktree's verdict.
{
  const WT = "/home/x/.loom/worktrees/proj1/deadbeef0001";
  const killed = [];
  const result = await reapProcessesRootedInWorktree(WT, {
    enumerate: async () => [
      { pid: process.pid, exePath: `${WT}/node_modules/.bin/esbuild.exe`, cwd: null, commandLine: null }, // matches WT, but IS the daemon's own pid
      { pid: 999999, exePath: `${WT}/node_modules/.bin/vite`, cwd: null, commandLine: null }, // matches WT, a genuine target
    ],
    kill: (pid) => killed.push(pid),
  });
  check("(unit) the daemon's OWN pid is NEVER killed even when it matches the worktree", !killed.includes(process.pid));
  check("(unit) a genuinely different matching pid IS still killed", killed.includes(999999));
  check("(unit) killedPids in the return value excludes the daemon's own pid too", !result.killedPids.includes(process.pid));
}

// ============================== (real) real OS processes, real enumerator/killer ==============================
{
  const wtA = path.join(os.tmpdir(), `loom-wpr-wtA-${sfx}`);
  const wtB = path.join(os.tmpdir(), `loom-wpr-wtB-${sfx}`);
  fs.mkdirSync(wtA, { recursive: true });
  fs.mkdirSync(wtB, { recursive: true });
  // Each probe's OWN SCRIPT PATH lives under its worktree — mirrors the real vite evidence (a shared
  // global node.exe whose COMMAND LINE names a path under the worktree), so this proves the commandLine
  // arm of the match against a REAL process, via the REAL platform enumerator (CIM on win32, /proc on posix).
  const probeA = path.join(wtA, "probe.js");
  const probeB = path.join(wtB, "probe.js");
  fs.writeFileSync(probeA, "setInterval(() => {}, 1000);\n");
  fs.writeFileSync(probeB, "setInterval(() => {}, 1000);\n");
  const childA = spawnProcess(process.execPath, [probeA], { stdio: "ignore" });
  const childB = spawnProcess(process.execPath, [probeB], { stdio: "ignore" });
  try {
    await sleep(400); // let both settle as steady-state live processes before enumerating
    check("(real) child A (rooted in worktree A) is alive before reap", isAlive(childA.pid));
    check("(real) child B (rooted in a DIFFERENT worktree B) is alive before reap", isAlive(childB.pid));

    const { killedPids } = await reapProcessesRootedInWorktree(wtA);
    const aGone = await waitUntil(() => !isAlive(childA.pid), 8000);
    check("(real) reapProcessesRootedInWorktree(wtA) kills child A via the REAL enumerator + killer", aGone);
    check("(real) child A's pid is reported in killedPids", killedPids.includes(childA.pid));

    // THE SAFETY INVARIANT: worktree B — standing in for a DIFFERENT, live/protected worktree — was never
    // named in the call above, so its process must be completely untouched.
    await sleep(600);
    check("(real) child B (a DIFFERENT worktree) is NEVER touched by a reap scoped to worktree A", isAlive(childB.pid));
  } finally {
    if (isAlive(childA.pid)) { try { process.kill(childA.pid, "SIGKILL"); } catch { /* ignore */ } }
    if (isAlive(childB.pid)) { try { process.kill(childB.pid, "SIGKILL"); } catch { /* ignore */ } }
    fs.rmSync(wtA, { recursive: true, force: true });
    fs.rmSync(wtB, { recursive: true, force: true });
  }
}

// ============================== (wired) SessionService's gcWorktreeDir chokepoint ==============================
function initRepo(repo, readme) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), readme);
  execSync(`git init -q && git config user.email wpr@loom && git config user.name wpr && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}
// Always seed a task + manager + worker row with `taskId` SET on the worker (Pass A's per-session filter
// requires `s.taskId` to even consider a session — omitting it, as an earlier version of this test did,
// makes Pass A skip the session entirely regardless of a genuinely-landed squash trailer).
function seed(db, p) {
  db.insertProject({ id: p.projId, name: "WPR", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "WPR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

const reapCalls = [];
const reapedBeforeRemove = new Map(); // worktreePath -> true once the injected reap has completed for it
const removeDirAttempts = [];
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  reapWorktreeProcesses: async (worktreePath) => {
    reapCalls.push(worktreePath);
    reapedBeforeRemove.set(worktreePath, true);
    return { killedPids: [123456] }; // simulate finding + killing an escaped process
  },
  // Fails the removal unless the injected reap ran FIRST for this exact path — proves ORDER, not just
  // that both got called somewhere. A real handle-holder would make removal genuinely fail if reaping
  // hadn't happened yet; this simulates that dependency deterministically.
  removeDir: async (target, ms) => {
    removeDirAttempts.push(target);
    if (!reapedBeforeRemove.get(target)) return { removed: false, killed: false };
    return killableRemoveDir(target, ms);
  },
});

try {
  // --- (A) finalizeMerge (confirmWorkerMerge) reaps the worktree it is about to discard, BEFORE removal ---
  const M = { projId: `wpr-m-proj-${sfx}`, agentId: `wpr-m-top-${sfx}`, taskId: `wpr-m-task-${sfx}`, mgrId: `wpr-m-mgr-${sfx}`, workerId: `wpr-m-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-wpr-merge-${sfx}`), file: "merge.txt" };
  initRepo(M.repo, "# wpr merge\n");
  {
    const { worktreePath, branch } = await createWorktree(M.repo, M.projId, M.taskId);
    fs.writeFileSync(path.join(worktreePath, M.file), "worker change\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${M.file}"`, { cwd: worktreePath });
    M.worktreePath = worktreePath; M.branch = branch;
  }
  seed(db, M);

  const confirmM = await sessions.confirmWorkerMerge(M.mgrId, M.workerId);
  check("(A) confirmWorkerMerge lands the merge", confirmM.merged === true);
  check("(A) the injected reap seam was called for the merged worker's OWN worktree", reapCalls.includes(M.worktreePath));
  check("(A) removal actually succeeded (proves reap ran BEFORE removeDir — the fake removeDir would have refused otherwise)", !fs.existsSync(M.worktreePath));
  check("(A) removeDir was attempted for that same path", removeDirAttempts.includes(M.worktreePath));

  // --- (B) boot-reconcile Pass B: reaps a DISPOSABLE worktree, but NEVER one it decides to KEEP ---
  const disposable = { projId: `wpr-d-proj-${sfx}`, agentId: `wpr-d-top-${sfx}`, taskId: `wpr-d-task-${sfx}`, mgrId: `wpr-d-mgr-${sfx}`, workerId: `wpr-d-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-wpr-disposable-${sfx}`), file: "done.txt" };
  initRepo(disposable.repo, "# wpr disposable\n");
  {
    const { worktreePath, branch } = await createWorktree(disposable.repo, disposable.projId, disposable.taskId);
    fs.writeFileSync(path.join(worktreePath, disposable.file), "already merged work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${disposable.file}"`, { cwd: worktreePath });
    // SQUASH-land it onto main directly (what confirmWorkerMerge does) — the worktree survives on disk
    // (a crashed-before-cleanup shape) so boot-reconcile Pass A finalizes it via the trailer.
    execSync(`git ${GIT_ID} merge --squash ${branch} && git ${GIT_ID} commit -q -m "WPR-TASK" -m "Loom-Worker-Branch: ${branch}"`, { cwd: disposable.repo });
    disposable.worktreePath = worktreePath; disposable.branch = branch;
  }
  seed(db, disposable);

  const stillHoldingWork = { projId: `wpr-k-proj-${sfx}`, agentId: `wpr-k-top-${sfx}`, taskId: `wpr-k-task-${sfx}`, mgrId: `wpr-k-mgr-${sfx}`, workerId: `wpr-k-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-wpr-kept-${sfx}`), file: "unmerged.txt" };
  initRepo(stillHoldingWork.repo, "# wpr kept\n");
  {
    // Committed to its OWN branch but never merged (branch ahead of main) — Pass B's worktreeHasWork()
    // guard must KEEP this one; a live/protected worktree in production shape. It must NEVER be reaped.
    const { worktreePath, branch } = await createWorktree(stillHoldingWork.repo, stillHoldingWork.projId, stillHoldingWork.taskId);
    fs.writeFileSync(path.join(worktreePath, stillHoldingWork.file), "committed, not yet merged\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${stillHoldingWork.file}"`, { cwd: worktreePath });
    stillHoldingWork.worktreePath = worktreePath; stillHoldingWork.branch = branch;
  }
  seed(db, stillHoldingWork);

  const reconcile = await sessions.reconcileOrchestrationOnBoot();
  check("(B) the disposable (already-merged) worktree was GC'd", !fs.existsSync(disposable.worktreePath));
  check("(B) reap was called for the disposable worktree", reapCalls.includes(disposable.worktreePath));
  check("(B) the still-holding-work worktree was KEPT", fs.existsSync(stillHoldingWork.worktreePath));
  check("(B) reap was NEVER called for the kept (live/protected-shaped) worktree — the safety invariant",
    !reapCalls.includes(stillHoldingWork.worktreePath));
  check("(B) reconcile reports it as kept, not pruned", reconcile.worktreesKept >= 1);
} finally {
  db.close();
  for (const dir of fs.readdirSync(os.tmpdir())) {
    if (dir.includes(`loom-wpr-merge-${sfx}`) || dir.includes(`loom-wpr-disposable-${sfx}`) || dir.includes(`loom-wpr-kept-${sfx}`)) {
      try { fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an escaped process rooted in a worktree (by exe path, cwd, or command line, matched on a path-segment boundary so a sibling worktree can never collide) is identified and killed via the REAL OS process enumerator BEFORE removal is attempted, wired into gcWorktreeDir so both finalizeMerge and boot-reconcile Pass B inherit it — and a worktree Pass B decides to KEEP (still holds real work, a live/protected shape) is NEVER swept."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
