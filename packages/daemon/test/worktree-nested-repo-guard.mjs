import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Nested-git-repo removal guard (card b6d41db1 — the incident). REAL git on a temp repo, NO claude and
// NO live daemon — drives SessionService.confirmWorkerMerge() directly (mirrors merge-finalize-
// resilient.mjs's in-process style).
//
// THE INCIDENT: a manager cloned an external repo into a gitignored subdirectory INSIDE a worker
// worktree, with an UNPUSHED branch. worker_merge_confirm's `git worktree remove --force` recursively
// deleted the worktree INCLUDING that nested clone — silently, unrecoverably. Every worker worktree
// ALWAYS has expected ephemeral untracked content (node_modules, dist, caches) — that's WHY the removal
// is forced — so the fix must distinguish that from a nested clone's own `.git`, not refuse on ANY
// untracked content.
//
// Proves:
//   (1) NESTED-REPO path — a worktree containing a subdirectory with its OWN `.git` (a real clone, with
//       a commit) → confirmWorkerMerge REFUSES the worktree removal: the branch's squash merge still
//       LANDS on main (that part is fine + idempotent), but the worktree + nested content are RETAINED
//       intact, and the result carries a warning naming the nested path.
//   (2) NORMAL path — a worktree with node_modules present (including a `.git`-like marker BURIED INSIDE
//       node_modules, proving the scan never descends into it) but NO nested repo of its own → merges +
//       removes cleanly, byte-identical to the pre-existing happy path (no warning).
//   (3) OVERRIDE path — same nested-repo setup as (1), but confirmWorkerMerge is called with
//       forceRemoveWorktree:true → proceeds and removes the worktree (nested content included) anyway.
//   (4) RECOVERY path — after (1)'s refusal, RE-CONFIRMING the SAME worker with forceRemoveWorktree:true
//       removes the retained worktree cleanly. This traverses a DIFFERENT internal path than (3) — the
//       branch is already merged + `merge_done` already recorded, so this re-confirm resolves via the
//       ALREADY_MERGED / finishAlreadyMerged short-circuit, not the fresh-merge path — worth proving
//       separately since the two paths call finalizeMerge from different call sites.
//   (5) TRUNCATED-SCAN path — the nested-repo scan itself reports `truncated:true` (an inconclusive,
//       gave-up-partway result, injected via the SessionService test seam rather than actually creating
//       tens of thousands of files) → the worktree is BLOCKED/retained exactly like a confirmed nested
//       repo, NEVER silently treated as "nothing found, proceed" — a truncated scan is not a clean scan.
//   (6) SCAN-THROWS path — the scan itself REJECTS (not the per-dir readdir glitch findNestedGitRepos
//       already swallows, but the scan producing NO result at all — a throwing test seam standing in for
//       e.g. a pathologically deep tree). Must fail safe exactly like a truncated scan — an unexpected
//       rejection is NEVER "confirmed clean," so removal is blocked/retained, not silently proceeded.
//   (7) BOOT-RECONCILE Pass B path — the worse real-world trigger: a worktree with NO commits ahead of
//       main (worker crashed before committing) and a nested clone that's GITIGNORED, so `git status
//       --porcelain` is blind to it and worktreeHasWork() reports false ("safe to prune"). Drives
//       reconcileOrchestrationOnBoot() directly (mirrors boot-reconcile-keep-work.mjs) and proves the
//       SAME chokepoint guard applies here too: the worktree + nested clone are RETAINED, not destroyed.
// Run: 1) build daemon (pnpm build), 2) node test/worktree-nested-repo-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-nrg-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=nrg@loom -c user.name=nrg";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMerge only calls pty.stop / pty.isAlive / pty.enqueueStdin on this path. A no-pty
// worker row (processState 'exited') means isAlive is false anyway; a stub keeps it hermetic.
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function seed(p) {
  db.insertProject({ id: p.projId, name: "NRG", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "NRG-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// Base worktree setup shared by every case: a real repo + a worktree with a committed file on its
// branch (a clean, mergeable change).
async function setupWorker(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# nrg\n");
  execSync(`git init -q && git config user.email nrg@loom && git config user.name nrg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "worker change\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "${p.file}"`, { cwd: worktreePath });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

// A real nested clone: its own `git init` + a commit, living in a gitignored-shaped subdirectory —
// exactly the incident's shape (a manager cloning an external target repo into the worktree).
function addNestedRepo(worktreePath, relDir) {
  const dir = path.join(worktreePath, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "unpushed.txt"), "unpushed work\n");
  execSync(`git init -q && git config user.email ext@loom && git config user.name ext && git add . && git ${GIT_ID} commit -q -m "unpushed external work"`, { cwd: dir });
  return dir;
}

// Ordinary ephemeral noise every real worker worktree carries — including a `.git`-shaped marker
// BURIED inside node_modules, proving the scan never descends into it (a false positive there would
// break EVERY merge, since node_modules is exactly why removeWorktree force-removes in the first place).
function addNodeModulesNoise(worktreePath) {
  const pkgGit = path.join(worktreePath, "node_modules", "some-pkg", ".git");
  fs.mkdirSync(pkgGit, { recursive: true }); // a directory named ".git" — would look like a repo if scanned
  fs.writeFileSync(path.join(worktreePath, "node_modules", "some-pkg", "index.js"), "module.exports = {};\n");
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const N = { projId: `nrg-n-proj-${sfx}`, agentId: `nrg-n-top-${sfx}`, taskId: `nrg-n-task-${sfx}`, mgrId: `nrg-n-mgr-${sfx}`, workerId: `nrg-n-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-nrg-nested-${sfx}`), file: "nested.txt" };
const H = { projId: `nrg-h-proj-${sfx}`, agentId: `nrg-h-top-${sfx}`, taskId: `nrg-h-task-${sfx}`, mgrId: `nrg-h-mgr-${sfx}`, workerId: `nrg-h-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-nrg-happy-${sfx}`), file: "happy.txt" };
const F = { projId: `nrg-f-proj-${sfx}`, agentId: `nrg-f-top-${sfx}`, taskId: `nrg-f-task-${sfx}`, mgrId: `nrg-f-mgr-${sfx}`, workerId: `nrg-f-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-nrg-force-${sfx}`), file: "force.txt" };
const T = { projId: `nrg-t-proj-${sfx}`, agentId: `nrg-t-top-${sfx}`, taskId: `nrg-t-task-${sfx}`, mgrId: `nrg-t-mgr-${sfx}`, workerId: `nrg-t-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-nrg-trunc-${sfx}`), file: "trunc.txt" };
const K = { projId: `nrg-k-proj-${sfx}`, agentId: `nrg-k-top-${sfx}`, taskId: `nrg-k-task-${sfx}`, mgrId: `nrg-k-mgr-${sfx}`, workerId: `nrg-k-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-nrg-boot-${sfx}`), file: "boot.txt" };
const E = { projId: `nrg-e-proj-${sfx}`, agentId: `nrg-e-top-${sfx}`, taskId: `nrg-e-task-${sfx}`, mgrId: `nrg-e-mgr-${sfx}`, workerId: `nrg-e-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-nrg-err-${sfx}`), file: "err.txt" };

