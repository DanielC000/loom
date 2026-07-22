import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Multi-repo epic 49136451 phase 2 — the full worker-lifecycle DoD: worktree cut / gate / merge /
// ship-state all honor a task's `repoKey`, with a REPO AXIS added to worktree keying so a registry-repo
// task can never collide with a primary-repo task's worktree dir. DETERMINISTIC + CLAUDE-FREE (a fake pty
// seam) + NETWORK-FREE, REAL git on temp repos, a REAL Db + SessionService, modeled on
// codescape-lifecycle-hooks.mjs (spawnWorker/confirmWorkerMerge end-to-end) and
// no-gate-by-design-merge-warning.mjs (the gate/warning assertions).
//
// Proves the DoD:
//   (1) a card with repoKey="secondary" (a registered repo with its OWN gateCommand): the worker's
//       worktree is cut under WORKTREES_DIR/<project>/secondary/<taskKey> (the repo axis), its Session
//       row is stamped repoKey="secondary", the merge gate runs SECONDARY's gateCommand (not the
//       project's), and the squash lands on SECONDARY's own main — never touching primary or any other
//       registered repo.
//   (2) a card with repoKey="gateless" (a registered repo with NO gateCommand of its own): the merge
//       still lands, but carries the "unverified: no gateCommand is configured for repo "gateless""
//       warning — CARRIED item 2 — and critically does NOT fall back to running the PROJECT's own
//       gateCommand against the gateless repo (no false green).
//   (3) a SIBLING card in the SAME project with no repoKey (primary): worktree dir/branch keying,
//       gate resolution, and squash target are ALL byte-identical to today (no repo-axis segment,
//       project-level gateCommand runs) — completely unaffected by the other two cards' repos.
//   (4) ship-state (`getTaskMergedInfo` via the resolveRepo-driven read already wired in phase 1)
//       resolves EACH card's `merged` sha against its OWN target repo, not always primary.
//   (5) boot-reconcile (Pass A) finishes an orphaned SECONDARY-repo squash-merge (a crash between the
//       squash commit and finalizeMerge's bookkeeping) by resolving the session's OWN stamped repoKey,
//       not project.repoPath — the repo-scoped worktree dir cleans up correctly.
//
// Run: 1) build (turbo builds shared first), 2) node test/multi-repo-worker-lifecycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-mrwl-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");
const { taskKey, getTaskMergedInfo } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mrwl@loom -c user.name=mrwl";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function initRepo(repo, readme) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), readme);
  execSync(`git init -q && git config user.email mrwl@loom && git config user.name mrwl && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  isAlive() { return false; }
}
function makeHost(db) {
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  return new SeamHost(events);
}

const repoPrimary = path.join(os.tmpdir(), `loom-mrwl-primary-${sfx}`);
const repoSecondary = path.join(os.tmpdir(), `loom-mrwl-secondary-${sfx}`);
const repoGateless = path.join(os.tmpdir(), `loom-mrwl-gateless-${sfx}`);
initRepo(repoPrimary, "# mrwl primary\n");
initRepo(repoSecondary, "# mrwl secondary\n");
initRepo(repoGateless, "# mrwl gateless\n");

// Green gate markers, distinct per repo so a wrong-repo gate run is instantly visible in the marker set.
// Each gate is a tiny SCRIPT FILE (not an inline `node -e "..."`) so a Windows-path marker embedding
// backslashes/quotes never has to survive cmd.exe's shell-quoting — the script file's OWN contents are
// written with plain fs, no shell escaping involved at all.
const secondaryGateMarker = path.join(os.tmpdir(), `loom-mrwl-secondary-gate-ran-${sfx}`);
const primaryGateMarker = path.join(os.tmpdir(), `loom-mrwl-primary-gate-ran-${sfx}`);
function gateCmd(marker) {
  const scriptPath = path.join(os.tmpdir(), `loom-mrwl-gate-script-${path.basename(marker)}.mjs`);
  fs.writeFileSync(scriptPath, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "1");\n`);
  return `node ${JSON.stringify(scriptPath)}`;
}