try {
  // --- (1) NESTED-REPO path: refuse removal, retain worktree + nested content, warn with the path. ---
  await setupWorker(N);
  const nestedDir = addNestedRepo(N.worktreePath, path.join("_external", "cloned-repo"));

  const warningsN = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warningsN.push(a.join(" ")); };
  let confirmN;
  try {
    confirmN = await sessions.confirmWorkerMerge(N.mgrId, N.workerId);
  } finally {
    console.warn = realWarn;
  }

  check("(nested) confirmWorkerMerge → merged:true (the squash still lands)", confirmN.merged === true);
  check("(nested) file landed on canonical repo (merge committed)", fs.existsSync(path.join(N.repo, N.file)));
  check("(nested) worktree RETAINED (not force-removed)", fs.existsSync(N.worktreePath));
  check("(nested) nested clone's OWN content is intact", fs.existsSync(path.join(nestedDir, "unpushed.txt")));
  check("(nested) nested clone's unpushed commit is still there", git(nestedDir, "log -1 --format=%s") === "unpushed external work");
  check("(nested) result carries a warning naming the nested path", typeof confirmN.warning === "string" && confirmN.warning.includes(nestedDir));
  check("(nested) result warning mentions the forceRemoveWorktree override", /forceRemoveWorktree/.test(confirmN.warning ?? ""));
  check("(nested) a console warning also named the retained worktree", warningsN.some((w) => w.includes(N.worktreePath) && /nested/i.test(w)));
  check("(nested) task STILL moved to done (merge landed; only cleanup deferred)", db.getTask(N.taskId).columnKey === "done");
  // The worktree is still checked out on the branch, so it can't be force-deleted — confirm it wasn't.
  check("(nested) branch NOT deleted (still checked out by the retained worktree)", git(N.repo, `branch --list ${N.branch}`) !== "");

  // --- (2) NORMAL path: node_modules noise (incl. a buried `.git`-shaped dir) never blocks removal. ---
  await setupWorker(H);
  addNodeModulesNoise(H.worktreePath);
  const confirmH = await sessions.confirmWorkerMerge(H.mgrId, H.workerId);
  check("(happy) confirmWorkerMerge → merged:true", confirmH.merged === true);
  check("(happy) file landed on canonical repo", fs.existsSync(path.join(H.repo, H.file)));
  check("(happy) worktree removed (node_modules noise did not block it)", !fs.existsSync(H.worktreePath));
  check("(happy) branch deleted", git(H.repo, `branch --list ${H.branch}`) === "");
  check("(happy) task moved to done", db.getTask(H.taskId).columnKey === "done");
  // (a "no gateCommand configured" warning is still expected here — this project sets none — but it
  // must never mention a nested/retained worktree, since node_modules noise never blocks removal)
  check("(happy) NO nested-repo warning on the ordinary path", !/nested|retained/i.test(confirmH.warning ?? ""));

  // --- (3) OVERRIDE path: forceRemoveWorktree:true removes despite the nested repo. ---
  await setupWorker(F);
  addNestedRepo(F.worktreePath, path.join("_external", "cloned-repo"));
  const confirmF = await sessions.confirmWorkerMerge(F.mgrId, F.workerId, undefined, true);
  check("(force) confirmWorkerMerge → merged:true", confirmF.merged === true);
  check("(force) file landed on canonical repo", fs.existsSync(path.join(F.repo, F.file)));
  check("(force) worktree REMOVED despite the nested repo (override honored)", !fs.existsSync(F.worktreePath));
  check("(force) branch deleted (removal proceeded normally)", git(F.repo, `branch --list ${F.branch}`) === "");
  check("(force) task moved to done", db.getTask(F.taskId).columnKey === "done");

  // --- (4) RECOVERY path: re-confirm N (already blocked in step 1) with forceRemoveWorktree:true. ---
  // N's branch is already merged + merge_done already recorded, so this re-confirm resolves via the
  // EARLY idempotency check → finishAlreadyMerged, a DIFFERENT call path than F's fresh-merge case above.
  const confirmN2 = await sessions.confirmWorkerMerge(N.mgrId, N.workerId, undefined, true);
  check("(recovery) re-confirm with forceRemoveWorktree:true → merged:true", confirmN2.merged === true);
  check("(recovery) re-confirm went through the ALREADY_MERGED path", confirmN2.emptyKind === "ALREADY_MERGED");
  check("(recovery) worktree NOW removed (override honored on the retry)", !fs.existsSync(N.worktreePath));
  check("(recovery) branch NOW deleted (no longer checked out)", git(N.repo, `branch --list ${N.branch}`) === "");
  check("(recovery) NO nested-repo warning this time (override skipped the guard)", !/nested/i.test(confirmN2.warning ?? ""));

  // --- (5) TRUNCATED-SCAN path: an inconclusive scan blocks removal exactly like a confirmed finding. ---
  const sessionsTruncated = new SessionService(db, ptyStub, new OrchestrationControl(), {
    // Simulate the scan hitting its entry cap on THIS worktree only — an inconclusive "gave up partway"
    // result, not "confirmed clean" — without needing to actually create tens of thousands of files.
    findNestedGitRepos: async (wt) => (wt === T.worktreePath ? { repos: [], truncated: true } : { repos: [], truncated: false }),
  });
  await setupWorker(T); // no real nested repo — otherwise a totally ordinary, mergeable worktree
  const warningsT = [];
  const realWarnT = console.warn;
  console.warn = (...a) => { warningsT.push(a.join(" ")); };
  let confirmT;
  try {
    confirmT = await sessionsTruncated.confirmWorkerMerge(T.mgrId, T.workerId);
  } finally {
    console.warn = realWarnT;
  }
  check("(truncated) confirmWorkerMerge → merged:true (the squash still lands)", confirmT.merged === true);
  check("(truncated) file landed on canonical repo (merge committed)", fs.existsSync(path.join(T.repo, T.file)));
  check("(truncated) worktree RETAINED despite finding NOTHING (fail-safe, not silent proceed)", fs.existsSync(T.worktreePath));
  check("(truncated) result warning mentions the scan was truncated", /truncated/i.test(confirmT.warning ?? ""));
  check("(truncated) a console warning also flagged the truncation", warningsT.some((w) => w.includes(T.worktreePath) && /truncated/i.test(w)));
  check("(truncated) branch NOT deleted (worktree still checked out)", git(T.repo, `branch --list ${T.branch}`) !== "");

  // --- (6) SCAN-THROWS path: the scan itself REJECTS (not a per-dir readdir glitch — that's swallowed
  // internally already — but the scan producing no result at all: a throwing seam here stands in for a
  // pathologically deep tree or similar). Must fail safe exactly like the truncated case, NEVER "confirmed
  // clean" → force-remove. ---
  const sessionsThrows = new SessionService(db, ptyStub, new OrchestrationControl(), {
    findNestedGitRepos: async (wt) => { if (wt === E.worktreePath) throw new Error("simulated scan failure"); return { repos: [], truncated: false }; },
  });
  await setupWorker(E); // no real nested repo — otherwise a totally ordinary, mergeable worktree
  const warningsE = [];
  const realWarnE = console.warn;
  console.warn = (...a) => { warningsE.push(a.join(" ")); };
  let confirmE;
  try {
    confirmE = await sessionsThrows.confirmWorkerMerge(E.mgrId, E.workerId);
  } finally {
    console.warn = realWarnE;
  }
  check("(scan-throws) confirmWorkerMerge → merged:true (the squash still lands)", confirmE.merged === true);
  check("(scan-throws) file landed on canonical repo (merge committed)", fs.existsSync(path.join(E.repo, E.file)));
  check("(scan-throws) worktree RETAINED despite the scan REJECTING (fail-safe, not silent proceed)", fs.existsSync(E.worktreePath));
  check("(scan-throws) result carries a warning (blocked, not silently clean)", typeof confirmE.warning === "string" && confirmE.warning.length > 0);
  check("(scan-throws) a console warning also flagged the retained worktree", warningsE.some((w) => w.includes(E.worktreePath)));
  check("(scan-throws) branch NOT deleted (worktree still checked out)", git(E.repo, `branch --list ${E.branch}`) !== "");

  // --- (7) BOOT-RECONCILE Pass B path: crash pre-merge, nested clone GITIGNORED, worktreeHasWork()=false. ---
  fs.mkdirSync(K.repo, { recursive: true });
  fs.writeFileSync(path.join(K.repo, "README.md"), "# nrg boot\n");
  // The .gitignore is committed to MAIN (inherited by the worktree with no new branch commit) so the
  // nested clone stays 0-ahead/clean from git's point of view — exactly the incident's blind spot.
  fs.writeFileSync(path.join(K.repo, ".gitignore"), "_external/\n");
  execSync(`git init -q && git config user.email nrg@loom && git config user.name nrg && git add . && git ${GIT_ID} commit -q -m init`, { cwd: K.repo });
  const kWt = await createWorktree(K.repo, K.projId, K.taskId); // 0 commits ahead of main — worker "crashed" before committing
  K.worktreePath = kWt.worktreePath; K.branch = kWt.branch;
  const kNestedDir = addNestedRepo(K.worktreePath, path.join("_external", "cloned-repo"));
  db.insertProject({ id: K.projId, name: "NRG", repoPath: K.repo, vaultPath: K.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: K.agentId, projectId: K.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: K.taskId, projectId: K.projId, title: "NRG-BOOT-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: K.mgrId, projectId: K.projId, agentId: K.agentId, engineSessionId: null, title: null, cwd: K.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // `exited` + unprotected — exactly the shape recoverStaleSessions leaves after a daemon crash.
  db.insertSession({ id: K.workerId, projectId: K.projId, agentId: K.agentId, engineSessionId: null, title: null, cwd: K.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: K.mgrId, taskId: K.taskId, worktreePath: K.worktreePath, branch: K.branch });

  const warningsK = [];
  const realWarnK = console.warn;
  console.warn = (...a) => { warningsK.push(a.join(" ")); };
  let reconcileResult;
  try {
    reconcileResult = await sessions.reconcileOrchestrationOnBoot();
  } finally {
    console.warn = realWarnK;
  }
  check("(boot) branch has NO commits ahead of main (the crash-before-commit shape)", git(K.repo, `rev-list --count HEAD..${K.branch}`) === "0");
  check("(boot) worktree RETAINED — Pass B did NOT destroy the gitignored nested clone", fs.existsSync(K.worktreePath));
  check("(boot) nested clone's OWN content is intact", fs.existsSync(path.join(kNestedDir, "unpushed.txt")));
  check("(boot) nested clone's unpushed commit is still there", git(kNestedDir, "log -1 --format=%s") === "unpushed external work");
  check("(boot) task untouched (Pass B never finalizes a task — that's Pass A's job)", db.getTask(K.taskId).columnKey === "in_progress");
  check("(boot) reconcile did NOT count this worktree as pruned", reconcileResult.worktreesPruned === 0);
  check("(boot) a console warning flagged the retained nested-repo worktree", warningsK.some((w) => w.includes(K.worktreePath) && /nested/i.test(w)));
} finally {
  db.close();
  for (const p of [N, H, F, T, K, E]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(p.repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a nested git repo inside a worker worktree blocks the force-remove at the SHARED chokepoint (worktree + nested content retained, merge already landed) across all its callers: the interactive merge path, its ALREADY_MERGED recovery re-confirm, an inconclusive/truncated scan (fail-safe, never silent-proceeds), and boot-reconcile Pass B (gitignored nested clone, worktreeHasWork()=false); ordinary node_modules noise never blocks it; forceRemoveWorktree:true overrides the guard."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