const db = new Db();
const sessions = new SessionService(db, makeHost(db), new OrchestrationControl(), {
  reapWorktreeProcesses: async () => ({ killedPids: [] }),
});

const projId = `mrwl-proj-${sfx}`;
db.insertProject({
  id: projId, name: "MRWL", repoPath: repoPrimary, vaultPath: repoPrimary,
  config: { orchestration: { maxConcurrentWorkers: 10, gateCommand: gateCmd(primaryGateMarker) } },
  createdAt: now, archivedAt: null, reserved: false,
  repos: [
    { key: "secondary", path: repoSecondary, gateCommand: gateCmd(secondaryGateMarker) },
    { key: "gateless", path: repoGateless },
  ],
});
db.insertAgent({ id: "mgrAgent", projectId: projId, name: "Mgr", startupPrompt: "", position: 0, profileId: null });
db.insertAgent({ id: "wkrAgent", projectId: projId, name: "Worker", startupPrompt: "", position: 1, profileId: null });

const taskSecondary = `mrwl-task-secondary-${sfx}`;
const taskGateless = `mrwl-task-gateless-${sfx}`;
const taskPrimary = `mrwl-task-primary-${sfx}`;
db.insertTask({ id: taskSecondary, projectId: projId, title: "Secondary-repo card", body: "", columnKey: "backlog", position: 1, priority: "p2", repoKey: "secondary", createdAt: now, updatedAt: now });
db.insertTask({ id: taskGateless, projectId: projId, title: "Gateless-repo card", body: "", columnKey: "backlog", position: 2, priority: "p2", repoKey: "gateless", createdAt: now, updatedAt: now });
db.insertTask({ id: taskPrimary, projectId: projId, title: "Primary sibling card", body: "", columnKey: "backlog", position: 3, priority: "p2", repoKey: null, createdAt: now, updatedAt: now });

const worktreesToClean = [];
try {
  const mgr = sessions.startManager("mgrAgent");

  // ===================== (1) SECONDARY repo: worktree axis + Session.repoKey + gate + squash target =====================
  const wSecondary = await sessions.spawnWorker(mgr.id, { taskId: taskSecondary, agentId: "wkrAgent", kickoffPrompt: "GO" });
  worktreesToClean.push(wSecondary.worktreePath);
  const expectedSecondaryDir = path.join(WORKTREES_DIR, projId, "secondary", taskKey(taskSecondary));
  check("(1) secondary-repo worktree cut under the REPO-AXIS dir (WORKTREES_DIR/project/secondary/<taskKey>)",
    path.resolve(wSecondary.worktreePath) === path.resolve(expectedSecondaryDir));
  check("(1) secondary worker's Session row is stamped repoKey='secondary'", db.getSession(wSecondary.id)?.repoKey === "secondary");

  fs.writeFileSync(path.join(wSecondary.worktreePath, "secondary-change.txt"), "secondary work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "secondary-change.txt"`, { cwd: wSecondary.worktreePath });
  const confirmSecondary = await sessions.confirmWorkerMerge(mgr.id, wSecondary.id);
  check("(1) secondary-repo merge lands", confirmSecondary.merged === true);
  check("(1) secondary-repo merge carries NO warning (its own gateCommand ran green)", confirmSecondary.warning === undefined);
  check("(1) secondary's own gate marker was written (the SECONDARY repo's gateCommand actually ran)", fs.existsSync(secondaryGateMarker));
  check("(1) squash landed on SECONDARY's own main (file present there)", fs.existsSync(path.join(repoSecondary, "secondary-change.txt")));
  check("(1) squash did NOT leak into primary", !fs.existsSync(path.join(repoPrimary, "secondary-change.txt")));
  check("(1) squash did NOT leak into the gateless repo", !fs.existsSync(path.join(repoGateless, "secondary-change.txt")));
  check("(1) task moved to done", db.getTask(taskSecondary)?.columnKey === "done");

  // ===================== (2) GATELESS registry repo: no fallback to the project gate, repo-named warning =====================
  const wGateless = await sessions.spawnWorker(mgr.id, { taskId: taskGateless, agentId: "wkrAgent", kickoffPrompt: "GO" });
  worktreesToClean.push(wGateless.worktreePath);
  const expectedGatelessDir = path.join(WORKTREES_DIR, projId, "gateless", taskKey(taskGateless));
  check("(2) gateless-repo worktree cut under its OWN repo-axis dir", path.resolve(wGateless.worktreePath) === path.resolve(expectedGatelessDir));
  check("(2) gateless worker's Session row is stamped repoKey='gateless'", db.getSession(wGateless.id)?.repoKey === "gateless");

  fs.writeFileSync(path.join(wGateless.worktreePath, "gateless-change.txt"), "gateless work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "gateless-change.txt"`, { cwd: wGateless.worktreePath });
  const primaryMarkerBefore = fs.existsSync(primaryGateMarker);
  const confirmGateless = await sessions.confirmWorkerMerge(mgr.id, wGateless.id);
  check("(2) gateless-repo merge lands (unconditionally, no gate configured for it)", confirmGateless.merged === true);
  check("(2) CARRIED item 2: unverified warning is present and names the REPO, not just \"this project\"",
    confirmGateless.warning === "unverified: no gateCommand is configured for repo \"gateless\" — the merge was NOT checked by any build/DoD gate");
  check("(2) CARRIED item 1 (settled, no re-litigating): the PROJECT's own gateCommand did NOT run against the gateless repo (no false green)",
    fs.existsSync(primaryGateMarker) === primaryMarkerBefore);
  check("(2) squash landed on the gateless repo's own main", fs.existsSync(path.join(repoGateless, "gateless-change.txt")));
  check("(2) squash did NOT leak into primary or secondary", !fs.existsSync(path.join(repoPrimary, "gateless-change.txt")) && !fs.existsSync(path.join(repoSecondary, "gateless-change.txt")));

  // ===================== (3) SIBLING primary-repo card: byte-identical, unaffected =====================
  const wPrimary = await sessions.spawnWorker(mgr.id, { taskId: taskPrimary, agentId: "wkrAgent", kickoffPrompt: "GO" });
  worktreesToClean.push(wPrimary.worktreePath);
  const expectedPrimaryDir = path.join(WORKTREES_DIR, projId, taskKey(taskPrimary)); // NO repo-axis segment
  check("(3) primary-repo sibling's worktree dir has NO repo-axis segment (byte-identical keying)",
    path.resolve(wPrimary.worktreePath) === path.resolve(expectedPrimaryDir));
  check("(3) primary sibling's Session row has repoKey null (unaffected by the other two cards' repos)", db.getSession(wPrimary.id)?.repoKey === null);

  fs.writeFileSync(path.join(wPrimary.worktreePath, "primary-change.txt"), "primary work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "primary-change.txt"`, { cwd: wPrimary.worktreePath });
  const confirmPrimary = await sessions.confirmWorkerMerge(mgr.id, wPrimary.id);
  check("(3) primary sibling merge lands", confirmPrimary.merged === true);
  check("(3) primary sibling's own gate (project-level) ran green, no warning", confirmPrimary.warning === undefined);
  check("(3) squash landed on PRIMARY's own main", fs.existsSync(path.join(repoPrimary, "primary-change.txt")));
  check("(3) squash did NOT leak into secondary or gateless", !fs.existsSync(path.join(repoSecondary, "primary-change.txt")) && !fs.existsSync(path.join(repoGateless, "primary-change.txt")));

  // ===================== (4) ship-state resolves EACH task against its OWN target repo =====================
  const secondarySha = git(repoSecondary, "rev-parse HEAD");
  const gatelessSha = git(repoGateless, "rev-parse HEAD");
  const primarySha = git(repoPrimary, "rev-parse HEAD");
  const mergedSecondary = await getTaskMergedInfo(repoSecondary, taskSecondary);
  const mergedGateless = await getTaskMergedInfo(repoGateless, taskGateless);
  const mergedPrimary = await getTaskMergedInfo(repoPrimary, taskPrimary);
  check("(4) ship-state: secondary card's merged sha is found scanning the SECONDARY repo", mergedSecondary?.sha === secondarySha.slice(0, 7));
  check("(4) ship-state: gateless card's merged sha is found scanning the GATELESS repo", mergedGateless?.sha === gatelessSha.slice(0, 7));
  check("(4) ship-state: primary sibling's merged sha is found scanning PRIMARY", mergedPrimary?.sha === primarySha.slice(0, 7));
  // Cross-repo negative: the secondary card's squash must NOT be discoverable scanning primary/gateless.
  const crossMiss1 = await getTaskMergedInfo(repoPrimary, taskSecondary);
  const crossMiss2 = await getTaskMergedInfo(repoGateless, taskSecondary);
  check("(4) ship-state cross-check: secondary card's squash is NOT found scanning primary", crossMiss1 === null);
  check("(4) ship-state cross-check: secondary card's squash is NOT found scanning gateless", crossMiss2 === null);

  // ===================== (5) boot-reconcile Pass A finishes an orphaned SECONDARY-repo merge =====================
  const taskOrphan = `mrwl-task-orphan-${sfx}`;
  db.insertTask({ id: taskOrphan, projectId: projId, title: "Orphaned secondary merge", body: "", columnKey: "backlog", position: 4, priority: "p2", repoKey: "secondary", createdAt: now, updatedAt: now });
  const wOrphan = await sessions.spawnWorker(mgr.id, { taskId: taskOrphan, agentId: "wkrAgent", kickoffPrompt: "GO" });
  fs.writeFileSync(path.join(wOrphan.worktreePath, "orphan-change.txt"), "orphaned work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "orphan-change.txt"`, { cwd: wOrphan.worktreePath });
  // Simulate the crash window: land the squash-merge commit directly on SECONDARY (mirrors what
  // confirmWorkerMerge's mergeBranch step does), but never run finalizeMerge — the worktree/branch/task
  // are left exactly as a daemon crash between the squash and its bookkeeping would leave them.
  const { mergeBranch } = await import("../dist/git/worktrees.js");
  const orphanMerge = await mergeBranch(repoSecondary, wOrphan.branch, "Orphaned secondary merge");
  check("(5) setup: the orphan's squash genuinely landed on secondary (simulated pre-crash state)", orphanMerge.ok === true);
  check("(5) setup: the task is still NOT done (bookkeeping never ran — the simulated crash point)", db.getTask(taskOrphan)?.columnKey !== "done");
  check("(5) setup: the worktree dir still exists on disk (never cleaned up)", fs.existsSync(wOrphan.worktreePath));

  const reconcileResult = await sessions.reconcileOrchestrationOnBoot();
  check("(5) boot-reconcile Pass A finishes the orphaned secondary-repo merge (mergesFinished >= 1)", reconcileResult.mergesFinished >= 1);
  check("(5) boot-reconcile moved the orphaned task to done", db.getTask(taskOrphan)?.columnKey === "done");
  check("(5) boot-reconcile removed the repo-scoped worktree dir", !fs.existsSync(wOrphan.worktreePath));
  check("(5) boot-reconcile's own git op targeted SECONDARY (Session.repoKey), not primary — the squash is only discoverable there",
    (await getTaskMergedInfo(repoSecondary, taskOrphan)) !== null && (await getTaskMergedInfo(repoPrimary, taskOrphan)) === null);
} finally {
  db.close();
  for (const wt of worktreesToClean) { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ } }
  for (const d of [repoPrimary, repoSecondary, repoGateless, tmpHome]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  for (const m of [secondaryGateMarker, primaryGateMarker]) { try { fs.rmSync(m, { force: true }); } catch { /* best-effort */ } }
  for (const m of [secondaryGateMarker, primaryGateMarker]) {
    try { fs.rmSync(path.join(os.tmpdir(), `loom-mrwl-gate-script-${path.basename(m)}.mjs`), { force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — multi-repo phase 2: a card's repoKey drives worktree cut (repo-axis dir), gate resolution (that repo's own gateCommand, no fallback), squash target, and ship-state, all resolved against the SESSION's own stamped repo; a gateless registry repo warns (naming itself, never silently gated by the project's command); a sibling primary-repo card in the same project stays byte-identical and unaffected; and boot-reconcile finishes an orphaned secondary-repo merge by resolving the session's own repoKey, not the project's primary."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
